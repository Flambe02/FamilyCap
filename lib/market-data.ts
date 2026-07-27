// Couche serveur indépendante des fournisseurs. Les composants et le moteur de portefeuille
// ne connaissent que ces structures normalisées, jamais le JSON d'un fournisseur.
import { resolveSymbols, yahooQuoteDetailed, YahooQuoteError } from "./market-quotes.ts";

export type MarketAssetType = "stock" | "etf" | "fund" | "bond" | "reit" | "gold" | "crypto" | "cash" | "other";
export type QuoteMode = "eod" | "delayed" | "realtime" | "manual";
export type QuoteFreshness = "fresh" | "stale" | "unavailable" | "manual";
export type ProviderFailureCode =
  | "rate_limited"
  | "not_found"
  | "http_error"
  | "timeout"
  | "parse_error"
  | "unavailable"
  | "invalid_quote"
  | "disabled";

export class MarketProviderError extends Error {
  readonly code: ProviderFailureCode;
  constructor(code: ProviderFailureCode, message: string) { super(message); this.name = "MarketProviderError"; this.code = code; }
}

export type MarketAsset = {
  id?: string;
  assetId?: string | null;
  listingId?: string | null;
  name: string;
  isin?: string | null;
  ticker?: string | null;
  /** Symbole explicitement validé pour EODHD. */
  providerSymbol?: string | null;
  /** Symbole explicitement validé pour Yahoo. */
  yahooSymbol?: string | null;
  exchange?: string | null;
  micCode?: string | null;
  currency?: string | null;
  assetType?: MarketAssetType | null;
  classificationStatus?: "verified" | "inferred" | "needs_review" | null;
  dataProvider?: string | null;
  quoteMode?: QuoteMode | null;
  country?: string | null;
};

export type MarketQuote = {
  provider: string;
  providerSymbol: string;
  price: number;
  currency: string;
  quotedAt: string;
  marketStatus: "open" | "closed" | "unknown";
  dataDelayMinutes: number | null;
  quoteMode: Exclude<QuoteMode, "manual">;
  rawMetadata: Record<string, unknown>;
};

export type DividendEvent = {
  provider: string; providerEventId: string | null; actionType: "dividend" | "split"; exDate: string;
  declarationDate: string | null; recordDate: string | null; paymentDate: string | null;
  amountPerShare: number | null; currency: string | null; splitFrom: number | null; splitTo: number | null; status: string;
};

export interface MarketDataProvider {
  getQuote(asset: MarketAsset): Promise<MarketQuote>;
  getDividends(asset: MarketAsset, from: string, to: string): Promise<DividendEvent[]>;
  searchAsset?(query: string): Promise<MarketAsset[]>;
}

const EODHD_BASE = "https://eodhd.com/api";
const TIMEOUT_MS = 9_000;

export function isEodhdConfigured() {
  return Boolean(process.env.EODHD_API_TOKEN?.trim());
}

function requiredToken() {
  const token = process.env.EODHD_API_TOKEN?.trim();
  if (!token) throw new MarketProviderError("disabled", "EODHD is not configured on the server.");
  return token;
}

