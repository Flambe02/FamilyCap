// Revenus (dividendes) d'un compte PEA / compte-titres — modèle unique de l'onglet « Revenus ».
//
// TROIS CATÉGORIES STRICTEMENT SÉPARÉES, jamais additionnées sans le dire :
//
//   « reçu »     — une opération RÉELLE de type `dividende` dans `account_operations`. C'est la
//                  seule catégorie qui constitue un fait comptable. Rien ici n'est déduit, et ce
//                  module n'écrit jamais : une estimation ne crée JAMAIS une opération.
//   « annoncé »  — un événement officiellement déclaré (société / fournisseur de données), avec
//                  date de détachement, date de paiement, montant par action et devise. Il n'est
//                  pas encaissé : c'est une annonce, pas une recette.
//   « estimé »   — une projection construite à partir du dernier dividende comparable connu du
//                  MÊME instrument. Toujours badgée « Estimé », toujours accompagnée de sa source
//                  et de sa date de référence.
//
// QUANTITÉ ÉLIGIBLE : calculée à la DATE DE DÉTACHEMENT à partir des opérations, pas la quantité
// détenue aujourd'hui. Un titre acheté après le détachement ne donne droit à rien, et l'ancienne
// approximation (« quantité actuelle ») surestimait mécaniquement tout portefeuille en croissance.
//
// FISCALITÉ :
//   PEA — aucun prélèvement n'est appliqué par dividende. Les dividendes encaissés dans le plan ne
//         subissent pas le PFU tant que le plan reste ouvert ; l'imposition est différée au
//         retrait. Appliquer 30 % à chaque ligne serait une désinformation fiscale.
//   CTO — taux paramétrable. Sans paramétrage, l'hypothèse PFU 30 % est appliquée et ANNONCÉE
//         comme une hypothèse (`netIsEstimated: true`), jamais comme un net certain.
//
// Module PUR, testé dans tests/dividend-income.test.mjs.

import { instrumentKey, type AccountOperation, type AccountType, type PortfolioPosition } from "./portfolio-account.ts";
import { normalizeInstrumentName } from "./instrument-alias.ts";

/** Prélèvement forfaitaire unique : 12,8 % d'impôt + 17,2 % de prélèvements sociaux. */
export const DEFAULT_FLAT_TAX_RATE = 0.3;

export type DividendStatus = "received" | "announced" | "estimated";

export type AnnouncedDividendRow = {
  id: string;
  exDate: string;
  paymentDate: string | null;
  amountPerShare: number | null;
  currency: string | null;
  status: string | null;
  provider: string | null;
  asset: { name: string | null; symbol: string | null; isin: string | null } | null;
};

export type DividendEntry = {
  id: string;
  status: DividendStatus;
  instrumentKey: string | null;
  name: string;
  ticker: string | null;
  isin: string | null;
  /** Détachement. `null` pour un dividende reçu dont seule la date d'encaissement est connue. */
  exDate: string | null;
  paymentDate: string | null;
  /** Date retenue pour le calendrier mensuel (paiement si connu, sinon détachement). */
  scheduleDate: string;
  amountPerShare: number | null;
  currency: string;
  eligibleQuantity: number | null;
  grossNative: number | null;
  grossReference: number | null;
  netReference: number | null;
  /** Le net est une HYPOTHÈSE fiscale, pas un montant confirmé par un relevé. */
  netIsEstimated: boolean;
  taxRateApplied: number | null;
  source: string;
  sourceAsOf: string | null;
  /** Conversion impossible faute de taux : le montant en devise de référence reste `null`. */
  conversionUnavailable: boolean;
};

export type MonthlyIncomePoint = {
  monthKey: string;
  monthIndex: number;
  label: string;
  receivedEur: number;
  announcedEur: number;
  estimatedEur: number;
  totalEur: number;
};

export type IncomeContributor = { key: string; name: string; annualEur: number; pct: number; status: DividendStatus };

export type DividendCoverage = {
  totalInstruments: number;
  analysedInstruments: number;
  distributing: number;
  accumulating: number;
  unknown: number;
  details: Array<{ key: string; name: string; reason: "accumulating" | "no_data" | "no_price" | "documented" }>;
  coveragePercent: number;
};

