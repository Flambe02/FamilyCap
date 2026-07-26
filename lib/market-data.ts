// Couche serveur indépendante des fournisseurs. Les composants et le moteur de portefeuille
// ne connaissent que ces structures normalisées, jamais le JSON EODHD/Yahoo.

export type MarketAssetType = "stock" | "etf" | "fund" | "bond" | "reit" | "gold" | "crypto" | "cash" | "other";
export type QuoteMode = "eod" | "delayed" | "realtime" | "manual";
export type QuoteFreshness = "fresh" | "stale" | "unavailable" | "manual";

export type MarketAsset = {
  id?: string;
  name: string;
  isin?: string | null;
  ticker?: string | null;
  providerSymbol?: string | null;
  exchange?: string | null;
  micCode?: string | null;
  currency?: string | null;
  assetType?: MarketAssetType | null;
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
  provider: string;
  providerEventId: string | null;
  actionType: "dividend" | "split";
  exDate: string;
  declarationDate: string | null;
  recordDate: string | null;
  paymentDate: string | null;
  amountPerShare: number | null;
  currency: string | null;
  splitFrom: number | null;
  splitTo: number | null;
  status: string;
};

export interface MarketDataProvider {
  getQuote(asset: MarketAsset): Promise<MarketQuote>;
  getDividends(asset: MarketAsset, from: string, to: string): Promise<DividendEvent[]>;
  searchAsset?(query: string): Promise<MarketAsset[]>;
}

const EODHD_BASE = "https://eodhd.com/api";
const TIMEOUT_MS = 9_000;

function requiredToken() {
  const token = process.env.EODHD_API_TOKEN?.trim();
  if (!token) throw new Error("EODHD_API_TOKEN n'est pas configuré côté serveur.");
  return token;
}

async function fetchJson(path: string, params: Record<string, string>) {
  const query = new URLSearchParams({ ...params, api_token: requiredToken(), fmt: "json" });
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const response = await fetch(`${EODHD_BASE}${path}?${query.toString()}`, { signal, cache: "no-store" });
  if (!response.ok) throw new Error(`EODHD indisponible (${response.status}).`);
  return response.json() as Promise<unknown>;
}

function isoDate(value: unknown): string | null {
  const raw = String(value ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}
function finite(value: unknown): number | null {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

/** EODHD primaire : endpoint EOD, donc une dernière clôture, jamais présentée comme temps réel. */
export class EodhdProvider implements MarketDataProvider {
  async getQuote(asset: MarketAsset): Promise<MarketQuote> {
    const symbol = asset.providerSymbol?.trim();
    if (!symbol) throw new Error("Actif à classifier : symbole EODHD manquant.");
    const payload = await fetchJson(`/eod/${encodeURIComponent(symbol)}`, { order: "d", limit: "1" });
    const row = Array.isArray(payload) ? payload[0] as Record<string, unknown> | undefined : undefined;
    const price = finite(row?.close);
    const date = isoDate(row?.date);
    if (!price || !date) throw new Error("EODHD n'a pas retourné de dernière clôture exploitable.");
    return {
      provider: "eodhd",
      providerSymbol: symbol,
      price,
      currency: String(asset.currency ?? "").toUpperCase() || "EUR",
      quotedAt: `${date}T00:00:00.000Z`,
      marketStatus: "closed",
      dataDelayMinutes: null,
      quoteMode: "eod",
      rawMetadata: { date, adjusted_close: finite(row?.adjusted_close) },
    };
  }

  async getDividends(asset: MarketAsset, from: string, to: string): Promise<DividendEvent[]> {
    const symbol = asset.providerSymbol?.trim();
    if (!symbol) return [];
    const payload = await fetchJson(`/div/${encodeURIComponent(symbol)}`, { from, to });
    if (!Array.isArray(payload)) return [];
    return payload.flatMap((entry): DividendEvent[] => {
      const row = entry as Record<string, unknown>;
      const exDate = isoDate(row.date);
      if (!exDate) return [];
      const value = finite(row.value ?? row.unadjustedValue);
      return [{
        provider: "eodhd", providerEventId: String(row.date ?? "") || null, actionType: "dividend", exDate,
        declarationDate: isoDate(row.declarationDate), recordDate: isoDate(row.recordDate), paymentDate: isoDate(row.paymentDate),
        amountPerShare: value, currency: String(row.currency ?? asset.currency ?? "").toUpperCase() || null,
        splitFrom: null, splitTo: null, status: "announced",
      }];
    });
  }
}

// Yahoo est volontairement désactivé par défaut : service non officiel, sans garantie. Cette
// coquille normalisée prépare un secours expérimental sans propager son format à l'UI.
export class YahooFinanceProvider implements MarketDataProvider {
  private enabled() { return process.env.ENABLE_EXPERIMENTAL_YAHOO_PROVIDER === "true"; }
  async getQuote(asset: MarketAsset): Promise<MarketQuote> {
    void asset;
    if (!this.enabled()) throw new Error("Le fournisseur Yahoo expérimental est désactivé.");
    throw new Error("Yahoo expérimental non configuré.");
  }
  async getDividends(asset: MarketAsset, from: string, to: string): Promise<DividendEvent[]> {
    void asset; void from; void to;
    if (!this.enabled()) return [];
    return [];
  }
}

export function primaryMarketProvider(): MarketDataProvider | null {
  const provider = (process.env.MARKET_DATA_PRIMARY_PROVIDER ?? "eodhd").toLowerCase();
  if (provider === "eodhd") return new EodhdProvider();
  if (provider === "yahoo" && process.env.ENABLE_EXPERIMENTAL_YAHOO_PROVIDER === "true") return new YahooFinanceProvider();
  return null;
}

export function quoteFreshness(input: { fetchedAt?: string | null; quoteMode?: QuoteMode | null; provider?: string | null }): QuoteFreshness {
  if (input.quoteMode === "manual" || input.provider === "manual") return "manual";
  if (!input.fetchedAt) return "unavailable";
  const fetched = new Date(input.fetchedAt).getTime();
  if (!Number.isFinite(fetched)) return "unavailable";
  return new Date(fetched).toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10) ? "fresh" : "stale";
}
