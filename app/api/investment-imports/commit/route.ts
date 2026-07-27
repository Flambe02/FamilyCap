import { authErrorResponse, requireAdmin } from "../../../../lib/auth-server";
import { supabaseRest } from "../../../../lib/supabase-rest";
import { buildOperationRecord } from "../../../../lib/account-operation";
import {
  computeFingerprint, matchInstrument, instrumentKeyOf, isValidIsin, operationAmountFields,
  type NormalizedOp,
} from "../../../../lib/investment-import";
import { loadImportAccount, loadImportContext, isOperationAccount, MAX_ROWS } from "../../../../lib/investment-import-server";
import { reconcileOnboardingForMember } from "../../../../lib/onboarding-challenges-service";
import {
  buildStatementOperations, runAccountingChecks, sanitizeStatementInput, statementInstruments,
  summarizeChecks,
} from "../../../../lib/document-extraction/statement";

// COMMIT d'un import. Admin uniquement. Revalide TOUT côté serveur (ne fait jamais confiance aux
// totaux ni au member_id du client) : chaque opération repasse par buildOperationRecord, la garde
// PEA « vente > détenu » est rejouée, les doublons certains sont exclus.
//
// DEUX ENTRÉES, une seule écriture :
//   • `operations` — import CSV / XLSX / relevé de mouvements : les opérations viennent du client
//     mais sont intégralement revalidées ici ;
//   • `statement`  — capture de portefeuille validée à l'écran : le serveur REJOUE les contrôles
//     comptables et RECONSTRUIT lui-même les opérations (buildStatementOperations). Le navigateur
//     ne décide que des valeurs LUES ; ni le coût de revient, ni la trésorerie, ni le type
//     d'opération ne lui sont empruntés.
//
// Écriture : une RPC TRANSACTIONNELLE (`commit_investment_import`, migration 20260808) fait
// lot + instruments + opérations d'un seul bloc. Si la migration n'est pas appliquée, on retombe
// sur l'écriture séquentielle historique, dont l'ordre (insérer PUIS supprimer) garantit qu'un
// échec laisse au pire un doublon réparable, jamais une perte de données.

export const runtime = "nodejs";

