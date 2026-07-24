"use client";

import { useEffect, useMemo, useState } from "react";
import type { Viewer } from "../lib/auth-types";
import type { TransferRequest } from "./back-office";
import { TransactionsView, type TransactionRecord, type TransactionShortcut } from "./transactions";
import { computeBitcoinModel, windowTimeline, ORIGIN_BY_KEY, type OriginKey, type MemberSummary } from "../lib/bitcoin-portfolio";
import { NavIcon } from "./dashboard-ui";
import {
  euro, btc8, dateOf, GainPill, MemberAvatar, StatusBadge, BitcoinKpi, DonutChart, LegendRow,
  EvolutionChart, PeriodFilter, EmptyState, InfoNote, Accordion, type ChartSeries,
} from "./bitcoin-components";
import "./bitcoin-investments.css";

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

type BitcoinTab = "resume" | "membres" | "investir" | "conservation" | "performance" | "historique" | "comprendre";
const TAB_SLUGS: Record<BitcoinTab, string> = {
  resume: "resume", membres: "mes-btc", investir: "investir", conservation: "conservation",
  performance: "performance", historique: "historique", comprendre: "comprendre",
};
const SLUG_TO_TAB = Object.fromEntries(Object.entries(TAB_SLUGS).map(([tab, slug]) => [slug, tab])) as Record<string, BitcoinTab>;

function tabFromHash(): BitcoinTab | null {
  if (typeof window === "undefined") return null;
  const match = /#bitcoin\/([\w-]+)/.exec(window.location.hash);
  return match && SLUG_TO_TAB[match[1]] ? SLUG_TO_TAB[match[1]] : null;
}

const PERIOD_OPTIONS: { id: "1M" | "6M" | "1A" | "TOUT"; label: string }[] = [
  { id: "1M", label: "1M" }, { id: "6M", label: "6M" }, { id: "1A", label: "1A" }, { id: "TOUT", label: "Tout" },
];

