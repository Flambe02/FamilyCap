"use client";

import { useState } from "react";
import type { Viewer } from "../lib/auth-types";
import type { View } from "../lib/navigation";
import { SettingsSection, SettingsMessage } from "./settings-ui";
import { onboardingCopy } from "../lib/onboarding/onboarding-copy";
import { clearTipsFor } from "../lib/onboarding/onboarding-client";
import { reopenChecklist } from "./onboarding/onboarding-checklist";

// Section « Aide et découverte » : relancer la présentation (visite, sans modifier les données ni
// le statut), reprendre une configuration inachevée, découvrir chaque univers, comprendre le
// partage familial, et réinitialiser les conseils contextuels (sans toucher aux données ni aux
// permissions). Aucune de ces actions ne supprime d'investissement.

const h = onboardingCopy.help;

export function HelpSettings({ viewer, onReplay, onResume, onNavigate, onGoToSection }: {
  viewer: Viewer;
  onReplay?: () => void;
  onResume?: () => void;
  onNavigate?: (view: View) => void;
  onGoToSection: (section: string) => void;
}) {
  const [message, setMessage] = useState<{ text: string; tone: "success" | "error" | "info" } | null>(null);
  const isMember = viewer.role === "adult" || viewer.role === "child";

  function resetTips() {
    clearTipsFor(viewer.id);
    reopenChecklist(viewer.id);
    setMessage({ text: h.resetTipsDone, tone: "success" });
  }

  return (
    <SettingsSection title={h.sectionTitle} subtitle="Revoir la présentation, reprendre ta configuration et découvrir chaque espace.">
      <ul className="set-rows">
        {onReplay && (
          <li className="set-row">
            <div className="set-row-main"><strong>{h.replay}</strong><p>Relance la visite guidée. Aucune donnée ni aucun réglage n’est modifié.</p></div>
            <div className="set-row-side"><button type="button" className="set-btn" onClick={onReplay}>Revoir</button></div>
          </li>
        )}
        {isMember && onResume && (
          <li className="set-row">
            <div className="set-row-main"><strong>{h.resume}</strong><p>Reprends ton accueil là où tu t’étais arrêté.</p></div>
            <div className="set-row-side"><button type="button" className="set-btn" onClick={() => { reopenChecklist(viewer.id); onResume(); }}>Reprendre</button></div>
          </li>
        )}
        {onNavigate && (
          <li className="set-row">
            <div className="set-row-main"><strong>{h.discoverBitcoin}</strong><p>Comprendre l’origine de tes bitcoins (cadeaux et achats personnels).</p></div>
            <div className="set-row-side"><button type="button" className="set-btn" onClick={() => onNavigate("bitcoin")}>Ouvrir ›</button></div>
          </li>
        )}
        {onNavigate && (
          <li className="set-row">
            <div className="set-row-main"><strong>{h.discoverPea}</strong><p>Suivre tes versements et positions sur ton PEA.</p></div>
            <div className="set-row-side"><button type="button" className="set-btn" onClick={() => onNavigate("investissements-pea")}>Ouvrir ›</button></div>
          </li>
        )}
        {onNavigate && (
          <li className="set-row">
            <div className="set-row-main"><strong>{h.discoverCto}</strong><p>Suivre tes actions, ETF et dividendes.</p></div>
            <div className="set-row-side"><button type="button" className="set-btn" onClick={() => onNavigate("investissements-comptetitres")}>Ouvrir ›</button></div>
          </li>
        )}
        <li className="set-row">
          <div className="set-row-main"><strong>{h.understandSharing}</strong><p>Choisir qui peut voir tes investissements.</p></div>
          <div className="set-row-side"><button type="button" className="set-btn" onClick={() => onGoToSection("partage")}>Gérer le partage ›</button></div>
        </li>
        <li className="set-row">
          <div className="set-row-main"><strong>{h.resetTips}</strong><p>Réaffiche les conseils contextuels. Aucune donnée ni aucune permission n’est modifiée.</p><SettingsMessage message={message} /></div>
          <div className="set-row-side"><button type="button" className="set-btn set-btn-quiet" onClick={resetTips}>Réinitialiser</button></div>
        </li>
      </ul>
    </SettingsSection>
  );
}
