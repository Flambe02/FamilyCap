"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Viewer } from "../lib/auth-types";
import type { NavIconId, View } from "../lib/navigation";
import { supabaseBrowser } from "../lib/supabase-browser";
import { NavIcon } from "./dashboard-ui";
import { SettingsSection, SettingsSwitch, SettingsMessage, SettingsModal } from "./settings-ui";
import { NotificationsSettings } from "./settings-notifications";
import { AccountsSettings } from "./settings-accounts";
import { LedgerSettings } from "./settings-ledger";
import { HelpSettings } from "./settings-help";
import { downloadAccountExport } from "../lib/account-settings-client";
import "./settings.css";

// Gestion administrateur des Paramètres d'un membre (rendu dans l'aperçu « Vue <membre> »).
// Toutes les écritures passent par les routes ADMIN protégées par requireAdmin() ; l'identité
// Supabase connectée reste celle de l'administrateur (aucune usurpation de session). Ce composant
// est distinct des écrans self-service (aucune régression du parcours membre).

type AdminMember = {
  id: string; name: string; email: string | null; role: Viewer["role"];
  birthday_day: number | null; birthday_month: number | null; birthday_year: number | null;
  is_active: boolean; access_status?: string; auth_user_id?: string | null;
  investment_access_scope?: "family" | "selected"; wallet_address?: string | null; photo_url?: string | null;
  selected_viewer_ids?: string[]; auth?: { emailConfirmedAt?: string | null; lastSignInAt?: string | null } | null;
};

const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

async function uploadMemberPhoto(memberId: string, file: File): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  form.append("memberId", memberId);
  const { authorization } = await authHeaders();
  const response = await fetch("/api/profile/photo", { method: "POST", headers: { authorization }, body: form });
  const result = await response.json().catch(() => ({})) as { photoUrl?: string; error?: string };
  if (!response.ok || !result.photoUrl) throw new Error(result.error ?? "Envoi de la photo impossible.");
  return result.photoUrl;
}

async function removeMemberPhoto(memberId: string): Promise<void> {
  const { authorization } = await authHeaders();
  const response = await fetch("/api/profile/photo?memberId=" + encodeURIComponent(memberId), { method: "DELETE", headers: { authorization } });
  const result = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(result.error ?? "Suppression de la photo impossible.");
}

type SectionId = "compte" | "securite" | "comptes" | "ledger" | "partage" | "notifications" | "confidentialite" | "aide";
type NavSection = { id: SectionId; label: string; icon: NavIconId };
type NavGroup = { title: string; items: NavSection[] };
type Message = { text: string; tone: "success" | "error" | "info" };

const GROUPS: NavGroup[] = [
  { title: "Compte", items: [{ id: "compte", label: "Mon compte", icon: "users" }, { id: "securite", label: "Sécurité", icon: "shield-check" }] },
  { title: "Investissements", items: [{ id: "comptes", label: "Mes comptes", icon: "wallet" }, { id: "ledger", label: "Ledger", icon: "key" }, { id: "partage", label: "Partage familial", icon: "users" }] },
  { title: "Préférences", items: [{ id: "notifications", label: "Notifications", icon: "bell" }] },
  { title: "Confidentialité", items: [{ id: "confidentialite", label: "Données et confidentialité", icon: "book-open" }] },
  { title: "Aide", items: [{ id: "aide", label: "Aide et découverte", icon: "book-open" }] },
];

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabaseBrowser.auth.getSession();
  return { authorization: "Bearer " + (data.session?.access_token ?? ""), "content-type": "application/json" };
}

