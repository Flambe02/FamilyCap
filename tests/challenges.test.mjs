// Tests unitaires du moteur PUR des Défis (lib/challenges.ts) : éligibilité des achats,
// progression, clés d'idempotence, validation/transitions admin, classement (sans montants) et
// états membre. La logique DB (gel de l'objectif, unicité, idempotence transactionnelle, RLS) est
// garantie par le schéma (contraintes UNIQUE / idempotency_key) + les routes serveur et validée
// par le build ; on teste ici les règles décidables sans base.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isPurchaseEligible, computeChallengeProgress, completionKey, reversalKey, resolvePointsAction, buildLeaderboard,
  validateChallengeInput, canTransition, rankLeaderboard, compareLeaderboard, memberChallengeState,
  effectiveWindowStart, deriveChallengeLevel, calculateMonthlyStreak,
} from "../lib/challenges.ts";

const WINDOW = { startsOn: "2026-07-01", endsOn: "2026-07-31", eligibleInstrumentTypes: ["etf", "stock"] };
const PART = { memberId: "me", targetAccountId: "acc-1" };
function op(partial) {
  return { memberId: "me", accountId: "acc-1", type: "achat", date: "2026-07-10", netAmount: 40, assetType: "etf", ...partial };
}

// ---- Détection des achats éligibles ------------------------------------------------------
test("un achat du mois sur le compte cible est éligible (montant = net)", () => {
  const verdict = isPurchaseEligible(op({ netAmount: 40 }), PART, WINDOW);
  assert.equal(verdict.eligible, true);
  assert.equal(verdict.amount, 40);
});

test("plusieurs achats éligibles s'additionnent", () => {
  const amounts = [op({ netAmount: 40 }), op({ netAmount: 60 })].map((o) => isPurchaseEligible(o, PART, WINDOW).amount);
  const progress = computeChallengeProgress(amounts, 100);
  assert.equal(progress.invested, 100);
});

test("un achat hors période ne compte pas", () => {
  assert.equal(isPurchaseEligible(op({ date: "2026-06-30" }), PART, WINDOW).eligible, false);
  assert.equal(isPurchaseEligible(op({ date: "2026-08-01" }), PART, WINDOW).eligible, false);
});

test("un achat sur un autre compte ne compte pas", () => {
  assert.equal(isPurchaseEligible(op({ accountId: "acc-2" }), PART, WINDOW).eligible, false);
});

test("une vente ne compte pas", () => {
  assert.equal(isPurchaseEligible(op({ type: "vente" }), PART, WINDOW).eligible, false);
});

test("un versement ne compte pas", () => {
  assert.equal(isPurchaseEligible(op({ type: "versement" }), PART, WINDOW).eligible, false);
});

test("un achat d'un autre membre ne compte pas", () => {
  assert.equal(isPurchaseEligible(op({ memberId: "someone-else" }), PART, WINDOW).eligible, false);
});

test("un instrument non éligible (obligation) est écarté", () => {
  assert.equal(isPurchaseEligible(op({ assetType: "bond" }), PART, WINDOW).eligible, false);
});

test("un instrument inconnu (type non identifié) est écarté — règle stricte", () => {
  const verdict = isPurchaseEligible(op({ assetType: null }), PART, WINDOW);
  assert.equal(verdict.eligible, false);
  assert.equal(verdict.reason, "instrument_unknown");
});

test("sans compte cible, rien n'est éligible", () => {
  assert.equal(isPurchaseEligible(op({}), { memberId: "me", targetAccountId: null }, WINDOW).eligible, false);
});

test("montant d'achat : repli brut puis quantité × prix", () => {
  assert.equal(isPurchaseEligible(op({ netAmount: null, grossAmount: 25 }), PART, WINDOW).amount, 25);
  assert.equal(isPurchaseEligible(op({ netAmount: null, grossAmount: null, quantity: 2, unitPrice: 10 }), PART, WINDOW).amount, 20);
});

