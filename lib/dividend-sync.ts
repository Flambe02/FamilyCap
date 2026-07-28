// ORCHESTRATION DE LA SYNCHRONISATION DES DIVIDENDES — serveur uniquement.
//
// Enchaînement, dans cet ordre et jamais un autre :
//   1. instruments réellement DÉTENUS (dérivés des opérations, jamais d'une table de positions) ;
//   2. rattachement à l'identité canonique `assets` + `asset_listings` ;
//   3. cache et quota : un instrument synchronisé il y a moins de `DIVIDEND_CACHE_TTL_HOURS`
//      n'est pas réinterrogé, et le quota quotidien du fournisseur est décompté AVANT l'appel ;
//   4. récupération des annonces et de l'historique nécessaire ;
//   5. normalisation des devises, montants et dates ;
//   6. fusion des doublons entre fournisseurs ;
//   7. enregistrement avec provenance ;
//   8. génération des projections manquantes ;
//   9. rapport lisible.
//
// GARANTIES
//   * aucune écriture dans `account_operations` — un dividende reçu ne peut être ni créé, ni
//     modifié, ni supprimé par une synchronisation ;
//   * un fournisseur muet ne supprime RIEN : les événements déjà enregistrés restent en place ;
//   * seules les PROJECTIONS (`is_forecast = true`) peuvent être remplacées, car elles sont
//     dérivées par construction ;
//   * la file est progressive : avec 26 positions et 25 appels par jour, l'amorçage s'étale sur
//     deux jours sans jamais repartir de zéro.

import { supabaseRest } from "./supabase-rest.ts";
import {
  alphaVantageDailyLimit, dividendCacheTtlHours, dividendProviderChain, projectionsEnabled,
  AlphaVantageDividendProvider,
  type DividendProvider, type NormalizedDividend, type ProviderInstrument,
} from "./dividend-providers.ts";
import { flagSpecialDividends, projectDividends, type HistoricalDividendPoint } from "./dividend-projection.ts";
import { resolveDistributionPolicy, type DividendType, type SyncReport } from "./dividend-engine.ts";
import { loadDividendContext, loadDividendEvents, type DividendContext, type HoldingRow } from "./dividend-server.ts";

/** Quota EODHD déjà en vigueur ailleurs dans le projet (lib/market-sync.ts). */
export const EODHD_DAILY_LIMIT = 20;
const ISIN_SHAPE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
const HISTORY_YEARS = 6;

export type SyncInstrumentOutcome = {
  assetId: string;
  name: string;
  isin: string | null;
  provider: string | null;
  symbol: string | null;
  status: "updated" | "cached" | "no_data" | "unresolved" | "accumulating" | "quota_deferred" | "provider_error";
  eventsWritten: number;
  forecasts: number;
  message: string;
};

export type DividendSyncResult = {
  report: SyncReport;
  outcomes: SyncInstrumentOutcome[];
  quota: Array<{ provider: string; used: number; limit: number | null }>;
  providers: Array<{ name: string; configured: boolean }>;
  projectionsEnabled: boolean;
  ranAt: string;
};

type SyncDependencies = {
  providers?: DividendProvider[];
  countUsage?: (provider: string) => Promise<number>;
  recordCall?: (provider: string, requestKey: string) => Promise<void>;
  saveEvents?: (assetId: string, rows: Array<Record<string, unknown>>) => Promise<void>;
  replaceForecasts?: (assetId: string, rows: Array<Record<string, unknown>>) => Promise<void>;
  saveState?: (assetId: string, provider: string, state: Record<string, unknown>) => Promise<void>;
  loadState?: (assetIds: string[]) => Promise<Map<string, { provider: string; lastSuccessAt: string | null }>>;
  now?: () => Date;
};

// ==========================================================================================
// Quota — le même journal que les cours, pour que les deux ne se marchent pas dessus
// ==========================================================================================
const ISO_DAY = (now: Date) => now.toISOString().slice(0, 10);

async function countUsageToday(provider: string, now: Date): Promise<number> {
  const rows = await supabaseRest<Array<{ request_key: string }>>(
    `market_data_requests?select=request_key&provider=eq.${encodeURIComponent(provider)}&request_date=eq.${ISO_DAY(now)}`,
  ).catch(() => []);
  return (rows ?? []).length;
}

