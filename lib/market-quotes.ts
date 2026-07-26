// Cours de bourse — fournisseurs GRATUITS et sans clé d'API.
//
// Pourquoi ce module existe : jusqu'ici, `holdings.last_price` ne pouvait être alimenté que
// manuellement ou par le cours figurant dans le fichier importé. Un relevé mal lu (ou périmé)
// se propageait donc directement dans la valeur du portefeuille. Le cours doit venir d'une
// source de marché indépendante du fichier.
//
// Chaîne de fournisseurs (dans l'ordre, arrêt au premier succès) :
//   1) Yahoo Finance — recherche par ISIN → symbole, puis cours + DEVISE + horodatage.
//      Endpoints publics, sans clé : /v1/finance/search et /v8/finance/chart.
//   2) Stooq — CSV public sans clé (cours de clôture). Pas de devise dans la réponse :
//      elle est déduite de la place de cotation (table explicite ci-dessous), jamais devinée.
//
// RÈGLES STRICTES (cohérentes avec « aucune donnée inventée ») :
//   * Aucun cours n'est retourné si le fournisseur ne répond pas : on renvoie une erreur
//     explicite, jamais une valeur par défaut ni le dernier cours connu maquillé en frais.
//   * La DEVISE du cours doit correspondre à celle de la position. L'application ne convertit
//     pas les devises (fxImpactEur reste null) : écrire un cours en USD sur une ligne libellée
//     en EUR fausserait silencieusement le total. Ce cas est signalé, pas appliqué.
//
// Module SERVEUR uniquement (appelé par /api/admin/market/refresh). Aucune écriture ici.

export type Quote = {
  symbol: string;
  price: number;
  currency: string;
  asOf: string | null; // ISO
  provider: string;
  name: string | null;
  exchange: string | null;
};

export type QuoteTarget = {
  isin?: string | null;
  ticker?: string | null;
  name?: string | null;
  currency?: string | null; // devise attendue de la position
  marketSymbol?: string | null; // symbole déjà résolu (évite une recherche)
};

export type QuoteOutcome =
  | { ok: true; quote: Quote }
  | { ok: false; reason: "not_found" | "currency_mismatch" | "provider_error"; message: string; quote?: Quote };

const YAHOO_SEARCH = "https://query1.finance.yahoo.com/v1/finance/search";
const YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart";
const STOOQ = "https://stooq.com/q/l/";
const TIMEOUT_MS = 8000;
// Yahoo renvoie 403 sans en-tête navigateur : on s'annonce explicitement (aucun contournement
// d'authentification — ces endpoints sont publics et anonymes).
const HEADERS = { "user-agent": "Mozilla/5.0 (compatible; LaBaJoCo/1.0)", accept: "application/json,text/csv,*/*" };

// Suffixe Yahoo → suffixe Stooq + devise de la place. Table EXPLICITE : hors de cette table,
// aucune devise n'est supposée (le repli Stooq est simplement indisponible).
const MARKETS: Record<string, { stooq: string; currency: string }> = {
  PA: { stooq: "fr", currency: "EUR" }, // Euronext Paris
  AS: { stooq: "nl", currency: "EUR" }, // Euronext Amsterdam
  BR: { stooq: "be", currency: "EUR" }, // Euronext Bruxelles
  LS: { stooq: "pt", currency: "EUR" }, // Euronext Lisbonne
  DE: { stooq: "de", currency: "EUR" }, // Xetra
  F: { stooq: "de", currency: "EUR" }, // Francfort
  MI: { stooq: "it", currency: "EUR" }, // Borsa Italiana
  MC: { stooq: "es", currency: "EUR" }, // Bolsa de Madrid
  VI: { stooq: "at", currency: "EUR" }, // Vienne
  IR: { stooq: "ie", currency: "EUR" }, // Euronext Dublin
  L: { stooq: "uk", currency: "GBP" }, // Londres
  SW: { stooq: "ch", currency: "CHF" }, // SIX Swiss
  ST: { stooq: "se", currency: "SEK" }, // Stockholm
  CO: { stooq: "dk", currency: "DKK" }, // Copenhague
  OL: { stooq: "no", currency: "NOK" }, // Oslo
  "": { stooq: "us", currency: "USD" }, // États-Unis (symbole sans suffixe)
};

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, headers: { ...HEADERS, ...(init.headers ?? {}) }, cache: "no-store", signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function suffixOf(symbol: string): string {
  const parts = symbol.split(".");
  return parts.length > 1 ? parts[parts.length - 1].toUpperCase() : "";
}

