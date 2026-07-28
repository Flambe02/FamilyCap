// Appariement POSITION DÉRIVÉE ↔ RÉFÉRENCE DE COURS.
//
// Pourquoi ce module existe (bug réel, Sanofi, PEA) :
// `instrumentKey()` choisit UNE clé par ordre de préférence — ISIN, sinon ticker, sinon nom. Les
// deux côtés de l'appariement la calculent indépendamment :
//   * la POSITION, à partir des champs de l'opération (`account_operations`) ;
//   * la RÉFÉRENCE DE COURS, à partir des champs de la ligne `holdings`.
// Quand les deux côtés ne connaissent pas les mêmes identifiants, ils tombent sur deux clés
// différentes et ne se rencontrent JAMAIS. Cas observé en base : l'opération Sanofi porte
// `isin = NULL, ticker = 'SAN'` (clé `tkr:SAN`) tandis que la ligne `holdings` porte un ISIN
// (clé `isin:…`). Résultat : position sans cours, exclue de la valorisation, invisible du
// pipeline dividendes — sans qu'aucune erreur ne soit levée nulle part.
//
// La correction n'invente rien : elle constate qu'un même instrument peut être désigné par
// plusieurs identifiants et apparie sur le PREMIER identifiant réellement commun aux deux côtés,
// du plus fort au plus faible (ISIN > ticker > nom normalisé). Un appariement par nom seul est
// signalé (`matchedOn: "name"`) pour que l'interface puisse le dire.
//
// Ce module est PUR (aucun accès réseau, aucune écriture) et testé dans
// tests/instrument-alias.test.mjs.

import { instrumentKey } from "./portfolio-account.ts";

/** Force d'un appariement : `isin` est certain, `name` est le dernier recours. */
export type AliasKind = "isin" | "ticker" | "name";

export type IdentityFields = {
  isin: string | null | undefined;
  ticker: string | null | undefined;
  name: string | null | undefined;
};

/** Ligne `holdings` telle que lue par /api/portfolio (référentiel de PRIX, jamais de quantité). */
export type PriceReferenceFields = {
  isin: string | null | undefined;
  symbol: string | null | undefined;
  name: string | null | undefined;
};

const ISIN_SHAPE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;

/**
 * Normalisation du nom volontairement AGRESSIVE, parce qu'un même instrument arrive avec des
 * habillages différents selon la source : « SANOFI », « Sanofi », « SODEXO (SW) »,
 * « AIR LIQUIDE PF28   (-) ». On retire le suffixe de ticker entre parenthèses, les signes de
 * ponctuation et les espaces multiples. On ne retire RIEN d'autre : « Air Liquide » et
 * « Air Liquide PF28 » restent deux instruments distincts (ce sont bien deux lignes réelles).
 */
export function normalizeInstrumentName(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*$/, "") // « SODEXO (SW) » → « sodexo »
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function cleanIsin(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim().toUpperCase();
  return ISIN_SHAPE.test(raw) ? raw : null;
}

function cleanTicker(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim().toUpperCase();
  return raw && raw !== "-" ? raw : null;
}

/**
 * Tous les alias d'une identité, du plus fort au plus faible. Un ISIN mal formé n'en est pas un :
 * il n'est pas retenu comme alias fort (c'est exactement ce qui a permis à `FR0001200578` —
 * l'ISIN Sanofi aux chiffres transposés — de faire écran).
 */
export function identityAliases(identity: IdentityFields): Array<{ kind: AliasKind; alias: string }> {
  const aliases: Array<{ kind: AliasKind; alias: string }> = [];
  const isin = cleanIsin(identity.isin);
  if (isin) aliases.push({ kind: "isin", alias: `isin:${isin}` });
  const ticker = cleanTicker(identity.ticker);
  if (ticker) aliases.push({ kind: "ticker", alias: `tkr:${ticker}` });
  const name = normalizeInstrumentName(identity.name);
  if (name) aliases.push({ kind: "name", alias: `name:${name}` });
  return aliases;
}

export type ResolvedReference<T> = { reference: T; matchedOn: AliasKind };

