"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { progressFor } from "../../lib/onboarding/onboarding-state";
import { onboardingCopy } from "../../lib/onboarding/onboarding-copy";
import type { OnboardingStep } from "../../lib/onboarding/onboarding-types";
import "./onboarding.css";

// Coquille plein écran du parcours : identité légère, progression fine, retour, sortie de visite.
// Gère le focus automatique sur le titre à chaque changement d'étape (accessibilité) et respecte
// `prefers-reduced-motion` (transitions désactivées via CSS).

function OnboardingProgress({ step }: { step: OnboardingStep }) {
  const { current, total, ratio, numbered } = progressFor(step);
  return (
    <div className="ob-progress" aria-hidden={!numbered}>
      <div className="ob-progress-track">
        <div className="ob-progress-fill" style={{ width: `${Math.round(ratio * 100)}%` }} />
      </div>
      {numbered && <span className="ob-progress-label" aria-current="step">{onboardingCopy.shell.stepLabel(current, total)}</span>}
    </div>
  );
}

export function OnboardingShell({
  mode,
  step,
  wide,
  onBack,
  onExit,
  children,
}: {
  mode: "required" | "tour";
  step: OnboardingStep;
  wide?: boolean;
  onBack?: () => void;
  onExit?: () => void;
  children: ReactNode;
}) {
  const cardRef = useRef<HTMLDivElement>(null);

  // Focus le titre de l'étape à chaque changement (ordre de lecture cohérent au clavier / lecteur).
  useEffect(() => {
    const title = cardRef.current?.querySelector<HTMLElement>("[data-ob-title]");
    title?.focus();
  }, [step]);

  return (
    <div className="ob-screen" role="dialog" aria-modal="true" aria-label={`${onboardingCopy.brand} — accueil`}>
      <div className="ob-topbar">
        {onBack ? (
          <button type="button" className="ob-back" onClick={onBack}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true"><path d="m14 6-6 6 6 6" /></svg>
            {onboardingCopy.shell.back}
          </button>
        ) : (
          <span className="ob-brand">
            <span className="ob-brand-mark" aria-hidden="true">LB</span>
            <span className="ob-brand-name">{onboardingCopy.brand}</span>
          </span>
        )}

        <OnboardingProgress step={step} />

        <span className="ob-topbar-right">
          {mode === "tour" && <span className="ob-tour-badge">{onboardingCopy.shell.tourBadge}</span>}
          {mode === "tour" && onExit && (
            <button type="button" className="ob-exit" onClick={onExit}>{onboardingCopy.shell.exitTour}</button>
          )}
        </span>
      </div>

      <div className="ob-main">
        <div ref={cardRef} className={wide ? "ob-card ob-card-wide" : "ob-card"}>
          {children}
        </div>
      </div>
    </div>
  );
}
