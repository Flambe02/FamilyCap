"use client";

import { useId, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { NavIcon } from "./dashboard-ui";
import type { NavIconId } from "../lib/navigation";
import type { MemberColor } from "../lib/family-roster";
import type { TimelinePoint } from "../lib/bitcoin-portfolio";

// ---- Formatters partagés (une seule définition pour toute la section Bitcoin) ----------
export const euro = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });
export const euro0 = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
export const fullDate = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
export const btc8 = (value: number) => `${(value || 0).toFixed(8)} BTC`;
export const signedEuro = (value: number) => `${value >= 0 ? "+" : "−"}${euro.format(Math.abs(value))}`;
export const signedPct = (value: number) => `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(1).replace(".", ",")} %`;
export const eurCompact = (value: number) => {
  const abs = Math.abs(value);
  if (abs >= 1000) return `${(value / 1000).toFixed(abs >= 10000 ? 0 : 1).replace(".", ",")} k€`;
  return `${Math.round(value)} €`;
};
export const dateOf = (iso: string) => fullDate.format(new Date(`${iso}T00:00:00Z`));

// ---- Petits éléments -----------------------------------------------------------------
export function MemberAvatar({ initials, color, size = 34 }: { initials: string; color: MemberColor; size?: number }) {
  return <span className={`btc-avatar btc-avatar-${color}`} style={{ width: size, height: size }} aria-hidden="true">{initials}</span>;
}

export function GainPill({ eur, pct, muted }: { eur: number | null; pct: number | null; muted?: boolean }) {
  if (eur === null) return <span className="btc-gain neutral">{muted ? "Cours indisponible" : "—"}</span>;
  const positive = eur >= 0;
  return <span className={`btc-gain ${positive ? "up" : "down"}`}>{signedEuro(eur)}{pct !== null && <em> ({signedPct(pct)})</em>}</span>;
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    "à préparer": "prepare", "nouvelle": "prepare",
    "en attente": "pending", "en traitement": "pending",
    "envoyé": "sent", "confirmé": "done", "transférée": "done",
    "annulé": "cancelled", "erreur": "error",
  };
  const tone = map[status.toLocaleLowerCase("fr")] ?? "pending";
  return <span className={`btc-status btc-status-${tone}`}>{status}</span>;
}

// ---- KPI -----------------------------------------------------------------------------
export function BitcoinKpi({ label, value, sub, icon, tone, action, onAction }: {
  label: string; value: ReactNode; sub?: ReactNode; icon: NavIconId; tone: "amber" | "teal" | "navy" | "coral" | "blue";
  action?: string; onAction?: () => void;
}) {
  return (
    <article className="btc-kpi">
      <span className={`btc-kpi-icon ${tone}`} aria-hidden="true"><NavIcon id={icon} /></span>
      <div className="btc-kpi-body">
        <p>{label}</p>
        <strong>{value}</strong>
        {sub != null && <small>{sub}</small>}
        {action && <button type="button" className="btc-link" onClick={onAction}>{action} →</button>}
      </div>
    </article>
  );
}

// ---- Donut SVG -----------------------------------------------------------------------
export type DonutSegment = { label: string; value: number; color: string };

export function DonutChart({ segments, centerTop, centerBottom, size = 168, thickness = 20, ariaLabel }: {
  segments: DonutSegment[]; centerTop: string; centerBottom: string; size?: number; thickness?: number; ariaLabel?: string;
}) {
  const total = segments.reduce((sum, segment) => sum + Math.max(0, segment.value), 0);
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const gap = segments.filter((segment) => segment.value > 0).length > 1 ? 2 : 0;
  let offset = 0;
  return (
    <div className="btc-donut" role="img" aria-label={ariaLabel ?? `${centerTop} ${centerBottom}`}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--btc-track)" strokeWidth={thickness} />
        {total > 0 && segments.filter((segment) => segment.value > 0).map((segment) => {
          const fraction = segment.value / total;
          const length = Math.max(0, fraction * circumference - gap);
          const dash = `${length} ${circumference - length}`;
          const circle = (
            <circle key={segment.label} cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={segment.color}
              strokeWidth={thickness} strokeDasharray={dash} strokeDashoffset={-offset} strokeLinecap="butt"
              transform={`rotate(-90 ${size / 2} ${size / 2})`} />
          );
          offset += fraction * circumference;
          return circle;
        })}
      </svg>
      <div className="btc-donut-center"><strong>{centerTop}</strong><small>{centerBottom}</small></div>
    </div>
  );
}

export function LegendRow({ color, name, value, pct }: { color: string; name: string; value: string; pct?: string }) {
  return (
    <li className="btc-legend-row">
      <span className="btc-legend-dot" style={{ background: color }} aria-hidden="true" />
      <span className="btc-legend-name">{name}</span>
      <span className="btc-legend-val">{value}{pct && <em> · {pct}</em>}</span>
    </li>
  );
}

// ---- Courbe d'évolution SVG ----------------------------------------------------------
export type ChartSeries = { key: string; label: string; color: string; get: (point: TimelinePoint) => number; fill?: boolean; dashed?: boolean };

