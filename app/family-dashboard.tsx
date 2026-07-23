"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { initialTransactions, InvestmentModal, TransactionRecord, TransactionsView, type GiftSaveResult, type GiftSource, type TransactionShortcut } from "./transactions";
import { TransferRequest } from "./back-office";
import { Administration } from "./administration";
import { GiftPortfolio } from "./gift-portfolio";
import { AmatxiGifts } from "./amatxi-gifts";
import { Settings } from "./settings";
import { AdminMemberSettings } from "./settings-admin-member";
import { AdminUsers } from "./admin-users";
import { BitcoinInvestmentPage } from "./bitcoin-investments";
import { PeaInvestmentPage } from "./pea-investments";
import { CtoInvestmentPage } from "./cto-investments";
import { SouvenirsPage } from "./souvenirs";
import type { AccountOperation } from "../lib/portfolio-account";
import type { Viewer } from "../lib/auth-types";
import { supabaseBrowser } from "../lib/supabase-browser";
import { OnboardingFlow } from "./onboarding/onboarding-flow";
import { OnboardingChecklist } from "./onboarding/onboarding-checklist";
import { ContextualTip } from "./onboarding/contextual-tips";
import { loadOnboardingState } from "../lib/onboarding/onboarding-client";
import { onboardingCopy } from "../lib/onboarding/onboarding-copy";
import type { OnboardingState } from "../lib/onboarding/onboarding-types";
import { GIFT_HISTORY } from "../lib/gift-history";
import { FAMILY_MEMBERS, BIRTHDAY_LABEL_SHORT } from "../lib/family-roster";
import { useDialogA11y } from "./use-dialog-a11y";
import { NavIcon, PanelTitle } from "./dashboard-ui";
import {
  BOTTOM_NAV_ITEMS,
  INVESTMENT_VIEW_IDS,
  adminNavigation,
  familyNavigation,
  investmentGroupMeta,
  investmentSubNavigation,
  titleForView,
  type View,
  type NavIconId,
} from "../lib/navigation";

export { PanelTitle };

type FamilyGiftRecord = {
  member_name: string;
  occasion: string;
  gift_date: string;
  amount_eur: number;
  btc_amount: number;
  custody?: string;
  ledger_amount?: number | null;
  is_deleted?: boolean;
  source?: string | null;
  note?: string | null;
};
type FamilyMemberBalance = { name: string; btc: number; currentValueEur: number | null };
type LedgerQuote = { bitcoinEur?: number | null };
type PortfolioAccount = { id: string; name: string; institution?: string | null; accountType: string; currency: string; memberId?: string; memberName: string | null };
type PortfolioHolding = { account_id: string; asset_type?: string | null; name?: string | null; symbol?: string | null; isin?: string | null; quantity: number; average_cost: number | null; last_price: number | null; last_price_at?: string | null; currency: string };
type PortfolioOperation = AccountOperation;

function familyGiftKey(record: Pick<FamilyGiftRecord, "member_name" | "occasion" | "gift_date">) {
  return `${record.member_name}|${record.occasion}|${record.gift_date}`;
}

// `missing` is a placeholder count, not derived from real gift records \u2014 see audit \u00a719.
const MISSING_PLACEHOLDER: Record<string, number> = { Thibault: 5, Uhaina: 4, Paul: 4, Aurore: 4, Thomas: 5 };
const members = FAMILY_MEMBERS.map((member) => ({
  name: member.name,
  initials: member.initials,
  birthday: BIRTHDAY_LABEL_SHORT[member.name],
  birthdayDay: member.birthdayDay,
  birthdayMonth: member.birthdayMonth,
  missing: MISSING_PLACEHOLDER[member.name] ?? 0,
  color: member.color,
}));

const euro = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });
const euroCompact = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });

async function authenticatedFetch(url: string, init: RequestInit) {
  const { data } = await supabaseBrowser.auth.getSession();
  return fetch(url, {
    ...init,
    headers: {
      ...init.headers,
      ...(data.session ? { authorization: "Bearer " + data.session.access_token } : {}),
    },
  });
}

