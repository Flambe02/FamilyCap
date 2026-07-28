// CHARGEMENT SERVEUR du contexte dividendes — PEA et compte-titres, exactement le même code.
//
// Ce module lit Supabase et assemble ce dont le moteur pur (lib/dividend-engine.ts) a besoin. Il
// ne contient AUCUNE règle de calcul financier : positions, quantités éligibles, totaux et
// projections restent dans les modules purs, testables sans base.
//
// Le point clé est le RATTACHEMENT : une position dérivée d'`account_operations` doit retrouver son
// instrument canonique dans `assets`. La chaîne est
//     opérations → clé de position → (index d'alias) → ligne `holdings` → ISIN → `assets`
// Chaque maillon est déjà éprouvé ailleurs dans le projet ; c'est leur absence de bout en bout qui
// laissait Sanofi sans dividende et le PEA sans aucune donnée.

import { computeAccountModel, type AccountModel, type AccountOperation, type InstrumentPrice } from "./portfolio-account.ts";
import { buildPriceIndex } from "./instrument-alias.ts";
import { getLatestFxRate, type FxRateRow } from "./fx-rates.ts";
import { loadPortfolioFxRates } from "./fx-rates-server.ts";
import { supabaseRest } from "./supabase-rest.ts";
import {
  type AccountTaxProfile, type Confidence, type DistributionPolicy, type DividendEventRow,
  type DividendInstrument, type DividendType, type ResolutionStatus,
} from "./dividend-engine.ts";

export type DividendAccount = {
  id: string;
  name: string;
  accountType: "PEA" | "CTO";
  currency: string;
  memberId: string;
};

export type HoldingRow = {
  id: string; account_id: string; asset_type: string | null; name: string | null; symbol: string | null; isin: string | null;
  currency: string; last_price: number | null; last_price_at: string | null;
  provider_symbol?: string | null; yahoo_symbol?: string | null; market_symbol?: string | null;
  exchange?: string | null; mic_code?: string | null; data_provider?: string | null; country?: string | null;
  listing_id?: string | null;
};

export type AssetRow = {
  id: string; isin: string | null; name: string; asset_type: string;
  distribution_policy?: string | null; distribution_policy_source?: string | null;
};

export type ListingRow = {
  id: string; asset_id: string; ticker: string | null; exchange: string | null; mic_code: string | null;
  currency: string; eodhd_symbol: string | null; yahoo_symbol: string | null;
  alpha_vantage_symbol?: string | null; resolution_status?: string | null; last_resolved_at?: string | null;
};

export type DividendContext = {
  accounts: DividendAccount[];
  primaryAccount: DividendAccount;
  referenceCurrency: string;
  accountType: "PEA" | "CTO";
  operations: AccountOperation[];
  model: AccountModel;
  holdings: HoldingRow[];
  /** Clé de position → ligne `holdings` appariée par alias. */
  holdingByPositionKey: Map<string, HoldingRow>;
  instruments: DividendInstrument[];
  /** Instrument canonique → cotation retenue (celle qui porte les symboles fournisseurs). */
  listingByAsset: Map<string, ListingRow>;
  assetById: Map<string, AssetRow>;
  events: DividendEventRow[];
  taxProfile: AccountTaxProfile | null;
  fxRateAt: (currency: string, date: string) => number | null;
  fxRows: FxRateRow[];
  /** Positions détenues sans instrument canonique : à identifier avant tout calcul. */
  unresolvedPositions: Array<{ key: string; name: string; isin: string | null; ticker: string | null }>;
  today: string;
};

const ISIN_SHAPE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;

/** Une table optionnelle absente (migration non jouée) réduit l'écran, elle ne le casse jamais. */
async function optional<T>(query: string): Promise<T[]> {
  try {
    return (await supabaseRest<T[]>(query)) ?? [];
  } catch {
    return [];
  }
}

