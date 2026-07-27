import { createHash } from "node:crypto";
import { authErrorResponse, requireAdmin } from "../../../../lib/auth-server";
import { supabaseRest } from "../../../../lib/supabase-rest";
import { buildPreviewFromOps, computeFingerprint, matchInstrument, instrumentKeyOf, parseDate } from "../../../../lib/investment-import";
import { loadImportAccount, loadImportContext, isOperationAccount } from "../../../../lib/investment-import-server";
import { getDocumentAiConfig, getDocumentProvider, type ExtractInput } from "../../../../lib/document-extraction/provider";
import { validateExtraction, type RawExtraction } from "../../../../lib/document-extraction/extract";
import { reconcilePositionPasses } from "../../../../lib/document-extraction/consensus";
import { brokerPromptHints, MARKER_INSTRUCTION } from "../../../../lib/document-extraction/brokers";
import { BOURSOBANK_TABLE_REGION, prepareCapture } from "../../../../lib/document-extraction/preprocess";
import {
  buildStatementOperations, parseModelStatement, reconcileHeaders, runAccountingChecks,
  statementFromConsensus, statementPositionRows, summarizeChecks, toStatement,
  type BrokerStatement,
} from "../../../../lib/document-extraction/statement";

// SCAN IA d'un relevé (capture d'écran de courtier ou PDF) — étape d'IMPORT, jamais un second
// moteur financier. Admin uniquement. Rien n'est écrit ici : la route lit, contrôle et renvoie
// une proposition que l'administrateur doit valider (/commit fait l'écriture).
//
// Chaîne de traitement, dans l'ordre :
//   1. empreinte SHA-256 du fichier         → dédoublonnage d'une capture déjà intégrée
//   2. prétraitement (EXIF, agrandissement) → des chiffres lisibles, sans les altérer
//   3. N relectures indépendantes en //     → le vote décorrèle les erreurs de perception
//   4. contrat Zod strict                   → une clé inventée est un signal, pas un détail
//   5. relevé canonique + consensus         → une seule vérité par cellule, désaccords signalés
//   6. contrôles comptables déterministes   → l'arithmétique du relevé doit tomber juste
//   7. seconde passe CIBLÉE si besoin       → zone du tableau seule, donc plus de pixels/chiffre
//
// Deux familles de documents, un seul parcours :
//   • capture de POSITIONS → mode "statement"  (relevé canonique + contrôles comptables)
//   • relevé de MOUVEMENTS → mode "operations" (opérations datées, pipeline d'import existant)
//
// Confidentialité : le fichier est traité en mémoire et jamais stocké ; le numéro de compte n'est
// renvoyé que MASQUÉ (quatre derniers caractères) ; aucune image ni aucun numéro n'est journalisé.

export const runtime = "nodejs";

const ALLOWED = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp"]);

