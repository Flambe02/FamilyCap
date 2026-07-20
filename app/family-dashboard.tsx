"use client";

import { useEffect, useMemo, useState, type ReactElement } from "react";
import { initialTransactions, InvestmentModal, TransactionRecord, TransactionsView, type GiftSaveResult, type TransactionShortcut } from "./transactions";
import { TransferRequest } from "./back-office";
import { Administration } from "./administration";
import { GiftPortfolio } from "./gift-portfolio";
import { Settings, PreviewSettings } from "./settings";
import { Indicators } from "./indicators";
import type { Viewer } from "../lib/auth-types";
import { supabaseBrowser } from "../lib/supabase-browser";
import { MemberOnboarding } from "./member-onboarding";
import { GIFT_HISTORY } from "../lib/gift-history";
import { FAMILY_MEMBERS, BIRTHDAY_LABEL_SHORT } from "../lib/family-roster";
import { useDialogA11y } from "./use-dialog-a11y";

type View = "famille" | "portefeuilles" | "transactions" | "indicateurs" | "comptes" | "videos" | "famille-roster" | "backoffice" | "suggestions" | "administration-globale" | "apprendre" | "parametres";

type FamilyGiftRecord = {
  member_name: string;
  occasion: string;
  gift_date: string;
  amount_eur: number;
  btc_amount: number;
  custody?: string;
  ledger_amount?: number | null;
  is_deleted?: boolean;
};
type FamilyMemberBalance = { name: string; btc: number; currentValueEur: number | null };
type LedgerQuote = { bitcoinEur?: number | null };

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

type FamilyCalendarEvent = { kind: "birthday" | "christmas"; name?: string; day: number; month: number; date: Date };

function nextFamilyCalendarEvents(today = new Date()) {
  const year = today.getFullYear();
  const todayStart = new Date(year, today.getMonth(), today.getDate());
  const events = members.map<FamilyCalendarEvent>((member) => {
    const date = new Date(year, member.birthdayMonth - 1, member.birthdayDay);
    if (date < todayStart) date.setFullYear(year + 1);
    return { kind: "birthday", name: member.name, day: member.birthdayDay, month: member.birthdayMonth, date };
  });
  const christmas = new Date(year, 11, 25);
  if (christmas < todayStart) christmas.setFullYear(year + 1);
  events.push({ kind: "christmas", day: 25, month: 12, date: christmas });
  const first = events.sort((a, b) => a.date.getTime() - b.date.getTime())[0];
  return events.filter((event) => event.date.getFullYear() === first.date.getFullYear() && event.date.getMonth() === first.date.getMonth()).sort((a, b) => a.date.getTime() - b.date.getTime());
}

function familyCalendarLabel(events: FamilyCalendarEvent[]) {
  const birthdays = events.filter((event) => event.kind === "birthday");
  const christmas = events.find((event) => event.kind === "christmas");
  const dateLabel = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric" }).format(events[0].date);
  const birthdayLabel = birthdays.length === 1
    ? "Prochain anniversaire de " + birthdays[0].name + ": " + birthdays[0].day + " " + dateLabel
    : "Prochains anniversaires de " + birthdays.slice(0, -1).map((event) => event.name).join(", ") + " et " + birthdays.at(-1)?.name + ": " + birthdays.map((event) => event.day).join(" et ") + " " + dateLabel;
  if (!christmas) return birthdayLabel;
  return birthdays.length > 0 ? birthdayLabel + " + No\u00ebl le 25 d\u00e9cembre" : "Prochain \u00e9v\u00e8nement : No\u00ebl le 25 " + dateLabel;
}
type NavIconId = "house" | "gift" | "bitcoin" | "trending-up" | "landmark" | "square-play" | "users" | "book-open" | "settings" | "list-checks" | "star" | "shield-check" | "calendar";

