// Tests unitaires de la logique PURE d'onboarding (lib/onboarding/onboarding-state.ts).
// Exécution : `node --test tests/onboarding-state.test.mjs` (Node ≥ 22.18 / 24 : type-stripping natif).
// Couvre : étape initiale par statut, reprise, report, achèvement, montée de version, garde d'accès
// (admin / aperçu / membre), progression, navigation bornée.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isOnboarded,
  determineInitialStep,
  nextIncompleteStep,
  resolveGate,
  progressFor,
  nextStep,
  previousStep,
  withStepCompleted,
  defaultOnboardingState,
  CURRENT_ONBOARDING_VERSION,
} from "../lib/onboarding/onboarding-state.ts";

function state(partial) {
  return { ...defaultOnboardingState(), ...partial };
}

/* ---- Étape initiale ---- */
test("jamais commencé → bienvenue", () => {
  assert.equal(determineInitialStep(state({ status: "not_started" })), "welcome");
});

test("en cours → l'étape enregistrée (reprise après rechargement)", () => {
  assert.equal(determineInitialStep(state({ status: "in_progress", currentStep: "modules" })), "modules");
});

test("en cours sans étape enregistrée → 1re étape non complétée", () => {
  assert.equal(determineInitialStep(state({ status: "in_progress", currentStep: null, completedSteps: ["welcome", "profile"] })), "modules");
});

test("reporté → reprise à l'endroit laissé", () => {
  assert.equal(determineInitialStep(state({ status: "deferred", currentStep: "privacy" })), "privacy");
});

test("terminé, version courante → écran de fin", () => {
  assert.equal(determineInitialStep(state({ status: "completed", version: CURRENT_ONBOARDING_VERSION, completedSteps: ["welcome", "profile", "modules", "privacy"] })), "completion");
});

test("terminé mais version ancienne → 1re nouvelle étape à faire (montée de version)", () => {
  assert.equal(determineInitialStep(state({ status: "completed", version: 0, completedSteps: ["welcome", "profile"] })), "modules");
});

/* ---- Statut « onboardé » ---- */
test("onboardé : terminé + version couvrant la version courante", () => {
  assert.equal(isOnboarded(state({ status: "completed", version: CURRENT_ONBOARDING_VERSION })), true);
});

test("non onboardé : terminé mais version antérieure (une nouvelle étape existe)", () => {
  assert.equal(isOnboarded(state({ status: "completed", version: CURRENT_ONBOARDING_VERSION - 1 })), false);
});

test("non onboardé : reporté", () => {
  assert.equal(isOnboarded(state({ status: "deferred" })), false);
});

/* ---- Garde d'accès ---- */
test("admin → jamais de tunnel", () => {
  assert.equal(resolveGate({ isAdmin: true, isPreview: false, state: state({ status: "not_started" }) }), "dashboard");
});

test("aperçu admin → jamais de tunnel (n'écrit rien chez le membre)", () => {
  assert.equal(resolveGate({ isAdmin: false, isPreview: true, state: state({ status: "not_started" }) }), "dashboard");
});

test("membre jamais commencé → tunnel", () => {
  assert.equal(resolveGate({ isAdmin: false, isPreview: false, state: state({ status: "not_started" }) }), "onboarding");
});

test("membre en cours → tunnel (reprise)", () => {
  assert.equal(resolveGate({ isAdmin: false, isPreview: false, state: state({ status: "in_progress", currentStep: "profile" }) }), "onboarding");
});

test("membre reporté → tableau de bord (pas de harcèlement)", () => {
  assert.equal(resolveGate({ isAdmin: false, isPreview: false, state: state({ status: "deferred" }) }), "dashboard");
});

test("membre terminé → tableau de bord", () => {
  assert.equal(resolveGate({ isAdmin: false, isPreview: false, state: state({ status: "completed", version: CURRENT_ONBOARDING_VERSION }) }), "dashboard");
});

/* ---- Navigation & progression ---- */
test("1re étape non complétée : toutes faites → completion", () => {
  assert.equal(nextIncompleteStep(state({ completedSteps: ["welcome", "profile", "modules", "privacy"] })), "completion");
});

test("étape suivante / précédente bornées", () => {
  assert.equal(nextStep("welcome"), "profile");
  assert.equal(nextStep("completion"), "completion");
  assert.equal(previousStep("welcome"), "welcome");
  assert.equal(previousStep("modules"), "profile");
});

test("progression : bienvenue numérotée 1/4", () => {
  const p = progressFor("welcome");
  assert.equal(p.current, 1);
  assert.equal(p.total, 4);
  assert.equal(p.numbered, true);
});

test("progression : confidentialité = 4/4", () => {
  const p = progressFor("privacy");
  assert.equal(p.current, 4);
  assert.equal(p.total, 4);
});

test("progression : écran de fin non numéroté, barre pleine", () => {
  const p = progressFor("completion");
  assert.equal(p.numbered, false);
  assert.equal(p.ratio, 1);
});

test("withStepCompleted : ajoute puis idempotent", () => {
  const once = withStepCompleted(state({ completedSteps: [] }), "profile");
  assert.deepEqual(once.completedSteps, ["profile"]);
  const twice = withStepCompleted(once, "profile");
  assert.deepEqual(twice.completedSteps, ["profile"]);
});
