"use client";

import { useEffect, useState } from "react";
import type { Viewer } from "../lib/auth-types";
import { supabaseBrowser } from "../lib/supabase-browser";
import { saveProfile } from "../lib/onboarding/onboarding-client";
import { InstallAppCard } from "./install-app";
import { SettingsSection, SettingsMessage } from "./settings-ui";

// Écran « Mon compte » : identité en libre-service (prénom, date de naissance — le membre gère
// désormais ses propres informations), adresse e-mail (Supabase Auth) et préférences d'affichage.
// Aucune donnée codée en dur : tout provient du membre connecté (`viewer`) et de Supabase.

function roleLabel(role: Viewer["role"]) {
  if (role === "admin") return "Administrateur";
  if (role === "viewer") return "Amatxi (lecture seule)";
  return "Membre";
}

type Message = { text: string; tone: "success" | "error" | "info" };

export function AccountSettings({ viewer, onSignOut, publishedVersion }: { viewer: Viewer; onSignOut: () => void; publishedVersion: string }) {
  const [email, setEmail] = useState(viewer.email);
  const [name, setName] = useState(viewer.name);
  const [day, setDay] = useState(viewer.birthdayDay?.toString() ?? "");
  const [month, setMonth] = useState(viewer.birthdayMonth?.toString() ?? "");
  const [year, setYear] = useState(viewer.birthdayYear?.toString() ?? "");
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
  const initials = (name.trim() || viewer.name).slice(0, 2).toUpperCase();

  const profileChanged =
    name.trim() !== viewer.name ||
    day !== (viewer.birthdayDay?.toString() ?? "") ||
    month !== (viewer.birthdayMonth?.toString() ?? "") ||
    year !== (viewer.birthdayYear?.toString() ?? "");
  const nothingChanged = emailUnchanged && !profileChanged;

  async function save() {
    if (saving || nothingChanged) return;
    if (!name.trim()) { setMessage({ text: "Le prénom est obligatoire.", tone: "error" }); return; }
    if (!emailUnchanged && !/^\S+@\S+\.\S+$/.test(trimmedEmail)) { setMessage({ text: "Adresse e-mail invalide.", tone: "error" }); return; }
    setSaving(true); setMessage(null);
    try {
      if (profileChanged) {
        const patch: Record<string, unknown> = { firstName: name.trim() };
        const dayNum = Number(day), monthNum = Number(month);
        if (day && month && Number.isFinite(dayNum) && Number.isFinite(monthNum)) {
          patch.birthdayDay = dayNum;
          patch.birthdayMonth = monthNum;
          patch.birthdayYear = year ? Number(year) : null;
        }
        await saveProfile(patch);
      }
      if (!emailUnchanged) {
        const { error } = await supabaseBrowser.auth.updateUser({ email: trimmedEmail });
        if (error) throw error;
        setMessage({ text: "Informations enregistrées. Un e-mail de confirmation a été envoyé à la nouvelle adresse — clique sur le lien reçu pour valider le changement.", tone: "success" });
      } else {
        setMessage({ text: "Informations enregistrées.", tone: "success" });
      }
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : "Enregistrement impossible.", tone: "error" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsSection title="Mon compte" subtitle="Informations personnelles">
      <div className="set-account-hero">
        <span className="avatar admin set-avatar" aria-hidden="true">{initials}</span>
        <div>
          <strong>{name.trim() || viewer.name}</strong>
          <span>{roleLabel(viewer.role)}</span>
        </div>
      </div>

      <div className="set-fields">
        <label className="set-field">
          <span>Prénom</span>
          <input value={name} onChange={(event) => setName(event.target.value)} autoComplete="given-name" />
        </label>
        <label className="set-field">
          <span>Rôle applicatif</span>
          <input value={roleLabel(viewer.role)} readOnly aria-readonly="true" />
        </label>
        <label className="set-field">
          <span>Jour de naissance</span>
          <input inputMode="numeric" value={day} onChange={(event) => setDay(event.target.value.replace(/\D/g, "").slice(0, 2))} placeholder="JJ" />
        </label>
        <label className="set-field">
          <span>Mois de naissance</span>
          <input inputMode="numeric" value={month} onChange={(event) => setMonth(event.target.value.replace(/\D/g, "").slice(0, 2))} placeholder="MM" />
        </label>
        <label className="set-field">
          <span>Année (facultatif)</span>
          <input inputMode="numeric" value={year} onChange={(event) => setYear(event.target.value.replace(/\D/g, "").slice(0, 4))} placeholder="AAAA" />
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
      <p className="set-hint">Ton anniversaire permet d’afficher les cadeaux et souvenirs qui te concernent. Le rôle applicatif est géré par l’administrateur ; une seule langue et une seule devise sont disponibles pour le moment.</p>

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
        <button type="button" className="set-btn-primary" onClick={() => void save()} disabled={saving || nothingChanged}>
          {saving ? "Enregistrement…" : "Enregistrer"}
        </button>
      </div>
      <SettingsMessage message={message} />

      <InstallAppCard />

      <div className="set-account-footer">
        <button type="button" className="set-btn set-btn-quiet" onClick={onSignOut}>Se déconnecter</button>
        <span className="set-version">Version publiée <strong>{publishedVersion}</strong></span>
      </div>
    </SettingsSection>
  );
}
