// Identité d'un actif coté — logique PURE (aucun réseau, aucune base).
//
// RAISON D'ÊTRE : jusqu'ici l'identité d'un actif n'était pas SAISIE, elle était DEVINÉE après
// coup par instrumentKey() (ISIN → sinon ticker → sinon nom, lib/portfolio-account.ts:179).
// Saisir « CW8 » avec l'ISIN d'un autre instrument produisait donc une clé cohérente en apparence
// portant deux références contradictoires, et plus rien en aval ne pouvait les départager.
// Ce module fabrique l'inverse : un candidat n'existe que s'il porte SIMULTANÉMENT sa cotation
// (place + devise + symboles), et la déduplication se fait sur cette identité complète.
//
// Aucune valeur n'est inventée : un champ absent chez la source reste `null` et l'interface
// affiche « — ». En particulier l'éligibilité PEA n'est PAS déduite du pays ou de l'ISIN.

import { isValidIsin } from "./investment-import.ts";

export type NormalizedAssetType = "stock" | "etf" | "fund" | "bond" | "reit" | "gold" | "crypto" | "cash" | "other";

export const ASSET_TYPES: readonly NormalizedAssetType[] = [
  "stock", "etf", "fund", "bond", "reit", "gold", "crypto", "cash", "other",
] as const;

/** Libellés français des types normalisés (l'interface traduit, la base reste en anglais). */
export const ASSET_TYPE_LABEL: Record<NormalizedAssetType, string> = {
  stock: "Action", etf: "ETF", fund: "Fonds", bond: "Obligation", reit: "Foncière",
  gold: "Or", crypto: "Crypto", cash: "Espèces", other: "Autre",
};

export type ClassificationStatus = "verified" | "inferred" | "needs_review";

/** Provenance d'un candidat — pilote le classement ET ce qu'on a le droit d'écrire. */
export type CandidateOrigin = "held" | "catalog" | "recent" | "provider";

export type AssetCandidate = {
  /** Renseignés si l'identité existe déjà en base : la sélection les réutilise sans créer de doublon. */
  assetId: string | null;
  listingId: string | null;
  isin: string | null;
  name: string;
  assetType: NormalizedAssetType;
  ticker: string | null;
  exchange: string | null;
  micCode: string | null;
  currency: string;
  country: string | null;
  eodhdSymbol: string | null;
  yahooSymbol: string | null;
  lastPrice: number | null;
  lastPriceAt: string | null;
  /**
   * `null` tant que la donnée n'est pas fiable — et elle ne l'est pas aujourd'hui : aucune de nos
   * sources ne publie l'éligibilité PEA. Le cahier impose de n'afficher le badge QUE si la donnée
   * est fiable, donc l'interface n'affiche rien plutôt qu'une déduction pays/ISIN fausse pour les
   * ETF synthétiques (un ETF World irlandais est éligible, un ETF US ne l'est pas).
   */
  peaEligible: boolean | null;
  origin: CandidateOrigin;
  confidence: ClassificationStatus;
};

// ==========================================================================================
// NORMALISATION
// ==========================================================================================

export function normalizeIsin(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim().toUpperCase().replace(/\s+/g, "");
  return raw ? raw : null;
}

/** Un ISIN n'est retenu que s'il passe la clé de contrôle Luhn — sinon il n'identifie rien. */
export function validIsinOrNull(value: string | null | undefined): string | null {
  const isin = normalizeIsin(value);
  return isin && isValidIsin(isin) ? isin : null;
}

export function normalizeCurrency(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(raw) ? raw : null;
}

export function normalizeMic(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim().toUpperCase();
  return /^[A-Z0-9]{4}$/.test(raw) ? raw : null;
}

export function normalizeTicker(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim().toUpperCase();
  return raw ? raw : null;
}

/**
 * Ramène un type fournisseur/import vers le référentiel normalisé. Un type inconnu devient
 * `other` — mais `other` N'EST JAMAIS écrit sur un actif déjà classé (cf. mergeClassification).
 */
