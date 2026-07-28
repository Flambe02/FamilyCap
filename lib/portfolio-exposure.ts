// Exposition GÉOGRAPHIQUE et SECTORIELLE consolidée d'un compte PEA / compte-titres.
//
// Trois règles structurent tout le module, et elles répondent chacune à une manière connue de
// mentir avec un camembert :
//
//  1. Un ETF n'est JAMAIS rattaché à son pays de cotation. Un ETF MSCI World coté à Paris n'est
//     pas une exposition à la France ; c'est même l'erreur qui rend une répartition géographique
//     activement trompeuse. Un ETF n'a d'exposition que si la composition de son indice est
//     renseignée (table `instrument_exposures`), et cette composition est datée et sourcée.
//  2. Ce qui n'est pas connu reste « Non renseigné ». Le poids manquant n'est jamais redistribué
//     entre les autres zones : redistribuer transforme une ignorance en certitude.
//  3. Le total fait 100 %, « Non renseigné » compris. Un camembert dont les parts ne bouclent pas
//     est un camembert qui cache quelque chose.
//
// Repli assumé pour une ACTION EN DIRECT sans exposition renseignée : le pays de domiciliation
// déduit du préfixe ISIN, marqué `isEstimated` et libellé « approximation ». C'est une
// approximation défendable (le siège social n'est pas le chiffre d'affaires), et elle est
// annoncée comme telle plutôt que présentée comme l'exposition économique réelle. Ce repli ne
// s'applique QU'AUX titres vifs : l'appliquer à un ETF reproduirait exactement l'erreur n° 1.
//
// Module PUR, testé dans tests/portfolio-exposure.test.mjs.

import type { PortfolioPosition } from "./portfolio-account.ts";

export type ExposureDimension = "geography" | "sector";
export type ExposureConfidence = "high" | "medium" | "low";

/** Une ligne de la table `instrument_exposures`, normalisée. */
export type InstrumentExposure = {
  isin: string | null;
  instrumentKey: string | null;
  dimension: ExposureDimension;
  code: string;
  label: string;
  weightPercent: number;
  source: string;
  sourceAsOf: string | null;
  confidence: ExposureConfidence;
  isEstimated: boolean;
};

export type ExposureBucket = {
  code: string;
  label: string;
  valueEur: number;
  pct: number;
  positions: number;
  /** Au moins une contribution provient d'une estimation (composition d'indice, domiciliation…). */
  isEstimated: boolean;
  sources: string[];
  color: string;
};

/** Pourquoi un instrument détenu ne contribue pas (ou pas totalement) à la répartition. */
export type ExposureGap = {
  key: string;
  name: string;
  ticker: string | null;
  isin: string | null;
  assetType: PortfolioPosition["assetType"];
  valueEur: number | null;
  missingPct: number;
  reason:
    | "no_price" // pas de cours : la position n'a pas de poids attribuable
    | "no_exposure" // aucune ligne d'exposition connue
    | "partial_exposure" // la somme des poids connus est < 100 %
    | "etf_without_lookthrough"; // ETF sans composition d'indice : surtout ne pas utiliser sa cotation
};

export type ExposureModel = {
  dimension: ExposureDimension;
  buckets: ExposureBucket[];
  /** Valeur réellement répartie (positions valorisées uniquement). */
  totalValueEur: number;
  unknownPct: number;
  estimatedPct: number;
  coverage: {
    totalInstruments: number;
    documentedInstruments: number;
    coveragePercent: number;
  };
  gaps: ExposureGap[];
  sources: string[];
  isComplete: boolean;
};

export const UNKNOWN_CODE = "UNKNOWN";
export const UNKNOWN_LABEL = "Non renseigné";
export const COMMODITY_CODE = "COMMODITY";

// Palette alignée sur la charte (fond crème, vert canard, bleu marine). Le gris est RÉSERVÉ à
// « Non renseigné » : cette part doit se lire comme une absence, jamais comme une zone.
const PALETTE = ["#1d706b", "#5a9bd4", "#f0a63a", "#9b7fd4", "#3aa17e", "#d9744d", "#7d8fa8", "#c2a33a"];
const UNKNOWN_COLOR = "#b6bfc6";

const EPS = 1e-9;

/**
 * Pays de domiciliation déduit du préfixe ISIN. Volontairement limité aux préfixes NON ambigus :
 * un préfixe est un pays d'ÉMISSION du titre, pas un pays d'activité, et certains (`XS`, `EU`)
 * ne désignent aucun pays. Ceux-là ne produisent rien plutôt qu'une zone inventée.
 */
