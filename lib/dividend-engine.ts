// MOTEUR DE DIVIDENDES — modèle de lecture unique, partagé par le PEA et le compte-titres.
//
// Module PUR : aucun accès réseau, aucun accès Supabase, aucun React. Il est appelé côté serveur
// par les routes /api/investment-accounts/:id/dividends*. Testé dans tests/dividend-engine.test.mjs.
//
// TROIS CATÉGORIES, JAMAIS CONFONDUES
//   « reçu »     — une opération RÉELLE de type `dividende` dans `account_operations`. Seule
//                  catégorie qui constitue un fait comptable. Ce module n'écrit jamais : une
//                  projection ne crée JAMAIS une opération, et une synchronisation n'en efface
//                  jamais une.
//   « annoncé »  — un événement déclaré par la société ou un fournisseur, avec un montant par
//                  action. Ce n'est pas une recette : c'est une annonce.
//   « estimé »   — une projection interne déterministe (lib/dividend-projection.ts). Elle ne porte
//                  QU'UN MOIS, jamais une date exacte, et elle est toujours badgée.
//
// UNE SEULE PÉRIODE POUR TOUT
// L'ancien écran additionnait trois périmètres différents : un total sur 12 mois glissants HORS
// reçus, une moyenne mensuelle sur l'ANNÉE CIVILE reçus INCLUS, et un rendement sur une troisième
// base. Total et moyenne ne pouvaient pas se recouper. Ici, `window` définit une seule fenêtre
// [from, to] de `months` mois : le total, la ventilation mensuelle, la moyenne et le rendement
// prévisionnel en sortent tous. `moyenne = total ÷ months` est vraie par construction.
//
// DATE RETENUE — la convention, dite une fois
//   reçu     → la date de l'opération (l'encaissement réel).
//   annoncé  → la DATE DE PAIEMENT quand elle est publiée. Sinon, le mois est déduit du
//              détachement et `scheduleBasis` vaut "ex_date" : l'interface doit alors afficher
//              « Paiement : date non publiée » et ne JAMAIS présenter le détachement comme un
//              paiement.
//   estimé   → le mois probable, et rien d'autre.

import { instrumentKey, type AccountOperation, type AccountType, type PortfolioPosition } from "./portfolio-account.ts";
import { normalizeInstrumentName } from "./instrument-alias.ts";

const EPS = 1e-9;

export type DividendStatus = "received" | "announced" | "estimated" | "unavailable";
export type DividendType = "ordinary" | "special" | "interim" | "final" | "other";
export type DistributionPolicy = "distributing" | "accumulating" | "unknown";
export type Confidence = "high" | "medium" | "low";
export type ResolutionStatus = "resolved" | "needs_review" | "unresolved";
/** Sur quoi repose le mois affiché. « ex_date » signale un mois DÉDUIT, pas un paiement publié. */
export type ScheduleBasis = "payment" | "ex_date" | "estimated" | "received";

/** Ligne `dividend_events` telle que lue en base (fait d'instrument, jamais de compte). */
export type DividendEventRow = {
  id: string;
  assetId: string;
  isin: string | null;
  providerSymbol: string | null;
  status: Exclude<DividendStatus, "received">;
  dividendType: DividendType;
  declarationDate: string | null;
  exDate: string | null;
  recordDate: string | null;
  paymentDate: string | null;
  /** « YYYY-MM » — seul repère temporel d'une projection. */
  estimatedMonth: string | null;
  amountPerShare: number | null;
  currency: string | null;
  sourceProvider: string;
  sourceEventId: string | null;
  sourceUrl: string | null;
  confidence: Confidence;
  isSpecial: boolean;
  isForecast: boolean;
  lastSyncedAt: string | null;
};

/**
 * Pont entre un instrument du catalogue (`assets`) et les positions dérivées qui le désignent.
 *
 * `positionKeys` contient TOUTES les clés de position rattachées à cet instrument. C'est ce qui
 * répare le défaut Sanofi : l'opération porte `isin NULL, ticker 'SAN'` (clé `tkr:SAN`) alors que
 * la référence porte un ISIN (clé `isin:FR…`). Une clé unique calculée de chaque côté ne se
 * rencontrait jamais ; une LISTE de clés, construite par l'index d'alias, se rencontre toujours.
 */
export type DividendInstrument = {
  assetId: string;
  positionKeys: string[];
  name: string;
  isin: string | null;
  ticker: string | null;
  assetType: PortfolioPosition["assetType"] | null;
  distributionPolicy: DistributionPolicy;
  resolutionStatus: ResolutionStatus;
  providerSymbol: string | null;
  lastSyncedAt: string | null;
};

/** Profil fiscal du compte. `null` = non configuré → aucun net n'est présenté. */
export type AccountTaxProfile = {
  taxResidencyCountry: string | null;
  withholdingTaxRate: number | null;
  estimatedTaxRate: number | null;
  allowanceRate: number | null;
  showEstimatedNet: boolean;
};

export type FxResolver = (currency: string, date: string) => number | null;

export type DividendWindow = {
  /** Première date incluse (YYYY-MM-DD). */
  from: string;
  /** Dernière date incluse (YYYY-MM-DD). */
  to: string;
  /** Nombre de mois de la fenêtre — le SEUL diviseur de la moyenne mensuelle. */
  months: number;
  label: string;
  kind: "next12m" | "calendar_year" | "custom";
};

