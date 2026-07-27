// Accès Supabase au catalogue d'actifs + résolution fournisseur. SERVEUR UNIQUEMENT.
//
// Le navigateur n'appelle JAMAIS Yahoo/EODHD : il interroge /api/instruments/search, qui appelle
// ce module. Aucune clé fournisseur ne peut donc se retrouver dans le bundle client.
//
// Ordre de recherche imposé par le cahier (§4) et implémenté par `searchInstrumentCandidates` :
//   1. catalogue Supabase déjà validé      4. service de résolution (fournisseur), si insuffisant
//   2. actifs déjà détenus dans ce compte  5. fusion
//   3. actifs récemment utilisés           6. déduplication par identité + classement
//
// TOLÉRANCE AU SCHÉMA : tant que la migration 20260811 n'est pas jouée, les lectures catalogue
// échouent proprement et la recherche continue de fonctionner via le fournisseur. C'est la même
// discipline que le reste du code (repli sur erreur PGRST20x / 42P01), et cela évite qu'une
// migration non appliquée transforme la modale en écran mort.

import { supabaseRest } from "./supabase-rest.ts";
import { searchInstruments } from "./market-quotes.ts";
import { instrumentKey } from "./portfolio-account.ts";
import { venueForExchangeLabel, venueForYahooSymbol } from "./market-venues.ts";
import {
  type AssetCandidate,
  type ClassificationStatus,
  type ReviewableAsset,
  type SearchIntent,
  classifyQuery,
  dedupeCandidates,
  normalizeAssetType,
  normalizeCurrency,
  normalizeIsin,
  normalizeMic,
  normalizeTicker,
  rankCandidates,
  validIsinOrNull,
  validateSelection,
} from "./asset-catalog.ts";

/** Une erreur de schéma (table absente) n'est pas une panne : on dégrade au lieu de casser. */
function isMissingSchema(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /PGRST20[0-9]|42P01|42703|asset_listings|public\.assets/i.test(message);
}

type AssetRow = {
  id: string; isin: string | null; name: string; asset_type: string | null;
  classification_status: string | null; issuer: string | null;
  asset_listings?: ListingRow[] | null;
};
type ListingRow = {
  id: string; asset_id?: string; ticker: string | null; exchange: string | null; mic_code: string | null;
  currency: string; country: string | null; eodhd_symbol: string | null; yahoo_symbol: string | null;
  validation_status: string | null; last_price: number | string | null; last_price_at: string | null;
};

const ASSET_SELECT =
  "id,isin,name,asset_type,issuer,classification_status," +
  "asset_listings(id,ticker,exchange,mic_code,currency,country,eodhd_symbol,yahoo_symbol,validation_status,last_price,last_price_at)";

function toStatus(value: string | null | undefined): ClassificationStatus {
  return value === "verified" || value === "inferred" ? value : "needs_review";
}

function toNumberOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Une ligne catalogue devient autant de candidats que l'actif a de cotations. */
function rowToCandidates(row: AssetRow, origin: AssetCandidate["origin"]): AssetCandidate[] {
  const assetType = normalizeAssetType(row.asset_type);
  const confidence = toStatus(row.classification_status);
  const listings = row.asset_listings ?? [];
  if (listings.length === 0) {
    // Actif connu sans cotation : on le propose quand même, mais il ne prétend pas être coté.
    return [{
      assetId: row.id, listingId: null, isin: normalizeIsin(row.isin), name: row.name, assetType,
      ticker: null, exchange: null, micCode: null, currency: "EUR", country: null,
      eodhdSymbol: null, yahooSymbol: null, lastPrice: null, lastPriceAt: null,
      peaEligible: null, origin, confidence,
    }];
  }
  return listings.map((listing) => ({
    assetId: row.id,
    listingId: listing.id,
    isin: normalizeIsin(row.isin),
    name: row.name,
    assetType,
    ticker: normalizeTicker(listing.ticker),
    exchange: listing.exchange,
    micCode: normalizeMic(listing.mic_code),
    currency: normalizeCurrency(listing.currency) ?? "EUR",
    country: listing.country,
    eodhdSymbol: normalizeTicker(listing.eodhd_symbol),
    yahooSymbol: normalizeTicker(listing.yahoo_symbol),
    lastPrice: toNumberOrNull(listing.last_price),
    lastPriceAt: listing.last_price_at,
    peaEligible: null, // aucune source fiable — cf. AssetCandidate.peaEligible
    origin,
    confidence: toStatus(listing.validation_status) === "verified" ? "verified" : confidence,
  }));
}

