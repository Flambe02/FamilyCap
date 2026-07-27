// Simulations pédagogiques de la leçon « Épargne et temps : le duo qui fait grandir votre argent ».
//
// Ce module est PUR (aucun React, aucun accès réseau) et constitue la seule source des chiffres
// affichés dans l'article : les jeux de données exportés plus bas sont CALCULÉS, jamais recopiés.
// `tests/lesson-savings-time.test.mjs` rejoue chaque valeur contre la référence éditoriale validée.
//
// Hypothèses — identiques à la section « Hypothèses de calcul » visible dans l'article :
//   - versements effectués EN FIN DE MOIS (annuité de fin de période) ;
//   - rendement annualisé constant converti en taux mensuel ÉQUIVALENT : (1 + r)^(1/12) − 1.
//     Surtout pas r/12, qui est un taux proportionnel et surestime le capital final ;
//   - gains intégralement réinvestis ;
//   - aucune fiscalité, aucun frais d'entrée, aucune variation réelle de marché.
// Le scénario « frais » retranche simplement 0,6 point au rendement brut annuel (5 % → 4,4 %).

/** Taux mensuel équivalent d'un rendement annualisé (0.05 → 0,4074 % par mois). */
export function monthlyRate(annualRate: number): number {
  return Math.pow(1 + annualRate, 1 / 12) - 1;
}

/** Capital atteint par des versements mensuels de fin de mois, gains réinvestis. */
export function futureValue(monthlyAmount: number, annualRate: number, years: number): number {
  const months = Math.round(years * 12);
  if (months <= 0 || monthlyAmount <= 0) return 0;
  const rate = monthlyRate(annualRate);
  if (rate === 0) return monthlyAmount * months;
  return monthlyAmount * ((Math.pow(1 + rate, months) - 1) / rate);
}

/**
 * Nombre de mois nécessaires pour atteindre un objectif. Forme fermée de l'annuité, arrondie au
 * mois SUPÉRIEUR : le mois où l'objectif est franchi compte, on n'annonce jamais une durée plus
 * courte que la réalité. Renvoie null si l'objectif est hors de portée (rendement ≤ −100 %).
 */
export function monthsToTarget(monthlyAmount: number, annualRate: number, target: number): number | null {
  if (monthlyAmount <= 0 || target <= 0) return null;
  const rate = monthlyRate(annualRate);
  if (!Number.isFinite(rate) || rate <= -1) return null;
  if (rate === 0) return Math.ceil(target / monthlyAmount);
  const ratio = 1 + (target * rate) / monthlyAmount;
  if (ratio <= 0) return null;
  return Math.ceil(Math.log(ratio) / Math.log(1 + rate));
}

/** Règle des 72 : temps de doublement approximatif, en années, pour un taux exprimé en pourcent. */
export function doublingYears(annualRatePercent: number): number {
  if (annualRatePercent <= 0) return Number.POSITIVE_INFINITY;
  return 72 / annualRatePercent;
}

/** Règle indicative des 4 % : capital ≈ revenu mensuel souhaité × 300 (soit 12 mois ÷ 4 %). */
export function indicativeCapital(monthlyIncome: number): number {
  return monthlyIncome * 300;
}

/** Pouvoir d'achat d'un capital futur, exprimé en euros d'aujourd'hui. */
export function realValue(nominal: number, inflationRate: number, years: number): number {
  return nominal / Math.pow(1 + inflationRate, years);
}

/** « 400 » → « 33 ans et 4 mois ». Aucune décimale n'est jamais montrée à l'utilisateur. */
export function durationLabel(months: number): string {
  const years = Math.floor(months / 12);
  const rest = months % 12;
  const yearPart = years > 0 ? `${years} ${years > 1 ? "ans" : "an"}` : "";
  const monthPart = rest > 0 ? `${rest} mois` : "";
  if (yearPart && monthPart) return `${yearPart} et ${monthPart}`;
  return yearPart || monthPart || "moins d’un mois";
}

/** Nombre décimal au format français : 14.4 → « 14,4 ». */
export function frNumber(value: number, fractionDigits = 1): string {
  return value.toFixed(fractionDigits).replace(".", ",").replace(/,0$/, "");
}

/** Pourcentage au format français, espace insécable comprise : 2.2 → « 2,2 % ». */
export function frPercent(value: number, fractionDigits = 1): string {
  return `${frNumber(value, fractionDigits)} %`;
}