async function recordProviderCall(provider: string, requestKey: string, now: Date): Promise<void> {
  await supabaseRest("market_data_requests?on_conflict=provider,request_key,request_date", {
    method: "POST",
    headers: { prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ provider, request_key: requestKey, request_date: ISO_DAY(now) }),
  }).catch(() => undefined);
}

export function providerDailyLimit(provider: string): number | null {
  if (provider === "alpha_vantage") return alphaVantageDailyLimit();
  if (provider === "eodhd") return EODHD_DAILY_LIMIT;
  return null; // Yahoo : pas de quota contractuel, il est déjà encadré par le nombre de positions
}

// ==========================================================================================
// Normalisation et fusion
// ==========================================================================================
/**
 * Devise d'un événement : celle publiée par le fournisseur, sinon celle de la COTATION.
 * Alpha Vantage ne publie aucune devise — sans cotation connue, l'événement est ABANDONNÉ plutôt
 * qu'enregistré en euros par défaut : un dividende américain compté en euros vaut ~15 % de trop.
 */
export function normalizeCurrency(event: NormalizedDividend, listingCurrency: string | null): string | null {
  return event.currency ?? (listingCurrency ? listingCurrency.toUpperCase() : null);
}

type MergedEvent = NormalizedDividend & { currency: string; provider: string };

/**
 * Fusion entre fournisseurs. Deux événements décrivent le MÊME versement lorsqu'ils tombent à
 * moins de 4 jours l'un de l'autre pour un montant identique à 1 % près.
 *
 * Le gagnant est celui qui apporte le plus d'information : une ligne avec date de paiement bat une
 * ligne sans, parce que c'est exactement le manque qui faisait afficher le détachement à la place
 * du paiement. À information égale, l'ordre de la chaîne de fournisseurs tranche.
 */
export function mergeProviderEvents(groups: MergedEvent[][]): MergedEvent[] {
  const merged: MergedEvent[] = [];
  for (const group of groups) {
    for (const event of group) {
      const reference = event.exDate ?? event.paymentDate;
      if (!reference) continue;
      const existingIndex = merged.findIndex((candidate) => {
        if (candidate.currency !== event.currency) return false;
        const candidateReference = candidate.exDate ?? candidate.paymentDate;
        if (!candidateReference) return false;
        const days = Math.abs(Date.parse(`${candidateReference}T00:00:00Z`) - Date.parse(`${reference}T00:00:00Z`)) / 86_400_000;
        if (days > 4) return false;
        const high = Math.max(candidate.amountPerShare, event.amountPerShare);
        return high > 0 && Math.abs(candidate.amountPerShare - event.amountPerShare) / high <= 0.01;
      });
      if (existingIndex === -1) {
        merged.push(event);
        continue;
      }
      const existing = merged[existingIndex];
      const score = (item: MergedEvent) => (item.paymentDate ? 4 : 0) + (item.exDate ? 2 : 0) + (item.declarationDate ? 1 : 0);
      if (score(event) > score(existing)) merged[existingIndex] = event;
    }
  }
  return merged.sort((a, b) => (a.exDate ?? a.paymentDate ?? "").localeCompare(b.exDate ?? b.paymentDate ?? ""));
}

// ==========================================================================================
// Catalogue : dé-duplication de `holdings`, JAMAIS invention d'un instrument
// ==========================================================================================
/**
 * Crée l'identité canonique manquante à partir de ce que `holdings` porte DÉJÀ (ISIN, nom, type,
 * devise, symboles). Rien n'est inventé : on rassemble sous une clé unique des lignes qui
 * existent en double parce que `holdings.account_id` est NOT NULL.
 *
 * Le statut reste `inferred` : seul un administrateur accorde `verified` (règle du projet).
 */
