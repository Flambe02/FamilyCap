"use client";

// Onglet PERFORMANCE — décomposition, comparaison, classement, risques et analyse.
//
// Règle de tête : cet écran ne publie une performance de période que si les FLUX HISTORIQUES le
// permettent. Quand les versements manquent ou que la trésorerie reconstruite devient négative,
// il l'écrit noir sur blanc et masque TWR, XIRR et courbe comparée — au lieu d'afficher un
// pourcentage flatteur produit par un dénominateur faux. Le détail latent / réalisé / dividendes /
// frais reste affiché, parce que celui-là est exact quoi qu'il arrive.

import { useEffect, useId, useMemo, useState } from "react";
import { authenticatedFetch } from "./investment-shared";
import { EmptyState, GainPill, dateOf, euro, euro0 } from "./bitcoin-components";
import { useExposureModel } from "./investment-exposure";
import {
  computePerformanceModel, computeRiskIndicators, normalizeBenchmark, rankPositions, twrSeries,
  externalFlows, type NormalizedPoint, type PerformanceModel, type RankedPosition,
} from "../lib/portfolio-performance";
import { UNKNOWN_CODE, type InstrumentExposure } from "../lib/portfolio-exposure";
import type { AccountModel, AccountOperation } from "../lib/portfolio-account";
import { getLatestFxRate, type FxRateRow } from "../lib/fx-rates";
import type { Observation } from "../lib/portfolio-insights";

type RangeId = "1M" | "6M" | "YTD" | "1A" | "TOUT";
const RANGES: Array<{ id: RangeId; label: string }> = [
  { id: "1M", label: "1M" }, { id: "6M", label: "6M" }, { id: "YTD", label: "YTD" }, { id: "1A", label: "1A" }, { id: "TOUT", label: "Tout" },
];

type BenchmarkPayload = {
  available: boolean;
  benchmarks: Array<{ code: string; label: string; proxyNote: string | null; currency: string | null; source: string | null; points: Array<{ date: string; close: number }> }>;
};
type AnalysisPayload = {
  observations: Observation[];
  generatedAt: string;
  coverageLabel: string;
  provider: string;
  cached: boolean;
  disclaimer: string;
};

const todayISO = () => new Date().toISOString().slice(0, 10);

function windowStart(range: RangeId, today: string, first: string | null): string | null {
  if (range === "TOUT") return first;
  const date = new Date(`${today}T00:00:00Z`);
  if (range === "YTD") return `${today.slice(0, 4)}-01-01`;
  if (range === "1M") date.setUTCMonth(date.getUTCMonth() - 1);
  if (range === "6M") date.setUTCMonth(date.getUTCMonth() - 6);
  if (range === "1A") date.setUTCFullYear(date.getUTCFullYear() - 1);
  return date.toISOString().slice(0, 10);
}

const pctLabel = (value: number | null, digits = 1) =>
  value === null || !Number.isFinite(value) ? "Non disponible" : `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(digits).replace(".", ",")} %`;

