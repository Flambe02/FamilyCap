// CONVERSION DE DEVISES — taux de référence BCE.
//
// Le piège central de ce sujet tient en une phrase : la BCE cote l'EURO EN BASE. « 1,1377 » ne
// veut pas dire « un dollar vaut 1,1377 euro » mais « un euro vaut 1,1377 dollar ». Multiplier
// au lieu de diviser gonfle un portefeuille de 29 % sans rien casser visiblement — d'où le
// nombre de tests consacrés au SENS de la conversion.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  convertAmount, convertCurrency, ecbRowsFor, FX_FOOTNOTE, getLatestFxRate, getPortfolioFxRates,
  MAX_FRESH_DAYS, parseEcbDailyXml, selectRateRow, shortRateDate, staleRateNotice,
} from "../lib/fx-rates.ts";
import { parseEcbDailyXml as parseEcbDailyXmlEdge, ecbRowsFor as ecbRowsForEdge, rejectedCurrencies } from "../supabase/functions/sync-fx-rates/ecb.ts";
import { computeAccountModel } from "../lib/portfolio-account.ts";

const rate = (quoteCurrency, value, rateDate) => ({ baseCurrency: "EUR", quoteCurrency, rate: value, rateDate, source: "ECB" });

// Taux réels du 24/07/2026 utilisés dans tout ce fichier (vendredi).
const FRIDAY = "2026-07-24";
const ROWS = [
  rate("USD", 1.1377, FRIDAY),
  rate("GBP", 0.8642, FRIDAY),
  rate("CHF", 0.9315, FRIDAY),
  rate("USD", 1.1402, "2026-07-23"),
  rate("GBP", 0.8630, "2026-07-23"),
];

// ==========================================================================================
// Lecture du fichier BCE
// ==========================================================================================

const ECB_XML = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
 <gesmes:subject>Reference rates</gesmes:subject>
 <Cube>
  <Cube time='2026-07-24'>
   <Cube currency='USD' rate='1.1377'/>
   <Cube currency='JPY' rate='171.35'/>
   <Cube currency='GBP' rate='0.8642'/>
   <Cube currency='CHF' rate='0.9315'/>
  </Cube>
 </Cube>
