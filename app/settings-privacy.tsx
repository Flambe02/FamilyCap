"use client";

import { useEffect, useState } from "react";
import type { Viewer } from "../lib/auth-types";
import { supabaseBrowser } from "../lib/supabase-browser";
import { SettingsSection, SettingsModal, SettingsMessage } from "./settings-ui";
import { downloadAccountExport, requestAccountDeactivation } from "../lib/account-settings-client";

// Écran « Données et confidentialité » : export réel des données propres, raccourci vers le
// partage familial, historique de connexion réel (dernière connexion Supabase), informations de
// confidentialité, et zone de danger. La désactivation NE supprime aucune donnée du registre :
// elle coupe l'accès (réversible par l'administrateur).

const CONFIRM_WORD = "SUPPRIMER";

export function PrivacySettings({ viewer, onGoToSection, onSignOut }: { viewer: Viewer; onGoToSection: (section: string) => void; onSignOut: () => void }) {
  const [lastSignIn, setLastSignIn] = useState<string | null | undefined>(undefined);
  const [downloading, setDownloading] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: "success" | "error" | "info" } | null>(null);

  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [deactivateOpen, setDeactivateOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [deactivating, setDeactivating] = useState(false);
  const [deactivateError, setDeactivateError] = useState("");

  const isAdmin = viewer.role === "admin";

  useEffect(() => {
    let cancelled = false;
    void supabaseBrowser.auth.getUser().then(({ data }) => {
      if (!cancelled) setLastSignIn(data.user?.last_sign_in_at ?? null);
    }).catch(() => { if (!cancelled) setLastSignIn(null); });
    return () => { cancelled = true; };
  }, []);

  async function download() {
    if (downloading) return;
    setDownloading(true); setMessage(null);
    try {
      await downloadAccountExport();
      setMessage({ text: "Export téléchargé.", tone: "success" });
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : "Export impossible.", tone: "error" });
    } finally {
      setDownloading(false);
    }
  }

  async function confirmDeactivate() {
    if (deactivating) return;
    if (confirmText.trim().toUpperCase() !== CONFIRM_WORD) { setDeactivateError(`Saisissez « ${CONFIRM_WORD} » pour confirmer.`); return; }
    setDeactivating(true); setDeactivateError("");
    try {
      await requestAccountDeactivation(confirmText.trim());
      setDeactivateOpen(false);
      onSignOut();
    } catch (error) {
      setDeactivateError(error instanceof Error ? error.message : "Désactivation impossible.");
    } finally {
      setDeactivating(false);
    }
  }

  const lastSignInLabel = lastSignIn === undefined
    ? "Chargement…"
    : lastSignIn
      ? new Intl.DateTimeFormat("fr-FR", { dateStyle: "long", timeStyle: "short" }).format(new Date(lastSignIn))
      : "Première connexion en cours";

  return (
    <>
      <SettingsSection title="Données et confidentialité" subtitle="Gérez vos données personnelles et vos préférences de confidentialité.">
        <ul className="set-rows">
          <li className="set-row">
            <div className="set-row-main"><strong>Télécharger mes données</strong><p>Obtenez une copie de vos données personnelles.</p><SettingsMessage message={message} /></div>
            <div className="set-row-side"><button type="button" className="set-btn" onClick={() => void download()} disabled={downloading}>{downloading ? "Préparation…" : "Télécharger"}</button></div>
          </li>
          <li className="set-row">
            <div className="set-row-main"><strong>Visibilité familiale</strong><p>Gérez ce que votre famille peut consulter.</p></div>
            <div className="set-row-side"><button type="button" className="set-btn" onClick={() => onGoToSection("partage")}>Gérer le partage ›</button></div>
          </li>
          <li className="set-row">
            <div className="set-row-main"><strong>Historique des connexions</strong><p>Dernière connexion : {lastSignInLabel}.</p><p className="set-subtle">L’historique détaillé des connexions n’est pas encore enregistré.</p></div>
          </li>
          <li className="set-row">
            <div className="set-row-main"><strong>Informations sur la confidentialité</strong><p>Découvrez comment vos données sont utilisées et protégées.</p></div>
            <div className="set-row-side"><button type="button" className="set-btn" onClick={() => setPrivacyOpen(true)}>En savoir plus ›</button></div>
          </li>
        </ul>
      </SettingsSection>

      <section className="set-danger" aria-labelledby="set-danger-title">
        <div>
          <h3 id="set-danger-title">Désactiver mon compte</h3>
          <p>Cette action coupe votre accès à LaBaJo &amp; Co. Vos données patrimoniales (cadeaux, virements) sont conservées pour l’intégrité du registre familial et ne sont pas supprimées. Un administrateur peut réactiver votre accès.</p>
          {isAdmin && <p className="set-subtle">Le compte administrateur ne peut pas être désactivé depuis cet écran.</p>}
        </div>
        <button type="button" className="set-btn-danger" onClick={() => { setConfirmText(""); setDeactivateError(""); setDeactivateOpen(true); }} disabled={isAdmin}>Désactiver mon compte</button>
      </section>

      <SettingsModal open={privacyOpen} onClose={() => setPrivacyOpen(false)} title="Informations sur la confidentialité">
        <div className="set-prose">
          <p>LaBaJo &amp; Co est un espace privé et familial. Vos données servent uniquement au suivi de l’épargne et des investissements de la famille.</p>
          <ul>
            <li>Vos informations (identité, e-mail, cadeaux, comptes) ne sont visibles que par vous, par les personnes que vous autorisez via le partage familial, et par l’administrateur familial.</li>
            <li>Les adresses publiques Ledger servent uniquement à lire des soldes publics ; aucune clé privée, phrase de récupération ou code n’est jamais stocké dans l’application.</li>
            <li>Vous pouvez à tout moment télécharger vos données ou désactiver votre accès depuis cet écran.</li>
          </ul>
        </div>
      </SettingsModal>

      <SettingsModal open={deactivateOpen} onClose={() => { if (!deactivating) setDeactivateOpen(false); }} title="Désactiver mon compte">
        <div className="set-prose">
          <p>Vous êtes sur le point de désactiver votre accès. Conséquences :</p>
          <ul>
            <li>Vous serez déconnecté et ne pourrez plus vous connecter tant qu’un administrateur n’a pas réactivé votre compte.</li>
            <li>Aucune donnée du registre familial (cadeaux, virements, historiques) n’est supprimée.</li>
          </ul>
          <label className="set-field">
            <span>Pour confirmer, saisissez <strong>{CONFIRM_WORD}</strong></span>
            <input value={confirmText} onChange={(event) => setConfirmText(event.target.value)} aria-label={`Saisir ${CONFIRM_WORD} pour confirmer`} autoComplete="off" />
          </label>
          {deactivateError && <p className="set-message error" role="status">{deactivateError}</p>}
        </div>
        <footer className="set-modal-actions">
          <button type="button" className="set-btn" onClick={() => setDeactivateOpen(false)} disabled={deactivating}>Annuler</button>
          <button type="button" className="set-btn-danger" onClick={() => void confirmDeactivate()} disabled={deactivating || confirmText.trim().toUpperCase() !== CONFIRM_WORD}>{deactivating ? "Désactivation…" : "Confirmer la désactivation"}</button>
        </footer>
      </SettingsModal>
    </>
  );
}