/** Échappe les caractères PostgREST qui casseraient un filtre `ilike` (virgule, parenthèses). */
function safeTerm(value: string): string {
  return value.replace(/[,()*\\]/g, " ").trim();
}

// ==========================================================================================
// 1. CATALOGUE SUPABASE
// ==========================================================================================
export async function searchCatalog(intent: SearchIntent, limit = 12): Promise<AssetCandidate[]> {
  const term = safeTerm(intent.raw);
  if (!term) return [];
  try {
    // Un ISIN valide est une identité exacte : on ne cherche que lui, c'est la voie prioritaire.
    const filter = intent.isin
      ? `isin=eq.${encodeURIComponent(intent.isin)}`
      : `or=(name.ilike.*${encodeURIComponent(term)}*,isin.ilike.${encodeURIComponent(term)}*)`;
    const rows = await supabaseRest<AssetRow[]>(`assets?select=${ASSET_SELECT}&${filter}&limit=${limit}`);
    const direct = (rows ?? []).flatMap((row) => rowToCandidates(row, "catalog"));
    if (intent.isin || direct.length >= limit) return direct;

    // Recherche par ticker : elle porte sur la COTATION, pas sur l'actif — un même ticker peut
    // désigner plusieurs places, et c'est justement ce que l'utilisateur doit pouvoir arbitrer.
    const byTicker = await supabaseRest<ListingRow[]>(
      `asset_listings?select=${encodeURIComponent("id,asset_id,ticker,exchange,mic_code,currency,country,eodhd_symbol,yahoo_symbol,validation_status,last_price,last_price_at,assets!inner(id,isin,name,asset_type,issuer,classification_status)")}` +
      `&ticker=ilike.${encodeURIComponent(term)}*&limit=${limit}`,
    );
    const viaTicker = (byTicker ?? []).map((listing) => {
      const asset = (listing as ListingRow & { assets?: AssetRow }).assets;
      if (!asset) return null;
      return rowToCandidates({ ...asset, asset_listings: [listing] }, "catalog")[0];
    }).filter((candidate): candidate is AssetCandidate => candidate !== null);
    // Les deux requêtes se recouvrent (« AI » remonte Air Liquide par son nom ET par son ticker).
    // Sans ce dédoublonnage, le même actif compterait deux fois dans le `local.length < limit`
    // qui décide d'interroger le fournisseur : on se croirait servi alors qu'on ne l'est pas.
    return dedupeCandidates([...direct, ...viaTicker]);
  } catch (error) {
    if (isMissingSchema(error)) return []; // migration non jouée → le fournisseur prend le relais
    throw error;
  }
}

// ==========================================================================================
// 2 & 3. DÉJÀ DÉTENUS DANS CE COMPTE, PUIS RÉCEMMENT UTILISÉS
// ==========================================================================================
/**
 * Actifs déjà rattachés à une opération de ce compte (priorité 2) ou des comptes visibles par
 * l'utilisateur (priorité 3). On ne lit QUE `asset_id` : une opération historique sans identité
 * stable n'est pas proposée comme une identité fiable.
 */
export async function searchKnownAssets(
  intent: SearchIntent,
  scope: { accountId?: string | null; memberIds?: string[] },
  limit = 8,
): Promise<AssetCandidate[]> {
  try {
    const filters: string[] = ["asset_id=not.is.null", "select=asset_id", `limit=${limit * 6}`, "order=created_at.desc"];
    if (scope.accountId) filters.push(`account_id=eq.${encodeURIComponent(scope.accountId)}`);
    else if (scope.memberIds?.length) filters.push(`member_id=in.(${scope.memberIds.map(encodeURIComponent).join(",")})`);
    else return [];

    const rows = await supabaseRest<Array<{ asset_id: string | null }>>(`account_operations?${filters.join("&")}`);
    const ids = [...new Set((rows ?? []).map((row) => row.asset_id).filter((id): id is string => Boolean(id)))].slice(0, limit);
    if (ids.length === 0) return [];

    const assets = await supabaseRest<AssetRow[]>(
      `assets?select=${ASSET_SELECT}&id=in.(${ids.map(encodeURIComponent).join(",")})`,
    );
    const origin: AssetCandidate["origin"] = scope.accountId ? "held" : "recent";
    const candidates = (assets ?? []).flatMap((row) => rowToCandidates(row, origin));
    // Ces candidats sont pertinents seulement s'ils répondent à ce que l'utilisateur tape.
    return candidates.filter((candidate) => matchesIntent(intent, candidate));
  } catch (error) {
    if (isMissingSchema(error)) return [];
    throw error;
  }
}

