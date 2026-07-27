// « Patrimoine total » du tableau de bord — contribution PEA / compte-titres
// (lib/home-portfolio.ts).
//
// Ce que ces tests verrouillent, et pourquoi :
// le tableau de bord valorisait autrefois les enveloppes par `holdings.quantity × last_price`.
// Or `holdings` est un référentiel de COURS : l'import CSV, l'import de capture courtier et le
// rafraîchissement des cours y écrivent tous `quantity: 0`. Un PEA constitué par import valait
// donc 0 € en accueil — et, à cause du garde « on n'ajoute que si > 0 », disparaissait du
// patrimoine total, alors que l'écran PEA affichait sa vraie valeur. Les espèces étaient
// ignorées elles aussi.

import { test } from "node:test";
import assert from "node:assert/strict";
import { investmentBucket, investmentWealth } from "../lib/home-portfolio.ts";
import { computeAccountModel, instrumentKey } from "../lib/portfolio-account.ts";

let counter = 0;
function op(partial) {
  counter += 1;
  return {
    id: `op-${counter}`, accountId: "pea-1", type: "achat", date: "2026-01-15",
    assetName: null, ticker: null, isin: null, quantity: null, unitPrice: null,
    grossAmount: null, fees: 0, netAmount: null, currency: "EUR", source: null, note: null,
    ...partial,
  };
}

// Ligne `holdings` telle que l'écrivent réellement les imports : quantité à zéro, seul le cours
// est renseigné.
const holdingRef = (accountId, isin, lastPrice) => ({
  account_id: accountId, isin, symbol: null, name: null, asset_type: "etf",
  quantity: 0, average_cost: null, last_price: lastPrice, last_price_at: "2026-07-27T10:00:00Z", currency: "EUR",
});

const PEA = [{ id: "pea-1", accountType: "pea" }];
const TODAY = "2026-07-27";

test("un PEA issu d'un import (holdings.quantity = 0) est valorisé, pas ignoré", () => {
  const bucket = investmentBucket({
    accountType: "pea", kind: "PEA", accounts: PEA, fxRates: [], today: TODAY,
    holdings: [holdingRef("pea-1", "FR0000120073", 130)],
    operations: [
      op({ type: "versement", netAmount: 10000, grossAmount: 10000 }),
      op({ type: "achat", isin: "FR0000120073", quantity: 50, unitPrice: 100, grossAmount: 5000, netAmount: 5000 }),
    ],
  });

  // 50 titres × 130 € = 6 500 € de positions, + 5 000 € d'espèces restantes.
  assert.equal(bucket.value, 11500);
  assert.equal(bucket.cost, 10000); // versements − retraits
  assert.equal(bucket.unpriced, false);
  // C'est bien le calcul qui échouait avant : quantity × last_price aurait donné 0.
  const naif = 0 * 130;
  assert.notEqual(bucket.value, naif);
});

test("le tableau de bord affiche exactement le même total que l'écran PEA", () => {
  const holdings = [holdingRef("pea-1", "FR0000120073", 130), holdingRef("pea-1", "IE0002XZSHO1", 12.5)];
  const operations = [
    op({ type: "versement", netAmount: 20000, grossAmount: 20000 }),
    op({ type: "achat", isin: "FR0000120073", quantity: 50, unitPrice: 100, grossAmount: 5000, netAmount: 5000 }),
    op({ type: "achat", isin: "IE0002XZSHO1", quantity: 400, unitPrice: 10, grossAmount: 4000, netAmount: 4000 }),
    op({ type: "dividende", isin: "FR0000120073", netAmount: 120, grossAmount: 120 }),
  ];

  const bucket = investmentBucket({ accountType: "pea", kind: "PEA", accounts: PEA, holdings, operations, fxRates: [], today: TODAY });

  // Le même moteur, appelé comme le fait l'écran PEA.
  const priceByKey = new Map();
  for (const holding of holdings) {
    priceByKey.set(instrumentKey({ isin: holding.isin, ticker: null, assetName: null }), {
      lastPrice: holding.last_price, lastPriceAt: holding.last_price_at, assetType: holding.asset_type, name: null,
    });
  }
  const ecran = computeAccountModel({ operations, priceByKey, accountType: "PEA", today: TODAY, referenceCurrency: "EUR" });

  assert.equal(bucket.value, ecran.totalValueEur);
  assert.equal(bucket.value - bucket.cost, ecran.performanceEur);
});

