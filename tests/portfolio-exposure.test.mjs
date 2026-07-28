// Exposition géographique / sectorielle (lib/portfolio-exposure.ts).
//
// Les trois règles à ne jamais casser : un ETF n'hérite pas de son pays de cotation, l'inconnu
// reste « Non renseigné » sans redistribution, et le total fait 100 % — inconnu compris.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeExposureModel, domicileFallback, exposureTotalPct, UNKNOWN_CODE, COMMODITY_CODE,
} from "../lib/portfolio-exposure.ts";

const position = (over = {}) => ({
  key: "isin:FR0000120271", name: "TOTALENERGIES", ticker: "TTE", isin: "FR0000120271",
  assetClass: "action", assetType: "stock", assetId: null, providerSymbol: null, yahooSymbol: null,
  exchange: null, micCode: null, dataProvider: null, quoteMode: null, marketStatus: null,
  dataDelayMinutes: null, quoteFetchedAt: null, quantity: 10, averageCost: 50, investedEur: 500,
  lastPrice: 60, lastPriceAt: null, currentValueEur: 600, gainEur: 100, gainPct: 20, weightPct: 100,
  currency: "EUR", referenceCurrency: "EUR", fxRateToReference: 1, accounts: [], ...over,
});
const exposure = (over = {}) => ({
  isin: null, instrumentKey: null, dimension: "geography", code: "FR", label: "France",
  weightPercent: 100, source: "test", sourceAsOf: null, confidence: "high", isEstimated: false, ...over,
});

test("le total fait 100 %, « Non renseigné » compris", () => {
  const model = computeExposureModel({
    positions: [
      position({ key: "a", isin: "FR0000120271", currentValueEur: 600 }),
      position({ key: "b", isin: null, name: "Instrument opaque", assetType: "other", currentValueEur: 400 }),
    ],
    exposures: [exposure({ isin: "FR0000120271" })],
    dimension: "geography",
  });
  assert.ok(Math.abs(exposureTotalPct(model) - 100) < 0.01);
  assert.equal(model.buckets.find((b) => b.code === UNKNOWN_CODE).pct, 40);
  assert.equal(model.buckets.find((b) => b.code === "FR").pct, 60);
});

test("un ETF World utilise ses expositions sous-jacentes, JAMAIS son pays de cotation", () => {
  const model = computeExposureModel({
    positions: [position({ key: "w", isin: "IE000BI8OT95", name: "Amundi Core MSCI World", assetType: "etf", currentValueEur: 1000 })],
    exposures: [
      exposure({ isin: "IE000BI8OT95", code: "NA", label: "Amérique du Nord", weightPercent: 74, isEstimated: true }),
      exposure({ isin: "IE000BI8OT95", code: "EUDEV", label: "Europe développée", weightPercent: 15, isEstimated: true }),
      exposure({ isin: "IE000BI8OT95", code: "JP", label: "Japon", weightPercent: 6, isEstimated: true }),
      exposure({ isin: "IE000BI8OT95", code: "APAC", label: "Asie-Pacifique développée", weightPercent: 5, isEstimated: true }),
    ],
    dimension: "geography",
  });
  // L'ISIN commence par IE (Irlande, pays de domiciliation du fonds) : il ne doit apparaître nulle part.
  assert.equal(model.buckets.some((b) => b.code === "IE"), false);
  assert.equal(model.buckets.find((b) => b.code === "NA").pct, 74);
  assert.ok(Math.abs(exposureTotalPct(model) - 100) < 0.01);
});

test("un ETF SANS composition d'indice ne reçoit AUCUN pays de repli", () => {
  const model = computeExposureModel({
    positions: [position({ key: "e", isin: "FR0011550185", name: "BNP Easy S&P 500", assetType: "etf", currentValueEur: 1000 })],
    exposures: [],
    dimension: "geography",
  });
  // Le préfixe FR de l'ISIN ne doit surtout pas devenir « France ».
  assert.equal(model.buckets.length, 1);
  assert.equal(model.buckets[0].code, UNKNOWN_CODE);
  assert.equal(model.gaps.find((g) => g.key === "e").reason, "etf_without_lookthrough");
});

