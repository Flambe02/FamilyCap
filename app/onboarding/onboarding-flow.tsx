"use client";

import { useEffect, useMemo, useState } from "react";
import type { Viewer } from "../../lib/auth-types";
import { OnboardingShell } from "./onboarding-shell";
import { WelcomeStep, ProfileStep, ModulesStep, PrivacyStep, CompletionStep } from "./onboarding-steps";
import { determineInitialStep, previousStep } from "../../lib/onboarding/onboarding-state";
import { onboardingCopy } from "../../lib/onboarding/onboarding-copy";
import {
  loadOnboardingContext,
  loadProfile,
  saveOnboardingState,
  saveProfile,
  type OnboardingContext,
  type ProfileData,
} from "../../lib/onboarding/onboarding-client";
import type { OnboardingModule, OnboardingState, OnboardingStep, PrivacyChoice } from "../../lib/onboarding/onboarding-types";
import { defaultOnboardingState } from "../../lib/onboarding/onboarding-types";

// Orchestrateur du parcours. Deux modes :
//  - "required" : première connexion. Chaque « Continuer » valide et PERSISTE (serveur + miroir),
//    l'étape est reprise après rechargement, le report est possible dès la bienvenue.
//  - "tour"     : relance volontaire depuis Paramètres/Dashboard. Aucune écriture (ni statut,
//    ni données, ni permission). Bouton « Quitter la visite » à tout moment.

function profileFromViewer(viewer: Viewer): ProfileData {
  return {
    firstName: viewer.name,
    lastName: "",
    birthdayDay: viewer.birthdayDay ?? null,
    birthdayMonth: viewer.birthdayMonth ?? null,
    birthdayYear: viewer.birthdayYear ?? null,
    language: "fr",
    displayCurrency: "EUR",
  };
}