const ISIN_COUNTRY: Record<string, { code: string; label: string }> = {
  FR: { code: "FR", label: "France" },
  DE: { code: "DE", label: "Allemagne" },
  NL: { code: "NL", label: "Pays-Bas" },
  BE: { code: "BE", label: "Belgique" },
  ES: { code: "ES", label: "Espagne" },
  IT: { code: "IT", label: "Italie" },
  PT: { code: "PT", label: "Portugal" },
  CH: { code: "CH", label: "Suisse" },
  GB: { code: "GB", label: "Royaume-Uni" },
  US: { code: "US", label: "États-Unis" },
  CA: { code: "CA", label: "Canada" },
  JP: { code: "JP", label: "Japon" },
  AU: { code: "AU", label: "Australie" },
  DK: { code: "DK", label: "Danemark" },
  SE: { code: "SE", label: "Suède" },
  NO: { code: "NO", label: "Norvège" },
  FI: { code: "FI", label: "Finlande" },
  AT: { code: "AT", label: "Autriche" },
  IE: { code: "IE", label: "Irlande" },
  LU: { code: "LU", label: "Luxembourg" },
};

/** Types d'actifs pour lesquels le repli « pays de domiciliation » a un sens. */
const DIRECT_HOLDING_TYPES = new Set<PortfolioPosition["assetType"]>(["stock", "reit"]);
/** Types pour lesquels le pays de cotation/domiciliation est structurellement TROMPEUR. */
const POOLED_TYPES = new Set<PortfolioPosition["assetType"]>(["etf", "fund"]);

function normalizeIsin(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim().toUpperCase();
  return /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(raw) ? raw : null;
}

/** Clé de rapprochement d'une ligne d'exposition (ISIN prioritaire, sinon clé d'instrument). */
function exposureKeys(exposure: InstrumentExposure): string[] {
  const keys: string[] = [];
  const isin = normalizeIsin(exposure.isin);
  if (isin) keys.push(`isin:${isin}`);
  if (exposure.instrumentKey) keys.push(exposure.instrumentKey);
  return keys;
}

function positionKeys(position: PortfolioPosition): string[] {
  const keys: string[] = [];
  const isin = normalizeIsin(position.isin);
  if (isin) keys.push(`isin:${isin}`);
  keys.push(position.key);
  return keys;
}

/**
 * Repli « domiciliation » pour un titre vif sans exposition renseignée. Renvoie `null` dès que le
 * repli n'est pas légitime : ETF/fonds (règle n° 1), or et matières premières (une exposition
 * mondiale, pas un pays), préfixe ISIN non concluant.
 */
export function domicileFallback(position: PortfolioPosition, dimension: ExposureDimension): InstrumentExposure | null {
  if (dimension !== "geography") return null;
  if (!DIRECT_HOLDING_TYPES.has(position.assetType)) return null;
  const isin = normalizeIsin(position.isin);
  if (!isin) return null;
  const country = ISIN_COUNTRY[isin.slice(0, 2)];
  if (!country) return null;
  return {
    isin,
    instrumentKey: position.key,
    dimension: "geography",
    code: country.code,
    label: country.label,
    weightPercent: 100,
    source: "Pays de domiciliation (préfixe ISIN)",
    sourceAsOf: null,
    confidence: "low",
    isEstimated: true,
  };
}

/** Les matières premières et l'or physique ne se rattachent à aucun pays : c'est leur nature. */
function commodityExposure(position: PortfolioPosition, dimension: ExposureDimension): InstrumentExposure | null {
  if (position.assetType !== "gold") return null;
  return {
    isin: normalizeIsin(position.isin),
    instrumentKey: position.key,
    dimension,
    code: COMMODITY_CODE,
    label: dimension === "geography" ? "Matières premières / exposition mondiale" : "Matières premières",
    weightPercent: 100,
    source: "Nature de l'actif (métal précieux détenu physiquement)",
    sourceAsOf: null,
    confidence: "high",
    isEstimated: false,
  };
}

export type ExposureInput = {
  positions: PortfolioPosition[];
  exposures: InstrumentExposure[];
  dimension: ExposureDimension;
  /** Autoriser le repli « pays de domiciliation » pour les titres vifs (défaut : oui). */
  allowDomicileFallback?: boolean;
};

/**
 * Consolide les expositions au niveau du portefeuille :
 *   poids de la position dans le portefeuille × poids de la zone dans l'instrument.
 *
 * Une position sans cours n'a pas de poids attribuable : elle n'entre pas au dénominateur et est
 * reportée dans `gaps` (`no_price`). Valoriser à zéro, ou retomber sur le prix de revient, aurait
 * mélangé deux référentiels de valeur dans le même camembert.
 */
