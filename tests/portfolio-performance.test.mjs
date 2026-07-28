// Performance (lib/portfolio-performance.ts).
//
// Le point d'acceptation central : un VERSEMENT n'est pas une performance. Le TWR doit rester
// inchangé quand on ajoute de l'argent sans que le marché bouge, et le module doit refuser de
// publier une performance de période quand les flux historiques manquent.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assessFlows, computePerformanceModel, computeRealizedGain, computeTwr, computeXirr,
  externalFlows, minimumCash, normalizeBenchmark, rankPositions, computeRiskIndicators, twrSeries,
} from "../lib/portfolio-performance.ts";

const identity = (_operation, amount) => amount;

const operation = (over = {}) => ({
  id: "o", accountId: "a", type: "achat", date: "2025-01-10", assetName: "TotalEnergies", ticker: "TTE",
  isin: "FR0000120271", quantity: 10, unitPrice: 50, grossAmount: 500, fees: 0, netAmount: 500,
  currency: "EUR", source: null, note: null, exchangeRate: null, ...over,
});
const position = (over = {}) => ({
  key: "isin:FR0000120271", name: "TotalEnergies", ticker: "TTE", isin: "FR0000120271",
  assetClass: "action", assetType: "stock", assetId: null, providerSymbol: null, yahooSymbol: null,
  exchange: null, micCode: null, dataProvider: null, quoteMode: null, marketStatus: null,
  dataDelayMinutes: null, quoteFetchedAt: null, quantity: 10, averageCost: 50, investedEur: 500,
  lastPrice: 60, lastPriceAt: null, currentValueEur: 600, gainEur: 100, gainPct: 20, weightPct: 60,
  currency: "EUR", referenceCurrency: "EUR", fxRateToReference: 1, accounts: [], ...over,
});
const model = (over = {}) => ({
  accountType: "PEA", hasOperations: true, startDate: "2025-01-10",
  netInvestedEur: 1000, cashEur: 500, hasUnconvertedCash: false, dividendsNetEur: 0, dividendsGrossEur: 0, feesEur: 0,
  positions: [position()], positionsValueEur: 600, investedInAssetsEur: 500, averageBookPrice: 50,
  pricedPositions: 1, unpricedPositions: 0,
  valuationCoverage: { totalPositions: 1, valuedPositions: 1, unvaluedPositions: 0, valuedCostEur: 500, unvaluedCostEur: 0, coveragePercent: 100 },
  totalValueEur: 1100, unrealizedGainEur: 100, unrealizedGainPct: 20, performanceEur: 100, performancePct: 10,
  allocation: [], currencyAllocation: [], fxImpactEur: null,
  monthly: { investedThisMonth: 0, monthLabel: "", status: "à_investir" }, timeline: [], ...over,
});

// ---- 11. Le TWR exclut les versements et retraits de la performance -------------------------
test("un versement ne crée AUCUNE performance dans le TWR", () => {
  // Valeur 1000 → 2000, mais uniquement parce que 1000 € ont été versés le même jour.
  const valuations = [
    { date: "2025-01-01", valueEur: 1000 },
    { date: "2025-02-01", valueEur: 2000 },
  ];
  const flows = [{ date: "2025-02-01", amountEur: 1000, type: "versement" }];
  const { twrPct } = computeTwr(valuations, flows);
  assert.ok(Math.abs(twrPct) < 1e-9, `le TWR devrait être nul, obtenu ${twrPct}`);
});

test("le TWR mesure la seule variation de marché, versement compris à mi-période", () => {
  const valuations = [
    { date: "2025-01-01", valueEur: 1000 },
    { date: "2025-03-01", valueEur: 2100 }, // +1000 versé, +100 de marché
  ];
  const flows = [{ date: "2025-03-01", amountEur: 1000, type: "versement" }];
  const { twrPct } = computeTwr(valuations, flows);
  assert.ok(Math.abs(twrPct - 10) < 1e-6, `attendu ~10 %, obtenu ${twrPct}`);
});

test("un retrait ne crée AUCUNE contre-performance", () => {
  const valuations = [{ date: "2025-01-01", valueEur: 1000 }, { date: "2025-02-01", valueEur: 500 }];
  const flows = [{ date: "2025-02-01", amountEur: -500, type: "retrait" }];
  assert.ok(Math.abs(computeTwr(valuations, flows).twrPct) < 1e-9);
});

test("sans flux, le TWR est la simple variation de valeur", () => {
  const valuations = [{ date: "2025-01-01", valueEur: 1000 }, { date: "2025-02-01", valueEur: 1200 }];
  assert.ok(Math.abs(computeTwr(valuations, []).twrPct - 20) < 1e-6);
});

