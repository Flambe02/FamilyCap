// D'UNE CAPTURE À `account_operations` — puis au portefeuille recalculé.
//
// C'est le test qui garantit l'intégration : la capture ne crée ni faux achats, ni ligne dans une
// table de positions. Elle produit des OPÉRATIONS, et c'est `computeAccountModel` — le moteur
// existant, inchangé — qui en dérive quantités, prix de revient et trésorerie.
//
// Chaîne vérifiée ici :
//   relevé → buildStatementOperations → buildOperationRecord (validation partagée)
//          → computeAccountModel → quantités / coût / espèces attendus au centime.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseModelStatement, toStatement, buildStatementOperations, statementInstruments,
} from "../lib/document-extraction/statement.ts";
import { buildOperationRecord } from "../lib/account-operation.ts";
import { computeAccountModel, priceKeyOf } from "../lib/portfolio-account.ts";
import { computeFingerprint, operationAmountFields } from "../lib/investment-import.ts";
import { RAW_STRICT, EXPECTED_POSITIONS } from "./fixtures/boursobank-capture.mjs";

const ACCOUNT_ID = "11111111-1111-1111-1111-111111111111";
const MEMBER_ID = "22222222-2222-2222-2222-222222222222";

function statement() {
  return toStatement(parseModelStatement(RAW_STRICT).data, { accountCurrency: "EUR" });
}

/** Rejoue exactement ce que fait /commit : validation partagée puis insertion simulée. */
function toRecords(operations) {
  return operations.map((op) => {
    const built = buildOperationRecord({
      type: op.type ?? undefined, date: op.date ?? undefined,
      assetName: op.instrumentName ?? undefined, ticker: op.ticker ?? undefined, isin: op.isin ?? undefined,
      quantity: op.quantity, unitPrice: op.unitPrice,
      ...operationAmountFields(op),
      fees: op.fees ?? undefined, taxes: op.taxes ?? undefined, currency: op.currency,
      note: op.note ?? undefined,
    }, { memberId: MEMBER_ID, source: "ai_scan", importFingerprint: computeFingerprint(ACCOUNT_ID, op) });
    assert.equal(built.ok, true, built.ok ? "" : built.error);
    return built.record;
  });
}

/** Relit les enregistrements comme le fait `loadImportContext`, puis calcule le portefeuille. */
function model(records, instruments) {
  const priceByKey = new Map();
  for (const instrument of instruments) {
    priceByKey.set(priceKeyOf({ isin: instrument.isin, symbol: instrument.ticker, name: instrument.name }), {
      lastPrice: instrument.lastPrice, lastPriceAt: instrument.lastPriceAt, assetType: "etf", name: instrument.name,
    });
  }
  return computeAccountModel({
    accountType: "PEA",
    today: "2026-07-26",
    priceByKey,
    operations: records.map((record, index) => ({
      id: `op-${index}`, accountId: ACCOUNT_ID, memberId: MEMBER_ID,
      type: record.type, date: record.operation_date,
      assetName: record.asset_name, ticker: record.ticker, isin: record.isin,
      quantity: record.quantity, unitPrice: record.unit_price,
      grossAmount: record.gross_amount, fees: record.fees, netAmount: record.net_amount,
      currency: record.currency, source: record.source, note: record.note,
    })),
  });
}

test("une capture produit des opérations de REPRISE, jamais de faux achats", () => {
  const { operations } = buildStatementOperations(statement());
  assert.equal(operations.length, 6, "5 positions + 1 reprise du solde espèces");
  const byType = operations.reduce((tally, op) => ({ ...tally, [op.type]: (tally[op.type] ?? 0) + 1 }), {});
  assert.deepEqual(byType, { correction: 5, versement: 1 });
  assert.equal(operations.filter((op) => op.type === "achat").length, 0, "aucun achat ne doit être inventé");
});

