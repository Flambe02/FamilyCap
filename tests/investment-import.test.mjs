// Tests unitaires du moteur d'import (lib/investment-import.ts) et du validateur d'opération
// partagé (lib/account-operation.ts). Exécution : `node --test tests/investment-import.test.mjs`
// (Node ≥ 24 : type-stripping natif). AUCUN réseau, AUCUNE donnée fictive écrite.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseDecimal, normalizeType, parseDate, detectDateFormat, isValidIsin, detectDelimiter,
  parseCsv, autoMapHeaders, matchInstrument, computeFingerprint, sanitizeCsvCell,
  buildTemplateCsv, buildPreview, normalizeRow, IMPORT_FIELDS,
} from "../lib/investment-import.ts";
import { validateOperation, buildOperationRecord, OPERATION_TYPES } from "../lib/account-operation.ts";

// ---- Nombres (virgule / point / milliers / signes) ---------------------------------------
test("parseDecimal : virgule décimale + espace milliers", () => {
  assert.equal(parseDecimal("1 410,50"), 1410.5);
  assert.equal(parseDecimal("410,50"), 410.5);
});
test("parseDecimal : point décimal", () => {
  assert.equal(parseDecimal("410.50"), 410.5);
  assert.equal(parseDecimal("0.5"), 0.5);
});
test("parseDecimal : milliers anglo (,) et euro (.)", () => {
  assert.equal(parseDecimal("1,234,567.89"), 1234567.89);
  assert.equal(parseDecimal("1.234.567,89"), 1234567.89);
});
test("parseDecimal : symboles monétaires et parenthèses négatives", () => {
  assert.equal(parseDecimal("1 410,50 €"), 1410.5);
  assert.equal(parseDecimal("(50)"), -50);
  assert.equal(parseDecimal(""), null);
  assert.equal(parseDecimal("—"), null);
});

// ---- Normalisation des types (FR / EN) ---------------------------------------------------
test("normalizeType : libellés français", () => {
  assert.equal(normalizeType("Achat"), "achat");
  assert.equal(normalizeType("Vente comptant"), "vente");
  assert.equal(normalizeType("Versement"), "versement");
  assert.equal(normalizeType("Dividende net"), "dividende");
  assert.equal(normalizeType("Frais de courtage"), "frais");
  assert.equal(normalizeType("Transfert entrant"), "transfer_in");
});
test("normalizeType : libellés anglais", () => {
  assert.equal(normalizeType("BUY"), "achat");
  assert.equal(normalizeType("Sell"), "vente");
  assert.equal(normalizeType("Cash deposit"), "versement");
  assert.equal(normalizeType("Dividend"), "dividende");
  assert.equal(normalizeType("Commission"), "frais");
});
test("normalizeType : phrase (fallback mot-clé) + inconnu", () => {
  assert.equal(normalizeType("Achat 10 AIR LIQUIDE"), "achat");
  assert.equal(normalizeType("Blabla inconnu"), null);
  assert.equal(normalizeType(""), null);
});

// ---- Dates (FR / US / ISO) ---------------------------------------------------------------
test("parseDate : FR / US / ISO", () => {
  assert.equal(parseDate("05/01/2026", "fr"), "2026-01-05");
  assert.equal(parseDate("01/05/2026", "us"), "2026-01-05");
  assert.equal(parseDate("2026-01-05"), "2026-01-05");
  assert.equal(parseDate("15/07/26", "fr"), "2026-07-15");
});
test("parseDate : date impossible → null", () => {
  assert.equal(parseDate("31/02/2026", "fr"), null);
  assert.equal(parseDate("2026-13-01"), null);
  assert.equal(parseDate("n/a", "fr"), null);
});
test("detectDateFormat : détection colonne", () => {
  assert.equal(detectDateFormat(["13/01/2026", "05/02/2026"]), "fr");
  assert.equal(detectDateFormat(["01/13/2026", "02/05/2026"]), "us");
  assert.equal(detectDateFormat(["2026-01-13"]), "iso");
});

// ---- ISIN (Luhn) -------------------------------------------------------------------------
test("isValidIsin : clé de contrôle", () => {
  assert.equal(isValidIsin("FR0000120073"), true);   // Air Liquide
  assert.equal(isValidIsin("US0378331005"), true);    // Apple
  assert.equal(isValidIsin("FR0000120074"), false);   // mauvaise clé
  assert.equal(isValidIsin("FR001031577"), false);    // trop court
  assert.equal(isValidIsin(""), false);
});

