// NON-RÉGRESSION — capture Boursobank « PEA LAMBERT » (fixture de référence).
//
// Ce fichier vérifie le parcours de lecture, de bout en bout et sans réseau :
//   sortie du modèle → contrat Zod strict → relevé canonique → contrôles comptables.
//
// Il porte les garanties exigées par le cahier des charges : 5 positions, titres 177 397,25 €,
// espèces 21,09 €, total 177 418,34 €, plus-value 28 022,63 €, aucun ISIN erroné, aucune quantité
// erronée, aucun signe négatif perdu. Et il vérifie surtout que les contrôles DÉTECTENT ces
// erreurs quand on les introduit volontairement : un contrôle qu'on ne voit jamais échouer ne
// prouve rien.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseModelStatement, toStatement, runAccountingChecks, summarizeChecks, costBasisOf,
  reconcileHeaders, statementPositionRows, statementFromConsensus,
} from "../lib/document-extraction/statement.ts";
import { detectBroker, normalizeMarker, brokerPromptHints } from "../lib/document-extraction/brokers.ts";
import { reconcilePositionPasses } from "../lib/document-extraction/consensus.ts";
import { isValidIsin } from "../lib/investment-import.ts";
import {
  RAW_STRICT, RAW_TEXTUAL, EXPECTED_HEADER, EXPECTED_POSITIONS, DETECTED_MARKERS,
} from "./fixtures/boursobank-capture.mjs";

const options = { accountCurrency: "EUR" };

function read(raw) {
  const verdict = parseModelStatement(raw);
  const statement = toStatement(verdict.data, options);
  const checks = runAccountingChecks(statement);
  return { verdict, statement, checks, summary: summarizeChecks(checks) };
}

// ==========================================================================================
// Reconnaissance du courtier — par les LIBELLÉS, jamais par la couleur ni le logo
// ==========================================================================================

test("courtier : les intitulés de la capture identifient Boursobank", () => {
  const detection = detectBroker({ markers: DETECTED_MARKERS, institution: "Boursobank" });
  assert.equal(detection.broker, "boursobank");
  assert.ok(detection.score >= 8, `score attendu ≥ 8, obtenu ${detection.score}`);
  for (const marker of ["total portefeuille", "solde especes disponible", "evaluation titres", "montant +/- values latentes", "gestion libre", "px revient", "+/- latentes", "dernier mvt"]) {
    assert.ok(detection.matched.includes(marker), `marqueur manquant : ${marker}`);
  }
});

test("courtier : reconnu SANS le nom de l'établissement (capture recadrée)", () => {
  // Le nom « Boursobank » peut être hors champ : les seuls intitulés du tableau doivent suffire.
  const detection = detectBroker({ markers: DETECTED_MARKERS.filter((m) => !/bourso/i.test(m)), institution: null });
  assert.equal(detection.broker, "boursobank");
  assert.equal(detection.nameConfirms, false);
});

test("courtier : les libellés génériques seuls ne suffisent JAMAIS", () => {
  // « Cours », « Montant », « Quantité », « Valeur » existent sur tous les relevés du monde :
  // s'y fier reconnaîtrait Boursobank sur n'importe quelle capture.
  const detection = detectBroker({ markers: ["Valeur", "Quantité", "Cours", "Montant", "Notification"] });
  assert.equal(detection.broker, "unknown");
  assert.ok(detection.score < 8);
});

test("courtier : un relevé d'un autre établissement n'est pas reconnu comme Boursobank", () => {
  const detection = detectBroker({
    markers: ["Libellé valeur", "Quantité", "Cours de revient", "Valorisation", "Plus ou moins-value"],
    institution: "Crédit Agricole",
  });
  assert.equal(detection.broker, "unknown");
});

test("courtier : la normalisation des libellés ignore accents, casse et ponctuation", () => {
  assert.equal(normalizeMarker("Évaluation titres"), "evaluation titres");
  assert.equal(normalizeMarker("Px. Revient"), "px revient");
  assert.equal(normalizeMarker("Dernier Mvt"), "dernier mvt");
  assert.equal(normalizeMarker("+/- Latentes"), "+/- latentes");
});

