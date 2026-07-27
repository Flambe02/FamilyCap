// Identité d'un actif coté — règles PURES de lib/asset-catalog.ts (aucun appel réseau).
//
// RÉGRESSION PRINCIPALE COUVERTE : l'incohérence ticker / ISIN.
// Avant, la modale offrait quatre champs libres (Nom, Ticker, ISIN, Devise) et l'identité était
// DEVINÉE après coup par instrumentKey() (ISIN → sinon ticker → sinon nom). Saisir « CW8 » avec
// l'ISIN FR0010315770 produisait donc une clé d'apparence cohérente portant deux références
// contradictoires — d'où les symboles invalides chez les fournisseurs, les doublons d'actifs et
// les cours impossibles à synchroniser. Ces tests verrouillent l'inverse : une identité n'existe
// que complète (actif + cotation), et une panne de cours ne peut PAS la dégrader.
//
//   node --test tests/asset-catalog.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ASSET_TYPE_LABEL,
  REVIEW_REASON_DETAIL,
  REVIEW_REASON_LABEL,
  buildReviewList,
  reviewReasons,
  classifyQuery,
  dedupeCandidates,
  describeListing,
  listingIdentityKey,
  mergeCandidates,
  mergeClassification,
  normalizeAssetType,
  normalizeIsin,
  normalizeMic,
  rankCandidates,
  scoreCandidate,
  validIsinOrNull,
  validateSelection,
} from "../lib/asset-catalog.ts";

// ---- fabrique de candidat : tout est explicite, rien n'est deviné ------------------------
function candidate(overrides = {}) {
  return {
    assetId: null, listingId: null, isin: null, name: "Actif", assetType: "other",
    ticker: null, exchange: null, micCode: null, currency: "EUR", country: null,
    eodhdSymbol: null, yahooSymbol: null, lastPrice: null, lastPriceAt: null,
    peaEligible: null, origin: "provider", confidence: "needs_review",
    ...overrides,
  };
}

const AIR_LIQUIDE = candidate({
  isin: "FR0000120073", name: "Air Liquide", assetType: "stock", ticker: "AI",
  exchange: "Euronext Paris", micCode: "XPAR", currency: "EUR",
  eodhdSymbol: "AI.PA", yahooSymbol: "AI.PA", origin: "catalog", confidence: "verified",
});

// La cotation CW8 telle qu'elle apparaît dans l'écran de référence. Le point n'est PAS qu'un
// ISIN donné serait « le bon » : c'est que le ticker et l'ISIN proviennent désormais de la MÊME
// ligne de cotation, au lieu d'être frappés dans deux champs indépendants.
const CW8 = candidate({
  isin: "LU1681043599", name: "Amundi MSCI World Swap UCITS ETF", assetType: "etf", ticker: "CW8",
  exchange: "Euronext Paris", micCode: "XPAR", currency: "EUR",
  eodhdSymbol: "CW8.PA", yahooSymbol: "CW8.PA", origin: "catalog", confidence: "inferred",
  lastPrice: 679.33, lastPriceAt: "2026-07-24T00:00:00.000Z",
});

// ==========================================================================================
// 1-3. QUALIFICATION DE LA RECHERCHE : nom, ticker, ISIN exact
// ==========================================================================================
test("recherche par nom : traitée comme un nom, sans ISIN implicite", () => {
  const intent = classifyQuery("Air Liquide");
  assert.equal(intent.kind, "name");
  assert.equal(intent.isin, null);
});

test("recherche par ticker : « AI » et « CW8 » sont des tickers, pas des noms", () => {
  assert.equal(classifyQuery("AI").kind, "ticker");
  assert.equal(classifyQuery("CW8").kind, "ticker");
});

