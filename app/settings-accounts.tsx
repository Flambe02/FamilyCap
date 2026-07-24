"use client";

import { useCallback, useEffect, useState } from "react";
import type { Viewer } from "../lib/auth-types";
import type { View } from "../lib/navigation";
import { supabaseBrowser } from "../lib/supabase-browser";
import { SettingsSection, SettingsModal, SettingsMessage } from "./settings-ui";

// Écran « Mes comptes » : vue simple des comptes appartenant au membre (Bitcoin cadeaux réels +
// comptes financiers PEA/compte-titres). Données réelles uniquement, portée serveur au membre.
// Ne remplace pas la section principale Investissements ; aucun bouton d'ajout (réservé admin).

type GiftRow = { member_name: string; occasion: string; gift_date: string; amount_eur: number; btc_amount: number; custody?: string; ledger_amount?: number | null; is_deleted?: boolean };
type PortfolioAccount = {
  id: string; name?: string; institution?: string | null; accountType: string; currency: string; memberName: string | null;
  accountNumberLast4?: string | null; ibanLast4?: string | null; openedAt?: string | null;
  monthlyTarget?: number | null; openingBalance?: number | null; notes?: string | null;
};
type PortfolioHolding = { account_id: string; quantity: number; last_price: number | null };
type AccountLine = { key: string; name: string; type: string; valueEur: number | null; navigate?: View; account?: PortfolioAccount };

const euro = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });

const TYPE_LABELS: Record<string, string> = {
  bitcoin: "Bitcoin", pea: "PEA", securities: "Compte-titres", bank: "Compte courant",
  savings: "Épargne", crypto_exchange: "Plateforme crypto", other: "Autre",
};

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabaseBrowser.auth.getSession();
  return { authorization: "Bearer " + (data.session?.access_token ?? "") };
}