async function fetchJson(path: string, params: Record<string, string>) {
  const query = new URLSearchParams({ ...params, api_token: requiredToken(), fmt: "json" });
  let response: Response;
  try {
    response = await fetch(`${EODHD_BASE}${path}?${query.toString()}`, { signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new MarketProviderError("timeout", "EODHD request timed out.");
    }
    throw new MarketProviderError("unavailable", "EODHD did not respond.");
  }
  if (response.status === 429) throw new MarketProviderError("rate_limited", "EODHD daily limit reached.");
  if (response.status === 404) throw new MarketProviderError("not_found", "EODHD symbol was not found.");
  if (!response.ok) throw new MarketProviderError("http_error", `EODHD HTTP ${response.status}.`);
  let payload: unknown;
  try {
    payload = await response.json() as unknown;
  } catch {
    throw new MarketProviderError("parse_error", "EODHD returned invalid JSON.");
  }
  const message = typeof payload === "object" && payload ? String((payload as Record<string, unknown>).message ?? (payload as Record<string, unknown>).error ?? "") : "";
  if (/limit|quota|too many/i.test(message)) throw new MarketProviderError("rate_limited", "EODHD daily limit reached.");
  return payload;
}

function isoDate(value: unknown): string | null {
  const raw = String(value ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}
function finite(value: unknown): number | null { const result = Number(value); return Number.isFinite(result) ? result : null; }
function validQuote(quote: MarketQuote) {
  if (!Number.isFinite(quote.price) || quote.price <= 0) throw new MarketProviderError("invalid_quote", "Provider returned an invalid price.");
  if (!/^[A-Z]{3}$/.test(quote.currency)) throw new MarketProviderError("invalid_quote", "Provider returned an invalid currency.");
  const date = new Date(quote.quotedAt);
  if (!Number.isFinite(date.getTime()) || date.getTime() > Date.now() + 48 * 3_600_000) throw new MarketProviderError("invalid_quote", "Provider returned an implausible market date.");
  return quote;
}

/** EODHD primaire : endpoint EOD, donc une dernière clôture, jamais présentée comme temps réel. */
export class EodhdProvider implements MarketDataProvider {
  async getQuote(asset: MarketAsset): Promise<MarketQuote> {
    const symbol = asset.providerSymbol?.trim();
    if (!symbol) throw new MarketProviderError("not_found", "No validated EODHD symbol.");
    const payload = await fetchJson(`/eod/${encodeURIComponent(symbol)}`, { order: "d", limit: "1" });
    const row = Array.isArray(payload) ? payload[0] as Record<string, unknown> | undefined : undefined;
    const price = finite(row?.close); const date = isoDate(row?.date);
    if (!price || !date) throw new MarketProviderError("invalid_quote", "EODHD returned no usable close.");
    return validQuote({ provider: "eodhd", providerSymbol: symbol, price, currency: String(asset.currency ?? "").toUpperCase() || "EUR", quotedAt: `${date}T00:00:00.000Z`, marketStatus: "closed", dataDelayMinutes: null, quoteMode: "eod", rawMetadata: { date, adjusted_close: finite(row?.adjusted_close) } });
  }
  async getDividends(asset: MarketAsset, from: string, to: string): Promise<DividendEvent[]> {
    const symbol = asset.providerSymbol?.trim(); if (!symbol) return [];
    const payload = await fetchJson(`/div/${encodeURIComponent(symbol)}`, { from, to }); if (!Array.isArray(payload)) return [];
    return payload.flatMap((entry): DividendEvent[] => {
      const row = entry as Record<string, unknown>; const exDate = isoDate(row.date); if (!exDate) return [];
      return [{ provider: "eodhd", providerEventId: String(row.date ?? "") || null, actionType: "dividend", exDate, declarationDate: isoDate(row.declarationDate), recordDate: isoDate(row.recordDate), paymentDate: isoDate(row.paymentDate), amountPerShare: finite(row.value ?? row.unadjustedValue), currency: String(row.currency ?? asset.currency ?? "").toUpperCase() || null, splitFrom: null, splitTo: null, status: "announced" }];
    });
  }
}

/**
 * Secours expérimental, isolé et exclusivement serveur. Yahoo n'est pas une API officielle ;
 * il peut être désactivé immédiatement par variable d'environnement.
 */
export class YahooFinanceProvider implements MarketDataProvider {
  private enabled() { return process.env.ENABLE_EXPERIMENTAL_YAHOO_PROVIDER === "true"; }
  async getQuote(asset: MarketAsset): Promise<MarketQuote> {
    if (!this.enabled()) throw new MarketProviderError("disabled", "Yahoo fallback is disabled.");
    const candidates = [asset.yahooSymbol, asset.providerSymbol].map((value) => value?.trim()).filter((value): value is string => Boolean(value));
    if (candidates.length === 0) candidates.push(...await resolveSymbols({ isin: asset.isin, ticker: asset.ticker, name: asset.name, currency: asset.currency }));
    for (const candidate of candidates.slice(0, 3)) {
      let quote;
      try {
        quote = await yahooQuoteDetailed(candidate);
      } catch (error) {
        if (error instanceof YahooQuoteError && error.code === "not_found") continue;
        if (error instanceof YahooQuoteError) {
          throw new MarketProviderError(error.code, error.message);
        }
        throw new MarketProviderError("unavailable", "Yahoo did not respond.");
      }
      if (asset.currency && quote.currency !== asset.currency.toUpperCase()) throw new MarketProviderError("invalid_quote", "Yahoo currency does not match the asset.");
      return validQuote({ provider: "yahoo", providerSymbol: quote.symbol, price: quote.price, currency: quote.currency, quotedAt: quote.asOf ?? new Date().toISOString(), marketStatus: "unknown", dataDelayMinutes: null, quoteMode: "delayed", rawMetadata: { exchange: quote.exchange, name: quote.name, source: "Yahoo Finance" } });
    }
    throw new MarketProviderError("not_found", "Yahoo did not resolve this asset.");
  }
  async getDividends(): Promise<DividendEvent[]> { return []; }
}

export function primaryMarketProvider(): MarketDataProvider | null {
  const provider = (process.env.MARKET_DATA_PRIMARY_PROVIDER ?? "eodhd").toLowerCase();
  if (provider === "eodhd") return isEodhdConfigured() ? new EodhdProvider() : null;
  if (provider === "yahoo") return new YahooFinanceProvider();
  return null;
}
export function fallbackMarketProvider(): MarketDataProvider | null {
  const provider = (process.env.MARKET_DATA_FALLBACK_PROVIDER ?? "manual").toLowerCase();
  return provider === "yahoo" ? new YahooFinanceProvider() : null;
}

/** Un contrat testable : un échec primaire ne change jamais l'identité métier de l'actif. */
export async function getQuoteFromProviders(asset: MarketAsset, primary: MarketDataProvider | null, fallback: MarketDataProvider | null, skipPrimary = false) {
  let primaryError: unknown = null;
  if (primary && !skipPrimary) {
    try { return { quote: await primary.getQuote(asset), source: "primary" as const, primaryError: null }; }
    catch (error) { primaryError = error; }
  }
  if (fallback) {
    try { return { quote: await fallback.getQuote(asset), source: "fallback" as const, primaryError }; }
    catch (fallbackError) { return { quote: null, source: null, primaryError, fallbackError }; }
  }
  return { quote: null, source: null, primaryError, fallbackError: null };
}

export function isRateLimitError(error: unknown) { return error instanceof MarketProviderError && error.code === "rate_limited"; }
export function quoteFreshness(input: { fetchedAt?: string | null; quoteMode?: QuoteMode | null; provider?: string | null }): QuoteFreshness {
  if (input.quoteMode === "manual" || input.provider === "manual") return "manual";
  if (!input.fetchedAt) return "unavailable";
  const fetched = new Date(input.fetchedAt).getTime(); if (!Number.isFinite(fetched)) return "unavailable";
  return new Date(fetched).toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10) ? "fresh" : "stale";
}
