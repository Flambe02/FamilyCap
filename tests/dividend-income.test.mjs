// Revenus / dividendes (lib/dividend-income.ts).
//
// Points d'acceptation couverts ici : Sanofi remonte en prévisionnel, un ETF « ACC » n'en produit
// jamais, « reçu » reste à zéro sans opération réelle, une estimation ne crée pas d'opération, le
// calendrier regroupe bien par mois, brut et net ne sont jamais confondus, et le PEA n'applique
// aucun PFU par dividende.

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDividendIncome, isAccumulating, quantityAtDate, DEFAULT_FLAT_TAX_RATE } from "../lib/dividend-income.ts";

const TODAY = "2026-07-27";

const operation = (over = {}) => ({
  id: "o1", accountId: "a1", type: "achat", date: "2025-01-10", assetName: "Sanofi", ticker: "SAN",
  isin: null, quantity: 360, unitPrice: 87.83, grossAmount: 31618.8, fees: 0, netAmount: 31618.8,
  currency: "EUR", source: "test", note: null, exchangeRate: null, ...over,
});
const position = (over = {}) => ({
  key: "tkr:SAN", name: "Sanofi", ticker: "SAN", isin: null, assetClass: "action", assetType: "stock",
  assetId: null, providerSymbol: null, yahooSymbol: null, exchange: null, micCode: null, dataProvider: null,
  quoteMode: null, marketStatus: null, dataDelayMinutes: null, quoteFetchedAt: null, quantity: 360,
  averageCost: 87.83, investedEur: 31618.8, lastPrice: 90, lastPriceAt: null, currentValueEur: 32400,
  gainEur: 781.2, gainPct: 2.47, weightPct: 100, currency: "EUR", referenceCurrency: "EUR",
  fxRateToReference: 1, accounts: [], ...over,
});
const announced = (over = {}) => ({
  id: "d1", exDate: "2025-05-16", paymentDate: "2025-05-20", amountPerShare: 3.92, currency: "EUR",
  status: "paid", provider: "yahoo", asset: { name: "Sanofi", symbol: "SAN", isin: null }, ...over,
});

// ---- 1. Sanofi remonte dans les dividendes prévisionnels du PEA -----------------------------
test("Sanofi remonte en dividende prévisionnel du PEA une fois son identité résolue", () => {
  const model = computeDividendIncome({
    operations: [operation()],
    positions: [position()],
    announced: [announced()],
    accountType: "PEA",
    today: TODAY,
  });
  const projected = model.entries.find((entry) => entry.status === "estimated");
  assert.ok(projected, "une projection doit exister pour la prochaine échéance annuelle");
  assert.equal(projected.name, "Sanofi");
  // Le dernier détachement connu est le 16/05/2025. Le 16/05/2026 est DÉJÀ passé au 27/07/2026 :
  // la prochaine occurrence attendue est celle de 2027, et non une date rétroactive.
  assert.equal(projected.exDate, "2027-05-16");
  assert.equal(projected.eligibleQuantity, 360);
  assert.equal(projected.grossReference, 3.92 * 360);
});

test("un instrument avec plusieurs années d'historique ne reçoit qu'UNE projection par échéance annuelle", () => {
  const model = computeDividendIncome({
    operations: [operation()],
    positions: [position()],
    announced: [
      announced({ id: "y1", exDate: "2023-05-16", paymentDate: "2023-05-20" }),
      announced({ id: "y2", exDate: "2024-05-17", paymentDate: "2024-05-21" }),
      announced({ id: "y3", exDate: "2025-05-16", paymentDate: "2025-05-20" }),
    ],
    accountType: "PEA",
    today: TODAY,
  });
  assert.equal(model.entries.filter((entry) => entry.status === "estimated").length, 1);
});

test("un instrument versant deux fois par an reçoit une projection PAR échéance", () => {
  const model = computeDividendIncome({
    operations: [operation()],
    positions: [position()],
    announced: [
      announced({ id: "s1", exDate: "2025-12-19", paymentDate: "2025-12-23" }),
      announced({ id: "s2", exDate: "2026-06-18", paymentDate: "2026-06-22" }),
    ],
    accountType: "PEA",
    today: TODAY,
  });
  const projected = model.entries.filter((entry) => entry.status === "estimated");
  assert.equal(projected.length, 2);
  assert.deepEqual(projected.map((entry) => entry.exDate).sort(), ["2026-12-19", "2027-06-18"]);
});

