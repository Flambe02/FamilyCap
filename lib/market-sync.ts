import { primaryMarketProvider, type DividendEvent, type MarketAsset, type MarketQuote } from "./market-data";
import { fetchFxRate, isRateFreshToday, normaliseCurrency } from "./market-fx";
import { supabaseRest } from "./supabase-rest";

const DAILY_EODHD_LIMIT = 20;
const ISO_DAY = () => new Date().toISOString().slice(0, 10);

export type SyncAsset = MarketAsset & { id: string; accountId: string; referenceCurrency?: string | null; lastQuote?: CachedQuote | null };
export type CachedQuote = { provider: string; provider_symbol: string; price: number; currency: string; quoted_at: string; market_status: string; data_delay_minutes: number | null; fetched_at: string; raw_metadata: Record<string, unknown> };
export type FxSyncRow = { pair: string; status: "fresh" | "cached" | "unavailable"; rate?: number; provider?: string; quotedAt?: string; message?: string };
export type MarketRefreshResult = {
  refreshed: number; skipped: number; cached: number; errors: number; apiLimitReached: boolean;
  results: Array<{ assetId: string; name: string; status: "fresh" | "stale" | "unavailable" | "manual"; message?: string }>;
  fx?: FxSyncRow[];
};

function isFetchedToday(value: string | null | undefined) { return String(value ?? "").slice(0, 10) === ISO_DAY(); }
function validSymbol(asset: SyncAsset) { return Boolean(asset.providerSymbol?.trim()) && asset.dataProvider !== "manual"; }

async function countCallsToday(provider: string) {
  const rows = await supabaseRest<Array<{ id: string }>>(`market_data_requests?select=id&provider=eq.${encodeURIComponent(provider)}&request_date=eq.${ISO_DAY()}`);
  return rows?.length ?? 0;
}
async function recordCall(provider: string, requestKey: string) {
  await supabaseRest("market_data_requests", {
    method: "POST", headers: { prefer: "return=minimal" },
    body: JSON.stringify({ provider, request_key: requestKey, request_date: ISO_DAY() }),
  });
}
async function upsertQuote(assetId: string, quote: MarketQuote) {
  await supabaseRest("market_quotes?on_conflict=provider,provider_symbol", {
    method: "POST", headers: { prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      asset_id: assetId, provider: quote.provider, provider_symbol: quote.providerSymbol, price: quote.price,
      currency: quote.currency, quoted_at: quote.quotedAt, market_status: quote.marketStatus,
      data_delay_minutes: quote.dataDelayMinutes, fetched_at: new Date().toISOString(), raw_metadata: quote.rawMetadata,
      updated_at: new Date().toISOString(),
    }),
  });
}
async function upsertFxRate(baseCurrency: string, quoteCurrency: string, rate: number, quotedAt: string, provider: string) {
  await supabaseRest("market_fx_rates?on_conflict=provider,base_currency,quote_currency,quoted_at", {
    method: "POST", headers: { prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ provider, base_currency: baseCurrency, quote_currency: quoteCurrency, rate, quoted_at: quotedAt, fetched_at: new Date().toISOString(), raw_metadata: {}, updated_at: new Date().toISOString() }),
  });
}
/**
 * Passe de change AUTONOME. Trois propriétés la distinguent de l'ancien code, et ce sont les
 * trois raisons pour lesquelles `market_fx_rates` restait vide :
 *   1. elle s'exécute même quand tous les cours viennent du cache du jour ;
 *   2. elle n'emprunte rien au quota EODHD (fournisseurs gratuits, sans clé) ;
 *   3. elle est rapportée ligne à ligne, donc un échec se voit au lieu d'être avalé.
 * Écrit uniquement dans `market_fx_rates` : ni cours, ni quantité, ni opération.
 */
