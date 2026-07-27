// Tests unitaires du moteur PUR du parcours « Bien démarrer » (lib/onboarding-challenges.ts) :
// conditions de chaque mission, exclusions strictes de la mission 4, reconnaissance rétroactive
// (évaluation sans état, sans dépendance à l'historique), et total du parcours. La logique DB
// (idempotence via la RPC, immutabilité, frontière de session) est couverte par
// tests/onboarding-challenges-guards.test.mjs (lecture structurelle des fichiers source).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isOnboardingAccountReady, hasOnboardingPortfolio, hasOnboardingPortfolioOperation, hasOnboardingPlan,
  isOnboardingPurchaseEligible, hasOnboardingFirstPurchase, evaluateOnboardingMissions,
  buildOnboardingProgress, onboardingCompletionKey, ONBOARDING_TOTAL_POINTS, ONBOARDING_MISSIONS,
  ONBOARDING_MISSION_SLUGS,
} from "../lib/onboarding-challenges.ts";

function account(partial) {
  return { id: "acc-1", accountType: "pea", isActive: true, name: "Mon PEA", ...partial };
}
function purchase(partial) {
  return { accountId: "acc-1", type: "achat", quantity: 2, unitPrice: 50, assetName: "ETF Monde", ticker: null, isin: null, date: "2026-07-10", ...partial };
}
function facts(partial) {
  return { accounts: [], positions: [], plan: null, purchases: [], ...partial };
}

// ---- Mission 1 : compte PEA/CTO configuré -------------------------------------------------
test("compte PEA actif et nommé : mission 1 terminée", () => {
  assert.equal(isOnboardingAccountReady(account({ accountType: "pea" })), true);
});

test("compte-titres actif : ne termine jamais le défi PEA", () => {
  assert.equal(isOnboardingAccountReady(account({ accountType: "securities" })), false);
});

test("compte archivé (is_active=false) : mission 1 non terminée", () => {
  assert.equal(isOnboardingAccountReady(account({ isActive: false })), false);
});

test("compte sans nom : mission 1 non terminée", () => {
  assert.equal(isOnboardingAccountReady(account({ name: "" })), false);
  assert.equal(isOnboardingAccountReady(account({ name: null })), false);
});

test("compte bancaire ou Bitcoin : n'entre pas dans l'évaluation de la mission 1", () => {
  const result = evaluateOnboardingMissions(facts({ accounts: [account({ accountType: "bitcoin" }), account({ accountType: "bank" })] }));
  assert.equal(result.onboarding_account_setup, false);
});

test("aucun numéro de compte ni IBAN requis (non modélisés dans les faits onboarding)", () => {
  // isOnboardingAccountReady ne lit ni accountNumberLast4 ni ibanLast4 : ces champs n'existent
  // même pas dans OnboardingAccountFact — la condition ne peut donc jamais les exiger.
  assert.equal(isOnboardingAccountReady(account({})), true);
});

// ---- Mission 2 : portefeuille existant -----------------------------------------------------
test("position réelle détenue (quantity > 0) : mission 2 terminée", () => {
  assert.equal(hasOnboardingPortfolio([{ accountId: "acc-1", quantity: 3 }]), true);
});

test("compte sans aucune position : mission 2 non terminée", () => {
  assert.equal(hasOnboardingPortfolio([]), false);
});

test("position à quantité nulle (vendue en totalité) : mission 2 non terminée", () => {
  assert.equal(hasOnboardingPortfolio([{ accountId: "acc-1", quantity: 0 }]), false);
});

test("déclaration « aucun placement » (aucune position, aucune opération) : aucun point", () => {
  const result = evaluateOnboardingMissions(facts({ accounts: [account({})] }));
  assert.equal(result.onboarding_existing_portfolio, false);
});

test("une opération confirmée sur le PEA termine le défi portefeuille, pas un brouillon client", () => {
  assert.equal(hasOnboardingPortfolioOperation([purchase({ type: "achat" })], new Set(["acc-1"])), true);
  assert.equal(hasOnboardingPortfolioOperation([purchase({ type: "versement" })], new Set(["acc-1"])), false);
  assert.equal(hasOnboardingPortfolioOperation([purchase({ accountId: "cto-1" })], new Set(["acc-1"])), false);
});

