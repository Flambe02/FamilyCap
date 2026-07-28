// Performance d'un compte PEA / compte-titres — décomposée, pas résumée à un ratio.
//
// LE PIÈGE QUE CE MODULE REFUSE : appeler « performance » le rapport valeur actuelle / prix de
// revient. Ce ratio ignore les dividendes encaissés, les plus-values déjà réalisées, les frais, et
// surtout il attribue à la gestion ce qui vient des VERSEMENTS. Un compte qui reçoit 10 000 € et
// ne bouge pas affiche alors une « performance » spectaculaire. C'est pourquoi les versements et
// retraits sont traités ici comme des FLUX EXTERNES, neutres par construction (TWR), et pourquoi
// le module refuse de publier un TWR quand les flux historiques sont absents ou incohérents.
//
// Ce qui est calculé séparément, jamais fondu dans un chiffre unique :
//   plus-value latente · plus-value réalisée · dividendes reçus · frais · rendement total ·
//   performance annualisée · TWR · XIRR (quand les flux le permettent).
//
// Module PUR, testé dans tests/portfolio-performance.test.mjs.

import { instrumentKey, type AccountModel, type AccountOperation, type PortfolioPosition } from "./portfolio-account.ts";

const EPS = 1e-9;
const MS_PER_DAY = 86_400_000;

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
function daysBetween(from: string, to: string): number {
  return (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / MS_PER_DAY;
}

// ==========================================================================================
// FLUX EXTERNES
// ==========================================================================================
export type ExternalFlow = { date: string; amountEur: number; type: "versement" | "retrait" };

/** Versements (+) et retraits (−) convertis en devise de référence. Rien d'autre n'est un flux. */
export function externalFlows(operations: AccountOperation[], toReference: (op: AccountOperation, amount: number) => number | null): ExternalFlow[] {
  const flows: ExternalFlow[] = [];
  for (const operation of operations) {
    if (operation.type !== "versement" && operation.type !== "retrait") continue;
    const native = operation.netAmount !== null && operation.netAmount !== undefined
      ? Math.abs(num(operation.netAmount))
      : Math.abs(num(operation.grossAmount));
    const amount = toReference(operation, native);
    if (amount === null) continue;
    flows.push({ date: operation.date, amountEur: operation.type === "versement" ? amount : -amount, type: operation.type });
  }
  return flows.sort((a, b) => a.date.localeCompare(b.date));
}

export type FlowReliability = {
  reliable: boolean;
  hasFlows: boolean;
  /** La trésorerie devient négative : des apports historiques manquent. */
  negativeCash: boolean;
  minCashEur: number;
  reason: string | null;
};

/**
 * Les flux sont-ils exploitables ? Deux conditions, toutes deux vérifiables sans rien supposer :
 * il existe au moins un versement, et la trésorerie reconstruite ne devient jamais négative.
 * Une trésorerie négative est la signature d'achats sans apport en contrepartie — l'historique
 * est alors incomplet, et tout TWR/XIRR calculé dessus serait une fiction bien formatée.
 */
export function assessFlows(model: AccountModel, flows: ExternalFlow[], minCashEur: number): FlowReliability {
  const hasFlows = flows.length > 0;
  const negativeCash = minCashEur < -1;
  if (!hasFlows && model.positions.length > 0) {
    return { reliable: false, hasFlows, negativeCash, minCashEur, reason: "Aucun versement n'est enregistré : les apports historiques n'ont pas été rapprochés." };
  }
  if (negativeCash) {
    return { reliable: false, hasFlows, negativeCash, minCashEur, reason: "La trésorerie reconstruite devient négative : des versements ou transferts entrants manquent." };
  }
  return { reliable: true, hasFlows, negativeCash, minCashEur, reason: null };
}

/** Trésorerie minimale atteinte au fil des opérations (détecte les apports manquants). */
export function minimumCash(operations: AccountOperation[], cashDeltaOf: (op: AccountOperation) => number): number {
  let cash = 0;
  let minimum = 0;
  for (const operation of [...operations].sort((a, b) => a.date.localeCompare(b.date))) {
    cash += cashDeltaOf(operation);
    if (cash < minimum) minimum = cash;
  }
  return minimum;
}

// ==========================================================================================
// TWR (rendement pondéré par le temps) — les flux externes ne créent PAS de performance
// ==========================================================================================
export type ValuationPoint = { date: string; valueEur: number };

/**
 * TWR chaîné par sous-période (Dietz modifié). Une sous-période dont le capital de départ est nul
 * ou négatif est IGNORÉE plutôt que forcée : diviser par un capital nul produit un pourcentage
 * infini, pas une performance.
 */
export function computeTwr(valuations: ValuationPoint[], flows: ExternalFlow[]): { twrPct: number | null; periods: number } {
  if (valuations.length < 2) return { twrPct: null, periods: 0 };
  let factor = 1;
  let periods = 0;
  for (let index = 1; index < valuations.length; index += 1) {
    const start = valuations[index - 1];
    const end = valuations[index];
    const span = daysBetween(start.date, end.date);
    if (span <= 0) continue;
    const inPeriod = flows.filter((flow) => flow.date > start.date && flow.date <= end.date);
    const netFlow = inPeriod.reduce((sum, flow) => sum + flow.amountEur, 0);
    const weighted = inPeriod.reduce((sum, flow) => sum + flow.amountEur * (daysBetween(flow.date, end.date) / span), 0);
    const base = start.valueEur + weighted;
    if (base <= EPS) continue;
    factor *= 1 + (end.valueEur - start.valueEur - netFlow) / base;
    periods += 1;
  }
  return periods === 0 ? { twrPct: null, periods: 0 } : { twrPct: (factor - 1) * 100, periods };
}

/**
 * Courbe de performance CUMULÉE, point par point, sur la même mécanique que `computeTwr`.
 *
 * C'est cette série — et non « valeur ÷ montant investi » — qui est comparable à un indice : elle
 * démarre à 0 % et un versement n'y produit aucun saut. Tracer la valeur brute face à un indice
 * ferait passer chaque apport d'argent pour une surperformance.
 */
export function twrSeries(valuations: ValuationPoint[], flows: ExternalFlow[]): NormalizedPoint[] {
  if (valuations.length === 0) return [];
  const series: NormalizedPoint[] = [{ date: valuations[0].date, pct: 0 }];
  let factor = 1;
  for (let index = 1; index < valuations.length; index += 1) {
    const start = valuations[index - 1];
    const end = valuations[index];
    const span = daysBetween(start.date, end.date);
    if (span > 0) {
      const inPeriod = flows.filter((flow) => flow.date > start.date && flow.date <= end.date);
      const netFlow = inPeriod.reduce((sum, flow) => sum + flow.amountEur, 0);
      const weighted = inPeriod.reduce((sum, flow) => sum + flow.amountEur * (daysBetween(flow.date, end.date) / span), 0);
      const base = start.valueEur + weighted;
      // Un capital de départ nul (mois antérieurs au premier achat) ne fait pas progresser la
      // courbe : elle reste à son niveau plutôt que d'afficher un bond artificiel.
      if (base > EPS) factor *= 1 + (end.valueEur - start.valueEur - netFlow) / base;
    }
    series.push({ date: end.date, pct: (factor - 1) * 100 });
  }
  return series;
}

// ==========================================================================================
// XIRR — taux actuariel sur flux datés
// ==========================================================================================
/**
 * Newton-Raphson avec repli par bissection. Renvoie `null` plutôt qu'un chiffre douteux quand les
 * flux ne changent jamais de signe (pas de solution économique) ou que la recherche ne converge pas.
 */
export function computeXirr(cashFlows: Array<{ date: string; amountEur: number }>): number | null {
  if (cashFlows.length < 2) return null;
  const sorted = [...cashFlows].sort((a, b) => a.date.localeCompare(b.date));
  const hasPositive = sorted.some((flow) => flow.amountEur > EPS);
  const hasNegative = sorted.some((flow) => flow.amountEur < -EPS);
  if (!hasPositive || !hasNegative) return null;
  const origin = sorted[0].date;
  const npv = (rate: number) => sorted.reduce((sum, flow) => sum + flow.amountEur / Math.pow(1 + rate, daysBetween(origin, flow.date) / 365), 0);

  let rate = 0.1;
  for (let iteration = 0; iteration < 60; iteration += 1) {
    const value = npv(rate);
    const derivative = (npv(rate + 1e-6) - value) / 1e-6;
    if (!Number.isFinite(derivative) || Math.abs(derivative) < 1e-12) break;
    const next = rate - value / derivative;
    if (!Number.isFinite(next) || next <= -0.999) break;
    if (Math.abs(next - rate) < 1e-9) return next * 100;
    rate = next;
  }
  let low = -0.9;
  let high = 10;
  if (npv(low) * npv(high) > 0) return null;
  for (let iteration = 0; iteration < 200; iteration += 1) {
    const mid = (low + high) / 2;
    if (npv(low) * npv(mid) <= 0) high = mid;
    else low = mid;
  }
  const solution = (low + high) / 2;
  return Number.isFinite(solution) ? solution * 100 : null;
}

// ==========================================================================================
// PLUS-VALUE RÉALISÉE
// ==========================================================================================
/**
 * Plus/moins-value effectivement encaissée sur les ventes, au coût moyen pondéré — la même
 * méthode que le moteur de positions, pour que réalisé et latent restent additionnables.
 * Un transfert sortant n'est PAS une vente : il ne réalise rien, il déplace la position.
 */
export function computeRealizedGain(operations: AccountOperation[], toReference: (op: AccountOperation, amount: number) => number | null): { realizedEur: number; sales: number; unconverted: number } {
  const holdings = new Map<string, { quantity: number; cost: number }>();
  let realized = 0;
  let sales = 0;
  let unconverted = 0;
  for (const operation of [...operations].sort((a, b) => a.date.localeCompare(b.date))) {
    const key = instrumentKey(operation);
    const entry = holdings.get(key) ?? { quantity: 0, cost: 0 };
    const gross = operation.grossAmount !== null && operation.grossAmount !== undefined
      ? Math.abs(num(operation.grossAmount))
      : Math.abs(num(operation.quantity) * num(operation.unitPrice));
    const fees = Math.abs(num(operation.fees));

    if (operation.type === "achat" || operation.type === "transfer_in" || (operation.type === "correction" && num(operation.quantity) > 0)) {
      const cost = toReference(operation, gross + fees);
      entry.quantity += num(operation.quantity);
      if (cost !== null) entry.cost += cost;
      else unconverted += 1;
    } else if (operation.type === "vente") {
      const soldQuantity = Math.min(num(operation.quantity), entry.quantity);
      const averageCost = entry.quantity > EPS ? entry.cost / entry.quantity : 0;
      const proceeds = toReference(operation, Math.max(0, gross - fees));
      if (proceeds !== null) {
        realized += proceeds - averageCost * soldQuantity;
        sales += 1;
      } else unconverted += 1;
      entry.quantity -= num(operation.quantity);
      entry.cost -= averageCost * soldQuantity;
    } else if (operation.type === "transfer_out" || (operation.type === "correction" && num(operation.quantity) < 0)) {
      const removed = Math.min(Math.abs(num(operation.quantity)), entry.quantity);
      const averageCost = entry.quantity > EPS ? entry.cost / entry.quantity : 0;
      entry.quantity -= removed;
      entry.cost -= averageCost * removed;
    }
    if (entry.quantity < EPS) {
      entry.quantity = 0;
      entry.cost = 0;
    }
    holdings.set(key, entry);
  }
  return { realizedEur: realized, sales, unconverted };
}

// ==========================================================================================
// CLASSEMENT DES POSITIONS
// ==========================================================================================
export type RankedPosition = {
  key: string;
  name: string;
  ticker: string | null;
  isin: string | null;
  currency: string;
  valueEur: number | null;
  costEur: number;
  gainEur: number | null;
  gainPct: number | null;
  weightPct: number;
  /** Part de la plus-value totale imputable à cette ligne (peut être négative). */
  contributionPct: number | null;
  /** La ligne ne peut pas être classée en pourcentage (coût nul : transfert sans prix de revient). */
  percentUnavailable: boolean;
};

export type PositionRanking = {
  criterion: "percent" | "contribution";
  best: RankedPosition[];
  worst: RankedPosition[];
  excluded: Array<{ key: string; name: string; reason: "no_price" | "no_cost" }>;
};

/**
 * Classement top / flop. Deux critères, parce qu'ils ne racontent pas la même chose : un +80 % sur
 * une ligne de 300 € pèse moins qu'un +6 % sur une ligne de 40 000 €, et n'afficher que l'un des
 * deux donne une image fausse du portefeuille.
 *
 * Cas traités explicitement : coût nul (transfert entrant sans prix de revient) → exclu du
 * classement en %, conservé en € ; position sans cours → exclue des deux, listée à part.
 */
export function rankPositions(positions: PortfolioPosition[], criterion: "percent" | "contribution", size = 3): PositionRanking {
  const excluded: PositionRanking["excluded"] = [];
  const totalGain = positions.reduce((sum, position) => sum + Math.abs(position.gainEur ?? 0), 0);
  const ranked: RankedPosition[] = [];
  for (const position of positions) {
    if (position.currentValueEur === null || position.gainEur === null) {
      excluded.push({ key: position.key, name: position.name, reason: "no_price" });
      continue;
    }
    const percentUnavailable = position.investedEur <= EPS || position.gainPct === null;
    if (criterion === "percent" && percentUnavailable) {
      excluded.push({ key: position.key, name: position.name, reason: "no_cost" });
      continue;
    }
    ranked.push({
      key: position.key,
      name: position.name,
      ticker: position.ticker,
      isin: position.isin,
      currency: position.currency,
      valueEur: position.currentValueEur,
      costEur: position.investedEur,
      gainEur: position.gainEur,
      gainPct: position.gainPct,
      weightPct: position.weightPct,
      contributionPct: totalGain > EPS ? (position.gainEur / totalGain) * 100 : null,
      percentUnavailable,
    });
  }
  const score = (item: RankedPosition) => (criterion === "percent" ? item.gainPct ?? 0 : item.gainEur ?? 0);
  const sorted = [...ranked].sort((a, b) => score(b) - score(a));
  return {
    criterion,
    best: sorted.slice(0, size),
    worst: [...sorted].reverse().slice(0, size),
    excluded,
  };
}

// ==========================================================================================
// RISQUES
// ==========================================================================================
export type RiskLevel = "low" | "watch" | "high";
export type RiskIndicator = {
  key: string;
  label: string;
  valuePct: number | null;
  level: RiskLevel;
  levelLabel: string;
  detail: string;
};

function levelFor(value: number | null, watch: number, high: number): { level: RiskLevel; levelLabel: string } {
  if (value === null) return { level: "watch", levelLabel: "Inconnu" };
  if (value >= high) return { level: "high", levelLabel: "Élevé" };
  if (value >= watch) return { level: "watch", levelLabel: "À surveiller" };
  return { level: "low", levelLabel: "Maîtrisé" };
}

export function computeRiskIndicators(input: {
  positions: PortfolioPosition[];
  geographyTopPct: number | null;
  geographyTopLabel: string | null;
  sectorTopPct: number | null;
  sectorTopLabel: string | null;
  coveragePercent: number;
}): RiskIndicator[] {
  const valued = input.positions.filter((position) => position.currentValueEur !== null).sort((a, b) => (b.currentValueEur ?? 0) - (a.currentValueEur ?? 0));
  const total = valued.reduce((sum, position) => sum + (position.currentValueEur ?? 0), 0);
  const share = (count: number) => (total > EPS ? (valued.slice(0, count).reduce((sum, position) => sum + (position.currentValueEur ?? 0), 0) / total) * 100 : null);
  const top1 = share(1);
  const top3 = share(3);

  const indicators: RiskIndicator[] = [
    { key: "top1", label: "Première position", valuePct: top1, ...levelFor(top1, 15, 25), detail: valued[0]?.name ?? "—" },
    { key: "top3", label: "Top 3 positions", valuePct: top3, ...levelFor(top3, 35, 50), detail: valued.slice(0, 3).map((position) => position.name).join(", ") || "—" },
  ];
  if (input.geographyTopPct !== null) {
    indicators.push({ key: "geo", label: "Concentration géographique", valuePct: input.geographyTopPct, ...levelFor(input.geographyTopPct, 40, 55), detail: input.geographyTopLabel ?? "—" });
  }
  if (input.sectorTopPct !== null) {
    indicators.push({ key: "sector", label: "Concentration sectorielle", valuePct: input.sectorTopPct, ...levelFor(input.sectorTopPct, 30, 45), detail: input.sectorTopLabel ?? "—" });
  }
  const coverage = input.coveragePercent;
  indicators.push({
    key: "coverage",
    label: "Couverture des données",
    valuePct: coverage,
    level: coverage >= 99.5 ? "low" : coverage >= 80 ? "watch" : "high",
    levelLabel: coverage >= 99.5 ? "Complète" : coverage >= 80 ? "Partielle" : "Insuffisante",
    detail: coverage >= 99.5 ? "Toutes les positions sont valorisées" : "Certaines positions ne sont pas valorisées",
  });
  return indicators;
}

// ==========================================================================================
// BENCHMARK
// ==========================================================================================
export type BenchmarkPoint = { date: string; close: number };
export type NormalizedPoint = { date: string; pct: number };

/** Rebase une série sur 0 % à sa première valeur exploitable de la fenêtre. */
export function normalizeBenchmark(points: BenchmarkPoint[], from: string | null, to: string | null): NormalizedPoint[] {
  const window = points
    .filter((point) => (!from || point.date >= from) && (!to || point.date <= to) && Number.isFinite(point.close) && point.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (window.length === 0) return [];
  const base = window[0].close;
  return window.map((point) => ({ date: point.date, pct: (point.close / base - 1) * 100 }));
}

// ==========================================================================================
// MODÈLE COMPLET
// ==========================================================================================
export type PerformanceModel = {
  unrealizedGainEur: number | null;
  unrealizedGainPct: number | null;
  realizedGainEur: number;
  dividendsNetEur: number;
  dividendsGrossEur: number;
  feesEur: number;
  /** Résultat total = latent + réalisé + dividendes − frais. Jamais un simple ratio. */
  totalReturnEur: number | null;
  totalReturnPct: number | null;
  annualizedPct: number | null;
  twrPct: number | null;
  xirrPct: number | null;
  flows: FlowReliability;
  /** Le compte a-t-il un historique suffisant pour publier une performance de période ? */
  isReliable: boolean;
  unreliableReason: string | null;
  firstDate: string | null;
  years: number | null;
  coveragePercent: number;
};

export type PerformanceInput = {
  model: AccountModel;
  operations: AccountOperation[];
  today: string;
  toReference: (operation: AccountOperation, amount: number) => number | null;
  cashDeltaOf: (operation: AccountOperation) => number;
  valuations: ValuationPoint[];
};

export function computePerformanceModel(input: PerformanceInput): PerformanceModel {
  const { model, operations, today } = input;
  const flows = externalFlows(operations, input.toReference);
  const reliability = assessFlows(model, flows, minimumCash(operations, input.cashDeltaOf));
  const realized = computeRealizedGain(operations, input.toReference);

  const totalReturnEur = model.unrealizedGainEur === null
    ? null
    : model.unrealizedGainEur + realized.realizedEur + model.dividendsNetEur - model.feesEur;
  // Le dénominateur du rendement total est le CAPITAL RÉELLEMENT ENGAGÉ sur les positions
  // valorisées (leur prix de revient) — pas le net investi, qui peut être nul ici, ni la valeur
  // actuelle, qui donnerait un pourcentage flatteur en cas de hausse.
  const base = model.valuationCoverage.valuedCostEur;
  const totalReturnPct = totalReturnEur === null || base <= EPS ? null : (totalReturnEur / base) * 100;

  const firstDate = model.startDate;
  const years = firstDate ? Math.max(daysBetween(firstDate, today) / 365, 0) : null;
  const annualizedPct = totalReturnPct === null || years === null || years < 0.25
    ? null
    : (Math.pow(1 + totalReturnPct / 100, 1 / years) - 1) * 100;

  const twr = reliability.reliable ? computeTwr(input.valuations, flows) : { twrPct: null, periods: 0 };
  const xirr = reliability.reliable && model.totalValueEur !== null
    ? computeXirr([
        ...flows.map((flow) => ({ date: flow.date, amountEur: -flow.amountEur })),
        { date: today, amountEur: model.totalValueEur },
      ])
    : null;

  return {
    unrealizedGainEur: model.unrealizedGainEur,
    unrealizedGainPct: model.unrealizedGainPct,
    realizedGainEur: realized.realizedEur,
    dividendsNetEur: model.dividendsNetEur,
    dividendsGrossEur: model.dividendsGrossEur,
    feesEur: model.feesEur,
    totalReturnEur,
    totalReturnPct,
    annualizedPct: reliability.reliable ? annualizedPct : null,
    twrPct: twr.twrPct,
    xirrPct: xirr,
    flows: reliability,
    isReliable: reliability.reliable,
    unreliableReason: reliability.reason,
    firstDate,
    years,
    coveragePercent: model.valuationCoverage.coveragePercent,
  };
}
