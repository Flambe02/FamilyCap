import { test } from "node:test";
import assert from "node:assert/strict";
import {
  autoMapSnapshotHeaders,
  buildSnapshotPreview,
  extractSnapshotDate,
  isPortfolioSnapshotHeader,
} from "../lib/portfolio-snapshot-import.ts";

const HEADER = ["Libellé", "Cours", "Dev", "Var/Veille", "Qté", "PRU", "Valorisation", "+/- values", "+/- values (%)", "Poids", "ISIN"];
const ROWS = [["AIR LIQUIDE (AI)", "176,52", "EUR", "0,54%", "119", "166,0461", "21005,88", "1246,3941", "6,31%", "2,19%", "FR0000120073"]];

test("snapshot : détecte et mappe un relevé PEA/CTO", () => {
  const mapping = autoMapSnapshotHeaders(HEADER);
  assert.equal(isPortfolioSnapshotHeader(HEADER), true);
  assert.equal(mapping.instrumentName, 0);
  assert.equal(mapping.lastPrice, 1);
  assert.equal(mapping.currency, 2);
  assert.equal(mapping.dayChangePct, 3);
  assert.equal(mapping.quantity, 4);
  assert.equal(mapping.averageCost, 5);
  assert.equal(mapping.currentValue, 6);
  assert.equal(mapping.gainEur, 7);
  assert.equal(mapping.gainPct, 8);
  assert.equal(mapping.weightPct, 9);
  assert.equal(mapping.isin, 10);
});

test("snapshot : transforme une position en correction sans mouvement de trésorerie", () => {
  const preview = buildSnapshotPreview({
    rows: ROWS,
    mapping: autoMapSnapshotHeaders(HEADER),
    asOfDate: "2026-07-24",
    accountCurrency: "EUR",
    holdings: [],
  });
  assert.equal(preview.summary.total, 1);
  assert.equal(preview.summary.errors, 0);
  assert.equal(preview.rows[0].op.type, "correction");
  assert.equal(preview.rows[0].op.quantity, 119);
  assert.equal(preview.rows[0].op.unitPrice, 166.0461);
  assert.equal(preview.rows[0].snapshot.lastPrice, 176.52);
  assert.equal(preview.rows[0].snapshot.gainEur, 1246.3941);
  assert.equal(preview.rows[0].snapshot.gainPct, 6.31);
  assert.equal(preview.rows[0].snapshot.dayChangePct, 0.54);
});

test("snapshot : récupère la date placée dans le préambule du courtier", () => {
  assert.equal(extractSnapshotDate([["Portefeuille 123"], ["24/07/2026"]]), "2026-07-24");
});