export function PerformanceTab({ model, operations, accountId, accountCurrency = "EUR", fxRates = [], exposures = [], canManage = false }: {
  model: AccountModel;
  operations: AccountOperation[];
  /** `null` en vue agrégée : benchmark et analyse portent sur UN compte, jamais sur un agrégat. */
  accountId: string | null;
  accountCurrency?: string;
  fxRates?: FxRateRow[];
  exposures?: InstrumentExposure[];
  canManage?: boolean;
}) {
  const [range, setRange] = useState<RangeId>("TOUT");
  const [benchmarkCode, setBenchmarkCode] = useState<string>("MSCI_WORLD");
  const [criterion, setCriterion] = useState<"percent" | "contribution">("percent");
  const [benchmarks, setBenchmarks] = useState<BenchmarkPayload>({ available: true, benchmarks: [] });
  const [analysisFor, setAnalysisFor] = useState<{ key: string; data: AnalysisPayload | null } | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const analysis = accountId && analysisFor?.key === accountId ? analysisFor.data : null;
  const analysisLoading = Boolean(accountId) && (regenerating || analysisFor?.key !== accountId);
  const today = todayISO();

  const geography = useExposureModel(model.positions, exposures, "geography");
  const sectors = useExposureModel(model.positions, exposures, "sector");

  const fxRateAt = useMemo(
    () => (currency: string, date: string) => getLatestFxRate(currency, accountCurrency, fxRates, { asOf: date, fallbackToEarliest: true })?.rate ?? null,
    [fxRates, accountCurrency],
  );
  const toReference = useMemo(
    () => (operation: AccountOperation, amount: number): number | null => {
      const currency = (operation.currency || accountCurrency).toUpperCase();
      if (currency === accountCurrency.toUpperCase()) return amount;
      const recorded = Number(operation.exchangeRate);
      if (Number.isFinite(recorded) && recorded > 0) return amount * recorded;
      const resolved = fxRateAt(currency, operation.date);
      return resolved === null ? null : amount * resolved;
    },
    [accountCurrency, fxRateAt],
  );
  const cashDeltaOf = useMemo(
    () => (operation: AccountOperation): number => {
      const gross = operation.grossAmount !== null && operation.grossAmount !== undefined
        ? Math.abs(Number(operation.grossAmount))
        : Math.abs(Number(operation.quantity ?? 0) * Number(operation.unitPrice ?? 0));
      const fees = Math.abs(Number(operation.fees ?? 0));
      const magnitude = operation.netAmount !== null && operation.netAmount !== undefined
        ? Math.abs(Number(operation.netAmount))
        : operation.type === "achat" ? gross + fees : operation.type === "vente" ? Math.max(0, gross - fees) : gross;
      const converted = toReference(operation, magnitude) ?? 0;
      if (operation.type === "versement" || operation.type === "vente" || operation.type === "dividende") return converted;
      if (operation.type === "achat" || operation.type === "retrait" || operation.type === "frais") return -converted;
      return 0;
    },
    [toReference],
  );

  const valuations = useMemo(
    () => model.timeline.map((point) => ({ date: `${point.monthKey}-28`, valueEur: point.valueEur })),
    [model.timeline],
  );
  const performance: PerformanceModel = useMemo(
    () => computePerformanceModel({ model, operations, today, toReference, cashDeltaOf, valuations }),
    [model, operations, today, toReference, cashDeltaOf, valuations],
  );

  const from = windowStart(range, today, model.startDate);
  const portfolioSeries = useMemo(() => {
    if (!performance.isReliable) return [];
    const flows = externalFlows(operations, toReference);
    const series = twrSeries(valuations, flows).filter((point) => !from || point.date >= from);
    if (series.length === 0) return [];
    const base = series[0].pct;
    return series.map((point) => ({ date: point.date, pct: point.pct - base }));
  }, [performance.isReliable, operations, toReference, valuations, from]);

  useEffect(() => {
    let active = true;
    authenticatedFetch("/api/market-data/benchmarks")
      .then((response) => (response.ok ? response.json() : { available: false, benchmarks: [] }))
      .then((data: BenchmarkPayload) => { if (active) setBenchmarks(data); })
      .catch(() => { if (active) setBenchmarks({ available: false, benchmarks: [] }); });
    return () => { active = false; };
  }, []);

  const benchmark = benchmarks.benchmarks.find((item) => item.code === benchmarkCode) ?? null;
  const benchmarkSeries: NormalizedPoint[] = useMemo(
    () => (benchmarkCode === "NONE" || !benchmark ? [] : normalizeBenchmark(benchmark.points, from, today)),
    [benchmark, benchmarkCode, from, today],
  );

  const ranking = useMemo(() => rankPositions(model.positions, criterion, 3), [model.positions, criterion]);
  const topGeography = geography.buckets.find((bucket) => bucket.code !== UNKNOWN_CODE) ?? null;
  const topSector = sectors.buckets.find((bucket) => bucket.code !== UNKNOWN_CODE) ?? null;
  const risks = useMemo(
    () => computeRiskIndicators({
      positions: model.positions,
      geographyTopPct: topGeography?.pct ?? null,
      geographyTopLabel: topGeography?.label ?? null,
      sectorTopPct: topSector?.pct ?? null,
      sectorTopLabel: topSector?.label ?? null,
      coveragePercent: model.valuationCoverage.coveragePercent,
    }),
    [model.positions, model.valuationCoverage.coveragePercent, topGeography, topSector],
  );

  // Premier chargement : l'effet n'appelle aucun setState de façon synchrone. Le résultat est
  // mémorisé avec la clé qui l'a produit, et « en cours » se déduit de la comparaison.
  useEffect(() => {
    if (!accountId) return;
    let active = true;
    authenticatedFetch(`/api/portfolio/analysis?accountId=${encodeURIComponent(accountId)}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => { if (active) setAnalysisFor({ key: accountId, data: (data as AnalysisPayload | null) }); })
      .catch(() => { if (active) setAnalysisFor({ key: accountId, data: null }); });
    return () => { active = false; };
  }, [accountId]);

  /** Régénération explicite : déclenchée par un clic, jamais par un effet. */
  async function regenerateAnalysis() {
    if (!accountId) return;
    setRegenerating(true);
    try {
      const response = await authenticatedFetch(`/api/portfolio/analysis?accountId=${encodeURIComponent(accountId)}`, { method: "POST" });
      if (response.ok) setAnalysisFor({ key: accountId, data: (await response.json()) as AnalysisPayload });
    } catch {
      /* l'écran reste utilisable sans analyse : c'est un commentaire, pas une donnée */
    } finally {
      setRegenerating(false);
    }
  }

  const gap = portfolioSeries.length && benchmarkSeries.length
    ? portfolioSeries[portfolioSeries.length - 1].pct - benchmarkSeries[benchmarkSeries.length - 1].pct
    : null;

  return (
    <>
      {/* ---- Filtres ------------------------------------------------------------------ */}
      <section className="panel inv-perf-filters">
        <div className="inv-toggle" role="group" aria-label="Période">
          {RANGES.map((item) => (
            <button key={item.id} type="button" className={range === item.id ? "active" : ""} onClick={() => setRange(item.id)}>{item.label}</button>
          ))}
        </div>
        <label className="inv-select inv-perf-benchmark">
          <span>Comparer à</span>
          <select value={benchmarkCode} onChange={(event) => setBenchmarkCode(event.target.value)}>
            {benchmarks.benchmarks.map((item) => <option key={item.code} value={item.code}>{item.label}</option>)}
            <option value="NONE">Aucun</option>
          </select>
        </label>
      </section>

      {!performance.isReliable && (
        <p className="inv-detail-warn" role="note">
          Performance non fiable tant que les flux historiques ne sont pas rapprochés. {performance.unreliableReason}
          {" "}Le détail ci-dessous (plus-value latente, réalisée, dividendes, frais) reste exact ; seuls la performance de période, le TWR et le XIRR sont masqués.
        </p>
      )}

      {/* ---- 4 KPI --------------------------------------------------------------------- */}
      <div className="inv-kpi-row">
        <PerfKpi icon="📈" label="Performance totale" value={pctLabel(performance.totalReturnPct)}
          sub={performance.totalReturnEur === null ? "Cours manquants" : `${euro.format(performance.totalReturnEur)} · latent + réalisé + dividendes − frais`}
          tone={performance.totalReturnPct === null ? undefined : performance.totalReturnPct >= 0 ? "up" : "down"} />
        <PerfKpi icon="💼" label="Plus-value latente" value={performance.unrealizedGainEur === null ? "Non disponible" : euro.format(performance.unrealizedGainEur)}
          sub={pctLabel(performance.unrealizedGainPct)}
          tone={performance.unrealizedGainEur === null ? undefined : performance.unrealizedGainEur >= 0 ? "up" : "down"} />
        <PerfKpi icon="🎁" label={model.accountType === "PEA" ? "Dividendes reçus" : "Dividendes nets"} value={euro.format(performance.dividendsNetEur)}
          sub={performance.dividendsNetEur > 0 ? "Cumulés, opérations réelles" : "Aucune opération de dividende enregistrée"} />
        <PerfKpi icon="📊" label="Performance annualisée" value={pctLabel(performance.annualizedPct)}
          sub={performance.isReliable && performance.years !== null ? `Sur ${performance.years.toFixed(1).replace(".", ",")} an(s)` : "Flux historiques incomplets"} />
      </div>

      <div className="inv-perf-grid">
        {/* ---- Courbe ------------------------------------------------------------------ */}
        <section className="panel inv-perf-chart">
          <header className="btc-chart-head">
            <h3 className="btc-panel-kicker">ÉVOLUTION DE LA PERFORMANCE</h3>
            {gap !== null && <span className={`inv-gap ${gap >= 0 ? "up" : "down"}`}>{pctLabel(gap)} vs {benchmark?.label}</span>}
          </header>
          {!performance.isReliable ? (
            <EmptyState icon="📉" title="Courbe indisponible"
              description="Une courbe de performance suppose des flux complets : sans versements enregistrés, chaque achat se lirait comme une perte. Enregistrez les versements historiques pour l’activer." />
          ) : portfolioSeries.length < 2 ? (
            <EmptyState icon="📉" title="Historique insuffisant"
              description="Il faut au moins deux points de valorisation sur la période choisie pour tracer une évolution." />
          ) : (
            <PerformanceChart
              portfolio={portfolioSeries}
              benchmark={benchmarkSeries}
              portfolioLabel={`Compte ${model.accountType === "PEA" ? "PEA" : "titres"}`}
              benchmarkLabel={benchmarkCode === "NONE" ? null : benchmark?.label ?? null}
            />
          )}
          {!benchmarks.available && <p className="btc-chart-source">Les séries de référence ne sont pas encore créées en base (migration 20260816) : aucune comparaison n’est affichée.</p>}
          {benchmarkCode !== "NONE" && benchmark && benchmark.points.length === 0 && (
            <p className="btc-chart-source">
              Comparaison indisponible : l’historique de {benchmark.label} n’a pas encore été collecté.
              {canManage && " Un administrateur peut le collecter depuis l’onglet Positions › Actualiser les cours."}
            </p>
          )}
          {benchmark?.proxyNote && benchmark.points.length > 0 && <p className="btc-chart-source">{benchmark.proxyNote}</p>}
          <p className="btc-chart-source">Les performances passées ne préjugent pas des performances futures.</p>
        </section>

        {/* ---- Analyse ------------------------------------------------------------------ */}
        <section className="panel inv-perf-analysis">
          <header className="inv-income-head">
            <h3 className="btc-panel-kicker">DIAGNOSTIC DU PORTEFEUILLE</h3>
            <span className="inv-ai-pill" aria-hidden="true">✦ Analyse</span>
          </header>
          {!accountId ? (
            <EmptyState title="Sélectionnez un compte" description="L’analyse porte sur un compte précis, jamais sur une vue agrégée." />
          ) : analysisLoading && !analysis ? (
            <p className="inv-muted">Analyse en cours…</p>
          ) : !analysis || analysis.observations.length === 0 ? (
            <EmptyState title="Analyse indisponible" description="Les données du compte ne permettent pas encore de formuler une observation vérifiable." />
          ) : (
            <ul className="inv-analysis-list">
              {analysis.observations.slice(0, analysisOpen ? 3 : 3).map((observation, index) => (
                <li key={`${observation.title}-${index}`} className={`tone-${observation.tone}`}>
                  <span className="inv-analysis-mark" aria-hidden="true">{observation.tone === "positive" ? "▲" : observation.tone === "risk" ? "!" : "✓"}</span>
                  <div>
                    <strong>{observation.title}</strong>
                    <p>{observation.body}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {analysis && (
            <div className="inv-analysis-foot">
              <button type="button" className="primary-button" onClick={() => setAnalysisOpen((open) => !open)}>
                {analysisOpen ? "Réduire" : "Voir l’analyse complète"}
              </button>
              <button type="button" className="btc-link" disabled={regenerating} onClick={regenerateAnalysis}>
                {regenerating ? "…" : "Régénérer"}
              </button>
            </div>
          )}
          {analysis && analysisOpen && (
            <div className="inv-analysis-detail">
              <h4>Sur quoi repose cette analyse</h4>
              <ul>
                <li>Valeur des positions : {model.positionsValueEur === null ? "non disponible" : euro.format(model.positionsValueEur)}</li>
                <li>Couverture : {model.valuationCoverage.valuedPositions}/{model.valuationCoverage.totalPositions} positions valorisées</li>
                <li>Géographie : {geography.coverage.documentedInstruments}/{geography.coverage.totalInstruments} instruments renseignés</li>
                <li>Secteurs : {sectors.coverage.documentedInstruments}/{sectors.coverage.totalInstruments} instruments renseignés</li>
                <li>Concentration : première ligne {risks[0]?.valuePct === null ? "—" : `${risks[0]?.valuePct?.toFixed(0)} %`} · top 3 {risks[1]?.valuePct === null ? "—" : `${risks[1]?.valuePct?.toFixed(0)} %`}</li>
              </ul>
              <p className="btc-chart-source">
                L’analyse ne peut citer que ces chiffres. Toute observation mentionnant une valeur absente de cet ensemble est rejetée avant affichage.
              </p>
            </div>
          )}
          {analysis && (
            <p className="btc-chart-source inv-analysis-meta">
              {analysis.coverageLabel} · analyse du {dateOf(analysis.generatedAt.slice(0, 10))}
              {analysis.cached ? " (inchangée depuis la dernière évolution du portefeuille)" : ""} · {analysis.disclaimer}
            </p>
          )}
        </section>
      </div>

      {/* ---- Classement + risques ------------------------------------------------------- */}
      <div className="inv-perf-bottom">
        <section className="panel">
          <header className="inv-income-head">
            <h3 className="btc-panel-kicker">MEILLEURES POSITIONS</h3>
            <div className="inv-toggle inv-toggle-small" role="group" aria-label="Critère de classement">
              <button type="button" className={criterion === "percent" ? "active" : ""} onClick={() => setCriterion("percent")}>%</button>
              <button type="button" className={criterion === "contribution" ? "active" : ""} onClick={() => setCriterion("contribution")}>€</button>
            </div>
          </header>
          <RankingList rows={ranking.best} />
        </section>

        <section className="panel">
          <h3 className="btc-panel-kicker">POSITIONS À SURVEILLER</h3>
          <RankingList rows={ranking.worst} />
        </section>

        <section className="panel">
          <h3 className="btc-panel-kicker">RISQUES CLÉS</h3>
          <ul className="inv-risks">
            {risks.map((risk) => (
              <li key={risk.key}>
                <span className="inv-risk-label">{risk.label}</span>
                <span className="inv-risk-track" aria-hidden="true"><i className={`level-${risk.level}`} style={{ width: `${Math.max(2, Math.min(100, risk.valuePct ?? 0))}%` }} /></span>
                <span className="inv-risk-value">{risk.valuePct === null ? "—" : `${risk.valuePct.toFixed(0)} %`}</span>
                <span className={`inv-badge level-${risk.level}`}>{risk.levelLabel}</span>
                <small>{risk.detail}</small>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {/* ---- Décomposition exacte -------------------------------------------------------- */}
      <section className="panel btc-synth">
        <h3 className="btc-panel-kicker">DÉCOMPOSITION DU RÉSULTAT</h3>
        <div className="btc-synth-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))" }}>
          <div><small>Plus-value latente</small><strong>{performance.unrealizedGainEur === null ? "Non disponible" : <GainPill eur={performance.unrealizedGainEur} pct={performance.unrealizedGainPct} />}</strong></div>
          <div><small>Plus-value réalisée</small><strong>{euro.format(performance.realizedGainEur)}</strong><em>Ventes effectives, coût moyen</em></div>
          <div><small>Dividendes reçus</small><strong>{euro.format(performance.dividendsNetEur)}</strong><em>Opérations réelles uniquement</em></div>
          <div><small>Frais</small><strong>{euro.format(performance.feesEur)}</strong><em>Courtage inclus dans le coût + frais isolés</em></div>
          <div><small>TWR</small><strong>{pctLabel(performance.twrPct, 2)}</strong><em>{performance.isReliable ? "Versements neutralisés" : "Flux incomplets"}</em></div>
          <div><small>XIRR</small><strong>{pctLabel(performance.xirrPct, 2)}</strong><em>{performance.xirrPct === null ? "Flux insuffisants" : "Taux actuariel des flux"}</em></div>
          <div><small>Coût des positions valorisées</small><strong>{euro.format(model.valuationCoverage.valuedCostEur)}</strong><em>Base du rendement total</em></div>
          <div><small>Couverture</small><strong>{model.valuationCoverage.valuedPositions} / {model.valuationCoverage.totalPositions}</strong><em>{model.valuationCoverage.coveragePercent.toFixed(0)} % des positions valorisées</em></div>
        </div>
        {ranking.excluded.length > 0 && (
          <p className="btc-chart-source">
            Exclues du classement : {ranking.excluded.map((item) => `${item.name} (${item.reason === "no_price" ? "sans cours" : "sans prix de revient"})`).join(", ")}.
            Elles ne sont jamais valorisées à zéro.
          </p>
        )}
      </section>
    </>
  );
}

function PerfKpi({ icon, label, value, sub, tone }: { icon: string; label: string; value: string; sub: string; tone?: "up" | "down" }) {
  return (
    <article className="panel inv-kpi">
      <span className="inv-kpi-icon" aria-hidden="true">{icon}</span>
      <div>
        <small>{label}</small>
        <strong className={tone ?? ""}>{value}</strong>
        <em>{sub}</em>
      </div>
    </article>
  );
}

function RankingList({ rows }: { rows: RankedPosition[] }) {
  if (rows.length === 0) {
    return <EmptyState title="Classement indisponible" description="Aucune position valorisée avec un prix de revient exploitable." />;
  }
  return (
    <ol className="inv-ranking">
      {rows.map((row, index) => (
        <li key={row.key}>
          <span className="inv-rank-index">{index + 1}</span>
          <div className="inv-rank-id">
            <strong>{row.name}</strong>
            <small>{row.valueEur === null ? "—" : euro0.format(row.valueEur)}{row.currency !== "EUR" ? ` · ${row.currency}` : ""}</small>
          </div>
          <div className="inv-rank-values">
            <b className={(row.gainPct ?? 0) >= 0 ? "up" : "down"}>{row.gainPct === null ? "—" : pctLabel(row.gainPct)}</b>
            <small className={(row.gainEur ?? 0) >= 0 ? "up" : "down"}>{row.gainEur === null ? "—" : `${row.gainEur >= 0 ? "+" : "−"}${euro0.format(Math.abs(row.gainEur))}`}</small>
          </div>
        </li>
      ))}
    </ol>
  );
}

/**
 * Courbe comparée, base commune 0 %. Échelle symétrique autour de zéro quand la performance est
 * négative : c'est ce qui permet de LIRE une perte, plutôt que de l'écraser en bas du cadre.
 */
function PerformanceChart({ portfolio, benchmark, portfolioLabel, benchmarkLabel }: {
  portfolio: NormalizedPoint[];
  benchmark: NormalizedPoint[];
  portfolioLabel: string;
  benchmarkLabel: string | null;
}) {
  const gradientId = useId().replace(/:/g, "");
  const [hover, setHover] = useState<number | null>(null);
  const width = 760;
  const height = 260;
  const pad = { top: 18, right: 18, bottom: 30, left: 54 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;

  const dates = portfolio.map((point) => point.date);
  // Le benchmark est ré-échantillonné sur les dates du portefeuille : deux séries de fréquences
  // différentes tracées côte à côte donneraient une comparaison visuellement fausse.
  const benchmarkAt = (date: string): number | null => {
    let value: number | null = null;
    for (const point of benchmark) {
      if (point.date <= date) value = point.pct;
      else break;
    }
    return value;
  };
  const benchmarkPoints = benchmarkLabel ? dates.map((date) => benchmarkAt(date)) : dates.map(() => null);

  const values = [...portfolio.map((point) => point.pct), ...benchmarkPoints.filter((value): value is number => value !== null)];
  const max = Math.max(5, ...values);
  const min = Math.min(-5, ...values);
  const span = max - min || 1;
  const xFor = (index: number) => pad.left + (dates.length <= 1 ? innerW / 2 : (index / (dates.length - 1)) * innerW);
  const yFor = (value: number) => pad.top + innerH - ((value - min) / span) * innerH;
  const ticks = [min, min + span * 0.25, min + span * 0.5, min + span * 0.75, max];
  const labelEvery = Math.max(1, Math.ceil(dates.length / 7));

  const line = (points: Array<number | null>) => points
    .map((value, index) => (value === null ? null : `${index === 0 || points[index - 1] === null ? "M" : "L"}${xFor(index).toFixed(1)} ${yFor(value).toFixed(1)}`))
    .filter(Boolean)
    .join(" ");

  const portfolioLine = line(portfolio.map((point) => point.pct));
  const last = portfolio[portfolio.length - 1];
  const lastBenchmark = benchmarkPoints[benchmarkPoints.length - 1];

  return (
    <div className="btc-chart-scroll inv-perf-chart-wrap">
      <div className="inv-perf-legend">
        <span><i style={{ background: "#1d706b" }} /> {portfolioLabel}</span>
        {benchmarkLabel && <span><i style={{ background: "#3f7fd4" }} /> {benchmarkLabel}</span>}
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="btc-chart" role="img"
        aria-label={`Performance ${portfolioLabel}${benchmarkLabel ? ` comparée à ${benchmarkLabel}` : ""}, base 0 %`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          const ratio = (event.clientX - bounds.left) / bounds.width;
          const index = Math.round(ratio * width - pad.left) / innerW * (dates.length - 1);
          setHover(Math.max(0, Math.min(dates.length - 1, Math.round(index))));
        }}
      >
        <defs>
          <linearGradient id={`${gradientId}-fill`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#1d706b" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#1d706b" stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={pad.left} x2={width - pad.right} y1={yFor(tick)} y2={yFor(tick)} className="btc-chart-grid" />
            <text x={pad.left - 10} y={yFor(tick)} dy="0.32em" textAnchor="end" className="btc-chart-axis">{`${tick >= 0 ? "" : "−"}${Math.abs(tick).toFixed(0)} %`}</text>
          </g>
        ))}
        <line x1={pad.left} x2={width - pad.right} y1={yFor(0)} y2={yFor(0)} className="inv-chart-zero" />
        {portfolioLine && <path d={`${portfolioLine} L${xFor(dates.length - 1)} ${yFor(min)} L${xFor(0)} ${yFor(min)} Z`} fill={`url(#${gradientId}-fill)`} />}
        {benchmarkLabel && <path d={line(benchmarkPoints)} fill="none" stroke="#3f7fd4" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
        <path d={portfolioLine} fill="none" stroke="#1d706b" strokeWidth={2.4} strokeLinejoin="round" strokeLinecap="round" />
        {hover !== null && dates[hover] && (
          <g>
            <line x1={xFor(hover)} x2={xFor(hover)} y1={pad.top} y2={pad.top + innerH} className="inv-chart-cursor" />
            <circle cx={xFor(hover)} cy={yFor(portfolio[hover].pct)} r={4} fill="#1d706b" />
            {benchmarkPoints[hover] !== null && <circle cx={xFor(hover)} cy={yFor(benchmarkPoints[hover]!)} r={4} fill="#3f7fd4" />}
          </g>
        )}
        {dates.map((date, index) => (index % labelEvery === 0 || index === dates.length - 1 ? (
          <text key={date} x={xFor(index)} y={height - 8} textAnchor="middle" className="btc-chart-axis">{date.slice(0, 7)}</text>
        ) : null))}
        {last && <text x={width - pad.right} y={yFor(last.pct) - 8} textAnchor="end" className="inv-chart-endlabel">{pctLabel(last.pct)}</text>}
        {benchmarkLabel && lastBenchmark !== null && lastBenchmark !== undefined && (
          <text x={width - pad.right} y={yFor(lastBenchmark) + 16} textAnchor="end" className="inv-chart-endlabel benchmark">{pctLabel(lastBenchmark)}</text>
        )}
      </svg>
      {hover !== null && dates[hover] && (
        <div className="inv-chart-tooltip" style={{ left: `${(xFor(hover) / width) * 100}%` }}>
          <strong>{dateOf(dates[hover])}</strong>
          <span><i style={{ background: "#1d706b" }} /> {portfolioLabel} <b>{pctLabel(portfolio[hover].pct)}</b></span>
          {benchmarkLabel && benchmarkPoints[hover] !== null && (
            <span><i style={{ background: "#3f7fd4" }} /> {benchmarkLabel} <b>{pctLabel(benchmarkPoints[hover]!)}</b></span>
          )}
        </div>
      )}
    </div>
  );
}
