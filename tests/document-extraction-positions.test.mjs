// Tests du SCAN d'un relevé de POSITIONS (lib/document-extraction/extract.ts) — PARTIE PURE.
// On simule la sortie brute de l'IA (aucun appel réseau) et on vérifie le trajet complet :
//   extraction → tableau canonique → autoMapSnapshotHeaders → buildSnapshotPreview.
// Régression couverte : une capture « Mes positions » (aucune opération datée) doit produire un
// portefeuille importable. L'ancienne version, dont le schéma ne connaissait que les opérations,
// renvoyait « aucune ligne d'opération exploitable » et l'import s'arrêtait là.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRawExtraction,
  validateExtractedPositions,
  extractDocument,
  crossCheckTotals,
} from "../lib/document-extraction/extract.ts";
import { autoMapSnapshotHeaders, buildSnapshotPreview } from "../lib/portfolio-snapshot-import.ts";

const f = (value, confidence = 0.95, page = 1) => ({ value, confidence, page });
const opts = { accountCurrency: "EUR" };

// Relevé Boursorama « Gestion Libre » : 5 lignes, totaux imprimés en tête de page.
const RAW_PEA = {
  document: {
    institution: f("Boursorama Banque"),
    account_type: f("pea"),
    currency: f("EUR"),
    holder: f("PEA LAMBERT"),
    as_of_date: f("2026-07-24"),
    total_valuation: f(176796.17),
    total_gain: f(27421.55),
    cash_balance: f(21.09),
  },
  positions: [
    { instrument_name: f("ISHARES CORE EURO STOXX 50 UCITS ETF EUR (ACC)"), isin: f("IE00B53L3W79"), quantity: f(317), average_cost: f(199.5), last_price: f(241.75), current_value: f(76634.75), day_change_pct: f(1.22), gain_amount: f(13393.75), gain_pct: f(21.18), last_movement_date: f("2025-12-09") },
    { instrument_name: f("ISHARES DIVERSIFIED COMMODITY SWAP UCITS ETF (DE)"), isin: f("DE000A0H0728"), quantity: f(1000), average_cost: f(26.6), last_price: f(34.98), current_value: f(34980), day_change_pct: f(-1.21), gain_amount: f(8380), gain_pct: f(31.5), last_movement_date: f("2024-05-22") },
    { instrument_name: f("ISHARES MSCI WORLD SWAP PEA UCITS ETF EUR (ACC)"), isin: f("IE0002XZSHO1", 0.55), quantity: f(5000), average_cost: f(4.94), last_price: f(6.82), current_value: f(34110), day_change_pct: f(0.63), gain_amount: f(9396), gain_pct: f(38.02), last_movement_date: f("2026-04-05") },
    { instrument_name: f("SANOFI"), isin: f("FR0000120578"), quantity: f(360), average_cost: f(87.83), last_price: f(76.36), current_value: f(27489.6), day_change_pct: f(-0.43), gain_amount: f(-4129.09), gain_pct: f(-13.05), last_movement_date: f("2026-02-23") },
    { instrument_name: f("AMUNDI PEA EMERGENT (MSCI EMERGING) ESG TRANSITION UCITS ETF"), isin: f("FR0013412020"), quantity: f(103), average_cost: f(31.08), last_price: f(34.78), current_value: f(3581.82), day_change_pct: f(-0.4), gain_amount: f(380.89), gain_pct: f(11.9), last_movement_date: f("2026-05-11") },
  ],
};

function runPipeline(raw, holdings = []) {
  const normalized = normalizeRawExtraction(raw);
  const document = extractDocument(normalized);
  const positions = validateExtractedPositions(normalized, opts);
  const preview = buildSnapshotPreview({
    rows: positions.rows,
    mapping: autoMapSnapshotHeaders(positions.header),
    asOfDate: document.asOfDate ?? "2026-07-24",
    accountCurrency: "EUR",
    holdings,
    numberFormat: "us",
  });
  return { normalized, document, positions, preview };
}

test("positions : un relevé sans aucune opération produit un portefeuille importable", () => {
  const { normalized, document, positions, preview } = runPipeline(RAW_PEA);

  // Le cas de la régression : zéro opération, mais cinq positions exploitables.
  assert.equal(normalized.operations.length, 0);
  assert.equal(positions.rows.length, 5);
  assert.equal(preview.rows.length, 5);
  assert.equal(preview.summary.errors, 0);

  assert.equal(document.institution, "Boursorama Banque");
  assert.equal(document.accountType, "pea");
  assert.equal(document.asOfDate, "2026-07-24");
});

test("positions : l'en-tête canonique est reconnu par le mappeur du CSV", () => {
  const mapping = autoMapSnapshotHeaders(validateExtractedPositions(normalizeRawExtraction(RAW_PEA), opts).header);
  assert.equal(mapping.instrumentName, 0);
  assert.equal(mapping.isin, 1);
  assert.equal(mapping.ticker, 2);
  assert.equal(mapping.quantity, 3);
  assert.equal(mapping.averageCost, 4);
  assert.equal(mapping.lastPrice, 5);
  assert.equal(mapping.currency, 6);
  assert.equal(mapping.currentValue, 7);
  assert.equal(mapping.dayChangePct, 8);
  assert.equal(mapping.gainEur, 9);
  assert.equal(mapping.gainPct, 10);
  assert.equal(mapping.weightPct, 11);
});