export function AccountsSettings({ viewer, onNavigate, scopeOverride }: { viewer: Viewer; onNavigate?: (view: View) => void; scopeOverride?: "family" | "selected" }) {
  const [lines, setLines] = useState<AccountLine[] | null>(null);
  const [visible, setVisible] = useState(true);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<{ account: PortfolioAccount; valueEur: number | null } | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: "success" | "error" | "info" } | null>(null);
  const canEdit = viewer.role === "admin";

  const load = useCallback(async () => {
    const headers = await authHeaders();
    // En gestion admin (scopeOverride fourni), la visibilité vient du membre ciblé : on n'interroge
    // pas /api/investment-access (qui renverrait le partage de l'administrateur, pas celui du membre).
    const [giftsRes, ledgerRes, portfolioRes, accessRes] = await Promise.all([
      fetch("/api/gifts", { headers }),
      fetch("/api/ledger?priceOnly=1", { headers }),
      fetch("/api/portfolio", { headers }),
      scopeOverride ? Promise.resolve(null) : fetch("/api/investment-access", { headers }),
    ]);

    const giftsBody = await giftsRes.json() as { records?: GiftRow[]; error?: string };
    if (!giftsRes.ok) throw new Error(giftsBody.error ?? "Comptes indisponibles.");
    const ledgerBody = ledgerRes.ok ? await ledgerRes.json() as { bitcoinEur?: number | null } : null;
    const price = ledgerBody && Number(ledgerBody.bitcoinEur) > 0 ? Number(ledgerBody.bitcoinEur) : null;
    const portfolioBody = portfolioRes.ok ? await portfolioRes.json() as { accounts?: PortfolioAccount[]; holdings?: PortfolioHolding[] } : { accounts: [], holdings: [] };
    if (scopeOverride) {
      setVisible(scopeOverride === "family");
    } else {
      const accessBody = accessRes && accessRes.ok ? await accessRes.json() as { scope?: "family" | "selected" } : null;
      setVisible((accessBody?.scope ?? "family") === "family");
    }

    // L'API renvoie les cadeaux actifs et l'historique fusionné dans le périmètre autorisé.
    const memberGifts = (giftsBody.records ?? [])
      .filter((record) => record.member_name === viewer.name && !record.is_deleted)
      .map((record) => ({ ...record, amount_eur: Number(record.amount_eur), btc_amount: Number(record.btc_amount), ledger_amount: record.ledger_amount == null ? null : Number(record.ledger_amount) }));
    const btc = memberGifts.reduce((sum, record) => {
      const owned = record.custody === "Ledger" && Number(record.ledger_amount) > 0 ? Number(record.ledger_amount) : Number(record.btc_amount);
      return sum + Math.max(0, owned || 0);
    }, 0);

    const result: AccountLine[] = [];
    if (btc > 0) result.push({ key: "bitcoin", name: "Bitcoin cadeaux", type: "Bitcoin", valueEur: price ? btc * price : null, navigate: "bitcoin" });

    // Comptes financiers du membre (hors Bitcoin, déjà couvert par les cadeaux) valorisés par positions.
    const holdings = portfolioBody.holdings ?? [];
    const valueByAccount = new Map<string, number>();
    for (const holding of holdings) {
      valueByAccount.set(holding.account_id, (valueByAccount.get(holding.account_id) ?? 0) + holding.quantity * (holding.last_price ?? 0));
    }
    for (const account of (portfolioBody.accounts ?? []).filter((item) => item.memberName === viewer.name && item.accountType !== "bitcoin")) {
      result.push({
        key: account.id,
        name: account.name?.trim() || TYPE_LABELS[account.accountType] || "Compte",
        type: TYPE_LABELS[account.accountType] ?? account.accountType,
        valueEur: valueByAccount.has(account.id) ? (valueByAccount.get(account.id) as number) : null,
        account,
      });
    }

    setLines(result);
  }, [viewer.name, scopeOverride]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try { await load(); }
      catch (caught) { if (!cancelled) { setError(caught instanceof Error ? caught.message : "Comptes indisponibles."); setLines([]); } }
    })();
    return () => { cancelled = true; };
  }, [load]);

  return (
    <SettingsSection title="Mes comptes" subtitle="Suivez vos comptes et la valeur de vos investissements.">
      {error && <p className="set-message error" role="status">{error}</p>}
      <SettingsMessage message={message} />
      {lines === null ? (
        <p className="set-hint">Chargement…</p>
      ) : lines.length === 0 ? (
        <div className="set-empty">
          <p>Aucun compte d’investissement n’est encore associé à votre profil.</p>
          <span>Vos comptes (Bitcoin, PEA, compte-titres) apparaîtront ici dès leur saisie par un administrateur.</span>
        </div>
      ) : (
        <ul className="set-account-list">
          {lines.map((line) => {
            const clickable = Boolean((line.navigate && onNavigate) || line.account);
            const content = (
              <>
                <span className={`set-account-logo ${line.key === "bitcoin" ? "bitcoin" : "generic"}`} aria-hidden="true">{line.key === "bitcoin" ? "₿" : line.type.slice(0, 2).toUpperCase()}</span>
                <span className="set-account-info"><strong>{line.name}</strong><small>{line.type}</small></span>
                <span className="set-account-value">{line.valueEur !== null ? euro.format(line.valueEur) : "—"}<small>{line.valueEur !== null ? "Valeur actuelle" : "Valeur indisponible"}</small></span>
                <span className={`set-badge ${visible ? "ok" : "muted"}`}>{visible ? "Visible" : "Restreint"}</span>
                {clickable ? <span className="set-account-chevron" aria-hidden="true">›</span> : <span className="set-account-chevron placeholder" aria-hidden="true" />}
              </>
            );
            return (
              <li key={line.key}>
                {clickable
                  ? <button type="button" className="set-account-row is-link" onClick={() => { if (line.navigate) onNavigate?.(line.navigate); else if (line.account) setDetail({ account: line.account, valueEur: line.valueEur }); }} aria-label={line.navigate ? `Voir le détail : ${line.name}` : `Informations du compte : ${line.name}`}>{content}</button>
                  : <div className="set-account-row">{content}</div>}
              </li>
            );
          })}
        </ul>
      )}
      <p className="set-note">Seuls les comptes qui vous appartiennent ou qui ont été partagés avec vous sont affichés ici.</p>
      {detail && (
        <AccountDetailModal
          account={detail.account}
          valueEur={detail.valueEur}
          canEdit={canEdit}
          onClose={() => setDetail(null)}
          onSaved={async (updated) => {
            setDetail((current) => (current ? { ...current, account: updated } : current));
            setMessage({ text: "Compte mis à jour.", tone: "success" });
            try { await load(); } catch { /* la liste reste inchangée si le rechargement échoue */ }
          }}
        />
      )}
    </SettingsSection>
  );
}