export function normalizeAssetType(value: string | null | undefined): NormalizedAssetType {
  const raw = String(value ?? "").trim().toLowerCase();
  switch (raw) {
    case "stock": case "equity": case "common stock": case "action":
      return "stock";
    case "etf": case "exchange traded fund": case "etp":
      return "etf";
    case "fund": case "mutualfund": case "mutual fund": case "sicav": case "fcp": case "fonds":
      return "fund";
    case "bond": case "obligation":
      return "bond";
    case "reit": case "foncière": case "fonciere":
      return "reit";
    case "gold": case "or":
      return "gold";
    case "crypto": case "cryptocurrency":
      return "crypto";
    case "cash": case "espèces": case "especes": case "monétaire": case "monetaire":
      return "cash";
    default:
      return "other";
  }
}

// ==========================================================================================
// CLASSIFICATION — ordre de confiance (§10 du cahier)
// ==========================================================================================
// 1. métadonnées validées en base  2. correction manuelle  3. ISIN/référentiel fiable
// 4. type du service de résolution  5. type importé  6. needs_review
//
// INVARIANT CRITIQUE : une panne de cours n'entre pas dans cette fonction. Un échec EODHD ou
// Yahoo ne peut donc pas transformer une action en « Autre » — c'était le comportement observé.
export function mergeClassification(
  current: { assetType: NormalizedAssetType; status: ClassificationStatus } | null,
  incoming: { assetType: NormalizedAssetType; status: ClassificationStatus },
): { assetType: NormalizedAssetType; status: ClassificationStatus } {
  if (!current) return incoming;
  // Une correction administrateur est immuable : rien ne l'écrase, jamais.
  if (current.status === "verified") return current;
  if (incoming.status === "verified") return incoming;
  // Un type connu ne régresse pas vers « other » : l'absence d'information n'est pas une information.
  if (incoming.assetType === "other" && current.assetType !== "other") return current;
  if (current.assetType === "other" && incoming.assetType !== "other") return incoming;
  return current.status === "inferred" ? current : incoming;
}

// ==========================================================================================
// IDENTITÉ D'UNE COTATION & DÉDUPLICATION
// ==========================================================================================

/**
 * Clé d'identité d'une cotation : ISIN + MIC + devise, comme demandé au §4.7. Les replis sont
 * explicites et ordonnés — sans ISIN on retombe sur le symbole fournisseur (qui porte déjà la
 * place), puis sur ticker+devise. Deux candidats partageant cette clé sont le MÊME instrument
 * sur la MÊME place : les fusionner est sûr.
 */
export function listingIdentityKey(candidate: Pick<AssetCandidate, "isin" | "micCode" | "currency" | "yahooSymbol" | "eodhdSymbol" | "ticker" | "name">): string {
  const isin = normalizeIsin(candidate.isin);
  const currency = normalizeCurrency(candidate.currency) ?? "";
  const mic = normalizeMic(candidate.micCode) ?? "";
  if (isin) return `isin:${isin}|${mic}|${currency}`;
  const symbol = normalizeTicker(candidate.yahooSymbol) ?? normalizeTicker(candidate.eodhdSymbol);
  if (symbol) return `sym:${symbol}`;
  const ticker = normalizeTicker(candidate.ticker);
  if (ticker) return `tkr:${ticker}|${mic}|${currency}`;
  return `name:${candidate.name.trim().toLowerCase()}|${currency}`;
}

/** Poids de provenance : ce qui est déjà en base prime sur ce qui vient d'un fournisseur. */
const ORIGIN_RANK: Record<CandidateOrigin, number> = { held: 0, catalog: 1, recent: 2, provider: 3 };

/**
 * Fusionne deux candidats de même identité. Le gagnant est celui de meilleure provenance ; on lui
 * greffe les champs que l'autre est seul à connaître (un fournisseur apporte souvent le cours, le
 * catalogue apporte les identifiants stables). Aucun champ n'est écrasé par un `null`.
 */