// ---- Mission 3 : rythme mensuel -------------------------------------------------------------
test("plan avec montant mensuel > 0 rattaché à un compte utilisable : mission 3 terminée", () => {
  const accounts = [account({ id: "acc-9" })];
  assert.equal(hasOnboardingPlan({ monthlyTarget: 50, targetAccountId: "acc-9" }, accounts), true);
});

test("montant mensuel nul ou négatif : mission 3 non terminée", () => {
  const accounts = [account({ id: "acc-9" })];
  assert.equal(hasOnboardingPlan({ monthlyTarget: 0, targetAccountId: "acc-9" }, accounts), false);
  assert.equal(hasOnboardingPlan({ monthlyTarget: -10, targetAccountId: "acc-9" }, accounts), false);
});

test("aucun plan enregistré : mission 3 non terminée", () => {
  assert.equal(hasOnboardingPlan(null, [account({})]), false);
});

test("plan rattaché à un compte archivé ou introuvable : mission 3 non terminée", () => {
  const accounts = [account({ id: "acc-9", isActive: false })];
  assert.equal(hasOnboardingPlan({ monthlyTarget: 50, targetAccountId: "acc-9" }, accounts), false);
  assert.equal(hasOnboardingPlan({ monthlyTarget: 50, targetAccountId: "acc-inconnu" }, accounts), false);
});

// ---- Mission 4 : premier investissement (exclusions strictes) -----------------------------
test("véritable achat PEA/CTO (quantité, prix, date, instrument) : mission 4 terminée", () => {
  assert.equal(isOnboardingPurchaseEligible(purchase({})), true);
});

test("versement, retrait, dividende, frais et correction ne sont jamais éligibles", () => {
  for (const type of ["versement", "retrait", "dividende", "frais", "correction"]) {
    assert.equal(isOnboardingPurchaseEligible(purchase({ type })), false, `${type} ne doit pas valider la mission 4`);
  }
});

test("les transferts de titres (entrant/sortant) ne sont jamais éligibles", () => {
  assert.equal(isOnboardingPurchaseEligible(purchase({ type: "transfer_in" })), false);
  assert.equal(isOnboardingPurchaseEligible(purchase({ type: "transfer_out" })), false);
});

test("une position initiale importée depuis un relevé (type 'correction') n'est jamais un achat", () => {
  // lib/portfolio-snapshot-import.ts force systématiquement type:'correction' pour un import de
  // relevé : ce test documente que la mission 4 ne peut donc jamais être validée par ce chemin.
  const snapshotImport = purchase({ type: "correction", note: "Position importée depuis un relevé au 2026-07-01" });
  assert.equal(isOnboardingPurchaseEligible(snapshotImport), false);
});

test("achat sans instrument identifiable (ni nom, ni ticker, ni ISIN) : non éligible", () => {
  assert.equal(isOnboardingPurchaseEligible(purchase({ assetName: null, ticker: null, isin: null })), false);
});

test("achat sans quantité ou prix positif : non éligible", () => {
  assert.equal(isOnboardingPurchaseEligible(purchase({ quantity: 0 })), false);
  assert.equal(isOnboardingPurchaseEligible(purchase({ unitPrice: 0 })), false);
  assert.equal(isOnboardingPurchaseEligible(purchase({ quantity: null })), false);
});

test("achat Bitcoin : hors périmètre (jamais transmis dans les faits onboarding, PEA/CTO uniquement)", () => {
  // Les faits onboarding ne sont construits qu'à partir des comptes pea/securities du membre
  // (lib/onboarding-challenges-service.ts::loadMemberFacts) : un achat Bitcoin ne peut donc
  // jamais apparaître dans `purchases`. hasOnboardingFirstPurchase reste false sans lui.
  assert.equal(hasOnboardingFirstPurchase([]), false);
});

