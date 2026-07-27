// Garde-fous de la sélection d'actif : ce que le CODE doit continuer de garantir.
//
// Ces tests lisent les sources et vérifient des propriétés structurelles — c'est le genre déjà
// utilisé par challenges-guards.test.mjs. Ils protègent des régressions qu'un test unitaire ne
// verrait pas : réintroduire un champ ISIN libre dans la modale, appeler Yahoo depuis le
// navigateur, ou écrire une quantité directement dans `holdings`.
//
//   node --test tests/asset-selection-guards.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { requiresAssetSelection, buildOperationRecord } from "../lib/account-operation.ts";
import { venueForExchangeLabel, venueForYahooSymbol, yahooSuffix } from "../lib/market-venues.ts";

const read = (path) => readFileSync(path, "utf8");

const MODAL = read("app/investment-account.tsx");
const SEARCH_FIELD = read("app/asset-search-field.tsx");
const SEARCH_ROUTE = read("app/api/instruments/search/route.ts");
const ADMIN_WRITE = read("app/api/pea/operations/route.ts");
const MEMBER_WRITE = read("app/api/investment-operations/route.ts");
const CATALOG_SERVER = read("lib/asset-catalog-server.ts");
const MIGRATION = read("supabase/migrations/20260811_asset_catalog.sql");

