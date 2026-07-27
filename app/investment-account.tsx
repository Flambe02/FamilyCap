"use client";

// Shell d'investissement PARTAGÉ entre le PEA et le compte-titres (CTO).
// Un seul moteur (lib/portfolio-account.ts), un seul jeu de composants de vue : PEA et CTO
// ne sont que deux `EnvelopeConfig` par-dessus ce shell. Aucune architecture parallèle.
//
// Différences pilotées par la config : titre/logo, hash d'onglet, 6e KPI (performance vs
// impact du change), 3e carte de répartition (géographique vs devise), vue agrégée multi-compte,
// colonnes du tableau de positions, cartes « Investir », champs de la modale et états vides.

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { Viewer } from "../lib/auth-types";
import { useDialogA11y } from "./use-dialog-a11y";
import { authenticatedFetch, OP_LABEL, OP_ICON, OP_INFLOW } from "./investment-shared";
import { InvestmentImportWizard } from "./investment-import-wizard";
import { InvestmentAccountSetup, type SetupNext } from "./investment-account-setup";
import {
  euro, euro0, dateOf, GainPill, BitcoinKpi, DonutChart, LegendRow,
  EvolutionChart, PeriodFilter, EmptyState, type ChartSeries,
} from "./bitcoin-components";
import {
  computeAccountModel, windowAccountTimeline, supportedRanges, priceKeyOf, instrumentKey,
  type AccountModel, type AccountOperation, type AccountOperationType, type AccountType, type InstrumentPrice, type PortfolioPosition,
} from "../lib/portfolio-account";
import { computeMonthlyPlanProgress, type MonthlyPlanProgress } from "../lib/investment-plan";
import { FX_FOOTNOTE, getLatestFxRate, shortRateDate, staleRateNotice, type FxRateRow } from "../lib/fx-rates";
// Sélection d'un actif coté : remplace les champs libres Nom / Ticker / ISIN / Devise de la modale.
import { AssetSearchField } from "./asset-search-field";
import {
  ASSET_TYPES, ASSET_TYPE_LABEL as CATALOG_TYPE_LABEL,
  type AssetCandidate, type NormalizedAssetType,
} from "../lib/asset-catalog";

/** Le compte a-t-il des opérations antérieures au premier taux connu ? (coût approximé) */
function operationsStartBefore(startDate: string | null, firstRateDate: string): boolean {
  return startDate !== null && startDate < firstRateDate;
}
// Type SEUL (effacé à la compilation) : `lib/market-quotes` est un module serveur, jamais
// embarqué dans le bundle client — seule sa forme de données est partagée avec la fiche d'actif.
import type { InstrumentSnapshot } from "../lib/market-quotes";
import "./pea-investments.css";
// Liste « Mes positions » : composant dédié (grille explicite + cartes mobiles), importé APRÈS
// la feuille PEA pour que ses règles l'emportent sur l'ancien habillage de tableau.
import { PositionsList, PortfolioSummaryStrip, ASSET_LABEL, money } from "./positions-list";

// ---- Types d'entrée (formes renvoyées par /api/portfolio) --------------------------------
export type InvestmentAccount = {
  id: string; name: string; institution?: string | null; accountType: string; currency: string;
  memberId?: string; memberName: string | null;
  // Informations de contexte (renvoyées par /api/portfolio ; null tant que la colonne/migration
  // correspondante n'existe pas). Affichées dans l'onglet « Infos », jamais injectées au moteur.
  accountNumberLast4?: string | null; ibanLast4?: string | null; openedAt?: string | null;
  monthlyTarget?: number | null; openingBalance?: number | null; notes?: string | null;
};
export type InvestmentHolding = { id?: string; account_id: string; asset_type?: string | null; name?: string | null; symbol?: string | null; isin?: string | null; quantity: number; average_cost: number | null; last_price: number | null; last_price_at?: string | null; currency: string; exchange?: string | null; providerSymbol?: string | null; yahooSymbol?: string | null; micCode?: string | null; dataProvider?: string | null; quoteMode?: "eod" | "delayed" | "realtime" | "manual" | null; country?: string | null; marketStatus?: string | null; dataDelayMinutes?: number | null; fetchedAt?: string | null; fxRateToReference?: number | null; referenceCurrency?: string | null };
export type InvestmentOperation = AccountOperation;

// Plan d'investissement du membre affiché (sous-ensemble utile au shell). L'objectif mensuel
// est l'engagement PERSONNEL du membre (≠ financial_accounts.monthly_target).
export type ShellInvestmentPlan = { monthlyTarget: number | null; targetAccountId: string | null };

export type InvestmentTab = "resume" | "positions" | "investir" | "revenus" | "performance" | "historique" | "infos";

// Compte rendu du rafraîchissement des cours (une ligne par position). Aucune valeur n'est
// inventée : un instrument introuvable ou coté dans une autre devise est RAPPORTÉ, pas écrit.
export type PriceRefreshRow = {
  instrumentKey: string;
  assetId: string | null;
  listingId: string | null;
  name: string;
  isin: string | null;
  ticker: string | null;
  symbol: string | null;
  status: "updated" | "preserved" | "unresolved" | "failed" | "skipped";
  provider: "eodhd" | "yahoo" | null;
  price: number | null;
  currency: string | null;
  priceAt: string | null;
  reason: string;
  preservedPrice: {
    price: number;
    priceAt: string | null;
    source: "automatic_cache" | "manual_holding";
    provider: string | null;
  } | null;
  diagnostic?: { primaryReason: string | null; fallbackReason: string | null };
};
// Compte rendu de la passe de CHANGE, distincte de celle des cours : elle a ses propres
// fournisseurs (gratuits, sans clé) et son propre cache quotidien.
export type FxRefreshRow = { pair: string; status: "fresh" | "cached" | "unavailable"; rate?: number; provider?: string; quotedAt?: string; message?: string };
export type PriceRefreshReport = {
  total: number;
  updated: number;
  preserved: { total: number; automaticCache: number; manualHoldingPrice: number };
  unresolved: number;
  failed: number;
  skipped: number;
  provider: {
    primary: string;
    primaryConfigured: boolean;
    primaryCircuitOpen: boolean;
    fallback: string | null;
    fallbackEnabled: boolean;
  };
  results: PriceRefreshRow[];
  fx?: FxRefreshRow[];
  error?: string;
};

const EMPTY_REFRESH_REPORT: PriceRefreshReport = {
  total: 0,
  updated: 0,
  preserved: { total: 0, automaticCache: 0, manualHoldingPrice: 0 },
  unresolved: 0,
  failed: 0,
  skipped: 0,
  provider: {
    primary: "eodhd",
    primaryConfigured: false,
    primaryCircuitOpen: false,
    fallback: "yahoo",
    fallbackEnabled: false,
  },
  results: [],
};

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
  const tabs: InvestmentTab[] = ["resume", "positions", "investir", "revenus", "performance", "historique", "infos"];
  return slug && (tabs as string[]).includes(slug) ? (slug as InvestmentTab) : null;
}

