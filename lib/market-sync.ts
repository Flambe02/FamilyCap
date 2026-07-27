import {
  fallbackMarketProvider,
  getQuoteFromProviders,
  isEodhdConfigured,
  isRateLimitError,
  primaryMarketProvider,
  MarketProviderError,
  type DividendEvent,
  type MarketAsset,
  type MarketDataProvider,
  type MarketQuote,
  type ProviderFailureCode,
} from "./market-data.ts";
import { fetchFxRate, isRateFreshToday, normaliseCurrency } from "./market-fx.ts";
import { supabaseRest } from "./supabase-rest.ts";

export const DAILY_EODHD_LIMIT = 20;
export const MAX_FALLBACK_ATTEMPTS = 30;
const ISO_DAY = () => new Date().toISOString().slice(0, 10);

export type CachedQuote = {
  provider: string;
  provider_symbol: string;
  price: number;
  currency: string;
  quoted_at: string;
  market_status: string;
  data_delay_minutes: number | null;
  fetched_at: string;
  raw_metadata: Record<string, unknown>;
};

export type ManualHoldingPrice = {
  price: number | null;
  priceAt: string | null;
  currency: string | null;
};

export type PreservedPrice = {
  price: number;
  priceAt: string | null;
  source: "automatic_cache" | "manual_holding";
  provider: string | null;
};

export type RefreshStatus = "updated" | "preserved" | "unresolved" | "failed" | "skipped";
export type RefreshReason =
  | "primary_success"
  | "primary_not_configured"
  | "primary_quota_exhausted"
  | "primary_symbol_not_found"
  | "primary_http_error"
  | "primary_timeout"
  | "primary_parse_error"
  | "fallback_success"
  | "fallback_disabled"
  | "fallback_symbol_not_found"
  | "fallback_http_error"
  | "fallback_timeout"
  | "fallback_parse_error"
  | "fallback_attempt_limit"
  | "preserved_automatic_cache"
  | "preserved_manual_price"
  | "missing_market_identity"
  | "ambiguous_market_identity"
  | "quote_storage_failed";

export type SyncAsset = MarketAsset & {
  id: string;
  accountId: string;
  instrumentKey: string;
  assetId?: string | null;
  listingId?: string | null;
  confidence?: "exact" | "resolved" | "ambiguous" | "unresolved";
  identityReason?: string | null;
  referenceCurrency?: string | null;
  lastQuote?: CachedQuote | null;
  manualPrice?: ManualHoldingPrice | null;
};

export type FxSyncRow = {
  pair: string;
  status: "fresh" | "cached" | "unavailable";
  rate?: number;
  provider?: string;
  quotedAt?: string;
  message?: string;
};

export type MarketRefreshRow = {
  instrumentKey: string;
  assetId: string | null;
  listingId: string | null;
  name: string;
  isin: string | null;
  ticker: string | null;
  symbol: string | null;
  status: RefreshStatus;
  provider: "eodhd" | "yahoo" | null;
  price: number | null;
  currency: string | null;
  priceAt: string | null;
  reason: RefreshReason;
  preservedPrice: PreservedPrice | null;
  diagnostic: {
    primaryReason: RefreshReason | null;
    fallbackReason: RefreshReason | null;
  };
};

export type MarketRefreshResult = {
  total: number;
  updated: number;
  preserved: {
    total: number;
    automaticCache: number;
    manualHoldingPrice: number;
  };
  unresolved: number;
  failed: number;
  skipped: number;
  provider: {
    primary: string;
    primaryConfigured: boolean;
    primaryCircuitOpen: boolean;
    fallback: string | null;
    fallbackEnabled: boolean;
  };
  results: MarketRefreshRow[];
  fx?: FxSyncRow[];
};

type RequestUsage = { total: number; quote: number; dividend: number };
type SyncDependencies = {
  primary?: MarketDataProvider | null;
  fallback?: MarketDataProvider | null;
  primaryName?: string;
  fallbackName?: string | null;
  primaryConfigured?: boolean;
  fallbackEnabled?: boolean;
  countUsage?: (provider: string) => Promise<RequestUsage>;
  recordCall?: (provider: string, requestKey: string) => Promise<void>;
  saveQuote?: (assetId: string, quote: MarketQuote) => Promise<void>;
  saveEvents?: (assetId: string, events: DividendEvent[]) => Promise<void>;
  syncFx?: typeof syncFxRates;
};

