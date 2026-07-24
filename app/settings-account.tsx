"use client";

import { useEffect, useRef, useState } from "react";
import type { Viewer } from "../lib/auth-types";
import { supabaseBrowser } from "../lib/supabase-browser";
import { saveProfile } from "../lib/onboarding/onboarding-client";
import { InstallAppCard } from "./install-app";
import { SettingsSection, SettingsMessage } from "./settings-ui";

const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

async function uploadOwnPhoto(file: File): Promise<string> {
  const { data } = await supabaseBrowser.auth.getSession();
  const form = new FormData();
  form.append("file", file);
  const response = await fetch("/api/profile/photo", { method: "POST", headers: { authorization: "Bearer " + (data.session?.access_token ?? "") }, body: form });
  const result = await response.json().catch(() => ({})) as { photoUrl?: string; error?: string };
  if (!response.ok || !result.photoUrl) throw new Error(result.error ?? "Envoi de la photo impossible.");
  return result.photoUrl;
}

async function removeOwnPhoto(): Promise<void> {
  const { data } = await supabaseBrowser.auth.getSession();
  const response = await fetch("/api/profile/photo", { method: "DELETE", headers: { authorization: "Bearer " + (data.session?.access_token ?? "") } });
  const result = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(result.error ?? "Suppression de la photo impossible.");
}

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
  const [photoUrl, setPhotoUrl] = useState(viewer.photoUrl ?? null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState("");
  const photoInputRef = useRef<HTMLInputElement>(null);

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

  async function pickPhoto(file: File) {
    if (!PHOTO_TYPES.has(file.type)) { setPhotoError("Format non pris en charge. Utilisez JPG, PNG ou WEBP."); return; }
    setPhotoBusy(true); setPhotoError("");
    try {
      const url = await uploadOwnPhoto(file);
      setPhotoUrl(url);
    } catch (error) {
      setPhotoError(error instanceof Error ? error.message : "Envoi de la photo impossible.");
    } finally {
      setPhotoBusy(false);
    }
  }

  async function clearPhoto() {
    setPhotoBusy(true); setPhotoError("");
    try {
      await removeOwnPhoto();
      setPhotoUrl(null);
    } catch (error) {
      setPhotoError(error instanceof Error ? error.message : "Suppression de la photo impossible.");
    } finally {
      setPhotoBusy(false);
    }
  }

  return (
    <SettingsSection title="Mon compte" subtitle={`Informations personnelles de ${name.trim() || viewer.name}.`}>
      <div className="set-account-hero">
        {photoUrl
          ? <img className="avatar admin set-avatar" src={photoUrl} alt="" aria-hidden="true" />
          : <span className="avatar admin set-avatar" aria-hidden="true">{initials}</span>}
        <div className="set-account-identity">
          <div className="set-account-heading">
            <strong>{name.trim() || viewer.name}</strong>
            <span className="set-role-badge">{roleLabel(viewer.role)}</span>
          </div>
          <div className="set-avatar-actions">
            <input ref={photoInputRef} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void pickPhoto(file); }} />
            <button type="button" className="set-btn-primary" onClick={() => photoInputRef.current?.click()} disabled={photoBusy}>{photoBusy ? "Envoi…" : photoUrl ? "Changer la photo" : "Ajouter une photo"}</button>
            {photoUrl && <button type="button" className="set-btn set-btn-quiet" onClick={() => void clearPhoto()} disabled={photoBusy}>Supprimer</button>}
          </div>
          {photoError && <p className="set-message error" role="status">{photoError}</p>}
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
