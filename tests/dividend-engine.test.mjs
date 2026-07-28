// Moteur de dividendes (lib/dividend-engine.ts) — modèle de lecture partagé PEA / compte-titres.
//
// Ce fichier couvre les points d'acceptation qui décident si l'écran dit la vérité : quantité
// éligible reconstruite à la date de détachement, séparation stricte reçu / annoncé / estimé,
// cohérence arithmétique du total et de la moyenne, rendements, conversion de devise, absence de
// date de paiement, instrument non reconnu, ETF capitalisant, et fiscalité des deux enveloppes.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTaxView, calendarYearWindow, computeDividendModel, describeSyncReport,
  eligibleQuantityAtExDate, next12mWindow, quantityAtDate, resolveDistributionPolicy,
} from "../lib/dividend-engine.ts";

const TODAY = "2026-07-28";

// ---- Fabriques ------------------------------------------------------------------------------
const operation = (over = {}) => ({
  id: "o1", accountId: "a1", memberId: "m1", type: "achat", date: "2025-01-10",
  assetName: "Sanofi", ticker: "SAN", isin: null, quantity: 360, unitPrice: 87.83,
  grossAmount: 31618.8, fees: 0, netAmount: 31618.8, currency: "EUR",
  exchangeRate: null, source: "test", note: null, ...over,
});

const position = (over = {}) => ({
  key: "tkr:SAN", name: "Sanofi", ticker: "SAN", isin: null, assetClass: "action", assetType: "stock",
  assetId: null, providerSymbol: null, yahooSymbol: null, exchange: null, micCode: null, dataProvider: null,
  quoteMode: null, marketStatus: null, dataDelayMinutes: null, quoteFetchedAt: null,
  quantity: 360, averageCost: 87.83, investedEur: 31618.8, lastPrice: 90, lastPriceAt: null,
  currentValueEur: 32400, gainEur: 781.2, gainPct: 2.47, weightPct: 100,
  currency: "EUR", referenceCurrency: "EUR", fxRateToReference: 1, accounts: [], ...over,
});

const instrument = (over = {}) => ({
  assetId: "asset-sanofi", positionKeys: ["tkr:SAN"], name: "Sanofi", isin: "FR0000120578", ticker: "SAN",
  assetType: "stock", distributionPolicy: "distributing", resolutionStatus: "resolved",
  providerSymbol: "SAN.PA", lastSyncedAt: "2026-07-27T10:00:00.000Z", ...over,
});

const event = (over = {}) => ({
  id: "e1", assetId: "asset-sanofi", isin: "FR0000120578", providerSymbol: "SAN.PA",
  status: "announced", dividendType: "ordinary", declarationDate: null,
  exDate: "2026-09-10", recordDate: null, paymentDate: "2026-09-14", estimatedMonth: null,
  amountPerShare: 3.92, currency: "EUR", sourceProvider: "alpha_vantage", sourceEventId: "2026-09-10",
  sourceUrl: null, confidence: "high", isSpecial: false, isForecast: false,
  lastSyncedAt: "2026-07-28T08:00:00.000Z", ...over,
});

const model = (over = {}) => computeDividendModel({
  operations: [operation()],
  positions: [position()],
  events: [event()],
  instruments: [instrument()],
  accountType: "PEA",
  today: TODAY,
  referenceCurrency: "EUR",
  ...over,
});

// ==========================================================================================
// 1-3. Quantité éligible à la date de détachement
// ==========================================================================================
test("1 — la quantité éligible est celle détenue au détachement, jamais celle d'aujourd'hui", () => {
  const operations = [
    operation({ id: "b1", date: "2024-01-05", quantity: 100 }),
    operation({ id: "b2", date: "2026-07-01", quantity: 260 }),
  ];
  assert.equal(eligibleQuantityAtExDate(operations, ["tkr:SAN"], "2025-05-16"), 100);
  assert.equal(eligibleQuantityAtExDate(operations, ["tkr:SAN"], "2026-07-28"), 360);
  // L'utilitaire générique, lui, inclut la date demandée : les deux conventions coexistent
  // volontairement et ne doivent pas être confondues.
  assert.equal(quantityAtDate(operations, ["tkr:SAN"], "2024-01-05"), 100);
});