test("recherche par ISIN : un ISIN complet ET valide déclenche la voie exacte", () => {
  const intent = classifyQuery("FR0000120073");
  assert.equal(intent.kind, "isin");
  assert.equal(intent.isin, "FR0000120073");
  // Minuscules et espaces collés restent le même identifiant.
  assert.equal(classifyQuery(" fr0000120073 ").isin, "FR0000120073");
});

test("un ISIN à la clé de contrôle FAUSSE n'est jamais traité comme une identité", () => {
  // FR0000120074 : même corps, dernier chiffre erroné → Luhn échoue.
  assert.equal(validIsinOrNull("FR0000120074"), null);
  assert.notEqual(classifyQuery("FR0000120074").kind, "isin");
});

// ==========================================================================================
// 4-5. DIFFÉRENCIATION PAR PLACE ET DÉDUPLICATION
// ==========================================================================================
test("résultats différenciés par place : même actif, deux cotations = deux entrées distinctes", () => {
  const paris = { ...AIR_LIQUIDE };
  const francfort = candidate({
    ...AIR_LIQUIDE, exchange: "Francfort", micCode: "XFRA", ticker: "AIL", yahooSymbol: "AIL.F", eodhdSymbol: "AIL.F",
  });
  assert.notEqual(listingIdentityKey(paris), listingIdentityKey(francfort));
  assert.equal(dedupeCandidates([paris, francfort]).length, 2);
});

test("déduplication par ISIN + MIC + devise : la même cotation vue deux fois n'apparaît qu'une fois", () => {
  const fromCatalog = { ...AIR_LIQUIDE };
  const fromProvider = candidate({
    isin: "FR0000120073", name: "AIR LIQUIDE SA", assetType: "stock", ticker: "AI",
    exchange: "Euronext Paris", micCode: "XPAR", currency: "EUR", yahooSymbol: "AI.PA",
    origin: "provider", confidence: "needs_review", lastPrice: 176.42, lastPriceAt: "2026-07-24T00:00:00.000Z",
  });
  const merged = dedupeCandidates([fromCatalog, fromProvider]);
  assert.equal(merged.length, 1);
  // Le catalogue gagne l'identité ; le fournisseur n'apporte que ce qu'il est seul à savoir.
  assert.equal(merged[0].name, "Air Liquide");
  assert.equal(merged[0].confidence, "verified");
  assert.equal(merged[0].lastPrice, 176.42);
});

test("fusion : un champ absent n'écrase jamais un champ renseigné", () => {
  const rich = { ...AIR_LIQUIDE };
  const poor = candidate({ isin: "FR0000120073", name: "Air Liquide", micCode: "XPAR", currency: "EUR", origin: "provider" });
  const merged = mergeCandidates(rich, poor);
  assert.equal(merged.ticker, "AI");
  assert.equal(merged.eodhdSymbol, "AI.PA");
  assert.equal(merged.exchange, "Euronext Paris");
});

// ==========================================================================================
// 8 & 10. UNE COMBINAISON TICKER / ISIN INCOHÉRENTE EST IRRECEVABLE
// ==========================================================================================
test("CW8 ne peut pas être lié à un ISIN arbitraire : ticker et ISIN viennent de la MÊME cotation", () => {
  // L'ancienne saisie permettait d'assembler ces deux références dans deux champs indépendants.
  // Désormais on ne choisit pas un ticker et un ISIN : on choisit une cotation, qui les porte
  // tous les deux. Les dissocier n'est plus représentable dans le modèle.
  const ranked = rankCandidates(classifyQuery("CW8"), [CW8, AIR_LIQUIDE]);
  assert.equal(ranked[0].ticker, "CW8");
  assert.equal(ranked[0].isin, CW8.isin, "l'ISIN proposé est celui de la cotation, jamais un autre");
  assert.equal(ranked[0].micCode, "XPAR");
  assert.equal(ranked[0].currency, "EUR");
});

