"use client";

import { useState } from "react";
import type { Viewer } from "../lib/auth-types";
import { useDialogA11y } from "./use-dialog-a11y";
import "./member-onboarding.css";

type OnboardingStep = {
  eyebrow: string;
  title: string;
  text: string;
  icon: string;
  points: string[];
};

const steps: OnboardingStep[] = [
  {
    eyebrow: "BIENVENUE DANS LABAJO & CO",
    title: "Tes bitcoins ont une histoire.",
    text: "Ici, tu retrouves les cadeaux Bitcoin qui te sont attribués par ta famille.",
    icon: "₿",
    points: ["Chaque cadeau t’appartient.", "Son prix d’achat reste visible.", "Tu peux suivre son évolution sans jargon."],
  },
  {
    eyebrow: "OÙ SONT MES BITCOINS ?",
    title: "Binance ou Ledger, c’est toujours ta part.",
    text: "Binance est le compte familial temporaire. Le Ledger est ton portefeuille personnel, visible sur la blockchain.",
    icon: "↗",
    points: ["Jaune : acheté pour toi, encore sur Binance.", "Vert : déjà transféré sur ton Ledger.", "Aucune clé privée ni phrase de récupération n’est enregistrée ici."],
  },
  {
    eyebrow: "TU ES PRÊT·E",
    title: "Commence par ton portefeuille.",
    text: "Tu y verras ton total, l’origine de chaque cadeau et, si besoin, tu pourras demander un transfert à Florent.",
    icon: "✦",
    points: ["Consulte ton total et ton historique.", "Pose une demande de transfert quand une part est sur Binance.", "Retrouve cette visite à tout moment dans Paramètres."],
  },
];

export function MemberOnboarding({ viewer, onComplete, onOpenPortfolio }: { viewer: Viewer; onComplete: () => void; onOpenPortfolio: () => void }) {
  const [step, setStep] = useState(0);
  const dialogRef = useDialogA11y(true, onComplete);
  const current = steps[step];
  const isLast = step === steps.length - 1;

  function next() {
    if (isLast) {
      onComplete();
      onOpenPortfolio();
      return;
    }
    setStep((value) => value + 1);
  }

  return <div className="onboarding-backdrop">
    <section ref={dialogRef} className="onboarding-card" role="dialog" aria-modal="true" aria-labelledby="onboarding-title" aria-describedby="onboarding-description" tabIndex={-1}>
      <header>
        <div className="onboarding-progress" aria-label={`Étape ${step + 1} sur ${steps.length}`}>
          <span>PREMIERS PAS</span><b>{step + 1}/{steps.length}</b>
        </div>
        <button type="button" className="onboarding-close" onClick={onComplete} aria-label="Passer la visite guidée">×</button>
      </header>
      <div className="onboarding-content">
        <div className={`onboarding-icon step-${step}`} aria-hidden="true">{current.icon}</div>
        <span className="onboarding-eyebrow">{current.eyebrow}</span>
        <h2 id="onboarding-title">Bienvenue {viewer.name}.<br />{current.title}</h2>
        <p id="onboarding-description">{current.text}</p>
        <ul>{current.points.map((point) => <li key={point}><span aria-hidden="true">✓</span>{point}</li>)}</ul>
      </div>
      <footer>
        <button type="button" className="onboarding-skip" onClick={onComplete}>Passer la visite</button>
        <div className="onboarding-actions">
          {step > 0 && <button type="button" className="onboarding-back" onClick={() => setStep((value) => value - 1)}>Retour</button>}
          <button type="button" className="onboarding-next" onClick={next}>{isLast ? "Voir mon portefeuille" : "Continuer"}<span aria-hidden="true">→</span></button>
        </div>
      </footer>
    </section>
  </div>;
}
