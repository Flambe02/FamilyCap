import { fallbackMarketProvider, getQuoteFromProviders, isRateLimitError, primaryMarketProvider, type DividendEvent, type MarketAsset, type MarketQuote } from "./market-data";
import { fetchFxRate, isRateFreshToday, normaliseCurrency } from "./market-fx";
import { supabaseRest } from "./supabase-rest";

const DAILY_EODHD_LIMIT = 20;
const MAX_FALLBACK_ATTEMPTS = 30;
const ISO_DAY = () => new Date().toISOString().slice(0, 10);

export type CachedQuote = { provider: string; provider_symbol: string; price: number; currency: string; quoted_at: string; market_status: string; data_delay_minutes: number | null; fetched_at: string; raw_metadata: Record<string, unknown> };
export type SyncAsset = MarketAsset & { id: string; accountId: string; referenceCurrency?: string | null; lastQuote?: CachedQuote | null };
export type FxSyncRow = { pair: string; status: "fresh" | "cached" | "unavailable"; rate?: number; provider?: string; quotedAt?: string; message?: string };
export type MarketRefreshRow = { assetId: string; name: string; status: "fresh" | "stale" | "unavailable" | "manual" | "needs_review"; source: "eodhd" | "yahoo" | "cache" | "manual" | null; marketDate?: string | null };
export type MarketRefreshResult = { refreshed: number; skipped: number; cached: number; errors: number; apiLimitReached: boolean; results: MarketRefreshRow[]; fx?: FxSyncRow[] };

function isFetchedToday(value: string | null | undefined) { return String(value ?? "").slice(0, 10) === ISO_DAY(); }
function usableCache(quote: CachedQuote | null | undefined) { return Boolean(quote && Number.isFinite(Number(quote.price)) && Number(quote.price) > 0 && /^[A-Z]{3}$/.test(String(quote.currency ?? "").toUpperCase())); }
function marketDate(quote: CachedQuote | MarketQuote | null | undefined) { return quote ? ("quoted_at" in quote ? quote.quoted_at : quote.quotedAt) : null; }
function cacheRow(asset: SyncAsset): MarketRefreshRow { return { assetId: asset.id, name: asset.name, status: "stale", source: "cache", marketDate: marketDate(asset.lastQuote) }; }
function needsReview(asset: SyncAsset) {
  return asset.assetType === "other" && !asset.isin?.trim() && !asset.ticker?.trim() && !asset.providerSymbol?.trim() && !asset.yahooSymbol?.trim();
}
function requestKey(asset: SyncAsset) { return `${asset.providerSymbol ?? asset.yahooSymbol ?? asset.isin ?? asset.ticker ?? asset.id}`.trim().toUpperCase(); }

async function countCallsToday(provider: string) {
  const rows = await supabaseRest<Array<{ id: string }>>(`market_data_requests?select=id&provider=eq.${encodeURIComponent(provider)}&request_date=eq.${ISO_DAY()}`);
  return rows?.length ?? 0;
}
async function recordCall(provider: string, requestKeyValue: string) {
  await supabaseRest("market_data_requests", { method: "POST", headers: { prefer: "return=minimal" }, body: JSON.stringify({ provider, request_key: requestKeyValue, request_date: ISO_DAY() }) });
}
async function upsertQuote(assetId: string, quote: MarketQuote) {
  await supabaseRest("market_quotes?on_conflict=provider,provider_symbol", {
    method: "POST", headers: { prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ asset_id: assetId, provider: quote.provider, provider_symbol: quote.providerSymbol, price: quote.price, currency: quote.currency, quoted_at: quote.quotedAt, market_status: quote.marketStatus, data_delay_minutes: quote.dataDelayMinutes, fetched_at: new Date().toISOString(), raw_metadata: quote.rawMetadata, updated_at: new Date().toISOString() }),
  });
}
async function upsertFxRate(baseCurrency: string, quoteCurrency: string, rate: number, quotedAt: string, provider: string) {
  await supabaseRest("market_fx_rates?on_conflict=provider,base_currency,quote_currency,quoted_at", { method: "POST", headers: { prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ provider, base_currency: baseCurrency, quote_currency: quoteCurrency, rate, quoted_at: quotedAt, fetched_at: new Date().toISOString(), raw_metadata: {}, updated_at: new Date().toISOString() }) });
}