test("une sous-période à capital nul est ignorée, jamais forcée", () => {
  const valuations = [
    { date: "2025-01-01", valueEur: 0 }, // avant le premier achat
    { date: "2025-02-01", valueEur: 0 },
    { date: "2025-03-01", valueEur: 1000 },
    { date: "2025-04-01", valueEur: 1100 },
  ];
  const flows = [{ date: "2025-03-01", amountEur: 1000, type: "versement" }];
  const { twrPct, periods } = computeTwr(valuations, flows);
  assert.equal(periods, 1);
  assert.ok(Math.abs(twrPct - 10) < 1e-6);
});

test("la courbe TWR démarre à 0 % et ne saute pas au versement", () => {
  const series = twrSeries(
    [{ date: "2025-01-01", valueEur: 1000 }, { date: "2025-02-01", valueEur: 2000 }, { date: "2025-03-01", valueEur: 2200 }],
    [{ date: "2025-02-01", amountEur: 1000, type: "versement" }],
  );
  assert.equal(series[0].pct, 0);
  assert.ok(Math.abs(series[1].pct) < 1e-9); // le versement ne fait pas monter la courbe
  assert.ok(Math.abs(series[2].pct - 10) < 1e-6);
});

// ---- Fiabilité des flux ----------------------------------------------------------------------
test("aucun versement enregistré ⇒ performance déclarée non fiable", () => {
  const state = assessFlows(model({ netInvestedEur: 0, cashEur: -59520 }), [], -59520);
  assert.equal(state.reliable, false);
  assert.match(state.reason, /Aucun versement/);
});

test("trésorerie négative ⇒ performance déclarée non fiable même s'il existe un versement", () => {
  const state = assessFlows(model(), [{ date: "2025-01-01", amountEur: 100, type: "versement" }], -5000);
  assert.equal(state.reliable, false);
  assert.match(state.reason, /trésorerie/i);
});

test("le cas réel du PEA (3 achats, 0 versement) masque TWR, XIRR et performance annualisée", () => {
  const operations = [
    operation({ id: "a1", date: "2026-07-27", assetName: "Sanofi", ticker: "SAN", isin: null, quantity: 360, unitPrice: 87.83, grossAmount: 31618.8, netAmount: 31618.8 }),
    operation({ id: "a2", date: "2026-07-27", assetName: "WPEA", isin: "IE0002XZSHO1", quantity: 5000, unitPrice: 4.94, grossAmount: 24700, netAmount: 24700 }),
  ];
  const cashDeltaOf = (op) => (op.type === "achat" ? -Math.abs(op.netAmount) : 0);
  const performance = computePerformanceModel({
    model: model({ netInvestedEur: 0, cashEur: -56318.8, totalValueEur: null }),
    operations, today: "2026-07-27", toReference: identity, cashDeltaOf,
    valuations: [{ date: "2026-07-28", valueEur: 56318.8 }],
  });
  assert.equal(performance.isReliable, false);
  assert.equal(performance.twrPct, null);
  assert.equal(performance.xirrPct, null);
  assert.equal(performance.annualizedPct, null);
  // Mais le détail exact reste publié : c'est lui qui n'a jamais été faux.
  assert.equal(performance.unrealizedGainEur, 100);
  assert.equal(performance.realizedGainEur, 0);
});

test("minimumCash détecte la trésorerie qui plonge en cours de route", () => {
  const cashDeltaOf = (op) => (op.type === "versement" ? Math.abs(op.netAmount) : -Math.abs(op.netAmount));
  const minimum = minimumCash(
    [operation({ id: "b", date: "2025-01-10", netAmount: 500 }), operation({ id: "v", type: "versement", date: "2025-02-01", netAmount: 1000 })],
    cashDeltaOf,
  );
  assert.equal(minimum, -500);
});

test("externalFlows ne retient QUE les versements et retraits", () => {
  const flows = externalFlows(
    [
      operation({ id: "v", type: "versement", netAmount: 1000 }),
      operation({ id: "r", type: "retrait", netAmount: 300 }),
      operation({ id: "a", type: "achat", netAmount: 500 }),
      operation({ id: "d", type: "dividende", netAmount: 40 }),
    ],
    identity,
  );
  assert.equal(flows.length, 2);
  assert.equal(flows.find((flow) => flow.type === "versement").amountEur, 1000);
  assert.equal(flows.find((flow) => flow.type === "retrait").amountEur, -300);
});

// ---- XIRR -------------------------------------------------------------------------------------
test("XIRR ≈ 10 % sur un placement d'un an", () => {
  const rate = computeXirr([{ date: "2025-01-01", amountEur: -1000 }, { date: "2026-01-01", amountEur: 1100 }]);
  assert.ok(Math.abs(rate - 10) < 0.1, `attendu ~10 %, obtenu ${rate}`);
});