// ==========================================================================================
// YAHOO
// ==========================================================================================
type YahooSearchQuote = { symbol?: string; shortname?: string; longname?: string; exchDisp?: string; quoteType?: string; score?: number };

/** Résout un identifiant (ISIN de préférence) en symboles Yahoo candidats, du plus au moins pertinent. */
export async function resolveSymbols(target: QuoteTarget): Promise<string[]> {
  const queries = [target.isin, target.ticker, target.name]
    .map((value) => String(value ?? "").trim())
    .filter((value) => value.length >= 2);
  const found: string[] = [];
  for (const query of queries) {
    try {
      const url = `${YAHOO_SEARCH}?q=${encodeURIComponent(query)}&quotesCount=8&newsCount=0&enableFuzzyQuery=false`;
      const response = await fetchWithTimeout(url);
      if (!response.ok) continue;
      const data = (await response.json()) as { quotes?: YahooSearchQuote[] };
      for (const quote of data.quotes ?? []) {
        const symbol = String(quote.symbol ?? "").trim();
        const type = String(quote.quoteType ?? "").toUpperCase();
        if (!symbol || (type && type !== "EQUITY" && type !== "ETF" && type !== "MUTUALFUND")) continue;
        if (!found.includes(symbol)) found.push(symbol);
      }
      if (found.length > 0) return found.slice(0, 6); // une recherche fructueuse suffit
    } catch { /* fournisseur indisponible → on tente la requête suivante */ }
  }
  return found.slice(0, 6);
}

/** Cours d'un symbole Yahoo (prix, devise, horodatage). null si indisponible. */
export async function yahooQuote(symbol: string): Promise<Quote | null> {
  try {
    const response = await fetchWithTimeout(`${YAHOO_CHART}/${encodeURIComponent(symbol)}?range=5d&interval=1d`);
    if (!response.ok) return null;
    const data = (await response.json()) as {
      chart?: { result?: Array<{ meta?: Record<string, unknown> }>; error?: unknown };
    };
    const meta = data.chart?.result?.[0]?.meta;
    if (!meta) return null;
    const rawPrice = Number(meta.regularMarketPrice);
    const rawCurrency = String(meta.currency ?? "");
    if (!Number.isFinite(rawPrice) || rawPrice <= 0 || !rawCurrency) return null;
    // Londres cote en pence (« GBp » / « GBX ») : ramené en livres pour rester homogène.
    const isPence = rawCurrency === "GBp" || rawCurrency.toUpperCase() === "GBX";
    const stamp = Number(meta.regularMarketTime);
    return {
      symbol: String(meta.symbol ?? symbol),
      price: isPence ? rawPrice / 100 : rawPrice,
      currency: isPence ? "GBP" : rawCurrency.toUpperCase(),
      asOf: Number.isFinite(stamp) && stamp > 0 ? new Date(stamp * 1000).toISOString() : null,
      provider: "Yahoo Finance",
      name: (meta.longName as string) ?? (meta.shortName as string) ?? null,
      exchange: (meta.fullExchangeName as string) ?? (meta.exchangeName as string) ?? null,
    };
  } catch {
    return null;
  }
}

