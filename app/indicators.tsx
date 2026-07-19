"use client";

import { useMemo, useState } from "react";
import { computePurchasePriceData, PURCHASE_PRICE_MEMBERS, type PurchaseSourceRecord } from "../lib/gift-history";
import "./indicators.css";

const euro = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const euroCompact = (value: number) => `${Math.round(value / 1000)} k€`;
const euroK1 = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const euroKDecimal = (value: number) => `${euroK1.format(value / 1000)} k€`;
const percent = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1, signDisplay: "always" });
const monthShort = new Intl.DateTimeFormat("fr-FR", { month: "short", timeZone: "UTC" });
const monthOf = (giftDate: string) => monthShort.format(new Date(`${giftDate}T00:00:00Z`)).replace(".", "");
const MONTH_LABELS = Array.from({ length: 12 }, (_, month) => monthShort.format(new Date(Date.UTC(2024, month, 1))).replace(".", ""));
const fullDate = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const dateOf = (giftDate: string) => fullDate.format(new Date(`${giftDate}T00:00:00Z`));
const btcAmountFormat = (value: number) => `${value.toFixed(8)} BTC`;

const WIDTH = 880;
const HEIGHT = 300;
const PAD = { top: 18, right: 20, bottom: 34, left: 56 };

type ChartPoint = { catIndex: number; price: number; amountEur: number; btcAmount: number; giftDate: string; onLedger: boolean };
type ChartSeries = { member: string; points: ChartPoint[] };

function runsOf(points: ChartPoint[]) {
  const runs: ChartPoint[][] = [];
  for (const point of points) {
    const last = runs[runs.length - 1];
    if (last && point.catIndex === last[last.length - 1].catIndex + 1) last.push(point);
    else runs.push([point]);
  }
  return runs;
}