const navItems: { id: View; label: string; icon: NavIconId; iconLabel: string; short?: string }[] = [
  { id: "famille", label: "Tableau de bord", icon: "house", iconLabel: "Tableau de bord", short: "Accueil" },
  { id: "portefeuilles", label: "Cadeaux d’Amatxi", icon: "gift", iconLabel: "Cadeaux d’Amatxi", short: "Cadeaux" },
  { id: "transactions", label: "Bitcoin", icon: "bitcoin", iconLabel: "Bitcoin" },
  { id: "indicateurs", label: "Investissements", icon: "trending-up", iconLabel: "Investissements", short: "Investir" },
  { id: "comptes", label: "Comptes (PEA / Titres)", icon: "landmark", iconLabel: "Comptes PEA et titres" },
  { id: "videos", label: "Vidéos souvenirs", icon: "square-play", iconLabel: "Vidéos souvenirs", short: "Vidéos" },
  { id: "famille-roster", label: "Famille", icon: "users", iconLabel: "Famille", short: "Famille" },
  { id: "apprendre", label: "Apprendre", icon: "book-open", iconLabel: "Apprendre" },
  { id: "parametres", label: "Paramètres", icon: "settings", iconLabel: "Paramètres" },
  { id: "backoffice", label: "Opérations", icon: "list-checks", iconLabel: "Opérations" },
  { id: "suggestions", label: "Suggestions mensuelles", icon: "star", iconLabel: "Suggestions mensuelles" },
  { id: "administration-globale", label: "Administration", icon: "shield-check", iconLabel: "Administration" },
];

const NAV_ICON_COMMON = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, className: "nav-icon-svg" };

const NAV_ICONS: Record<NavIconId, ReactElement> = {
  house: <svg {...NAV_ICON_COMMON}><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5" /></svg>,
  gift: <svg {...NAV_ICON_COMMON}><rect x="3" y="8" width="18" height="4" rx="1" /><path d="M12 8v13" /><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7" /><path d="M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5" /></svg>,
  bitcoin: <svg {...NAV_ICON_COMMON}><path d="M11.8 19.1c4.9.9 6.1-6 1.2-6.9m-1.2 6.9L5.9 18m5.9 1.1-.3 2m1.6-8.9c4.9.9 6.1-6 1.2-6.9m-1.2 6.9-3.9-.7m5.1-6.2L8.3 4.3m5.9 1-.3-2M7.5 20.4l3.1-17.7" /></svg>,
  "trending-up": <svg {...NAV_ICON_COMMON}><polyline points="22 7 13.5 15.5 8.5 10.5 2 17" /><polyline points="16 7 22 7 22 13" /></svg>,
  landmark: <svg {...NAV_ICON_COMMON}><line x1="3" y1="22" x2="21" y2="22" /><line x1="6" y1="18" x2="6" y2="11" /><line x1="10" y1="18" x2="10" y2="11" /><line x1="14" y1="18" x2="14" y2="11" /><line x1="18" y1="18" x2="18" y2="11" /><polygon points="12 2 20 7 4 7" /></svg>,
  "square-play": <svg {...NAV_ICON_COMMON}><rect x="3" y="3" width="18" height="18" rx="2" /><path d="m10 8 6 4-6 4Z" /></svg>,
  users: <svg {...NAV_ICON_COMMON}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>,
  "book-open": <svg {...NAV_ICON_COMMON}><path d="M12 7v14" /><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" /></svg>,
  settings: <svg {...NAV_ICON_COMMON}><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" /></svg>,
  "list-checks": <svg {...NAV_ICON_COMMON}><path d="m3 17 2 2 4-4" /><path d="m3 7 2 2 4-4" /><path d="M13 6h8" /><path d="M13 12h8" /><path d="M13 18h8" /></svg>,
  star: <svg {...NAV_ICON_COMMON}><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>,
  "shield-check": <svg {...NAV_ICON_COMMON}><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /><path d="m9 12 2 2 4-4" /></svg>,
  calendar: <svg {...NAV_ICON_COMMON}><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4" /><path d="M8 2v4" /><path d="M3 10h18" /></svg>,
};

