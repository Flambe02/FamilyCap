"use client";

// Onglet REVENUS — calendrier de dividendes, contributeurs, lecture rapide et détail filtrable.
//
// Ce que cet écran remplace : une liste unique où annonces du fournisseur, projections et
// encaissements réels étaient présentés au même niveau, avec le mot « net » posé sur un montant
// qui n'avait subi aucun prélèvement. Ici, les trois catégories sont séparées visuellement ET
// dans le modèle (lib/dividend-income.ts) :
//   Reçu (foncé) — un encaissement réel, issu d'une opération.
//   Annoncé      — une échéance déclarée, pas encore encaissée.
//   Estimé (clair, badgé) — une projection sur le dernier dividende comparable connu.
//
// Aucun total ne mélange ces catégories sans le dire, et aucune projection ne crée d'opération.

import { useCallback, useEffect, useMemo, useState } from "react";
import { authenticatedFetch } from "./investment-shared";
import { EmptyState, dateOf, euro, euro0 } from "./bitcoin-components";
import { money } from "./positions-list";
import {
  DEFAULT_FLAT_TAX_RATE, computeDividendIncome,
  type AnnouncedDividendRow, type DividendEntry, type DividendIncomeModel, type DividendStatus,
} from "../lib/dividend-income";
import type { AccountModel, AccountOperation } from "../lib/portfolio-account";
import { getLatestFxRate, type FxRateRow } from "../lib/fx-rates";

export type ApiDividend = {
  id: string; ex_date: string; payment_date: string | null; amount_per_share: number | null;
  currency: string | null; status: string | null; provider: string | null;
  asset: { name: string | null; symbol: string | null; isin: string | null } | null;
};

/**
 * Annonces du fournisseur pour un périmètre de comptes. Le hook vit ici, mais il est appelé DEPUIS
 * LE SHELL : la couverture « dividendes » du bandeau et l'onglet Revenus doivent lire exactement
 * la même liste, sinon les deux écrans annonceraient deux couvertures différentes.
 */
export function useAnnouncedDividends(accountIds: string[]): { announced: ApiDividend[]; loading: boolean; reload: () => void } {
  const key = accountIds.join(",");
  const [nonce, setNonce] = useState(0);
  // Résultat mémorisé avec sa clé (périmètre + numéro de rechargement) : « en cours » se déduit
  // de la comparaison, plutôt que d'un setState synchrone dans l'effet.
  const [fetched, setFetched] = useState<{ key: string; rows: ApiDividend[] } | null>(null);
  const stamp = `${key}#${nonce}`;

  useEffect(() => {
    if (!key) return;
    let active = true;
    authenticatedFetch(`/api/market-data/dividends?accountIds=${encodeURIComponent(key)}`)
      .then((response) => (response.ok ? response.json() : { dividends: [] }))
      .then((data: { dividends?: ApiDividend[] }) => { if (active) setFetched({ key: stamp, rows: data.dividends ?? [] }); })
      .catch(() => { if (active) setFetched({ key: stamp, rows: [] }); });
    return () => { active = false; };
  }, [key, stamp]);

  const current = fetched?.key === stamp ? fetched : null;
  return {
    announced: current?.rows ?? [],
    loading: key !== "" && current === null,
    reload: useCallback(() => setNonce((value) => value + 1), []),
  };
}

const todayISO = () => new Date().toISOString().slice(0, 10);
const STATUS_LABEL: Record<DividendStatus, string> = { received: "Reçu", announced: "Annoncé", estimated: "Estimé" };
const FILTERS: Array<{ id: "all" | DividendStatus; label: string }> = [
  { id: "all", label: "Tous" }, { id: "received", label: "Reçus" }, { id: "announced", label: "Annoncés" }, { id: "estimated", label: "Estimés" },
];