export function AdminMemberSettings({ memberName, onExit, onNavigate, onReplayOnboarding, onResumeOnboarding }: { memberName: string; onExit: () => void; onNavigate?: (view: View) => void; onReplayOnboarding?: () => void; onResumeOnboarding?: () => void }) {
  const [members, setMembers] = useState<AdminMember[] | null>(null);
  const [error, setError] = useState("");
  const [active, setActive] = useState<SectionId>("compte");
  const [mobileView, setMobileView] = useState<"index" | "detail">("index");

  const reload = useCallback(async () => {
    const response = await fetch("/api/admin/users", { headers: await authHeaders() });
    const result = await response.json() as { users?: AdminMember[]; error?: string };
    if (!response.ok) throw new Error(result.error ?? "Chargement impossible.");
    setMembers(result.users ?? []);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => { try { await reload(); } catch (caught) { if (!cancelled) setError(caught instanceof Error ? caught.message : "Chargement impossible."); } })();
    return () => { cancelled = true; };
  }, [reload]);

  const member = members?.find((item) => item.name === memberName) ?? null;

  function selectSection(id: string) {
    if (GROUPS.some((group) => group.items.some((item) => item.id === id))) { setActive(id as SectionId); setMobileView("detail"); }
  }

  return (
    <div className="settings-page">
      <header className="settings-page-head">
        <h2>Paramètres</h2>
        <p>Gestion administrateur des réglages de {memberName}.</p>
      </header>

      <div className="set-admin-banner" role="status">
        <span className="set-admin-banner-eye" aria-hidden="true">◐</span>
        <span>Aperçu de <strong>{memberName}</strong> · gestion administrateur. Les modifications s’appliquent au compte du membre.</span>
        <button type="button" onClick={onExit}>Quitter l’aperçu</button>
      </div>

      {error && !member ? (
        <div className="set-section"><p className="set-message error" role="status">{error}</p></div>
      ) : !members ? (
        <div className="set-section"><p className="set-hint">Chargement…</p></div>
      ) : !member ? (
        <div className="set-section"><p className="set-hint">Membre introuvable.</p></div>
      ) : (
        <div className="settings-layout" data-mobile-view={mobileView}>
          <nav className="settings-nav" aria-label="Sections des paramètres">
            {GROUPS.map((group) => (
              <div className="settings-nav-group" key={group.title}>
                <p className="settings-nav-kicker">{group.title}</p>
                {group.items.map((item) => (
                  <button key={item.id} type="button" className={active === item.id ? "settings-nav-item active" : "settings-nav-item"} aria-current={active === item.id ? "page" : undefined} onClick={() => selectSection(item.id)}>
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

            {active === "compte" && <MemberAccount member={member} onSaved={reload} />}
            {active === "securite" && <MemberSecurity member={member} onSaved={reload} />}
            {active === "comptes" && <AccountsSettings viewer={memberAsViewer(member)} onNavigate={onNavigate} scopeOverride={member.investment_access_scope ?? "family"} />}
            {active === "ledger" && <LedgerSettings viewer={memberAsViewer(member)} />}
            {active === "partage" && <MemberSharing member={member} members={members} onSaved={reload} />}
            {active === "notifications" && <NotificationsSettings memberId={member.id} />}
            {active === "confidentialite" && <MemberPrivacy member={member} onGoToSection={selectSection} onSaved={reload} />}
            {active === "aide" && <HelpSettings viewer={memberAsViewer(member)} onReplay={onReplayOnboarding} onResume={onResumeOnboarding} onNavigate={onNavigate} onGoToSection={selectSection} />}
          </div>
        </div>
      )}
    </div>
  );
}

function memberAsViewer(member: AdminMember): Viewer {
  return { id: member.id, email: member.email ?? "", name: member.name, role: member.role, birthdayDay: member.birthday_day, birthdayMonth: member.birthday_month, birthdayYear: member.birthday_year, walletAddress: member.wallet_address ?? null };
}

function roleLabel(role: Viewer["role"]) {
  if (role === "admin") return "Administrateur";
  if (role === "viewer") return "Amatxi (lecture seule)";
  if (role === "adult") return "Adulte";
  return "Jeune membre";
}

async function patchMember(body: Record<string, unknown>): Promise<void> {
  const response = await fetch("/api/admin/users", { method: "PATCH", headers: await authHeaders(), body: JSON.stringify(body) });
  const result = await response.json() as { error?: string };
  if (!response.ok) throw new Error(result.error ?? "Enregistrement impossible.");
}

/* ---- Mon compte (édition admin) ---- */
function MemberAccount({ member, onSaved }: { member: AdminMember; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(member.name);
  const [email, setEmail] = useState(member.email ?? "");
  const [day, setDay] = useState(member.birthday_day?.toString() ?? "");
  const [month, setMonth] = useState(member.birthday_month?.toString() ?? "");
  const [year, setYear] = useState(member.birthday_year?.toString() ?? "");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [photoUrl, setPhotoUrl] = useState(member.photo_url ?? null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState("");
  const photoInputRef = useRef<HTMLInputElement>(null);

  const initials = member.name.slice(0, 2).toUpperCase();
  const emailConfirmed = member.auth?.emailConfirmedAt ? true : member.auth_user_id ? false : null;

  async function pickPhoto(file: File) {
    if (!PHOTO_TYPES.has(file.type)) { setPhotoError("Format non pris en charge. Utilisez JPG, PNG ou WEBP."); return; }
    setPhotoBusy(true); setPhotoError("");
    try {
      const url = await uploadMemberPhoto(member.id, file);
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
      await removeMemberPhoto(member.id);
      setPhotoUrl(null);
    } catch (error) {
      setPhotoError(error instanceof Error ? error.message : "Suppression de la photo impossible.");
    } finally {
      setPhotoBusy(false);
    }
  }

  async function save() {
    if (saving) return;
    if (!name.trim()) { setMessage({ text: "Le nom est obligatoire.", tone: "error" }); return; }
    if (email.trim() && !/^\S+@\S+\.\S+$/.test(email.trim())) { setMessage({ text: "Adresse e-mail invalide.", tone: "error" }); return; }
    const dayNum = Number(day), monthNum = Number(month);
    const birthday = day && month && Number.isFinite(dayNum) && Number.isFinite(monthNum) ? `${dayNum}/${monthNum}${year ? "/" + Number(year) : ""}` : "";
    setSaving(true); setMessage(null);
    try {
      await patchMember({ id: member.id, name: name.trim(), email: email.trim().toLowerCase(), birthday });
      await onSaved();
      setMessage({ text: "Compte du membre mis à jour.", tone: "success" });
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : "Enregistrement impossible.", tone: "error" });
    } finally { setSaving(false); }
  }

  return (
    <SettingsSection title="Mon compte" subtitle={`Informations personnelles de ${member.name}.`}>
      <div className="set-account-hero">
        {photoUrl
          ? <img className="avatar admin set-avatar" src={photoUrl} alt="" aria-hidden="true" />
          : <span className="avatar admin set-avatar" aria-hidden="true">{initials}</span>}
        <div className="set-account-identity">
          <div className="set-account-heading">
            <strong>{member.name}</strong>
            <span className="set-role-badge">{roleLabel(member.role)}</span>
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
        <label className="set-field"><span>Prénom / Nom</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label className="set-field"><span>Rôle applicatif</span><input value={roleLabel(member.role)} readOnly aria-readonly="true" /></label>
        <label className="set-field"><span>Jour de naissance</span><input inputMode="numeric" value={day} onChange={(event) => setDay(event.target.value.replace(/\D/g, ""))} placeholder="JJ" /></label>
        <label className="set-field"><span>Mois de naissance</span><input inputMode="numeric" value={month} onChange={(event) => setMonth(event.target.value.replace(/\D/g, ""))} placeholder="MM" /></label>
        <label className="set-field"><span>Année (facultatif)</span><input inputMode="numeric" value={year} onChange={(event) => setYear(event.target.value.replace(/\D/g, ""))} placeholder="AAAA" /></label>
      </div>
      <p className="set-hint">Le rôle applicatif se modifie dans Utilisateurs &amp; accès.</p>

      <label className="set-field set-field-email">
        <span>Adresse e-mail (identifiant de connexion)</span>
        <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="off" aria-describedby="set-admin-email-status" />
      </label>
      <p id="set-admin-email-status" className="set-email-status">
        <span className={`verify-badge ${emailConfirmed === null ? "pending" : emailConfirmed ? "verified" : "unverified"}`}>
          {emailConfirmed === null ? "Pas encore de compte" : emailConfirmed ? "✓ Vérifié" : "Non vérifié"}
        </span>
      </p>

      <div className="set-actions">
        <button type="button" className="set-btn-primary" onClick={() => void save()} disabled={saving}>{saving ? "Enregistrement…" : "Enregistrer"}</button>
      </div>
      <SettingsMessage message={message} />
    </SettingsSection>
  );
}

/* ---- Sécurité (actions admin) ---- */
function MemberSecurity({ member, onSaved }: { member: AdminMember; onSaved: () => Promise<void> }) {
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState<"reset" | "invite" | "active" | null>(null);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  async function action(kind: "reset_password" | "invite") {
    setBusy(kind === "reset_password" ? "reset" : "invite"); setMessage(null);
    try {
      const redirectTo = typeof window !== "undefined" ? window.location.origin : undefined;
      const response = await fetch("/api/admin/users/actions", { method: "POST", headers: await authHeaders(), body: JSON.stringify({ action: kind, memberId: member.id, redirectTo }) });
      const result = await response.json() as { message?: string; error?: string };
      if (!response.ok) throw new Error(result.error ?? "Action impossible.");
      setMessage({ text: result.message ?? "Fait.", tone: "success" });
      if (kind === "reset_password") setCooldown(45);
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : "Action impossible.", tone: "error" });
    } finally { setBusy(null); }
  }

  async function toggleActive(next: boolean) {
    setBusy("active"); setMessage(null);
    try {
      await patchMember({ id: member.id, isActive: next });
      await onSaved();
      setMessage({ text: next ? "Accès réactivé." : "Accès désactivé.", tone: "success" });
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : "Action impossible.", tone: "error" });
    } finally { setBusy(null); }
  }

  return (
    <SettingsSection title="Sécurité" subtitle={`Accès et connexion de ${member.name}.`}>
      <div className="set-rows">
        <div className="set-row">
          <div className="set-row-main"><strong>Mot de passe & double authentification</strong><p>Gérés par le membre depuis son propre compte. Vous pouvez lui envoyer un lien de réinitialisation.</p></div>
          <div className="set-row-side">
            {member.email
              ? <button type="button" className="set-btn" onClick={() => void action("reset_password")} disabled={busy !== null || cooldown > 0}>{cooldown > 0 ? `Renvoyer (${cooldown}s)` : busy === "reset" ? "Envoi…" : "Envoyer un lien de réinitialisation"}</button>
              : <span className="set-badge muted">Aucune adresse e-mail</span>}
          </div>
        </div>

        <div className="set-row">
          <div className="set-row-main"><strong>Compte de connexion</strong><p>{member.auth_user_id ? "Le membre a un compte actif." : "Le membre n’a pas encore activé son compte."}</p></div>
          <div className="set-row-side">
            {member.auth_user_id
              ? <span className="set-badge ok">Compte actif</span>
              : member.email
                ? <button type="button" className="set-btn" onClick={() => void action("invite")} disabled={busy !== null}>{busy === "invite" ? "Envoi…" : "Envoyer une invitation"}</button>
                : <span className="set-badge muted">Aucune adresse e-mail</span>}
          </div>
        </div>

        <div className="set-row">
          <div className="set-row-main"><strong>Accès à l’application</strong><p>{member.is_active ? "Le membre peut se connecter." : "L’accès du membre est désactivé."}</p></div>
          <div className="set-row-side">
            <SettingsSwitch checked={member.is_active} onChange={(next) => void toggleActive(next)} label="Accès à l’application" disabled={busy !== null} />
          </div>
        </div>
      </div>
      <SettingsMessage message={message} />
    </SettingsSection>
  );
}

/* ---- Partage familial (édition admin) ---- */
function MemberSharing({ member, members, onSaved }: { member: AdminMember; members: AdminMember[]; onSaved: () => Promise<void> }) {
  const [scope, setScope] = useState<"family" | "selected">(member.investment_access_scope ?? "family");
  const [selectedIds, setSelectedIds] = useState<string[]>(member.selected_viewer_ids ?? []);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);

  const others = members.filter((item) => item.id !== member.id && item.is_active);

  async function save() {
    if (scope === "selected" && selectedIds.length === 0) { setMessage({ text: "Choisissez au moins une personne, ou partagez avec toute la famille.", tone: "error" }); return; }
    setSaving(true); setMessage(null);
    try {
      await patchMember({ id: member.id, accessScope: scope, selectedViewerIds: selectedIds });
      await onSaved();
      setMessage({ text: "Partage mis à jour.", tone: "success" });
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : "Enregistrement impossible.", tone: "error" });
    } finally { setSaving(false); }
  }

  return (
    <SettingsSection title="Partage familial" subtitle={`Qui peut consulter les investissements de ${member.name}.`}>
      <div className="set-rows">
        <div className="set-row">
          <div className="set-row-main"><strong>Toute la famille active</strong><p>Tous les utilisateurs actifs peuvent consulter ces investissements.</p></div>
          <div className="set-row-side"><SettingsSwitch checked={scope === "family"} onChange={(next) => { setScope(next ? "family" : "selected"); setMessage(null); }} label="Partager avec toute la famille active" /></div>
        </div>
      </div>

      {scope === "selected" && (
        <div className="set-share-members">
          <p className="set-notif-kicker">Personnes autorisées</p>
          {others.length ? (
            <ul className="set-rows">
              {others.map((other) => (
                <li key={other.id} className="set-row">
                  <div className="set-row-main set-row-icon-main">
                    {other.photo_url
                      ? <img className="avatar set-share-avatar" src={other.photo_url} alt="" aria-hidden="true" />
                      : <span className="avatar set-share-avatar" aria-hidden="true">{other.name.slice(0, 2).toUpperCase()}</span>}
                    <span><strong>{other.name}</strong><p>{roleLabel(other.role)}</p></span>
                  </div>
                  <div className="set-row-side">
                    <SettingsSwitch checked={selectedIds.includes(other.id)} onChange={() => { setSelectedIds((current) => current.includes(other.id) ? current.filter((id) => id !== other.id) : [...current, other.id]); setMessage(null); }} label={`Autoriser ${other.name}`} />
                  </div>
                </li>
              ))}
            </ul>
          ) : <p className="set-hint">Aucun autre utilisateur actif.</p>}
        </div>
      )}

      <div className="set-actions"><button type="button" className="set-btn-primary" onClick={() => void save()} disabled={saving}>{saving ? "Enregistrement…" : "Enregistrer"}</button></div>
      <SettingsMessage message={message} />
    </SettingsSection>
  );
}

