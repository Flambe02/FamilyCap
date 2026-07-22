// Tests unitaires du moteur PEA (lib/portfolio-account.ts).
// Exécution : `node --test tests/portfolio-account.test.mjs` (Node ≥ 22.18 / 24 : type-stripping natif).
// Couvre : quantité détenue, montant net investi, solde espèces, prix de revient (PMP),
// plus/moins-value, agrégation des dividendes, répartition par type d'actif, classement des
// positions, état vide et absence de prix.

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeAccountModel, instrumentKey } from "../lib/portfolio-account.ts";

let counter = 0;
function op(partial) {
  counter += 1;
  return {
    id: `op-${counter}`,
    accountId: "acc",
    type: "achat",
    date: "2026-01-15",
    assetName: null,
    ticker: null,
    isin: null,
    quantity: null,
    unitPrice: null,
    grossAmount: null,
    fees: 0,
    netAmount: null,
    currency: "EUR",
    source: null,
    note: null,
    ...partial,
  };
}

function priceMap(entries) {
  const map = new Map();
  for (const [isin, price] of entries) {
    map.set(instrumentKey({ isin, ticker: null, assetName: null }), { lastPrice: price.lastPrice, lastPriceAt: null, assetType: price.assetType, name: price.name ?? null });
  }
  return map;
}

const base = { accountType: "PEA", today: "2026-07-22" };
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test("quantité détenue = achats − ventes", () => {
  const model = computeAccountModel({
    operations: [
      op({ type: "achat", isin: "AAA", quantity: 10, unitPrice: 100, grossAmount: 1000, netAmount: 1000 }),
      op({ type: "vente", isin: "AAA", quantity: 4, unitPrice: 120, grossAmount: 480, netAmount: 480 }),
    ],
    priceByKey: priceMap([["AAA", { lastPrice: 130, assetType: "etf" }]]),
    ...base,
  });
  assert.equal(model.positions.length, 1);
  assert.ok(approx(model.positions[0].quantity, 6));
});

test("montant net investi = versements − retraits (≠ montant investi en titres)", () => {
  const model = computeAccountModel({
    operations: [
      op({ type: "versement", grossAmount: 1000, netAmount: 1000 }),
      op({ type: "retrait", grossAmount: 200, netAmount: 200 }),
    ],
    priceByKey: new Map(),
    ...base,
  });
  assert.ok(approx(model.netInvestedEur, 800));
});

test("solde espèces = versements − achats + ventes + dividendes − retraits − frais", () => {
  const model = computeAccountModel({
    operations: [
      op({ type: "versement", grossAmount: 1000, netAmount: 1000 }),
      op({ type: "achat", isin: "AAA", quantity: 10, unitPrice: 50, grossAmount: 500, fees: 5, netAmount: 505 }),
      op({ type: "dividende", isin: "AAA", grossAmount: 30, netAmount: 30 }),
    ],
    priceByKey: priceMap([["AAA", { lastPrice: 60, assetType: "etf" }]]),
    ...base,
  });
  // 1000 − 505 + 30 = 525
  assert.ok(approx(model.cashEur, 525));
});

test("prix de revient moyen pondéré (CUMP/PMP), frais inclus", () => {
  const model = computeAccountModel({
    operations: [
      op({ type: "achat", isin: "AAA", quantity: 10, unitPrice: 100, grossAmount: 1000, fees: 0, netAmount: 1000 }),
      op({ type: "achat", isin: "AAA", quantity: 10, unitPrice: 120, grossAmount: 1200, fees: 0, netAmount: 1200 }),
      op({ type: "vente", isin: "AAA", quantity: 5, unitPrice: 130, grossAmount: 650, netAmount: 650 }),
    ],
    priceByKey: priceMap([["AAA", { lastPrice: 130, assetType: "etf" }]]),
    ...base,
  });
  const position = model.positions[0];
  assert.ok(approx(position.quantity, 15));
  assert.ok(approx(position.averageCost, 110)); // (2200/20) conservé après vente
  assert.ok(approx(model.averageBookPrice, 110));
});

test("plus / moins-value latente = valeur − prix de revient des titres détenus", () => {
  const model = computeAccountModel({
    operations: [op({ type: "achat", isin: "AAA", quantity: 10, unitPrice: 100, grossAmount: 1000, netAmount: 1000 })],
    priceByKey: priceMap([["AAA", { lastPrice: 150, assetType: "etf" }]]),
    ...base,
  });
  assert.ok(approx(model.unrealizedGainEur, 500));
  assert.ok(approx(model.unrealizedGainPct, 50));
});