test("XIRR renvoie null quand les flux ne changent jamais de signe", () => {
  assert.equal(computeXirr([{ date: "2025-01-01", amountEur: -1000 }, { date: "2026-01-01", amountEur: -500 }]), null);
});

// ---- Plus-value réalisée ------------------------------------------------------------------------
test("la plus-value réalisée utilise le coût moyen et ignore le transfert sortant", () => {
  const result = computeRealizedGain(
    [
      operation({ id: "b1", date: "2025-01-01", quantity: 10, grossAmount: 500, netAmount: 500 }),
      operation({ id: "b2", date: "2025-02-01", quantity: 10, unitPrice: 70, grossAmount: 700, netAmount: 700 }),
      operation({ id: "s1", type: "vente", date: "2025-06-01", quantity: 10, unitPrice: 80, grossAmount: 800, netAmount: 800, fees: 0 }),
    ],
    identity,
  );
  // Coût moyen = 1200 / 20 = 60 ; vente de 10 à 80 ⇒ 800 − 600 = 200.
  assert.ok(Math.abs(result.realizedEur - 200) < 1e-6);
  assert.equal(result.sales, 1);
});

test("un transfert sortant ne réalise aucune plus-value", () => {
  const result = computeRealizedGain(
    [operation({ id: "b", quantity: 10, grossAmount: 500, netAmount: 500 }), operation({ id: "t", type: "transfer_out", date: "2025-06-01", quantity: 10 })],
    identity,
  );
  assert.equal(result.realizedEur, 0);
  assert.equal(result.sales, 0);
});

test("les frais d'achat entrent dans le coût, ceux de vente réduisent le produit", () => {
  const result = computeRealizedGain(
    [
      operation({ id: "b", quantity: 10, grossAmount: 500, netAmount: null, fees: 10 }),
      operation({ id: "s", type: "vente", date: "2025-06-01", quantity: 10, grossAmount: 600, netAmount: null, fees: 5 }),
    ],
    identity,
  );
  assert.ok(Math.abs(result.realizedEur - (595 - 510)) < 1e-6);
});

// ---- 10. Classement top 3 / bottom 3 ------------------------------------------------------------
test("les top 3 et bottom 3 sont correctement classés, en % comme en €", () => {
  const positions = [
    position({ key: "a", name: "Air Liquide", gainPct: 42.8, gainEur: 28416, currentValueEur: 90000, investedEur: 61584 }),
    position({ key: "b", name: "Société Générale", gainPct: 38.4, gainEur: 21873, currentValueEur: 70000, investedEur: 48127 }),
    position({ key: "c", name: "TotalEnergies", gainPct: 31.6, gainEur: 18925, currentValueEur: 60000, investedEur: 41075 }),
    position({ key: "d", name: "WEX", gainPct: -40.2, gainEur: -9842, currentValueEur: 14000, investedEur: 23842 }),
    position({ key: "e", name: "Kering", gainPct: -18.7, gainEur: -6215, currentValueEur: 27000, investedEur: 33215 }),
    position({ key: "f", name: "Edenred", gainPct: -12.4, gainEur: -3568, currentValueEur: 25000, investedEur: 28568 }),
  ];
  const byPercent = rankPositions(positions, "percent", 3);
  assert.deepEqual(byPercent.best.map((row) => row.name), ["Air Liquide", "Société Générale", "TotalEnergies"]);
  assert.deepEqual(byPercent.worst.map((row) => row.name), ["WEX", "Kering", "Edenred"]);

  const byContribution = rankPositions(positions, "contribution", 3);
  assert.deepEqual(byContribution.best.map((row) => row.name), ["Air Liquide", "Société Générale", "TotalEnergies"]);
  assert.deepEqual(byContribution.worst.map((row) => row.name), ["WEX", "Kering", "Edenred"]);
});

test("le critère € peut différer du critère % (petite ligne très performante)", () => {
  const positions = [
    position({ key: "small", name: "Petite ligne", gainPct: 300, gainEur: 900, currentValueEur: 1200, investedEur: 300 }),
    position({ key: "big", name: "Grosse ligne", gainPct: 6, gainEur: 2400, currentValueEur: 42400, investedEur: 40000 }),
  ];
  assert.equal(rankPositions(positions, "percent", 1).best[0].name, "Petite ligne");
  assert.equal(rankPositions(positions, "contribution", 1).best[0].name, "Grosse ligne");
});

test("une position sans cours est exclue du classement et rapportée, jamais valorisée à zéro", () => {
  const positions = [
    position({ key: "ok", name: "Cotée" }),
    position({ key: "ko", name: "Sans cours", currentValueEur: null, gainEur: null, gainPct: null }),
  ];
  const ranking = rankPositions(positions, "percent", 3);
  assert.equal(ranking.best.length, 1);
  assert.deepEqual(ranking.excluded, [{ key: "ko", name: "Sans cours", reason: "no_price" }]);
});

