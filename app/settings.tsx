"use client";

import { useEffect, useState } from "react";
import { AdminUsers } from "./admin-users";
import { InvestmentAccessSettings } from "./investment-access-settings";
import { InstallAppCard } from "./install-app";
import { PanelTitle } from "./family-dashboard";
import type { Viewer } from "../lib/auth-types";
import { supabaseBrowser } from "../lib/supabase-browser";
import "./settings.css";

type SettingsTabId = "compte" | "securite" | "portefeuilles" | "partage" | "utilisateurs" | "cadeaux" | "donnees";
type SettingsTab = { id: SettingsTabId; label: string };

const MEMBER_TABS: SettingsTab[] = [
  { id: "compte", label: "Mon compte" },
  { id: "securite", label: "Sécurité" },
  { id: "portefeuilles", label: "Mes investissements" },
  { id: "partage", label: "Partage familial" },
];

const ADMIN_TABS: SettingsTab[] = [
  { id: "compte", label: "Mon compte" },
  { id: "securite", label: "Sécurité" },
  { id: "portefeuilles", label: "Mes investissements" },
  { id: "partage", label: "Partage familial" },
  { id: "utilisateurs", label: "Utilisateurs & accès" },
  { id: "cadeaux", label: "Règles des cadeaux" },
  { id: "donnees", label: "Données" },
];

export function PreviewSettings({ member, onExit }: { member: string; onExit: () => void }) {
  return <div className="panel preview-settings"><span>MODE APERCU</span><h2>Vue de {member}</h2><p>Tu regardes l interface comme ce membre, sans modifier son compte, ses donnees ou ses droits reels.</p><button className="primary-button" onClick={onExit}>Quitter l apercu</button></div>;
}

/**
 * Nouvelle page Paramètres : le menu principal (sidebar) reste inchangé, la navigation
 * secondaire est ici horizontale — jamais une seconde sidebar complète.
 */