test("toutes les opérations portent la DATE DU RELEVÉ, jamais le « Dernier Mvt »", () => {
  const { operations } = buildStatementOperations(statement());
  const movementDates = EXPECTED_POSITIONS.map((position) => position.lastMovementDate);
  for (const op of operations) {
    assert.equal(op.date, "2026-07-25");
    assert.ok(!movementDates.includes(op.date));
  }
  // « Dernier Mvt » reste une métadonnée de la position : conservée en note, jamais opérante.
  const sanofi = operations.find((op) => op.isin === "FR0000120578");
  assert.ok(sanofi.note.includes("dernier mouvement 2026-02-23"));
});

test("chaque opération porte le COÛT HISTORIQUE exact, pas le prix de revient affiché", () => {
  const { operations, totalCostBasis } = buildStatementOperations(statement());
  const byIsin = Object.fromEntries(operations.filter((op) => op.isin).map((op) => [op.isin, op]));
  assert.equal(byIsin.IE00B53L3W79.amount, 63241.0);
  assert.equal(byIsin.DE000A0H0728.amount, 26600.0);
  assert.equal(byIsin.IE0002XZSHO1.amount, 24714.0);
  assert.equal(byIsin.FR0000120578.amount, 31618.69);
  assert.equal(byIsin.FR0013412020.amount, 3200.93);
  assert.equal(totalCostBasis, 149374.62);
  // Le prix de revient AFFICHÉ reste consigné, à titre informatif, dans la note.
  assert.ok(byIsin.FR0000120578.note.includes("prix de revient affiché 87.83"));
});

test("le montant du coût arrive dans gross_amount (sinon le moteur recalcule un coût arrondi)", () => {
  const { operations } = buildStatementOperations(statement());
  const records = toRecords(operations);
  const sanofi = records.find((record) => record.isin === "FR0000120578");
  assert.equal(sanofi.gross_amount, 31618.69);
  assert.equal(sanofi.type, "correction");
  // Le prix unitaire stocké est le coût EXACT rapporté à la quantité, pas le prix affiché.
  assert.ok(Math.abs(sanofi.unit_price * 360 - 31618.69) < 0.01);
});

test("le portefeuille RECALCULÉ reproduit la capture : quantités, coût, espèces", () => {
  const source = statement();
  const { operations } = buildStatementOperations(source);
  const result = model(toRecords(operations), statementInstruments(source));

  // Quantités : dérivées des opérations, jamais stockées.
  const byIsin = Object.fromEntries(result.positions.map((position) => [position.isin, position]));
  assert.equal(byIsin.IE00B53L3W79.quantity, 317);
  assert.equal(byIsin.DE000A0H0728.quantity, 1000);
  assert.equal(byIsin.IE0002XZSHO1.quantity, 5000);
  assert.equal(byIsin.FR0000120578.quantity, 360);
  assert.equal(byIsin.FR0013412020.quantity, 103);

  // Coût historique par ligne, au centime.
  assert.ok(Math.abs(byIsin.FR0000120578.investedEur - 31618.69) < 0.005);
  assert.ok(Math.abs(byIsin.FR0013412020.investedEur - 3200.93) < 0.005);
  assert.ok(Math.abs(result.investedInAssetsEur - 149374.62) < 0.02);

  // Trésorerie : exactement le solde espèces du relevé.
  assert.ok(Math.abs(result.cashEur - 21.09) < 0.005);

  // Valorisation et plus-value latente : celles du relevé.
  assert.ok(Math.abs(result.positionsValueEur - 177397.25) < 0.02, `valorisation ${result.positionsValueEur}`);
  assert.ok(Math.abs(result.totalValueEur - 177418.34) < 0.02, `total ${result.totalValueEur}`);
  assert.ok(Math.abs(result.unrealizedGainEur - 28022.63) < 0.02, `+/- value ${result.unrealizedGainEur}`);
});