export async function syncFxRates(pairs: Array<{ base: string; quote: string }>): Promise<FxSyncRow[]> {
  const wanted = new Map<string, { base: string; quote: string }>();
  for (const pair of pairs) {
    const base = normaliseCurrency(pair.base);
    const quote = normaliseCurrency(pair.quote);
    if (!base || !quote || base === quote) continue; // une paire identique vaut 1, rien à stocker
    wanted.set(`${base}:${quote}`, { base, quote });
  }
  if (wanted.size === 0) return [];

  // Cache : un taux déjà daté d'aujourd'hui n'est pas relu (les deux fournisseurs publient au
  // plus une valeur par jour ouvré).
  const known = new Map<string, string>();
  try {
    const rows = await supabaseRest<Array<{ base_currency: string; quote_currency: string; quoted_at: string }>>(
      "market_fx_rates?select=base_currency,quote_currency,quoted_at&order=quoted_at.desc",
    );
    for (const row of rows ?? []) {
      const key = `${row.base_currency}:${row.quote_currency}`;
      if (!known.has(key)) known.set(key, row.quoted_at);
    }
  } catch { /* table absente ou injoignable : on tentera l'écriture, elle rapportera l'erreur */ }

  const report: FxSyncRow[] = [];
  for (const [key, { base, quote }] of wanted) {
    if (isRateFreshToday(known.get(key))) {
      report.push({ pair: key, status: "cached", quotedAt: known.get(key), message: "Taux du jour déjà enregistré." });
      continue;
    }
    const outcome = await fetchFxRate(base, quote);
    if (!outcome.ok) {
      report.push({ pair: key, status: "unavailable", message: outcome.message });
      continue;
    }
    try {
      await upsertFxRate(base, quote, outcome.rate.rate, outcome.rate.quotedAt, outcome.rate.provider);
      report.push({ pair: key, status: "fresh", rate: outcome.rate.rate, provider: outcome.rate.provider, quotedAt: outcome.rate.quotedAt });
    } catch (error) {
      report.push({ pair: key, status: "unavailable", message: error instanceof Error ? error.message : "Enregistrement du taux impossible." });
    }
  }
  return report;
}

function eventIdentity(event: DividendEvent) {
  return event.providerEventId ?? `${event.actionType}:${event.exDate}:${event.amountPerShare ?? ""}:${event.splitFrom ?? ""}:${event.splitTo ?? ""}`;
}
async function upsertEvents(assetId: string, events: DividendEvent[]) {
  await Promise.all(events.map((event) => supabaseRest("corporate_actions?on_conflict=asset_id,provider,provider_event_id,action_type,ex_date,amount_per_share,split_from,split_to", {
    method: "POST", headers: { prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      asset_id: assetId, provider: event.provider, provider_event_id: eventIdentity(event), action_type: event.actionType,
      ex_date: event.exDate, declaration_date: event.declarationDate, record_date: event.recordDate, payment_date: event.paymentDate,
      amount_per_share: event.amountPerShare, currency: event.currency, split_from: event.splitFrom, split_to: event.splitTo,
      status: event.status, fetched_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }),
  })));
}

/**
 * Synchronise uniquement les actifs actuellement détenus, dédupliqués par symbole. Le cache
 * quotidien est consulté AVANT tout appel réseau et le dernier cours valide n'est jamais écrasé
 * lors d'une erreur fournisseur. `account_operations` n'est ni lu ni écrit ici.
 */
