"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "../lib/supabase-browser";
import "./admin-users.css";

type DbRole = "admin" | "adult" | "child" | "viewer";
type EditableRole = "admin" | "adult" | "viewer";
type FamilyUser = { id: string; name: string; email?: string | null; role: DbRole; birthday_day?: number | null; birthday_month?: number | null; birthday_year?: number | null; access_status: string; is_active?: boolean; auth_user_id?: string | null; investment_access_scope?: "family" | "selected"; selected_viewer_ids?: string[]; wallet_address?: string | null };
type Draft = { name: string; email: string; role: EditableRole; birthday: string; accessScope: "family" | "selected"; selectedViewerIds: string[]; walletAddress: string };

const EMPTY_DRAFT: Draft = { name: "", email: "", role: "adult", birthday: "", accessScope: "family", selectedViewerIds: [], walletAddress: "" };
const ROLE_LABEL: Record<DbRole, string> = { admin: "Administrateur", adult: "Utilisateur", child: "Utilisateur", viewer: "Amatxi" };

async function authHeaders() {
  const { data } = await supabaseBrowser.auth.getSession();
  return { authorization: "Bearer " + (data.session?.access_token ?? ""), "content-type": "application/json" };
}
function birthdayValue(user: FamilyUser) { if (!user.birthday_month || !user.birthday_day) return ""; const date = String(user.birthday_day).padStart(2, "0") + "/" + String(user.birthday_month).padStart(2, "0"); return user.birthday_year ? date + "/" + user.birthday_year : date; }
function userDraft(user: FamilyUser): Draft { return { name: user.name, email: user.email ?? "", role: user.role === "child" ? "adult" : user.role, birthday: birthdayValue(user), accessScope: user.investment_access_scope ?? "family", selectedViewerIds: user.selected_viewer_ids ?? [], walletAddress: user.wallet_address ?? "" }; }