export type DividendIncomeModel = {
  accountType: AccountType;
  referenceCurrency: string;
  year: number;
  entries: DividendEntry[];
  monthly: MonthlyIncomePoint[];
  /** Σ des 12 prochains mois, toutes catégories (annoncé + estimé + déjà reçu sur la période). */
  expected12mEur: number;
  monthlyAverageEur: number;
  receivedThisYearEur: number;
  receivedTotalEur: number;
  portfolioYieldPct: number | null;
  upcoming: DividendEntry[];
  contributors: IncomeContributor[];
  quickRead: {
    bestMonthLabel: string | null;
    bestMonthPct: number | null;
    topContributorName: string | null;
    topContributorPct: number | null;
    monthsWithoutIncome: number;
  };
  coverage: DividendCoverage;
  taxNote: string;
  hasRealDividendOperations: boolean;
};

const MONTHS_SHORT = ["Janv.", "Févr.", "Mars", "Avr.", "Mai", "Juin", "Juil.", "Août", "Sept.", "Oct.", "Nov.", "Déc."];
const EPS = 1e-9;

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Un ETF/fonds CAPITALISANT ne verse rien en espèces : il réinvestit. Lui projeter un dividende
 * produirait un revenu qui n'arrivera jamais sur le compte.
 *
 * La détection est volontairement conservatrice — un faux positif prive l'utilisateur d'un revenu
 * réel. On n'accepte que des marqueurs NON ambigus, en fin de libellé ou isolés (« ACC », « (C) »,
 * « CAPITALISANT »), et uniquement pour un ETF ou un fonds : « Accor » reste une action qui
 * distribue, et le mot « Acc » au milieu d'un nom d'entreprise n'a rien à voir.
 */
export function isAccumulating(instrument: { name: string | null; assetType?: PortfolioPosition["assetType"] | null }): boolean {
  const assetType = instrument.assetType ?? null;
  if (assetType !== null && assetType !== "etf" && assetType !== "fund") return false;
  const name = String(instrument.name ?? "").toUpperCase();
  if (!name) return false;
  return /(^|[\s(\-–])(ACC|ACCUMULATING|CAPITALISANT|CAPITALISATION)([\s)\-–]|$)/.test(name)
    || /[\s(\-–]C\s+(EUR|USD|GBP|CHF)\s+ACC([\s)]|$)/.test(name)
    || /\(C\)\s*$/.test(name);
}

/** Quantité détenue à une date donnée, reconstruite depuis les opérations (jamais « aujourd'hui »). */
export function quantityAtDate(operations: AccountOperation[], key: string, date: string): number {
  let quantity = 0;
  for (const operation of operations) {
    if (instrumentKey(operation) !== key) continue;
    if (operation.date > date) continue;
    if (operation.type === "achat" || operation.type === "transfer_in") quantity += num(operation.quantity);
    else if (operation.type === "vente" || operation.type === "transfer_out") quantity -= num(operation.quantity);
    else if (operation.type === "correction") quantity += num(operation.quantity);
  }
  return quantity > EPS ? quantity : 0;
}

function addYears(date: string, years: number): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCFullYear(next.getUTCFullYear() + years);
  return next.toISOString().slice(0, 10);
}
function daysBetween(from: string, to: string): number {
  return Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000);
}
function dayOfYear(date: string): number {
  const parsed = new Date(`${date}T00:00:00Z`);
  return Math.floor((parsed.getTime() - Date.UTC(parsed.getUTCFullYear(), 0, 0)) / 86_400_000);
}
/**
 * Écart entre deux dates ramené au CYCLE ANNUEL. C'est ce qui permet de reconnaître que le
 * 19 décembre 2024 et le 21 décembre 2025 sont la même échéance annuelle, et non deux échéances
 * distinctes — sans quoi un instrument recevrait autant de projections qu'il a d'années
 * d'historique.
 */
function annualSlotDistance(a: string, b: string): number {
  const raw = Math.abs(dayOfYear(a) - dayOfYear(b));
  return Math.min(raw, 365 - raw);
}

