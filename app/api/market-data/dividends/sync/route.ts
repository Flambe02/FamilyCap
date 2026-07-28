// Synchronisation des dividendes d'un compte PEA / compte-titres (administrateur).
//
// POURQUOI CETTE ROUTE EXISTE : jusqu'ici, `corporate_actions` n'était écrite NULLE PART. Le seul
// appelant de `syncMarketData` passait `includeCorporateActions: false`, et le fournisseur primaire
// (EODHD) exige une clé qui n'est pas configurée. Les dividendes affichés provenaient donc de
// lignes héritées, figées, et aucun instrument nouvellement acheté ne pouvait en obtenir — c'est
// exactement le symptôme observé sur Sanofi.
//
// Ce que la route écrit, et ce qu'elle n'écrit pas :
//   * elle écrit UNIQUEMENT dans `corporate_actions` (référentiel d'événements) ;
//   * elle n'écrit JAMAIS dans `account_operations`. Un dividende détaché n'est pas un dividende
//     encaissé : transformer une annonce en opération fabriquerait une recette que personne n'a
//     reçue, et fausserait la trésorerie ;
//   * un ETF capitalisant est ignoré : il ne verse rien en espèces.

import { authErrorResponse, requireAdmin } from "../../../../../lib/auth-server";
import { supabaseRest } from "../../../../../lib/supabase-rest";
import { computeAccountModel, type AccountOperation, type InstrumentPrice } from "../../../../../lib/portfolio-account";
import { buildPriceIndex } from "../../../../../lib/instrument-alias";
import { isAccumulating } from "../../../../../lib/dividend-income";
import { fetchDividendHistory } from "../../../../../lib/market-history";
import { resolveSymbols } from "../../../../../lib/market-quotes";
import { loadImportAccount, isOperationAccount } from "../../../../../lib/investment-import-server";

export const runtime = "nodejs";

type HoldingRow = {
  id: string; name: string | null; symbol: string | null; isin: string | null; currency: string;
  asset_type: string | null; provider_symbol?: string | null; yahoo_symbol?: string | null;
};
type OperationRow = {
  id: string; account_id: string; member_id: string; type: AccountOperation["type"]; operation_date: string;
  asset_name: string | null; ticker: string | null; isin: string | null; quantity: number | null;
  unit_price: number | null; gross_amount: number | null; fees: number | null; net_amount: number | null;
  currency: string; source: string | null; note: string | null; exchange_rate: number | null;
};

type SyncRow = {
  name: string;
  isin: string | null;
  symbol: string | null;
  status: "updated" | "no_dividend" | "accumulating" | "unresolved" | "provider_unavailable";
  events: number;
  reason: string;
};

function asOperation(row: OperationRow): AccountOperation {
  return {
    id: row.id, accountId: row.account_id, memberId: row.member_id, type: row.type, date: row.operation_date,
    assetName: row.asset_name, ticker: row.ticker, isin: row.isin,
    quantity: row.quantity === null ? null : Number(row.quantity),
    unitPrice: row.unit_price === null ? null : Number(row.unit_price),
    grossAmount: row.gross_amount === null ? null : Number(row.gross_amount),
    fees: row.fees === null ? null : Number(row.fees),
    netAmount: row.net_amount === null ? null : Number(row.net_amount),
    currency: row.currency, source: row.source, note: row.note,
    exchangeRate: row.exchange_rate === null ? null : Number(row.exchange_rate),
  };
}

/**
 * Symbole utilisable, par ordre de confiance décroissant : symbole validé sur la ligne, puis
 * symbole qu'un cours a RÉELLEMENT servi (`market_quotes`), puis résolution par ISIN.
 * On ne fabrique jamais un symbole à partir du nom : c'est la manière connue de confondre
 * deux instruments homonymes.
 */
async function resolveSymbol(holding: HoldingRow, quoteSymbol: string | null): Promise<string | null> {
  const explicit = holding.yahoo_symbol?.trim() || holding.provider_symbol?.trim() || quoteSymbol?.trim();
  if (explicit) return explicit;
  if (!holding.isin) return null;
  const candidates = await resolveSymbols({ isin: holding.isin, ticker: holding.symbol, name: holding.name, currency: holding.currency });
  return candidates[0] ?? null;
}