export type DividendEntry = {
  id: string;
  status: DividendStatus;
  assetId: string | null;
  instrumentKey: string | null;
  name: string;
  ticker: string | null;
  isin: string | null;
  dividendType: DividendType;
  isSpecial: boolean;
  exDate: string | null;
  /** `null` quand le fournisseur ne l'a pas publiée. Jamais remplacée par le détachement. */
  paymentDate: string | null;
  /** « YYYY-MM » retenu pour le calendrier. */
  scheduleMonth: string;
  scheduleBasis: ScheduleBasis;
  amountPerShare: number | null;
  currency: string;
  eligibleQuantity: number | null;
  /** Hypothèse assumée d'une projection : la quantité d'AUJOURD'HUI, pas celle du détachement. */
  quantityIsCurrent: boolean;
  grossNative: number | null;
  grossReference: number | null;
  netReference: number | null;
  netIsEstimated: boolean;
  confidence: Confidence | null;
  sourceProvider: string;
  sourceUrl: string | null;
  lastSyncedAt: string | null;
  fxRate: number | null;
  fxRateDate: string | null;
  conversionUnavailable: boolean;
  /** Événement fournisseur déjà encaissé et rapproché : compté une seule fois, en « reçu ». */
  reconciledWithOperationId: string | null;
};

export type MonthlyPoint = {
  monthKey: string;
  label: string;
  receivedReference: number;
  announcedReference: number;
  estimatedReference: number;
  totalReference: number;
};

export type DividendContributor = {
  key: string;
  name: string;
  amountReference: number;
  pct: number;
  hasEstimate: boolean;
  dataQuality: "complete" | "partial" | "unavailable";
};

export type DividendPositionDetail = {
  key: string;
  assetId: string | null;
  name: string;
  ticker: string | null;
  isin: string | null;
  assetType: PortfolioPosition["assetType"];
  distributionPolicy: DistributionPolicy;
  quantity: number;
  amountPerShare: number | null;
  expectedReference: number | null;
  receivedThisYearReference: number;
  yieldOnValuePct: number | null;
  yieldOnCostPct: number | null;
  nextPaymentMonth: string | null;
  nextPaymentDate: string | null;
  nextPaymentStatus: DividendStatus | null;
  dataStatus: "ok" | "accumulating" | "unresolved" | "no_data";
  sourceProvider: string | null;
  lastSyncedAt: string | null;
};

export type DividendCoverage = {
  totalInstruments: number;
  distributing: number;
  accumulating: number;
  unknown: number;
  unresolved: number;
  documented: number;
  coveragePercent: number;
  unresolvedNames: string[];
};

export type DividendTaxView = {
  /** Le sélecteur Brut / Net estimé n'est proposé QUE si ceci est vrai. */
  netAvailable: boolean;
  effectiveRate: number | null;
  note: string;
  /** Ce qui manque pour calculer un net, quand il n'est pas disponible. */
  missing: string | null;
};

export type DividendModel = {
  accountType: AccountType;
  referenceCurrency: string;
  today: string;
  window: DividendWindow;
  includeForecast: boolean;
  entries: DividendEntry[];
  monthly: MonthlyPoint[];
  /** Σ de la fenêtre, toutes catégories retenues (reçu + annoncé + estimé si inclus). */
  expectedReference: number;
  expectedReceivedReference: number;
  expectedAnnouncedReference: number;
  expectedEstimatedReference: number;
  /** expectedReference ÷ window.months — cohérent par construction. */
  monthlyAverageReference: number;
  receivedThisYearReference: number;
  receivedThisYearCount: number;
  receivedPreviousYearReference: number | null;
  hasPreviousYearBaseline: boolean;
  forwardYieldPct: number | null;
  yieldOnCostPct: number | null;
  yieldUnavailableReason: string | null;
  upcoming: DividendEntry[];
  contributors: DividendContributor[];
  positions: DividendPositionDetail[];
  coverage: DividendCoverage;
  tax: DividendTaxView;
  hasRealDividendOperations: boolean;
  /** Rapprochements incertains : signalés, jamais fusionnés en silence. */
  anomalies: Array<{ kind: "ambiguous_match" | "orphan_operation" | "missing_payment_date" | "unresolved_instrument"; label: string; detail: string }>;
};

// ==========================================================================================
// Utilitaires de date
// ==========================================================================================
const MONTHS_SHORT = ["Janv.", "Févr.", "Mars", "Avr.", "Mai", "Juin", "Juil.", "Août", "Sept.", "Oct.", "Nov.", "Déc."];
const MONTHS_LONG = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

