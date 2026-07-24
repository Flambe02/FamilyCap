"use client";

// Assistant de CONFIGURATION d'un compte d'investissement (PEA / compte-titres).
// ADMIN uniquement (rendu seulement si canManage). Ouvert DEPUIS l'écran PEA/CTO : plus besoin
// de partir dans Administration › Comptes & positions pour créer le compte, puis de revenir.
//
// Parcours : 1) informations du compte (titulaire, établissement, identification, ouverture)
//            2) écran de confirmation qui enchaîne sur la première opération ou l'import.
//
// Sécurité (identique à Administration) : on n'enregistre JAMAIS un IBAN ni un numéro de compte
// complet — seuls les 4 derniers caractères sont transmis, le reste ne quitte pas le navigateur.
// L'écriture passe par /api/admin/accounts, protégée par requireAdmin côté serveur.

import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { Viewer } from "../lib/auth-types";
import { useDialogA11y } from "./use-dialog-a11y";
import { authenticatedFetch } from "./investment-shared";
import type { AccountType } from "../lib/portfolio-account";
import type { InvestmentAccount } from "./investment-account";

export type SetupNext = "operation" | "import" | "none";
export type CreatedAccount = { id: string; name: string };

type Member = { id: string; name: string; role?: string; is_active?: boolean };

// Établissements courants : simple aide à la saisie (datalist), la valeur reste libre.
const INSTITUTIONS = [
  "Boursorama Banque", "Fortuneo", "Bourse Direct", "Trade Republic", "Saxo Banque", "BforBank",
  "Degiro", "Interactive Brokers", "Crédit Agricole", "BNP Paribas", "Société Générale", "LCL",
  "Caisse d’Épargne", "La Banque Postale", "Crédit Mutuel", "Yomoni", "Linxea",
];

// 4 derniers caractères alphanumériques : c'est tout ce qui est enregistré, jamais l'IBAN entier.
function last4(value: string): string {
  return value.replace(/[^0-9A-Za-z]/g, "").slice(-4).toUpperCase();
}