function matchesIntent(intent: SearchIntent, candidate: AssetCandidate): boolean {
  if (intent.isin) return normalizeIsin(candidate.isin) === intent.isin;
  const needle = intent.raw.trim().toLowerCase();
  if (!needle) return false;
  return candidate.name.toLowerCase().includes(needle)
    || (candidate.ticker ?? "").toLowerCase().startsWith(needle)
    || (candidate.isin ?? "").toLowerCase().startsWith(needle);
}

// ==========================================================================================
// 4. SERVICE DE RÉSOLUTION (fournisseur)
// ==========================================================================================
/**
 * Interroge le fournisseur et qualifie chaque résultat via la table de places explicite.
 * L'ISIN n'est renseigné QUE si l'utilisateur a lui-même cherché par ISIN : le fournisseur ne le
 * renvoie pas, et le déduire d'un nom serait exactement l'erreur qu'on corrige.
 */
export async function searchProvider(intent: SearchIntent, limit = 8): Promise<AssetCandidate[] | null> {
  const hits = await searchInstruments(intent.raw);
  if (hits === null) return null; // fournisseur muet — distinct d'une absence de correspondance
  const candidates: AssetCandidate[] = [];
  for (const hit of hits.slice(0, limit)) {
    const venue = venueForYahooSymbol(hit.symbol) ?? venueForExchangeLabel(hit.exchangeLabel);
    if (!venue) continue; // place inconnue → devise inconnue → on ne propose pas une cotation floue
    const ticker = normalizeTicker(hit.symbol.split(".")[0]);
    candidates.push({
      assetId: null,
      listingId: null,
      isin: intent.isin, // null si la recherche portait sur un nom ou un ticker
      name: hit.name ?? ticker ?? hit.symbol,
      assetType: normalizeAssetType(hit.quoteType),
      ticker,
      exchange: venue.exchange,
      micCode: venue.mic,
      currency: venue.currency,
      country: venue.country,
      eodhdSymbol: hit.symbol, // même convention SYMBOLE.PLACE que l'adaptateur EODHD existant
      yahooSymbol: hit.symbol,
      lastPrice: null,
      lastPriceAt: null,
      peaEligible: null,
      origin: "provider",
      confidence: intent.isin ? "inferred" : "needs_review",
    });
  }
  return candidates;
}

// ==========================================================================================
// ORCHESTRATION
// ==========================================================================================
export type SearchOutcome = {
  candidates: AssetCandidate[];
  /** `true` si le fournisseur a été sollicité mais n'a rien pu renvoyer (panne ou quota). */
  providerUnavailable: boolean;
};

export async function searchInstrumentCandidates(
  query: string,
  scope: { accountId?: string | null; memberIds?: string[] } = {},
  limit = 8,
): Promise<SearchOutcome> {
  const intent = classifyQuery(query);
  if (intent.raw.length < 2) return { candidates: [], providerUnavailable: false };

  const [catalog, held, recent] = await Promise.all([
    searchCatalog(intent),
    scope.accountId ? searchKnownAssets(intent, { accountId: scope.accountId }) : Promise.resolve([]),
    scope.memberIds?.length ? searchKnownAssets(intent, { memberIds: scope.memberIds }) : Promise.resolve([]),
  ]);

  // Le fournisseur n'est interrogé que si le local ne suffit pas — un ISIN déjà au catalogue ne
  // déclenche donc aucun appel externe.
  const local = [...held, ...catalog, ...recent];
  let providerUnavailable = false;
  let provider: AssetCandidate[] = [];
  if (local.length < limit) {
    const outcome = await searchProvider(intent, limit);
    // `null` = le fournisseur n'a pas répondu. Un tableau vide signifie qu'il a répondu et que
    // rien ne correspond : c'est « Aucun actif coté trouvé », pas une panne.
    providerUnavailable = outcome === null && local.length === 0;
    provider = outcome ?? [];
  }

  return { candidates: rankCandidates(intent, [...local, ...provider]).slice(0, limit), providerUnavailable };
}