/** Horizon de projection : 12 mois glissants, l'horizon exactement affiché par l'écran. */
const PROJECTION_HORIZON_DAYS = 372;
/** Une projection tombant à moins de 45 jours d'une annonce réelle est abandonnée (doublon). */
const ALREADY_ANNOUNCED_WINDOW_DAYS = 45;

export type FxResolver = (currency: string, date: string) => number | null;

export type DividendIncomeInput = {
  operations: AccountOperation[];
  positions: PortfolioPosition[];
  announced: AnnouncedDividendRow[];
  accountType: AccountType;
  today: string;
  referenceCurrency?: string;
  /** Taux natif → devise de référence à une date. Aucun 1:1 implicite. */
  fxRateAt?: FxResolver;
  /** Taux d'imposition du CTO (0 → 1). `null` = non paramétré → hypothèse PFU annoncée. */
  ctoTaxRate?: number | null;
  /** Valeur des positions, pour le rendement du portefeuille. */
  positionsValueEur?: number | null;
  /** Année affichée dans l'histogramme (défaut : année de `today`). */
  year?: number;
};

function identityOf(asset: AnnouncedDividendRow["asset"]): { key: string | null; name: string; ticker: string | null; isin: string | null } {
  if (!asset) return { key: null, name: "Actif non identifié", ticker: null, isin: null };
  return {
    key: instrumentKey({ isin: asset.isin, ticker: asset.symbol, assetName: asset.name }),
    name: asset.name?.trim() || asset.symbol || "Actif",
    ticker: asset.symbol,
    isin: asset.isin,
  };
}

function convert(amount: number | null, currency: string, referenceCurrency: string, date: string, fxRateAt?: FxResolver): number | null {
  if (amount === null) return null;
  if (currency.toUpperCase() === referenceCurrency) return amount;
  const rate = fxRateAt?.(currency.toUpperCase(), date) ?? null;
  return rate !== null && Number.isFinite(rate) && rate > 0 ? amount * rate : null;
}

