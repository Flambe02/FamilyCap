"use client";

import type { ReactNode, RefObject } from "react";
import { useDialogA11y } from "./use-dialog-a11y";

// Primitives visuelles partagées par les écrans Paramètres (carte de section, interrupteur
// accessible, modale). Évite un composant unique trop volumineux et garantit une présentation
// homogène et accessible sur tous les écrans.

export function SettingsSection({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section className="set-section">
      <header className="set-section-head">
        <h2>{title}</h2>
        {subtitle && <p>{subtitle}</p>}
      </header>
      {children}
    </section>
  );
}

export function SettingsMessage({ message }: { message: { text: string; tone: "success" | "error" | "info" } | null }) {
  if (!message) return null;
  return <p className={`set-message ${message.tone}`} role="status">{message.text}</p>;
}

/** Interrupteur accessible (role="switch", aria-checked, focus visible, ≥44px de zone tactile). */
export function SettingsSwitch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`set-switch${checked ? " on" : ""}`}
      onClick={() => { if (!disabled) onChange(!checked); }}
    >
      <span className="set-switch-thumb" aria-hidden="true" />
    </button>
  );
}

export function SettingsModal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useDialogA11y(open, onClose);
  if (!open) return null;
  return (
    <div className="modal-backdrop set-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={ref as RefObject<HTMLDivElement>} className="modal set-modal" role="dialog" aria-modal="true" aria-labelledby="set-modal-title" tabIndex={-1}>
        <header>
          <h2 id="set-modal-title">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Fermer">×</button>
        </header>
        <div className="set-modal-body">{children}</div>
      </div>
    </div>
  );
}
