"use client";

// ONGLET DIVIDENDES — écran unique, partagé à l'identique par le PEA et le compte-titres.
//
// Il répond à cinq questions, dans cet ordre et en moins de trois secondes :
//   combien vais-je recevoir · combien ai-je déjà reçu · quand · confirmé ou estimé · qui paie.
//
// TOUT LE CALCUL EST FAIT CÔTÉ SERVEUR (lib/dividend-engine.ts, via
// /api/investment-accounts/:id/dividends). Ce composant n'additionne rien : il met en forme. C'est
// ce qui garantit que le total, la moyenne mensuelle et le rendement viennent de la MÊME fenêtre —
// l'écran précédent en additionnait trois différentes, et sa moyenne ne pouvait pas se recouper
// avec son total.
//
// Trois statuts, jamais distingués par la seule couleur : chacun a son libellé, sa texture et son
// badge — exigence d'accessibilité autant que de lisibilité.

import { useCallback, useEffect, useMemo, useState } from "react";
import { authenticatedFetch } from "./investment-shared";
import { EmptyState, dateOf } from "./bitcoin-components";
import { money } from "./positions-list";
import { confidenceLabel } from "../lib/dividend-projection";
import type {
  DividendContributor, DividendEntry, DividendModel, DividendPositionDetail, DividendStatus,
} from "../lib/dividend-engine";

type ProviderState = { name: string; role: string; configured: boolean };

type DividendPayload = {
  account: { id: string; name: string; accountType: "PEA" | "CTO"; currency: string };
  accounts: Array<{ id: string; name: string }>;
  model: DividendModel;
  instruments: Array<{ assetId: string; name: string; isin: string | null; providerSymbol: string | null; resolutionStatus: string; distributionPolicy: string; lastSyncedAt: string | null }>;
  unresolved: Array<{ name: string; isin: string | null; ticker: string | null }>;
  lastSyncedAt: string | null;
  providers: ProviderState[];
};

type WindowChoice = "next12m" | "current_year" | "previous_year";

const WINDOW_OPTIONS: Array<{ id: WindowChoice; label: string }> = [
  { id: "next12m", label: "12 prochains mois" },
  { id: "current_year", label: "Année en cours" },
  { id: "previous_year", label: "Année précédente" },
];

const STATUS_LABEL: Record<DividendStatus, string> = {
  received: "Reçu",
  announced: "Annoncé",
  estimated: "Estimé",
  unavailable: "Indisponible",
};

const MONTHS_LONG = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const monthLong = (monthKey: string) => `${MONTHS_LONG[Number(monthKey.slice(5, 7)) - 1] ?? monthKey} ${monthKey.slice(0, 4)}`;

