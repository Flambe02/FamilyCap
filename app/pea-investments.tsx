"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { Viewer } from "../lib/auth-types";
import { supabaseBrowser } from "../lib/supabase-browser";
import { useDialogA11y } from "./use-dialog-a11y";
import {
  euro, euro0, dateOf, GainPill, BitcoinKpi, DonutChart, LegendRow,
  EvolutionChart, PeriodFilter, EmptyState, InfoNote, type ChartSeries,
} from "./bitcoin-components";
import {
  computeAccountModel, windowAccountTimeline, supportedRanges, priceKeyOf,
  type AccountModel, type AccountOperation, type AccountOperationType, type InstrumentPrice,
} from "../lib/portfolio-account";
import "./pea-investments.css";

// ---- Types d'entrée (formes renvoyées par /api/portfolio) --------------------------------
export type PeaAccount = { id: string; name: string; institution?: string | null; accountType: string; currency: string; memberId?: string; memberName: string | null };
export type PeaHolding = { account_id: string; asset_type?: string | null; name?: string | null; symbol?: string | null; isin?: string | null; quantity: number; average_cost: number | null; last_price: number | null; last_price_at?: string | null; currency: string };
export type PeaOperation = AccountOperation;

type PeaTab = "resume" | "positions" | "investir" | "revenus" | "performance" | "historique" | "comprendre";
const TAB_SLUGS: Record<PeaTab, string> = {
  resume: "resume", positions: "positions", investir: "investir", revenus: "revenus",
  performance: "performance", historique: "historique", comprendre: "comprendre",
};
const SLUG_TO_TAB = Object.fromEntries(Object.entries(TAB_SLUGS).map(([tab, slug]) => [slug, tab])) as Record<string, PeaTab>;

function tabFromHash(): PeaTab | null {
  if (typeof window === "undefined") return null;
  const match = /#pea\/([\w-]+)/.exec(window.location.hash);
  return match && SLUG_TO_TAB[match[1]] ? SLUG_TO_TAB[match[1]] : null;
}

const qty = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 4 });
const todayISO = () => new Date().toISOString().slice(0, 10);

const OP_LABEL: Record<AccountOperationType, string> = {
  achat: "Achat", vente: "Vente", versement: "Versement", retrait: "Retrait",
  dividende: "Dividende", frais: "Frais", correction: "Correction",
};
const OP_ICON: Record<AccountOperationType, string> = {
  achat: "📈", vente: "📉", versement: "➕", retrait: "➖", dividende: "💶", frais: "🧾", correction: "✏️",
};
// Signe du mouvement de trésorerie affiché.
const OP_INFLOW: Record<AccountOperationType, boolean> = {
  versement: true, vente: true, dividende: true, achat: false, retrait: false, frais: false, correction: true,
};

async function authenticatedFetch(url: string, init: RequestInit = {}) {
  const { data } = await supabaseBrowser.auth.getSession();
  return fetch(url, { ...init, headers: { ...init.headers, ...(data.session ? { authorization: "Bearer " + data.session.access_token } : {}) } });
}

