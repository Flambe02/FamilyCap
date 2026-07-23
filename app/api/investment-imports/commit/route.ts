import { authErrorResponse, requireAdmin } from "../../../../lib/auth-server";
import { supabaseRest } from "../../../../lib/supabase-rest";
import { buildOperationRecord } from "../../../../lib/account-operation";
import {
  computeFingerprint, matchInstrument, instrumentKeyOf, isValidIsin,
  type NormalizedOp,
} from "../../../../lib/investment-import";
import { loadImportAccount, loadImportContext, isOperationAccount, MAX_ROWS } from "../../../../lib/investment-import-server";

// COMMIT d'un import. Admin uniquement. Revalide TOUT côté serveur (ne fait jamais confiance aux
// totaux ni au member_id du client) : chaque opération repasse par buildOperationRecord, la garde
// PEA « vente > détenu » est rejouée, les doublons certains sont exclus. Écriture en 2 temps :
// (1) validation complète SANS écriture — si une seule erreur bloquante, on abandonne (aucun
// portefeuille partiel) ; (2) création du lot, des instruments manquants (sans cours inventé) et
// insertion ATOMIQUE des opérations (POST tableau = tout ou rien).

export const runtime = "nodejs";

type NewInstrument = { isin?: string | null; ticker?: string | null; name?: string | null; assetType?: string | null; currency?: string | null };
type CommitBody = {
  accountId?: string;
  filename?: string;
  fileType?: string;
  fileFingerprint?: string;
  sourceKind?: "file" | "ai_scan";
  mapping?: unknown;
  operations?: NormalizedOp[];
  newInstruments?: NewInstrument[];
};

const ASSET_TYPES = new Set(["stock", "etf", "fund", "bond", "crypto", "cash", "other"]);

function setupResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Erreur Supabase";
  if (message.includes("investment_import_batches") || message.includes("import_batch_id") || message.includes("import_fingerprint") || message.includes("external_reference")) {
    return Response.json({ error: "La migration d'import (20260726_investment_imports.sql) doit être appliquée dans Supabase.", setupRequired: true }, { status: 503 });
  }
  if (message.includes("exchange_rate") || message.includes("taxes") || message.includes("_type_check")) {
    return Response.json({ error: "La migration compte-titres (20260725) doit être appliquée pour les transferts / taxes / taux de change.", setupRequired: true }, { status: 503 });
  }
  if (message.includes("account_operations") || message.includes("PGRST205")) {
    return Response.json({ error: "La migration des opérations (20260722) doit être appliquée dans Supabase.", setupRequired: true }, { status: 503 });
  }
  return authErrorResponse(error);
}

