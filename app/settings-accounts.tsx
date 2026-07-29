"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { Viewer } from "../lib/auth-types";
import type { View } from "../lib/navigation";
import { authHeader } from "../lib/supabase-session";
import { computeAccountModel, priceKeyOf, type AccountOperation, type InstrumentPrice } from "../lib/portfolio-account";
import { getLatestFxRate, type FxRateRow } from "../lib/fx-rates";
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
type PortfolioHolding = { account_id: string; quantity: number; last_price: number | null; symbol?: string | null; isin?: string | null; name?: string | null; asset_type?: string | null };
type PortfolioOperation = AccountOperation;
type AccountLine = { key: string; name: string; type: string; valueEur: number | null; navigate?: View; account?: PortfolioAccount };

const euro = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });

const TYPE_LABELS: Record<string, string> = {
  bitcoin: "Bitcoin", pea: "PEA", securities: "Compte-titres", bank: "Compte courant",
  savings: "Épargne", crypto_exchange: "Plateforme crypto", other: "Autre",
};

async function authHeaders(): Promise<Record<string, string>> {
  return authHeader();
}

/**
 * Formulaire guidé de création d'un PEA / compte-titres par LE MEMBRE lui-même.
 *
 * `canWrite` (et non plus `canEdit === admin`) : le membre écrit via /api/investment-accounts,
 * la route self-service qui force `member_id` sur l'appelant. L'admin, lui, continue d'écrire par
 * /api/admin/accounts (il peut créer le compte de n'importe qui). Auparavant tout le formulaire
 * était `disabled` dès que le rôle n'était pas admin — or l'admin ne voit JAMAIS ces défis
 * (isChallengeEligible n'accepte que adult/child), donc personne ne pouvait terminer l'étape.
 */