type NewInstrument = { isin?: string | null; ticker?: string | null; name?: string | null; assetType?: string | null; currency?: string | null; lastPrice?: number | null; lastPriceAt?: string | null };
type SnapshotInput = { asOfDate?: string; positions?: Array<{ isin?: string | null; ticker?: string | null; name?: string | null; currency?: string | null; lastPrice?: number | null; lastPriceAt?: string | null }> };
type CommitBody = {
  accountId?: string;
  filename?: string;
  fileType?: string;
  fileFingerprint?: string;
  sourceKind?: "file" | "ai_scan";
  mapping?: unknown;
  operations?: NormalizedOp[];
  newInstruments?: NewInstrument[];
  portfolioSnapshot?: SnapshotInput;
  /** Capture de portefeuille validée à l'écran (mode « statement »). */
  statement?: unknown;
  /** Enregistrer le solde espèces du relevé (case cochée dans l'écran de validation). */
  includeCash?: boolean;
  /** Positions décochées par l'administrateur (index 1-based de l'écran de validation). */
  excludedIndexes?: number[];
  /** Contrôles comptables en échec assumés explicitement par l'administrateur. */
  acknowledgeChecks?: boolean;
  /** Réimporter une capture déjà intégrée (l'administrateur a vu l'avertissement). */
  force?: boolean;
  /**
   * « Remplacer le portefeuille » : les opérations existantes du compte sont supprimées et
   * remplacées par celles du fichier. Destructif → l'appelant doit renvoyer le nom exact du
   * compte dans `replaceConfirm`.
   */
  replaceExisting?: boolean;
  replaceConfirm?: string;
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
    if (!accountId) return Response.json({ error: "Le compte est obligatoire." }, { status: 400 });

    const account = await loadImportAccount(accountId);
    if (!account) return Response.json({ error: "Compte introuvable." }, { status: 404 });
    if (!isOperationAccount(account.accountType)) return Response.json({ error: "Ce type de compte n'accepte pas d'opérations." }, { status: 400 });
    if (!account.isActive) return Response.json({ error: "Ce compte est archivé : réactivez-le avant d'importer." }, { status: 409 });

    const captureHash = String(body.fileFingerprint ?? "").trim().slice(0, 64) || null;

    // ---- Entrée « capture de portefeuille » : contrôles rejoués, opérations reconstruites ----
    let operations: NormalizedOp[];
    let requestedInstruments: NewInstrument[];
    let snapshotForPrices: SnapshotInput | undefined;
    let statementSummary: Record<string, unknown> | null = null;
    let snapshotDate: string | null = null;
    const hardDedup = body.statement !== undefined && body.statement !== null;

    if (hardDedup) {
      const statement = sanitizeStatementInput(body.statement, { accountCurrency: account.currency });
      if (!statement) return Response.json({ error: "Relevé illisible : relancez l'analyse de la capture." }, { status: 400 });
      if (!statement.header.snapshotDate) {
        return Response.json({ error: "La date d'arrêté du relevé est obligatoire (AAAA-MM-JJ)." }, { status: 400 });
      }
      if (statement.positions.length === 0) {
        return Response.json({ error: "Aucune position à importer." }, { status: 400 });
      }

      // Une capture déjà intégrée n'est jamais réimportée en silence.
      if (captureHash && !body.force) {
        const existing = await findCompletedBatch(account.id, captureHash);
        if (existing) {
          return Response.json({
            error: "Cette capture semble déjà avoir été intégrée.",
            code: "duplicate_capture", duplicate: existing,
          }, { status: 409 });
        }
      }

      // Les contrôles comptables sont REJOUÉS sur le relevé tel qu'il a été corrigé : un contrôle
      // bloquant en échec interdit l'import, sauf reconnaissance explicite de l'administrateur.
      const checks = runAccountingChecks(statement);
      const summary = summarizeChecks(checks);
      if (!summary.importable && body.acknowledgeChecks !== true) {
        return Response.json({
          error: "Import refusé : les contrôles comptables du relevé ne tombent pas juste. Corrigez les champs signalés, ou confirmez explicitement l'import.",
          code: "checks_failed",
          checks: checks.filter((entry) => !entry.ok),
          checksSummary: summary,
        }, { status: 422 });
      }

      const built = buildStatementOperations(statement, {
        includeCash: body.includeCash !== false,
        excludeIndexes: Array.isArray(body.excludedIndexes) ? body.excludedIndexes.map(Number).filter(Number.isFinite) : [],
      });
      operations = built.operations;
      snapshotDate = statement.header.snapshotDate;
      // Instruments et cours : déduits du relevé côté serveur, pas de la liste du navigateur.
      requestedInstruments = statementInstruments(
        statement,
        Array.isArray(body.excludedIndexes) ? body.excludedIndexes.map(Number).filter(Number.isFinite) : [],
      ).map((instrument) => ({ ...instrument, assetType: "other" }));
      snapshotForPrices = { asOfDate: statement.header.snapshotDate, positions: requestedInstruments };
      // En-tête conservé sur le lot pour le RAPPROCHEMENT d'un import ultérieur. Le numéro de
      // compte n'y est que masqué (sanitizeStatementInput le re-tronque).
      statementSummary = {
        broker: statement.header.broker,
        accountName: statement.header.accountName,
        accountNumberMasked: statement.header.accountNumberMasked,
        snapshotDate: statement.header.snapshotDate,
        openingDate: statement.header.openingDate,
        managementMode: statement.header.managementMode,
        totalPortfolio: statement.header.totalPortfolio,
        availableCash: statement.header.availableCash,
        securitiesValue: statement.header.securitiesValue,
        unrealizedGain: statement.header.unrealizedGain,
        depositCeiling: statement.header.depositCeiling,
        cumulativeDeposits: statement.header.cumulativeDeposits,
        currency: statement.header.currency,
        totalCostBasis: built.totalCostBasis,
        cashRecorded: built.cashRecorded,
        checks: summary,
      };
    } else {
      operations = Array.isArray(body.operations) ? body.operations : [];
      requestedInstruments = body.newInstruments ?? [];
      snapshotForPrices = body.portfolioSnapshot;
    }

    if (operations.length === 0) return Response.json({ error: "Aucune opération à importer." }, { status: 400 });
    if (operations.length > MAX_ROWS) return Response.json({ error: `Trop d'opérations (${operations.length} > ${MAX_ROWS}).` }, { status: 413 });

    // Mode « remplacer » : confirmation explicite, puis contexte calculé COMME SI le compte était
    // vide (quantités d'ouverture nulles, aucun doublon opposé à des lignes qui vont disparaître).
    const replaceExisting = body.replaceExisting === true;
    if (replaceExisting && String(body.replaceConfirm ?? "").trim() !== account.name.trim()) {
      return Response.json({ error: `Confirmation requise : saisissez le nom exact du compte (« ${account.name} ») pour remplacer le portefeuille.` }, { status: 428 });
    }
    const context = await loadImportContext(account, { ignoreExistingOperations: replaceExisting });
    const held: Record<string, number> = { ...context.openingQuantities };

    // ---- PASSE 1 : validation complète, AUCUNE écriture ----
    const toInsert: Record<string, unknown>[] = [];
    const errors: Array<{ line: number; error: string }> = [];
    let duplicates = 0;

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
      // Doublon par EMPREINTE (compte + date + instrument + quantité + montant) : écarté sans
      // discussion pour une capture de portefeuille — une même position ne peut pas être reprise
      // deux fois à la même date. Pour un import d'OPÉRATIONS en revanche, deux achats
      // identiques le même jour sont parfaitement possibles : l'empreinte n'y vaut qu'un
      // avertissement « doublon possible » dans l'aperçu, et l'administrateur tranche.
      if (hardDedup && context.existingFingerprints.has(fingerprint)) { duplicates++; continue; }

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
          ...operationAmountFields(advancedOp),
          fees: advancedOp.fees ?? undefined, taxes: advancedOp.taxes ?? undefined, currency: advancedOp.currency,
          exchangeRate: advancedOp.exchangeRate ?? undefined, note: advancedOp.note ?? undefined,
        },
        context.importTracking
          ? { memberId: account.memberId, source: body.sourceKind === "ai_scan" ? "ai_scan" : "import", externalReference: extRef, importFingerprint: fingerprint }
          : { memberId: account.memberId, source: body.sourceKind === "ai_scan" ? "ai_scan" : "import" },
      );
      if (!built.ok) { errors.push({ line, error: built.error }); continue; }

      // Garde PEA : vente supérieure à la quantité détenue (opening + import simulé).
      const key = instrumentKeyOf(advancedOp);
      if (advancedOp.type === "achat" || advancedOp.type === "transfer_in" || advancedOp.type === "correction") {
        held[key] = (held[key] ?? 0) + Number(advancedOp.quantity ?? 0);
      } else if (advancedOp.type === "vente" || advancedOp.type === "transfer_out") {
        const available = held[key] ?? 0;
        if (context.kind === "PEA" && Number(advancedOp.quantity ?? 0) > available + 1e-9) {
          errors.push({ line, error: `Vente de ${advancedOp.quantity} > quantité détenue (${available}).` });
          continue;
        }
        held[key] = available - Number(advancedOp.quantity ?? 0);
      }

      toInsert.push(built.record);
    }

    // Une seule erreur bloquante → aucun import (pas de portefeuille partiel).
    if (errors.length > 0) {
      return Response.json({ error: "Import refusé : certaines lignes sont invalides. Corrigez-les puis réessayez.", invalidLines: errors, setupRequired: false }, { status: 422 });
    }
    if (toInsert.length === 0) {
      return Response.json({ imported: 0, duplicates, message: "Toutes les lignes étaient des doublons : rien à importer." });
    }

    const batchMeta = {
      original_filename: (body.filename ?? "").slice(0, 200) || null,
      file_type: (body.fileType ?? "csv").slice(0, 20),
      file_fingerprint: captureHash,
      source_kind: body.sourceKind === "ai_scan" ? "ai_scan" : "file",
      mapping: body.mapping ?? null,
      total_rows: operations.length,
      duplicate_rows: duplicates,
      snapshot_date: snapshotDate,
      statement: statementSummary,
    };

    // ---- PASSE 2 : écriture ATOMIQUE (RPC) ou, à défaut, séquentielle ----
    const atomic = await commitAtomically({
      accountId: account.id, importedBy: admin.id, batch: batchMeta,
      instruments: requestedInstruments, operations: toInsert, replace: replaceExisting,
    });

    let created: number;
    let replaced: number;
    if (atomic) {
      batchId = atomic.batchId;
      created = atomic.createdInstruments;
      replaced = atomic.replaced;
    } else {
      const sequential = await commitSequentially({
        account, admin, batchMeta, context, replaceExisting,
        instruments: requestedInstruments, snapshot: snapshotForPrices,
        records: toInsert, duplicates,
      });
      batchId = sequential.batchId;
      created = sequential.createdInstruments;
      replaced = sequential.replaced;
    }

    // Reconnaissance automatique des missions « Ajoute ton portefeuille » / « Premier
    // investissement » (best-effort ; couvre aussi bien l'import de relevé que l'import CSV/XLSX).
    try { await reconcileOnboardingForMember(account.memberId); } catch { /* best-effort */ }

    return Response.json({
      batchId, imported: toInsert.length, duplicates, newInstruments: created, replaced,
      atomic: Boolean(atomic),
      tracking: context.importTracking ? "complete" : "limited",
      message: replaceExisting
        ? `${toInsert.length} opération(s) importée(s), ${replaced} ancienne(s) opération(s) remplacée(s).`
        : `${toInsert.length} opération(s) importée(s).`,
    }, { status: 201 });
  } catch (error) {
    // Échec après création du lot → on marque le lot 'failed'. L'insert des opérations est
    // atomique (RPC, ou POST tableau) : il n'y a jamais d'import partiellement écrit.
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

/** Ce fichier a-t-il déjà été importé avec succès sur ce compte ? */
async function findCompletedBatch(accountId: string, hash: string) {
  try {
    const rows = await supabaseRest<Array<{ id: string; created_at: string | null; completed_at: string | null; original_filename: string | null; imported_rows: number }>>(
      `investment_import_batches?select=id,created_at,completed_at,original_filename,imported_rows`
      + `&account_id=eq.${encodeURIComponent(accountId)}&file_fingerprint=eq.${encodeURIComponent(hash)}`
      + `&status=eq.completed&order=created_at.desc&limit=1`,
    );
    const row = rows?.[0];
    return row ? { batchId: row.id, importedAt: row.completed_at ?? row.created_at, filename: row.original_filename, importedRows: row.imported_rows } : null;
  } catch {
    return null;
  }
}

/**
 * Écriture en UNE transaction via la RPC `commit_investment_import` (migration 20260808).
 * Renvoie null si la fonction n'existe pas encore : l'appelant retombe alors sur l'écriture
 * séquentielle. Toute AUTRE erreur est propagée — un échec de transaction ne doit pas être
 * rattrapé par une écriture non transactionnelle.
 */
async function commitAtomically(params: {
  accountId: string; importedBy: string; batch: Record<string, unknown>;
  instruments: NewInstrument[]; operations: Record<string, unknown>[]; replace: boolean;
}): Promise<{ batchId: string; createdInstruments: number; replaced: number } | null> {
  try {
    const result = await supabaseRest<{ batch_id: string; imported: number; created_instruments: number; replaced: number }>(
      "rpc/commit_investment_import",
      {
        method: "POST",
        body: JSON.stringify({
          p_account_id: params.accountId,
          p_imported_by: params.importedBy,
          p_batch: params.batch,
          p_instruments: params.instruments.map((instrument) => ({
            isin: instrument.isin && isValidIsin(instrument.isin) ? instrument.isin : null,
            ticker: instrument.ticker ?? null,
            name: instrument.name ?? null,
            asset_type: ASSET_TYPES.has(instrument.assetType ?? "") ? instrument.assetType : "other",
            currency: instrument.currency ?? "EUR",
            last_price: Number.isFinite(Number(instrument.lastPrice)) ? Number(instrument.lastPrice) : null,
            last_price_at: instrument.lastPriceAt ?? null,
          })),
          p_operations: params.operations,
          p_replace: params.replace,
        }),
      },
    );
    if (!result?.batch_id) return null;
    return { batchId: result.batch_id, createdInstruments: result.created_instruments ?? 0, replaced: result.replaced ?? 0 };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    // PGRST202 / 404 : la fonction n'est pas déployée (migration 20260808 non jouée).
    if (message.includes("PGRST202") || message.includes("commit_investment_import") || message.includes("404")) return null;
    throw error;
  }
}

/** Écriture séquentielle historique — utilisée tant que la migration 20260808 n'est pas jouée. */
async function commitSequentially(params: {
  account: { id: string; memberId: string; name: string };
  admin: { id: string };
  batchMeta: Record<string, unknown>;
  context: Awaited<ReturnType<typeof loadImportContext>>;
  replaceExisting: boolean;
  instruments: NewInstrument[];
  snapshot: SnapshotInput | undefined;
  records: Record<string, unknown>[];
  duplicates: number;
}): Promise<{ batchId: string | null; createdInstruments: number; replaced: number }> {
  const { account, admin, context, replaceExisting } = params;

  // Lignes actuelles, capturées AVANT toute écriture : ce sont elles (et elles seules) qui
  // seront supprimées après une insertion réussie en mode « remplacer ».
  const previousIds = replaceExisting
    ? (await supabaseRest<Array<{ id: string }>>(`account_operations?select=id&account_id=eq.${encodeURIComponent(account.id)}`).catch(() => []))?.map((row) => row.id) ?? []
    : [];

  let batchId: string | null = null;
  if (context.importTracking) {
    const batchRows = await supabaseRest<Array<{ id: string }>>("investment_import_batches", {
      method: "POST",
      headers: { prefer: "return=representation" },
      body: JSON.stringify({
        ...params.batchMeta,
        account_id: account.id, member_id: account.memberId, imported_by: admin.id, status: "pending",
        // snapshot_date / statement n'existent qu'avec la migration 20260808 : on ne les envoie
        // pas ici, précisément parce que cette branche est celle où elle n'est pas jouée.
        snapshot_date: undefined, statement: undefined,
      }),
    });
    batchId = batchRows[0]?.id ?? null;
    if (!batchId) throw new Error("Création du lot d'import impossible.");
  }

  const createdInstruments = await createMissingHoldings(account.id, params.instruments, context.holdings);
  if (params.snapshot?.positions?.length) await updateSnapshotPrices(account.id, params.snapshot, context.holdings);

  await supabaseRest("account_operations", {
    method: "POST",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify(params.records.map((record) => ({
      ...record,
      account_id: account.id,
      ...(context.importTracking && batchId ? { import_batch_id: batchId } : {}),
    }))),
  });

  let replaced = 0;
  if (replaceExisting && previousIds.length > 0) {
    const removed = await supabaseRest<Array<{ id: string }>>(
      `account_operations?id=in.(${previousIds.map((value) => encodeURIComponent(value)).join(",")})`,
      { method: "DELETE", headers: { prefer: "return=representation" } },
    );
    replaced = removed?.length ?? previousIds.length;
    try {
      await supabaseRest(`investment_import_batches?account_id=eq.${encodeURIComponent(account.id)}&status=eq.completed${batchId ? `&id=neq.${encodeURIComponent(batchId)}` : ""}`, {
        method: "PATCH", headers: { prefer: "return=minimal" },
        body: JSON.stringify({ status: "cancelled", cancelled_at: new Date().toISOString() }),
      });
    } catch { /* traçabilité non déployée : sans effet sur l'import */ }
  }

  if (batchId) {
    await supabaseRest(`investment_import_batches?id=eq.${encodeURIComponent(batchId)}`, {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ status: "completed", imported_rows: params.records.length, duplicate_rows: params.duplicates, error_rows: 0, completed_at: new Date().toISOString() }),
    });
  }
  return { batchId, createdInstruments, replaced };
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
        // `holdings` reste un RÉFÉRENTIEL de prix : sa quantité n'est jamais alimentée par un
        // import — la quantité détenue est dérivée des opérations par computeAccountModel.
        quantity: 0, average_cost: null, currency: (instrument.currency || "EUR").toUpperCase(),
        last_price: Number.isFinite(Number(instrument.lastPrice)) ? Number(instrument.lastPrice) : null,
        last_price_at: instrument.lastPriceAt || null,
        market_provider: instrument.lastPrice === null || instrument.lastPrice === undefined ? "manual" : "file_import",
      }),
    });
    existing.push({ isin, symbol: ticker, name });
    created++;
  }
  return created;
}

async function updateSnapshotPrices(
  accountId: string,
  snapshot: SnapshotInput,
  holdings: Array<{ id: string; isin: string | null; symbol: string | null; name: string | null }>,
) {
  for (const position of snapshot.positions ?? []) {
    const lastPrice = position.lastPrice === null || position.lastPrice === undefined ? null : Number(position.lastPrice);
    if (lastPrice === null || !Number.isFinite(lastPrice) || lastPrice < 0) continue;
    const match = matchInstrument(
      { isin: position.isin ?? null, ticker: position.ticker ?? null, instrumentName: position.name ?? null },
      holdings,
    );
    if (!match.holdingId) continue;
    await supabaseRest(`holdings?id=eq.${encodeURIComponent(match.holdingId)}&account_id=eq.${encodeURIComponent(accountId)}`, {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({
        last_price: lastPrice,
        last_price_at: position.lastPriceAt || snapshot.asOfDate || null,
        market_provider: "file_import",
      }),
    });
  }
}
