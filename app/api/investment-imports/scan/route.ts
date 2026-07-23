import { authErrorResponse, requireAdmin } from "../../../../lib/auth-server";
import { buildPreviewFromOps } from "../../../../lib/investment-import";
import { loadImportAccount, loadImportContext, isOperationAccount } from "../../../../lib/investment-import-server";
import { getDocumentAiConfig, getDocumentProvider } from "../../../../lib/document-extraction/provider";
import { validateExtraction } from "../../../../lib/document-extraction/extract";

// SCAN IA d'un relevé (PDF / image) — étape d'import, PAS un second moteur financier. Admin
// uniquement. Le fichier est traité de façon TRANSITOIRE (jamais stocké) : on l'encode, on
// appelle le fournisseur IA côté serveur, on VALIDE la sortie par schéma + contrôles
// déterministes, puis on renvoie la MÊME prévisualisation que l'import CSV (rien n'est écrit).
// L'IA n'extrait que des champs bruts ; tous les calculs restent dans computeAccountModel.

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
    const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
    let raw;
    try {
      raw = await provider.extract({ base64, mediaType, filename: file.name });
    } catch (extractError) {
      const aborted = extractError instanceof Error && extractError.name === "AbortError";
      const message = extractError instanceof Error ? extractError.message : "Extraction impossible.";
      return Response.json({ error: aborted ? "L'analyse IA a expiré. Réessayez avec un fichier plus court, ou utilisez le CSV." : `Analyse IA impossible : ${message}. Essayez un autre fichier, le CSV, ou la saisie manuelle.` }, { status: 502 });
    }

    const { document, operations } = validateExtraction(raw, { accountCurrency: account.currency, thresholds: config.thresholds });
    if (operations.length === 0) {
      return Response.json({ error: "Aucune opération détectée dans ce document. Vérifiez qu'il s'agit d'un relevé lisible, ou utilisez le CSV." }, { status: 422 });
    }

    const context = await loadImportContext(account);
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