export function EvolutionChart({ points, series, height = 240 }: { points: TimelinePoint[]; series: ChartSeries[]; height?: number }) {
  const gradientId = useId().replace(/:/g, "");
  const width = 760;
  const pad = { top: 16, right: 16, bottom: 28, left: 52 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;

  const values = series.flatMap((s) => points.map((point) => s.get(point)));
  const maxValue = Math.max(1, ...values);
  const yMax = niceCeil(maxValue * 1.1);
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((step) => Math.round(yMax * step));

  const xFor = (index: number) => pad.left + (points.length <= 1 ? innerW / 2 : (index / (points.length - 1)) * innerW);
  const yFor = (value: number) => pad.top + innerH - (value / yMax) * innerH;

  const labelEvery = Math.max(1, Math.ceil(points.length / 8));

  if (points.length === 0) {
    return <div className="btc-chart-empty">Pas encore assez d’opérations pour tracer une évolution.</div>;
  }

  return (
    <div className="btc-chart-scroll">
      <svg viewBox={`0 0 ${width} ${height}`} className="btc-chart" role="img" aria-label="Évolution de la valeur du portefeuille Bitcoin">
        <defs>
          {series.filter((s) => s.fill).map((s) => (
            <linearGradient key={s.key} id={`${gradientId}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity="0.28" />
              <stop offset="100%" stopColor={s.color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>
        {yTicks.map((tick) => (
          <g key={tick}>
            <line x1={pad.left} x2={width - pad.right} y1={yFor(tick)} y2={yFor(tick)} className="btc-chart-grid" />
            <text x={pad.left - 10} y={yFor(tick)} dy="0.32em" textAnchor="end" className="btc-chart-axis">{eurCompact(tick)}</text>
          </g>
        ))}
        {series.map((s) => {
          const line = points.map((point, index) => `${index === 0 ? "M" : "L"}${xFor(index).toFixed(1)} ${yFor(s.get(point)).toFixed(1)}`).join(" ");
          const area = `${line} L${xFor(points.length - 1).toFixed(1)} ${yFor(0)} L${xFor(0).toFixed(1)} ${yFor(0)} Z`;
          return (
            <g key={s.key}>
              {s.fill && <path d={area} fill={`url(#${gradientId}-${s.key})`} />}
              <path d={line} fill="none" stroke={s.color} strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" strokeDasharray={s.dashed ? "5 4" : undefined} />
            </g>
          );
        })}
        {points.map((point, index) => index % labelEvery === 0 || index === points.length - 1 ? (
          <text key={point.monthKey} x={xFor(index)} y={height - 8} textAnchor="middle" className="btc-chart-axis">{point.label}</text>
        ) : null)}
      </svg>
    </div>
  );
}

function niceCeil(value: number): number {
  if (value <= 0) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

export function PeriodFilter<T extends string>({ value, options, onChange }: { value: T; options: { id: T; label: string }[]; onChange: (value: T) => void }) {
  return (
    <div className="btc-period" role="group" aria-label="Choisir la période">
      {options.map((option) => (
        <button key={option.id} type="button" className={value === option.id ? "active" : ""} aria-pressed={value === option.id} onClick={() => onChange(option.id)}>{option.label}</button>
      ))}
    </div>
  );
}

// ---- Empty state utile ----------------------------------------------------------------
export function EmptyState({ icon, title, description, action, onAction }: { icon?: string; title: string; description: string; action?: string; onAction?: () => void }) {
  return (
    <div className="btc-empty">
      <span className="btc-empty-icon" aria-hidden="true">{icon ?? "✦"}</span>
      <strong>{title}</strong>
      <p>{description}</p>
      {action && <button type="button" className="secondary-button" onClick={onAction}>{action}</button>}
    </div>
  );
}

export function InfoNote({ title, children, action, onAction }: { title: string; children: ReactNode; action?: string; onAction?: () => void }) {
  return (
    <div className="btc-note">
      <span className="btc-note-icon" aria-hidden="true"><NavIcon id="book-open" /></span>
      <div className="btc-note-body"><strong>{title}</strong><p>{children}</p></div>
      {action && <button type="button" className="btc-link" onClick={onAction}>{action} →</button>}
    </div>
  );
}

// ---- Accordéon pédagogique -----------------------------------------------------------
export function Accordion({ items }: { items: { id: string; question: string; answer: ReactNode }[] }) {
  const [open, setOpen] = useState<string | null>(items[0]?.id ?? null);
  return (
    <div className="btc-accordion">
      {items.map((item) => {
        const isOpen = open === item.id;
        return (
          <div key={item.id} className={`btc-accordion-item ${isOpen ? "open" : ""}`}>
            <button type="button" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : item.id)}>
              <span>{item.question}</span>
              <b aria-hidden="true">{isOpen ? "−" : "+"}</b>
            </button>
            {isOpen && <div className="btc-accordion-body">{item.answer}</div>}
          </div>
        );
      })}
    </div>
  );
}

export function useDonutSegments(source: { label: string; value: number; color: string }[]) {
  return useMemo(() => source.filter((segment) => segment.value > 0), [source]);
}