function isFetchedToday(value: string | null | undefined) {
  return String(value ?? "").slice(0, 10) === ISO_DAY();
}

function validCurrency(value: string | null | undefined) {
  return /^[A-Z]{3}$/.test(String(value ?? "").trim().toUpperCase());
}

function validTimestamp(value: string | null | undefined) {
  if (!value) return true;
  return Number.isFinite(new Date(value).getTime());
}

function usableCache(quote: CachedQuote | null | undefined, assetCurrency?: string | null) {
  return Boolean(
    quote
    && Number.isFinite(Number(quote.price))
    && Number(quote.price) > 0
    && validCurrency(quote.currency)
    && validTimestamp(quote.quoted_at)
    && (!assetCurrency || quote.currency.toUpperCase() === assetCurrency.toUpperCase()),
  );
}

function usableManualPrice(price: ManualHoldingPrice | null | undefined, assetCurrency?: string | null) {
  return Boolean(
    price
    && Number.isFinite(Number(price.price))
    && Number(price.price) > 0
    && validTimestamp(price.priceAt)
    && (!price.currency || !assetCurrency || price.currency.toUpperCase() === assetCurrency.toUpperCase()),
  );
}

function preservedPrice(asset: SyncAsset): PreservedPrice | null {
  if (usableCache(asset.lastQuote, asset.currency)) {
    return {
      price: Number(asset.lastQuote!.price),
      priceAt: asset.lastQuote!.quoted_at,
      source: "automatic_cache",
      provider: asset.lastQuote!.provider || null,
    };
  }
  if (usableManualPrice(asset.manualPrice, asset.currency)) {
    return {
      price: Number(asset.manualPrice!.price),
      priceAt: asset.manualPrice!.priceAt,
      source: "manual_holding",
      provider: "manual",
    };
  }
  return null;
}

function requestKey(asset: SyncAsset) {
  return `${asset.providerSymbol ?? asset.yahooSymbol ?? asset.isin ?? asset.ticker ?? asset.instrumentKey}`.trim().toUpperCase();
}

function providerFailure(error: unknown, provider: "primary" | "fallback"): RefreshReason {
  const code: ProviderFailureCode = error instanceof MarketProviderError ? error.code : "unavailable";
  if (provider === "primary") {
    if (code === "rate_limited") return "primary_quota_exhausted";
    if (code === "not_found" || code === "invalid_quote") return "primary_symbol_not_found";
    if (code === "timeout") return "primary_timeout";
    if (code === "parse_error") return "primary_parse_error";
    if (code === "disabled") return "primary_not_configured";
    return "primary_http_error";
  }
  if (code === "not_found" || code === "invalid_quote") return "fallback_symbol_not_found";
  if (code === "timeout") return "fallback_timeout";
  if (code === "parse_error") return "fallback_parse_error";
  if (code === "disabled") return "fallback_disabled";
  return "fallback_http_error";
}

function baseRow(asset: SyncAsset): Omit<MarketRefreshRow, "status" | "reason" | "preservedPrice" | "diagnostic"> {
  return {
    instrumentKey: asset.instrumentKey,
    assetId: asset.assetId ?? null,
    listingId: asset.listingId ?? null,
    name: asset.name,
    isin: asset.isin ?? null,
    ticker: asset.ticker ?? null,
    symbol: asset.providerSymbol ?? asset.yahooSymbol ?? null,
    provider: null,
    price: null,
    currency: asset.currency ?? null,
    priceAt: null,
  };
}

async function countUsageToday(provider: string): Promise<RequestUsage> {
  const rows = await supabaseRest<Array<{ request_key: string }>>(
    `market_data_requests?select=request_key&provider=eq.${encodeURIComponent(provider)}&request_date=eq.${ISO_DAY()}`,
  );
  const keys = (rows ?? []).map((row) => String(row.request_key ?? ""));
  return {
    total: keys.length,
    quote: keys.filter((key) => key.startsWith("quote:")).length,
    dividend: keys.filter((key) => key.startsWith("dividend:") || key.startsWith("div:")).length,
  };
}