test("patrimoine total = Bitcoin + PEA + compte-titres, chaque enveloppe à sa vraie valeur", () => {
  const { pea, cto } = investmentWealth({
    accounts: [{ id: "pea-1", accountType: "pea" }, { id: "cto-1", accountType: "securities" }],
    holdings: [holdingRef("pea-1", "FR0000120073", 130), holdingRef("cto-1", "US0378331005", 200)],
    operations: [
      op({ accountId: "pea-1", type: "versement", netAmount: 6000, grossAmount: 6000 }),
      op({ accountId: "pea-1", type: "achat", isin: "FR0000120073", quantity: 50, unitPrice: 100, grossAmount: 5000, netAmount: 5000 }),
      op({ accountId: "cto-1", type: "versement", netAmount: 2000, grossAmount: 2000 }),
      op({ accountId: "cto-1", type: "achat", isin: "US0378331005", quantity: 10, unitPrice: 150, grossAmount: 1500, netAmount: 1500 }),
    ],
    fxRates: [], today: TODAY,
  });

  assert.equal(pea.value, 50 * 130 + 1000); // positions + espèces
  assert.equal(cto.value, 10 * 200 + 500);

  const bitcoinValueEur = 553.98;
  const total = bitcoinValueEur + pea.value + cto.value;
  assert.equal(Math.round(total * 100) / 100, 553.98 + 7500 + 2500);
});

test("une enveloppe absente vaut 0 et ne rend pas le total indisponible", () => {
  const { pea, cto } = investmentWealth({
    accounts: [{ id: "pea-1", accountType: "pea" }],
    holdings: [holdingRef("pea-1", "FR0000120073", 130)],
    operations: [op({ type: "achat", isin: "FR0000120073", quantity: 10, unitPrice: 100, grossAmount: 1000, netAmount: 1000 })],
    fxRates: [], today: TODAY,
  });
  assert.equal(cto.value, 0);
  assert.equal(cto.cost, 0);
  assert.equal(cto.unpriced, false); // pas de compte-titres ≠ compte-titres non valorisable
  assert.ok(pea.value > 0);
});

test("un compte sans aucune opération ne pèse rien", () => {
  const bucket = investmentBucket({
    accountType: "pea", kind: "PEA", accounts: PEA, holdings: [holdingRef("pea-1", "FR0000120073", 130)],
    operations: [], fxRates: [], today: TODAY,
  });
  assert.deepEqual(bucket, { value: 0, cost: 0, unpriced: false });
});

test("une position sans cours signale `unpriced` au lieu d'un total partiel", () => {
  const bucket = investmentBucket({
    accountType: "pea", kind: "PEA", accounts: PEA, fxRates: [], today: TODAY,
    holdings: [], // aucune référence de cours pour la ligne détenue
    operations: [
      op({ type: "versement", netAmount: 5000, grossAmount: 5000 }),
      op({ type: "achat", isin: "FR0000120073", quantity: 50, unitPrice: 100, grossAmount: 5000, netAmount: 5000 }),
    ],
  });
  // Espèces à zéro et aucune position valorisable : le moteur ne produit pas de total, et le
  // tableau de bord doit afficher « Valeur indisponible » plutôt qu'un patrimoine amputé du PEA.
  assert.equal(bucket.unpriced, true);
  assert.equal(bucket.value, 0);
});

test("des achats sans versement laissent des espèces négatives, pas un `unpriced`", () => {
  // Comportement RÉEL du moteur, documenté ici pour qu'il ne surprenne pas : un achat non
  // précédé d'un versement creuse le solde espèces. Le total reste calculable (donc `unpriced`
  // est faux) mais il est négatif ; le tableau de bord n'ajoute une classe d'actif au patrimoine
  // que si elle est strictement positive, cette enveloppe n'y entre donc pas.
  const bucket = investmentBucket({
    accountType: "pea", kind: "PEA", accounts: PEA, fxRates: [], today: TODAY,
    holdings: [holdingRef("pea-1", "FR0000120073", 130)],
    operations: [op({ type: "achat", isin: "FR0000120073", quantity: 50, unitPrice: 100, grossAmount: 5000, netAmount: 5000 })],
  });
  assert.equal(bucket.unpriced, false);
  assert.equal(bucket.value, 50 * 130 - 5000); // 1 500 € : positions valorisées − espèces avancées
});

test("seuls les comptes du périmètre transmis sont comptés", () => {
  const operations = [
    op({ accountId: "pea-1", type: "versement", netAmount: 1000, grossAmount: 1000 }),
    op({ accountId: "pea-autre", type: "versement", netAmount: 9999, grossAmount: 9999 }),
  ];
  const bucket = investmentBucket({
    accountType: "pea", kind: "PEA", accounts: PEA, holdings: [], operations, fxRates: [], today: TODAY,
  });
  // Le compte d'un autre membre (hors périmètre) n'est pas transmis : son versement est ignoré.
  assert.equal(bucket.value, 1000);
});

test("le tableau de bord n'utilise plus holdings.quantity pour valoriser une enveloppe", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../app/family-dashboard.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /holding\.quantity\s*\*/);
  assert.match(source, /investmentWealth\(/);
});
