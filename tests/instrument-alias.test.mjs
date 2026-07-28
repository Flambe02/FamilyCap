// Appariement position ↔ référence de cours (lib/instrument-alias.ts).
//
// Le cas central rejoue le bug réel observé en base : l'opération Sanofi du PEA porte
// `isin: null, ticker: "SAN"` alors que la ligne `holdings` correspondante est identifiée par un
// ISIN. Avec une clé unique par côté, les deux ne se rencontraient jamais.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAliasIndex, buildPriceIndex, collectInstrumentIdentities, identityAliases,
  normalizeInstrumentName, resolveReference,
} from "../lib/instrument-alias.ts";

const op = (over = {}) => ({ isin: null, ticker: null, assetName: null, ...over });

test("Sanofi : une opération sans ISIN retrouve sa ligne de référence portant un ISIN", () => {
  const holdings = [{ id: "h1", isin: "FR0000120578", symbol: null, name: "SANOFI" }];
  const operations = [op({ ticker: "SAN", assetName: "Sanofi" })];
  const index = buildPriceIndex(holdings, (h) => ({ isin: h.isin, symbol: h.symbol, name: h.name }), operations);
  assert.equal(index.byKey.get("tkr:SAN")?.id, "h1");
  assert.equal(index.matchedOn.get("tkr:SAN"), "name");
  assert.deepEqual(index.unmatched, []);
});

test("Sanofi : même appariement quand la ligne de référence porte l'ANCIEN ISIN erroné", () => {
  // FR0001200578 est l'ISIN aux chiffres transposés réellement présent en base. Il n'est pas un
  // alias valable pour l'opération, mais le nom, lui, reste commun aux deux côtés.
  const holdings = [{ id: "h1", isin: "FR0001200578", symbol: null, name: "SANOFI" }];
  const index = buildPriceIndex(holdings, (h) => ({ isin: h.isin, symbol: h.symbol, name: h.name }), [op({ ticker: "SAN", assetName: "Sanofi" })]);
  assert.equal(index.byKey.get("tkr:SAN")?.id, "h1");
});

test("l'ISIN prime sur le ticker, et le ticker sur le nom", () => {
  const holdings = [
    { id: "byIsin", isin: "FR0000120271", symbol: null, name: "Autre chose" },
    { id: "byName", isin: null, symbol: null, name: "TOTALENERGIES (TTE)" },
  ];
  const index = buildPriceIndex(
    holdings,
    (h) => ({ isin: h.isin, symbol: h.symbol, name: h.name }),
    [op({ isin: "FR0000120271", assetName: "TOTALENERGIES (TTE)" })],
  );
  assert.equal(index.byKey.get("isin:FR0000120271")?.id, "byIsin");
  assert.equal(index.matchedOn.get("isin:FR0000120271"), "isin");
});

test("un instrument sans aucune référence est rapporté, jamais silencieusement ignoré", () => {
  const index = buildPriceIndex([], (h) => h, [op({ ticker: "XYZ", assetName: "Inconnu" })]);
  assert.equal(index.byKey.size, 0);
  assert.equal(index.unmatched.length, 1);
  assert.equal(index.unmatched[0].ticker, "XYZ");
});

test("un ISIN mal formé n'est pas retenu comme alias fort", () => {
  const aliases = identityAliases({ isin: "PAS-UN-ISIN", ticker: "SAN", name: "Sanofi" });
  assert.deepEqual(aliases.map((a) => a.kind), ["ticker", "name"]);
});

test("normalisation de nom : suffixe de ticker, casse et ponctuation", () => {
  assert.equal(normalizeInstrumentName("SODEXO (SW)"), "sodexo");
  assert.equal(normalizeInstrumentName("  AIR LIQUIDE PF28   (-)  "), "air liquide pf28");
  assert.equal(normalizeInstrumentName("Sanofi"), "sanofi");
  // Deux lignes réelles distinctes ne doivent PAS fusionner.
  assert.notEqual(normalizeInstrumentName("AIR LIQUIDE (AI)"), normalizeInstrumentName("AIR LIQUIDE PF28 (-)"));
});

test("un alias faible n'écrase jamais un alias fort déjà pris", () => {
  const references = [
    { id: "strong", isin: "FR0000120073", symbol: "AI", name: "Air Liquide" },
    { id: "weak", isin: null, symbol: null, name: "Air Liquide" },
  ];
  const index = buildAliasIndex(references, (r) => ({ isin: r.isin, symbol: r.symbol, name: r.name }));
  assert.equal(index.get("name:air liquide").reference.id, "strong");
});

test("les identités consolident les champs de PLUSIEURS opérations du même instrument", () => {
  // Une correction porte l'ISIN, l'achat non : l'identité consolidée doit connaître les deux.
  const identities = collectInstrumentIdentities([
    op({ ticker: "SAN", assetName: "Sanofi" }),
    op({ ticker: "SAN", assetName: "Sanofi", isin: null }),
  ]);
  assert.equal(identities.length, 1);
  assert.equal(identities[0].key, "tkr:SAN");
  assert.equal(identities[0].name, "Sanofi");
});

test("resolveReference suit l'ordre ISIN → ticker → nom", () => {
  const index = buildAliasIndex(
    [{ id: "t", isin: null, symbol: "TTE", name: null }],
    (r) => ({ isin: r.isin, symbol: r.symbol, name: r.name }),
  );
  assert.equal(resolveReference(index, { isin: null, ticker: "TTE", name: "TotalEnergies" })?.reference.id, "t");
  assert.equal(resolveReference(index, { isin: null, ticker: "ORA", name: "Orange" }), null);
});