// ==========================================================================================
// LIEN AVEC LE PIPELINE DE COTATIONS
// ==========================================================================================
/** Identité de marché d'une cotation, telle que la consomme le rafraîchissement des cours. */
export type ListingIdentity = {
  listingId: string;
  assetId: string | null;
  name: string;
  isin: string | null;
  assetType: string;
  ticker: string | null;
  exchange: string | null;
  micCode: string | null;
  currency: string;
  country: string | null;
  eodhdSymbol: string | null;
  yahooSymbol: string | null;
  classificationStatus: ClassificationStatus;
};

/**
 * Cotations rattachées aux opérations d'un compte, indexées par la clé d'instrument du moteur
 * (`instrumentKey`) — c'est-à-dire exactement la clé sous laquelle `computeAccountModel` regroupe
 * ses positions. Le pipeline peut donc LIRE le symbole choisi par l'utilisateur au lieu de le
 * redéduire d'un nom, ce qui était la source des « symbole de marché à confirmer ».
 *
 * Les opérations sans `listing_id` (historique, imports) n'apparaissent pas : elles continuent de
 * suivre exactement le chemin d'avant. Aucune reprise implicite.
 */
export async function loadAccountListings(accountId: string): Promise<Map<string, ListingIdentity>> {
  const byKey = new Map<string, ListingIdentity>();
  try {
    const operations = await supabaseRest<Array<{ isin: string | null; ticker: string | null; asset_name: string | null; listing_id: string | null }>>(
      `account_operations?select=isin,ticker,asset_name,listing_id&account_id=eq.${encodeURIComponent(accountId)}&listing_id=not.is.null`,
    );
    if (!operations?.length) return byKey;

    const ids = [...new Set(operations.map((row) => row.listing_id).filter((id): id is string => Boolean(id)))];
    if (ids.length === 0) return byKey;

    const listings = await supabaseRest<Array<ListingRow & { assets?: AssetRow }>>(
      `asset_listings?select=${encodeURIComponent("id,asset_id,ticker,exchange,mic_code,currency,country,eodhd_symbol,yahoo_symbol,validation_status,assets(id,isin,name,asset_type,classification_status)")}` +
      `&id=in.(${ids.map(encodeURIComponent).join(",")})`,
    );
    const byId = new Map<string, ListingIdentity>();
    for (const listing of listings ?? []) {
      const asset = listing.assets;
      byId.set(listing.id, {
        listingId: listing.id,
        assetId: listing.asset_id ?? asset?.id ?? null,
        name: asset?.name ?? "",
        isin: normalizeIsin(asset?.isin ?? null),
        assetType: normalizeAssetType(asset?.asset_type),
        ticker: normalizeTicker(listing.ticker),
        exchange: listing.exchange,
        micCode: normalizeMic(listing.mic_code),
        currency: normalizeCurrency(listing.currency) ?? "EUR",
        country: listing.country,
        eodhdSymbol: normalizeTicker(listing.eodhd_symbol),
        yahooSymbol: normalizeTicker(listing.yahoo_symbol),
        // La cotation prime, mais une classification d'actif « verified » reste la plus forte.
        classificationStatus: toStatus(asset?.classification_status) === "verified" ? "verified" : toStatus(listing.validation_status),
      });
    }

    for (const row of operations) {
      const listing = row.listing_id ? byId.get(row.listing_id) : null;
      if (!listing) continue;
      byKey.set(instrumentKey({ isin: row.isin, ticker: row.ticker, assetName: row.asset_name }), listing);
    }
    return byKey;
  } catch (error) {
    if (isMissingSchema(error)) return byKey; // migration non jouée → pipeline inchangé
    throw error;
  }
}

// ==========================================================================================
// REVUE ADMINISTRATEUR (§13)
// ==========================================================================================
/**
 * Catalogue complet + nombre d'opérations par actif, pour l'écran « Actifs & cotations ».
 * Le tri et la qualification des motifs sont faits par `buildReviewList` (pur, testable) : cette
 * fonction ne fait que lire. `null` si la migration 20260811 n'est pas jouée.
 */