export function Settings({ viewer, onSignOut, publishedVersion, onReplayOnboarding }: { viewer: Viewer; onSignOut: () => void; publishedVersion: string; onReplayOnboarding?: () => void }) {
  const tabs = viewer.role === "admin" ? ADMIN_TABS : MEMBER_TABS;
  const [tab, setTab] = useState<SettingsTabId>("compte");
  const activeTab = tabs.some((item) => item.id === tab) ? tab : "compte";

  return (
    <div className="settings-page">
      <header className="settings-page-head">
        <span className="settings-eyebrow">MON ESPACE</span>
        <h2>Paramètres</h2>
        <p>Gérez votre compte, vos investissements et vos accès.</p>
      </header>

      <div className="settings-tabbar" role="tablist" aria-label="Sections des paramètres">
        {tabs.map((item) => (
          <button
            key={item.id}
            role="tab"
            id={`settings-tab-${item.id}`}
            aria-selected={activeTab === item.id}
            aria-controls={`settings-panel-${item.id}`}
            className={activeTab === item.id ? "active" : ""}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <section className="settings-content panel" role="tabpanel" id={`settings-panel-${activeTab}`} aria-labelledby={`settings-tab-${activeTab}`} tabIndex={0}>
        {activeTab === "compte" && <AccountSettings viewer={viewer} onSignOut={onSignOut} publishedVersion={publishedVersion} onReplayOnboarding={onReplayOnboarding} />}
        {activeTab === "utilisateurs" && viewer.role === "admin" && <UsersSettings />}
        {activeTab === "portefeuilles" && (viewer.role === "admin" ? <WalletSettings /> : <MemberWalletSettings viewer={viewer} />)}
        {activeTab === "partage" && <InvestmentAccessSettings />}
        {activeTab === "cadeaux" && viewer.role === "admin" && <GiftSettings />}
        {activeTab === "securite" && <SecuritySettings />}
        {activeTab === "donnees" && viewer.role === "admin" && <DataSettings />}
      </section>
    </div>
  );
}

function formatBirthday(day?: number | null, month?: number | null, year?: number | null) {
  if (!day || !month) return "Non renseignée";
  const formatted = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long" }).format(new Date(2000, month - 1, day));
  return year ? `${formatted} ${year}` : formatted;
}

function roleLabel(role: Viewer["role"]) {
  if (role === "admin") return "Administrateur";
  if (role === "viewer") return "Amatxi (lecture seule)";
  return "Membre";
}

type FormMessage = { text: string; tone: "success" | "error" };

/** Onglet « Mon compte » : identité, e-mail (Supabase Auth) et mot de passe. Le rôle applicatif reste en lecture seule ici — sa modification vit dans Administration. */
function AccountSettings({ viewer, onSignOut, publishedVersion, onReplayOnboarding }: { viewer: Viewer; onSignOut: () => void; publishedVersion: string; onReplayOnboarding?: () => void }) {
  const [password, setPassword] = useState("");
  const [passwordMessage, setPasswordMessage] = useState<FormMessage | null>(null);
  const [savingPassword, setSavingPassword] = useState(false);
  const [email, setEmail] = useState(viewer.email);
  const [emailMessage, setEmailMessage] = useState<FormMessage | null>(null);
  const [savingEmail, setSavingEmail] = useState(false);
  const [emailVerified, setEmailVerified] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void supabaseBrowser.auth.getUser().then(({ data }) => {
      if (!cancelled) setEmailVerified(Boolean(data.user?.email_confirmed_at));
    });
    return () => { cancelled = true; };
  }, []);

  const trimmedEmail = email.trim().toLowerCase();
  const emailUnchanged = trimmedEmail === viewer.email.toLowerCase();

  async function updatePassword() {
    if (savingPassword || password.length < 8) {
      if (password.length < 8) setPasswordMessage({ text: "Le mot de passe doit contenir au moins 8 caractères.", tone: "error" });
      return;
    }
    setSavingPassword(true); setPasswordMessage(null);
    const { error } = await supabaseBrowser.auth.updateUser({ password });
    setPasswordMessage(error ? { text: error.message, tone: "error" } : { text: "Mot de passe mis à jour.", tone: "success" });
    if (!error) setPassword("");
    setSavingPassword(false);
  }

  async function updateEmail() {
    if (savingEmail || emailUnchanged) return;
    if (!/^\S+@\S+\.\S+$/.test(trimmedEmail)) { setEmailMessage({ text: "Adresse e-mail invalide.", tone: "error" }); return; }
    setSavingEmail(true); setEmailMessage(null);
    const { error } = await supabaseBrowser.auth.updateUser({ email: trimmedEmail });
    setEmailMessage(error ? { text: error.message, tone: "error" } : { text: "E-mail de confirmation envoyé à la nouvelle adresse. Clique sur le lien reçu pour valider le changement.", tone: "success" });
    setSavingEmail(false);
  }

  const initials = viewer.name.slice(0, 2).toUpperCase();

  return <>
    <div className="settings-account-head">
      <span className="avatar admin" aria-hidden="true">{initials}</span>
      <div><h3>{viewer.name}</h3><p>{viewer.email}</p></div>
    </div>

    <PanelTitle eyebrow="MON ESPACE" title="Informations personnelles" />
    <p className="section-intro">Ces informations correspondent à ton accès personnel LaBaJo &amp; Co.</p>
    <div className="form-grid">
      <label>Nom<input value={viewer.name} readOnly /></label>
      <label>Rôle applicatif<input value={roleLabel(viewer.role)} readOnly /></label>
      <label>Date de naissance<input value={formatBirthday(viewer.birthdayDay, viewer.birthdayMonth, viewer.birthdayYear)} readOnly /></label>
    </div>
    <p className="section-hint">Le nom, le rôle applicatif et la date de naissance sont gérés par un administrateur — contacte Florent pour une correction.</p>

    <InstallAppCard />

    <h3 className="settings-subhead">Adresse e-mail (identifiant de connexion)</h3>
    <div className="form-grid">
      <label className="span-2">Adresse e-mail
        <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" aria-describedby="settings-email-verify-status" />
      </label>
    </div>
    <p id="settings-email-verify-status">
      <span className={`verify-badge ${emailVerified === null ? "pending" : emailVerified ? "verified" : "unverified"}`}>
        {emailVerified === null ? "Vérification…" : emailVerified ? "✓ Vérifié" : "Non vérifié"}
      </span>
    </p>
    <div className="settings-account-actions">
      <button onClick={() => void updateEmail()} disabled={savingEmail || emailUnchanged}>{savingEmail ? "Envoi…" : "Changer d'adresse e-mail"}</button>
    </div>
    {emailMessage && <p className={`settings-message ${emailMessage.tone}`} role="status">{emailMessage.text}</p>}

    <h3 className="settings-subhead">Mot de passe</h3>
    <div className="form-grid">
      <label>Nouveau mot de passe<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="8 caractères minimum" autoComplete="new-password" /></label>
    </div>
    <div className="settings-account-actions">
      <button onClick={() => void updatePassword()} disabled={savingPassword || password.length < 8}>{savingPassword ? "Mise à jour…" : "Mettre à jour le mot de passe"}</button>
      <button className="logout-button" onClick={onSignOut}>Se déconnecter</button>
    </div>
    {passwordMessage && <p className={`settings-message ${passwordMessage.tone}`} role="status">{passwordMessage.text}</p>}

    {viewer.role !== "admin" && onReplayOnboarding && <div className="onboarding-settings"><div><b>Revoir les premiers pas</b><p>Une visite courte pour comprendre Binance, Ledger et ton portefeuille.</p></div><button type="button" onClick={onReplayOnboarding}>Revoir la visite</button></div>}
    <div className="account-version">Version publiée <strong>{publishedVersion}</strong></div>
  </>;
}

function UsersSettings() {
  return <AdminUsers />;
}

function WalletSettings() {
  const [wallets, setWallets] = useState<Array<{ name: string; address: string }> | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const { data } = await supabaseBrowser.auth.getSession();
      const response = await fetch("/api/admin/users", { headers: { authorization: "Bearer " + (data.session?.access_token ?? "") }, signal: controller.signal });
      const result = await response.json() as { users?: Array<{ name: string; wallet_address?: string | null }> };
      setWallets((result.users ?? []).filter((user) => user.wallet_address).map((user) => ({ name: user.name, address: user.wallet_address as string })));
    })().catch(() => setWallets([]));
    return () => controller.abort();
  }, []);
  return <><PanelTitle eyebrow="PARAMÈTRES" title="Comptes & wallets" /><p className="section-intro">Les adresses publiques Ledger enregistrées pour la famille sont contrôlées sur la blockchain. Jamais de clé privée ni de phrase de récupération. Ajoute ou modifie une adresse depuis Utilisateurs &amp; accès.</p><div className="wallet-list"><article><div className="wallet-logo bitcoin">₿</div><div><strong>Binance commun</strong><p>Compte de passage · parts individuelles à ventiler</p></div><span className="warning-pill">À rapprocher</span></article>{wallets === null ? <p className="section-hint">Chargement…</p> : wallets.length === 0 ? <p className="section-hint">Aucune adresse Ledger enregistrée pour l’instant.</p> : wallets.map((wallet) => <article key={wallet.name}><div className="wallet-logo ledger">L</div><div><strong>Ledger de {wallet.name}</strong><p title={wallet.address}>{wallet.address}</p></div><span className="access">Blockchain connectée</span></article>)}</div><div className="info-callout"><b>Important</b><p>Ces adresses servent uniquement à lire les soldes et transactions publics. Les 24 mots, clés privées, codes PIN et codes Binance ne doivent jamais être saisis ici.</p></div></>;
}