test("agrégation des dividendes (net)", () => {
  const model = computeAccountModel({
    operations: [
      op({ type: "dividende", isin: "AAA", grossAmount: 30, netAmount: 30 }),
      op({ type: "dividende", isin: "BBB", grossAmount: 20, netAmount: 20 }),
    ],
    priceByKey: new Map(),
    ...base,
  });
  assert.ok(approx(model.dividendsNetEur, 50));
});

test("répartition par type d'actif (ETF / Actions / Espèces)", () => {
  const model = computeAccountModel({
    operations: [
      op({ type: "versement", grossAmount: 1000, netAmount: 1000 }),
      op({ type: "achat", isin: "AAA", quantity: 10, unitPrice: 50, grossAmount: 500, fees: 5, netAmount: 505 }),
      op({ type: "achat", isin: "BBB", quantity: 5, unitPrice: 40, grossAmount: 200, netAmount: 200 }),
    ],
    priceByKey: priceMap([
      ["AAA", { lastPrice: 60, assetType: "etf" }],
      ["BBB", { lastPrice: 50, assetType: "stock" }],
    ]),
    ...base,
  });
  const labels = model.allocation.map((bucket) => bucket.label);
  assert.ok(labels.includes("ETF"));
  assert.ok(labels.includes("Actions"));
  assert.ok(labels.includes("Espèces"));
  const totalPct = model.allocation.reduce((sum, bucket) => sum + bucket.pct, 0);
  assert.ok(approx(totalPct, 100, 0.001));
});

test("classement des principales positions par valeur décroissante", () => {
  const model = computeAccountModel({
    operations: [
      op({ type: "achat", isin: "AAA", quantity: 10, unitPrice: 50, grossAmount: 500, netAmount: 500 }),
      op({ type: "achat", isin: "BBB", quantity: 5, unitPrice: 40, grossAmount: 200, netAmount: 200 }),
    ],
    priceByKey: priceMap([
      ["AAA", { lastPrice: 60, assetType: "etf" }], // 600
      ["BBB", { lastPrice: 50, assetType: "stock" }], // 250
    ]),
    ...base,
  });
  assert.equal(model.positions[0].isin, "AAA");
  assert.equal(model.positions[1].isin, "BBB");
});

test("état vide : aucune opération", () => {
  const model = computeAccountModel({ operations: [], priceByKey: new Map(), ...base });
  assert.equal(model.hasOperations, false);
  assert.equal(model.positions.length, 0);
  assert.equal(model.totalValueEur, null);
  assert.equal(model.startDate, null);
});

test("absence de prix : valeur non calculée, jamais inventée", () => {
  const model = computeAccountModel({
    operations: [
      op({ type: "versement", grossAmount: 1000, netAmount: 1000 }),
      op({ type: "achat", isin: "AAA", quantity: 10, unitPrice: 100, grossAmount: 1000, netAmount: 1000 }),
    ],
    priceByKey: new Map(), // aucun cours connu
    ...base,
  });
  assert.equal(model.positions.length, 1);
  assert.equal(model.positions[0].currentValueEur, null);
  assert.equal(model.positionsValueEur, null);
  assert.equal(model.unrealizedGainEur, null);
  assert.equal(model.unpricedPositions, 1);
  // versement 1000 − achat 1000 = 0 espèce ; aucune position valorisée → total non disponible
  assert.equal(model.totalValueEur, null);
});

test("investissement régulier : versement du mois courant comptabilisé", () => {
  const model = computeAccountModel({
    operations: [
      op({ type: "versement", date: "2026-07-05", grossAmount: 100, netAmount: 100 }),
      op({ type: "versement", date: "2026-06-05", grossAmount: 100, netAmount: 100 }),
    ],
    priceByKey: new Map(),
    ...base,
  });
  assert.ok(approx(model.monthly.investedThisMonth, 100));
  assert.equal(model.monthly.status, "investi");
});

// ---- Compte-titres (CTO) : transferts, devises, agrégation multi-compte, impact du change ----
const cto = { accountType: "CTO", today: "2026-07-22" };

test("transfert entrant : ajoute une position sans mouvement d'espèces", () => {
  const model = computeAccountModel({
    operations: [
      op({ type: "versement", grossAmount: 1000, netAmount: 1000 }),
      op({ type: "transfer_in", isin: "AAA", quantity: 5, unitPrice: 100, grossAmount: 500, netAmount: 500 }),
    ],
    priceByKey: priceMap([["AAA", { lastPrice: 120, assetType: "etf" }]]),
    ...cto,
  });
  assert.ok(approx(model.cashEur, 1000)); // le transfert de titres ne touche pas la trésorerie
  assert.equal(model.positions.length, 1);
  assert.ok(approx(model.positions[0].quantity, 5));
  assert.ok(approx(model.positions[0].investedEur, 500)); // prix de revient repris
});