async function recordProviderCall(provider: string, requestKeyValue: string) {
  await supabaseRest("market_data_requests", {
    method: "POST",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify({ provider, request_key: requestKeyValue, request_date: ISO_DAY() }),
  });
}

async function upsertQuote(assetId: string, quote: MarketQuote) {
  const record = {
    asset_id: assetId,
    provider: quote.provider,
    provider_symbol: quote.providerSymbol,
    price: quote.price,
    currency: quote.currency,
    quoted_at: quote.quotedAt,
    market_status: quote.marketStatus,
    data_delay_minutes: quote.dataDelayMinutes,
    fetched_at: new Date().toISOString(),
    raw_metadata: quote.rawMetadata,
    updated_at: new Date().toISOString(),
  };
  try {
    // Schéma corrigé : une même cotation peut être mise en cache pour plusieurs
    // références holdings sans que le dernier compte rafraîchi ne vole la ligne.
    await supabaseRest("market_quotes?on_conflict=asset_id,provider,provider_symbol", {
      method: "POST",
      headers: { prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(record),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!/42P10|no unique or exclusion constraint/i.test(message)) throw error;
    // Compatibilité avant application de 20260813 : l'ancien schéma n'a que
    // l'unicité globale provider/symbol. Ce repli évite une panne de déploiement.
    await supabaseRest("market_quotes?on_conflict=provider,provider_symbol", {
      method: "POST",
      headers: { prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(record),
    });
  }
}

async function upsertFxRate(baseCurrency: string, quoteCurrency: string, rate: number, quotedAt: string, provider: string) {
  await supabaseRest("market_fx_rates?on_conflict=provider,base_currency,quote_currency,quoted_at", {
    method: "POST",
    headers: { prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      provider,
      base_currency: baseCurrency,
      quote_currency: quoteCurrency,
      rate,
      quoted_at: quotedAt,
      fetched_at: new Date().toISOString(),
      raw_metadata: {},
      updated_at: new Date().toISOString(),
    }),
  });
}

/** Change indépendant des fournisseurs de cours : aucune écriture portefeuille ici. */
export async function syncFxRates(pairs: Array<{ base: string; quote: string }>): Promise<FxSyncRow[]> {
  const wanted = new Map<string, { base: string; quote: string }>();
  for (const pair of pairs) {
    const base = normaliseCurrency(pair.base);
    const quote = normaliseCurrency(pair.quote);
    if (base && quote && base !== quote) wanted.set(`${base}:${quote}`, { base, quote });
  }
  if (wanted.size === 0) return [];
  const known = new Map<string, string>();
  try {
    const rows = await supabaseRest<Array<{ base_currency: string; quote_currency: string; quoted_at: string }>>(
      "market_fx_rates?select=base_currency,quote_currency,quoted_at&order=quoted_at.desc",
    );
    for (const row of rows ?? []) {
      if (!known.has(`${row.base_currency}:${row.quote_currency}`)) {
        known.set(`${row.base_currency}:${row.quote_currency}`, row.quoted_at);
      }
    }
  } catch {
    // La vue conserve son état FX existant.
  }
  const report: FxSyncRow[] = [];
  for (const [key, pair] of wanted) {
    if (isRateFreshToday(known.get(key))) {
      report.push({ pair: key, status: "cached", quotedAt: known.get(key) });
      continue;
    }
    const outcome = await fetchFxRate(pair.base, pair.quote);
    if (!outcome.ok) {
      report.push({ pair: key, status: "unavailable", message: outcome.message });
      continue;
    }
    try {
      await upsertFxRate(pair.base, pair.quote, outcome.rate.rate, outcome.rate.quotedAt, outcome.rate.provider);
      report.push({
        pair: key,
        status: "fresh",
        rate: outcome.rate.rate,
        provider: outcome.rate.provider,
        quotedAt: outcome.rate.quotedAt,
      });
    } catch {
      report.push({ pair: key, status: "unavailable", message: "FX cache write failed." });
    }
  }
  return report;
}

function eventIdentity(event: DividendEvent) {
  return event.providerEventId
    ?? `${event.actionType}:${event.exDate}:${event.amountPerShare ?? ""}:${event.splitFrom ?? ""}:${event.splitTo ?? ""}`;
}

async function upsertEvents(assetId: string, events: DividendEvent[]) {
  await Promise.all(events.map((event) => supabaseRest(
    "corporate_actions?on_conflict=asset_id,provider,provider_event_id,action_type,ex_date,amount_per_share,split_from,split_to",
    {
      method: "POST",
      headers: { prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        asset_id: assetId,
        provider: event.provider,
        provider_event_id: eventIdentity(event),
        action_type: event.actionType,
        ex_date: event.exDate,
        declaration_date: event.declarationDate,
        record_date: event.recordDate,
        payment_date: event.paymentDate,
        amount_per_share: event.amountPerShare,
        currency: event.currency,
        split_from: event.splitFrom,
        split_to: event.splitTo,
        status: event.status,
        fetched_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
    },
  )));
}

function fallbackConfigured() {
  return (process.env.MARKET_DATA_FALLBACK_PROVIDER ?? "manual").toLowerCase() === "yahoo";
}

function yahooEnabled() {
  return process.env.ENABLE_EXPERIMENTAL_YAHOO_PROVIDER === "true";
}

/**
 * Synchronise chaque position indépendamment. Les quotes sont toutes traitées avant
 * l'éventuelle phase dividendes. Le quota local ne remplace pas la limite fournisseur :
 * il ouvre seulement le circuit EODHD et bascule vers Yahoo/cache.
 */
export async function syncMarketData(
  assets: SyncAsset[],
  options: { includeCorporateActions?: boolean; dependencies?: SyncDependencies } = {},
): Promise<MarketRefreshResult> {
  const dependencies = options.dependencies ?? {};
  const primaryName = dependencies.primaryName
    ?? (process.env.MARKET_DATA_PRIMARY_PROVIDER ?? "eodhd").toLowerCase();
  const fallbackName = dependencies.fallbackName !== undefined
    ? dependencies.fallbackName
    : fallbackConfigured() ? "yahoo" : null;
  const primaryConfigured = dependencies.primaryConfigured
    ?? (primaryName !== "eodhd" || isEodhdConfigured());
  const fallbackEnabled = dependencies.fallbackEnabled
    ?? (fallbackName === "yahoo" && yahooEnabled());
  const primary = dependencies.primary !== undefined ? dependencies.primary : primaryMarketProvider();
  const fallback = dependencies.fallback !== undefined ? dependencies.fallback : fallbackMarketProvider();
  const countUsage = dependencies.countUsage ?? countUsageToday;
  const recordCall = dependencies.recordCall ?? recordProviderCall;
  const saveQuote = dependencies.saveQuote ?? upsertQuote;
  const saveEvents = dependencies.saveEvents ?? upsertEvents;
  const fxSync = dependencies.syncFx ?? syncFxRates;

  const usage = primaryName === "eodhd"
    ? await countUsage("eodhd")
    : { total: 0, quote: 0, dividend: 0 };
  let eodhdCalls = usage.total;
  let circuitOpen = primaryName === "eodhd" && eodhdCalls >= DAILY_EODHD_LIMIT;
  let fallbackAttempts = 0;
  const results: MarketRefreshRow[] = [];
  const quoteCurrencyByAsset = new Map<string, string>();
  const eodhdQuotedAssets: SyncAsset[] = [];

  for (const asset of assets) {
    const cached = preservedPrice(asset);
    const identityFailure = asset.confidence === "unresolved" || asset.confidence === "ambiguous";
    const hasProviderIdentity = Boolean(asset.providerSymbol?.trim() || asset.yahooSymbol?.trim());

    if (identityFailure && !hasProviderIdentity) {
      const reason: RefreshReason = asset.confidence === "ambiguous"
        ? "ambiguous_market_identity"
        : "missing_market_identity";
      if (cached) {
        results.push({
          ...baseRow(asset),
          status: "preserved",
          provider: cached.provider === "eodhd" || cached.provider === "yahoo" ? cached.provider : null,
          price: cached.price,
          priceAt: cached.priceAt,
          reason: cached.source === "automatic_cache" ? "preserved_automatic_cache" : "preserved_manual_price",
          preservedPrice: cached,
          diagnostic: { primaryReason: reason, fallbackReason: null },
        });
      } else {
        results.push({
          ...baseRow(asset),
          status: "unresolved",
          reason,
          preservedPrice: null,
          diagnostic: { primaryReason: reason, fallbackReason: null },
        });
      }
      continue;
    }

    if (usableCache(asset.lastQuote, asset.currency) && isFetchedToday(asset.lastQuote!.fetched_at)) {
      quoteCurrencyByAsset.set(asset.id, asset.lastQuote!.currency);
      results.push({
        ...baseRow(asset),
        status: "preserved",
        provider: asset.lastQuote!.provider === "eodhd" || asset.lastQuote!.provider === "yahoo"
          ? asset.lastQuote!.provider
          : null,
        price: Number(asset.lastQuote!.price),
        currency: asset.lastQuote!.currency,
        priceAt: asset.lastQuote!.quoted_at,
        reason: "preserved_automatic_cache",
        preservedPrice: cached,
        diagnostic: { primaryReason: null, fallbackReason: null },
      });
      continue;
    }

    let primaryReason: RefreshReason | null = null;
    const canUsePrimary =
      Boolean(primary)
      && primaryConfigured
      && Boolean(asset.providerSymbol?.trim())
      && !circuitOpen;

    if (!primaryConfigured) primaryReason = "primary_not_configured";
    else if (circuitOpen) primaryReason = "primary_quota_exhausted";
    else if (!asset.providerSymbol?.trim()) primaryReason = "primary_symbol_not_found";

    if (canUsePrimary && primaryName === "eodhd") {
      await recordCall("eodhd", `quote:${requestKey(asset)}`);
      eodhdCalls += 1;
      if (eodhdCalls >= DAILY_EODHD_LIMIT) circuitOpen = true;
    }

    const canUseFallback =
      Boolean(fallback)
      && fallbackName === "yahoo"
      && fallbackEnabled
      && fallbackAttempts < MAX_FALLBACK_ATTEMPTS;

    const outcome = await getQuoteFromProviders(
      asset,
      canUsePrimary ? primary : null,
      canUseFallback ? fallback : null,
      false,
    );

    if (outcome.primaryError) {
      primaryReason = providerFailure(outcome.primaryError, "primary");
      if (isRateLimitError(outcome.primaryError)) {
        circuitOpen = true;
        console.warn("market-sync: EODHD circuit opened; remaining quotes use fallback/cache");
      }
    }
    if (canUseFallback && (!canUsePrimary || Boolean(outcome.primaryError))) fallbackAttempts += 1;

    if (outcome.quote) {
      const provider = outcome.quote.provider === "yahoo" ? "yahoo" : "eodhd";
      try {
        // Le schéma historique de market_quotes référence holdings(id), pas assets(id).
        await saveQuote(asset.id, outcome.quote);
        quoteCurrencyByAsset.set(asset.id, outcome.quote.currency);
        if (provider === "eodhd") eodhdQuotedAssets.push(asset);
        results.push({
          ...baseRow(asset),
          symbol: outcome.quote.providerSymbol,
          status: "updated",
          provider,
          price: outcome.quote.price,
          currency: outcome.quote.currency,
          priceAt: outcome.quote.quotedAt,
          reason: provider === "eodhd" ? "primary_success" : primaryReason ?? "fallback_success",
          preservedPrice: null,
          diagnostic: {
            primaryReason,
            fallbackReason: provider === "yahoo" ? "fallback_success" : null,
          },
        });
        continue;
      } catch {
        if (cached) {
          results.push({
            ...baseRow(asset),
            status: "preserved",
            provider: cached.provider === "eodhd" || cached.provider === "yahoo" ? cached.provider : null,
            price: cached.price,
            priceAt: cached.priceAt,
            reason: cached.source === "automatic_cache" ? "preserved_automatic_cache" : "preserved_manual_price",
            preservedPrice: cached,
            diagnostic: { primaryReason: "quote_storage_failed", fallbackReason: null },
          });
        } else {
          results.push({
            ...baseRow(asset),
            status: "failed",
            reason: "quote_storage_failed",
            preservedPrice: null,
            diagnostic: { primaryReason: "quote_storage_failed", fallbackReason: null },
          });
        }
        continue;
      }
    }

    let fallbackReason: RefreshReason | null;
    if (outcome.fallbackError) fallbackReason = providerFailure(outcome.fallbackError, "fallback");
    else if (fallbackName === "yahoo" && !fallbackEnabled) fallbackReason = "fallback_disabled";
    else if (fallbackAttempts >= MAX_FALLBACK_ATTEMPTS) fallbackReason = "fallback_attempt_limit";
    else if (!fallback) fallbackReason = "fallback_disabled";
    else fallbackReason = null;

    if (cached) {
      if (cached.source === "automatic_cache") quoteCurrencyByAsset.set(asset.id, asset.lastQuote!.currency);
      results.push({
        ...baseRow(asset),
        status: "preserved",
        provider: cached.provider === "eodhd" || cached.provider === "yahoo" ? cached.provider : null,
        price: cached.price,
        priceAt: cached.priceAt,
        reason: cached.source === "automatic_cache" ? "preserved_automatic_cache" : "preserved_manual_price",
        preservedPrice: cached,
        diagnostic: { primaryReason, fallbackReason },
      });
      continue;
    }

    const notFound = primaryReason === "primary_symbol_not_found"
      && (!fallbackReason || fallbackReason === "fallback_symbol_not_found");
    results.push({
      ...baseRow(asset),
      status: notFound ? "unresolved" : "failed",
      reason: fallbackReason ?? primaryReason ?? "fallback_disabled",
      preservedPrice: null,
      diagnostic: { primaryReason, fallbackReason },
    });
  }

  // Phase 2 : les dividendes viennent seulement après toutes les quotes et consomment
  // le même budget réel EODHD. Ils sont différés dès que le budget est épuisé.
  if (options.includeCorporateActions && primary && primaryName === "eodhd") {
    const from = new Date(Date.now() - 366 * 86_400_000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 366 * 86_400_000).toISOString().slice(0, 10);
    for (const asset of eodhdQuotedAssets) {
      if (eodhdCalls >= DAILY_EODHD_LIMIT) break;
      try {
        await recordCall("eodhd", `dividend:${requestKey(asset)}`);
        eodhdCalls += 1;
        await saveEvents(asset.id, await primary.getDividends(asset, from, to));
      } catch {
        // Un échec dividende ne dégrade jamais le cours déjà sauvegardé.
      }
    }
  }

  const fx = await fxSync(assets.map((asset) => ({
    base: quoteCurrencyByAsset.get(asset.id)
      ?? asset.lastQuote?.currency
      ?? asset.manualPrice?.currency
      ?? asset.currency
      ?? "",
    quote: asset.referenceCurrency ?? "EUR",
  })));
  const updated = results.filter((row) => row.status === "updated").length;
  const automaticCache = results.filter(
    (row) => row.status === "preserved" && row.preservedPrice?.source === "automatic_cache",
  ).length;
  const manualHoldingPrice = results.filter(
    (row) => row.status === "preserved" && row.preservedPrice?.source === "manual_holding",
  ).length;

  return {
    total: assets.length,
    updated,
    preserved: {
      total: automaticCache + manualHoldingPrice,
      automaticCache,
      manualHoldingPrice,
    },
    unresolved: results.filter((row) => row.status === "unresolved").length,
    failed: results.filter((row) => row.status === "failed").length,
    skipped: results.filter((row) => row.status === "skipped").length,
    provider: {
      primary: primaryName,
      primaryConfigured,
      primaryCircuitOpen: circuitOpen,
      fallback: fallbackName,
      fallbackEnabled,
    },
    results,
    fx,
  };
}

export async function acquireRefreshLock(accountId: string) {
  return await supabaseRest<boolean>("rpc/try_acquire_market_refresh_lock", {
    method: "POST",
    body: JSON.stringify({ p_account_id: accountId, p_seconds: 120 }),
  });
}

export async function releaseRefreshLock(accountId: string) {
  await supabaseRest("rpc/release_market_refresh_lock", {
    method: "POST",
    body: JSON.stringify({ p_account_id: accountId }),
  }).catch(() => undefined);
}