export function OnboardingFlow({ viewer, mode, initialState, onDone, onDefer, onExitTour }: {
  viewer: Viewer;
  mode: "required" | "tour";
  initialState?: OnboardingState;
  onDone: () => void;
  onDefer?: () => void;
  onExitTour?: () => void;
}) {
  const base = initialState ?? defaultOnboardingState();
  const [state, setState] = useState<OnboardingState>(base);
  const [step, setStep] = useState<OnboardingStep>(() => (mode === "tour" ? "welcome" : determineInitialStep(base)));
  const [context, setContext] = useState<OnboardingContext | null>(null);
  const [profile, setProfile] = useState<ProfileData>(profileFromViewer(viewer));
  const [selectedModules, setSelectedModules] = useState<OnboardingModule[]>(base.selectedModules);
  const [privacyChoice, setPrivacyChoice] = useState<PrivacyChoice>(base.privacyChoice ?? "admin");
  const [adminCanEdit, setAdminCanEdit] = useState<boolean>(base.adminCanEdit);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const readOnly = mode === "tour";
  const firstName = (profile.firstName || viewer.name).trim().split(/\s+/)[0] || viewer.name;

  // Contexte réel (cadeaux, Bitcoin, PEA/CTO, nom de l'administrateur) — données existantes.
  useEffect(() => {
    let cancelled = false;
    void loadOnboardingContext().then((ctx) => {
      if (cancelled) return;
      setContext(ctx);
      // Pré-sélection « Cadeaux d'Amatxi » si des cadeaux existent et qu'aucun choix n'est déjà stocké.
      setSelectedModules((current) => (current.length === 0 && ctx.giftCount > 0 ? ["gifts"] : current));
    });
    void loadProfile().then((p) => { if (!cancelled && p) setProfile((prev) => ({ ...prev, ...p, firstName: p.firstName || prev.firstName })); });
    return () => { cancelled = true; };
  }, []);

  const adminName = context?.adminName ?? "l’administrateur";

  // Persiste l'étape courante (reprise après rechargement). Silencieux et sans effet en mode visite.
  function persistStep(nextStep: OnboardingStep, completedStep?: OnboardingStep) {
    if (readOnly) return;
    void saveOnboardingState(viewer.id, state, { status: "in_progress", currentStep: nextStep, completedStep }).then(setState);
  }

  function goTo(nextStep: OnboardingStep, completedStep?: OnboardingStep) {
    setError(null);
    persistStep(nextStep, completedStep);
    setStep(nextStep);
  }

  function goBack() {
    const prev = previousStep(step);
    setError(null);
    if (!readOnly) void saveOnboardingState(viewer.id, state, { status: "in_progress", currentStep: prev }).then(setState);
    setStep(prev);
  }

  // ---- Handlers d'étapes ----
  function handleStart() { goTo("profile", "welcome"); }

  function handleDeferFromWelcome() {
    if (readOnly) { onExitTour?.(); return; }
    void saveOnboardingState(viewer.id, state, { status: "deferred", currentStep: "welcome" }).then(setState);
    (onDefer ?? onDone)();
  }

  async function handleProfileSubmit(patch: Partial<ProfileData>) {
    if (readOnly) { goTo("modules", "profile"); return; }
    setSaving(true); setError(null);
    try {
      if (Object.keys(patch).length) await saveProfile(patch);
      setProfile((prev) => ({ ...prev, ...patch }));
      const next = await saveOnboardingState(viewer.id, state, { status: "in_progress", currentStep: "modules", completedStep: "profile" });
      setState(next);
      setStep("modules");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : onboardingCopy.profile.error);
    } finally {
      setSaving(false);
    }
  }

  function toggleModule(module: OnboardingModule) {
    setSelectedModules((current) => (current.includes(module) ? current.filter((m) => m !== module) : [...current, module]));
  }

  function handleModulesContinue() {
    if (readOnly) { goTo("privacy", "modules"); return; }
    void saveOnboardingState(viewer.id, state, { status: "in_progress", currentStep: "privacy", completedStep: "modules", selectedModules }).then(setState);
    setStep("privacy");
  }

  async function handlePrivacyConfirm() {
    if (readOnly) { goTo("completion", "privacy"); return; }
    setSaving(true); setError(null);
    try {
      const next = await saveOnboardingState(viewer.id, state, {
        status: "in_progress", currentStep: "completion", completedStep: "privacy", privacyChoice, adminCanEdit,
      });
      setState(next);
      setStep("completion");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : onboardingCopy.privacy.error);
    } finally {
      setSaving(false);
    }
  }

  async function finish(hash?: string) {
    if (readOnly) { (onExitTour ?? onDone)(); return; }
    setSaving(true);
    try {
      const next = await saveOnboardingState(viewer.id, state, { status: "completed", currentStep: null, completedStep: "completion" });
      setState(next);
    } finally {
      setSaving(false);
      if (hash && typeof window !== "undefined") window.location.hash = hash;
      onDone();
    }
  }

  function handleCompletionDefer() {
    if (readOnly) { (onExitTour ?? onDone)(); return; }
    void saveOnboardingState(viewer.id, state, { status: "deferred" }).then(setState);
    (onDefer ?? onDone)();
  }

  // CTA secondaire contextuel de l'écran de fin : uniquement les cibles réellement accessibles
  // via le hash déjà géré par l'app (#pea, #bitcoin). Sinon, aucun bouton mort.
  const secondary = useMemo(() => {
    if (selectedModules.includes("pea")) return { label: onboardingCopy.completion.secondary.pea, onClick: () => void finish("#pea") };
    if (selectedModules.includes("bitcoin") || (context?.btcAttributed ?? 0) > 0) return { label: onboardingCopy.completion.secondary.bitcoin, onClick: () => void finish("#bitcoin") };
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedModules, context, state]);

  const wide = step === "modules" || step === "privacy" || step === "completion";

  return (
    <OnboardingShell
      mode={mode}
      step={step}
      wide={wide}
      onBack={step !== "welcome" ? goBack : undefined}
      onExit={mode === "tour" ? (onExitTour ?? onDone) : undefined}
    >
      {step === "welcome" && (
        <WelcomeStep
          firstName={firstName}
          onStart={handleStart}
          onDefer={mode === "required" ? handleDeferFromWelcome : undefined}
        />
      )}
      {step === "profile" && (
        <ProfileStep profile={profile} readOnly={readOnly} saving={saving} error={error} onSubmit={(patch) => void handleProfileSubmit(patch)} />
      )}
      {step === "modules" && (
        <ModulesStep
          selected={selectedModules}
          giftsConfigured={(context?.giftCount ?? 0) > 0}
          onToggle={toggleModule}
          onContinue={handleModulesContinue}
        />
      )}
      {step === "privacy" && (
        <PrivacyStep
          adminName={adminName}
          choice={privacyChoice}
          onChoice={setPrivacyChoice}
          adminCanEdit={adminCanEdit}
          onToggleEdit={setAdminCanEdit}
          saving={saving}
          error={error}
          onConfirm={() => void handlePrivacyConfirm()}
        />
      )}
      {step === "completion" && (
        <CompletionStep
          firstName={firstName}
          context={context}
          saving={saving}
          onDone={() => void finish()}
          secondary={secondary}
          onDeferLink={mode === "required" ? handleCompletionDefer : undefined}
        />
      )}
    </OnboardingShell>
  );
}
