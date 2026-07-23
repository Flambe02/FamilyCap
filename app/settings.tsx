"use client";

import { useEffect, useState } from "react";
import { AdminUsers } from "./admin-users";
import { InvestmentAccessSettings } from "./investment-access-settings";
import { AccountSettings } from "./settings-account";
import { SecuritySettings } from "./settings-security";
import { AccountsSettings } from "./settings-accounts";
import { LedgerSettings } from "./settings-ledger";
import { NotificationsSettings } from "./settings-notifications";
import { PrivacySettings } from "./settings-privacy";
import { HelpSettings } from "./settings-help";
import { SettingsSection } from "./settings-ui";
import { NavIcon } from "./dashboard-ui";
import type { NavIconId, View } from "../lib/navigation";
import type { Viewer } from "../lib/auth-types";
import { supabaseBrowser } from "../lib/supabase-browser";
import "./settings.css";

type SectionId =
  | "compte" | "securite" | "comptes" | "ledger" | "partage" | "notifications" | "confidentialite" | "aide"
  | "admin-utilisateurs" | "admin-cadeaux" | "admin-wallets" | "admin-donnees";

type NavSection = { id: SectionId; label: string; icon: NavIconId };
type NavGroup = { title: string; adminOnly?: boolean; items: NavSection[] };

// Navigation secondaire des Paramètres. Le menu principal de l'application (sidebar) reste
// inchangé ; ceci n'est jamais une seconde application. Les sections « Administration » ne
// s'affichent que pour l'administrateur réel (jamais en vue/aperçu membre).
const GROUPS: NavGroup[] = [
  { title: "Compte", items: [
    { id: "compte", label: "Mon compte", icon: "users" },
    { id: "securite", label: "Sécurité", icon: "shield-check" },
  ] },
  { title: "Investissements", items: [
    { id: "comptes", label: "Mes comptes", icon: "wallet" },
    { id: "ledger", label: "Ledger", icon: "key" },
    { id: "partage", label: "Partage familial", icon: "users" },
  ] },
  { title: "Préférences", items: [
    { id: "notifications", label: "Notifications", icon: "bell" },
  ] },
  { title: "Confidentialité", items: [
    { id: "confidentialite", label: "Données et confidentialité", icon: "book-open" },
  ] },
  { title: "Aide et découverte", items: [
    { id: "aide", label: "Aide et découverte", icon: "book-open" },
  ] },
  { title: "Administration", adminOnly: true, items: [
    { id: "admin-utilisateurs", label: "Utilisateurs & accès", icon: "users" },
    { id: "admin-cadeaux", label: "Règles des cadeaux", icon: "gift" },
    { id: "admin-wallets", label: "Comptes & wallets", icon: "wallet" },
    { id: "admin-donnees", label: "Export & données", icon: "list-checks" },
  ] },
];

/**
 * Paramètres — vue utilisateur. Trois zones sur desktop : la sidebar principale de l'application
 * (hors de ce composant), la navigation secondaire verticale ci-dessous, et le contenu de la
 * section active. Sur mobile : un index de sections, chaque catégorie ouvrant son propre écran
 * avec un bouton retour.
 */