export function computeDividendIncome(input: DividendIncomeInput): DividendIncomeModel {
  const referenceCurrency = (input.referenceCurrency || "EUR").toUpperCase();
  const { operations, positions, accountType, today } = input;
  const year = input.year ?? Number(today.slice(0, 4));
  const isCto = accountType === "CTO";
  const taxRate = isCto ? (input.ctoTaxRate ?? DEFAULT_FLAT_TAX_RATE) : null;
  const taxRateIsAssumed = isCto && (input.ctoTaxRate === null || input.ctoTaxRate === undefined);
  const positionByKey = new Map(positions.map((position) => [position.key, position]));

  const entries: DividendEntry[] = [];

  // ---- 1. REÇUS — uniquement des opérations réelles -----------------------------------------
  const realDividends = operations.filter((operation) => operation.type === "dividende");
  for (const operation of realDividends) {
    const key = instrumentKey(operation);
    const currency = (operation.currency || referenceCurrency).toUpperCase();
    // Le brut est celui inscrit sur l'opération. On ne le RECONSTITUE jamais depuis le net : la
    // retenue réelle n'est pas toujours le taux théorique, et l'inventer fabriquerait un impôt.
    const gross = operation.grossAmount !== null && operation.grossAmount !== undefined ? Math.abs(num(operation.grossAmount)) : null;
    const net = operation.netAmount !== null && operation.netAmount !== undefined ? Math.abs(num(operation.netAmount)) : gross;
    const rateOnOperation = Number(operation.exchangeRate);
    const useRecorded = Number.isFinite(rateOnOperation) && rateOnOperation > 0;
    const grossReference = gross === null ? null : useRecorded ? gross * rateOnOperation : convert(gross, currency, referenceCurrency, operation.date, input.fxRateAt);
    const netReference = net === null ? null : useRecorded ? net * rateOnOperation : convert(net, currency, referenceCurrency, operation.date, input.fxRateAt);
    entries.push({
      id: `op:${operation.id}`,
      status: "received",
      instrumentKey: key,
      name: operation.assetName?.trim() || "Dividende",
      ticker: operation.ticker,
      isin: operation.isin,
      exDate: null,
      paymentDate: operation.date,
      scheduleDate: operation.date,
      amountPerShare: null,
      currency,
      eligibleQuantity: null,
      grossNative: gross,
      grossReference,
      netReference,
      netIsEstimated: false, // un encaissement réel : le net est celui du relevé
      taxRateApplied: null,
      source: operation.source?.trim() || "Opération enregistrée",
      sourceAsOf: operation.date,
      conversionUnavailable: netReference === null && net !== null,
    });
  }

  // ---- 2. ANNONCÉS + 3. ESTIMÉS -------------------------------------------------------------
  const announcedByAsset = new Map<string, AnnouncedDividendRow[]>();
  for (const row of input.announced) {
    if (row.amountPerShare === null) continue;
    const { key } = identityOf(row.asset);
    if (!key) continue;
    announcedByAsset.set(key, [...(announcedByAsset.get(key) ?? []), row]);
  }

  const buildScheduled = (
    row: AnnouncedDividendRow,
    status: "announced" | "estimated",
    exDate: string,
    paymentDate: string | null,
    referenceYear: number | null,
  ): DividendEntry | null => {
    const identity = identityOf(row.asset);
    if (!identity.key) return null;
    const position = positionByKey.get(identity.key) ?? null;
    // Un ETF capitalisant ne verse rien : ni annonce à afficher comme espèces, ni projection.
    if (isAccumulating({ name: position?.name ?? identity.name, assetType: position?.assetType ?? null })) return null;
    const eligibleQuantity = quantityAtDate(operations, identity.key, exDate);
    const currency = (row.currency || position?.currency || referenceCurrency).toUpperCase();
    const amountPerShare = row.amountPerShare;
    const grossNative = amountPerShare === null ? null : amountPerShare * eligibleQuantity;
    const grossReference = convert(grossNative, currency, referenceCurrency, exDate, input.fxRateAt);
    const netReference = grossReference === null || taxRate === null ? grossReference : grossReference * (1 - taxRate);
    return {
      id: status === "estimated" ? `${row.id}:estimated:${exDate}` : `ca:${row.id}`,
      status,
      instrumentKey: identity.key,
      name: position?.name ?? identity.name,
      ticker: identity.ticker,
      isin: identity.isin,
      exDate,
      paymentDate,
      scheduleDate: paymentDate ?? exDate,
      amountPerShare,
      currency,
      eligibleQuantity,
      grossNative,
      grossReference,
      netReference,
      // PEA : `netReference === grossReference`, et ce n'est pas une estimation — c'est
      // l'absence de prélèvement dans l'enveloppe. CTO : hypothèse tant que le taux n'est
      // pas paramétré.
      netIsEstimated: isCto && taxRateIsAssumed,
      taxRateApplied: taxRate,
      source: status === "estimated"
        ? `Projection sur le dernier dividende connu${referenceYear ? ` (${referenceYear})` : ""}`
        : `Annonce ${row.provider ?? "fournisseur"}`,
      sourceAsOf: status === "estimated" ? row.exDate : row.exDate,
      conversionUnavailable: grossReference === null && grossNative !== null,
    };
  };

  for (const [, rows] of announcedByAsset) {
    for (const row of rows) {
      // Une annonce est « annoncée » tant que son détachement n'est pas passé ; au-delà, elle
      // reste un fait historique du fournisseur, utile à la projection mais pas un revenu à venir.
      const entry = buildScheduled(row, "announced", row.exDate, row.paymentDate, null);
      if (entry) entries.push(entry);
    }
    // ---- Projection ------------------------------------------------------------------------
    // Un instrument peut verser plusieurs fois par an (acompte de décembre, solde de mai…). On
    // identifie donc ses ÉCHÉANCES ANNUELLES — les « créneaux » —, puis on projette la prochaine
    // occurrence de chacun, à partir de son observation la plus récente.
    //
    // Deux erreurs sont évitées ici. Projeter depuis CHAQUE annonce produirait autant de lignes
    // que d'années d'historique pour le même créneau. Et projeter systématiquement « +1 an »
    // depuis la dernière annonce connue donnerait une date déjà passée quand l'historique du
    // fournisseur s'arrête un an en arrière : on avance donc d'autant d'années que nécessaire
    // pour retomber sur une date à venir.
    const sortedRows = [...rows].sort((a, b) => b.exDate.localeCompare(a.exDate));
    const seeds: AnnouncedDividendRow[] = [];
    for (const row of sortedRows) {
      if (row.amountPerShare === null) continue;
      if (seeds.some((seed) => annualSlotDistance(seed.exDate, row.exDate) <= ALREADY_ANNOUNCED_WINDOW_DAYS)) continue;
      seeds.push(row);
    }

    for (const seed of seeds) {
      let years = 1;
      let projectedExDate = addYears(seed.exDate, years);
      while (projectedExDate < today && years < 12) {
        years += 1;
        projectedExDate = addYears(seed.exDate, years);
      }
      if (projectedExDate < today || daysBetween(today, projectedExDate) > PROJECTION_HORIZON_DAYS) continue;
      // Une annonce réelle À VENIR pour la même échéance rend la projection inutile : on ne
      // double jamais une information confirmée par une supposition.
      const covered = rows.some((other) => other.exDate >= today && Math.abs(daysBetween(other.exDate, projectedExDate)) <= ALREADY_ANNOUNCED_WINDOW_DAYS);
      if (covered) continue;
      const entry = buildScheduled(
        seed,
        "estimated",
        projectedExDate,
        seed.paymentDate ? addYears(seed.paymentDate, years) : null,
        Number(seed.exDate.slice(0, 4)),
      );
      if (entry) entries.push(entry);
    }
  }

  entries.sort((a, b) => b.scheduleDate.localeCompare(a.scheduleDate));

  // ---- Calendrier mensuel de l'année affichée ------------------------------------------------
  const monthly: MonthlyIncomePoint[] = MONTHS_SHORT.map((label, index) => ({
    monthKey: `${year}-${String(index + 1).padStart(2, "0")}`,
    monthIndex: index,
    label,
    receivedEur: 0,
    announcedEur: 0,
    estimatedEur: 0,
    totalEur: 0,
  }));
  // Le graphique montre le BRUT par défaut ; le net est proposé en bascule côté composant, qui
  // relit `entries`. Ici on agrège ce qui est comparable : brut converti en devise du compte.
  for (const entry of entries) {
    if (!entry.scheduleDate.startsWith(String(year))) continue;
    const amount = entry.status === "received" ? entry.grossReference ?? entry.netReference : entry.grossReference;
    if (amount === null) continue;
    const point = monthly[Number(entry.scheduleDate.slice(5, 7)) - 1];
    if (!point) continue;
    if (entry.status === "received") point.receivedEur += amount;
    else if (entry.status === "announced") point.announcedEur += amount;
    else point.estimatedEur += amount;
    point.totalEur += amount;
  }

  // ---- Agrégats ------------------------------------------------------------------------------
  const horizonEnd = addYears(today, 1);
  const expected12mEur = entries
    .filter((entry) => entry.status !== "received" && entry.scheduleDate >= today && entry.scheduleDate <= horizonEnd)
    .reduce((sum, entry) => sum + (entry.grossReference ?? 0), 0);
  const receivedThisYearEur = entries
    .filter((entry) => entry.status === "received" && entry.scheduleDate.startsWith(String(year)))
    .reduce((sum, entry) => sum + (entry.netReference ?? entry.grossReference ?? 0), 0);
  const receivedTotalEur = entries
    .filter((entry) => entry.status === "received")
    .reduce((sum, entry) => sum + (entry.netReference ?? entry.grossReference ?? 0), 0);

  const twelveMonthBase = expected12mEur + entries
    .filter((entry) => entry.status === "received" && entry.scheduleDate >= addYears(today, -1) && entry.scheduleDate < today)
    .reduce((sum, entry) => sum + (entry.grossReference ?? 0), 0);
  const positionsValue = input.positionsValueEur ?? null;
  const portfolioYieldPct = positionsValue !== null && positionsValue > EPS && twelveMonthBase > EPS
    ? (twelveMonthBase / positionsValue) * 100
    : null;

  const upcoming = entries
    .filter((entry) => entry.status !== "received" && entry.scheduleDate >= today)
    .sort((a, b) => a.scheduleDate.localeCompare(b.scheduleDate))
    .slice(0, 4);

  // ---- Contributeurs (12 mois glissants, brut) -----------------------------------------------
  const contributorTotals = new Map<string, { name: string; amount: number; status: DividendStatus }>();
  for (const entry of entries) {
    if (entry.scheduleDate < addYears(today, -1) || entry.scheduleDate > horizonEnd) continue;
    const amount = entry.grossReference ?? 0;
    if (amount <= EPS) continue;
    const key = entry.instrumentKey ?? `name:${normalizeInstrumentName(entry.name)}`;
    const current = contributorTotals.get(key) ?? { name: entry.name, amount: 0, status: entry.status };
    current.amount += amount;
    // Un contributeur mêlant réel et estimé est présenté au niveau de fiabilité le plus faible.
    if (entry.status === "estimated") current.status = "estimated";
    else if (entry.status === "announced" && current.status === "received") current.status = "announced";
    contributorTotals.set(key, current);
  }
  const contributorTotal = [...contributorTotals.values()].reduce((sum, item) => sum + item.amount, 0);
  const contributors: IncomeContributor[] = [...contributorTotals.entries()]
    .map(([key, item]) => ({ key, name: item.name, annualEur: item.amount, pct: contributorTotal > EPS ? (item.amount / contributorTotal) * 100 : 0, status: item.status }))
    .sort((a, b) => b.annualEur - a.annualEur);

  const monthlyTotal = monthly.reduce((sum, point) => sum + point.totalEur, 0);
  const bestMonth = monthly.reduce<MonthlyIncomePoint | null>((best, point) => (best === null || point.totalEur > best.totalEur ? point : best), null);
  const monthsWithoutIncome = monthly.filter((point) => point.totalEur <= EPS).length;

  // ---- Couverture ----------------------------------------------------------------------------
  const details: DividendCoverage["details"] = [];
  let distributing = 0;
  let accumulating = 0;
  let unknown = 0;
  for (const position of positions) {
    if (isAccumulating({ name: position.name, assetType: position.assetType })) {
      accumulating += 1;
      details.push({ key: position.key, name: position.name, reason: "accumulating" });
      continue;
    }
    if (announcedByAsset.has(position.key)) {
      distributing += 1;
      details.push({ key: position.key, name: position.name, reason: "documented" });
      continue;
    }
    unknown += 1;
    details.push({ key: position.key, name: position.name, reason: position.currentValueEur === null ? "no_price" : "no_data" });
  }
  const analysedInstruments = distributing + accumulating;

  const taxNote = isCto
    ? taxRateIsAssumed
      ? `Net estimé sur hypothèse PFU ${Math.round(DEFAULT_FLAT_TAX_RATE * 100)} % (12,8 % d'impôt + 17,2 % de prélèvements sociaux). Renseignez votre taux réel dans les paramètres du compte.`
      : `Net calculé au taux paramétré de ${(Number(taxRate) * 100).toFixed(1).replace(".", ",")} %.`
    : "Dans un PEA, les dividendes ne subissent aucun prélèvement tant que le plan reste ouvert : l'imposition est différée au retrait. Aucun PFU n'est appliqué ici.";

  return {
    accountType,
    referenceCurrency,
    year,
    entries,
    monthly,
    expected12mEur,
    monthlyAverageEur: monthlyTotal / 12,
    receivedThisYearEur,
    receivedTotalEur,
    portfolioYieldPct,
    upcoming,
    contributors,
    quickRead: {
      bestMonthLabel: bestMonth && bestMonth.totalEur > EPS ? bestMonth.label : null,
      bestMonthPct: bestMonth && monthlyTotal > EPS ? (bestMonth.totalEur / monthlyTotal) * 100 : null,
      topContributorName: contributors[0]?.name ?? null,
      topContributorPct: contributors[0]?.pct ?? null,
      monthsWithoutIncome,
    },
    coverage: {
      totalInstruments: positions.length,
      analysedInstruments,
      distributing,
      accumulating,
      unknown,
      details,
      coveragePercent: positions.length > 0 ? (analysedInstruments / positions.length) * 100 : 100,
    },
    taxNote,
    hasRealDividendOperations: realDividends.length > 0,
  };
}
