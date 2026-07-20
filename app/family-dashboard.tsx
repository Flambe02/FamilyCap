"use client";

import { useEffect, useMemo, useState } from "react";
import { initialTransactions, InvestmentModal, TransactionRecord, TransactionsView, type TransactionShortcut } from "./transactions";
import { TransferRequest } from "./back-office";
import { Administration } from "./administration";
import { GiftPortfolio } from "./gift-portfolio";
import { AdminUsers } from "./admin-users";
import { InvestmentAccessSettings } from "./investment-access-settings";
import { InstallAppCard } from "./install-app";
import { AmatxiReport } from "./amatxi-report";
import { Indicators } from "./indicators";
import type { Viewer } from "../lib/auth-types";
import { supabaseBrowser } from "../lib/supabase-browser";
import { MemberOnboarding } from "./member-onboarding";
import { GIFT_HISTORY } from "../lib/gift-history";
import { useDialogA11y } from "./use-dialog-a11y";

type View = "famille" | "portefeuilles" | "transactions" | "indicateurs" | "backoffice" | "amatxi" | "apprendre" | "parametres";

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

const members = [
  { name: "Thibault", initials: "TH", birthday: "15 mars", birthdayDay: 15, birthdayMonth: 3, missing: 5, color: "mint" },
  { name: "Uhaina", initials: "UH", birthday: "16 ao\u00fbt", birthdayDay: 16, birthdayMonth: 8, missing: 4, color: "coral" },
  { name: "Paul", initials: "PA", birthday: "18 nov.", birthdayDay: 18, birthdayMonth: 11, missing: 4, color: "blue" },
  { name: "Aurore", initials: "AU", birthday: "17 ao\u00fbt", birthdayDay: 17, birthdayMonth: 8, missing: 4, color: "yellow" },
  { name: "Thomas", initials: "TO", birthday: "29 d\u00e9c.", birthdayDay: 29, birthdayMonth: 12, missing: 5, color: "purple" },
];

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
const navItems: { id: View; label: string; icon: string; iconLabel: string; short?: string }[] = [
  { id: "famille", label: "Vue famille", icon: "⌂", iconLabel: "Accueil", short: "Accueil" },
  { id: "portefeuilles", label: "Portefeuilles", icon: "◫", iconLabel: "Portefeuilles", short: "Portefeuille" },
  { id: "transactions", label: "Transactions", icon: "⇄", iconLabel: "Transactions", short: "Mouvements" },
  { id: "indicateurs", label: "Indicateurs", icon: "↗", iconLabel: "Indicateurs", short: "Indicateurs" },
  { id: "backoffice", label: "Administration", icon: "▣", iconLabel: "Administration" },
  { id: "amatxi", label: "Vue Amatxi", icon: "?", iconLabel: "Vue Amatxi" },
  { id: "apprendre", label: "Apprendre", icon: "◇", iconLabel: "Apprendre", short: "Apprendre" },
  { id: "parametres", label: "Paramètres", icon: "⚙", iconLabel: "Paramètres", short: "Paramètres" },
];

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
  const [modalOpen, setModalOpen] = useState(false);
  const [toast, setToast] = useState("");
  const publishedVersion = process.env.NEXT_PUBLIC_APP_VERSION ?? "local";
  const [activity, setActivity] = useState([
    { member: "Thibault", label: "Cadeau anniversaire", detail: "55,00 € · Bitcoin", time: "15 mars" },
  ]);
  const [transactions, setTransactions] = useState<TransactionRecord[]>(initialTransactions);
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
  const memberNavItems = navItems.filter((item) => item.id !== "backoffice" && item.id !== "amatxi");
  const adminNavItems = navItems.filter((item) => item.id === "backoffice" || item.id === "amatxi");
  const bottomNavItems = memberNavItems.filter((item) => item.id !== "indicateurs" && item.id !== "parametres");

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
  }, [viewer.role]);
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
  const missing = useMemo(() => members.reduce((sum, member) => sum + member.missing, 0), []);

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

  function saveInvestment(transaction: TransactionRecord) {
    setTransactions((current) => [transaction, ...current]);
    setActivity((current) => [
      { member: transaction.member, label: "Investissement saisi", detail: `${euro.format(transaction.amount)} · ${transaction.asset} · par ${transaction.author}`, time: "Aujourd’hui" },
      ...current,
    ]);
    setModalOpen(false);
    setToast("Opération enregistrée et visible dans Transactions");
    window.setTimeout(() => setToast(""), 3200);
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
          <span><strong>LaBaJo &amp; Co</strong><small>L’école financière</small></span>
        </button>

        <nav aria-label="Navigation principale">
          <div className="nav-group">
            <p className="nav-kicker" id="nav-membre-label">ESPACE MEMBRE</p>
            {memberNavItems.map((item) => (
              <button
                key={item.id}
                className={view === item.id ? "nav-item active" : "nav-item"}
                onClick={() => navigate(item.id)}
                aria-current={view === item.id ? "page" : undefined}
              >
                <span aria-hidden="true">{item.icon}</span>
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
                <span aria-hidden="true">{item.icon}</span>
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
          {!isPreview && <button type="button" onClick={() => setProfileMenuOpen((open) => !open)} aria-haspopup="menu" aria-expanded={profileMenuOpen} aria-label="Menu du profil">...</button>}
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
          <button type="button" className="mobile-menu-trigger" onClick={() => setMobileMenuOpen(true)} aria-label="Ouvrir mon profil et les paramètres">
            <span aria-hidden="true">{effectiveViewer.name.slice(0, 2).toUpperCase()}</span>
          </button>
          <div>
            <p className="eyebrow" aria-label="Date du jour">JEUDI 16 JUILLET 2026</p>
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
            {isPreview ? <div className="preview-pill" role="status" aria-live="polite">Aperçu membre - lecture seule</div> : <button className="primary-button" aria-label="Ajouter une opération" onClick={() => setModalOpen(true)}><span aria-hidden="true"><b>+</b></span><span>Ajouter une opération</span></button>}
          </div>
        </header>

        {isPreview && <div className="preview-banner" role="status" aria-live="polite">
          <span className="preview-banner-eye" aria-hidden="true">◐</span>
          <span>Aperçu de <strong>{previewMember}</strong> · lecture seule</span>
          <button type="button" onClick={() => changePreview(null)}>Quitter</button>
        </div>}

        {view === "famille" && (
          <Dashboard totalBtc={totalBtc} totalBitcoinValueEur={totalBitcoinValueEur} bitcoinEur={bitcoinEur} marketLoading={familyMarketLoading} memberBalances={memberBalances} missing={missing} activity={activity} openModal={() => setModalOpen(true)} navigate={navigate} onOpenMember={(member) => { setFamilyMember(member); setView("portefeuilles"); }} />
        )}
        {view === "portefeuilles" && <Portfolios openModal={() => setModalOpen(true)} viewer={effectiveViewer} requests={transferRequests} selectedMember={familyMember} previewReadOnly={isPreview} onOpenTransactions={openFilteredTransactions} />}
        {view === "transactions" && <TransactionsView transactions={effectiveViewer.role === "admin" ? transactions : transactions.filter((transaction) => transaction.member === effectiveViewer.name)} isAdmin={effectiveViewer.role === "admin"} viewerName={effectiveViewer.name} shortcut={transactionShortcut} onAdd={() => isPreview ? setToast("Apercu : aucune modification n est autorisee.") : setModalOpen(true)} onTransferRequest={isPreview ? () => setToast("Apercu : aucune demande n est envoyee.") : requestTransfer} onOpenPortfolio={(member) => { setFamilyMember(member); setView("portefeuilles"); }} />}
        {view === "indicateurs" && <Indicators records={familyGiftRecords} bitcoinEur={bitcoinEur} />}
        {view === "backoffice" && effectiveViewer.role === "admin" && <Administration viewer={effectiveViewer} requests={transferRequests} onRequestStatus={updateRequestStatus} />}
        {view === "amatxi" && effectiveViewer.role === "admin" && <AmatxiReport records={familyGiftRecords} bitcoinEur={bitcoinEur} loading={familyMarketLoading} />}
        {view === "apprendre" && <Learn />}
        {view === "parametres" && (isPreview ? <PreviewSettings member={previewMember!} onExit={() => { setPreviewMember(null); setView("famille"); }} /> : <Settings viewer={viewer} onSignOut={onSignOut} publishedVersion={publishedVersion} onReplayOnboarding={replayOnboarding} />)}
      </section>

      <nav className="mobile-nav" aria-label="Navigation mobile">
        {bottomNavItems.map((item) => (
          <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => navigate(item.id)} aria-current={view === item.id ? "page" : undefined}>
            <span aria-hidden="true">{item.icon}</span><small>{item.short ?? item.label.split(" ")[0]}</small>
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
              <p>Indicateurs</p>
              <button type="button" className="mobile-menu-link" onClick={() => { setView("indicateurs"); setMobileMenuOpen(false); }}><span>Indicateurs</span><span>›</span></button>
            </div>
            <div className="mobile-menu-section">
              <p>Réglages</p>
              <button type="button" className="mobile-menu-link" onClick={() => { setView("parametres"); setMobileMenuOpen(false); }}><span>Paramètres</span><span>›</span></button>
            </div>
            {viewer.role === "admin" && (
              <div className="mobile-menu-section">
                <p>Administration</p>
                <button type="button" className="mobile-menu-link" onClick={() => { setView("backoffice"); setMobileMenuOpen(false); }}><span>Administration</span>{transferRequests.length > 0 ? <em>{transferRequests.length}</em> : <span>›</span>}</button>
                <button type="button" className="mobile-menu-link" onClick={() => { setView("amatxi"); setMobileMenuOpen(false); }}><span>Vue Amatxi</span><span>›</span></button>
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
      {modalOpen && <InvestmentModal onClose={() => setModalOpen(false)} onSave={saveInvestment} />}
      {toast && <div className="toast" role="status">✓ {toast}</div>}
    </main>
  );
}

function Dashboard({ totalBtc, totalBitcoinValueEur, bitcoinEur, marketLoading, memberBalances, missing, activity, openModal, navigate, onOpenMember }: {
  totalBtc: number;
  totalBitcoinValueEur: number | null;
  bitcoinEur: number | null;
  marketLoading: boolean;
  memberBalances: FamilyMemberBalance[];
  missing: number;
  activity: { member: string; label: string; detail: string; time: string }[];
  openModal: () => void;
  navigate: (view: View) => void;
  onOpenMember: (member: string) => void;
}) {
  const nextFamilyEvents = nextFamilyCalendarEvents();
  const nextFamilyEvent = nextFamilyEvents[0];
  const daysUntilNextFamilyEvent = Math.max(0, Math.ceil((nextFamilyEvent.date.getTime() - Date.now()) / 86400000));
  return (
    <div className="content-grid">
      <section className="welcome-panel">
        <div>
          <span className="soft-pill">● SITUATION AUJOURD’HUI</span>
          <h2>Bonjour 👋<br />La famille avance bien.</h2>
          <p>Le suivi Bitcoin est prêt. La prochaine étape est de compléter les achats manquants puis de rapprocher Binance et les Ledger.</p>
          <button type="button" className="welcome-cta-mobile" onClick={() => navigate("portefeuilles")}>Voir les portefeuilles →</button>
        </div>
        <div className="hero-orbit" aria-hidden="true"><span className="coin">₿</span><i /><b /></div>
        <button className="primary-button welcome-action" onClick={openModal}>＋ Ajouter une opération</button>      </section>

      <div className="next-birthday-notice family-calendar-notice" role="status"><span aria-hidden="true">&#127874;</span><span>{familyCalendarLabel(nextFamilyEvents)}</span><b>{daysUntilNextFamilyEvent === 0 ? "Ce jour" : "dans " + daysUntilNextFamilyEvent + " jours"}</b></div>

      <section className="stats-row" aria-label="Indicateurs clés">
        <Stat label="Valeur Bitcoin actuelle" value={totalBitcoinValueEur === null ? (marketLoading ? "Mise à jour…" : "Cours indisponible") : euro.format(totalBitcoinValueEur)} note={bitcoinEur ? `${totalBtc.toFixed(8)} BTC attribués · 1 BTC = ${euro.format(bitcoinEur)}` : "Bitcoin uniquement · PEA et compte-titres bientôt"} tone="navy" icon="₿" />
        <Stat label="À compléter" value={`${missing} achats`} note="Quantités BTC manquantes" tone="amber" icon="!" />
        <Stat label={"Prochain \u00e9v\u00e8nement"} value={nextFamilyEvent.day + " " + new Intl.DateTimeFormat("fr-FR", { month: "long" }).format(nextFamilyEvent.date)} note={nextFamilyEvent.kind === "christmas" ? "No\u00ebl" : "Anniversaire de " + nextFamilyEvent.name} tone="teal" icon={"\u2311"} />
      </section>

      <section className="panel family-panel">
        <PanelTitle eyebrow="LES MEMBRES" title="Vue d’ensemble" action="Gérer la famille" onAction={() => navigate("parametres")} />
        <div className="member-grid">
          {members.map((member) => { const documentedProgress = Math.max(18, 100 - member.missing * 12); const balance = memberBalances.find((item) => item.name === member.name); const btc = balance?.btc ?? 0; const currentValueEur = balance?.currentValueEur ?? null; return (
            <button className="member-card member-card-button" key={member.name} onClick={() => onOpenMember(member.name)} aria-label={`Voir le portefeuille et les transactions de ${member.name}`}>
              <div className="member-top"><span className={`avatar ${member.color}`}>{member.initials}</span><span className="status-dot">À vérifier</span></div>
              <h3>{member.name}</h3><p>Anniversaire · {member.birthday}</p>
              <div className="member-value"><strong>{currentValueEur === null ? "—" : euro.format(currentValueEur)}</strong><small>{currentValueEur === null ? "Cours BTC indisponible" : "valeur Bitcoin actuelle"}</small></div>
              <div className="progress" role="progressbar" aria-label={`Cadeaux documentés pour ${member.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={documentedProgress} aria-valuetext={`${member.missing} cadeau${member.missing > 1 ? "x" : ""} à saisir`}><span style={{ width: `${documentedProgress}%` }} /></div>
              <footer><span>{btc.toFixed(8)} BTC attribués</span><b>{member.missing} à saisir</b></footer>
            </button>
          ); })}
        </div>
      </section>

      <section className="panel activity-panel">
        <PanelTitle eyebrow="JOURNAL" title="Activité récente" action="Ajouter" onAction={openModal} />
        <div className="activity-list">
          {activity.slice(0, 4).map((item, index) => (
            <div className="activity-item" key={`${item.label}-${index}`}><span className="activity-mark">{item.member.slice(0, 1)}</span><div><strong>{item.label}</strong><p>{item.member} · {item.detail}</p></div><time>{item.time}</time></div>
          ))}
        </div>
      </section>
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

function PreviewSettings({ member, onExit }: { member: string; onExit: () => void }) {
  return <div className="panel preview-settings"><span>MODE APERCU</span><h2>Vue de {member}</h2><p>Tu regardes l interface comme ce membre, sans modifier son compte, ses donnees ou ses droits reels.</p><button className="primary-button" onClick={onExit}>Quitter l apercu</button></div>;
}
function Settings({ viewer, onSignOut, publishedVersion, onReplayOnboarding }: { viewer: Viewer; onSignOut: () => void; publishedVersion: string; onReplayOnboarding?: () => void }) {
  const adminTabs = [["utilisateurs", "Utilisateurs & accès"], ["portefeuilles", "Comptes & wallets"], ["partage", "Partage de mes investissements"], ["cadeaux", "Règles des cadeaux"], ["securite", "Sécurité"], ["donnees", "Données & exports"], ["compte", "Mon compte"]];
  const memberTabs = [["compte", "Mon compte"], ["portefeuilles", "Mes portefeuilles"], ["partage", "Partage de mes investissements"], ["securite", "S\u00e9curit\u00e9"]];
  const tabs = viewer.role === "admin" ? adminTabs : memberTabs;
  const [tab, setTab] = useState(viewer.role === "admin" ? "utilisateurs" : "compte");
  return <div className="settings-layout"><aside className="settings-nav"><p>RÉGLAGES</p>{tabs.map(([id, label]) => <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{label}<span>›</span></button>)}</aside><section className="settings-content panel">{tab === "utilisateurs" && viewer.role === "admin" && <UsersSettings />}{tab === "portefeuilles" && (viewer.role === "admin" ? <WalletSettings /> : <MemberWalletSettings viewer={viewer} />)}{tab === "partage" && <InvestmentAccessSettings />}{tab === "cadeaux" && viewer.role === "admin" && <GiftSettings />}{tab === "securite" && <SecuritySettings />}{tab === "donnees" && viewer.role === "admin" && <DataSettings />}{tab === "compte" && <PersonalSettings viewer={viewer} onSignOut={onSignOut} publishedVersion={publishedVersion} onReplayOnboarding={onReplayOnboarding} />}</section></div>;
}

function formatBirthday(day?: number | null, month?: number | null, year?: number | null) {
  if (!day || !month) return "Non renseignée";
  const formatted = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long" }).format(new Date(2000, month - 1, day));
  return year ? `${formatted} ${year}` : formatted;
}

function PersonalSettings({ viewer, onSignOut, publishedVersion, onReplayOnboarding }: { viewer: Viewer; onSignOut: () => void; publishedVersion: string; onReplayOnboarding?: () => void }) {
  const [password, setPassword] = useState("");
  const [passwordMessage, setPasswordMessage] = useState("");
  const [email, setEmail] = useState(viewer.email);
  const [emailMessage, setEmailMessage] = useState("");
  const [savingEmail, setSavingEmail] = useState(false);

  async function updatePassword() {
    if (password.length < 8) { setPasswordMessage("Le mot de passe doit contenir au moins 8 caractères."); return; }
    const { error } = await supabaseBrowser.auth.updateUser({ password });
    setPasswordMessage(error ? error.message : "Mot de passe mis à jour.");
    if (!error) setPassword("");
  }

  async function updateEmail() {
    const trimmed = email.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(trimmed)) { setEmailMessage("Adresse e-mail invalide."); return; }
    if (trimmed === viewer.email.toLowerCase()) { setEmailMessage("C'est déjà ton adresse actuelle."); return; }
    setSavingEmail(true); setEmailMessage("");
    const { error } = await supabaseBrowser.auth.updateUser({ email: trimmed });
    setEmailMessage(error ? error.message : "E-mail de confirmation envoyé à la nouvelle adresse. Clique sur le lien reçu pour valider le changement.");
    setSavingEmail(false);
  }

  return <>
    <PanelTitle eyebrow="MON ESPACE" title="Compte & connexion" />
    <p className="section-intro">Ces informations correspondent à ton accès personnel LaBaJo &amp; Co.</p>
    <InstallAppCard />
    <div className="form-grid">
      <label>Nom<input value={viewer.name} readOnly /></label>
      <label>Rôle<input value={viewer.role === "admin" ? "Administrateur" : viewer.role === "viewer" ? "Amatxi" : "Utilisateur"} readOnly /></label>
      <label>Date de naissance<input value={formatBirthday(viewer.birthdayDay, viewer.birthdayMonth, viewer.birthdayYear)} readOnly /></label>
    </div>
    <p className="section-hint">Le nom, le rôle et la date de naissance sont gérés par Florent — contacte-le pour une correction.</p>

    <h3 className="settings-subhead">Adresse e-mail (identifiant de connexion)</h3>
    <div className="form-grid">
      <label className="span-2">Adresse e-mail<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" /></label>
    </div>
    <div className="settings-account-actions"><button onClick={() => void updateEmail()} disabled={savingEmail}>{savingEmail ? "Envoi…" : "Changer d'adresse e-mail"}</button></div>
    {emailMessage && <p className="info-callout" role="status">{emailMessage}</p>}

    <h3 className="settings-subhead">Mot de passe</h3>
    <div className="form-grid">
      <label>Nouveau mot de passe<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="8 caractères minimum" autoComplete="new-password" /></label>
    </div>
    <div className="settings-account-actions">
      <button onClick={() => void updatePassword()}>Mettre à jour le mot de passe</button>
      <button className="logout-button" onClick={onSignOut}>Se déconnecter</button>
    </div>
    {passwordMessage && <p className="info-callout" role="status">{passwordMessage}</p>}

    {viewer.role !== "admin" && onReplayOnboarding && <div className="onboarding-settings"><div><b>Revoir les premiers pas</b><p>Une visite courte pour comprendre Binance, Ledger et ton portefeuille.</p></div><button type="button" onClick={onReplayOnboarding}>Revoir la visite</button></div>}
    <div className="account-version">Version publiée <strong>{publishedVersion}</strong></div>
  </>;
}

function UsersSettings() {
  return <AdminUsers />;
}

function WalletSettings() {
  const ledgerAddresses = [
    ["Thibault", "bc1qcy4jt8fh5dhj9fq9d4lu2hq6klvvdmlkeqcgks"],
    ["Uhaina", "bc1qqkfmts27j07y8u7a6ap7wyczfhe5afyrkn7y2t"],
    ["Paul", "bc1qxx7ve23aggf0596zf45kx0ppk5qjggpak82wd5"],
    ["Aurore", "bc1qxs2uy67myzfx8z2vtzr6lm3cgrx808azqkt4pg"],
    ["Thomas", "bc1qfwuze87xnhxjfdmr3wnfy3wguu5ymedk4qcwjr"],
  ];
  return <><PanelTitle eyebrow="PARAMÈTRES" title="Comptes & wallets" action="＋ Ajouter un compte" /><p className="section-intro">Les cinq adresses publiques Ledger sont maintenant enregistrées et contrôlées sur la blockchain. Jamais de clé privée ni de phrase de récupération.</p><div className="wallet-list"><article><div className="wallet-logo bitcoin">₿</div><div><strong>Binance commun</strong><p>Compte de passage · parts individuelles à ventiler</p></div><span className="warning-pill">À rapprocher</span></article>{ledgerAddresses.map(([name, address]) => <article key={name}><div className="wallet-logo ledger">L</div><div><strong>Ledger de {name}</strong><p title={address}>{address}</p></div><span className="access">Blockchain connectée</span></article>)}</div><div className="info-callout"><b>Important</b><p>Ces adresses servent uniquement à lire les soldes et transactions publics. Les 24 mots, clés privées, codes PIN et codes Binance ne doivent jamais être saisis ici.</p></div></>;
}

function MemberWalletSettings({ viewer }: { viewer: Viewer }) {
  const addresses: Record<string, string> = {
    Thibault: "bc1qcy4jt8fh5dhj9fq9d4lu2hq6klvvdmlkeqcgks",
    Uhaina: "bc1qqkfmts27j07y8u7a6ap7wyczfhe5afyrkn7y2t",
    Paul: "bc1qxx7ve23aggf0596zf45kx0ppk5qjggpak82wd5",
    Aurore: "bc1qxs2uy67myzfx8z2vtzr6lm3cgrx808azqkt4pg",
    Thomas: "bc1qfwuze87xnhxjfdmr3wnfy3wguu5ymedk4qcwjr",
  };
  const address = addresses[viewer.name];
  return <><PanelTitle eyebrow="MES PARAMÈTRES" title="Mon portefeuille" /><p className="section-intro">Tu peux consulter ton adresse publique et son historique. Seul Florent peut modifier les comptes familiaux.</p>{address ? <div className="wallet-list"><article><div className="wallet-logo ledger">L</div><div><strong>Ledger de {viewer.name}</strong><p>{address}</p></div><span className="access">Blockchain connectée</span></article></div> : <div className="info-callout"><b>Aucun portefeuille associé</b><p>Florent pourra ajouter ton compte depuis le back-office.</p></div>}</>;
}
function GiftSettings() {
  return <><PanelTitle eyebrow="PARAMÈTRES" title="Règles des cadeaux" /><div className="form-grid"><label>Montant par cadeau<div className="input-suffix"><input defaultValue="55,00" /><span>EUR</span></div></label><label>Occasions<select defaultValue="birthday"><option value="birthday">Anniversaire + Noël</option></select></label><label>Date de début<input type="date" defaultValue="2022-12-27" /></label><label>Traitement des frais<select defaultValue="included"><option value="included">Inclus dans les 55 €</option></select></label></div><div className="info-callout"><b>Règle active</b><p>Chaque enfant reçoit 55 € au total, frais Binance et frais réseau compris. Les échéances futures sont générées automatiquement.</p></div></>;
}

function SecuritySettings() {
  return <><PanelTitle eyebrow="PARAMÈTRES" title="Sécurité & confidentialité" /><div className="security-grid"><article><span>1</span><div><strong>Connexion personnelle</strong><p>À la mise en ligne, chaque membre utilisera une invitation sécurisée. Aucun mot de passe ne sera visible ou stocké en clair.</p></div><b>Prévu</b></article><article><span>2</span><div><strong>Rôles et permissions</strong><p>Administrateur, adulte, jeune investisseur et lecture seule.</p></div><b>Défini</b></article><article><span>3</span><div><strong>Données sensibles</strong><p>Les phrases Ledger, clés privées, codes Binance et codes 2FA sont interdits dans l’application.</p></div><b>Actif</b></article></div></>;
}

function DataSettings() {
  return <><PanelTitle eyebrow="PARAMÈTRES" title="Données & exports" /><div className="export-card"><div><strong>Registre de rapprochement</strong><p>Exporter l’historique des cadeaux, les quantités BTC, les soldes Binance/Ledger et les écarts.</p></div><button>Exporter en Excel</button></div><div className="export-card"><div><strong>Sauvegarde familiale</strong><p>Une sauvegarde chiffrée sera disponible avec la version en ligne.</p></div><button disabled>Bientôt</button></div></>;
}

function Stat({ label, value, note, tone, icon }: { label: string; value: string; note: string; tone: string; icon: string }) {
  return <article className="stat-card"><span className={`stat-icon ${tone}`}>{icon}</span><div><p>{label}</p><strong>{value}</strong><small>{note}</small></div></article>;
}

function PanelTitle({ eyebrow, title, action, onAction }: { eyebrow: string; title: string; action?: string; onAction?: () => void }) {
  return <header className="panel-title"><div><span>{eyebrow}</span><h2>{title}</h2></div>{action && <button onClick={onAction}>{action} →</button>}</header>;
}

function titleFor(view: View) {
  return { famille: "Accueil", portefeuilles: "Portefeuille", transactions: "Mouvements", indicateurs: "Indicateurs", backoffice: "Administration", amatxi: "Vue Amatxi", apprendre: "Apprendre", parametres: "Paramètres" }[view];
}