export function InvestmentAccountSetup({
  kind, accountType, viewer, existingAccounts, intent = "operation", onClose, onCreated, onOpenAdmin,
}: {
  kind: AccountType;              // "PEA" | "CTO"
  accountType: string;            // financial_accounts.account_type : "pea" | "securities"
  viewer: Viewer;
  existingAccounts: InvestmentAccount[];
  intent?: SetupNext;             // d'où vient l'admin : « Configurer » ou « Importer un historique »
  onClose: () => void;
  onCreated: (account: CreatedAccount, next: SetupNext) => void;
  onOpenAdmin?: () => void;
}) {
  const isCto = kind === "CTO";
  const envLabel = isCto ? "Compte-titres" : "PEA";
  const dialogRef = useDialogA11y(true, onClose);

  const [members, setMembers] = useState<Member[] | null>(null);
  const [memberId, setMemberId] = useState(viewer.id);
  const [institution, setInstitution] = useState("");
  // Nom proposé (« PEA Boursorama Banque ») tant que l'admin ne l'a pas écrit lui-même : dérivé,
  // jamais synchronisé par un effet.
  const [customName, setCustomName] = useState<string | null>(null);
  const name = customName ?? (institution.trim() ? `${envLabel} ${institution.trim()}` : envLabel);
  const [currency, setCurrency] = useState("EUR");
  const [accountNumber, setAccountNumber] = useState("");
  const [iban, setIban] = useState("");
  const [openedAt, setOpenedAt] = useState("");
  const [monthlyTarget, setMonthlyTarget] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<CreatedAccount | null>(null);

  // Titulaires : liste réelle de family_members (jamais une liste en dur). Si la route est
  // indisponible (Supabase non configuré), on retombe sur le seul titulaire certain : le viewer.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await authenticatedFetch("/api/admin/users");
        const data = (await response.json().catch(() => ({}))) as { users?: Member[] };
        if (cancelled) return;
        const list = (data.users ?? []).filter((member) => member.is_active !== false);
        setMembers(list.length ? list : [{ id: viewer.id, name: viewer.name }]);
      } catch {
        if (!cancelled) setMembers([{ id: viewer.id, name: viewer.name }]);
      }
    })();
    return () => { cancelled = true; };
  }, [viewer.id, viewer.name]);

  const ownerName = members?.find((member) => member.id === memberId)?.name ?? viewer.name;
  // Un PEA est unique par personne (règle fiscale) : on prévient sans bloquer, l'admin peut
  // légitimement suivre un second plan (PEA-PME) ou corriger un doublon ensuite.
  const duplicate = useMemo(
    () => existingAccounts.filter((account) => account.accountType === accountType && account.memberId === memberId),
    [existingAccounts, accountType, memberId],
  );

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (!memberId) { setError("Choisissez le titulaire du compte."); return; }
    if (!name.trim()) { setError("Donnez un nom au compte."); return; }
    const payload: Record<string, unknown> = {
      memberId,
      name: name.trim(),
      accountType,
      institution: institution.trim(),
      currency: (currency || "EUR").toUpperCase(),
      accountNumberLast4: last4(accountNumber),
      ibanLast4: last4(iban),
      notes: notes.trim(),
    };
    if (openedAt) payload.openedAt = openedAt;
    if (monthlyTarget.trim() !== "") {
      const target = Number(monthlyTarget.replace(",", "."));
      if (!Number.isFinite(target) || target < 0) { setError("L’objectif mensuel doit être un montant positif."); return; }
      payload.monthlyTarget = target;
    }
    setSaving(true);
    try {
      const response = await authenticatedFetch("/api/admin/accounts", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
      });
      const data = (await response.json().catch(() => ({}))) as { id?: string; error?: string };
      setSaving(false);
      if (!response.ok || !data.id) { setError(data.error ?? "Création impossible."); return; }
      setCreated({ id: data.id, name: name.trim() });
    } catch {
      setSaving(false);
      setError("Réseau indisponible.");
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => !saving && event.target === event.currentTarget && onClose()}>
      <section className="modal pea-modal setup-modal" ref={dialogRef} role="dialog" aria-modal="true" aria-label={`Configurer un ${envLabel.toLowerCase()}`} tabIndex={-1}>
        <header className="pea-modal-head">
          <div>
            <span className="soft-pill">{envLabel}</span>
            <h2>{created ? "Compte créé" : `Configurer ${isCto ? "un compte-titres" : "un PEA"}`}</h2>
          </div>
          <button type="button" className="pea-modal-close" onClick={onClose} aria-label="Fermer">×</button>
        </header>

        <ol className="imp-steps" aria-label="Étapes de la configuration">
          <li className={created ? "done" : "active"}>1. Informations du compte</li>
          <li className={created ? "active" : ""}>2. Premières opérations</li>
        </ol>

        {created ? (
          <div className="imp-panel imp-result">
            <span className="imp-result-icon" aria-hidden="true">✓</span>
            <strong>{created.name} est configuré</strong>
            <p className="imp-hint">
              Le compte de {ownerName} est enregistré. Il ne reste qu’à alimenter son historique : saisissez la
              première opération, ou importez le relevé de votre banque (CSV, XLSX ou PDF scanné).
            </p>
            <div className="setup-next">
              {/* L'action mise en avant est celle demandée au départ (« Configurer » vs « Importer »). */}
              <button type="button" className={intent === "import" ? "secondary-button" : "primary-button"} onClick={() => onCreated(created, "operation")}>Enregistrer la première opération</button>
              <button type="button" className={intent === "import" ? "primary-button" : "secondary-button"} onClick={() => onCreated(created, "import")}>Importer un historique</button>
              <button type="button" className="btc-link" onClick={() => onCreated(created, "none")}>Plus tard</button>
            </div>
          </div>
        ) : (
          <form className="pea-form setup-form" onSubmit={handleSubmit}>
            <p className="setup-legend">Titulaire et établissement</p>
            <label className="pea-field">
              <span>Titulaire</span>
              <select value={memberId} onChange={(event) => setMemberId(event.target.value)} required disabled={members === null}>
                {members === null ? (
                  <option value={viewer.id}>Chargement…</option>
                ) : (
                  members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)
                )}
              </select>
            </label>
            <label className="pea-field">
              <span>Banque / courtier</span>
              <input list="setup-institutions" value={institution} onChange={(event) => setInstitution(event.target.value)} placeholder="Boursorama Banque" />
              <datalist id="setup-institutions">
                {INSTITUTIONS.map((item) => <option key={item} value={item} />)}
              </datalist>
            </label>
            <label className="pea-field pea-field-wide">
              <span>Nom du compte</span>
              <input value={name} onChange={(event) => setCustomName(event.target.value)} required placeholder={`${envLabel} ${ownerName}`} />
            </label>
            {isCto && (
              <label className="pea-field">
                <span>Devise du compte</span>
                <input list="setup-currencies" value={currency} maxLength={3} onChange={(event) => setCurrency(event.target.value.toUpperCase())} placeholder="EUR" />
                <datalist id="setup-currencies">
                  {["EUR", "USD", "GBP", "CHF"].map((item) => <option key={item} value={item} />)}
                </datalist>
              </label>
            )}

            <p className="setup-legend">Identification du compte</p>
            <label className="pea-field">
              <span>N° de compte</span>
              <input value={accountNumber} onChange={(event) => setAccountNumber(event.target.value)} placeholder="•••• 1234" autoComplete="off" />
            </label>
            <label className="pea-field">
              <span>IBAN</span>
              <input value={iban} onChange={(event) => setIban(event.target.value)} placeholder="FR76 •••• •••• •••• 1234" autoComplete="off" />
            </label>
            <p className="imp-hint pea-field-wide">
              🔒 Seuls les <strong>4 derniers caractères</strong> sont enregistrés{last4(iban) || last4(accountNumber) ? ` (compte •••• ${last4(accountNumber) || "—"} · IBAN •••• ${last4(iban) || "—"})` : ""} :
              le reste de la saisie ne quitte pas votre navigateur. Ne saisissez jamais d’identifiant, de code ni de clé privée.
            </p>

            <p className="setup-legend">Suivi</p>
            <label className="pea-field">
              <span>Date d’ouverture</span>
              <input type="date" value={openedAt} max={new Date().toISOString().slice(0, 10)} onChange={(event) => setOpenedAt(event.target.value)} />
            </label>
            <label className="pea-field">
              <span>Objectif mensuel (facultatif)</span>
              <input type="number" min="0" step="any" value={monthlyTarget} onChange={(event) => setMonthlyTarget(event.target.value)} placeholder="ex. 150" />
            </label>
            <label className="pea-field pea-field-wide">
              <span>Note (facultatif)</span>
              <input value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Stratégie, bénéficiaire, particularité…" />
            </label>

            {!isCto && (
              <p className="imp-hint pea-field-wide">
                La date d’ouverture détermine l’antériorité fiscale du PEA (5 ans). Le plafond de versements est de
                150 000 € et un PEA est unique par personne.
              </p>
            )}
            {duplicate.length > 0 && (
              <p className="imp-ai-banner pea-field-wide" role="status">
                {ownerName} a déjà {duplicate.length === 1 ? `un ${envLabel.toLowerCase()} enregistré (${duplicate[0].name})` : `${duplicate.length} ${envLabel.toLowerCase()}s enregistrés`}.
                {isCto ? " Vous pouvez en ajouter un second si le courtier est différent." : " Vérifiez qu’il ne s’agit pas d’un doublon."}
              </p>
            )}

            {error && <p className="pea-form-error" role="alert">{error}</p>}
            <div className="pea-form-actions">
              {onOpenAdmin && <button type="button" className="btc-link setup-admin-link" onClick={onOpenAdmin}>Gérer tous les comptes →</button>}
              <button type="button" className="secondary-button" onClick={onClose} disabled={saving}>Annuler</button>
              <button type="submit" className="primary-button" disabled={saving}>{saving ? "Création…" : "Créer le compte"}</button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