test("2 — achat AVANT le détachement : éligible ; achat LE JOUR du détachement : non éligible", () => {
  const before = [operation({ id: "b", date: "2026-09-09", quantity: 50 })];
  const onExDate = [operation({ id: "b", date: "2026-09-10", quantity: 50 })];
  assert.equal(eligibleQuantityAtExDate(before, ["tkr:SAN"], "2026-09-10"), 50);
  assert.equal(eligibleQuantityAtExDate(onExDate, ["tkr:SAN"], "2026-09-10"), 0);
});

test("3 — vente avant le détachement : retirée ; vente le jour du détachement : reste éligible", () => {
  const soldBefore = [
    operation({ id: "b", date: "2024-01-05", quantity: 360 }),
    operation({ id: "s", type: "vente", date: "2026-09-09", quantity: 200 }),
  ];
  const soldOnExDate = [
    operation({ id: "b", date: "2024-01-05", quantity: 360 }),
    operation({ id: "s", type: "vente", date: "2026-09-10", quantity: 200 }),
  ];
  assert.equal(eligibleQuantityAtExDate(soldBefore, ["tkr:SAN"], "2026-09-10"), 160);
  assert.equal(eligibleQuantityAtExDate(soldOnExDate, ["tkr:SAN"], "2026-09-10"), 360);
});

test("3 bis — transferts et corrections modifient la quantité au même titre qu'un achat", () => {
  const operations = [
    operation({ id: "c", type: "correction", date: "2026-01-05", quantity: 500 }),
    operation({ id: "t", type: "transfer_out", date: "2026-02-05", quantity: 100 }),
    operation({ id: "c2", type: "correction", date: "2026-03-05", quantity: -50 }),
  ];
  assert.equal(eligibleQuantityAtExDate(operations, ["tkr:SAN"], "2026-09-10"), 350);
});

test("1 ter — l'appariement se fait sur TOUTES les clés de l'instrument (défaut Sanofi)", () => {
  // L'opération porte `isin: null, ticker: SAN` → clé `tkr:SAN`. L'instrument canonique est
  // identifié par son ISIN. Avec une clé unique calculée de chaque côté, les deux ne se
  // rencontraient jamais et la quantité éligible tombait à zéro.
  const result = model();
  const announced = result.entries.find((entry) => entry.status === "announced");
  assert.equal(announced.eligibleQuantity, 360);
  assert.equal(announced.grossReference, 3.92 * 360);
});

// ==========================================================================================
// 4. Rapprochement avec une opération reçue
// ==========================================================================================
test("4 — un dividende annoncé puis encaissé n'est compté qu'une fois", () => {
  const result = model({
    operations: [
      operation(),
      operation({ id: "d1", type: "dividende", date: "2026-09-15", quantity: null, unitPrice: null, grossAmount: 1411.2, netAmount: 1411.2 }),
    ],
  });
  const announced = result.entries.find((entry) => entry.status === "announced");
  const received = result.entries.find((entry) => entry.status === "received");
  assert.equal(announced.reconciledWithOperationId, "d1", "l'annonce doit être rapprochée de l'encaissement");
  assert.equal(received.reconciledWithOperationId, null);
  // Le mois de septembre ne contient QUE l'encaissement réel : l'annonce rapprochée en est exclue.
  const september = result.monthly.find((point) => point.monthKey === "2026-09");
  assert.equal(Math.round(september.receivedReference), 1411);
  assert.equal(september.announcedReference, 0);
});

test("4 bis — un rapprochement ambigu est SIGNALÉ, jamais tranché en silence", () => {
  const result = model({
    operations: [
      operation(),
      operation({ id: "d1", type: "dividende", date: "2026-09-15", quantity: null, grossAmount: 1411.2, netAmount: 1411.2 }),
      operation({ id: "d2", type: "dividende", date: "2026-09-16", quantity: null, grossAmount: 1411.2, netAmount: 1411.2 }),
    ],
  });
  const announced = result.entries.find((entry) => entry.status === "announced");
  assert.equal(announced.reconciledWithOperationId, null);
  assert.ok(result.anomalies.some((anomaly) => anomaly.kind === "ambiguous_match"));
});

