// INTÉGRATION — un portefeuille PEA et un portefeuille compte-titres traversent la chaîne
// complète : opérations réelles → positions dérivées (`computeAccountModel`) → appariement par
// alias → moteur de dividendes → modèle affiché.
//
// Aucun accès base, aucun réseau : ce sont les MÊMES fonctions pures que celles appelées par la
// route serveur. Ce qui est vérifié ici, c'est que les deux enveloppes empruntent exactement le
// même chemin et ne diffèrent que par leur fiscalité.

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeAccountModel } from "../lib/portfolio-account.ts";
import { buildPriceIndex } from "../lib/instrument-alias.ts";
import { computeDividendModel, next12mWindow } from "../lib/dividend-engine.ts";

const TODAY = "2026-07-28";

const operation = (over) => ({
  id: "x", accountId: "acc", memberId: "m", type: "achat", date: "2025-01-10",
  assetName: null, ticker: null, isin: null, quantity: null, unitPrice: null,
  grossAmount: null, fees: 0, netAmount: null, currency: "EUR", exchangeRate: null,
  source: "import", note: null, ...over,
});

/**
 * Reproduit ce que fait `loadDividendContext` : positions dérivées des opérations, référence de
 * prix appariée PAR ALIAS, puis instruments canoniques rattachés à leurs clés de position.
 */
function buildContext({ operations, holdings, accountType, referenceCurrency = "EUR", fxRateAt }) {
  const index = buildPriceIndex(
    holdings,
    (holding) => ({ isin: holding.isin, symbol: holding.symbol, name: holding.name }),
    operations,
  );
  const priceByKey = new Map();
  for (const [key, holding] of index.byKey) {
    priceByKey.set(key, {
      lastPrice: holding.lastPrice, lastPriceAt: null, assetType: holding.assetType,
      name: holding.name, assetId: holding.id,
      fxRateToReference: holding.currency === referenceCurrency ? 1 : fxRateAt?.(holding.currency, TODAY) ?? null,
      referenceCurrency,
    });
  }
  const model = computeAccountModel({ operations, priceByKey, accountType, today: TODAY, referenceCurrency, fxRateAt });
  const positionKeysByAsset = new Map();
  for (const position of model.positions) {
    const holding = index.byKey.get(position.key);
    if (!holding) continue;
    positionKeysByAsset.set(holding.assetId, [...(positionKeysByAsset.get(holding.assetId) ?? []), position.key]);
  }
  const instruments = [...positionKeysByAsset.entries()].map(([assetId, positionKeys]) => {
    const holding = holdings.find((row) => row.assetId === assetId);
    return {
      assetId, positionKeys, name: holding.name, isin: holding.isin, ticker: holding.symbol,
      assetType: holding.assetType, distributionPolicy: holding.distributionPolicy,
      resolutionStatus: "resolved", providerSymbol: holding.providerSymbol ?? null,
      lastSyncedAt: "2026-07-28T06:00:00.000Z",
    };
  });
  return { model, instruments };
}

const event = (over) => ({
  id: "e", assetId: "a", isin: null, providerSymbol: null, status: "announced",
  dividendType: "ordinary", declarationDate: null, exDate: null, recordDate: null,
  paymentDate: null, estimatedMonth: null, amountPerShare: null, currency: "EUR",
  sourceProvider: "alpha_vantage", sourceEventId: null, sourceUrl: null,
  confidence: "high", isSpecial: false, isForecast: false,
  lastSyncedAt: "2026-07-28T06:00:00.000Z", ...over,
});