test("le prix de revient AFFICHÉ, s'il servait de coût, fausserait le portefeuille", () => {
  // Démonstration de la régression que ce travail corrige : en reprenant quantité × prix de
  // revient AFFICHÉ, le coût total vaut 149 361,54 € au lieu de 149 374,62 €. L'écart de 13,08 €
  // n'est pas une erreur de lecture — c'est l'arrondi de la banque, ligne par ligne :
  //   SANOFI  360 × 87,83 = 31 618,80  au lieu de 31 618,69  (+0,11)
  //   AMUNDI  103 × 31,08 =  3 201,24  au lieu de  3 200,93  (+0,31)
  //   WORLD  5 000 ×  4,94 = 24 700,00 au lieu de 24 714,00  (−14,00)
  // Et la plus-value latente cesse alors de correspondre à celle imprimée sur le relevé.
  const naive = EXPECTED_POSITIONS.reduce((total, position) => total + position.quantity * position.averageCostDisplayed, 0);
  assert.equal(Math.round(naive * 100) / 100, 149361.54);
  assert.notEqual(Math.round(naive * 100) / 100, 149374.62);
  for (const position of EXPECTED_POSITIONS) {
    const rounded = Math.round(position.quantity * position.averageCostDisplayed * 100) / 100;
    if (rounded !== position.costBasis) {
      assert.ok(Math.abs(rounded - position.costBasis) > 0, `${position.isin} : l'arrondi doit être visible`);
    }
  }
});

test("le solde espèces peut être écarté, et le cumul des versements n'est JAMAIS importé", () => {
  const source = statement();
  const withoutCash = buildStatementOperations(source, { includeCash: false });
  assert.equal(withoutCash.operations.filter((op) => op.type === "versement").length, 0);
  assert.equal(withoutCash.cashRecorded, null);

  const withCash = buildStatementOperations(source);
  // 149 500 € de « Cumul des versements » figurent sur le relevé : ils sont conservés comme
  // information, jamais convertis en opération (ils feraient double emploi avec l'historique
  // déjà saisi et gonfleraient la trésorerie de 149 500 €).
  const cumulative = withCash.notImported.find((entry) => entry.label === "Cumul des versements");
  assert.equal(cumulative.value, 149500);
  assert.equal(withCash.operations.filter((op) => op.type === "versement").length, 1);
  assert.equal(withCash.operations.find((op) => op.type === "versement").amount, 21.09);
  const ceiling = withCash.notImported.find((entry) => entry.label === "Plafond de versement");
  assert.equal(ceiling.value, 150000);
});

test("une position décochée n'est pas reprise", () => {
  const { operations, totalCostBasis } = buildStatementOperations(statement(), { excludeIndexes: [4] });
  assert.equal(operations.filter((op) => op.type === "correction").length, 4);
  assert.equal(operations.some((op) => op.isin === "FR0000120578"), false);
  assert.equal(totalCostBasis, Math.round((149374.62 - 31618.69) * 100) / 100);
});

test("clé d'import : compte + date + ISIN + quantité + valeur", () => {
  const { operations } = buildStatementOperations(statement());
  const line = operations.find((op) => op.isin === "FR0000120578");

  // Même capture réimportée → même empreinte : le doublon est reconnu.
  assert.equal(computeFingerprint(ACCOUNT_ID, line), computeFingerprint(ACCOUNT_ID, { ...line }));
  // Un autre compte, une autre date, une autre quantité ou une autre valeur → empreinte différente.
  assert.notEqual(computeFingerprint(ACCOUNT_ID, line), computeFingerprint("autre-compte", line));
  assert.notEqual(computeFingerprint(ACCOUNT_ID, line), computeFingerprint(ACCOUNT_ID, { ...line, date: "2026-07-24" }));
  assert.notEqual(computeFingerprint(ACCOUNT_ID, line), computeFingerprint(ACCOUNT_ID, { ...line, quantity: 361 }));
  assert.notEqual(computeFingerprint(ACCOUNT_ID, line), computeFingerprint(ACCOUNT_ID, { ...line, amount: 31618.7 }));
  assert.notEqual(computeFingerprint(ACCOUNT_ID, line), computeFingerprint(ACCOUNT_ID, { ...line, isin: "FR0000120579" }));
});

