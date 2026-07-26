"use client";

// Shell d'investissement PARTAGÉ entre le PEA et le compte-titres (CTO).
// Un seul moteur (lib/portfolio-account.ts), un seul jeu de composants de vue : PEA et CTO
// ne sont que deux `EnvelopeConfig` par-dessus ce shell. Aucune architecture parallèle.
//
// Différences pilotées par la config : titre/logo, hash d'onglet, 6e KPI (performance vs
// impact du change), 3e carte de répartition (géographique vs devise), vue agrégée multi-compte,
// colonnes du tableau de positions, cartes « Investir », champs de la modale, FAQ, états vides.

import { Fragment, useEffect, useMemo, useState, type FormEvent } from "react";
import type { Viewer } from "../lib/auth-types";
import { useDialogA11y } from "./use-dialog-a11y";
import { authenticatedFetch, OP_LABEL, OP_ICON, OP_INFLOW } from "./investment-shared";
import { InvestmentImportWizard } from "./investment-import-wizard";
import { InvestmentAccountSetup, type SetupNext } from "./investment-account-setup";
import {
  euro, euro0, dateOf, GainPill, BitcoinKpi, DonutChart, LegendRow,
  EvolutionChart, PeriodFilter, EmptyState, InfoNote, type ChartSeries,
} from "./bitcoin-components";
import {
  computeAccountModel, windowAccountTimeline, supportedRanges, priceKeyOf, instrumentKey,
  type AccountModel, type AccountOperation, type AccountOperationType, type AccountType, type InstrumentPrice, type PortfolioPosition,
} from "../lib/portfolio-account";
import { computeMonthlyPlanProgress, type MonthlyPlanProgress } from "../lib/investment-plan";
import "./pea-investments.css";

// ---- Types d'entrée (formes renvoyées par /api/portfolio) --------------------------------
export type InvestmentAccount = {
  id: string; name: string; institution?: string | null; accountType: string; currency: string;
  memberId?: string; memberName: string | null;
  // Informations de contexte (renvoyées par /api/portfolio ; null tant que la colonne/migration
  // correspondante n'existe pas). Affichées dans l'onglet « Infos », jamais injectées au moteur.
  accountNumberLast4?: string | null; ibanLast4?: string | null; openedAt?: string | null;
  monthlyTarget?: number | null; openingBalance?: number | null; notes?: string | null;
};
export type InvestmentHolding = { account_id: string; asset_type?: string | null; name?: string | null; symbol?: string | null; isin?: string | null; quantity: number; average_cost: number | null; last_price: number | null; last_price_at?: string | null; currency: string };
export type InvestmentOperation = AccountOperation;

// Plan d'investissement du membre affiché (sous-ensemble utile au shell). L'objectif mensuel
// est l'engagement PERSONNEL du membre (≠ financial_accounts.monthly_target).
export type ShellInvestmentPlan = { monthlyTarget: number | null; targetAccountId: string | null };

export type InvestmentTab = "resume" | "positions" | "investir" | "revenus" | "performance" | "historique" | "comprendre" | "infos";

// Compte rendu du rafraîchissement des cours (une ligne par position). Aucune valeur n'est
// inventée : un instrument introuvable ou coté dans une autre devise est RAPPORTÉ, pas écrit.
export type PriceRefreshRow = {
  key: string; name: string; isin: string | null; ticker: string | null;
  status: "updated" | "unchanged" | "not_found" | "currency_mismatch" | "provider_error";
  price: number | null; currency: string | null; previousPrice: number | null;
  asOf: string | null; provider: string | null; symbol: string | null; message: string | null;
};
export type PriceRefreshReport = { refreshed: number; failed: number; results: PriceRefreshRow[]; error?: string };

// ---- Config d'enveloppe (PEA / CTO) ------------------------------------------------------
export type EnvelopeConfig = {
  kind: AccountType; // "PEA" | "CTO"
  accountType: string; // financial_accounts.account_type : "pea" | "securities"
  hashPrefix: string; // "pea" | "cto"
  pageClass: string; // classes CSS racine
  logoGlyph: string;
  logoClass: string;
  singularTitle: (name: string) => string; // ex. `Compte-titres de ${name}`
  aggregateTitle: string; // ex. "Mes comptes-titres"
  subtitle: string;
  allowAggregate: boolean; // vue « Tous les comptes »
  thirdCard: "geo" | "currency" | "none";
  sixthKpi: "performance" | "fxImpact";
  showRegular: boolean; // carte « Investissement régulier »
  positionsVariant: "pea" | "cto";
  investCards: AccountOperationType[];
  modalAdvanced: boolean; // transferts + devise + taxes + taux de change
  faq: { q: string; a: string }[];
  emptyNoAccount: { icon: string; title: string; description: string; action?: string };
  emptyNoOperation: { icon: string; title: string; description: string; action: string };
  resumeNote: string;
};

const qty = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 4 });
const todayISO = () => new Date().toISOString().slice(0, 10);
const ALL_ACCOUNTS = "__all__";

// Libellés / helpers d'opération déplacés dans investment-shared.ts (évite un cycle d'import
// avec l'assistant d'import). Ré-exportés ici pour préserver la surface publique existante.
export { OP_LABEL, OP_ICON, OP_INFLOW, authenticatedFetch };

// Libellé d'une option du sélecteur de compte. Préfixe le membre quand il diffère du nom du
// compte (l'admin voit plusieurs membres) ; ajoute l'établissement pour distinguer deux comptes
// d'un même membre (ex. « Florent · Boursorama » vs « Florent · Trade Republic »).
function accountOptionLabel(account: InvestmentAccount): string {
  const base = account.memberName && account.memberName !== account.name ? `${account.memberName} · ${account.name}` : account.name;
  return account.institution ? `${base} · ${account.institution}` : base;
}

function tabFromHash(prefix: string): InvestmentTab | null {
  if (typeof window === "undefined") return null;
  const match = new RegExp(`#${prefix}/([\\w-]+)`).exec(window.location.hash);
  const slug = match?.[1];
  const tabs: InvestmentTab[] = ["resume", "positions", "investir", "revenus", "performance", "historique", "comprendre", "infos"];
  return slug && (tabs as string[]).includes(slug) ? (slug as InvestmentTab) : null;
}