// ==========================================================================================
// 6-7. LA SÉLECTION VERROUILLE L'IDENTITÉ, ET RIEN NE S'ENREGISTRE SANS ELLE
// ==========================================================================================
test("la modale n'expose plus de champs libres Nom / Ticker / ISIN / Devise", () => {
  // C'est la cause racine : quatre saisies indépendantes qu'on pouvait rendre contradictoires.
  for (const forbidden of [/setAssetName\(/, /setTicker\(/, /setIsin\(/]) {
    assert.equal(forbidden.test(MODAL), false, `le champ libre ${forbidden} ne doit pas revenir dans la modale`);
  }
  assert.match(MODAL, /<AssetSearchField/, "la modale doit passer par le sélecteur d'actif");
});

test("la devise n'est plus saisissable : elle est dérivée de la cotation choisie", () => {
  assert.equal(/setCurrency\(event\.target\.value/.test(MODAL), false);
  assert.match(MODAL, /const currency = needsAsset \? \(selection\?\.currency/);
});

test("le bouton d'enregistrement est désactivé tant qu'aucun actif n'est sélectionné", () => {
  assert.match(MODAL, /disabled=\{saving \|\| !assetReady/);
  assert.match(MODAL, /const assetReady = !needsAsset \|\| selection !== null/);
});

test("les types portant un actif exigent une sélection ; les mouvements d'espèces non", () => {
  for (const type of ["achat", "vente", "dividende", "correction", "transfer_in", "transfer_out"]) {
    assert.equal(requiresAssetSelection(type), true, `${type} porte un actif`);
  }
  for (const type of ["versement", "retrait", "frais"]) {
    assert.equal(requiresAssetSelection(type), false, `${type} ne doit PAS déclencher de recherche d'actif`);
  }
});

test("le versement et le retrait n'affichent aucun moteur de recherche d'actif", () => {
  // needsAsset pilote l'affichage du sélecteur ; il exclut versement / retrait / frais.
  assert.match(MODAL, /const needsAsset = ASSET_TYPES_SET\.has\(type\)/);
  assert.equal(/ASSET_TYPES_SET = new Set[^)]*versement/.test(MODAL), false);
});

test("vente et dividende ne proposent que des positions réellement détenues", () => {
  assert.match(MODAL, /HELD_ONLY_TYPES = new Set<AccountOperationType>\(\["vente", "dividende", "transfer_out"\]\)/);
  assert.match(MODAL, /restrictTo=\{heldOnly \? heldCandidates : null\}/);
  // La quantité disponible borne la saisie côté client…
  assert.match(MODAL, /const overSells = heldOnly && availableQuantity !== null && qtyNumber > availableQuantity/);
  // …et la garde serveur historique reste en place (elle, seule, fait foi).
  assert.match(ADMIN_WRITE, /Vente impossible/);
});

// ==========================================================================================
// 14 & 16. MESSAGES ET SÉCURITÉ
// ==========================================================================================
test("les routes d'écriture refusent une opération d'actif sans sélection, avec le message prévu", () => {
  assert.match(ADMIN_WRITE, /Sélectionnez un actif dans la liste avant d'enregistrer\./);
  assert.match(MEMBER_WRITE, /Sélectionnez un actif dans la liste avant d'enregistrer\./);
});

test("aucune erreur brute fournisseur / Supabase / SQL ne remonte à la modale", () => {
  assert.match(SEARCH_ROUTE, /La recherche est momentanément indisponible\. Réessayez dans quelques instants\./);
  // `error.message` peut être INSPECTÉ pour classer l'erreur, mais jamais renvoyé au client :
  // toute valeur d'`error:` dans une réponse doit être une chaîne littérale.
  const returned = [...SEARCH_ROUTE.matchAll(/error:\s*([^,\n}]+)/g)].map((match) => match[1].trim());
  for (const value of returned) {
    assert.match(value, /^"/, `« ${value} » doit être un message littéral, pas une erreur technique relayée`);
  }
});

test("le fournisseur n'est appelé QUE côté serveur : aucun composant client ne joint Yahoo", () => {
  // Le composant client ne connaît aucun point d'entrée fournisseur…
  assert.equal(/finance\.yahoo\.com|eodhd\.com|stooq\.com/i.test(SEARCH_FIELD), false);
  // …et tous ses appels réseau sont des URL RELATIVES de cette application.
  const urls = [...SEARCH_FIELD.matchAll(/authenticatedFetch\(`([^`]+)`/g)].map((match) => match[1]);
  assert.ok(urls.length > 0, "le composant doit bien effectuer un appel");
  for (const url of urls) assert.match(url, /^\//, `« ${url} » doit être une URL relative`);
  assert.match(SEARCH_FIELD, /\/api\/instruments\/search/, "il passe par la route serveur");
  // Le module serveur, lui, est le seul à importer le client de marché.
  assert.match(CATALOG_SERVER, /from "\.\/market-quotes\.ts"/);
  // market-quotes n'est jamais importé en VALEUR par un composant client (seulement en type).
  assert.equal(/^import \{[^}]*\} from "\.\.\/lib\/market-quotes"/m.test(SEARCH_FIELD), false);
});

test("la recherche est authentifiée et ne révèle aucune donnée financière d'un autre membre", () => {
  assert.match(SEARCH_ROUTE, /requireFamilyMember/);
  // Aucun champ patrimonial n'est sélectionné par le catalogue.
  for (const financial of ["quantity", "average_cost", "net_amount", "gross_amount", "member_name"]) {
    assert.equal(CATALOG_SERVER.includes(`,${financial}`), false, `le catalogue ne doit pas lire ${financial}`);
  }
});

test("le client ne peut pas s'auto-déclarer « verified »", () => {
  // Seule une correction administrateur (/api/market-data/assets/[id]) confère ce statut.
  assert.match(CATALOG_SERVER, /raw\.confidence === "verified" \? "inferred"/);
});

test("member_id reste dérivé du compte dans les deux routes d'écriture", () => {
  assert.match(ADMIN_WRITE, /memberId: account\.memberId/);
  assert.match(MEMBER_WRITE, /memberId: account!\.memberId/);
});

test("aucune route d'écriture n'honore ?asMember=", () => {
  assert.equal(ADMIN_WRITE.includes("asMember"), false);
  assert.equal(MEMBER_WRITE.includes("asMember"), false);
});

// ==========================================================================================
// 21 & 25-26. IDENTITÉ STABLE, PAS D'ÉCRITURE DANS holdings, POSITIONS DÉRIVÉES
// ==========================================================================================
test("une sélection enregistre asset_id et listing_id sur l'opération", () => {
  const built = buildOperationRecord(
    { type: "achat", date: "2026-07-27", assetName: "Air Liquide", ticker: "AI", isin: "FR0000120073",
      quantity: 10, unitPrice: 174.8, fees: 1.9, currency: "EUR",
      assetId: "11111111-1111-1111-1111-111111111111", listingId: "22222222-2222-2222-2222-222222222222" },
    { memberId: "33333333-3333-3333-3333-333333333333" },
  );
  assert.equal(built.ok, true);
  assert.equal(built.record.asset_id, "11111111-1111-1111-1111-111111111111");
  assert.equal(built.record.listing_id, "22222222-2222-2222-2222-222222222222");
  // Le total reste DÉRIVÉ (10 × 174,80 + 1,90), jamais une donnée indépendante fournie au serveur.
  assert.equal(built.record.gross_amount, 1748);
  assert.equal(built.record.net_amount, 1749.9);
});

test("une opération SANS identité stable reste enregistrable (import, historique)", () => {
  const built = buildOperationRecord(
    { type: "achat", date: "2026-07-27", assetName: "Vieux titre", quantity: 1, unitPrice: 10 },
    { memberId: "33333333-3333-3333-3333-333333333333" },
  );
  assert.equal(built.ok, true);
  // Colonnes ABSENTES du record — donc jamais écrasées par un patch, et compatibles avec une
  // base où la migration 20260811 n'est pas encore jouée.
  assert.equal("asset_id" in built.record, false);
  assert.equal("listing_id" in built.record, false);
});

test("aucune écriture directe dans holdings : le catalogue n'y touche pas", () => {
  assert.equal(/"holdings/.test(CATALOG_SERVER), false, "le service catalogue n'écrit jamais dans holdings");
  assert.equal(/holdings/.test(ADMIN_WRITE), false, "la route d'opération n'écrit jamais dans holdings");
});

test("les positions restent dérivées de account_operations", () => {
  assert.match(MODAL, /computeAccountModel/);
  // La modale ne lit les positions que pour PROPOSER un actif, jamais pour les écrire.
  assert.match(MODAL, /positions\.filter\(\(position\) => position\.quantity > 1e-9\)/);
});

// ==========================================================================================
// 22. LE COURS EST SYNCHRONISÉ AVEC LA COTATION CHOISIE
// ==========================================================================================
test("le rafraîchissement des cours lit la cotation sélectionnée avant toute déduction", () => {
  const refresh = read("app/api/market-data/refresh/route.ts");
  assert.match(refresh, /loadAccountListings/, "le pipeline doit charger les cotations sélectionnées");
  // Le symbole de la cotation prime sur celui déduit du nom…
  assert.match(refresh, /providerSymbol: listing\?\.eodhdSymbol \?\? item\.provider_symbol/);
  assert.match(refresh, /yahooSymbol: listing\?\.yahooSymbol \?\? item\.yahoo_symbol/);
  // …mais JAMAIS sur une correction administrateur déjà enregistrée.
  assert.match(refresh, /item\.classification_status === "verified" \? null : listingByKey\.get\(key\)/);
});

test("la référence de prix créée pour une position reprend la cotation, et garde quantity 0", () => {
  const refresh = read("app/api/market-data/refresh/route.ts");
  assert.match(refresh, /quantity: 0/, "holdings reste un référentiel de prix, jamais une position");
  assert.match(refresh, /record\.listing_id = listing\.listingId/);
});

test("une cotation ne se rattache qu'aux opérations qui la portent explicitement", () => {
  // Aucune reprise implicite de l'historique : seules les opérations avec listing_id remontent.
  assert.match(CATALOG_SERVER, /listing_id=not\.is\.null/);
});

// ==========================================================================================
// 24. COMPATIBILITÉ PEA ET CTO — un seul composant, deux configurations
// ==========================================================================================
test("PEA et CTO partagent la même modale et le même sélecteur", () => {
  const pea = read("app/pea-investments.tsx");
  const cto = read("app/cto-investments.tsx");
  for (const [name, source] of [["PEA", pea], ["CTO", cto]]) {
    assert.match(source, /InvestmentAccountShell/, `${name} doit rester sur le shell partagé`);
    assert.equal(/AssetSearchField/.test(source), false, `${name} ne doit pas réimplémenter le sélecteur`);
  }
  // Une seule définition de la modale dans tout le code.
  assert.equal(MODAL.match(/function InvestmentOperationModal/g).length, 1);
});

// ==========================================================================================
// MIGRATION : ADDITIVE, IDEMPOTENTE, NON DESTRUCTIVE
// ==========================================================================================
test("la migration est additive et idempotente", () => {
  assert.match(MIGRATION, /create table if not exists public\.assets/);
  assert.match(MIGRATION, /create table if not exists public\.asset_listings/);
  assert.match(MIGRATION, /add column if not exists asset_id/);
  assert.match(MIGRATION, /add column if not exists listing_id/);
  // Aucune destruction : ni drop de table/colonne, ni delete, ni truncate.
  for (const destructive of [/drop table/i, /drop column/i, /\bdelete from\b/i, /truncate/i]) {
    assert.equal(destructive.test(MIGRATION), false, `la migration ne doit contenir aucun ${destructive}`);
  }
});

test("asset_id et listing_id restent NULLABLES : l'historique n'est pas cassé", () => {
  assert.equal(/add column if not exists asset_id uuid[^;]*not null/i.test(MIGRATION), false);
  assert.equal(/add column if not exists listing_id uuid[^;]*not null/i.test(MIGRATION), false);
});

test("le catalogue est en lecture seule pour les membres, en écriture pour le serveur", () => {
  assert.match(MIGRATION, /revoke insert, update, delete on public\.assets from anon, authenticated/);
  assert.match(MIGRATION, /revoke insert, update, delete on public\.asset_listings from anon, authenticated/);
  assert.match(MIGRATION, /for select to authenticated using \(true\)/);
});

test("l'unicité qui empêche les doublons est garantie EN BASE, pas seulement en code", () => {
  assert.match(MIGRATION, /create unique index if not exists assets_isin_key/);
  assert.match(MIGRATION, /create unique index if not exists asset_listings_identity_key/);
});

test("la reprise depuis holdings ne récupère QUE les cotations confirmées à la main", () => {
  assert.match(MIGRATION, /where h\.classification_status = 'verified'/);
});

// ==========================================================================================
// PLACES DE COTATION — table explicite, aucune devise supposée
// ==========================================================================================
test("une place connue fournit devise et MIC ; une place inconnue ne fournit RIEN", () => {
  assert.deepEqual(venueForYahooSymbol("AI.PA"), { exchange: "Euronext Paris", mic: "XPAR", currency: "EUR", country: "France" });
  assert.equal(venueForYahooSymbol("XYZ.ZZ"), null, "aucune devise ne doit être supposée hors table");
  assert.equal(venueForYahooSymbol("AAPL").currency, "USD");
  assert.equal(venueForYahooSymbol("VOD.L").currency, "GBP");
});

test("suffixe : un symbole sans point désigne les États-Unis", () => {
  assert.equal(yahooSuffix("AI.PA"), "PA");
  assert.equal(yahooSuffix("AAPL"), "");
});

test("le libellé de place du fournisseur est reconnu par correspondance explicite", () => {
  assert.equal(venueForExchangeLabel("Paris").mic, "XPAR");
  assert.equal(venueForExchangeLabel("inconnu"), null);
});
