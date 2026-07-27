import { authErrorResponse, requireAdmin } from "../../../../lib/auth-server";
import { computeAccountModel, instrumentKey, priceKeyOf, type AccountOperation, type InstrumentPrice } from "../../../../lib/portfolio-account";
import { acquireRefreshLock, releaseRefreshLock, syncMarketData, type CachedQuote, type SyncAsset } from "../../../../lib/market-sync";
import { loadImportAccount, isOperationAccount } from "../../../../lib/investment-import-server";
import { supabaseRest } from "../../../../lib/supabase-rest";
import { resolveMarketIdentity } from "../../../../lib/market-identity";
import { loadAccountListings, type ListingIdentity } from "../../../../lib/asset-catalog-server";
import { createMarketRefreshPost } from "../../../../lib/market-refresh-route";

export const runtime = "nodejs";

type HoldingRow = {
  id: string; account_id: string; asset_type: string; name: string; symbol: string | null; isin: string | null; currency: string;
  exchange: string | null; provider_symbol: string | null; market_symbol: string | null; mic_code: string | null;
  data_provider: string | null; quote_mode: string | null; country: string | null;
  listing_id?: string | null; last_price?: number | null; last_price_at?: string | null;
  yahoo_symbol?: string | null; classification_status?: "verified" | "inferred" | "needs_review" | null;
};
type OperationRow = { id: string; account_id: string; member_id: string; type: AccountOperation["type"]; operation_date: string; asset_name: string | null; ticker: string | null; isin: string | null; quantity: number | null; unit_price: number | null; gross_amount: number | null; fees: number | null; net_amount: number | null; currency: string; source: string | null; note: string | null; exchange_rate?: number | null; taxes?: number | null };

const HOLDING_SELECT = "id,account_id,asset_type,name,symbol,isin,currency,exchange,provider_symbol,yahoo_symbol,market_symbol,mic_code,data_provider,quote_mode,country,classification_status,listing_id,last_price,last_price_at";

function asOperation(row: OperationRow): AccountOperation {
  return { id: row.id, accountId: row.account_id, memberId: row.member_id, type: row.type, date: row.operation_date, assetName: row.asset_name, ticker: row.ticker, isin: row.isin, quantity: row.quantity === null ? null : Number(row.quantity), unitPrice: row.unit_price === null ? null : Number(row.unit_price), grossAmount: row.gross_amount === null ? null : Number(row.gross_amount), fees: row.fees === null ? null : Number(row.fees), netAmount: row.net_amount === null ? null : Number(row.net_amount), currency: row.currency, source: row.source, note: row.note, exchangeRate: row.exchange_rate === null ? null : Number(row.exchange_rate), taxes: row.taxes === null ? null : Number(row.taxes) };
}

async function loadOperations(accountId: string) {
  return supabaseRest<OperationRow[]>(`account_operations?select=id,account_id,member_id,type,operation_date,asset_name,ticker,isin,quantity,unit_price,gross_amount,fees,net_amount,currency,source,note,exchange_rate,taxes&account_id=eq.${encodeURIComponent(accountId)}&order=operation_date.asc`);
}
async function loadHoldings(accountId: string) {
  try {
    return await supabaseRest<HoldingRow[]>(`holdings?select=${HOLDING_SELECT}&account_id=eq.${encodeURIComponent(accountId)}`);
  } catch (error) {
    // Déploiement sûr entre code et migration : le rafraîchissement reste lisible, mais le
    // secours Yahoo/les statuts d'identité ne deviennent actifs qu'après la migration fournie.
    const message = error instanceof Error ? error.message : "";
    if (!/yahoo_symbol|classification_status|PGRST20[0-9]|42703/.test(message)) throw error;
    return await supabaseRest<HoldingRow[]>(`holdings?select=id,account_id,asset_type,name,symbol,isin,currency,exchange,provider_symbol,market_symbol,mic_code,data_provider,quote_mode,country,last_price,last_price_at&account_id=eq.${encodeURIComponent(accountId)}`);
  }
}
/**
 * Crée la ligne `holdings` de référence d'une position qui n'en a pas encore. `quantity: 0` :
 * cette table reste un RÉFÉRENTIEL DE PRIX, jamais une source de position.
 *
 * Quand l'utilisateur a sélectionné une cotation, elle est reprise ici telle quelle — symbole
 * fournisseur, place, MIC, devise, type. C'est ce qui remplace la déduction depuis le nom, seule
 * responsable jusqu'ici des « symbole de marché à confirmer » sur des actifs pourtant identifiés.
 */
async function createReference(
  accountId: string,
  position: ReturnType<typeof computeAccountModel>["positions"][number],
  listing: ListingIdentity | null,
) {
  const record: Record<string, unknown> = {
    account_id: accountId, quantity: 0, average_cost: null,
    asset_type: listing?.assetType ?? "other",
    name: listing?.name || position.name,
    symbol: listing?.ticker ?? position.ticker,
    isin: listing?.isin ?? position.isin,
    currency: listing?.currency ?? position.currency,
    data_provider: listing?.eodhdSymbol ? "eodhd" : listing?.yahooSymbol ? "yahoo" : "manual",
    quote_mode: listing?.eodhdSymbol || listing?.yahooSymbol ? "eod" : "manual",
  };
  if (listing) {
    record.provider_symbol = listing.eodhdSymbol;
    record.yahoo_symbol = listing.yahooSymbol;
    record.exchange = listing.exchange;
    record.mic_code = listing.micCode;
    record.country = listing.country;
    record.classification_status = listing.classificationStatus;
    record.listing_id = listing.listingId;
  }
  try {
    const rows = await supabaseRest<HoldingRow[]>("holdings", {
      method: "POST", headers: { prefer: "return=representation" }, body: JSON.stringify(record),
    });
    return rows[0];
  } catch (error) {
    // Colonnes du catalogue absentes (migration 20260811 non jouée) : on retombe sur la référence
    // minimale d'avant plutôt que d'échouer tout le rafraîchissement.
    const message = error instanceof Error ? error.message : "";
    if (!/listing_id|yahoo_symbol|classification_status|PGRST204|42703/.test(message)) throw error;
    const rows = await supabaseRest<HoldingRow[]>("holdings", {
      method: "POST", headers: { prefer: "return=representation" },
      body: JSON.stringify({ account_id: accountId, asset_type: "other", name: position.name, symbol: position.ticker, isin: position.isin, quantity: 0, average_cost: null, currency: position.currency, data_provider: "manual", quote_mode: "manual" }),
    });
    return rows[0];
  }
}

