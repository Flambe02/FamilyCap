// COUCHE FOURNISSEUR DE DIVIDENDES — adaptateurs normalisés, SERVEUR UNIQUEMENT.
//
// Aucune clé n'est jamais exposée au navigateur : ce module lit `process.env` et n'est importé que
// par des routes serveur. Il ne connaît ni Supabase, ni React, ni le moteur de calcul — il rend un
// format unique (`NormalizedDividend`) et un code d'échec explicite. C'est ce qui permet de changer
// de fournisseur sans toucher au moteur, et de tester le moteur sans réseau.
//
// HIÉRARCHIE
//   1. Alpha Vantage (`DIVIDENDS`) — gratuit, ~25 appels/jour, publie les DATES DE PAIEMENT et de
//      détachement, y compris pour une échéance déjà annoncée. C'est ce qui manquait le plus.
//   2. EODHD (`/div`) — historique et secours. Publie la devise et la période, ce qu'Alpha Vantage
//      ne fait pas.
//   3. Yahoo — secours technique, activé UNIQUEMENT si le projet l'a déjà autorisé
//      (`ENABLE_EXPERIMENTAL_YAHOO_PROVIDER`). Il ne publie ni date de paiement ni annonce future :
//      il alimente donc l'historique, jamais une échéance « annoncée ».
//
// RÈGLE ABSOLUE : un échec fournisseur renvoie un code, jamais une liste vide déguisée en
// « aucun dividende ». Confondre les deux fait disparaître des revenus réels sans le dire.

import type { DividendType } from "./dividend-engine.ts";
import { fetchDividendHistory } from "./market-history.ts";

export type DividendProviderName = "alpha_vantage" | "eodhd" | "dividland" | "yahoo";

export type DividendFailureCode =
  | "not_configured"
  | "no_symbol"
  | "rate_limited"
  | "not_found"
  | "http_error"
  | "timeout"
  | "parse_error"
  | "unavailable"
  | "disabled";

export type NormalizedDividend = {
  providerEventId: string | null;
  declarationDate: string | null;
  exDate: string | null;
  recordDate: string | null;
  paymentDate: string | null;
  amountPerShare: number;
  /** `null` quand le fournisseur ne la publie pas — Alpha Vantage notamment. */
  currency: string | null;
  dividendType: DividendType;
  isSpecial: boolean;
  sourceUrl: string | null;
};

export type DividendFetchResult =
  | { ok: true; provider: DividendProviderName; symbol: string; dividends: NormalizedDividend[] }
  | { ok: false; provider: DividendProviderName; symbol: string | null; code: DividendFailureCode; message: string };

/** Identité minimale nécessaire pour interroger un fournisseur. Aucune supposition n'est faite. */
export type ProviderInstrument = {
  isin: string | null;
  ticker: string | null;
  name: string | null;
  currency: string | null;
  micCode: string | null;
  exchange: string | null;
  alphaVantageSymbol: string | null;
  eodhdSymbol: string | null;
  yahooSymbol: string | null;
  /** Fiche DividLand validée manuellement, au format `123-NOM-DE-LA-SOCIETE`. */
  dividlandSlug?: string | null;
  assetType?: string | null;
};

export interface DividendProvider {
  readonly name: DividendProviderName;
  /** Le fournisseur est-il utilisable (clé présente, drapeau activé) ? */
  isConfigured(): boolean;
  /** Symbole utilisable pour CE fournisseur, ou `null` — jamais deviné à partir du nom. */
  symbolFor(instrument: ProviderInstrument): string | null;
  fetchDividends(symbol: string, range: { from: string; to: string }): Promise<DividendFetchResult>;
}

const TIMEOUT_MS = 10_000;
const USER_AGENT = "LaBaJoCo/1.0 (+dividendes)";

