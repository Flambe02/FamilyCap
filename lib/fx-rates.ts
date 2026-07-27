// CONVERSION DE DEVISES — taux de référence de la Banque centrale européenne.
//
// Module PUR : aucune requête, aucun accès Supabase, aucun React. C'est le SEUL endroit où la
// formule de conversion est écrite. Toute autre couche (route /api/portfolio, moteur de
// portefeuille, composants) se contente d'appliquer le facteur qu'il renvoie — une formule
// recopiée dans un composant est une formule qui divergera.
//
// CONVENTION BCE, à ne jamais oublier : la BCE publie ses taux avec l'EURO EN BASE.
//     <Cube currency='USD' rate='1.1377'/>   signifie   1 EUR = 1,1377 USD
// Convertir un montant en dollars vers l'euro est donc une DIVISION :
//     montant_eur = montant_usd / 1,1377
// L'erreur symétrique — multiplier par 1,1377 — donnerait 72 604 € pour 63 818 $US au lieu de
// 56 094 €, soit +29 %. C'est exactement le genre d'écart qui passe inaperçu sur un écran.
//
// Ce module ne stocke rien et n'invente rien : sans taux enregistré, il renvoie null et
// l'interface affiche « Conversion indisponible ». Jamais de 1:1 par défaut.

/** Une ligne de la table `fx_rates` : 1 baseCurrency = rate quoteCurrency, à la date rateDate. */
export type FxRateRow = {
  baseCurrency: string;
  quoteCurrency: string;
  rate: number;
  rateDate: string; // YYYY-MM-DD
  source: string;
};

/** Facteur MULTIPLICATIF résolu pour une paire, avec la traçabilité de sa provenance. */
export type FxConversion = {
  /** montant_cible = montant_source × rate. Une seule multiplication, jamais deux inversions. */
  rate: number;
  /** Date du taux retenu (peut être antérieure à la date demandée : week-end, férié…). */
  rateDate: string;
  /** Ancienneté en jours par rapport à la date de valorisation demandée. */
  ageDays: number;
  /** true au-delà de `MAX_FRESH_DAYS` : on convertit quand même, mais on le dit. */
  stale: boolean;
  /**
   * true quand AUCUN taux n'existait à la date demandée et qu'on a pris le plus ancien connu
   * (uniquement si `fallbackToEarliest`). Cas réel : la collecte des taux démarre aujourd'hui,
   * alors que les achats datent d'il y a deux ans. Le coût converti est alors une APPROXIMATION
   * assumée et signalée, jamais présentée comme le change réellement subi.
   */
  approximated: boolean;
  /** Taux élémentaires utilisés, pour l'infobulle (« 1 EUR = 1,1377 USD au 24/07/2026 »). */
  legs: string[];
};

/**
 * Au-delà de sept jours, le taux reste utilisé — refuser de convertir serait pire que convertir
 * avec le taux de la semaine passée — mais l'interface l'indique discrètement. Sept jours
 * couvrent un week-end prolongé et un jour férié sans jamais alerter à tort.
 */
export const MAX_FRESH_DAYS = 7;

export const ECB_BASE_CURRENCY = "EUR";