// ==========================================================================================
// PEA — Sanofi (sans ISIN sur l'opération) + un ETF capitalisant
// ==========================================================================================
const PEA_OPERATIONS = [
  operation({ id: "p1", type: "versement", date: "2024-12-20", grossAmount: 60000, netAmount: 60000 }),
  // L'opération porte `isin: null, ticker: SAN` — exactement la ligne réelle du PEA en base.
  operation({ id: "p2", date: "2025-01-10", assetName: "Sanofi", ticker: "SAN", quantity: 360, unitPrice: 87.83, grossAmount: 31618.8, netAmount: 31618.8 }),
  operation({ id: "p3", date: "2025-02-04", assetName: "iShares MSCI World Swap PEA UCITS ETF", isin: "IE0002XZSHO1", quantity: 5000, unitPrice: 5.2, grossAmount: 26000, netAmount: 26000 }),
];
const PEA_HOLDINGS = [
  // La ligne de référence, elle, est identifiée par son ISIN : c'est le décalage qui rendait
  // Sanofi invisible avant l'appariement par alias.
  { id: "h1", assetId: "asset-san", name: "Sanofi", symbol: null, isin: "FR0000120578", currency: "EUR", assetType: "stock", lastPrice: 90, distributionPolicy: "distributing", providerSymbol: "SAN.PA" },
  { id: "h2", assetId: "asset-wpea", name: "iShares MSCI World Swap PEA UCITS ETF", symbol: "WPEA", isin: "IE0002XZSHO1", currency: "EUR", assetType: "etf", lastPrice: 5.9, distributionPolicy: "accumulating", providerSymbol: "WPEA.PA" },
];
const PEA_EVENTS = [
  event({ id: "san-a", assetId: "asset-san", isin: "FR0000120578", exDate: "2026-09-10", paymentDate: "2026-09-14", amountPerShare: 3.92 }),
  event({ id: "san-f", assetId: "asset-san", isin: "FR0000120578", status: "estimated", isForecast: true, estimatedMonth: "2027-05", amountPerShare: 3.76, confidence: "high", sourceProvider: "projection" }),
  // Un événement rattaché à l'ETF capitalisant : il ne doit produire AUCUN versement en espèces.
  event({ id: "wpea-a", assetId: "asset-wpea", isin: "IE0002XZSHO1", exDate: "2026-11-05", paymentDate: "2026-11-09", amountPerShare: 0.4 }),
];

test("PEA — Sanofi remonte malgré l'absence d'ISIN sur l'opération, l'ETF capitalisant reste muet", () => {
  const { model, instruments } = buildContext({ operations: PEA_OPERATIONS, holdings: PEA_HOLDINGS, accountType: "PEA" });
  assert.equal(model.positions.length, 2);

  const dividends = computeDividendModel({
    operations: PEA_OPERATIONS, positions: model.positions, events: PEA_EVENTS, instruments,
    accountType: "PEA", today: TODAY, referenceCurrency: "EUR", taxProfile: null,
    positionsValueReference: model.positionsValueEur, investedReference: model.investedInAssetsEur,
  });

  const announced = dividends.entries.filter((entry) => entry.status === "announced");
  assert.equal(announced.length, 1, "seul Sanofi verse en espèces");
  assert.equal(announced[0].name, "Sanofi");
  assert.equal(announced[0].eligibleQuantity, 360);
  assert.equal(announced[0].grossReference, 3.92 * 360);
  assert.equal(announced[0].paymentDate, "2026-09-14");

  const estimated = dividends.entries.filter((entry) => entry.status === "estimated");
  assert.equal(estimated.length, 1);
  assert.equal(estimated[0].scheduleMonth, "2027-05");
  assert.equal(estimated[0].exDate, null, "une projection ne porte jamais de date exacte");

  // Le capitalisant est compté dans la couverture, sans jamais produire d'échéance.
  assert.equal(dividends.coverage.accumulating, 1);
  assert.equal(dividends.entries.some((entry) => entry.name.includes("MSCI World Swap")), false);
  assert.equal(dividends.positions.find((position) => position.isin === "IE0002XZSHO1").dataStatus, "accumulating");

  // Fiscalité PEA : aucun prélèvement par versement, aucun sélecteur « net ».
  assert.equal(dividends.tax.netAvailable, false);
  assert.equal(announced[0].netReference, announced[0].grossReference);

  // Cohérence arithmétique de l'écran.
  assert.ok(Math.abs(dividends.monthlyAverageReference * 12 - dividends.expectedReference) < 1e-6);
  assert.ok(Math.abs(dividends.expectedReference - (3.92 * 360 + 3.76 * 360)) < 1e-6);
});