export function computeExposureModel({ positions, exposures, dimension, allowDomicileFallback = true }: ExposureInput): ExposureModel {
  const byKey = new Map<string, InstrumentExposure[]>();
  for (const exposure of exposures) {
    if (exposure.dimension !== dimension) continue;
    if (!Number.isFinite(exposure.weightPercent) || exposure.weightPercent <= 0) continue;
    for (const key of exposureKeys(exposure)) {
      byKey.set(key, [...(byKey.get(key) ?? []), exposure]);
    }
  }

  const valued = positions.filter((position) => position.currentValueEur !== null && position.currentValueEur > EPS);
  const totalValueEur = valued.reduce((sum, position) => sum + (position.currentValueEur ?? 0), 0);

  const buckets = new Map<string, { label: string; valueEur: number; positions: Set<string>; estimated: boolean; sources: Set<string> }>();
  const gaps: ExposureGap[] = [];
  const sources = new Set<string>();
  let documentedInstruments = 0;
  let estimatedValueEur = 0;

  const add = (code: string, label: string, valueEur: number, positionKey: string, isEstimated: boolean, source: string | null) => {
    if (valueEur <= EPS) return;
    const bucket = buckets.get(code) ?? { label, valueEur: 0, positions: new Set<string>(), estimated: false, sources: new Set<string>() };
    bucket.valueEur += valueEur;
    bucket.positions.add(positionKey);
    bucket.estimated = bucket.estimated || isEstimated;
    if (source) bucket.sources.add(source);
    buckets.set(code, bucket);
    if (isEstimated) estimatedValueEur += valueEur;
    if (source) sources.add(source);
  };

  // Positions sans cours : signalées, jamais valorisées à zéro ni au prix de revient.
  for (const position of positions) {
    if (position.currentValueEur !== null && position.currentValueEur > EPS) continue;
    gaps.push({
      key: position.key,
      name: position.name,
      ticker: position.ticker,
      isin: position.isin,
      assetType: position.assetType,
      valueEur: position.currentValueEur,
      missingPct: 100,
      reason: "no_price",
    });
  }

  for (const position of valued) {
    const positionValue = position.currentValueEur ?? 0;
    let rows = positionKeys(position).flatMap((key) => byKey.get(key) ?? []);
    // Dédoublonnage : une même ligne peut être atteinte par l'ISIN ET par la clé d'instrument.
    const seen = new Set<string>();
    rows = rows.filter((row) => {
      const signature = `${row.code}|${row.weightPercent}|${row.source}`;
      if (seen.has(signature)) return false;
      seen.add(signature);
      return true;
    });

    if (rows.length === 0) {
      const derived = commodityExposure(position, dimension)
        ?? (allowDomicileFallback ? domicileFallback(position, dimension) : null);
      if (derived) rows = [derived];
    }

    if (rows.length === 0) {
      add(UNKNOWN_CODE, UNKNOWN_LABEL, positionValue, position.key, false, null);
      gaps.push({
        key: position.key,
        name: position.name,
        ticker: position.ticker,
        isin: position.isin,
        assetType: position.assetType,
        valueEur: positionValue,
        missingPct: 100,
        // Distinguer l'ETF est utile : le message à afficher n'est pas le même (« il faut la
        // composition de l'indice », pas « il faut le pays »).
        reason: POOLED_TYPES.has(position.assetType) ? "etf_without_lookthrough" : "no_exposure",
      });
      continue;
    }

    documentedInstruments += 1;
    const declared = rows.reduce((sum, row) => sum + row.weightPercent, 0);
    for (const row of rows) {
      add(row.code, row.label, (positionValue * row.weightPercent) / 100, position.key, row.isEstimated, row.source);
    }
    // Une composition qui ne boucle pas à 100 % laisse un reste : il va en « Non renseigné », il
    // n'est pas réparti au prorata sur les zones connues.
    const missing = 100 - declared;
    if (missing > 0.01) {
      add(UNKNOWN_CODE, UNKNOWN_LABEL, (positionValue * missing) / 100, position.key, false, null);
      gaps.push({
        key: position.key,
        name: position.name,
        ticker: position.ticker,
        isin: position.isin,
        assetType: position.assetType,
        valueEur: positionValue,
        missingPct: missing,
        reason: "partial_exposure",
      });
    }
  }

  const ordered = [...buckets.entries()]
    .sort((a, b) => (a[0] === UNKNOWN_CODE ? 1 : b[0] === UNKNOWN_CODE ? -1 : b[1].valueEur - a[1].valueEur));

  let colorIndex = 0;
  const result: ExposureBucket[] = ordered.map(([code, bucket]) => ({
    code,
    label: bucket.label,
    valueEur: bucket.valueEur,
    pct: totalValueEur > EPS ? (bucket.valueEur / totalValueEur) * 100 : 0,
    positions: bucket.positions.size,
    isEstimated: bucket.estimated,
    sources: [...bucket.sources],
    color: code === UNKNOWN_CODE ? UNKNOWN_COLOR : PALETTE[colorIndex++ % PALETTE.length],
  }));

  const unknown = result.find((bucket) => bucket.code === UNKNOWN_CODE);
  const totalInstruments = positions.length;
  return {
    dimension,
    buckets: result,
    totalValueEur,
    unknownPct: unknown?.pct ?? 0,
    estimatedPct: totalValueEur > EPS ? (estimatedValueEur / totalValueEur) * 100 : 0,
    coverage: {
      totalInstruments,
      documentedInstruments,
      coveragePercent: totalInstruments > 0 ? (documentedInstruments / totalInstruments) * 100 : 100,
    },
    gaps,
    sources: [...sources],
    isComplete: totalInstruments > 0 && documentedInstruments === totalInstruments && (unknown?.pct ?? 0) < 0.01,
  };
}

/** Somme des parts, arrondie : sert aux tests d'acceptation et à l'assertion « le total fait 100 % ». */
export function exposureTotalPct(model: ExposureModel): number {
  return model.buckets.reduce((sum, bucket) => sum + bucket.pct, 0);
}
