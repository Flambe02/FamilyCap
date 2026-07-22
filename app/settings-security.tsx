"use client";

import { useEffect, useState } from "react";
import type { Viewer } from "../lib/auth-types";
import { supabaseBrowser } from "../lib/supabase-browser";
import { SettingsSection, SettingsMessage } from "./settings-ui";

// Écran « Sécurité » : mot de passe, statut réel de la double authentification (Supabase MFA),
// sessions et réinitialisation. Aucun statut ni chiffre n'est inventé : tout est lu depuis
// Supabase Auth, et les fonctions non encore disponibles sont annoncées comme telles.

type Message = { text: string; tone: "success" | "error" | "info" };

export function SecuritySettings({ viewer }: { viewer: Viewer }) {
  const [password, setPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState<Message | null>(null);

  const [mfaStatus, setMfaStatus] = useState<"loading" | "active" | "none">("loading");

  const [resetSent, setResetSent] = useState(false);
  const [resetCooldown, setResetCooldown] = useState(0);
  const [resetMessage, setResetMessage] = useState<Message | null>(null);

  const [signingOutOthers, setSigningOutOthers] = useState(false);
  const [sessionMessage, setSessionMessage] = useState<Message | null>(null);

  useEffect(() => {
    let cancelled = false;
    void supabaseBrowser.auth.mfa.listFactors().then(({ data, error }) => {
      if (cancelled) return;
      if (error) { setMfaStatus("none"); return; }
      const factors = data?.all ?? [];
      setMfaStatus(factors.some((factor) => factor.status === "verified") ? "active" : "none");
    }).catch(() => { if (!cancelled) setMfaStatus("none"); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (resetCooldown <= 0) return;
    const timer = window.setTimeout(() => setResetCooldown((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [resetCooldown]);

  async function updatePassword() {
    if (savingPassword) return;
    if (password.length < 8) { setPasswordMessage({ text: "Le mot de passe doit contenir au moins 8 caractères.", tone: "error" }); return; }
    setSavingPassword(true); setPasswordMessage(null);
    const { error } = await supabaseBrowser.auth.updateUser({ password });
    setPasswordMessage(error ? { text: error.message, tone: "error" } : { text: "Mot de passe mis à jour.", tone: "success" });
    if (!error) setPassword("");
    setSavingPassword(false);
  }

  async function sendReset() {
    if (resetCooldown > 0) return;
    setResetMessage(null);
    const redirectTo = typeof window !== "undefined" ? window.location.origin : undefined;
    const { error } = await supabaseBrowser.auth.resetPasswordForEmail(viewer.email, redirectTo ? { redirectTo } : undefined);
    if (error) { setResetMessage({ text: error.message, tone: "error" }); return; }
    setResetSent(true);
    setResetCooldown(45);
    setResetMessage({ text: `Lien de réinitialisation envoyé à ${viewer.email}.`, tone: "success" });
  }

  async function signOutOthers() {
    if (signingOutOthers) return;
    setSigningOutOthers(true); setSessionMessage(null);
    const { error } = await supabaseBrowser.auth.signOut({ scope: "others" });
    setSessionMessage(error ? { text: error.message, tone: "error" } : { text: "Les autres sessions ont été déconnectées.", tone: "success" });
    setSigningOutOthers(false);
  }

  return (
    <SettingsSection title="Sécurité" subtitle="Protégez votre accès avec des réglages fiables.">
      <div className="set-rows">
        {/* Mot de passe */}
        <div className="set-row">
          <div className="set-row-main">
            <strong>Mot de passe</strong>
            <p>Choisissez un mot de passe d’au moins 8 caractères.</p>
            <label className="set-field set-field-inline">
              <span className="sr-only">Nouveau mot de passe</span>
              <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Nouveau mot de passe" autoComplete="new-password" />
            </label>
            <SettingsMessage message={passwordMessage} />
          </div>
          <div className="set-row-side">
            <button type="button" className="set-btn" onClick={() => void updatePassword()} disabled={savingPassword || password.length < 8}>
              {savingPassword ? "Mise à jour…" : "Modifier le mot de passe"}
            </button>
          </div>
        </div>

        {/* Double authentification */}
        <div className="set-row">
          <div className="set-row-main">
            <strong>Double authentification</strong>
            <p>Ajoutez une seconde vérification à la connexion.</p>
          </div>
          <div className="set-row-side">
            <span className={`set-badge ${mfaStatus === "active" ? "ok" : "muted"}`}>
              {mfaStatus === "loading" ? "Vérification…" : mfaStatus === "active" ? "Activée" : "Non configurée"}
            </span>
            <button type="button" className="set-btn" disabled title="Bientôt disponible">Configurer</button>
          </div>
        </div>

        {/* Appareils connectés */}
        <div className="set-row">
          <div className="set-row-main">
            <strong>Appareils connectés</strong>
            <p>Le détail des appareils connectés sera disponible prochainement.</p>
          </div>
          <div className="set-row-side">
            <span className="set-badge muted">À venir</span>
          </div>
        </div>

        {/* Sessions actives */}
        <div className="set-row">
          <div className="set-row-main">
            <strong>Sessions actives</strong>
            <p>Vous êtes connecté sur cet appareil. Vous pouvez déconnecter vos autres sessions.</p>
            <SettingsMessage message={sessionMessage} />
          </div>
          <div className="set-row-side">
            <button type="button" className="set-btn" onClick={() => void signOutOthers()} disabled={signingOutOthers}>
              {signingOutOthers ? "Déconnexion…" : "Déconnecter les autres appareils"}
            </button>
          </div>
        </div>

        {/* Réinitialisation du mot de passe */}
        <div className="set-row">
          <div className="set-row-main">
            <strong>Réinitialisation du mot de passe</strong>
            <p>Recevez un lien sécurisé à l’adresse {viewer.email}.</p>
            <SettingsMessage message={resetMessage} />
          </div>
          <div className="set-row-side">
            <button type="button" className="set-btn" onClick={() => void sendReset()} disabled={resetCooldown > 0}>
              {resetCooldown > 0 ? `Renvoyer (${resetCooldown}s)` : resetSent ? "Renvoyer le lien" : "Envoyer le lien"}
            </button>
          </div>
        </div>
      </div>
    </SettingsSection>
  );
}