function PriceChart({ categories, series, bitcoinEur, average, emptyNote }: { categories: string[]; series: ChartSeries[]; bitcoinEur: number | null; average: number; emptyNote?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const colSpan = (WIDTH - PAD.left - PAD.right) / (categories.length - 1);
  const hasAnyPoint = series.some((s) => s.points.length > 0);

  function xFor(index: number) {
    const span = WIDTH - PAD.left - PAD.right;
    return PAD.left + (index / (categories.length - 1)) * span;
  }
  const maxDataPrice = Math.max(...series.flatMap((s) => s.points.map((point) => point.price)), bitcoinEur ?? 0, average);
  const yMax = Math.max(10000, Math.ceil((maxDataPrice * 1.12) / 10000) * 10000);
  const yTicks = [0, 1, 2, 3, 4].map((step) => Math.round((yMax * step) / 4));
  function yFor(price: number) {
    const span = HEIGHT - PAD.top - PAD.bottom;
    return HEIGHT - PAD.bottom - (price / yMax) * span;
  }

  return <div className="indicators-body">
    {!hasAnyPoint && emptyNote && <p className="indicators-empty-note">{emptyNote}</p>}
    <div className="indicators-scroll">
      <div className="indicators-chart-wrap">
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="Prix d’achat du bitcoin par enfant, comparé au cours actuel">
          {yTicks.map((tick) => <g key={tick}>
            <line x1={PAD.left} x2={WIDTH - PAD.right} y1={yFor(tick)} y2={yFor(tick)} className="indicators-grid" />
            <text x={PAD.left - 10} y={yFor(tick)} dy="0.32em" textAnchor="end" className="indicators-axis-label">{euroCompact(tick)}</text>
          </g>)}

          <line x1={PAD.left} x2={WIDTH - PAD.right} y1={yFor(average)} y2={yFor(average)} className="indicators-average-line" />
          <text x={WIDTH - PAD.right} y={yFor(average) - 7} textAnchor="end" className="indicators-average-label">Moyenne achat · {euroCompact(average)}</text>

          {bitcoinEur && <>
            <line x1={PAD.left} x2={WIDTH - PAD.right} y1={yFor(bitcoinEur)} y2={yFor(bitcoinEur)} className="indicators-current-line" />
            <text x={PAD.left + 4} y={yFor(bitcoinEur) - 7} textAnchor="start" className="indicators-current-label">Cours actuel · {euroCompact(bitcoinEur)}</text>
          </>}

          {hover !== null && <line x1={xFor(hover)} x2={xFor(hover)} y1={PAD.top} y2={HEIGHT - PAD.bottom} className="indicators-crosshair" />}

          {series.map((s) => runsOf(s.points).map((run, runIndex) => <path
            key={`${s.member}-${runIndex}`}
            d={run.map((point, i) => `${i === 0 ? "M" : "L"}${xFor(point.catIndex)} ${yFor(point.price)}`).join(" ")}
            className={`indicators-line indicators-line-${s.member.toLowerCase()}`}
            fill="none"
          />))}

          {series.map((s) => s.points.map((point) => <circle
            key={`${s.member}-${point.catIndex}`}
            cx={xFor(point.catIndex)}
            cy={yFor(point.price)}
            r={hover === point.catIndex ? 4.5 : 3}
            className={`indicators-dot indicators-dot-${s.member.toLowerCase()}`}
          />))}

          {categories.map((label, index) => <rect
            key={label}
            x={xFor(index) - colSpan / 2}
            y={PAD.top}
            width={colSpan}
            height={HEIGHT - PAD.top - PAD.bottom}
            className="indicators-hover-col"
            onMouseEnter={() => setHover(index)}
            onMouseLeave={() => setHover((current) => (current === index ? null : current))}
            onClick={() => setHover((current) => (current === index ? null : index))}
          />)}

          {categories.map((label, index) => <text key={label} x={xFor(index)} y={HEIGHT - PAD.bottom + 20} textAnchor="middle" className="indicators-axis-label">{label}</text>)}
        </svg>

        {hover !== null && series.some((s) => s.points.some((p) => p.catIndex === hover)) && <div className="indicators-tooltip" style={{ left: `${(xFor(hover) / WIDTH) * 100}%` }}>
          <strong>{categories[hover]}</strong>
          {series.filter((s) => s.points.some((point) => point.catIndex === hover)).map((s) => {
            const point = s.points.find((item) => item.catIndex === hover)!;
            const currentValue = bitcoinEur ? point.btcAmount * bitcoinEur : null;
            const gainEur = currentValue === null ? null : currentValue - point.amountEur;
            const gainPct = gainEur === null ? null : (gainEur / point.amountEur) * 100;
            return <span key={s.member} className={`indicators-tooltip-row indicators-tooltip-${s.member.toLowerCase()}`}>
              {s.member} <i>({monthOf(point.giftDate)}{point.onLedger ? " · L" : ""})</i> · {euro.format(point.price)}
              {gainEur !== null && <em className={gainEur >= 0 ? "positive" : "negative"}> · {gainEur >= 0 ? "+" : ""}{euro.format(gainEur)} ({percent.format(gainPct!)} %)</em>}
            </span>;
          })}
        </div>}
      </div>
    </div>
    <p className="indicators-hint">Touchez une colonne pour afficher le prix d’achat, le mois et la plus ou moins-value de chaque enfant. « L » indique un cadeau déjà transféré sur Ledger.</p>

    <ul className="indicators-legend">
      {PURCHASE_PRICE_MEMBERS.map((member) => <li key={member} className={`indicators-legend-${member.toLowerCase()}`}><span aria-hidden="true" />{member}</li>)}
      <li className="indicators-legend-average"><span aria-hidden="true" />Moyenne achat</li>
      {bitcoinEur && <li className="indicators-legend-current"><span aria-hidden="true" />Cours actuel</li>}
    </ul>
  </div>;
}

export function Indicators({ records, bitcoinEur }: { records: PurchaseSourceRecord[]; bitcoinEur: number | null }) {
  const [viewMode, setViewMode] = useState<"chart" | "monthly" | "table">("chart");

  const data = useMemo(() => computePurchasePriceData(records), [records]);
  const totalGifts = useMemo(() => data.series.reduce((sum, series) => sum + series.points.length, 0), [data]);
  const lastYearWithData = useMemo(() => data.years.filter((year) => data.series.some((series) => series.points.some((point) => point.giftDate.slice(0, 4) === String(year)))).pop() ?? data.years[data.years.length - 1], [data]);
  const [year, setYear] = useState(lastYearWithData);
  const activeYear = data.years.includes(year) ? year : lastYearWithData;

  const totalCurrentValue = bitcoinEur ? data.totalBtc * bitcoinEur : null;
  const totalGainEur = totalCurrentValue === null ? null : totalCurrentValue - data.totalInvestedEur;
  const totalGainPct = totalGainEur === null || data.totalInvestedEur <= 0 ? null : (totalGainEur / data.totalInvestedEur) * 100;

  const yearSeries = useMemo<ChartSeries[]>(() => data.series.map((s) => ({
    member: s.member,
    points: s.points.filter((point) => point.giftDate.slice(0, 4) === String(activeYear))
      .map((point) => ({ catIndex: Number(point.giftDate.slice(5, 7)) - 1, price: point.price, amountEur: point.amountEur, btcAmount: point.btcAmount, giftDate: point.giftDate, onLedger: point.onLedger })),
  })), [data, activeYear]);

  const mainSeries = useMemo<ChartSeries[]>(() => data.series.map((s) => ({
    member: s.member,
    points: s.points.map((point) => ({ catIndex: point.index, price: point.price, amountEur: point.amountEur, btcAmount: point.btcAmount, giftDate: point.giftDate, onLedger: point.onLedger })),
  })), [data]);

  return <div className="page-stack indicators-page">
    <section className="panel indicators-hero">
      <div>
        <span>INDICATEURS FAMILLE</span>
        <h2>Prix d’achat du bitcoin, cadeau par cadeau</h2>
        <p>Chaque point est un anniversaire ou un Noël où un cadeau a réellement été acheté, qu’il soit encore sur Binance ou déjà transféré sur Ledger. Moyenne pondérée sur l’ensemble des achats familiaux : <strong>{euro.format(data.average)} / BTC</strong>.</p>
      </div>
      <div className="indicators-hero-stats">
        <div className="indicators-hero-stat">
          <span>{totalGifts}</span>
          <small>cadeaux suivis</small>
        </div>
        <div className="indicators-hero-stat">
          {totalGainEur === null
            ? <><span className="indicators-stat-muted">—</span><small>Cours indisponible</small></>
            : <><span className={totalGainEur >= 0 ? "indicators-stat-positive" : "indicators-stat-negative"}>{totalGainEur >= 0 ? "+" : ""}{euroCompact(totalGainEur)}</span><small>Plus-value totale {totalGainPct !== null ? `(${percent.format(totalGainPct)} %)` : ""}</small></>}
        </div>
      </div>
    </section>

    <section className="panel indicators-chart-panel">
      <header>
        <div><span>HISTORIQUE DES ACHATS</span><h3>Prix achat BTC par personne</h3></div>
        <div className="indicators-view-tabs" role="group" aria-label="Choisir l’affichage">
          <button type="button" className={viewMode === "chart" ? "active" : ""} onClick={() => setViewMode("chart")}>Graphique</button>
          <button type="button" className={viewMode === "monthly" ? "active" : ""} onClick={() => setViewMode("monthly")}>Vue mensuelle</button>
          <button type="button" className={viewMode === "table" ? "active" : ""} onClick={() => setViewMode("table")}>Tableau</button>
        </div>
      </header>

      {viewMode === "chart" && <PriceChart categories={data.categories} series={mainSeries} bitcoinEur={bitcoinEur} average={data.average} />}

      {viewMode === "monthly" && <>
        <div className="indicators-year-picker" role="group" aria-label="Choisir l’année">
          {data.years.map((y) => <button type="button" key={y} className={y === activeYear ? "active" : ""} onClick={() => setYear(y)} aria-pressed={y === activeYear}>{y}</button>)}
        </div>
        <PriceChart key={activeYear} categories={MONTH_LABELS} series={yearSeries} bitcoinEur={bitcoinEur} average={data.average} emptyNote={`Aucun cadeau enregistré pour ${activeYear} pour le moment.`} />
      </>}

      {viewMode === "table" && <><p className="indicators-hint">Survolez ou touchez un montant pour voir la date, la quantité achetée et la plus ou moins-value.</p>
      <div className="indicators-scroll">
        <table className="indicators-table">
          <thead><tr><th scope="col">Enfant</th>{data.categories.map((label) => <th scope="col" key={label}>{label}</th>)}<th scope="col" className="indicators-table-average-col">Moyenne</th></tr></thead>
          <tbody>{data.series.map((series) => {
            const memberInvested = series.points.reduce((sum, point) => sum + point.amountEur, 0);
            const memberBtc = series.points.reduce((sum, point) => sum + point.btcAmount, 0);
            const memberAverage = memberBtc > 0 ? memberInvested / memberBtc : null;
            return <tr key={series.member}>
              <th scope="row" className={`indicators-legend-${series.member.toLowerCase()}`}>{series.member}</th>
              {data.categories.map((label, index) => {
                const point = series.points.find((item) => item.index === index);
                if (!point) return <td key={label}>—</td>;
                const currentValue = bitcoinEur ? point.btcAmount * bitcoinEur : null;
                const gainEur = currentValue === null ? null : currentValue - point.amountEur;
                const gainPct = gainEur === null ? null : (gainEur / point.amountEur) * 100;
                return <td key={label} className="indicators-table-cell">
                  <button type="button" className="indicators-cell-trigger">
                    {euroKDecimal(point.price)}
                    <span className="indicators-cell-tooltip">
                      <strong>{dateOf(point.giftDate)}</strong>
                      <span>Quantité achetée : {btcAmountFormat(point.btcAmount)}</span>
                      <span>Prix d’achat : {euro.format(point.price)} / BTC</span>
                      {gainEur !== null && <span className={gainEur >= 0 ? "positive" : "negative"}>Plus/moins-value : {gainEur >= 0 ? "+" : ""}{euro.format(gainEur)} ({percent.format(gainPct!)} %)</span>}
                      {point.onLedger && <span>Déjà transféré sur Ledger</span>}
                    </span>
                  </button>
                </td>;
              })}
              <td className="indicators-table-average-col">{memberAverage !== null ? euroKDecimal(memberAverage) : "—"}</td>
            </tr>;
          })}</tbody>
        </table>
      </div></>}
    </section>
  </div>;
}