export function Settings({ viewer, onSignOut, publishedVersion, onReplayOnboarding, onResumeOnboarding, onNavigate }: { viewer: Viewer; onSignOut: () => void; publishedVersion: string; onReplayOnboarding?: () => void; onResumeOnboarding?: () => void; onNavigate?: (view: View) => void }) {
  const groups = GROUPS.filter((group) => !group.adminOnly || viewer.role === "admin");
  const allowed = groups.flatMap((group) => group.items.map((item) => item.id));
  const [active, setActive] = useState<SectionId>("compte");
  const [mobileView, setMobileView] = useState<"index" | "detail">("index");
  const activeSection: SectionId = allowed.includes(active) ? active : "compte";

  function selectSection(id: string) {
    if ((allowed as string[]).includes(id)) { setActive(id as SectionId); setMobileView("detail"); }
  }

  return (
    <div className="settings-page">
      <header className="settings-page-head">
        <h2>Paramètres</h2>
        <p>Gérez votre compte, vos préférences et votre confidentialité.</p>
      </header>

      <div className="settings-layout" data-mobile-view={mobileView}>
        <nav className="settings-nav" aria-label="Sections des paramètres">
          {groups.map((group) => (
            <div className="settings-nav-group" key={group.title}>
              <p className="settings-nav-kicker">{group.title}</p>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={activeSection === item.id ? "settings-nav-item active" : "settings-nav-item"}
                  aria-current={activeSection === item.id ? "page" : undefined}
                  onClick={() => selectSection(item.id)}
                >
                  <span className="settings-nav-icon" aria-hidden="true"><NavIcon id={item.icon} /></span>
                  <span>{item.label}</span>
                  <span className="settings-nav-chevron" aria-hidden="true">›</span>
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="settings-panel-wrap">
          <button type="button" className="settings-back" onClick={() => setMobileView("index")} aria-label="Retour aux sections">‹ Sections</button>

          {activeSection === "compte" && <AccountSettings viewer={viewer} onSignOut={onSignOut} publishedVersion={publishedVersion} />}
          {activeSection === "securite" && <SecuritySettings viewer={viewer} />}
          {activeSection === "comptes" && <AccountsSettings viewer={viewer} onNavigate={onNavigate} />}
          {activeSection === "ledger" && <LedgerSettings viewer={viewer} />}
          {activeSection === "partage" && <InvestmentAccessSettings />}
          {activeSection === "notifications" && <NotificationsSettings />}
          {activeSection === "confidentialite" && <PrivacySettings viewer={viewer} onGoToSection={selectSection} onSignOut={onSignOut} />}
          {activeSection === "aide" && <HelpSettings viewer={viewer} onReplay={onReplayOnboarding} onResume={onResumeOnboarding} onNavigate={onNavigate} onGoToSection={selectSection} />}
          {activeSection === "admin-utilisateurs" && viewer.role === "admin" && <div className="set-section"><AdminUsers /></div>}
          {activeSection === "admin-cadeaux" && viewer.role === "admin" && <GiftSettings />}
          {activeSection === "admin-wallets" && viewer.role === "admin" && <WalletSettings />}
          {activeSection === "admin-donnees" && viewer.role === "admin" && <DataSettings />}
        </div>
      </div>
    </div>
  );
}

/* ---- Sections réservées à l'administrateur (conservées de l'ancien écran, sans régression) ---- */

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
  return <SettingsSection title="Comptes & wallets" subtitle="Adresses publiques Ledger de la famille (lecture blockchain uniquement)."><p className="set-hint">Jamais de clé privée ni de phrase de récupération. Ajoute ou modifie une adresse depuis Utilisateurs &amp; accès.</p><div className="wallet-list"><article><div className="wallet-logo bitcoin">₿</div><div><strong>Binance commun</strong><p>Compte de passage · parts individuelles à ventiler</p></div><span className="warning-pill">À rapprocher</span></article>{wallets === null ? <p className="set-hint">Chargement…</p> : wallets.length === 0 ? <p className="set-hint">Aucune adresse Ledger enregistrée pour l’instant.</p> : wallets.map((wallet) => <article key={wallet.name}><div className="wallet-logo ledger">L</div><div><strong>Ledger de {wallet.name}</strong><p title={wallet.address}>{wallet.address}</p></div><span className="access">Blockchain connectée</span></article>)}</div><div className="info-callout"><b>Important</b><p>Ces adresses servent uniquement à lire les soldes et transactions publics. Les 24 mots, clés privées, codes PIN et codes Binance ne doivent jamais être saisis ici.</p></div></SettingsSection>;
}

function GiftSettings() {
  return <SettingsSection title="Règles des cadeaux" subtitle="Paramètres de génération des cadeaux familiaux."><div className="form-grid"><label>Montant par cadeau<div className="input-suffix"><input defaultValue="55,00" /><span>EUR</span></div></label><label>Occasions<select defaultValue="birthday"><option value="birthday">Anniversaire + Noël</option></select></label><label>Date de début<input type="date" defaultValue="2022-12-27" /></label><label>Traitement des frais<select defaultValue="included"><option value="included">Inclus dans les 55 €</option></select></label></div><div className="info-callout"><b>Règle active</b><p>Chaque enfant reçoit 55 € au total, frais Binance et frais réseau compris. Les échéances futures sont générées automatiquement.</p></div></SettingsSection>;
}

function DataSettings() {
  return <SettingsSection title="Export & données" subtitle="Registre de rapprochement et sauvegardes."><div className="export-card"><div><strong>Registre de rapprochement</strong><p>Exporter l’historique des cadeaux, les quantités BTC, les soldes Binance/Ledger et les écarts.</p></div><button>Exporter en Excel</button></div><div className="export-card"><div><strong>Sauvegarde familiale</strong><p>Une sauvegarde chiffrée sera disponible avec la version en ligne.</p></div><button disabled>Bientôt</button></div></SettingsSection>;
}