export async function loadReviewableAssets(): Promise<ReviewableAsset[] | null> {
  try {
    const [rows, operations] = await Promise.all([
      supabaseRest<AssetRow[]>(`assets?select=${ASSET_SELECT}&order=name.asc&limit=500`),
      supabaseRest<Array<{ asset_id: string | null }>>("account_operations?select=asset_id&asset_id=not.is.null&limit=5000"),
    ]);
    const usage = new Map<string, number>();
    for (const row of operations ?? []) {
      if (row.asset_id) usage.set(row.asset_id, (usage.get(row.asset_id) ?? 0) + 1);
    }
    return (rows ?? []).map((row) => ({
      assetId: row.id,
      name: row.name,
      isin: normalizeIsin(row.isin),
      assetType: normalizeAssetType(row.asset_type),
      classificationStatus: toStatus(row.classification_status),
      listings: (row.asset_listings ?? []).map((listing) => ({
        listingId: listing.id,
        ticker: normalizeTicker(listing.ticker),
        exchange: listing.exchange,
        micCode: normalizeMic(listing.mic_code),
        currency: normalizeCurrency(listing.currency) ?? "EUR",
        eodhdSymbol: normalizeTicker(listing.eodhd_symbol),
        yahooSymbol: normalizeTicker(listing.yahoo_symbol),
        validationStatus: toStatus(listing.validation_status),
      })),
      operationCount: usage.get(row.id) ?? 0,
    }));
  } catch (error) {
    if (isMissingSchema(error)) return null;
    throw error;
  }
}

export type AdminCorrection = {
  assetId: string;
  name?: string;
  isin?: string | null;
  assetType?: string;
  listing?: {
    listingId?: string;
    ticker?: string | null; exchange?: string | null; micCode?: string | null; currency?: string;
    eodhdSymbol?: string | null; yahooSymbol?: string | null;
  };
};

/**
 * Applique une correction ADMINISTRATEUR : elle est la source de confiance la plus haute et
 * marque l'actif (et la cotation touchée) `verified` — ce que `mergeClassification` et le
 * pipeline de cotations refusent ensuite d'écraser, y compris après une panne fournisseur.
 *
 * Un ISIN n'est jamais effacé silencieusement : le passer à `null` doit être explicite.
 */