// ---- CSV : délimiteur + parsing ----------------------------------------------------------
test("detectDelimiter : ; , tab", () => {
  assert.equal(detectDelimiter("a;b;c\n1;2;3"), ";");
  assert.equal(detectDelimiter("a,b,c\n1,2,3"), ",");
  assert.equal(detectDelimiter("a\tb\tc"), "\t");
});
test("parseCsv : guillemets, délimiteur intégré, BOM, CRLF", () => {
  const csv = '﻿date,libelle,montant\r\n2026-01-05,"Air, Liquide","1 000,50"\r\n2026-01-06,"Ligne\nmulti",10';
  const { header, rows } = parseCsv(csv);
  assert.deepEqual(header, ["date", "libelle", "montant"]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0][1], "Air, Liquide");
  assert.equal(rows[1][1], "Ligne\nmulti");
});

// ---- Auto-mapping FR / EN ----------------------------------------------------------------
test("autoMapHeaders : en-têtes français", () => {
  const m = autoMapHeaders(["Date opération", "Type", "Code ISIN", "Libellé", "Quantité", "Cours", "Frais de courtage", "Devise"]);
  assert.equal(m.date, 0);
  assert.equal(m.type, 1);
  assert.equal(m.isin, 2);
  assert.equal(m.instrumentName, 3);
  assert.equal(m.quantity, 4);
  assert.equal(m.unitPrice, 5);
  assert.equal(m.fees, 6);
  assert.equal(m.currency, 7);
});
test("autoMapHeaders : en-têtes anglais", () => {
  const m = autoMapHeaders(["Trade Date", "Transaction Type", "ISIN", "Security Name", "Quantity", "Price", "Amount", "Currency"]);
  assert.equal(m.date, 0);
  assert.equal(m.type, 1);
  assert.equal(m.isin, 2);
  assert.equal(m.instrumentName, 3);
  assert.equal(m.quantity, 4);
  assert.equal(m.unitPrice, 5);
  assert.equal(m.amount, 6);
  assert.equal(m.currency, 7);
});
test("autoMapHeaders : une colonne source n'est mappée qu'une fois", () => {
  const m = autoMapHeaders(["date", "type", "montant"]);
  const assigned = IMPORT_FIELDS.map((f) => m[f]).filter((i) => i >= 0);
  assert.equal(new Set(assigned).size, assigned.length);
});

// ---- Matching instrument (holdings) ------------------------------------------------------
const HOLDINGS = [
  { id: "h1", isin: "FR0010315770", symbol: "CW8", name: "Amundi MSCI World" },
  { id: "h2", isin: "FR0000120073", symbol: "AI", name: "Air Liquide" },
];
test("matchInstrument : ISIN > ticker > nom > aucun", () => {
  assert.deepEqual(matchInstrument({ isin: "FR0010315770", ticker: null, instrumentName: null }, HOLDINGS), { holdingId: "h1", matchedBy: "isin" });
  assert.deepEqual(matchInstrument({ isin: null, ticker: "AI", instrumentName: null }, HOLDINGS), { holdingId: "h2", matchedBy: "ticker" });
  assert.deepEqual(matchInstrument({ isin: null, ticker: null, instrumentName: "air liquide" }, HOLDINGS), { holdingId: "h2", matchedBy: "name" });
  assert.deepEqual(matchInstrument({ isin: "DE0000000000", ticker: "ZZZ", instrumentName: "Inconnu" }, HOLDINGS), { holdingId: null, matchedBy: null });
});

// ---- Empreinte (dédup) -------------------------------------------------------------------
test("computeFingerprint : stable et discriminant", () => {
  const op = { type: "achat", date: "2026-01-05", isin: "FR0010315770", ticker: null, instrumentName: null, quantity: 1, unitPrice: 410.5, amount: null, fees: 1.5, taxes: null, currency: "EUR", exchangeRate: null, externalReference: null, note: null };
  const a = computeFingerprint("acc", op);
  assert.equal(a, computeFingerprint("acc", { ...op }));
  assert.notEqual(a, computeFingerprint("acc", { ...op, quantity: 2 }));
  assert.notEqual(a, computeFingerprint("other", op));
});