type PassOutcome = { statement: BrokerStatement; strict: boolean; issues: string[]; targeted: boolean };

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
    // « Analyser quand même » : l'administrateur a vu l'avertissement de doublon et l'assume.
    const force = String(form.get("force") ?? "") === "true";
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

    // ---- 1) Empreinte de la capture + détection d'un import déjà effectué -------------------
    const bytes = Buffer.from(await file.arrayBuffer());
    const captureHash = createHash("sha256").update(bytes).digest("hex");
    const alreadyImported = await findExistingBatch(account.id, captureHash);
    if (alreadyImported && !force) {
      return Response.json({
        error: "Cette capture semble déjà avoir été intégrée.",
        code: "duplicate_capture",
        duplicate: alreadyImported,
        captureHash,
      }, { status: 409 });
    }

    // ---- 2) Prétraitement : l'image originale n'est jamais modifiée, une copie est préparée --
    const prepared = await prepareCapture(bytes, mediaType, {});

    // ---- 3) Relectures indépendantes, EN PARALLÈLE -----------------------------------------
    // Mesuré sur un relevé PEA réel : une passe unique se trompe sur ~6 cellules chiffrées sur
    // 30 en annonçant 0,90 à 0,98 de confiance — la confiance auto-déclarée ne vaut rien. Mais
    // les erreurs sont ALÉATOIRES : trois relectures ne se trompent pas au même endroit, et le
    // vote cellule par cellule les fait toutes remonter. Coût en temps : celui d'une seule passe.
    const baseInstructions = `${MARKER_INSTRUCTION}\n\n${brokerPromptHints(null)}`;
    const first = await runPasses(provider, {
      base64: prepared.base64, mediaType: prepared.mediaType, filename: file.name,
      extraInstructions: baseInstructions,
    }, config.passes, account.currency);

    if (first.outcomes.length === 0 && first.operations.length === 0) {
      const failure = first.error;
      const aborted = failure instanceof Error && failure.name === "AbortError";
      const message = failure instanceof Error ? failure.message : "Extraction impossible.";
      return Response.json({
        error: aborted
          ? `L'analyse IA a dépassé ${Math.round(config.timeoutMs / 1000)} s. Réessayez, ou scannez une page à la fois — un export CSV du même relevé reste la voie la plus fiable.`
          : `Analyse IA impossible : ${message}. Essayez un autre fichier, le CSV, ou la saisie manuelle.`,
      }, { status: 502 });
    }

    const context = await loadImportContext(account);

    // ---- RELEVÉ DE MOUVEMENTS : opérations datées → pipeline d'import existant --------------
    // Priorité aux opérations quand le document en contient : elles portent l'historique réel.
    if (first.operations.length > 0) {
      const { rows, summary } = buildPreviewFromOps(first.operations.map((entry) => entry.op), {
        accountId: account.id, accountCurrency: account.currency, accountType: context.kind,
        holdings: context.holdings, existingFingerprints: context.existingFingerprints,
        existingExternalRefs: context.existingExternalRefs,
        openingQuantities: context.openingQuantities, allowAdvanced: context.allowAdvanced,
      });
      const ai = first.operations.map((entry) => ({ confidence: entry.confidence, band: entry.band, page: entry.page, sourceText: entry.sourceText, warnings: entry.warnings }));
      const mergedRows = rows.map((row) => {
        const meta = ai[row.index - 1];
        return meta ? { ...row, warnings: [...new Set([...row.warnings, ...meta.warnings])], aiConfidence: meta.confidence, aiBand: meta.band, aiPage: meta.page, aiSourceText: meta.sourceText } : row;
      });
      return Response.json({
        account: accountPayload(account, context.kind),
        source: "ai_scan", mode: "operations", provider: provider.name,
        capture: capturePayload(file, captureHash, prepared),
        document: first.document,
        allowAdvanced: context.allowAdvanced,
        knownHoldings: context.holdings,
        summary, rows: mergedRows, ai,
      });
    }

    if (first.outcomes.length === 0) {
      return Response.json({
        error: "Le document a été transmis à l'IA, mais aucune ligne exploitable n'a été retranscrite — ni opération, ni position. Vérifiez que le relevé est net, entier et non protégé, puis réessayez ou utilisez le CSV.",
        code: "no_rows_detected",
        provider: provider.name,
      }, { status: 422 });
    }

    // ---- 4-6) CAPTURE DE POSITIONS : relevé canonique, consensus, contrôles -----------------
    const fallbackDate = parseDate(String(form.get("snapshotDate") ?? "").trim(), "iso");
    let outcomes = first.outcomes;
    let merged = mergeOutcomes(outcomes, account.currency, fallbackDate);
    let targetedPass = false;

    // ---- 7) Seconde passe CIBLÉE ------------------------------------------------------------
    // Elle n'est déclenchée que si la première lecture n'emporte pas la conviction : contrôle
    // comptable bloquant en échec, ou désaccord entre relectures. On renvoie alors la seule
    // BANDE DU TABLEAU, agrandie : à budget de jetons constant, chaque chiffre occupe deux fois
    // plus de pixels. Les nouvelles relectures s'ajoutent au vote, elles ne le remplacent pas.
    const needsSecondPass = mediaType !== "application/pdf"
      && (merged.checksSummary.blockingFailures > 0 || merged.reading.disputedCells > 0);
    if (needsSecondPass) {
      const region = merged.statement.header.broker === "boursobank" ? BOURSOBANK_TABLE_REGION : { top: 0.15, bottom: 1 };
      const zoomed = await prepareCapture(bytes, mediaType, { region });
      const focused = await runPasses(provider, {
        base64: zoomed.base64, mediaType: zoomed.mediaType, filename: file.name,
        extraInstructions: `${MARKER_INSTRUCTION}\n\n${brokerPromptHints(merged.statement.header.broker)}`,
        focusHint: "Cette image est un AGRANDISSEMENT de la zone du tableau de la même capture. Concentre-toi sur les colonnes chiffrées et recopie-les chiffre à chiffre.",
      }, Math.min(2, config.passes), account.currency);
      if (focused.outcomes.length > 0) {
        targetedPass = true;
        outcomes = [...outcomes, ...focused.outcomes.map((entry) => ({ ...entry, targeted: true }))];
        const retry = mergeOutcomes(outcomes, account.currency, fallbackDate);
        // On ne garde la relecture ciblée que si elle AMÉLIORE réellement le résultat.
        if (retry.checksSummary.blockingFailures <= merged.checksSummary.blockingFailures) merged = retry;
      }
    }

    // ---- Rapprochement avec le portefeuille déjà enregistré ---------------------------------
    const enriched = merged.statement.positions.map((position) => {
      const match = matchInstrument({ isin: position.isin, ticker: position.ticker, instrumentName: position.name }, context.holdings);
      const key = instrumentKeyOf({ isin: position.isin, ticker: position.ticker, instrumentName: position.name });
      const heldQuantity = context.openingQuantities[key] ?? 0;
      // Empreinte d'import : compte + date + instrument + quantité + montant. C'est elle qui
      // empêche la même ligne d'être intégrée deux fois, même via une capture différente.
      const fingerprint = computeFingerprint(account.id, {
        type: "correction", date: merged.statement.header.snapshotDate,
        isin: position.isin, ticker: position.ticker, instrumentName: position.name,
        quantity: position.quantity, unitPrice: position.costBasis !== null && position.quantity ? position.costBasis / position.quantity : null,
        amount: position.costBasis, fees: 0, taxes: null, currency: position.currency,
        exchangeRate: null, externalReference: null, note: null,
      });
      return {
        ...position,
        holdingId: match.holdingId,
        matchedBy: match.matchedBy,
        heldQuantity,
        alreadyImported: context.existingFingerprints.has(fingerprint),
        fingerprint,
      };
    });

    const preview = buildStatementOperations(merged.statement, {});

    return Response.json({
      account: accountPayload(account, context.kind),
      source: "ai_scan",
      mode: "statement",
      provider: provider.name,
      capture: { ...capturePayload(file, captureHash, prepared), targetedPass, passes: outcomes.length },
      broker: {
        id: merged.statement.header.broker,
        label: merged.statement.header.brokerLabel,
        recognised: merged.statement.header.broker !== "unknown",
      },
      // Respect du contrat par le modèle. Une clé inventée accompagne souvent une valeur inventée :
      // le manquement est affiché, pas absorbé en silence.
      schema: { strict: merged.strict, issues: merged.issues },
      statement: { header: merged.statement.header, positions: enriched, warnings: merged.statement.warnings },
      checks: merged.checks,
      checksSummary: merged.checksSummary,
      reading: merged.reading,
      operationsPreview: {
        count: preview.operations.length,
        totalCostBasis: preview.totalCostBasis,
        cashRecorded: preview.cashRecorded,
        notImported: preview.notImported,
      },
      reconciliation: {
        newPositions: enriched.filter((position) => !position.holdingId).length,
        existingPositions: enriched.filter((position) => position.holdingId).length,
        possibleDuplicates: enriched.filter((position) => position.alreadyImported).length,
        heldPositions: enriched.filter((position) => position.heldQuantity > 0).length,
        accountHasOperations: Object.keys(context.openingQuantities).length > 0,
      },
      duplicate: alreadyImported,
      captureHash,
      allowAdvanced: context.allowAdvanced,
      knownHoldings: context.holdings,
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}

function accountPayload(account: { id: string; name: string; currency: string; memberName: string | null }, kind: "PEA" | "CTO") {
  return { id: account.id, name: account.name, kind, currency: account.currency, memberName: account.memberName };
}

function capturePayload(file: File, hash: string, prepared: { mediaType: string; width: number | null; height: number | null; applied: string[]; original: boolean }) {
  return {
    filename: file.name,
    bytes: file.size,
    // Empreinte du CONTENU : c'est elle qui reconnaît une capture déjà intégrée, y compris
    // renommée. Elle ne révèle rien du document (fonction à sens unique).
    hash,
    mediaType: prepared.mediaType,
    width: prepared.width,
    height: prepared.height,
    preprocessing: prepared.applied,
    preprocessed: !prepared.original,
  };
}

/** Lance N relectures indépendantes en parallèle et convertit chacune en relevé canonique. */
async function runPasses(
  provider: { extract(input: ExtractInput): Promise<{ raw: unknown; normalized: RawExtraction }> },
  input: Omit<ExtractInput, "pass">,
  passes: number,
  accountCurrency: string,
): Promise<{
  outcomes: PassOutcome[];
  operations: ReturnType<typeof validateExtraction>["operations"];
  document: ReturnType<typeof validateExtraction>["document"] | null;
  error: unknown;
}> {
  const attempts = await Promise.allSettled(
    Array.from({ length: Math.max(1, passes) }, (_, index) => provider.extract({ ...input, pass: index + 1 })),
  );
  const fulfilled = attempts.filter((attempt) => attempt.status === "fulfilled").map((attempt) => attempt.value);
  const rejected = attempts.find((attempt) => attempt.status === "rejected");

  const outcomes: PassOutcome[] = [];
  let operations: ReturnType<typeof validateExtraction>["operations"] = [];
  let document: ReturnType<typeof validateExtraction>["document"] | null = null;

  for (const result of fulfilled) {
    // Le contrat Zod est vérifié sur la sortie BRUTE : la normaliser d'abord masquerait
    // précisément les manquements (clé inventée, valeur nue) que ce contrôle doit révéler.
    const verdict = parseModelStatement(result.raw);
    const statement = toStatement(verdict.data, { accountCurrency });
    if (statement.positions.length > 0) {
      outcomes.push({ statement, strict: verdict.strict, issues: verdict.issues, targeted: false });
      continue;
    }
    const parsed = validateExtraction(result.normalized, { accountCurrency });
    if (parsed.operations.length > operations.length) {
      operations = parsed.operations;
      document = parsed.document;
    }
  }

  return { outcomes, operations, document, error: rejected && rejected.status === "rejected" ? rejected.reason : null };
}

/** Vote entre relectures, puis contrôles comptables sur le relevé retenu. */
function mergeOutcomes(outcomes: PassOutcome[], accountCurrency: string, fallbackDate: string | null) {
  const statements = outcomes.map((entry) => entry.statement);
  const agreed = reconcilePositionPasses(statements.map(statementPositionRows));
  // Relecture de référence : la plus complète (elle fixe l'ordre des lignes et porte les textes
  // OCR d'origine réattachés après le vote).
  const reference = statements.reduce((best, current) => (current.positions.length > best.positions.length ? current : best), statements[0]);
  const headerVote = reconcileHeaders(statements.map((statement) => statement.header));

  const statement = statementFromConsensus(
    { ...reference, header: headerVote.header },
    agreed.rows,
    agreed.meta,
    { accountCurrency },
  );
  if (!statement.header.snapshotDate && fallbackDate) statement.header.snapshotDate = fallbackDate;

  const warnings = [...statement.warnings];
  for (const field of headerVote.disputed) {
    warnings.push(`« ${field} » a été lu différemment d'une relecture à l'autre : la valeur la plus fréquente est proposée, vérifiez-la sur le relevé.`);
  }
  if (!statement.header.snapshotDate) warnings.push("Date d'arrêté non lue sur le relevé : saisissez-la avant de valider.");
  statement.warnings = [...new Set(warnings)];

  const checks = runAccountingChecks(statement);
  return {
    statement,
    checks,
    checksSummary: summarizeChecks(checks),
    strict: outcomes.every((entry) => entry.strict),
    issues: [...new Set(outcomes.flatMap((entry) => entry.issues))].slice(0, 8),
    reading: {
      passes: agreed.passes,
      unanimousRows: agreed.consensus.filter((entry) => entry.disputed.length === 0 && entry.seenBy === agreed.passes).length,
      disputedCells: agreed.consensus.reduce((total, entry) => total + entry.disputed.length, 0),
      disputedHeaderFields: headerVote.disputed,
    },
  };
}

/**
 * Cette capture a-t-elle DÉJÀ été intégrée sur ce compte ? Recherche par empreinte du contenu :
 * un fichier renommé ou re-téléversé est reconnu. Seuls les lots réellement aboutis comptent —
 * un import annulé peut être refait.
 */
async function findExistingBatch(accountId: string, hash: string): Promise<{ batchId: string; importedAt: string | null; filename: string | null; importedRows: number } | null> {
  try {
    const rows = await supabaseRest<Array<{ id: string; created_at: string | null; completed_at: string | null; original_filename: string | null; imported_rows: number }>>(
      `investment_import_batches?select=id,created_at,completed_at,original_filename,imported_rows`
      + `&account_id=eq.${encodeURIComponent(accountId)}&file_fingerprint=eq.${encodeURIComponent(hash)}`
      + `&status=eq.completed&order=created_at.desc&limit=1`,
    );
    const row = rows?.[0];
    return row ? { batchId: row.id, importedAt: row.completed_at ?? row.created_at, filename: row.original_filename, importedRows: row.imported_rows } : null;
  } catch {
    // Traçabilité des imports non déployée : le dédoublonnage par capture est simplement
    // indisponible. On ne bloque pas l'analyse pour autant.
    return null;
  }
}