/** Change indépendant des fournisseurs de cours : aucune écriture portefeuille ici. */
export async function syncFxRates(pairs: Array<{ base: string; quote: string }>): Promise<FxSyncRow[]> {
  const wanted = new Map<string, { base: string; quote: string }>();
  for (const pair of pairs) { const base = normaliseCurrency(pair.base); const quote = normaliseCurrency(pair.quote); if (base && quote && base !== quote) wanted.set(`${base}:${quote}`, { base, quote }); }
  if (wanted.size === 0) return [];
  const known = new Map<string, string>();
  try {
    const rows = await supabaseRest<Array<{ base_currency: string; quote_currency: string; quoted_at: string }>>("market_fx_rates?select=base_currency,quote_currency,quoted_at&order=quoted_at.desc");
    for (const row of rows ?? []) if (!known.has(`${row.base_currency}:${row.quote_currency}`)) known.set(`${row.base_currency}:${row.quote_currency}`, row.quoted_at);
  } catch { /* the UI will retain its existing FX state */ }
  const report: FxSyncRow[] = [];
  for (const [key, pair] of wanted) {
    if (isRateFreshToday(known.get(key))) { report.push({ pair: key, status: "cached", quotedAt: known.get(key) }); continue; }
    const outcome = await fetchFxRate(pair.base, pair.quote);
    if (!outcome.ok) { report.push({ pair: key, status: "unavailable", message: outcome.message }); continue; }
    try { await upsertFxRate(pair.base, pair.quote, outcome.rate.rate, outcome.rate.quotedAt, outcome.rate.provider); report.push({ pair: key, status: "fresh", rate: outcome.rate.rate, provider: outcome.rate.provider, quotedAt: outcome.rate.quotedAt }); }
    catch { report.push({ pair: key, status: "unavailable", message: "FX cache write failed." }); }
  }
  return report;
}