test("4 ter — un montant trop éloigné n'est PAS rapproché", () => {
  const result = model({
    operations: [
      operation(),
      operation({ id: "d1", type: "dividende", date: "2026-09-15", quantity: null, grossAmount: 400, netAmount: 400 }),
    ],
  });
  const announced = result.entries.find((entry) => entry.status === "announced");
  assert.equal(announced.reconciledWithOperationId, null);
});

// ==========================================================================================
// 8. ETF capitalisant
// ==========================================================================================
test("8 — un ETF capitalisant ne produit AUCUN versement en espèces", () => {
  const etf = position({ key: "isin:IE000BI8OT95", name: "Amundi Core MSCI World UCITS ETF - USD ACC", isin: "IE000BI8OT95", ticker: null, assetType: "etf" });
  const result = model({
    operations: [operation({ assetName: "Amundi Core MSCI World UCITS ETF - USD ACC", ticker: null, isin: "IE000BI8OT95" })],
    positions: [etf],
    instruments: [instrument({ assetId: "asset-etf", positionKeys: ["isin:IE000BI8OT95"], name: "Amundi Core MSCI World UCITS ETF - USD ACC", isin: "IE000BI8OT95", assetType: "etf", distributionPolicy: "accumulating" })],
    events: [event({ assetId: "asset-etf" })],
  });
  assert.equal(result.entries.length, 0);
  assert.equal(result.coverage.accumulating, 1);
  assert.equal(result.positions[0].dataStatus, "accumulating");
});

test("8 bis — la politique du catalogue prime sur le nom, et « Accor » reste une action", () => {
  assert.equal(resolveDistributionPolicy({ distributionPolicy: "distributing", name: "ETF Monde ACC", assetType: "etf" }), "distributing");
  assert.equal(resolveDistributionPolicy({ distributionPolicy: "unknown", name: "ISHARES CORE EURO STOXX 50 (ACC)", assetType: "etf" }), "accumulating");
  assert.equal(resolveDistributionPolicy({ distributionPolicy: "unknown", name: "Accor", assetType: "stock" }), "unknown");
  assert.equal(resolveDistributionPolicy({ distributionPolicy: "unknown", name: "iShares Euro Dividend UCITS ETF - EUR DIS", assetType: "etf" }), "unknown");
});

// ==========================================================================================
// 9-10. Total sur 12 mois et cohérence de la moyenne
// ==========================================================================================
test("9 — le total de la fenêtre est la somme de ses trois composantes", () => {
  const result = model({
    operations: [
      operation(),
      operation({ id: "d1", type: "dividende", date: "2026-08-05", quantity: null, grossAmount: 200, netAmount: 200 }),
    ],
    events: [
      event(),
      event({ id: "e2", status: "estimated", isForecast: true, exDate: null, paymentDate: null, estimatedMonth: "2027-05", amountPerShare: 4, confidence: "high" }),
    ],
  });
  assert.equal(result.window.kind, "next12m");
  assert.equal(result.window.months, 12);
  const sum = result.expectedReceivedReference + result.expectedAnnouncedReference + result.expectedEstimatedReference;
  assert.ok(Math.abs(sum - result.expectedReference) < 1e-6);
  assert.ok(result.expectedReceivedReference > 0 && result.expectedAnnouncedReference > 0 && result.expectedEstimatedReference > 0);
});

test("10 — moyenne mensuelle = total ÷ mois de LA MÊME fenêtre, par construction", () => {
  const result = model();
  assert.ok(Math.abs(result.monthlyAverageReference * result.window.months - result.expectedReference) < 1e-6);
  // Et la ventilation mensuelle redonne exactement le même total : aucun mois hors fenêtre.
  const monthlyTotal = result.monthly.reduce((sum, point) => sum + point.totalReference, 0);
  assert.ok(Math.abs(monthlyTotal - result.expectedReference) < 1e-6);
  assert.equal(result.monthly.length, 12);
});