export function FamilyDashboard({ viewer, onSignOut }: { viewer: Viewer; onSignOut: () => void }) {
  // Restaure la section Bitcoin depuis l'URL (#bitcoin/<onglet>) au chargement : un
  // rafraîchissement ne renvoie plus systématiquement à l'accueil ni au Résumé.
  const [view, setView] = useState<View>(() => {
    if (typeof window === "undefined") return "famille";
    if (window.location.hash.startsWith("#bitcoin")) return "bitcoin";
    if (window.location.hash.startsWith("#pea")) return "investissements-pea";
    if (window.location.hash.startsWith("#cto")) return "investissements-comptetitres";
    return "famille";
  });
  const todayLabel = useMemo(() => new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date()).toUpperCase(), []);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalSource, setModalSource] = useState<GiftSource | undefined>(undefined);
  const [personalModalOpen, setPersonalModalOpen] = useState(false);
  const [toast, setToast] = useState("");
  function openGiftModal(source?: GiftSource) { setModalSource(source); setModalOpen(true); }
  function closeGiftModal() { setModalOpen(false); setModalSource(undefined); }
  const publishedVersion = process.env.NEXT_PUBLIC_APP_VERSION ?? "local";
  const [transactions] = useState<TransactionRecord[]>(initialTransactions);
  const [transactionsReloadKey, setTransactionsReloadKey] = useState(0);
  const [transferRequests, setTransferRequests] = useState<TransferRequest[]>([]);
  const [familyRecords, setFamilyRecords] = useState<FamilyGiftRecord[]>([]);
  const [portfolioAccounts, setPortfolioAccounts] = useState<PortfolioAccount[]>([]);
  const [portfolioHoldings, setPortfolioHoldings] = useState<PortfolioHolding[]>([]);
  const [portfolioOperations, setPortfolioOperations] = useState<PortfolioOperation[]>([]);
  const [bitcoinEur, setBitcoinEur] = useState<number | null>(null);
  const [familyMarketLoading, setFamilyMarketLoading] = useState(true);
  const [familyMember, setFamilyMember] = useState("Thibault");
  const [transactionShortcut, setTransactionShortcut] = useState<TransactionShortcut | null>(null);
  const [previewMember, setPreviewMember] = useState<string | null>(null);
  const isPreview = previewMember !== null;
  const [onboardingOverlay, setOnboardingOverlay] = useState<null | { mode: "tour" | "required"; state?: OnboardingState }>(null);
  const [checklistToken, setChecklistToken] = useState(0);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [quickSwitchOpen, setQuickSwitchOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const mobileMenuRef = useDialogA11y(mobileMenuOpen, () => setMobileMenuOpen(false));
  const effectiveViewer: Viewer = previewMember ? { ...viewer, name: previewMember, email: "preview@cap.family", role: "child" } : viewer;
  const canManageGifts = viewer.role === "admin" && !isPreview;
  // Un membre (hors admin et hors aperçu) enregistre lui-même ses achats Bitcoin
  // personnels ; l'identité et l'origine sont forcées côté serveur.
  const canRecordPersonalBtc = viewer.role !== "admin" && !isPreview;
  const [investmentsOpen, setInvestmentsOpen] = useState(true);
  const investmentsActive = INVESTMENT_VIEW_IDS.includes(view);
  const investmentsExpanded = investmentsActive || investmentsOpen;

  useEffect(() => {
    const controller = new AbortController();
    void authenticatedFetch("/api/transfer-requests", { signal: controller.signal })
      .then((response) => response.json())
      .then((result: { requests?: TransferRequest[] }) => setTransferRequests(result.requests ?? []))
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) console.error(error);
      });
    return () => controller.abort();
  }, []);

  const [familyReloadToken, setFamilyReloadToken] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    async function loadFamilyMarketSummary() {
      setFamilyMarketLoading(true);
      try {
        const [giftResponse, ledgerResponse, portfolioResponse] = await Promise.all([
          authenticatedFetch("/api/gifts", { signal: controller.signal }),
          authenticatedFetch("/api/ledger?priceOnly=1", { signal: controller.signal }),
          authenticatedFetch("/api/portfolio", { signal: controller.signal }),
        ]);
        const giftResult = await giftResponse.json() as { records?: FamilyGiftRecord[]; error?: string };
        if (!giftResponse.ok) throw new Error(giftResult.error ?? "Cadeaux indisponibles");
        setFamilyRecords((giftResult.records ?? []).map((record) => ({
          ...record,
          amount_eur: Number(record.amount_eur),
          btc_amount: Number(record.btc_amount),
          ledger_amount: record.ledger_amount === null || record.ledger_amount === undefined ? null : Number(record.ledger_amount),
          is_deleted: Boolean(record.is_deleted),
        })));
        if (ledgerResponse) {
          const ledgerResult = await ledgerResponse.json() as LedgerQuote;
          setBitcoinEur(ledgerResponse.ok && Number(ledgerResult.bitcoinEur) > 0 ? Number(ledgerResult.bitcoinEur) : null);
        } else {
          setBitcoinEur(null);
        }
        if (portfolioResponse.ok) {
          const portfolioResult = await portfolioResponse.json() as { accounts?: PortfolioAccount[]; holdings?: PortfolioHolding[]; operations?: PortfolioOperation[] };
          setPortfolioAccounts(portfolioResult.accounts ?? []);
          setPortfolioHoldings(portfolioResult.holdings ?? []);
          setPortfolioOperations(portfolioResult.operations ?? []);
        } else {
          setPortfolioAccounts([]);
          setPortfolioHoldings([]);
          setPortfolioOperations([]);
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) console.error(error);
      } finally {
        if (!controller.signal.aborted) setFamilyMarketLoading(false);
      }
    }
    void loadFamilyMarketSummary();
    return () => controller.abort();
  }, [viewer.role, familyReloadToken]);
  const familyGiftRecords = useMemo(() => {
    const storedByKey = new Map(familyRecords.map((record) => [familyGiftKey(record), record]));
    const historyKeys = new Set(GIFT_HISTORY.map((gift) => familyGiftKey({ member_name: gift.member, occasion: gift.occasion, gift_date: gift.giftDate })));
    const history = GIFT_HISTORY.flatMap((gift) => {
      const key = familyGiftKey({ member_name: gift.member, occasion: gift.occasion, gift_date: gift.giftDate });
      const stored = storedByKey.get(key);
      if (stored?.is_deleted) return [];
      return [stored ?? { member_name: gift.member, occasion: gift.occasion, gift_date: gift.giftDate, amount_eur: gift.amountEur, btc_amount: gift.btcAmount }];
    });
    const extras = familyRecords.filter((record) => !record.is_deleted && !historyKeys.has(familyGiftKey(record)));
    return [...history, ...extras];
  }, [familyRecords]);
  const memberBalances = useMemo<FamilyMemberBalance[]>(() => members.map((member) => {
    const btc = familyGiftRecords.filter((record) => record.member_name === member.name).reduce((sum, record) => { const ownedBtc = record.custody === "Ledger" && Number(record.ledger_amount) > 0 ? Number(record.ledger_amount) : Number(record.btc_amount); return sum + Math.max(0, ownedBtc || 0); }, 0);
    return { name: member.name, btc, currentValueEur: bitcoinEur && bitcoinEur > 0 ? btc * bitcoinEur : null };
  }), [bitcoinEur, familyGiftRecords]);
  const totalBtc = useMemo(() => memberBalances.reduce((sum, member) => sum + member.btc, 0), [memberBalances]);
  const totalBitcoinValueEur = bitcoinEur && bitcoinEur > 0 ? totalBtc * bitcoinEur : null;

  // Tableau de bord « vue utilisateur » — données réelles uniquement.
  // Bitcoin : cadeaux (gift_records + historique) × cours en direct.
  // PEA / compte-titres : comptes (financial_accounts) + positions (holdings) valorisées.
  // Admin hors aperçu → total famille ; membre ou aperçu → portefeuille du membre affiché.
  const homeData = useMemo<HomeData>(() => {
    const family = viewer.role === "admin" && !isPreview;
    const scoped = family ? familyGiftRecords : familyGiftRecords.filter((record) => record.member_name === effectiveViewer.name);
    const ownedBtc = (record: FamilyGiftRecord) => (record.custody === "Ledger" && Number(record.ledger_amount) > 0 ? Number(record.ledger_amount) : Number(record.btc_amount));
    const btc = scoped.reduce((sum, record) => sum + Math.max(0, ownedBtc(record) || 0), 0);
    const bitcoinCost = scoped.reduce((sum, record) => sum + Math.max(0, Number(record.amount_eur) || 0), 0);
    const bitcoinValueEur = bitcoinEur && bitcoinEur > 0 ? btc * bitcoinEur : null;

    // PEA & compte-titres : positions valorisées (quantité × dernier cours), limitées au
    // périmètre affiché (toute la famille pour l'admin, sinon le membre courant).
    const scopedAccounts = family ? portfolioAccounts : portfolioAccounts.filter((account) => account.memberName === effectiveViewer.name);
    const perAccount = new Map<string, { value: number; cost: number }>();
    for (const holding of portfolioHoldings) {
      const value = holding.quantity * (holding.last_price ?? 0);
      const cost = holding.quantity * (holding.average_cost ?? 0);
      const current = perAccount.get(holding.account_id) ?? { value: 0, cost: 0 };
      perAccount.set(holding.account_id, { value: current.value + value, cost: current.cost + cost });
    }
    const bucket = (type: string) => scopedAccounts.filter((account) => account.accountType === type).reduce((acc, account) => {
      const totals = perAccount.get(account.id) ?? { value: 0, cost: 0 };
      return { value: acc.value + totals.value, cost: acc.cost + totals.cost };
    }, { value: 0, cost: 0 });
    const pea = bucket("pea");
    const cto = bucket("securities");

    // Le Bitcoin n'entre dans le patrimoine que si son cours est connu (sinon on n'affiche
    // pas un total partiel trompeur). Chaque classe d'actif n'apparaît que si elle est > 0.
    const btcUnpriced = btc > 0 && bitcoinValueEur === null;
    const btcQty = btc > 0 ? `${btc.toFixed(8)} BTC` : undefined;
    const assets: { key: string; color: string; value: number; cost: number; qty?: string }[] = [];
    if ((bitcoinValueEur ?? 0) > 0) assets.push({ key: "Bitcoin", color: "#f0a63a", value: bitcoinValueEur as number, cost: bitcoinCost, qty: btcQty });
    if (pea.value > 0) assets.push({ key: "PEA", color: "#5a9bd4", value: pea.value, cost: pea.cost });
    if (cto.value > 0) assets.push({ key: "Compte-titres", color: "#3aa17e", value: cto.value, cost: cto.cost });
    const total = assets.reduce((sum, asset) => sum + asset.value, 0);

    const valueEur = btcUnpriced ? null : total;
    const repartition: HomeAsset[] = btcUnpriced
      ? [{ key: "Bitcoin", color: "#f0a63a", valueEur: null, pct: 100, qty: btcQty }]
      : total > 0
        ? assets.map((asset) => ({ key: asset.key, color: asset.color, valueEur: asset.value, pct: (asset.value / total) * 100, qty: asset.qty }))
        : [];
    const totalCost = bitcoinCost + pea.cost + cto.cost;
    const gainEur = valueEur === null ? null : valueEur - totalCost;
    const gainPct = gainEur === null || totalCost <= 0 ? null : (gainEur / totalCost) * 100;

    const now = new Date();
    const investedMonth = scoped.reduce((sum, record) => {
      const date = new Date(record.gift_date);
      return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() ? sum + (Number(record.amount_eur) || 0) : sum;
    }, 0);
    const dateFmt = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric" });
    const operations: HomeOperation[] = [...scoped]
      .sort((a, b) => new Date(b.gift_date).getTime() - new Date(a.gift_date).getTime())
      .slice(0, 4)
      .map((record) => ({
        icon: "gift",
        tone: "coral",
        title: `Cadeau — ${record.occasion}`,
        sub: family ? record.member_name : "Cadeau d’Amatxi",
        amount: `${(Number(record.btc_amount) || 0).toFixed(8)} BTC`,
        amountEur: euro.format(Number(record.amount_eur) || 0),
        date: dateFmt.format(new Date(record.gift_date)),
      }));
    const birthday = homeBirthdayInfo(effectiveViewer.name, !family);
    const hasAssets = btc > 0 || pea.value > 0 || cto.value > 0;
    return { btc, bitcoinValueEur, valueEur, gainEur, gainPct, investedMonth, operations, repartition, birthday, hasAssets };
  }, [familyGiftRecords, bitcoinEur, portfolioAccounts, portfolioHoldings, viewer.role, isPreview, effectiveViewer.name]);

  // Relance volontaire (visite, sans écriture) et reprise d'un parcours reporté (mode obligatoire).
  function replayOnboarding() { setOnboardingOverlay({ mode: "tour" }); }
  function resumeOnboarding() { void loadOnboardingState(viewer.id).then(({ state }) => setOnboardingOverlay({ mode: "required", state })); }
  function closeOnboardingOverlay() { setOnboardingOverlay(null); setChecklistToken((token) => token + 1); setFamilyReloadToken((token) => token + 1); }
  function changePreview(next: string | null) {
    setPreviewMember(next);
    setFamilyMember(next ?? familyMember);
    setView("famille");
  }

  function openFilteredTransactions(shortcut: Omit<TransactionShortcut, "requestId">) {
    setTransactionShortcut({ ...shortcut, requestId: Date.now() });
    setView("transactions");
  }

  function navigate(next: View) {
    if (next === "transactions") setTransactionShortcut(null);
    // En quittant Bitcoin, on efface le hash d'onglet pour ne pas y revenir au refresh.
    if (next !== "bitcoin" && typeof window !== "undefined" && window.location.hash.startsWith("#bitcoin")) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    setView(next);
  }

  function handleGiftSaved(result: GiftSaveResult) {
    closeGiftModal();
    setToast(result.message);
    window.setTimeout(() => setToast(""), 3200);
    setTransactionsReloadKey((key) => key + 1);
    setFamilyReloadToken((key) => key + 1);
  }

  function handlePersonalInvestmentSaved(result: GiftSaveResult) {
    setPersonalModalOpen(false);
    setToast(result.message);
    window.setTimeout(() => setToast(""), 3200);
    setTransactionsReloadKey((key) => key + 1);
    setFamilyReloadToken((key) => key + 1);
  }

  function requestTransfer(transaction: TransactionRecord) {
    const request: TransferRequest = {
      id: `request-${transaction.id}-${Date.now()}`,
      member: transaction.member,
      transactionId: transaction.id,
      btcAmount: transaction.quantity,
      requestedAt: "Aujourd’hui",
      status: "Nouvelle",
    };

    setTransferRequests((current) =>
      current.some((item) => item.transactionId === transaction.id && item.status !== "Transférée")
        ? current
        : [request, ...current],
    );
    setToast(`Demande de ${transaction.member} envoyée au back-office`);
    window.setTimeout(() => setToast(""), 3200);
    void authenticatedFetch("/api/transfer-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...request, requestedAt: new Date().toISOString() }),
    }).catch(() => undefined);
  }

  function updateRequestStatus(id: string, status: TransferRequest["status"]) {
    setTransferRequests((current) =>
      current.map((request) => (request.id === id ? { ...request, status } : request)),
    );
    void authenticatedFetch("/api/transfer-requests", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, status }),
    }).catch(() => undefined);
  }


  return (
    <main className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => setView("famille")} aria-label="Accueil LaBaJo & Co">
          <span className="brand-mark" aria-hidden="true">LB</span>
          <span><strong>LaBaJo &amp; Co</strong><small>L’école financière familiale</small></span>
        </button>

        <nav className="sidebar-nav" aria-label="Navigation principale">
          <div className="nav-group">
            <p className="nav-kicker" id="nav-membre-label">ESPACE FAMILLE</p>
            {familyNavigation.slice(0, 2).map((item) => (
              <button
                key={item.id}
                className={view === item.id ? "nav-item active" : "nav-item"}
                onClick={() => navigate(item.id)}
                aria-current={view === item.id ? "page" : undefined}
              >
                <span aria-hidden="true"><NavIcon id={item.icon} /></span>
                <span className="sr-only">{item.iconLabel} :</span>{item.label}
              </button>
            ))}
            <button
              type="button"
              className={investmentsActive ? "nav-item nav-item-parent active" : "nav-item nav-item-parent"}
              aria-expanded={investmentsExpanded}
              aria-controls="investissements-subnav"
              onClick={() => setInvestmentsOpen((open) => !open)}
            >
              <span aria-hidden="true"><NavIcon id={investmentGroupMeta.icon} /></span>
              <span className="sr-only">{investmentGroupMeta.iconLabel} :</span>{investmentGroupMeta.label}
              <b className="nav-chevron" aria-hidden="true">{investmentsExpanded ? "⌃" : "⌄"}</b>
            </button>
            {investmentsExpanded && (
              <div id="investissements-subnav" className="nav-subgroup">
                {investmentSubNavigation.map((item) => (
                  <button
                    key={item.id}
                    className={view === item.id ? "nav-subitem active" : "nav-subitem"}
                    onClick={() => navigate(item.id)}
                    aria-current={view === item.id ? "page" : undefined}
                  >
                    <span aria-hidden="true"><NavIcon id={item.icon} /></span>
                    <span className="sr-only">{item.iconLabel} :</span>{item.label}
                  </button>
                ))}
              </div>
            )}
            {familyNavigation.slice(2).map((item) => (
              <button
                key={item.id}
                className={view === item.id ? "nav-item active" : "nav-item"}
                onClick={() => navigate(item.id)}
                aria-current={view === item.id ? "page" : undefined}
              >
                <span aria-hidden="true"><NavIcon id={item.icon} /></span>
                <span className="sr-only">{item.iconLabel} :</span>{item.label}
              </button>
            ))}
          </div>
          {effectiveViewer.role === "admin" && <div className="nav-group nav-group-admin">
            <p className="nav-kicker" id="nav-admin-label">ADMINISTRATION</p>
            {adminNavigation.map((item) => (
              <button
                key={item.id}
                className={view === item.id ? "nav-item active" : "nav-item"}
                onClick={() => navigate(item.id)}
                aria-current={view === item.id ? "page" : undefined}
              >
                <span aria-hidden="true"><NavIcon id={item.icon} /></span>
                <span className="sr-only">{item.iconLabel} :</span>{item.label}
                {item.id === "transactions" && transferRequests.length > 0 && <em aria-label={`${transferRequests.length} demandes en attente`}>{transferRequests.length}</em>}
              </button>
            ))}
          </div>}
        </nav>

        <div className="profile-mini">
          <span className="avatar admin" aria-hidden="true">{(isPreview ? previewMember! : viewer.name).slice(0, 1).toUpperCase()}</span>
          <span><strong>{isPreview ? previewMember : viewer.name}</strong><small>{isPreview ? "Aperçu lecture seule" : viewer.role === "admin" ? "Administrateur" : viewer.email}</small></span>
          <button type="button" className="profile-mini-trigger" onClick={() => setProfileMenuOpen((open) => !open)} aria-haspopup="menu" aria-expanded={profileMenuOpen} aria-label="Menu du profil">⌄</button>
          {profileMenuOpen && <>
            <div className="profile-menu-backdrop" onClick={() => setProfileMenuOpen(false)} />
            <div className="profile-menu-popup" role="menu">
              <button type="button" role="menuitem" onClick={() => { setView("parametres"); setProfileMenuOpen(false); }}>Paramètres</button>
              <button type="button" role="menuitem" className="profile-menu-signout" onClick={() => { setProfileMenuOpen(false); onSignOut(); }}>Se déconnecter</button>
            </div>
          </>}
        </div>
      </aside>

      <section className="workspace" id="main-content" tabIndex={-1}>
        <header className="topbar">
          <div className="mobile-brand" aria-hidden="true">
            <span><strong>LaBaJo &amp; Co</strong><small>L’école financière familiale</small></span>
          </div>
          <button type="button" className="mobile-menu-trigger" onClick={() => setMobileMenuOpen(true)} aria-label="Ouvrir mon profil et les paramètres">
            <span className="mobile-menu-trigger-avatar" aria-hidden="true">{effectiveViewer.name.slice(0, 2).toUpperCase()}</span>
            <span className="mobile-menu-trigger-info"><strong>{isPreview ? previewMember : viewer.name}</strong><small>{isPreview ? "Aperçu" : viewer.role === "admin" ? "Admin" : "Membre"}</small></span>
            <b className="mobile-menu-trigger-chevron" aria-hidden="true">⌄</b>
          </button>
          <div className="topbar-heading">
            <p className="eyebrow" aria-label="Date du jour">{todayLabel}</p>
            <h1 className="topbar-title">{titleForView(view)}</h1>
          </div>
          <div className="topbar-chip-group">
            {viewer.role === "admin" && (
              <div className="mobile-quick-switch">
                <button type="button" className="mobile-quick-switch-trigger" onClick={() => setQuickSwitchOpen((open) => !open)} aria-expanded={quickSwitchOpen} aria-haspopup="listbox" aria-label="Changer la vue affichée">
                  <span>{isPreview ? previewMember : "Admin"}</span>
                  <b aria-hidden="true">⌄</b>
                </button>
                {quickSwitchOpen && <>
                  <div className="mobile-quick-switch-backdrop" onClick={() => setQuickSwitchOpen(false)} />
                  <div className="mobile-quick-switch-menu" role="listbox" aria-label="Choisir la vue affichée">
                    <button type="button" role="option" aria-selected={!isPreview} className={!isPreview ? "active" : ""} onClick={() => { changePreview(null); setQuickSwitchOpen(false); }}>Admin</button>
                    {members.map((member) => <button key={member.name} type="button" role="option" aria-selected={previewMember === member.name} className={previewMember === member.name ? "active" : ""} onClick={() => { changePreview(member.name); setQuickSwitchOpen(false); }}>{member.name}</button>)}
                  </div>
                </>}
              </div>
            )}
            <div className="mobile-btc-chip" role="status" aria-label={bitcoinEur ? `Cours du Bitcoin : 1 bitcoin égale ${euro.format(bitcoinEur)}` : "Cours du Bitcoin en cours de mise à jour"}>
              <span className="mobile-btc-mark" aria-hidden="true">₿</span>
              <span>{bitcoinEur ? euroCompact.format(bitcoinEur) : "Cours…"}</span>
            </div>
          </div>
          <div className="top-actions">
            {viewer.role === "admin" && <div className="view-mode-switch" role="group" aria-label="Choisir la vue affichée">
              <button type="button" className={!isPreview ? "active" : ""} onClick={() => changePreview(null)}>Vue admin</button>
              <label><span className="sr-only">Voir comme un membre</span><select value={previewMember ?? "Thibault"} onChange={(event) => changePreview(event.target.value)}>{members.map((member) => <option key={member.name} value={member.name}>Vue {member.name}</option>)}</select></label>
            </div>}
            <button className="icon-button" aria-label="Notifications - aucune nouvelle notification">
              <span aria-hidden="true">♢</span>
              <span className="sr-only">Notifications</span>
              <span className="notification-dot" aria-hidden="true" />
            </button>
            {viewer.role === "admin" && (isPreview ? <div className="preview-pill" role="status" aria-live="polite">Aperçu membre - lecture seule</div> : <button className="primary-button" aria-label="Ajouter une opération" onClick={() => openGiftModal()}><span aria-hidden="true"><b>+</b></span><span>Ajouter une opération</span></button>)}
          </div>
          <div className="topbar-desktop-actions">
            <button type="button" className="topbar-bell" aria-label={transferRequests.length > 0 ? `Notifications : ${transferRequests.length}` : "Notifications"}>
              <NavIcon id="bell" />
              {transferRequests.length > 0 && <em aria-hidden="true">{transferRequests.length}</em>}
            </button>
            <div className="topbar-user">
              {viewer.role === "admin" ? (
                <button type="button" className="topbar-user-pill" onClick={() => setQuickSwitchOpen((open) => !open)} aria-haspopup="listbox" aria-expanded={quickSwitchOpen} aria-label="Changer la vue affichée">
                  <span className="topbar-user-avatar" aria-hidden="true">{(isPreview ? previewMember! : viewer.name).slice(0, 1).toUpperCase()}</span>
                  <span className="topbar-user-name">{isPreview ? `Vue ${previewMember}` : "Vue admin"}</span>
                  <b className="topbar-user-caret" aria-hidden="true">⌄</b>
                </button>
              ) : (
                <span className="topbar-user-pill topbar-user-pill-static">
                  <span className="topbar-user-avatar" aria-hidden="true">{viewer.name.slice(0, 1).toUpperCase()}</span>
                  <span className="topbar-user-name">{viewer.name}</span>
                </span>
              )}
              {viewer.role === "admin" && quickSwitchOpen && (
                <>
                  <div className="topbar-user-backdrop" onClick={() => setQuickSwitchOpen(false)} />
                  <div className="topbar-user-menu" role="listbox" aria-label="Choisir la vue affichée">
                    <button type="button" role="option" aria-selected={!isPreview} className={!isPreview ? "active" : ""} onClick={() => { changePreview(null); setQuickSwitchOpen(false); }}>Vue admin</button>
                    {members.map((member) => <button key={member.name} type="button" role="option" aria-selected={previewMember === member.name} className={previewMember === member.name ? "active" : ""} onClick={() => { changePreview(member.name); setQuickSwitchOpen(false); }}>Vue {member.name}</button>)}
                  </div>
                </>
              )}
            </div>
          </div>
        </header>

        {isPreview && <div className="preview-banner" role="status" aria-live="polite">
          <span className="preview-banner-eye" aria-hidden="true">◐</span>
          <span>Aperçu de <strong>{previewMember}</strong> · lecture seule</span>
          <button type="button" onClick={() => changePreview(null)}>Quitter</button>
        </div>}

        {INVESTMENT_VIEW_IDS.includes(view) && (
          <nav className="invest-subnav" aria-label="Sections Investissements">
            {investmentSubNavigation.map((item) => (
              <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => navigate(item.id)} aria-current={view === item.id ? "page" : undefined}>
                {item.short ?? item.label}
              </button>
            ))}
          </nav>
        )}

        {view === "famille" && <Dashboard name={effectiveViewer.name} navigate={navigate} home={homeData} marketLoading={familyMarketLoading} checklist={(viewer.role === "adult" || viewer.role === "child") && !isPreview ? <OnboardingChecklist key={checklistToken} viewer={viewer} navigate={navigate} onResume={resumeOnboarding} /> : null} />}
        {view === "cadeaux-amatxi" && <AmatxiGifts viewer={effectiveViewer} previewReadOnly={isPreview} onOpenPortfolio={(member) => { setFamilyMember(member); setView("portefeuilles"); }} />}
        {view === "portefeuilles" && <Portfolios openModal={() => setModalOpen(true)} viewer={effectiveViewer} requests={transferRequests} selectedMember={familyMember} previewReadOnly={isPreview} onOpenTransactions={openFilteredTransactions} />}
        {view === "bitcoin" && (
          <>
            {canRecordPersonalBtc && <ContextualTip tipId="bitcoin" memberId={viewer.id} title={onboardingCopy.tips.bitcoin.title} body={onboardingCopy.tips.bitcoin.body} cta={onboardingCopy.tips.bitcoin.cta} />}
            <BitcoinInvestmentPage
            records={familyGiftRecords}
            bitcoinEur={bitcoinEur}
            totalBtc={totalBtc}
            totalBitcoinValueEur={totalBitcoinValueEur}
            marketLoading={familyMarketLoading}
            memberBalances={memberBalances}
            transferRequests={transferRequests}
            transactions={effectiveViewer.role === "admin" ? transactions : transactions.filter((transaction) => transaction.member === effectiveViewer.name)}
            transactionShortcut={transactionShortcut}
            transactionsReloadKey={transactionsReloadKey}
            viewer={effectiveViewer}
            isPreview={isPreview}
            canManageGifts={canManageGifts}
            canRecordPersonalBtc={canRecordPersonalBtc}
            openModal={(source) => openGiftModal(source)}
            openPersonalModal={() => setPersonalModalOpen(true)}
            onOpenMemberDetail={(member) => { setFamilyMember(member); setView("portefeuilles"); }}
            onTransferRequest={isPreview ? () => setToast("Apercu : aucune demande n est envoyee.") : requestTransfer}
            onRequestStatus={updateRequestStatus}
            onOpenTransactions={openFilteredTransactions}
          />
          </>
        )}
        {view === "transactions" && <TransactionsView transactions={effectiveViewer.role === "admin" ? transactions : transactions.filter((transaction) => transaction.member === effectiveViewer.name)} isAdmin={effectiveViewer.role === "admin"} viewerName={effectiveViewer.name} shortcut={transactionShortcut} reloadKey={transactionsReloadKey} onAdd={() => canManageGifts ? setModalOpen(true) : setToast(isPreview ? "Aperçu : aucune modification n’est autorisée." : "Seul l’administrateur peut ajouter une opération.")} onTransferRequest={isPreview ? () => setToast("Apercu : aucune demande n est envoyee.") : requestTransfer} onOpenPortfolio={(member) => { setFamilyMember(member); setView("portefeuilles"); }} />}
        {view === "investissements-pea" && (
          <>
            {canRecordPersonalBtc && <ContextualTip tipId="pea" memberId={viewer.id} title={onboardingCopy.tips.pea.title} body={onboardingCopy.tips.pea.body} cta={onboardingCopy.tips.pea.cta} />}
            <PeaInvestmentPage
            accounts={portfolioAccounts}
            holdings={portfolioHoldings}
            operations={portfolioOperations}
            marketLoading={familyMarketLoading}
            viewer={effectiveViewer}
            isPreview={isPreview}
            canManage={canManageGifts}
            onReload={() => setFamilyReloadToken((token) => token + 1)}
            onConfigure={() => setView("administration-globale")}
          />
          </>
        )}
        {view === "investissements-comptetitres" && (
          <>
            {canRecordPersonalBtc && <ContextualTip tipId="cto" memberId={viewer.id} title={onboardingCopy.tips.cto.title} body={onboardingCopy.tips.cto.body} cta={onboardingCopy.tips.cto.cta} />}
            <CtoInvestmentPage
              accounts={portfolioAccounts}
              holdings={portfolioHoldings}
              operations={portfolioOperations}
              marketLoading={familyMarketLoading}
              viewer={effectiveViewer}
              isPreview={isPreview}
              canManage={canManageGifts}
              onReload={() => setFamilyReloadToken((token) => token + 1)}
              onConfigure={() => setView("administration-globale")}
            />
          </>
        )}
        {view === "investissements-suggestions" && <ComingSoon eyebrow="INVESTISSEMENTS" title="Suggestions mensuelles" description="Cette section sera connectée aux données existantes. Un futur outil de recommandation d’investissement mensuel (répartition PEA & titres) sera piloté depuis cet écran." />}
        {view === "investissements-historique" && <ComingSoon eyebrow="INVESTISSEMENTS" title="Historique" description="Cette section sera connectée aux données existantes. L’historique consolidé des opérations d’investissement (Bitcoin, PEA, compte-titres) arrivera dans une prochaine étape." />}
        {view === "videos" && <>{canRecordPersonalBtc && <ContextualTip tipId="videos" memberId={viewer.id} title={onboardingCopy.tips.videos.title} body={onboardingCopy.tips.videos.body} cta={onboardingCopy.tips.videos.cta} />}<SouvenirsPage viewer={effectiveViewer} isPreview={isPreview} onOpenGiftMember={(member) => { setFamilyMember(member); setView("cadeaux-amatxi"); }} /></>}
        {view === "famille-roster" && <FamilyRoster memberBalances={memberBalances} onOpenMember={(member) => { setFamilyMember(member); setView("portefeuilles"); }} />}
        {view === "famille-acces" && effectiveViewer.role === "admin" && <AdminUsers />}
        {view === "administration-suggestions" && effectiveViewer.role === "admin" && <ComingSoon eyebrow="ADMINISTRATION" title="Suggestions" description="Cette section sera connectée aux données existantes. Un futur outil de création et de suivi des suggestions mensuelles (répartition PEA & titres) sera piloté depuis cet écran." />}
        {view === "administration-globale" && effectiveViewer.role === "admin" && <Administration viewer={effectiveViewer} requests={transferRequests} onRequestStatus={updateRequestStatus} />}
        {view === "apprendre" && <Learn />}
        {view === "parametres" && (isPreview ? <AdminMemberSettings memberName={previewMember!} onExit={() => { setPreviewMember(null); setView("famille"); }} onNavigate={navigate} /> : <Settings viewer={viewer} onSignOut={onSignOut} publishedVersion={publishedVersion} onReplayOnboarding={replayOnboarding} onResumeOnboarding={resumeOnboarding} onNavigate={navigate} />)}
      </section>

      <nav className="mobile-nav" aria-label="Navigation mobile">
        {BOTTOM_NAV_ITEMS.map((item) => {
          const active = item.groupIds ? item.groupIds.includes(view) : view === item.id;
          return (
            <button key={item.id} className={active ? "active" : ""} onClick={() => navigate(item.id)} aria-current={active ? "page" : undefined}>
              <span aria-hidden="true"><NavIcon id={item.icon} /></span><small>{item.short}</small>
            </button>
          );
        })}
      </nav>

      <div className={mobileMenuOpen ? "mobile-menu-backdrop open" : "mobile-menu-backdrop"} onMouseDown={(event) => event.target === event.currentTarget && setMobileMenuOpen(false)} />
      <aside ref={mobileMenuRef} className={mobileMenuOpen ? "mobile-menu-drawer open" : "mobile-menu-drawer"} role="dialog" aria-modal="true" aria-label="Profil et paramètres" aria-hidden={!mobileMenuOpen} tabIndex={-1}>
        <div className="mobile-menu-head">
          <span>MON ESPACE</span>
          <button type="button" className="mobile-menu-close" onClick={() => setMobileMenuOpen(false)} aria-label="Fermer le menu">×</button>
        </div>
        <div className="mobile-menu-profile">
          <span className="avatar admin" aria-hidden="true">{effectiveViewer.name.slice(0, 2).toUpperCase()}</span>
          <span><strong>{effectiveViewer.name}</strong><small>{isPreview ? "Aperçu lecture seule" : effectiveViewer.role === "admin" ? "Administrateur" : effectiveViewer.email}</small></span>
        </div>
        {viewer.role === "admin" && (
          <div className="mobile-menu-section">
            <p>Voir l’app comme</p>
            <div className="mobile-view-chips" role="group" aria-label="Choisir la vue affichée">
              <button type="button" className={!isPreview ? "active" : ""} aria-pressed={!isPreview} onClick={() => { changePreview(null); setMobileMenuOpen(false); }}>Admin</button>
              {members.map((member) => <button key={member.name} type="button" className={previewMember === member.name ? "active" : ""} aria-pressed={previewMember === member.name} onClick={() => { changePreview(member.name); setMobileMenuOpen(false); }}>{member.name}</button>)}
            </div>
          </div>
        )}
        {isPreview ? (
          <div className="mobile-menu-section">
            <button type="button" className="mobile-menu-signout" onClick={() => { changePreview(null); setMobileMenuOpen(false); }}>Quitter l’aperçu</button>
          </div>
        ) : (
          <>
            <div className="mobile-menu-section">
              <p>Espace famille</p>
              <button type="button" className="mobile-menu-link" onClick={() => { setView("cadeaux-amatxi"); setMobileMenuOpen(false); }}><span className="mobile-menu-link-content"><span aria-hidden="true"><NavIcon id="gift" /></span><span>Cadeaux d’Amatxi</span></span><span>›</span></button>
              <button type="button" className="mobile-menu-link" onClick={() => { setView("famille-roster"); setMobileMenuOpen(false); }}><span className="mobile-menu-link-content"><span aria-hidden="true"><NavIcon id="users" /></span><span>Famille</span></span><span>›</span></button>
            </div>
            <div className="mobile-menu-section">
              <p>Réglages</p>
              <button type="button" className="mobile-menu-link" onClick={() => { setView("parametres"); setMobileMenuOpen(false); }}><span className="mobile-menu-link-content"><span aria-hidden="true"><NavIcon id="settings" /></span><span>Paramètres</span></span><span>›</span></button>
            </div>
            {viewer.role === "admin" && (
              <div className="mobile-menu-section">
                <p>Administration</p>
                <button type="button" className="mobile-menu-link" onClick={() => { setView("transactions"); setMobileMenuOpen(false); }}><span className="mobile-menu-link-content"><span aria-hidden="true"><NavIcon id="list-checks" /></span><span>Opérations</span></span>{transferRequests.length > 0 ? <em>{transferRequests.length}</em> : <span>›</span>}</button>
                <button type="button" className="mobile-menu-link" onClick={() => { setView("famille-acces"); setMobileMenuOpen(false); }}><span className="mobile-menu-link-content"><span aria-hidden="true"><NavIcon id="users" /></span><span>Famille &amp; accès</span></span><span>›</span></button>
                <button type="button" className="mobile-menu-link" onClick={() => { setView("administration-suggestions"); setMobileMenuOpen(false); }}><span className="mobile-menu-link-content"><span aria-hidden="true"><NavIcon id="star" /></span><span>Suggestions</span></span><span>›</span></button>
                <button type="button" className="mobile-menu-link" onClick={() => { setView("administration-globale"); setMobileMenuOpen(false); }}><span className="mobile-menu-link-content"><span aria-hidden="true"><NavIcon id="shield-check" /></span><span>Administration</span></span><span>›</span></button>
              </div>
            )}
            <div className="mobile-menu-section">
              {viewer.role !== "admin" && <button type="button" className="mobile-menu-link" onClick={() => { replayOnboarding(); setMobileMenuOpen(false); }}><span>Revoir les premiers pas</span><span>›</span></button>}
              <button type="button" className="mobile-menu-signout" onClick={() => { setMobileMenuOpen(false); onSignOut(); }}>Se déconnecter</button>
            </div>
          </>
        )}
      </aside>

      {onboardingOverlay && !isPreview && <OnboardingFlow viewer={viewer} mode={onboardingOverlay.mode} initialState={onboardingOverlay.state} onDone={closeOnboardingOverlay} onDefer={closeOnboardingOverlay} onExitTour={closeOnboardingOverlay} />}
      {modalOpen && canManageGifts && <InvestmentModal defaultMember={familyMember} defaultSource={modalSource} onClose={closeGiftModal} onSaved={handleGiftSaved} />}
      {personalModalOpen && canRecordPersonalBtc && <InvestmentModal personalMode memberInvestor={effectiveViewer.name} onClose={() => setPersonalModalOpen(false)} onSaved={handlePersonalInvestmentSaved} />}
      {toast && <div className="toast" role="status">✓ {toast}</div>}
    </main>
  );
}