export async function POST(request: Request) {
  let batchId: string | null = null;
  try {
    const admin = await requireAdmin(request);
    const body = (await request.json()) as CommitBody;

    const accountId = String(body.accountId ?? "").trim();
    const operations = Array.isArray(body.operations) ? body.operations : [];
    if (!accountId) return Response.json({ error: "Le compte est obligatoire." }, { status: 400 });
    if (operations.length === 0) return Response.json({ error: "Aucune opération à importer." }, { status: 400 });
    if (operations.length > MAX_ROWS) return Response.json({ error: `Trop d'opérations (${operations.length} > ${MAX_ROWS}).` }, { status: 413 });

    const account = await loadImportAccount(accountId);
    if (!account) return Response.json({ error: "Compte introuvable." }, { status: 404 });
    if (!isOperationAccount(account.accountType)) return Response.json({ error: "Ce type de compte n'accepte pas d'opérations." }, { status: 400 });
    if (!account.isActive) return Response.json({ error: "Ce compte est archivé : réactivez-le avant d'importer." }, { status: 409 });

    const context = await loadImportContext(account);
    const held: Record<string, number> = { ...context.openingQuantities };

    // ---- PASSE 1 : validation complète, AUCUNE écriture ----
    const toInsert: Record<string, unknown>[] = [];
    const errors: Array<{ line: number; error: string }> = [];
    let duplicates = 0;
    const seenFingerprints = new Set<string>();

    // Simulation « vente > détenu » dans l'ordre chronologique (indépendant de l'ordre d'envoi).
    const ordered = operations
      .map((op, i) => ({ op, i }))
      .sort((a, b) => String(a.op.date ?? "9999").localeCompare(String(b.op.date ?? "9999")) || a.i - b.i);

    for (const { op, i } of ordered) {
      const line = i + 1;
      const fingerprint = computeFingerprint(account.id, op);
      const extRef = op.externalReference?.trim() || null;

      // Doublon CERTAIN (référence externe déjà en base) → exclu (jamais réécrit).
      if (extRef && context.existingExternalRefs.has(extRef)) { duplicates++; continue; }

      // Transferts / colonnes avancées sans migration 20260725 → neutralisés / rejetés.
      const advancedOp: NormalizedOp = context.allowAdvanced ? op : { ...op, taxes: null, exchangeRate: null };
      if (!context.allowAdvanced && (op.type === "transfer_in" || op.type === "transfer_out")) {
        errors.push({ line, error: "Transfert de titres impossible sans la migration 20260725." });
        continue;
      }

      // Construction + validation via la SOURCE DE VÉRITÉ partagée (member_id forcé).
      const built = buildOperationRecord(
        {
          type: advancedOp.type ?? undefined, date: advancedOp.date ?? undefined,
          assetName: advancedOp.instrumentName ?? undefined, ticker: advancedOp.ticker ?? undefined, isin: advancedOp.isin ?? undefined,
          quantity: advancedOp.quantity, unitPrice: advancedOp.unitPrice,
          grossAmount: (advancedOp.type === "achat" || advancedOp.type === "vente" || advancedOp.type === "transfer_in" || advancedOp.type === "transfer_out") ? advancedOp.amount : undefined,
          netAmount: (advancedOp.type === "achat" || advancedOp.type === "vente" || advancedOp.type === "transfer_in" || advancedOp.type === "transfer_out") ? undefined : advancedOp.amount,
          fees: advancedOp.fees ?? undefined, taxes: advancedOp.taxes ?? undefined, currency: advancedOp.currency,
          exchangeRate: advancedOp.exchangeRate ?? undefined, note: advancedOp.note ?? undefined,
        },
        { memberId: account.memberId, source: body.sourceKind === "ai_scan" ? "ai_scan" : "import", externalReference: extRef, importFingerprint: fingerprint },
      );
      if (!built.ok) { errors.push({ line, error: built.error }); continue; }

      // Garde PEA : vente supérieure à la quantité détenue (opening + import simulé).
      const key = instrumentKeyOf(advancedOp);
      if (advancedOp.type === "achat" || advancedOp.type === "transfer_in") held[key] = (held[key] ?? 0) + Number(advancedOp.quantity ?? 0);
      else if (advancedOp.type === "vente" || advancedOp.type === "transfer_out") {
        const available = held[key] ?? 0;
        if (context.kind === "PEA" && Number(advancedOp.quantity ?? 0) > available + 1e-9) {
          errors.push({ line, error: `Vente de ${advancedOp.quantity} > quantité détenue (${available}).` });
          continue;
        }
        held[key] = available - Number(advancedOp.quantity ?? 0);
      }

      seenFingerprints.add(fingerprint);
      toInsert.push(built.record);
    }

    // Une seule erreur bloquante → aucun import (pas de portefeuille partiel).
    if (errors.length > 0) {
      return Response.json({ error: "Import refusé : certaines lignes sont invalides. Corrigez-les puis réessayez.", invalidLines: errors, setupRequired: false }, { status: 422 });
    }
    if (toInsert.length === 0) {
      return Response.json({ imported: 0, duplicates, message: "Toutes les lignes étaient des doublons : rien à importer." });
    }

    // ---- PASSE 2 : écriture ----
    // Lot d'import (member_id dérivé du compte ; imported_by = administrateur).
    const batchRows = await supabaseRest<Array<{ id: string }>>("investment_import_batches", {
      method: "POST",
      headers: { prefer: "return=representation" },
      body: JSON.stringify({
        account_id: account.id, member_id: account.memberId, imported_by: admin.id,
        original_filename: (body.filename ?? "").slice(0, 200) || null,
        file_type: (body.fileType ?? "csv").slice(0, 20),
        file_fingerprint: (body.fileFingerprint ?? "").slice(0, 64) || null,
        source_kind: body.sourceKind === "ai_scan" ? "ai_scan" : "file",
        status: "pending",
        mapping: body.mapping ?? null,
        total_rows: operations.length, duplicate_rows: duplicates,
      }),
    });
    batchId = batchRows[0]?.id ?? null;
    if (!batchId) throw new Error("Création du lot d'import impossible.");

    // Instruments manquants validés (aucun cours inventé : last_price null).
    const createdInstruments = await createMissingHoldings(account.id, body.newInstruments ?? [], context.holdings);

    // Rattachement de chaque opération à son lot, puis insertion ATOMIQUE (tableau = tout ou rien).
    const records = toInsert.map((record) => ({ ...record, account_id: account.id, import_batch_id: batchId }));
    await supabaseRest("account_operations", {
      method: "POST",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify(records),
    });

    await supabaseRest(`investment_import_batches?id=eq.${encodeURIComponent(batchId)}`, {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ status: "completed", imported_rows: records.length, duplicate_rows: duplicates, error_rows: 0, completed_at: new Date().toISOString() }),
    });

    return Response.json({ batchId, imported: records.length, duplicates, newInstruments: createdInstruments, message: `${records.length} opération(s) importée(s).` }, { status: 201 });
  } catch (error) {
    // Échec après création du lot → on marque le lot 'failed' (les opérations n'ont PAS été
    // insérées de façon partielle : l'insert est atomique). Best-effort, on n'écrase pas l'erreur.
    if (batchId) {
      try {
        await supabaseRest(`investment_import_batches?id=eq.${encodeURIComponent(batchId)}`, {
          method: "PATCH", headers: { prefer: "return=minimal" },
          body: JSON.stringify({ status: "failed" }),
        });
      } catch { /* best-effort */ }
    }
    return setupResponse(error);
  }
}