test("10 bis — désactiver les projections retire les estimés du total ET du graphique", () => {
  const events = [
    event(),
    event({ id: "e2", status: "estimated", isForecast: true, exDate: null, paymentDate: null, estimatedMonth: "2027-05", amountPerShare: 4 }),
  ];
  const withForecast = model({ events });
  const without = model({ events, includeForecast: false });
  assert.ok(withForecast.expectedEstimatedReference > 0);
  assert.equal(without.expectedEstimatedReference, 0);
  assert.equal(without.entries.some((entry) => entry.status === "estimated"), false);
  assert.ok(without.expectedReference < withForecast.expectedReference);
});

test("10 ter — une fenêtre « année civile » couvre janvier à décembre", () => {
  const result = model({ window: calendarYearWindow(2026) });
  assert.equal(result.monthly[0].monthKey, "2026-01");
  assert.equal(result.monthly[11].monthKey, "2026-12");
  assert.equal(next12mWindow(TODAY).from, "2026-07-01");
  assert.equal(next12mWindow(TODAY).to, "2027-06-30");
});

// ==========================================================================================
// 11-12. Rendements
// ==========================================================================================
test("11 — rendement prévisionnel = attendus ÷ valeur actuelle", () => {
  const result = model({ positionsValueReference: 32400, investedReference: 31618.8 });
  const expected = (result.expectedReference / 32400) * 100;
  assert.ok(Math.abs(result.forwardYieldPct - expected) < 1e-9);
});

test("12 — rendement sur prix de revient = attendus ÷ capital investi", () => {
  const result = model({ positionsValueReference: 32400, investedReference: 31618.8 });
  const expected = (result.expectedReference / 31618.8) * 100;
  assert.ok(Math.abs(result.yieldOnCostPct - expected) < 1e-9);
  // Les titres ayant pris de la valeur, le rendement sur revient est le plus élevé des deux.
  assert.ok(result.yieldOnCostPct > result.forwardYieldPct);
});

test("12 bis — sans valeur de portefeuille, « Non calculable » avec sa raison", () => {
  const result = model({ positionsValueReference: null });
  assert.equal(result.forwardYieldPct, null);
  assert.match(result.yieldUnavailableReason, /valeur actuelle/i);
});

// ==========================================================================================
// 13. Conversion de devise
// ==========================================================================================
test("13 — sans taux connu, le montant converti reste null, jamais 1:1", () => {
  const usd = position({ key: "isin:US5949181045", name: "Microsoft", isin: "US5949181045", ticker: null, currency: "USD", quantity: 81 });
  const result = model({
    operations: [operation({ assetName: "Microsoft", ticker: null, isin: "US5949181045", currency: "USD", quantity: 81 })],
    positions: [usd],
    instruments: [instrument({ assetId: "asset-msft", positionKeys: ["isin:US5949181045"], name: "Microsoft", isin: "US5949181045", ticker: null })],
    events: [event({ assetId: "asset-msft", currency: "USD", amountPerShare: 0.83 })],
    accountType: "CTO",
    fxRateAt: () => null,
  });
  const entry = result.entries.find((item) => item.status === "announced");
  assert.equal(entry.grossNative, 0.83 * 81);
  assert.equal(entry.grossReference, null);
  assert.equal(entry.conversionUnavailable, true);
});

test("13 bis — avec un taux, le montant natif est conservé ET le taux tracé", () => {
  const usd = position({ key: "isin:US5949181045", name: "Microsoft", isin: "US5949181045", ticker: null, currency: "USD", quantity: 81 });
  const result = model({
    operations: [operation({ assetName: "Microsoft", ticker: null, isin: "US5949181045", currency: "USD", quantity: 81 })],
    positions: [usd],
    instruments: [instrument({ assetId: "asset-msft", positionKeys: ["isin:US5949181045"], name: "Microsoft", isin: "US5949181045", ticker: null })],
    events: [event({ assetId: "asset-msft", currency: "USD", amountPerShare: 0.83 })],
    accountType: "CTO",
    fxRateAt: () => 1 / 1.1377,
  });
  const entry = result.entries.find((item) => item.status === "announced");
  assert.equal(entry.currency, "USD");
  assert.equal(entry.grossNative, 0.83 * 81);
  assert.ok(Math.abs(entry.grossReference - (0.83 * 81) / 1.1377) < 1e-6);
  assert.ok(entry.fxRate > 0);
  assert.equal(entry.fxRateDate, "2026-09-14");
});