function NavIcon({ id }: { id: NavIconId }) {
  return NAV_ICONS[id];
}
const ADMIN_ONLY_VIEW_IDS: View[] = ["backoffice", "suggestions", "administration-globale"];
const BOTTOM_NAV_VIEW_IDS: View[] = ["famille", "portefeuilles", "indicateurs", "videos", "famille-roster"];

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
  const [view, setView] = useState<View>("famille");
  const todayLabel = useMemo(() => new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date()).toUpperCase(), []);
  const [modalOpen, setModalOpen] = useState(false);
  const [toast, setToast] = useState("");
  const publishedVersion = process.env.NEXT_PUBLIC_APP_VERSION ?? "local";
  const [activity, setActivity] = useState([
    { member: "Thibault", label: "Cadeau anniversaire", detail: "55,00 € · Bitcoin", time: "15 mars" },
  ]);
  const [transactions] = useState<TransactionRecord[]>(initialTransactions);
  const [transactionsReloadKey, setTransactionsReloadKey] = useState(0);
  const [transferRequests, setTransferRequests] = useState<TransferRequest[]>([]);
  const [familyRecords, setFamilyRecords] = useState<FamilyGiftRecord[]>([]);
  const [bitcoinEur, setBitcoinEur] = useState<number | null>(null);
  const [familyMarketLoading, setFamilyMarketLoading] = useState(true);
  const [familyMember, setFamilyMember] = useState("Thibault");
  const [transactionShortcut, setTransactionShortcut] = useState<TransactionShortcut | null>(null);
  const [previewMember, setPreviewMember] = useState<string | null>(null);
  const isPreview = previewMember !== null;
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [quickSwitchOpen, setQuickSwitchOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const mobileMenuRef = useDialogA11y(mobileMenuOpen, () => setMobileMenuOpen(false));
  const effectiveViewer: Viewer = previewMember ? { ...viewer, name: previewMember, email: "preview@cap.family", role: "child" } : viewer;
  const canManageGifts = viewer.role === "admin" && !isPreview;
  const memberNavItems = navItems.filter((item) => !ADMIN_ONLY_VIEW_IDS.includes(item.id));
  const adminNavItems = navItems.filter((item) => ADMIN_ONLY_VIEW_IDS.includes(item.id));
  const bottomNavItems = BOTTOM_NAV_VIEW_IDS.map((id) => navItems.find((item) => item.id === id)!);

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
        const [giftResponse, ledgerResponse] = await Promise.all([
          authenticatedFetch("/api/gifts", { signal: controller.signal }),
          authenticatedFetch("/api/ledger?priceOnly=1", { signal: controller.signal }),
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
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) console.error(error);
      } finally {
        if (!controller.signal.aborted) setFamilyMarketLoading(false);
      }
    }
    void loadFamilyMarketSummary();
    return () => controller.abort();
  }, [viewer.role, familyReloadToken]);
  useEffect(() => {
    if (viewer.role === "admin" || isPreview) return;
    const timer = window.setTimeout(() => setOnboardingOpen(window.localStorage.getItem(`cap-family-onboarding-v1:${viewer.id}`) !== "done"), 0);
    return () => window.clearTimeout(timer);
  }, [isPreview, viewer.id, viewer.role]);

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

  function completeOnboarding() {
    window.localStorage.setItem(`cap-family-onboarding-v1:${viewer.id}`, "done");
    setOnboardingOpen(false);
  }