/* ---- Données et confidentialité (admin) ---- */
function MemberPrivacy({ member, onGoToSection, onSaved }: { member: AdminMember; onGoToSection: (section: string) => void; onSaved: () => Promise<void> }) {
  const [downloading, setDownloading] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [deactivateOpen, setDeactivateOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [deactivating, setDeactivating] = useState(false);
  const [deactivateError, setDeactivateError] = useState("");

  const lastSignIn = member.auth?.lastSignInAt
    ? new Intl.DateTimeFormat("fr-FR", { dateStyle: "long", timeStyle: "short" }).format(new Date(member.auth.lastSignInAt))
    : "Jamais connecté";

  async function download() {
    setDownloading(true); setMessage(null);
    try { await downloadAccountExport(member.id); setMessage({ text: "Export téléchargé.", tone: "success" }); }
    catch (error) { setMessage({ text: error instanceof Error ? error.message : "Export impossible.", tone: "error" }); }
    finally { setDownloading(false); }
  }

  async function confirmDeactivate() {
    if (confirmText.trim().toUpperCase() !== "SUPPRIMER") { setDeactivateError("Saisissez « SUPPRIMER » pour confirmer."); return; }
    setDeactivating(true); setDeactivateError("");
    try {
      await patchMember({ id: member.id, isActive: false });
      await onSaved();
      setDeactivateOpen(false);
      setMessage({ text: `L’accès de ${member.name} a été désactivé.`, tone: "success" });
    } catch (error) {
      setDeactivateError(error instanceof Error ? error.message : "Désactivation impossible.");
    } finally { setDeactivating(false); }
  }

  return (
    <>
      <SettingsSection title="Données et confidentialité" subtitle={`Données personnelles de ${member.name}.`}>
        <ul className="set-rows">
          <li className="set-row">
            <div className="set-row-main"><strong>Télécharger les données</strong><p>Obtenez une copie des données personnelles du membre.</p><SettingsMessage message={message} /></div>
            <div className="set-row-side"><button type="button" className="set-btn" onClick={() => void download()} disabled={downloading}>{downloading ? "Préparation…" : "Télécharger"}</button></div>
          </li>
          <li className="set-row">
            <div className="set-row-main"><strong>Visibilité familiale</strong><p>Gérez ce que la famille peut consulter.</p></div>
            <div className="set-row-side"><button type="button" className="set-btn" onClick={() => onGoToSection("partage")}>Gérer le partage ›</button></div>
          </li>
          <li className="set-row">
            <div className="set-row-main"><strong>Historique des connexions</strong><p>Dernière connexion : {lastSignIn}.</p><p className="set-subtle">L’historique détaillé n’est pas encore enregistré.</p></div>
          </li>
          <li className="set-row">
            <div className="set-row-main"><strong>Informations sur la confidentialité</strong><p>Découvrez comment les données sont utilisées et protégées.</p></div>
            <div className="set-row-side"><button type="button" className="set-btn" onClick={() => setPrivacyOpen(true)}>En savoir plus ›</button></div>
          </li>
        </ul>
      </SettingsSection>

      <section className="set-danger" aria-labelledby="set-admin-danger-title">
        <div>
          <h3 id="set-admin-danger-title">Désactiver le compte du membre</h3>
          <p>Coupe l’accès de {member.name} à LaBaJo &amp; Co. Les données patrimoniales (cadeaux, virements) sont conservées ; l’accès reste réactivable depuis Sécurité ou Utilisateurs &amp; accès.</p>
        </div>
        <button type="button" className="set-btn-danger" onClick={() => { setConfirmText(""); setDeactivateError(""); setDeactivateOpen(true); }} disabled={!member.is_active}>{member.is_active ? "Désactiver le compte" : "Déjà désactivé"}</button>
      </section>

      <SettingsModal open={privacyOpen} onClose={() => setPrivacyOpen(false)} title="Informations sur la confidentialité">
        <div className="set-prose">
          <p>LaBaJo &amp; Co est un espace privé et familial. Les données d’un membre ne sont visibles que par lui, par les personnes qu’il autorise (partage familial) et par l’administrateur familial.</p>
          <ul>
            <li>Les adresses publiques Ledger servent uniquement à lire des soldes publics ; aucune clé privée n’est stockée.</li>
            <li>Vous pouvez télécharger les données d’un membre ou désactiver son accès depuis cet écran.</li>
          </ul>
        </div>
      </SettingsModal>

      <SettingsModal open={deactivateOpen} onClose={() => { if (!deactivating) setDeactivateOpen(false); }} title="Désactiver le compte du membre">
        <div className="set-prose">
          <p>Vous êtes sur le point de désactiver l’accès de <strong>{member.name}</strong>. Aucune donnée du registre familial n’est supprimée ; l’accès reste réactivable.</p>
          <label className="set-field"><span>Pour confirmer, saisissez <strong>SUPPRIMER</strong></span><input value={confirmText} onChange={(event) => setConfirmText(event.target.value)} autoComplete="off" aria-label="Saisir SUPPRIMER pour confirmer" /></label>
          {deactivateError && <p className="set-message error" role="status">{deactivateError}</p>}
        </div>
        <footer className="set-modal-actions">
          <button type="button" className="set-btn" onClick={() => setDeactivateOpen(false)} disabled={deactivating}>Annuler</button>
          <button type="button" className="set-btn-danger" onClick={() => void confirmDeactivate()} disabled={deactivating || confirmText.trim().toUpperCase() !== "SUPPRIMER"}>{deactivating ? "Désactivation…" : "Confirmer"}</button>
        </footer>
      </SettingsModal>
    </>
  );
}