// ==========================================================================================
// SHELL
// ==========================================================================================
export function InvestmentAccountShell({
  config, accounts, holdings, operations, marketLoading, viewer, isPreview, canManage,
  memberCanRecord = false, investmentPlan = null, onReload, onConfigure, onOpenRhythm,
}: {
  config: EnvelopeConfig;
  accounts: InvestmentAccount[];
  holdings: InvestmentHolding[];
  operations: InvestmentOperation[];
  marketLoading: boolean;
  viewer: Viewer;
  isPreview: boolean;
  canManage: boolean;
  // Un membre (non-admin, hors aperçu) peut enregistrer un ACHAT sur son propre compte via la
  // route self-service /api/investment-operations. L'écriture admin reste inchangée.
  memberCanRecord?: boolean;
  investmentPlan?: ShellInvestmentPlan | null;
  onReload: () => void;
  onConfigure: () => void;
  onOpenRhythm?: () => void;
}) {
  const isAdmin = viewer.role === "admin";
  const [tab, setTabState] = useState<InvestmentTab>(() => tabFromHash(config.hashPrefix) ?? "resume");
  const [range, setRange] = useState<"1M" | "3M" | "6M" | "1A" | "3A" | "TOUT">("TOUT");
  const [modal, setModal] = useState<{ open: boolean; type: AccountOperationType; mode: "admin" | "member" }>({ open: false, type: "achat", mode: "admin" });
  const [importOpen, setImportOpen] = useState(false);
  // Gestion des lignes : modification d'une opération existante, suppression (une ligne ou toute
  // une position), et vidage complet du compte. Toutes ces actions passent par le serveur ; le
  // portefeuille reste dérivé des opérations restantes (aucune quantité n'est stockée).
  const [editingOp, setEditingOp] = useState<InvestmentOperation | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ title: string; detail: string; ids: string[] } | null>(null);
  const [purgeAccount, setPurgeAccount] = useState<InvestmentAccount | null>(null);
  const [pricesBusy, setPricesBusy] = useState(false);
  const [priceReport, setPriceReport] = useState<PriceRefreshReport | null>(null);
  // Assistant de création de compte, ouvert EN PLACE (plus de détour par Administration).
  // `null` = fermé ; la valeur mémorise l'intention de départ pour proposer la bonne suite.
  const [setupIntent, setSetupIntent] = useState<SetupNext | null>(null);
  const [notice, setNotice] = useState("");

  // Comptes de l'enveloppe visibles. Le partage familial est déjà appliqué côté serveur
  // (/api/portfolio → viewableMemberIds) ; en vue membre on restreint en plus au membre affiché,
  // cohérent avec la vue Bitcoin « limitée à soi ». En aperçu admin, canManage est faux.
  const envAccounts = useMemo(
    () => accounts.filter((account) => account.accountType === config.accountType && (isAdmin || account.memberName === viewer.name)),
    [accounts, isAdmin, viewer.name, config.accountType],
  );

  // Sélection persistée pour la session (jamais en aperçu admin : ne pas modifier un filtre persistant).
  const storageKey = `invsel:${config.kind}`;
  const [selectedId, setSelectedIdState] = useState<string>(() => {
    if (typeof window === "undefined" || isPreview) return config.allowAggregate ? ALL_ACCOUNTS : "";
    return window.sessionStorage.getItem(storageKey) ?? (config.allowAggregate ? ALL_ACCOUNTS : "");
  });
  function setSelectedId(next: string) {
    setSelectedIdState(next);
    if (typeof window !== "undefined" && !isPreview) window.sessionStorage.setItem(storageKey, next);
  }

  function setTab(next: InvestmentTab) {
    setTabState(next);
    if (typeof window !== "undefined") window.history.replaceState(null, "", `#${config.hashPrefix}/${next}`);
  }
  useEffect(() => {
    if (typeof window !== "undefined" && !window.location.hash.startsWith(`#${config.hashPrefix}/`)) {
      window.history.replaceState(null, "", `#${config.hashPrefix}/${tab}`);
    }
    const onHash = () => { const next = tabFromHash(config.hashPrefix); if (next) setTabState(next); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(""), 3200); return () => window.clearTimeout(timer); }, [notice]);

  // Résolution du périmètre : agrégé (« Tous les comptes ») ou un compte précis.
  const canAggregate = config.allowAggregate && envAccounts.length > 1;
  const isAggregate = canAggregate && (selectedId === ALL_ACCOUNTS || selectedId === "");
  const selectedAccount = isAggregate ? null : (envAccounts.find((account) => account.id === selectedId) ?? envAccounts[0] ?? null);
  const scopeAccounts = useMemo(
    () => (isAggregate ? envAccounts : selectedAccount ? [selectedAccount] : []),
    [isAggregate, envAccounts, selectedAccount],
  );
  const hasScope = scopeAccounts.length > 0;

  const accountNameById = useMemo(() => new Map(envAccounts.map((account) => [account.id, account.name])), [envAccounts]);
  const scopeIds = useMemo(() => new Set(scopeAccounts.map((account) => account.id)), [scopeAccounts]);

  // Opérations du périmètre, enrichies du nom de compte (attribution des positions en agrégé).
  const scopeOps = useMemo(
    () => operations.filter((op) => scopeIds.has(op.accountId)).map((op) => ({ ...op, accountName: accountNameById.get(op.accountId) ?? null })),
    [operations, scopeIds, accountNameById],
  );
  const priceByKey = useMemo(() => {
    const map = new Map<string, InstrumentPrice>();
    for (const holding of holdings.filter((item) => scopeIds.has(item.account_id))) {
      map.set(priceKeyOf({ isin: holding.isin ?? null, symbol: holding.symbol ?? null, name: holding.name ?? null }), {
        lastPrice: holding.last_price, lastPriceAt: holding.last_price_at ?? null, assetType: holding.asset_type ?? null, name: holding.name ?? null,
      });
    }
    return map;
  }, [holdings, scopeIds]);

  const model = useMemo(
    () => (hasScope ? computeAccountModel({ operations: scopeOps, priceByKey, accountType: config.kind, today: todayISO() }) : null),
    [hasScope, scopeOps, priceByKey, config.kind],
  );

  // Compte cible d'une écriture : le compte sélectionné, ou le premier en mode agrégé.
  const writeAccounts = isAggregate ? envAccounts : selectedAccount ? [selectedAccount] : [];
  // Cible d'un import : un seul compte précis (jamais la vue agrégée). En agrégé multi-comptes,
  // l'admin doit d'abord choisir un compte dans le sélecteur d'en-tête.
  const importTarget = selectedAccount ?? (envAccounts.length === 1 ? envAccounts[0] : null);
  const importAccount = importTarget ? { id: importTarget.id, name: importTarget.name, kind: config.kind, currency: importTarget.currency, memberName: importTarget.memberName } : null;

  async function submitOperation(payload: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
    try {
      const response = await authenticatedFetch("/api/pea/operations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const result = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) return { ok: false, error: result.error ?? "Enregistrement impossible." };
      return { ok: true };
    } catch {
      return { ok: false, error: "Réseau indisponible." };
    }
  }

  // Achat self-service du membre sur SON compte (route séparée de l'admin, member_id forcé serveur).
  async function submitMemberOperation(payload: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
    try {
      const response = await authenticatedFetch("/api/investment-operations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, type: "achat" }) });
      const result = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) return { ok: false, error: result.error ?? "Enregistrement impossible." };
      return { ok: true };
    } catch {
      return { ok: false, error: "Réseau indisponible." };
    }
  }

  // Modification d'une ligne existante (admin). Le compte et le titulaire sont immuables côté
  // serveur : seul le contenu de l'opération change, et la validation est identique à la création.
  async function submitOperationEdit(payload: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
    try {
      const response = await authenticatedFetch("/api/pea/operations", {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, id: editingOp?.id }),
      });
      const result = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) return { ok: false, error: result.error ?? "Modification impossible." };
      return { ok: true };
    } catch {
      return { ok: false, error: "Réseau indisponible." };
    }
  }

  // Suppression d'une ou plusieurs lignes (une opération, ou toutes celles d'une position).
  async function deleteOperations(ids: string[]): Promise<{ ok: boolean; error?: string; removed?: number }> {
    try {
      const response = await authenticatedFetch(`/api/pea/operations?ids=${ids.map(encodeURIComponent).join(",")}`, { method: "DELETE" });
      const result = (await response.json().catch(() => ({}))) as { error?: string; removed?: number };
      if (!response.ok) return { ok: false, error: result.error ?? "Suppression impossible." };
      return { ok: true, removed: result.removed };
    } catch {
      return { ok: false, error: "Réseau indisponible." };
    }
  }

  // Vidage complet d'un compte : le nom exact du compte est exigé par le serveur (garde-fou).
  async function purgeOperations(account: InvestmentAccount, confirm: string): Promise<{ ok: boolean; error?: string; removed?: number }> {
    try {
      const query = `accountId=${encodeURIComponent(account.id)}&scope=all&confirm=${encodeURIComponent(confirm)}`;
      const response = await authenticatedFetch(`/api/pea/operations?${query}`, { method: "DELETE" });
      const result = (await response.json().catch(() => ({}))) as { error?: string; removed?: number };
      if (!response.ok) return { ok: false, error: result.error ?? "Suppression impossible." };
      return { ok: true, removed: result.removed };
    } catch {
      return { ok: false, error: "Réseau indisponible." };
    }
  }

  // Rafraîchissement des cours auprès d'un fournisseur de marché gratuit (Yahoo Finance, repli
  // Stooq). N'écrit qu'un cours et son horodatage : ni quantité, ni prix de revient.
  async function refreshPrices() {
    if (!selectedAccount || pricesBusy) return;
    setPricesBusy(true);
    try {
      const response = await authenticatedFetch("/api/admin/market/refresh", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId: selectedAccount.id }),
      });
      const data = (await response.json().catch(() => ({}))) as PriceRefreshReport & { error?: string };
      if (!response.ok) {
        setPriceReport({ refreshed: 0, failed: 0, results: [], error: data.error ?? "Mise à jour des cours impossible." });
      } else {
        setPriceReport({ refreshed: data.refreshed ?? 0, failed: data.failed ?? 0, results: data.results ?? [] });
        onReload();
      }
    } catch {
      setPriceReport({ refreshed: 0, failed: 0, results: [], error: "Réseau indisponible." });
    }
    setPricesBusy(false);
  }

  // Toutes les opérations d'une position (clé d'instrument), pour l'édition ligne à ligne.
  function operationsOfPosition(key: string): InvestmentOperation[] {
    return scopeOps
      .filter((op) => instrumentKey({ isin: op.isin, ticker: op.ticker, assetName: op.assetName }) === key)
      .sort((a, b) => b.date.localeCompare(a.date));
  }

  // Progression de l'objectif mensuel : dérivée des ACHATS réels du mois civil, sur le compte
  // cible du plan (ou, à défaut, le périmètre affiché). Jamais les versements, la valeur du
  // portefeuille ni holdings.quantity. L'objectif n'est pris en compte qu'en vue membre.
  const monthlyProgress = useMemo<MonthlyPlanProgress>(() => {
    const targetId = investmentPlan?.targetAccountId ?? null;
    const accountIds = targetId ? [targetId] : [...scopeIds];
    return computeMonthlyPlanProgress({ operations, accountIds, monthlyTarget: investmentPlan?.monthlyTarget ?? null, today: todayISO() });
  }, [operations, scopeIds, investmentPlan]);
  const hasPlan = !isAdmin && investmentPlan != null && investmentPlan.monthlyTarget != null && investmentPlan.monthlyTarget > 0;

  // Compte créé : on le sélectionne, on rafraîchit le portefeuille, puis on enchaîne directement
  // sur la suite choisie. Le compte n'existe pas encore dans `accounts` (rechargement asynchrone) :
  // la modale d'opération / l'assistant d'import s'affichent dès que les données arrivent.
  function handleAccountCreated(account: { id: string; name: string }, next: SetupNext) {
    setSetupIntent(null);
    setSelectedId(account.id);
    onReload();
    setNotice(`${account.name} est configuré.`);
    if (next === "operation") setModal({ open: true, type: "versement", mode: "admin" });
    if (next === "import") setImportOpen(true);
  }

  const loading = marketLoading && accounts.length === 0 && operations.length === 0;
  const headerTitle = isAggregate ? config.aggregateTitle : selectedAccount ? config.singularTitle(selectedAccount.memberName ?? selectedAccount.name) : config.singularTitle("");
  const tabs: { id: InvestmentTab; label: string }[] = [
    { id: "resume", label: "Résumé" }, { id: "positions", label: "Mes positions" }, { id: "investir", label: "Investir" },
    { id: "revenus", label: "Revenus" }, { id: "performance", label: "Performance" }, { id: "historique", label: "Historique" },
    { id: "comprendre", label: "Comprendre" }, { id: "infos", label: "Infos" },
  ];

  return (
    <div className={`page-stack ${config.pageClass}`}>
      <header className="btc-header pea-header">
        <div className="btc-header-lead">
          <span className={`btc-logo ${config.logoClass}`} aria-hidden="true">{config.logoGlyph}</span>
          <div className="btc-header-copy">
            <div className="btc-header-titleline">
              <h1>{headerTitle}</h1>
              <span className={`btc-role-pill ${isAdmin ? "admin" : "member"}`}>{isPreview ? `Aperçu ${viewer.name}` : isAdmin ? "Vue admin" : "Vue membre"}</span>
              {envAccounts.length > 1 && (
                <label className="pea-account-select">
                  <span className="sr-only">Choisir le compte</span>
                  <select value={isAggregate ? ALL_ACCOUNTS : selectedAccount?.id ?? ""} onChange={(event) => setSelectedId(event.target.value)}>
                    {config.allowAggregate && <option value={ALL_ACCOUNTS}>Tous les comptes</option>}
                    {envAccounts.map((account) => (
                      <option key={account.id} value={account.id}>{accountOptionLabel(account)}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <p>{config.subtitle}</p>
          </div>
        </div>
        <div className="btc-header-actions">
          {canManage && hasScope && (
            <>
              <button type="button" className="primary-button btc-cta" onClick={() => setModal({ open: true, type: "achat", mode: "admin" })}><b>+</b> Enregistrer une opération</button>
              <button type="button" className="secondary-button btc-cta" disabled={!importAccount} title={importAccount ? undefined : "Choisissez un compte précis pour importer"} onClick={() => importAccount && setImportOpen(true)}>⬆ Importer un fichier</button>
              <button type="button" className="secondary-button btc-cta" onClick={() => setSetupIntent("operation")}><b>+</b> Ajouter un compte</button>
            </>
          )}
          {canManage && !hasScope && !loading && (
            <button type="button" className="primary-button btc-cta" onClick={() => setSetupIntent("operation")}><b>+</b> Configurer {config.kind === "CTO" ? "un compte-titres" : "un PEA"}</button>
          )}
          {memberCanRecord && hasScope && (
            <button type="button" className="primary-button btc-cta" onClick={() => setModal({ open: true, type: "achat", mode: "member" })}><b>+</b> Enregistrer un achat</button>
          )}
        </div>
      </header>

      <nav className="btc-tabs" aria-label={`Sections ${config.kind === "CTO" ? "compte-titres" : "PEA"}`}>
        {tabs.map((item) => (
          <button key={item.id} type="button" className={tab === item.id ? "active" : ""} aria-current={tab === item.id ? "page" : undefined} onClick={() => setTab(item.id)}>{item.label}</button>
        ))}
      </nav>

      {loading ? (
        <InvestmentSkeleton />
      ) : !hasScope ? (
        <section className="panel">
          {canManage ? (
            <EmptyState icon={config.emptyNoAccount.icon}
              title={`Aucun ${config.kind === "CTO" ? "compte-titres" : "PEA"} configuré pour ce membre`}
              description="Renseignez le titulaire, la banque et les références du compte : les opérations pourront ensuite être saisies manuellement ou importées depuis un relevé."
              action={`Configurer ${config.kind === "CTO" ? "un compte-titres" : "un PEA"}`} onAction={() => setSetupIntent("operation")}
              secondaryAction="Importer un historique" onSecondaryAction={() => setSetupIntent("import")} />
          ) : (
            <EmptyState icon={config.emptyNoAccount.icon}
              title={`Aucun ${config.kind === "CTO" ? "compte-titres" : "PEA"} n’est encore configuré`}
              description="Ce compte doit être configuré par l’administrateur de l’espace familial." />
          )}
        </section>
      ) : tab === "infos" ? (
        <InfosTab config={config} accounts={scopeAccounts} />
      ) : !model!.hasOperations ? (
        <section className="panel">
          {canManage ? (
            <EmptyState icon={config.emptyNoOperation.icon} title={config.emptyNoOperation.title} description={config.emptyNoOperation.description}
              action="Enregistrer la première opération" onAction={() => setModal({ open: true, type: "versement", mode: "admin" })}
              secondaryAction={importAccount ? "Importer un fichier" : undefined} onSecondaryAction={importAccount ? () => setImportOpen(true) : undefined} />
          ) : (
            <EmptyState icon={config.emptyNoOperation.icon} title={config.emptyNoOperation.title}
              description="Les opérations seront saisies par l’administrateur ; la valeur et les positions apparaîtront ici ensuite." />
          )}
        </section>
      ) : (
        <>
          {tab === "resume" && (
            <ResumeTab config={config} model={model!} title={isAggregate ? config.aggregateTitle : selectedAccount!.name} range={range} setRange={setRange} canManage={canManage} memberCanRecord={memberCanRecord} marketLoading={marketLoading}
              monthlyProgress={monthlyProgress} hasPlan={hasPlan} onOpenRhythm={onOpenRhythm}
              onGoto={setTab} onAddInvestment={() => setModal({ open: true, type: "versement", mode: "admin" })}
              onMemberAdd={() => setModal({ open: true, type: "achat", mode: "member" })}
              onReport={() => setNotice("Le report sera enregistré dans une prochaine version. Saisissez le versement le moment venu.")} recent={scopeOps} />
          )}
          {tab === "positions" && (
            <PositionsTab config={config} model={model!} canManage={canManage}
              canRefreshPrices={canManage && selectedAccount !== null} pricesBusy={pricesBusy} onRefreshPrices={refreshPrices}
              priceReport={priceReport} onDismissPriceReport={() => setPriceReport(null)}
              operationsOfPosition={operationsOfPosition}
              onEditOperation={setEditingOp}
              onDeletePosition={(position) => {
                const ids = operationsOfPosition(position.key).map((op) => op.id);
                setConfirmDelete({
                  title: `Supprimer la position « ${position.name} » ?`,
                  detail: `${ids.length} opération(s) liée(s) à cet actif seront définitivement supprimées. La position disparaîtra du portefeuille (elle en est dérivée). Les versements et les autres actifs ne sont pas touchés.`,
                  ids,
                });
              }}
              onAddOperation={canManage ? () => setModal({ open: true, type: "achat", mode: "admin" }) : undefined} />
          )}
          {tab === "historique" && (
            <HistoriqueTab config={config} operations={scopeOps} accountNameById={accountNameById} canManage={canManage}
              onImport={importAccount ? () => setImportOpen(true) : undefined}
              onEdit={setEditingOp}
              onDelete={(op) => setConfirmDelete({
                title: "Supprimer cette opération ?",
                detail: `${OP_LABEL[op.type]} du ${dateOf(op.date)}${op.assetName ? ` · ${op.assetName}` : ""}. La suppression est définitive ; le portefeuille sera recalculé à partir des opérations restantes.`,
                ids: [op.id],
              })}
              onPurge={selectedAccount ? () => setPurgeAccount(selectedAccount) : undefined} />
          )}
          {tab === "revenus" && <RevenusTab model={model!} operations={scopeOps} />}
          {tab === "investir" && <InvestirTab config={config} model={model!} canManage={canManage} memberCanRecord={memberCanRecord} onAdd={(type) => setModal({ open: true, type, mode: "admin" })} onMemberAdd={() => setModal({ open: true, type: "achat", mode: "member" })} />}
          {tab === "performance" && <PerformanceTab model={model!} onGoto={setTab} />}
          {tab === "comprendre" && <ComprendreTab config={config} />}
        </>
      )}

      {modal.open && (canManage || (memberCanRecord && modal.mode === "member")) && writeAccounts.length > 0 && (
        <InvestmentOperationModal config={config} accounts={writeAccounts} defaultAccountId={selectedAccount?.id ?? writeAccounts[0].id}
          defaultType={modal.mode === "member" ? "achat" : modal.type} restrictToAchat={modal.mode === "member"}
          onClose={() => setModal((current) => ({ ...current, open: false }))}
          onSubmit={modal.mode === "member" ? submitMemberOperation : submitOperation}
          onSaved={() => { setModal((current) => ({ ...current, open: false })); setNotice(modal.mode === "member" ? "Achat enregistré." : "Opération enregistrée."); onReload(); }} />
      )}
      {setupIntent && canManage && (
        <InvestmentAccountSetup
          kind={config.kind}
          accountType={config.accountType}
          viewer={viewer}
          existingAccounts={accounts}
          intent={setupIntent}
          onClose={() => setSetupIntent(null)}
          onCreated={handleAccountCreated}
          onOpenAdmin={isAdmin ? () => { setSetupIntent(null); onConfigure(); } : undefined}
        />
      )}
      {importOpen && canManage && importAccount && (
        <InvestmentImportWizard account={importAccount}
          onClose={() => setImportOpen(false)}
          onDone={() => { setNotice("Import enregistré."); onReload(); }} />
      )}
      {editingOp && canManage && (
        <InvestmentOperationModal config={config} accounts={envAccounts.filter((item) => item.id === editingOp.accountId)}
          defaultAccountId={editingOp.accountId} defaultType={editingOp.type} editing={editingOp}
          onClose={() => setEditingOp(null)}
          onSubmit={submitOperationEdit}
          onSaved={() => { setEditingOp(null); setNotice("Opération modifiée."); onReload(); }} />
      )}
      {confirmDelete && canManage && (
        <ConfirmDangerDialog title={confirmDelete.title} detail={confirmDelete.detail}
          confirmLabel={confirmDelete.ids.length > 1 ? `Supprimer ${confirmDelete.ids.length} opérations` : "Supprimer"}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={async () => {
            const result = await deleteOperations(confirmDelete.ids);
            if (!result.ok) return result.error ?? "Suppression impossible.";
            setConfirmDelete(null);
            setNotice(`${result.removed ?? confirmDelete.ids.length} opération(s) supprimée(s).`);
            onReload();
            return null;
          }} />
      )}
      {purgeAccount && canManage && (
        <ConfirmDangerDialog title={`Vider le portefeuille « ${purgeAccount.name} » ?`}
          detail="TOUTES les opérations de ce compte (versements, achats, ventes, dividendes, frais) seront définitivement supprimées. Le compte lui-même, ses informations et le référentiel des cours sont conservés. Cette action est irréversible."
          confirmLabel="Vider le portefeuille"
          challenge={{ label: "Saisissez le nom exact du compte pour confirmer", expected: purgeAccount.name }}
          onCancel={() => setPurgeAccount(null)}
          onConfirm={async (value) => {
            const result = await purgeOperations(purgeAccount, value);
            if (!result.ok) return result.error ?? "Suppression impossible.";
            setPurgeAccount(null);
            setNotice(`${result.removed ?? 0} opération(s) supprimée(s). Le portefeuille est vide.`);
            onReload();
            return null;
          }} />
      )}
      {notice && <div className="toast" role="status">✓ {notice}</div>}
    </div>
  );
}

// ==========================================================================================
// RÉSUMÉ
// ==========================================================================================
// Libellé + classe CSS (réutilise .pea-status-*) de l'état de l'objectif mensuel.
function regularStatus(status: MonthlyPlanProgress["status"]): { label: string; cls: string } {
  if (status === "atteint") return { label: "Objectif atteint", cls: "investi" };
  if (status === "en_cours") return { label: "En cours", cls: "partiellement_investi" };
  if (status === "a_commencer") return { label: "À commencer", cls: "à_investir" };
  return { label: "Objectif à définir", cls: "à_investir" };
}

function ResumeTab({ config, model, title, range, setRange, canManage, memberCanRecord, marketLoading, monthlyProgress, hasPlan, onOpenRhythm, onGoto, onAddInvestment, onMemberAdd, onReport, recent }: {
  config: EnvelopeConfig; model: AccountModel; title: string; range: "1M" | "3M" | "6M" | "1A" | "3A" | "TOUT";
  setRange: (value: "1M" | "3M" | "6M" | "1A" | "3A" | "TOUT") => void; canManage: boolean; memberCanRecord: boolean; marketLoading: boolean;
  monthlyProgress: MonthlyPlanProgress; hasPlan: boolean; onOpenRhythm?: () => void;
  onGoto: (tab: InvestmentTab) => void; onAddInvestment: () => void; onMemberAdd: () => void; onReport: () => void; recent: InvestmentOperation[];
}) {
  const ranges = supportedRanges(model.timeline);
  const activeRange = ranges.includes(range) ? range : "TOUT";
  const points = windowAccountTimeline(model.timeline, activeRange).map((point) => ({ ...point, btc: 0 }));
  const valueSeries: ChartSeries[] = [{ key: "value", label: "Valeur", color: "#1d706b", get: (point) => point.valueEur, fill: true }];
  const rangeOptions = ranges.map((id) => ({ id, label: id === "TOUT" ? "Tout" : id }));

  const multiCurrency = model.currencyAllocation.length > 1;
  const valueLabel = model.totalValueEur === null ? (marketLoading ? "Mise à jour…" : "Cours non disponible") : euro.format(model.totalValueEur);
  const allocSegments = model.allocation.map((bucket) => ({ label: bucket.label, value: bucket.valueEur, color: bucket.color }));
  const topPositions = model.positions.slice(0, 5);
  const startLabel = model.startDate ? dateOf(model.startDate) : "—";

  return (
    <>
      <div className="btc-hero-grid">
        <section className="btc-hero">
          <div className="btc-hero-copy">
            <span className="btc-eyebrow">VALEUR ACTUELLE TOTALE</span>
            <strong className="btc-hero-value">{valueLabel}</strong>
            <p className="btc-hero-btc">{euro.format(model.netInvestedEur)} investis</p>
            <div className="btc-hero-gain"><GainPill eur={model.performanceEur} pct={model.performancePct} muted={marketLoading} /></div>
            <small className="btc-hero-note">Depuis l’origine ({startLabel}){multiCurrency ? " · valeurs non converties" : ""}</small>
          </div>
          <div className="btc-hero-scene" aria-hidden="true" />
        </section>

        <div className="btc-kpi-grid">
          <BitcoinKpi label="MONTANT NET INVESTI" value={euro.format(model.netInvestedEur)} sub="Versements − retraits" icon="wallet" tone="amber" />
          <BitcoinKpi label="PRIX DE REVIENT MOYEN" value={model.averageBookPrice === null ? "Non disponible" : euro.format(model.averageBookPrice)} sub="Par part / action" icon="landmark" tone="teal" />
          <BitcoinKpi label="PLUS / MOINS-VALUE" value={model.unrealizedGainEur === null ? "Cours non disponible" : <GainPill eur={model.unrealizedGainEur} pct={model.unrealizedGainPct} />} sub="Sur les positions détenues" icon="trending-up" tone="teal" />
          <BitcoinKpi label="DIVIDENDES REÇUS" value={euro.format(model.dividendsNetEur)} sub="Net, depuis l’origine" icon="sprout" tone="teal" />
          <BitcoinKpi label="ESPÈCES DISPONIBLES" value={euro.format(model.cashEur)} sub="À investir" icon="bell" tone="blue" />
          {config.sixthKpi === "fxImpact" ? (
            <BitcoinKpi label="IMPACT DU CHANGE" value={model.fxImpactEur === null ? "Non disponible" : euro.format(model.fxImpactEur)} sub={multiCurrency ? "Plusieurs devises détectées" : "Calcul à venir"} icon="swap" tone="navy" />
          ) : (
            <BitcoinKpi label="PERFORMANCE DEPUIS L’ORIGINE" value={model.performancePct === null ? "Non disponible" : `${model.performancePct >= 0 ? "+" : ""}${model.performancePct.toFixed(2).replace(".", ",")} %`} sub="Valeur / net investi" icon="trending-up" tone="teal" />
          )}
        </div>
      </div>

      <div className="btc-allocation-grid pea-alloc-grid">
        <section className="panel btc-alloc-card">
          <h3 className="btc-panel-kicker">RÉPARTITION PAR TYPE D’ACTIF</h3>
          {allocSegments.length === 0 ? (
            <EmptyState title="Aucune position valorisée" description="Ajoutez des achats d’ETF ou d’actions, ou renseignez leur cours, pour voir la répartition." />
          ) : (
            <div className="btc-alloc-body">
              <DonutChart segments={allocSegments} centerTop={euro0.format(model.totalValueEur ?? 0)} centerBottom="Valeur totale" ariaLabel="Répartition par type d’actif" />
              <ul className="btc-legend">
                {model.allocation.map((bucket) => (
                  <LegendRow key={bucket.key} color={bucket.color} name={bucket.label} value={euro.format(bucket.valueEur)} pct={`${bucket.pct.toFixed(1)} %`} />
                ))}
              </ul>
            </div>
          )}
          <button type="button" className="btc-link" onClick={() => onGoto("positions")}>Voir le détail →</button>
        </section>

        <section className="panel btc-alloc-card">
          <h3 className="btc-panel-kicker">PRINCIPALES POSITIONS</h3>
          {topPositions.length === 0 ? (
            <EmptyState title="Aucune position" description="Les positions apparaîtront ici dès le premier achat enregistré." />
          ) : (
            <ul className="pea-top-list">
              {topPositions.map((position) => (
                <li key={position.key}>
                  <div className="pea-top-id">
                    <strong>{position.name}</strong>
                    <small>{position.ticker ?? position.isin ?? "—"}{position.currency && position.currency !== "EUR" ? ` · ${position.currency}` : ""}</small>
                  </div>
                  <span className="pea-top-weight">{position.currentValueEur === null ? "—" : `${position.weightPct.toFixed(1)} %`}</span>
                  <span className="pea-top-value">{position.currentValueEur === null ? "Cours indispo." : euro.format(position.currentValueEur)}</span>
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="btc-link" onClick={() => onGoto("positions")}>Voir toutes les positions →</button>
        </section>

        {config.thirdCard === "currency" ? (
          <CurrencyCard model={model} />
        ) : config.thirdCard === "geo" ? (
          <section className="panel btc-alloc-card">
            <h3 className="btc-panel-kicker">RÉPARTITION GÉOGRAPHIQUE</h3>
            <EmptyState icon="🌍" title="Bientôt disponible" description="La répartition géographique sera disponible lorsque les informations des actifs auront été complétées." />
          </section>
        ) : null}
      </div>

      <div className="btc-lower-grid">
        <section className="panel btc-chart-card">
          <header className="btc-chart-head">
            <h3 className="btc-panel-kicker">ÉVOLUTION DE LA VALEUR</h3>
            <PeriodFilter value={activeRange} options={rangeOptions} onChange={setRange} />
          </header>
          <EvolutionChart points={points} series={valueSeries} />
          <div className="btc-chart-foot">
            <div><small>Montant net investi</small><strong>{euro.format(model.netInvestedEur)}</strong></div>
            <div><small>Valeur actuelle</small><strong>{valueLabel}</strong></div>
            <div><small>Depuis l’origine</small><strong className={model.performanceEur === null ? "" : model.performanceEur >= 0 ? "up" : "down"}><GainPill eur={model.performanceEur} pct={model.performancePct} /></strong></div>
          </div>
        </section>

        {config.showRegular && (
          <section className="panel pea-regular">
            <h3 className="btc-panel-kicker">INVESTISSEMENT RÉGULIER</h3>
            <div className="pea-regular-head">
              <div><small>Objectif mensuel</small><strong>{monthlyProgress.monthlyTarget !== null ? euro.format(monthlyProgress.monthlyTarget) : "À définir"}</strong></div>
              <div><small>Investi ce mois ({model.monthly.monthLabel})</small><strong>{euro.format(monthlyProgress.investedThisMonth)}</strong></div>
            </div>
            {monthlyProgress.monthlyTarget !== null && (
              <div className="pea-regular-progress" role="progressbar" aria-valuenow={Math.round(monthlyProgress.pct ?? 0)} aria-valuemin={0} aria-valuemax={100}>
                <div className="pea-regular-progress-bar" style={{ width: `${monthlyProgress.pct ?? 0}%` }} />
              </div>
            )}
            <div className="pea-regular-status">
              <span className={`pea-status pea-status-${regularStatus(monthlyProgress.status).cls}`}>{regularStatus(monthlyProgress.status).label}</span>
              <small>
                {monthlyProgress.monthlyTarget !== null
                  ? `${monthlyProgress.daysRemaining} jour(s) restant(s) ce mois-ci. Progression calculée sur vos achats réels.`
                  : "Définissez un objectif mensuel pour suivre votre progression. Elle est calculée sur vos achats réels (jamais les versements)."}
              </small>
            </div>
            <div className="pea-regular-actions">
              {canManage && (
                <>
                  <button type="button" className="primary-button" onClick={onAddInvestment}>Enregistrer un investissement</button>
                  <button type="button" className="secondary-button" onClick={onReport}>Reporter ce mois</button>
                </>
              )}
              {memberCanRecord && <button type="button" className="primary-button" onClick={onMemberAdd}>Enregistrer un achat</button>}
              {!hasPlan && memberCanRecord && onOpenRhythm && <button type="button" className="secondary-button" onClick={onOpenRhythm}>Définir mon rythme</button>}
            </div>
          </section>
        )}
      </div>

      <section className="panel btc-ops-card">
        <header className="btc-ops-head">
          <h3 className="btc-panel-kicker">DERNIÈRES OPÉRATIONS</h3>
          <button type="button" className="btc-link" onClick={() => onGoto("historique")}>Voir tout →</button>
        </header>
        <OperationList operations={[...recent].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5)} subtitle={title} />
      </section>

      <InfoNote title={`Comment lisons-nous votre ${config.kind === "CTO" ? "compte-titres" : "PEA"} ?`} action="Comprendre" onAction={() => onGoto("comprendre")}>
        {config.resumeNote}
      </InfoNote>
    </>
  );
}

function CurrencyCard({ model }: { model: AccountModel }) {
  const palette = ["#5a9bd4", "#3aa17e", "#f0a63a", "#9b7fd4", "#d9744d", "#94a3ab"];
  const segments = model.currencyAllocation.map((bucket, index) => ({ label: bucket.currency, value: bucket.value, color: palette[index % palette.length] }));
  const total = model.currencyAllocation.reduce((sum, bucket) => sum + bucket.value, 0);
  return (
    <section className="panel btc-alloc-card">
      <h3 className="btc-panel-kicker">RÉPARTITION PAR DEVISE</h3>
      {segments.length === 0 ? (
        <EmptyState icon="💱" title="Aucune position valorisée" description="La répartition par devise apparaîtra dès qu’une position détenue aura un cours ou un prix de revient." />
      ) : (
        <>
          <div className="btc-alloc-body">
            <DonutChart segments={segments} centerTop={String(segments.length)} centerBottom={segments.length > 1 ? "devises" : "devise"} ariaLabel="Répartition par devise" />
            <ul className="btc-legend">
              {model.currencyAllocation.map((bucket, index) => (
                <LegendRow key={bucket.currency} color={palette[index % palette.length]} name={bucket.currency} value={`${qty.format(bucket.value)} ${bucket.currency}`} pct={`${bucket.pct.toFixed(1)} %`} />
              ))}
            </ul>
          </div>
          <p className="btc-chart-source">Montants exprimés dans leur devise d’origine — {total > 0 ? "non convertis" : ""}. La conversion et l’impact du change arriveront dans un prochain lot.</p>
        </>
      )}
    </section>
  );
}

export function OperationList({ operations, subtitle }: { operations: InvestmentOperation[]; subtitle: string }) {
  if (operations.length === 0) return <EmptyState icon="🧾" title="Aucune opération" description="Les opérations enregistrées apparaîtront ici." />;
  return (
    <ul className="btc-ops">
      {operations.map((op) => {
        const inflow = OP_INFLOW[op.type];
        const amount = op.netAmount ?? op.grossAmount ?? (op.quantity && op.unitPrice ? op.quantity * op.unitPrice : 0);
        return (
          <li key={op.id}>
            <span className="btc-ops-mark" aria-hidden="true">{OP_ICON[op.type]}</span>
            <div className="btc-ops-info"><strong>{OP_LABEL[op.type]}{op.assetName ? ` · ${op.assetName}` : ""}</strong><small>{op.accountName ?? subtitle}</small></div>
            <div className="btc-ops-amount">
              <b className={inflow ? "" : "pea-out"}>{inflow ? "+" : "−"}{euro.format(Math.abs(Number(amount) || 0))}{op.currency && op.currency !== "EUR" ? ` ${op.currency}` : ""}</b>
              <small>{op.quantity ? `${qty.format(op.quantity)} parts` : "—"}</small>
            </div>
            <div className="btc-ops-meta"><span>{op.ticker ?? op.isin ?? ""}</span><time>{dateOf(op.date)}</time></div>
          </li>
        );
      })}
    </ul>
  );
}

// ==========================================================================================
// MES POSITIONS
// ==========================================================================================
const ASSET_LABEL: Record<string, string> = { etf: "ETF", action: "Action", obligation: "Obligation", fonds: "Fonds", autre: "Autre" };

// Fraîcheur d'un cours, telle quelle (jamais arrondie à l'avantage de l'affichage).
function priceAge(lastPriceAt: string | null): string | null {
  if (!lastPriceAt) return null;
  const stamp = new Date(lastPriceAt).getTime();
  if (!Number.isFinite(stamp)) return null;
  const days = Math.floor((Date.now() - stamp) / 86_400_000);
  if (days <= 0) return "aujourd’hui";
  if (days === 1) return "hier";
  return `il y a ${days} j`;
}

function PositionsTab({
  config, model, canManage, canRefreshPrices, pricesBusy, onRefreshPrices, priceReport, onDismissPriceReport,
  operationsOfPosition, onEditOperation, onDeletePosition, onAddOperation,
}: {
  config: EnvelopeConfig; model: AccountModel; canManage: boolean;
  canRefreshPrices: boolean; pricesBusy: boolean; onRefreshPrices: () => void;
  priceReport: PriceRefreshReport | null; onDismissPriceReport: () => void;
  operationsOfPosition: (key: string) => InvestmentOperation[];
  onEditOperation: (op: InvestmentOperation) => void;
  onDeletePosition: (position: PortfolioPosition) => void;
  onAddOperation?: () => void;
}) {
  const cto = config.positionsVariant === "cto";
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [currencyFilter, setCurrencyFilter] = useState("all");
  const [accountFilter, setAccountFilter] = useState("all");
  // Position dont on déplie les lignes (opérations) pour les modifier une à une.
  const [openKey, setOpenKey] = useState<string | null>(null);

  const accountOptions = useMemo(() => [...new Set(model.positions.flatMap((position) => position.accounts))].sort(), [model.positions]);
  const currencyOptions = useMemo(() => [...new Set(model.positions.map((position) => position.currency))].sort(), [model.positions]);

  const filtered = model.positions.filter((position) => {
    if (typeFilter !== "all" && position.assetClass !== typeFilter) return false;
    if (cto && currencyFilter !== "all" && position.currency !== currencyFilter) return false;
    if (cto && accountFilter !== "all" && !position.accounts.includes(accountFilter)) return false;
    if (search.trim()) {
      const needle = search.trim().toLowerCase();
      const hay = `${position.name} ${position.ticker ?? ""} ${position.isin ?? ""}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });

  return (
    <section className="panel table-panel btc-table-card">
      <div className="inv-positions-head">
        <h3 className="btc-panel-kicker">DÉTAIL DES POSITIONS</h3>
        {canManage && (
          <div className="inv-actions">
            {canRefreshPrices && (
              <button type="button" className="secondary-button inv-import-btn" disabled={pricesBusy} onClick={onRefreshPrices}
                title="Relit le cours de chaque position auprès d’un fournisseur de marché gratuit (Yahoo Finance, repli Stooq)">
                {pricesBusy ? "Mise à jour des cours…" : "↻ Actualiser les cours"}
              </button>
            )}
            {onAddOperation && <button type="button" className="secondary-button inv-import-btn" onClick={onAddOperation}>+ Ajouter une ligne</button>}
          </div>
        )}
        {cto && model.positions.length > 0 && (
          <div className="inv-filters">
            <label><span className="sr-only">Rechercher une position</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Rechercher…" /></label>
            <label><span className="sr-only">Filtrer par type</span>
              <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
                <option value="all">Tous les types</option>
                {Object.entries(ASSET_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            {currencyOptions.length > 1 && (
              <label><span className="sr-only">Filtrer par devise</span>
                <select value={currencyFilter} onChange={(event) => setCurrencyFilter(event.target.value)}>
                  <option value="all">Toutes devises</option>
                  {currencyOptions.map((currency) => <option key={currency} value={currency}>{currency}</option>)}
                </select>
              </label>
            )}
            {accountOptions.length > 1 && (
              <label><span className="sr-only">Filtrer par compte</span>
                <select value={accountFilter} onChange={(event) => setAccountFilter(event.target.value)}>
                  <option value="all">Tous les comptes</option>
                  {accountOptions.map((account) => <option key={account} value={account}>{account}</option>)}
                </select>
              </label>
            )}
          </div>
        )}
      </div>
      {priceReport && <PriceRefreshPanel report={priceReport} onDismiss={onDismissPriceReport} />}
      {model.positions.length === 0 ? (
        <EmptyState title="Aucune position" description="Aucune position détenue à ce jour." />
      ) : filtered.length === 0 ? (
        <EmptyState title="Aucun résultat" description="Aucune position ne correspond à ces filtres." />
      ) : (
        <div className="responsive-table">
          <table className="btc-table">
            <thead>
              {cto ? (
                <tr><th>Actif</th><th>Type</th><th>Compte</th><th>Quantité</th><th>PRU</th><th>Cours</th><th>Devise</th><th>Valeur</th><th>Gain</th><th>Poids</th>{canManage && <th>Actions</th>}</tr>
              ) : (
                <tr><th>Actif</th><th>Type</th><th>Ticker / ISIN</th><th>Quantité</th><th>Prix de revient</th><th>Cours</th><th>Valeur</th><th>Poids</th><th>Perf.</th>{canManage && <th>Actions</th>}</tr>
              )}
            </thead>
            <tbody>
              {filtered.map((position) => {
                const lines = canManage && openKey === position.key ? operationsOfPosition(position.key) : [];
                const age = priceAge(position.lastPriceAt);
                return (
                <Fragment key={position.key}>
                <tr>
                  <td data-label="Actif"><strong>{position.name}</strong>{cto && (position.ticker || position.isin) ? <><br /><small className="inv-muted">{position.ticker ?? position.isin}</small></> : null}</td>
                  <td data-label="Type">{ASSET_LABEL[position.assetClass] ?? "Autre"}</td>
                  {cto ? (
                    <td data-label="Compte">{position.accounts.length === 0 ? "—" : position.accounts.length === 1 ? position.accounts[0] : `${position.accounts.length} comptes`}</td>
                  ) : (
                    <td data-label="Ticker / ISIN">{position.ticker ?? position.isin ?? "—"}</td>
                  )}
                  <td data-label="Quantité" className="num">{qty.format(position.quantity)}</td>
                  <td data-label={cto ? "PRU" : "Prix de revient"} className="num">{position.averageCost === null ? "—" : euro.format(position.averageCost)}</td>
                  <td data-label="Cours" className="num">
                    {position.lastPrice === null ? "Indispo." : euro.format(position.lastPrice)}
                    {age && <><br /><small className="inv-muted">{age}</small></>}
                  </td>
                  {cto && <td data-label="Devise">{position.currency}</td>}
                  <td data-label="Valeur" className="num">{position.currentValueEur === null ? "—" : euro.format(position.currentValueEur)}</td>
                  {cto ? (
                    <td data-label="Gain" className="num">{position.gainEur === null ? "—" : <span className={position.gainEur >= 0 ? "up" : "down"}>{position.gainEur >= 0 ? "+" : "−"}{euro.format(Math.abs(position.gainEur))}{position.gainPct === null ? "" : ` (${position.gainPct >= 0 ? "+" : ""}${position.gainPct.toFixed(1)} %)`}</span>}</td>
                  ) : null}
                  <td data-label="Poids" className="num">{position.currentValueEur === null ? "—" : `${position.weightPct.toFixed(1)} %`}</td>
                  {!cto && <td data-label="Perf." className="num">{position.gainPct === null ? "—" : <span className={position.gainPct >= 0 ? "up" : "down"}>{position.gainPct >= 0 ? "+" : ""}{position.gainPct.toFixed(1)} %</span>}</td>}
                  {canManage && (
                    <td data-label="Actions">
                      <div className="inv-row-actions">
                        <button type="button" className="inv-icon-btn" aria-expanded={openKey === position.key}
                          onClick={() => setOpenKey(openKey === position.key ? null : position.key)}
                          title="Voir et modifier les opérations de cette position">
                          {openKey === position.key ? "▾ Lignes" : "▸ Lignes"}
                        </button>
                        <button type="button" className="inv-icon-btn inv-icon-danger" onClick={() => onDeletePosition(position)}
                          title="Supprimer toutes les opérations de cette position">🗑</button>
                      </div>
                    </td>
                  )}
                </tr>
                {lines.length > 0 && (
                  <tr className="inv-lines-row">
                    <td colSpan={cto ? 11 : 10}>
                      <div className="inv-lines">
                        <p className="inv-lines-head">
                          {lines.length} opération(s) sur <b>{position.name}</b>. La quantité et le prix de revient en découlent&nbsp;: corrigez une ligne, le portefeuille se recalcule.
                        </p>
                        <ul>
                          {lines.map((op) => (
                            <li key={op.id}>
                              <span className="inv-line-date">{dateOf(op.date)}</span>
                              <span className="inv-line-type">{OP_ICON[op.type]} {OP_LABEL[op.type]}</span>
                              <span className="inv-line-qty">{op.quantity ? `${qty.format(op.quantity)} × ${op.unitPrice ? euro.format(op.unitPrice) : "—"}` : "—"}</span>
                              <span className="inv-line-amount">{op.netAmount === null || op.netAmount === undefined ? "—" : euro.format(Math.abs(op.netAmount))}</span>
                              <span className="inv-line-actions">
                                <button type="button" className="inv-icon-btn" onClick={() => onEditOperation(op)} title="Modifier cette opération">✏️ Modifier</button>
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </td>
                  </tr>
                )}
                </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {model.unpricedPositions > 0 && (
        <p className="btc-chart-source">
          {model.unpricedPositions} position(s) sans cours&nbsp;: leur valeur n’est pas comptée dans le total.
          {canManage ? " Utilisez « Actualiser les cours » pour les relire auprès d’un fournisseur de marché, ou saisissez le cours dans Administration › Comptes & positions." : ""}
        </p>
      )}
    </section>
  );
}

// Compte rendu du rafraîchissement : chaque position a une ligne, y compris les échecs. Rien
// n'est masqué — une position sans cours doit se voir, pas disparaître du total en silence.
function PriceRefreshPanel({ report, onDismiss }: { report: PriceRefreshReport; onDismiss: () => void }) {
  const failures = report.results.filter((row) => row.status !== "updated" && row.status !== "unchanged");
  return (
    <div className={`inv-price-report${report.error || failures.length > 0 ? " warn" : ""}`} role="status">
      <button type="button" className="inv-price-report-close" onClick={onDismiss} aria-label="Fermer">×</button>
      {report.error ? (
        <strong>{report.error}</strong>
      ) : (
        <>
          <strong>{report.refreshed} cours mis à jour{failures.length > 0 ? `, ${failures.length} non résolu(s)` : ""}.</strong>
          {report.results.some((row) => row.provider) && (
            <small> Source&nbsp;: {[...new Set(report.results.map((row) => row.provider).filter(Boolean))].join(", ")}.</small>
          )}
          {failures.length > 0 && (
            <>
              <ul className="inv-price-report-list">
                {failures.map((row) => (
                  <li key={row.key}><b>{row.name}</b>{row.isin ? ` (${row.isin})` : ""} — {row.message ?? "Cours indisponible."}</li>
                ))}
              </ul>
              {failures.some((row) => row.status === "currency_mismatch") && (
                <small>
                  Une position libellée dans la mauvaise devise vient généralement d’un import&nbsp;: si le fichier n’avait pas de colonne «&nbsp;devise&nbsp;», celle du compte a été reprise.
                  Corrigez la devise sur les opérations concernées (onglet Historique&nbsp;› ✏️) pour que le cours puisse s’appliquer.
                </small>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

// ==========================================================================================
// HISTORIQUE
// ==========================================================================================
function HistoriqueTab({ config, operations, accountNameById, canManage, onImport, onEdit, onDelete, onPurge }: {
  config: EnvelopeConfig; operations: InvestmentOperation[]; accountNameById: Map<string, string>; canManage: boolean;
  onImport?: () => void; onEdit: (op: InvestmentOperation) => void; onDelete: (op: InvestmentOperation) => void; onPurge?: () => void;
}) {
  const cto = config.positionsVariant === "cto";
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [accountFilter, setAccountFilter] = useState<string>("all");
  const accountIds = useMemo(() => [...new Set(operations.map((op) => op.accountId))], [operations]);

  const sorted = [...operations]
    .filter((op) => (typeFilter === "all" || op.type === typeFilter) && (accountFilter === "all" || op.accountId === accountFilter))
    .sort((a, b) => b.date.localeCompare(a.date));

  return (
    <section className="panel table-panel btc-table-card">
      <div className="inv-positions-head">
        <h3 className="btc-panel-kicker">HISTORIQUE DES OPÉRATIONS</h3>
        {canManage && (
          <div className="inv-actions">
            {onImport && <button type="button" className="secondary-button inv-import-btn" onClick={onImport}>⬆ Importer un fichier</button>}
            {onPurge && operations.length > 0 && (
              <button type="button" className="danger-button inv-import-btn" onClick={onPurge}
                title="Supprimer toutes les opérations de ce compte">🗑 Vider le portefeuille</button>
            )}
          </div>
        )}
        {operations.length > 0 && (
          <div className="inv-filters">
            <label><span className="sr-only">Filtrer par type</span>
              <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
                <option value="all">Tous les types</option>
                {(Object.keys(OP_LABEL) as AccountOperationType[]).map((type) => <option key={type} value={type}>{OP_LABEL[type]}</option>)}
              </select>
            </label>
            {cto && accountIds.length > 1 && (
              <label><span className="sr-only">Filtrer par compte</span>
                <select value={accountFilter} onChange={(event) => setAccountFilter(event.target.value)}>
                  <option value="all">Tous les comptes</option>
                  {accountIds.map((id) => <option key={id} value={id}>{accountNameById.get(id) ?? id}</option>)}
                </select>
              </label>
            )}
          </div>
        )}
      </div>
      {sorted.length === 0 ? (
        <EmptyState title="Aucune opération" description="Aucune opération enregistrée sur ce périmètre." />
      ) : (
        <div className="responsive-table">
          <table className="btc-table">
            <thead>
              <tr><th>Date</th><th>Type</th><th>Actif</th><th>Quantité</th><th>Prix</th><th>Frais</th><th>Montant net</th><th>Devise</th><th>Compte</th>{canManage && <th>Actions</th>}</tr>
            </thead>
            <tbody>
              {sorted.map((op) => (
                <tr key={op.id}>
                  <td data-label="Date">{dateOf(op.date)}</td>
                  <td data-label="Type">{OP_LABEL[op.type]}</td>
                  <td data-label="Actif">{op.assetName ?? "—"}{op.ticker ? ` (${op.ticker})` : ""}</td>
                  <td data-label="Quantité" className="num">{op.quantity ? qty.format(op.quantity) : "—"}</td>
                  <td data-label="Prix" className="num">{op.unitPrice ? euro.format(op.unitPrice) : "—"}</td>
                  <td data-label="Frais" className="num">{op.fees ? euro.format(op.fees) : "—"}</td>
                  <td data-label="Montant net" className="num">{op.netAmount === null || op.netAmount === undefined ? "—" : <span className={OP_INFLOW[op.type] ? "up" : "down"}>{OP_INFLOW[op.type] ? "+" : "−"}{euro.format(Math.abs(op.netAmount))}</span>}</td>
                  <td data-label="Devise">{op.currency}</td>
                  <td data-label="Compte">{op.accountName ?? accountNameById.get(op.accountId) ?? "—"}</td>
                  {canManage && (
                    <td data-label="Actions">
                      <div className="inv-row-actions">
                        <button type="button" className="inv-icon-btn" onClick={() => onEdit(op)} title="Modifier cette opération">✏️</button>
                        <button type="button" className="inv-icon-btn inv-icon-danger" onClick={() => onDelete(op)} title="Supprimer cette opération">🗑</button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ==========================================================================================
// REVENUS (dividendes)
// ==========================================================================================
function RevenusTab({ model, operations }: { model: AccountModel; operations: InvestmentOperation[] }) {
  const dividends = operations.filter((op) => op.type === "dividende").sort((a, b) => b.date.localeCompare(a.date));
  return (
    <>
      <section className="panel btc-synth">
        <h3 className="btc-panel-kicker">DIVIDENDES</h3>
        <div className="btc-synth-grid" style={{ gridTemplateColumns: "repeat(3,minmax(0,1fr))" }}>
          <div><small>Dividendes bruts</small><strong>{euro.format(model.dividendsGrossEur)}</strong></div>
          <div><small>Dividendes nets</small><strong>{euro.format(model.dividendsNetEur)}</strong></div>
          <div><small>Opérations</small><strong>{dividends.length}</strong></div>
        </div>
      </section>
      <section className="panel btc-ops-card">
        <h3 className="btc-panel-kicker">DÉTAIL DES DIVIDENDES</h3>
        {dividends.length === 0 ? (
          <EmptyState icon="💶" title="Aucun dividende enregistré pour le moment." description="Les dividendes reçus apparaîtront ici dès leur saisie." />
        ) : (
          <ul className="btc-ops">
            {dividends.map((op) => (
              <li key={op.id}>
                <span className="btc-ops-mark" aria-hidden="true">💶</span>
                <div className="btc-ops-info"><strong>{op.assetName ?? "Dividende"}</strong><small>{op.ticker ?? op.isin ?? ""}{op.accountName ? ` · ${op.accountName}` : ""}</small></div>
                <div className="btc-ops-amount"><b>+{euro.format(Math.abs(Number(op.netAmount ?? op.grossAmount ?? 0)))}{op.currency && op.currency !== "EUR" ? ` ${op.currency}` : ""}</b><small>net</small></div>
                <div className="btc-ops-meta"><time>{dateOf(op.date)}</time></div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

// ==========================================================================================
// INVESTIR
// ==========================================================================================
const INVEST_CARD_META: Record<AccountOperationType, { icon: string; title: string; desc: string }> = {
  versement: { icon: "➕", title: "Versement", desc: "Un apport d’espèces sur le compte (alimente la trésorerie disponible)." },
  achat: { icon: "📈", title: "Achat", desc: "Achat d’un ETF, d’une action ou d’un fonds : quantité, prix unitaire et frais." },
  vente: { icon: "📉", title: "Vente", desc: "Vente d’une position : quantité, prix unitaire et frais." },
  dividende: { icon: "💶", title: "Dividende", desc: "Un dividende reçu (montant net, éventuelle retenue)." },
  retrait: { icon: "➖", title: "Retrait", desc: "Un retrait d’espèces du compte." },
  frais: { icon: "🧾", title: "Frais", desc: "Des frais de tenue de compte ou de courtage isolés." },
  transfer_in: { icon: "📥", title: "Transfert entrant", desc: "Des titres transférés depuis un autre établissement (déplace une position, sans espèces)." },
  transfer_out: { icon: "📤", title: "Transfert sortant", desc: "Des titres transférés vers un autre établissement." },
  correction: { icon: "✏️", title: "Correction", desc: "Un ajustement de quantité ou de montant, tracé dans l’historique." },
};

function InvestirTab({ config, model, canManage, memberCanRecord, onAdd, onMemberAdd }: { config: EnvelopeConfig; model: AccountModel; canManage: boolean; memberCanRecord: boolean; onAdd: (type: AccountOperationType) => void; onMemberAdd: () => void }) {
  if (!canManage) {
    // Un membre peut enregistrer lui-même un ACHAT sur son propre compte (route self-service).
    if (memberCanRecord) {
      const card = INVEST_CARD_META.achat;
      return (
        <>
          <section className="panel btc-invest-head">
            <div className="btc-invest-intro">
              <span className="soft-pill">INVESTIR</span>
              <h2>Enregistrer un achat</h2>
              <p>Enregistrez un achat d’ETF ou d’actions sur votre propre compte : le portefeuille (valeur, positions, prix de revient) est recalculé automatiquement à partir de vos opérations réelles. Aucun faux succès : l’enregistrement n’est confirmé qu’après réponse du serveur.</p>
            </div>
            <div className="btc-invest-price">
              <div><small>Espèces disponibles</small><strong>{euro.format(model.cashEur)}</strong></div>
              <div><small>Valeur totale</small><strong>{model.totalValueEur === null ? "—" : euro.format(model.totalValueEur)}</strong></div>
            </div>
          </section>
          <div className="btc-parcours-grid pea-parcours-grid">
            <button type="button" className="btc-parcours-card" onClick={onMemberAdd}>
              <span className="btc-parcours-icon" aria-hidden="true">{card.icon}</span>
              <strong>{card.title}</strong>
              <p>{card.desc}</p>
              <span className="btc-parcours-cta">Enregistrer →</span>
            </button>
          </div>
          <p className="btc-chart-source">Les autres opérations (versement, vente, dividende…) restent gérées par l’administrateur.</p>
        </>
      );
    }
    return (
      <section className="panel">
        <EmptyState icon="🔒" title="Les opérations sont gérées par l’administrateur"
          description="Seul l’administrateur enregistre les opérations (versements, achats, ventes, dividendes). Vous pouvez suivre la valeur et les positions dans les onglets Résumé et Mes positions." />
      </section>
    );
  }
  return (
    <>
      <section className="panel btc-invest-head">
        <div className="btc-invest-intro">
          <span className="soft-pill">INVESTIR</span>
          <h2>Enregistrer une opération</h2>
          <p>Choisissez le type d’opération : le portefeuille (valeur, positions, prix de revient, espèces) est recalculé automatiquement. Aucun faux succès : l’enregistrement n’est confirmé qu’après réponse du serveur.</p>
        </div>
        <div className="btc-invest-price">
          <div><small>Espèces disponibles</small><strong>{euro.format(model.cashEur)}</strong></div>
          <div><small>Valeur totale</small><strong>{model.totalValueEur === null ? "—" : euro.format(model.totalValueEur)}</strong></div>
        </div>
      </section>
      <div className="btc-parcours-grid pea-parcours-grid">
        {config.investCards.map((type) => {
          const card = INVEST_CARD_META[type];
          return (
            <button key={type} type="button" className="btc-parcours-card" onClick={() => onAdd(type)}>
              <span className="btc-parcours-icon" aria-hidden="true">{card.icon}</span>
              <strong>{card.title}</strong>
              <p>{card.desc}</p>
              <span className="btc-parcours-cta">Enregistrer →</span>
            </button>
          );
        })}
      </div>
    </>
  );
}

// ==========================================================================================
// PERFORMANCE (placeholder honnête : pas de métrique non implémentée)
// ==========================================================================================
function PerformanceTab({ model, onGoto }: { model: AccountModel; onGoto: (tab: InvestmentTab) => void }) {
  return (
    <>
      <section className="panel btc-synth">
        <h3 className="btc-panel-kicker">PERFORMANCE (VUE SIMPLE)</h3>
        <div className="btc-synth-grid" style={{ gridTemplateColumns: "repeat(3,minmax(0,1fr))" }}>
          <div><small>Montant net investi</small><strong>{euro.format(model.netInvestedEur)}</strong></div>
          <div><small>Valeur actuelle</small><strong>{model.totalValueEur === null ? "Non disponible" : euro.format(model.totalValueEur)}</strong></div>
          <div><small>Plus / moins-value</small><strong>{model.unrealizedGainEur === null ? "Non disponible" : <GainPill eur={model.unrealizedGainEur} pct={model.unrealizedGainPct} />}</strong></div>
          <div><small>Dividendes nets</small><strong>{euro.format(model.dividendsNetEur)}</strong></div>
          <div><small>Frais</small><strong>{euro.format(model.feesEur)}</strong></div>
          <div><small>Performance depuis l’origine</small><strong>{model.performanceEur === null ? "Non disponible" : <GainPill eur={model.performanceEur} pct={model.performancePct} />}</strong></div>
        </div>
      </section>
      <section className="panel">
        <EmptyState icon="📊" title="Analyse avancée à venir"
          description="Le rendement annualisé, le TWR, l’IRR, la volatilité, le drawdown et l’impact du change seront ajoutés lorsqu’ils seront réellement calculés — nous n’affichons aucune métrique estimée."
          action="Voir le Résumé" onAction={() => onGoto("resume")} />
      </section>
    </>
  );
}

// ==========================================================================================
// COMPRENDRE
// ==========================================================================================
function ComprendreTab({ config }: { config: EnvelopeConfig }) {
  return (
    <section className="panel">
      <div className="pea-faq">
        {config.faq.map((item) => (
          <div key={item.q} className="pea-faq-item"><strong>{item.q}</strong><p>{item.a}</p></div>
        ))}
      </div>
    </section>
  );
}

// ==========================================================================================
// INFOS (informations du compte — lecture seule ; édition dans Paramètres › Mes comptes)
// ==========================================================================================
function money(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat("fr-FR", { style: "currency", currency: (currency || "EUR").toUpperCase() }).format(value);
  } catch {
    return `${qty.format(value)} ${currency || "EUR"}`;
  }
}

function AccountInfoCard({ account, envLabel }: { account: InvestmentAccount; envLabel: string }) {
  const rows: { label: string; value: string }[] = [
    { label: "Titulaire", value: account.memberName ?? "—" },
    { label: "Type de compte", value: envLabel },
    { label: "Établissement", value: account.institution?.trim() || "—" },
    { label: "Devise", value: (account.currency || "EUR").toUpperCase() },
    { label: "N° de compte", value: account.accountNumberLast4 ? `•••• ${account.accountNumberLast4}` : "—" },
    { label: "IBAN", value: account.ibanLast4 ? `•••• ${account.ibanLast4}` : "—" },
    { label: "Date d’ouverture", value: account.openedAt ? dateOf(account.openedAt) : "—" },
    { label: "Objectif mensuel", value: account.monthlyTarget != null ? money(account.monthlyTarget, account.currency) : "—" },
    { label: "Solde de départ", value: account.openingBalance != null ? money(account.openingBalance, account.currency) : "—" },
  ];
  return (
    <article className="pea-info-card">
      <header className="pea-info-card-head">
        <strong>{account.name}</strong>
        <span className="soft-pill">{envLabel}</span>
      </header>
      <dl className="pea-info-grid">
        {rows.map((row) => (
          <div key={row.label} className="pea-info-row">
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
      {account.notes?.trim() ? <p className="pea-info-note"><span>Note</span>{account.notes.trim()}</p> : null}
    </article>
  );
}

function InfosTab({ config, accounts }: { config: EnvelopeConfig; accounts: InvestmentAccount[] }) {
  const envLabel = config.kind === "CTO" ? "Compte-titres" : "PEA";
  if (accounts.length === 0) {
    return <section className="panel"><EmptyState icon="ℹ️" title="Aucun compte" description="Sélectionnez un compte pour afficher ses informations." /></section>;
  }
  return (
    <section className="panel pea-infos">
      <div className="inv-positions-head">
        <h3 className="btc-panel-kicker">{accounts.length > 1 ? "INFORMATIONS DES COMPTES" : "INFORMATIONS DU COMPTE"}</h3>
      </div>
      <div className="pea-infos-list">
        {accounts.map((account) => <AccountInfoCard key={account.id} account={account} envLabel={envLabel} />)}
      </div>
      <p className="btc-chart-source">
        Ces informations sont renseignées à la configuration du compte. L’administrateur peut les modifier dans Paramètres&nbsp;› Mes comptes. Le solde de départ est indiqué à titre de contexte&nbsp;: la valeur et la performance restent calculées à partir des opérations réelles.
      </p>
    </section>
  );
}

// ==========================================================================================
// SKELETON
// ==========================================================================================
export function InvestmentSkeleton() {
  return (
    <div className="pea-skeleton" aria-hidden="true">
      <div className="pea-skeleton-hero" />
      <div className="pea-skeleton-kpis">{Array.from({ length: 6 }).map((_, index) => <div key={index} className="pea-skeleton-card" />)}</div>
      <div className="pea-skeleton-row">{Array.from({ length: 3 }).map((_, index) => <div key={index} className="pea-skeleton-block" />)}</div>
    </div>
  );
}

// ==========================================================================================
// MODALE D'OPÉRATION (admin) — générique PEA / CTO
// ==========================================================================================
// `editing` : opération existante à MODIFIER (sinon création). En modification, le compte n'est
// pas changeable (le serveur l'impose : une opération ne déménage pas d'un compte à l'autre) et
// tous les types restent proposés — une ligne importée peut être une « correction ».
const num2 = (value: number | null | undefined) => (value === null || value === undefined || !Number.isFinite(Number(value)) ? "" : String(value));

function InvestmentOperationModal({ config, accounts, defaultAccountId, defaultType, restrictToAchat = false, editing = null, onClose, onSubmit, onSaved }: {
  config: EnvelopeConfig; accounts: InvestmentAccount[]; defaultAccountId: string; defaultType: AccountOperationType; restrictToAchat?: boolean;
  editing?: InvestmentOperation | null;
  onClose: () => void; onSubmit: (payload: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>; onSaved: () => void;
}) {
  const dialogRef = useDialogA11y(true, onClose);
  const [accountId, setAccountId] = useState(defaultAccountId);
  const [type, setType] = useState<AccountOperationType>(defaultType);
  const [date, setDate] = useState(editing?.date ?? todayISO());
  const [assetName, setAssetName] = useState(editing?.assetName ?? "");
  const [ticker, setTicker] = useState(editing?.ticker ?? "");
  const [isin, setIsin] = useState(editing?.isin ?? "");
  const [quantity, setQuantity] = useState(num2(editing?.quantity));
  const [unitPrice, setUnitPrice] = useState(num2(editing?.unitPrice));
  const [amount, setAmount] = useState(num2(editing?.netAmount ?? editing?.grossAmount));
  const [fees, setFees] = useState(num2(editing?.fees));
  const [taxes, setTaxes] = useState("");
  const account = accounts.find((item) => item.id === accountId) ?? accounts[0];
  const [currency, setCurrency] = useState(editing?.currency ?? account?.currency ?? "EUR");
  const [exchangeRate, setExchangeRate] = useState("");
  const [note, setNote] = useState(editing?.note ?? "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const isEditing = editing !== null;

  const isTransfer = type === "transfer_in" || type === "transfer_out";
  const needsAsset = type === "achat" || type === "vente" || type === "dividende" || type === "correction" || isTransfer;
  const needsQtyPrice = type === "achat" || type === "vente" || isTransfer;
  const needsAmount = type === "versement" || type === "retrait" || type === "frais" || type === "dividende";
  const needsQtyOnly = type === "correction";
  const advanced = config.modalAdvanced;
  // La devise est toujours modifiable en correction, y compris sur un PEA : un import sans
  // colonne « devise » a repris celle du compte, et c'est précisément ce qu'il faut pouvoir
  // rectifier pour qu'un cours de marché puisse s'appliquer à la position.
  const showCurrency = (advanced || isEditing) && (needsAsset || needsAmount);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");
    const payload: Record<string, unknown> = {
      accountId, type, date,
      assetName: needsAsset ? assetName.trim() || undefined : undefined,
      ticker: needsAsset ? ticker.trim() || undefined : undefined,
      isin: needsAsset ? isin.trim() || undefined : undefined,
      quantity: needsQtyPrice || needsQtyOnly ? Number(quantity) : undefined,
      unitPrice: needsQtyPrice ? Number(unitPrice) : undefined,
      netAmount: needsAmount ? Number(amount) : undefined,
      fees: fees ? Number(fees) : undefined,
      taxes: advanced && taxes ? Number(taxes) : undefined,
      currency: showCurrency ? currency : undefined,
      exchangeRate: advanced && exchangeRate ? Number(exchangeRate) : undefined,
      note: note.trim() || undefined,
    };
    setSaving(true);
    const result = await onSubmit(payload);
    setSaving(false);
    if (!result.ok) { setError(result.error ?? "Enregistrement impossible."); return; }
    onSaved();
  }

  const envLabel = config.kind === "CTO" ? "Compte-titres" : "PEA";
  return (
    <div className="modal-backdrop" onMouseDown={(event) => !saving && event.target === event.currentTarget && onClose()}>
      <section className="modal pea-modal" ref={dialogRef} role="dialog" aria-modal="true" aria-label={`Enregistrer une opération ${envLabel}`} tabIndex={-1}>
        <header className="pea-modal-head">
          <div><span className="soft-pill">{envLabel} · {account?.memberName ?? account?.name}</span><h2>{isEditing ? "Modifier une opération" : "Enregistrer une opération"}</h2></div>
          <button type="button" className="pea-modal-close" onClick={onClose} aria-label="Fermer">×</button>
        </header>
        <form className="pea-form" onSubmit={handleSubmit}>
          {isEditing && (
            <p className="imp-hint pea-field-wide">
              Le portefeuille est <b>dérivé</b> des opérations&nbsp;: corriger cette ligne recalcule automatiquement la quantité, le prix de revient et la valeur. Le compte porteur n’est pas modifiable.
            </p>
          )}
          {accounts.length > 1 && !isEditing && (
            <label className="pea-field pea-field-wide">
              <span>Compte</span>
              <select value={accountId} onChange={(event) => { setAccountId(event.target.value); const next = accounts.find((item) => item.id === event.target.value); if (next) setCurrency(next.currency); }}>
                {accounts.map((item) => <option key={item.id} value={item.id}>{item.name}{item.institution ? ` · ${item.institution}` : ""}</option>)}
              </select>
            </label>
          )}
          {restrictToAchat ? (
            <label className="pea-field">
              <span>Type d’opération</span>
              <input value="Achat" readOnly aria-readonly="true" />
            </label>
          ) : (
            <label className="pea-field">
              <span>Type d’opération</span>
              <select value={type} onChange={(event) => setType(event.target.value as AccountOperationType)}>
                {config.investCards.map((value) => <option key={value} value={value}>{OP_LABEL[value]}</option>)}
                {!config.investCards.includes("correction") && <option value="correction">Correction</option>}
                {/* En modification, le type d'origine reste proposé même s'il n'est pas dans les cartes. */}
                {isEditing && !config.investCards.includes(type) && type !== "correction" && <option value={type}>{OP_LABEL[type]}</option>}
              </select>
            </label>
          )}
          <label className="pea-field">
            <span>Date</span>
            <input type="date" value={date} max={todayISO()} onChange={(event) => setDate(event.target.value)} required />
          </label>
          {needsAsset && (
            <>
              <label className="pea-field pea-field-wide"><span>Nom de l’actif</span><input value={assetName} onChange={(event) => setAssetName(event.target.value)} placeholder="Amundi MSCI World" /></label>
              <label className="pea-field"><span>Ticker</span><input value={ticker} onChange={(event) => setTicker(event.target.value)} placeholder="CW8" /></label>
              <label className="pea-field"><span>ISIN</span><input value={isin} onChange={(event) => setIsin(event.target.value)} placeholder="FR0010315770" /></label>
            </>
          )}
          {(needsQtyPrice || needsQtyOnly) && (
            <label className="pea-field"><span>Quantité{needsQtyOnly ? " (signée)" : ""}</span><input type="number" step="any" value={quantity} onChange={(event) => setQuantity(event.target.value)} required={needsQtyPrice} /></label>
          )}
          {needsQtyPrice && (
            <label className="pea-field"><span>Prix unitaire{isTransfer ? " (prix de revient repris)" : ""}</span><input type="number" step="any" min="0" value={unitPrice} onChange={(event) => setUnitPrice(event.target.value)} required={!isTransfer} /></label>
          )}
          {needsAmount && (
            <label className="pea-field"><span>Montant{type === "dividende" ? " net" : ""}</span><input type="number" step="any" min="0" value={amount} onChange={(event) => setAmount(event.target.value)} required /></label>
          )}
          {showCurrency && (
            <label className="pea-field"><span>Devise</span><input value={currency} onChange={(event) => setCurrency(event.target.value.toUpperCase())} maxLength={3} placeholder="EUR" /></label>
          )}
          {(needsQtyPrice || type === "frais") && (
            <label className="pea-field"><span>Frais</span><input type="number" step="any" min="0" value={fees} onChange={(event) => setFees(event.target.value)} /></label>
          )}
          {advanced && type === "dividende" && (
            <label className="pea-field"><span>Retenue / taxes</span><input type="number" step="any" min="0" value={taxes} onChange={(event) => setTaxes(event.target.value)} /></label>
          )}
          {advanced && showCurrency && currency !== "EUR" && (
            <label className="pea-field"><span>Taux de change → EUR (facultatif)</span><input type="number" step="any" min="0" value={exchangeRate} onChange={(event) => setExchangeRate(event.target.value)} placeholder="ex. 0,92" /></label>
          )}
          <label className="pea-field pea-field-wide"><span>Note (facultatif)</span><input value={note} onChange={(event) => setNote(event.target.value)} /></label>
          {error && <p className="pea-form-error" role="alert">{error}</p>}
          <div className="pea-form-actions">
            <button type="button" className="secondary-button" onClick={onClose}>Annuler</button>
            <button type="submit" className="primary-button" disabled={saving}>{saving ? "Enregistrement…" : isEditing ? "Enregistrer les modifications" : "Enregistrer"}</button>
          </div>
        </form>
      </section>
    </div>
  );
}

// ==========================================================================================
// CONFIRMATION D'UNE ACTION DESTRUCTIVE
// ==========================================================================================
// `challenge` : pour les actions les plus lourdes (vider un compte), l'utilisateur doit RECOPIER
// une valeur (le nom du compte). Le serveur exige la même chose : la garde n'est pas seulement
// visuelle. `onConfirm` renvoie un message d'erreur, ou null en cas de succès.
function ConfirmDangerDialog({ title, detail, confirmLabel, challenge, onCancel, onConfirm }: {
  title: string; detail: string; confirmLabel: string;
  challenge?: { label: string; expected: string };
  onCancel: () => void;
  onConfirm: (value: string) => Promise<string | null>;
}) {
  const dialogRef = useDialogA11y(true, onCancel);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const ready = !challenge || value.trim() === challenge.expected.trim();

  async function confirm() {
    if (!ready || busy) return;
    setBusy(true);
    setError("");
    const message = await onConfirm(value.trim());
    setBusy(false);
    if (message) setError(message);
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => !busy && event.target === event.currentTarget && onCancel()}>
      <section className="modal pea-modal inv-confirm-modal" ref={dialogRef} role="alertdialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <header className="pea-modal-head">
          <div><span className="soft-pill inv-pill-danger">Action irréversible</span><h2>{title}</h2></div>
          <button type="button" className="pea-modal-close" onClick={onCancel} aria-label="Fermer">×</button>
        </header>
        <div className="inv-confirm-body">
          <p>{detail}</p>
          {challenge && (
            <label className="pea-field pea-field-wide">
              <span>{challenge.label}</span>
              <input value={value} onChange={(event) => setValue(event.target.value)} placeholder={challenge.expected} autoComplete="off" />
            </label>
          )}
          {error && <p className="pea-form-error" role="alert">{error}</p>}
          <div className="pea-form-actions">
            <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>Annuler</button>
            <button type="button" className="danger-button" onClick={confirm} disabled={!ready || busy}>{busy ? "Suppression…" : confirmLabel}</button>
          </div>
        </div>
      </section>
    </div>
  );
}
