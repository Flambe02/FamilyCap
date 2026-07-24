// Tests du validateur d'extraction IA (lib/document-extraction/extract.ts) — PARTIE PURE.
// On simule la sortie brute de l'IA (aucun appel réseau) et on vérifie la conversion en
// NormalizedOp, les bandes de confiance et les CONTRÔLES DÉTERMINISTES.

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateExtraction, normalizeRawExtraction, DEFAULT_THRESHOLDS } from "../lib/document-extraction/extract.ts";

const f = (value, confidence = 0.95, page = 1) => ({ value, confidence, page });
const opts = { accountCurrency: "EUR" };

test("validateExtraction : achat bien détecté → confiance haute", () => {
  const raw = { operations: [{ date: f("2026-07-15"), type: f("buy"), isin: f("FR0000120073"), instrument_name: f("Air Liquide"), quantity: f(10), unit_price: f(176.5), fees: f(4.9), currency: f("EUR") }] };
  const { operations } = validateExtraction(raw, opts);
  assert.equal(operations.length, 1);
  assert.equal(operations[0].op.type, "achat");
  assert.equal(operations[0].op.date, "2026-07-15");
  assert.equal(operations[0].op.quantity, 10);
  assert.equal(operations[0].band, "high");
  assert.deepEqual(operations[0].warnings, []);
});

test("validateExtraction : faible confiance → bande low", () => {
  const raw = { operations: [{ date: f("2026-07-15", 0.4), type: f("achat", 0.5), quantity: f(1, 0.4), unit_price: f(10, 0.4) }] };
  const { operations } = validateExtraction(raw, opts);
  assert.equal(operations[0].band, "low");
});

test("validateExtraction : date américaine tolérée", () => {
  const raw = { operations: [{ date: f("07/15/2026"), type: f("dividend"), instrument_name: f("Apple"), net_amount: f(12) }] };
  const { operations } = validateExtraction(raw, opts);
  assert.equal(operations[0].op.date, "2026-07-15");
  assert.equal(operations[0].op.type, "dividende");
});

test("validateExtraction : date française tolérée", () => {
  const raw = { operations: [{ date: f("15/07/2026"), type: f("versement"), net_amount: f(500) }] };
  const { operations } = validateExtraction(raw, opts);
  assert.equal(operations[0].op.date, "2026-07-15");
});

test("validateExtraction : ISIN mal lu → avertissement", () => {
  const raw = { operations: [{ date: f("2026-07-15"), type: f("achat"), isin: f("FR0000120074"), quantity: f(1), unit_price: f(10) }] };
  const { operations } = validateExtraction(raw, opts);
  assert.match(operations[0].warnings.join(" "), /ISIN/);
});

test("validateExtraction : montant incohérent (qté × prix) → avertissement", () => {
  const raw = { operations: [{ date: f("2026-07-15"), type: f("achat"), instrument_name: f("X"), quantity: f(10), unit_price: f(100), gross_amount: f(500) }] };
  const { operations } = validateExtraction(raw, opts);
  assert.match(operations[0].warnings.join(" "), /quantité × prix/);
});

test("validateExtraction : virgule décimale numérique déjà résolue côté IA (number)", () => {
  const raw = { operations: [{ date: f("2026-07-15"), type: f("frais"), net_amount: f(2.5) }] };
  const { operations } = validateExtraction(raw, opts);
  assert.equal(operations[0].op.amount, 2.5);
});

test("validateExtraction : document sans opération", () => {
  const { operations } = validateExtraction({ document: { institution: f("Boursorama") }, operations: [] }, opts);
  assert.equal(operations.length, 0);
});

test("validateExtraction : sortie IA invalide (non conforme) → aucune opération, pas de crash", () => {
  assert.doesNotThrow(() => validateExtraction({}, opts));
  assert.doesNotThrow(() => validateExtraction({ operations: "nope" }, opts));
  assert.equal(validateExtraction({}, opts).operations.length, 0);
});

test("validateExtraction : document (compte détecté)", () => {
  const raw = { document: { institution: f("Boursorama"), account_type: f("pea"), currency: f("EUR") }, operations: [] };
  const { document } = validateExtraction(raw, opts);
  assert.equal(document.institution, "Boursorama");
  assert.equal(document.accountType, "pea");
  assert.equal(document.currency, "EUR");
});

test("validateExtraction : seuils par défaut cohérents", () => {
  assert.ok(DEFAULT_THRESHOLDS.high > DEFAULT_THRESHOLDS.low);
});

test("normalizeRawExtraction : accepte les valeurs directes renvoyées par un modèle", () => {
  const raw = normalizeRawExtraction({
    transactions: [{
      operation_date: "2026-07-15", action: "buy", assetName: "Air Liquide",
      quantity: 2, price: 176.5, amount: 353, currency: "EUR", sourceText: "15/07 Achat Air Liquide 2 x 176,50",
    }],
  });
  const { operations } = validateExtraction(raw, opts);
  assert.equal(operations.length, 1);
  assert.equal(operations[0].op.type, "achat");
  assert.equal(operations[0].op.quantity, 2);
  assert.equal(operations[0].op.unitPrice, 176.5);
  assert.equal(operations[0].op.amount, 353);
  assert.equal(operations[0].band, "medium");
});
