"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "../lib/supabase-browser";
import "./admin-users.css";

type FamilyUser = {
  id: string;
  name: string;
  email?: string | null;
  role: "admin" | "adult" | "child" | "viewer";
  birthday_day?: number | null;
  birthday_month?: number | null;
  access_status: string;
  is_active?: boolean;
};

async function authHeaders() {
  const { data } = await supabaseBrowser.auth.getSession();
  return { authorization: `Bearer ${data.session?.access_token ?? ""}`, "content-type": "application/json" };
}

export function AdminUsers() {
  const [users, setUsers] = useState<FamilyUser[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [draft, setDraft] = useState({ name: "", email: "", role: "child", birthdayDay: "", birthdayMonth: "" });

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

  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/admin/users", {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({ ...draft, birthdayDay: Number(draft.birthdayDay) || undefined, birthdayMonth: Number(draft.birthdayMonth) || undefined, sendInvite: true, redirectTo: window.location.origin }),
      });
      const result = await response.json() as { invitation?: { sent?: boolean; reason?: string }; error?: string };
      if (!response.ok) throw new Error(result.error ?? "Invitation impossible");
      setMessage(result.invitation?.sent ? "Invitation envoyée avec succès." : `Utilisateur autorisé, mais e-mail non envoyé : ${result.invitation?.reason ?? "à vérifier"}`);
      setDraft({ name: "", email: "", role: "child", birthdayDay: "", birthdayMonth: "" });
      setOpen(false); await loadUsers();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Invitation impossible"); }
    finally { setBusy(false); }
  }

  return <section className="panel admin-users-panel"><header><div><span>ACCÈS À LA FAMILLE</span><h2>Utilisateurs & invitations</h2><p>Seules les adresses présentes ici peuvent créer un compte ou utiliser Google.</p></div><button onClick={() => setOpen((value) => !value)}>＋ Inviter une personne</button></header>{open && <form className="invite-form" onSubmit={submit}><label>Nom<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} required /></label><label>Adresse e-mail<input type="email" value={draft.email} onChange={(event) => setDraft({ ...draft, email: event.target.value })} required /></label><label>Rôle<select value={draft.role} onChange={(event) => setDraft({ ...draft, role: event.target.value })}><option value="child">Jeune investisseur</option><option value="adult">Adulte</option><option value="viewer">Lecture seule</option></select></label><label>Jour anniversaire<input type="number" min="1" max="31" value={draft.birthdayDay} onChange={(event) => setDraft({ ...draft, birthdayDay: event.target.value })} /></label><label>Mois<input type="number" min="1" max="12" value={draft.birthdayMonth} onChange={(event) => setDraft({ ...draft, birthdayMonth: event.target.value })} /></label><button disabled={busy}>{busy ? "Envoi…" : "Autoriser et envoyer le lien"}</button></form>}{message && <p className="admin-user-message">{message}</p>}<div className="admin-user-list">{users.map((user) => <article key={user.id}><span>{user.name.slice(0, 2).toUpperCase()}</span><div><strong>{user.name}</strong><small>{user.email || "E-mail à renseigner"}</small></div><em>{user.role === "admin" ? "Administrateur" : user.role === "child" ? "Jeune" : user.role}</em><b className={`user-access ${user.access_status}`}>{user.access_status === "active" ? "Compte actif" : user.access_status === "invited" ? "Invitation envoyée" : "À inviter"}</b></article>)}</div></section>;
}