export async function applyAdminCorrection(correction: AdminCorrection):
  Promise<{ ok: true } | { ok: false; error: string }> {
  const patch: Record<string, unknown> = { classification_status: "verified", updated_at: new Date().toISOString() };
  if (correction.name !== undefined) {
    const name = String(correction.name).trim();
    if (!name) return { ok: false, error: "Le nom de l'actif est obligatoire." };
    patch.name = name;
  }
  if (correction.isin !== undefined) {
    if (correction.isin === null || String(correction.isin).trim() === "") patch.isin = null;
    else {
      const isin = validIsinOrNull(correction.isin);
      if (!isin) return { ok: false, error: "Cet ISIN est invalide (clé de contrôle)." };
      patch.isin = isin;
    }
  }
  if (correction.assetType !== undefined) patch.asset_type = normalizeAssetType(correction.assetType);

  try {
    await supabaseRest(`assets?id=eq.${encodeURIComponent(correction.assetId)}`, {
      method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify(patch),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/duplicate key|assets_isin_key|23505/i.test(message)) {
      return { ok: false, error: "Un autre actif porte déjà cet ISIN. Fusionnez-les plutôt que de les dupliquer." };
    }
    if (isMissingSchema(error)) return { ok: false, error: "Le catalogue d'actifs n'est pas encore installé (migration 20260811)." };
    throw error;
  }

  const listing = correction.listing;
  if (listing?.listingId) {
    const listingPatch: Record<string, unknown> = { validation_status: "verified", updated_at: new Date().toISOString() };
    if (listing.ticker !== undefined) listingPatch.ticker = normalizeTicker(listing.ticker);
    if (listing.exchange !== undefined) listingPatch.exchange = listing.exchange?.trim() || null;
    if (listing.micCode !== undefined) listingPatch.mic_code = normalizeMic(listing.micCode);
    if (listing.eodhdSymbol !== undefined) listingPatch.eodhd_symbol = normalizeTicker(listing.eodhdSymbol);
    if (listing.yahooSymbol !== undefined) listingPatch.yahoo_symbol = normalizeTicker(listing.yahooSymbol);
    if (listing.currency !== undefined) {
      const currency = normalizeCurrency(listing.currency);
      if (!currency) return { ok: false, error: "La devise de la cotation est invalide." };
      listingPatch.currency = currency;
    }
    try {
      await supabaseRest(`asset_listings?id=eq.${encodeURIComponent(listing.listingId)}`, {
        method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify(listingPatch),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/duplicate key|asset_listings_|23505/i.test(message)) {
        return { ok: false, error: "Une autre cotation porte déjà ce symbole ou cette identité." };
      }
      throw error;
    }
  }
  return { ok: true };
}

// ==========================================================================================
// PERSISTANCE D'UNE SÉLECTION
// ==========================================================================================
export type PersistedIdentity = { assetId: string; listingId: string | null };

/**
 * Enregistre (ou réutilise) l'actif canonique et sa cotation, puis renvoie les identifiants
 * stables à rattacher à l'opération. Jamais de doublon : l'unicité est garantie EN BASE par
 * `assets_isin_key` et `asset_listings_identity_key`, pas seulement par ce code — deux requêtes
 * concurrentes ne peuvent donc pas créer deux fois le même actif.
 *
 * Une classification `verified` déjà en base n'est jamais écrasée (§9).
 */
export async function persistSelection(candidate: AssetCandidate): Promise<PersistedIdentity | null> {
  try {
    const isin = validIsinOrNull(candidate.isin);
    const asset = await resolveAsset(candidate, isin);
    if (!asset) return null;
    const listingId = await resolveListing(asset.id, candidate);
    return { assetId: asset.id, listingId };
  } catch (error) {
    if (isMissingSchema(error)) return null; // migration non jouée : l'opération s'enregistre sans lien
    throw error;
  }
}

/**
 * Transforme la cotation choisie par l'utilisateur en champs d'opération. C'EST LE POINT OÙ
 * L'INCOHÉRENCE TICKER/ISIN DEVIENT IMPOSSIBLE : nom, ticker, ISIN et devise sont RÉÉCRITS depuis
 * la sélection et les champs libres correspondants du corps de requête sont ignorés. Le client ne
 * peut donc plus composer une identité champ par champ, même en forgeant la requête à la main.
 *
 * Renvoie `null` en cas de sélection absente (l'appelant décide si elle était obligatoire).
 */
export async function applySelection(selection: unknown): Promise<
  | { ok: true; fields: { assetName: string; ticker: string | null; isin: string | null; currency: string; assetId?: string; listingId?: string } }
  | { ok: false; error: string }
  | null
> {
  if (!selection || typeof selection !== "object") return null;
  const raw = selection as Partial<AssetCandidate>;
  const checked = validateSelection({
    isin: raw.isin, ticker: raw.ticker, currency: raw.currency, micCode: raw.micCode, name: raw.name,
  });
  if (!checked.ok) return { ok: false, error: checked.error };

  const candidate: AssetCandidate = {
    assetId: typeof raw.assetId === "string" ? raw.assetId : null,
    listingId: typeof raw.listingId === "string" ? raw.listingId : null,
    isin: checked.isin, name: checked.name, assetType: normalizeAssetType(raw.assetType),
    ticker: checked.ticker, exchange: raw.exchange ?? null, micCode: checked.micCode,
    currency: checked.currency, country: raw.country ?? null,
    eodhdSymbol: normalizeTicker(raw.eodhdSymbol), yahooSymbol: normalizeTicker(raw.yahooSymbol),
    lastPrice: null, lastPriceAt: null, peaEligible: null,
    origin: "provider",
    // Le client ne peut pas s'auto-déclarer « verified » : seule une correction administrateur
    // passant par /api/market-data/assets/[id] confère ce statut.
    confidence: raw.confidence === "verified" ? "inferred" : toStatus(raw.confidence),
  };

  const identity = await persistSelection(candidate);
  return {
    ok: true,
    fields: {
      assetName: checked.name, ticker: checked.ticker, isin: checked.isin, currency: checked.currency,
      ...(identity?.assetId ? { assetId: identity.assetId } : {}),
      ...(identity?.listingId ? { listingId: identity.listingId } : {}),
    },
  };
}

async function resolveAsset(candidate: AssetCandidate, isin: string | null): Promise<{ id: string } | null> {
  if (candidate.assetId) return { id: candidate.assetId };

  if (isin) {
    const existing = await supabaseRest<Array<{ id: string }>>(
      `assets?select=id&isin=eq.${encodeURIComponent(isin)}&limit=1`,
    );
    if (existing?.[0]) return existing[0];
  }

  // Le fournisseur ne renvoie PAS d'ISIN sur une recherche par nom ou par ticker. Sans ce
  // rattrapage, choisir « Air Liquide » par son nom puis par son ISIN créerait DEUX actifs pour
  // le même instrument — l'index unique sur l'ISIN ne couvrant pas les lignes à ISIN nul.
  // Le symbole fournisseur, lui, est unique par cotation : il permet de retrouver l'actif.
  const symbol = candidate.yahooSymbol ?? candidate.eodhdSymbol;
  if (symbol) {
    const column = candidate.yahooSymbol ? "yahoo_symbol" : "eodhd_symbol";
    const known = await supabaseRest<Array<{ asset_id: string }>>(
      `asset_listings?select=asset_id&${column}=eq.${encodeURIComponent(symbol)}&limit=1`,
    );
    if (known?.[0]?.asset_id) {
      // Un ISIN nouvellement connu enrichit l'actif existant, sans jamais en écraser un autre.
      if (isin) await enrichAssetIsin(known[0].asset_id, isin);
      return { id: known[0].asset_id };
    }
  }

  const inserted = await supabaseRest<Array<{ id: string }>>("assets?select=id", {
    method: "POST",
    headers: { prefer: "return=representation,resolution=merge-duplicates" },
    body: JSON.stringify({
      isin,
      name: candidate.name,
      asset_type: candidate.assetType,
      classification_status: candidate.confidence === "verified" ? "verified" : isin ? "inferred" : "needs_review",
      source: candidate.origin,
    }),
  });
  if (inserted?.[0]) return inserted[0];
  // Course perdue contre une insertion concurrente : la contrainte d'unicité a joué, on relit.
  if (!isin) return null;
  const reread = await supabaseRest<Array<{ id: string }>>(`assets?select=id&isin=eq.${encodeURIComponent(isin)}&limit=1`);
  return reread?.[0] ?? null;
}

/**
 * Complète l'ISIN d'un actif qui n'en avait pas encore. Ne remplace JAMAIS un ISIN existant :
 * changer l'identité d'un actif déjà rattaché à des opérations réécrirait leur histoire.
 */
async function enrichAssetIsin(assetId: string, isin: string): Promise<void> {
  try {
    await supabaseRest(`assets?id=eq.${encodeURIComponent(assetId)}&isin=is.null`, {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ isin, updated_at: new Date().toISOString() }),
    });
  } catch {
    // Un autre actif porte déjà cet ISIN (violation d'unicité) : on garde l'actif trouvé tel
    // quel plutôt que d'échouer l'enregistrement de l'opération. Le cas relève d'une revue.
  }
}