async function ensureCatalogEntries(context: DividendContext): Promise<number> {
  const missing = context.unresolvedPositions
    .map((position) => ({
      position,
      holding: context.holdingByPositionKey.get(position.key) ?? null,
    }))
    .filter((entry): entry is { position: (typeof context.unresolvedPositions)[number]; holding: HoldingRow } => {
      const isin = (entry.holding?.isin ?? entry.position.isin ?? "").trim().toUpperCase();
      return entry.holding !== null && ISIN_SHAPE.test(isin);
    });
  if (missing.length === 0) return 0;

  const byIsin = new Map<string, HoldingRow>();
  for (const entry of missing) {
    const isin = (entry.holding.isin ?? entry.position.isin ?? "").trim().toUpperCase();
    if (!byIsin.has(isin)) byIsin.set(isin, entry.holding);
  }

  const assetRows = [...byIsin.entries()].map(([isin, holding]) => ({
    isin,
    name: (holding.name ?? isin).trim(),
    asset_type: holding.asset_type ?? "other",
    classification_status: "inferred",
    source: "holdings",
  }));
  await supabaseRest("assets?on_conflict=isin", {
    method: "POST",
    headers: { prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(assetRows),
  }).catch(() => undefined);

  const created = await supabaseRest<Array<{ id: string; isin: string | null }>>(
    `assets?select=id,isin&isin=in.(${[...byIsin.keys()].map(encodeURIComponent).join(",")})`,
  ).catch(() => []);
  const assetIdByIsin = new Map((created ?? []).map((asset) => [(asset.isin ?? "").toUpperCase(), asset.id]));

  const listingRows = [...byIsin.entries()]
    .map(([isin, holding]) => {
      const assetId = assetIdByIsin.get(isin);
      if (!assetId) return null;
      // Le symbole n'est repris que s'il a été VALIDÉ ailleurs (cours réellement obtenu). Un
      // symbole deviné ici ferait interroger un homonyme d'une autre place.
      const eodhd = holding.provider_symbol?.trim() || holding.market_symbol?.trim() || null;
      const yahoo = holding.yahoo_symbol?.trim() || holding.market_symbol?.trim() || null;
      return {
        asset_id: assetId,
        ticker: holding.symbol?.trim() || null,
        exchange: holding.exchange ?? null,
        mic_code: holding.mic_code ?? null,
        currency: (holding.currency || "EUR").toUpperCase(),
        country: holding.country ?? null,
        eodhd_symbol: eodhd,
        yahoo_symbol: yahoo,
        validation_status: "inferred",
        resolution_status: eodhd || yahoo ? "resolved" : "unresolved",
        source: "holdings",
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  if (listingRows.length > 0) {
    await supabaseRest("asset_listings?on_conflict=asset_id,mic_code,currency,ticker", {
      method: "POST",
      headers: { prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(listingRows),
    }).catch(async () => {
      // Contrainte d'unicité exprimée en index d'expression : l'upsert nommé peut être refusé.
      // On insère alors une à une, en ignorant les doublons — jamais en écrasant une ligne.
      for (const row of listingRows) {
        await supabaseRest("asset_listings", {
          method: "POST",
          headers: { prefer: "return=minimal" },
          body: JSON.stringify(row),
        }).catch(() => undefined);
      }
    });
  }
  return byIsin.size;
}

// ==========================================================================================
// Écritures
// ==========================================================================================
async function saveEventRows(_assetId: string, rows: Array<Record<string, unknown>>): Promise<void> {
  if (rows.length === 0) return;
  // `on_conflict` sur la clé fournisseur : re-synchroniser met à jour, ne duplique jamais.
  await supabaseRest("dividend_events?on_conflict=asset_id,source_provider,source_event_id", {
    method: "POST",
    headers: { prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });
}

async function replaceForecastRows(assetId: string, rows: Array<Record<string, unknown>>): Promise<void> {
  // Seules les PROJECTIONS sont supprimées, et seulement celles de cet instrument. Un fait
  // fournisseur (`is_forecast = false`) n'est jamais touché : c'est la garantie qu'une
  // synchronisation ne peut pas faire disparaître une annonce ou un historique.
  await supabaseRest(
    `dividend_events?asset_id=eq.${encodeURIComponent(assetId)}&is_forecast=is.true&account_id=is.null`,
    { method: "DELETE", headers: { prefer: "return=minimal" } },
  ).catch(() => undefined);
  if (rows.length === 0) return;
  await supabaseRest("dividend_events", {
    method: "POST",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify(rows),
  }).catch(() => undefined);
}

async function saveSyncState(assetId: string, provider: string, state: Record<string, unknown>): Promise<void> {
  await supabaseRest("dividend_sync_state?on_conflict=asset_id,provider", {
    method: "POST",
    headers: { prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ asset_id: assetId, provider, updated_at: new Date().toISOString(), ...state }),
  }).catch(() => undefined);
}

async function loadSyncState(assetIds: string[]): Promise<Map<string, { provider: string; lastSuccessAt: string | null }>> {
  if (assetIds.length === 0) return new Map();
  const rows = await supabaseRest<Array<{ asset_id: string; provider: string; last_success_at: string | null }>>(
    `dividend_sync_state?select=asset_id,provider,last_success_at&asset_id=in.(${assetIds.join(",")})&order=last_success_at.desc.nullslast`,
  ).catch(() => []);
  const map = new Map<string, { provider: string; lastSuccessAt: string | null }>();
  for (const row of rows ?? []) if (!map.has(row.asset_id)) map.set(row.asset_id, { provider: row.provider, lastSuccessAt: row.last_success_at });
  return map;
}

// ==========================================================================================
// Synchronisation
// ==========================================================================================
export async function syncAccountDividends(
  accountIds: string[],
  options: { today?: string; force?: boolean; dependencies?: SyncDependencies } = {},
): Promise<DividendSyncResult | null> {
  const dependencies = options.dependencies ?? {};
  const now = dependencies.now?.() ?? new Date();
  const today = options.today ?? now.toISOString().slice(0, 10);

  let context = await loadDividendContext(accountIds, today);
  if (!context) return null;

  // Un instrument détenu mais absent du catalogue ne peut être interrogé chez aucun fournisseur.
  // On le crée à partir de ce que `holdings` porte déjà, puis on relit le contexte.
  if (context.unresolvedPositions.length > 0) {
    const created = await ensureCatalogEntries(context);
    if (created > 0) context = (await loadDividendContext(accountIds, today)) ?? context;
  }

  const providers = dependencies.providers ?? dividendProviderChain();
  const countUsage = dependencies.countUsage ?? ((provider: string) => countUsageToday(provider, now));
  const recordCall = dependencies.recordCall ?? ((provider: string, key: string) => recordProviderCall(provider, key, now));
  const saveEvents = dependencies.saveEvents ?? saveEventRows;
  const replaceForecasts = dependencies.replaceForecasts ?? replaceForecastRows;
  const saveState = dependencies.saveState ?? saveSyncState;
  const readState = dependencies.loadState ?? loadSyncState;

  const usage = new Map<string, number>();
  for (const provider of providers) usage.set(provider.name, await countUsage(provider.name));

  const state = await readState(context.instruments.map((instrument) => instrument.assetId));
  const ttlMs = dividendCacheTtlHours() * 3_600_000;

  // ---- File : jamais synchronisé d'abord, puis le plus ancien --------------------------------
  const queue = [...context.instruments].sort((a, b) => {
    const left = state.get(a.assetId)?.lastSuccessAt ?? "";
    const right = state.get(b.assetId)?.lastSuccessAt ?? "";
    if (left === right) return a.name.localeCompare(b.name);
    if (!left) return -1;
    if (!right) return 1;
    return left.localeCompare(right);
  });

  const outcomes: SyncInstrumentOutcome[] = [];
  const historyFrom = new Date(now.getTime() - HISTORY_YEARS * 365 * 86_400_000).toISOString().slice(0, 10);
  const historyTo = new Date(now.getTime() + 400 * 86_400_000).toISOString().slice(0, 10);
  const touchedAssets: string[] = [];

  for (const instrument of queue) {
    const listing = context.listingByAsset.get(instrument.assetId) ?? null;
    const asset = context.assetById.get(instrument.assetId) ?? null;
    const policy = resolveDistributionPolicy({
      distributionPolicy: instrument.distributionPolicy,
      name: instrument.name,
      assetType: instrument.assetType,
    });

    if (policy === "accumulating") {
      outcomes.push({
        assetId: instrument.assetId, name: instrument.name, isin: instrument.isin, provider: null, symbol: null,
        status: "accumulating", eventsWritten: 0, forecasts: 0,
        message: "Capitalisant. Aucun versement en espèces attendu.",
      });
      await saveState(instrument.assetId, "engine", { status: "accumulating", message: "ETF/fonds capitalisant", last_attempt_at: now.toISOString() });
      continue;
    }

    const lastSuccess = state.get(instrument.assetId)?.lastSuccessAt ?? null;
    if (!options.force && lastSuccess && now.getTime() - Date.parse(lastSuccess) < ttlMs) {
      outcomes.push({
        assetId: instrument.assetId, name: instrument.name, isin: instrument.isin, provider: null, symbol: null,
        status: "cached", eventsWritten: 0, forecasts: 0,
        message: `Déjà synchronisé le ${lastSuccess.slice(0, 10)} : le cache est encore valide.`,
      });
      continue;
    }

    const providerInstrument: ProviderInstrument = {
      isin: instrument.isin,
      ticker: instrument.ticker,
      name: instrument.name,
      currency: listing?.currency ?? context.holdingByPositionKey.get(instrument.positionKeys[0])?.currency ?? null,
      micCode: listing?.mic_code ?? null,
      exchange: listing?.exchange ?? null,
      alphaVantageSymbol: listing?.alpha_vantage_symbol ?? null,
      eodhdSymbol: listing?.eodhd_symbol ?? null,
      yahooSymbol: listing?.yahoo_symbol ?? null,
    };
    const listingCurrency = providerInstrument.currency;

    const groups: MergedEvent[][] = [];
    let usedProvider: string | null = null;
    let usedSymbol: string | null = null;
    let quotaDeferred = false;
    let lastError = "";

    for (const provider of providers) {
      const limit = providerDailyLimit(provider.name);
      const used = usage.get(provider.name) ?? 0;
      if (limit !== null && used >= limit) {
        quotaDeferred = true;
        continue;
      }
      const symbol = provider.symbolFor(providerInstrument);
      if (!symbol) continue;
      if (limit !== null) {
        // Décompté AVANT l'appel : une réponse en erreur consomme le quota du fournisseur aussi
        // sûrement qu'une réponse utile. Ne compter que les succès ferait dépasser la limite.
        await recordCall(provider.name, `dividend:${symbol}`);
        usage.set(provider.name, used + 1);
      }
      const result = await provider.fetchDividends(symbol, { from: historyFrom, to: historyTo });
      if (!result.ok) {
        lastError = result.message;
        if (result.code === "rate_limited") {
          quotaDeferred = true;
          usage.set(provider.name, (limit ?? 0) + 1); // circuit ouvert pour le reste du lot
        }
        continue;
      }
      const withCurrency = result.dividends
        .map((event) => ({ ...event, currency: normalizeCurrency(event, listingCurrency) }))
        .filter((event): event is NormalizedDividend & { currency: string } => event.currency !== null)
        .map((event) => ({ ...event, provider: result.provider }));
      if (withCurrency.length === 0) continue;
      groups.push(withCurrency);
      if (!usedProvider) {
        usedProvider = result.provider;
        usedSymbol = symbol;
      }
    }

    if (groups.length === 0) {
      const status: SyncInstrumentOutcome["status"] = quotaDeferred
        ? "quota_deferred"
        : providers.length === 0
          ? "provider_error"
          : providerInstrument.alphaVantageSymbol || providerInstrument.eodhdSymbol || providerInstrument.yahooSymbol
            ? lastError ? "provider_error" : "no_data"
            : "unresolved";
      outcomes.push({
        assetId: instrument.assetId, name: instrument.name, isin: instrument.isin, provider: null, symbol: null,
        status, eventsWritten: 0, forecasts: 0,
        message: status === "quota_deferred"
          ? "Quota quotidien atteint. La synchronisation reprendra automatiquement demain."
          : status === "unresolved"
            ? "Aucun symbole fournisseur validé pour cet instrument."
            : status === "no_data"
              ? "Le fournisseur ne connaît aucun dividende pour cet instrument."
              : lastError || "Aucun fournisseur de dividendes n’est configuré.",
      });
      await saveState(instrument.assetId, usedProvider ?? "none", {
        status: status === "quota_deferred" ? "quota_deferred" : status === "unresolved" ? "unresolved" : status === "no_data" ? "no_data" : "provider_error",
        message: lastError.slice(0, 200) || null,
        last_attempt_at: now.toISOString(),
      });
      continue;
    }

    const merged = flagSpecialDividends(mergeProviderEvents(groups).map((event) => ({
      ...event,
      dividendType: event.dividendType as DividendType,
    })));

    const rows = merged.map((event) => ({
      asset_id: instrument.assetId,
      listing_id: listing?.id ?? null,
      account_id: null,
      isin: instrument.isin,
      provider_symbol: usedSymbol,
      status: "announced",
      dividend_type: event.dividendType,
      declaration_date: event.declarationDate,
      ex_date: event.exDate,
      record_date: event.recordDate,
      payment_date: event.paymentDate,
      estimated_month: null,
      amount_per_share: event.amountPerShare,
      currency: event.currency,
      source_provider: event.provider,
      source_event_id: event.providerEventId,
      source_url: event.sourceUrl,
      confidence: "high",
      is_special: event.isSpecial,
      is_forecast: false,
      last_synced_at: now.toISOString(),
      updated_at: now.toISOString(),
    }));

    try {
      await saveEvents(instrument.assetId, rows);
    } catch (error) {
      outcomes.push({
        assetId: instrument.assetId, name: instrument.name, isin: instrument.isin, provider: usedProvider, symbol: usedSymbol,
        status: "provider_error", eventsWritten: 0, forecasts: 0,
        message: `Enregistrement impossible : ${error instanceof Error ? error.message.slice(0, 120) : "erreur inconnue"}`,
      });
      continue;
    }

    // ---- Projections ------------------------------------------------------------------------
    let forecasts = 0;
    if (projectionsEnabled()) {
      const history: HistoricalDividendPoint[] = merged
        .filter((event) => event.exDate !== null && event.exDate < today)
        .map((event) => ({
          exDate: event.exDate as string,
          amountPerShare: event.amountPerShare,
          currency: event.currency,
          dividendType: event.dividendType,
          isSpecial: event.isSpecial,
        }));
      const announcedAhead = merged
        .filter((event) => (event.paymentDate ?? event.exDate ?? "") >= today)
        .map((event) => ({ exDate: event.exDate, paymentDate: event.paymentDate, dividendType: event.dividendType }));
      const projection = projectDividends(history, announcedAhead, { today });
      const forecastRows = projection.projections.map((item) => ({
        asset_id: instrument.assetId,
        listing_id: listing?.id ?? null,
        account_id: null,
        isin: instrument.isin,
        provider_symbol: usedSymbol,
        status: "estimated",
        dividend_type: item.dividendType,
        declaration_date: null,
        ex_date: null,
        record_date: null,
        payment_date: null,
        estimated_month: item.estimatedMonth,
        amount_per_share: item.amountPerShare,
        currency: item.currency ?? listingCurrency,
        source_provider: "projection",
        source_event_id: `forecast:${item.estimatedMonth}:${item.dividendType}`,
        source_url: null,
        confidence: item.confidence,
        is_special: false,
        is_forecast: true,
        last_synced_at: now.toISOString(),
        updated_at: now.toISOString(),
      })).filter((row) => row.currency !== null);
      await replaceForecasts(instrument.assetId, forecastRows);
      forecasts = forecastRows.length;
    }

    touchedAssets.push(instrument.assetId);
    outcomes.push({
      assetId: instrument.assetId, name: instrument.name, isin: instrument.isin, provider: usedProvider, symbol: usedSymbol,
      status: "updated", eventsWritten: rows.length, forecasts,
      message: `${rows.length} événement(s) enregistré(s) depuis ${usedProvider}${forecasts > 0 ? `, ${forecasts} projection(s)` : ""}.`,
    });
    await saveState(instrument.assetId, usedProvider ?? "unknown", {
      status: "ok",
      message: null,
      events_written: rows.length,
      last_attempt_at: now.toISOString(),
      last_success_at: now.toISOString(),
    });

    // La politique de distribution se déduit d'un fait, pas d'un nom : un instrument qui a
    // réellement détaché des dividendes DISTRIBUE. On ne dégrade jamais une valeur posée par un
    // administrateur.
    if (asset && (asset.distribution_policy ?? "unknown") === "unknown" && rows.length > 0) {
      await supabaseRest(`assets?id=eq.${encodeURIComponent(instrument.assetId)}`, {
        method: "PATCH",
        headers: { prefer: "return=minimal" },
        body: JSON.stringify({ distribution_policy: "distributing", distribution_policy_source: "provider", updated_at: now.toISOString() }),
      }).catch(() => undefined);
    }
  }

  const report: SyncReport = {
    instrumentsChecked: queue.length,
    announcedUpdated: outcomes.reduce((sum, outcome) => sum + outcome.eventsWritten, 0),
    forecastsRebuilt: outcomes.reduce((sum, outcome) => sum + outcome.forecasts, 0),
    unresolved: outcomes.filter((outcome) => outcome.status === "unresolved").length
      + context.unresolvedPositions.filter((position) => !ISIN_SHAPE.test((position.isin ?? "").toUpperCase())).length,
    accumulating: outcomes.filter((outcome) => outcome.status === "accumulating").length,
    deferredByQuota: outcomes.filter((outcome) => outcome.status === "quota_deferred").length,
    providerUnavailable: outcomes.filter((outcome) => outcome.status === "provider_error").length,
  };

  return {
    report,
    outcomes,
    quota: providers.map((provider) => ({ provider: provider.name, used: usage.get(provider.name) ?? 0, limit: providerDailyLimit(provider.name) })),
    providers: providers.map((provider) => ({ name: provider.name, configured: provider.isConfigured() })),
    projectionsEnabled: projectionsEnabled(),
    ranAt: now.toISOString(),
  };
}

/**
 * Résolution des symboles Alpha Vantage manquants. Isolée de la synchronisation parce qu'elle
 * consomme le MÊME quota : la lancer à chaque fois épuiserait la limite avant d'avoir récupéré le
 * moindre dividende. Elle n'écrit un symbole que lorsqu'il est certain ; sinon elle marque
 * `needs_review` et laisse un humain trancher.
 */
export async function resolveAlphaVantageSymbols(
  accountIds: string[],
  options: { limit?: number; today?: string } = {},
): Promise<Array<{ name: string; isin: string | null; status: "resolved" | "needs_review" | "failed"; symbol: string | null; message: string }>> {
  const provider = new AlphaVantageDividendProvider();
  if (!provider.isConfigured()) return [];
  const context = await loadDividendContext(accountIds, options.today);
  if (!context) return [];
  const now = new Date();
  const dailyLimit = alphaVantageDailyLimit();
  let used = await countUsageToday("alpha_vantage", now);
  const budget = Math.max(0, Math.min(options.limit ?? 5, dailyLimit - used));
  const results: Array<{ name: string; isin: string | null; status: "resolved" | "needs_review" | "failed"; symbol: string | null; message: string }> = [];

  for (const instrument of context.instruments) {
    if (results.length >= budget) break;
    const listing = context.listingByAsset.get(instrument.assetId) ?? null;
    if (!listing || listing.alpha_vantage_symbol) continue;
    if (resolveDistributionPolicy(instrument) === "accumulating") continue;

    await recordProviderCall("alpha_vantage", `resolve:${instrument.isin ?? instrument.name}`, now);
    used += 1;
    const resolution = await provider.resolveSymbol({
      isin: instrument.isin,
      ticker: instrument.ticker,
      name: instrument.name,
      currency: listing.currency,
      micCode: listing.mic_code,
      exchange: listing.exchange,
      alphaVantageSymbol: null,
      eodhdSymbol: listing.eodhd_symbol,
      yahooSymbol: listing.yahoo_symbol,
    });
    if (resolution.ok) {
      await supabaseRest(`asset_listings?id=eq.${encodeURIComponent(listing.id)}`, {
        method: "PATCH",
        headers: { prefer: "return=minimal" },
        body: JSON.stringify({
          alpha_vantage_symbol: resolution.symbol,
          resolution_status: "resolved",
          last_resolved_at: now.toISOString(),
          resolution_note: resolution.region ? `Alpha Vantage — ${resolution.region}` : null,
          updated_at: now.toISOString(),
        }),
      }).catch(() => undefined);
      results.push({ name: instrument.name, isin: instrument.isin, status: "resolved", symbol: resolution.symbol, message: `Symbole Alpha Vantage : ${resolution.symbol}.` });
      continue;
    }
    const needsReview = resolution.code === "ambiguous";
    if (needsReview) {
      await supabaseRest(`asset_listings?id=eq.${encodeURIComponent(listing.id)}`, {
        method: "PATCH",
        headers: { prefer: "return=minimal" },
        body: JSON.stringify({
          resolution_status: "needs_review",
          last_resolved_at: now.toISOString(),
          resolution_note: `${resolution.message}${resolution.candidates ? ` Candidats : ${resolution.candidates.join(", ")}` : ""}`.slice(0, 300),
          updated_at: now.toISOString(),
        }),
      }).catch(() => undefined);
    }
    results.push({
      name: instrument.name, isin: instrument.isin,
      status: needsReview ? "needs_review" : "failed",
      symbol: null,
      message: resolution.message,
    });
    if (resolution.code === "rate_limited") break;
  }
  return results;
}

/** Relit les événements après écriture — utilisé par la route pour renvoyer un modèle à jour. */
export async function reloadEvents(context: DividendContext) {
  return loadDividendEvents(context.instruments.map((instrument) => instrument.assetId));
}
