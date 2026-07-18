"use client";

import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "../lib/supabase-browser";
import "./investment-access-settings.css";

type ShareMember = { id: string; name: string; role: "admin" | "adult" | "child" | "viewer" };
type AccessState = { scope: "family" | "selected"; selectedIds: string[]; members: ShareMember[] };

async function authHeaders() {
  const { data } = await supabaseBrowser.auth.getSession();
  return { authorization: "Bearer " + (data.session?.access_token ?? ""), "content-type": "application/json" };
}

export function InvestmentAccessSettings() {
  const [access, setAccess] = useState<AccessState | null>(null);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch("/api/investment-access", { headers: await authHeaders() });
    const result = await response.json() as AccessState & { error?: string };
    if (!response.ok) throw new Error(result.error ?? "Chargement impossible");
    setAccess(result);
  }, []);

  useEffect(() => { void load().catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Supabase indisponible")); }, [load]);

  function setScope(scope: AccessState["scope"]) {
    setAccess((current) => current ? { ...current, scope } : current);
  }
  function toggleMember(id: string) {
    setAccess((current) => current ? { ...current, selectedIds: current.selectedIds.includes(id) ? current.selectedIds.filter((selectedId) => selectedId !== id) : [...current.selectedIds, id] } : current);
  }
  async function save() {
    if (!access) return;
    setSaving(true); setMessage("");
    try {
      const response = await fetch("/api/investment-access", { method: "PATCH", headers: await authHeaders(), body: JSON.stringify({ scope: access.scope, selectedIds: access.selectedIds }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Enregistrement impossible");
      setMessage("Pr\u00e9f\u00e9rences de partage enregistr\u00e9es.");
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Enregistrement impossible"); }
    finally { setSaving(false); }
  }

  return <section className="investment-access-settings">
    <p className="settings-eyebrow">{"CONFIDENTIALIT\u00c9"}</p><h2>Partage de mes investissements</h2><p className="section-intro">{"Choisis qui peut consulter tes comptes, soldes et positions. Les administrateurs conservent un acc\u00e8s de gestion."}</p>
    {!access ? <p className="info-callout">Chargement des droits de partage...</p> : <>
      <fieldset className="investment-access-options"><legend>Qui peut voir mes investissements ?</legend>
        <label className={access.scope === "family" ? "selected" : ""}><input type="radio" name="investment-access" checked={access.scope === "family"} onChange={() => setScope("family")} /><span><b>Toute la famille active</b><small>Tous les utilisateurs actifs de Cap Family peuvent consulter tes investissements.</small></span></label>
        <label className={access.scope === "selected" ? "selected" : ""}><input type="radio" name="investment-access" checked={access.scope === "selected"} onChange={() => setScope("selected")} /><span><b>{"Personnes s\u00e9lectionn\u00e9es"}</b><small>{"Seuls les membres coch\u00e9s ci-dessous y auront acc\u00e8s."}</small></span></label>
      </fieldset>
      {access.scope === "selected" && <div className="investment-access-members"><p>{"Personnes autoris\u00e9es"}</p>{access.members.length ? access.members.map((member) => <label key={member.id}><input type="checkbox" checked={access.selectedIds.includes(member.id)} onChange={() => toggleMember(member.id)} /><span>{member.name}</span><small>{member.role === "admin" ? "Administrateur" : member.role === "viewer" ? "Amatxi" : "Utilisateur"}</small></label>) : <p>Aucun autre utilisateur actif.</p>}</div>}
      <div className="investment-access-actions"><button type="button" onClick={() => void save()} disabled={saving}>{saving ? "Enregistrement..." : "Enregistrer mes preferences"}</button>{message && <p role="status">{message}</p>}</div>
    </>}
  </section>;
}