test("un coût nul (transfert sans prix de revient) sort du classement en %, mais reste en €", () => {
  const positions = [position({ key: "t", name: "Transférée", investedEur: 0, gainPct: null, gainEur: 400 })];
  assert.equal(rankPositions(positions, "percent", 3).best.length, 0);
  assert.equal(rankPositions(positions, "percent", 3).excluded[0].reason, "no_cost");
  assert.equal(rankPositions(positions, "contribution", 3).best.length, 1);
});

// ---- Risques et benchmark -------------------------------------------------------------------------
test("les indicateurs de risque mesurent la concentration réelle", () => {
  const positions = [
    position({ key: "a", currentValueEur: 5000 }),
    position({ key: "b", currentValueEur: 3000 }),
    position({ key: "c", currentValueEur: 1500 }),
    position({ key: "d", currentValueEur: 500 }),
  ];
  const risks = computeRiskIndicators({
    positions, geographyTopPct: 58, geographyTopLabel: "France", sectorTopPct: 20, sectorTopLabel: "Énergie", coveragePercent: 100,
  });
  assert.equal(risks.find((risk) => risk.key === "top1").valuePct, 50);
  assert.equal(risks.find((risk) => risk.key === "top3").valuePct, 95);
  assert.equal(risks.find((risk) => risk.key === "geo").level, "high"); // 58 % ≥ seuil
  assert.equal(risks.find((risk) => risk.key === "coverage").levelLabel, "Complète");
});

// ---- 12. Une couverture incomplète déclenche un avertissement --------------------------------------
test("une couverture incomplète est signalée comme telle", () => {
  const risks = computeRiskIndicators({
    positions: [position()], geographyTopPct: null, geographyTopLabel: null, sectorTopPct: null, sectorTopLabel: null, coveragePercent: 60,
  });
  const coverage = risks.find((risk) => risk.key === "coverage");
  assert.equal(coverage.level, "high");
  assert.equal(coverage.levelLabel, "Insuffisante");
});

test("le benchmark est normalisé à 0 % au début de la fenêtre", () => {
  const points = [
    { date: "2025-01-31", close: 100 },
    { date: "2025-06-30", close: 110 },
    { date: "2025-12-31", close: 121 },
  ];
  const normalized = normalizeBenchmark(points, "2025-01-01", "2025-12-31");
  assert.equal(normalized[0].pct, 0);
  assert.ok(Math.abs(normalized[1].pct - 10) < 1e-9);
  assert.ok(Math.abs(normalized[2].pct - 21) < 1e-9);
});

test("une fenêtre plus courte rebase sur son propre premier point", () => {
  const points = [{ date: "2025-01-31", close: 100 }, { date: "2025-06-30", close: 110 }, { date: "2025-12-31", close: 121 }];
  const normalized = normalizeBenchmark(points, "2025-06-01", "2025-12-31");
  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].pct, 0);
  assert.ok(Math.abs(normalized[1].pct - 10) < 1e-9);
});

test("une série vide renvoie une comparaison vide, jamais une courbe reconstituée", () => {
  assert.deepEqual(normalizeBenchmark([], null, null), []);
});

// ---- Résultat total ----------------------------------------------------------------------------------
test("le résultat total additionne latent, réalisé et dividendes, et retranche les frais", () => {
  const performance = computePerformanceModel({
    model: model({ dividendsNetEur: 40, feesEur: 15 }),
    operations: [
      operation({ id: "v", type: "versement", date: "2025-01-01", netAmount: 1000, quantity: null, unitPrice: null, grossAmount: 1000 }),
      operation({ id: "b1", date: "2025-01-05", quantity: 10, grossAmount: 500, netAmount: 500 }),
      operation({ id: "b2", date: "2025-02-05", quantity: 10, unitPrice: 70, grossAmount: 700, netAmount: 700 }),
      operation({ id: "s1", type: "vente", date: "2025-06-01", quantity: 10, unitPrice: 80, grossAmount: 800, netAmount: 800 }),
    ],
    today: "2026-07-27",
    toReference: identity,
    cashDeltaOf: (op) => (op.type === "versement" || op.type === "vente" ? Math.abs(op.netAmount) : -Math.abs(op.netAmount)),
    valuations: [{ date: "2025-01-31", valueEur: 500 }, { date: "2026-07-31", valueEur: 600 }],
  });
  assert.ok(Math.abs(performance.realizedGainEur - 200) < 1e-6);
  assert.ok(Math.abs(performance.totalReturnEur - (100 + 200 + 40 - 15)) < 1e-6);
  assert.ok(Math.abs(performance.totalReturnPct - ((325 / 500) * 100)) < 1e-6);
});