function asOperation(row: Record<string, unknown>): AccountOperation {
  const numberOrNull = (value: unknown) => (value === null || value === undefined ? null : Number(value));
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    memberId: row.member_id === null || row.member_id === undefined ? null : String(row.member_id),
    accountName: row.account_name === undefined ? null : (row.account_name as string | null),
    type: row.type as AccountOperation["type"],
    date: String(row.operation_date),
    assetName: (row.asset_name as string | null) ?? null,
    ticker: (row.ticker as string | null) ?? null,
    isin: (row.isin as string | null) ?? null,
    quantity: numberOrNull(row.quantity),
    unitPrice: numberOrNull(row.unit_price),
    grossAmount: numberOrNull(row.gross_amount),
    fees: numberOrNull(row.fees),
    netAmount: numberOrNull(row.net_amount),
    currency: String(row.currency ?? "EUR"),
    exchangeRate: numberOrNull(row.exchange_rate),
    taxes: numberOrNull(row.taxes),
    source: (row.source as string | null) ?? null,
    note: (row.note as string | null) ?? null,
  };
}

export async function loadDividendAccounts(accountIds: string[]): Promise<DividendAccount[]> {
  if (accountIds.length === 0) return [];
  const rows = await supabaseRest<Array<{ id: string; name: string; account_type: string; currency: string; member_id: string }>>(
    `financial_accounts?select=id,name,account_type,currency,member_id&id=in.(${accountIds.map(encodeURIComponent).join(",")})`,
  );
  return rows
    .filter((row) => row.account_type === "pea" || row.account_type === "securities")
    .map((row) => ({
      id: row.id,
      name: row.name,
      accountType: row.account_type === "pea" ? "PEA" : "CTO",
      currency: (row.currency || "EUR").toUpperCase(),
      memberId: row.member_id,
    }));
}

async function loadHoldings(accountIds: string[]): Promise<HoldingRow[]> {
  const full = "id,account_id,asset_type,name,symbol,isin,currency,last_price,last_price_at,provider_symbol,yahoo_symbol,market_symbol,exchange,mic_code,data_provider,country,listing_id";
  const filter = `account_id=in.(${accountIds.join(",")})`;
  try {
    return await supabaseRest<HoldingRow[]>(`holdings?select=${full}&${filter}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!/provider_symbol|yahoo_symbol|market_symbol|mic_code|data_provider|country|listing_id|42703|PGRST20[0-9]/.test(message)) throw error;
    return await supabaseRest<HoldingRow[]>(`holdings?select=id,account_id,asset_type,name,symbol,isin,currency,last_price,last_price_at&${filter}`);
  }
}

async function loadAssetsByIsin(isins: string[]): Promise<AssetRow[]> {
  if (isins.length === 0) return [];
  const filter = `isin=in.(${isins.map(encodeURIComponent).join(",")})`;
  try {
    return await supabaseRest<AssetRow[]>(`assets?select=id,isin,name,asset_type,distribution_policy,distribution_policy_source&${filter}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!/distribution_policy|42703|PGRST20[0-9]/.test(message)) return [];
    return await optional<AssetRow>(`assets?select=id,isin,name,asset_type&${filter}`);
  }
}

