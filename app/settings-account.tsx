"use client";

import { useEffect, useState } from "react";
import type { Viewer } from "../lib/auth-types";
import { supabaseBrowser } from "../lib/supabase-browser";
import { InstallAppCard } from "./install-app";
import { SettingsSection, SettingsMessage } from "./settings-ui";

// Écran « Mon compte » : identité (lecture seule, gérée par l'administrateur), adresse e-mail
// (Supabase Auth) et préférences d'affichage. Aucune donnée n'est codée en dur — tout provient
// du membre connecté (`viewer`) et de Supabase Auth.

function roleLabel(role: Viewer["role"]) {
  if (role === "admin") return "Administrateur";
  if (role === "viewer") return "Amatxi (lecture seule)";
  return "Membre";
}

function formatBirthday(day?: number | null, month?: number | null, year?: number | null) {
  if (!day || !month) return "Non renseignée";
  const formatted = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long" }).format(new Date(2000, month - 1, day));
  return year ? `${formatted} ${year}` : formatted;
}

type Message = { text: string; tone: "success" | "error" | "info" };

export function AccountSettings({ viewer, onSignOut, publishedVersion, onReplayOnboarding }: { viewer: Viewer; onSignOut: () => void; publishedVersion: string; onReplayOnboarding?: () => void }) {
  const [email, setEmail] = useState(viewer.email);
  const [emailVerified, setEmailVerified] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);

  useEffect(() => {
    let cancelled = false;
    void supabaseBrowser.auth.getUser().then(({ data }) => {
      if (!cancelled) setEmailVerified(Boolean(data.user?.email_confirmed_at));
    });
    return () => { cancelled = true; };
  }, []);

  const trimmedEmail = email.trim().toLowerCase();
  const emailUnchanged = trimmedEmail === viewer.email.toLowerCase();
  const initials = viewer.name.slice(0, 2).toUpperCase();

  async function save() {
    if (saving || emailUnchanged) return;
    if (!/^\S+@\S+\.\S+$/.test(trimmedEmail)) { setMessage({ text: "Adresse e-mail invalide.", tone: "error" }); return; }
    setSaving(true); setMessage(null);
    const { error } = await supabaseBrowser.auth.updateUser({ email: trimmedEmail });
    setMessage(error
      ? { text: error.message, tone: "error" }
      : { text: "E-mail de confirmation envoyé à la nouvelle adresse. Clique sur le lien reçu pour valider le changement.", tone: "success" });
    setSaving(false);
  }

  return (
    <SettingsSection title="Mon compte" subtitle="Informations personnelles">
      <div className="set-account-hero">
        <span className="avatar admin set-avatar" aria-hidden="true">{initials}</span>
        <div>
          <strong>{viewer.name}</strong>
          <span>{roleLabel(viewer.role)}</span>
        </div>
      </div>

      <div className="set-fields">
        <label className="set-field">
          <span>Nom</span>
          <input value={viewer.name} readOnly aria-readonly="true" />
        </label>
        <label className="set-field">
          <span>Rôle applicatif</span>
          <input value={roleLabel(viewer.role)} readOnly aria-readonly="true" />
        </label>
        <label className="set-field">
          <span>Date de naissance</span>
          <input value={formatBirthday(viewer.birthdayDay, viewer.birthdayMonth, viewer.birthdayYear)} readOnly aria-readonly="true" />
        </label>
        <label className="set-field">
          <span>Langue</span>
          <select value="fr" disabled aria-disabled="true"><option value="fr">Français</option></select>
        </label>
        <label className="set-field">
          <span>Devise d’affichage</span>
          <select value="eur" disabled aria-disabled="true"><option value="eur">Euro (€)</option></select>
        </label>
      </div>
      <p className="set-hint">Le nom, le rôle et la date de naissance sont gérés par un administrateur — contacte Florent pour une correction. Une seule langue et une seule devise sont disponibles pour le moment.</p>

      <label className="set-field set-field-email">
        <span>Adresse e-mail (identifiant de connexion)</span>
        <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" aria-describedby="set-email-status" />
      </label>
      <p id="set-email-status" className="set-email-status">
        <span className={`verify-badge ${emailVerified === null ? "pending" : emailVerified ? "verified" : "unverified"}`}>
          {emailVerified === null ? "Vérification…" : emailVerified ? "✓ Vérifié" : "Non vérifié"}
        </span>
      </p>

      <div className="set-actions">
        <button type="button" className="set-btn-primary" onClick={() => void save()} disabled={saving || emailUnchanged}>
          {saving ? "Envoi…" : "Enregistrer"}
        </button>
      </div>
      <SettingsMessage message={message} />

      <InstallAppCard />

      <div className="set-account-footer">
        {viewer.role !== "admin" && onReplayOnboarding && (
          <button type="button" className="set-btn" onClick={onReplayOnboarding}>Revoir les premiers pas</button>
        )}
        <button type="button" className="set-btn set-btn-quiet" onClick={onSignOut}>Se déconnecter</button>
        <span className="set-version">Version publiée <strong>{publishedVersion}</strong></span>
      </div>
    </SettingsSection>
  );
}