test("prompt : les consignes Boursobank couvrent les pièges de structure du tableau", () => {
  const hints = brokerPromptHints("boursobank");
  for (const expected of [
    "ISIN",             // nom et ISIN dans la même colonne
    "variation du jour", // à ne pas confondre avec la performance latente
    "+/- Latentes",      // montant
    "+/- %",             // pourcentage
    "Dernier Mvt",       // date du dernier mouvement, pas d'achat
    "BOUTONS",           // pastilles A / V
    "Notification",      // icônes ignorées
    "Ma performance",    // bandeau : pas des positions
  ]) {
    assert.ok(hints.includes(expected), `consigne manquante : ${expected}`);
  }
});

// ==========================================================================================
// Contrat Zod strict
// ==========================================================================================

test("schéma : la sortie conforme est acceptée telle quelle", () => {
  const verdict = parseModelStatement(RAW_STRICT);
  assert.equal(verdict.strict, true);
  assert.deepEqual(verdict.issues, []);
});

test("schéma : une clé inventée par le modèle est SIGNALÉE, la lecture est récupérée", () => {
  // Une clé en trop est souvent le symptôme d'une valeur en trop : on ne l'absorbe pas en silence.
  const polluted = {
    ...RAW_STRICT,
    document: { ...RAW_STRICT.document, commentaire_du_modele: "portefeuille bien diversifié" },
    total_estime: 177418.34,
  };
  const verdict = parseModelStatement(polluted);
  assert.equal(verdict.strict, false);
  assert.ok(verdict.issues.length > 0);
  // …mais les 5 positions restent exploitables.
  const statement = toStatement(verdict.data, options);
  assert.equal(statement.positions.length, 5);
  assert.equal(statement.header.totalPortfolio, 177418.34);
});

test("schéma : une valeur nue (sans {value, confidence}) est récupérée avec une confiance prudente", () => {
  const bare = {
    document: { ...RAW_STRICT.document, available_cash: 21.09 },
    positions: RAW_STRICT.positions,
  };
  const verdict = parseModelStatement(bare);
  assert.equal(verdict.strict, false);
  const statement = toStatement(verdict.data, options);
  assert.equal(statement.header.availableCash, 21.09);
});

// ==========================================================================================
// Relevé canonique — la capture de référence
// ==========================================================================================

for (const [label, raw] of [["JSON strict", RAW_STRICT], ["cellules recopiées telles qu'affichées", RAW_TEXTUAL]]) {
  test(`capture de référence (${label}) : en-tête exact`, () => {
    const { statement } = read(raw);
    const header = statement.header;
    assert.equal(header.broker, EXPECTED_HEADER.broker);
    assert.equal(header.accountType, EXPECTED_HEADER.accountType);
    assert.equal(header.accountName, EXPECTED_HEADER.accountName);
    assert.equal(header.snapshotDate, EXPECTED_HEADER.snapshotDate);
    assert.equal(header.openingDate, EXPECTED_HEADER.openingDate);
    assert.equal(header.managementMode, EXPECTED_HEADER.managementMode);
    assert.equal(header.totalPortfolio, EXPECTED_HEADER.totalPortfolio);
    assert.equal(header.availableCash, EXPECTED_HEADER.availableCash);
    assert.equal(header.securitiesValue, EXPECTED_HEADER.securitiesValue);
    assert.equal(header.unrealizedGain, EXPECTED_HEADER.unrealizedGain);
    assert.equal(header.unrealizedGainPercent, EXPECTED_HEADER.unrealizedGainPercent);
    assert.equal(header.depositCeiling, EXPECTED_HEADER.depositCeiling);
    assert.equal(header.cumulativeDeposits, EXPECTED_HEADER.cumulativeDeposits);
    assert.equal(header.currency, EXPECTED_HEADER.currency);
  });

  test(`capture de référence (${label}) : les 5 positions, au centime`, () => {
    const { statement } = read(raw);
    assert.equal(statement.positions.length, 5);
    statement.positions.forEach((position, index) => {
      const expected = EXPECTED_POSITIONS[index];
      assert.equal(position.name, expected.name, `nom ligne ${index + 1}`);
      assert.equal(position.isin, expected.isin, `ISIN ligne ${index + 1}`);
      assert.equal(position.quantity, expected.quantity, `quantité ligne ${index + 1}`);
      assert.equal(position.averageCostDisplayed, expected.averageCostDisplayed, `px revient ligne ${index + 1}`);
      assert.equal(position.currentPrice, expected.currentPrice, `cours ligne ${index + 1}`);
      assert.equal(position.dailyChangePercent, expected.dailyChangePercent, `var. veille ligne ${index + 1}`);
      assert.equal(position.marketValue, expected.marketValue, `valorisation ligne ${index + 1}`);
      assert.equal(position.unrealizedGain, expected.unrealizedGain, `+/- value ligne ${index + 1}`);
      assert.equal(position.unrealizedGainPercent, expected.unrealizedGainPercent, `+/- % ligne ${index + 1}`);
      assert.equal(position.lastMovementDate, expected.lastMovementDate, `dernier mvt ligne ${index + 1}`);
    });
  });
}