// Détail d'un compte financier : affichage des informations, et — pour l'administrateur —
// édition (nom, établissement, date d'ouverture, objectif mensuel, solde de départ, note).
// L'écriture passe par /api/admin/accounts (PATCH, requireAdmin). Les identifiants (n° de compte,
// IBAN) restent en lecture seule : seuls leurs 4 derniers caractères ont été enregistrés.
function AccountDetailModal({ account, valueEur, canEdit, onClose, onSaved }: {
  account: PortfolioAccount; valueEur: number | null; canEdit: boolean;
  onClose: () => void; onSaved: (updated: PortfolioAccount) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(account.name ?? "");
  const [institution, setInstitution] = useState(account.institution ?? "");
  const [openedAt, setOpenedAt] = useState(account.openedAt ?? "");
  const [monthlyTarget, setMonthlyTarget] = useState(account.monthlyTarget != null ? String(account.monthlyTarget) : "");
  const [openingBalance, setOpeningBalance] = useState(account.openingBalance != null ? String(account.openingBalance) : "");
  const [notes, setNotes] = useState(account.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const ccy = (account.currency || "EUR").toUpperCase();
  const typeLabel = TYPE_LABELS[account.accountType] ?? account.accountType;
  const ro = !editing;
  const todayISO = new Date().toISOString().slice(0, 10);

  function cancelEdit() {
    setName(account.name ?? "");
    setInstitution(account.institution ?? "");
    setOpenedAt(account.openedAt ?? "");
    setMonthlyTarget(account.monthlyTarget != null ? String(account.monthlyTarget) : "");
    setOpeningBalance(account.openingBalance != null ? String(account.openingBalance) : "");
    setNotes(account.notes ?? "");
    setError("");
    setEditing(false);
  }

  async function save() {
    setError("");
    if (!name.trim()) { setError("Le nom du compte est obligatoire."); return; }
    let mt: number | null = null;
    let ob: number | null = null;
    if (monthlyTarget.trim() !== "") {
      mt = Number(monthlyTarget.replace(",", "."));
      if (!Number.isFinite(mt) || mt < 0) { setError("L’objectif mensuel doit être un montant positif."); return; }
    }
    if (openingBalance.trim() !== "") {
      ob = Number(openingBalance.replace(",", "."));
      if (!Number.isFinite(ob) || ob < 0) { setError("Le solde de départ doit être un montant positif."); return; }
    }
    setSaving(true);
    try {
      const headers = await authHeaders();
      const response = await fetch("/api/admin/accounts", {
        method: "PATCH",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ id: account.id, name: name.trim(), institution: institution.trim(), openedAt: openedAt || null, monthlyTarget: mt, openingBalance: ob, notes: notes.trim() }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      setSaving(false);
      if (!response.ok) { setError(body.error ?? "Enregistrement impossible."); return; }
      setEditing(false);
      onSaved({ ...account, name: name.trim(), institution: institution.trim() || null, openedAt: openedAt || null, monthlyTarget: mt, openingBalance: ob, notes: notes.trim() || null });
    } catch {
      setSaving(false);
      setError("Réseau indisponible.");
    }
  }

  return (
    <SettingsModal open onClose={onClose} title={account.name?.trim() || typeLabel}>
      <div className="set-account-detail-value">
        <span>Valeur actuelle</span>
        <strong>{valueEur !== null ? euro.format(valueEur) : "Valeur indisponible"}</strong>
      </div>
      <div className="set-fields">
        <label className="set-field">
          <span>Nom du compte</span>
          <input value={name} onChange={(event) => setName(event.target.value)} readOnly={ro} aria-readonly={ro} />
        </label>
        <label className="set-field">
          <span>Titulaire</span>
          <input value={account.memberName ?? "—"} readOnly aria-readonly="true" />
        </label>
        <label className="set-field">
          <span>Type de compte</span>
          <input value={typeLabel} readOnly aria-readonly="true" />
        </label>
        <label className="set-field">
          <span>Établissement</span>
          <input value={institution} onChange={(event) => setInstitution(event.target.value)} readOnly={ro} aria-readonly={ro} placeholder={ro ? "—" : "Boursorama Banque"} />
        </label>
        <label className="set-field">
          <span>Devise</span>
          <input value={ccy} readOnly aria-readonly="true" />
        </label>
        <label className="set-field">
          <span>Date d’ouverture</span>
          <input type="date" value={openedAt} max={todayISO} onChange={(event) => setOpenedAt(event.target.value)} readOnly={ro} aria-readonly={ro} />
        </label>
        <label className="set-field">
          <span>N° de compte</span>
          <input value={account.accountNumberLast4 ? `•••• ${account.accountNumberLast4}` : "—"} readOnly aria-readonly="true" />
        </label>
        <label className="set-field">
          <span>IBAN</span>
          <input value={account.ibanLast4 ? `•••• ${account.ibanLast4}` : "—"} readOnly aria-readonly="true" />
        </label>
        <label className="set-field">
          <span>Objectif mensuel ({ccy})</span>
          <input type="number" min="0" step="any" value={monthlyTarget} onChange={(event) => setMonthlyTarget(event.target.value)} readOnly={ro} aria-readonly={ro} placeholder={ro ? "—" : "ex. 150"} />
        </label>
        <label className="set-field">
          <span>Solde de départ ({ccy})</span>
          <input type="number" min="0" step="any" value={openingBalance} onChange={(event) => setOpeningBalance(event.target.value)} readOnly={ro} aria-readonly={ro} placeholder={ro ? "—" : "ex. 5000"} />
        </label>
        <label className="set-field" style={{ gridColumn: "1 / -1" }}>
          <span>Note</span>
          <input value={notes} onChange={(event) => setNotes(event.target.value)} readOnly={ro} aria-readonly={ro} placeholder={ro ? "—" : "Stratégie, bénéficiaire, particularité…"} />
        </label>
      </div>
      <p className="set-hint">Le solde de départ est une information de contexte (montant déjà présent au début du suivi). La valeur et la performance restent calculées à partir des opérations enregistrées. Le n° de compte et l’IBAN ne sont conservés qu’en 4 derniers caractères et ne sont pas modifiables ici.</p>
      {error && <p className="set-message error" role="status">{error}</p>}
      <footer className="set-modal-actions">
        {canEdit && !editing && <button type="button" className="set-btn-primary" onClick={() => setEditing(true)}>Modifier</button>}
        {editing && (
          <>
            <button type="button" className="set-btn" onClick={cancelEdit} disabled={saving}>Annuler</button>
            <button type="button" className="set-btn-primary" onClick={() => void save()} disabled={saving}>{saving ? "Enregistrement…" : "Enregistrer"}</button>
          </>
        )}
        {!canEdit && <button type="button" className="set-btn" onClick={onClose}>Fermer</button>}
      </footer>
    </SettingsModal>
  );
}