export function RevenusTab({ model, operations, accountIds, announced, loading, onReloadAnnounced, accountCurrency = "EUR", fxRates = [], dividendTaxRate = null, canManage = false }: {
  model: AccountModel;
  operations: AccountOperation[];
  accountIds: string[];
  /** Annonces chargées par le shell : une seule requête, une seule vérité de couverture. */
  announced: ApiDividend[];
  loading: boolean;
  onReloadAnnounced: () => void;
  accountCurrency?: string;
  fxRates?: FxRateRow[];
  /** Taux d'imposition paramétré du compte-titres (`null` = non paramétré → hypothèse annoncée). */
  dividendTaxRate?: number | null;
  canManage?: boolean;
}) {
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [basis, setBasis] = useState<"gross" | "net">("gross");
  const [filter, setFilter] = useState<"all" | DividendStatus>("all");
  // Le tableau s'ouvre court et s'allonge à la demande : c'est ce qui remplace la liste unique
  // qui déroulait tous les titres au même niveau.
  const [visibleRows, setVisibleRows] = useState(20);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const fxRateAt = useMemo(
    () => (currency: string, date: string) => getLatestFxRate(currency, accountCurrency, fxRates, { asOf: date, fallbackToEarliest: true })?.rate ?? null,
    [fxRates, accountCurrency],
  );

  const income: DividendIncomeModel = useMemo(() => computeDividendIncome({
    operations,
    positions: model.positions,
    announced: announced.map((row): AnnouncedDividendRow => ({
      id: row.id, exDate: row.ex_date, paymentDate: row.payment_date,
      amountPerShare: row.amount_per_share, currency: row.currency, status: row.status, provider: row.provider, asset: row.asset,
    })),
    accountType: model.accountType,
    today: todayISO(),
    referenceCurrency: accountCurrency,
    fxRateAt,
    ctoTaxRate: dividendTaxRate,
    positionsValueEur: model.positionsValueEur,
    year,
  }), [announced, model, operations, accountCurrency, fxRateAt, dividendTaxRate, year]);

  const years = useMemo(() => {
    const found = new Set<number>([new Date().getFullYear()]);
    for (const entry of income.entries) found.add(Number(entry.scheduleDate.slice(0, 4)));
    return [...found].sort((a, b) => b - a);
  }, [income.entries]);

  const filtered = useMemo(
    () => (filter === "all" ? income.entries : income.entries.filter((entry) => entry.status === filter)),
    [income.entries, filter],
  );

  async function syncDividends() {
    if (accountIds.length !== 1) return;
    setSyncing(true);
    setSyncNote(null);
    try {
      const response = await authenticatedFetch("/api/market-data/dividends/sync", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountId: accountIds[0] }),
      });
      const data = (await response.json().catch(() => ({}))) as { updated?: number; accumulating?: number; unresolved?: number; unavailable?: number; error?: string };
      if (!response.ok) setSyncNote(data.error ?? "Synchronisation impossible.");
      else {
        setSyncNote(`${data.updated ?? 0} instrument(s) mis à jour · ${data.accumulating ?? 0} capitalisant(s) ignoré(s) · ${data.unresolved ?? 0} non résolu(s)${data.unavailable ? ` · ${data.unavailable} fournisseur muet` : ""}.`);
        onReloadAnnounced();
      }
    } catch {
      setSyncNote("Réseau indisponible.");
    } finally {
      setSyncing(false);
    }
  }

  const amountOf = (entry: DividendEntry) => (basis === "net" ? entry.netReference ?? entry.grossReference : entry.grossReference);

  return (
    <>
      {/* ---- 4 KPI ------------------------------------------------------------------- */}
      <div className="inv-kpi-row">
        <IncomeKpi
          icon="🪙" label="Dividendes estimés sur 12 mois"
          value={euro.format(income.expected12mEur)}
          sub={income.expected12mEur > 0 ? "Annoncés + projetés, bruts" : "Aucune échéance connue à ce jour"}
        />
        <IncomeKpi icon="📈" label="Moyenne mensuelle" value={euro.format(income.monthlyAverageEur)} sub={`Sur l’année ${year}`} />
        <IncomeKpi
          icon="✅" label={`Déjà encaissé en ${year}`}
          value={euro.format(income.receivedThisYearEur)}
          sub={income.hasRealDividendOperations ? "Opérations réelles" : "Aucun dividende encaissé enregistré"}
        />
        <IncomeKpi
          icon="％" label="Rendement du portefeuille"
          value={income.portfolioYieldPct === null ? "Non calculable" : `${income.portfolioYieldPct.toFixed(2).replace(".", ",")} %`}
          sub={income.portfolioYieldPct === null ? "Valeur ou revenus manquants" : "Revenus 12 mois ÷ valeur des positions"}
        />
      </div>

      <div className="inv-income-grid">
        {/* ---- Histogramme ----------------------------------------------------------- */}
        <section className="panel inv-income-chart">
          <header className="btc-chart-head inv-income-head">
            <h3 className="btc-panel-kicker">REVENUS PAR MOIS</h3>
            <div className="inv-income-controls">
              <label className="inv-select">
                <span className="sr-only">Année</span>
                <select value={year} onChange={(event) => setYear(Number(event.target.value))}>
                  {years.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              <div className="inv-toggle" role="group" aria-label="Base de calcul">
                <button type="button" className={basis === "gross" ? "active" : ""} onClick={() => setBasis("gross")}>Brut</button>
                <button type="button" className={basis === "net" ? "active" : ""} onClick={() => setBasis("net")}>Net estimé</button>
              </div>
            </div>
          </header>
          <IncomeBars income={income} basis={basis} />
          <p className="btc-chart-source">{income.taxNote}</p>
        </section>

        {/* ---- Prochains versements --------------------------------------------------- */}
        <section className="panel inv-income-next">
          <h3 className="btc-panel-kicker">PROCHAINS VERSEMENTS</h3>
          {loading ? (
            <p className="inv-muted">Chargement des échéances…</p>
          ) : income.upcoming.length === 0 ? (
            <EmptyState icon="🗓️" title="Aucune échéance connue"
              description="Les échéances proviennent des annonces du fournisseur et des projections sur les derniers dividendes détachés." />
          ) : (
            <ul className="inv-next-list">
              {income.upcoming.map((entry) => (
                <li key={entry.id}>
                  <span className="inv-next-mark" aria-hidden="true">{entry.status === "announced" ? "◆" : "◌"}</span>
                  <div className="inv-next-id">
                    <strong>{entry.name}</strong>
                    <small>{entry.paymentDate ? dateOf(entry.paymentDate) : entry.exDate ? `détachement ${dateOf(entry.exDate)}` : "—"}</small>
                  </div>
                  <div className="inv-next-amount">
                    <b>{amountOf(entry) === null ? "Conversion indispo." : money(amountOf(entry)!, accountCurrency)}</b>
                    <small>{basis === "net" ? "net" : "brut"}</small>
                  </div>
                  <span className={`inv-badge ${entry.status === "announced" ? "inv-badge-confirmed" : "inv-badge-estimated"}`}>
                    {entry.status === "announced" ? "Confirmé" : "Estimé"}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {canManage && accountIds.length === 1 && (
            <div className="inv-income-sync">
              <button type="button" className="secondary-button" disabled={syncing} onClick={syncDividends}>
                {syncing ? "Synchronisation…" : "Synchroniser les dividendes"}
              </button>
              {syncNote && <small>{syncNote}</small>}
            </div>
          )}
        </section>
      </div>

      {/* ---- Contributeurs + lecture rapide ------------------------------------------- */}
      <div className="inv-income-grid">
        <section className="panel">
          <h3 className="btc-panel-kicker">PRINCIPAUX CONTRIBUTEURS</h3>
          {income.contributors.length === 0 ? (
            <EmptyState title="Aucun contributeur" description="Aucun revenu connu sur les 12 derniers mois ni sur les 12 prochains." />
          ) : (
            <ul className="inv-contributors">
              {income.contributors.slice(0, 6).map((contributor) => (
                <li key={contributor.key}>
                  <span className="inv-contributor-name">{contributor.name}</span>
                  <span className="inv-contributor-track" aria-hidden="true"><i style={{ width: `${Math.max(2, contributor.pct)}%` }} /></span>
                  <span className="inv-contributor-value">{euro0.format(contributor.annualEur)}</span>
                  <span className="inv-contributor-pct">{contributor.pct.toFixed(0)} %</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel">
          <h3 className="btc-panel-kicker">LECTURE RAPIDE</h3>
          <ul className="inv-quickread">
            <li>
              <span aria-hidden="true">🗓️</span>
              <p>{income.quickRead.bestMonthLabel && income.quickRead.bestMonthPct !== null
                ? `${income.quickRead.bestMonthLabel} concentre ${income.quickRead.bestMonthPct.toFixed(0)} % des revenus de ${year}.`
                : `Aucun revenu connu sur ${year}.`}</p>
            </li>
            <li>
              <span aria-hidden="true">🥧</span>
              <p>{income.quickRead.topContributorName && income.quickRead.topContributorPct !== null
                ? `${income.quickRead.topContributorName} représente ${income.quickRead.topContributorPct.toFixed(0)} % du total.`
                : "Aucun contributeur identifié."}</p>
            </li>
            <li>
              <span aria-hidden="true">📊</span>
              <p>{income.quickRead.monthsWithoutIncome} mois sur 12 sans versement en {year}.</p>
            </li>
            <li>
              <span aria-hidden="true">🔎</span>
              <p>
                {income.coverage.analysedInstruments}/{income.coverage.totalInstruments} instruments analysés
                {income.coverage.accumulating > 0 ? ` · ${income.coverage.accumulating} capitalisant(s), sans versement en espèces` : ""}
                {income.coverage.unknown > 0 ? ` · ${income.coverage.unknown} sans donnée de dividende` : ""}.
              </p>
            </li>
          </ul>
        </section>
      </div>

      {/* ---- Détail filtrable ---------------------------------------------------------- */}
      <section className="panel inv-income-detail">
        <header className="inv-income-head">
          <h3 className="btc-panel-kicker">DÉTAIL DES DIVIDENDES</h3>
          <div className="inv-toggle" role="group" aria-label="Filtrer les dividendes">
            {FILTERS.map((item) => (
              <button key={item.id} type="button" className={filter === item.id ? "active" : ""} onClick={() => setFilter(item.id)}>
                {item.label}
                <em>{item.id === "all" ? income.entries.length : income.entries.filter((entry) => entry.status === item.id).length}</em>
              </button>
            ))}
          </div>
        </header>
        {filtered.length === 0 ? (
          <EmptyState icon="💶"
            title={filter === "received" ? "Aucun dividende encaissé" : "Aucune ligne dans ce filtre"}
            description={filter === "received"
              ? "Aucune opération de type « dividende » n’est enregistrée sur ce compte. Rien n’est créé automatiquement à partir d’une annonce ou d’une estimation."
              : "Les annonces et projections apparaîtront dès qu’un dividende sera connu pour un instrument détenu."} />
        ) : (
          <div className="inv-table-scroll">
            <table className="inv-income-table">
              <caption className="sr-only">Détail des dividendes reçus, annoncés et estimés</caption>
              <thead>
                <tr>
                  <th scope="col">Instrument</th>
                  <th scope="col">Statut</th>
                  <th scope="col">Détachement</th>
                  <th scope="col">Paiement</th>
                  <th scope="col" className="num">Par action</th>
                  <th scope="col" className="num">Titres</th>
                  <th scope="col" className="num">Brut</th>
                  <th scope="col" className="num">Net</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, visibleRows).map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      <strong>{entry.name}</strong>
                      <small>{entry.ticker ?? entry.isin ?? "—"} · {entry.source}</small>
                    </td>
                    <td><span className={`inv-badge inv-badge-${entry.status}`}>{STATUS_LABEL[entry.status]}</span></td>
                    <td>{entry.exDate ? dateOf(entry.exDate) : "—"}</td>
                    <td>{entry.paymentDate ? dateOf(entry.paymentDate) : "—"}</td>
                    <td className="num">{entry.amountPerShare === null ? "—" : money(entry.amountPerShare, entry.currency)}</td>
                    <td className="num">{entry.eligibleQuantity === null ? "—" : entry.eligibleQuantity.toLocaleString("fr-FR")}</td>
                    {/* Zéro titre détenu à la date de détachement ⇒ « non détenu », jamais
                        « 0,00 € ». Un montant nul se lit comme un dividende qui n'a rien rapporté ;
                        la réalité est qu'aucun titre n'était détenu ce jour-là. */}
                    {entry.eligibleQuantity === 0 ? (
                      <td className="num" colSpan={2}><small>Non détenu à cette date</small></td>
                    ) : (
                      <>
                        <td className="num">{entry.grossReference === null ? (entry.conversionUnavailable ? "Conversion indispo." : "—") : money(entry.grossReference, accountCurrency)}</td>
                        <td className="num">
                          {entry.netReference === null ? "—" : money(entry.netReference, accountCurrency)}
                          {entry.netIsEstimated && <em className="inv-net-hint"> estimé</em>}
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {filtered.length > visibleRows && (
          <button type="button" className="btc-link" onClick={() => setVisibleRows((count) => count + 20)}>
            Afficher 20 lignes de plus ({visibleRows} sur {filtered.length}) →
          </button>
        )}
        <p className="btc-chart-source">
          « Reçu » provient exclusivement d’opérations réelles. « Annoncé » vient du fournisseur de données.
          « Estimé » est une projection sur le dernier dividende comparable — jamais enregistrée comme opération.
          {model.accountType === "CTO" && dividendTaxRate === null && ` Le net est calculé sur l’hypothèse PFU ${Math.round(DEFAULT_FLAT_TAX_RATE * 100)} %.`}
        </p>
      </section>
    </>
  );
}

function IncomeKpi({ icon, label, value, sub }: { icon: string; label: string; value: string; sub: string }) {
  return (
    <article className="panel inv-kpi">
      <span className="inv-kpi-icon" aria-hidden="true">{icon}</span>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
        <em>{sub}</em>
      </div>
    </article>
  );
}

/**
 * Histogramme janvier→décembre. Deux teintes seulement : foncé = encaissé (un fait), clair =
 * attendu (annoncé ou estimé). Mélanger trois teintes rendait la lecture moins immédiate que
 * l'opposition « déjà là / pas encore », qui est la vraie question posée à cet écran.
 */
function IncomeBars({ income, basis }: { income: DividendIncomeModel; basis: "gross" | "net" }) {
  const ratio = basis === "net" && income.accountType === "CTO" ? 1 - DEFAULT_FLAT_TAX_RATE : 1;
  const points = income.monthly.map((point) => ({
    ...point,
    received: point.receivedEur,
    expected: (point.announcedEur + point.estimatedEur) * ratio,
  }));
  const max = Math.max(...points.map((point) => point.received + point.expected), 1);
  const average = points.reduce((sum, point) => sum + point.received + point.expected, 0) / 12;
  const height = 200;
  const scale = (value: number) => (value / max) * height;

  if (max <= 1 && average <= 0) {
    return <EmptyState icon="📊" title="Aucun revenu sur cette année" description="Sélectionnez une autre année, ou synchronisez les dividendes pour voir les échéances connues." />;
  }

  return (
    <div className="inv-bars">
      <div className="inv-bars-legend">
        <span><i className="inv-swatch inv-swatch-received" /> Encaissé</span>
        <span><i className="inv-swatch inv-swatch-expected" /> Attendu (annoncé ou estimé)</span>
        <span><i className="inv-swatch inv-swatch-average" /> Moyenne mensuelle ({euro0.format(average)})</span>
      </div>
      <div className="inv-bars-plot" style={{ height: `${height + 28}px` }}>
        <div className="inv-bars-average" style={{ bottom: `${scale(average) + 24}px` }} aria-hidden="true" />
        {points.map((point) => (
          <div key={point.monthKey} className="inv-bars-col">
            <div className="inv-bars-stack" style={{ height: `${height}px` }}>
              <div
                className="inv-bar inv-bar-expected"
                style={{ height: `${scale(point.expected)}px` }}
                title={`${point.label} — attendu ${euro0.format(point.expected)}`}
              />
              <div
                className="inv-bar inv-bar-received"
                style={{ height: `${scale(point.received)}px` }}
                title={`${point.label} — encaissé ${euro0.format(point.received)}`}
              />
            </div>
            <small>{point.label}</small>
          </div>
        ))}
      </div>
    </div>
  );
}
