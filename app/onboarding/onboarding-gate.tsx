"use client";

import { useEffect, useState } from "react";
import type { Viewer } from "../../lib/auth-types";
import { FamilyDashboard } from "../family-dashboard";
import { OnboardingFlow } from "./onboarding-flow";
import { loadOnboardingState } from "../../lib/onboarding/onboarding-client";
import { resolveGate } from "../../lib/onboarding/onboarding-state";
import { defaultOnboardingState, type OnboardingState } from "../../lib/onboarding/onboarding-types";

// Garde d'accès centrale (une seule source de vérité, aucune redirection dispersée) :
//  - admin / lecteur familial → jamais de tunnel obligatoire ;
//  - membre (adulte/jeune)     → tunnel obligatoire tant que le parcours n'est pas terminé ou
//    reporté. Le report renvoie au tableau de bord (carte de reprise), sans réafficher le plein
//    écran à chaque connexion. Aucun flash du dashboard : on rend un écran d'attente avant décision.
export function OnboardingGate({ viewer, onSignOut, onViewerChanged }: { viewer: Viewer; onSignOut: () => void; onViewerChanged?: () => void }) {
  // Seuls les membres actifs concernés par les investissements passent par le tunnel obligatoire.
  const gated = viewer.role === "adult" || viewer.role === "child";
  const [phase, setPhase] = useState<"loading" | "onboarding" | "app">(gated ? "loading" : "app");
  const [state, setState] = useState<OnboardingState>(defaultOnboardingState());

  useEffect(() => {
    if (!gated) return;
    let cancelled = false;
    void loadOnboardingState(viewer.id)
      .then(({ state: loaded }) => {
        if (cancelled) return;
        setState(loaded);
        setPhase(resolveGate({ isAdmin: false, isPreview: false, state: loaded }) === "onboarding" ? "onboarding" : "app");
      })
      .catch(() => { if (!cancelled) setPhase("app"); });
    return () => { cancelled = true; };
  }, [gated, viewer.id]);

  if (phase === "loading") {
    return <div className="auth-loading"><span><img src="/Labajo logo.png" alt="" width={48} height={48} /></span><p>Préparation de ton espace…</p></div>;
  }
  if (phase === "onboarding") {
    return <OnboardingFlow viewer={viewer} mode="required" initialState={state} onDone={() => setPhase("app")} onDefer={() => setPhase("app")} />;
  }
  return <FamilyDashboard viewer={viewer} onSignOut={onSignOut} onViewerChanged={onViewerChanged} />;
}
