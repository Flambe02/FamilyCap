"use client";

import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "../lib/supabase-browser";
import { SettingsSection, SettingsSwitch, SettingsMessage } from "./settings-ui";
import "./investment-access-settings.css";

// Écran « Partage familial » : le membre choisit qui peut consulter SES investissements.
// Le modèle de données (scope « famille » / « personnes sélectionnées » + investment_access_grants)
// et l'API /api/investment-access sont conservés — seule la présentation passe en interrupteurs.
// Les changements sont persistés dans Supabase ; aucune permission n'est purement locale.

type ShareRole = "admin" | "adult" | "child" | "viewer";
type ShareMember = { id: string; name: string; role: ShareRole };
type ShareClasses = { btc: boolean; pea: boolean; cto: boolean };
type AccessState = { scope: "family" | "selected"; selectedIds: string[]; shareClasses: ShareClasses; members: ShareMember[] };
type Message = { text: string; tone: "success" | "error" | "info" };

const ASSET_CLASSES: { key: keyof ShareClasses; label: string; hint: string }[] = [
  { key: "btc", label: "Bitcoin", hint: "Cadeaux et portefeuille BTC." },
  { key: "pea", label: "PEA", hint: "Plan d’épargne en actions." },
  { key: "cto", label: "Compte-titres", hint: "Compte-titres ordinaire (CTO)." },
];

function roleLabel(role: ShareRole) {
  return role === "admin" ? "Administrateur" : role === "viewer" ? "Amatxi" : "Membre de la famille";
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabaseBrowser.auth.getSession();
  return { authorization: "Bearer " + (data.session?.access_token ?? ""), "content-type": "application/json" };
}

export function InvestmentAccessSettings() {
  const [access, setAccess] = useState<AccessState | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch("/api/investment-access", { headers: await authHeaders() });
    const result = await response.json() as Partial<AccessState> & { error?: string };
    if (!response.ok) throw new Error(result.error ?? "Chargement impossible");
    setAccess({
      scope: result.scope ?? "family",
      selectedIds: result.selectedIds ?? [],
      shareClasses: { btc: result.shareClasses?.btc !== false, pea: result.shareClasses?.pea !== false, cto: result.shareClasses?.cto !== false },
      members: result.members ?? [],
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try { await load(); }
      catch (error) { if (!cancelled) setMessage({ text: error instanceof Error ? error.message : "Supabase indisponible", tone: "error" }); }
    })();
    return () => { cancelled = true; };
  }, [load]);

  function setScope(family: boolean) {
    setAccess((current) => current ? { ...current, scope: family ? "family" : "selected" } : current);
    setMessage(null);
  }
  function toggleMember(id: string) {
    setAccess((current) => current ? { ...current, selectedIds: current.selectedIds.includes(id) ? current.selectedIds.filter((selectedId) => selectedId !== id) : [...current.selectedIds, id] } : current);
    setMessage(null);
  }
  function toggleClass(key: keyof ShareClasses, value: boolean) {
    setAccess((current) => current ? { ...current, shareClasses: { ...current.shareClasses, [key]: value } } : current);
    setMessage(null);
  }

  async function save() {
    if (!access) return;
    if (access.scope === "selected" && access.selectedIds.length === 0) {
      setMessage({ text: "Choisissez au moins une personne, ou partagez avec toute la famille.", tone: "error" });
      return;
    }
    setSaving(true); setMessage(null);
    try {
      const response = await fetch("/api/investment-access", { method: "PATCH", headers: await authHeaders(), body: JSON.stringify({ scope: access.scope, selectedIds: access.selectedIds, shareClasses: access.shareClasses }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Enregistrement impossible");
      setMessage({ text: "Préférences de partage enregistrées.", tone: "success" });
      await load();
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : "Enregistrement impossible", tone: "error" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsSection title="Partage familial" subtitle="Choisissez ce que vous partagez, et avec qui.">
      {!access ? <p className="set-hint">Chargement des droits de partage…</p> : (
        <>
          <div className="set-share-classes">
            <p className="set-notif-kicker">Ce que je partage</p>
            <ul className="set-rows">
              {ASSET_CLASSES.map((asset) => (
                <li key={asset.key} className="set-row">
                  <div className="set-row-main">
                    <strong>{asset.label}</strong>
                    <p>{asset.hint}</p>
                  </div>
                  <div className="set-row-side">
                    <SettingsSwitch checked={access.shareClasses[asset.key]} onChange={(value) => toggleClass(asset.key, value)} label={`Partager ${asset.label}`} />
                  </div>
                </li>
              ))}
            </ul>
            <p className="set-hint">Ce que vous désactivez ici reste visible par vous et par l’administrateur, mais n’apparaît pas chez les personnes avec qui vous partagez.</p>
          </div>

          <div className="set-rows">
            <p className="set-notif-kicker">Avec qui je partage</p>
            <div className="set-row">
              <div className="set-row-main">
                <strong>Toute la famille active</strong>
                <p>Tous les utilisateurs actifs de LaBaJo &amp; Co peuvent consulter les classes partagées ci-dessus.</p>
              </div>
              <div className="set-row-side">
                <SettingsSwitch checked={access.scope === "family"} onChange={setScope} label="Partager avec toute la famille active" />
              </div>
            </div>
          </div>

          {access.scope === "selected" && (
            <div className="set-share-members">
              <p className="set-notif-kicker">Personnes autorisées</p>
              {access.members.length ? (
                <ul className="set-rows">
                  {access.members.map((member) => (
                    <li key={member.id} className="set-row">
                      <div className="set-row-main set-row-icon-main">
                        <span className="avatar set-share-avatar" aria-hidden="true">{member.name.slice(0, 2).toUpperCase()}</span>
                        <span><strong>{member.name}</strong><p>{roleLabel(member.role)}</p></span>
                      </div>
                      <div className="set-row-side">
                        <SettingsSwitch checked={access.selectedIds.includes(member.id)} onChange={() => toggleMember(member.id)} label={`Autoriser ${member.name}`} />
                      </div>
                    </li>
                  ))}
                </ul>
              ) : <p className="set-hint">Aucun autre utilisateur actif.</p>}
            </div>
          )}

          <div className="set-actions">
            <button type="button" className="set-btn-primary" onClick={() => void save()} disabled={saving}>{saving ? "Enregistrement…" : "Enregistrer"}</button>
          </div>
          <SettingsMessage message={message} />
          <p className="set-note">Vous pouvez modifier ces accès à tout moment. Les administrateurs conservent un accès de gestion.</p>
        </>
      )}
    </SettingsSection>
  );
}
