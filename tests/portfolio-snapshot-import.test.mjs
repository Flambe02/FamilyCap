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

// ---- RÉGRESSION : le cours d'un relevé français à 3 décimales -----------------------------
// « 81,023 » lu 81 023 € valorisait 719 parts à 58 255 537 € au lieu de 58 255,54 €.
// Deux filets désormais : lecture du séparateur décimal au niveau du FICHIER, et
// contre-vérification du cours par la valorisation du même relevé (valorisation ÷ quantité).
const SNAP_HEADER = ["Libellé", "Cours", "Dev", "Var/Veille", "Qté", "PRU", "Valorisation", "+/- values", "+/- values (%)", "Poids", "ISIN"];

test("snapshot : cours à 3 décimales lu comme un décimal (pas ×1000)", () => {
  const rows = [["VANGUARD FTSE ALL-WORLD (VHYL)", "81,023", "EUR", "0,20%", "719", "61,79", "58255,54", "13828,53", "31,1%", "55,3%", "IE00B8GKDB10"]];
  const { positions, rows: preview } = buildSnapshotPreview({
    rows, mapping: autoMapSnapshotHeaders(SNAP_HEADER), asOfDate: "2026-07-25", accountCurrency: "EUR", holdings: [],
  });
  assert.equal(positions[0].lastPrice, 81.023);
  assert.equal(positions[0].quantity, 719);
  assert.equal(preview[0].snapshot.priceMismatch, false);
  assert.equal(preview[0].warnings.some((w) => w.startsWith("Cours incohérent")), false);
});

test("snapshot : cours contredit par la valorisation → avertissement + cours recalculé", () => {
  // Le fichier est lu en format US : « 81,023 » devient 81 023, incompatible avec la valorisation.
  const rows = [["VANGUARD FTSE ALL-WORLD (VHYL)", "81,023", "EUR", "0.20%", "719", "61.79", "58255.54", "13828.53", "31.1%", "55.3%", "IE00B8GKDB10"]];
  const { rows: preview } = buildSnapshotPreview({
    rows, mapping: autoMapSnapshotHeaders(SNAP_HEADER), asOfDate: "2026-07-25", accountCurrency: "EUR", holdings: [], numberFormat: "us",
  });
  assert.equal(preview[0].snapshot.lastPrice, 81023);
  assert.equal(preview[0].snapshot.priceMismatch, true);
  // Cours recalculé depuis le relevé : 58 255,54 ÷ 719 ≈ 81,023.
  assert.ok(Math.abs(preview[0].snapshot.derivedPrice - 81.023) < 0.001);
  assert.equal(preview[0].status, "warning");
  assert.ok(preview[0].warnings.some((w) => w.startsWith("Cours incohérent")));
});

test("snapshot : sans colonne valorisation, aucun cours n'est inventé", () => {
  const header = ["Libellé", "Cours", "Qté", "ISIN"];
  const rows = [["AIR LIQUIDE (AI)", "176,52", "119", "FR0000120073"]];
  const { rows: preview } = buildSnapshotPreview({
    rows, mapping: autoMapSnapshotHeaders(header), asOfDate: "2026-07-25", accountCurrency: "EUR", holdings: [],
  });
  assert.equal(preview[0].snapshot.derivedPrice, null);
  assert.equal(preview[0].snapshot.priceMismatch, false);
});
