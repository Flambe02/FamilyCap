// Garde-fou de l'analyse IA (lib/portfolio-insights.ts).
//
// Point d'acceptation n° 13 : l'analyse ne peut citer QUE les métriques fournies. Ces tests
// vérifient le refus, pas la génération — c'est le refus qui protège l'utilisateur.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allowedNumbers, buildAnalysisPrompt, coverageLabel, deterministicObservations, extractNumbers,
  factsHash, validateObservations, DISCLAIMER,
} from "../lib/portfolio-insights.ts";

const facts = (over = {}) => ({
  generatedAt: "2026-07-27T10:00:00.000Z",
  accountType: "CTO",
  accountLabel: "Compte-titres Boursorama Banque",
  referenceCurrency: "EUR",
  totalValueEur: 742100,
  positionsValueEur: 742100,
  cashEur: 0,
  netInvestedEur: 0,
  positionsCount: 21,
  performance: {
    unrealizedGainEur: 219573, unrealizedGainPct: 29.6, realizedGainEur: 0, dividendsNetEur: 0,
    feesEur: 0, totalReturnEur: 219573, totalReturnPct: 29.6, annualizedPct: 7.4, twrPct: null,
    xirrPct: null, isReliable: true, unreliableReason: null,
  },
  coverage: {
    pricedPositions: 21, totalPositions: 21, pricePercent: 100, geographyPercent: 100,
    sectorPercent: 90, dividendPercent: 80, costBasisPercent: 100, sufficient: true,
  },
  concentration: { top1Pct: 18, top3Pct: 41, top5Pct: 55 },
  best: [{ name: "Air Liquide", gainPct: 42.8, gainEur: 28416, valueEur: 94800 }],
  worst: [{ name: "WEX", gainPct: -40.2, gainEur: -9842, valueEur: 14630 }],
  geography: [{ label: "France", pct: 58, isEstimated: true }, { label: "États-Unis", pct: 22, isEstimated: true }],
  sectors: [{ label: "Services financiers", pct: 27, isEstimated: false }],
  dividends: {
    receivedThisYearEur: 3214, expected12mEur: 9842, portfolioYieldPct: 1.02,
    topContributorName: "Sodexo", topContributorPct: 38, monthsWithoutIncome: 7, hasRealOperations: true,
  },
  benchmark: null,
  anomalies: [],
  ...over,
});

const observation = (over = {}) => ({ tone: "risk", title: "Concentration", body: "58 % du portefeuille est exposé à France.", metric: "58 %", ...over });

test("une observation citant un chiffre présent dans les données est acceptée", () => {
  const result = validateObservations([observation()], facts());
  assert.equal(result.accepted.length, 1);
  assert.equal(result.rejected.length, 0);
});

// ---- 13. Un chiffre inventé est refusé ------------------------------------------------------
test("une observation citant un chiffre ABSENT des données est rejetée", () => {
  const result = validateObservations([observation({ body: "73 % du portefeuille est exposé à France." })], facts());
  assert.equal(result.accepted.length, 0);
  assert.match(result.rejected[0].reason, /chiffre absent/);
});

test("un montant inventé est rejeté même s'il est plausible", () => {
  const result = validateObservations(
    [observation({ tone: "positive", title: "Plus-value", body: "La plus-value latente atteint 231 400 EUR." })],
    facts(),
  );
  assert.equal(result.accepted.length, 0);
});

test("un arrondi raisonnable du chiffre source est accepté", () => {
  // 29,6 % est la valeur exacte ; « 30 % » reste dans la tolérance d'arrondi.
  const result = validateObservations(
    [observation({ tone: "positive", title: "Performance", body: "La performance totale est de 29,6 %." })],
    facts(),
  );
  assert.equal(result.accepted.length, 1);
});

test("une valeur absolue est acceptée pour un chiffre négatif", () => {
  const result = validateObservations(
    [observation({ body: "WEX recule de 40,2 %, la plus forte baisse du compte." })],
    facts(),
  );
  assert.equal(result.accepted.length, 1);
});