function PeaChallengeSetup({ viewer, canWrite, isAdmin, accountType, onSaved, onNavigate }: {
  viewer: Viewer; canWrite: boolean; isAdmin: boolean; accountType: "pea" | "securities";
  onSaved: () => void; onNavigate?: (view: View) => void;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const label = accountType === "pea" ? "PEA" : "compte-titres";
  const [situation, setSituation] = useState<"existing" | "opening">("existing");
  const [institution, setInstitution] = useState("");
  const [name, setName] = useState(accountType === "pea" ? "Mon PEA" : "Mon compte-titres");
  const [openedAt, setOpenedAt] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState<{ points: number; totalPoints: number | null; rank: number | null; nextSlug: string | null } | null>(null);

  useEffect(() => { titleRef.current?.focus(); }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canWrite || saving || situation !== "existing") return;
    if (!institution.trim()) { setError("Indiquez l'établissement financier."); return; }
    setSaving(true); setError("");
    try {
      const headers = await authHeaders();
      // Le membre passe par la route self-service (member_id forcé côté serveur) ; l'admin garde
      // sa route, qui seule permet de créer le compte d'un AUTRE membre.
      const response = isAdmin
        ? await fetch("/api/admin/accounts", {
            method: "POST", headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ memberId: viewer.id, name: name.trim() || `Mon ${label}`, accountType, institution: institution.trim(), currency: "EUR", openedAt: openedAt || undefined }),
          })
        : await fetch("/api/investment-accounts", {
            method: "POST", headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ name: name.trim() || `Mon ${label}`, accountType, institution: institution.trim(), openedAt: openedAt || undefined }),
          });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Enregistrement impossible.");
      const [pointsResponse, onboardingResponse] = await Promise.all([
        fetch("/api/challenges/points", { headers }),
        fetch("/api/challenges/onboarding", { headers }),
      ]);
      const pointsBody = pointsResponse.ok ? await pointsResponse.json() as { totalPoints?: number; rank?: number } : null;
      const onboardingBody = onboardingResponse.ok ? await onboardingResponse.json() as { missions?: { slug: string; points: number; status: "todo" | "done" }[] } : null;
      const awardedPoints = onboardingBody?.missions?.find((mission) => mission.slug === "onboarding_account_setup")?.points ?? 300;
      const nextSlug = onboardingBody?.missions?.find((mission) => mission.status === "todo")?.slug ?? null;
      setSuccess({ points: awardedPoints, totalPoints: Number.isFinite(pointsBody?.totalPoints) ? Number(pointsBody?.totalPoints) : null, rank: Number.isFinite(pointsBody?.rank) ? Number(pointsBody?.rank) : null, nextSlug });
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Enregistrement impossible.");
    } finally { setSaving(false); }
  }

  function continueWithNextChallenge() {
    if (!onNavigate || typeof window === "undefined") { onNavigate?.("investissements-suggestions"); return; }
    const url = new URL(window.location.href);
    if (success?.nextSlug === "onboarding_monthly_plan") {
      url.searchParams.set("settings", "rythme");
      url.searchParams.set("challenge", success.nextSlug);
      window.history.replaceState(null, "", `${url.pathname}?${url.searchParams.toString()}`);
      onNavigate("parametres");
      return;
    }
    if (success?.nextSlug === "onboarding_existing_portfolio" || success?.nextSlug === "onboarding_first_purchase") {
      window.history.replaceState(null, "", `${url.pathname}${url.search}#pea/investir`);
      onNavigate("investissements-pea");
      return;
    }
    onNavigate("investissements-suggestions");
  }

  if (success) return (
    <section className="set-challenge-success" aria-live="polite">
      <span aria-hidden="true">🎉</span>
      <h3 tabIndex={-1} ref={titleRef}>Ton {label} est configuré !</h3>
      <p>Bravo, tu viens de terminer ton premier défi d’investissement.</p>
      <strong>+{success.points} points</strong>
      {success.totalPoints !== null && <small>Nouveau total : {success.totalPoints} points.</small>}
      {success.rank !== null && <small>Position actuelle : {success.rank}.</small>}
      <div className="set-actions"><button type="button" className="set-btn-primary" onClick={continueWithNextChallenge}>Continuer avec le défi suivant</button><button type="button" className="set-btn" onClick={() => onNavigate?.("investissements-suggestions")}>Voir tous mes défis</button></div>
    </section>
  );

  return (
    <section className="set-challenge-guide" aria-labelledby="pea-challenge-title">
      <p className="set-challenge-kicker">Défi · Configure ton {label}</p>
      <h3 id="pea-challenge-title" tabIndex={-1} ref={titleRef}>Complète cette étape pour gagner 300 points.</h3>
      {canWrite && !isAdmin && <p className="set-hint">Renseigne ton {label} : tu pourras ensuite suivre tes investissements et définir ton rythme.</p>}
      {canWrite && isAdmin && <p className="set-hint">Vous configurez le {label} de {viewer.name}.</p>}
      {!canWrite && <p className="set-message info">Lecture seule : cet aperçu n’enregistre rien. Le membre configure son {label} depuis son propre espace.</p>}
      <form className="set-fields" onSubmit={submit}>
        <label className="set-field"><span>Situation</span><select value={situation} onChange={(event) => setSituation(event.target.value as "existing" | "opening")} disabled={!canWrite || saving}><option value="existing">J’ai déjà un {label}</option><option value="opening">Je souhaite en ouvrir un</option></select></label>
        {situation === "existing" ? <>
          <label className="set-field"><span>Établissement financier</span><input value={institution} onChange={(event) => setInstitution(event.target.value)} placeholder="ex. Boursorama Banque" disabled={!canWrite || saving} required /></label>
          <label className="set-field"><span>Nom du compte</span><input value={name} onChange={(event) => setName(event.target.value)} disabled={!canWrite || saving} /></label>
          <label className="set-field"><span>Date d’ouverture (facultative)</span><input type="date" value={openedAt} max={new Date().toISOString().slice(0, 10)} onChange={(event) => setOpenedAt(event.target.value)} disabled={!canWrite || saving} /></label>
        </> : <p className="set-hint">Un projet d’ouverture ne crée pas de compte actif et ne valide pas le défi. Reviens ici lorsque ton {label} sera réellement ouvert.</p>}
        {error && <p className="set-message error" role="alert">{error}</p>}
        <div className="set-actions"><button type="button" className="set-btn" onClick={() => onNavigate?.("investissements-suggestions")} disabled={saving}>Je le ferai plus tard</button>{situation === "existing" && <button type="submit" className="set-btn-primary" disabled={!canWrite || saving}>{saving ? "Enregistrement…" : `Enregistrer mon ${label} et terminer le défi`}</button>}</div>
      </form>
    </section>
  );
}