export async function syncMarketData(assets: SyncAsset[], options: { includeCorporateActions?: boolean } = {}): Promise<MarketRefreshResult> {
  const provider = primaryMarketProvider();
  const primaryName = (process.env.MARKET_DATA_PRIMARY_PROVIDER ?? "eodhd").toLowerCase();
  const results: MarketRefreshResult["results"] = [];
  let refreshed = 0; let skipped = 0; let cached = 0; let errors = 0;
  if (!provider) {
    // Sans fournisseur de cours, le change reste néanmoins récupérable : ses deux sources sont
    // gratuites et sans clé. Une position dont le cours est déjà connu redevient donc valorisée.
    const fxOnly = await syncFxRates(assets.map((asset) => ({ base: asset.lastQuote?.currency ?? asset.currency ?? "", quote: asset.referenceCurrency ?? "EUR" })));
    return { refreshed, skipped, cached, errors: assets.length, apiLimitReached: false, fx: fxOnly, results: assets.map((asset) => ({ assetId: asset.id, name: asset.name, status: "unavailable", message: "Fournisseur de marché non configuré." })) };
  }

  const distinct = new Map<string, SyncAsset[]>();
  for (const asset of assets) {
    if (!validSymbol(asset)) {
      skipped++; results.push({ assetId: asset.id, name: asset.name, status: asset.dataProvider === "manual" ? "manual" : "unavailable", message: asset.dataProvider === "manual" ? "Cours manuel." : "Actif à classifier : symbole validé manquant." });
      continue;
    }
    const key = `${primaryName}:${asset.providerSymbol!.trim().toUpperCase()}`;
    const group = distinct.get(key) ?? [];
    group.push(asset); distinct.set(key, group);
  }

  // Devise réellement cotée par actif (elle peut différer de `holdings.currency`) : c'est elle
  // qui détermine la paire de change à relever.
  const quoteCurrencyByAsset = new Map<string, string>();
  let calls = await countCallsToday(primaryName);
  let apiLimitReached = calls >= DAILY_EODHD_LIMIT;
  for (const group of distinct.values()) {
    const representative = group[0];
    const cachedToday = group.some((asset) => asset.lastQuote && asset.lastQuote.provider === primaryName && isFetchedToday(asset.lastQuote.fetched_at));
    if (cachedToday) {
      cached += group.length;
      for (const asset of group) results.push({ assetId: asset.id, name: asset.name, status: "fresh", message: "Servi depuis le cache du jour." });
      continue;
    }
    if (calls >= DAILY_EODHD_LIMIT) {
      apiLimitReached = true; skipped += group.length;
      for (const asset of group) results.push({ assetId: asset.id, name: asset.name, status: representative.lastQuote ? "stale" : "unavailable", message: "Limite quotidienne EODHD atteinte : dernier cours conservé." });
      continue;
    }
    try {
      await recordCall(primaryName, `quote:${representative.providerSymbol!.trim().toUpperCase()}`);
      calls += 1;
      const quote = await provider.getQuote(representative);
      // Un symbole peut être présent sur plusieurs comptes : market_quotes est unique par
      // provider/symbole. On rattache le cache au premier référentiel et les autres lignes
      // utilisent le même prix à la lecture sans réémettre d'appel.
      await upsertQuote(representative.id, quote);
      refreshed += group.length;
      for (const asset of group) results.push({ assetId: asset.id, name: asset.name, status: "fresh" });

      // Le taux de change de cette devise est relevé par `syncFxRates`, APRÈS cette boucle : le
      // faire ici le rendait tributaire du cache des cours et du quota EODHD, et il n'était donc
      // jamais écrit en régime de croisière.
      for (const asset of group) quoteCurrencyByAsset.set(asset.id, quote.currency);

      // Dividendes : au plus un appel supplémentaire par symbole et par jour, uniquement si le
      // budget le permet. Ce sont des ANNONCES, jamais des opérations de compte.
      if (options.includeCorporateActions && calls < DAILY_EODHD_LIMIT) {
        try {
          await recordCall(primaryName, `div:${representative.providerSymbol!.trim().toUpperCase()}`);
          calls += 1;
          const from = new Date(Date.now() - 366 * 86_400_000).toISOString().slice(0, 10);
          const to = new Date(Date.now() + 366 * 86_400_000).toISOString().slice(0, 10);
          await upsertEvents(representative.id, await provider.getDividends(representative, from, to));
        } catch { /* Le cours valide reste utilisable même si les annonces échouent. */ }
      }
    } catch (error) {
      errors += group.length;
      const message = error instanceof Error ? error.message : "Erreur fournisseur.";
      for (const asset of group) results.push({ assetId: asset.id, name: asset.name, status: asset.lastQuote ? "stale" : "unavailable", message });
    }
  }
  // Passe de change : TOUJOURS exécutée, y compris quand chaque cours venait du cache et que la
  // boucle ci-dessus n'a fait aucun appel. La devise retenue par actif est celle réellement
  // cotée quand on vient de la lire, sinon celle du cache, sinon celle du référentiel.
  const fx = await syncFxRates(assets.map((asset) => ({
    base: quoteCurrencyByAsset.get(asset.id) ?? asset.lastQuote?.currency ?? asset.currency ?? "",
    quote: asset.referenceCurrency ?? "EUR",
  })));
  return { refreshed, skipped, cached, errors, apiLimitReached, results, fx };
}

export async function acquireRefreshLock(accountId: string) {
  const response = await supabaseRest<boolean>("rpc/try_acquire_market_refresh_lock", { method: "POST", body: JSON.stringify({ p_account_id: accountId, p_seconds: 120 }) });
  return response === true;
}
export async function releaseRefreshLock(accountId: string) {
  await supabaseRest("rpc/release_market_refresh_lock", { method: "POST", body: JSON.stringify({ p_account_id: accountId }) }).catch(() => undefined);
}