export function mergeCandidates(a: AssetCandidate, b: AssetCandidate): AssetCandidate {
  const [winner, other] = ORIGIN_RANK[a.origin] <= ORIGIN_RANK[b.origin] ? [a, b] : [b, a];
  const classification = mergeClassification(
    { assetType: winner.assetType, status: winner.confidence },
    { assetType: other.assetType, status: other.confidence },
  );
  const fresher = pickFresherPrice(winner, other);
  return {
    ...winner,
    assetId: winner.assetId ?? other.assetId,
    listingId: winner.listingId ?? other.listingId,
    isin: winner.isin ?? other.isin,
    ticker: winner.ticker ?? other.ticker,
    exchange: winner.exchange ?? other.exchange,
    micCode: winner.micCode ?? other.micCode,
    country: winner.country ?? other.country,
    eodhdSymbol: winner.eodhdSymbol ?? other.eodhdSymbol,
    yahooSymbol: winner.yahooSymbol ?? other.yahooSymbol,
    lastPrice: fresher.lastPrice,
    lastPriceAt: fresher.lastPriceAt,
    peaEligible: winner.peaEligible ?? other.peaEligible,
    assetType: classification.assetType,
    confidence: classification.status,
  };
}

function pickFresherPrice(a: AssetCandidate, b: AssetCandidate): { lastPrice: number | null; lastPriceAt: string | null } {
  if (a.lastPrice === null) return { lastPrice: b.lastPrice, lastPriceAt: b.lastPriceAt };
  if (b.lastPrice === null) return { lastPrice: a.lastPrice, lastPriceAt: a.lastPriceAt };
  if (!a.lastPriceAt) return { lastPrice: b.lastPrice, lastPriceAt: b.lastPriceAt };
  if (!b.lastPriceAt) return { lastPrice: a.lastPrice, lastPriceAt: a.lastPriceAt };
  return a.lastPriceAt >= b.lastPriceAt ? { lastPrice: a.lastPrice, lastPriceAt: a.lastPriceAt } : { lastPrice: b.lastPrice, lastPriceAt: b.lastPriceAt };
}

/** Déduplique par identité canonique + cotation, en conservant l'ordre d'arrivée des gagnants. */
export function dedupeCandidates(candidates: AssetCandidate[]): AssetCandidate[] {
  const byKey = new Map<string, AssetCandidate>();
  const order: string[] = [];
  for (const candidate of candidates) {
    const key = listingIdentityKey(candidate);
    const existing = byKey.get(key);
    if (existing) byKey.set(key, mergeCandidates(existing, candidate));
    else { byKey.set(key, candidate); order.push(key); }
  }
  return order.map((key) => byKey.get(key)!);
}

// ==========================================================================================
// PERTINENCE
// ==========================================================================================

export type SearchIntent = { raw: string; isin: string | null; kind: "isin" | "ticker" | "name" };

/**
 * Qualifie ce que l'utilisateur a tapé. Un ISIN complet ET valide déclenche une recherche exacte
 * prioritaire (§4) ; une chaîne courte et compacte est traitée comme un ticker.
 */
export function classifyQuery(query: string): SearchIntent {
  const raw = query.trim();
  const compact = raw.toUpperCase().replace(/\s+/g, "");
  const isin = validIsinOrNull(compact);
  if (isin) return { raw, isin, kind: "isin" };
  if (/^[A-Z0-9.\-]{1,6}$/.test(compact) && !compact.includes(" ")) return { raw, isin: null, kind: "ticker" };
  return { raw, isin: null, kind: "name" };
}