function MemberWalletSettings({ viewer }: { viewer: Viewer }) {
  const address = viewer.walletAddress;
  return <><PanelTitle eyebrow="MES PARAMÈTRES" title="Mon portefeuille" /><p className="section-intro">Tu peux consulter ton adresse publique et son historique. Seul Florent peut modifier les comptes familiaux.</p>{address ? <div className="wallet-list"><article><div className="wallet-logo ledger">L</div><div><strong>Ledger de {viewer.name}</strong><p>{address}</p></div><span className="access">Blockchain connectée</span></article></div> : <div className="info-callout"><b>Aucun portefeuille associé</b><p>Florent pourra ajouter ton compte depuis le back-office.</p></div>}</>;
}

function GiftSettings() {
  return <><PanelTitle eyebrow="PARAMÈTRES" title="Règles des cadeaux" /><div className="form-grid"><label>Montant par cadeau<div className="input-suffix"><input defaultValue="55,00" /><span>EUR</span></div></label><label>Occasions<select defaultValue="birthday"><option value="birthday">Anniversaire + Noël</option></select></label><label>Date de début<input type="date" defaultValue="2022-12-27" /></label><label>Traitement des frais<select defaultValue="included"><option value="included">Inclus dans les 55 €</option></select></label></div><div className="info-callout"><b>Règle active</b><p>Chaque enfant reçoit 55 € au total, frais Binance et frais réseau compris. Les échéances futures sont générées automatiquement.</p></div></>;
}

function SecuritySettings() {
  return <><PanelTitle eyebrow="PARAMÈTRES" title="Sécurité & confidentialité" /><div className="security-grid"><article><span>1</span><div><strong>Connexion personnelle</strong><p>À la mise en ligne, chaque membre utilisera une invitation sécurisée. Aucun mot de passe ne sera visible ou stocké en clair.</p></div><b>Prévu</b></article><article><span>2</span><div><strong>Rôles et permissions</strong><p>Administrateur, adulte, jeune investisseur et lecture seule.</p></div><b>Défini</b></article><article><span>3</span><div><strong>Données sensibles</strong><p>Les phrases Ledger, clés privées, codes Binance et codes 2FA sont interdits dans l’application.</p></div><b>Actif</b></article></div></>;
}

function DataSettings() {
  return <><PanelTitle eyebrow="PARAMÈTRES" title="Données & exports" /><div className="export-card"><div><strong>Registre de rapprochement</strong><p>Exporter l’historique des cadeaux, les quantités BTC, les soldes Binance/Ledger et les écarts.</p></div><button>Exporter en Excel</button></div><div className="export-card"><div><strong>Sauvegarde familiale</strong><p>Une sauvegarde chiffrée sera disponible avec la version en ligne.</p></div><button disabled>Bientôt</button></div></>;
}