// ==========================================================================================
// 14. Événement sans date de paiement
// ==========================================================================================
test("14 — sans date de paiement, la date de détachement n'est JAMAIS réutilisée", () => {
  const result = model({ events: [event({ paymentDate: null })] });
  const entry = result.entries.find((item) => item.status === "announced");
  assert.equal(entry.paymentDate, null, "la date de paiement reste inconnue");
  assert.equal(entry.scheduleBasis, "ex_date", "le mois est DÉDUIT, et l'interface doit le dire");
  assert.equal(entry.scheduleMonth, "2026-09");
  assert.ok(result.anomalies.some((anomaly) => anomaly.kind === "missing_payment_date"));
});

test("14 bis — une projection ne porte qu'un mois, jamais une date exacte", () => {
  const result = model({
    events: [event({ id: "f1", status: "estimated", isForecast: true, exDate: null, paymentDate: null, estimatedMonth: "2027-05", confidence: "medium" })],
  });
  const entry = result.entries.find((item) => item.status === "estimated");
  assert.equal(entry.exDate, null);
  assert.equal(entry.paymentDate, null);
  assert.equal(entry.scheduleMonth, "2027-05");
  assert.equal(entry.scheduleBasis, "estimated");
  assert.equal(entry.confidence, "medium");
  // Faute de détachement connu, la quantité retenue est celle d'aujourd'hui — hypothèse assumée.
  assert.equal(entry.quantityIsCurrent, true);
});

// ==========================================================================================
// 15. Instrument non reconnu
// ==========================================================================================
test("15 — une position sans instrument canonique est listée, jamais silencieusement omise", () => {
  const result = model({ instruments: [], events: [] });
  assert.equal(result.positions.length, 1);
  assert.equal(result.positions[0].dataStatus, "unresolved");
  assert.equal(result.coverage.unresolved, 1);
  assert.deepEqual(result.coverage.unresolvedNames, ["Sanofi"]);
  assert.ok(result.anomalies.some((anomaly) => anomaly.kind === "unresolved_instrument"));
});

test("15 bis — un dividende encaissé sur un instrument inconnu reste compté et signalé", () => {
  const result = model({
    operations: [operation({ id: "d", type: "dividende", date: "2026-08-01", assetName: "Titre inconnu", ticker: "ZZZ", quantity: null, grossAmount: 90, netAmount: 90 })],
    positions: [],
    instruments: [],
    events: [],
  });
  const received = result.entries.find((entry) => entry.status === "received");
  assert.equal(received.grossReference, 90);
  assert.ok(result.anomalies.some((anomaly) => anomaly.kind === "orphan_operation"));
});

// ==========================================================================================
// 16-17. Fiscalité
// ==========================================================================================
test("16 — PEA : aucun prélèvement par dividende, et pas de sélecteur « net »", () => {
  const result = model({ accountType: "PEA", taxProfile: null });
  assert.equal(result.tax.netAvailable, false);
  assert.equal(result.tax.effectiveRate, null);
  assert.match(result.tax.note, /aucun prélèvement n’est appliqué versement par versement/i);
  const entry = result.entries.find((item) => item.status === "announced");
  assert.equal(entry.netReference, entry.grossReference);
  assert.equal(entry.netIsEstimated, false);
});

test("17 — CTO sans profil fiscal : brut seul, avec ce qu'il manque pour obtenir un net", () => {
  const result = model({ accountType: "CTO", taxProfile: null });
  assert.equal(result.tax.netAvailable, false);
  assert.match(result.tax.note, /aucun profil fiscal/i);
  assert.match(result.tax.missing, /résidence fiscale/i);
  const entry = result.entries.find((item) => item.status === "announced");
  assert.equal(entry.netReference, entry.grossReference, "aucun PFU implicite n'est appliqué");
});