// ---- 2. Un ETF ACC ne produit aucun versement en espèces ------------------------------------
test("un ETF capitalisant (ACC) ne produit AUCUN versement, ni annoncé ni estimé", () => {
  const etfPosition = position({
    key: "isin:IE000BI8OT95", name: "Amundi Core MSCI World UCITS ETF - USD ACC (MWRD)",
    isin: "IE000BI8OT95", ticker: null, assetType: "etf",
  });
  const model = computeDividendIncome({
    operations: [operation({ assetName: "Amundi Core MSCI World UCITS ETF - USD ACC (MWRD)", ticker: null, isin: "IE000BI8OT95" })],
    positions: [etfPosition],
    announced: [announced({ asset: { name: "Amundi Core MSCI World UCITS ETF - USD ACC (MWRD)", symbol: null, isin: "IE000BI8OT95" } })],
    accountType: "PEA",
    today: TODAY,
  });
  assert.equal(model.entries.length, 0);
  assert.equal(model.coverage.accumulating, 1);
});

test("détection « capitalisant » : conservatrice, et jamais appliquée à une action", () => {
  assert.equal(isAccumulating({ name: "ISHARES CORE EURO STOXX 50 ETF EUR ACC", assetType: "etf" }), true);
  assert.equal(isAccumulating({ name: "BNP PARIBAS EASY S&P 500 UCITS ETF - C EUR ACC (ESE)", assetType: "etf" }), true);
  assert.equal(isAccumulating({ name: "Amundi PEA Émergent ESG Transition UCITS ETF Acc", assetType: "etf" }), true);
  // Faux positifs à éviter : une action dont le nom contient « acc », et un ETF distribuant.
  assert.equal(isAccumulating({ name: "Accor", assetType: "stock" }), false);
  assert.equal(isAccumulating({ name: "iShares Euro Dividend UCITS ETF - EUR DIS (IDVY)", assetType: "etf" }), false);
  assert.equal(isAccumulating({ name: "SANOFI", assetType: "stock" }), false);
});

// ---- 3 & 4. « Reçu » vient uniquement d'opérations réelles ----------------------------------
test("aucune opération réelle ⇒ dividendes reçus à zéro, et aucune opération créée", () => {
  const model = computeDividendIncome({
    operations: [operation()], // achat seulement
    positions: [position()],
    announced: [announced()],
    accountType: "PEA",
    today: TODAY,
  });
  assert.equal(model.receivedTotalEur, 0);
  assert.equal(model.receivedThisYearEur, 0);
  assert.equal(model.hasRealDividendOperations, false);
  assert.equal(model.entries.some((entry) => entry.status === "received"), false);
  // Une estimation ne devient jamais une opération : elle porte un identifiant dérivé, préfixé,
  // et jamais l'identifiant d'une ligne d'`account_operations`.
  const estimated = model.entries.filter((entry) => entry.status === "estimated");
  assert.ok(estimated.length > 0);
  assert.ok(estimated.every((entry) => entry.id.includes(":estimated:")));
  assert.ok(estimated.every((entry) => !entry.id.startsWith("op:")));
});

test("un dividende reçu provient bien d'une opération, avec son brut et son net d'origine", () => {
  const model = computeDividendIncome({
    operations: [operation(), operation({ id: "o2", type: "dividende", date: "2026-05-20", grossAmount: 1411.2, netAmount: 1411.2, quantity: null, unitPrice: null })],
    positions: [position()],
    announced: [],
    accountType: "PEA",
    today: TODAY,
  });
  const received = model.entries.find((entry) => entry.status === "received");
  assert.equal(received.id, "op:o2");
  assert.equal(received.grossReference, 1411.2);
  assert.equal(received.netReference, 1411.2);
  assert.equal(received.netIsEstimated, false); // encaissement réel : le net est celui du relevé
  assert.equal(model.receivedThisYearEur, 1411.2);
});