// ---------------------------------------------------------------------------------------------
// Jeux de données de l'article. Tous dérivés des fonctions ci-dessus.
// ---------------------------------------------------------------------------------------------

/** Hypothèses communes, affichées telles quelles dans les infobulles et les sous-titres. */
export const SAVINGS_TARGET = 500_000;
export const BASE_RETURN_RATE = 0.05;
export const FEE_POINTS = 0.006;

export type EffortRow = { monthlyAmount: number; months: number; years: number; displayDuration: string };

/** Graphique 1 — combien de temps pour atteindre 500 000 € à 5 % par an. */
export const EFFORT_ROWS: EffortRow[] = [500, 750, 1000, 1500, 2000, 2500].map((monthlyAmount) => {
  const months = monthsToTarget(monthlyAmount, BASE_RETURN_RATE, SAVINGS_TARGET) ?? 0;
  return {
    monthlyAmount,
    months,
    years: Math.round((months / 12) * 100) / 100,
    displayDuration: durationLabel(months),
  };
});

/** Scénario mis en avant dans le graphique 1 (repère de lecture, pas une recommandation). */
export const EFFORT_HIGHLIGHT = 1000;

export type CompoundRow = { year: number; contributions: number; capital: number; gains: number };

/** Graphique 2 — 1 000 € par mois à 5 %, versements cumulés contre capital estimé. */
export const COMPOUND_ROWS: CompoundRow[] = [0, 5, 10, 15, 20, 25, 30].map((year) => {
  const contributions = 1000 * 12 * year;
  const capital = Math.round(futureValue(1000, BASE_RETURN_RATE, year));
  return { year, contributions, capital, gains: capital - contributions };
});

export type DoublingRow = { rate: number; years: number };

/** Graphique 3 — règle des 72. */
export const DOUBLING_ROWS: DoublingRow[] = [3, 4, 5, 7, 8, 10].map((rate) => ({
  rate,
  years: Math.round(doublingYears(rate) * 10) / 10,
}));

/** Repère mis en évidence dans le graphique 3. */
export const DOUBLING_HIGHLIGHT = 5;

export type WithdrawalRow = { monthlyIncome: number; indicativeCapital: number };

/** Règle indicative des 4 %. */
export const WITHDRAWAL_ROWS: WithdrawalRow[] = [500, 1000, 1500, 2000, 3000].map((monthlyIncome) => ({
  monthlyIncome,
  indicativeCapital: indicativeCapital(monthlyIncome),
}));

export type FeeRow = { year: number; gross: number; net: number; difference: number };

/**
 * Graphique 4 — 500 € par mois, 5 % brut contre 4,4 % net simplifié.
 * L'écart est arrondi à partir des valeurs EXACTES, et non de la soustraction des deux valeurs
 * déjà arrondies : c'est le montant réellement perdu qui est annoncé. Conséquence assumée — à
 * l'année 25 l'écart affiché (23 814 €) vaut 1 € de plus que la soustraction des deux capitaux
 * arrondis (23 813 €), l'écart exact étant 23 813,5 €.
 */
export const FEE_ROWS: FeeRow[] = [5, 10, 15, 20, 25, 30].map((year) => {
  const gross = futureValue(500, BASE_RETURN_RATE, year);
  const net = futureValue(500, BASE_RETURN_RATE - FEE_POINTS, year);
  return { year, gross: Math.round(gross), net: Math.round(net), difference: Math.round(gross - net) };
});

export const INFLATION_SCENARIOS = [0.01, 0.022, 0.05] as const;

export type InflationRow = { returnRate: number; nominal: number; real: { rate: number; value: number }[] };

/** Graphique 5 — 1 000 € par mois pendant 20 ans, capital nominal contre pouvoir d'achat. */
export const INFLATION_ROWS: InflationRow[] = [0.04, 0.08].map((returnRate) => {
  // Le pouvoir d'achat est déflaté depuis le capital EXACT : arrondir d'abord le nominal
  // propagerait l'arrondi dans les trois scénarios d'inflation.
  const nominal = futureValue(1000, returnRate, 20);
  return {
    returnRate: Math.round(returnRate * 100),
    nominal: Math.round(nominal),
    real: INFLATION_SCENARIOS.map((rate) => ({
      rate: Math.round(rate * 1000) / 10,
      value: Math.round(realValue(nominal, rate, 20)),
    })),
  };
});