// ---- Sécurité CSV ------------------------------------------------------------------------
test("sanitizeCsvCell : neutralise les formules et échappe", () => {
  assert.equal(sanitizeCsvCell("=SUM(A1:A2)"), "'=SUM(A1:A2)");
  assert.equal(sanitizeCsvCell("+1"), "'+1");
  assert.equal(sanitizeCsvCell("@x"), "'@x");
  assert.equal(sanitizeCsvCell("a,b"), '"a,b"');
  assert.equal(sanitizeCsvCell('a"b'), '"a""b"');
});
test("buildTemplateCsv : en-tête documenté + exemples", () => {
  const csv = buildTemplateCsv();
  assert.match(csv, /date,type,isin,ticker,instrument_name/);
  assert.match(csv, /versement/);
  assert.match(csv, /FR0010315770/);
});

// ---- buildPreview : cœur de la prévisualisation ------------------------------------------
function preview(csv, opts = {}) {
  const { header, rows } = parseCsv(csv);
  const mapping = opts.mapping ?? autoMapHeaders(header);
  return buildPreview({ rows, mapping, accountId: "acc", accountCurrency: "EUR", accountType: opts.accountType ?? "PEA", holdings: opts.holdings ?? HOLDINGS, existingFingerprints: opts.existingFingerprints, existingExternalRefs: opts.existingExternalRefs, allowAdvanced: opts.allowAdvanced });
}

test("buildPreview : CSV valide (point-virgule + virgule décimale)", () => {
  const csv = "date;type;isin;instrument;quantite;cours;frais\n05/01/2026;Achat;FR0010315770;Amundi MSCI World;1,2;410,50;1,50";
  const { rows, summary } = preview(csv);
  assert.equal(summary.total, 1);
  assert.equal(summary.valid, 1);
  assert.equal(rows[0].op.type, "achat");
  assert.equal(rows[0].op.quantity, 1.2);
  assert.equal(rows[0].op.unitPrice, 410.5);
  assert.equal(rows[0].instrumentHoldingId, "h1");
});
test("buildPreview : versement (montant seul)", () => {
  const csv = "date,type,amount\n2026-01-05,Versement,500";
  const { rows, summary } = preview(csv);
  assert.equal(summary.valid, 1);
  assert.equal(rows[0].op.type, "versement");
  assert.equal(rows[0].op.amount, 500);
});
test("buildPreview : type EN + instrument par ISIN", () => {
  const csv = "Trade Date,Transaction Type,ISIN,Quantity,Price\n2026-01-06,Buy,FR0000120073,10,176.5";
  const { rows, summary } = preview(csv);
  assert.equal(summary.valid, 1);
  assert.equal(rows[0].op.type, "achat");
  assert.equal(rows[0].instrumentHoldingId, "h2");
  assert.equal(rows[0].matchedBy, "isin");
});
test("buildPreview : mapping manuel", () => {
  const csv = "col_a,col_b,col_c,col_d\n2026-01-05,versement,,500";
  const mapping = Object.fromEntries(IMPORT_FIELDS.map((f) => [f, -1]));
  mapping.date = 0; mapping.type = 1; mapping.amount = 3;
  const { summary } = preview(csv, { mapping });
  assert.equal(summary.valid, 1);
});
test("buildPreview : instrument inconnu → avertissement (non bloquant)", () => {
  const csv = "date,type,isin,quantity,unit_price\n2026-01-05,Achat,DE0007164600,3,120";
  const { rows, summary } = preview(csv);
  assert.equal(summary.unknownInstruments, 1);
  assert.equal(rows[0].status, "warning");
  assert.equal(rows[0].errors.length, 0);
});
test("buildPreview : date illisible → ligne en erreur", () => {
  const csv = "date,type,amount\nn/a,Versement,500";
  const { rows, summary } = preview(csv);
  assert.equal(summary.errors, 1);
  assert.equal(rows[0].status, "error");
});
test("buildPreview : doublon certain par référence externe", () => {
  const csv = "date,type,amount,reference\n2026-01-05,Versement,500,VRS-1";
  const { rows } = preview(csv, { existingExternalRefs: new Set(["VRS-1"]) });
  assert.equal(rows[0].status, "duplicate_certain");
});
test("buildPreview : doublon probable par empreinte (base existante)", () => {
  const csv = "date,type,amount\n2026-01-05,Versement,500";
  const { header, rows } = parseCsv(csv);
  const mapping = autoMapHeaders(header);
  const fp = computeFingerprint("acc", normalizeRow(rows[0], mapping, "fr", "EUR"));
  const out = buildPreview({ rows, mapping, accountId: "acc", accountCurrency: "EUR", accountType: "PEA", holdings: HOLDINGS, existingFingerprints: new Set([fp]) });
  assert.equal(out.rows[0].status, "duplicate_possible");
});
test("buildPreview : doublon probable dans le même fichier", () => {
  const csv = "date,type,amount\n2026-01-05,Versement,500\n2026-01-05,Versement,500";
  const { summary } = preview(csv);
  assert.equal(summary.duplicatesPossible, 1); // la 2e occurrence
});
test("buildPreview : PEA — vente > quantité détenue → erreur", () => {
  const csv = "date,type,isin,quantity,unit_price\n2026-01-05,Achat,FR0010315770,1,400\n2026-02-05,Vente,FR0010315770,3,420";
  const { rows } = preview(csv);
  const sell = rows.find((r) => r.op.type === "vente");
  assert.equal(sell.status, "error");
  assert.match(sell.errors.join(" "), /détenue/);
});
test("buildPreview : transferts exigent la migration 20260725", () => {
  const csv = "date,type,isin,quantity,unit_price\n2026-01-05,Transfert entrant,FR0010315770,1,400";
  const { rows } = preview(csv, { accountType: "CTO", allowAdvanced: false });
  assert.equal(rows[0].status, "error");
  assert.match(rows[0].errors.join(" "), /20260725/);
});