function eventIdentity(event: DividendEvent) { return event.providerEventId ?? `${event.actionType}:${event.exDate}:${event.amountPerShare ?? ""}:${event.splitFrom ?? ""}:${event.splitTo ?? ""}`; }
async function upsertEvents(assetId: string, events: DividendEvent[]) {
  await Promise.all(events.map((event) => supabaseRest("corporate_actions?on_conflict=asset_id,provider,provider_event_id,action_type,ex_date,amount_per_share,split_from,split_to", {
    method: "POST", headers: { prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ asset_id: assetId, provider: event.provider, provider_event_id: eventIdentity(event), action_type: event.actionType, ex_date: event.exDate, declaration_date: event.declarationDate, record_date: event.recordDate, payment_date: event.paymentDate, amount_per_share: event.amountPerShare, currency: event.currency, split_from: event.splitFrom, split_to: event.splitTo, status: event.status, fetched_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
  })));
}

/**
 * Synchronise les actifs détenus. Le circuit EODHD s'ouvre au premier quota atteint : les
 * symboles restants vont directement vers le secours puis vers le dernier cache valide.
 * Une erreur de fournisseur ne modifie jamais asset_type ou les métadonnées de l'actif.
 */
export async function syncMarketData(assets: SyncAsset[], options: { includeCorporateActions?: boolean } = {}): Promise<MarketRefreshResult> {
  const primary = primaryMarketProvider(); const fallback = fallbackMarketProvider();
  const primaryName = (process.env.MARKET_DATA_PRIMARY_PROVIDER ?? "eodhd").toLowerCase();
  const results: MarketRefreshRow[] = []; const quoteCurrencyByAsset = new Map<string, string>();
  let refreshed = 0; let skipped = 0; let cached = 0; let errors = 0; let fallbackAttempts = 0;
  let calls = primaryName === "eodhd" ? await countCallsToday("eodhd") : 0;
  let circuitOpen = primaryName === "eodhd" && calls >= DAILY_EODHD_LIMIT;
  let apiLimitReached = circuitOpen;
  const seen = new Map<string, { quote: MarketQuote | null; row: MarketRefreshRow; currency: string | null }>();

  for (const asset of assets) {
    if (asset.dataProvider === "manual" && !asset.providerSymbol && !asset.yahooSymbol && !asset.isin && !asset.ticker) {
      skipped++; results.push({ assetId: asset.id, name: asset.name, status: "manual", source: "manual", marketDate: marketDate(asset.lastQuote) }); continue;
    }
    if (needsReview(asset)) {
      skipped++; results.push({ assetId: asset.id, name: asset.name, status: "needs_review", source: null, marketDate: marketDate(asset.lastQuote) }); continue;
    }
    if (usableCache(asset.lastQuote) && isFetchedToday(asset.lastQuote!.fetched_at)) {
      cached++; quoteCurrencyByAsset.set(asset.id, asset.lastQuote!.currency); results.push({ assetId: asset.id, name: asset.name, status: "fresh", source: "cache", marketDate: marketDate(asset.lastQuote) }); continue;
    }
    const key = requestKey(asset);
    const prior = seen.get(key);
    if (prior) {
      if (prior.quote) { refreshed++; quoteCurrencyByAsset.set(asset.id, prior.currency!); results.push({ ...prior.row, assetId: asset.id, name: asset.name }); }
      else if (usableCache(asset.lastQuote)) { cached++; quoteCurrencyByAsset.set(asset.id, asset.lastQuote!.currency); results.push(cacheRow(asset)); }
      else { errors++; results.push({ assetId: asset.id, name: asset.name, status: "unavailable", source: null }); }
      continue;
    }

    const canTryPrimary = Boolean(primary && asset.providerSymbol?.trim()) && !circuitOpen;
    if (canTryPrimary && primaryName === "eodhd") {
      await recordCall("eodhd", `quote:${key}`); calls += 1;
      // Le vingtième appel est autorisé ; les actifs suivants passent directement au secours.
      if (calls >= DAILY_EODHD_LIMIT) { circuitOpen = true; apiLimitReached = true; }
    }
    const canTryFallback = Boolean(fallback) && fallbackAttempts < MAX_FALLBACK_ATTEMPTS;
    const outcome = await getQuoteFromProviders(asset, canTryPrimary ? primary : null, canTryFallback ? fallback : null, false);
    // Compte aussi un échec de secours : une indisponibilité Yahoo ne doit pas devenir une
    // rafale de tentatives pour chaque ligne restante.
    if (canTryFallback && (!canTryPrimary || Boolean(outcome.primaryError))) fallbackAttempts += 1;
    if (isRateLimitError(outcome.primaryError)) {
      circuitOpen = true; apiLimitReached = true;
      // Une seule trace serveur, volontairement sans jeton ni réponse brute du fournisseur.
      console.warn("market-sync: EODHD daily circuit opened; switching remaining assets to fallback/cache");
    }
    if (!outcome.quote) {
      const row = usableCache(asset.lastQuote) ? cacheRow(asset) : { assetId: asset.id, name: asset.name, status: "unavailable" as const, source: null, marketDate: null };
      if (row.status === "stale") { cached++; quoteCurrencyByAsset.set(asset.id, asset.lastQuote!.currency); } else errors++;
      results.push(row); seen.set(key, { quote: null, row, currency: asset.lastQuote?.currency ?? null }); continue;
    }
    try {
      await upsertQuote(asset.id, outcome.quote);
      const row: MarketRefreshRow = { assetId: asset.id, name: asset.name, status: "fresh", source: outcome.quote.provider === "yahoo" ? "yahoo" : "eodhd", marketDate: outcome.quote.quotedAt };
      refreshed++; quoteCurrencyByAsset.set(asset.id, outcome.quote.currency); results.push(row); seen.set(key, { quote: outcome.quote, row, currency: outcome.quote.currency });
      // Les annonces ne sont pas requêtées pendant un rafraîchissement si le budget est serré :
      // elles restent une synchronisation EODHD distincte et ne doivent jamais évincer les cours.
      if (options.includeCorporateActions && outcome.quote.provider === "eodhd" && !circuitOpen && calls < DAILY_EODHD_LIMIT - 1 && primary) {
        try { await recordCall("eodhd", `div:${key}`); calls += 1; const from = new Date(Date.now() - 366 * 86_400_000).toISOString().slice(0, 10); const to = new Date(Date.now() + 366 * 86_400_000).toISOString().slice(0, 10); await upsertEvents(asset.id, await primary.getDividends(asset, from, to)); } catch { /* quote stays valid */ }
      }
    } catch {
      const row = usableCache(asset.lastQuote) ? cacheRow(asset) : { assetId: asset.id, name: asset.name, status: "unavailable" as const, source: null, marketDate: null };
      if (row.status === "stale") { cached++; quoteCurrencyByAsset.set(asset.id, asset.lastQuote!.currency); } else errors++;
      results.push(row); seen.set(key, { quote: null, row, currency: asset.lastQuote?.currency ?? null });
    }
  }
  const fx = await syncFxRates(assets.map((asset) => ({ base: quoteCurrencyByAsset.get(asset.id) ?? asset.lastQuote?.currency ?? asset.currency ?? "", quote: asset.referenceCurrency ?? "EUR" })));
  return { refreshed, skipped, cached, errors, apiLimitReached, results, fx };
}

export async function acquireRefreshLock(accountId: string) { return await supabaseRest<boolean>("rpc/try_acquire_market_refresh_lock", { method: "POST", body: JSON.stringify({ p_account_id: accountId, p_seconds: 120 }) }); }
export async function releaseRefreshLock(accountId: string) { await supabaseRest("rpc/release_market_refresh_lock", { method: "POST", body: JSON.stringify({ p_account_id: accountId }) }).catch(() => undefined); }