// ==========================================================================================
// Compte-titres — multi-devises, un encaissement réel et un profil fiscal complet
// ==========================================================================================
const CTO_OPERATIONS = [
  operation({ id: "c1", type: "versement", date: "2024-01-05", grossAmount: 200000, netAmount: 200000 }),
  operation({ id: "c2", date: "2024-02-01", assetName: "TOTALENERGIES (TTE)", isin: "FR0000120271", ticker: "TTE", quantity: 1568, unitPrice: 55, grossAmount: 86240, netAmount: 86240 }),
  operation({ id: "c3", date: "2024-03-01", assetName: "Microsoft (MSFT)", isin: "US5949181045", ticker: "MSFT", quantity: 81, unitPrice: 400, grossAmount: 32400, netAmount: 32400, currency: "USD", exchangeRate: 0.9 }),
  // Encaissement RÉEL : la seule source d'un « reçu ».
  operation({ id: "c4", type: "dividende", date: "2026-08-05", assetName: "TOTALENERGIES (TTE)", isin: "FR0000120271", ticker: "TTE", grossAmount: 1332.8, netAmount: 1332.8 }),
];
const CTO_HOLDINGS = [
  { id: "h3", assetId: "asset-tte", name: "TOTALENERGIES (TTE)", symbol: "TTE", isin: "FR0000120271", currency: "EUR", assetType: "stock", lastPrice: 60, distributionPolicy: "distributing", providerSymbol: "TTE.PA" },
  { id: "h4", assetId: "asset-msft", name: "Microsoft (MSFT)", symbol: "MSFT", isin: "US5949181045", currency: "USD", assetType: "stock", lastPrice: 430, distributionPolicy: "distributing", providerSymbol: "MSFT" },
];
const CTO_EVENTS = [
  event({ id: "tte-a", assetId: "asset-tte", isin: "FR0000120271", exDate: "2026-09-30", paymentDate: "2026-10-02", amountPerShare: 0.85 }),
  // Le fournisseur n'a pas publié la date de paiement : elle doit rester inconnue.
  event({ id: "tte-b", assetId: "asset-tte", isin: "FR0000120271", exDate: "2026-12-30", paymentDate: null, amountPerShare: 0.85, sourceProvider: "eodhd" }),
  event({ id: "msft-a", assetId: "asset-msft", isin: "US5949181045", exDate: "2026-11-19", paymentDate: "2026-12-11", amountPerShare: 0.83, currency: "USD" }),
];
/** 1 EUR = 1,1377 USD ⇒ convertir un dollar en euro est une DIVISION. */
const usdToEur = (currency) => (currency === "USD" ? 1 / 1.1377 : currency === "EUR" ? 1 : null);

test("compte-titres — devises, date de paiement absente et encaissement réel cohabitent sans se contredire", () => {
  const fxRateAt = (currency) => usdToEur(currency);
  const { model, instruments } = buildContext({ operations: CTO_OPERATIONS, holdings: CTO_HOLDINGS, accountType: "CTO", fxRateAt });
  assert.equal(model.positions.length, 2);

  const taxProfile = { taxResidencyCountry: "FR", withholdingTaxRate: 0.128, estimatedTaxRate: 0.172, allowanceRate: 0, showEstimatedNet: true };
  const dividends = computeDividendModel({
    operations: CTO_OPERATIONS, positions: model.positions, events: CTO_EVENTS, instruments,
    accountType: "CTO", today: TODAY, referenceCurrency: "EUR", fxRateAt, taxProfile,
    positionsValueReference: model.positionsValueEur, investedReference: model.investedInAssetsEur,
  });

  // Le reçu vient d'une opération, et de rien d'autre.
  const received = dividends.entries.filter((entry) => entry.status === "received");
  assert.equal(received.length, 1);
  assert.equal(received[0].id, "op:c4");
  assert.equal(received[0].grossReference, 1332.8);
  assert.equal(dividends.receivedThisYearCount, 1);

  // Date de paiement absente : le mois est déduit, et l'anomalie est signalée.
  const december = dividends.entries.find((entry) => entry.id === "ev:tte-b");
  assert.equal(december.paymentDate, null);
  assert.equal(december.scheduleBasis, "ex_date");
  assert.ok(dividends.anomalies.some((anomaly) => anomaly.kind === "missing_payment_date"));

  // Le dividende en dollars est converti par DIVISION, et son montant natif est conservé.
  const microsoft = dividends.entries.find((entry) => entry.id === "ev:msft-a");
  assert.equal(microsoft.currency, "USD");
  assert.equal(microsoft.grossNative, 0.83 * 81);
  assert.ok(Math.abs(microsoft.grossReference - (0.83 * 81) / 1.1377) < 1e-6);
  assert.ok(microsoft.grossReference < microsoft.grossNative, "1 USD vaut moins d'un euro : la conversion divise");

  // Fiscalité CTO : le net existe parce qu'un profil le définit — jamais par défaut.
  assert.equal(dividends.tax.netAvailable, true);
  assert.ok(Math.abs(dividends.tax.effectiveRate - 0.3) < 1e-9);
  assert.ok(Math.abs(microsoft.netReference - microsoft.grossReference * 0.7) < 1e-6);
  // Un encaissement réel garde le net du relevé : aucun taux théorique ne le recalcule.
  assert.equal(received[0].netReference, 1332.8);
  assert.equal(received[0].netIsEstimated, false);

  // Cohérence : total = somme des trois catégories = somme des douze mois = moyenne × 12.
  const monthlyTotal = dividends.monthly.reduce((sum, point) => sum + point.totalReference, 0);
  assert.ok(Math.abs(monthlyTotal - dividends.expectedReference) < 1e-6);
  assert.ok(Math.abs(dividends.monthlyAverageReference * 12 - dividends.expectedReference) < 1e-6);
  assert.equal(dividends.window.months, 12);
});