export function AccountsSettings({ viewer, onNavigate, scopeOverride, guidedChallenge, guidedAccountType }: { viewer: Viewer; onNavigate?: (view: View) => void; scopeOverride?: "family" | "selected"; guidedChallenge?: "onboarding_account_setup" | null; guidedAccountType?: "pea" | "securities" }) {
  const [lines, setLines] = useState<AccountLine[] | null>(null);
  const [visible, setVisible] = useState(true);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<{ account: PortfolioAccount; valueEur: number | null } | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: "success" | "error" | "info" } | null>(null);
  const [creating, setCreating] = useState<"pea" | "securities" | null>(null);
  // `scopeOverride` est fourni uniquement par AdminMemberSettings : la session reste celle de
  // l'administrateur, donc les routes /api/admin/accounts peuvent gérer le compte ciblé sans
  // jamais usurper l'identité du membre affiché.
  const isAdminPreview = scopeOverride !== undefined;
  const canEdit = viewer.role === "admin" || isAdminPreview;
  // La création self-service reste interdite dans l'aperçu : elle forcerait le member_id de
  // l'administrateur. Les comptes existants, eux, passent par la route admin sécurisée.
  const canWrite = !isAdminPreview;
  const isAdmin = viewer.role === "admin";

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
    const portfolioBody = portfolioRes.ok ? await portfolioRes.json() as { accounts?: PortfolioAccount[]; holdings?: PortfolioHolding[]; operations?: PortfolioOperation[]; fxRates?: FxRateRow[] } : { accounts: [], holdings: [], operations: [], fxRates: [] };
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

    // Comptes financiers du membre (hors Bitcoin, déjà couvert par les cadeaux).
    // Valorisation COHÉRENTE avec l'écran PEA/CTO : dès qu'un compte porte des opérations
    // (y compris un achat enregistré par le membre lui-même), sa valeur est DÉRIVÉE des opérations
    // (source de vérité unique, lib/portfolio-account). En l'absence d'opération, on retombe sur le
    // référentiel de positions `holdings` (cas d'un compte dont l'admin a saisi les positions en
    // direct), afin de ne pas régresser. La progression mensuelle, elle, n'utilise jamais
    // holdings.quantity (uniquement les achats de account_operations).
    const holdings = portfolioBody.holdings ?? [];
    const operations = portfolioBody.operations ?? [];
    // Mêmes taux que l'écran PEA/CTO : sans eux, un compte-titres en dollars serait valorisé
    // ici à zéro alors qu'il affiche sa vraie valeur ailleurs — deux chiffres contradictoires.
    const fxRates = portfolioBody.fxRates ?? [];
    const fxRateAt = (currency: string, date: string) => getLatestFxRate(currency, "EUR", fxRates, { asOf: date, fallbackToEarliest: true })?.rate ?? null;
    const holdingsValueByAccount = new Map<string, number>();
    for (const holding of holdings) {
      holdingsValueByAccount.set(holding.account_id, (holdingsValueByAccount.get(holding.account_id) ?? 0) + holding.quantity * (holding.last_price ?? 0));
    }
    function accountValue(account: PortfolioAccount): number | null {
      const accountOps = operations.filter((op) => op.accountId === account.id);
      if ((account.accountType === "pea" || account.accountType === "securities") && accountOps.length > 0) {
        const priceByKey = new Map<string, InstrumentPrice>();
        for (const holding of holdings.filter((item) => item.account_id === account.id)) {
          priceByKey.set(priceKeyOf({ isin: holding.isin ?? null, symbol: holding.symbol ?? null, name: holding.name ?? null }), { lastPrice: holding.last_price, lastPriceAt: null, assetType: holding.asset_type ?? null, name: holding.name ?? null });
        }
        return computeAccountModel({ operations: accountOps, priceByKey, accountType: account.accountType === "pea" ? "PEA" : "CTO", referenceCurrency: account.currency, fxRateAt }).totalValueEur;
      }
      return holdingsValueByAccount.has(account.id) ? (holdingsValueByAccount.get(account.id) as number) : null;
    }
    for (const account of (portfolioBody.accounts ?? []).filter((item) => item.memberName === viewer.name && item.accountType !== "bitcoin")) {
      result.push({
        key: account.id,
        name: account.name?.trim() || TYPE_LABELS[account.accountType] || "Compte",
        type: TYPE_LABELS[account.accountType] ?? account.accountType,
        valueEur: accountValue(account),
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
      {/* Formulaire guidé : ouvert par un défi (?challenge=…) OU par le bouton « Ajouter » ci-dessous. */}
      {(guidedChallenge === "onboarding_account_setup" || creating) && (
        <PeaChallengeSetup
          key={creating ?? guidedAccountType ?? "pea"}
          viewer={viewer}
          canWrite={canWrite}
          isAdmin={isAdmin}
          accountType={creating ?? guidedAccountType ?? "pea"}
          onSaved={() => { setCreating(null); void load(); }}
          onNavigate={onNavigate}
        />
      )}
      {error && <p className="set-message error" role="status">{error}</p>}
      <SettingsMessage message={message} />
      {lines === null ? (
        <p className="set-hint">Chargement…</p>
      ) : lines.length === 0 ? (
        <div className="set-empty">
          <p>Aucun compte d’investissement n’est encore associé à votre profil.</p>
          {canWrite
            ? <span>Enregistrez votre PEA ou votre compte-titres pour suivre vos investissements.</span>
            : <span>Vos comptes (Bitcoin, PEA, compte-titres) apparaîtront ici dès leur saisie.</span>}
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
      {/* Création permanente : ne dépend plus d'un défi. Un membre qui arrive ici de lui-même doit
          pouvoir enregistrer son compte, sans attendre qu'un administrateur le fasse pour lui. */}
      {canWrite && !creating && guidedChallenge !== "onboarding_account_setup" && (
        <div className="set-actions set-account-add">
          <button type="button" className="set-btn-primary" onClick={() => setCreating("pea")}>Ajouter un PEA</button>
          <button type="button" className="set-btn" onClick={() => setCreating("securities")}>Ajouter un compte-titres</button>
        </div>
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
          onPurged={async (removed) => {
            setDetail(null);
            setMessage({ text: `Portefeuille vidé : ${removed} opération(s) supprimée(s). Le compte est conservé.`, tone: "success" });
            try { await load(); } catch { /* la liste reste inchangée si le rechargement échoue */ }
          }}
          onDeleted={async () => {
            setDetail(null);
            setMessage({ text: `${detail.account.name ?? "Le PEA"} a été supprimé.`, tone: "success" });
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
function AccountDetailModal({ account, valueEur, canEdit, onClose, onSaved, onPurged, onDeleted }: {
  account: PortfolioAccount; valueEur: number | null; canEdit: boolean;
  onClose: () => void; onSaved: (updated: PortfolioAccount) => void; onPurged: (removed: number) => void;
  onDeleted: () => void;
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
  // Vidage du compte : seuls le PEA et le compte-titres portent des opérations, et l'action
  // exige de recopier le nom exact du compte — la même exigence est REJOUÉE côté serveur.
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [purgeConfirm, setPurgeConfirm] = useState("");
  const [purging, setPurging] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);

  const ccy = (account.currency || "EUR").toUpperCase();
  const typeLabel = TYPE_LABELS[account.accountType] ?? account.accountType;
  const ro = !editing;
  const todayISO = new Date().toISOString().slice(0, 10);
  const canPurge = canEdit && (account.accountType === "pea" || account.accountType === "securities");
  const canDelete = canEdit && account.accountType === "pea";
  const accountName = (account.name ?? "").trim();

  async function purge() {
    setError("");
    setPurging(true);
    try {
      const headers = await authHeaders();
      const query = `accountId=${encodeURIComponent(account.id)}&scope=all&confirm=${encodeURIComponent(purgeConfirm.trim())}`;
      const response = await fetch(`/api/pea/operations?${query}`, { method: "DELETE", headers });
      const body = (await response.json().catch(() => ({}))) as { removed?: number; error?: string };
      setPurging(false);
      if (!response.ok) { setError(body.error ?? "Suppression impossible."); return; }
      onPurged(body.removed ?? 0);
    } catch {
      setPurging(false);
      setError("Réseau indisponible.");
    }
  }

  async function deleteAccount() {
    setError("");
    setDeleting(true);
    try {
      const headers = await authHeaders();
      const response = await fetch(`/api/admin/accounts?id=${encodeURIComponent(account.id)}`, { method: "DELETE", headers });
      const body = (await response.json().catch(() => ({}))) as { error?: string; requiresConfirmation?: boolean };
      if (!response.ok) {
        setError(body.requiresConfirmation
          ? "Ce PEA contient des opérations. Utilisez d’abord « Tout effacer », puis supprimez le compte."
          : body.error ?? "Suppression impossible.");
        return;
      }
      onDeleted();
    } catch {
      setError("Réseau indisponible.");
    } finally {
      setDeleting(false);
    }
  }

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

      {/* Zone destructive — PEA et compte-titres uniquement (seuls porteurs d'opérations). */}
      {canPurge && !editing && (
        <div className="set-danger">
          <div>
            <h3>Tout effacer</h3>
            <p>
              Supprime <b>toutes les opérations</b> de ce {typeLabel} — versements, achats, ventes, dividendes, frais — ainsi que les positions et la performance qui en sont dérivées.
              Le compte lui-même, ses informations et ses instruments sont conservés&nbsp;: vous repartez d’un portefeuille vide, prêt pour un nouvel import.
              <span className="set-subtle"> Action irréversible : aucune sauvegarde n’est conservée.</span>
            </p>
          </div>
          {!purgeOpen
            ? <button type="button" className="set-btn-danger" onClick={() => { setPurgeOpen(true); setPurgeConfirm(""); setError(""); }}>Tout effacer</button>
            : (
              <div className="set-fields" style={{ gridColumn: "1 / -1", gridTemplateColumns: "1fr" }}>
                <label className="set-field">
                  <span>Saisissez «&nbsp;{accountName}&nbsp;» pour confirmer</span>
                  <input value={purgeConfirm} onChange={(event) => setPurgeConfirm(event.target.value)} placeholder={accountName} autoComplete="off" />
                </label>
                <div className="set-modal-actions">
                  <button type="button" className="set-btn" onClick={() => { setPurgeOpen(false); setPurgeConfirm(""); }} disabled={purging}>Annuler</button>
                  <button type="button" className="set-btn-danger" disabled={purging || purgeConfirm.trim() !== accountName} onClick={() => void purge()}>
                    {purging ? "Suppression…" : "Effacer définitivement"}
                  </button>
                </div>
              </div>
            )}
        </div>
      )}

      {canDelete && !editing && (
        <div className="set-danger">
          <div>
            <h3>Supprimer ce PEA</h3>
            <p>
              Retire définitivement le compte de {account.memberName ?? "ce membre"}. Si des opérations sont encore enregistrées,
              videz d’abord le portefeuille ci-dessus afin de ne pas supprimer son historique par erreur.
            </p>
          </div>
          {!deleteOpen
            ? <button type="button" className="set-btn-danger" onClick={() => { setDeleteOpen(true); setDeleteConfirm(""); setError(""); }}>Supprimer le PEA</button>
            : (
              <div className="set-fields" style={{ gridColumn: "1 / -1", gridTemplateColumns: "1fr" }}>
                <label className="set-field">
                  <span>Saisissez «&nbsp;{accountName}&nbsp;» pour confirmer</span>
                  <input value={deleteConfirm} onChange={(event) => setDeleteConfirm(event.target.value)} placeholder={accountName} autoComplete="off" />
                </label>
                <div className="set-modal-actions">
                  <button type="button" className="set-btn" onClick={() => { setDeleteOpen(false); setDeleteConfirm(""); }} disabled={deleting}>Annuler</button>
                  <button type="button" className="set-btn-danger" disabled={deleting || deleteConfirm.trim() !== accountName} onClick={() => void deleteAccount()}>
                    {deleting ? "Suppression…" : "Supprimer définitivement le PEA"}
                  </button>
                </div>
              </div>
            )}
        </div>
      )}

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