export function BitcoinInvestmentPage({
  records, bitcoinEur, totalBtc, totalBitcoinValueEur, marketLoading, memberBalances, viewableMembers, transferRequests,
  transactions, transactionShortcut, transactionsReloadKey, viewer, isPreview, canManageGifts, canRecordPersonalBtc,
  openModal, openPersonalModal, onOpenMemberDetail, onTransferRequest, onRequestStatus,
}: {
  records: FamilyGiftRecord[];
  bitcoinEur: number | null;
  totalBtc: number;
  totalBitcoinValueEur: number | null;
  marketLoading: boolean;
  memberBalances: FamilyMemberBalance[];
  // Membres que le viewer a le droit de voir pour le BTC (partage familial par classe).
  // `null` = admin (toute la famille) ; sinon liste de noms renvoyée par /api/gifts.
  viewableMembers: string[] | null;
  transferRequests: TransferRequest[];
  transactions: TransactionRecord[];
  transactionShortcut: TransactionShortcut | null;
  transactionsReloadKey: number;
  viewer: Viewer;
  isPreview: boolean;
  canManageGifts: boolean;
  canRecordPersonalBtc: boolean;
  openModal: (source?: OriginKey) => void;
  openPersonalModal: () => void;
  onOpenMemberDetail: (member: string) => void;
  onTransferRequest: (transaction: TransactionRecord) => void;
  onRequestStatus: (id: string, status: TransferRequest["status"]) => void;
  onOpenTransactions: (shortcut: Omit<TransactionShortcut, "requestId">) => void;
}) {
  const isAdmin = viewer.role === "admin";
  const [tab, setTabState] = useState<BitcoinTab>(() => tabFromHash() ?? "resume");
  const [period, setPeriod] = useState<"1M" | "6M" | "1A" | "TOUT">("TOUT");
  const [memberFilter, setMemberFilter] = useState<string>("Tous");

  // L'onglet actif est conservé dans l'URL (#bitcoin/<slug>) : pas d'état fragile qui
  // ramène toujours sur Résumé au rafraîchissement.
  function setTab(next: BitcoinTab) {
    setTabState(next);
    if (typeof window !== "undefined") window.history.replaceState(null, "", `#bitcoin/${TAB_SLUGS[next]}`);
  }
  useEffect(() => {
    if (typeof window !== "undefined" && !window.location.hash.startsWith("#bitcoin/")) {
      window.history.replaceState(null, "", `#bitcoin/${TAB_SLUGS[tab]}`);
    }
    const onHash = () => { const next = tabFromHash(); if (next) setTabState(next); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pendingTransfers = useMemo(() => transferRequests.filter((request) => request.status !== "Transférée"), [transferRequests]);
  const pendingByMember = useMemo(() => {
    const map: Record<string, number> = {};
    for (const request of pendingTransfers) map[request.member] = (map[request.member] ?? 0) + 1;
    return map;
  }, [pendingTransfers]);

  // Périmètre "moi seul" : pilote tout le Résumé/Performance/Conservation/Investir — un
  // membre ne doit voir QUE son propre portefeuille dans ces écrans, jamais l'agrégat famille.
  const ownScope = useMemo(() => {
    if (isAdmin) return { records, memberBalances, totalBtc, totalValueEur: totalBitcoinValueEur };
    const sRecords = records.filter((record) => record.member_name === viewer.name);
    const sBalances = memberBalances.filter((balance) => balance.name === viewer.name);
    const sTotalBtc = sBalances.reduce((sum, balance) => sum + balance.btc, 0);
    const sTotalValue = sBalances.some((balance) => balance.currentValueEur !== null)
      ? sBalances.reduce((sum, balance) => sum + (balance.currentValueEur ?? 0), 0)
      : bitcoinEur !== null ? sTotalBtc * bitcoinEur : null;
    return { records: sRecords, memberBalances: sBalances, totalBtc: sTotalBtc, totalValueEur: sTotalValue };
  }, [isAdmin, viewer.name, records, memberBalances, totalBtc, totalBitcoinValueEur, bitcoinEur]);

  // Périmètre "partagé" : soi + les membres qui ont ouvert leur classe BTC au viewer (partage
  // familial par classe, renvoyé par /api/gifts). Sert UNIQUEMENT à la liste « Répartition par
  // membre » du Résumé — c'est le seul endroit où on montre les BTC d'un autre membre.
  // Repli sûr sur soi uniquement si la liste des membres partagés n'est pas disponible.
  const sharedScope = useMemo(() => {
    if (isAdmin) return { records, memberBalances, totalBtc, totalValueEur: totalBitcoinValueEur };
    const allowed = viewableMembers && viewableMembers.length > 0 ? new Set(viewableMembers) : new Set([viewer.name]);
    const sRecords = records.filter((record) => allowed.has(record.member_name));
    const sBalances = memberBalances.filter((balance) => allowed.has(balance.name));
    const sTotalBtc = sBalances.reduce((sum, balance) => sum + balance.btc, 0);
    const sTotalValue = sBalances.some((balance) => balance.currentValueEur !== null)
      ? sBalances.reduce((sum, balance) => sum + (balance.currentValueEur ?? 0), 0)
      : bitcoinEur !== null ? sTotalBtc * bitcoinEur : null;
    return { records: sRecords, memberBalances: sBalances, totalBtc: sTotalBtc, totalValueEur: sTotalValue };
  }, [isAdmin, viewer.name, viewableMembers, records, memberBalances, totalBtc, totalBitcoinValueEur, bitcoinEur]);

  const model = useMemo(() => computeBitcoinModel({
    records: ownScope.records, bitcoinEur, memberBalances: ownScope.memberBalances,
    totalBtc: ownScope.totalBtc, totalValueEur: ownScope.totalValueEur, pendingByMember,
  }), [ownScope, bitcoinEur, pendingByMember]);

  const memberBreakdown = useMemo(() => computeBitcoinModel({
    records: sharedScope.records, bitcoinEur, memberBalances: sharedScope.memberBalances,
    totalBtc: sharedScope.totalBtc, totalValueEur: sharedScope.totalValueEur, pendingByMember,
  }).members, [sharedScope, bitcoinEur, pendingByMember]);

  const pendingBtc = useMemo(() => pendingTransfers.reduce((sum, request) => sum + (request.btcAmount ?? 0), 0), [pendingTransfers]);
  const binanceKpiBtc = model.custody.binance.btc + model.custody.unclassified.btc;

  // L'onglet « Mes BTC » (détail par membre) ne subsiste que pour l'admin : côté membre il
  // faisait doublon avec le Résumé. Un membre qui arriverait sur ce slug (ancien lien) est
  // ramené au Résumé.
  const tabs: { id: BitcoinTab; label: string }[] = [
    { id: "resume", label: "Résumé" },
    ...(isAdmin ? [{ id: "membres" as BitcoinTab, label: "Détail par membre" }] : []),
    { id: "conservation", label: "Conservation" },
    { id: "performance", label: "Performance" },
    { id: "historique", label: "Historique" },
    { id: "comprendre", label: "Comprendre" },
    { id: "investir", label: "Investir" },
  ];
  const activeTab: BitcoinTab = tab === "membres" && !isAdmin ? "resume" : tab;

  const valueLabel = model.valueEur === null ? (marketLoading ? "Mise à jour…" : "Cours indisponible") : euro.format(model.valueEur);

  return (
    <div className="page-stack btc-page">
      {/* ---- Header commun à tous les onglets ---- */}
      <header className="btc-header">
        <div className="btc-header-lead">
          <span className="btc-logo" aria-hidden="true">₿</span>
          <div className="btc-header-copy">
            <div className="btc-header-titleline">
              <h1>Bitcoin</h1>
              <span className={`btc-role-pill ${isAdmin ? "admin" : "member"}`}>{isPreview ? `Aperçu ${viewer.name}` : isAdmin ? "Vue admin" : "Vue membre"}</span>
            </div>
            <p>Suivez vos BTC : cadeaux d’Amatxi, investissements personnels, conservation et performance.</p>
          </div>
        </div>
        <div className="btc-header-actions">
          {pendingTransfers.length > 0 && (
            <button type="button" className="btc-alert" onClick={() => setTab("conservation")}>
              <span className="btc-alert-dot" aria-hidden="true" />
              {pendingTransfers.length} transfert{pendingTransfers.length > 1 ? "s" : ""} en attente
            </button>
          )}
          {canManageGifts && (
            <button type="button" className="primary-button btc-cta" onClick={() => openModal()}><b>+</b> Enregistrer un achat BTC</button>
          )}
        </div>
      </header>

      <nav className="btc-tabs" aria-label="Sections Bitcoin">
        {tabs.map((item) => (
          <button key={item.id} type="button" className={activeTab === item.id ? "active" : ""} aria-current={activeTab === item.id ? "page" : undefined} onClick={() => setTab(item.id)}>
            {item.label}
          </button>
        ))}
      </nav>

      {activeTab === "resume" && (
        <ResumeTab
          model={model} memberBreakdown={memberBreakdown} valueLabel={valueLabel} bitcoinEur={bitcoinEur} marketLoading={marketLoading}
          pendingCount={pendingTransfers.length} pendingBtc={pendingBtc} binanceKpiBtc={binanceKpiBtc}
          period={period} setPeriod={setPeriod} isAdmin={isAdmin} onGoto={setTab}
        />
      )}

      {activeTab === "membres" && isAdmin && (
        <MembresTab model={model} memberFilter={memberFilter} setMemberFilter={setMemberFilter} onOpenMemberDetail={onOpenMemberDetail} onGoto={setTab} />
      )}

      {activeTab === "investir" && (
        <InvestirTab model={model} bitcoinEur={bitcoinEur} canManageGifts={canManageGifts} canRecordPersonalBtc={canRecordPersonalBtc} isPreview={isPreview} openModal={openModal} openPersonalModal={openPersonalModal} onGoto={setTab} />
      )}

      {activeTab === "conservation" && (
        <ConservationTab model={model} bitcoinEur={bitcoinEur} transferRequests={transferRequests} pendingTransfers={pendingTransfers} isAdmin={isAdmin} canManageGifts={canManageGifts} onRequestStatus={onRequestStatus} onGoto={setTab} />
      )}

      {activeTab === "performance" && (
        <PerformanceTab model={model} bitcoinEur={bitcoinEur} period={period} setPeriod={setPeriod} />
      )}

      {activeTab === "historique" && (
        <TransactionsView
          transactions={transactions} isAdmin={isAdmin} viewerName={viewer.name} onAdd={() => openModal()}
          onTransferRequest={onTransferRequest} onOpenPortfolio={(member) => onOpenMemberDetail(member)}
          shortcut={transactionShortcut} reloadKey={transactionsReloadKey}
        />
      )}

      {activeTab === "comprendre" && <ComprendreTab onGoto={setTab} />}
    </div>
  );
}

// ======================================================================================
// RÉSUMÉ
// ======================================================================================
function ResumeTab({ model, memberBreakdown, valueLabel, bitcoinEur, marketLoading, pendingCount, pendingBtc, binanceKpiBtc, period, setPeriod, isAdmin, onGoto }: {
  model: ReturnType<typeof computeBitcoinModel>; memberBreakdown: MemberSummary[]; valueLabel: string; bitcoinEur: number | null; marketLoading: boolean;
  pendingCount: number; pendingBtc: number; binanceKpiBtc: number;
  period: "1M" | "6M" | "1A" | "TOUT"; setPeriod: (value: "1M" | "6M" | "1A" | "TOUT") => void; isAdmin: boolean;
  onGoto: (tab: BitcoinTab) => void;
}) {
  const timeline = windowTimeline(model.timeline, period);
  const valueSeries: ChartSeries[] = [{ key: "value", label: "Valeur", color: "#1d706b", get: (point) => point.valueEur, fill: true }];
  const originSegments = model.origins.map((origin) => ({ label: origin.label, value: origin.btc, color: origin.color }));
  const custodySegments = [
    { label: "Sur Ledger", value: model.custody.ledger.btc, color: model.custody.ledger.color },
    { label: "Sur Binance", value: model.custody.binance.btc + model.custody.unclassified.btc, color: model.custody.binance.color },
  ];

  return (
    <>
      <div className="btc-hero-grid">
        <section className="btc-hero">
          <div className="btc-hero-copy">
            <span className="btc-eyebrow">VALEUR ACTUELLE TOTALE</span>
            <strong className="btc-hero-value">{valueLabel}</strong>
            <p className="btc-hero-btc">{btc8(model.totalBtc)}</p>
            <div className="btc-hero-gain"><GainPill eur={model.gainEur} pct={model.gainPct} muted={marketLoading} /></div>
            <small className="btc-hero-note">Depuis l’origine</small>
          </div>
          <div className="btc-hero-scene" aria-hidden="true" />
        </section>

        <div className="btc-kpi-grid">
          <BitcoinKpi label="MONTANT INVESTI" value={euro.format(model.investedEur)} sub="Coût d’achat historique" icon="wallet" tone="amber" />
          <BitcoinKpi label="PRIX ACTUEL DU BTC" value={bitcoinEur ? euro.format(bitcoinEur) : marketLoading ? "…" : "—"} sub="Cours en direct" icon="trending-up" tone="teal" />
          <BitcoinKpi label="PRIX MOYEN D’ACHAT" value={model.purchasedBtc > 0 ? euro.format(model.averagePrice) : "—"} sub="Par BTC" icon="landmark" tone="teal" />
          <BitcoinKpi label="SUR BINANCE" value={btc8(binanceKpiBtc)} sub="En attente de transfert" icon="wallet" tone="amber" />
          <BitcoinKpi label="SUR LEDGER" value={btc8(model.custody.ledger.btc)} sub="Transférés et sécurisés" icon="shield-check" tone="teal" />
          <BitcoinKpi label="TRANSFERTS EN ATTENTE" value={String(pendingCount)} sub={pendingCount > 0 ? `${btc8(pendingBtc)} vers Ledger` : "Vers Ledger"} icon="swap" tone="teal" action={isAdmin ? "Voir" : undefined} onAction={isAdmin ? () => onGoto("conservation") : undefined} />
        </div>
      </div>

      <div className="btc-allocation-grid">
        <section className="panel btc-alloc-card">
          <h3 className="btc-panel-kicker">RÉPARTITION PAR ORIGINE</h3>
          <div className="btc-alloc-body">
            <DonutChart segments={originSegments} centerTop={btc8(model.totalBtc).replace(" BTC", "")} centerBottom="BTC · Total" ariaLabel="Répartition par origine" />
            <ul className="btc-legend">
              {model.origins.map((origin) => (
                <LegendRow key={origin.key} color={origin.color} name={origin.label}
                  value={origin.count === 0 ? "Aucun pour l’instant" : `${btc8(origin.btc)}`}
                  pct={origin.count === 0 ? undefined : `${origin.pct.toFixed(1)} %`} />
              ))}
            </ul>
          </div>
          {isAdmin && <button type="button" className="btc-link" onClick={() => onGoto("membres")}>Voir le détail des origines →</button>}
        </section>

        <section className="panel btc-alloc-card">
          <h3 className="btc-panel-kicker">RÉPARTITION PAR MEMBRE</h3>
          <ul className="btc-member-mini">
            {memberBreakdown.map((member) => (
              <li key={member.name}>
                <MemberAvatar initials={member.initials} color={member.color} size={30} />
                <span className="btc-member-mini-name">{member.name}</span>
                <span className="btc-member-mini-bar"><i style={{ width: `${Math.max(2, member.pct)}%` }} /></span>
                <span className="btc-member-mini-btc">{btc8(member.btc)}</span>
                <span className="btc-member-mini-pct">{member.pct.toFixed(1)} %</span>
              </li>
            ))}
          </ul>
          {isAdmin && <button type="button" className="btc-link" onClick={() => onGoto("membres")}>Voir le détail par membre →</button>}
        </section>

        <section className="panel btc-alloc-card">
          <h3 className="btc-panel-kicker">RÉPARTITION PAR CONSERVATION</h3>
          <div className="btc-alloc-body">
            <DonutChart segments={custodySegments} centerTop={btc8(model.totalBtc).replace(" BTC", "")} centerBottom="BTC · Total" ariaLabel="Répartition par conservation" />
            <ul className="btc-legend">
              <LegendRow color={model.custody.ledger.color} name="Sur Ledger" value={btc8(model.custody.ledger.btc)} pct={`${model.custody.ledger.pct.toFixed(1)} %`} />
              <LegendRow color={model.custody.binance.color} name="Sur Binance" value={btc8(model.custody.binance.btc + model.custody.unclassified.btc)} pct={`${(model.custody.binance.pct + model.custody.unclassified.pct).toFixed(1)} %`} />
            </ul>
          </div>
          <button type="button" className="btc-link" onClick={() => onGoto("conservation")}>Voir la conservation →</button>
        </section>
      </div>

      <div className="btc-lower-grid">
        <section className="panel btc-chart-card">
          <header className="btc-chart-head">
            <h3 className="btc-panel-kicker">ÉVOLUTION DE LA VALEUR TOTALE</h3>
            <PeriodFilter value={period} options={PERIOD_OPTIONS} onChange={setPeriod} />
          </header>
          <EvolutionChart points={timeline} series={valueSeries} />
          <div className="btc-chart-foot">
            <div><small>Montant investi</small><strong>{euro.format(model.investedEur)}</strong></div>
            <div><small>Valeur actuelle</small><strong>{valueLabel}</strong></div>
            <div><small>Plus / moins-value</small><strong className={model.gainEur === null ? "" : model.gainEur >= 0 ? "up" : "down"}><GainPill eur={model.gainEur} pct={model.gainPct} /></strong></div>
          </div>
        </section>

        <section className="panel btc-ops-card">
          <header className="btc-ops-head">
            <h3 className="btc-panel-kicker">DERNIÈRES OPÉRATIONS BITCOIN</h3>
            <button type="button" className="btc-link" onClick={() => onGoto("historique")}>Voir toutes les opérations →</button>
          </header>
          <OperationList operations={model.operations.slice(0, 5)} />
        </section>
      </div>

      <InfoNote title="Bon à savoir" action="Comprendre pourquoi" onAction={() => onGoto("comprendre")}>
        Les cadeaux d’Amatxi sont une façon unique d’investir ensemble dans le temps. Continuez à épargner régulièrement !
      </InfoNote>
    </>
  );
}

function OperationList({ operations, onOpen }: { operations: ReturnType<typeof computeBitcoinModel>["operations"]; onOpen?: (member: string) => void }) {
  if (operations.length === 0) return <EmptyState icon="🎁" title="Aucune opération pour l’instant" description="Les cadeaux et achats Bitcoin apparaîtront ici dès leur enregistrement." />;
  return (
    <ul className="btc-ops">
      {operations.map((op) => {
        const icon: string = op.custody === "Ledger" ? "🛡️" : op.origin === "cadeau_amatxi" ? "🎁" : op.origin === "investissement_personnel" ? "📈" : "👥";
        const place = op.custody === "Ledger" ? "Ledger" : op.custody === "À classer" ? "À classer" : "Binance";
        return (
          <li
            key={op.key}
            className={onOpen ? "clickable" : undefined}
            role={onOpen ? "button" : undefined}
            tabIndex={onOpen ? 0 : undefined}
            aria-label={onOpen ? `Voir les opérations de ${op.member}` : undefined}
            onClick={onOpen ? () => onOpen(op.member) : undefined}
            onKeyDown={onOpen ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(op.member); } } : undefined}
          >
            <span className="btc-ops-mark" aria-hidden="true">{icon}</span>
            <div className="btc-ops-info"><strong>{op.label}</strong><small>{op.member}</small></div>
            <div className="btc-ops-amount"><b>+{op.btcAmount.toFixed(8)} BTC</b><small>{euro.format(op.amountEur)}</small></div>
            <div className="btc-ops-meta"><span>{place}</span><time>{dateOf(op.date)}</time></div>
          </li>
        );
      })}
    </ul>
  );
}

// ======================================================================================
// MES BTC / MEMBRES
// ======================================================================================
function MembresTab({ model, memberFilter, setMemberFilter, onOpenMemberDetail, onGoto }: {
  model: ReturnType<typeof computeBitcoinModel>;
  memberFilter: string; setMemberFilter: (value: string) => void;
  onOpenMemberDetail: (member: string) => void; onGoto: (tab: BitcoinTab) => void;
}) {
  const filters = ["Tous", ...model.members.map((member) => member.name)];
  const shownMembers = memberFilter === "Tous" ? model.members : model.members.filter((member) => member.name === memberFilter);
  const shownLots = memberFilter === "Tous" ? model.lots : model.lots.filter((lot) => lot.member === memberFilter);

  return (
    <>
      <section className="panel btc-synth">
        <h3 className="btc-panel-kicker">SYNTHÈSE GLOBALE</h3>
        <div className="btc-synth-grid">
          <div><small>Total BTC</small><strong>{btc8(model.totalBtc)}</strong></div>
          <div><small>Valeur actuelle</small><strong>{model.valueEur === null ? "—" : euro.format(model.valueEur)}</strong></div>
          <div><small>Coût investi</small><strong>{euro.format(model.investedEur)}</strong></div>
          <div><small>Plus / moins-value</small><strong className={model.gainEur === null ? "" : model.gainEur >= 0 ? "up" : "down"}><GainPill eur={model.gainEur} pct={model.gainPct} /></strong></div>
          <div><small>Membres concernés</small><strong>{model.memberCount}</strong></div>
        </div>
      </section>

      <div className="btc-filter-bar" role="group" aria-label="Filtrer par membre">
        {filters.map((name) => (
          <button key={name} type="button" className={memberFilter === name ? "active" : ""} onClick={() => setMemberFilter(name)}>{name}</button>
        ))}
      </div>

      <div className="btc-member-cards">
        {shownMembers.map((member) => (
          <MemberCard key={member.name} member={member} onOpen={() => onOpenMemberDetail(member.name)} />
        ))}
      </div>

      <section className="panel table-panel btc-table-card">
        <h3 className="btc-panel-kicker">DÉTAIL DES LOTS BITCOIN</h3>
        <div className="responsive-table">
          <table className="btc-table">
            <thead>
              <tr><th>Membre</th><th>Origine</th><th>Date</th><th>BTC</th><th>Coût</th><th>Valeur</th><th>Perf.</th><th>Conservation</th></tr>
            </thead>
            <tbody>
              {shownLots.map((lot) => (
                <tr key={lot.id}>
                  <td data-label="Membre"><strong>{lot.member}</strong></td>
                  <td data-label="Origine"><span className="btc-origin-tag" style={{ color: ORIGIN_BY_KEY[lot.origin].color }}>● {ORIGIN_BY_KEY[lot.origin].short}</span></td>
                  <td data-label="Date">{dateOf(lot.date)}</td>
                  <td data-label="BTC" className="num">{lot.btc.toFixed(8)}</td>
                  <td data-label="Coût" className="num">{euro.format(lot.investedEur)}</td>
                  <td data-label="Valeur" className="num">{lot.currentValueEur === null ? "—" : euro.format(lot.currentValueEur)}</td>
                  <td data-label="Perf." className="num">{lot.gainPct === null ? "—" : <span className={lot.gainPct >= 0 ? "up" : "down"}>{lot.gainPct >= 0 ? "+" : ""}{lot.gainPct.toFixed(1)} %</span>}</td>
                  <td data-label="Conservation"><StatusBadge status={lot.custody === "Ledger" ? "confirmé" : lot.custody === "À classer" ? "à préparer" : "en attente"} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {shownLots.length === 0 && <EmptyState title="Aucun lot" description="Aucun lot Bitcoin pour ce filtre." />}
      </section>

      <InfoNote title="Comprendre les origines" action="En savoir plus" onAction={() => onGoto("comprendre")}>
        Chaque lot indique d’où vient le Bitcoin (cadeau d’Amatxi, investissement personnel ou achat groupé), où il est conservé et sa performance actuelle.
      </InfoNote>
    </>
  );
}

function MemberCard({ member, onOpen }: { member: MemberSummary; onOpen: () => void }) {
  return (
    <article className="btc-member-card">
      <header>
        <MemberAvatar initials={member.initials} color={member.color} size={40} />
        <div className="btc-member-card-id">
          <strong>{member.name}</strong>
          <small>{member.topOrigin ? ORIGIN_BY_KEY[member.topOrigin].label : "—"}</small>
        </div>
        {member.pending > 0 && <span className="btc-member-card-flag">{member.pending} transfert{member.pending > 1 ? "s" : ""}</span>}
      </header>
      <p className="btc-member-card-value">{member.valueEur === null ? btc8(member.btc) : euro.format(member.valueEur)}</p>
      <div className="btc-member-card-bar"><i style={{ width: `${Math.max(2, member.pct)}%`, background: `var(--btc-member-${member.color})` }} /></div>
      <dl>
        <div><dt>Quantité</dt><dd>{member.btc.toFixed(8)} BTC</dd></div>
        <div><dt>Coût</dt><dd>{euro.format(member.investedEur)}</dd></div>
        <div><dt>Performance</dt><dd className={member.gainEur === null ? "" : member.gainEur >= 0 ? "up" : "down"}>{member.gainPct === null ? "—" : `${member.gainPct >= 0 ? "+" : ""}${member.gainPct.toFixed(1)} %`}</dd></div>
        <div><dt>Binance</dt><dd>{member.binanceBtc.toFixed(8)}</dd></div>
        <div><dt>Ledger</dt><dd>{member.ledgerBtc.toFixed(8)}</dd></div>
      </dl>
      <button type="button" className="secondary-button btc-member-card-btn" onClick={onOpen}>Voir le détail →</button>
    </article>
  );
}

// ======================================================================================
// INVESTIR
// ======================================================================================
function InvestirTab({ model, bitcoinEur, canManageGifts, canRecordPersonalBtc, isPreview, openModal, openPersonalModal, onGoto }: {
  model: ReturnType<typeof computeBitcoinModel>; bitcoinEur: number | null;
  canManageGifts: boolean; canRecordPersonalBtc: boolean; isPreview: boolean;
  openModal: (source?: OriginKey) => void; openPersonalModal: () => void; onGoto: (tab: BitcoinTab) => void;
}) {
  // Ni l'admin (registre famille), ni un membre autorisé à saisir son propre achat
  // (aperçu / rôle en lecture seule) → écran verrouillé.
  if (!canManageGifts && !canRecordPersonalBtc) {
    return (
      <section className="panel">
        <EmptyState icon="🔒" title={isPreview ? "Aperçu en lecture seule" : "Les achats sont gérés par l’administrateur"}
          description="Seul l’administrateur enregistre les opérations Bitcoin (cadeaux d’Amatxi, investissements personnels, achats groupés). Vous pouvez suivre l’ensemble de vos BTC dans l’onglet « Résumé »."
          action="Voir le résumé" onAction={() => onGoto("resume")} />
      </section>
    );
  }

  // L'admin gère les trois origines du registre familial ; le membre n'enregistre
  // que ses propres achats personnels (origine forcée côté serveur).
  const parcours: { source: OriginKey; icon: string; title: string; desc: string }[] = [
    { source: "investissement_personnel", icon: "📈", title: "Achat personnel", desc: "Un achat financé par le membre lui-même, suivi séparément des cadeaux." },
    { source: "cadeau_amatxi", icon: "🎁", title: "Cadeau d’Amatxi", desc: "Un cadeau offert par la famille (anniversaire, Noël)." },
    { source: "achat_groupe", icon: "👥", title: "Achat groupé / autre", desc: "Un achat partagé entre plusieurs membres, ou une autre origine." },
  ];

  return (
    <>
      <section className="panel btc-invest-head">
        <div className="btc-invest-intro">
          <span className="soft-pill">INVESTIR</span>
          <h2>{canManageGifts ? "Enregistrer une opération Bitcoin" : "Enregistrer mon investissement"}</h2>
          <p>{canManageGifts
            ? "Choisissez le type d’opération : le formulaire guidé s’adapte et écrit directement dans le registre familial. Aucun faux succès : l’enregistrement n’est confirmé qu’après réponse du serveur."
            : "Enregistrez vous-même un achat de Bitcoin que vous avez financé. Il est suivi séparément (origine : personnel) et apparaît dans votre Résumé Bitcoin. L’enregistrement n’est confirmé qu’après réponse du serveur."}</p>
        </div>
        <div className="btc-invest-price">
          <div><small>Prix actuel du BTC</small><strong>{bitcoinEur ? euro.format(bitcoinEur) : "—"}</strong></div>
          <div><small>{canManageGifts ? "Prix moyen d’achat famille" : "Mon prix moyen d’achat"}</small><strong>{model.purchasedBtc > 0 ? euro.format(model.averagePrice) : "—"}</strong></div>
        </div>
      </section>

      <div className="btc-parcours-grid">
        {canManageGifts ? parcours.map((item) => (
          <button key={item.source} type="button" className="btc-parcours-card" onClick={() => openModal(item.source)}>
            <span className="btc-parcours-icon" aria-hidden="true">{item.icon}</span>
            <strong>{item.title}</strong>
            <p>{item.desc}</p>
            <span className="btc-parcours-cta">Enregistrer →</span>
          </button>
        )) : (
          <button type="button" className="btc-parcours-card" onClick={openPersonalModal}>
            <span className="btc-parcours-icon" aria-hidden="true">📈</span>
            <strong>Achat personnel</strong>
            <p>Un achat de Bitcoin que vous avez financé vous-même : valeur d’achat, prix du BTC, quantité et lieu de conservation (Ledger ou non).</p>
            <span className="btc-parcours-cta">Enregistrer →</span>
          </button>
        )}
      </div>

      <section className="panel btc-ops-card">
        <header className="btc-ops-head">
          <h3 className="btc-panel-kicker">{canManageGifts ? "DERNIÈRES OPÉRATIONS ENREGISTRÉES" : "MES DERNIÈRES OPÉRATIONS"}</h3>
          <button type="button" className="btc-link" onClick={() => onGoto("historique")}>Voir l’historique →</button>
        </header>
        <OperationList operations={model.operations.slice(0, 5)} />
      </section>
    </>
  );
}

// ======================================================================================
// CONSERVATION
// ======================================================================================
function ConservationTab({ model, bitcoinEur, transferRequests, pendingTransfers, isAdmin, canManageGifts, onRequestStatus, onGoto }: {
  model: ReturnType<typeof computeBitcoinModel>; bitcoinEur: number | null;
  transferRequests: TransferRequest[]; pendingTransfers: TransferRequest[]; isAdmin: boolean; canManageGifts: boolean;
  onRequestStatus: (id: string, status: TransferRequest["status"]) => void; onGoto: (tab: BitcoinTab) => void;
}) {
  const binanceBtc = model.custody.binance.btc + model.custody.unclassified.btc;
  const binanceMembers = model.members.filter((member) => member.binanceBtc > 0);
  const ledgerMembers = model.members.filter((member) => member.ledgerBtc > 0);

  return (
    <>
      <section className="panel btc-synth">
        <h3 className="btc-panel-kicker">OÙ SONT LES BITCOINS DE LA FAMILLE ?</h3>
        <div className="btc-synth-grid">
          <div><small>Sur Binance</small><strong>{btc8(binanceBtc)}</strong></div>
          <div><small>Sur Ledger</small><strong>{btc8(model.custody.ledger.btc)}</strong></div>
          <div><small>En transfert</small><strong>{pendingTransfers.length}</strong></div>
          <div><small>Sécurisé hors plateforme</small><strong className={model.custody.securedPct >= 50 ? "up" : ""}>{model.custody.securedPct.toFixed(0)} %</strong></div>
        </div>
      </section>

      <div className="btc-flow" aria-hidden="true">
        <span className="btc-flow-node binance">Binance<b>{btc8(binanceBtc)}</b></span>
        <span className="btc-flow-arrow">→ <em>{pendingTransfers.length} en attente</em> →</span>
        <span className="btc-flow-node ledger">Ledger<b>{btc8(model.custody.ledger.btc)}</b></span>
      </div>

      <div className="btc-custody-grid">
        <section className="panel btc-custody-card">
          <header><span className="btc-custody-badge binance" aria-hidden="true">◆</span><div><strong>Binance</strong><small>Plateforme tierce · en attente de transfert</small></div></header>
          <p className="btc-custody-value">{btc8(binanceBtc)}<span>{bitcoinEur ? euro.format(binanceBtc * bitcoinEur) : ""}</span></p>
          <div className="btc-custody-bar"><i className="binance" style={{ width: `${model.custody.binance.pct + model.custody.unclassified.pct}%` }} /></div>
          <small className="btc-custody-pct">{(model.custody.binance.pct + model.custody.unclassified.pct).toFixed(1)} % du total · {model.custody.binance.count + model.custody.unclassified.count} lot(s)</small>
          <ul className="btc-custody-members">
            {binanceMembers.length === 0 ? <li className="muted">Aucun membre concerné.</li> : binanceMembers.map((member) => (
              <li key={member.name}><MemberAvatar initials={member.initials} color={member.color} size={24} /><span>{member.name}</span><b>{member.binanceBtc.toFixed(8)} BTC</b></li>
            ))}
          </ul>
          {canManageGifts && <button type="button" className="secondary-button" onClick={() => onGoto("membres")}>Préparer un transfert</button>}
        </section>

        <section className="panel btc-custody-card">
          <header><span className="btc-custody-badge ledger" aria-hidden="true"><NavIcon id="shield-check" /></span><div><strong>Ledger</strong><small>Portefeuille personnel · clés détenues par la famille</small></div></header>
          <p className="btc-custody-value">{btc8(model.custody.ledger.btc)}<span>{bitcoinEur ? euro.format(model.custody.ledger.btc * bitcoinEur) : ""}</span></p>
          <div className="btc-custody-bar"><i className="ledger" style={{ width: `${model.custody.ledger.pct}%` }} /></div>
          <small className="btc-custody-pct">{model.custody.ledger.pct.toFixed(1)} % du total · {model.custody.ledger.count} lot(s)</small>
          <ul className="btc-custody-members">
            {ledgerMembers.length === 0 ? <li className="muted">Aucun membre concerné.</li> : ledgerMembers.map((member) => (
              <li key={member.name}><MemberAvatar initials={member.initials} color={member.color} size={24} /><span>{member.name}</span><b>{member.ledgerBtc.toFixed(8)} BTC</b></li>
            ))}
          </ul>
          <div className="btc-custody-secure"><NavIcon id="shield-check" /> {model.custody.securedPct.toFixed(0)} % du portefeuille sécurisé hors plateforme</div>
        </section>
      </div>

      <section className="panel">
        <h3 className="btc-panel-kicker">TRANSFERTS BINANCE → LEDGER</h3>
        {transferRequests.length === 0 ? (
          <EmptyState icon="🛡️" title="Aucun transfert en attente" description="Tout le Bitcoin transférable est déjà sécurisé sur Ledger, ou aucune demande n’a encore été faite. Les demandes des membres apparaîtront ici." />
        ) : (
          <ul className="btc-transfer-list">
            {transferRequests.map((request) => (
              <li key={request.id} className="btc-transfer-item">
                <div className="btc-transfer-lead">
                  <span className="btc-transfer-icon" aria-hidden="true"><NavIcon id="swap" /></span>
                  <div><strong>{request.member}</strong><small>{request.btcAmount ? `${request.btcAmount.toFixed(8)} BTC` : "Montant à confirmer"} · {request.requestedAt}</small></div>
                </div>
                <div className="btc-transfer-route"><span>Binance</span><b>→</b><span>Ledger</span></div>
                {isAdmin ? (
                  <select className="btc-transfer-select" value={request.status} onChange={(event) => onRequestStatus(request.id, event.target.value as TransferRequest["status"])}>
                    <option>Nouvelle</option><option>En traitement</option><option>Transférée</option>
                  </select>
                ) : (
                  <StatusBadge status={request.status} />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <InfoNote title="Binance vs Ledger" action="Comprendre" onAction={() => onGoto("comprendre")}>
        Le Ledger est un portefeuille personnel : vous seuls détenez les clés. Binance est une plateforme tierce ; on y conserve les BTC en attendant de les transférer sur Ledger pour les sécuriser.
      </InfoNote>
    </>
  );
}

// ======================================================================================
// PERFORMANCE
// ======================================================================================
function PerformanceTab({ model, bitcoinEur, period, setPeriod }: {
  model: ReturnType<typeof computeBitcoinModel>; bitcoinEur: number | null;
  period: "1M" | "6M" | "1A" | "TOUT"; setPeriod: (value: "1M" | "6M" | "1A" | "TOUT") => void;
}) {
  const [seriesKey, setSeriesKey] = useState<"value" | "invested" | "price">("value");
  const timeline = windowTimeline(model.timeline, period);
  const seriesMap: Record<typeof seriesKey, ChartSeries[]> = {
    value: [
      { key: "value", label: "Valeur", color: "#1d706b", get: (point) => point.valueEur, fill: true },
      { key: "invested", label: "Investi", color: "#5a9bd4", get: (point) => point.investedEur, dashed: true },
    ],
    invested: [{ key: "invested", label: "Investi", color: "#5a9bd4", get: (point) => point.investedEur, fill: true }],
    price: [{ key: "price", label: "Prix BTC", color: "#f0a63a", get: (point) => (point.btc > 0 ? point.valueEur / point.btc : 0), fill: true }],
  };

  const byOrigin = model.origins.filter((origin) => origin.count > 0);
  const bestLot = model.lots.filter((lot) => lot.gainPct !== null).sort((a, b) => (b.gainPct ?? 0) - (a.gainPct ?? 0))[0];
  const worstLot = model.lots.filter((lot) => lot.gainPct !== null).sort((a, b) => (a.gainPct ?? 0) - (b.gainPct ?? 0))[0];

  return (
    <>
      <section className="panel btc-synth">
        <h3 className="btc-panel-kicker">PERFORMANCE GLOBALE</h3>
        <div className="btc-synth-grid btc-synth-6">
          <div><small>Valeur actuelle</small><strong>{model.valueEur === null ? "—" : euro.format(model.valueEur)}</strong></div>
          <div><small>Montant investi</small><strong>{euro.format(model.investedEur)}</strong></div>
          <div><small>Plus / moins-value</small><strong className={model.gainEur === null ? "" : model.gainEur >= 0 ? "up" : "down"}><GainPill eur={model.gainEur} pct={model.gainPct} /></strong></div>
          <div><small>Rendement global</small><strong className={model.gainPct === null ? "" : model.gainPct >= 0 ? "up" : "down"}>{model.gainPct === null ? "—" : `${model.gainPct >= 0 ? "+" : ""}${model.gainPct.toFixed(1)} %`}</strong></div>
          <div><small>Prix moyen d’achat</small><strong>{model.purchasedBtc > 0 ? euro.format(model.averagePrice) : "—"}</strong></div>
          <div><small>Prix actuel BTC</small><strong>{bitcoinEur ? euro.format(bitcoinEur) : "—"}</strong></div>
        </div>
      </section>

      <section className="panel btc-chart-card">
        <header className="btc-chart-head">
          <div className="btc-series-tabs" role="group" aria-label="Choisir la donnée affichée">
            <button type="button" className={seriesKey === "value" ? "active" : ""} onClick={() => setSeriesKey("value")}>Valeur & investi</button>
            <button type="button" className={seriesKey === "invested" ? "active" : ""} onClick={() => setSeriesKey("invested")}>Montant investi</button>
            <button type="button" className={seriesKey === "price" ? "active" : ""} onClick={() => setSeriesKey("price")}>Prix BTC</button>
          </div>
          <PeriodFilter value={period} options={PERIOD_OPTIONS} onChange={setPeriod} />
        </header>
        <EvolutionChart points={timeline} series={seriesMap[seriesKey]} />
        <p className="btc-chart-source">Valeur reconstruite à partir des prix d’achat réels de chaque cadeau et du cours en direct (CoinGecko/Kraken). Aucune donnée fictive.</p>
      </section>

      <div className="btc-analyse-grid">
        <section className="panel">
          <h3 className="btc-panel-kicker">PERFORMANCE PAR MEMBRE</h3>
          <ul className="btc-analyse-list">
            {model.members.filter((member) => member.btc > 0).map((member) => (
              <li key={member.name}>
                <MemberAvatar initials={member.initials} color={member.color} size={28} />
                <span className="btc-analyse-name">{member.name}</span>
                <span className="btc-analyse-val">{member.valueEur === null ? "—" : euro.format(member.valueEur)}</span>
                <span className={`btc-analyse-perf ${member.gainEur === null ? "" : member.gainEur >= 0 ? "up" : "down"}`}>{member.gainPct === null ? "—" : `${member.gainPct >= 0 ? "+" : ""}${member.gainPct.toFixed(1)} %`}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="panel">
          <h3 className="btc-panel-kicker">PERFORMANCE PAR ORIGINE</h3>
          <ul className="btc-analyse-list">
            {byOrigin.length === 0 ? <li className="muted">Aucune origine renseignée.</li> : byOrigin.map((origin) => {
              const gain = origin.valueEur === null ? null : origin.valueEur - origin.investedEur;
              const gainPct = gain === null || origin.investedEur <= 0 ? null : (gain / origin.investedEur) * 100;
              return (
                <li key={origin.key}>
                  <span className="btc-legend-dot" style={{ background: origin.color }} aria-hidden="true" />
                  <span className="btc-analyse-name">{origin.label}</span>
                  <span className="btc-analyse-val">{origin.valueEur === null ? "—" : euro.format(origin.valueEur)}</span>
                  <span className={`btc-analyse-perf ${gain === null ? "" : gain >= 0 ? "up" : "down"}`}>{gainPct === null ? "—" : `${gainPct >= 0 ? "+" : ""}${gainPct.toFixed(1)} %`}</span>
                </li>
              );
            })}
          </ul>
          {(bestLot || worstLot) && (
            <div className="btc-extremes">
              {bestLot && <div><small>Meilleur point d’entrée</small><strong className="up">{bestLot.member} · {dateOf(bestLot.date)}{bestLot.gainPct !== null ? ` · ${bestLot.gainPct >= 0 ? "+" : ""}${bestLot.gainPct.toFixed(1)} %` : ""}</strong></div>}
              {worstLot && worstLot.id !== bestLot?.id && <div><small>Point d’entrée le plus haut</small><strong className={worstLot.gainPct !== null && worstLot.gainPct < 0 ? "down" : ""}>{worstLot.member} · {dateOf(worstLot.date)}{worstLot.gainPct !== null ? ` · ${worstLot.gainPct >= 0 ? "+" : ""}${worstLot.gainPct.toFixed(1)} %` : ""}</strong></div>}
            </div>
          )}
        </section>
      </div>

      <section className="panel table-panel btc-table-card">
        <h3 className="btc-panel-kicker">DÉTAIL PAR LOT</h3>
        <div className="responsive-table">
          <table className="btc-table">
            <thead><tr><th>Date</th><th>Membre</th><th>Origine</th><th>BTC</th><th>Prix d’achat</th><th>Prix actuel</th><th>Perf. €</th><th>Perf. %</th></tr></thead>
            <tbody>
              {model.lots.map((lot) => (
                <tr key={lot.id}>
                  <td data-label="Date">{dateOf(lot.date)}</td>
                  <td data-label="Membre"><strong>{lot.member}</strong></td>
                  <td data-label="Origine"><span className="btc-origin-tag" style={{ color: ORIGIN_BY_KEY[lot.origin].color }}>● {ORIGIN_BY_KEY[lot.origin].short}</span></td>
                  <td data-label="BTC" className="num">{lot.btc.toFixed(8)}</td>
                  <td data-label="Prix d’achat" className="num">{lot.purchasePrice === null ? "—" : euro.format(lot.purchasePrice)}</td>
                  <td data-label="Prix actuel" className="num">{bitcoinEur ? euro.format(bitcoinEur) : "—"}</td>
                  <td data-label="Perf. €" className="num">{lot.gainEur === null ? "—" : <span className={lot.gainEur >= 0 ? "up" : "down"}>{lot.gainEur >= 0 ? "+" : ""}{euro.format(lot.gainEur)}</span>}</td>
                  <td data-label="Perf. %" className="num">{lot.gainPct === null ? "—" : <span className={lot.gainPct >= 0 ? "up" : "down"}>{lot.gainPct >= 0 ? "+" : ""}{lot.gainPct.toFixed(1)} %</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {model.lots.length === 0 && <EmptyState title="Aucun lot" description="Aucune opération à analyser pour l’instant." />}
      </section>
    </>
  );
}

// ======================================================================================
// COMPRENDRE
// ======================================================================================
function ComprendreTab({ onGoto }: { onGoto: (tab: BitcoinTab) => void }) {
  const faq = [
    { id: "btc", question: "Qu’est-ce que le Bitcoin ?", answer: "Une monnaie numérique décentralisée. On peut en recevoir en cadeau ou en acheter, puis la conserver dans un portefeuille sécurisé. Sa valeur évolue selon l’offre et la demande." },
    { id: "why", question: "Pourquoi la famille en détient-elle ?", answer: "Pour apprendre à investir tôt, ensemble et sur le long terme. Les cadeaux d’Amatxi transforment chaque anniversaire et chaque Noël en une petite épargne qui grandit avec le temps." },
    { id: "binance-ledger", question: "Différence entre Binance et Ledger", answer: "Binance est une plateforme d’échange (un tiers garde vos BTC). Ledger est un portefeuille personnel dont vous seuls détenez les clés : c’est le moyen le plus sûr de conserver ses bitcoins sur le long terme." },
    { id: "pru", question: "Qu’est-ce qu’un prix moyen d’achat ?", answer: "C’est la moyenne pondérée de tous les prix payés pour vos BTC (montant total investi ÷ BTC achetés). Il sert de référence pour calculer votre plus-value." },
    { id: "perf", question: "Comment calculons-nous la performance ?", answer: "Valeur actuelle = BTC détenu × cours du jour. Plus-value = valeur actuelle − montant investi. Le pourcentage rapporte cette plus-value au montant investi." },
    { id: "transfer", question: "Que signifie un transfert en attente ?", answer: "Un BTC acheté sur Binance qui n’a pas encore été envoyé vers le Ledger. Tant qu’il est « en attente », il reste sur la plateforme ; une fois « transféré », il est sécurisé hors plateforme." },
    { id: "gift-vs-perso", question: "Différence entre cadeau et investissement personnel", answer: "Un cadeau d’Amatxi est offert par la famille. Un investissement personnel est un achat financé par le membre lui-même. Les deux sont suivis séparément par origine." },
    { id: "security", question: "Bonnes pratiques de sécurité", answer: "L’adresse publique se partage librement ; la phrase de récupération (24 mots) et la clé privée ne se partagent JAMAIS. Un Ledger protège vos clés hors ligne." },
  ];
  const glossary = [
    { term: "BTC", def: "Unité du Bitcoin (1 BTC = 100 000 000 satoshis)." },
    { term: "Wallet", def: "Portefeuille qui stocke vos clés Bitcoin." },
    { term: "Exchange", def: "Plateforme d’achat/vente (ex. Binance)." },
    { term: "Clé privée", def: "Secret qui prouve la propriété des BTC. Jamais partagée." },
    { term: "Ledger", def: "Portefeuille matériel gardant les clés hors ligne." },
    { term: "Plus-value", def: "Gain entre le prix d’achat et la valeur actuelle." },
    { term: "Prix moyen", def: "Coût moyen pondéré de tous vos achats." },
    { term: "Transfert", def: "Envoi de BTC d’un portefeuille vers un autre." },
  ];
  return (
    <>
      <section className="btc-learn-head">
        <span className="soft-pill">COMPRENDRE</span>
        <h2>Le Bitcoin de la famille, expliqué simplement.</h2>
        <p>Des réponses courtes aux questions les plus utiles pour suivre vos BTC sereinement.</p>
      </section>

      <div className="btc-comprendre-grid">
        <section className="panel"><Accordion items={faq} /></section>
        <aside className="btc-comprendre-side">
          <section className="panel btc-glossary">
            <h3 className="btc-panel-kicker">GLOSSAIRE</h3>
            <dl>
              {glossary.map((item) => (<div key={item.term}><dt>{item.term}</dt><dd>{item.def}</dd></div>))}
            </dl>
          </section>
          <InfoNote title="Envie de suivre vos chiffres ?" action="Voir la performance" onAction={() => onGoto("performance")}>
            Retrouvez votre plus-value, votre prix moyen d’achat et l’évolution de la valeur dans l’onglet Performance.
          </InfoNote>
        </aside>
      </div>
    </>
  );
}