// ---- Progression / validation ------------------------------------------------------------
test("atteindre 100 % termine le défi", () => {
  const progress = computeChallengeProgress([50, 50], 100);
  assert.equal(progress.completed, true);
  assert.equal(progress.pct, 100);
});

test("dépasser 100 % plafonne l'affichage à 100 %", () => {
  const progress = computeChallengeProgress([150], 100);
  assert.equal(progress.pct, 100);
  assert.equal(progress.completed, true);
  assert.ok(progress.ratio > 1);
});

test("en dessous de l'objectif : non terminé", () => {
  const progress = computeChallengeProgress([40], 100);
  assert.equal(progress.completed, false);
  assert.equal(progress.pct, 40);
});

// ---- Idempotence des points --------------------------------------------------------------
test("clés de complétion déterministes et versionnées", () => {
  assert.equal(completionKey("c1", "m1", 0), "challenge_completion:c1:m1:v0");
  assert.notEqual(completionKey("c1", "m1", 0), completionKey("c1", "m1", 1));
});

test("clé d'annulation distincte de la complétion", () => {
  assert.notEqual(reversalKey("c1", "m1", 0), completionKey("c1", "m1", 0));
  assert.equal(reversalKey("c1", "m1", 0), "challenge_reversal:c1:m1:v0");
});

// ---- Décision d'attribution (résout award / reverse / none) -------------------------------
test("attribue quand terminé et non encore attribué", () => {
  assert.deepEqual(resolvePointsAction({ progressCompleted: true, completionCount: 0, reversalCount: 0 }), { action: "award", version: 0 });
});

test("deux tentatives d'attribution → même clé (une seule écriture positive)", () => {
  // Deux réconciliations concurrentes voient le même état (0/0) → même version → même clé → dédup.
  const a = resolvePointsAction({ progressCompleted: true, completionCount: 0, reversalCount: 0 });
  const b = resolvePointsAction({ progressCompleted: true, completionCount: 0, reversalCount: 0 });
  assert.equal(completionKey("c", "m", a.version), completionKey("c", "m", b.version));
});

test("déjà attribué → aucune nouvelle attribution", () => {
  assert.equal(resolvePointsAction({ progressCompleted: true, completionCount: 1, reversalCount: 0 }).action, "none");
});

test("passe sous l'objectif après attribution → une annulation, puis plus rien", () => {
  // Attribué (1/0) et sous l'objectif → une annulation (version 0).
  assert.deepEqual(resolvePointsAction({ progressCompleted: false, completionCount: 1, reversalCount: 0 }), { action: "reverse", version: 0 });
  // Après l'annulation (1/1) et toujours sous l'objectif → AUCUNE seconde compensation.
  assert.equal(resolvePointsAction({ progressCompleted: false, completionCount: 1, reversalCount: 1 }).action, "none");
});

test("re-complétion après annulation → version distincte (nouveaux points légitimes)", () => {
  assert.deepEqual(resolvePointsAction({ progressCompleted: true, completionCount: 1, reversalCount: 1 }), { action: "award", version: 1 });
  assert.notEqual(completionKey("c", "m", 0), completionKey("c", "m", 1));
});

// ---- buildLeaderboard : opt-out et confidentialité ---------------------------------------
test("buildLeaderboard exclut les membres opt-out et ne renvoie aucun montant", () => {
  const rows = buildLeaderboard([
    { memberId: "a", name: "A", photoUrl: null, points: 300, defisCompleted: 1, lastPointsAt: "2026-07-10", optIn: true },
    { memberId: "b", name: "B", photoUrl: null, points: 500, defisCompleted: 1, lastPointsAt: "2026-07-11", optIn: false },
    { memberId: "c", name: "C", photoUrl: null, points: 100, defisCompleted: 1, lastPointsAt: "2026-07-12", optIn: true },
  ]);
  assert.deepEqual(rows.map((row) => row.memberId), ["a", "c"]); // b (opt-out) absent
  assert.deepEqual(rows.map((row) => row.rank), [1, 2]);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ["challengesCompleted", "memberId", "name", "photoUrl", "points", "rank"]);
    for (const forbidden of ["invested", "target", "targetAmount", "monthlyTarget", "amount", "value", "account", "optIn", "lastPointsAt"]) {
      assert.equal(forbidden in row, false, `le classement public ne doit pas exposer ${forbidden}`);
    }
  }
});