// ==========================================================================================
// SHELL
// ==========================================================================================
export function InvestmentAccountShell({
  config, accounts, holdings, operations, fxRates = [], marketLoading, viewer, isPreview, canManage,
  memberCanRecord = false, investmentPlan = null, onReload, onConfigure, onOpenRhythm,
}: {
  config: EnvelopeConfig;
  accounts: InvestmentAccount[];
  holdings: InvestmentHolding[];
  operations: InvestmentOperation[];
  /**
   * Taux de référence BCE (base EUR, datés) couvrant les devises du portefeuille, renvoyés par
   * /api/portfolio en une seule requête. Ils servent à deux choses que le facteur déjà attaché à
   * chaque position ne couvre pas : convertir le COÛT HISTORIQUE d'une opération au taux de SA
   * date, et justifier la conversion dans l'infobulle.
   */
  fxRates?: FxRateRow[];
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
  // Position dont on ouvre la FICHE (identité, ma position, données de marché externes).
  const [detailPosition, setDetailPosition] = useState<PortfolioPosition | null>(null);
  const [pricesBusy, setPricesBusy] = useState(false);
  const [priceReport, setPriceReport] = useState<PriceRefreshReport | null>(null);
  // Evite une rafale de rafraichissements lorsque le rechargement des donnees remonte l'arbre.
  // Un compte est actualise une fois a son ouverture, puis l'utilisateur garde le bouton manuel.
  const refreshedOnEntry = useRef<string | null>(null);
  const refreshInFlight = useRef(false);
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
    if (typeof window !== "undefined" && (!window.location.hash.startsWith(`#${config.hashPrefix}/`) || tabFromHash(config.hashPrefix) === null)) {
      window.history.replaceState(null, "", `#${config.hashPrefix}/${tab}`);
    }
    const onHash = () => {
      const next = tabFromHash(config.hashPrefix);
      if (next) setTabState(next);
      else window.history.replaceState(null, "", `#${config.hashPrefix}/${tab}`);
    };
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
        assetId: holding.id ?? null, providerSymbol: holding.providerSymbol ?? null, yahooSymbol: holding.yahooSymbol ?? null, exchange: holding.exchange ?? null, micCode: holding.micCode ?? null,
        dataProvider: holding.dataProvider ?? null, quoteMode: holding.quoteMode ?? null, country: holding.country ?? null,
        marketStatus: holding.marketStatus ?? null, dataDelayMinutes: holding.dataDelayMinutes ?? null, fetchedAt: holding.fetchedAt ?? null,
        fxRateToReference: holding.fxRateToReference ?? null, referenceCurrency: holding.referenceCurrency ?? null,
      });
    }
    return map;
  }, [holdings, scopeIds]);

  const referenceCurrencyCode = selectedAccount?.currency ?? "EUR";

  // Résolveur de change du moteur : devise + DATE DE L'OPÉRATION → facteur vers la devise du
  // compte. Il n'est consulté qu'en dernier recours — un `exchange_rate` enregistré sur
  // l'opération reste prioritaire, car c'est le change réellement subi ce jour-là.
  //
  // `fallbackToEarliest` : la collecte des taux commence aujourd'hui, alors que les achats sont
  // parfois vieux de deux ans. Sans ce repli, aucune plus-value en euros ne serait calculable
  // avant des mois. Le coût est alors converti au plus ancien taux connu — approximation
  // ASSUMÉE et signalée sous le tableau, jamais présentée comme le change réellement subi.
  const fxRateAt = useMemo(
    () => (currency: string, date: string) => getLatestFxRate(currency, referenceCurrencyCode, fxRates, { asOf: date, fallbackToEarliest: true })?.rate ?? null,
    [fxRates, referenceCurrencyCode],
  );

  const model = useMemo(
    () => (hasScope ? computeAccountModel({ operations: scopeOps, priceByKey, accountType: config.kind, today: todayISO(), referenceCurrency: referenceCurrencyCode, fxRateAt }) : null),
    [hasScope, scopeOps, priceByKey, config.kind, referenceCurrencyCode, fxRateAt],
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

  // Pipeline serveur EODHD puis Yahoo. Il n'écrit qu'un cours automatique et son
  // horodatage : jamais une quantité, un prix de revient ou une opération.
  const refreshPrices = useCallback(async () => {
    if (!selectedAccount || refreshInFlight.current) return;
    refreshInFlight.current = true;
    setPricesBusy(true);
    try {
      const response = await authenticatedFetch("/api/market-data/refresh", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId: selectedAccount.id }),
      });
      const data = (await response.json().catch(() => ({}))) as PriceRefreshReport & { error?: string };
      if (!response.ok) {
        setPriceReport({ ...EMPTY_REFRESH_REPORT, error: data.error ?? "Mise à jour des cours impossible." });
      } else {
        setPriceReport({
          ...EMPTY_REFRESH_REPORT,
          ...data,
          preserved: data.preserved ?? EMPTY_REFRESH_REPORT.preserved,
          provider: data.provider ?? EMPTY_REFRESH_REPORT.provider,
          results: data.results ?? [],
          fx: data.fx ?? [],
        });
        onReload();
      }
    } catch {
      setPriceReport({ ...EMPTY_REFRESH_REPORT, error: "Réseau indisponible." });
    } finally {
      setPricesBusy(false);
      refreshInFlight.current = false;
    }
  }, [onReload, selectedAccount]);

  // Les cours sont rafraichis cote serveur quand un administrateur ouvre un compte precis qui
  // contient des positions. Cela ne cree ni ne modifie aucune operation financiere, et ne se
  // declenche pas dans la vue agregee (la route attend un compte unique).
  useEffect(() => {
    if (!canManage || !selectedAccount || model?.positions.length === 0) return;
    if (refreshedOnEntry.current === selectedAccount.id) return;
    refreshedOnEntry.current = selectedAccount.id;
    void refreshPrices();
  }, [canManage, model?.positions.length, refreshPrices, selectedAccount]);

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
    { id: "infos", label: "Infos" },
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
            <PositionsTab model={model!} canManage={canManage} fxRates={fxRates}
              canRefreshPrices={canManage && selectedAccount !== null} pricesBusy={pricesBusy} onRefreshPrices={refreshPrices}
              priceReport={priceReport} onDismissPriceReport={() => setPriceReport(null)}
              onOpenPosition={setDetailPosition} />
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
          {tab === "revenus" && <RevenusTab model={model!} operations={scopeOps} accountIds={scopeAccounts.map((account) => account.id)} />}
          {tab === "investir" && <InvestirTab config={config} model={model!} canManage={canManage} memberCanRecord={memberCanRecord} onAdd={(type) => setModal({ open: true, type, mode: "admin" })} onMemberAdd={() => setModal({ open: true, type: "achat", mode: "member" })} />}
          {tab === "performance" && <PerformanceTab model={model!} />}
        </>
      )}

      {modal.open && (canManage || (memberCanRecord && modal.mode === "member")) && writeAccounts.length > 0 && (
        <InvestmentOperationModal config={config} accounts={writeAccounts} positions={model?.positions ?? []} defaultAccountId={selectedAccount?.id ?? writeAccounts[0].id}
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
        <InvestmentOperationModal config={config} accounts={envAccounts.filter((item) => item.id === editingOp.accountId)} positions={model?.positions ?? []}
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
      {detailPosition && (
        <PositionDetailModal
          key={detailPosition.key}
          position={detailPosition}
          envLabel={config.kind === "CTO" ? "Compte-titres" : "PEA"}
          operations={operationsOfPosition(detailPosition.key)}
          canManage={canManage}
          onClassified={onReload}
          onPrepareReference={canManage && selectedAccount ? async () => { await refreshPrices(); } : undefined}
          onViewOperations={() => { setDetailPosition(null); setTab("historique"); }}
          onEditOperation={canManage ? (operation) => { setDetailPosition(null); setEditingOp(operation); } : undefined}
          onAddRelated={canManage ? () => { setDetailPosition(null); setModal({ open: true, type: "achat", mode: "admin" }); } : undefined}
          onViewDividends={() => { setDetailPosition(null); setTab("revenus"); }}
          onClose={() => setDetailPosition(null)}
        />
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
            <span className="btc-eyebrow">VALEUR TOTALE DU COMPTE</span>
            <strong className="btc-hero-value">{valueLabel}</strong>
            <p className="btc-hero-btc">{euro.format(model.netInvestedEur)} investis</p>
            <div className="btc-hero-gain"><GainPill eur={model.unrealizedGainEur} pct={model.unrealizedGainPct} muted={marketLoading} /></div>
            <small className="btc-hero-note">
              Valeur des positions {model.positionsValueEur === null ? "indisponible" : euro.format(model.positionsValueEur)}
              {" · "}Trésorerie {euro.format(model.cashEur)}
              {" · "}Depuis l’origine ({startLabel}){multiCurrency ? " · valeurs non converties" : ""}
            </small>
          </div>
          <div className="btc-hero-scene" aria-hidden="true" />
        </section>

        <div className="btc-kpi-grid">
          <BitcoinKpi label="MONTANT NET INVESTI" value={euro.format(model.netInvestedEur)} sub="Versements − retraits" icon="wallet" tone="amber" />
          <BitcoinKpi label="VALEUR DES POSITIONS" value={model.positionsValueEur === null ? "Cours non disponible" : euro.format(model.positionsValueEur)} sub={`${model.valuationCoverage.valuedPositions}/${model.valuationCoverage.totalPositions} positions valorisées`} icon="landmark" tone="teal" />
          <BitcoinKpi label={model.valuationCoverage.unvaluedPositions > 0 ? "PERFORMANCE PARTIELLE" : "PLUS / MOINS-VALUE"} value={model.unrealizedGainEur === null ? "Cours non disponible" : <GainPill eur={model.unrealizedGainEur} pct={model.unrealizedGainPct} />} sub={`Coût valorisé ${euro.format(model.valuationCoverage.valuedCostEur)}`} icon="trending-up" tone="teal" />
          <BitcoinKpi label="DIVIDENDES REÇUS" value={euro.format(model.dividendsNetEur)} sub="Net, depuis l’origine" icon="sprout" tone="teal" />
          <BitcoinKpi label="TRÉSORERIE" value={euro.format(model.cashEur)} sub={model.cashEur < 0 ? "Des apports historiques peuvent manquer" : "Disponible"} icon="bell" tone="blue" />
          {config.sixthKpi === "fxImpact" ? (
            <BitcoinKpi label="IMPACT DU CHANGE" value={model.fxImpactEur === null ? "Non disponible" : euro.format(model.fxImpactEur)} sub={multiCurrency ? "Plusieurs devises détectées" : "Calcul à venir"} icon="swap" tone="navy" />
          ) : (
            <BitcoinKpi label={model.valuationCoverage.unvaluedPositions > 0 ? "PERFORMANCE PARTIELLE" : "PERFORMANCE DES POSITIONS"} value={model.unrealizedGainPct === null ? "Non disponible" : `${model.unrealizedGainPct >= 0 ? "+" : ""}${model.unrealizedGainPct.toFixed(2).replace(".", ",")} %`} sub={`${model.valuationCoverage.coveragePercent.toFixed(0)} % des positions valorisées`} icon="trending-up" tone="teal" />
          )}
        </div>
        {model.cashEur < 0 && (
          <p className="btc-chart-source" role="note">
            Trésorerie négative : certains achats ne sont associés à aucun versement ou transfert entrant. Aucune opération n’a été créée automatiquement.
          </p>
        )}
        {model.valuationCoverage.unvaluedPositions > 0 && (
          <p className="btc-chart-source" role="note">
            Performance partielle : {model.valuationCoverage.unvaluedPositions} position(s), représentant un coût de {euro.format(model.valuationCoverage.unvaluedCostEur)}, sont exclues faute de cours.
          </p>
        )}
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
            <div><small>{model.valuationCoverage.unvaluedPositions > 0 ? "Performance partielle" : "Performance des positions"}</small><strong className={model.unrealizedGainEur === null ? "" : model.unrealizedGainEur >= 0 ? "up" : "down"}><GainPill eur={model.unrealizedGainEur} pct={model.unrealizedGainPct} /></strong></div>
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
  model, canManage, canRefreshPrices, pricesBusy, onRefreshPrices, priceReport, onDismissPriceReport,
  onOpenPosition, fxRates = [],
}: {
  model: AccountModel; canManage: boolean;
  canRefreshPrices: boolean; pricesBusy: boolean; onRefreshPrices: () => void;
  priceReport: PriceRefreshReport | null; onDismissPriceReport: () => void;
  onOpenPosition: (position: PortfolioPosition) => void;
  fxRates?: FxRateRow[];
}) {
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [currencyFilter, setCurrencyFilter] = useState("all");
  const [accountFilter, setAccountFilter] = useState("all");
  const [sort, setSort] = useState<"value" | "gain" | "gainPct" | "weight" | "name" | "type">("value");
  const [visibleCount, setVisibleCount] = useState(15);

  const accountOptions = useMemo(() => [...new Set(model.positions.flatMap((position) => position.accounts))].sort(), [model.positions]);
  const currencyOptions = useMemo(() => [...new Set(model.positions.map((position) => position.currency))].sort(), [model.positions]);

  const filtered = model.positions.filter((position) => {
    if (typeFilter !== "all" && position.assetType !== typeFilter) return false;
    if (currencyFilter !== "all" && position.currency !== currencyFilter) return false;
    if (accountFilter !== "all" && !position.accounts.includes(accountFilter)) return false;
    if (search.trim()) {
      const needle = search.trim().toLowerCase();
      const hay = `${position.name} ${position.ticker ?? ""} ${position.isin ?? ""}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  }).sort((a, b) => {
    if (sort === "name") return a.name.localeCompare(b.name, "fr");
    if (sort === "type") return ASSET_LABEL[a.assetType].localeCompare(ASSET_LABEL[b.assetType], "fr");
    if (sort === "gain") return (b.gainEur ?? -Infinity) - (a.gainEur ?? -Infinity);
    if (sort === "gainPct") return (b.gainPct ?? -Infinity) - (a.gainPct ?? -Infinity);
    if (sort === "weight") return b.weightPct - a.weightPct;
    return (b.currentValueEur ?? -Infinity) - (a.currentValueEur ?? -Infinity);
  });
  const visiblePositions = filtered.slice(0, visibleCount);
  const quoteDates = model.positions.map((position) => position.lastPriceAt).filter((date): date is string => Boolean(date));
  const uniqueQuoteDates = [...new Set(quoteDates.map((date) => date.slice(0, 10)))];
  const latestQuoteAt = quoteDates.sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] ?? null;
  const quoteFetchDates = model.positions.map((position) => position.quoteFetchedAt).filter((date): date is string => Boolean(date));
  const latestQuoteFetchAt = quoteFetchDates.sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] ?? null;
  const quoteHeader = uniqueQuoteDates.length === 1 && latestQuoteAt
    ? `Cours au ${dayOf(latestQuoteAt)}`
    : latestQuoteAt ? `Cours actualisés le ${dayOf(latestQuoteFetchAt ?? latestQuoteAt)}` : "Cours indisponibles";
  const hasActiveFilters = Boolean(search || typeFilter !== "all" || currencyFilter !== "all" || accountFilter !== "all" || sort !== "value");
  const resetFilters = () => {
    setSearch(""); setTypeFilter("all"); setCurrencyFilter("all"); setAccountFilter("all"); setSort("value"); setVisibleCount(15);
  };

  // Devise de référence du périmètre + présence d'une position cotée dans une autre devise :
  // c'est ce qui justifie (ou non) la note de bas de liste sur la conversion.
  const referenceCurrency = model.positions[0]?.referenceCurrency ?? "EUR";
  const hasForeignCurrency = model.positions.some((position) => position.currency !== position.referenceCurrency);
  const countLabel = `${filtered.length} position${filtered.length > 1 ? "s" : ""}`;
  // Ventilation des positions non valorisées (simple comptage d'un état déjà calculé par le
  // moteur : `model.unpricedPositions` les additionne sans dire laquelle relève de quelle cause).
  const noQuote = model.positions.filter((position) => position.lastPrice === null).length;
  const noFxRate = model.positions.filter((position) => position.lastPrice !== null && position.currentValueEur === null).length;

  // Justification du change : un taux par devise étrangère réellement présente, avec sa date.
  // Calculé ici, affiché une seule fois sous le tableau — jamais ligne à ligne.
  const foreignCurrencies = useMemo(
    () => [...new Set(model.positions.filter((position) => position.currency !== position.referenceCurrency).map((position) => position.currency))],
    [model.positions],
  );
  const fxConversions = useMemo(
    () => foreignCurrencies.map((currency) => ({ currency, conversion: getLatestFxRate(currency, referenceCurrency, fxRates) })),
    [foreignCurrencies, referenceCurrency, fxRates],
  );
  const fxTooltip = useMemo(() => {
    const legs = fxConversions.flatMap((entry) => entry.conversion?.legs ?? []);
    return legs.length > 0 ? legs.join("\n") : null;
  }, [fxConversions]);
  const fxStaleNotices = useMemo(
    () => fxConversions.map((entry) => {
      const notice = staleRateNotice(entry.conversion);
      return notice ? `${entry.currency} : ${notice}` : null;
    }).filter((notice): notice is string => notice !== null),
    [fxConversions],
  );
  // Date du plus ancien taux connu : au-delà, les coûts d'achat sont convertis par approximation.
  // On le dit une fois, sous le tableau — plutôt que de laisser croire à un change réellement subi.
  const firstRateDate = useMemo(
    () => fxRates.reduce<string | null>((best, row) => (best === null || row.rateDate < best ? row.rateDate : best), null),
    [fxRates],
  );
  const hasOlderPurchases = useMemo(
    () => firstRateDate !== null && model.positions.some((position) => position.currency !== position.referenceCurrency)
      && operationsStartBefore(model.startDate, firstRateDate),
    [firstRateDate, model.positions, model.startDate],
  );

  return (
    <section className="panel table-panel btc-table-card inv-positions-panel">
      <div className="inv-positions-head">
        <div>
          <h2>Mes positions</h2>
          {/* Valeur DES POSITIONS, pas du compte : les espèces n'ont rien à faire dans un
              décompte de lignes détenues. */}
          <p className="inv-positions-subtitle">
            {countLabel}
            {model.positionsValueEur !== null && ` · ${money(model.positionsValueEur, referenceCurrency)}`}
          </p>
        </div>
        <div className="inv-quote-actions">
          <span className="inv-quote-asof">{quoteHeader}</span>
          {canManage && canRefreshPrices && (
            <button type="button" className="inv-refresh-button" disabled={pricesBusy} onClick={onRefreshPrices}
              title="Met à jour les dernières clôtures EODHD, avec cache quotidien et sans exposer la clé fournisseur.">
              {pricesBusy ? "Actualisation…" : "Actualiser"}
            </button>
          )}
        </div>
        {model.positions.length > 0 && (
          <div className="inv-filters">
            <label className="inv-filter-search"><span className="sr-only">Rechercher une position</span><input type="search" value={search} onChange={(event) => { setSearch(event.target.value); setVisibleCount(15); }} placeholder="Rechercher un actif, un ticker ou un ISIN" /></label>
            <label><span className="sr-only">Filtrer par type</span>
              <select value={typeFilter} onChange={(event) => { setTypeFilter(event.target.value); setVisibleCount(15); }}>
                <option value="all">Tous les types</option>
                {Object.entries(ASSET_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            {currencyOptions.length > 1 && (
              <label><span className="sr-only">Filtrer par devise</span>
                <select value={currencyFilter} onChange={(event) => { setCurrencyFilter(event.target.value); setVisibleCount(15); }}>
                  <option value="all">Toutes devises</option>
                  {currencyOptions.map((currency) => <option key={currency} value={currency}>{currency}</option>)}
                </select>
              </label>
            )}
            {accountOptions.length > 1 && (
              <label><span className="sr-only">Filtrer par compte</span>
                <select value={accountFilter} onChange={(event) => { setAccountFilter(event.target.value); setVisibleCount(15); }}>
                  <option value="all">Tous les comptes</option>
                  {accountOptions.map((account) => <option key={account} value={account}>{account}</option>)}
                </select>
              </label>
            )}
            <label><span className="sr-only">Trier les positions</span><select value={sort} onChange={(event) => { setSort(event.target.value as typeof sort); setVisibleCount(15); }}><option value="value">Valeur décroissante</option><option value="gain">Performance (€)</option><option value="gainPct">Performance (%)</option><option value="weight">Poids</option><option value="name">Nom</option><option value="type">Type</option></select></label>
            {hasActiveFilters && <button type="button" className="inv-reset-filters" onClick={resetFilters}>Réinitialiser</button>}
          </div>
        )}
      </div>
      <PortfolioSummaryStrip
        positionsValue={model.positionsValueEur}
        totalValue={model.totalValueEur}
        invested={model.investedInAssetsEur}
        gainEur={model.unrealizedGainEur}
        gainPct={model.unrealizedGainPct}
        dividends={model.dividendsNetEur}
        currency={referenceCurrency}
        unvaluedPositions={model.valuationCoverage.unvaluedPositions}
        unvaluedCost={model.valuationCoverage.unvaluedCostEur}
      />
      {priceReport && <PriceRefreshPanel report={priceReport} onDismiss={onDismissPriceReport} />}
      {model.positions.length === 0 ? (
        <EmptyState title="Aucune position" description="Aucune position détenue à ce jour." />
      ) : filtered.length === 0 ? (
        <EmptyState title="Aucun résultat" description="Aucune position ne correspond à ces filtres." />
      ) : (
        <PositionsList positions={visiblePositions} onOpen={onOpenPosition} />
      )}
      {filtered.length > visiblePositions.length && (
        <div className="inv-show-more"><button type="button" className="secondary-button" onClick={() => setVisibleCount((count) => count + 15)}>Afficher plus ({filtered.length - visiblePositions.length})</button></div>
      )}
      {hasForeignCurrency && (
        <p className="btc-chart-source" title={fxTooltip ?? undefined}>
          Valeurs et performances exprimées en {referenceCurrency}. Les cours et le prix de revient restent affichés dans la devise de cotation de l’actif.
          {" "}{FX_FOOTNOTE}
          {/* Le taux n'apparaît PAS sur chaque ligne : il serait répété dix fois pour dire dix
              fois la même chose. Il est ici, en infobulle, et dans la fiche de la position. */}
          {fxStaleNotices.length > 0 && <em> {fxStaleNotices.join(" · ")}.</em>}
          {hasOlderPurchases && (
            <em> Les achats antérieurs au {shortRateDate(firstRateDate!)} sont convertis au plus ancien taux enregistré : leur prix de revient en {referenceCurrency} est une approximation.</em>
          )}
        </p>
      )}
      {/* Deux causes DISTINCTES d'absence de valeur, deux messages distincts : les confondre
          sous « sans cours » envoyait vers « Actualiser les cours » une position qui a un cours
          et à laquelle il manque seulement un taux de change — action sans effet. */}
      {/* Chaînes assemblées en JS, pas en JSX multiligne : une expression suivie d'un retour à
          la ligne perd l'espace qui la sépare du texte suivant (« 6position(s) sans cours »). */}
      {noQuote > 0 && (
        <p className="btc-chart-source">
          {`${noQuote} position(s) sans cours : leur valeur n’est pas comptée dans le total.`}
          {canManage ? " Utilisez « Actualiser » pour les relire auprès du fournisseur de marché, ou saisissez le cours dans Administration › Comptes & positions." : ""}
        </p>
      )}
      {noFxRate > 0 && (
        <p className="btc-chart-source">
          {`${noFxRate} position(s) cotée(s) dans une autre devise que ${referenceCurrency}, sans taux de change enregistré : leur valeur n’est pas convertie et n’est pas comptée dans le total. Aucune conversion n’est estimée tant qu’un taux fiable n’a pas été relevé.`}
        </p>
      )}
    </section>
  );
}

// Compte rendu du rafraîchissement : chaque position a une ligne, y compris les échecs. Rien
// n'est masqué — une position sans cours doit se voir, pas disparaître du total en silence.
function PriceRefreshPanel({ report, onDismiss }: { report: PriceRefreshReport; onDismiss: () => void }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const unavailable = report.results.filter((row) => row.status === "failed");
  const preserved = report.results.filter((row) => row.status === "preserved");
  const needsReview = report.results.filter((row) => row.status === "unresolved");
  const primary = report.results.filter((row) => row.status === "updated" && row.provider === "eodhd");
  const backup = report.results.filter((row) => row.status === "updated" && row.provider === "yahoo");
  const fx = report.fx ?? [];
  const fxFailures = fx.filter((row) => row.status === "unavailable");
  const hasIssue = unavailable.length > 0 || preserved.length > 0 || needsReview.length > 0 || fxFailures.length > 0;
  const title = report.error ? "Actualisation momentanément indisponible"
    : needsReview.length > 0 ? `${needsReview.length} actif${needsReview.length > 1 ? "s" : ""} à vérifier`
      : !hasIssue ? "Cours actualisés"
        : report.updated > 0 || preserved.length > 0 ? "Actualisation partielle" : "Actualisation momentanément indisponible";
  const message = report.error ? "Les nouveaux cours n’ont pas pu être récupérés. Réessayez plus tard."
    : report.updated === report.total && report.total > 0 ? `${report.updated} cours actualisés.`
      : report.updated === 0 && report.preserved.total > 0
        ? `Aucun nouveau cours récupéré. ${report.preserved.total} cours existants ont été conservés. ${report.unresolved + report.failed} position(s) restent sans cours.`
        : `${report.updated} cours actualisé${report.updated > 1 ? "s" : ""}. ${report.preserved.total} dernier${report.preserved.total > 1 ? "s" : ""} cours connu${report.preserved.total > 1 ? "s" : ""} conservé${report.preserved.total > 1 ? "s" : ""}.`;
  return (
    <div className={`inv-price-report${hasIssue || report.error ? " warn" : ""}`} role="status">
      <button type="button" className="inv-price-report-close" onClick={onDismiss} aria-label="Fermer">×</button>
      <strong>{title}</strong>
      <span>{message}</span>
      {preserved.length > 0 && <small>Les valorisations restent disponibles avec la date de chaque cours.</small>}
      {(hasIssue || backup.length > 0) && <button type="button" className="inv-price-report-details" onClick={() => setDetailsOpen((open) => !open)}>{detailsOpen ? "Masquer les détails" : "Voir les détails"}</button>}
      {detailsOpen && (
        <div className="inv-price-report-details-content">
          {primary.length > 0 && <p>{primary.length} cours actualisé{primary.length > 1 ? "s" : ""} par le fournisseur principal.</p>}
          {backup.length > 0 && <p>EODHD était indisponible ou avait atteint sa limite. Yahoo Finance a actualisé {backup.length} position{backup.length > 1 ? "s" : ""}.</p>}
          {preserved.length > 0 && <p>{report.preserved.automaticCache} cours automatique(s) et {report.preserved.manualHoldingPrice} cours manuel(s) conservé(s).</p>}
          {needsReview.length > 0 && <p>Actif à vérifier : {needsReview.map((row) => row.name).join(", ")}.</p>}
          {unavailable.length > 0 && <p>Aucun cours disponible : {unavailable.map((row) => row.name).join(", ")}.</p>}
          {report.results.map((row) => (
            <details key={row.instrumentKey}>
              <summary>{row.name} · {row.status === "updated" ? "actualisé" : row.status === "preserved" ? "cours conservé" : row.status === "unresolved" ? "instrument à vérifier" : row.status === "failed" ? "échec" : "ignoré"}</summary>
              <p>
                Symbole : {row.symbol ?? "non déterminé"} · Fournisseur : {row.provider === "yahoo" ? "Yahoo Finance" : row.provider === "eodhd" ? "EODHD" : "aucun"}.
                {" "}{refreshReasonLabel(row.reason)}
                {row.preservedPrice ? ` Ancien cours conservé : ${money(row.preservedPrice.price, row.currency ?? "EUR")}.` : ""}
              </p>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

function refreshReasonLabel(reason: string) {
  const labels: Record<string, string> = {
    primary_success: "Le fournisseur principal a répondu.",
    primary_not_configured: "EODHD n’est pas configuré sur le serveur.",
    primary_quota_exhausted: "La limite EODHD est atteinte.",
    primary_symbol_not_found: "EODHD n’a pas trouvé ce symbole.",
    primary_http_error: "EODHD est temporairement indisponible.",
    primary_timeout: "EODHD n’a pas répondu à temps.",
    primary_parse_error: "La réponse EODHD était inexploitable.",
    fallback_success: "Le fournisseur de secours a répondu.",
    fallback_disabled: "Le fournisseur de secours Yahoo doit être activé dans la configuration serveur.",
    fallback_symbol_not_found: "Yahoo Finance n’a pas trouvé ce symbole.",
    fallback_http_error: "Yahoo Finance est temporairement indisponible.",
    fallback_timeout: "Yahoo Finance n’a pas répondu à temps.",
    fallback_parse_error: "La réponse Yahoo Finance était inexploitable.",
    fallback_attempt_limit: "La limite de tentatives du fournisseur de secours est atteinte.",
    preserved_automatic_cache: "Le dernier cours automatique valide est conservé.",
    preserved_manual_price: "Le cours manuel historique est conservé.",
    missing_market_identity: "Renseignez l’instrument et sa place de cotation.",
    ambiguous_market_identity: "Le ticker est ambigu : vérifiez la place et la devise.",
    quote_storage_failed: "Le cours récupéré n’a pas pu être sauvegardé.",
  };
  return labels[reason] ?? "Consultez l’identité de marché de cette position.";
}

// ==========================================================================================
// FICHE D'UN ACTIF
// ==========================================================================================
// Trois blocs, dans cet ordre : ce qu'EST l'instrument, ce que J'EN DÉTIENS, ce qu'en dit le
// MARCHÉ. Les deux premiers viennent des opérations enregistrées (source de vérité interne) ;
// le troisième d'un fournisseur externe gratuit, chargé à l'ouverture et clairement attribué.
// Aucune valeur externe n'est écrite en base : la fiche informe, elle ne modifie rien.

/** Courbe de tendance (1 mois). Uniquement des points réellement cotés — jamais interpolés. */
function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const width = 100;
  const height = 30;
  const path = points.map((value, index) => `${(index / (points.length - 1)) * width},${height - ((value - min) / span) * height}`).join(" ");
  const rising = points[points.length - 1] >= points[0];
  return (
    <svg className="inv-spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={rising ? "Tendance à la hausse sur un mois" : "Tendance à la baisse sur un mois"}>
      <polyline points={path} fill="none" strokeWidth="1.6" vectorEffect="non-scaling-stroke"
        stroke={rising ? "var(--btc-up, #1d7a5f)" : "var(--btc-down, #d9544d)"} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// `dateOf` attend une date SEULE (« 2026-07-24 ») : elle concatène « T00:00:00Z ». Lui passer un
// horodatage complet (`holdings.last_price_at`, `asOf` du fournisseur) produit une date invalide
// et fait planter le rendu. On tronque donc systématiquement à la partie calendaire.
const dayOf = (iso: string) => dateOf(String(iso).slice(0, 10));

function DetailRow({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "up" | "down" }) {
  return (
    <div className="inv-detail-row">
      <dt>{label}</dt>
      <dd className={tone ? tone : undefined}>{value}</dd>
    </div>
  );
}

type MarketState =
  | { status: "loading" }
  | { status: "ok"; instrument: InstrumentSnapshot; currencyMismatch: boolean }
  | { status: "error"; message: string };

function PositionDetailModal({ position, envLabel, operations, canManage, onClassified, onPrepareReference, onViewOperations, onEditOperation, onAddRelated, onViewDividends, onClose }: {
  position: PortfolioPosition; envLabel: string; operations: InvestmentOperation[]; canManage: boolean; onClassified: () => void;
  // Crée la fiche d'actif manquante (via le rafraîchissement des cours du compte). Absent en vue
  // agrégée : la création vise un compte précis.
  onPrepareReference?: () => Promise<void>;
  onViewOperations: () => void; onEditOperation?: (operation: InvestmentOperation) => void; onAddRelated?: () => void; onViewDividends: () => void; onClose: () => void;
}) {
  const dialogRef = useDialogA11y(true, onClose);
  const [market, setMarket] = useState<MarketState>({ status: "loading" });
  const [classificationStatus, setClassificationStatus] = useState("");
  const [preparingReference, setPreparingReference] = useState(false);
  const { isin, ticker, name, currency } = position;

  // Pas de remise à « loading » ici : la modale est montée avec `key={position.key}`, donc
  // changer d'actif remonte le composant et l'état initial est déjà le bon.
  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (isin) params.set("isin", isin);
    if (ticker) params.set("ticker", ticker);
    if (name) params.set("name", name);
    if (currency) params.set("currency", currency);
    void (async () => {
      try {
        const response = await authenticatedFetch(`/api/market/instrument?${params.toString()}`);
        const data = (await response.json().catch(() => ({}))) as { instrument?: InstrumentSnapshot; currencyMismatch?: boolean; error?: string };
        if (cancelled) return;
        if (!response.ok || !data.instrument) {
          setMarket({ status: "error", message: data.error ?? "Fiche de marché indisponible pour cet instrument." });
          return;
        }
        setMarket({ status: "ok", instrument: data.instrument, currencyMismatch: data.currencyMismatch === true });
      } catch {
        if (!cancelled) setMarket({ status: "error", message: "Fournisseur de marché injoignable. Réessayez plus tard." });
      }
    })();
    return () => { cancelled = true; };
  }, [isin, ticker, name, currency]);

  const buys = operations.filter((op) => op.type === "achat").length;
  const sells = operations.filter((op) => op.type === "vente").length;
  const dividends = operations.filter((op) => op.type === "dividende")
    .reduce((total, op) => total + Math.abs(Number(op.netAmount ?? 0)), 0);
  const firstDate = operations.length > 0 ? operations.map((op) => op.date).sort()[0] : null;
  const pct = (value: number | null) => (value === null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(2)} %`);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal pea-modal inv-detail-modal" ref={dialogRef} role="dialog" aria-modal="true" aria-label={`Fiche de ${position.name}`} tabIndex={-1}>
        <header className="pea-modal-head">
          <div className="inv-detail-title">
            <span className="soft-pill">{envLabel} · {ASSET_LABEL[position.assetType]}</span>
            <h2>{position.name}</h2>
            <p className="inv-detail-codes">
              {position.ticker && <span className="inv-tag inv-tag-ticker">{position.ticker}</span>}
              {position.isin && <span className="inv-tag inv-tag-isin">{position.isin}</span>}
              <span className="inv-tag inv-tag-ccy">{position.currency}</span>
            </p>
          </div>
          <button type="button" className="pea-modal-close" onClick={onClose} aria-label="Fermer">×</button>
        </header>

        <div className="inv-detail-body">
          <section className="inv-detail-block">
            <h3 className="btc-panel-kicker">MA POSITION</h3>
            <dl className="inv-detail-grid">
              <DetailRow label="Quantité détenue" value={qty.format(position.quantity)} />
              <DetailRow label="Prix de revient (PMP)" value={position.averageCost === null ? "—" : money(position.averageCost, position.currency)} />
              <DetailRow label="Montant investi" value={money(position.investedEur, position.currency)} />
              <DetailRow label="Valeur actuelle" value={position.currentValueEur === null ? "Aucun cours" : money(position.currentValueEur, position.currency)} />
              <DetailRow label="+/- value latente"
                tone={position.gainEur === null ? undefined : position.gainEur >= 0 ? "up" : "down"}
                value={position.gainEur === null ? "—" : `${position.gainEur >= 0 ? "+" : "−"}${money(Math.abs(position.gainEur), position.currency)}${position.gainPct === null ? "" : ` (${position.gainPct >= 0 ? "+" : ""}${position.gainPct.toFixed(1)} %)`}`} />
              <DetailRow label="Poids du portefeuille" value={`${position.weightPct.toFixed(1)} %`} />
              <DetailRow label="Compte(s)" value={position.accounts.length === 0 ? "—" : position.accounts.join(", ")} />
              <DetailRow label="Cours enregistré" value={position.lastPrice === null ? "Aucun" : `${money(position.lastPrice, position.currency)}${position.lastPriceAt ? ` · ${priceAge(position.lastPriceAt) ?? dayOf(position.lastPriceAt)}` : ""}`} />
            </dl>
            <p className="inv-detail-note">
              {operations.length} opération(s) enregistrée(s){buys > 0 ? ` · ${buys} achat(s)` : ""}{sells > 0 ? ` · ${sells} vente(s)` : ""}
              {dividends > 0 ? ` · ${money(dividends, position.currency)} de dividendes` : ""}
              {firstDate ? ` · depuis le ${dateOf(firstDate)}` : ""}.
              La quantité et le prix de revient sont <b>dérivés de ces opérations</b>, jamais saisis directement.
            </p>
            <div className="inv-detail-actions" aria-label="Actions pour cette position">
              {onEditOperation && operations.length === 1 && <button type="button" className="primary-button" onClick={() => onEditOperation(operations[0])}>Modifier l&apos;opération</button>}
              {onEditOperation && operations.length > 1 && <button type="button" className="primary-button" onClick={() => onEditOperation(operations[0])}>Modifier la dernière opération</button>}
              <button type="button" className="secondary-button" onClick={onViewOperations}>{onEditOperation ? "Voir toutes les opérations" : "Voir les opérations"}</button>
              {onAddRelated && <button type="button" className="secondary-button" onClick={onAddRelated}>Ajouter une opération liée</button>}
              <button type="button" className="secondary-button" onClick={onViewDividends}>Voir les dividendes</button>
            </div>
          </section>

          {/* Une position DÉRIVÉE des opérations n'a pas forcément de fiche d'actif en base : son
              `assetId` est alors null. Masquer le bloc dans ce cas (comportement précédent) rendait
              la classification impossible ET inexplicable — l'utilisateur ne voyait rien du tout.
              On montre donc le blocage et l'action qui le lève. */}
          {canManage && position.assetType === "other" && !position.assetId && (
            <section className="inv-detail-block inv-classify">
              <h3 className="btc-panel-kicker">À CLASSIFIER</h3>
              <p>
                Cette position est calculée à partir de vos opérations, mais aucune <b>fiche d’actif</b> ne lui correspond encore en base :
                il n’y a donc pas encore de champ à renseigner. La fiche est créée automatiquement au premier rafraîchissement des cours de ce compte.
              </p>
              {onPrepareReference ? (
                <button type="button" className="secondary-button" disabled={preparingReference} onClick={async () => {
                  setPreparingReference(true);
                  await onPrepareReference();
                  setPreparingReference(false);
                }}>{preparingReference ? "Création de la fiche…" : "Créer la fiche et actualiser les cours"}</button>
              ) : (
                <p className="inv-detail-note">Choisissez un compte précis dans l’en-tête (au lieu de « Tous les comptes ») pour lancer cette création.</p>
              )}
              <p className="inv-detail-note">
                Pour corriger la quantité ou le prix de revient, passez par les opérations : ils en sont <b>dérivés</b> et ne se saisissent jamais directement.
              </p>
            </section>
          )}

          {canManage && position.assetType === "other" && position.assetId && (
            <section className="inv-detail-block inv-classify">
              <h3 className="btc-panel-kicker">À CLASSIFIER</h3>
              <p>Renseignez une identité validée : ISIN en priorité, sinon ticker et place. Aucun titre n’est deviné depuis son nom.</p>
              <form onSubmit={async (event) => {
                event.preventDefault(); setClassificationStatus("Enregistrement…");
                const data = new FormData(event.currentTarget);
                const response = await authenticatedFetch(`/api/market-data/assets/${position.assetId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.fromEntries(data)) });
                if (!response.ok) { const result = await response.json().catch(() => ({})) as { error?: string }; setClassificationStatus(result.error ?? "Enregistrement impossible."); return; }
                setClassificationStatus("Classification enregistrée."); onClassified();
              }} className="inv-classify-form">
                <label>Type<select name="assetType" defaultValue={position.assetType}>{Object.entries(ASSET_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                <label>ISIN<input name="isin" defaultValue={position.isin ?? ""} /></label>
                <label>Ticker<input name="ticker" defaultValue={position.ticker ?? ""} /></label>
                <label>Symbole EODHD<input name="providerSymbol" defaultValue={position.providerSymbol ?? ""} placeholder="ex. AI.PA" /></label>
                <label>Symbole Yahoo<input name="yahooSymbol" defaultValue={position.yahooSymbol ?? ""} placeholder="ex. AI.PA" /></label>
                <label>Place<input name="exchange" defaultValue={position.exchange ?? ""} /></label>
                <label>Devise<input name="currency" defaultValue={position.currency} maxLength={3} /></label>
                <label>MIC (optionnel)<input name="micCode" defaultValue={position.micCode ?? ""} /></label>
                <button type="submit" className="secondary-button">Enregistrer la classification</button>
                {classificationStatus && <small role="status">{classificationStatus}</small>}
              </form>
            </section>
          )}

          <section className="inv-detail-block">
            <h3 className="btc-panel-kicker">DONNÉES DE MARCHÉ</h3>
            {market.status === "loading" && <p className="inv-detail-loading">Interrogation du fournisseur de marché…</p>}
            {market.status === "error" && (
              <p className="inv-detail-empty">
                {market.message} Les informations ci-dessus restent celles de vos opérations : elles ne dépendent d’aucun fournisseur externe.
              </p>
            )}
            {market.status === "ok" && (
              <>
                {market.currencyMismatch && (
                  <p className="inv-detail-warn">
                    ⚠ La seule cotation trouvée est en <b>{market.instrument.currency}</b>, alors que votre position est libellée en <b>{position.currency}</b>.
                    Les chiffres ci-dessous sont donc dans une autre devise et ne sont pas comparables tels quels à votre valorisation.
                  </p>
                )}
                {market.instrument.history.length > 1 && (
                  <div className="inv-detail-spark">
                    <Sparkline points={market.instrument.history.map((point) => point.close)} />
                    <small>1 mois · {market.instrument.history.length} séances</small>
                  </div>
                )}
                <dl className="inv-detail-grid">
                  <DetailRow label="Cours de marché" value={money(market.instrument.price, market.instrument.currency)} />
                  <DetailRow label="Variation / veille"
                    tone={market.instrument.dayChangePct === null ? undefined : market.instrument.dayChangePct >= 0 ? "up" : "down"}
                    value={pct(market.instrument.dayChangePct)} />
                  <DetailRow label="Clôture précédente" value={market.instrument.previousClose === null ? "—" : money(market.instrument.previousClose, market.instrument.currency)} />
                  <DetailRow label="Séance (bas – haut)" value={market.instrument.dayLow === null || market.instrument.dayHigh === null ? "—" : `${money(market.instrument.dayLow, market.instrument.currency)} – ${money(market.instrument.dayHigh, market.instrument.currency)}`} />
                  <DetailRow label="52 semaines (bas – haut)" value={market.instrument.fiftyTwoWeekLow === null || market.instrument.fiftyTwoWeekHigh === null ? "—" : `${money(market.instrument.fiftyTwoWeekLow, market.instrument.currency)} – ${money(market.instrument.fiftyTwoWeekHigh, market.instrument.currency)}`} />
                  <DetailRow label="Volume du jour" value={market.instrument.volume === null ? "—" : qty.format(market.instrument.volume)} />
                  <DetailRow label="Place de cotation" value={market.instrument.exchange ?? "—"} />
                  <DetailRow label="Symbole" value={market.instrument.symbol} />
                </dl>
                <p className="inv-detail-source">
                  Source&nbsp;: {market.instrument.provider}{market.instrument.asOf ? ` · relevé le ${dayOf(market.instrument.asOf)}` : ""}
                  {market.instrument.name && market.instrument.name !== position.name ? ` · libellé fournisseur : ${market.instrument.name}` : ""}.
                  Données indicatives, non contractuelles. Elles ne sont pas enregistrées&nbsp;: pour mettre à jour le cours du portefeuille, utilisez «&nbsp;Actualiser les cours&nbsp;».
                </p>
              </>
            )}
          </section>
        </div>

        <div className="pea-form-actions">
          <button type="button" className="primary-button" onClick={onClose}>Fermer</button>
        </div>
      </section>
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
type AnnouncedDividend = { id: string; ex_date: string; payment_date: string | null; amount_per_share: number | null; currency: string | null; status: string; asset: { name: string; symbol: string | null; isin: string | null } | null };
function RevenusTab({ model, operations, accountIds }: { model: AccountModel; operations: InvestmentOperation[]; accountIds: string[] }) {
  const dividends = operations.filter((op) => op.type === "dividende").sort((a, b) => b.date.localeCompare(a.date));
  const [announced, setAnnounced] = useState<AnnouncedDividend[]>([]);
  const [announcedLoading, setAnnouncedLoading] = useState(true);
  const accountIdsKey = accountIds.join(",");
  const year = new Date().getFullYear();
  const paidThisYear = dividends.filter((op) => op.date.startsWith(String(year))).reduce((sum, op) => {
    const amount = Math.abs(Number(op.netAmount ?? op.grossAmount ?? 0));
    const rate = op.currency === "EUR" ? 1 : op.exchangeRate;
    return sum + (Number.isFinite(rate) && Number(rate) > 0 ? amount * Number(rate) : 0);
  }, 0);
  useEffect(() => {
    let active = true;
    authenticatedFetch(`/api/market-data/dividends?accountIds=${encodeURIComponent(accountIdsKey)}`)
      .then((response) => response.ok ? response.json() : { dividends: [] })
      .then((data: { dividends?: AnnouncedDividend[] }) => { if (active) setAnnounced(data.dividends ?? []); })
      .catch(() => { if (active) setAnnounced([]); })
      .finally(() => { if (active) setAnnouncedLoading(false); });
    return () => { active = false; };
  }, [accountIdsKey]);
  return (
    <>
      <section className="panel btc-synth">
        <h3 className="btc-panel-kicker">DIVIDENDES</h3>
        <div className="btc-synth-grid" style={{ gridTemplateColumns: "repeat(3,minmax(0,1fr))" }}>
          <div><small>Dividendes bruts</small><strong>{euro.format(model.dividendsGrossEur)}</strong></div>
          <div><small>Encaissés cette année</small><strong>{euro.format(paidThisYear)}</strong></div>
          <div><small>Opérations réelles</small><strong>{dividends.length}</strong></div>
        </div>
      </section>
      <section className="panel btc-ops-card">
        <h3 className="btc-panel-kicker">DIVIDENDES ANNONCÉS</h3>
        <p className="btc-chart-source">Annonce fournisseur uniquement : elle ne crée jamais un dividende encaissé ni une opération.</p>
        {announcedLoading ? <p className="inv-muted">Chargement des annonces…</p> : announced.length === 0 ? <EmptyState title="Aucun dividende annoncé" description="Les annonces EODHD apparaîtront après une synchronisation réussie." /> : <ul className="btc-ops">{announced.slice(0, 12).map((event) => <li key={event.id}><span className="btc-ops-mark" aria-hidden="true">◌</span><div className="btc-ops-info"><strong>{event.asset?.name ?? "Actif"}</strong><small>Dividende annoncé · détachement {dateOf(event.ex_date)}</small></div><div className="btc-ops-amount"><b>{event.amount_per_share === null ? "Montant non communiqué" : money(event.amount_per_share, event.currency ?? "EUR")}</b><small>{event.payment_date ? `paiement ${dateOf(event.payment_date)}` : "date de paiement inconnue"}</small></div></li>)}</ul>}
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
// PERFORMANCE DES POSITIONS
// ==========================================================================================
function PerformanceTab({ model }: { model: AccountModel }) {
  const coverage = model.valuationCoverage;
  const isPartial = coverage.unvaluedPositions > 0;
  return (
    <>
      <section className="panel btc-synth">
        <h3 className="btc-panel-kicker">PERFORMANCE DES POSITIONS</h3>
        <div className="btc-synth-grid" style={{ gridTemplateColumns: "repeat(3,minmax(0,1fr))" }}>
          <div><small>Valeur des positions</small><strong>{model.positionsValueEur === null ? "Non disponible" : euro.format(model.positionsValueEur)}</strong></div>
          <div><small>Coût des positions valorisées</small><strong>{euro.format(coverage.valuedCostEur)}</strong></div>
          <div><small>Plus / moins-value</small><strong>{model.unrealizedGainEur === null ? "Non disponible" : <GainPill eur={model.unrealizedGainEur} pct={model.unrealizedGainPct} />}</strong></div>
          <div><small>Dividendes nets</small><strong>{euro.format(model.dividendsNetEur)}</strong></div>
          <div><small>Frais</small><strong>{euro.format(model.feesEur)}</strong></div>
          <div><small>Couverture de valorisation</small><strong>{coverage.valuedPositions} / {coverage.totalPositions} position(s)</strong><em>{coverage.coveragePercent.toFixed(0)} % du coût valorisé</em></div>
        </div>
      </section>
      <section className="panel">
        <h3 className="btc-panel-kicker">PÉRIMÈTRE DE CALCUL</h3>
        {isPartial ? (
          <p className="inv-detail-warn">
            Performance partielle : {coverage.unvaluedPositions} position(s) sans cours valide, pour un coût de {euro.format(coverage.unvaluedCostEur)}, sont exclue(s) du calcul. Elles ne sont jamais valorisées à zéro.
          </p>
        ) : (
          <p className="inv-detail-note">Toutes les positions détenues ont un cours valide. La performance compare leur valeur à leur prix de revient.</p>
        )}
      </section>
    </>
  );
}

// ==========================================================================================
// INFOS (informations du compte — lecture seule ; édition dans Paramètres › Mes comptes)
// ==========================================================================================
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

// Types portant un actif : la saisie passe alors par la sélection d'une cotation (étape 1).
const ASSET_TYPES_SET = new Set<AccountOperationType>(["achat", "vente", "dividende", "correction", "transfer_in", "transfer_out"]);
// Types dont l'actif doit être une position RÉELLEMENT DÉTENUE sur le compte (§7 du cahier).
const HELD_ONLY_TYPES = new Set<AccountOperationType>(["vente", "dividende", "transfer_out"]);

/** Une position détenue devient un candidat sélectionnable, sans repasser par le fournisseur. */
function positionToCandidate(position: PortfolioPosition): AssetCandidate {
  return {
    assetId: position.assetId, listingId: null, isin: position.isin, name: position.name,
    assetType: position.assetType, ticker: position.ticker, exchange: position.exchange,
    micCode: position.micCode, currency: position.currency, country: null,
    eodhdSymbol: position.providerSymbol, yahooSymbol: position.yahooSymbol,
    lastPrice: position.lastPrice, lastPriceAt: position.lastPriceAt,
    peaEligible: null, origin: "held", confidence: "inferred",
  };
}

/** Une opération existante redevient un candidat pour permettre sa modification sans re-recherche. */
function editingToCandidate(operation: InvestmentOperation): AssetCandidate | null {
  if (!operation.assetName && !operation.ticker && !operation.isin) return null;
  return {
    assetId: null, listingId: null, isin: operation.isin, name: operation.assetName ?? operation.ticker ?? "Actif",
    assetType: "other", ticker: operation.ticker, exchange: null, micCode: null,
    currency: operation.currency || "EUR", country: null, eodhdSymbol: null, yahooSymbol: null,
    lastPrice: null, lastPriceAt: null, peaEligible: null, origin: "catalog", confidence: "needs_review",
  };
}

function InvestmentOperationModal({ config, accounts, positions = [], defaultAccountId, defaultType, restrictToAchat = false, editing = null, onClose, onSubmit, onSaved }: {
  config: EnvelopeConfig; accounts: InvestmentAccount[]; positions?: PortfolioPosition[]; defaultAccountId: string; defaultType: AccountOperationType; restrictToAchat?: boolean;
  editing?: InvestmentOperation | null;
  onClose: () => void; onSubmit: (payload: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>; onSaved: () => void;
}) {
  const dialogRef = useDialogA11y(true, onClose);
  const [accountId, setAccountId] = useState(defaultAccountId);
  const [type, setType] = useState<AccountOperationType>(defaultType);
  const [date, setDate] = useState(editing?.date ?? todayISO());
  const [selection, setSelection] = useState<AssetCandidate | null>(editing ? editingToCandidate(editing) : null);
  const [unlisted, setUnlisted] = useState(false);
  const [unlistedName, setUnlistedName] = useState("");
  const [unlistedType, setUnlistedType] = useState<NormalizedAssetType>("other");
  const [quantity, setQuantity] = useState(num2(editing?.quantity));
  const [unitPrice, setUnitPrice] = useState(num2(editing?.unitPrice));
  const [amount, setAmount] = useState(num2(editing?.netAmount ?? editing?.grossAmount));
  const [fees, setFees] = useState(num2(editing?.fees));
  // Champs déjà présents en base et jusqu'ici jamais repeuplés en modification (retenue d'un
  // dividende importé, notamment) : ils sont désormais réhydratés depuis l'opération éditée.
  const [taxes, setTaxes] = useState(num2(editing?.taxes));
  const account = accounts.find((item) => item.id === accountId) ?? accounts[0];
  const [accountCurrency, setAccountCurrency] = useState(editing?.currency ?? account?.currency ?? "EUR");
  const [paidEur, setPaidEur] = useState("");
  const [note, setNote] = useState(editing?.note ?? "");
  const [moreOpen, setMoreOpen] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const isEditing = editing !== null;

  const isTransfer = type === "transfer_in" || type === "transfer_out";
  const needsAsset = ASSET_TYPES_SET.has(type);
  const needsQtyPrice = type === "achat" || type === "vente" || isTransfer;
  const needsAmount = type === "versement" || type === "retrait" || type === "frais" || type === "dividende";
  const needsQtyOnly = type === "correction";
  const advanced = config.modalAdvanced;
  const heldOnly = HELD_ONLY_TYPES.has(type);

  // La devise n'est plus saisie : elle vient de la cotation choisie (ou du compte pour les
  // opérations d'espèces). C'est ce qui supprime la dernière voie d'incohérence d'identité.
  const currency = needsAsset ? (selection?.currency ?? accountCurrency) : accountCurrency;

  const heldCandidates = useMemo(
    () => positions.filter((position) => position.quantity > 1e-9).map(positionToCandidate),
    [positions],
  );
  const availableQuantity = useMemo(() => {
    if (!heldOnly || !selection) return null;
    const match = positions.find((position) =>
      (selection.isin && position.isin === selection.isin)
      || (selection.ticker && position.ticker === selection.ticker)
      || position.name === selection.name);
    return match ? match.quantity : null;
  }, [heldOnly, selection, positions]);

  // Total affiché, JAMAIS enregistré comme donnée indépendante : validateOperation le recalcule
  // côté serveur (gross = quantité × prix, net = gross + frais pour un achat).
  const qtyNumber = Number(quantity);
  const priceNumber = Number(unitPrice);
  const feesNumber = fees ? Number(fees) : 0;
  const total = Number.isFinite(qtyNumber) && Number.isFinite(priceNumber) && quantity !== "" && unitPrice !== ""
    ? qtyNumber * priceNumber + (Number.isFinite(feesNumber) ? feesNumber : 0)
    : null;

  const quoteDate = selection?.lastPriceAt ? new Date(selection.lastPriceAt) : null;
  const quoteDateLabel = quoteDate && !Number.isNaN(quoteDate.getTime()) ? quoteDate.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" }) : null;

  const assetReady = !needsAsset || selection !== null;
  const overSells = heldOnly && availableQuantity !== null && qtyNumber > availableQuantity + 1e-9;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (needsAsset && !selection) { setError("Sélectionnez un actif dans la liste avant d'enregistrer."); return; }
    if (overSells) { setError(`Vente impossible : ${qtyNumber} demandé(s) pour ${availableQuantity} détenu(s).`); return; }

    // Le montant payé en euros est une donnée HISTORIQUE : on en déduit le taux réellement subi,
    // au lieu de reconvertir plus tard au taux courant (ce qui réécrirait un coût passé).
    const nativeTotal = total;
    const paid = paidEur ? Number(paidEur) : null;
    const derivedRate = paid !== null && Number.isFinite(paid) && nativeTotal !== null && nativeTotal > 0
      ? paid / nativeTotal
      : null;

    const payload: Record<string, unknown> = {
      accountId, type, date,
      // L'identité n'est plus composée champ par champ : elle est transmise en bloc, et le serveur
      // la réécrit depuis la cotation qu'il a lui-même résolue.
      selection: needsAsset && selection ? selection : undefined,
      quantity: needsQtyPrice || needsQtyOnly ? Number(quantity) : undefined,
      unitPrice: needsQtyPrice ? Number(unitPrice) : undefined,
      netAmount: needsAmount ? Number(amount) : undefined,
      fees: fees ? Number(fees) : undefined,
      taxes: advanced && taxes ? Number(taxes) : undefined,
      currency: needsAsset ? undefined : accountCurrency,
      exchangeRate: derivedRate ?? undefined,
      note: note.trim() || undefined,
    };
    setSaving(true);
    const result = await onSubmit(payload);
    setSaving(false);
    if (!result.ok) { setError(result.error ?? "Enregistrement impossible."); return; }
    onSaved();
  }

  function confirmUnlisted() {
    const name = unlistedName.trim();
    if (!name) return;
    setSelection({
      assetId: null, listingId: null, isin: null, name, assetType: unlistedType, ticker: null,
      exchange: null, micCode: null, currency: accountCurrency, country: null,
      eodhdSymbol: null, yahooSymbol: null, lastPrice: null, lastPriceAt: null,
      peaEligible: null, origin: "catalog", confidence: "needs_review",
    });
    setUnlisted(false);
    setUnlistedName("");
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
              <span className="pea-field-label">Compte</span>
              <select value={accountId} onChange={(event) => { setAccountId(event.target.value); const next = accounts.find((item) => item.id === event.target.value); if (next) setAccountCurrency(next.currency); }}>
                {accounts.map((item) => <option key={item.id} value={item.id}>{item.name}{item.institution ? ` · ${item.institution}` : ""}</option>)}
              </select>
            </label>
          )}
          {restrictToAchat ? (
            <label className="pea-field">
              <span className="pea-field-label">Type d’opération</span>
              <input value="Achat" readOnly aria-readonly="true" />
            </label>
          ) : (
            <label className="pea-field">
              <span className="pea-field-label">Type d’opération</span>
              <select value={type} onChange={(event) => { setType(event.target.value as AccountOperationType); setSelection(null); setUnlisted(false); }}>
                {config.investCards.map((value) => <option key={value} value={value}>{OP_LABEL[value]}</option>)}
                {!config.investCards.includes("correction") && <option value="correction">Correction</option>}
                {/* En modification, le type d'origine reste proposé même s'il n'est pas dans les cartes. */}
                {isEditing && !config.investCards.includes(type) && type !== "correction" && <option value={type}>{OP_LABEL[type]}</option>}
              </select>
            </label>
          )}
          <label className="pea-field">
            <span className="pea-field-label">Date{type === "dividende" ? " de paiement" : ""}</span>
            <input type="date" value={date} max={todayISO()} onChange={(event) => setDate(event.target.value)} required />
          </label>

          {/* ÉTAPE 1 / ÉTAPE 2 — visibles dans la même modale, sans navigation. */}
          {needsAsset && (
            <ol className="asset-steps pea-field-wide" aria-label="Étapes de saisie">
              <li className={selection ? "is-done" : "is-current"}>
                <span className="asset-step-dot" aria-hidden="true">{selection ? "✓" : "1"}</span>Identifier l’actif
              </li>
              <li className={selection ? "is-current" : ""}>
                <span className="asset-step-dot" aria-hidden="true">2</span>Saisir l’opération
              </li>
            </ol>
          )}

          {needsAsset && !unlisted && (
            <AssetSearchField
              value={selection}
              onSelect={setSelection}
              accountId={accountId}
              restrictTo={heldOnly ? heldCandidates : null}
              label={heldOnly ? "Sélectionner une position détenue" : "Rechercher une action, un ETF ou un fonds"}
              onUnlisted={heldOnly ? undefined : () => setUnlisted(true)}
            />
          )}

          {needsAsset && unlisted && (
            <div className="pea-field pea-field-wide asset-unlisted">
              <b>Actif non coté</b>
              <p>Sa valorisation restera <b>manuelle</b> : aucune synchronisation automatique de cours ne sera proposée.</p>
              <div className="asset-unlisted-grid">
                <label className="pea-field"><span className="pea-field-label">Nom</span><input value={unlistedName} onChange={(event) => setUnlistedName(event.target.value)} placeholder="Parts de SCI familiale" /></label>
                <label className="pea-field">
                  <span className="pea-field-label">Type</span>
                  <select value={unlistedType} onChange={(event) => setUnlistedType(event.target.value as NormalizedAssetType)}>
                    {ASSET_TYPES.map((value) => <option key={value} value={value}>{CATALOG_TYPE_LABEL[value]}</option>)}
                  </select>
                </label>
              </div>
              <div className="asset-empty-actions">
                <button type="button" className="secondary-button" onClick={() => setUnlisted(false)}>Revenir à la recherche</button>
                <button type="button" className="primary-button" onClick={confirmUnlisted} disabled={!unlistedName.trim()}>Utiliser cet actif</button>
              </div>
            </div>
          )}

          {/* ÉTAPE 2 — n'apparaît qu'une fois l'identité verrouillée. */}
          {assetReady && (needsQtyPrice || needsQtyOnly) && (
            <label className="pea-field">
              <span className="pea-field-label">Quantité{needsQtyOnly ? " (signée)" : type === "vente" ? " vendue" : ""}</span>
              <input type="number" step="any" inputMode="decimal" value={quantity} onChange={(event) => setQuantity(event.target.value)} required={needsQtyPrice}
                max={heldOnly && availableQuantity !== null ? availableQuantity : undefined} />
              {heldOnly && availableQuantity !== null && (
                <small className="pea-field-hint">{availableQuantity} détenu(s) sur ce compte</small>
              )}
            </label>
          )}
          {assetReady && needsQtyPrice && (
            <label className="pea-field">
              <span className="pea-field-label">{isTransfer ? "Prix de revient repris" : type === "vente" ? "Prix de vente" : "Prix unitaire"}{currency !== "EUR" ? ` (${currency})` : ""}</span>
              <input type="number" step="any" min="0" inputMode="decimal" value={unitPrice} onChange={(event) => setUnitPrice(event.target.value)} required={!isTransfer} />
              {/* Aide FACULTATIVE : le prix reste celui de l'opération historique, jamais remplacé
                  d'office par le cours du jour. L'action est explicite et le champ reste modifiable. */}
              {selection?.lastPrice !== null && selection?.lastPrice !== undefined && quoteDateLabel && (
                <button type="button" className="asset-quote-hint" onClick={() => setUnitPrice(String(selection.lastPrice))}>
                  ↺ Utiliser le cours du {quoteDateLabel}
                </button>
              )}
            </label>
          )}
          {assetReady && needsAmount && (
            <label className="pea-field">
              <span className="pea-field-label">Montant{type === "dividende" ? " net" : ""}{currency !== "EUR" ? ` (${currency})` : ""}</span>
              <input type="number" step="any" min="0" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} required />
            </label>
          )}
          {assetReady && (needsQtyPrice || type === "frais") && (
            <label className="pea-field">
              <span className="pea-field-label">Frais</span>
              <input type="number" step="any" min="0" inputMode="decimal" value={fees} onChange={(event) => setFees(event.target.value)} />
            </label>
          )}
          {assetReady && needsQtyPrice && currency !== "EUR" && (
            <label className="pea-field">
              <span className="pea-field-label">Montant payé en EUR (facultatif)</span>
              <input type="number" step="any" min="0" inputMode="decimal" value={paidEur} onChange={(event) => setPaidEur(event.target.value)} />
              <small className="pea-field-hint">Conserve le coût réellement subi, sans reconversion au taux courant.</small>
            </label>
          )}

          {assetReady && total !== null && needsQtyPrice && (
            <div className="asset-total pea-field-wide">
              <div>
                <span>Montant total</span>
                <b>{money(total, currency)}</b>
              </div>
              <small>{quantity} × {money(priceNumber, currency)}{feesNumber ? ` + ${money(feesNumber, currency)}` : ""}</small>
            </div>
          )}

          {assetReady && (
            <details className="asset-more pea-field-wide" open={moreOpen} onToggle={(event) => setMoreOpen((event.currentTarget as HTMLDetailsElement).open)}>
              <summary>⚙ Options supplémentaires</summary>
              <div className="asset-more-body">
                {advanced && type === "dividende" && (
                  <label className="pea-field"><span className="pea-field-label">Retenue / taxes</span><input type="number" step="any" min="0" inputMode="decimal" value={taxes} onChange={(event) => setTaxes(event.target.value)} /></label>
                )}
                <label className="pea-field pea-field-wide">
                  <span className="pea-field-label">Note {type === "correction" ? "(motif obligatoire)" : "(facultatif)"}</span>
                  <input value={note} onChange={(event) => setNote(event.target.value)} required={type === "correction"} />
                </label>
              </div>
            </details>
          )}

          {error && <p className="pea-form-error" role="alert">{error}</p>}
          <div className="pea-form-actions">
            <button type="button" className="secondary-button" onClick={onClose}>Annuler</button>
            <button type="submit" className="primary-button" disabled={saving || !assetReady || overSells}>
              {saving ? "Enregistrement…" : isEditing ? "Enregistrer les modifications" : needsAsset ? "Ajouter l’opération" : "Enregistrer"}
            </button>
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