test("transfert sortant : retire la quantité, espèces inchangées", () => {
  const model = computeAccountModel({
    operations: [
      op({ type: "achat", isin: "AAA", quantity: 10, unitPrice: 100, grossAmount: 1000, netAmount: 1000 }),
      op({ type: "transfer_out", isin: "AAA", quantity: 4, unitPrice: 130, grossAmount: 520, netAmount: 520 }),
    ],
    priceByKey: priceMap([["AAA", { lastPrice: 130, assetType: "etf" }]]),
    ...cto,
  });
  assert.ok(approx(model.positions[0].quantity, 6));
  assert.ok(approx(model.cashEur, -1000)); // seul l'achat a bougé les espèces (−1000)
});

test("répartition par devise : positions groupées par devise, non converties", () => {
  const model = computeAccountModel({
    operations: [
      op({ type: "achat", isin: "AAA", quantity: 10, unitPrice: 50, grossAmount: 500, fees: 5, netAmount: 505, currency: "EUR" }),
      op({ type: "achat", isin: "BBB", quantity: 5, unitPrice: 40, grossAmount: 200, netAmount: 200, currency: "USD" }),
    ],
    priceByKey: priceMap([
      ["AAA", { lastPrice: 60, assetType: "etf" }], // 600
      ["BBB", { lastPrice: 50, assetType: "stock" }], // 250 (USD, non converti)
    ]),
    ...cto,
  });
  const currencies = model.currencyAllocation.map((bucket) => bucket.currency).sort();
  assert.deepEqual(currencies, ["EUR", "USD"]);
  const usd = model.currencyAllocation.find((bucket) => bucket.currency === "USD");
  assert.ok(approx(usd.value, 250));
  assert.equal(model.positions.find((position) => position.isin === "BBB").currency, "USD");
  const totalPct = model.currencyAllocation.reduce((sum, bucket) => sum + bucket.pct, 0);
  assert.ok(approx(totalPct, 100, 0.001));
});

test("impact du change : jamais estimé (null) au lot 1", () => {
  const model = computeAccountModel({
    operations: [op({ type: "achat", isin: "AAA", quantity: 1, unitPrice: 100, grossAmount: 100, netAmount: 100, currency: "USD" })],
    priceByKey: priceMap([["AAA", { lastPrice: 110, assetType: "stock" }]]),
    ...cto,
  });
  assert.equal(model.fxImpactEur, null);
});

test("agrégation multi-compte : même ISIN fusionné, comptes attribués", () => {
  const model = computeAccountModel({
    operations: [
      op({ type: "achat", accountId: "a1", accountName: "Boursorama", isin: "AAA", quantity: 5, unitPrice: 100, grossAmount: 500, netAmount: 500 }),
      op({ type: "achat", accountId: "a2", accountName: "Trade Republic", isin: "AAA", quantity: 5, unitPrice: 120, grossAmount: 600, netAmount: 600 }),
      op({ type: "achat", accountId: "a2", accountName: "Trade Republic", isin: "BBB", quantity: 2, unitPrice: 50, grossAmount: 100, netAmount: 100 }),
    ],
    priceByKey: priceMap([
      ["AAA", { lastPrice: 130, assetType: "etf" }],
      ["BBB", { lastPrice: 60, assetType: "stock" }],
    ]),
    ...cto,
  });
  const aaa = model.positions.find((position) => position.isin === "AAA");
  assert.ok(approx(aaa.quantity, 10)); // fusion des deux comptes
  assert.ok(approx(aaa.averageCost, 110)); // (500 + 600) / 10
  assert.deepEqual([...aaa.accounts].sort(), ["Boursorama", "Trade Republic"]);
  const bbb = model.positions.find((position) => position.isin === "BBB");
  assert.deepEqual(bbb.accounts, ["Trade Republic"]);
});

test("position mono-devise EUR par défaut", () => {
  const model = computeAccountModel({
    operations: [op({ type: "achat", isin: "AAA", quantity: 1, unitPrice: 100, grossAmount: 100, netAmount: 100 })],
    priceByKey: priceMap([["AAA", { lastPrice: 100, assetType: "etf" }]]),
    ...cto,
  });
  assert.equal(model.positions[0].currency, "EUR");
  assert.equal(model.currencyAllocation.length, 1);
  assert.equal(model.currencyAllocation[0].currency, "EUR");
});