test("une identité forgée avec un ISIN à clé de contrôle fausse est refusée côté serveur", () => {
  // Même en contournant l'interface, un corps de requête portant un ISIN qui n'identifie rien
  // ne franchit pas validateSelection.
  const forged = validateSelection({ name: "Amundi MSCI World", ticker: "CW8", isin: "LU1681043598", currency: "EUR" });
  assert.equal(forged.ok, false);
  assert.match(forged.error, /références de cet actif ne correspondent pas/i);
});

test("une sélection sans devise est refusée : sans devise il n'y a pas de cotation", () => {
  const result = validateSelection({ name: "Air Liquide", ticker: "AI", isin: "FR0000120073", currency: "" });
  assert.equal(result.ok, false);
  assert.match(result.error, /devise/i);
});

test("une sélection sans nom est refusée", () => {
  assert.equal(validateSelection({ name: "  ", currency: "EUR" }).ok, false);
});

test("une sélection cohérente est normalisée (ISIN et devise en majuscules, MIC validé)", () => {
  const result = validateSelection({ name: "Air Liquide", ticker: "ai", isin: "fr0000120073", currency: "eur", micCode: "xpar" });
  assert.equal(result.ok, true);
  assert.equal(result.isin, "FR0000120073");
  assert.equal(result.ticker, "AI");
  assert.equal(result.currency, "EUR");
  assert.equal(result.micCode, "XPAR");
});

// ==========================================================================================
// 9. LE CAS DE RÉFÉRENCE : AIR LIQUIDE
// ==========================================================================================
test("Air Liquide : FR0000120073, AI, Euronext Paris, EUR — les quatre viennent de la MÊME cotation", () => {
  assert.equal(AIR_LIQUIDE.isin, "FR0000120073");
  assert.equal(AIR_LIQUIDE.ticker, "AI");
  assert.equal(AIR_LIQUIDE.exchange, "Euronext Paris");
  assert.equal(AIR_LIQUIDE.currency, "EUR");
  assert.equal(AIR_LIQUIDE.micCode, "XPAR");
  assert.equal(describeListing(AIR_LIQUIDE), "AI · Euronext Paris · EUR");
});

test("les trois recherches — nom, ticker, ISIN — désignent la même cotation Air Liquide", () => {
  const pool = [AIR_LIQUIDE, CW8];
  for (const query of ["Air Liquide", "AI", "FR0000120073"]) {
    const best = rankCandidates(classifyQuery(query), pool)[0];
    assert.equal(best.isin, "FR0000120073", `« ${query} » doit remonter Air Liquide en tête`);
    assert.equal(best.micCode, "XPAR");
    assert.equal(best.currency, "EUR");
  }
});

test("une recherche par ISIN exact place l'identité exacte devant tout le reste", () => {
  // L'homonyme n'a délibérément pas d'ISIN : on ne fabrique pas un identifiant réel de plus.
  const homonyme = candidate({ name: "Air Liquide Finance", ticker: "AIF", micCode: "XPAR", origin: "catalog" });
  const ranked = rankCandidates(classifyQuery("FR0000120073"), [homonyme, AIR_LIQUIDE]);
  assert.equal(ranked[0].isin, "FR0000120073");
});

test("classement : un actif déjà détenu passe devant un résultat fournisseur équivalent", () => {
  const held = candidate({ name: "Air Liquide", ticker: "AI", isin: "FR0000120073", micCode: "XPAR", origin: "held" });
  const remote = candidate({ name: "Air Liquide", ticker: "AI", isin: "FR0000120073", micCode: "XMIL", origin: "provider" });
  assert.ok(scoreCandidate(classifyQuery("Air Liquide"), held) > scoreCandidate(classifyQuery("Air Liquide"), remote));
});

// ==========================================================================================
// 11-12. CLASSIFICATION : UN ETF RESTE UN ETF, MÊME QUAND LE COURS TOMBE
// ==========================================================================================
test("un ETF reste classé ETF et n'est jamais rétrogradé en « Autre »", () => {
  const current = { assetType: "etf", status: "inferred" };
  const providerFailure = { assetType: "other", status: "needs_review" };
  assert.deepEqual(mergeClassification(current, providerFailure), current);
  assert.equal(ASSET_TYPE_LABEL.etf, "ETF");
});