type HomeOperation = { icon: NavIconId; tone: string; title: string; sub: string; amount: string; amountEur: string; date: string };
type HomeAsset = { key: string; color: string; valueEur: number | null; pct: number; qty?: string };
type HomeBirthday = { title: string; message: string; reminder: string };
type HomeData = {
  btc: number;
  bitcoinValueEur: number | null;
  valueEur: number | null;
  gainEur: number | null;
  gainPct: number | null;
  investedMonth: number;
  operations: HomeOperation[];
  repartition: HomeAsset[];
  birthday: HomeBirthday;
  hasAssets: boolean;
};

// Prochaine occurrence d'une date anniversaire (mois/jour) à partir d'aujourd'hui.
function nextDateFor(month: number, day: number, today = new Date()) {
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const date = new Date(today.getFullYear(), month - 1, day);
  if (date < todayStart) date.setFullYear(today.getFullYear() + 1);
  return date;
}

// Bandeau anniversaire personnalisé :
// - membre : son PROPRE prochain cadeau (anniversaire ou Noël) + un simple rappel de
//   l'anniversaire d'un autre membre, sans jamais évoquer de cadeau qui ne lui est pas destiné ;
// - admin : le prochain anniversaire de la famille, présenté comme un cadeau à préparer.
function homeBirthdayInfo(viewerName: string, isMember: boolean): HomeBirthday {
  const longFmt = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric" });
  const shortFmt = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long" });
  const christmas = nextDateFor(12, 25);
  if (isMember) {
    const me = members.find((member) => member.name === viewerName);
    const myBirthday = me ? nextDateFor(me.birthdayMonth, me.birthdayDay) : christmas;
    const gift = myBirthday.getTime() <= christmas.getTime()
      ? { date: myBirthday, label: `Ton anniversaire : ${longFmt.format(myBirthday)}` }
      : { date: christmas, label: `Prochain cadeau : Noël, le ${longFmt.format(christmas)}` };
    const other = members
      .filter((member) => member.name !== viewerName)
      .map((member) => ({ name: member.name, date: nextDateFor(member.birthdayMonth, member.birthdayDay) }))
      .sort((a, b) => a.date.getTime() - b.date.getTime())[0];
    return {
      title: gift.label,
      message: "Un nouveau cadeau d’Amatxi arrive bientôt 🎉",
      reminder: other ? `Pense aussi à l’anniversaire de ${other.name}, le ${shortFmt.format(other.date)}` : "",
    };
  }
  const fam = members
    .map((member) => ({ name: member.name, date: nextDateFor(member.birthdayMonth, member.birthdayDay) }))
    .sort((a, b) => a.date.getTime() - b.date.getTime())[0];
  return {
    title: `Prochain anniversaire : ${fam.name}, le ${longFmt.format(fam.date)}`,
    message: "Un cadeau d’Amatxi est à préparer 🎉",
    reminder: "",
  };
}