test("le cours repris reproduit la valorisation du relevé, malgré l'arrondi affiché", () => {
  const instruments = statementInstruments(statement());
  const world = instruments.find((instrument) => instrument.isin === "IE0002XZSHO1");
  // Le relevé affiche 6,86 € ; 5 000 × 6,86 = 34 300 € alors qu'il annonce 34 325 €.
  assert.equal(world.lastPrice, 6.865);
  assert.equal(world.priceSource, "derived");
  assert.equal(world.lastPriceAt, "2026-07-25");
});

// ==========================================================================================
// Garanties d'architecture (lues dans le code : elles ne se testent pas autrement sans base)
// ==========================================================================================

const commitSource = readFileSync(new URL("../app/api/investment-imports/commit/route.ts", import.meta.url), "utf8");
const scanSource = readFileSync(new URL("../app/api/investment-imports/scan/route.ts", import.meta.url), "utf8");
const migrationSource = readFileSync(new URL("../supabase/migrations/20260808_import_capture_commit.sql", import.meta.url), "utf8");

test("aucune écriture de position dans holdings : la quantité y reste à zéro", () => {
  // `holdings` est un RÉFÉRENTIEL DE PRIX. Y écrire une quantité créerait une seconde source de
  // vérité, en concurrence avec account_operations.
  const createBlock = commitSource.slice(
    commitSource.indexOf("async function createMissingHoldings"),
    commitSource.indexOf("async function updateSnapshotPrices"),
  );
  assert.ok(createBlock.length > 0, "l'insertion d'instrument doit rester visible dans le code");
  assert.deepEqual(createBlock.match(/quantity:\s*[^,\n]+/g), ["quantity: 0"]);
  assert.deepEqual(createBlock.match(/average_cost:\s*[^,\n]+/g), ["average_cost: null"]);

  // Les mises à jour de holdings ne touchent que le cours.
  const patchBlock = commitSource.slice(commitSource.indexOf("async function updateSnapshotPrices"));
  assert.ok(!/quantity/.test(patchBlock), "une mise à jour de holdings ne doit jamais toucher la quantité");
  assert.ok(!/average_cost/.test(patchBlock), "le prix de revient est dérivé, jamais écrit dans holdings");

  // Même règle côté SQL : la RPC ne lit JAMAIS de quantité dans le relevé.
  assert.ok(!/v_instrument->>'quantity'/.test(migrationSource));
  assert.ok(!/v_instrument->>'average_cost'/.test(migrationSource));

  // Et il n'existe aucune autre table de positions.
  assert.ok(!/portfolio_positions|imported_positions|statement_positions/.test(commitSource));
  assert.ok(!/create table[\s\S]*position/i.test(migrationSource));
});

test("l'import est écrit dans UNE transaction (RPC), avec repli documenté", () => {
  assert.match(commitSource, /rpc\/commit_investment_import/);
  assert.match(migrationSource, /create or replace function public\.commit_investment_import/);
  // La fonction est réservée au serveur : aucun client authentifié ne peut l'appeler.
  assert.match(migrationSource, /revoke all on function public\.commit_investment_import[\s\S]*from authenticated/);
  // Le repli séquentiel n'est emprunté QUE si la fonction n'est pas déployée.
  assert.match(commitSource, /PGRST202/);
});

test("la capture est identifiée par une empreinte SHA-256 et un lot d'import", () => {
  assert.match(scanSource, /createHash\("sha256"\)/);
  assert.match(scanSource, /duplicate_capture/);
  assert.match(commitSource, /duplicate_capture/);
  assert.match(migrationSource, /investment_import_batches_capture_idx/);
});

test("aucune image ni aucun numéro de compte n'est journalisé", () => {
  for (const [name, source] of [["scan", scanSource], ["commit", commitSource]]) {
    assert.ok(!/console\.(log|info|warn|error)/.test(source), `${name} ne doit rien journaliser`);
  }
  // Le numéro de compte ne circule que masqué.
  assert.ok(!/accountNumber\b(?!Masked)/.test(commitSource));
  assert.ok(!/accountNumber\b(?!Masked)/.test(scanSource));
});
