import { authErrorResponse, requireAdmin } from "../../../../lib/auth-server";
import { computeAccountModel, instrumentKey, priceKeyOf, type AccountOperation, type InstrumentPrice } from "../../../../lib/portfolio-account";
import { acquireRefreshLock, releaseRefreshLock, syncMarketData, type CachedQuote, type SyncAsset } from "../../../../lib/market-sync";
import { loadImportAccount, isOperationAccount } from "../../../../lib/investment-import-server";
import { supabaseRest } from "../../../../lib/supabase-rest";

export const runtime = "nodejs";

type HoldingRow = {
  id: string; account_id: string; asset_type: string; name: string; symbol: string | null; isin: string | null; currency: string;
  exchange: string | null; provider_symbol: string | null; market_symbol: string | null; mic_code: string | null;
  data_provider: string | null; quote_mode: string | null; country: string | null;
};
type OperationRow = { id: string; account_id: string; member_id: string; type: AccountOperation["type"]; operation_date: string; asset_name: string | null; ticker: string | null; isin: string | null; quantity: number | null; unit_price: number | null; gross_amount: number | null; fees: number | null; net_amount: number | null; currency: string; source: string | null; note: string | null; exchange_rate?: number | null; taxes?: number | null };

const HOLDING_SELECT = "id,account_id,asset_type,name,symbol,isin,currency,exchange,provider_symbol,market_symbol,mic_code,data_provider,quote_mode,country";

function asOperation(row: OperationRow): AccountOperation {
  return { id: row.id, accountId: row.account_id, memberId: row.member_id, type: row.type, date: row.operation_date, assetName: row.asset_name, ticker: row.ticker, isin: row.isin, quantity: row.quantity === null ? null : Number(row.quantity), unitPrice: row.unit_price === null ? null : Number(row.unit_price), grossAmount: row.gross_amount === null ? null : Number(row.gross_amount), fees: row.fees === null ? null : Number(row.fees), netAmount: row.net_amount === null ? null : Number(row.net_amount), currency: row.currency, source: row.source, note: row.note, exchangeRate: row.exchange_rate === null ? null : Number(row.exchange_rate), taxes: row.taxes === null ? null : Number(row.taxes) };
}

async function loadOperations(accountId: string) {
  return supabaseRest<OperationRow[]>(`account_operations?select=id,account_id,member_id,type,operation_date,asset_name,ticker,isin,quantity,unit_price,gross_amount,fees,net_amount,currency,source,note,exchange_rate,taxes&account_id=eq.${encodeURIComponent(accountId)}&order=operation_date.asc`);
}
async function createReference(accountId: string, position: ReturnType<typeof computeAccountModel>["positions"][number]) {
  const rows = await supabaseRest<HoldingRow[]>("holdings", {
    method: "POST", headers: { prefer: "return=representation" },
    body: JSON.stringify({ account_id: accountId, asset_type: "other", name: position.name, symbol: position.ticker, isin: position.isin, quantity: 0, average_cost: null, currency: position.currency, data_provider: "manual", quote_mode: "manual" }),
  });
  return rows[0];
}

export async function POST(request: Request) {
  let accountId: string | null = null;
  try {
    await requireAdmin(request);
    const body = await request.json().catch(() => ({})) as { accountId?: string };
    accountId = String(body.accountId ?? "").trim() || null;
    if (!accountId) return Response.json({ error: "Le compte est obligatoire." }, { status: 400 });
    const account = await loadImportAccount(accountId);
    if (!account || !isOperationAccount(account.accountType)) return Response.json({ error: "Compte PEA ou compte-titres introuvable." }, { status: 404 });
    const confirmedAccountId = accountId;
    if (!await acquireRefreshLock(accountId)) return Response.json({ error: "Une actualisation est déjà en cours pour ce compte." }, { status: 409 });

    const [operations, holdingRows] = await Promise.all([
      loadOperations(accountId),
      supabaseRest<HoldingRow[]>(`holdings?select=${HOLDING_SELECT}&account_id=eq.${encodeURIComponent(accountId)}`),
    ]);
    const model = computeAccountModel({ operations: operations.map(asOperation), priceByKey: new Map<string, InstrumentPrice>(), accountType: account.accountType === "pea" ? "PEA" : "CTO", referenceCurrency: account.currency });
    const holdingByKey = new Map(holdingRows.map((item) => [priceKeyOf({ isin: item.isin, symbol: item.symbol, name: item.name }), item]));
    const unresolved = new Map<string, HoldingRow>();
    for (const position of model.positions) {
      const key = instrumentKey({ isin: position.isin, ticker: position.ticker, assetName: position.name });
      unresolved.set(key, holdingByKey.get(key) ?? await createReference(accountId, position));
    }
    const assetIds = [...new Set([...unresolved.values()].map((item) => item.id))];
    const quotes = assetIds.length ? await supabaseRest<Array<CachedQuote & { asset_id: string }>>(`market_quotes?select=asset_id,provider,provider_symbol,price,currency,quoted_at,market_status,data_delay_minutes,fetched_at,raw_metadata&asset_id=in.(${assetIds.join(",")})&order=fetched_at.desc`) : [];
    const quoteByAsset = new Map<string, CachedQuote>();
    for (const quote of quotes) if (!quoteByAsset.has(quote.asset_id)) quoteByAsset.set(quote.asset_id, quote);
    const assets: SyncAsset[] = [...unresolved.entries()].map(([key, item]) => {
      const position = model.positions.find((candidate) => instrumentKey({ isin: candidate.isin, ticker: candidate.ticker, assetName: candidate.name }) === key)!;
      return { id: item.id, accountId: confirmedAccountId, referenceCurrency: account.currency, name: item.name || position.name, isin: item.isin ?? position.isin, ticker: item.symbol ?? position.ticker, providerSymbol: item.provider_symbol ?? item.market_symbol, exchange: item.exchange, micCode: item.mic_code, currency: item.currency || position.currency, assetType: item.asset_type as SyncAsset["assetType"], dataProvider: item.data_provider, quoteMode: item.quote_mode as SyncAsset["quoteMode"], country: item.country, lastQuote: quoteByAsset.get(item.id) ?? null };
    });
    const report = await syncMarketData(assets, { includeCorporateActions: true });
    return Response.json(report);
  } catch (error) {
    return authErrorResponse(error);
  } finally {
    if (accountId) await releaseRefreshLock(accountId);
  }
}
