// Tests du VOTE entre relectures (lib/document-extraction/consensus.ts) — partie pure.
//
// Ce que ce module doit garantir, et que ces tests verrouillent :
//   1) une cellule lue différemment d'une relecture à l'autre n'est JAMAIS validée en silence ;
//   2) la valeur majoritaire est proposée, mais la ligne est marquée « à vérifier » ;
//   3) l'unanimité, et elle seule, vaut confiance haute ;
//   4) les lignes sont rapprochées par ISIN — leur ordre peut changer d'une relecture à l'autre.
// Contexte mesuré : une passe unique se trompe sur ~6 cellules chiffrées sur 30 en annonçant
// 0,90 à 0,98 de confiance ; 3 relectures ne laissent passer aucune erreur unanime.

import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcilePositionPasses } from "../lib/document-extraction/consensus.ts";

// Colonnes : Libellé, ISIN, Ticker, Quantité, PRU, Cours, Devise, Valorisation, Var, +/-, +/-%, Poids
const line = (name, isin, quantity, pru, cours, valo) =>
  [name, isin, "", String(quantity), String(pru), String(cours), "EUR", String(valo), "", "", "", ""];

const meta = (warnings = []) => ({ confidence: 0.95, band: "high", page: 1, sourceText: null, warnings, lastMovementDate: null });
const pass = (rows) => ({ rows, meta: rows.map(() => meta()) });

test("consensus : trois relectures d'accord → confiance haute, aucun avertissement de divergence", () => {
  const rows = [line("SANOFI", "FR0000120578", 360, 87.83, 76.36, 27489.6)];
  const result = reconcilePositionPasses([pass(rows), pass(rows), pass(rows)]);
  assert.equal(result.passes, 3);
  assert.equal(result.meta[0].band, "high");
  assert.equal(result.consensus[0].disputed.length, 0);
  assert.equal(result.meta[0].warnings.length, 0);
  assert.equal(result.rows[0][3], "360");
});

test("consensus : une quantité lue 100 au lieu de 1000 est SIGNALÉE, jamais avalée", () => {
  // Cas réel observé : « 1 000 » lu « 100 » par une relecture sur trois.
  const good = line("ISHARES DIVERSIFIED COMMODITY", "DE000A0H0728", 1000, 26.6, 34.98, 34980);
  const bad = line("ISHARES DIVERSIFIED COMMODITY", "DE000A0H0728", 100, 26.6, 34.98, 3498);
  const result = reconcilePositionPasses([pass([bad]), pass([good]), pass([good])]);

  // La majorité l'emporte pour la valeur PROPOSÉE…
  assert.equal(result.rows[0][3], "1000");
  assert.equal(result.rows[0][7], "34980");
  // …mais la ligne n'est surtout pas présentée comme fiable.
  assert.deepEqual(result.consensus[0].disputed, ["Quantité", "Valorisation"]);
  assert.notEqual(result.meta[0].band, "high");
  assert.ok(result.meta[0].warnings.some((warning) => warning.includes("Quantité") && warning.includes("100")));
});

test("consensus : la valeur majoritaire est proposée même quand la minorité est unique", () => {
  const a = line("SANOFI", "FR0000120578", 360, 87.83, 76.36, 27489.6);
  const b = line("SANOFI", "FR0000120578", 360, 83.78, 76.36, 27489.6); // PRU aux chiffres inversés
  const result = reconcilePositionPasses([pass([a]), pass([b]), pass([a])]);
  assert.equal(result.rows[0][4], "87.83");
  assert.deepEqual(result.consensus[0].disputed, ["PRU"]);
});

test("consensus : « 34980 », « 34980.0 » et « 34980.00 » sont la MÊME valeur", () => {
  const rows = (valo) => [line("X", "FR0000120578", 10, 1, 2, valo)];
  const result = reconcilePositionPasses([pass(rows("34980")), pass(rows("34980.0")), pass(rows("34980.00"))]);
  assert.equal(result.consensus[0].disputed.length, 0, "un écart d'écriture n'est pas un désaccord");
  assert.equal(result.meta[0].band, "high");
});

test("consensus : lignes rapprochées par ISIN, quel que soit leur ordre", () => {
  const sanofi = line("SANOFI", "FR0000120578", 360, 87.83, 76.36, 27489.6);
  const amundi = line("AMUNDI PEA EMERGENT", "FR0013412020", 103, 31.08, 34.78, 3581.82);
  const result = reconcilePositionPasses([pass([sanofi, amundi]), pass([amundi, sanofi]), pass([sanofi, amundi])]);
  assert.equal(result.rows.length, 2);
  for (const entry of result.consensus) assert.equal(entry.disputed.length, 0);
});

test("consensus : une ligne vue par une seule relecture est signalée, pas supprimée", () => {
  const sanofi = line("SANOFI", "FR0000120578", 360, 87.83, 76.36, 27489.6);
  const orpheline = line("LIGNE INCERTAINE", "FR0013412020", 103, 31.08, 34.78, 3581.82);
  const result = reconcilePositionPasses([pass([sanofi, orpheline]), pass([sanofi]), pass([sanofi])]);
  assert.equal(result.rows.length, 2, "la ligne douteuse reste visible et corrigeable");
  const orphan = result.consensus[1];
  assert.equal(orphan.seenBy, 1);
  assert.notEqual(result.meta[1].band, "high");
  assert.ok(result.meta[1].warnings.some((warning) => warning.includes("absente de")));
});

test("consensus : une seule relecture exploitable ne prétend PAS à un consensus", () => {
  const rows = [line("SANOFI", "FR0000120578", 360, 87.83, 76.36, 27489.6)];
  const result = reconcilePositionPasses([pass(rows)]);
  assert.equal(result.passes, 1);
  assert.equal(result.rows.length, 1);
  assert.equal(result.consensus[0].agreement, 0, "aucun accord mesurable avec une seule lecture");
});

test("consensus : aucune relecture exploitable → résultat vide, pas une exception", () => {
  const result = reconcilePositionPasses([{ rows: [], meta: [] }]);
  assert.equal(result.passes, 0);
  assert.deepEqual(result.rows, []);
});

test("consensus : les avertissements de chaque relecture sont conservés, sans doublon", () => {
  const rows = [line("SANOFI", "FR0000120578", 360, 87.83, 76.36, 27489.6)];
  const withWarning = { rows, meta: [meta(["ISIN invalide (clé de contrôle)."])] };
  const result = reconcilePositionPasses([withWarning, withWarning, pass(rows)]);
  assert.equal(result.meta[0].warnings.filter((w) => w.includes("ISIN invalide")).length, 1);
});