test("positions : les nombres du JSON traversent sans ambiguïté de séparateur décimal", () => {
  const { preview } = runPipeline(RAW_PEA);
  const sanofi = preview.positions.find((position) => position.name === "SANOFI");
  assert.equal(sanofi.quantity, 360);
  assert.equal(sanofi.averageCost, 87.83);
  assert.equal(sanofi.lastPrice, 76.36);
  assert.equal(sanofi.currentValue, 27489.6);
  assert.equal(sanofi.gainEur, -4129.09); // la moins-value reste négative
  // Aucune ligne ne doit être signalée « cours incohérent » : cours × quantité = valorisation.
  assert.equal(preview.rows.filter((row) => row.snapshot.priceMismatch).length, 0);
});

test("positions : la date d'arrêté devient la date de chaque position (solde initial)", () => {
  const { preview } = runPipeline(RAW_PEA);
  for (const row of preview.rows) {
    assert.equal(row.op.type, "correction");
    assert.equal(row.op.date, "2026-07-24");
  }
});

test("crossCheckTotals : la somme des lignes retranscrites confirme le total imprimé", () => {
  const { document, preview } = runPipeline(RAW_PEA);
  const sum = (pick) => Math.round(preview.positions.reduce((total, position) => total + (pick(position) ?? 0), 0) * 100) / 100;
  const totals = crossCheckTotals({ sumValuation: sum((p) => p.currentValue), sumGain: sum((p) => p.gainEur), document });
  assert.equal(totals.valuation.actual, 176796.17);
  assert.equal(totals.valuation.ok, true);
  assert.equal(totals.gain.actual, 27421.55);
  assert.equal(totals.gain.ok, true);
});

test("crossCheckTotals : une ligne oubliée est DÉTECTÉE (le contrôle ne se contente pas de la confiance)", () => {
  const amputated = { ...RAW_PEA, positions: RAW_PEA.positions.slice(0, 4) };
  const { document, preview } = runPipeline(amputated);
  const sum = (pick) => Math.round(preview.positions.reduce((total, position) => total + (pick(position) ?? 0), 0) * 100) / 100;
  const totals = crossCheckTotals({ sumValuation: sum((p) => p.currentValue), sumGain: sum((p) => p.gainEur), document });
  assert.equal(totals.valuation.ok, false);
  assert.equal(Math.round((totals.valuation.expected - totals.valuation.actual) * 100) / 100, 3581.82);
});

test("positions : un ISIN dont la clé de contrôle est fausse est signalé, jamais bloquant", () => {
  const corrupted = {
    positions: [{ instrument_name: f("SANOFI"), isin: f("FR0000120579"), quantity: f(360), average_cost: f(87.83), last_price: f(76.36), current_value: f(27489.6) }],
  };
  const { meta } = validateExtractedPositions(normalizeRawExtraction(corrupted), opts);
  assert.ok(meta[0].warnings.some((warning) => warning.includes("ISIN invalide")));
});

test("positions : une confiance basse rétrograde la bande, sans écarter la ligne", () => {
  const { positions } = runPipeline(RAW_PEA);
  const doubtful = positions.meta[2]; // ISIN lu à 0,55 de confiance (caractères ambigus O/0)
  assert.equal(doubtful.band, "high"); // l'ISIN n'entre pas dans la confiance de ligne…
  const weak = validateExtractedPositions(
    normalizeRawExtraction({ positions: [{ instrument_name: f("VALEUR FLOUE", 0.3), quantity: f(10, 0.3), last_price: f(5, 0.3) }] }),
    opts,
  );
  assert.equal(weak.meta[0].band, "low"); // …mais un libellé/quantité douteux, oui
});

test("repêchage : des positions rangées à tort dans « operations » sont reclassées", () => {
  // Mode de défaillance observé : le modèle place les lignes du tableau de positions dans
  // « operations », sans type ni date. Elles y étaient invalides et l'import repartait à vide.
  const misfiled = {
    operations: [
      { instrument_name: f("SANOFI"), isin: f("FR0000120578"), quantity: f(360), unit_price: f(76.36), amount: f(27489.6) },
      { date: f("2026-07-15"), type: f("achat"), instrument_name: f("SANOFI"), quantity: f(10), unit_price: f(76.36) },
    ],
  };
  const normalized = normalizeRawExtraction(misfiled);
  assert.equal(normalized.operations.length, 1); // le véritable achat daté reste une opération
  assert.equal(normalized.positions.length, 1); // la ligne de position est reclassée
  const { rows } = validateExtractedPositions(normalized, opts);
  assert.equal(rows[0][0], "SANOFI");
  assert.equal(rows[0][3], "360");
});

test("positions : alias de nommage tolérés (holdings / libelle / cours / valorisation)", () => {
  const loose = {
    holdings: [{ libelle: "SANOFI", isin: "FR0000120578", quantite: 360, pru: 87.83, cours: 76.36, valorisation: 27489.6, devise: "EUR" }],
  };
  const { rows } = validateExtractedPositions(normalizeRawExtraction(loose), opts);
  assert.deepEqual(rows[0].slice(0, 8), ["SANOFI", "FR0000120578", "", "360", "87.83", "76.36", "EUR", "27489.6"]);
});
