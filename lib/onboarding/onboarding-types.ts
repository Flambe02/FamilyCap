// Types partagés de l'onboarding (serveur + client).
// Les constantes runtime et la fabrique d'état par défaut sont définies dans onboarding-state
// (module sans import runtime, donc testable en isolation) et ré-exportées ici pour que le reste
// de l'application n'ait qu'un seul point d'import.

export type OnboardingStatus = "not_started" | "in_progress" | "deferred" | "completed";

export type OnboardingModule = "gifts" | "bitcoin" | "pea" | "cto";

export type PrivacyChoice = "private" | "admin" | "custom";

// Étapes du tunnel. La création du mot de passe est déléguée à Supabase Auth (pas d'étape ici) ;
// « completion » est un écran de fin, hors du compteur d'étapes principales.
export type OnboardingStep = "welcome" | "profile" | "modules" | "privacy" | "completion";

export type OnboardingState = {
  version: number;
  status: OnboardingStatus;
  currentStep: OnboardingStep | null;
  completedSteps: OnboardingStep[];
  selectedModules: OnboardingModule[];
  privacyChoice: PrivacyChoice | null;
  adminCanEdit: boolean;
  startedAt: string | null;
  completedAt: string | null;
  deferredAt: string | null;
  updatedAt: string | null;
};

export {
  CURRENT_ONBOARDING_VERSION,
  PRINCIPAL_STEPS,
  STEP_ORDER,
  ONBOARDING_MODULES,
  defaultOnboardingState,
} from "./onboarding-state";
