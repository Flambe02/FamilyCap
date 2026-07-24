// Tests unitaires du plan d'investissement du membre (lib/investment-plan.ts).
// Exécution : `node --test tests/investment-plan.test.mjs` (Node ≥ 22.18 : type-stripping natif).
// Couvre : validation/normalisation du plan, autorisation d'un achat self-service (le membre ne
// peut agir que sur SON propre PEA/compte-titres actif, achat uniquement), et progression
// mensuelle dérivée EXCLUSIVEMENT des achats réels (jamais versements / ventes / holdings).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateInvestmentPlanInput,
  authorizeMemberOperation,
  computeMonthlyPlanProgress,
  firstOfMonth,
} from "../lib/investment-plan.ts";

const TODAY = "2026-08-20";

// ---- validateInvestmentPlanInput ---------------------------------------------------------
test("plan valide : normalise montant, jour, préférence et pose les défauts", () => {
  const result = validateInvestmentPlanInput(
    { monthlyTarget: 50, targetDay: 5, instrumentPreference: "stocks", targetAccountId: " acc-1 " },
    TODAY,
  );
  assert.equal(result.ok, true);
  assert.equal(result.plan.monthlyTarget, 50);
  assert.equal(result.plan.targetDay, 5);
  assert.equal(result.plan.instrumentPreference, "stocks");
  assert.equal(result.plan.targetAccountId, "acc-1");
  assert.equal(result.plan.remindersEnabled, true); // défaut
  assert.equal(result.plan.leaderboardOptIn, true); // défaut
  assert.equal(result.plan.effectiveFrom, "2026-08-01"); // 1er du mois courant
});

test("plan minimal : préférence 'etf' par défaut, pas de compte ni de jour", () => {
  const result = validateInvestmentPlanInput({ monthlyTarget: 30 }, TODAY);
  assert.equal(result.ok, true);
  assert.equal(result.plan.instrumentPreference, "etf");
  assert.equal(result.plan.targetAccountId, null);
  assert.equal(result.plan.targetDay, null);
});

test("montant arrondi à 2 décimales", () => {
  const result = validateInvestmentPlanInput({ monthlyTarget: 10.999 }, TODAY);
  assert.equal(result.ok, true);
  assert.equal(result.plan.monthlyTarget, 11);
});

test("montant manquant ou négatif refusé", () => {
  assert.equal(validateInvestmentPlanInput({}, TODAY).ok, false);
  assert.equal(validateInvestmentPlanInput({ monthlyTarget: -1 }, TODAY).ok, false);
  assert.equal(validateInvestmentPlanInput({ monthlyTarget: "abc" }, TODAY).ok, false);
});

test("jour cible hors 1..28 refusé", () => {
  assert.equal(validateInvestmentPlanInput({ monthlyTarget: 10, targetDay: 0 }, TODAY).ok, false);
  assert.equal(validateInvestmentPlanInput({ monthlyTarget: 10, targetDay: 29 }, TODAY).ok, false);
  assert.equal(validateInvestmentPlanInput({ monthlyTarget: 10, targetDay: 28 }, TODAY).ok, true);
});

test("préférence d'instrument invalide refusée", () => {
  assert.equal(validateInvestmentPlanInput({ monthlyTarget: 10, instrumentPreference: "crypto" }, TODAY).ok, false);
});

test("firstOfMonth renvoie le 1er du mois", () => {
  assert.equal(firstOfMonth("2026-08-20"), "2026-08-01");
});

// ---- authorizeMemberOperation (self-service achat) ---------------------------------------
const OWN_PEA = { memberId: "me", accountType: "pea", isActive: true };
const OWN_CTO = { memberId: "me", accountType: "securities", isActive: true };

test("un membre peut enregistrer un achat sur son PEA / compte-titres actif", () => {
  assert.equal(authorizeMemberOperation({ account: OWN_PEA, viewerId: "me", type: "achat" }).ok, true);
  assert.equal(authorizeMemberOperation({ account: OWN_CTO, viewerId: "me", type: "achat" }).ok, true);
});

test("un membre ne peut PAS agir sur le compte d'un autre membre", () => {
  const result = authorizeMemberOperation({ account: { memberId: "someone-else", accountType: "pea", isActive: true }, viewerId: "me", type: "achat" });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
});