test("le numéro de compte n'est JAMAIS restitué en clair", () => {
  const { statement } = read(RAW_STRICT);
  assert.equal(statement.header.accountNumberMasked, "•••• 1306");
  const serialized = JSON.stringify(statement);
  assert.ok(!serialized.includes("00088051306"), "le numéro complet ne doit apparaître nulle part");
});

test("aucun ISIN erroné : format et clé de contrôle valides sur les 5 lignes", () => {
  const { statement } = read(RAW_STRICT);
  for (const position of statement.positions) {
    assert.ok(isValidIsin(position.isin), `ISIN invalide : ${position.isin}`);
  }
});

test("aucune quantité erronée : les milliers survivent à la lecture", () => {
  const { statement } = read(RAW_TEXTUAL);
  assert.deepEqual(statement.positions.map((position) => position.quantity), [317, 1000, 5000, 360, 103]);
});

test("aucun signe négatif perdu", () => {
  const { statement } = read(RAW_TEXTUAL);
  const sanofi = statement.positions.find((position) => position.isin === "FR0000120578");
  assert.equal(sanofi.unrealizedGain, -4247.89);
  assert.equal(sanofi.unrealizedGainPercent, -13.42);
  assert.equal(sanofi.dailyChangePercent, -0.43);
  assert.equal(statement.positions.find((p) => p.isin === "DE000A0H0728").dailyChangePercent, -1.21);
  assert.equal(statement.positions.find((p) => p.isin === "FR0013412020").dailyChangePercent, -0.4);
});

// ==========================================================================================
// Prix de revient arrondi → coût historique EXACT
// ==========================================================================================

test("coût historique : valorisation − plus-value, jamais quantité × prix de revient affiché", () => {
  const { statement } = read(RAW_STRICT);
  const expected = {
    IE00B53L3W79: 63241.0,
    DE000A0H0728: 26600.0,
    IE0002XZSHO1: 24714.0,
    FR0000120578: 31618.69,
    FR0013412020: 3200.93,
  };
  for (const position of statement.positions) {
    assert.equal(position.costBasis, expected[position.isin], `coût historique ${position.isin}`);
    assert.equal(position.costBasisSource, "gain");
  }
  // La démonstration du problème : le prix de revient AFFICHÉ est arrondi. Sur SANOFI il donne
  // 31 618,80 € au lieu de 31 618,69 €, et sur AMUNDI 3 201,24 € au lieu de 3 200,93 €.
  const sanofi = statement.positions.find((position) => position.isin === "FR0000120578");
  assert.equal(Math.round(sanofi.quantity * sanofi.averageCostDisplayed * 100) / 100, 31618.8);
  assert.notEqual(sanofi.costBasis, 31618.8);
});