function replayOnboarding() { setOnboardingOpen(true); }
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
    setView(next);
  }

  function handleGiftSaved(result: GiftSaveResult) {
    setModalOpen(false);
    setActivity((current) => [
      { member: result.member, label: "Cadeau enregistré", detail: `${euro.format(result.amountEur)} · Bitcoin`, time: "Aujourd’hui" },
      ...current,
    ]);
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
          <span className="brand-mark"><img src="/Labajo logo.png" alt="" width={39} height={39} /></span>
          <span><strong>LaBaJo &amp; Co</strong><small>L’école financière familiale</small></span>
        </button>

        <nav className="sidebar-nav" aria-label="Navigation principale">
          <div className="nav-group">
            <p className="nav-kicker" id="nav-membre-label">ESPACE FAMILLE</p>
            {memberNavItems.map((item) => (
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
            {adminNavItems.map((item) => (
              <button
                key={item.id}
                className={view === item.id ? "nav-item active" : "nav-item"}
                onClick={() => navigate(item.id)}
                aria-current={view === item.id ? "page" : undefined}
              >
                <span aria-hidden="true"><NavIcon id={item.icon} /></span>
                <span className="sr-only">{item.iconLabel} :</span>{item.label}
                {item.id === "backoffice" && transferRequests.length > 0 && <em aria-label={`${transferRequests.length} demandes en attente`}>{transferRequests.length}</em>}
              </button>
            ))}
          </div>}
        </nav>

        <div className="learning-card" role="complementary" aria-labelledby="learning-title">
          <span className="learning-icon" aria-hidden="true">✦</span>
          <strong id="learning-title">Conseil du mois</strong>
          <p>Investir régulièrement compte souvent plus que choisir le “moment parfait”.</p>
          <button onClick={() => setView("apprendre")}>Comprendre pourquoi →</button>
        </div>

        <div className="profile-mini">
          <span className="avatar admin" aria-hidden="true">FM</span>
          <span><strong>{isPreview ? previewMember : viewer.name}</strong><small>{isPreview ? "Apercu lecture seule" : viewer.role === "admin" ? "Administrateur" : viewer.email}</small></span>
          {!isPreview && <button type="button" className="profile-mini-trigger" onClick={() => setProfileMenuOpen((open) => !open)} aria-haspopup="menu" aria-expanded={profileMenuOpen} aria-label="Menu du profil">⌄</button>}
          {!isPreview && profileMenuOpen && <>
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
            <span className="mobile-brand-mark"><img src="/Labajo logo.png" alt="" width={32} height={32} /></span>
            <span><strong>LaBaJo &amp; Co</strong><small>L’école financière familiale</small></span>
          </div>
          <button type="button" className="mobile-menu-trigger" onClick={() => setMobileMenuOpen(true)} aria-label="Ouvrir mon profil et les paramètres">
            <span className="mobile-menu-trigger-avatar" aria-hidden="true">{effectiveViewer.name.slice(0, 2).toUpperCase()}</span>
            <span className="mobile-menu-trigger-info"><strong>{isPreview ? previewMember : viewer.name}</strong><small>{isPreview ? "Aperçu" : viewer.role === "admin" ? "Admin" : "Membre"}</small></span>
            <b className="mobile-menu-trigger-chevron" aria-hidden="true">⌄</b>
          </button>
          <div className="topbar-heading">
            <p className="eyebrow" aria-label="Date du jour">{todayLabel}</p>
            <h1 className="topbar-title">{titleFor(view)}</h1>
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
            {viewer.role === "admin" && (isPreview ? <div className="preview-pill" role="status" aria-live="polite">Aperçu membre - lecture seule</div> : <button className="primary-button" aria-label="Ajouter une opération" onClick={() => setModalOpen(true)}><span aria-hidden="true"><b>+</b></span><span>Ajouter une opération</span></button>)}
          </div>
        </header>

        {isPreview && <div className="preview-banner" role="status" aria-live="polite">
          <span className="preview-banner-eye" aria-hidden="true">◐</span>
          <span>Aperçu de <strong>{previewMember}</strong> · lecture seule</span>
          <button type="button" onClick={() => changePreview(null)}>Quitter</button>
        </div>}

        {view === "famille" && (
          <Dashboard totalBtc={totalBtc} totalBitcoinValueEur={totalBitcoinValueEur} bitcoinEur={bitcoinEur} marketLoading={familyMarketLoading} memberBalances={memberBalances} activity={activity} transferRequests={transferRequests} canManageGifts={canManageGifts} openModal={() => setModalOpen(true)} navigate={navigate} onOpenMember={(member) => { setFamilyMember(member); setView("portefeuilles"); }} />
        )}
        {view === "portefeuilles" && <Portfolios openModal={() => setModalOpen(true)} viewer={effectiveViewer} requests={transferRequests} selectedMember={familyMember} previewReadOnly={isPreview} onOpenTransactions={openFilteredTransactions} />}
        {view === "transactions" && <TransactionsView transactions={effectiveViewer.role === "admin" ? transactions : transactions.filter((transaction) => transaction.member === effectiveViewer.name)} isAdmin={effectiveViewer.role === "admin"} viewerName={effectiveViewer.name} shortcut={transactionShortcut} reloadKey={transactionsReloadKey} onAdd={() => canManageGifts ? setModalOpen(true) : setToast(isPreview ? "Aperçu : aucune modification n’est autorisée." : "Seul l’administrateur peut ajouter une opération.")} onTransferRequest={isPreview ? () => setToast("Apercu : aucune demande n est envoyee.") : requestTransfer} onOpenPortfolio={(member) => { setFamilyMember(member); setView("portefeuilles"); }} />}
        {view === "indicateurs" && <Indicators records={familyGiftRecords} bitcoinEur={bitcoinEur} />}
        {view === "comptes" && <ComingSoon eyebrow="COMPTES" title="Comptes (PEA / Titres)" description="Le suivi des comptes PEA et compte-titres arrivera dans une prochaine étape, une fois le partage familial appliqué côté serveur." />}
        {view === "videos" && <ComingSoon eyebrow="SOUVENIRS" title="Vidéos souvenirs" description="Un espace pour retrouver les vidéos souvenirs d’Amatxi sera bientôt disponible ici." />}
        {view === "famille-roster" && <FamilyRoster memberBalances={memberBalances} onOpenMember={(member) => { setFamilyMember(member); setView("portefeuilles"); }} />}
        {view === "backoffice" && effectiveViewer.role === "admin" && <Administration viewer={effectiveViewer} requests={transferRequests} onRequestStatus={updateRequestStatus} />}
        {view === "suggestions" && effectiveViewer.role === "admin" && <ComingSoon eyebrow="ADMINISTRATION" title="Suggestions mensuelles" description="Un futur outil de recommandation d’investissement mensuel (répartition PEA & titres) sera piloté depuis cet écran." />}
        {view === "administration-globale" && effectiveViewer.role === "admin" && <ComingSoon eyebrow="ADMINISTRATION" title="Administration" description="Un tableau de pilotage global regroupant les réglages administrateurs arrivera ici." />}
        {view === "apprendre" && <Learn />}
        {view === "parametres" && (isPreview ? <PreviewSettings member={previewMember!} onExit={() => { setPreviewMember(null); setView("famille"); }} /> : <Settings viewer={viewer} onSignOut={onSignOut} publishedVersion={publishedVersion} onReplayOnboarding={replayOnboarding} />)}
      </section>

      <nav className="mobile-nav" aria-label="Navigation mobile">
        {bottomNavItems.map((item) => (
          <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => navigate(item.id)} aria-current={view === item.id ? "page" : undefined}>
            <span aria-hidden="true"><NavIcon id={item.icon} /></span><small>{item.short ?? item.label.split(" ")[0]}</small>
          </button>
        ))}
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
              <button type="button" className="mobile-menu-link" onClick={() => { setView("transactions"); setMobileMenuOpen(false); }}><span className="mobile-menu-link-content"><span aria-hidden="true"><NavIcon id="bitcoin" /></span><span>Bitcoin</span></span><span>›</span></button>
              <button type="button" className="mobile-menu-link" onClick={() => { setView("comptes"); setMobileMenuOpen(false); }}><span className="mobile-menu-link-content"><span aria-hidden="true"><NavIcon id="landmark" /></span><span>Comptes (PEA / Titres)</span></span><span>›</span></button>
            </div>
            <div className="mobile-menu-section">
              <p>Réglages</p>
              <button type="button" className="mobile-menu-link" onClick={() => { setView("parametres"); setMobileMenuOpen(false); }}><span className="mobile-menu-link-content"><span aria-hidden="true"><NavIcon id="settings" /></span><span>Paramètres</span></span><span>›</span></button>
            </div>
            {viewer.role === "admin" && (
              <div className="mobile-menu-section">
                <p>Administration</p>
                <button type="button" className="mobile-menu-link" onClick={() => { setView("backoffice"); setMobileMenuOpen(false); }}><span className="mobile-menu-link-content"><span aria-hidden="true"><NavIcon id="list-checks" /></span><span>Opérations</span></span>{transferRequests.length > 0 ? <em>{transferRequests.length}</em> : <span>›</span>}</button>
                <button type="button" className="mobile-menu-link" onClick={() => { setView("suggestions"); setMobileMenuOpen(false); }}><span className="mobile-menu-link-content"><span aria-hidden="true"><NavIcon id="star" /></span><span>Suggestions mensuelles</span></span><span>›</span></button>
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

      {onboardingOpen && !isPreview && effectiveViewer.role !== "admin" && <MemberOnboarding viewer={effectiveViewer} onComplete={completeOnboarding} onOpenPortfolio={() => setView("portefeuilles")} />}
      {modalOpen && canManageGifts && <InvestmentModal defaultMember={familyMember} onClose={() => setModalOpen(false)} onSaved={handleGiftSaved} />}
      {toast && <div className="toast" role="status">✓ {toast}</div>}
    </main>
  );
}

function Dashboard({ totalBtc, totalBitcoinValueEur, bitcoinEur, marketLoading, memberBalances, activity, transferRequests, canManageGifts, openModal, navigate, onOpenMember }: {
  totalBtc: number;
  totalBitcoinValueEur: number | null;
  bitcoinEur: number | null;
  marketLoading: boolean;
  memberBalances: FamilyMemberBalance[];
  activity: { member: string; label: string; detail: string; time: string }[];
  transferRequests: TransferRequest[];
  canManageGifts: boolean;
  openModal: () => void;
  navigate: (view: View) => void;
  onOpenMember: (member: string) => void;
}) {
  const nextFamilyEvents = nextFamilyCalendarEvents();
  const nextFamilyEvent = nextFamilyEvents[0];
  const daysUntilNextFamilyEvent = Math.max(0, Math.ceil((nextFamilyEvent.date.getTime() - Date.now()) / 86400000));
  const pendingTransfers = transferRequests.filter((request) => request.status !== "Transférée");
  const pendingTransferBtc = pendingTransfers.reduce((sum, request) => sum + (request.btcAmount ?? 0), 0);
  return (
    <div className="content-grid">
      <section className="welcome-panel">
        <div>
          <span className="soft-pill">● SITUATION AUJOURD’HUI</span>
          <h2>Bonjour 👋<br />La famille construit son avenir.</h2>
          <p>Les cadeaux d’Amatxi en Bitcoin et vos investissements réguliers progressent bien. Continuons à construire, ensemble, sereinement.</p>
          {canManageGifts && <button type="button" className="welcome-cta-mobile" onClick={openModal}><b aria-hidden="true">+</b> Ajouter une opération</button>}
        </div>
        <div className="hero-orbit" aria-hidden="true"><span className="coin">₿</span><i /><b /></div>
        {canManageGifts && <button className="primary-button welcome-action" onClick={openModal}>＋ Ajouter une opération</button>}      </section>

      <div className="next-birthday-notice family-calendar-notice" role="status"><span aria-hidden="true">&#127874;</span><span>{familyCalendarLabel(nextFamilyEvents)}</span><b>{daysUntilNextFamilyEvent === 0 ? "Ce jour" : "dans " + daysUntilNextFamilyEvent + " jours"}</b></div>

      <section className="stats-row" aria-label="Indicateurs clés">
        <Stat label="Valeur totale BTC cadeaux" value={totalBitcoinValueEur === null ? (marketLoading ? "Mise à jour…" : "Cours indisponible") : euro.format(totalBitcoinValueEur)} note={bitcoinEur ? `${totalBtc.toFixed(8)} BTC attribués · 1 BTC = ${euro.format(bitcoinEur)}` : "Bitcoin uniquement · PEA et compte-titres bientôt"} tone="amber" icon="bitcoin" />
        <Stat label="À transférer vers Ledger" value={`${pendingTransfers.length} transfert${pendingTransfers.length > 1 ? "s" : ""}`} note={pendingTransferBtc > 0 ? `${pendingTransferBtc.toFixed(8)} BTC en attente` : "Aucun transfert en attente"} tone="teal" icon="shield-check" />
        <Stat label="Suggestions mensuelles" value="Bientôt" note="Répartition PEA & Titres — à venir" tone="teal" icon="trending-up" />
        <Stat label={"Prochain \u00e9v\u00e8nement"} value={nextFamilyEvent.day + " " + new Intl.DateTimeFormat("fr-FR", { month: "long" }).format(nextFamilyEvent.date)} note={nextFamilyEvent.kind === "christmas" ? "No\u00ebl" : "Anniversaire de " + nextFamilyEvent.name} tone="amber" icon="calendar" />
      </section>

      <section className="panel family-panel">
        <PanelTitle eyebrow="LES MEMBRES" title="Vue d’ensemble de la famille" action="Voir la famille" onAction={() => navigate("famille-roster")} />
        <div className="member-grid">
          {members.map((member) => { const documentedProgress = Math.max(18, 100 - member.missing * 12); const balance = memberBalances.find((item) => item.name === member.name); const btc = balance?.btc ?? 0; const currentValueEur = balance?.currentValueEur ?? null; return (
            <button className="member-card member-card-button" key={member.name} onClick={() => onOpenMember(member.name)} aria-label={`Voir le portefeuille et les transactions de ${member.name}`}>
              <div className="member-top"><span className={`avatar ${member.color}`}>{member.initials}</span></div>
              <h3>{member.name}</h3><p>Anniversaire · {member.birthday}</p>
              <div className="member-value"><strong>{currentValueEur === null ? "—" : euro.format(currentValueEur)}</strong><small>{currentValueEur === null ? "Cours BTC indisponible" : "valeur Bitcoin actuelle"}</small></div>
              <div className="progress" role="progressbar" aria-label={`Cadeaux documentés pour ${member.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={documentedProgress} aria-valuetext={`${member.missing} cadeau${member.missing > 1 ? "x" : ""} à saisir`}><span style={{ width: `${documentedProgress}%` }} /></div>
              <footer><span>{btc.toFixed(8)} BTC attribués</span><b>{member.missing} à saisir</b></footer>
            </button>
          ); })}
        </div>
      </section>

      <div className="dashboard-bottom-row">
        <section className="panel activity-panel">
          <PanelTitle eyebrow="JOURNAL" title="Activité récente" action={canManageGifts ? "Ajouter" : undefined} onAction={canManageGifts ? openModal : undefined} />
          <div className="activity-list">
            {activity.slice(0, 4).map((item, index) => (
              <div className="activity-item" key={`${item.label}-${index}`}><span className="activity-mark">{item.member.slice(0, 1)}</span><div><strong>{item.label}</strong><p>{item.member} · {item.detail}</p></div><time>{item.time}</time></div>
            ))}
          </div>
        </section>

        <section className="panel dashboard-mini-panel">
          <PanelTitle eyebrow="SUGGESTION DU MOIS" title="Investir régulièrement" />
          <p className="dashboard-mini-copy">Investir régulièrement compte souvent plus que choisir le « moment parfait ». Les recommandations personnalisées (PEA &amp; Titres) arrivent bientôt.</p>
          <span className="coming-soon-badge">Bientôt disponible</span>
        </section>

        <section className="panel dashboard-mini-panel">
          <PanelTitle eyebrow="VIDÉOS SOUVENIRS" title="Souvenirs d’Amatxi" />
          <p className="dashboard-mini-copy">Un espace pour retrouver les vidéos souvenirs d’Amatxi sera bientôt disponible ici.</p>
          <span className="coming-soon-badge">Bientôt disponible</span>
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

function Stat({ label, value, note, tone, icon }: { label: string; value: string; note: string; tone: string; icon: NavIconId }) {
  return <article className="stat-card"><span className={`stat-icon ${tone}`}><NavIcon id={icon} /></span><div><p>{label}</p><strong>{value}</strong><small>{note}</small></div></article>;
}

export function PanelTitle({ eyebrow, title, action, onAction }: { eyebrow: string; title: string; action?: string; onAction?: () => void }) {
  return <header className="panel-title"><div><span>{eyebrow}</span><h2>{title}</h2></div>{action && <button onClick={onAction}>{action} →</button>}</header>;
}

function titleFor(view: View) {
  return {
    famille: "Tableau de bord",
    portefeuilles: "Cadeaux d’Amatxi",
    transactions: "Bitcoin",
    indicateurs: "Investissements",
    comptes: "Comptes (PEA / Titres)",
    videos: "Vidéos souvenirs",
    "famille-roster": "Famille",
    backoffice: "Opérations",
    suggestions: "Suggestions mensuelles",
    "administration-globale": "Administration",
    apprendre: "Apprendre",
    parametres: "Paramètres",
  }[view];
}