test("seul le type 'achat' est autorisé en libre-service", () => {
  for (const type of ["vente", "versement", "retrait", "dividende", "frais", "correction", "transfer_in"]) {
    const result = authorizeMemberOperation({ account: OWN_PEA, viewerId: "me", type });
    assert.equal(result.ok, false, `type ${type} devrait être refusé`);
    assert.equal(result.status, 400);
  }
});

test("un compte non PEA/compte-titres refuse l'achat en libre-service", () => {
  const result = authorizeMemberOperation({ account: { memberId: "me", accountType: "bank", isActive: true }, viewerId: "me", type: "achat" });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
});

test("un compte archivé refuse l'achat", () => {
  const result = authorizeMemberOperation({ account: { memberId: "me", accountType: "pea", isActive: false }, viewerId: "me", type: "achat" });
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
});

test("compte introuvable → 404", () => {
  const result = authorizeMemberOperation({ account: null, viewerId: "me", type: "achat" });
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
});

// ---- computeMonthlyPlanProgress (dérivée des achats réels) --------------------------------
let seq = 0;
function op(partial) {
  seq += 1;
  return { type: "achat", date: "2026-08-05", accountId: "acc-1", netAmount: 0, ...partial, id: `op-${seq}` };
}

test("un achat du mois civil alimente la progression ; versement/vente/mois précédent ignorés", () => {
  const operations = [
    op({ type: "achat", date: "2026-08-05", netAmount: 40 }),      // compte
    op({ type: "achat", date: "2026-07-30", netAmount: 100 }),     // mois précédent → ignoré
    op({ type: "versement", date: "2026-08-10", netAmount: 500 }), // versement → ignoré
    op({ type: "vente", date: "2026-08-12", netAmount: 60 }),      // vente → ignorée
  ];
  const progress = computeMonthlyPlanProgress({ operations, accountIds: ["acc-1"], monthlyTarget: 50, today: TODAY });
  assert.equal(progress.investedThisMonth, 40);
  assert.equal(progress.monthlyTarget, 50);
  assert.equal(progress.pct, 80);
  assert.equal(progress.status, "en_cours");
  assert.equal(progress.daysRemaining, 11); // août = 31 jours, 31 - 20
});

test("objectif atteint : pourcentage plafonné à 100", () => {
  const progress = computeMonthlyPlanProgress({ operations: [op({ netAmount: 60 })], accountIds: ["acc-1"], monthlyTarget: 50, today: TODAY });
  assert.equal(progress.investedThisMonth, 60);
  assert.equal(progress.pct, 100);
  assert.equal(progress.status, "atteint");
});

test("aucun achat ce mois : statut « à commencer »", () => {
  const progress = computeMonthlyPlanProgress({ operations: [], accountIds: ["acc-1"], monthlyTarget: 50, today: TODAY });
  assert.equal(progress.investedThisMonth, 0);
  assert.equal(progress.status, "a_commencer");
  assert.equal(progress.pct, 0);
});

test("filtre par compte cible : un achat sur un autre compte n'est pas compté", () => {
  const operations = [op({ accountId: "acc-2", netAmount: 200 })];
  const progress = computeMonthlyPlanProgress({ operations, accountIds: ["acc-1"], monthlyTarget: 50, today: TODAY });
  assert.equal(progress.investedThisMonth, 0);
});

test("sans objectif : montant investi calculé, mais aucun statut ni pourcentage", () => {
  const progress = computeMonthlyPlanProgress({ operations: [op({ netAmount: 40 })], accountIds: ["acc-1"], monthlyTarget: null, today: TODAY });
  assert.equal(progress.investedThisMonth, 40);
  assert.equal(progress.monthlyTarget, null);
  assert.equal(progress.pct, null);
  assert.equal(progress.status, null);
});

test("montant d'achat : repli brut puis quantité × prix quand net absent", () => {
  const operations = [
    op({ netAmount: null, grossAmount: 25 }),                          // → 25
    op({ netAmount: null, grossAmount: null, quantity: 2, unitPrice: 10 }), // → 20
  ];
  const progress = computeMonthlyPlanProgress({ operations, accountIds: null, monthlyTarget: 100, today: TODAY });
  assert.equal(progress.investedThisMonth, 45);
});