// ==========================================================================================
// STOOQ (repli, CSV sans clé — cours de clôture)
// ==========================================================================================
export async function stooqQuote(yahooSymbol: string): Promise<Quote | null> {
  const suffix = suffixOf(yahooSymbol);
  const market = MARKETS[suffix];
  if (!market) return null; // place inconnue → aucune devise supposée
  const base = (suffix ? yahooSymbol.slice(0, yahooSymbol.length - suffix.length - 1) : yahooSymbol).toLowerCase();
  if (!base) return null;
  try {
    const response = await fetchWithTimeout(`${STOOQ}?s=${encodeURIComponent(`${base}.${market.stooq}`)}&f=sd2t2ohlcv&h&e=csv`);
    if (!response.ok) return null;
    const text = await response.text();
    const [header, row] = text.trim().split(/\r?\n/);
    if (!header || !row) return null;
    const columns = header.toLowerCase().split(",");
    const values = row.split(",");
    const get = (key: string) => values[columns.indexOf(key)]?.trim() ?? "";
    const price = Number(get("close"));
    const date = get("date");
    if (!Number.isFinite(price) || price <= 0 || date === "N/D") return null;
    return {
      symbol: yahooSymbol,
      price,
      currency: market.currency,
      asOf: /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00:00.000Z` : null,
      provider: "Stooq",
      name: null,
      exchange: null,
    };
  } catch {
    return null;
  }
}

// ==========================================================================================
// POINT D'ENTRÉE
// ==========================================================================================
// Places à sonder pour une devise donnée, par ordre de pertinence pour un investisseur français.
// Sert uniquement quand la recherche par ISIN n'a renvoyé que des cotations dans une AUTRE
// devise : Yahoo ne remonte qu'une place par ISIN, alors qu'un même ETF est souvent coté à
// Londres (GBP), Amsterdam (EUR) et Milan (EUR). On ne devine rien : chaque sonde est vérifiée
// par la devise que le fournisseur renvoie lui-même.
const PROBE_ORDER: Record<string, string[]> = {
  EUR: ["AS", "PA", "DE", "MI", "MC", "BR", "F", "VI", "IR", "LS"],
  GBP: ["L"],
  CHF: ["SW"],
  USD: [""],
  SEK: ["ST"],
  DKK: ["CO"],
  NOK: ["OL"],
};
const MAX_PROBES = 6;

// Mots sans pouvoir distinctif dans un nom d'instrument (habillage juridique / part / devise).
const NOISE = new Set([
  "ucits", "etf", "etp", "etc", "fund", "sicav", "index", "the", "and", "de", "du", "des",
  "inc", "corp", "corporation", "co", "company", "sa", "s", "as", "nv", "n", "v", "plc", "ag", "spa", "se", "ltd",
  "acc", "accumulating", "dist", "distributing", "eur", "usd", "gbp", "chf", "class", "share", "shares", "hedged",
]);

function nameTokens(value: string | null | undefined): Set<string> {
  return new Set(
    String(value ?? "")
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((token) => token.length > 1 && !NOISE.has(token)),
  );
}

/**
 * Deux cotations désignent-elles le MÊME titre ? Question critique : sonder « AMZN » sur les
 * places européennes remonte « LS 1x Amazon Tracker ETP » (6,27 €) — un produit dérivé, pas
 * l'action Amazon (232 $). Écrire ce cours détruirait la valeur du portefeuille en silence.
 *
 * Deux contrôles indépendants, tous deux exigés :
 *   1) NOM — une cotation secondaire d'un même titre porte le nom officiel de l'émetteur ;
 *      on exige un fort recouvrement des mots distinctifs.
 *   2) PRIX — deux cotations d'un même titre, même en devises différentes (EUR/USD/GBP),
 *      restent du même ordre de grandeur. Un écart hors [0,4 ; 2,5] trahit un autre instrument
 *      (produit à levier, certificat, action fractionnée…).
 */
function sameInstrument(reference: { name: string | null; price: number | null }, candidate: Quote): boolean {
  const referenceTokens = nameTokens(reference.name);
  const candidateTokens = nameTokens(candidate.name);
  if (referenceTokens.size === 0 || candidateTokens.size === 0) return false;
  const shared = [...referenceTokens].filter((token) => candidateTokens.has(token)).length;
  const smallest = Math.min(referenceTokens.size, candidateTokens.size);
  if (shared < 2 || shared / smallest < 0.8) return false;
  if (reference.price !== null && reference.price > 0) {
    const ratio = candidate.price / reference.price;
    if (ratio < 0.4 || ratio > 2.5) return false;
  }
  return true;
}

/**
 * Cherche le cours d'un instrument. Essaie les symboles candidats et retient EN PRIORITÉ celui
 * dont la devise correspond à celle de la position (une même valeur est souvent cotée sur
 * plusieurs places, dans plusieurs devises). Si aucun candidat ne correspond, renvoie le
 * meilleur cours trouvé avec `currency_mismatch` : l'appelant décide, rien n'est écrit d'office.
 */
export async function fetchQuote(target: QuoteTarget): Promise<QuoteOutcome> {
  const expected = String(target.currency ?? "").trim().toUpperCase() || null;
  const candidates: string[] = [];
  const preset = String(target.marketSymbol ?? "").trim();
  if (preset) candidates.push(preset);
  for (const symbol of await resolveSymbols(target)) if (!candidates.includes(symbol)) candidates.push(symbol);
  if (candidates.length === 0) {
    return { ok: false, reason: "not_found", message: "Aucun symbole de marché trouvé pour cet instrument (ISIN, ticker ou nom)." };
  }

  let fallback: Quote | null = null;
  let providerReached = false;
  for (const symbol of candidates) {
    const quote = (await yahooQuote(symbol)) ?? (await stooqQuote(symbol));
    if (!quote) continue;
    providerReached = true;
    if (!expected || quote.currency === expected) return { ok: true, quote };
    if (!fallback) fallback = quote;
  }

  // Aucune cotation dans la devise attendue : sonder les places de cette devise, à partir du
  // ticker (celui du relevé et celui des symboles déjà trouvés). Chaque sonde doit passer le
  // contrôle d'identité `sameInstrument` — sans quoi on préfère ne rien écrire.
  if (expected && PROBE_ORDER[expected]) {
    const reference = { name: fallback?.name ?? target.name ?? null, price: fallback?.price ?? null };
    const bases = new Set<string>();
    for (const value of [target.ticker, ...candidates]) {
      const symbol = String(value ?? "").trim().toUpperCase();
      if (!symbol) continue;
      const suffix = suffixOf(symbol);
      const base = suffix ? symbol.slice(0, symbol.length - suffix.length - 1) : symbol;
      if (base.length >= 2 && /^[A-Z0-9-]+$/.test(base)) bases.add(base);
    }
    let probes = 0;
    for (const base of bases) {
      for (const suffix of PROBE_ORDER[expected]) {
        const symbol = suffix ? `${base}.${suffix}` : base;
        if (candidates.includes(symbol) || probes >= MAX_PROBES) continue;
        probes++;
        const quote = await yahooQuote(symbol);
        if (quote && quote.currency === expected && sameInstrument(reference, quote)) return { ok: true, quote };
      }
      if (probes >= MAX_PROBES) break;
    }
  }

  if (fallback) {
    return {
      ok: false,
      reason: "currency_mismatch",
      message: `Cours trouvé en ${fallback.currency} (${fallback.symbol} — ${fallback.price}) alors que la position est libellée en ${expected}. Cours non appliqué : l'application ne convertit pas les devises, et aucune cotation en ${expected} n'a pu être identifiée avec certitude pour ce titre.`,
      quote: fallback,
    };
  }
  return {
    ok: false,
    reason: providerReached ? "not_found" : "provider_error",
    message: providerReached
      ? "Aucun cours exploitable pour cet instrument."
      : "Le fournisseur de cours n'a pas répondu. Réessayez plus tard.",
  };
}