test("une panne de fournisseur ne modifie pas la classification d'une action", () => {
  // Une panne se traduit par un candidat sans type ni cours. Elle ne doit rien emporter.
  const outage = candidate({ isin: "FR0000120073", name: "Air Liquide", micCode: "XPAR", currency: "EUR", assetType: "other", confidence: "needs_review" });
  const merged = mergeCandidates(AIR_LIQUIDE, outage);
  assert.equal(merged.assetType, "stock");
  assert.equal(merged.confidence, "verified");
});

test("une correction administrateur (verified) n'est jamais écrasée", () => {
  const admin = { assetType: "stock", status: "verified" };
  assert.deepEqual(mergeClassification(admin, { assetType: "etf", status: "inferred" }), admin);
  assert.deepEqual(mergeClassification(admin, { assetType: "other", status: "needs_review" }), admin);
});

test("normalisation des types : les libellés fournisseurs et français retombent sur le référentiel", () => {
  assert.equal(normalizeAssetType("EQUITY"), "stock");
  assert.equal(normalizeAssetType("MUTUALFUND"), "fund");
  assert.equal(normalizeAssetType("ETF"), "etf");
  assert.equal(normalizeAssetType("action"), "stock");
  assert.equal(normalizeAssetType("truc inconnu"), "other");
  assert.equal(normalizeAssetType(null), "other");
});

// ==========================================================================================
// NORMALISATIONS DE BASE
// ==========================================================================================
test("normalisations : ISIN et MIC ne retiennent que des formes valides", () => {
  assert.equal(normalizeIsin(" fr0000120073 "), "FR0000120073");
  assert.equal(normalizeIsin(""), null);
  assert.equal(normalizeMic("xpar"), "XPAR");
  assert.equal(normalizeMic("XPARIS"), null); // 4 caractères exactement
  assert.equal(normalizeMic(null), null);
});

test("clé d'identité : sans ISIN on retombe sur le symbole fournisseur, jamais sur le seul nom", () => {
  const noIsin = candidate({ name: "Truc", ticker: "TRC", yahooSymbol: "TRC.PA", currency: "EUR" });
  assert.equal(listingIdentityKey(noIsin), "sym:TRC.PA");
});

// ==========================================================================================
// REVUE ADMINISTRATEUR (§13) — signaler ce qui bloque, pas vider la table
// ==========================================================================================
function reviewable(overrides = {}) {
  return {
    assetId: "a1", name: "Actif", isin: null, assetType: "other",
    classificationStatus: "inferred", listings: [], operationCount: 0, ...overrides,
  };
}
const listing = (overrides = {}) => ({
  listingId: "l1", ticker: "AI", exchange: "Euronext Paris", micCode: "XPAR", currency: "EUR",
  eodhdSymbol: "AI.PA", yahooSymbol: "AI.PA", validationStatus: "inferred", ...overrides,
});

test("un actif complet et confirmé ne remonte PAS dans la revue", () => {
  const healthy = reviewable({ isin: "FR0000120073", classificationStatus: "verified", listings: [listing()] });
  assert.deepEqual(reviewReasons(healthy, [healthy]), []);
  assert.equal(buildReviewList([healthy]).length, 0);
});

test("un actif sans cotation est signalé : aucun cours ne pourra s'y rattacher", () => {
  const orphan = reviewable({ isin: "FR0000120073", classificationStatus: "verified", listings: [] });
  assert.ok(reviewReasons(orphan, [orphan]).includes("no_listing"));
});

