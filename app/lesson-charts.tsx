"use client";

// Briques graphiques des articles pédagogiques.
//
// Aucune bibliothèque de graphiques n'est installée dans le projet (ni Recharts, ni Chart.js, ni
// Tremor) et les visualisations existantes — donut et courbe de la section Bitcoin — sont déjà des
// SVG écrits à la main. On reste sur ce choix : cinq graphiques simples ne justifient pas une
// dépendance de plusieurs centaines de kilo-octets.
//
// Trois partis pris d'accessibilité, valables pour tous les graphiques d'ici :
//  1. Le nom accessible de chaque élément focusable contient DÉJÀ toute l'information de
//     l'infobulle (« 1 000 € par mois : 22 ans et 10 mois pour atteindre 500 000 € … »). La zone
//     de lecture visuelle est donc `aria-hidden` : elle sert l'œil, pas le lecteur d'écran, qui
//     entendrait sinon deux fois la même phrase.
//  2. Un tableau de données complet accompagne chaque graphique. Il est masqué visuellement
//     (`.sr-only`, défini dans globals.css) mais reste dans l'arbre d'accessibilité.
//  3. La couleur n'est jamais le seul porteur d'information : chaque série est nommée dans la
//     légende avec son style de trait, et chaque valeur est écrite en toutes lettres.
//
// Les tracés utilisent `preserveAspectRatio="none"` + `vector-effect="non-scaling-stroke"` :
// le SVG s'étire librement dans son conteneur, mais tous les textes (axes, annotations, points)
// sont du HTML positionné en pourcentage — ils gardent donc leur taille réelle à 320 px de large,
// là où un texte placé dans le SVG deviendrait illisible. C'est aussi ce qui évite tout défilement
// horizontal : rien n'a de largeur minimale en pixels.

import { useId, useState, type ReactNode } from "react";
import { niceCeil } from "./bitcoin-components";
import "./lesson-charts.css";

