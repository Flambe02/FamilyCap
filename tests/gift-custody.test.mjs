// Tests de la classification custody (lib/gift-custody.ts).
// Verrouille notamment la regle : un transfert Ledger AVEC frais de reseau
// (ledger_amount < btc_amount) n'est jamais recompte comme encore sur Binance.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isLedgerGift,
  isBinanceGift,
  heldBtc,
  transferFeeBtc,
  ledgerBalanceBtc,
  binanceBalanceBtc,
  transferFeesBtc,
  unreconciledLedgerBtc,
} from "../lib/gift-custody.ts";

// Cas reel : anniversaire 2024 de Paul, transfere avec 0,00002 BTC de frais.
const ledgerWithFee = { custody: "Ledger", btc_amount: 0.00061163, ledger_amount: 0.00059163, txid: "58354c88" };
const ledgerNoFee = { custody: "Ledger", btc_amount: 0.00053083, ledger_amount: 0.00053083, txid: "58354c88" };
const onBinance = { custody: "Binance commun", btc_amount: 0.001, ledger_amount: null };
const toReconcile = { custody: "À rapprocher", btc_amount: 0.002, ledger_amount: null };

test("un transfert Ledger net de frais n'est PAS considere comme Binance", () => {
  assert.equal(isLedgerGift(ledgerWithFee), true);
  assert.equal(isBinanceGift(ledgerWithFee), false);
  // Il ne contribue jamais au solde Binance, meme avec ledger_amount < btc_amount.
  assert.equal(binanceBalanceBtc([ledgerWithFee]), 0);
});

test("heldBtc = net recu sur Ledger (frais deduits), sinon montant achete", () => {
  assert.equal(heldBtc(ledgerWithFee), 0.00059163);
  assert.equal(heldBtc(ledgerNoFee), 0.00053083);
  assert.equal(heldBtc(onBinance), 0.001);
});

test("transferFeeBtc isole les frais du transfert", () => {
  assert.equal(Math.round(transferFeeBtc(ledgerWithFee) * 1e8), 2000);
  assert.equal(transferFeeBtc(ledgerNoFee), 0);
  assert.equal(transferFeeBtc(onBinance), 0);
});

test("soldes agreges sur un portefeuille mixte (cas Paul)", () => {
  const paul = [
    { custody: "Ledger", btc_amount: 0.00155968, ledger_amount: 0.00155968 },
    { custody: "Ledger", btc_amount: 0.00309400, ledger_amount: 0.00309400 },
    { custody: "Ledger", btc_amount: 0.00155968, ledger_amount: 0.00155968 },
    { custody: "Ledger", btc_amount: 0.00136200, ledger_amount: 0.00136200 },
    ledgerWithFee,
    { custody: "Ledger", btc_amount: 0.00053083, ledger_amount: 0.00053083 },
    { custody: "Ledger", btc_amount: 0.00065951, ledger_amount: 0.00065951 },
    { custody: "Ledger", btc_amount: 0.00071399, ledger_amount: 0.00071399 },
  ];
  assert.equal(Math.round(ledgerBalanceBtc(paul) * 1e8), 1007132);
  assert.equal(binanceBalanceBtc(paul), 0);
  assert.equal(Math.round(transferFeesBtc(paul) * 1e8), 2000);
  // Invariant : somme des achats = net recu sur Ledger + frais.
  const achats = paul.reduce((s, g) => s + Math.round(g.btc_amount * 1e8), 0);
  assert.equal(achats, 1007132 + 2000);
});

test("unreconciledLedgerBtc revele les BTC on-chain non rattaches a un cadeau", () => {
  const gifts = [ledgerNoFee]; // 0.00053083 rapproche
  assert.equal(Math.round(unreconciledLedgerBtc(gifts, 0.00112246) * 1e8), 59163);
  // Une fois le cadeau manquant ajoute, l'ecart tombe a zero.
  assert.equal(unreconciledLedgerBtc([ledgerNoFee, ledgerWithFee], 0.00112246), 0);
});

test("les montants en chaine de caracteres sont geres", () => {
  const stringy = { custody: "Ledger", btc_amount: "0.00061163", ledger_amount: "0.00059163" };
  assert.equal(heldBtc(stringy), 0.00059163);
  assert.equal(Math.round(transferFeeBtc(stringy) * 1e8), 2000);
  assert.equal(binanceBalanceBtc([stringy]), 0);
});