/** Score de pertinence — plus haut = plus pertinent. Déterministe et testable. */
export function scoreCandidate(intent: SearchIntent, candidate: AssetCandidate): number {
  let score = 0;
  const needle = intent.raw.trim().toLowerCase();
  const name = candidate.name.toLowerCase();
  const ticker = (candidate.ticker ?? "").toLowerCase();

  if (intent.isin && normalizeIsin(candidate.isin) === intent.isin) score += 1000; // identité exacte
  if (intent.kind === "ticker" && ticker && ticker === needle) score += 400;
  else if (ticker.startsWith(needle) && needle.length >= 2) score += 150;
  if (name === needle) score += 300;
  else if (name.startsWith(needle)) score += 120;
  else if (name.includes(needle)) score += 60;

  score += (3 - ORIGIN_RANK[candidate.origin]) * 50;       // déjà détenu / déjà connu d'abord
  if (candidate.confidence === "verified") score += 40;
  else if (candidate.confidence === "inferred") score += 15;
  if (candidate.isin) score += 25;                          // une identité stable vaut mieux
  if (candidate.micCode) score += 10;                       // cotation pleinement qualifiée
  if (candidate.lastPrice !== null) score += 5;
  if (candidate.currency === "EUR") score += 5;             // le compte est libellé en euros
  return score;
}

export function rankCandidates(intent: SearchIntent, candidates: AssetCandidate[]): AssetCandidate[] {
  return dedupeCandidates(candidates)
    .map((candidate, index) => ({ candidate, index, score: scoreCandidate(intent, candidate) }))
    .sort((a, b) => (b.score - a.score) || (a.index - b.index)) // stable à score égal
    .map((entry) => entry.candidate);
}

// ==========================================================================================
// COHÉRENCE D'UNE SÉLECTION
// ==========================================================================================

/**
 * Refuse une identité composite incohérente. C'est le garde-fou serveur qui rend impossible le
 * couple observé « ticker CW8 + ISIN FR0010315770 » : on n'accepte plus des références assemblées
 * champ par champ, seulement une cotation entière et cohérente.
 */
export function validateSelection(input: {
  isin?: string | null; ticker?: string | null; currency?: string | null; micCode?: string | null; name?: string | null;
}): { ok: true; isin: string | null; ticker: string | null; currency: string; micCode: string | null; name: string } | { ok: false; error: string } {
  const name = String(input.name ?? "").trim();
  if (!name) return { ok: false, error: "L'actif sélectionné n'a pas de nom." };
  const rawIsin = normalizeIsin(input.isin);
  if (rawIsin && !isValidIsin(rawIsin)) {
    return { ok: false, error: "Les références de cet actif ne correspondent pas. Vérifiez la cotation avant de continuer." };
  }
  const currency = normalizeCurrency(input.currency);
  if (!currency) return { ok: false, error: "La devise de la cotation est manquante ou invalide." };
  return { ok: true, isin: rawIsin, ticker: normalizeTicker(input.ticker), currency, micCode: normalizeMic(input.micCode), name };
}

/** Résumé d'une cotation pour l'interface : « CW8 · Euronext Paris · EUR ». */
export function describeListing(candidate: Pick<AssetCandidate, "ticker" | "exchange" | "currency">): string {
  return [candidate.ticker, candidate.exchange, candidate.currency].filter(Boolean).join(" · ");
}

// ==========================================================================================
// REVUE ADMINISTRATEUR (§13) — pourquoi un actif mérite un coup d'œil
// ==========================================================================================

export type ReviewReason =
  | "needs_review"        // classification non confirmée
  | "no_listing"          // actif sans aucune cotation : aucun cours ne pourra s'y rattacher
  | "no_provider_symbol"  // cotation sans symbole fournisseur : synchronisation impossible
  | "no_isin"             // identité faible : rattaché par nom/ticker seulement
  | "conflict";           // deux actifs distincts revendiquent le même ticker sur la même place

export const REVIEW_REASON_LABEL: Record<ReviewReason, string> = {
  needs_review: "Classification à confirmer",
  no_listing: "Sans cotation",
  no_provider_symbol: "Sans symbole fournisseur",
  no_isin: "Sans ISIN",
  conflict: "En conflit",
};