test("17 bis — CTO avec profil incomplet (aucun taux) : toujours pas de net", () => {
  const view = buildTaxView("CTO", {
    taxResidencyCountry: "PT", withholdingTaxRate: null, estimatedTaxRate: null,
    allowanceRate: null, showEstimatedNet: true,
  });
  assert.equal(view.netAvailable, false);
  assert.match(view.missing, /retenue à la source|taux d’imposition/i);
});

test("17 ter — CTO avec profil complet : net = brut × (1 − retenue) − assiette × impôt", () => {
  const taxProfile = {
    taxResidencyCountry: "FR", withholdingTaxRate: 0.128, estimatedTaxRate: 0.172,
    allowanceRate: 0, showEstimatedNet: true,
  };
  const result = model({ accountType: "CTO", taxProfile });
  assert.equal(result.tax.netAvailable, true);
  assert.ok(Math.abs(result.tax.effectiveRate - 0.3) < 1e-9);
  const entry = result.entries.find((item) => item.status === "announced");
  assert.ok(Math.abs(entry.netReference - entry.grossReference * 0.7) < 1e-6);
  assert.equal(entry.netIsEstimated, true, "un net calculé sur un profil reste une estimation");
});

test("17 quater — aucune fiscalité française n'est présumée : un résident portugais garde SON taux", () => {
  const result = model({
    accountType: "CTO",
    taxProfile: { taxResidencyCountry: "PT", withholdingTaxRate: 0.15, estimatedTaxRate: 0.13, allowanceRate: 0.2, showEstimatedNet: true },
  });
  // taux effectif = 0,15 + (1 − 0,20) × 0,13 = 0,254 — et surtout pas 30 %.
  assert.ok(Math.abs(result.tax.effectiveRate - 0.254) < 1e-9);
  assert.match(result.tax.note, /PT/);
});

// ==========================================================================================
// Divers : contributeurs, prochains versements, rapport de synchronisation
// ==========================================================================================
test("les contributeurs sont triés et leurs parts totalisent 100 %", () => {
  const second = position({ key: "isin:FR0000120271", name: "TotalEnergies", isin: "FR0000120271", ticker: "TTE", quantity: 1568, currentValueEur: 90000, investedEur: 80000 });
  const result = model({
    operations: [operation(), operation({ id: "b2", assetName: "TotalEnergies", ticker: "TTE", isin: "FR0000120271", quantity: 1568, date: "2024-02-01" })],
    positions: [position(), second],
    instruments: [instrument(), instrument({ assetId: "asset-tte", positionKeys: ["isin:FR0000120271"], name: "TotalEnergies", isin: "FR0000120271", ticker: "TTE" })],
    events: [event(), event({ id: "e-tte", assetId: "asset-tte", amountPerShare: 0.85, exDate: "2026-09-30", paymentDate: "2026-10-02" })],
  });
  assert.equal(result.contributors.length, 2);
  assert.ok(result.contributors[0].amountReference >= result.contributors[1].amountReference);
  const total = result.contributors.reduce((sum, item) => sum + item.pct, 0);
  assert.ok(Math.abs(total - 100) < 1e-6);
});

test("les prochains versements sont à venir et triés par date croissante", () => {
  const result = model({
    events: [
      event({ id: "past", exDate: "2026-03-10", paymentDate: "2026-03-14" }),
      event({ id: "soon", exDate: "2026-09-10", paymentDate: "2026-09-14" }),
      event({ id: "later", exDate: "2026-12-01", paymentDate: "2026-12-05" }),
    ],
    window: calendarYearWindow(2026),
  });
  const dates = result.upcoming.map((entry) => entry.paymentDate);
  assert.deepEqual(dates, [...dates].sort());
  assert.ok(dates.every((date) => date >= TODAY));
});

test("le rapport de synchronisation est une phrase utile, pas un code technique", () => {
  const message = describeSyncReport({
    instrumentsChecked: 18, announcedUpdated: 4, forecastsRebuilt: 7,
    unresolved: 2, accumulating: 3, deferredByQuota: 0, providerUnavailable: 0,
  });
  assert.match(message, /18 positions vérifiées/);
  assert.match(message, /4 dividendes annoncés mis à jour/);
  assert.match(message, /7 projections recalculées/);
  assert.match(message, /2 instruments restent à identifier/);
});