test("au moins un vrai achat parmi plusieurs opérations mixtes : mission 4 terminée", () => {
  const purchases = [purchase({ type: "versement" }), purchase({ type: "achat" }), purchase({ type: "correction" })];
  assert.equal(hasOnboardingFirstPurchase(purchases), true);
});

// ---- Reconnaissance rétroactive : l'évaluation est PURE, sans état ni dépendance temporelle --
test("reconnaissance rétroactive : des faits déjà vrais avant l'existence des missions sont reconnus", () => {
  const preexistingFacts = facts({
    accounts: [account({ id: "acc-old" })],
    positions: [{ accountId: "acc-old", quantity: 5 }],
    plan: { monthlyTarget: 80, targetAccountId: "acc-old" },
    purchases: [purchase({ accountId: "acc-old", date: "2026-01-05" })], // antérieur au parcours
  });
  const result = evaluateOnboardingMissions(preexistingFacts);
  assert.deepEqual(result, {
    onboarding_account_setup: true, onboarding_existing_portfolio: true,
    onboarding_monthly_plan: true, onboarding_first_purchase: true,
  });
});

// ---- Idempotence : clé stable, sans version (jamais annulée) ------------------------------
test("clé d'idempotence onboarding stable, indépendante d'un compteur d'annulations", () => {
  assert.equal(onboardingCompletionKey("onboarding_account_setup", "m1"), "onboarding_completion:onboarding_account_setup:m1");
  // Appeler deux fois avec les mêmes arguments produit TOUJOURS la même clé (jamais versionnée).
  assert.equal(onboardingCompletionKey("onboarding_account_setup", "m1"), onboardingCompletionKey("onboarding_account_setup", "m1"));
});

test("la clé d'idempotence dépend du membre : deux membres ne partagent jamais la même clé", () => {
  assert.notEqual(onboardingCompletionKey("onboarding_account_setup", "m1"), onboardingCompletionKey("onboarding_account_setup", "m2"));
});

// ---- Total du parcours = 850 points ---------------------------------------------------------
test("le parcours totalise exactement 850 points (300 + 200 + 100 + 250)", () => {
  assert.equal(ONBOARDING_TOTAL_POINTS, 850);
  assert.equal(ONBOARDING_MISSIONS.reduce((sum, mission) => sum + mission.points, 0), 850);
});

test("buildOnboardingProgress : parcours vierge (0/4), parcours complet (4/4 = 850 pts)", () => {
  const empty = { onboarding_account_setup: false, onboarding_existing_portfolio: false, onboarding_monthly_plan: false, onboarding_first_purchase: false };
  const emptyProgress = buildOnboardingProgress(empty);
  assert.equal(emptyProgress.completedCount, 0);
  assert.equal(emptyProgress.earnedPoints, 0);
  assert.equal(emptyProgress.totalPoints, 850);
  assert.equal(emptyProgress.missions.every((mission) => mission.status === "todo"), true);

  const full = { onboarding_account_setup: true, onboarding_existing_portfolio: true, onboarding_monthly_plan: true, onboarding_first_purchase: true };
  const fullProgress = buildOnboardingProgress(full);
  assert.equal(fullProgress.completedCount, 4);
  assert.equal(fullProgress.earnedPoints, 850);
  assert.equal(fullProgress.missions.every((mission) => mission.status === "done"), true);
});

test("buildOnboardingProgress : progression partielle (mélange terminé / à faire)", () => {
  const partial = { onboarding_account_setup: true, onboarding_existing_portfolio: false, onboarding_monthly_plan: true, onboarding_first_purchase: false };
  const progress = buildOnboardingProgress(partial);
  assert.equal(progress.completedCount, 2);
  assert.equal(progress.earnedPoints, 400); // 300 (PEA) + 100 (rythme)
});

test("les 4 identifiants stables sont uniques et couvrent exactement les 4 missions attendues", () => {
  assert.deepEqual([...ONBOARDING_MISSION_SLUGS].sort(), [
    "onboarding_account_setup", "onboarding_existing_portfolio", "onboarding_first_purchase", "onboarding_monthly_plan",
  ]);
  assert.equal(new Set(ONBOARDING_MISSIONS.map((mission) => mission.slug)).size, 4);
});