</gesmes:Envelope>`;

test("BCE : la date et les taux sont extraits du fichier quotidien", () => {
  const daily = parseEcbDailyXml(ECB_XML);
  assert.equal(daily.date, "2026-07-24");
  assert.deepEqual(daily.rates, [
    { currency: "USD", rate: 1.1377 },
    { currency: "JPY", rate: 171.35 },
    { currency: "GBP", rate: 0.8642 },
    { currency: "CHF", rate: 0.9315 },
  ]);
});

test("BCE : les lignes prêtes à écrire portent bien l'euro EN BASE", () => {
  const rows = ecbRowsFor(parseEcbDailyXml(ECB_XML), "2026-07-24T18:00:00.000Z");
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0], {
    base_currency: "EUR", quote_currency: "USD", rate: 1.1377,
    rate_date: "2026-07-24", source: "ECB", fetched_at: "2026-07-24T18:00:00.000Z",
  });
});

test("BCE : un fichier douteux ne produit RIEN plutôt qu'un taux inventé", () => {
  assert.equal(parseEcbDailyXml(""), null);
  assert.equal(parseEcbDailyXml("<Cube time='2026-07-24'></Cube>"), null); // date sans taux
  assert.equal(parseEcbDailyXml("<Cube currency='USD' rate='1.1377'/>"), null); // taux sans date
  // Taux nul, négatif ou illisible : écarté ligne à ligne, le reste du fichier reste exploitable.
  const partial = parseEcbDailyXml(`<Cube time='2026-07-24'>
    <Cube currency='USD' rate='0'/>
    <Cube currency='XXX' rate='-2'/>
    <Cube currency='GBP' rate='abc'/>
    <Cube currency='CHF' rate='0.9315'/>
  </Cube>`);
  assert.deepEqual(partial.rates, [{ currency: "CHF", rate: 0.9315 }]);
});

test("BCE : un « EUR » présent dans la liste est ignoré (il est la base, pas une cotation)", () => {
  const daily = parseEcbDailyXml(`<Cube time='2026-07-24'>
    <Cube currency='EUR' rate='0.98'/>
    <Cube currency='USD' rate='1.1377'/>
  </Cube>`);
  assert.deepEqual(daily.rates, [{ currency: "USD", rate: 1.1377 }]);
});

test("la Fonction Edge lit EXACTEMENT comme l'application", () => {
  // La fonction Deno embarque sa propre copie du lecteur (elle ne peut pas importer lib/).
  // Ce test est le verrou : toute divergence entre les deux le fait échouer.
  for (const xml of [ECB_XML, "", "<Cube time='2026-07-24'></Cube>", `<Cube time='2026-07-24'><Cube currency='EUR' rate='0.98'/><Cube currency="USD" rate="1.1377"/></Cube>`]) {
    assert.deepEqual(parseEcbDailyXmlEdge(xml), parseEcbDailyXml(xml), `divergence sur : ${xml.slice(0, 40)}`);
  }
  const stamp = "2026-07-24T18:00:00.000Z";
  assert.deepEqual(ecbRowsForEdge(parseEcbDailyXmlEdge(ECB_XML), stamp), ecbRowsFor(parseEcbDailyXml(ECB_XML), stamp));
});

test("les devises écartées sont RAPPORTÉES, pas passées sous silence", () => {
  const xml = `<Cube time='2026-07-24'><Cube currency='USD' rate='1.1377'/><Cube currency='ZWL' rate='0'/></Cube>`;
  const daily = parseEcbDailyXmlEdge(xml);
  assert.deepEqual(rejectedCurrencies(xml, daily.rates), ["ZWL"]);
});

// ==========================================================================================
// Sens de la conversion
// ==========================================================================================

test("EUR → EUR vaut toujours 1, sans aucun taux enregistré", () => {
  const conversion = getLatestFxRate("EUR", "EUR", [], { asOf: FRIDAY });
  assert.equal(conversion.rate, 1);
  assert.equal(conversion.stale, false);
  assert.deepEqual(conversion.legs, []);
  assert.equal(convertAmount(1234.56, "EUR", "EUR", []), 1234.56);
});

test("USD → EUR DIVISE par le taux BCE : 63 818 $ / 1,1377 ≈ 56 093,87 €", () => {
  // Le cas exact du cahier des charges : Alphabet, 200 titres à 319,09 $US.
  const marketValueUsd = 200 * 319.09;
  assert.equal(Math.round(marketValueUsd * 100) / 100, 63818);
  const eur = convertAmount(marketValueUsd, "USD", "EUR", ROWS, { asOf: FRIDAY });
  assert.equal(Math.round(eur * 100) / 100, 56093.87);
  // La faute symétrique — multiplier — donnerait 72 604 € : +29 %, et rien à l'écran ne le dirait.
  assert.notEqual(Math.round(marketValueUsd * 1.1377 * 100) / 100, 56093.87);
});

test("GBP → EUR et CHF → EUR divisent aussi", () => {
  assert.equal(Math.round(convertAmount(1000, "GBP", "EUR", ROWS, { asOf: FRIDAY }) * 100) / 100, 1157.14);
  assert.equal(Math.round(convertAmount(1000, "CHF", "EUR", ROWS, { asOf: FRIDAY }) * 100) / 100, 1073.54);
});

test("EUR → USD multiplie (sens inverse, une seule fois)", () => {
  assert.equal(Math.round(convertAmount(100, "EUR", "USD", ROWS, { asOf: FRIDAY }) * 100) / 100, 113.77);
});

test("croisement USD → GBP : une seule composition, jamais deux inversions", () => {
  const conversion = getLatestFxRate("USD", "GBP", ROWS, { asOf: FRIDAY });
  // 0,8642 / 1,1377 — et surtout PAS (1/1,1377) × (1/0,8642).
  assert.equal(conversion.rate, 0.8642 / 1.1377);
  assert.equal(Math.round(conversion.rate * 1e6) / 1e6, 0.759603);
  assert.equal(conversion.legs.length, 2);
});

test("aller-retour : convertir puis reconvertir redonne le montant de départ", () => {
  // Preuve qu'aucune inversion parasite ne s'est glissée dans la chaîne.
  const eur = convertAmount(63818, "USD", "EUR", ROWS, { asOf: FRIDAY });
  const back = convertAmount(eur, "EUR", "USD", ROWS, { asOf: FRIDAY });
  assert.ok(Math.abs(back - 63818) < 1e-9, `retour à ${back}`);
});

test("aucun arrondi intermédiaire : la précision n'est perdue qu'à l'affichage", () => {
  const conversion = getLatestFxRate("USD", "EUR", ROWS, { asOf: FRIDAY });
  assert.equal(conversion.rate, 1 / 1.1377);
  const exact = 63818 / 1.1377;
  assert.equal(convertCurrency(63818, conversion.rate), exact);
  // 56093.875 40… : la deuxième décimale n'apparaît qu'au formatage.
  assert.ok(String(exact).length > 10);
});

test("un taux absurde n'est jamais appliqué", () => {
  assert.equal(convertCurrency(100, 0), null);
  assert.equal(convertCurrency(100, -1), null);
  assert.equal(convertCurrency(Number.NaN, 1.1), null);
  assert.equal(getLatestFxRate("ZZ", "EUR", ROWS), null);
  assert.equal(getLatestFxRate("USD", "", ROWS), null);
});

// ==========================================================================================
// Règle de repli
// ==========================================================================================

test("week-end : le samedi et le dimanche utilisent le taux du vendredi", () => {
  for (const day of ["2026-07-25", "2026-07-26"]) { // samedi, dimanche
    const conversion = getLatestFxRate("USD", "EUR", ROWS, { asOf: day });
    assert.equal(conversion.rateDate, FRIDAY);
    assert.equal(conversion.stale, false, "un taux de vendredi n'est pas « périmé » le dimanche");
  }
});

test("jour férié : le dernier taux antérieur est retenu, jamais un taux postérieur", () => {
  const rows = [rate("USD", 1.1377, "2026-05-07"), rate("USD", 1.15, "2026-05-11")];
  const conversion = getLatestFxRate("USD", "EUR", rows, { asOf: "2026-05-08" }); // 8 mai, férié
  assert.equal(conversion.rateDate, "2026-05-07");
  assert.equal(conversion.rate, 1 / 1.1377);
});

test("le taux du jour exact n'est PAS exigé : une position n'est jamais exclue pour cela", () => {
  const rows = [rate("USD", 1.1377, FRIDAY)];
  const conversion = getLatestFxRate("USD", "EUR", rows, { asOf: "2026-07-28" });
  assert.ok(conversion, "un taux de quatre jours doit rester utilisé");
  assert.equal(conversion.ageDays, 4);
  assert.equal(conversion.stale, false);
});

test("au-delà de sept jours : on convertit QUAND MÊME, mais on l'affiche", () => {
  const rows = [rate("USD", 1.1377, FRIDAY)];
  const fresh = getLatestFxRate("USD", "EUR", rows, { asOf: "2026-07-31" }); // 7 jours
  assert.equal(fresh.ageDays, MAX_FRESH_DAYS);
  assert.equal(fresh.stale, false);
  assert.equal(staleRateNotice(fresh), null);

  const old = getLatestFxRate("USD", "EUR", rows, { asOf: "2026-08-14" }); // 21 jours
  assert.equal(old.stale, true);
  assert.equal(old.rate, 1 / 1.1377, "un taux ancien reste appliqué : il vaut mieux que rien");
  assert.equal(staleRateNotice(old), "Taux du 24/07");
  assert.equal(shortRateDate(FRIDAY), "24/07");
});

test("aucun taux JAMAIS enregistré : là, et seulement là, la conversion est indisponible", () => {
  assert.equal(getLatestFxRate("USD", "EUR", [], { asOf: FRIDAY }), null);
  assert.equal(convertAmount(63818, "USD", "EUR", [], { asOf: FRIDAY }), null);
  assert.equal(staleRateNotice(null), null);
});

test("une paire composée retient la fraîcheur du taux le PLUS ANCIEN", () => {
  const rows = [rate("USD", 1.1377, FRIDAY), rate("GBP", 0.8642, "2026-06-01")];
  const conversion = getLatestFxRate("USD", "GBP", rows, { asOf: FRIDAY });
  assert.equal(conversion.rateDate, "2026-06-01");
  assert.equal(conversion.stale, true);
});

test("selectRateRow ignore les lignes d'une autre base ou d'une date postérieure", () => {
  const rows = [
    { baseCurrency: "USD", quoteCurrency: "EUR", rate: 0.879, rateDate: FRIDAY, source: "autre" },
    rate("USD", 1.15, "2026-08-01"),
    rate("USD", 1.1377, FRIDAY),
  ];
  const hit = selectRateRow(rows, "USD", FRIDAY);
  assert.equal(hit.row.rate, 1.1377);
  assert.equal(hit.row.baseCurrency, "EUR");
  assert.equal(hit.approximated, false);
});

// ==========================================================================================
// Portefeuille
// ==========================================================================================

test("plusieurs positions partagent UN SEUL taux par devise", () => {
  const map = getPortfolioFxRates(["USD", "usd", "USD", "GBP", null, "EUR"], "EUR", ROWS, { asOf: FRIDAY });
  assert.deepEqual([...map.keys()], ["USD", "GBP", "EUR"]);
  assert.equal(map.get("USD").rate, 1 / 1.1377);
  assert.equal(map.get("EUR").rate, 1);
  // Toutes les lignes en dollars pointent sur le MÊME objet de conversion : impossible qu'elles
  // divergent d'une position à l'autre.
  assert.equal(map.get("USD").rateDate, FRIDAY);
});

/** Six positions américaines de la capture, plus une ligne en euros. */
const US_POSITIONS = [
  { isin: "US02079K1079", name: "Alphabet C", qty: 200, cost: 106.8, price: 319.09 },
  { isin: "US0231351067", name: "Amazon.com", qty: 120, cost: 157.74, price: 232.11 },
  { isin: "US0378331005", name: "Apple", qty: 55, cost: 198.07, price: 333.02 },
  { isin: "US19260Q1076", name: "Coinbase Global A", qty: 130, cost: 235.33, price: 158.29 },
  { isin: "US5949181045", name: "Microsoft", qty: 81, cost: 236.57, price: 381.7 },
  { isin: "US90353T1007", name: "Uber Technologies", qty: 265, cost: 44.81, price: 65.94 },
];

function usPortfolio(fxRateAt) {
  const operations = US_POSITIONS.map((position, index) => ({
    id: `op-${index}`, accountId: "cto", memberId: "m", type: "achat", date: "2026-01-15",
    assetName: position.name, ticker: null, isin: position.isin,
    quantity: position.qty, unitPrice: position.cost,
    grossAmount: Math.round(position.qty * position.cost * 100) / 100,
    fees: 0, netAmount: Math.round(position.qty * position.cost * 100) / 100,
    currency: "USD", source: "test", note: null,
  }));
  const priceByKey = new Map();
  for (const position of US_POSITIONS) {
    priceByKey.set(`isin:${position.isin}`, { lastPrice: position.price, lastPriceAt: FRIDAY, assetType: "stock", name: position.name });
  }
  return computeAccountModel({ operations, priceByKey, accountType: "CTO", today: FRIDAY, referenceCurrency: "EUR", fxRateAt });
}

test("sans taux : les positions en dollars sortent du total (comportement d'avant, préservé)", () => {
  const model = usPortfolio(undefined);
  assert.equal(model.positionsValueEur, null);
  for (const position of model.positions) assert.equal(position.currentValueEur, null);
});

test("avec le taux BCE : valeur, coût, plus-value et poids sont calculés en euros", () => {
  const fxRateAt = (currency, date) => getLatestFxRate(currency, "EUR", ROWS, { asOf: date, fallbackToEarliest: true })?.rate ?? null;
  const model = usPortfolio(fxRateAt);

  // Alphabet : 200 × 319,09 = 63 818 $ → 63 818 / 1,1377 = 56 093,87 €.
  const alphabet = model.positions.find((position) => position.isin === "US02079K1079");
  assert.equal(Math.round(alphabet.currentValueEur * 100) / 100, 56093.87);
  // Le cours et le prix de revient restent EN DOLLARS : seule la valorisation est convertie.
  assert.equal(alphabet.lastPrice, 319.09);
  assert.equal(alphabet.averageCost, 106.8);
  assert.equal(alphabet.currency, "USD");

  // Coût historique : l'achat du 15/01 précède TOUS les taux collectés (le plus ancien est le
  // 23/07 à 1,1402). Le repli `fallbackToEarliest` s'applique donc — et c'est exactement la
  // situation réelle au démarrage, la collecte des taux commençant aujourd'hui.
  assert.equal(Math.round(alphabet.investedEur * 100) / 100, Math.round((200 * 106.8 / 1.1402) * 100) / 100);
  assert.equal(getLatestFxRate("USD", "EUR", ROWS, { asOf: "2026-01-15", fallbackToEarliest: true }).approximated, true);
  assert.equal(getLatestFxRate("USD", "EUR", ROWS, { asOf: "2026-01-15" }), null, "sans repli explicite, rien n'est inventé");
  assert.equal(Math.round(alphabet.gainEur * 100) / 100, Math.round((alphabet.currentValueEur - alphabet.investedEur) * 100) / 100);
  assert.ok(alphabet.gainEur > 0);

  // Toutes les positions convertibles entrent dans le total, la plus-value et les poids.
  const expectedTotal = US_POSITIONS.reduce((sum, position) => sum + position.qty * position.price, 0) / 1.1377;
  assert.ok(Math.abs(model.positionsValueEur - expectedTotal) < 0.01, `total ${model.positionsValueEur}`);
  assert.equal(model.positions.length, 6);
  assert.equal(model.positions.filter((position) => position.currentValueEur === null).length, 0);
  assert.ok(Math.abs(model.positions.reduce((sum, position) => sum + position.weightPct, 0) - 100) < 0.001);
  const weight = (alphabet.currentValueEur / model.positionsValueEur) * 100;
  assert.ok(Math.abs(alphabet.weightPct - weight) < 1e-9);

  // Plus-value totale = valeur convertie − coût converti, sans double conversion.
  assert.ok(Math.abs(model.unrealizedGainEur - (model.positionsValueEur - model.investedInAssetsEur)) < 1e-6);
});

test("le taux enregistré SUR l'opération l'emporte sur le taux de marché", () => {
  // Un achat dont le change réel est connu (exchange_rate) ne doit jamais être recalculé : c'est
  // une donnée historique. Ici 0,90 €/$ contre 0,879 au taux BCE.
  const fxRateAt = () => 1 / 1.1377;
  const operations = [{
    id: "op-1", accountId: "cto", memberId: "m", type: "achat", date: "2026-01-15",
    assetName: "Apple", ticker: null, isin: "US0378331005",
    quantity: 10, unitPrice: 100, grossAmount: 1000, fees: 0, netAmount: 1000,
    currency: "USD", exchangeRate: 0.9, source: "test", note: null,
  }];
  const model = computeAccountModel({
    operations, priceByKey: new Map([["isin:US0378331005", { lastPrice: 120, lastPriceAt: FRIDAY, assetType: "stock", name: "Apple" }]]),
    accountType: "CTO", today: FRIDAY, referenceCurrency: "EUR", fxRateAt,
  });
  assert.equal(model.positions[0].investedEur, 900, "1 000 $ × 0,90 enregistré, pas ÷ 1,1377");
});

test("la mention de bas de tableau existe et nomme la BCE", () => {
  assert.match(FX_FOOTNOTE, /BCE/);
  assert.match(FX_FOOTNOTE, /devises étrangères/);
});