test("une action en direct sans exposition retombe sur son pays de domiciliation, marqué approximation", () => {
  const model = computeExposureModel({
    positions: [position({ key: "s", isin: "US5949181045", name: "Microsoft", assetType: "stock", currentValueEur: 500 })],
    exposures: [],
    dimension: "geography",
  });
  const bucket = model.buckets.find((b) => b.code === "US");
  assert.ok(bucket);
  assert.equal(bucket.pct, 100);
  assert.equal(bucket.isEstimated, true);
  assert.equal(model.estimatedPct, 100);
});

test("le repli par domiciliation ne s'applique pas au secteur, ni aux ETF, ni à l'or", () => {
  assert.equal(domicileFallback(position({ assetType: "stock" }), "sector"), null);
  assert.equal(domicileFallback(position({ assetType: "etf" }), "geography"), null);
  assert.equal(domicileFallback(position({ assetType: "gold" }), "geography"), null);
});

test("un ETC or est classé « matières premières », pas rattaché à la France", () => {
  const model = computeExposureModel({
    positions: [position({ key: "g", isin: "FR0013416716", name: "AMUNDI PHYS GOLD", assetType: "gold", currentValueEur: 800 })],
    exposures: [],
    dimension: "geography",
  });
  assert.equal(model.buckets[0].code, COMMODITY_CODE);
  assert.equal(model.buckets.some((b) => b.code === "FR"), false);
});

test("une composition partielle laisse le reste en « Non renseigné », sans redistribution", () => {
  const model = computeExposureModel({
    positions: [position({ key: "p", isin: "IE00B8GKDB10", assetType: "etf", currentValueEur: 1000 })],
    exposures: [
      exposure({ isin: "IE00B8GKDB10", code: "NA", label: "Amérique du Nord", weightPercent: 42 }),
      exposure({ isin: "IE00B8GKDB10", code: "EUDEV", label: "Europe développée", weightPercent: 24 }),
    ],
    dimension: "geography",
  });
  assert.equal(model.buckets.find((b) => b.code === "NA").pct, 42);
  assert.equal(model.buckets.find((b) => b.code === UNKNOWN_CODE).pct, 34); // 100 − 66, PAS réparti
  assert.ok(Math.abs(exposureTotalPct(model) - 100) < 0.01);
  assert.equal(model.gaps.find((g) => g.key === "p").reason, "partial_exposure");
});

test("une position sans cours est signalée et n'entre pas au dénominateur", () => {
  const model = computeExposureModel({
    positions: [
      position({ key: "ok", isin: "FR0000120271", currentValueEur: 600 }),
      position({ key: "nocours", isin: "FR0000131104", currentValueEur: null, gainEur: null, gainPct: null }),
    ],
    exposures: [exposure({ isin: "FR0000120271" })],
    dimension: "geography",
  });
  assert.equal(model.totalValueEur, 600);
  assert.equal(model.buckets.find((b) => b.code === "FR").pct, 100);
  assert.equal(model.gaps.find((g) => g.key === "nocours").reason, "no_price");
  assert.equal(model.isComplete, false);
});

test("la couverture compte les instruments documentés, pas les zones", () => {
  const model = computeExposureModel({
    positions: [
      position({ key: "a", isin: "FR0000120271", currentValueEur: 300 }),
      position({ key: "b", isin: "XX0000000000", name: "Opaque", assetType: "other", currentValueEur: 300 }),
    ],
    exposures: [exposure({ isin: "FR0000120271" })],
    dimension: "geography",
  });
  assert.equal(model.coverage.totalInstruments, 2);
  assert.equal(model.coverage.documentedInstruments, 1);
  assert.equal(model.coverage.coveragePercent, 50);
});

test("« Non renseigné » est toujours classé en dernier", () => {
  const model = computeExposureModel({
    positions: [
      position({ key: "a", isin: "FR0000120271", currentValueEur: 100 }),
      position({ key: "b", isin: null, assetType: "other", currentValueEur: 900 }),
    ],
    exposures: [exposure({ isin: "FR0000120271" })],
    dimension: "geography",
  });
  assert.equal(model.buckets[model.buckets.length - 1].code, UNKNOWN_CODE);
});