export function AdminUsers() {
  const [users, setUsers] = useState<FamilyUser[]>([]);
  const [isInviteOpen, setIsInviteOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);

  const loadUsers = useCallback(async () => {
    const response = await fetch("/api/admin/users", { headers: await authHeaders() });
    const result = await response.json() as { users?: FamilyUser[]; error?: string };
    if (!response.ok) throw new Error(result.error ?? "Chargement impossible");
    setUsers(result.users ?? []);
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => { void loadUsers().catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Supabase indisponible")); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadUsers]);

  async function request(path: string, init: RequestInit, fallback: string) {
    const response = await fetch(path, { ...init, headers: { ...(await authHeaders()), ...(init.headers ?? {}) } });
    const result = await response.json() as { error?: string; message?: string };
    if (!response.ok) throw new Error(result.error ?? fallback);
    return result;
  }
  async function createUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusyId("create"); setMessage("");
    try {
      await request("/api/admin/users", { method: "POST", body: JSON.stringify({ name: draft.name, email: draft.email, role: draft.role, birthday: draft.birthday, sendInvite: true, redirectTo: window.location.origin }) }, "Invitation impossible");
      setMessage("Invitation envoy\u00e9e."); setDraft(EMPTY_DRAFT); setIsInviteOpen(false); await loadUsers();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Invitation impossible"); } finally { setBusyId(null); }
  }
  async function saveUser(event: FormEvent<HTMLFormElement>, user: FamilyUser) {
    event.preventDefault(); setBusyId(user.id); setMessage("");
    try {
      // Nom et e-mail ne sont envoy\u00e9s que si renseign\u00e9s : un champ vide laisse
      // la valeur existante inchang\u00e9e c\u00f4t\u00e9 serveur plut\u00f4t que de bloquer l'enregistrement.
      const trimmedName = draft.name.trim();
      const trimmedEmail = draft.email.trim();
      await request("/api/admin/users", { method: "PATCH", body: JSON.stringify({
        id: user.id,
        ...(trimmedName ? { name: trimmedName } : {}),
        ...(trimmedEmail ? { email: trimmedEmail } : {}),
        role: draft.role,
        birthday: draft.birthday,
        accessScope: draft.accessScope,
        selectedViewerIds: draft.selectedViewerIds,
        walletAddress: draft.walletAddress,
      }) }, "Modification impossible");
      setEditingId(null); setMessage("Utilisateur mis \u00e0 jour."); await loadUsers();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Modification impossible"); } finally { setBusyId(null); }
  }
  async function runAction(user: FamilyUser, action: "invite" | "reset_password" | "toggle" | "delete") {
    if (action === "delete" && !window.confirm("Supprimer cet utilisateur et son compte Supabase ?")) return;
    setBusyId(user.id); setMessage("");
    try {
      if (action === "toggle") await request("/api/admin/users", { method: "PATCH", body: JSON.stringify({ id: user.id, isActive: !user.is_active }) }, "Mise a jour impossible");
      else if (action === "delete") await request("/api/admin/users?id=" + encodeURIComponent(user.id), { method: "DELETE" }, "Suppression impossible");
      else { const result = await request("/api/admin/users/actions", { method: "POST", body: JSON.stringify({ action, memberId: user.id, redirectTo: window.location.origin }) }, "Envoi impossible"); setMessage(result.message ?? "E-mail envoy\u00e9."); }
      if (action === "toggle") setMessage(user.is_active ? "Acc\u00e8s d\u00e9sactiv\u00e9." : "Acc\u00e8s r\u00e9activ\u00e9.");
      if (action === "delete") setMessage("Utilisateur supprim\u00e9.");
      await loadUsers();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Action impossible"); } finally { setBusyId(null); }
  }
  function toggleViewer(id: string) { setDraft((current) => ({ ...current, selectedViewerIds: current.selectedViewerIds.includes(id) ? current.selectedViewerIds.filter((selectedId) => selectedId !== id) : [...current.selectedViewerIds, id] })); }

  return <section className="panel admin-users-panel">
    <header><div><span>{"ACC\u00c8S A LA FAMILLE"}</span><h2>Utilisateurs et invitations</h2><p>Gérez les accès, les rôles et le partage des investissements.</p></div><button type="button" onClick={() => setIsInviteOpen((value) => !value)}>+ Inviter une personne</button></header>
    {isInviteOpen && <form className="invite-form compact" onSubmit={createUser}><label>Nom<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} required /></label><label>Adresse e-mail<input type="email" value={draft.email} onChange={(event) => setDraft({ ...draft, email: event.target.value })} required title="Nécessaire pour envoyer l'invitation" /></label><label>{"R\u00f4le"}<select value={draft.role} onChange={(event) => setDraft({ ...draft, role: event.target.value as EditableRole })}><option value="adult">Utilisateur</option><option value="viewer">Amatxi</option><option value="admin">Administrateur</option></select></label><label>Date anniversaire<input type="text" inputMode="numeric" pattern="[0-3][0-9]/[0-1][0-9](/[0-9]{4})?" placeholder="JJ/MM/AAAA" value={draft.birthday} onChange={(event) => setDraft({ ...draft, birthday: event.target.value })} /></label><button disabled={busyId === "create"}>{busyId === "create" ? "Envoi..." : "Envoyer le lien"}</button></form>}
    {message && <p className="admin-user-message" role="status">{message}</p>}
    <div className="admin-user-list">{users.map((user) => {
      const isPrimary = user.email?.toLowerCase() === "florent.lambert@gmail.com";
      const isEditing = editingId === user.id;
      const isBusy = busyId === user.id;
      const eligibleViewers = users.filter((candidate) => candidate.id !== user.id && candidate.is_active !== false);
      return <article key={user.id} className={user.is_active === false ? "is-inactive" : ""}><span>{user.name.slice(0, 2).toUpperCase()}</span><div className="admin-user-identity"><strong>{user.name}</strong><small>{user.email || "E-mail \u00e0 renseigner"}</small></div><div className="admin-user-meta"><em>{ROLE_LABEL[user.role]}</em><b className={["user-access", user.access_status].join(" ")}>{user.is_active === false ? "Acc\u00e8s d\u00e9sactiv\u00e9" : user.access_status === "active" ? "Compte actif" : "Invitation \u00e0 envoyer"}</b></div><div className="admin-user-actions">{isPrimary ? <small>Compte principal prot\u00e9g\u00e9</small> : <button type="button" onClick={() => { setEditingId(isEditing ? null : user.id); setDraft(userDraft(user)); }}>Modifier</button>}</div>
        {isEditing && <form className="admin-user-edit" onSubmit={(event) => void saveUser(event, user)}><div className="admin-user-edit-fields"><label>Nom<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Nom" /></label><label>Adresse e-mail<input type="email" value={draft.email} onChange={(event) => setDraft({ ...draft, email: event.target.value })} placeholder="À renseigner plus tard" /></label><label>{"R\u00f4le"}<select value={draft.role} onChange={(event) => setDraft({ ...draft, role: event.target.value as EditableRole })}><option value="adult">Utilisateur</option><option value="viewer">Amatxi</option><option value="admin">Administrateur</option></select></label><label>Date anniversaire<input type="text" inputMode="numeric" pattern="[0-3][0-9]/[0-1][0-9](/[0-9]{4})?" placeholder="JJ/MM/AAAA" value={draft.birthday} onChange={(event) => setDraft({ ...draft, birthday: event.target.value })} /></label><label>Portefeuille Bitcoin (adresse ou clé étendue)<input value={draft.walletAddress} onChange={(event) => setDraft({ ...draft, walletAddress: event.target.value })} placeholder="zpub… (recommandé) ou bc1q… — jamais les 24 mots" /><small className="set-hint">Collez la clé publique étendue (xpub/ypub/zpub) exportée par Ledger Live pour suivre automatiquement toutes les adresses du compte. Une simple adresse reste acceptée.</small></label></div>
          <fieldset className="admin-visibility"><legend>Visualisation des investissements</legend><label><input type="radio" name={"visibility-" + user.id} checked={draft.accessScope === "family"} onChange={() => setDraft({ ...draft, accessScope: "family" })} /> Accès complet pour tous les utilisateurs actifs</label><label><input type="radio" name={"visibility-" + user.id} checked={draft.accessScope === "selected"} onChange={() => setDraft({ ...draft, accessScope: "selected" })} /> Accès réservé aux personnes sélectionnées</label>{draft.accessScope === "selected" && <div className="admin-visibility-members">{eligibleViewers.map((candidate) => <label key={candidate.id}><input type="checkbox" checked={draft.selectedViewerIds.includes(candidate.id)} onChange={() => toggleViewer(candidate.id)} /> {candidate.name}</label>)}</div>}</fieldset>
          <div className="admin-user-edit-actions"><button disabled={isBusy}>{isBusy ? "Enregistrement..." : "Enregistrer"}</button><button type="button" className="secondary" onClick={() => setEditingId(null)}>Annuler</button>{!isPrimary && <><button type="button" onClick={() => void runAction(user, user.auth_user_id ? "reset_password" : "invite")}>{user.auth_user_id ? "Envoyer lien mot de passe" : "Envoyer l'invitation"}</button><button type="button" onClick={() => void runAction(user, "toggle")}>{user.is_active === false ? "R\u00e9activer" : "D\u00e9sactiver"}</button><button type="button" className="danger" onClick={() => void runAction(user, "delete")}>Supprimer</button></>}</div>
        </form>}</article>;
    })}</div>
  </section>;
}