// ---- Validation & transitions admin ------------------------------------------------------
test("un défi valide est normalisé", () => {
  const result = validateChallengeInput({ title: "  Mon cap  ", startsOn: "2026-07-01", endsOn: "2026-07-31", pointsReward: 300 });
  assert.equal(result.ok, true);
  assert.equal(result.value.title, "Mon cap");
  assert.equal(result.value.challengeType, "monthly_investment");
  assert.deepEqual(result.value.eligibleAccountTypes, ["pea", "securities"]);
});

test("titre obligatoire ; fin avant début refusée ; points hors 1..1000 refusés", () => {
  assert.equal(validateChallengeInput({ title: "", startsOn: "2026-07-01", endsOn: "2026-07-31" }).ok, false);
  assert.equal(validateChallengeInput({ title: "X", startsOn: "2026-07-31", endsOn: "2026-07-01" }).ok, false);
  assert.equal(validateChallengeInput({ title: "X", startsOn: "2026-07-01", endsOn: "2026-07-31", pointsReward: 0 }).ok, false);
  assert.equal(validateChallengeInput({ title: "X", startsOn: "2026-07-01", endsOn: "2026-07-31", pointsReward: 1001 }).ok, false);
});

test("types éligibles nettoyés (valeurs inconnues ignorées, défaut si vide)", () => {
  const result = validateChallengeInput({ title: "X", startsOn: "2026-07-01", endsOn: "2026-07-31", eligibleAccountTypes: ["pea", "bitcoin"], eligibleInstrumentTypes: [] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.eligibleAccountTypes, ["pea"]);
  assert.deepEqual(result.value.eligibleInstrumentTypes, ["etf", "stock"]);
});

test("transitions de statut", () => {
  assert.equal(canTransition("draft", "active"), true);
  assert.equal(canTransition("active", "completed"), true);
  assert.equal(canTransition("completed", "archived"), true);
  assert.equal(canTransition("active", "draft"), false);
});

test("un défi archivé ou terminé se réactive (désarchivage en place)", () => {
  assert.equal(canTransition("archived", "active"), true);
  assert.equal(canTransition("archived", "draft"), true); // rouvre l'édition du contenu
  assert.equal(canTransition("archived", "scheduled"), true);
  assert.equal(canTransition("completed", "active"), true);
  // Un défi actif ne redevient jamais brouillon directement : il faut le terminer ou l'archiver.
  assert.equal(canTransition("active", "scheduled"), false);
});

// ---- Défis SANS DATE (permanents) --------------------------------------------------------
test("un défi sans aucune date est valide (permanent) et les dates ressortent à null", () => {
  const result = validateChallengeInput({ title: "Mon cap continu", pointsReward: 300 });
  assert.equal(result.ok, true);
  assert.equal(result.value.startsOn, null);
  assert.equal(result.value.endsOn, null);
});

test("des dates vides valent absence de date (permanent)", () => {
  const result = validateChallengeInput({ title: "X", startsOn: "", endsOn: "" });
  assert.equal(result.ok, true);
  assert.equal(result.value.startsOn, null);
});

test("une seule des deux dates est refusée (période ambiguë)", () => {
  assert.equal(validateChallengeInput({ title: "X", startsOn: "2026-07-01" }).ok, false);
  assert.equal(validateChallengeInput({ title: "X", endsOn: "2026-07-31" }).ok, false);
  assert.equal(validateChallengeInput({ title: "X", startsOn: "2026-07-01", endsOn: null }).ok, false);
});

test("une date mal formée est refusée", () => {
  assert.equal(validateChallengeInput({ title: "X", startsOn: "01/07/2026", endsOn: "31/07/2026" }).ok, false);
});

test("fenêtre effective : date du défi si datée, date d'inscription si permanent", () => {
  assert.equal(effectiveWindowStart("2026-07-01", "2026-07-20"), "2026-07-01");
  assert.equal(effectiveWindowStart(null, "2026-07-20"), "2026-07-20");
  assert.equal(effectiveWindowStart(null, null), null); // inconnu → l'appelant doit refuser
});

test("défi permanent : les achats ANTÉRIEURS à l'inscription ne comptent pas", () => {
  const permanent = { startsOn: null, endsOn: null, eligibleInstrumentTypes: ["etf", "stock"] };
  const joined = { memberId: "me", targetAccountId: "acc-1", joinedOn: "2026-07-15" };
  assert.equal(isPurchaseEligible(op({ date: "2026-07-14" }), joined, permanent).eligible, false);
  assert.equal(isPurchaseEligible(op({ date: "2026-07-15" }), joined, permanent).eligible, true); // borne incluse
  assert.equal(isPurchaseEligible(op({ date: "2027-03-02" }), joined, permanent).eligible, true); // aucune échéance
});

test("défi permanent sans date d'inscription connue : achat refusé (fail-closed)", () => {
  const permanent = { startsOn: null, endsOn: null, eligibleInstrumentTypes: ["etf", "stock"] };
  const verdict = isPurchaseEligible(op({}), { memberId: "me", targetAccountId: "acc-1" }, permanent);
  assert.equal(verdict.eligible, false);
  assert.equal(verdict.reason, "no_join_date");
});

test("défi daté : la date d'inscription ne restreint PAS la période du défi", () => {
  // Rejoindre en cours de mois n'annule pas les achats déjà faits dans la période annoncée.
  const late = { memberId: "me", targetAccountId: "acc-1", joinedOn: "2026-07-28" };
  assert.equal(isPurchaseEligible(op({ date: "2026-07-10" }), late, WINDOW).eligible, true);
});

// ---- Classement (ordre, départage, aucune donnée privée) ---------------------------------
test("classement : tri par points décroissants", () => {
  const ranked = rankLeaderboard([
    { memberId: "a", points: 100, defisCompleted: 1, lastPointsAt: "2026-07-10" },
    { memberId: "b", points: 300, defisCompleted: 1, lastPointsAt: "2026-07-11" },
    { memberId: "c", points: 200, defisCompleted: 1, lastPointsAt: "2026-07-12" },
  ]);
  assert.deepEqual(ranked.map((row) => row.memberId), ["b", "c", "a"]);
  assert.deepEqual(ranked.map((row) => row.rank), [1, 2, 3]);
});

test("départage : défis terminés puis régularité (derniers points les plus tôt)", () => {
  // Points égaux : plus de défis terminés d'abord.
  assert.equal(compareLeaderboard(
    { memberId: "a", points: 100, defisCompleted: 2, lastPointsAt: "2026-07-20" },
    { memberId: "b", points: 100, defisCompleted: 1, lastPointsAt: "2026-07-01" },
  ), 0);
  // Points + défis égaux : celui qui a fini le plus tôt d'abord.
  assert.equal(compareLeaderboard(
    { memberId: "a", points: 100, defisCompleted: 1, lastPointsAt: "2026-07-05" },
    { memberId: "b", points: 100, defisCompleted: 1, lastPointsAt: "2026-07-20" },
  ), 0);
});

test("égalité parfaite → ex æquo (même rang)", () => {
  const ranked = rankLeaderboard([
    { memberId: "a", points: 100, defisCompleted: 1, lastPointsAt: "2026-07-10" },
    { memberId: "b", points: 100, defisCompleted: 1, lastPointsAt: "2026-07-10" },
  ]);
  assert.equal(ranked[0].rank, ranked[1].rank);
});

test("le classement n'expose aucun montant privé", () => {
  const [row] = rankLeaderboard([{ memberId: "a", points: 100, defisCompleted: 1, lastPointsAt: "2026-07-10" }]);
  const keys = Object.keys(row).sort();
  assert.deepEqual(keys, ["defisCompleted", "lastPointsAt", "memberId", "points", "rank"]);
  for (const forbidden of ["invested", "target", "targetAmount", "monthlyTarget", "amount", "value", "portfolio"]) {
    assert.equal(forbidden in row, false, `le classement ne doit pas exposer ${forbidden}`);
  }
});

// ---- États membre ------------------------------------------------------------------------
test("état membre selon le contexte", () => {
  const base = { challengeStatus: "active", participantStatus: null };
  assert.equal(memberChallengeState({ ...base, hasPlan: false, hasTargetAccount: false, isParticipant: false }), "no_plan");
  assert.equal(memberChallengeState({ ...base, hasPlan: true, hasTargetAccount: false, isParticipant: false }), "no_account");
  assert.equal(memberChallengeState({ ...base, hasPlan: true, hasTargetAccount: true, isParticipant: false }), "ready_to_join");
  assert.equal(memberChallengeState({ ...base, hasPlan: true, hasTargetAccount: true, isParticipant: true, participantStatus: "in_progress" }), "in_progress");
  assert.equal(memberChallengeState({ ...base, hasPlan: true, hasTargetAccount: true, isParticipant: true, participantStatus: "completed" }), "completed");
  assert.equal(memberChallengeState({ challengeStatus: "completed", participantStatus: null, hasPlan: true, hasTargetAccount: true, isParticipant: true }), "challenge_ended");
});

test("levels and progression are derived from cumulative points", () => {
  assert.deepEqual(deriveChallengeLevel(0), { level: "Découverte", nextLevel: "Premiers pas", nextLevelAt: 100, levelProgressPct: 0 });
  assert.equal(deriveChallengeLevel(100).level, "Premiers pas");
  assert.equal(deriveChallengeLevel(899).nextLevel, "Bâtisseur");
  assert.equal(deriveChallengeLevel(900).level, "Bâtisseur");
  assert.deepEqual(deriveChallengeLevel(1600), { level: "Stratège", nextLevel: null, nextLevelAt: null, levelProgressPct: 100 });
});

test("monthly streak only counts consecutive completed monthly challenges", () => {
  const challenges = [
    { id: "jul", challengeType: "monthly_investment", startsOn: "2026-07-01", endsOn: "2026-07-31" },
    { id: "jun", challengeType: "monthly_investment", startsOn: "2026-06-01", endsOn: "2026-06-30" },
    { id: "onboarding", challengeType: "onboarding_mission", startsOn: null, endsOn: null },
  ];
  assert.equal(calculateMonthlyStreak([{ challengeId: "jul", points: 300 }, { challengeId: "jun", points: 300 }, { challengeId: "onboarding", points: 250 }], challenges), 2);
});

test("monthly streak ignores a month cancelled by challenge reversal", () => {
  const challenges = [
    { id: "jul", challengeType: "monthly_investment", startsOn: "2026-07-01", endsOn: "2026-07-31" },
    { id: "jun", challengeType: "monthly_investment", startsOn: "2026-06-01", endsOn: "2026-06-30" },
  ];
  assert.equal(calculateMonthlyStreak([{ challengeId: "jul", points: 300 }, { challengeId: "jun", points: 300 }, { challengeId: "jun", points: -300 }], challenges), 1);
});

test("opt-in zero member remains ranked and opt-out is excluded", () => {
  const board = buildLeaderboard([
    { memberId: "a", name: "Alice", photoUrl: null, points: 20, defisCompleted: 1, lastPointsAt: null, optIn: true },
    { memberId: "b", name: "Bruno", photoUrl: null, points: 0, defisCompleted: 0, lastPointsAt: null, optIn: true },
    { memberId: "c", name: "Claire", photoUrl: null, points: 50, defisCompleted: 1, lastPointsAt: null, optIn: false },
  ]);
  assert.deepEqual(board.map((row) => [row.memberId, row.rank]), [["a", 1], ["b", 2]]);
});