function stamp(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

// ==========================================================================================
// Onglet
// ==========================================================================================
export function DividendsTab({ accountIds, canManage }: { accountIds: string[]; canManage: boolean }) {
  const [windowChoice, setWindowChoice] = useState<WindowChoice>("next12m");
  const [includeForecast, setIncludeForecast] = useState(true);
  const [basis, setBasis] = useState<"gross" | "net">("gross");
  const [payload, setPayload] = useState<DividendPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"overview" | "positions" | "calendar">("overview");
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const scope = accountIds.join(",");
  const primaryId = accountIds[0] ?? "";

  useEffect(() => {
    if (!primaryId) {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);
    const query = new URLSearchParams({ accountIds: scope, window: windowChoice, includeForecast: includeForecast ? "1" : "0" });
    authenticatedFetch(`/api/investment-accounts/${encodeURIComponent(primaryId)}/dividends?${query.toString()}`)
      .then(async (response) => {
        const data = (await response.json().catch(() => ({}))) as DividendPayload & { error?: string };
        if (!active) return;
        if (!response.ok) {
          setError(data.error ?? "Les dividendes n’ont pas pu être chargés.");
          setPayload(null);
        } else {
          setPayload(data);
          setError(null);
        }
      })
      .catch(() => {
        if (active) {
          setError("Réseau indisponible : les dividendes n’ont pas pu être chargés.");
          setPayload(null);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [primaryId, scope, windowChoice, includeForecast, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  async function synchronise() {
    if (!primaryId) return;
    setSyncing(true);
    setSyncMessage(null);
    try {
      const response = await authenticatedFetch(`/api/investment-accounts/${encodeURIComponent(primaryId)}/dividends/sync?accountIds=${encodeURIComponent(scope)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resolveSymbols: true }),
      });
      const data = (await response.json().catch(() => ({}))) as { message?: string; error?: string };
      setSyncMessage(response.ok ? data.message ?? "Synchronisation terminée." : data.error ?? "Synchronisation impossible.");
      if (response.ok) reload();
    } catch {
      setSyncMessage("Réseau indisponible : rien n’a été modifié.");
    } finally {
      setSyncing(false);
    }
  }

  const model = payload?.model ?? null;
  const currency = payload?.account.currency ?? "EUR";
  const netAvailable = model?.tax.netAvailable === true;
  const effectiveBasis: "gross" | "net" = netAvailable ? basis : "gross";
  const amountOf = useCallback(
    (entry: DividendEntry) => (effectiveBasis === "net" ? entry.netReference ?? entry.grossReference : entry.grossReference),
    [effectiveBasis],
  );

  if (loading && !payload) {
    return <section className="panel dv-loading"><p className="inv-muted">Chargement des dividendes…</p></section>;
  }
  if (error) {
    return (
      <section className="panel">
        <EmptyState icon="⚠️" title="Dividendes indisponibles" description={error} action="Réessayer" onAction={reload} />
      </section>
    );
  }
  if (!payload || !model) {
    return (
      <section className="panel">
        <EmptyState icon="💶" title="Aucun compte sélectionné" description="Choisissez un compte pour consulter ses dividendes." />
      </section>
    );
  }

  if (view === "positions") {
    return <PositionsView payload={payload} currency={currency} onBack={() => setView("overview")} />;
  }
  if (view === "calendar") {
    return <CalendarView model={model} currency={currency} amountOf={amountOf} basis={effectiveBasis} onBack={() => setView("overview")} />;
  }

  const noDistributing = model.coverage.totalInstruments > 0
    && model.coverage.accumulating === model.coverage.totalInstruments;

  return (
    <>
      <DividendHeader
        payload={payload}
        windowChoice={windowChoice}
        onWindow={setWindowChoice}
        includeForecast={includeForecast}
        onIncludeForecast={setIncludeForecast}
        basis={effectiveBasis}
        onBasis={setBasis}
        netAvailable={netAvailable}
        canManage={canManage}
        syncing={syncing}
        onSync={synchronise}
        syncMessage={syncMessage}
      />

      <DividendNotices payload={payload} />

      {model.coverage.totalInstruments === 0 ? (
        <section className="panel">
          <EmptyState icon="📄" title="Aucune position dans ce compte"
            description="Les dividendes se calculent à partir des titres réellement détenus. Enregistrez une première opération d’achat pour voir apparaître les échéances." />
        </section>
      ) : noDistributing ? (
        <section className="panel">
          <EmptyState icon="🌱" title="Aucun dividende en espèces attendu"
            description="Toutes les positions de ce compte sont capitalisantes : les revenus sont réinvestis dans le fonds au lieu d’être versés." />
        </section>
      ) : (
        <>
          <div className="dv-kpi-row">
            <ExpectedCard model={model} currency={currency} basis={effectiveBasis} />
            <ReceivedCard model={model} currency={currency} />
            <YieldCard model={model} />
          </div>

          <div className="dv-grid">
            <section className="panel dv-chart-panel">
              <header className="dv-panel-head">
                <h3 className="btc-panel-kicker">REVENUS PAR MOIS</h3>
                <ChartLegend />
              </header>
              <MonthlyChart model={model} currency={currency} basis={effectiveBasis} />
              <p className="btc-chart-source">{model.tax.note}</p>
            </section>

            <section className="panel dv-next-panel">
              <header className="dv-panel-head">
                <h3 className="btc-panel-kicker">PROCHAINS VERSEMENTS</h3>
              </header>
              <UpcomingList entries={model.upcoming} currency={currency} amountOf={amountOf} basis={effectiveBasis} />
              {model.upcoming.length > 0 && (
                <button type="button" className="btc-link dv-more" onClick={() => setView("calendar")}>
                  Voir tout le calendrier →
                </button>
              )}
            </section>
          </div>

          <section className="panel dv-contributors-panel">
            <header className="dv-panel-head">
              <h3 className="btc-panel-kicker">PRINCIPAUX CONTRIBUTEURS</h3>
              <small className="inv-muted">{model.window.label}</small>
            </header>
            <Contributors contributors={model.contributors} currency={currency} />
            <button type="button" className="btc-link dv-more" onClick={() => setView("positions")}>
              Voir toutes les positions →
            </button>
          </section>
        </>
      )}
    </>
  );
}

// ==========================================================================================
// En-tête
// ==========================================================================================
function DividendHeader({
  payload, windowChoice, onWindow, includeForecast, onIncludeForecast, basis, onBasis, netAvailable,
  canManage, syncing, onSync, syncMessage,
}: {
  payload: DividendPayload;
  windowChoice: WindowChoice;
  onWindow: (value: WindowChoice) => void;
  includeForecast: boolean;
  onIncludeForecast: (value: boolean) => void;
  basis: "gross" | "net";
  onBasis: (value: "gross" | "net") => void;
  netAvailable: boolean;
  canManage: boolean;
  syncing: boolean;
  onSync: () => void;
  syncMessage: string | null;
}) {
  const synced = stamp(payload.lastSyncedAt);
  return (
    <section className="panel dv-header">
      <div className="dv-header-id">
        <h2>Dividendes</h2>
        <p>
          {payload.accounts.length > 1 ? `${payload.accounts.length} comptes` : payload.account.name}
          {" · "}
          {payload.model.window.label}
        </p>
      </div>
      <div className="dv-header-controls">
        <label className="inv-select">
          <span className="sr-only">Période</span>
          <select value={windowChoice} onChange={(event) => onWindow(event.target.value as WindowChoice)}>
            {WINDOW_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
        </label>

        {/* Le sélecteur Brut / Net estimé n'apparaît QUE si un profil fiscal permet de calculer un
            net. Sans profil, proposer « net » reviendrait à inventer une fiscalité. */}
        {netAvailable && (
          <div className="inv-toggle" role="group" aria-label="Base de calcul">
            <button type="button" className={basis === "gross" ? "active" : ""} onClick={() => onBasis("gross")}>Brut</button>
            <button type="button" className={basis === "net" ? "active" : ""} onClick={() => onBasis("net")}>Net estimé</button>
          </div>
        )}

        <label className="dv-switch">
          <input type="checkbox" checked={includeForecast} onChange={(event) => onIncludeForecast(event.target.checked)} />
          <span className="dv-switch-track" aria-hidden="true"><i /></span>
          <span className="dv-switch-label">Inclure les projections</span>
        </label>

        {canManage && (
          <button type="button" className="secondary-button dv-refresh" disabled={syncing} onClick={onSync}>
            {syncing ? "Synchronisation…" : "↻ Actualiser"}
          </button>
        )}
      </div>
      <p className="dv-header-stamp">
        {synced ? `Dernière synchronisation : ${synced}` : "Aucune synchronisation enregistrée pour l’instant."}
        {syncMessage ? ` · ${syncMessage}` : ""}
      </p>
    </section>
  );
}

/**
 * États explicites : fournisseur absent, instruments non identifiés, données anciennes, anomalies
 * de rapprochement. Chacun dit ce qui manque ET ce qu'il faut faire — un écran silencieux laisse
 * croire que zéro est la vérité.
 */
function DividendNotices({ payload }: { payload: DividendPayload }) {
  const notices: Array<{ tone: "info" | "warn"; text: string }> = [];
  const configured = payload.providers.filter((provider) => provider.configured);
  if (payload.providers.length > 0 && configured.length === 0) {
    notices.push({
      tone: "warn",
      text: "Aucun fournisseur de dividendes n’est configuré sur le serveur. Ajoutez une clé Alpha Vantage (ALPHA_VANTAGE_API_KEY) pour récupérer les échéances annoncées.",
    });
  }
  if (payload.unresolved.length > 0) {
    const names = payload.unresolved.slice(0, 3).map((item) => item.name).join(", ");
    notices.push({
      tone: "warn",
      text: `${payload.unresolved.length} instrument${payload.unresolved.length > 1 ? "s doivent" : " doit"} être identifié${payload.unresolved.length > 1 ? "s" : ""} avant de pouvoir calculer ${payload.unresolved.length > 1 ? "leurs" : "son"} dividende${payload.unresolved.length > 1 ? "s" : ""} : ${names}${payload.unresolved.length > 3 ? "…" : ""}`,
    });
  }
  for (const anomaly of payload.model.anomalies.slice(0, 3)) {
    notices.push({ tone: "info", text: `${anomaly.label} — ${anomaly.detail}` });
  }
  if (notices.length === 0) return null;
  return (
    <ul className="dv-notices">
      {notices.map((notice, index) => (
        <li key={index} className={notice.tone === "warn" ? "is-warn" : ""}>
          <span aria-hidden="true">{notice.tone === "warn" ? "⚠" : "ℹ"}</span>
          <p>{notice.text}</p>
        </li>
      ))}
    </ul>
  );
}

// ==========================================================================================
// KPI
// ==========================================================================================
function ExpectedCard({ model, currency, basis }: { model: DividendModel; currency: string; basis: "gross" | "net" }) {
  const total = model.expectedReference;
  return (
    <article className="panel dv-kpi">
      <span className="dv-kpi-icon" aria-hidden="true">🗓️</span>
      <div>
        <small>Attendus sur {model.window.label.toLowerCase()}</small>
        <strong>{money(total, currency)}</strong>
        <p className="dv-kpi-split">
          <span><i className="dv-dot dv-dot-received" aria-hidden="true" />{money(model.expectedReceivedReference, currency)} reçus</span>
          <span><i className="dv-dot dv-dot-announced" aria-hidden="true" />{money(model.expectedAnnouncedReference, currency)} annoncés</span>
          {model.includeForecast && (
            <span><i className="dv-dot dv-dot-estimated" aria-hidden="true" />{money(model.expectedEstimatedReference, currency)} estimés</span>
          )}
        </p>
        {/* Moyenne = total ÷ nombre de mois de LA MÊME fenêtre. Elle est donc toujours
            réconciliable avec le montant affiché au-dessus. */}
        <em>Moyenne : {money(model.monthlyAverageReference, currency)} / mois{basis === "net" ? " (net estimé)" : ""}</em>
      </div>
    </article>
  );
}

function ReceivedCard({ model, currency }: { model: DividendModel; currency: string }) {
  const year = model.today.slice(0, 4);
  const previous = model.receivedPreviousYearReference;
  const delta = previous !== null && previous > 0
    ? ((model.receivedThisYearReference - previous) / previous) * 100
    : null;
  return (
    <article className="panel dv-kpi">
      <span className="dv-kpi-icon" aria-hidden="true">✅</span>
      <div>
        <small>Reçus en {year}</small>
        <strong>{money(model.receivedThisYearReference, currency)}</strong>
        <p className="dv-kpi-split">
          <span>{model.receivedThisYearCount} versement{model.receivedThisYearCount > 1 ? "s" : ""} encaissé{model.receivedThisYearCount > 1 ? "s" : ""}</span>
        </p>
        <em>
          {/* Aucune comparaison n'est affichée sans année de référence réellement documentée :
              comparer à un zéro qui signifie « rien n'a été saisi » inventerait une progression. */}
          {delta !== null
            ? `${delta >= 0 ? "+" : "−"}${Math.abs(delta).toFixed(0)} % par rapport à ${Number(year) - 1}`
            : model.hasRealDividendOperations
              ? "Pas assez d’historique pour comparer à l’an dernier"
              : "Aucun dividende encaissé enregistré sur ce compte"}
        </em>
      </div>
    </article>
  );
}

function YieldCard({ model }: { model: DividendModel }) {
  const percent = (value: number | null) => (value === null ? null : `${value.toFixed(1).replace(".", ",")} %`);
  const forward = percent(model.forwardYieldPct);
  const onCost = percent(model.yieldOnCostPct);
  return (
    <article className="panel dv-kpi">
      <span className="dv-kpi-icon" aria-hidden="true">📈</span>
      <div>
        <small>Rendement prévisionnel</small>
        <strong>{forward ?? "Non calculable"}</strong>
        <p className="dv-kpi-split">
          <span
            title="Rendement prévisionnel = dividendes attendus sur la période ÷ valeur actuelle du portefeuille. Rendement sur prix de revient = les mêmes dividendes ÷ capital réellement investi : il est plus élevé quand les titres ont pris de la valeur depuis l’achat."
          >
            {onCost ? `${onCost} sur prix de revient` : "Prix de revient non disponible"}
            <abbr className="dv-hint" aria-label="Explication des deux rendements"> ⓘ</abbr>
          </span>
        </p>
        <em>{forward === null ? model.yieldUnavailableReason ?? "Données insuffisantes." : "Sur la valeur actuelle des positions"}</em>
      </div>
    </article>
  );
}

// ==========================================================================================
// Graphique
// ==========================================================================================
function ChartLegend() {
  return (
    <ul className="dv-legend">
      <li><i className="dv-swatch dv-swatch-received" aria-hidden="true" />Reçu</li>
      <li><i className="dv-swatch dv-swatch-announced" aria-hidden="true" />Annoncé</li>
      <li><i className="dv-swatch dv-swatch-estimated" aria-hidden="true" />Estimé</li>
    </ul>
  );
}

/**
 * Histogramme empilé sur la fenêtre affichée. Les trois couches se distinguent par la couleur ET
 * par la texture (l'estimé est hachuré) : une différence de teinte seule serait invisible pour une
 * partie des lecteurs, et indiscernable à l'impression.
 */
function MonthlyChart({ model, currency, basis }: { model: DividendModel; currency: string; basis: "gross" | "net" }) {
  const ratio = basis === "net" && model.tax.effectiveRate !== null ? 1 - model.tax.effectiveRate : 1;
  const points = model.monthly.map((point) => ({
    ...point,
    received: point.receivedReference,
    announced: point.announcedReference * ratio,
    estimated: point.estimatedReference * ratio,
  }));
  const max = Math.max(...points.map((point) => point.received + point.announced + point.estimated), 0);

  if (max <= 0) {
    return (
      <EmptyState icon="📊" title="Aucun versement sur cette période"
        description="Aucun dividende reçu, annoncé ni projeté sur la période sélectionnée. Changez de période, ou lancez une synchronisation pour récupérer les échéances connues." />
    );
  }

  const height = 190;
  const scale = (value: number) => (max > 0 ? (value / max) * height : 0);
  const ticks = [max, max * 0.75, max * 0.5, max * 0.25, 0];

  return (
    <div className="dv-chart">
      <div className="dv-chart-axis" aria-hidden="true">
        {ticks.map((tick, index) => <span key={index}>{money(tick, currency)}</span>)}
      </div>
      <ul className="dv-chart-plot" style={{ height: `${height + 26}px` }}>
        {ticks.map((tick, index) => (
          <i key={`grid-${index}`} className="dv-gridline" style={{ bottom: `${scale(tick) + 22}px` }} aria-hidden="true" />
        ))}
        {points.map((point) => {
          const total = point.received + point.announced + point.estimated;
          return (
            <li key={point.monthKey} className="dv-chart-col">
              <div className="dv-chart-stack" style={{ height: `${height}px` }}>
                {point.estimated > 0 && <div className="dv-bar dv-bar-estimated" style={{ height: `${scale(point.estimated)}px` }} />}
                {point.announced > 0 && <div className="dv-bar dv-bar-announced" style={{ height: `${scale(point.announced)}px` }} />}
                {point.received > 0 && <div className="dv-bar dv-bar-received" style={{ height: `${scale(point.received)}px` }} />}
              </div>
              <small aria-hidden="true">{point.label}</small>
              {/* Lecture d'écran : le détail chiffré du mois, que l'histogramme ne peut pas dire. */}
              <span className="sr-only">
                {monthLong(point.monthKey)} : {money(total, currency)} au total
                {point.received > 0 ? `, dont ${money(point.received, currency)} reçus` : ""}
                {point.announced > 0 ? `, ${money(point.announced, currency)} annoncés` : ""}
                {point.estimated > 0 ? `, ${money(point.estimated, currency)} estimés` : ""}.
              </span>
              <span className="dv-chart-tip">{money(total, currency)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ==========================================================================================
// Prochains versements
// ==========================================================================================
function initialsOf(entry: DividendEntry): string {
  return (entry.ticker ?? entry.name).replace(/[^A-Za-z0-9]/g, "").slice(0, 3).toUpperCase() || "—";
}

function UpcomingList({ entries, currency, amountOf, basis, limit = 4 }: {
  entries: DividendEntry[];
  currency: string;
  amountOf: (entry: DividendEntry) => number | null;
  basis: "gross" | "net";
  limit?: number;
}) {
  if (entries.length === 0) {
    return (
      <EmptyState icon="🗓️" title="Aucune échéance connue"
        description="Les échéances proviennent des annonces des fournisseurs et des projections calculées sur l’historique de chaque titre." />
    );
  }
  return (
    <ul className="dv-next">
      {entries.slice(0, limit).map((entry) => (
        <li key={entry.id}>
          <span className={`dv-next-mark dv-mark-${entry.status}`} aria-hidden="true">{initialsOf(entry)}</span>
          <div className="dv-next-id">
            <strong>{entry.name}</strong>
            <small>{scheduleLine(entry)}</small>
            {entry.amountPerShare !== null && entry.eligibleQuantity !== null && (
              <small className="dv-next-detail">
                {money(entry.amountPerShare, entry.currency)} × {entry.eligibleQuantity.toLocaleString("fr-FR")} titre{entry.eligibleQuantity > 1 ? "s" : ""}
                {entry.quantityIsCurrent ? " (quantité actuelle)" : ""}
              </small>
            )}
          </div>
          <div className="dv-next-amount">
            <b>{amountOf(entry) === null ? "Donnée indisponible" : money(amountOf(entry)!, currency)}</b>
            <small>{basis === "net" ? "net estimé" : "brut"}</small>
          </div>
          <span className={`inv-badge dv-badge-${entry.status}`}>
            {STATUS_LABEL[entry.status]}
            {entry.status === "estimated" && entry.confidence ? ` · ${confidenceLabel(entry.confidence).toLowerCase()}` : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Ligne de dates. Trois cas, et aucun n'emprunte la date de l'autre :
 *   annoncé avec paiement    → « Détachement 5 oct. · Paiement 7 oct. »
 *   annoncé sans paiement    → « Paiement : date non publiée » (jamais le détachement à la place)
 *   estimé                   → « Mai 2027 estimé · Date non annoncée »
 */
function scheduleLine(entry: DividendEntry): string {
  if (entry.status === "estimated") return `${monthLong(entry.scheduleMonth)} estimé · date non annoncée`;
  const parts: string[] = [];
  if (entry.exDate) parts.push(`Détachement ${dateOf(entry.exDate)}`);
  parts.push(entry.paymentDate ? `Paiement ${dateOf(entry.paymentDate)}` : "Paiement : date non publiée");
  return parts.join(" · ");
}

// ==========================================================================================
// Contributeurs
// ==========================================================================================
function Contributors({ contributors, currency }: { contributors: DividendContributor[]; currency: string }) {
  if (contributors.length === 0) {
    return <EmptyState title="Aucun contributeur" description="Aucun revenu connu sur la période sélectionnée." />;
  }
  return (
    <ul className="dv-contributors">
      {contributors.slice(0, 5).map((contributor) => (
        <li key={contributor.key}>
          <span className="dv-contributor-name">
            {contributor.name}
            {contributor.dataQuality !== "complete" && <em className="dv-quality"> donnée partielle</em>}
          </span>
          <span className="dv-contributor-value">{money(contributor.amountReference, currency)}</span>
          <span className="dv-contributor-track" aria-hidden="true">
            <i className={contributor.hasEstimate ? "is-estimated" : ""} style={{ width: `${Math.max(2, Math.min(100, contributor.pct))}%` }} />
          </span>
          <span className="dv-contributor-pct">{contributor.pct.toFixed(0)} %</span>
        </li>
      ))}
    </ul>
  );
}

// ==========================================================================================
// Vue « toutes les positions »
// ==========================================================================================
const POLICY_LABEL: Record<string, string> = {
  distributing: "Distribuant",
  accumulating: "Capitalisant",
  unknown: "Politique inconnue",
};

function PositionsView({ payload, currency, onBack }: { payload: DividendPayload; currency: string; onBack: () => void }) {
  const positions = useMemo(
    () => [...payload.model.positions].sort((a, b) => (b.expectedReference ?? -1) - (a.expectedReference ?? -1)),
    [payload.model.positions],
  );
  return (
    <section className="panel dv-detail">
      <header className="dv-panel-head">
        <button type="button" className="btc-link" onClick={onBack}>← Retour aux dividendes</button>
        <h3 className="btc-panel-kicker">TOUTES LES POSITIONS · {payload.model.window.label.toUpperCase()}</h3>
      </header>

      {/* Desktop : un tableau. Mobile : des cartes (le tableau déborderait). Les deux rendus
          affichent EXACTEMENT les mêmes champs — une colonne masquée serait une donnée perdue. */}
      <div className="dv-table-scroll">
        <table className="dv-table">
          <caption className="sr-only">Détail des dividendes par position</caption>
          <thead>
            <tr>
              <th scope="col">Instrument</th>
              <th scope="col">Type</th>
              <th scope="col" className="num">Quantité</th>
              <th scope="col" className="num">Par action</th>
              <th scope="col" className="num">Attendu</th>
              <th scope="col" className="num">Reçu {payload.model.today.slice(0, 4)}</th>
              <th scope="col" className="num">Rdt valeur</th>
              <th scope="col" className="num">Rdt revient</th>
              <th scope="col">Prochain</th>
              <th scope="col">Donnée</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((position) => <PositionRow key={position.key} position={position} currency={currency} />)}
          </tbody>
        </table>
      </div>

      <ul className="dv-cards">
        {positions.map((position) => <PositionCard key={position.key} position={position} currency={currency} />)}
      </ul>

      <p className="btc-chart-source">
        « Reçu » provient exclusivement d’opérations réelles enregistrées sur le compte. « Attendu » additionne les annonces
        des fournisseurs et les projections calculées sur l’historique. Une projection n’est jamais transformée en opération.
      </p>
    </section>
  );
}

function dataStatusLabel(position: DividendPositionDetail): string {
  switch (position.dataStatus) {
    case "accumulating": return "Capitalisant. Aucun versement en espèces attendu.";
    case "unresolved": return "Instrument à identifier";
    case "no_data": return "Donnée indisponible";
    default: return position.sourceProvider ?? "Synchronisé";
  }
}

function PositionRow({ position, currency }: { position: DividendPositionDetail; currency: string }) {
  const percent = (value: number | null) => (value === null ? "—" : `${value.toFixed(1).replace(".", ",")} %`);
  return (
    <tr>
      <td>
        <strong>{position.name}</strong>
        <small>{position.ticker ?? position.isin ?? "—"}</small>
      </td>
      <td>
        {position.assetType === "etf" || position.assetType === "fund" ? "ETF / fonds" : position.assetType === "stock" ? "Action" : "Autre"}
        <small>{POLICY_LABEL[position.distributionPolicy] ?? "—"}</small>
      </td>
      <td className="num">{position.quantity.toLocaleString("fr-FR")}</td>
      <td className="num">{position.amountPerShare === null ? "—" : money(position.amountPerShare, currency)}</td>
      <td className="num">{position.expectedReference === null ? "—" : money(position.expectedReference, currency)}</td>
      <td className="num">{money(position.receivedThisYearReference, currency)}</td>
      <td className="num">{percent(position.yieldOnValuePct)}</td>
      <td className="num">{percent(position.yieldOnCostPct)}</td>
      <td>
        {position.distributionPolicy === "accumulating"
          ? "—"
          : position.nextPaymentDate
            ? dateOf(position.nextPaymentDate)
            : position.nextPaymentMonth
              ? `${monthLong(position.nextPaymentMonth)} (estimé)`
              : "—"}
      </td>
      <td><small>{dataStatusLabel(position)}</small></td>
    </tr>
  );
}

function PositionCard({ position, currency }: { position: DividendPositionDetail; currency: string }) {
  const percent = (value: number | null) => (value === null ? "—" : `${value.toFixed(1).replace(".", ",")} %`);
  return (
    <li className="dv-card">
      <header>
        <strong>{position.name}</strong>
        <span className={`inv-badge dv-badge-${position.dataStatus === "ok" ? "announced" : "unavailable"}`}>
          {POLICY_LABEL[position.distributionPolicy] ?? "—"}
        </span>
      </header>
      {position.distributionPolicy === "accumulating" ? (
        <p className="dv-card-note">Capitalisant. Aucun versement en espèces attendu.</p>
      ) : (
        <dl className="dv-card-grid">
          <div><dt>Quantité</dt><dd>{position.quantity.toLocaleString("fr-FR")}</dd></div>
          <div><dt>Par action</dt><dd>{position.amountPerShare === null ? "—" : money(position.amountPerShare, currency)}</dd></div>
          <div><dt>Attendu</dt><dd>{position.expectedReference === null ? "—" : money(position.expectedReference, currency)}</dd></div>
          <div><dt>Reçu</dt><dd>{money(position.receivedThisYearReference, currency)}</dd></div>
          <div><dt>Rdt valeur</dt><dd>{percent(position.yieldOnValuePct)}</dd></div>
          <div><dt>Rdt revient</dt><dd>{percent(position.yieldOnCostPct)}</dd></div>
          <div className="dv-card-wide">
            <dt>Prochain versement</dt>
            <dd>
              {position.nextPaymentDate
                ? dateOf(position.nextPaymentDate)
                : position.nextPaymentMonth
                  ? `${monthLong(position.nextPaymentMonth)} (estimé, date non annoncée)`
                  : "—"}
            </dd>
          </div>
          <div className="dv-card-wide"><dt>Donnée</dt><dd>{dataStatusLabel(position)}</dd></div>
        </dl>
      )}
    </li>
  );
}

// ==========================================================================================
// Vue calendrier
// ==========================================================================================
function CalendarView({ model, currency, amountOf, basis, onBack }: {
  model: DividendModel;
  currency: string;
  amountOf: (entry: DividendEntry) => number | null;
  basis: "gross" | "net";
  onBack: () => void;
}) {
  const byMonth = useMemo(() => {
    const months = new Map<string, DividendEntry[]>();
    for (const monthPoint of model.monthly) months.set(monthPoint.monthKey, []);
    for (const entry of model.entries) {
      const bucket = months.get(entry.scheduleMonth);
      if (bucket) bucket.push(entry);
    }
    return [...months.entries()].filter(([, entries]) => entries.length > 0);
  }, [model]);

  return (
    <section className="panel dv-detail">
      <header className="dv-panel-head">
        <button type="button" className="btc-link" onClick={onBack}>← Retour aux dividendes</button>
        <h3 className="btc-panel-kicker">CALENDRIER · {model.window.label.toUpperCase()}</h3>
      </header>
      {byMonth.length === 0 ? (
        <EmptyState icon="🗓️" title="Aucune échéance sur la période"
          description="Aucun dividende reçu, annoncé ou projeté n’est placé sur cette période." />
      ) : (
        <ul className="dv-calendar">
          {byMonth.map(([monthKey, entries]) => (
            <li key={monthKey}>
              <h4>
                {monthLong(monthKey)}
                <b>{money(entries.reduce((sum, entry) => sum + (amountOf(entry) ?? 0), 0), currency)}</b>
              </h4>
              <UpcomingList entries={entries} currency={currency} amountOf={amountOf} basis={basis} limit={entries.length} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