test("coût historique : repli sur le prix de revient affiché SEULEMENT si la +/- value manque, et signalé", () => {
  const withoutGain = costBasisOf({ marketValue: 27370.8, unrealizedGain: null, quantity: 360, averageCostDisplayed: 87.83 });
  assert.equal(withoutGain.costBasis, 31618.8);
  assert.equal(withoutGain.source, "average_cost");
  const nothing = costBasisOf({ marketValue: null, unrealizedGain: null, quantity: null, averageCostDisplayed: null });
  assert.equal(nothing.costBasis, null);
  assert.equal(nothing.source, null);
});

// ==========================================================================================
// Contrôles comptables
// ==========================================================================================

test("les trois contrôles exigés tombent EXACTEMENT juste", () => {
  const { statement, checks, summary } = read(RAW_STRICT);
  const byId = Object.fromEntries(checks.map((entry) => [entry.id, entry]));

  // 1. somme des positions = 177 397,25
  assert.equal(byId.sum_positions.actual, 177397.25);
  assert.equal(byId.sum_positions.expected, 177397.25);
  assert.equal(byId.sum_positions.delta, 0);
  assert.equal(byId.sum_positions.ok, true);

  // 2. somme des plus-values = 28 022,63
  assert.equal(byId.sum_gains.actual, 28022.63);
  assert.equal(byId.sum_gains.delta, 0);
  assert.equal(byId.sum_gains.ok, true);

  // 3. titres + espèces = 177 418,34
  assert.equal(byId.total_vs_parts.expected, 177418.34);
  assert.equal(byId.total_vs_parts.actual, 177418.34);
  assert.equal(byId.total_vs_parts.delta, 0);
  assert.equal(byId.total_vs_parts.ok, true);

  assert.equal(statement.header.availableCash, 21.09);
  assert.equal(summary.failed, 0, `contrôles en échec : ${checks.filter((c) => !c.ok).map((c) => c.id).join(", ")}`);
  assert.equal(summary.importable, true);
});

test("quantité × cours : l'écart d'arrondi du cours est TOLÉRÉ, pas signalé", () => {
  // 5 000 × 6,86 = 34 300 alors que la valorisation imprimée est 34 325 : le cours affiché est
  // arrondi à deux décimales (le vrai est 6,865). Une tolérance fixe de 2 centimes hurlerait ici.
  const { checks } = read(RAW_STRICT);
  const line3 = checks.find((entry) => entry.id === "qty_price_3");
  assert.equal(line3.expected, 34300);
  assert.equal(line3.actual, 34325);
  assert.equal(line3.ok, true, "un écart de 5 000 × 0,005 = 25 € est un arrondi de cours, pas une erreur");
  assert.ok(line3.tolerance >= 25);
  // Sur 103 parts, la tolérance ne vaut plus que ~0,54 € : elle suit la quantité.
  const line5 = checks.find((entry) => entry.id === "qty_price_5");
  assert.ok(line5.tolerance < 1);
  assert.equal(line5.ok, true);
});

test("contrôle : une ligne OUBLIÉE est détectée (le total ne tombe plus juste)", () => {
  const amputated = { ...RAW_STRICT, positions: RAW_STRICT.positions.slice(0, 4) };
  const { checks, summary } = read(amputated);
  const sum = checks.find((entry) => entry.id === "sum_positions");
  assert.equal(sum.ok, false);
  assert.equal(sum.delta, -3567.4);
  assert.equal(sum.severity, "blocking");
  assert.equal(summary.importable, false);
});

test("contrôle : un millier perdu (5 000 lu 5) est détecté", () => {
  const broken = structuredClone(RAW_STRICT);
  broken.positions[2].quantity = { value: 5, confidence: 0.97, page: 1 };
  const { checks, summary } = read(broken);
  assert.equal(summary.importable, false);
  const qtyPrice = checks.find((entry) => entry.id === "qty_price_3");
  assert.equal(qtyPrice.ok, false);
  assert.equal(qtyPrice.expected, 34.3);
  assert.equal(qtyPrice.actual, 34325);
});