/** Explication affichée à l'administrateur : ce qui manque, et ce que ça empêche concrètement. */
export const REVIEW_REASON_DETAIL: Record<ReviewReason, string> = {
  needs_review: "Le type de cet actif n’a pas été confirmé. Il reste utilisable, mais il apparaît en « Autre » dans les répartitions.",
  no_listing: "Aucune place de cotation n’est rattachée : aucun cours ne peut être synchronisé tant qu’il n’y en a pas.",
  no_provider_symbol: "La cotation n’a ni symbole EODHD ni symbole Yahoo : la synchronisation du cours échouera silencieusement.",
  no_isin: "L’actif est identifié par son nom et son ticker seulement. Un ISIN le rendrait insensible aux changements de ticker.",
  conflict: "Plusieurs actifs revendiquent le même ticker sur la même place avec des ISIN différents : l’un d’eux est probablement en double.",
};

export type ReviewableAsset = {
  assetId: string;
  name: string;
  isin: string | null;
  assetType: NormalizedAssetType;
  classificationStatus: ClassificationStatus;
  listings: Array<{
    listingId: string; ticker: string | null; exchange: string | null; micCode: string | null;
    currency: string; eodhdSymbol: string | null; yahooSymbol: string | null; validationStatus: ClassificationStatus;
  }>;
  /** Nombre d'opérations rattachées — un actif utilisé mérite d'être corrigé en priorité. */
  operationCount: number;
};

/**
 * Classe les actifs à revoir. PURE et donc testable : c'est la même fonction qui décide de la
 * liste affichée et de son ordre, pas une requête SQL différente par onglet.
 *
 * Un actif `verified` n'est JAMAIS signalé pour sa classification — une correction administrateur
 * est définitive. Il peut en revanche l'être pour un manque concret (pas de cotation, pas de
 * symbole), car cela empêche réellement la synchronisation.
 */
export function reviewReasons(asset: ReviewableAsset, allAssets: ReviewableAsset[] = []): ReviewReason[] {
  const reasons: ReviewReason[] = [];

  // Conflit : même ticker + même place, mais deux ISIN différents. C'est la trace d'un doublon.
  const conflicting = allAssets.some((other) => {
    if (other.assetId === asset.assetId) return false;
    const sameIsin = normalizeIsin(other.isin) !== null && normalizeIsin(other.isin) === normalizeIsin(asset.isin);
    if (sameIsin) return false;
    return other.listings.some((theirs) => asset.listings.some((ours) =>
      ours.ticker !== null && theirs.ticker === ours.ticker
      && (ours.micCode ?? "") === (theirs.micCode ?? "")
      && ours.currency === theirs.currency));
  });
  if (conflicting) reasons.push("conflict");

  if (asset.classificationStatus === "needs_review") reasons.push("needs_review");
  if (asset.listings.length === 0) reasons.push("no_listing");
  else if (asset.listings.every((listing) => !listing.eodhdSymbol && !listing.yahooSymbol)) reasons.push("no_provider_symbol");
  if (!normalizeIsin(asset.isin)) reasons.push("no_isin");

  return reasons;
}

const REASON_SEVERITY: Record<ReviewReason, number> = {
  conflict: 0, no_listing: 1, no_provider_symbol: 2, needs_review: 3, no_isin: 4,
};

/**
 * Liste de revue, la plus gênante d'abord, puis les actifs les plus utilisés — corriger un actif
 * porté par 40 opérations vaut mieux que d'en corriger un jamais employé.
 */
export function buildReviewList(assets: ReviewableAsset[]): Array<ReviewableAsset & { reasons: ReviewReason[] }> {
  return assets
    .map((asset) => ({ ...asset, reasons: reviewReasons(asset, assets) }))
    .filter((asset) => asset.reasons.length > 0)
    .sort((a, b) => {
      const severity = Math.min(...a.reasons.map((reason) => REASON_SEVERITY[reason]))
        - Math.min(...b.reasons.map((reason) => REASON_SEVERITY[reason]));
      return severity !== 0 ? severity : (b.operationCount - a.operationCount) || a.name.localeCompare(b.name, "fr");
    });
}