/** Format des graduations : le `eurCompact` de la section Bitcoin ne sait pas dire « 1 M€ ». */
export function eurAxis(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(abs % 1_000_000 === 0 ? 0 : 1).replace(".", ",")} M€`;
  if (abs >= 1000) return `${Math.round(value / 1000)} k€`;
  return `${Math.round(value)} €`;
}

export type ChartTable = { caption: string; head: string[]; rows: string[][] };

/**
 * Enveloppe commune : titre, sous-titre, zone de lecture, légende, tableau de repli et mention
 * « Simulation pédagogique ». Le graphique est relié à son titre et à son sous-titre par
 * `aria-labelledby` / `aria-describedby`.
 */
export function ArticleChartCard({ id, title, subtitle, legend, readout, table, children }: {
  id: string; title: string; subtitle: string; legend?: ReactNode; readout: ReactNode; table: ChartTable; children: ReactNode;
}) {
  return (
    <figure className="art-chart" aria-labelledby={`${id}-title`}>
      <figcaption className="art-chart-head">
        <h4 id={`${id}-title`}>{title}</h4>
        <p id={`${id}-desc`}>{subtitle}</p>
      </figcaption>
      <div className="art-chart-plot" role="group" aria-labelledby={`${id}-title`} aria-describedby={`${id}-desc`}>{children}</div>
      {legend}
      <p className="art-chart-readout" aria-hidden="true">{readout}</p>
      {/* `.sr-only` est posé sur un DIV, jamais sur le `<table>` : un tableau traite `width: 1px`
          comme un minimum et reste large comme son contenu (≈ 550 px), ce qui provoquait un
          débordement horizontal de la modale sur mobile. Le div, lui, découpe réellement. */}
      <div className="sr-only">
        <table>
          <caption>{table.caption}</caption>
          <thead><tr>{table.head.map((cell) => <th key={cell} scope="col">{cell}</th>)}</tr></thead>
          <tbody>
            {table.rows.map((row) => (
              <tr key={row[0]}>{row.map((cell, index) => index === 0 ? <th key={cell} scope="row">{cell}</th> : <td key={`${row[0]}-${index}`}>{cell}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="art-chart-note">Simulation pédagogique</p>
    </figure>
  );
}

/** Légende : pastille de couleur + libellé + précision non colorée (style de trait, rôle…). */
export function ChartLegend({ items }: { items: { key: string; color: string; label: string; note?: string }[] }) {
  return (
    <ul className="art-legend">
      {items.map((item) => (
        <li key={item.key}>
          <span className="art-legend-swatch" style={{ background: item.color }} aria-hidden="true" />
          <b>{item.label}</b>
          {item.note && <em>{item.note}</em>}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------------------------
// Barres horizontales — graphiques 1 et 3
// ---------------------------------------------------------------------------------------------

export type BarDatum = {
  key: string;
  /** Libellé de catégorie, à gauche de la barre. */
  label: string;
  value: number;
  /** Valeur écrite au bout de la barre, sans décimale brute. */
  valueLabel: string;
  color: string;
  /** Repère de lecture : ajoute un badge textuel, jamais une simple nuance de couleur. */
  badge?: string;
  /** Nom accessible complet du bouton : c'est l'infobulle, pour le lecteur d'écran. */
  description: string;
  /** Détail affiché dans la zone de lecture au survol ou au focus. */
  readout: ReactNode;
};

export function HorizontalBarChart({ id, title, subtitle, data, table, hint, legend }: {
  id: string; title: string; subtitle: string; data: BarDatum[]; table: ChartTable; hint: string; legend?: ReactNode;
}) {
  const [active, setActive] = useState<string | null>(null);
  const max = Math.max(...data.map((datum) => datum.value), 1);
  const current = data.find((datum) => datum.key === active);
  const clear = (key: string) => setActive((previous) => (previous === key ? null : previous));

  return (
    <ArticleChartCard id={id} title={title} subtitle={subtitle} legend={legend} table={table} readout={current ? current.readout : hint}>
      <ul className="art-bars">
        {data.map((datum) => (
          <li key={datum.key}>
            <button
              type="button"
              className={`art-bar${datum.badge ? " is-flagged" : ""}${active === datum.key ? " is-active" : ""}`}
              aria-label={datum.description}
              onMouseEnter={() => setActive(datum.key)}
              onMouseLeave={() => clear(datum.key)}
              onFocus={() => setActive(datum.key)}
              onBlur={() => clear(datum.key)}
              onClick={() => setActive((previous) => (previous === datum.key ? null : datum.key))}
            >
              <span className="art-bar-head" aria-hidden="true">
                <span className="art-bar-label">{datum.label}</span>
                {datum.badge && <span className="art-bar-badge">{datum.badge}</span>}
                <span className="art-bar-value art-bar-value-stacked">{datum.valueLabel}</span>
              </span>
              <span className="art-bar-track" aria-hidden="true">
                {/* La barre ne dépasse jamais 78 % de la piste : les 22 % restants accueillent la
                    valeur écrite, qui ne peut donc pas sortir de la carte. */}
                <span className="art-bar-fill" style={{ width: `${(datum.value / max) * 78}%`, background: datum.color }} />
                <span className="art-bar-value art-bar-value-inline" style={{ left: `calc(${(datum.value / max) * 78}% + 10px)` }}>{datum.valueLabel}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </ArticleChartCard>
  );
}

// ---------------------------------------------------------------------------------------------
// Colonnes groupées — graphique 5
// ---------------------------------------------------------------------------------------------

export type ColumnDatum = { key: string; label: string; value: number; valueLabel: string; color: string; description: string; readout: ReactNode };
export type ColumnGroup = { key: string; label: string; pickerLabel: string; columns: ColumnDatum[] };

/**
 * Desktop : tous les groupes côte à côte. Mobile : un sélecteur de scénario, un seul groupe
 * affiché. Le basculement est fait en CSS pur (`display: none`) et non par une media query lue en
 * JavaScript : le rendu serveur et le rendu client sont donc strictement identiques — aucune
 * erreur d'hydratation possible — et les boutons masqués sortent naturellement du parcours clavier.
 */
export function ColumnGroupChart({ id, title, subtitle, groups, table, hint, legend, pickerLabel }: {
  id: string; title: string; subtitle: string; groups: ColumnGroup[]; table: ChartTable; hint: string; legend?: ReactNode; pickerLabel: string;
}) {
  const [active, setActive] = useState<string | null>(null);
  const [scenario, setScenario] = useState(groups[0]?.key ?? "");
  const max = Math.max(...groups.flatMap((group) => group.columns.map((column) => column.value)), 1);
  const current = groups.flatMap((group) => group.columns).find((column) => column.key === active);
  const clear = (key: string) => setActive((previous) => (previous === key ? null : previous));

  return (
    <ArticleChartCard id={id} title={title} subtitle={subtitle} legend={legend} table={table} readout={current ? current.readout : hint}>
      <div className="art-scenario" role="group" aria-label={pickerLabel}>
        {groups.map((group) => (
          <button key={group.key} type="button" className={scenario === group.key ? "is-active" : ""} aria-pressed={scenario === group.key} onClick={() => setScenario(group.key)}>
            {group.pickerLabel}
          </button>
        ))}
      </div>
      <div className="art-groups">
        {groups.map((group) => (
          <div className="art-group" key={group.key} data-active={scenario === group.key ? "true" : "false"}>
            <div className="art-columns">
              {group.columns.map((column) => (
                <button
                  key={column.key}
                  type="button"
                  className={`art-column${active === column.key ? " is-active" : ""}`}
                  aria-label={column.description}
                  onMouseEnter={() => setActive(column.key)}
                  onMouseLeave={() => clear(column.key)}
                  onFocus={() => setActive(column.key)}
                  onBlur={() => clear(column.key)}
                  onClick={() => setActive((previous) => (previous === column.key ? null : column.key))}
                >
                  <span className="art-column-value" aria-hidden="true">{column.valueLabel}</span>
                  <span className="art-column-track" aria-hidden="true">
                    <span className="art-column-fill" style={{ height: `${(column.value / max) * 100}%`, background: column.color }} />
                  </span>
                  <span className="art-column-label" aria-hidden="true">{column.label}</span>
                </button>
              ))}
            </div>
            <p className="art-group-label" aria-hidden="true">{group.label}</p>
          </div>
        ))}
      </div>
    </ArticleChartCard>
  );
}

// ---------------------------------------------------------------------------------------------
// Séries temporelles — graphiques 2 et 4
// ---------------------------------------------------------------------------------------------

export type TimeSeries = { key: string; label: string; color: string; values: number[]; dashed?: boolean; area?: boolean };
export type TimePoint = { key: string; label: string; description: string; readout: ReactNode };

export function TimeSeriesChart({ id, title, subtitle, points, series, band, annotation, table, hint, legend, xUnit }: {
  id: string; title: string; subtitle: string; points: TimePoint[]; series: TimeSeries[];
  /** Zone teintée entre deux séries (écart de frais, part des gains…). */
  band?: { from: string; to: string; color: string };
  /** `top` en pourcentage de la hauteur du tracé ; par défaut collée en haut. */
  annotation?: { index: number; text: string; top?: number };
  table: ChartTable; hint: string; legend?: ReactNode; xUnit: string;
}) {
  const gradientId = useId().replace(/:/g, "");
  const [active, setActive] = useState<number | null>(null);
  const count = points.length;
  const maxValue = Math.max(...series.flatMap((serie) => serie.values), 1);
  const yMax = niceCeil(maxValue);
  const ticks = [1, 0.75, 0.5, 0.25, 0].map((step) => Math.round(yMax * step));

  const xPct = (index: number) => (count <= 1 ? 50 : (index / (count - 1)) * 100);
  const yPct = (value: number) => 100 - (value / yMax) * 100;
  const lineOf = (values: number[]) => values.map((value, index) => `${index === 0 ? "M" : "L"}${xPct(index).toFixed(3)} ${yPct(value).toFixed(3)}`).join(" ");
  const byKey = (key: string) => series.find((serie) => serie.key === key);

  const bandPath = (() => {
    if (!band) return null;
    const upper = byKey(band.from)?.values;
    const lower = byKey(band.to)?.values;
    if (!upper || !lower) return null;
    const back = lower.map((value, index) => `L${xPct(lower.length - 1 - index).toFixed(3)} ${yPct(lower[lower.length - 1 - index]).toFixed(3)}`).join(" ");
    return `${lineOf(upper)} ${back} Z`;
  })();

  return (
    <ArticleChartCard id={id} title={title} subtitle={subtitle} legend={legend} table={table} readout={active !== null ? points[active].readout : hint}>
      <div className="art-plot">
        <div className="art-plot-y" aria-hidden="true">
          {ticks.map((tick) => <span key={tick} style={{ top: `${yPct(tick)}%` }}>{eurAxis(tick)}</span>)}
        </div>
        <div className="art-plot-area">
          <svg className="art-plot-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
            <defs>
              {series.filter((serie) => serie.area).map((serie) => (
                <linearGradient key={serie.key} id={`${gradientId}-${serie.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={serie.color} stopOpacity="0.24" />
                  <stop offset="100%" stopColor={serie.color} stopOpacity="0.02" />
                </linearGradient>
              ))}
            </defs>
            {ticks.map((tick) => <line key={tick} className="art-plot-grid" x1="0" x2="100" y1={yPct(tick)} y2={yPct(tick)} vectorEffect="non-scaling-stroke" />)}
            {bandPath && <path d={bandPath} fill={band!.color} />}
            {series.filter((serie) => serie.area).map((serie) => (
              <path key={`${serie.key}-area`} d={`${lineOf(serie.values)} L100 100 L0 100 Z`} fill={`url(#${gradientId}-${serie.key})`} />
            ))}
            {series.map((serie) => (
              <path key={serie.key} d={lineOf(serie.values)} fill="none" stroke={serie.color} strokeWidth={2.2}
                strokeLinecap="round" strokeLinejoin="round" strokeDasharray={serie.dashed ? "6 5" : undefined} vectorEffect="non-scaling-stroke" />
            ))}
          </svg>

          {/* Points actifs et annotation : en HTML, donc parfaitement ronds et lisibles quelle que
              soit la largeur — un cercle SVG serait ovalisé par `preserveAspectRatio="none"`. */}
          {active !== null && series.map((serie) => (
            <span key={serie.key} className="art-plot-dot" style={{ left: `${xPct(active)}%`, top: `${yPct(serie.values[active])}%`, borderColor: serie.color }} aria-hidden="true" />
          ))}
          {active !== null && <span className="art-plot-rule" style={{ left: `${xPct(active)}%` }} aria-hidden="true" />}
          {annotation && (
            <span className="art-plot-annotation" style={{ right: `${100 - xPct(annotation.index)}%`, top: `${annotation.top ?? 3}%` }} aria-hidden="true">{annotation.text}</span>
          )}

          <div className="art-plot-hits">
            {points.map((point, index) => (
              <button
                key={point.key}
                type="button"
                className={active === index ? "is-active" : ""}
                style={{ left: `${xPct(index)}%`, width: `${100 / Math.max(1, count - 1)}%` }}
                aria-label={point.description}
                onMouseEnter={() => setActive(index)}
                onMouseLeave={() => setActive((previous) => (previous === index ? null : previous))}
                onFocus={() => setActive(index)}
                onBlur={() => setActive((previous) => (previous === index ? null : previous))}
                onClick={() => setActive((previous) => (previous === index ? null : index))}
              />
            ))}
          </div>
        </div>
      </div>
      <div className="art-plot-x" aria-hidden="true">
        {points.map((point, index) => (
          <span key={point.key} style={{ left: `${xPct(index)}%`, transform: index === 0 ? "none" : index === count - 1 ? "translateX(-100%)" : "translateX(-50%)" }}>{point.label}</span>
        ))}
        <b>{xUnit}</b>
      </div>
    </ArticleChartCard>
  );
}