test("une cotation sans symbole fournisseur est signalée", () => {
  const mute = reviewable({
    isin: "FR0000120073", classificationStatus: "verified",
    listings: [listing({ eodhdSymbol: null, yahooSymbol: null })],
  });
  const reasons = reviewReasons(mute, [mute]);
  assert.ok(reasons.includes("no_provider_symbol"));
  assert.equal(reasons.includes("no_listing"), false, "elle a bien une cotation, c'est le symbole qui manque");
});

test("un conflit est détecté quand deux actifs revendiquent le même ticker sur la même place", () => {
  const first = reviewable({ assetId: "a1", isin: "FR0000120073", listings: [listing()] });
  const second = reviewable({ assetId: "a2", isin: "FR0000120271", listings: [listing({ listingId: "l2" })] });
  assert.ok(reviewReasons(first, [first, second]).includes("conflict"));
  assert.ok(reviewReasons(second, [first, second]).includes("conflict"));
});

test("deux cotations du MÊME actif ne sont pas un conflit", () => {
  const paris = listing();
  const francfort = listing({ listingId: "l2", ticker: "AILA", exchange: "Francfort", micCode: "XFRA", yahooSymbol: "AILA.F", eodhdSymbol: "AILA.F" });
  const single = reviewable({ isin: "FR0000120073", classificationStatus: "verified", listings: [paris, francfort] });
  assert.equal(reviewReasons(single, [single]).includes("conflict"), false);
});

test("une classification « verified » n'est plus jamais signalée comme à confirmer", () => {
  const corrected = reviewable({ isin: "FR0000120073", classificationStatus: "verified", listings: [listing()] });
  assert.equal(reviewReasons(corrected, [corrected]).includes("needs_review"), false);
  const pending = reviewable({ isin: "FR0000120073", classificationStatus: "needs_review", listings: [listing()] });
  assert.ok(reviewReasons(pending, [pending]).includes("needs_review"));
});

test("la revue classe le plus bloquant d'abord, puis les actifs les plus utilisés", () => {
  const conflictA = reviewable({ assetId: "c1", name: "Doublon A", isin: "FR0000120073", listings: [listing()] });
  const conflictB = reviewable({ assetId: "c2", name: "Doublon B", isin: "FR0000120271", listings: [listing({ listingId: "l2" })] });
  const orphan = reviewable({ assetId: "o1", name: "Sans cotation", isin: "FR0007052782", listings: [] });
  const minor = reviewable({ assetId: "m1", name: "Sans ISIN", classificationStatus: "verified", listings: [listing({ listingId: "l9", ticker: "ZZZ" })], operationCount: 40 });

  const ordered = buildReviewList([minor, orphan, conflictA, conflictB]).map((asset) => asset.assetId);
  assert.ok(ordered.indexOf("c1") < ordered.indexOf("o1"), "un conflit passe avant une absence de cotation");
  assert.ok(ordered.indexOf("o1") < ordered.indexOf("m1"), "une absence de cotation passe avant un simple ISIN manquant");
  // Le motif le moins grave ne fait pas remonter un actif très utilisé devant un vrai blocage.
  assert.equal(ordered.at(-1), "m1");
});

test("chaque motif a un libellé ET une conséquence expliquée", () => {
  for (const reason of ["needs_review", "no_listing", "no_provider_symbol", "no_isin", "conflict"]) {
    assert.ok(REVIEW_REASON_LABEL[reason]?.length > 0, `${reason} doit avoir un libellé`);
    assert.ok(REVIEW_REASON_DETAIL[reason]?.length > 20, `${reason} doit expliquer ce qu'il empêche`);
  }
});

test("le badge « Éligible PEA » n'est jamais affirmé faute de source fiable", () => {
  // Le cahier n'autorise le badge que si la donnée est fiable : aucune de nos sources ne la
  // publie, donc peaEligible reste null et l'interface n'affiche rien plutôt qu'une déduction.
  assert.equal(AIR_LIQUIDE.peaEligible, null);
  assert.equal(mergeCandidates(AIR_LIQUIDE, CW8).peaEligible, null);
});