export async function POST(request: Request) {
  try {
    await requireAdmin(request);
    const body = (await request.json().catch(() => ({}))) as { accountId?: string };
    const accountId = String(body.accountId ?? "").trim();
    if (!accountId) return Response.json({ error: "accountId manquant." }, { status: 400 });

    const account = await loadImportAccount(accountId);
    if (!account || !isOperationAccount(account.accountType)) {
      return Response.json({ error: "Compte PEA ou compte-titres introuvable." }, { status: 404 });
    }

    const [operationRows, holdingRows] = await Promise.all([
      supabaseRest<OperationRow[]>(`account_operations?select=id,account_id,member_id,type,operation_date,asset_name,ticker,isin,quantity,unit_price,gross_amount,fees,net_amount,currency,source,note,exchange_rate&account_id=eq.${encodeURIComponent(accountId)}&order=operation_date.asc`),
      supabaseRest<HoldingRow[]>(`holdings?select=id,name,symbol,isin,currency,asset_type,provider_symbol,yahoo_symbol&account_id=eq.${encodeURIComponent(accountId)}`),
    ]);
    const operations = operationRows.map(asOperation);

    // Appariement par ALIAS : une opération sans ISIN (`ticker: SAN`) doit retrouver sa ligne de
    // référence même si celle-ci est identifiée par un ISIN. Sans cela, l'instrument reste
    // invisible du pipeline — c'était le cas de Sanofi.
    const index = buildPriceIndex(
      holdingRows,
      (holding) => ({ isin: holding.isin, symbol: holding.symbol, name: holding.name }),
      operations,
    );
    const priceByKey = new Map<string, InstrumentPrice>();
    for (const [key, holding] of index.byKey) {
      priceByKey.set(key, { lastPrice: null, lastPriceAt: null, assetType: holding.asset_type ?? null, name: holding.name ?? null, assetId: holding.id });
    }
    const model = computeAccountModel({
      operations,
      priceByKey,
      accountType: account.accountType === "pea" ? "PEA" : "CTO",
      referenceCurrency: account.currency,
    });

    const heldHoldingIds = [...new Set([...index.byKey.entries()]
      .filter(([key]) => model.positions.some((position) => position.key === key))
      .map(([, holding]) => holding.id))];
    const quoteSymbolByAsset = new Map<string, string>();
    if (heldHoldingIds.length) {
      const quotes = await supabaseRest<Array<{ asset_id: string; provider_symbol: string; fetched_at: string }>>(
        `market_quotes?select=asset_id,provider_symbol,fetched_at&asset_id=in.(${heldHoldingIds.join(",")})&order=fetched_at.desc`,
      ).catch(() => []);
      for (const quote of quotes ?? []) if (!quoteSymbolByAsset.has(quote.asset_id)) quoteSymbolByAsset.set(quote.asset_id, quote.provider_symbol);
    }

    const today = new Date().toISOString().slice(0, 10);
    const results: SyncRow[] = [];
    let written = 0;

    for (const position of model.positions) {
      const holding = index.byKey.get(position.key) ?? null;
      if (!holding) {
        results.push({ name: position.name, isin: position.isin, symbol: null, status: "unresolved", events: 0, reason: "Aucune ligne de référence pour cet instrument." });
        continue;
      }
      if (isAccumulating({ name: holding.name ?? position.name, assetType: position.assetType })) {
        results.push({ name: position.name, isin: position.isin, symbol: null, status: "accumulating", events: 0, reason: "ETF capitalisant : aucun versement en espèces attendu." });
        continue;
      }
      const symbol = await resolveSymbol(holding, quoteSymbolByAsset.get(holding.id) ?? null);
      if (!symbol) {
        results.push({ name: position.name, isin: position.isin, symbol: null, status: "unresolved", events: 0, reason: "Aucun symbole de marché validé : impossible d'interroger le fournisseur." });
        continue;
      }
      const history = await fetchDividendHistory(symbol, 5);
      if (history === null) {
        results.push({ name: position.name, isin: position.isin, symbol, status: "provider_unavailable", events: 0, reason: "Le fournisseur n'a pas répondu. Aucune donnée n'a été effacée." });
        continue;
      }
      if (history.length === 0) {
        results.push({ name: position.name, isin: position.isin, symbol, status: "no_dividend", events: 0, reason: "Le fournisseur ne connaît aucun dividende sur 5 ans." });
        continue;
      }
      // `status` distingue un fait passé d'une échéance à venir. La projection « Estimé » est
      // calculée à l'affichage (lib/dividend-income.ts) et n'est jamais stockée.
      const records = history.map((event) => ({
        asset_id: holding.id,
        provider: "yahoo",
        provider_event_id: `yahoo:${symbol}:${event.exDate}`,
        action_type: "dividend",
        ex_date: event.exDate,
        declaration_date: null,
        record_date: null,
        payment_date: null,
        amount_per_share: event.amountPerShare,
        currency: event.currency ?? holding.currency ?? null,
        split_from: null,
        split_to: null,
        status: event.exDate > today ? "announced" : "paid",
        fetched_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }));
      try {
        await supabaseRest(
          "corporate_actions?on_conflict=asset_id,provider,provider_event_id,action_type,ex_date,amount_per_share,split_from,split_to",
          { method: "POST", headers: { prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(records) },
        );
        written += records.length;
        results.push({ name: position.name, isin: position.isin, symbol, status: "updated", events: records.length, reason: "Historique du fournisseur enregistré." });
      } catch (error) {
        results.push({
          name: position.name, isin: position.isin, symbol, status: "provider_unavailable", events: 0,
          reason: `Enregistrement impossible : ${error instanceof Error ? error.message.slice(0, 120) : "erreur inconnue"}`,
        });
      }
    }

    return Response.json({
      provider: "yahoo",
      total: model.positions.length,
      written,
      updated: results.filter((row) => row.status === "updated").length,
      accumulating: results.filter((row) => row.status === "accumulating").length,
      unresolved: results.filter((row) => row.status === "unresolved").length,
      unavailable: results.filter((row) => row.status === "provider_unavailable").length,
      results,
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}