test("contrôle : un signe négatif perdu est détecté par la cohérence montant/pourcentage", () => {
  const broken = structuredClone(RAW_STRICT);
  broken.positions[3].gain_amount = { value: 4247.89, confidence: 0.98, page: 1 }; // « - » perdu
  const { checks, summary } = read(broken);
  const sign = checks.find((entry) => entry.id === "gain_sign_4");
  assert.ok(sign, "le contrôle de signe doit exister");
  assert.equal(sign.ok, false);
  assert.equal(sign.severity, "blocking");
  assert.equal(summary.importable, false);
});

test("contrôle : un ISIN dont la clé est fausse est signalé, sans bloquer l'import", () => {
  const broken = structuredClone(RAW_STRICT);
  broken.positions[0].isin = { value: "IE00B53L3W78", confidence: 0.6, page: 1 };
  const { checks, summary } = read(broken);
  const isin = checks.find((entry) => entry.id === "isin_1");
  assert.equal(isin.ok, false);
  assert.equal(isin.severity, "warning");
  assert.equal(summary.importable, true, "un ISIN douteux se corrige à l'écran, il ne bloque pas");
});

test("contrôle : le total imprimé qui ne correspond pas à titres + espèces est bloquant", () => {
  const broken = structuredClone(RAW_STRICT);
  broken.document.total_portfolio = { value: 177418.99, confidence: 0.95, page: 1 };
  const { checks, summary } = read(broken);
  const total = checks.find((entry) => entry.id === "total_vs_parts");
  assert.equal(total.ok, false);
  assert.equal(Math.abs(total.delta), 0.65);
  assert.equal(summary.importable, false);
});

test("contrôle : la tolérance des sommes comptables est bien de 2 centimes", () => {
  const nearlyRight = structuredClone(RAW_STRICT);
  nearlyRight.document.total_portfolio = { value: 177418.36, confidence: 0.95, page: 1 }; // +0,02
  assert.equal(read(nearlyRight).summary.importable, true);
  const tooFar = structuredClone(RAW_STRICT);
  tooFar.document.total_portfolio = { value: 177418.37, confidence: 0.95, page: 1 }; // +0,03
  assert.equal(read(tooFar).summary.importable, false);
});

// ==========================================================================================
// Consensus de relecture — le vote porte aussi sur l'en-tête
// ==========================================================================================

test("consensus : une relecture minoritaire fausse ne l'emporte pas et la ligne est signalée", () => {
  const good = toStatement(parseModelStatement(RAW_STRICT).data, options);
  const wrong = structuredClone(RAW_STRICT);
  wrong.positions[1].quantity = { value: 100, confidence: 0.96, page: 1 }; // « 1 000 » lu « 100 »
  const misread = toStatement(parseModelStatement(wrong).data, options);

  const agreed = reconcilePositionPasses([good, misread, good].map(statementPositionRows));
  const merged = statementFromConsensus(good, agreed.rows, agreed.meta, options);
  const line = merged.positions.find((position) => position.isin === "DE000A0H0728");
  assert.equal(line.quantity, 1000, "la valeur majoritaire l'emporte");
  assert.equal(line.band, "low", "un désaccord sur une colonne décisive doit décocher la ligne");
  assert.ok(line.warnings.some((warning) => warning.includes("Quantité")), "le désaccord doit être expliqué");
});

test("consensus : l'en-tête est voté lui aussi, et les divergences sont listées", () => {
  const base = toStatement(parseModelStatement(RAW_STRICT).data, options).header;
  const drifted = { ...base, availableCash: 2109 }; // virgule perdue sur une relecture
  const vote = reconcileHeaders([base, drifted, base]);
  assert.equal(vote.header.availableCash, 21.09);
  assert.deepEqual(vote.disputed, ["availableCash"]);
});

test("consensus : une seule relecture ne prétend jamais au consensus", () => {
  const only = toStatement(parseModelStatement(RAW_STRICT).data, options);
  const agreed = reconcilePositionPasses([statementPositionRows(only)]);
  assert.equal(agreed.passes, 1);
  assert.ok(agreed.consensus.every((entry) => entry.agreement === 0));
});
