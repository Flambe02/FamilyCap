// Taux de change — fournisseurs GRATUITS et sans clé d'API.
//
// Pourquoi ce module existe : jusqu'ici le taux n'était relevé QU'À L'INTÉRIEUR de la branche
// « un cours vient d'être rafraîchi » de `market-sync.ts`. Il était donc sauté dès que le cours
// venait du cache du jour, dès que le plafond quotidien EODHD était atteint, et pour toujours si
// la première tentative avait échoué. Résultat mesuré : `market_fx_rates` vide, donc
// `fxRateToReference = null`, donc toute position en USD sans valeur ET hors du total du
// portefeuille. Le change est une donnée INDÉPENDANTE d'un instrument : il lui faut son propre
// chemin, son propre cache, et surtout aucun quota partagé avec les cours.
//
// Chaîne de fournisseurs (arrêt au premier succès) :
//   1) Frankfurter — taux de référence quotidiens de la BCE. Gratuit, sans clé, daté.
//      https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR
//   2) Yahoo Finance — paire `USDEUR=X`, cotation continue. Gratuit, sans clé.
//
// RÈGLES STRICTES (cohérentes avec « aucune donnée inventée ») :
//   * Aucun taux n'est renvoyé si les deux fournisseurs échouent : l'appelant reçoit une erreur
//     explicite et la position reste « Conversion indisponible ». Jamais de 1:1 par défaut,
//     jamais de taux périmé maquillé en frais.
//   * Un taux est refusé s'il n'est pas un nombre fini strictement positif, ou si le fournisseur
//     répond sur une AUTRE paire que celle demandée.
//   * Ce module ne lit ni n'écrit la base : il rapporte ce que le fournisseur a dit.

export type FxRate = {
  baseCurrency: string;
  quoteCurrency: string;
  rate: number; // 1 baseCurrency = `rate` quoteCurrency
  quotedAt: string; // ISO
  provider: string;
};

export type FxOutcome =
  | { ok: true; rate: FxRate }
  | { ok: false; message: string };

const FRANKFURTER = "https://api.frankfurter.dev/v1/latest";
const YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart";
const TIMEOUT_MS = 8000;
const HEADERS = { "user-agent": "Mozilla/5.0 (compatible; LaBaJoCo/1.0)", accept: "application/json,*/*" };

export function normaliseCurrency(value: string | null | undefined): string | null {
  const code = String(value ?? "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

/** Un taux exploitable est fini et strictement positif. Rien d'autre n'est accepté. */
export function isUsableRate(value: unknown): value is number {
  const rate = Number(value);
  return Number.isFinite(rate) && rate > 0;
}

// ---- Analyse des réponses (pures, donc testables sans réseau) -----------------------------

/** Réponse Frankfurter : `{ base, date, rates: { EUR: 0.87897 } }`. */
export function parseFrankfurter(payload: unknown, base: string, quote: string): FxRate | null {
  const data = payload as { base?: unknown; date?: unknown; rates?: Record<string, unknown> } | null;
  if (!data || typeof data !== "object") return null;
  // Le fournisseur doit confirmer la paire demandée : une réponse sur une autre base serait
  // silencieusement fausse au moment de valoriser le portefeuille.
  if (normaliseCurrency(String(data.base ?? "")) !== base) return null;
  const rate = data.rates?.[quote];
  if (!isUsableRate(rate)) return null;
  const date = String(data.date ?? "");
  return {
    baseCurrency: base,
    quoteCurrency: quote,
    rate: Number(rate),
    quotedAt: /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00:00.000Z` : new Date().toISOString(),
    provider: "Frankfurter (BCE)",
  };
}

/** Réponse Yahoo pour `USDEUR=X` : le prix EST le taux, et `meta.currency` est la devise cible. */
export function parseYahooFx(payload: unknown, base: string, quote: string): FxRate | null {
  const meta = (payload as { chart?: { result?: Array<{ meta?: Record<string, unknown> }> } } | null)
    ?.chart?.result?.[0]?.meta;
  if (!meta) return null;
  if (String(meta.symbol ?? "").toUpperCase() !== `${base}${quote}=X`) return null;
  if (normaliseCurrency(String(meta.currency ?? "")) !== quote) return null;
  const price = meta.regularMarketPrice;
  if (!isUsableRate(price)) return null;
  const stamp = Number(meta.regularMarketTime);
  return {
    baseCurrency: base,
    quoteCurrency: quote,
    rate: Number(price),
    quotedAt: Number.isFinite(stamp) && stamp > 0 ? new Date(stamp * 1000).toISOString() : new Date().toISOString(),
    provider: "Yahoo Finance",
  };
}

// ---- Accès réseau --------------------------------------------------------------------------

async function fetchJson(url: string): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers: HEADERS, cache: "no-store", signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Taux `base → quote`. Une paire identique vaut 1 sans appel réseau : ce n'est pas une valeur
 * inventée mais une identité. Tout le reste vient d'un fournisseur, ou échoue franchement.
 */
export async function fetchFxRate(baseInput: string, quoteInput: string): Promise<FxOutcome> {
  const base = normaliseCurrency(baseInput);
  const quote = normaliseCurrency(quoteInput);
  if (!base || !quote) return { ok: false, message: "Code devise invalide (trois lettres attendues)." };
  if (base === quote) {
    return { ok: true, rate: { baseCurrency: base, quoteCurrency: quote, rate: 1, quotedAt: new Date().toISOString(), provider: "identité" } };
  }

  const ecb = parseFrankfurter(await fetchJson(`${FRANKFURTER}?base=${base}&symbols=${quote}`), base, quote);
  if (ecb) return { ok: true, rate: ecb };

  const yahoo = parseYahooFx(await fetchJson(`${YAHOO_CHART}/${base}${quote}=X?range=5d&interval=1d`), base, quote);
  if (yahoo) return { ok: true, rate: yahoo };

  return { ok: false, message: `Aucun taux ${base}→${quote} obtenu auprès des fournisseurs de change. Les positions dans cette devise restent non converties.` };
}

/**
 * Un taux daté d'aujourd'hui n'est pas relu : les deux fournisseurs publient au plus une valeur
 * par jour ouvré, et la conversion d'un portefeuille familial n'a pas besoin de la seconde près.
 */
export function isRateFreshToday(quotedAt: string | null | undefined, today = new Date().toISOString().slice(0, 10)): boolean {
  return String(quotedAt ?? "").slice(0, 10) === today;
}
