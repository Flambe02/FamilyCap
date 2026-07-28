// Historiques de marché GRATUITS et sans clé : dividendes versés et séries d'indices.
//
// Pourquoi un module séparé de `market-quotes.ts` : celui-ci renvoie un cours ponctuel, celui-là
// une SÉRIE. Ce sont deux besoins, deux formes de réponse et deux politiques d'erreur.
//
// Ce que cette source peut et ne peut PAS faire, dit une fois pour toutes :
//   * elle renvoie les dividendes DÉJÀ DÉTACHÉS (historique). C'est un fait vérifiable, et c'est
//     la base légitime d'une projection ;
//   * elle ne publie pas de calendrier prévisionnel fiable. Un dividende futur n'apparaît donc
//     comme « annoncé » que si sa date de détachement est réellement postérieure à aujourd'hui.
//     Le reste des échéances à venir est produit par PROJECTION, badgée « Estimé », jamais
//     présentée comme une annonce.
//
// Module SERVEUR uniquement. Aucune écriture : les routes décident de ce qui est enregistré.

const YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart";
const TIMEOUT_MS = 9000;
const HEADERS = { "user-agent": "Mozilla/5.0 (compatible; LaBaJoCo/1.0)", accept: "application/json,*/*" };

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers: HEADERS, cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function isoDay(seconds: number): string | null {
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

export type HistoricalDividend = { exDate: string; amountPerShare: number; currency: string | null };

/**
 * Dividendes détachés sur les `years` dernières années, pour un symbole DÉJÀ RÉSOLU.
 *
 * Aucune résolution de symbole n'est tentée ici : deviner le symbole est exactement ce qui a
 * produit des rapprochements faux ailleurs dans ce projet. Un appelant qui n'a pas de symbole
 * validé n'appelle pas cette fonction.
 */
export async function fetchDividendHistory(symbol: string, years = 5): Promise<HistoricalDividend[] | null> {
  const clean = symbol.trim();
  if (!clean) return null;
  let payload: unknown;
  try {
    payload = await fetchJson(`${YAHOO_CHART}/${encodeURIComponent(clean)}?range=${Math.max(1, Math.min(10, years))}y&interval=1d&events=div`);
  } catch {
    return null; // fournisseur muet : « indisponible », surtout pas « aucun dividende »
  }
  const result = (payload as { chart?: { result?: Array<{ meta?: { currency?: string }; events?: { dividends?: Record<string, { amount?: number; date?: number }> } }> } })
    .chart?.result?.[0];
  if (!result) return null;
  const currency = String(result.meta?.currency ?? "").toUpperCase() || null;
  const dividends = result.events?.dividends;
  if (!dividends) return []; // réponse valide sans dividende : l'instrument ne distribue pas
  const rows: HistoricalDividend[] = [];
  for (const entry of Object.values(dividends)) {
    const amount = Number(entry?.amount);
    const date = Number(entry?.date);
    const exDate = Number.isFinite(date) ? isoDay(date) : null;
    if (!exDate || !Number.isFinite(amount) || amount <= 0) continue;
    rows.push({ exDate, amountPerShare: amount, currency });
  }
  return rows.sort((a, b) => a.exDate.localeCompare(b.exDate));
}

export type BenchmarkDefinition = {
  code: string;
  label: string;
  /** Symbole du fournisseur. Un indice (`^FCHI`) ou un ETF représentatif, dit explicitement. */
  symbol: string;
  /** Mentionné dans l'interface quand la série est un PROXY et non l'indice lui-même. */
  proxyNote: string | null;
};

/**
 * Références proposées. `MSCI World` n'est pas cotable en direct : la série vient d'un ETF
 * physique répliquant l'indice, et l'interface l'annonce (« proxy »), plutôt que de laisser
 * croire qu'il s'agit de l'indice net dividendes réinvestis.
 *
 * Le Livret A n'y figure pas : son taux est un paramètre réglementaire qui ne se collecte pas
 * chez un fournisseur de marché. L'inventer pour compléter la liste serait précisément le genre
 * de chiffre plausible-mais-faux que ce projet refuse.
 */
export const BENCHMARKS: BenchmarkDefinition[] = [
  { code: "MSCI_WORLD", label: "MSCI World", symbol: "IWDA.AS", proxyNote: "Série issue de l'ETF iShares Core MSCI World (IWDA.AS), utilisé comme proxy de l'indice." },
  { code: "CAC40", label: "CAC 40", symbol: "^FCHI", proxyNote: null },
];

export function benchmarkByCode(code: string): BenchmarkDefinition | null {
  return BENCHMARKS.find((benchmark) => benchmark.code === code) ?? null;
}

export type BenchmarkClose = { date: string; close: number; currency: string };

/** Clôtures mensuelles sur `years` années. `null` = fournisseur indisponible (jamais une série vide déguisée). */
export async function fetchBenchmarkSeries(symbol: string, years = 10): Promise<BenchmarkClose[] | null> {
  let payload: unknown;
  try {
    payload = await fetchJson(`${YAHOO_CHART}/${encodeURIComponent(symbol)}?range=${Math.max(1, Math.min(10, years))}y&interval=1mo`);
  } catch {
    return null;
  }
  const result = (payload as {
    chart?: { result?: Array<{ meta?: { currency?: string }; timestamp?: number[]; indicators?: { quote?: Array<{ close?: Array<number | null> }> } }> };
  }).chart?.result?.[0];
  if (!result?.timestamp?.length) return null;
  const currency = String(result.meta?.currency ?? "EUR").toUpperCase();
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  const rows: BenchmarkClose[] = [];
  for (let index = 0; index < result.timestamp.length; index += 1) {
    const date = isoDay(result.timestamp[index]);
    const close = Number(closes[index]);
    if (!date || !Number.isFinite(close) || close <= 0) continue;
    rows.push({ date, close, currency });
  }
  return rows;
}
