"use client";

import { useEffect, useState } from "react";
import "./onboarding.css";

// Mini-onboardings contextuels : un conseil léger affiché une seule fois par écran, sans librairie
// de « product tour » ni série de bulles. Persistance par membre dans localStorage
// (`labajo-tip:<id>:<memberId>`), réinitialisable depuis Paramètres › Aide et découverte.

function tipKey(tipId: string, memberId: string) { return `labajo-tip:${tipId}:${memberId}`; }

export function ContextualTip({ tipId, memberId, title, body, cta, onCta }: {
  tipId: string; memberId: string; title: string; body: string; cta: string; onCta?: () => void;
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try { setVisible(window.localStorage.getItem(tipKey(tipId, memberId)) !== "1"); } catch { setVisible(false); }
  }, [tipId, memberId]);

  if (!visible) return null;

  function close(runCta: boolean) {
    try { window.localStorage.setItem(tipKey(tipId, memberId), "1"); } catch { /* ignore */ }
    setVisible(false);
    if (runCta) onCta?.();
  }

  return (
    <aside className="ob-tip" role="note" aria-label={title}>
      <span className="ob-tip-icon" aria-hidden="true">💡</span>
      <div className="ob-tip-body">
        <strong>{title}</strong>
        <p>{body}</p>
      </div>
      <div className="ob-tip-actions">
        <button type="button" className="ob-tip-cta" onClick={() => close(true)}>{cta}</button>
        <button type="button" className="ob-tip-close" aria-label="Fermer ce conseil" onClick={() => close(false)}>×</button>
      </div>
    </aside>
  );
}
