import { authErrorResponse, requireAdmin } from "../../../../lib/auth-server";
import { buildPreviewFromOps, parseDate } from "../../../../lib/investment-import";
import { loadImportAccount, loadImportContext, isOperationAccount } from "../../../../lib/investment-import-server";
import { getDocumentAiConfig, getDocumentProvider } from "../../../../lib/document-extraction/provider";
import { validateExtraction, validateExtractedPositions, crossCheckTotals } from "../../../../lib/document-extraction/extract";
import { reconcilePositionPasses } from "../../../../lib/document-extraction/consensus";
import { autoMapSnapshotHeaders, buildSnapshotPreview } from "../../../../lib/portfolio-snapshot-import";

// SCAN IA d'un relevé (PDF / image) — étape d'import, PAS un second moteur financier. Admin
// uniquement. Le fichier est traité de façon TRANSITOIRE (jamais stocké) : on l'encode, on
// appelle le fournisseur IA côté serveur, on VALIDE la sortie par schéma + contrôles
// déterministes, puis on renvoie la MÊME prévisualisation que l'import CSV (rien n'est écrit).
// L'IA n'extrait que des champs bruts ; tous les calculs restent dans computeAccountModel.
//
// DEUX FAMILLES DE RELEVÉS, un seul parcours :
//   • mouvements  → opérations datées      → buildPreviewFromOps    (mode "operations")
//   • positions   → portefeuille à une date → buildSnapshotPreview  (mode "snapshot")
// Le second cas est celui d'une capture « Mes positions » : il ne contient aucune opération, et
// c'est exactement ce que l'ancienne version rejetait avec « aucune ligne d'opération exploitable ».

export const runtime = "nodejs";

const ALLOWED = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp"]);