// ==========================================================================================
// VALIDATEUR D'OPÉRATION PARTAGÉ (lib/account-operation.ts)
// ==========================================================================================
test("OPERATION_TYPES : couvre les 9 types du schéma", () => {
  for (const t of ["achat", "vente", "versement", "retrait", "dividende", "frais", "correction", "transfer_in", "transfer_out"]) {
    assert.ok(OPERATION_TYPES.has(t), t);
  }
});
test("validateOperation : achat calcule gross/net (frais inclus)", () => {
  const r = validateOperation({ type: "achat", date: "2026-01-05", quantity: 2, unitPrice: 100, fees: 1 });
  assert.ok(r.ok);
  assert.equal(r.gross, 200);
  assert.equal(r.net, 201);
});
test("validateOperation : vente rapporte brut − frais", () => {
  const r = validateOperation({ type: "vente", date: "2026-01-05", quantity: 2, unitPrice: 100, fees: 1 });
  assert.ok(r.ok);
  assert.equal(r.net, 199);
});
test("validateOperation : achat sans quantité → erreur", () => {
  const r = validateOperation({ type: "achat", date: "2026-01-05", unitPrice: 100 });
  assert.equal(r.ok, false);
});
test("validateOperation : versement/dividende exigent un montant positif", () => {
  assert.equal(validateOperation({ type: "versement", date: "2026-01-05" }).ok, false);
  assert.ok(validateOperation({ type: "versement", date: "2026-01-05", netAmount: 500 }).ok);
  assert.ok(validateOperation({ type: "dividende", date: "2026-01-05", netAmount: 12 }).ok);
});
test("validateOperation : transfert exige une quantité positive", () => {
  assert.equal(validateOperation({ type: "transfer_in", date: "2026-01-05", quantity: 0 }).ok, false);
  assert.ok(validateOperation({ type: "transfer_in", date: "2026-01-05", quantity: 5, unitPrice: 10 }).ok);
});
test("validateOperation : date invalide → erreur", () => {
  assert.equal(validateOperation({ type: "versement", date: "05/01/2026", netAmount: 10 }).ok, false);
});
test("buildOperationRecord : member_id forcé + colonnes avancées conditionnelles", () => {
  const r = buildOperationRecord(
    { type: "dividende", date: "2026-01-05", assetName: "Air Liquide", netAmount: 12.8, taxes: 3.2, currency: "USD", exchangeRate: 0.92 },
    { memberId: "m1", source: "import", importBatchId: "b1", externalReference: "DIV-1", importFingerprint: "abc123" },
  );
  assert.ok(r.ok);
  assert.equal(r.record.member_id, "m1");
  assert.equal(r.record.taxes, 3.2);
  assert.equal(r.record.exchange_rate, 0.92);
  assert.equal(r.record.import_batch_id, "b1");
  assert.equal(r.record.external_reference, "DIV-1");
  assert.equal(r.record.source, "import");
});
test("buildOperationRecord : sans migration avancée, pas de colonnes taxes/exchange_rate", () => {
  const r = buildOperationRecord({ type: "versement", date: "2026-01-05", netAmount: 500 }, { memberId: "m1" });
  assert.ok(r.ok);
  assert.equal("taxes" in r.record, false);
  assert.equal("exchange_rate" in r.record, false);
  assert.equal(r.record.member_id, "m1");
});
