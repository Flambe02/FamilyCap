// Logique PURE + constantes de l'onboarding : étape initiale, statut « onboardé », progression,
// navigation. Ce module ne dépend d'AUCUN import runtime — les types sont importés en `import type`
// (effacés à la compilation). Il reste ainsi testable en isolation (node --test) et sert de source
// unique des constantes, ré-exportées par onboarding-types pour le reste de l'application.

import type {
  OnboardingModule,
  OnboardingState,
  OnboardingStep,
} from "./onboarding-types";

// Version courante du parcours. Un futur incrément pourra n'ajouter qu'une étape sans forcer
// tous les membres à tout recommencer (cf. `isOnboarded` + `nextIncompleteStep`).
export const CURRENT_ONBOARDING_VERSION = 1;

// Étapes principales de la barre de progression (hors « completion »).
export const PRINCIPAL_STEPS: OnboardingStep[] = ["welcome", "profile", "modules", "privacy"];

// Ordre complet des étapes, utilisé pour la navigation et la reprise.
export const STEP_ORDER: OnboardingStep[] = ["welcome", "profile", "modules", "privacy", "completion"];

export const ONBOARDING_MODULES: OnboardingModule[] = ["gifts", "bitcoin", "pea", "cto"];

export function defaultOnboardingState(): OnboardingState {
  return {
    version: CURRENT_ONBOARDING_VERSION,
    status: "not_started",
    currentStep: null,
    completedSteps: [],
    selectedModules: [],
    privacyChoice: null,
    adminCanEdit: false,
    startedAt: null,
    completedAt: null,
    deferredAt: null,
    updatedAt: null,
  };
}

// Un membre est « onboardé » pour cette version si le parcours est terminé ET que la version
// enregistrée couvre la version courante. Un futur incrément de version repassera à `false`.
export function isOnboarded(state: OnboardingState): boolean {
  return state.status === "completed" && state.version >= CURRENT_ONBOARDING_VERSION;
}

// Première étape non encore complétée dans l'ordre du tunnel (hors « completion »).
export function nextIncompleteStep(state: OnboardingState): OnboardingStep {
  const done = new Set(state.completedSteps);
  for (const step of PRINCIPAL_STEPS) {
    if (!done.has(step)) return step;
  }
  return "completion";
}

// Étape à afficher à l'ouverture du tunnel obligatoire, selon l'état persistant :
//  - jamais commencé            → welcome ;
//  - en cours                   → l'étape enregistrée, sinon la 1re non complétée (reprise) ;
//  - reporté                    → reprise à l'endroit laissé (n'ouvre le tunnel que sur relance) ;
//  - terminé (version ancienne) → 1re nouvelle étape non complétée (montée de version).
export function determineInitialStep(state: OnboardingState): OnboardingStep {
  if (state.status === "not_started") return "welcome";
  if (state.status === "completed") {
    return state.version >= CURRENT_ONBOARDING_VERSION ? "completion" : nextIncompleteStep(state);
  }
  if (state.currentStep && STEP_ORDER.includes(state.currentStep)) return state.currentStep;
  return nextIncompleteStep(state);
}

// Décision de la garde d'accès (aucune redirection dispersée : une seule source de vérité).
//  - admin ou aperçu           → jamais de tunnel obligatoire ;
//  - onboardé ou reporté       → application (le report affiche une carte de reprise, pas le tunnel) ;
//  - sinon                     → tunnel obligatoire.
export type GateDecision = "dashboard" | "onboarding";

export function resolveGate(input: { isAdmin: boolean; isPreview: boolean; state: OnboardingState }): GateDecision {
  if (input.isAdmin || input.isPreview) return "dashboard";
  if (isOnboarded(input.state)) return "dashboard";
  if (input.state.status === "deferred") return "dashboard";
  return "onboarding";
}

export function stepIndex(step: OnboardingStep): number {
  return STEP_ORDER.indexOf(step);
}

// Étape suivante / précédente dans l'ordre du tunnel (bornées).
export function nextStep(step: OnboardingStep): OnboardingStep {
  const index = stepIndex(step);
  return STEP_ORDER[Math.min(index + 1, STEP_ORDER.length - 1)];
}

export function previousStep(step: OnboardingStep): OnboardingStep {
  const index = stepIndex(step);
  return STEP_ORDER[Math.max(index - 1, 0)];
}

// Progression pour la barre / le libellé « Étape n sur N » (le compteur ne couvre que les
// étapes principales ; « completion » affiche une barre pleine sans numéro).
export function progressFor(step: OnboardingStep): { current: number; total: number; ratio: number; numbered: boolean } {
  const total = PRINCIPAL_STEPS.length;
  const principalIndex = PRINCIPAL_STEPS.indexOf(step);
  if (principalIndex === -1) {
    // completion (ou étape hors liste) : parcours abouti.
    return { current: total, total, ratio: 1, numbered: false };
  }
  const current = principalIndex + 1;
  return { current, total, ratio: current / total, numbered: true };
}

// Fusionne des changements dans un état, en marquant l'étape courante comme complétée quand on
// avance. Pur : renvoie un nouvel état, ne mute pas l'entrée.
export function withStepCompleted(state: OnboardingState, step: OnboardingStep): OnboardingState {
  if (state.completedSteps.includes(step)) return state;
  return { ...state, completedSteps: [...state.completedSteps, step] };
}