// ---- Formulations interdites -----------------------------------------------------------------
test("un ordre d'achat ou de vente est rejeté", () => {
  for (const body of [
    "58 % en France : vendez une partie de vos actions françaises.",
    "Il faudrait alléger la ligne à 58 % du portefeuille.",
    "Renforcez la poche internationale, aujourd'hui à 22 %.",
  ]) {
    const result = validateObservations([observation({ body })], facts());
    assert.equal(result.accepted.length, 0, `non rejeté : ${body}`);
    assert.match(result.rejected[0].reason, /ordre d'achat/);
  }
});

test("une promesse de performance est rejetée", () => {
  const result = validateObservations(
    [observation({ body: "Avec 58 % en France, le compte va progresser l'an prochain." })],
    facts(),
  );
  assert.equal(result.accepted.length, 0);
  assert.match(result.rejected[0].reason, /promesse/);
});

test("un conseil personnalisé est rejeté", () => {
  const result = validateObservations(
    [observation({ body: "Je recommande de revoir la répartition, actuellement à 58 %." })],
    facts(),
  );
  assert.equal(result.accepted.length, 0);
});

test("un actif inventé est rejeté", () => {
  const result = validateObservations(
    [observation({ tone: "positive", title: "Bonne ligne", body: "Danone contribue pour 28 416 EUR de plus-value." })],
    facts(),
  );
  assert.equal(result.accepted.length, 0);
  assert.match(result.rejected[0].reason, /non présent/);
});

test("une observation sans aucun chiffre est rejetée", () => {
  const result = validateObservations(
    [observation({ body: "Le portefeuille semble bien diversifié." })],
    facts(),
  );
  assert.equal(result.accepted.length, 0);
  assert.match(result.rejected[0].reason, /aucun chiffre/);
});

test("au maximum trois observations sont conservées", () => {
  const many = Array.from({ length: 6 }, (_, index) => observation({ title: `Point ${index}` }));
  assert.equal(validateObservations(many, facts()).accepted.length, 3);
});

// ---- Extraction et empreinte -------------------------------------------------------------------
test("les nombres français sont correctement extraits", () => {
  assert.deepEqual(extractNumbers("58 % et 219 573 € et +29,6 %"), [58, 219573, 29.6]);
  assert.deepEqual(extractNumbers("−12,4 %"), [12.4]);
});

test("l'ensemble autorisé contient les valeurs des données et leurs arrondis", () => {
  const allowed = allowedNumbers(facts());
  assert.ok(allowed.has(219573));
  assert.ok(allowed.has(29.6));
  assert.ok(allowed.has(58));
  assert.ok(allowed.has(9842)); // valeur absolue d'un chiffre négatif
  assert.ok(!allowed.has(999999));
});

test("l'empreinte ignore l'horodatage mais change avec les chiffres", () => {
  const a = facts();
  const b = facts({ generatedAt: "2027-01-01T00:00:00.000Z" });
  assert.equal(factsHash(a), factsHash(b));
  assert.notEqual(factsHash(a), factsHash(facts({ totalValueEur: 742101 })));
});

// ---- Couverture insuffisante ---------------------------------------------------------------------
test("une couverture insuffisante produit une observation qui le DIT, sans conclure", () => {
  const incomplete = facts({
    coverage: { pricedPositions: 4, totalPositions: 5, pricePercent: 80, geographyPercent: 60, sectorPercent: 60, dividendPercent: 40, costBasisPercent: 100, sufficient: false },
  });
  const observations = deterministicObservations(incomplete);
  assert.equal(observations[0].tone, "risk");
  assert.match(observations[0].body, /4 position\(s\) sur 5/);
  assert.match(coverageLabel(incomplete), /Couverture partielle : 4\/5/);
});

test("l'analyse déterministe ne cite que des chiffres valides et passe son propre garde-fou", () => {
  const source = facts();
  const result = validateObservations(deterministicObservations(source), source);
  assert.equal(result.rejected.length, 0, JSON.stringify(result.rejected));
  assert.ok(result.accepted.length > 0);
});

test("des flux non fiables produisent une action pédagogique à vérifier, pas un conseil", () => {
  const unreliable = facts({
    netInvestedEur: 0,
    cashEur: -59520,
    performance: { ...facts().performance, isReliable: false, unreliableReason: "Aucun versement n'est enregistré." },
  });
  const observations = deterministicObservations(unreliable);
  assert.ok(observations.some((item) => item.tone === "action" && /versements/i.test(item.body)));
  assert.equal(validateObservations(observations, unreliable).rejected.length, 0);
});

// ---- Consigne envoyée au modèle -------------------------------------------------------------------
test("la consigne contient les données ET les interdictions, mais aucune opération brute", () => {
  const prompt = buildAnalysisPrompt(facts());
  assert.match(prompt, /Tu ne peux citer QUE des chiffres présents/);
  assert.match(prompt, /Aucun ordre d'achat ou de vente/);
  assert.match(prompt, /Maximum 3 observations/);
  assert.match(prompt, /"totalValueEur": 742100/);
  // Aucune opération, aucun identifiant de ligne : le modèle ne voit que des agrégats.
  assert.equal(/account_operations|operation_date|"quantity"/.test(prompt), false);
});

test("l'avertissement pédagogique est constant", () => {
  assert.equal(DISCLAIMER, "Information pédagogique, pas un conseil financier.");
});