/**
 * Index d'alias → référence. Une référence occupe plusieurs entrées ; en cas de collision, la
 * PREMIÈRE gagne, et un alias fort n'est jamais écrasé par un alias faible (c'est ce qui évite
 * qu'une ligne « Air Liquide PF28 » capte le nom « air liquide » d'une autre).
 */
export function buildAliasIndex<T>(
  references: T[],
  read: (reference: T) => PriceReferenceFields,
): Map<string, ResolvedReference<T>> {
  const index = new Map<string, ResolvedReference<T>>();
  // Deux passes : tous les alias forts d'abord, les faibles ensuite. Sans cela, l'ordre des
  // lignes en base déciderait du gagnant — un comportement non reproductible.
  const order: AliasKind[] = ["isin", "ticker", "name"];
  for (const kind of order) {
    for (const reference of references) {
      const fields = read(reference);
      for (const { kind: aliasKind, alias } of identityAliases({ isin: fields.isin, ticker: fields.symbol, name: fields.name })) {
        if (aliasKind !== kind || index.has(alias)) continue;
        index.set(alias, { reference, matchedOn: aliasKind });
      }
    }
  }
  return index;
}

/** Première référence rencontrée en suivant les alias de l'instrument, du plus fort au plus faible. */
export function resolveReference<T>(
  index: Map<string, ResolvedReference<T>>,
  identity: IdentityFields,
): ResolvedReference<T> | null {
  for (const { alias } of identityAliases(identity)) {
    const hit = index.get(alias);
    if (hit) return hit;
  }
  return null;
}

export type InstrumentIdentity = IdentityFields & { key: string };

/**
 * Identités distinctes portées par un jeu d'opérations, avec la clé que `computeAccountModel`
 * utilisera pour la position correspondante. Les champs sont CONSOLIDÉS entre les opérations du
 * même instrument : une opération d'achat sans ISIN et une correction avec ISIN décrivent le même
 * titre, et il serait absurde d'oublier l'ISIN parce que la première ligne ne le portait pas.
 */
export function collectInstrumentIdentities(
  operations: Array<{ isin: string | null; ticker: string | null; assetName: string | null }>,
): InstrumentIdentity[] {
  const byKey = new Map<string, InstrumentIdentity>();
  for (const operation of operations) {
    const key = instrumentKey(operation);
    const current = byKey.get(key) ?? { key, isin: null, ticker: null, name: null };
    byKey.set(key, {
      key,
      isin: current.isin ?? cleanIsin(operation.isin),
      ticker: current.ticker ?? cleanTicker(operation.ticker),
      name: current.name ?? (String(operation.assetName ?? "").trim() || null),
    });
  }
  return [...byKey.values()];
}

export type PriceIndexResult<T> = {
  /** Clé de position (celle de `computeAccountModel`) → référence de cours appariée. */
  byKey: Map<string, T>;
  /** Comment chaque appariement a été obtenu — utile pour signaler un rapprochement par nom. */
  matchedOn: Map<string, AliasKind>;
  /** Instruments détenus pour lesquels aucune référence n'a été trouvée. */
  unmatched: InstrumentIdentity[];
};

/**
 * Construit la table `clé de position → référence de cours` attendue par `computeAccountModel`.
 *
 * C'est le point d'entrée à utiliser partout : il produit une Map dont les clés sont EXACTEMENT
 * celles des positions dérivées, ce qui rend l'appariement indépendant du fait que l'opération et
 * la ligne `holdings` connaissent, ou non, les mêmes identifiants.
 */
export function buildPriceIndex<T>(
  references: T[],
  read: (reference: T) => PriceReferenceFields,
  operations: Array<{ isin: string | null; ticker: string | null; assetName: string | null }>,
): PriceIndexResult<T> {
  const index = buildAliasIndex(references, read);
  const byKey = new Map<string, T>();
  const matchedOn = new Map<string, AliasKind>();
  const unmatched: InstrumentIdentity[] = [];
  for (const identity of collectInstrumentIdentities(operations)) {
    const hit = resolveReference(index, identity);
    if (!hit) {
      unmatched.push(identity);
      continue;
    }
    byKey.set(identity.key, hit.reference);
    matchedOn.set(identity.key, hit.matchedOn);
  }
  return { byKey, matchedOn, unmatched };
}