export function normaliseCurrency(value: string | null | undefined): string | null {
  const code = String(value ?? "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

function isUsableRate(value: unknown): value is number {
  const rate = Number(value);
  return Number.isFinite(rate) && rate > 0;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, Math.round((to - from) / 86_400_000));
}

// ==========================================================================================
// 1) LECTURE DU FICHIER QUOTIDIEN DE LA BCE
// ==========================================================================================
// Format (https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml) :
//   <Cube time='2026-07-24'>
//     <Cube currency='USD' rate='1.1377'/>
//     <Cube currency='GBP' rate='0.8642'/>
//   </Cube>
// On le lit par expression régulière plutôt qu'avec un analyseur XML : le document fait une
// vingtaine de lignes, sa structure est figée depuis vingt ans, et cela évite d'ajouter une
// dépendance à un projet qui n'en a pas besoin.

export type EcbDaily = { date: string; rates: Array<{ currency: string; rate: number }> };

export function parseEcbDailyXml(xml: string): EcbDaily | null {
  const text = String(xml ?? "");
  const date = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(text)?.[1];
  if (!date) return null;

  const rates: Array<{ currency: string; rate: number }> = [];
  const seen = new Set<string>();
  const pattern = /<Cube\s+currency=['"]([A-Za-z]{3})['"]\s+rate=['"]([0-9.,]+)['"]/g;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const currency = normaliseCurrency(match[1]);
    // La BCE publie en notation anglo-saxonne (point décimal) : on ne « corrige » rien.
    const rate = Number(match[2]);
    if (!currency || !isUsableRate(rate)) continue;
    // L'euro ne peut pas figurer dans la liste : il est la base. S'il y apparaissait, l'ignorer
    // évite d'enregistrer un absurde « EUR→EUR = 0,98 ».
    if (currency === ECB_BASE_CURRENCY) continue;
    if (seen.has(currency)) continue;
    seen.add(currency);
    rates.push({ currency, rate });
  }
  return rates.length === 0 ? null : { date, rates };
}

/** Lignes prêtes à écrire dans `fx_rates`, à partir du fichier quotidien. */
export function ecbRowsFor(daily: EcbDaily, fetchedAt: string): Array<{
  base_currency: string; quote_currency: string; rate: number; rate_date: string; source: string; fetched_at: string;
}> {
  return daily.rates.map((entry) => ({
    base_currency: ECB_BASE_CURRENCY,
    quote_currency: entry.currency,
    rate: entry.rate,
    rate_date: daily.date,
    source: "ECB",
    fetched_at: fetchedAt,
  }));
}

// ==========================================================================================
// 2) SÉLECTION DU TAUX APPLICABLE
// ==========================================================================================

export type RateLookupOptions = {
  /** Date de valorisation (défaut : aujourd'hui). Un taux postérieur n'est jamais utilisé. */
  asOf?: string;
  /** Seuil d'ancienneté au-delà duquel le taux est signalé (défaut : 7 jours). */
  maxFreshDays?: number;
  /**
   * Autorise le repli sur le PLUS ANCIEN taux connu quand aucun ne précède la date demandée.
   * Réservé au COÛT HISTORIQUE : la collecte des taux démarre aujourd'hui, alors que les achats
   * sont anciens. Sans ce repli, aucune plus-value en euros ne serait calculable avant plusieurs
   * mois. La conversion est alors marquée `approximated` et l'interface le dit.
   *
   * JAMAIS pour la valorisation courante : là, un taux postérieur n'a aucune raison d'exister.
   */
  fallbackToEarliest?: boolean;
};

/**
 * Dernier taux connu pour une devise, à une date donnée.
 *
 * RÈGLE DE REPLI : on retient la ligne la plus récente dont la date est INFÉRIEURE OU ÉGALE à la
 * date de valorisation. C'est ce qui fait qu'un samedi utilise le taux du vendredi, qu'un jour
 * férié utilise la veille ouvrée, et qu'une valorisation historique n'est jamais recalculée avec
 * le taux d'aujourd'hui.
 */
export function selectRateRow(
  rows: FxRateRow[],
  quoteCurrency: string,
  asOf: string,
  fallbackToEarliest = false,
): { row: FxRateRow; approximated: boolean } | null {
  const currency = normaliseCurrency(quoteCurrency);
  if (!currency) return null;
  let best: FxRateRow | null = null;
  let earliest: FxRateRow | null = null;
  for (const row of rows) {
    if (normaliseCurrency(row.baseCurrency) !== ECB_BASE_CURRENCY) continue;
    if (normaliseCurrency(row.quoteCurrency) !== currency) continue;
    if (!isIsoDate(row.rateDate) || !isUsableRate(row.rate)) continue;
    if (!earliest || row.rateDate < earliest.rateDate) earliest = row;
    if (row.rateDate > asOf) continue; // jamais un taux postérieur à la valorisation
    if (!best || row.rateDate > best.rateDate) best = row;
  }
  if (best) return { row: best, approximated: false };
  // Aucun taux antérieur : soit on renonce (valorisation courante), soit on prend le plus ancien
  // connu en l'annonçant comme approximation (coût historique d'un achat antérieur à la collecte).
  return fallbackToEarliest && earliest ? { row: earliest, approximated: true } : null;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function legLabel(row: FxRateRow): string {
  return `1 ${row.baseCurrency} = ${row.rate} ${row.quoteCurrency} (BCE, ${row.rateDate})`;
}

/**
 * Facteur de conversion `from → to`, résolu depuis les taux BCE (base EUR).
 *
 * Trois cas, et un seul passage par l'inversion :
 *   EUR → X   : facteur = taux(X)            (1 EUR = 1,1377 USD → 100 € = 113,77 $)
 *   X   → EUR : facteur = 1 / taux(X)        (63 818 $ / 1,1377 = 56 093,87 €)
 *   X   → Y   : facteur = taux(Y) / taux(X)  (composition unique, pas deux inversions)
 */
export function getLatestFxRate(
  fromCurrency: string,
  toCurrency: string,
  rows: FxRateRow[],
  options: RateLookupOptions = {},
): FxConversion | null {
  const from = normaliseCurrency(fromCurrency);
  const to = normaliseCurrency(toCurrency);
  if (!from || !to) return null;

  const asOf = isIsoDate(options.asOf) ? options.asOf : today();
  const maxFresh = options.maxFreshDays ?? MAX_FRESH_DAYS;

  // Identité : ce n'est pas une valeur inventée, c'est une définition. Aucun taux requis.
  if (from === to) {
    return { rate: 1, rateDate: asOf, ageDays: 0, stale: false, approximated: false, legs: [] };
  }

  const fallback = options.fallbackToEarliest === true;
  type Hit = { row: FxRateRow; approximated: boolean };
  const build = (rate: number, hit: Hit, extra?: Hit): FxConversion => {
    // Quand deux taux composent la conversion, la fraîcheur retenue est celle du PLUS ANCIEN :
    // annoncer la plus récente laisserait croire à une précision que la paire n'a pas.
    const rateDate = extra && extra.row.rateDate < hit.row.rateDate ? extra.row.rateDate : hit.row.rateDate;
    const ageDays = daysBetween(rateDate, asOf);
    return {
      rate, rateDate, ageDays,
      stale: ageDays > maxFresh,
      approximated: hit.approximated || Boolean(extra?.approximated),
      legs: extra ? [legLabel(hit.row), legLabel(extra.row)] : [legLabel(hit.row)],
    };
  };

  if (from === ECB_BASE_CURRENCY) {
    const hit = selectRateRow(rows, to, asOf, fallback);
    return hit ? build(hit.row.rate, hit) : null;
  }
  if (to === ECB_BASE_CURRENCY) {
    const hit = selectRateRow(rows, from, asOf, fallback);
    return hit ? build(1 / hit.row.rate, hit) : null;
  }
  const fromHit = selectRateRow(rows, from, asOf, fallback);
  const toHit = selectRateRow(rows, to, asOf, fallback);
  return fromHit && toHit ? build(toHit.row.rate / fromHit.row.rate, toHit, fromHit) : null;
}

/**
 * Applique un facteur déjà résolu. Aucune règle métier ici : c'est volontaire, cette fonction
 * doit rester une multiplication pour qu'il soit impossible d'inverser un taux deux fois en
 * la traversant. Aucun arrondi non plus — l'arrondi appartient à l'affichage.
 */
export function convertCurrency(amount: number, rate: number): number | null {
  if (!Number.isFinite(amount) || !isUsableRate(rate)) return null;
  return amount * rate;
}

/** Conversion complète en une fois, quand l'appelant n'a pas besoin du détail du taux. */
export function convertAmount(
  amount: number,
  fromCurrency: string,
  toCurrency: string,
  rows: FxRateRow[],
  options: RateLookupOptions = {},
): number | null {
  const conversion = getLatestFxRate(fromCurrency, toCurrency, rows, options);
  return conversion ? convertCurrency(amount, conversion.rate) : null;
}

/**
 * Facteurs pour TOUTES les devises d'un portefeuille, résolus en une seule passe sur le même
 * jeu de lignes. Les positions partagent ainsi un unique taux par devise : dix lignes en dollars
 * n'entraînent ni dix requêtes, ni dix résolutions divergentes.
 */
export function getPortfolioFxRates(
  currencies: Array<string | null | undefined>,
  toCurrency: string,
  rows: FxRateRow[],
  options: RateLookupOptions = {},
): Map<string, FxConversion | null> {
  const result = new Map<string, FxConversion | null>();
  for (const raw of currencies) {
    const currency = normaliseCurrency(raw);
    if (!currency || result.has(currency)) continue;
    result.set(currency, getLatestFxRate(currency, toCurrency, rows, options));
  }
  return result;
}

// ==========================================================================================
// 3) AFFICHAGE
// ==========================================================================================

/** « 2026-07-24 » → « 24/07 ». */
export function shortRateDate(rateDate: string): string {
  return isIsoDate(rateDate) ? `${rateDate.slice(8, 10)}/${rateDate.slice(5, 7)}` : rateDate;
}

/**
 * Mention discrète à afficher SEULEMENT quand elle apprend quelque chose : un taux de la veille
 * ou du vendredi n'a pas besoin d'être commenté, un taux vieux de trois semaines si.
 */
export function staleRateNotice(conversion: FxConversion | null | undefined): string | null {
  return conversion && conversion.stale ? `Taux du ${shortRateDate(conversion.rateDate)}` : null;
}

/** Mention de bas de tableau, unique et non répétée ligne à ligne. */
export const FX_FOOTNOTE =
  "Positions en devises étrangères converties en EUR avec le dernier taux de référence BCE disponible.";