// ==========================================================================================
export function PeaInvestmentPage({
  accounts, holdings, operations, marketLoading, viewer, isPreview, canManage, onReload, onConfigure,
}: {
  accounts: PeaAccount[];
  holdings: PeaHolding[];
  operations: PeaOperation[];
  marketLoading: boolean;
  viewer: Viewer;
  isPreview: boolean;
  canManage: boolean;
  onReload: () => void;
  onConfigure: () => void;
}) {
  const isAdmin = viewer.role === "admin";
  const [tab, setTabState] = useState<PeaTab>(() => tabFromHash() ?? "resume");
  const [range, setRange] = useState<"1M" | "3M" | "6M" | "1A" | "3A" | "TOUT">("TOUT");
  const [modal, setModal] = useState<{ open: boolean; type: AccountOperationType }>({ open: false, type: "achat" });
  const [notice, setNotice] = useState("");

  function setTab(next: PeaTab) {
    setTabState(next);
    if (typeof window !== "undefined") window.history.replaceState(null, "", `#pea/${TAB_SLUGS[next]}`);
  }
  useEffect(() => {
    if (typeof window !== "undefined" && !window.location.hash.startsWith("#pea/")) {
      window.history.replaceState(null, "", `#pea/${TAB_SLUGS[tab]}`);
    }
    const onHash = () => { const next = tabFromHash(); if (next) setTabState(next); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(""), 3200); return () => window.clearTimeout(timer); }, [notice]);

  // Comptes PEA visibles. Le partage familial est déjà appliqué côté serveur ; en vue membre
  // (et en aperçu d'un membre par l'admin, où les données sont chargées avec le périmètre admin),
  // on restreint au membre affiché — cohérent avec la vue Bitcoin « limitée à soi ».
  const peaAccounts = useMemo(
    () => accounts.filter((account) => account.accountType === "pea" && (isAdmin || account.memberName === viewer.name)),
    [accounts, isAdmin, viewer.name],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = peaAccounts.find((account) => account.id === selectedId) ?? peaAccounts[0] ?? null;

  const accountOps = useMemo(() => (selected ? operations.filter((op) => op.accountId === selected.id) : []), [operations, selected]);
  const priceByKey = useMemo(() => {
    const map = new Map<string, InstrumentPrice>();
    if (!selected) return map;
    for (const holding of holdings.filter((item) => item.account_id === selected.id)) {
      map.set(priceKeyOf({ isin: holding.isin ?? null, symbol: holding.symbol ?? null, name: holding.name ?? null }), {
        lastPrice: holding.last_price, lastPriceAt: holding.last_price_at ?? null, assetType: holding.asset_type ?? null, name: holding.name ?? null,
      });
    }
    return map;
  }, [holdings, selected]);

  const model = useMemo(
    () => (selected ? computeAccountModel({ operations: accountOps, priceByKey, accountType: "PEA", today: todayISO() }) : null),
    [selected, accountOps, priceByKey],
  );

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

  // ---- États de bord ----
  const loading = marketLoading && accounts.length === 0 && operations.length === 0;
  const tabs: { id: PeaTab; label: string }[] = [
    { id: "resume", label: "Résumé" }, { id: "positions", label: "Mes positions" }, { id: "investir", label: "Investir" },
    { id: "revenus", label: "Revenus" }, { id: "performance", label: "Performance" }, { id: "historique", label: "Historique" },
    { id: "comprendre", label: "Comprendre" },
  ];

  return (
    <div className="page-stack pea-page">
      <header className="btc-header pea-header">
        <div className="btc-header-lead">
          <span className="btc-logo pea-logo" aria-hidden="true">₧</span>
          <div className="btc-header-copy">
            <div className="btc-header-titleline">
              <h1>PEA{selected ? ` de ${selected.memberName ?? selected.name}` : ""}</h1>
              <span className={`btc-role-pill ${isAdmin ? "admin" : "member"}`}>{isPreview ? `Aperçu ${viewer.name}` : isAdmin ? "Vue admin" : "Vue membre"}</span>
              {peaAccounts.length > 1 && (
                <label className="pea-account-select">
                  <span className="sr-only">Choisir le compte PEA</span>
                  <select value={selected?.id ?? ""} onChange={(event) => setSelectedId(event.target.value)}>
                    {peaAccounts.map((account) => (
                      <option key={account.id} value={account.id}>{account.memberName ?? account.name}{account.institution ? ` · ${account.institution}` : ""}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <p>Suivez le Plan d’Épargne en Actions : valeur, positions, versements réguliers et performance — calculés à partir de vos opérations réelles.</p>
          </div>
        </div>
        <div className="btc-header-actions">
          {canManage && selected && (
            <button type="button" className="primary-button btc-cta" onClick={() => setModal({ open: true, type: "achat" })}><b>+</b> Enregistrer une opération</button>
          )}
        </div>
      </header>

      <nav className="btc-tabs" aria-label="Sections PEA">
        {tabs.map((item) => (
          <button key={item.id} type="button" className={tab === item.id ? "active" : ""} aria-current={tab === item.id ? "page" : undefined} onClick={() => setTab(item.id)}>{item.label}</button>
        ))}
      </nav>

      {loading ? (
        <PeaSkeleton />
      ) : !selected ? (
        <section className="panel">
          <EmptyState icon="🏦" title="Aucun PEA n’est encore configuré pour ce membre."
            description="Un administrateur peut créer un compte PEA depuis Administration › Comptes & positions. Les opérations et positions apparaîtront ensuite ici."
            action={canManage ? "Configurer le PEA" : undefined} onAction={canManage ? onConfigure : undefined} />
        </section>
      ) : !model!.hasOperations ? (
        <section className="panel">
          <EmptyState icon="📄" title="Le PEA est configuré, mais aucune opération n’a encore été enregistrée."
            description="Enregistrez un versement, un achat d’ETF ou d’actions : la valeur, le prix de revient et la performance se calculeront automatiquement à partir de ces opérations."
            action={canManage ? "Enregistrer la première opération" : undefined} onAction={canManage ? () => setModal({ open: true, type: "versement" }) : undefined} />
        </section>
      ) : (
        <>
          {tab === "resume" && (
            <ResumeTab model={model!} account={selected} range={range} setRange={setRange} canManage={canManage} marketLoading={marketLoading}
              onGoto={setTab} onAddInvestment={() => setModal({ open: true, type: "versement" })}
              onReport={() => setNotice("Le report sera enregistré dans une prochaine version. Saisissez le versement le moment venu.")} recent={accountOps} />
          )}
          {tab === "positions" && <PositionsTab model={model!} />}
          {tab === "historique" && <HistoriqueTab operations={accountOps} accountName={selected.name} />}
          {tab === "revenus" && <RevenusTab model={model!} operations={accountOps} />}
          {tab === "investir" && <InvestirTab model={model!} canManage={canManage} onAdd={(type) => setModal({ open: true, type })} />}
          {tab === "performance" && (
            <section className="panel"><EmptyState icon="📊" title="Analyse de performance à venir" description="Le suivi de performance avancé (TWR, comparaison par période et par ligne) arrivera dans un prochain lot. La performance depuis l’origine reste visible sur l’onglet Résumé." action="Voir le Résumé" onAction={() => setTab("resume")} /></section>
          )}
          {tab === "comprendre" && <ComprendreTab />}
        </>
      )}

      {modal.open && canManage && selected && (
        <PeaOperationModal account={selected} defaultType={modal.type}
          onClose={() => setModal((current) => ({ ...current, open: false }))}
          onSubmit={submitOperation}
          onSaved={() => { setModal((current) => ({ ...current, open: false })); setNotice("Opération enregistrée."); onReload(); }} />
      )}
      {notice && <div className="toast" role="status">✓ {notice}</div>}
    </div>
  );
}

// ==========================================================================================
// RÉSUMÉ
// ==========================================================================================
function ResumeTab({ model, account, range, setRange, canManage, marketLoading, onGoto, onAddInvestment, onReport, recent }: {
  model: AccountModel; account: PeaAccount; range: "1M" | "3M" | "6M" | "1A" | "3A" | "TOUT";
  setRange: (value: "1M" | "3M" | "6M" | "1A" | "3A" | "TOUT") => void; canManage: boolean; marketLoading: boolean;
  onGoto: (tab: PeaTab) => void; onAddInvestment: () => void; onReport: () => void; recent: PeaOperation[];
}) {
  const ranges = supportedRanges(model.timeline);
  const activeRange = ranges.includes(range) ? range : "TOUT";
  const points = windowAccountTimeline(model.timeline, activeRange).map((point) => ({ ...point, btc: 0 }));
  const valueSeries: ChartSeries[] = [{ key: "value", label: "Valeur", color: "#1d706b", get: (point) => point.valueEur, fill: true }];
  const rangeOptions = ranges.map((id) => ({ id, label: id === "TOUT" ? "Tout" : id }));

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
            <small className="btc-hero-note">Depuis l’origine ({startLabel})</small>
          </div>
          <div className="btc-hero-scene" aria-hidden="true" />
        </section>

        <div className="btc-kpi-grid">
          <BitcoinKpi label="MONTANT NET INVESTI" value={euro.format(model.netInvestedEur)} sub="Versements − retraits" icon="wallet" tone="amber" />
          <BitcoinKpi label="PRIX DE REVIENT MOYEN" value={model.averageBookPrice === null ? "Non disponible" : euro.format(model.averageBookPrice)} sub="Par part / action" icon="landmark" tone="teal" />
          <BitcoinKpi label="PLUS / MOINS-VALUE" value={model.unrealizedGainEur === null ? "Cours non disponible" : <GainPill eur={model.unrealizedGainEur} pct={model.unrealizedGainPct} />} sub="Sur les positions détenues" icon="trending-up" tone="teal" />
          <BitcoinKpi label="DIVIDENDES REÇUS" value={euro.format(model.dividendsNetEur)} sub="Net, depuis l’origine" icon="sprout" tone="teal" />
          <BitcoinKpi label="ESPÈCES DISPONIBLES" value={euro.format(model.cashEur)} sub="À investir" icon="bell" tone="blue" />
          <BitcoinKpi label="PERFORMANCE DEPUIS L’ORIGINE" value={model.performancePct === null ? "Non disponible" : `${model.performancePct >= 0 ? "+" : ""}${model.performancePct.toFixed(2).replace(".", ",")} %`} sub="Valeur / net investi" icon="trending-up" tone="teal" />
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
                    <small>{position.ticker ?? position.isin ?? "—"}</small>
                  </div>
                  <span className="pea-top-weight">{position.currentValueEur === null ? "—" : `${position.weightPct.toFixed(1)} %`}</span>
                  <span className="pea-top-value">{position.currentValueEur === null ? "Cours indispo." : euro.format(position.currentValueEur)}</span>
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="btc-link" onClick={() => onGoto("positions")}>Voir toutes les positions →</button>
        </section>

        <section className="panel btc-alloc-card">
          <h3 className="btc-panel-kicker">RÉPARTITION GÉOGRAPHIQUE</h3>
          <EmptyState icon="🌍" title="Bientôt disponible" description="La répartition géographique sera disponible lorsque les informations des actifs auront été complétées." />
        </section>
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

        <section className="panel pea-regular">
          <h3 className="btc-panel-kicker">INVESTISSEMENT RÉGULIER</h3>
          <div className="pea-regular-head">
            <div><small>Objectif mensuel</small><strong>À compléter</strong></div>
            <div><small>Déjà investi ({model.monthly.monthLabel})</small><strong>{euro.format(model.monthly.investedThisMonth)}</strong></div>
          </div>
          <div className="pea-regular-status">
            <span className={`pea-status pea-status-${model.monthly.status}`}>
              {model.monthly.status === "investi" ? "Investi ce mois" : model.monthly.status === "partiellement_investi" ? "Partiellement investi" : model.monthly.status === "reporté" ? "Reporté" : "À investir"}
            </span>
            <small>L’objectif mensuel sera configurable dans un prochain lot ; la progression est calculée à partir des versements réels.</small>
          </div>
          {canManage && (
            <div className="pea-regular-actions">
              <button type="button" className="primary-button" onClick={onAddInvestment}>Enregistrer un investissement</button>
              <button type="button" className="secondary-button" onClick={onReport}>Reporter ce mois</button>
            </div>
          )}
        </section>
      </div>

      <section className="panel btc-ops-card">
        <header className="btc-ops-head">
          <h3 className="btc-panel-kicker">DERNIÈRES OPÉRATIONS</h3>
          <button type="button" className="btc-link" onClick={() => onGoto("historique")}>Voir tout →</button>
        </header>
        <OperationList operations={recent.slice(0, 5)} accountName={account.name} />
      </section>

      <InfoNote title="Comment lisons-nous votre PEA ?" action="Comprendre" onAction={() => onGoto("comprendre")}>
        Chaque chiffre est calculé à partir de vos opérations réelles (versements, achats, ventes, dividendes). Le prix de revient utilise la moyenne pondérée. Aucune donnée n’est inventée : si un cours manque, la valeur est signalée comme indisponible.
      </InfoNote>
    </>
  );
}

function OperationList({ operations, accountName }: { operations: PeaOperation[]; accountName: string }) {
  if (operations.length === 0) return <EmptyState icon="🧾" title="Aucune opération" description="Les opérations enregistrées apparaîtront ici." />;
  return (
    <ul className="btc-ops">
      {operations.map((op) => {
        const inflow = OP_INFLOW[op.type];
        const amount = op.netAmount ?? op.grossAmount ?? (op.quantity && op.unitPrice ? op.quantity * op.unitPrice : 0);
        return (
          <li key={op.id}>
            <span className="btc-ops-mark" aria-hidden="true">{OP_ICON[op.type]}</span>
            <div className="btc-ops-info"><strong>{OP_LABEL[op.type]}{op.assetName ? ` · ${op.assetName}` : ""}</strong><small>{accountName}</small></div>
            <div className="btc-ops-amount">
              <b className={inflow ? "" : "pea-out"}>{inflow ? "+" : "−"}{euro.format(Math.abs(Number(amount) || 0))}</b>
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
function PositionsTab({ model }: { model: AccountModel }) {
  return (
    <section className="panel table-panel btc-table-card">
      <h3 className="btc-panel-kicker">DÉTAIL DES POSITIONS</h3>
      {model.positions.length === 0 ? (
        <EmptyState title="Aucune position" description="Aucune position détenue à ce jour." />
      ) : (
        <div className="responsive-table">
          <table className="btc-table">
            <thead>
              <tr><th>Actif</th><th>Type</th><th>Ticker / ISIN</th><th>Quantité</th><th>Prix de revient</th><th>Cours</th><th>Valeur</th><th>Poids</th><th>Perf.</th></tr>
            </thead>
            <tbody>
              {model.positions.map((position) => (
                <tr key={position.key}>
                  <td data-label="Actif"><strong>{position.name}</strong></td>
                  <td data-label="Type">{position.assetClass === "etf" ? "ETF" : position.assetClass === "action" ? "Action" : position.assetClass === "obligation" ? "Obligation" : position.assetClass === "fonds" ? "Fonds" : "Autre"}</td>
                  <td data-label="Ticker / ISIN">{position.ticker ?? position.isin ?? "—"}</td>
                  <td data-label="Quantité" className="num">{qty.format(position.quantity)}</td>
                  <td data-label="Prix de revient" className="num">{position.averageCost === null ? "—" : euro.format(position.averageCost)}</td>
                  <td data-label="Cours" className="num">{position.lastPrice === null ? "Indispo." : euro.format(position.lastPrice)}</td>
                  <td data-label="Valeur" className="num">{position.currentValueEur === null ? "—" : euro.format(position.currentValueEur)}</td>
                  <td data-label="Poids" className="num">{position.currentValueEur === null ? "—" : `${position.weightPct.toFixed(1)} %`}</td>
                  <td data-label="Perf." className="num">{position.gainPct === null ? "—" : <span className={position.gainPct >= 0 ? "up" : "down"}>{position.gainPct >= 0 ? "+" : ""}{position.gainPct.toFixed(1)} %</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {model.unpricedPositions > 0 && <p className="btc-chart-source">{model.unpricedPositions} position(s) sans cours à jour : leur valeur n’est pas comptée dans le total. Renseignez le cours dans Administration › Comptes & positions.</p>}
    </section>
  );
}

// ==========================================================================================
// HISTORIQUE
// ==========================================================================================
function HistoriqueTab({ operations, accountName }: { operations: PeaOperation[]; accountName: string }) {
  const sorted = [...operations].sort((a, b) => b.date.localeCompare(a.date));
  return (
    <section className="panel table-panel btc-table-card">
      <h3 className="btc-panel-kicker">HISTORIQUE DES OPÉRATIONS</h3>
      {sorted.length === 0 ? (
        <EmptyState title="Aucune opération" description="Aucune opération enregistrée sur ce compte." />
      ) : (
        <div className="responsive-table">
          <table className="btc-table">
            <thead>
              <tr><th>Date</th><th>Type</th><th>Actif</th><th>Quantité</th><th>Prix</th><th>Frais</th><th>Montant net</th><th>Compte</th></tr>
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
                  <td data-label="Compte">{accountName}</td>
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
function RevenusTab({ model, operations }: { model: AccountModel; operations: PeaOperation[] }) {
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
          <EmptyState icon="💶" title="Aucun dividende enregistré" description="Les dividendes reçus apparaîtront ici dès leur saisie." />
        ) : (
          <ul className="btc-ops">
            {dividends.map((op) => (
              <li key={op.id}>
                <span className="btc-ops-mark" aria-hidden="true">💶</span>
                <div className="btc-ops-info"><strong>{op.assetName ?? "Dividende"}</strong><small>{op.ticker ?? op.isin ?? ""}</small></div>
                <div className="btc-ops-amount"><b>+{euro.format(Math.abs(Number(op.netAmount ?? op.grossAmount ?? 0)))}</b><small>net</small></div>
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
function InvestirTab({ model, canManage, onAdd }: { model: AccountModel; canManage: boolean; onAdd: (type: AccountOperationType) => void }) {
  if (!canManage) {
    return (
      <section className="panel">
        <EmptyState icon="🔒" title="Les opérations sont gérées par l’administrateur"
          description="Seul l’administrateur enregistre les opérations du PEA (versements, achats, ventes, dividendes). Vous pouvez suivre la valeur et les positions dans les onglets Résumé et Mes positions." />
      </section>
    );
  }
  const cards: { type: AccountOperationType; icon: string; title: string; desc: string }[] = [
    { type: "versement", icon: "➕", title: "Versement", desc: "Un apport d’espèces sur le PEA (alimente la trésorerie disponible)." },
    { type: "achat", icon: "📈", title: "Achat", desc: "Achat d’un ETF ou d’une action : quantité, prix unitaire et frais." },
    { type: "vente", icon: "📉", title: "Vente", desc: "Vente d’une position : quantité, prix unitaire et frais." },
    { type: "dividende", icon: "💶", title: "Dividende", desc: "Un dividende reçu (montant net)." },
    { type: "retrait", icon: "➖", title: "Retrait", desc: "Un retrait d’espèces du PEA." },
    { type: "frais", icon: "🧾", title: "Frais", desc: "Des frais de tenue de compte ou de courtage isolés." },
  ];
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
        {cards.map((card) => (
          <button key={card.type} type="button" className="btc-parcours-card" onClick={() => onAdd(card.type)}>
            <span className="btc-parcours-icon" aria-hidden="true">{card.icon}</span>
            <strong>{card.title}</strong>
            <p>{card.desc}</p>
            <span className="btc-parcours-cta">Enregistrer →</span>
          </button>
        ))}
      </div>
    </>
  );
}

// ==========================================================================================
// COMPRENDRE
// ==========================================================================================
function ComprendreTab() {
  const items = [
    { q: "Qu’est-ce qu’un PEA ?", a: "Le Plan d’Épargne en Actions est une enveloppe qui permet d’investir en actions et ETF européens avec une fiscalité avantageuse après 5 ans." },
    { q: "Comment est calculée la valeur ?", a: "Valeur = somme (quantité détenue × cours actuel) + espèces disponibles. Si un cours manque, la position est signalée « cours non disponible » plutôt qu’estimée." },
    { q: "Qu’est-ce que le prix de revient moyen ?", a: "C’est la moyenne pondérée de tous vos achats (frais inclus) rapportée à la quantité détenue. Il sert de référence pour la plus ou moins-value." },
    { q: "Comment lisons-nous la performance ?", a: "« Depuis l’origine » = valeur totale actuelle − montant net investi (versements − retraits). Nous n’affichons pas de TWR/IRR tant qu’ils ne sont pas réellement calculés." },
  ];
  return (
    <section className="panel">
      <div className="pea-faq">
        {items.map((item) => (
          <div key={item.q} className="pea-faq-item"><strong>{item.q}</strong><p>{item.a}</p></div>
        ))}
      </div>
    </section>
  );
}

// ==========================================================================================
// SKELETON
// ==========================================================================================
function PeaSkeleton() {
  return (
    <div className="pea-skeleton" aria-hidden="true">
      <div className="pea-skeleton-hero" />
      <div className="pea-skeleton-kpis">{Array.from({ length: 6 }).map((_, index) => <div key={index} className="pea-skeleton-card" />)}</div>
      <div className="pea-skeleton-row">{Array.from({ length: 3 }).map((_, index) => <div key={index} className="pea-skeleton-block" />)}</div>
    </div>
  );
}

// ==========================================================================================
// MODALE D'OPÉRATION (admin)
// ==========================================================================================
function PeaOperationModal({ account, defaultType, onClose, onSubmit, onSaved }: {
  account: PeaAccount; defaultType: AccountOperationType;
  onClose: () => void; onSubmit: (payload: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>; onSaved: () => void;
}) {
  const dialogRef = useDialogA11y(true, onClose);
  const [type, setType] = useState<AccountOperationType>(defaultType);
  const [date, setDate] = useState(todayISO());
  const [assetName, setAssetName] = useState("");
  const [ticker, setTicker] = useState("");
  const [isin, setIsin] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unitPrice, setUnitPrice] = useState("");
  const [amount, setAmount] = useState("");
  const [fees, setFees] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const needsAsset = type === "achat" || type === "vente" || type === "dividende" || type === "correction";
  const needsQtyPrice = type === "achat" || type === "vente";
  const needsAmount = type === "versement" || type === "retrait" || type === "frais" || type === "dividende";
  const needsQtyOnly = type === "correction";

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");
    const payload: Record<string, unknown> = {
      accountId: account.id, type, date,
      assetName: needsAsset ? assetName.trim() || undefined : undefined,
      ticker: needsAsset ? ticker.trim() || undefined : undefined,
      isin: needsAsset ? isin.trim() || undefined : undefined,
      quantity: needsQtyPrice || needsQtyOnly ? Number(quantity) : undefined,
      unitPrice: needsQtyPrice ? Number(unitPrice) : undefined,
      netAmount: needsAmount ? Number(amount) : undefined,
      fees: fees ? Number(fees) : undefined,
      note: note.trim() || undefined,
    };
    setSaving(true);
    const result = await onSubmit(payload);
    setSaving(false);
    if (!result.ok) { setError(result.error ?? "Enregistrement impossible."); return; }
    onSaved();
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => !saving && event.target === event.currentTarget && onClose()}>
      <section className="modal pea-modal" ref={dialogRef} role="dialog" aria-modal="true" aria-label="Enregistrer une opération PEA" tabIndex={-1}>
        <header className="pea-modal-head">
          <div><span className="soft-pill">PEA · {account.memberName ?? account.name}</span><h2>Enregistrer une opération</h2></div>
          <button type="button" className="pea-modal-close" onClick={onClose} aria-label="Fermer">×</button>
        </header>
        <form className="pea-form" onSubmit={handleSubmit}>
          <label className="pea-field">
            <span>Type d’opération</span>
            <select value={type} onChange={(event) => setType(event.target.value as AccountOperationType)}>
              <option value="versement">Versement</option>
              <option value="achat">Achat</option>
              <option value="vente">Vente</option>
              <option value="dividende">Dividende</option>
              <option value="retrait">Retrait</option>
              <option value="frais">Frais</option>
              <option value="correction">Correction</option>
            </select>
          </label>
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
            <label className="pea-field"><span>Prix unitaire (€)</span><input type="number" step="any" min="0" value={unitPrice} onChange={(event) => setUnitPrice(event.target.value)} required /></label>
          )}
          {needsAmount && (
            <label className="pea-field"><span>Montant{type === "dividende" ? " net" : ""} (€)</span><input type="number" step="any" min="0" value={amount} onChange={(event) => setAmount(event.target.value)} required /></label>
          )}
          {(needsQtyPrice || type === "frais") && (
            <label className="pea-field"><span>Frais (€)</span><input type="number" step="any" min="0" value={fees} onChange={(event) => setFees(event.target.value)} /></label>
          )}
          <label className="pea-field pea-field-wide"><span>Note (facultatif)</span><input value={note} onChange={(event) => setNote(event.target.value)} /></label>
          {error && <p className="pea-form-error" role="alert">{error}</p>}
          <div className="pea-form-actions">
            <button type="button" className="secondary-button" onClick={onClose}>Annuler</button>
            <button type="submit" className="primary-button" disabled={saving}>{saving ? "Enregistrement…" : "Enregistrer"}</button>
          </div>
        </form>
      </section>
    </div>
  );
}