async function refreshAccount(accountId: string) {
    const account = await loadImportAccount(accountId);
    if (!account || !isOperationAccount(account.accountType)) {
      return Response.json({ error: "Compte PEA ou compte-titres introuvable." }, { status: 404 });
    }
    const confirmedAccountId = accountId;
    const [operations, holdingRows, listingByKey] = await Promise.all([
      loadOperations(accountId),
      loadHoldings(accountId),
      // Cotations choisies à la saisie : elles fournissent le symbole exact du fournisseur.
      loadAccountListings(accountId),
    ]);
    const model = computeAccountModel({ operations: operations.map(asOperation), priceByKey: new Map<string, InstrumentPrice>(), accountType: account.accountType === "pea" ? "PEA" : "CTO", referenceCurrency: account.currency });
    const holdingByKey = new Map(holdingRows.map((item) => [priceKeyOf({ isin: item.isin, symbol: item.symbol, name: item.name }), item]));
    const unresolved = new Map<string, HoldingRow>();
    for (const position of model.positions) {
      const key = instrumentKey({ isin: position.isin, ticker: position.ticker, assetName: position.name });
      unresolved.set(key, holdingByKey.get(key) ?? await createReference(accountId, position, listingByKey.get(key) ?? null));
    }
    const assetIds = [...new Set([...unresolved.values()].map((item) => item.id))];
    const quotes = assetIds.length ? await supabaseRest<Array<CachedQuote & { asset_id: string }>>(`market_quotes?select=asset_id,provider,provider_symbol,price,currency,quoted_at,market_status,data_delay_minutes,fetched_at,raw_metadata&asset_id=in.(${assetIds.join(",")})&order=fetched_at.desc`) : [];
    const quoteByAsset = new Map<string, CachedQuote>();
    for (const quote of quotes) if (!quoteByAsset.has(quote.asset_id)) quoteByAsset.set(quote.asset_id, quote);
    const assets: SyncAsset[] = [...unresolved.entries()].map(([key, item]) => {
      const position = model.positions.find((candidate) => instrumentKey({ isin: candidate.isin, ticker: candidate.ticker, assetName: candidate.name }) === key)!;
      // Ordre de confiance : cotation SÉLECTIONNÉE > correction admin déjà stockée > déduction.
      // Un symbole choisi par l'utilisateur n'est jamais écrasé par une valeur devinée du nom,
      // mais il ne prime pas non plus sur une ligne que l'administrateur a explicitement corrigée.
      const listing = item.classification_status === "verified" ? null : listingByKey.get(key) ?? null;
      const identity = resolveMarketIdentity({
          name: item.name || position.name, isin: listing?.isin ?? item.isin ?? position.isin, ticker: listing?.ticker ?? item.symbol ?? position.ticker,
          providerSymbol: listing?.eodhdSymbol ?? item.provider_symbol ?? item.market_symbol,
          yahooSymbol: listing?.yahooSymbol ?? item.yahoo_symbol,
          exchange: listing?.exchange ?? item.exchange, micCode: listing?.micCode ?? item.mic_code,
          currency: listing?.currency ?? item.currency ?? position.currency,
          assetType: (listing?.assetType ?? item.asset_type) as SyncAsset["assetType"],
          classificationStatus: listing?.classificationStatus ?? item.classification_status,
          dataProvider: listing?.eodhdSymbol ? "eodhd" : item.data_provider,
          quoteMode: (listing?.eodhdSymbol ? "eod" : item.quote_mode) as SyncAsset["quoteMode"],
          country: listing?.country ?? item.country,
          assetId: listing?.assetId ?? null,
          listingId: listing?.listingId ?? item.listing_id ?? null,
        });
      return {
        ...identity,
        id: item.id,
        accountId: confirmedAccountId,
        identityReason: identity.reason,
        referenceCurrency: account.currency,
        lastQuote: quoteByAsset.get(item.id) ?? null,
        manualPrice: {
          price: item.last_price === null || item.last_price === undefined ? null : Number(item.last_price),
          priceAt: item.last_price_at ?? null,
          currency: item.currency ?? position.currency,
        },
      };
    });
    // Les dividendes sont synchronisés séparément : ne jamais consommer le quota des cours
    // depuis un clic utilisateur alors que des positions restent à valoriser.
    const report = await syncMarketData(assets, { includeCorporateActions: false });
    return Response.json(report);
}

export const POST = createMarketRefreshPost({
  authorize: requireAdmin,
  acquireLock: acquireRefreshLock,
  releaseLock: releaseRefreshLock,
  refresh: refreshAccount,
  errorResponse: authErrorResponse,
});