async function createMissingHoldings(accountId: string, requested: NewInstrument[], existing: Array<{ isin: string | null; symbol: string | null; name: string | null }>): Promise<number> {
  let created = 0;
  for (const instrument of requested) {
    const name = (instrument.name ?? "").trim();
    if (!name) continue;
    const isin = (instrument.isin ?? "").trim().toUpperCase() || null;
    const ticker = (instrument.ticker ?? "").trim().toUpperCase() || null;
    if (isin && !isValidIsin(isin)) continue; // ISIN invalide → on ne crée pas d'entrée douteuse
    const already = matchInstrument({ isin, ticker, instrumentName: name }, existing.map((h, idx) => ({ id: String(idx), isin: h.isin, symbol: h.symbol, name: h.name })));
    if (already.holdingId) continue; // évite les doublons d'ISIN / ticker / nom
    await supabaseRest("holdings", {
      method: "POST",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({
        account_id: accountId,
        asset_type: ASSET_TYPES.has(instrument.assetType ?? "") ? instrument.assetType : "other",
        symbol: ticker, isin, name,
        quantity: 0, average_cost: null, currency: (instrument.currency || "EUR").toUpperCase(),
        market_provider: "manual", last_price: null, last_price_at: null, // aucun cours inventé
      }),
    });
    existing.push({ isin, symbol: ticker, name });
    created++;
  }
  return created;
}