async function loadListings(assetIds: string[]): Promise<ListingRow[]> {
  if (assetIds.length === 0) return [];
  const filter = `asset_id=in.(${assetIds.join(",")})`;
  try {
    return await supabaseRest<ListingRow[]>(
      `asset_listings?select=id,asset_id,ticker,exchange,mic_code,currency,eodhd_symbol,yahoo_symbol,alpha_vantage_symbol,resolution_status,last_resolved_at&${filter}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!/alpha_vantage_symbol|resolution_status|last_resolved_at|42703|PGRST20[0-9]/.test(message)) return [];
    return await optional<ListingRow>(`asset_listings?select=id,asset_id,ticker,exchange,mic_code,currency,eodhd_symbol,yahoo_symbol&${filter}`);
  }
}

function toDistributionPolicy(value: unknown): DistributionPolicy {
  return value === "distributing" || value === "accumulating" ? value : "unknown";
}
function toConfidence(value: unknown): Confidence {
  return value === "high" || value === "low" ? value : "medium";
}
function toDividendType(value: unknown): DividendType {
  return value === "special" || value === "interim" || value === "final" || value === "other" ? value : "ordinary";
}

export async function loadDividendEvents(assetIds: string[]): Promise<DividendEventRow[]> {
  if (assetIds.length === 0) return [];
  const rows = await optional<Record<string, unknown>>(
    "dividend_events?select=id,asset_id,isin,provider_symbol,status,dividend_type,declaration_date,ex_date,record_date,payment_date,estimated_month,amount_per_share,currency,source_provider,source_event_id,source_url,confidence,is_special,is_forecast,last_synced_at"
    + `&asset_id=in.(${assetIds.join(",")})&account_id=is.null&order=ex_date.desc.nullslast`,
  );
  return rows.map((row) => ({
    id: String(row.id),
    assetId: String(row.asset_id),
    isin: (row.isin as string | null) ?? null,
    providerSymbol: (row.provider_symbol as string | null) ?? null,
    status: (row.status === "estimated" || row.status === "unavailable" ? row.status : "announced") as DividendEventRow["status"],
    dividendType: toDividendType(row.dividend_type),
    declarationDate: (row.declaration_date as string | null) ?? null,
    exDate: (row.ex_date as string | null) ?? null,
    recordDate: (row.record_date as string | null) ?? null,
    paymentDate: (row.payment_date as string | null) ?? null,
    estimatedMonth: (row.estimated_month as string | null) ?? null,
    amountPerShare: row.amount_per_share === null || row.amount_per_share === undefined ? null : Number(row.amount_per_share),
    currency: (row.currency as string | null) ?? null,
    sourceProvider: String(row.source_provider ?? "inconnu"),
    sourceEventId: (row.source_event_id as string | null) ?? null,
    sourceUrl: (row.source_url as string | null) ?? null,
    confidence: toConfidence(row.confidence),
    isSpecial: Boolean(row.is_special),
    isForecast: Boolean(row.is_forecast),
    lastSyncedAt: (row.last_synced_at as string | null) ?? null,
  }));
}

async function loadTaxProfile(accountId: string, accountType: "PEA" | "CTO"): Promise<AccountTaxProfile | null> {
  const rows = await optional<Record<string, unknown>>(
    `account_tax_profiles?select=account_id,tax_residency_country,withholding_tax_rate,estimated_tax_rate,allowance_rate,show_estimated_net&account_id=eq.${encodeURIComponent(accountId)}&limit=1`,
  );
  const row = rows[0];
  if (row) {
    const rate = (value: unknown) => (value === null || value === undefined ? null : Number(value));
    return {
      taxResidencyCountry: (row.tax_residency_country as string | null) ?? null,
      withholdingTaxRate: rate(row.withholding_tax_rate),
      estimatedTaxRate: rate(row.estimated_tax_rate),
      allowanceRate: rate(row.allowance_rate),
      showEstimatedNet: Boolean(row.show_estimated_net),
    };
  }
  // Compatibilité : tant que la migration 20260817 n'est pas jouée, le seul paramètre disponible
  // est `financial_accounts.dividend_tax_rate`. Il est repris TEL QUEL — jamais complété par un
  // taux par défaut, et jamais appliqué à un PEA.
  if (accountType !== "CTO") return null;
  const legacy = await optional<{ dividend_tax_rate: number | null }>(
    `financial_accounts?select=dividend_tax_rate&id=eq.${encodeURIComponent(accountId)}&limit=1`,
  );
  const legacyRate = legacy[0]?.dividend_tax_rate;
  if (legacyRate === null || legacyRate === undefined) return null;
  return {
    taxResidencyCountry: null,
    withholdingTaxRate: null,
    estimatedTaxRate: Number(legacyRate),
    allowanceRate: null,
    showEstimatedNet: true,
  };
}

/**
 * Contexte complet pour un périmètre de comptes (un seul, ou tous les comptes-titres en vue
 * agrégée). Le PEA et le compte-titres empruntent ce chemin sans aucune branche conditionnelle :
 * seule la fiscalité, plus bas, distingue les deux enveloppes.
 */
export async function loadDividendContext(
  accountIds: string[],
  today = new Date().toISOString().slice(0, 10),
): Promise<DividendContext | null> {
  const accounts = await loadDividendAccounts(accountIds);
  if (accounts.length === 0) return null;
  const primaryAccount = accounts[0];
  const referenceCurrency = primaryAccount.currency;
  const accountType = primaryAccount.accountType;
  const ids = accounts.map((account) => account.id);

  const [operationRows, holdings] = await Promise.all([
    optional<Record<string, unknown>>(
      "account_operations?select=id,account_id,member_id,type,operation_date,asset_name,ticker,isin,quantity,unit_price,gross_amount,fees,net_amount,currency,source,note,exchange_rate"
      + `&account_id=in.(${ids.join(",")})&order=operation_date.asc`,
    ),
    loadHoldings(ids),
  ]);
  const nameById = new Map(accounts.map((account) => [account.id, account.name]));
  const operations = operationRows.map((row) => ({ ...asOperation(row), accountName: nameById.get(String(row.account_id)) ?? null }));

  const quoteRows = holdings.length
    ? await optional<{ asset_id: string; provider: string; price: number; currency: string; quoted_at: string; fetched_at: string }>(
      `market_quotes?select=asset_id,provider,price,currency,quoted_at,fetched_at&asset_id=in.(${holdings.map((holding) => holding.id).join(",")})&order=fetched_at.desc`,
    )
    : [];
  const latestQuote = new Map<string, (typeof quoteRows)[number]>();
  for (const quote of quoteRows) if (!latestQuote.has(quote.asset_id)) latestQuote.set(quote.asset_id, quote);

  const currencies = new Set<string>([referenceCurrency]);
  for (const holding of holdings) currencies.add((latestQuote.get(holding.id)?.currency ?? holding.currency ?? "EUR").toUpperCase());
  for (const operation of operations) currencies.add((operation.currency ?? "EUR").toUpperCase());
  const fxRows = await loadPortfolioFxRates([...currencies]).catch(() => [] as FxRateRow[]);
  const fxRateAt = (currency: string, date: string) =>
    getLatestFxRate(currency, referenceCurrency, fxRows, { asOf: date, fallbackToEarliest: true })?.rate ?? null;

  const index = buildPriceIndex(
    holdings,
    (holding) => ({ isin: holding.isin, symbol: holding.symbol, name: holding.name }),
    operations,
  );
  const priceByKey = new Map<string, InstrumentPrice>();
  for (const [key, holding] of index.byKey) {
    const quote = latestQuote.get(holding.id) ?? null;
    const usable = quote && Number(quote.price) > 0 && (!holding.currency || quote.currency.toUpperCase() === holding.currency.toUpperCase()) ? quote : null;
    const price = usable ? Number(usable.price) : holding.last_price === null ? null : Number(holding.last_price);
    const nativeCurrency = (usable?.currency ?? holding.currency ?? referenceCurrency).toUpperCase();
    priceByKey.set(key, {
      lastPrice: price !== null && Number.isFinite(price) && price > 0 ? price : null,
      lastPriceAt: usable?.quoted_at ?? holding.last_price_at ?? null,
      assetType: holding.asset_type ?? null,
      name: holding.name ?? null,
      assetId: holding.id,
      providerSymbol: holding.provider_symbol ?? holding.market_symbol ?? null,
      yahooSymbol: holding.yahoo_symbol ?? null,
      exchange: holding.exchange ?? null,
      micCode: holding.mic_code ?? null,
      dataProvider: usable?.provider ?? holding.data_provider ?? null,
      country: holding.country ?? null,
      fetchedAt: usable?.fetched_at ?? null,
      fxRateToReference: getLatestFxRate(nativeCurrency, referenceCurrency, fxRows)?.rate ?? null,
      referenceCurrency,
    });
  }

  const model = computeAccountModel({ operations, priceByKey, accountType, today, referenceCurrency, fxRateAt });

  // ---- Rattachement au catalogue canonique -------------------------------------------------
  const holdingByPositionKey = new Map<string, HoldingRow>();
  for (const position of model.positions) {
    const holding = index.byKey.get(position.key);
    if (holding) holdingByPositionKey.set(position.key, holding);
  }

  const isins = [...new Set(
    [...holdingByPositionKey.values()]
      .map((holding) => holding.isin?.trim().toUpperCase() ?? "")
      .filter((isin) => ISIN_SHAPE.test(isin)),
  )];
  const assets = await loadAssetsByIsin(isins);
  const assetByIsin = new Map(assets.map((asset) => [(asset.isin ?? "").toUpperCase(), asset]));
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const listings = await loadListings(assets.map((asset) => asset.id));

  // Une cotation par instrument : celle dont la devise correspond à la ligne détenue, sinon la
  // première. Choisir la cotation en dollars d'une action détenue en euros ferait chercher les
  // dividendes du mauvais titre.
  const listingByAsset = new Map<string, ListingRow>();
  for (const asset of assets) {
    const candidates = listings.filter((listing) => listing.asset_id === asset.id);
    if (candidates.length === 0) continue;
    const holding = [...holdingByPositionKey.values()].find((row) => (row.isin ?? "").toUpperCase() === (asset.isin ?? "").toUpperCase());
    const wanted = (holding?.currency ?? "").toUpperCase();
    const matching = wanted ? candidates.find((listing) => listing.currency.toUpperCase() === wanted) : null;
    listingByAsset.set(asset.id, matching ?? candidates[0]);
  }

  const positionKeysByAsset = new Map<string, string[]>();
  const unresolvedPositions: DividendContext["unresolvedPositions"] = [];
  for (const position of model.positions) {
    const holding = holdingByPositionKey.get(position.key) ?? null;
    const isin = (holding?.isin ?? position.isin ?? "").trim().toUpperCase();
    const asset = ISIN_SHAPE.test(isin) ? assetByIsin.get(isin) ?? null : null;
    if (!asset) {
      unresolvedPositions.push({ key: position.key, name: position.name, isin: position.isin, ticker: position.ticker });
      continue;
    }
    positionKeysByAsset.set(asset.id, [...(positionKeysByAsset.get(asset.id) ?? []), position.key]);
  }

  const instruments: DividendInstrument[] = [...positionKeysByAsset.entries()].map(([assetId, positionKeys]) => {
    const asset = assetById.get(assetId)!;
    const listing = listingByAsset.get(assetId) ?? null;
    const holding = holdingByPositionKey.get(positionKeys[0]) ?? null;
    const providerSymbol = listing?.alpha_vantage_symbol
      ?? listing?.eodhd_symbol
      ?? listing?.yahoo_symbol
      ?? holding?.provider_symbol
      ?? holding?.yahoo_symbol
      ?? holding?.market_symbol
      ?? null;
    const resolutionStatus: ResolutionStatus = listing?.resolution_status === "resolved" || listing?.resolution_status === "needs_review"
      ? listing.resolution_status
      : providerSymbol
        ? "resolved"
        : "unresolved";
    return {
      assetId,
      positionKeys,
      name: asset.name || holding?.name || positionKeys[0],
      isin: asset.isin,
      ticker: listing?.ticker ?? holding?.symbol ?? null,
      assetType: (asset.asset_type as DividendInstrument["assetType"]) ?? null,
      distributionPolicy: toDistributionPolicy(asset.distribution_policy),
      resolutionStatus,
      providerSymbol,
      lastSyncedAt: listing?.last_resolved_at ?? null,
    };
  });

  const events = await loadDividendEvents([...positionKeysByAsset.keys()]);
  const taxProfile = await loadTaxProfile(primaryAccount.id, accountType);

  return {
    accounts,
    primaryAccount,
    referenceCurrency,
    accountType,
    operations,
    model,
    holdings,
    holdingByPositionKey,
    instruments,
    listingByAsset,
    assetById,
    events,
    taxProfile,
    fxRateAt,
    fxRows,
    unresolvedPositions,
    today,
  };
}
