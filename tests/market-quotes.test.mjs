// Tests des règles PURES de lib/market-quotes.ts (aucun appel réseau).
//
// Régression principale couverte : la « variation / veille » de la fiche d'un actif.
// Le champ `chartPreviousClose` de Yahoo n'est PAS la clôture de la veille mais celle qui
// précède le DÉBUT de la plage demandée. Avec range=1mo, TTE.PA renvoyait 69,51 € contre
// 75,90 € de cours, soit « +9,19 % sur la veille » au lieu de −0,37 % — un chiffre faux sans
// en avoir l'air. resolvePreviousClose reconstruit la vraie clôture précédente.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePreviousClose } from "../lib/market-quotes.ts";

test("previousClose : le champ explicite du fournisseur prime quand il existe", () => {
  assert.equal(resolvePreviousClose([70, 74.29, 76.18, 75.9], 75.9, 76.18), 76.18);
});

test("previousClose : marché OUVERT — le dernier point est la séance en cours", () => {
  // Cas réel TTE.PA : dernier close (75,90) = cours en direct → la veille est 76,18.
  const closes = [69.51, 74.29, 76.18, 75.9];
  assert.equal(resolvePreviousClose(closes, 75.9, null), 76.18);
  const previous = resolvePreviousClose(closes, 75.9, null);
  const changePct = Math.round(((75.9 - previous) / previous) * 10000) / 100;
  assert.equal(changePct, -0.37); // et surtout PAS +9,19 % (69,51 → 75,90)
});

test("previousClose : marché FERMÉ — le cours est déjà la dernière clôture connue", () => {
  // L'historique s'arrête la veille : cette clôture EST la référence, sans décalage d'un cran.
  assert.equal(resolvePreviousClose([100, 101, 102], 105, null), 102);
});

test("previousClose : historique insuffisant → null, jamais une valeur de repli", () => {
  assert.equal(resolvePreviousClose([], 75.9, null), null);
  assert.equal(resolvePreviousClose([75.9], 75.9, null), null); // seul point = séance en cours
});

test("previousClose : la tolérance « même séance » reste serrée", () => {
  // 0,05 % d'écart : arrondi d'affichage, c'est bien la séance en cours → on prend l'avant-dernier.
  assert.equal(resolvePreviousClose([50, 60, 100.03], 100, null), 60);
  // 1 % d'écart : le cours a bougé depuis la dernière clôture → celle-ci est la référence.
  assert.equal(resolvePreviousClose([50, 60, 101], 100, null), 101);
});