// ==========================================================================================
// Le même moteur pour les deux enveloppes
// ==========================================================================================
test("un SEUL moteur : seule la fiscalité distingue le PEA du compte-titres", () => {
  const shared = {
    operations: PEA_OPERATIONS, events: PEA_EVENTS, today: TODAY, referenceCurrency: "EUR",
    window: next12mWindow(TODAY),
  };
  const context = buildContext({ operations: PEA_OPERATIONS, holdings: PEA_HOLDINGS, accountType: "PEA" });
  const asPea = computeDividendModel({ ...shared, positions: context.model.positions, instruments: context.instruments, accountType: "PEA", taxProfile: null });
  const asCto = computeDividendModel({
    ...shared, positions: context.model.positions, instruments: context.instruments, accountType: "CTO",
    taxProfile: { taxResidencyCountry: "FR", withholdingTaxRate: 0.128, estimatedTaxRate: 0.172, allowanceRate: 0, showEstimatedNet: true },
  });

  // Mêmes échéances, mêmes montants BRUTS, même calendrier : le brut ne dépend pas de l'enveloppe.
  assert.deepEqual(
    asPea.entries.map((entry) => [entry.id, entry.scheduleMonth, entry.grossReference]),
    asCto.entries.map((entry) => [entry.id, entry.scheduleMonth, entry.grossReference]),
  );
  assert.equal(asPea.expectedReference, asCto.expectedReference);

  // Seul le net diffère — et il n'existe que là où un profil fiscal le définit.
  assert.equal(asPea.tax.netAvailable, false);
  assert.equal(asCto.tax.netAvailable, true);
  const peaEntry = asPea.entries.find((entry) => entry.status === "announced");
  const ctoEntry = asCto.entries.find((entry) => entry.status === "announced");
  assert.equal(peaEntry.netReference, peaEntry.grossReference);
  assert.ok(ctoEntry.netReference < ctoEntry.grossReference);
});

test("sans aucune donnée fournisseur, l'écran reste honnête : zéro attendu, positions listées", () => {
  const { model, instruments } = buildContext({ operations: PEA_OPERATIONS, holdings: PEA_HOLDINGS, accountType: "PEA" });
  const dividends = computeDividendModel({
    operations: PEA_OPERATIONS, positions: model.positions, events: [], instruments,
    accountType: "PEA", today: TODAY, referenceCurrency: "EUR",
    positionsValueReference: model.positionsValueEur, investedReference: model.investedInAssetsEur,
  });
  assert.equal(dividends.expectedReference, 0);
  assert.equal(dividends.entries.length, 0);
  assert.equal(dividends.forwardYieldPct, null);
  assert.match(dividends.yieldUnavailableReason, /Aucun dividende attendu/);
  // Les positions restent listées avec leur statut : « pas de donnée » n'est pas « pas de position ».
  assert.equal(dividends.positions.length, 2);
  assert.equal(dividends.positions.find((position) => position.name === "Sanofi").dataStatus, "no_data");
});