async function resolveListing(assetId: string, candidate: AssetCandidate): Promise<string | null> {
  if (candidate.listingId) return candidate.listingId;
  const currency = normalizeCurrency(candidate.currency);
  if (!currency) return null; // sans devise il n'y a pas de cotation : on ne fabrique pas un lien faux

  const mic = normalizeMic(candidate.micCode);
  const ticker = normalizeTicker(candidate.ticker);
  const filters = [
    `asset_id=eq.${encodeURIComponent(assetId)}`,
    `currency=eq.${encodeURIComponent(currency)}`,
    mic ? `mic_code=eq.${encodeURIComponent(mic)}` : "mic_code=is.null",
    ticker ? `ticker=eq.${encodeURIComponent(ticker)}` : "ticker=is.null",
  ];
  const existing = await supabaseRest<Array<{ id: string }>>(`asset_listings?select=id&${filters.join("&")}&limit=1`);
  if (existing?.[0]) return existing[0].id;

  const inserted = await supabaseRest<Array<{ id: string }>>("asset_listings?select=id", {
    method: "POST",
    headers: { prefer: "return=representation" },
    body: JSON.stringify({
      asset_id: assetId, ticker, exchange: candidate.exchange, mic_code: mic, currency,
      country: candidate.country, eodhd_symbol: candidate.eodhdSymbol, yahoo_symbol: candidate.yahooSymbol,
      validation_status: candidate.confidence === "verified" ? "verified" : "inferred",
      source: candidate.origin,
    }),
  });
  if (inserted?.[0]) return inserted[0].id;
  const reread = await supabaseRest<Array<{ id: string }>>(`asset_listings?select=id&${filters.join("&")}&limit=1`);
  return reread?.[0]?.id ?? null;
}