export async function POST(request: Request) {
  try {
    await requireAdmin(request);

    const config = getDocumentAiConfig();
    if (!config.configured) {
      return Response.json({ error: "Le scan IA n'est pas configuré sur ce serveur (ajoutez ANTHROPIC_API_KEY ou OPENAI_API_KEY). Utilisez l'import CSV/XLSX ou la saisie manuelle.", setupRequired: true }, { status: 503 });
    }
    const provider = getDocumentProvider(config);
    if (!provider) return Response.json({ error: "Fournisseur IA indisponible.", setupRequired: true }, { status: 503 });

    const form = await request.formData().catch(() => null);
    if (!form) return Response.json({ error: "Fichier manquant." }, { status: 400 });
    const file = form.get("file");
    const accountId = String(form.get("accountId") ?? "").trim();
    if (!accountId) return Response.json({ error: "Le compte est obligatoire." }, { status: 400 });
    if (!(file instanceof File)) return Response.json({ error: "Fichier manquant." }, { status: 400 });
    if (file.size === 0) return Response.json({ error: "Le fichier est vide." }, { status: 400 });
    if (file.size > config.maxFileBytes) return Response.json({ error: `Fichier trop volumineux (max ${Math.round(config.maxFileBytes / 1024 / 1024)} Mo).` }, { status: 413 });
    const mediaType = file.type || "application/octet-stream";
    if (!ALLOWED.has(mediaType)) return Response.json({ error: "Format non pris en charge. Acceptés : PDF, PNG, JPG, WEBP. Pour l'écriture manuscrite ou les scans flous, préférez le CSV ou la saisie manuelle." }, { status: 415 });

    const account = await loadImportAccount(accountId);
    if (!account) return Response.json({ error: "Compte introuvable." }, { status: 404 });
    if (!isOperationAccount(account.accountType)) return Response.json({ error: "Ce type de compte n'accepte pas d'opérations." }, { status: 400 });
    if (!account.isActive) return Response.json({ error: "Ce compte est archivé : réactivez-le avant d'importer." }, { status: 409 });

    // Encodage transitoire (jamais stocké) + appel fournisseur.
    //
    // RELECTURES MULTIPLES, EN PARALLÈLE. Mesuré sur un relevé PEA réel : une passe unique se
    // trompe sur ~6 cellules chiffrées sur 30, en annonçant une confiance de 0,90 à 0,98 — la
    // confiance auto-déclarée par le modèle ne vaut donc rien. Mais les erreurs sont ALÉATOIRES :
    // trois relectures indépendantes ne se trompent pas au même endroit, et le vote cellule par
    // cellule (cf. consensus.ts) les fait toutes remonter comme « à vérifier ». Comme les appels
    // partent ensemble, le coût en temps reste celui d'une seule passe.
    const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
    const attempts = await Promise.allSettled(
      Array.from({ length: config.passes }, (_, index) =>
        provider.extract({ base64, mediaType, filename: file.name, pass: index + 1 })),
    );
    const raws = attempts.filter((attempt) => attempt.status === "fulfilled").map((attempt) => attempt.value);
    if (raws.length === 0) {
      const failure = attempts[0].status === "rejected" ? attempts[0].reason : null;
      const aborted = failure instanceof Error && failure.name === "AbortError";
      const message = failure instanceof Error ? failure.message : "Extraction impossible.";
      return Response.json({
        error: aborted
          ? `L'analyse IA a dépassé ${Math.round(config.timeoutMs / 1000)} s. Réessayez, ou scannez une page à la fois — un export CSV du même relevé reste la voie la plus fiable.`
          : `Analyse IA impossible : ${message}. Essayez un autre fichier, le CSV, ou la saisie manuelle.`,
      }, { status: 502 });
    }

    // L'en-tête et les opérations datées sont pris sur la première relecture aboutie ; seules
    // les POSITIONS (des chiffres, donc le risque de lecture) passent par le vote.
    const raw = raws[0];
    const { document, operations } = validateExtraction(raw, { accountCurrency: account.currency, thresholds: config.thresholds });
    const positionPasses = raws.map((candidate) => validateExtractedPositions(candidate, { accountCurrency: account.currency, thresholds: config.thresholds }));
    const agreed = reconcilePositionPasses(positionPasses);
    const positions = { header: positionPasses[0].header, rows: agreed.rows, meta: agreed.meta };

    if (operations.length === 0 && positions.rows.length === 0) {
      return Response.json({
        error: "Le document a été transmis à l'IA, mais aucune ligne exploitable n'a été retranscrite — ni opération, ni position. Vérifiez que le relevé est net, entier et non protégé, puis réessayez ou utilisez le CSV.",
        code: "no_rows_detected",
        provider: provider.name,
        document,
        extraction: { documentDetected: Boolean(document.institution || document.accountType || document.period || document.holder), operationsDetected: 0, positionsDetected: 0 },
      }, { status: 422 });
    }

    const context = await loadImportContext(account);

    // ---- RELEVÉ DE POSITIONS ------------------------------------------------------------
    // Priorité aux opérations quand le document en contient : elles portent l'historique réel.
    if (operations.length === 0) {
      // Date d'arrêté : celle lue sur le relevé, sinon celle saisie par l'administrateur, sinon
      // le jour même. Elle reste modifiable dans l'assistant avant tout enregistrement.
      const submitted = parseDate(String(form.get("snapshotDate") ?? "").trim(), "iso");
      const asOfDate = document.asOfDate ?? submitted ?? new Date().toISOString().slice(0, 10);
      const mapping = autoMapSnapshotHeaders(positions.header);
      const snapshot = buildSnapshotPreview({
        rows: positions.rows,
        mapping,
        asOfDate,
        accountCurrency: account.currency,
        holdings: context.holdings,
        // Le JSON de l'IA porte de vrais nombres : le tableau canonique est écrit en point
        // décimal sans séparateur de milliers. Aucune détection à faire, aucune ambiguïté ×1000.
        numberFormat: "us",
      });

      const mergedRows = snapshot.rows.map((row) => {
        const meta = positions.meta[row.index - 1];
        return meta
          ? { ...row, warnings: [...new Set([...row.warnings, ...meta.warnings])], aiConfidence: meta.confidence, aiBand: meta.band, aiPage: meta.page, aiSourceText: meta.sourceText, lastMovementDate: meta.lastMovementDate }
          : row;
      });

      // Contre-vérification : somme des lignes retranscrites vs totaux imprimés sur le relevé.
      const sum = (pick: (position: (typeof snapshot.positions)[number]) => number | null) =>
        snapshot.positions.some((position) => pick(position) !== null)
          ? Math.round(snapshot.positions.reduce((total, position) => total + (pick(position) ?? 0), 0) * 100) / 100
          : null;
      const totals = crossCheckTotals({
        sumValuation: sum((position) => position.currentValue),
        sumGain: sum((position) => position.gainEur),
        document,
      });

      return Response.json({
        account: { id: account.id, name: account.name, kind: context.kind, currency: account.currency, memberName: account.memberName },
        source: "ai_scan",
        mode: "snapshot",
        provider: provider.name,
        document,
        totals,
        // Qualité de lecture MESURÉE (et non déclarée) : nombre de relectures et part de lignes
        // sur lesquelles elles se sont toutes accordées. C'est ce que l'écran affiche.
        reading: {
          passes: agreed.passes,
          unanimousRows: agreed.consensus.filter((entry) => entry.disputed.length === 0 && entry.seenBy === agreed.passes).length,
          disputedCells: agreed.consensus.reduce((total, entry) => total + entry.disputed.length, 0),
        },
        snapshot: { asOfDate, positions: snapshot.positions },
        allowAdvanced: context.allowAdvanced,
        knownHoldings: context.holdings,
        summary: snapshot.summary,
        rows: mergedRows,
      });
    }

    const { rows, summary } = buildPreviewFromOps(operations.map((o) => o.op), {
      accountId: account.id, accountCurrency: account.currency, accountType: context.kind,
      holdings: context.holdings, existingFingerprints: context.existingFingerprints, existingExternalRefs: context.existingExternalRefs,
      openingQuantities: context.openingQuantities, allowAdvanced: context.allowAdvanced,
    });

    // Métadonnées IA alignées sur l'ordre des opérations (row.index = i+1). On fusionne les
    // avertissements déterministes de l'extraction dans les avertissements de la ligne.
    const ai = operations.map((o) => ({ confidence: o.confidence, band: o.band, page: o.page, sourceText: o.sourceText, warnings: o.warnings }));
    const mergedRows = rows.map((row) => {
      const meta = ai[row.index - 1];
      return meta ? { ...row, warnings: [...new Set([...row.warnings, ...meta.warnings])], aiConfidence: meta.confidence, aiBand: meta.band, aiPage: meta.page, aiSourceText: meta.sourceText } : row;
    });

    return Response.json({
      account: { id: account.id, name: account.name, kind: context.kind, currency: account.currency, memberName: account.memberName },
      source: "ai_scan",
      mode: "operations",
      provider: provider.name,
      document,
      allowAdvanced: context.allowAdvanced,
      knownHoldings: context.holdings,
      summary,
      rows: mergedRows,
      ai,
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}