// Construit un conic-gradient réellement dérivé des données (aucune valeur figée).
function homeDonutGradient(assets: HomeAsset[]): string {
  if (assets.length === 0) return "conic-gradient(#e9eeec 0 100%)";
  const gap = assets.length > 1 ? 0.7 : 0;
  let acc = 0;
  const stops: string[] = [];
  assets.forEach((asset, index) => {
    const start = acc;
    const end = acc + asset.pct;
    stops.push(`${asset.color} ${start}% ${Math.max(start, end - gap)}%`);
    if (gap && index < assets.length - 1) stops.push(`#fff ${end - gap}% ${end}%`);
    acc = end;
  });
  return `conic-gradient(${stops.join(",")})`;
}

// Tableau de bord « vue utilisateur » — 100 % branché sur les données réelles.
// Seul le Bitcoin existe aujourd'hui (cadeaux réels + cours en direct) ; le PEA et le
// compte-titres n'apparaissent que lorsque des comptes (public.financial_accounts) et des
// positions (public.holdings) sont réellement saisis dans Supabase. Aucune donnée fictive.
function Dashboard({ name, navigate, home, marketLoading, checklist }: { name: string; navigate: (view: View) => void; home: HomeData; marketLoading: boolean; checklist?: ReactNode }) {
  const valueLabel = home.valueEur !== null ? euro.format(home.valueEur) : marketLoading ? "Mise à jour…" : "Valeur indisponible";
  const donutLabel = home.repartition.map((asset) => `${asset.key} ${asset.pct.toFixed(0)} %`).join(", ");
  const showGain = home.gainEur !== null && home.gainPct !== null;
  const gainPositive = (home.gainEur ?? 0) >= 0;
  const gainText = showGain
    ? `${gainPositive ? "+" : "−"}${euro.format(Math.abs(home.gainEur as number))} (${gainPositive ? "+" : "−"}${Math.abs(home.gainPct as number).toFixed(1).replace(".", ",")} %)`
    : "";
  return (
    <div className="content-grid dashboard-home">
      <section className="home-hero">
        <div className="home-hero-scene" aria-hidden="true" />
        <div className="home-hero-copy">
          <h2 className="home-hero-title">Bonjour {name} <span className="home-hero-wave" aria-hidden="true">👋</span></h2>
          <p className="home-hero-sub">Toute votre épargne et vos investissements<br />au même endroit.</p>
        </div>
        <div className="home-kpis">
          <article className="home-kpi">
            <span className="home-kpi-icon mint" aria-hidden="true"><NavIcon id="sprout" /></span>
            <div className="home-kpi-body">
              <p>PATRIMOINE TOTAL</p>
              <strong>{valueLabel}</strong>
              {showGain && <small className={gainPositive ? "home-kpi-gain" : "home-kpi-gain neg"}>{gainText}</small>}
              <small className="home-kpi-note">Depuis l’origine</small>
            </div>
          </article>
          <article className="home-kpi">
            <span className="home-kpi-icon gold" aria-hidden="true"><NavIcon id="bitcoin" /></span>
            <div className="home-kpi-body">
              <p>BITCOIN TOTAL</p>
              <strong>{home.btc.toFixed(8)} BTC</strong>
              <small className="home-kpi-note">{home.bitcoinValueEur !== null ? `≈ ${euro.format(home.bitcoinValueEur)}` : marketLoading ? "Cours…" : "Cours indisponible"}</small>
            </div>
          </article>
          <article className="home-kpi">
            <span className="home-kpi-icon mint" aria-hidden="true"><NavIcon id="trending-up" /></span>
            <div className="home-kpi-body">
              <p>INVESTI CE MOIS</p>
              <strong>{euro.format(home.investedMonth)}</strong>
              <small className="home-kpi-note">Bitcoin</small>
            </div>
          </article>
        </div>
      </section>

      <div className="home-birthday" role="status">
        <span className="home-birthday-icon" aria-hidden="true"><NavIcon id="gift" /></span>
        <div className="home-birthday-text">
          <strong>{home.birthday.title}</strong>
          <p>{home.birthday.message}</p>
          {home.birthday.reminder && <span className="home-birthday-reminder"><NavIcon id="calendar" /> {home.birthday.reminder}</span>}
        </div>
        <button type="button" className="home-birthday-cta" onClick={() => navigate("cadeaux-amatxi")}>Voir mes cadeaux →</button>
      </div>

      {checklist && <div className="home-row">{checklist}</div>}

      <div className="home-row home-row-split">
        <section className="panel home-card home-repartition">
          <h3 className="home-card-kicker">RÉPARTITION DE VOTRE PATRIMOINE</h3>
          {home.hasAssets ? (
            <>
              <div className="home-repartition-body">
                <div className="home-donut" role="img" aria-label={`Répartition du patrimoine : ${donutLabel}`} style={{ background: homeDonutGradient(home.repartition) }}>
                  <div className="home-donut-center"><strong>{home.valueEur !== null ? euro.format(home.valueEur) : "—"}</strong><small>Total</small></div>
                </div>
                <ul className="home-legend">
                  {home.repartition.map((asset) => (
                    <li key={asset.key}>
                      <span className="home-legend-dot" aria-hidden="true" style={{ background: asset.color }} />
                      <span className="home-legend-name">{asset.key}</span>
                      <span className="home-legend-val">
                        {asset.valueEur !== null ? `${euro.format(asset.valueEur)} (${asset.pct.toFixed(0)} %)` : `${asset.pct.toFixed(0)} %`}
                        {asset.qty && <small className="home-legend-qty"> · {asset.qty}</small>}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              <button type="button" className="home-card-link" onClick={() => navigate("bitcoin")}>Voir le détail de mes investissements →</button>
            </>
          ) : (
            <div className="home-empty">
              <p>Aucun investissement pour le moment.</p>
              <span>Vos investissements (Bitcoin, PEA, compte-titres) apparaîtront ici dès leur saisie.</span>
            </div>
          )}
        </section>

        <section className="panel home-card home-operations">
          <h3 className="home-card-kicker">DERNIÈRES OPÉRATIONS</h3>
          {home.operations.length > 0 ? (
            <>
              <ul className="home-ops">
                {home.operations.map((op, index) => (
                  <li key={op.title + op.date + index}>
                    <span className={`home-ops-icon ${op.tone}`} aria-hidden="true"><NavIcon id={op.icon} /></span>
                    <div className="home-ops-info"><strong>{op.title}</strong><small>{op.sub}</small></div>
                    <div className="home-ops-meta"><b>{op.amount}</b><small>{op.amountEur} · {op.date}</small></div>
                  </li>
                ))}
              </ul>
              <button type="button" className="home-card-link" onClick={() => navigate("bitcoin")}>Voir toutes les opérations →</button>
            </>
          ) : (
            <div className="home-empty">
              <p>Aucune opération récente.</p>
              <span>Les cadeaux et achats Bitcoin s’afficheront ici.</span>
            </div>
          )}
        </section>
      </div>

      <div className="home-row home-row-split home-row-lower">
        <section className="panel home-card home-conseil">
          <span className="home-conseil-icon" aria-hidden="true"><NavIcon id="sprout" /></span>
          <div className="home-conseil-body">
            <h3>Conseil du mois</h3>
            <p>Investir régulièrement, même de petits montants, est la clé pour construire votre avenir.</p>
            <button type="button" className="home-card-link" onClick={() => navigate("apprendre")}>Voir tous les conseils →</button>
          </div>
        </section>

        <section className="panel home-card home-objectif">
          <div className="home-objectif-head">
            <h3>Objectif personnel</h3>
            <p>Constituer votre épargne pour vos projets futurs.</p>
          </div>
          <div className="home-empty home-objectif-empty">
            <p>Aucun objectif défini pour le moment.</p>
            <span>Un objectif d’épargne pourra être ajouté ici pour suivre votre progression.</span>
          </div>
        </section>
      </div>
    </div>
  );
}

function Portfolios({ viewer, requests, selectedMember, previewReadOnly, onOpenTransactions }: { openModal: () => void; viewer: Viewer; requests: TransferRequest[]; selectedMember: string; previewReadOnly: boolean; onOpenTransactions: (shortcut: Omit<TransactionShortcut, "requestId">) => void }) {
  return <GiftPortfolio viewer={viewer} requests={requests} selectedMember={selectedMember} previewReadOnly={previewReadOnly} onOpenTransactions={onOpenTransactions} />;
}

function Learn() {
  const lessons = [
    { level: "LES BASES", title: "Pourquoi investir tôt ?", text: "Le temps et les intérêts composés sont les deux meilleurs alliés d’un jeune investisseur.", icon: "↗", color: "navy" },
    { level: "BITCOIN", title: "Ledger, Binance : qui garde quoi ?", text: "Comprendre la différence entre une plateforme et un portefeuille dont on contrôle les clés.", icon: "₿", color: "amber" },
    { level: "BOURSE", title: "Un ETF en 5 minutes", text: "Acheter en une fois un panier diversifié d’entreprises, avec des frais généralement réduits.", icon: "▥", color: "teal" },
    { level: "SÉCURITÉ", title: "Les 24 mots ne se partagent jamais", text: "L’adresse publique se partage ; la phrase de récupération et la clé privée restent secrètes.", icon: "⌾", color: "coral" },
  ];
  return <div className="page-stack"><section className="learn-head"><span className="soft-pill">BIBLIOTHÈQUE FAMILIALE</span><h2>Apprendre juste ce qu’il faut,<br />au bon moment.</h2><p>Des explications courtes, reliées à une vraie action dans le portefeuille.</p></section><section className="lesson-grid">{lessons.map((lesson, i) => <article className="lesson-card" key={lesson.title}><div className={`lesson-icon ${lesson.color}`}>{lesson.icon}</div><span>{lesson.level} · {i + 4} MIN</span><h3>{lesson.title}</h3><p>{lesson.text}</p><button>Commencer la leçon →</button></article>)}</section></div>;
}


function ComingSoon({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return (
    <div className="page-stack">
      <section className="panel coming-soon-panel">
        <span className="soft-pill">{eyebrow}</span>
        <h2>{title}</h2>
        <p>{description}</p>
        <span className="coming-soon-badge">Bientôt disponible</span>
      </section>
    </div>
  );
}

function FamilyRoster({ memberBalances, onOpenMember }: { memberBalances: FamilyMemberBalance[]; onOpenMember: (member: string) => void }) {
  return (
    <div className="page-stack">
      <section className="learn-head">
        <span className="soft-pill">ESPACE FAMILLE</span>
        <h2>La famille, en un coup d’œil.</h2>
        <p>Anniversaires et valeur Bitcoin actuelle de chaque membre.</p>
      </section>
      <section className="panel family-panel">
        <div className="member-grid">
          {members.map((member) => {
            const balance = memberBalances.find((item) => item.name === member.name);
            const btc = balance?.btc ?? 0;
            const currentValueEur = balance?.currentValueEur ?? null;
            return (
              <button className="member-card member-card-button" key={member.name} onClick={() => onOpenMember(member.name)} aria-label={`Voir le portefeuille et les transactions de ${member.name}`}>
                <div className="member-top"><span className={`avatar ${member.color}`}>{member.initials}</span></div>
                <h3>{member.name}</h3><p>Anniversaire · {member.birthday}</p>
                <div className="member-value"><strong>{currentValueEur === null ? "—" : euro.format(currentValueEur)}</strong><small>{currentValueEur === null ? "Cours BTC indisponible" : "valeur Bitcoin actuelle"}</small></div>
                <footer><span>{btc.toFixed(8)} BTC attribués</span></footer>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}