// ---- 5. Le calendrier regroupe par mois -----------------------------------------------------
test("le calendrier regroupe les montants par mois de paiement", () => {
  const model = computeDividendIncome({
    operations: [
      operation(),
      operation({ id: "d-a", type: "dividende", date: "2026-05-20", grossAmount: 100, netAmount: 100, quantity: null }),
      operation({ id: "d-b", type: "dividende", date: "2026-05-28", grossAmount: 50, netAmount: 50, quantity: null }),
      operation({ id: "d-c", type: "dividende", date: "2026-12-04", grossAmount: 30, netAmount: 30, quantity: null }),
    ],
    positions: [position()],
    announced: [],
    accountType: "PEA",
    today: TODAY,
    year: 2026,
  });
  assert.equal(model.monthly.length, 12);
  assert.equal(model.monthly[4].receivedEur, 150); // mai
  assert.equal(model.monthly[11].receivedEur, 30); // décembre
  assert.equal(model.monthly[0].receivedEur, 0); // janvier
  assert.equal(model.quickRead.monthsWithoutIncome, 10);
  assert.equal(model.quickRead.bestMonthLabel, "Mai");
});

// ---- 6 & 7. Brut / net, et fiscalité PEA ----------------------------------------------------
test("le PEA n'applique JAMAIS le PFU par dividende : net = brut", () => {
  const model = computeDividendIncome({
    operations: [operation()], positions: [position()], announced: [announced()],
    accountType: "PEA", today: TODAY,
  });
  const projected = model.entries.find((entry) => entry.status === "estimated");
  assert.equal(projected.netReference, projected.grossReference);
  assert.equal(projected.taxRateApplied, null);
  assert.equal(projected.netIsEstimated, false);
  assert.match(model.taxNote, /aucun prélèvement|différée/i);
});

test("le CTO applique le PFU 30 % en l'ANNONÇANT comme une hypothèse tant qu'aucun taux n'est paramétré", () => {
  const model = computeDividendIncome({
    operations: [operation()], positions: [position()], announced: [announced()],
    accountType: "CTO", today: TODAY, ctoTaxRate: null,
  });
  const projected = model.entries.find((entry) => entry.status === "estimated");
  assert.ok(Math.abs(projected.netReference - projected.grossReference * (1 - DEFAULT_FLAT_TAX_RATE)) < 1e-6);
  assert.equal(projected.netIsEstimated, true);
  assert.match(model.taxNote, /hypothèse PFU 30 %/);
});

test("un taux paramétré remplace l'hypothèse et n'est plus présenté comme estimé", () => {
  const model = computeDividendIncome({
    operations: [operation()], positions: [position()], announced: [announced()],
    accountType: "CTO", today: TODAY, ctoTaxRate: 0.172,
  });
  const projected = model.entries.find((entry) => entry.status === "estimated");
  assert.ok(Math.abs(projected.netReference - projected.grossReference * 0.828) < 1e-6);
  assert.equal(projected.netIsEstimated, false);
  assert.match(model.taxNote, /taux paramétré/);
});

test("brut et net ne sont jamais confondus dans les agrégats", () => {
  const model = computeDividendIncome({
    operations: [
      operation(),
      operation({ id: "d1", type: "dividende", date: "2026-03-10", grossAmount: 200, netAmount: 140, quantity: null }),
    ],
    positions: [position()],
    announced: [],
    accountType: "CTO", today: TODAY, year: 2026,
  });
  const received = model.entries.find((entry) => entry.status === "received");
  assert.equal(received.grossReference, 200);
  assert.equal(received.netReference, 140);
  assert.equal(model.monthly[2].receivedEur, 200); // l'histogramme agrège le BRUT
  assert.equal(model.receivedThisYearEur, 140); // « déjà encaissé » est le NET réellement reçu
});

// ---- Quantité éligible à la date de détachement ---------------------------------------------
test("la quantité éligible est celle détenue à la DATE DE DÉTACHEMENT, pas aujourd'hui", () => {
  const operations = [
    operation({ id: "b1", date: "2024-01-05", quantity: 100 }),
    operation({ id: "b2", date: "2026-07-01", quantity: 260 }), // acheté APRÈS le détachement 2025
  ];
  assert.equal(quantityAtDate(operations, "tkr:SAN", "2025-05-16"), 100);
  assert.equal(quantityAtDate(operations, "tkr:SAN", "2026-07-27"), 360);

  const model = computeDividendIncome({
    operations, positions: [position()], announced: [announced()], accountType: "PEA", today: TODAY,
  });
  const real = model.entries.find((entry) => entry.status === "announced");
  assert.equal(real.eligibleQuantity, 100); // et non 360
});