function isoDate(value: unknown): string | null {
  const raw = String(value ?? "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  // « 0000-00-00 » est renvoyé par certains fournisseurs pour « inconnu » : ce n'est pas une date.
  return raw.startsWith("0000") ? null : raw;
}

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function currencyOf(value: unknown): string | null {
  const code = String(value ?? "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "application/json,*/*" },
      cache: "no-store",
      signal: controller.signal,
    });
    if (response.status === 429) throw new ProviderHttpError("rate_limited", "Limite d’appels du fournisseur atteinte.");
    if (response.status === 404) throw new ProviderHttpError("not_found", "Symbole inconnu du fournisseur.");
    if (!response.ok) throw new ProviderHttpError("http_error", `Réponse HTTP ${response.status}.`);
    const text = await response.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ProviderHttpError("parse_error", "Réponse illisible (JSON invalide).");
    }
  } catch (error) {
    if (error instanceof ProviderHttpError) throw error;
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
      throw new ProviderHttpError("timeout", "Le fournisseur n’a pas répondu à temps.");
    }
    throw new ProviderHttpError("unavailable", "Le fournisseur est injoignable.");
  } finally {
    clearTimeout(timer);
  }
}

async function fetchHtml(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" },
      cache: "no-store",
      signal: controller.signal,
    });
    if (response.status === 429) throw new ProviderHttpError("rate_limited", "Limite d’appels DividLand atteinte.");
    if (response.status === 404) throw new ProviderHttpError("not_found", "Fiche DividLand introuvable.");
    if (!response.ok) throw new ProviderHttpError("http_error", `Réponse HTTP ${response.status}.`);
    return await response.text();
  } catch (error) {
    if (error instanceof ProviderHttpError) throw error;
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) throw new ProviderHttpError("timeout", "DividLand n’a pas répondu à temps.");
    throw new ProviderHttpError("unavailable", "DividLand est injoignable.");
  } finally {
    clearTimeout(timer);
  }
}

class ProviderHttpError extends Error {
  readonly code: DividendFailureCode;
  constructor(code: DividendFailureCode, message: string) {
    super(message);
    this.name = "ProviderHttpError";
    this.code = code;
  }
}

function failure(provider: DividendProviderName, symbol: string | null, error: unknown): DividendFetchResult {
  if (error instanceof ProviderHttpError) return { ok: false, provider, symbol, code: error.code, message: error.message };
  return { ok: false, provider, symbol, code: "unavailable", message: "Le fournisseur est injoignable." };
}

// ==========================================================================================
// ALPHA VANTAGE
// ==========================================================================================
const ALPHA_VANTAGE_BASE = "https://www.alphavantage.co/query";

/**
 * Endpoint officiel `DIVIDENDS`. Réponse observée (clé de démonstration, IBM, 2026-07-28) :
 *   { "symbol": "IBM", "data": [{ "ex_dividend_date", "declaration_date", "record_date",
 *                                 "payment_date", "amount" }] }
 *
 * DEUX LIMITES À CONNAÎTRE, et qui décident de l'architecture :
 *   * la réponse NE CONTIENT PAS LA DEVISE. Elle est donc reprise de la COTATION enregistrée, et
 *     jamais supposée : sans devise connue, l'événement reste « Donnée indisponible » ;
 *   * les dividendes exceptionnels ne sont pas étiquetés. Leur détection est faite plus loin, par
 *     une règle déterministe et documentée (`flagSpecialDividends`), jamais par le fournisseur.
 */
export class AlphaVantageDividendProvider implements DividendProvider {
  readonly name = "alpha_vantage" as const;

  isConfigured(): boolean {
    return Boolean(process.env.ALPHA_VANTAGE_API_KEY?.trim());
  }

  /**
   * Alpha Vantage exige son propre suffixe de place, différent de celui d'EODHD ou de Yahoo
   * (`.LON`, `.DEX`, `.FRK`, `.AMS`…). On n'en devine AUCUN : soit le symbole a été résolu et
   * enregistré (`asset_listings.alpha_vantage_symbol`), soit — et seulement pour une cotation
   * américaine sans suffixe — le ticker nu est valide. Tout le reste doit passer par la
   * résolution explicite, sous peine d'interroger un homonyme d'une autre place.
   */
  symbolFor(instrument: ProviderInstrument): string | null {
    const explicit = instrument.alphaVantageSymbol?.trim();
    if (explicit) return explicit;
    const ticker = instrument.ticker?.trim().toUpperCase();
    if (!ticker || ticker.includes(".")) return null;
    const isUsListing = instrument.currency?.toUpperCase() === "USD"
      && (instrument.micCode === null || /^(XNYS|XNAS|XNGS|ARCX|BATS)$/.test(instrument.micCode.toUpperCase()));
    return isUsListing ? ticker : null;
  }

  async fetchDividends(symbol: string): Promise<DividendFetchResult> {
    const key = process.env.ALPHA_VANTAGE_API_KEY?.trim();
    if (!key) return { ok: false, provider: this.name, symbol, code: "not_configured", message: "ALPHA_VANTAGE_API_KEY n’est pas configurée." };
    const url = `${ALPHA_VANTAGE_BASE}?function=DIVIDENDS&symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(key)}`;
    let payload: unknown;
    try {
      payload = await fetchJson(url);
    } catch (error) {
      return failure(this.name, symbol, error);
    }
    const record = (payload ?? {}) as Record<string, unknown>;
    // Alpha Vantage répond 200 même quand il refuse : le quota et les erreurs arrivent dans
    // « Note », « Information » ou « Error Message ». Les lire est indispensable, sinon un quota
    // épuisé se lit « aucun dividende ».
    const message = String(record.Note ?? record.Information ?? record["Error Message"] ?? "").trim();
    if (message) {
      const limited = /rate limit|call frequency|premium|thank you for using|higher api call/i.test(message);
      return {
        ok: false, provider: this.name, symbol,
        code: limited ? "rate_limited" : "not_found",
        message: limited ? "Quota quotidien Alpha Vantage atteint." : message.slice(0, 200),
      };
    }
    const rows = Array.isArray(record.data) ? record.data : null;
    if (!rows) return { ok: false, provider: this.name, symbol, code: "parse_error", message: "Réponse Alpha Vantage inattendue." };

    const dividends: NormalizedDividend[] = [];
    for (const entry of rows) {
      const row = entry as Record<string, unknown>;
      const amount = finite(row.amount);
      if (amount === null || amount <= 0) continue;
      const exDate = isoDate(row.ex_dividend_date);
      const paymentDate = isoDate(row.payment_date);
      if (!exDate && !paymentDate) continue;
      dividends.push({
        providerEventId: exDate ?? paymentDate,
        declarationDate: isoDate(row.declaration_date),
        exDate,
        recordDate: isoDate(row.record_date),
        paymentDate,
        amountPerShare: amount,
        currency: null, // non publiée par l'endpoint : reprise de la cotation, jamais devinée ici
        dividendType: "ordinary",
        isSpecial: false,
        sourceUrl: `https://www.alphavantage.co/documentation/#dividends`,
      });
    }
    return { ok: true, provider: this.name, symbol, dividends };
  }

  /**
   * Résolution de symbole par `SYMBOL_SEARCH`. Consomme un appel du quota, d'où son isolement :
   * elle n'est déclenchée que lorsqu'aucun symbole n'est enregistré.
   *
   * AMBIGUÏTÉ : si plusieurs cotations correspondent également bien (même devise attendue, scores
   * proches), AUCUNE n'est retenue. Choisir en silence, c'est rattacher les dividendes d'un ADR
   * américain à une action parisienne — l'erreur exacte que le catalogue a été créé pour empêcher.
   */
  async resolveSymbol(instrument: ProviderInstrument): Promise<
    | { ok: true; symbol: string; currency: string | null; region: string | null }
    | { ok: false; code: DividendFailureCode | "ambiguous"; message: string; candidates?: string[] }
  > {
    const key = process.env.ALPHA_VANTAGE_API_KEY?.trim();
    if (!key) return { ok: false, code: "not_configured", message: "ALPHA_VANTAGE_API_KEY n’est pas configurée." };
    const query = instrument.isin?.trim() || instrument.ticker?.trim() || instrument.name?.trim();
    if (!query) return { ok: false, code: "no_symbol", message: "Aucun identifiant à rechercher." };
    let payload: unknown;
    try {
      payload = await fetchJson(`${ALPHA_VANTAGE_BASE}?function=SYMBOL_SEARCH&keywords=${encodeURIComponent(query)}&apikey=${encodeURIComponent(key)}`);
    } catch (error) {
      const result = failure(this.name, null, error);
      return { ok: false, code: result.ok ? "unavailable" : result.code, message: result.ok ? "" : result.message };
    }
    const record = (payload ?? {}) as Record<string, unknown>;
    const message = String(record.Note ?? record.Information ?? record["Error Message"] ?? "").trim();
    if (message) {
      const limited = /rate limit|call frequency|premium|thank you for using/i.test(message);
      return { ok: false, code: limited ? "rate_limited" : "not_found", message: limited ? "Quota quotidien Alpha Vantage atteint." : message.slice(0, 200) };
    }
    const matches = Array.isArray(record.bestMatches) ? record.bestMatches : [];
    const expected = instrument.currency?.toUpperCase() ?? null;
    const parsed = matches.map((entry) => {
      const row = entry as Record<string, unknown>;
      return {
        symbol: String(row["1. symbol"] ?? "").trim(),
        name: String(row["2. name"] ?? "").trim(),
        region: String(row["4. region"] ?? "").trim() || null,
        currency: currencyOf(row["8. currency"]),
        score: finite(row["9. matchScore"]) ?? 0,
      };
    }).filter((entry) => entry.symbol);
    if (parsed.length === 0) return { ok: false, code: "not_found", message: "Aucune cotation Alpha Vantage pour cet instrument." };

    // La devise attendue est le filtre le plus discriminant : une action parisienne cote en euros,
    // son ADR américain en dollars. Sans devise connue, on ne tranche pas.
    const sameCurrency = expected ? parsed.filter((entry) => entry.currency === expected) : [];
    const pool = sameCurrency.length > 0 ? sameCurrency : expected ? [] : parsed;
    if (pool.length === 0) {
      return { ok: false, code: "ambiguous", message: `Aucune cotation en ${expected} parmi les réponses.`, candidates: parsed.map((entry) => entry.symbol) };
    }
    const sorted = [...pool].sort((a, b) => b.score - a.score);
    if (sorted.length > 1 && Math.abs(sorted[0].score - sorted[1].score) < 0.05) {
      return { ok: false, code: "ambiguous", message: "Plusieurs cotations correspondent aussi bien : vérification nécessaire.", candidates: sorted.slice(0, 4).map((entry) => entry.symbol) };
    }
    return { ok: true, symbol: sorted[0].symbol, currency: sorted[0].currency, region: sorted[0].region };
  }
}

// ==========================================================================================
// EODHD
// ==========================================================================================
const EODHD_BASE = "https://eodhd.com/api";

/** EODHD publie la devise ET la période (« Interim », « Final »…) : elles sont reprises telles quelles. */
export class EodhdDividendProvider implements DividendProvider {
  readonly name = "eodhd" as const;

  isConfigured(): boolean {
    return Boolean(process.env.EODHD_API_TOKEN?.trim());
  }

  symbolFor(instrument: ProviderInstrument): string | null {
    return instrument.eodhdSymbol?.trim() || null;
  }

  async fetchDividends(symbol: string, range: { from: string; to: string }): Promise<DividendFetchResult> {
    const token = process.env.EODHD_API_TOKEN?.trim();
    if (!token) return { ok: false, provider: this.name, symbol, code: "not_configured", message: "EODHD_API_TOKEN n’est pas configuré." };
    const query = new URLSearchParams({ from: range.from, to: range.to, api_token: token, fmt: "json" });
    let payload: unknown;
    try {
      payload = await fetchJson(`${EODHD_BASE}/div/${encodeURIComponent(symbol)}?${query.toString()}`);
    } catch (error) {
      return failure(this.name, symbol, error);
    }
    if (!Array.isArray(payload)) {
      const record = (payload ?? {}) as Record<string, unknown>;
      const message = String(record.message ?? record.error ?? "").trim();
      if (/limit|quota|too many/i.test(message)) return { ok: false, provider: this.name, symbol, code: "rate_limited", message: "Quota quotidien EODHD atteint." };
      return { ok: false, provider: this.name, symbol, code: "parse_error", message: "Réponse EODHD inattendue." };
    }
    const dividends: NormalizedDividend[] = [];
    for (const entry of payload) {
      const row = entry as Record<string, unknown>;
      const amount = finite(row.value ?? row.unadjustedValue);
      if (amount === null || amount <= 0) continue;
      const exDate = isoDate(row.date);
      const paymentDate = isoDate(row.paymentDate);
      if (!exDate && !paymentDate) continue;
      dividends.push({
        providerEventId: exDate ?? paymentDate,
        declarationDate: isoDate(row.declarationDate),
        exDate,
        recordDate: isoDate(row.recordDate),
        paymentDate,
        amountPerShare: amount,
        currency: currencyOf(row.currency),
        dividendType: periodToType(row.period),
        isSpecial: /special|exceptionnel/i.test(String(row.period ?? "")),
        sourceUrl: null,
      });
    }
    return { ok: true, provider: this.name, symbol, dividends };
  }
}

function periodToType(period: unknown): DividendType {
  const raw = String(period ?? "").trim().toLowerCase();
  if (!raw) return "ordinary";
  if (raw.includes("interim") || raw.includes("acompte")) return "interim";
  if (raw.includes("final") || raw.includes("solde")) return "final";
  if (raw.includes("special") || raw.includes("exceptionnel")) return "special";
  return "ordinary";
}

// ==========================================================================================
// DIVIDLAND — secours personnel français, serveur uniquement
// ==========================================================================================
const DIVIDLAND_BASE = "https://www.dividland.fr/company/";

function htmlText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&euro;/gi, "€").replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ").trim();
}

const FRENCH_MONTHS: Record<string, string> = {
  janvier: "01", février: "02", fevrier: "02", mars: "03", avril: "04", mai: "05", juin: "06",
  juillet: "07", août: "08", aout: "08", septembre: "09", octobre: "10", novembre: "11", décembre: "12", decembre: "12",
};

function frenchDate(value: string): string | null {
  const match = value.trim().match(/(\d{1,2})\s+(janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre)\s+(\d{4})/i);
  if (!match) return null;
  const month = FRENCH_MONTHS[match[2].toLowerCase()];
  return month ? `${match[3]}-${month}-${match[1].padStart(2, "0")}` : null;
}

/**
 * Extrait uniquement des versements datés. Une simple mention de montant reste une annonce
 * éditoriale tant que la fiche ne publie pas de détachement/paiement : elle n'est jamais
 * transformée en date inventée ni en encaissement.
 */
export function parseDividlandDividendPage(html: string, sourceUrl: string): NormalizedDividend[] {
  const text = htmlText(html);
  const eventPattern = /(\d{1,2}\s+[A-Za-zÀ-ÿ]+\s+\d{4})\s+Détachement\s+([^€]{1,48}?)\s+DIVIDENDE\s*:\s*([\d.,]+)\s*€\s*\/\s*action[\s\S]{0,180}?PAIEMENT\s*:\s*(\d{1,2}\s+[A-Za-zÀ-ÿ]+\s+\d{4})/gi;
  const dividends: NormalizedDividend[] = [];
  for (const match of text.matchAll(eventPattern)) {
    const exDate = frenchDate(match[1]);
    const paymentDate = frenchDate(match[4]);
    const amount = Number(match[3].replace(/\s/g, "").replace(",", "."));
    if (!exDate || !paymentDate || !Number.isFinite(amount) || amount <= 0) continue;
    const label = match[2].toLowerCase();
    const dividendType: DividendType = label.includes("acompte") ? "interim" : label.includes("solde") ? "final" : "ordinary";
    dividends.push({
      providerEventId: `dividland:${exDate}:${paymentDate}:${amount.toFixed(8)}`,
      declarationDate: null,
      exDate,
      recordDate: null,
      paymentDate,
      amountPerShare: amount,
      currency: "EUR",
      dividendType,
      isSpecial: /exceptionnel|special/i.test(label),
      sourceUrl,
    });
  }
  return dividends;
}

export class DividlandDividendProvider implements DividendProvider {
  readonly name = "dividland" as const;

  isConfigured(): boolean { return process.env.DIVIDENDS_DIVIDLAND_ENABLED === "true"; }

  symbolFor(instrument: ProviderInstrument): string | null {
    // Aucune recherche par nom : seule une fiche approuvée pour l'ISIN français exact est utilisable.
    if (!instrument.isin?.toUpperCase().startsWith("FR") || /^(etf|fund)$/i.test(instrument.assetType ?? "")) return null;
    const slug = instrument.dividlandSlug?.trim();
    return slug && /^\d+-[A-Za-z0-9%_-]+$/i.test(slug) ? slug : null;
  }

  async fetchDividends(symbol: string): Promise<DividendFetchResult> {
    if (!this.isConfigured()) return { ok: false, provider: this.name, symbol, code: "disabled", message: "DividLand est désactivé (DIVIDENDS_DIVIDLAND_ENABLED)." };
    const sourceUrl = `${DIVIDLAND_BASE}${encodeURIComponent(symbol)}/`;
    try {
      const dividends = parseDividlandDividendPage(await fetchHtml(sourceUrl), sourceUrl);
      return { ok: true, provider: this.name, symbol, dividends };
    } catch (error) {
      return failure(this.name, symbol, error);
    }
  }
}

// ==========================================================================================
// YAHOO — secours technique, uniquement si le projet l'a déjà autorisé
// ==========================================================================================
/**
 * Yahoo ne publie que des détachements PASSÉS, sans date de paiement. Il alimente donc
 * l'historique — la base légitime d'une projection — et ne produit JAMAIS une échéance
 * « annoncée » : une annonce sans date de paiement n'en est pas une.
 */
export class YahooDividendProvider implements DividendProvider {
  readonly name = "yahoo" as const;

  isConfigured(): boolean {
    return process.env.ENABLE_EXPERIMENTAL_YAHOO_PROVIDER === "true";
  }

  symbolFor(instrument: ProviderInstrument): string | null {
    return instrument.yahooSymbol?.trim() || null;
  }

  async fetchDividends(symbol: string, range: { from: string; to: string }): Promise<DividendFetchResult> {
    if (!this.isConfigured()) {
      return { ok: false, provider: this.name, symbol, code: "disabled", message: "Le secours Yahoo est désactivé (ENABLE_EXPERIMENTAL_YAHOO_PROVIDER)." };
    }
    const years = Math.max(1, Math.min(10, Math.ceil((Date.parse(range.to) - Date.parse(range.from)) / (365 * 86_400_000))));
    const history = await fetchDividendHistory(symbol, years);
    if (history === null) {
      return { ok: false, provider: this.name, symbol, code: "unavailable", message: "Yahoo n’a pas répondu. Aucune donnée n’a été effacée." };
    }
    return {
      ok: true,
      provider: this.name,
      symbol,
      dividends: history.map((point) => ({
        providerEventId: point.exDate,
        declarationDate: null,
        exDate: point.exDate,
        recordDate: null,
        paymentDate: null, // Yahoo ne la publie pas : elle reste inconnue, jamais copiée du détachement
        amountPerShare: point.amountPerShare,
        currency: currencyOf(point.currency),
        dividendType: "ordinary",
        isSpecial: false,
        sourceUrl: null,
      })),
    };
  }
}

// ==========================================================================================
// Sélection des fournisseurs
// ==========================================================================================
export const DEFAULT_ALPHA_VANTAGE_DAILY_LIMIT = 25;
export const DEFAULT_CACHE_TTL_HOURS = 24;

export function alphaVantageDailyLimit(): number {
  const raw = Number(process.env.ALPHA_VANTAGE_DAILY_LIMIT);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_ALPHA_VANTAGE_DAILY_LIMIT;
}

export function dividendCacheTtlHours(): number {
  const raw = Number(process.env.DIVIDEND_CACHE_TTL_HOURS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CACHE_TTL_HOURS;
}

export function projectionsEnabled(): boolean {
  // Activées par défaut : sans elles, l'écran ne montrerait que les rares échéances déjà annoncées.
  return process.env.ENABLE_DIVIDEND_PROJECTIONS !== "false";
}

function providerByName(name: string): DividendProvider | null {
  switch (name.trim().toLowerCase()) {
    case "alpha_vantage": return new AlphaVantageDividendProvider();
    case "eodhd": return new EodhdDividendProvider();
    case "dividland": return new DividlandDividendProvider();
    case "yahoo": return new YahooDividendProvider();
    default: return null;
  }
}

/**
 * Chaîne de fournisseurs réellement utilisable, dans l'ordre. Un fournisseur non configuré est
 * ÉCARTÉ ici plutôt que d'échouer plus tard : la file de synchronisation n'a alors jamais à
 * distinguer « non configuré » de « en panne ».
 */
export function dividendProviderChain(): DividendProvider[] {
  const names = [
    process.env.DIVIDEND_PRIMARY_PROVIDER ?? "alpha_vantage",
    process.env.DIVIDEND_SECONDARY_PROVIDER ?? "eodhd",
    process.env.DIVIDEND_FALLBACK_PROVIDER ?? "yahoo",
    process.env.DIVIDEND_FRANCE_FALLBACK_PROVIDER ?? "dividland",
  ];
  const chain: DividendProvider[] = [];
  for (const name of names) {
    const provider = providerByName(name);
    if (!provider || chain.some((existing) => existing.name === provider.name)) continue;
    if (!provider.isConfigured()) continue;
    chain.push(provider);
  }
  return chain;
}

/** Diagnostic affichable : quel fournisseur est prêt, lequel ne l'est pas et pourquoi. */
export function providerAvailability(): Array<{ name: DividendProviderName; role: "primary" | "secondary" | "fallback" | "france_fallback"; configured: boolean }> {
  const roles: Array<{ role: "primary" | "secondary" | "fallback" | "france_fallback"; name: string }> = [
    { role: "primary", name: process.env.DIVIDEND_PRIMARY_PROVIDER ?? "alpha_vantage" },
    { role: "secondary", name: process.env.DIVIDEND_SECONDARY_PROVIDER ?? "eodhd" },
    { role: "fallback", name: process.env.DIVIDEND_FALLBACK_PROVIDER ?? "yahoo" },
    { role: "france_fallback", name: process.env.DIVIDEND_FRANCE_FALLBACK_PROVIDER ?? "dividland" },
  ];
  const result: Array<{ name: DividendProviderName; role: "primary" | "secondary" | "fallback" | "france_fallback"; configured: boolean }> = [];
  for (const entry of roles) {
    const provider = providerByName(entry.name);
    if (!provider) continue;
    result.push({ name: provider.name, role: entry.role, configured: provider.isConfigured() });
  }
  return result;
}

/** Priorité réellement adaptée à la cotation : jamais une chaîne globale aveugle. */
export function orderDividendProviders(providers: DividendProvider[], instrument: ProviderInstrument): DividendProvider[] {
  const frenchOrEuronext = instrument.isin?.toUpperCase().startsWith("FR") || instrument.micCode?.toUpperCase() === "XPAR" || /euronext/i.test(instrument.exchange ?? "") || /^(etf|fund)$/i.test(instrument.assetType ?? "");
  const usStock = instrument.isin?.toUpperCase().startsWith("US") && !/^(etf|fund)$/i.test(instrument.assetType ?? "");
  const preference = frenchOrEuronext
    ? ["eodhd", "dividland", "alpha_vantage", "yahoo"]
    : usStock
      ? ["alpha_vantage", "eodhd", "yahoo", "dividland"]
      : ["eodhd", "alpha_vantage", "yahoo", "dividland"];
  return [...providers].sort((left, right) => preference.indexOf(left.name) - preference.indexOf(right.name));
}