export function monthOf(date: string): string {
  return date.slice(0, 7);
}
export function monthLabel(monthKey: string): string {
  const index = Number(monthKey.slice(5, 7)) - 1;
  return `${MONTHS_SHORT[index] ?? monthKey} ${monthKey.slice(2, 4)}`;
}
export function monthLabelLong(monthKey: string): string {
  const index = Number(monthKey.slice(5, 7)) - 1;
  return `${MONTHS_LONG[index] ?? monthKey} ${monthKey.slice(0, 4)}`;
}
function addMonths(monthKey: string, count: number): string {
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7)) - 1 + count;
  const nextYear = year + Math.floor(month / 12);
  const nextMonth = ((month % 12) + 12) % 12;
  return `${nextYear}-${String(nextMonth + 1).padStart(2, "0")}`;
}
function lastDayOfMonth(monthKey: string): string {
  const next = addMonths(monthKey, 1);
  const date = new Date(`${next}-01T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/** Fenêtre « 12 prochains mois » : du mois courant inclus, 12 mois pleins. */
export function next12mWindow(today: string): DividendWindow {
  const first = monthOf(today);
  const last = addMonths(first, 11);
  return { from: `${first}-01`, to: lastDayOfMonth(last), months: 12, label: "12 prochains mois", kind: "next12m" };
}
export function calendarYearWindow(year: number): DividendWindow {
  return { from: `${year}-01-01`, to: `${year}-12-31`, months: 12, label: `Année ${year}`, kind: "calendar_year" };
}
export function windowMonths(window: DividendWindow): string[] {
  const months: string[] = [];
  let current = monthOf(window.from);
  const last = monthOf(window.to);
  while (current <= last && months.length < 240) {
    months.push(current);
    current = addMonths(current, 1);
  }
  return months;
}

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// ==========================================================================================
// Politique de distribution
// ==========================================================================================
/**
 * Marqueur de capitalisation lisible dans le NOM. Volontairement conservateur : un faux positif
 * prive l'utilisateur d'un revenu réel. Seuls des marqueurs isolés ou en fin de libellé comptent
 * (« ACC », « (C) », « CAPITALISANT »), et seulement pour un ETF ou un fonds — « Accor » reste
 * une action qui distribue.
 *
 * Ce n'est qu'un REPLI : la politique fiable vient de `assets.distribution_policy`.
 */
export function accumulatingFromName(name: string | null | undefined, assetType: string | null | undefined): boolean {
  const type = (assetType ?? "").toLowerCase();
  if (type && type !== "etf" && type !== "fund") return false;
  const upper = String(name ?? "").toUpperCase();
  if (!upper) return false;
  return /(^|[\s(\-–])(ACC|ACCUMULATING|CAPITALISANT|CAPITALISATION)([\s)\-–]|$)/.test(upper)
    || /[\s(\-–]C\s+(EUR|USD|GBP|CHF)\s+ACC([\s)]|$)/.test(upper)
    || /\(C\)\s*$/.test(upper);
}

/** Politique retenue : la valeur du catalogue prime ; le nom ne sert qu'à défaut. */
export function resolveDistributionPolicy(instrument: {
  distributionPolicy?: DistributionPolicy | null;
  name?: string | null;
  assetType?: string | null;
}): DistributionPolicy {
  const stored = instrument.distributionPolicy ?? "unknown";
  if (stored !== "unknown") return stored;
  return accumulatingFromName(instrument.name, instrument.assetType) ? "accumulating" : "unknown";
}

// ==========================================================================================
// Quantité éligible
// ==========================================================================================
/**
 * Quantité détenue à la fin d'une date (opérations jusqu'au `date` INCLUS).
 * Utilitaire générique ; pour un droit à dividende, utiliser `eligibleQuantityAtExDate`.
 */
export function quantityAtDate(operations: AccountOperation[], keys: string[] | string, date: string): number {
  const wanted = new Set(Array.isArray(keys) ? keys : [keys]);
  let quantity = 0;
  for (const operation of operations) {
    if (!wanted.has(instrumentKey(operation))) continue;
    if (operation.date > date) continue;
    quantity += quantityDelta(operation);
  }
  return quantity > EPS ? quantity : 0;
}

/**
 * CONVENTION DE DATE, appliquée partout et documentée à l'écran :
 *   achat exécuté AVANT la date de détachement          → éligible ;
 *   achat exécuté À PARTIR de la date de détachement     → NON éligible ;
 *   vente AVANT la date de détachement                   → non éligible ;
 *   vente À PARTIR de la date de détachement              → reste éligible.
 *
 * Autrement dit : la quantité retenue est celle détenue à la CLÔTURE DE LA VEILLE du détachement.
 * Les transferts de titres et les corrections modifient la quantité au même titre qu'un achat ou
 * une vente — les ignorer ferait mentir tout portefeuille repris depuis une capture de courtier,
 * où l'intégralité des positions arrive sous forme de `correction`.
 */
export function eligibleQuantityAtExDate(operations: AccountOperation[], keys: string[] | string, exDate: string): number {
  const wanted = new Set(Array.isArray(keys) ? keys : [keys]);
  let quantity = 0;
  for (const operation of operations) {
    if (!wanted.has(instrumentKey(operation))) continue;
    if (operation.date >= exDate) continue; // strictement avant : le jour du détachement, il est trop tard
    quantity += quantityDelta(operation);
  }
  return quantity > EPS ? quantity : 0;
}

function quantityDelta(operation: AccountOperation): number {
  switch (operation.type) {
    case "achat":
    case "transfer_in":
      return num(operation.quantity);
    case "vente":
    case "transfer_out":
      return -num(operation.quantity);
    case "correction":
      return num(operation.quantity); // quantité SIGNÉE
    default:
      return 0;
  }
}

// ==========================================================================================
// Conversion
// ==========================================================================================
type Converted = { amount: number | null; rate: number | null; rateDate: string | null };

function convert(
  amount: number | null,
  currency: string,
  referenceCurrency: string,
  date: string,
  fxRateAt?: FxResolver,
): Converted {
  if (amount === null) return { amount: null, rate: null, rateDate: null };
  if (currency.toUpperCase() === referenceCurrency) return { amount, rate: 1, rateDate: null };
  const rate = fxRateAt?.(currency.toUpperCase(), date) ?? null;
  if (rate === null || !Number.isFinite(rate) || rate <= 0) return { amount: null, rate: null, rateDate: null };
  return { amount: amount * rate, rate, rateDate: date };
}

// ==========================================================================================
// Fiscalité
// ==========================================================================================
/**
 * Le BRUT est la référence. Le net n'est calculé que si le profil fiscal dit COMMENT le calculer.
 *
 * Aucune fiscalité française n'est codée en dur : il n'y a pas de taux par défaut, pas de PFU
 * implicite, et le titulaire n'est pas présumé résident fiscal français. Sans profil, le
 * sélecteur « Net estimé » n'est même pas proposé.
 *
 * Formule, volontairement explicite :
 *     après retenue = brut × (1 − retenue_à_la_source)
 *     assiette      = brut × (1 − abattement)
 *     impôt         = assiette × taux_d_imposition
 *     net           = après retenue − impôt
 * Aucun crédit d'impôt conventionnel n'est modélisé : il dépend d'une convention bilatérale que
 * l'application ne connaît pas. Le net reste donc une ESTIMATION, et le dit.
 */
export function buildTaxView(accountType: AccountType, profile: AccountTaxProfile | null): DividendTaxView {
  const hasRate = profile !== null
    && (profile.withholdingTaxRate !== null || profile.estimatedTaxRate !== null);
  const enabled = profile !== null && profile.showEstimatedNet && hasRate;

  if (accountType === "PEA") {
    const base = "Dans un PEA, les dividendes encaissés restent dans l’enveloppe : aucun prélèvement n’est appliqué versement par versement, l’imposition intervient au retrait.";
    if (!enabled) return { netAvailable: false, effectiveRate: null, note: base, missing: null };
    return {
      netAvailable: true,
      effectiveRate: effectiveRate(profile!),
      note: `${base} Le net affiché applique le profil fiscal enregistré pour ce compte, à titre indicatif.`,
      missing: null,
    };
  }

  if (!profile) {
    return {
      netAvailable: false,
      effectiveRate: null,
      note: "Seul le brut est affiché : aucun profil fiscal n’est enregistré pour ce compte.",
      missing: "Renseignez la résidence fiscale et le taux d’imposition du compte pour obtenir un net estimé.",
    };
  }
  if (!hasRate) {
    return {
      netAvailable: false,
      effectiveRate: null,
      note: "Seul le brut est affiché : le profil fiscal ne comporte ni retenue à la source ni taux d’imposition.",
      missing: "Complétez la retenue à la source ou le taux d’imposition dans le profil fiscal du compte.",
    };
  }
  if (!profile.showEstimatedNet) {
    return {
      netAvailable: false,
      effectiveRate: null,
      note: "Le net estimé est désactivé dans le profil fiscal de ce compte.",
      missing: null,
    };
  }
  const country = profile.taxResidencyCountry ? ` (résidence fiscale ${profile.taxResidencyCountry})` : "";
  return {
    netAvailable: true,
    effectiveRate: effectiveRate(profile),
    note: `Net estimé d’après le profil fiscal du compte${country}. Aucun crédit d’impôt conventionnel n’est modélisé : c’est une estimation, pas un montant certain.`,
    missing: null,
  };
}

function effectiveRate(profile: AccountTaxProfile): number {
  const withholding = clampRate(profile.withholdingTaxRate);
  const allowance = clampRate(profile.allowanceRate);
  const tax = clampRate(profile.estimatedTaxRate);
  // net = brut × (1 − w) − brut × (1 − a) × t  ⇒  taux effectif = w + (1 − a) × t
  return Math.min(1, withholding + (1 - allowance) * tax);
}
function clampRate(value: number | null | undefined): number {
  const rate = Number(value);
  return Number.isFinite(rate) && rate > 0 ? Math.min(1, rate) : 0;
}

// ==========================================================================================
// Rapprochement opération reçue ↔ événement
// ==========================================================================================
/** Tolérance de rapprochement : 3 % du montant, et 10 jours autour de la date de paiement. */
export const RECONCILIATION_AMOUNT_TOLERANCE = 0.03;
export const RECONCILIATION_DAYS_TOLERANCE = 10;

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

// ==========================================================================================
// Entrée principale
// ==========================================================================================
export type DividendModelInput = {
  operations: AccountOperation[];
  positions: PortfolioPosition[];
  events: DividendEventRow[];
  instruments: DividendInstrument[];
  accountType: AccountType;
  today: string;
  referenceCurrency?: string;
  fxRateAt?: FxResolver;
  taxProfile?: AccountTaxProfile | null;
  window?: DividendWindow;
  includeForecast?: boolean;
  positionsValueReference?: number | null;
  investedReference?: number | null;
};

export function computeDividendModel(input: DividendModelInput): DividendModel {
  const referenceCurrency = (input.referenceCurrency || "EUR").toUpperCase();
  const { operations, positions, accountType, today } = input;
  const window = input.window ?? next12mWindow(today);
  const includeForecast = input.includeForecast !== false;
  const taxProfile = input.taxProfile ?? null;
  const tax = buildTaxView(accountType, taxProfile);
  const rate = tax.netAvailable && taxProfile ? effectiveRate(taxProfile) : null;

  const positionByKey = new Map(positions.map((position) => [position.key, position]));
  const anomalies: DividendModel["anomalies"] = [];

  // ---- Index instrument -----------------------------------------------------------------
  const instrumentByAsset = new Map(input.instruments.map((instrument) => [instrument.assetId, instrument]));
  const instrumentByPositionKey = new Map<string, DividendInstrument>();
  for (const instrument of input.instruments) {
    for (const key of instrument.positionKeys) instrumentByPositionKey.set(key, instrument);
  }

  const entries: DividendEntry[] = [];

  // ---- 1. REÇUS — uniquement des opérations réelles ---------------------------------------
  const realDividends = operations.filter((operation) => operation.type === "dividende");
  for (const operation of realDividends) {
    const key = instrumentKey(operation);
    const instrument = instrumentByPositionKey.get(key) ?? null;
    const currency = (operation.currency || referenceCurrency).toUpperCase();
    // Le brut est celui inscrit sur l'opération. On ne le RECONSTITUE jamais depuis le net : la
    // retenue réelle n'est pas toujours le taux théorique, et l'inventer fabriquerait un impôt.
    const gross = operation.grossAmount === null || operation.grossAmount === undefined ? null : Math.abs(num(operation.grossAmount));
    const net = operation.netAmount === null || operation.netAmount === undefined ? gross : Math.abs(num(operation.netAmount));
    const recorded = Number(operation.exchangeRate);
    const useRecorded = Number.isFinite(recorded) && recorded > 0;
    const grossConverted = gross === null
      ? { amount: null, rate: null, rateDate: null }
      : useRecorded
        ? { amount: gross * recorded, rate: recorded, rateDate: operation.date }
        : convert(gross, currency, referenceCurrency, operation.date, input.fxRateAt);
    const netConverted = net === null
      ? { amount: null, rate: null, rateDate: null }
      : useRecorded
        ? { amount: net * recorded, rate: recorded, rateDate: operation.date }
        : convert(net, currency, referenceCurrency, operation.date, input.fxRateAt);

    entries.push({
      id: `op:${operation.id}`,
      status: "received",
      assetId: instrument?.assetId ?? null,
      instrumentKey: key,
      name: operation.assetName?.trim() || instrument?.name || "Dividende",
      ticker: operation.ticker ?? instrument?.ticker ?? null,
      isin: operation.isin ?? instrument?.isin ?? null,
      dividendType: "ordinary",
      isSpecial: false,
      exDate: null,
      paymentDate: operation.date,
      scheduleMonth: monthOf(operation.date),
      scheduleBasis: "received",
      amountPerShare: null,
      currency,
      eligibleQuantity: operation.quantity === null || operation.quantity === undefined ? null : Math.abs(num(operation.quantity)),
      quantityIsCurrent: false,
      grossNative: gross,
      grossReference: grossConverted.amount,
      netReference: netConverted.amount,
      netIsEstimated: false, // encaissement réel : le net est celui du relevé
      confidence: null,
      sourceProvider: operation.source?.trim() || "Opération enregistrée",
      sourceUrl: null,
      lastSyncedAt: operation.date,
      fxRate: grossConverted.rate,
      fxRateDate: grossConverted.rateDate,
      conversionUnavailable: grossConverted.amount === null && gross !== null,
      reconciledWithOperationId: null,
    });
    if (!instrument && operation.assetName) {
      anomalies.push({
        kind: "orphan_operation",
        label: operation.assetName,
        detail: `Dividende encaissé le ${operation.date} sans instrument identifié : il est compté dans les reçus, mais ne peut alimenter aucune projection.`,
      });
    }
  }

  // ---- 2. ANNONCÉS + 3. ESTIMÉS -----------------------------------------------------------
  for (const event of input.events) {
    if (!includeForecast && event.status === "estimated") continue;
    if (event.status === "unavailable") continue;
    const instrument = instrumentByAsset.get(event.assetId) ?? null;
    if (!instrument) continue;
    const policy = resolveDistributionPolicy(instrument);
    // Un capitalisant ne verse rien en espèces : ni annonce à afficher, ni projection.
    if (policy === "accumulating") continue;

    const positionKey = instrument.positionKeys.find((key) => positionByKey.has(key)) ?? instrument.positionKeys[0] ?? null;
    const position = positionKey ? positionByKey.get(positionKey) ?? null : null;
    const currency = (event.currency || position?.currency || referenceCurrency).toUpperCase();

    // Mois retenu et sur quoi il repose — jamais une date de paiement inventée.
    let scheduleMonth: string;
    let scheduleBasis: ScheduleBasis;
    if (event.status === "estimated") {
      if (!event.estimatedMonth) continue;
      scheduleMonth = event.estimatedMonth;
      scheduleBasis = "estimated";
    } else if (event.paymentDate) {
      scheduleMonth = monthOf(event.paymentDate);
      scheduleBasis = "payment";
    } else if (event.exDate) {
      scheduleMonth = monthOf(event.exDate);
      scheduleBasis = "ex_date";
      anomalies.push({
        kind: "missing_payment_date",
        label: instrument.name,
        detail: `Détachement du ${event.exDate} : le fournisseur ${event.sourceProvider} n’a pas publié la date de paiement. Le mois affiché est déduit du détachement.`,
      });
    } else {
      continue;
    }

    // Quantité éligible : reconstruite à la date de détachement pour un événement daté ; pour une
    // projection sans détachement connu, la quantité d'AUJOURD'HUI sert d'hypothèse — et c'est dit.
    const keys = instrument.positionKeys;
    const quantityIsCurrent = event.exDate === null;
    const eligibleQuantity = event.exDate
      ? eligibleQuantityAtExDate(operations, keys, event.exDate)
      : quantityAtDate(operations, keys, today);

    const amountPerShare = event.amountPerShare;
    const grossNative = amountPerShare === null ? null : amountPerShare * eligibleQuantity;
    const fxDate = event.paymentDate ?? event.exDate ?? `${scheduleMonth}-01`;
    const converted = convert(grossNative, currency, referenceCurrency, fxDate, input.fxRateAt);
    const netReference = converted.amount === null || rate === null ? converted.amount : converted.amount * (1 - rate);

    entries.push({
      id: `ev:${event.id}`,
      status: event.status,
      assetId: event.assetId,
      instrumentKey: positionKey,
      name: position?.name ?? instrument.name,
      ticker: instrument.ticker,
      isin: instrument.isin ?? event.isin,
      dividendType: event.dividendType,
      isSpecial: event.isSpecial,
      exDate: event.exDate,
      paymentDate: event.paymentDate,
      scheduleMonth,
      scheduleBasis,
      amountPerShare,
      currency,
      eligibleQuantity,
      quantityIsCurrent,
      grossNative,
      grossReference: converted.amount,
      netReference,
      netIsEstimated: rate !== null,
      confidence: event.status === "estimated" ? event.confidence : null,
      sourceProvider: event.sourceProvider,
      sourceUrl: event.sourceUrl,
      lastSyncedAt: event.lastSyncedAt,
      fxRate: converted.rate,
      fxRateDate: converted.rateDate,
      conversionUnavailable: converted.amount === null && grossNative !== null,
      reconciledWithOperationId: null,
    });
  }

  // ---- Rapprochement : un événement déjà encaissé ne doit pas être compté deux fois --------
  reconcile(entries, anomalies);

  entries.sort((a, b) => (a.scheduleMonth === b.scheduleMonth
    ? (b.grossReference ?? 0) - (a.grossReference ?? 0)
    : b.scheduleMonth.localeCompare(a.scheduleMonth)));

  // ---- Ventilation mensuelle sur LA fenêtre -----------------------------------------------
  const months = windowMonths(window);
  const monthly: MonthlyPoint[] = months.map((monthKey) => ({
    monthKey,
    label: monthLabel(monthKey),
    receivedReference: 0,
    announcedReference: 0,
    estimatedReference: 0,
    totalReference: 0,
  }));
  const monthIndex = new Map(months.map((monthKey, index) => [monthKey, index]));

  const counted = entries.filter((entry) => entry.reconciledWithOperationId === null);
  for (const entry of counted) {
    const index = monthIndex.get(entry.scheduleMonth);
    if (index === undefined) continue;
    const amount = entry.grossReference;
    if (amount === null) continue;
    const point = monthly[index];
    if (entry.status === "received") point.receivedReference += amount;
    else if (entry.status === "announced") point.announcedReference += amount;
    else point.estimatedReference += amount;
    point.totalReference += amount;
  }

  const expectedReceivedReference = monthly.reduce((sum, point) => sum + point.receivedReference, 0);
  const expectedAnnouncedReference = monthly.reduce((sum, point) => sum + point.announcedReference, 0);
  const expectedEstimatedReference = monthly.reduce((sum, point) => sum + point.estimatedReference, 0);
  const expectedReference = expectedReceivedReference + expectedAnnouncedReference + expectedEstimatedReference;
  const monthlyAverageReference = window.months > 0 ? expectedReference / window.months : 0;

  // ---- Reçus de l'année civile (indépendant de la fenêtre, comme l'annonce la carte) ------
  const year = Number(today.slice(0, 4));
  const receivedThisYear = counted.filter((entry) => entry.status === "received" && entry.scheduleMonth.startsWith(String(year)));
  const receivedThisYearReference = receivedThisYear.reduce((sum, entry) => sum + (entry.netReference ?? entry.grossReference ?? 0), 0);
  const previousYearEntries = counted.filter((entry) => entry.status === "received" && entry.scheduleMonth.startsWith(String(year - 1)));
  // Une comparaison n'a de sens que si l'année précédente est réellement documentée : comparer à
  // un zéro qui signifie « rien n'a été saisi » ferait afficher une croissance imaginaire.
  const hasPreviousYearBaseline = previousYearEntries.length > 0;
  const receivedPreviousYearReference = hasPreviousYearBaseline
    ? previousYearEntries.reduce((sum, entry) => sum + (entry.netReference ?? entry.grossReference ?? 0), 0)
    : null;

  // ---- Rendements — même numérateur que la carte 1, deux dénominateurs -------------------
  const positionsValue = input.positionsValueReference ?? null;
  const invested = input.investedReference ?? null;
  const forwardYieldPct = positionsValue !== null && positionsValue > EPS && expectedReference > EPS
    ? (expectedReference / positionsValue) * 100
    : null;
  const yieldOnCostPct = invested !== null && invested > EPS && expectedReference > EPS
    ? (expectedReference / invested) * 100
    : null;
  const yieldUnavailableReason = forwardYieldPct !== null
    ? null
    : expectedReference <= EPS
      ? "Aucun dividende attendu sur la période."
      : positionsValue === null || positionsValue <= EPS
        ? "La valeur actuelle du portefeuille n’est pas connue (aucun cours disponible)."
        : null;

  // ---- Prochains versements ---------------------------------------------------------------
  const todayMonth = monthOf(today);
  const upcoming = counted
    .filter((entry) => entry.status !== "received")
    .filter((entry) => (entry.paymentDate ? entry.paymentDate >= today : entry.scheduleMonth >= todayMonth))
    .sort((a, b) => {
      const aKey = a.paymentDate ?? `${a.scheduleMonth}-99`;
      const bKey = b.paymentDate ?? `${b.scheduleMonth}-99`;
      return aKey.localeCompare(bKey);
    });

  // ---- Contributeurs sur LA fenêtre --------------------------------------------------------
  const contributorTotals = new Map<string, { name: string; amount: number; hasEstimate: boolean; missing: boolean }>();
  for (const entry of counted) {
    if (!monthIndex.has(entry.scheduleMonth)) continue;
    const key = entry.assetId ?? entry.instrumentKey ?? `name:${normalizeInstrumentName(entry.name)}`;
    const current = contributorTotals.get(key) ?? { name: entry.name, amount: 0, hasEstimate: false, missing: false };
    current.amount += entry.grossReference ?? 0;
    if (entry.status === "estimated") current.hasEstimate = true;
    if (entry.grossReference === null) current.missing = true;
    contributorTotals.set(key, current);
  }
  const contributorTotal = [...contributorTotals.values()].reduce((sum, item) => sum + item.amount, 0);
  const contributors: DividendContributor[] = [...contributorTotals.entries()]
    .filter(([, item]) => item.amount > EPS || item.missing)
    .map(([key, item]) => ({
      key,
      name: item.name,
      amountReference: item.amount,
      pct: contributorTotal > EPS ? (item.amount / contributorTotal) * 100 : 0,
      hasEstimate: item.hasEstimate,
      dataQuality: (item.missing ? (item.amount > EPS ? "partial" : "unavailable") : "complete") as DividendContributor["dataQuality"],
    }))
    .sort((a, b) => b.amountReference - a.amountReference);

  // ---- Détail par position -----------------------------------------------------------------
  const detail = buildPositionDetails({
    positions, entries: counted, instrumentByPositionKey, monthIndex, today,
    receivedYear: String(year), invested,
  });

  // ---- Couverture ---------------------------------------------------------------------------
  const coverage = buildCoverage(positions, instrumentByPositionKey, counted);
  for (const name of coverage.unresolvedNames) {
    anomalies.push({
      kind: "unresolved_instrument",
      label: name,
      detail: "Aucun symbole fournisseur validé : les dividendes de cet instrument ne peuvent pas être calculés.",
    });
  }

  return {
    accountType,
    referenceCurrency,
    today,
    window,
    includeForecast,
    entries,
    monthly,
    expectedReference,
    expectedReceivedReference,
    expectedAnnouncedReference,
    expectedEstimatedReference,
    monthlyAverageReference,
    receivedThisYearReference,
    receivedThisYearCount: receivedThisYear.length,
    receivedPreviousYearReference,
    hasPreviousYearBaseline,
    forwardYieldPct,
    yieldOnCostPct,
    yieldUnavailableReason,
    upcoming,
    contributors,
    positions: detail,
    coverage,
    tax,
    hasRealDividendOperations: realDividends.length > 0,
    anomalies: dedupeAnomalies(anomalies),
  };
}

/**
 * Un dividende annoncé puis réellement encaissé apparaît DEUX FOIS : une opération et un événement
 * fournisseur. Les additionner doublerait le revenu. On rapproche donc l'événement de l'opération
 * quand l'instrument, la devise, le montant (à 3 %) et la date (à 10 jours) concordent.
 *
 * Une correspondance MULTIPLE n'est jamais tranchée au hasard : l'événement reste compté et
 * l'anomalie est signalée. Fusionner en silence deux versements du même titre reviendrait à en
 * effacer un.
 */
function reconcile(entries: DividendEntry[], anomalies: DividendModel["anomalies"]): void {
  const received = entries.filter((entry) => entry.status === "received");
  if (received.length === 0) return;
  for (const entry of entries) {
    if (entry.status !== "announced") continue;
    if (entry.grossReference === null) continue;
    const candidates = received.filter((operation) => {
      if (operation.reconciledWithOperationId !== null) return false;
      if (operation.instrumentKey !== entry.instrumentKey) return false;
      if (operation.currency !== entry.currency) return false;
      const amount = operation.grossReference ?? operation.netReference;
      if (amount === null || entry.grossReference === null) return false;
      const reference = Math.max(Math.abs(amount), Math.abs(entry.grossReference));
      if (reference <= EPS) return false;
      if (Math.abs(amount - entry.grossReference) / reference > RECONCILIATION_AMOUNT_TOLERANCE) return false;
      const paymentDate = entry.paymentDate ?? entry.exDate;
      if (!paymentDate || !operation.paymentDate) return false;
      return Math.abs(daysBetween(paymentDate, operation.paymentDate)) <= RECONCILIATION_DAYS_TOLERANCE;
    });
    if (candidates.length === 1) {
      entry.reconciledWithOperationId = candidates[0].id.replace(/^op:/, "");
    } else if (candidates.length > 1) {
      anomalies.push({
        kind: "ambiguous_match",
        label: entry.name,
        detail: `${candidates.length} encaissements pourraient correspondre à l’échéance du ${entry.paymentDate ?? entry.exDate}. Aucun rapprochement n’a été fait automatiquement.`,
      });
    }
  }
}

function buildPositionDetails(params: {
  positions: PortfolioPosition[];
  entries: DividendEntry[];
  instrumentByPositionKey: Map<string, DividendInstrument>;
  monthIndex: Map<string, number>;
  today: string;
  receivedYear: string;
  invested: number | null;
}): DividendPositionDetail[] {
  const { positions, entries, instrumentByPositionKey, monthIndex, today, receivedYear } = params;
  const todayMonth = monthOf(today);
  return positions.map((position) => {
    const instrument = instrumentByPositionKey.get(position.key) ?? null;
    const policy = resolveDistributionPolicy({
      distributionPolicy: instrument?.distributionPolicy ?? null,
      name: position.name,
      assetType: position.assetType,
    });
    const own = entries.filter((entry) => entry.instrumentKey === position.key);
    const inWindow = own.filter((entry) => monthIndex.has(entry.scheduleMonth));
    const expected = inWindow.some((entry) => entry.grossReference !== null)
      ? inWindow.reduce((sum, entry) => sum + (entry.grossReference ?? 0), 0)
      : null;
    const receivedThisYear = own
      .filter((entry) => entry.status === "received" && entry.scheduleMonth.startsWith(receivedYear))
      .reduce((sum, entry) => sum + (entry.netReference ?? entry.grossReference ?? 0), 0);
    const next = own
      .filter((entry) => entry.status !== "received")
      .filter((entry) => (entry.paymentDate ? entry.paymentDate >= today : entry.scheduleMonth >= todayMonth))
      .sort((a, b) => (a.paymentDate ?? `${a.scheduleMonth}-99`).localeCompare(b.paymentDate ?? `${b.scheduleMonth}-99`))[0] ?? null;

    const dataStatus: DividendPositionDetail["dataStatus"] = policy === "accumulating"
      ? "accumulating"
      : instrument === null || instrument.resolutionStatus === "unresolved"
        ? "unresolved"
        : own.length === 0
          ? "no_data"
          : "ok";

    return {
      key: position.key,
      assetId: instrument?.assetId ?? null,
      name: position.name,
      ticker: position.ticker,
      isin: position.isin,
      assetType: position.assetType,
      distributionPolicy: policy,
      quantity: position.quantity,
      amountPerShare: next?.amountPerShare ?? null,
      expectedReference: expected,
      receivedThisYearReference: receivedThisYear,
      yieldOnValuePct: expected !== null && position.currentValueEur !== null && position.currentValueEur > EPS
        ? (expected / position.currentValueEur) * 100
        : null,
      yieldOnCostPct: expected !== null && position.investedEur > EPS ? (expected / position.investedEur) * 100 : null,
      nextPaymentMonth: next?.scheduleMonth ?? null,
      nextPaymentDate: next?.paymentDate ?? null,
      nextPaymentStatus: next?.status ?? null,
      dataStatus,
      sourceProvider: next?.sourceProvider ?? instrument?.providerSymbol ?? null,
      lastSyncedAt: instrument?.lastSyncedAt ?? null,
    };
  });
}

function buildCoverage(
  positions: PortfolioPosition[],
  instrumentByPositionKey: Map<string, DividendInstrument>,
  entries: DividendEntry[],
): DividendCoverage {
  const documentedKeys = new Set(entries.filter((entry) => entry.status !== "received").map((entry) => entry.instrumentKey));
  let distributing = 0;
  let accumulating = 0;
  let unknown = 0;
  let unresolved = 0;
  let documented = 0;
  const unresolvedNames: string[] = [];
  for (const position of positions) {
    const instrument = instrumentByPositionKey.get(position.key) ?? null;
    const policy = resolveDistributionPolicy({
      distributionPolicy: instrument?.distributionPolicy ?? null,
      name: position.name,
      assetType: position.assetType,
    });
    if (policy === "accumulating") accumulating += 1;
    else if (policy === "distributing") distributing += 1;
    else unknown += 1;
    if (documentedKeys.has(position.key)) documented += 1;
    if (policy !== "accumulating" && (instrument === null || instrument.resolutionStatus === "unresolved")) {
      unresolved += 1;
      unresolvedNames.push(position.name);
    }
  }
  // Une position est « couverte » dès lors qu'on sait quoi en dire : soit elle capitalise (rien à
  // attendre), soit un événement la documente. Une position simplement « inconnue » ne l'est pas.
  const covered = accumulating + documented;
  return {
    totalInstruments: positions.length,
    distributing,
    accumulating,
    unknown,
    unresolved,
    documented,
    coveragePercent: positions.length > 0 ? (covered / positions.length) * 100 : 100,
    unresolvedNames,
  };
}

function dedupeAnomalies(anomalies: DividendModel["anomalies"]): DividendModel["anomalies"] {
  const seen = new Set<string>();
  const result: DividendModel["anomalies"] = [];
  for (const anomaly of anomalies) {
    const key = `${anomaly.kind}|${anomaly.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(anomaly);
  }
  return result;
}

// ==========================================================================================
// Rapport de synchronisation — phrase lisible par l'utilisateur
// ==========================================================================================
export type SyncReport = {
  instrumentsChecked: number;
  announcedUpdated: number;
  forecastsRebuilt: number;
  unresolved: number;
  accumulating: number;
  deferredByQuota: number;
  providerUnavailable: number;
};

/** « 18 positions vérifiées. 4 dividendes annoncés mis à jour. 7 projections recalculées. » */
export function describeSyncReport(report: SyncReport): string {
  const parts = [`${report.instrumentsChecked} position${report.instrumentsChecked > 1 ? "s" : ""} vérifiée${report.instrumentsChecked > 1 ? "s" : ""}`];
  if (report.announcedUpdated > 0) parts.push(`${report.announcedUpdated} dividende${report.announcedUpdated > 1 ? "s" : ""} annoncé${report.announcedUpdated > 1 ? "s" : ""} mis à jour`);
  if (report.forecastsRebuilt > 0) parts.push(`${report.forecastsRebuilt} projection${report.forecastsRebuilt > 1 ? "s" : ""} recalculée${report.forecastsRebuilt > 1 ? "s" : ""}`);
  if (report.accumulating > 0) parts.push(`${report.accumulating} capitalisant${report.accumulating > 1 ? "s" : ""} sans versement attendu`);
  if (report.unresolved > 0) parts.push(`${report.unresolved} instrument${report.unresolved > 1 ? "s" : ""} reste${report.unresolved > 1 ? "nt" : ""} à identifier`);
  if (report.deferredByQuota > 0) parts.push(`${report.deferredByQuota} report${report.deferredByQuota > 1 ? "és" : "é"} au prochain quota`);
  if (report.providerUnavailable > 0) parts.push(`${report.providerUnavailable} sans réponse du fournisseur`);
  return `${parts.join(". ")}.`;
}