test("une vente avant le détachement retire les titres du calcul", () => {
  const operations = [
    operation({ id: "b1", date: "2024-01-05", quantity: 360 }),
    operation({ id: "s1", type: "vente", date: "2025-01-05", quantity: 200 }),
  ];
  assert.equal(quantityAtDate(operations, "tkr:SAN", "2025-05-16"), 160);
});

// ---- Couverture et devise -------------------------------------------------------------------
test("une conversion impossible laisse le montant en devise de référence à null, jamais à 1:1", () => {
  const usdPosition = position({ key: "isin:US5949181045", name: "Microsoft", isin: "US5949181045", ticker: null, currency: "USD" });
  const model = computeDividendIncome({
    operations: [operation({ assetName: "Microsoft", ticker: null, isin: "US5949181045", currency: "USD", quantity: 81 })],
    positions: [usdPosition],
    announced: [announced({ id: "d-us", currency: "USD", amountPerShare: 0.83, asset: { name: "Microsoft", symbol: null, isin: "US5949181045" } })],
    accountType: "CTO",
    today: TODAY,
    referenceCurrency: "EUR",
    fxRateAt: () => null, // aucun taux connu
  });
  const entry = model.entries.find((item) => item.status !== "received");
  assert.equal(entry.grossNative, 0.83 * 81);
  assert.equal(entry.grossReference, null);
  assert.equal(entry.conversionUnavailable, true);
});

test("la couverture distingue documenté, capitalisant et inconnu", () => {
  const model = computeDividendIncome({
    operations: [operation()],
    positions: [
      position(),
      position({ key: "isin:IE00B53L3W79", name: "ISHARES CORE EURO STOXX 50 ETF EUR ACC", isin: "IE00B53L3W79", ticker: null, assetType: "etf" }),
      position({ key: "isin:FR0010667147", name: "COFACE", isin: "FR0010667147", ticker: null }),
    ],
    announced: [announced()],
    accountType: "CTO", today: TODAY,
  });
  assert.equal(model.coverage.totalInstruments, 3);
  assert.equal(model.coverage.distributing, 1);
  assert.equal(model.coverage.accumulating, 1);
  assert.equal(model.coverage.unknown, 1);
  assert.ok(Math.abs(model.coverage.coveragePercent - (2 / 3) * 100) < 0.01);
});

test("une annonce réelle À VENIR supprime la projection de la même échéance", () => {
  const model = computeDividendIncome({
    operations: [operation()],
    positions: [position()],
    announced: [
      announced({ id: "past", exDate: "2025-05-16", paymentDate: "2025-05-20" }),
      // Annonce réelle future : c'est elle qui doit être affichée, pas une supposition.
      announced({ id: "future", exDate: "2026-09-10", paymentDate: "2026-09-14", status: "announced" }),
    ],
    accountType: "PEA", today: TODAY,
  });
  const estimated = model.entries.filter((entry) => entry.status === "estimated");
  // L'échéance de mai reste projetée (2027) ; celle de septembre est confirmée, donc non projetée.
  assert.equal(estimated.some((entry) => Math.abs(new Date(entry.exDate) - new Date("2026-09-10")) < 45 * 86400000), false);
  assert.equal(model.entries.filter((entry) => entry.status === "announced").length, 2);
});

test("les 4 prochaines échéances sont triées par date croissante", () => {
  const model = computeDividendIncome({
    operations: [operation()],
    positions: [position()],
    announced: [
      announced({ id: "a", exDate: "2025-03-01", paymentDate: "2025-03-05" }),
      announced({ id: "b", exDate: "2025-09-01", paymentDate: "2025-09-05" }),
      announced({ id: "c", exDate: "2025-12-01", paymentDate: "2025-12-05" }),
    ],
    accountType: "PEA", today: TODAY,
  });
  const dates = model.upcoming.map((entry) => entry.scheduleDate);
  assert.deepEqual(dates, [...dates].sort());
  assert.ok(model.upcoming.length <= 4);
  assert.ok(dates.every((date) => date >= TODAY));
});
