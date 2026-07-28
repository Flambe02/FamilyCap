"use client";

// Répartition géographique et sectorielle — carte du Résumé, bandeau de couverture et détail.
//
// Ce fichier a une obsession : ne jamais présenter une répartition comme complète quand elle ne
// l'est pas. Concrètement, trois choses sont toujours visibles quand elles s'appliquent :
//   * la part « Non renseigné », en gris, jamais redistribuée sur les autres zones ;
//   * un bandeau « Analyse partielle. N positions sur M sont correctement renseignées. » ;
//   * le détail, ouvrable, des instruments non reconnus AVEC la raison exacte.
//
// Une part marquée « approximation » (composition d'indice indicative, pays de domiciliation)
// porte son badge dans la légende : l'utilisateur doit pouvoir distinguer, d'un regard, ce qui
// est mesuré de ce qui est approché.

import { useCallback, useEffect, useMemo, useState } from "react";
import { authenticatedFetch } from "./investment-shared";
import { DonutChart, EmptyState, LegendRow, euro } from "./bitcoin-components";
import { useDialogA11y } from "./use-dialog-a11y";
import {
  computeExposureModel, UNKNOWN_CODE,
  type ExposureDimension, type ExposureGap, type ExposureModel, type InstrumentExposure,
} from "../lib/portfolio-exposure";
import type { PortfolioPosition } from "../lib/portfolio-account";
// Habillage commun aux trois écrans (Résumé, Revenus, Performance) : importé ici parce que ce
// module est le premier des trois chargé par le shell.
import "./investment-insights.css";

const ISIN_SHAPE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;

type ExposurePayload = { available: boolean; exposures: InstrumentExposure[] };

/**
 * Charge les expositions des instruments détenus. `available: false` signifie « la table n'existe
 * pas encore » (migration non jouée) — un état à DIRE, différent d'un portefeuille réellement sans
 * exposition connue.
 */
export function useAccountExposures(positions: PortfolioPosition[]): { exposures: InstrumentExposure[]; available: boolean; loading: boolean } {
  const isins = useMemo(
    () => [...new Set(positions.map((position) => position.isin?.trim().toUpperCase()).filter((isin): isin is string => ISIN_SHAPE.test(isin ?? "")))].sort(),
    [positions],
  );
  const key = isins.join(",");
  // Le résultat est mémorisé AVEC la clé qui l'a produit. « En cours de chargement » se déduit
  // alors de la comparaison des deux, au lieu d'un `setState` synchrone dans l'effet — qui
  // provoquerait un rendu en cascade à chaque changement de périmètre.
  const [fetched, setFetched] = useState<{ key: string; exposures: InstrumentExposure[]; available: boolean } | null>(null);

  useEffect(() => {
    if (!key) return;
    let active = true;
    authenticatedFetch(`/api/market-data/exposures?isins=${encodeURIComponent(key)}`)
      .then((response) => (response.ok ? response.json() : { available: false, exposures: [] }))
      .then((data: ExposurePayload) => { if (active) setFetched({ key, exposures: data.exposures ?? [], available: data.available !== false }); })
      .catch(() => { if (active) setFetched({ key, exposures: [], available: false }); });
    return () => { active = false; };
  }, [key]);

  const current = fetched?.key === key ? fetched : null;
  return {
    exposures: current?.exposures ?? [],
    available: current?.available ?? true,
    loading: key !== "" && current === null,
  };
}

export function useExposureModel(positions: PortfolioPosition[], exposures: InstrumentExposure[], dimension: ExposureDimension): ExposureModel {
  return useMemo(() => computeExposureModel({ positions, exposures, dimension }), [positions, exposures, dimension]);
}

const GAP_REASON: Record<ExposureGap["reason"], string> = {
  no_price: "Aucun cours : la position ne peut pas recevoir de poids dans la répartition.",
  no_exposure: "Aucune exposition renseignée pour cet instrument.",
  etf_without_lookthrough: "ETF sans composition d’indice renseignée. Son pays de cotation n’est volontairement pas utilisé : ce serait une exposition fausse.",
  partial_exposure: "Composition partielle : le reste est compté en « Non renseigné », jamais réparti sur les autres zones.",
};

export function coverageSentence(model: ExposureModel): string | null {
  const { documentedInstruments, totalInstruments } = model.coverage;
  if (totalInstruments === 0 || documentedInstruments === totalInstruments) return null;
  return `Analyse partielle. ${documentedInstruments} position${documentedInstruments > 1 ? "s" : ""} sur ${totalInstruments} ${documentedInstruments > 1 ? "sont correctement renseignées" : "est correctement renseignée"}.`;
}

// ==========================================================================================
// BANDEAU DE COUVERTURE — les 4 dimensions demandées, d'un coup d'œil
// ==========================================================================================
export function CoverageStrip({ quotes, geography, sectors, dividends, costBasis, spanColumns = 3, onOpenDetail }: {
  quotes: { done: number; total: number };
  geography: { done: number; total: number };
  sectors: { done: number; total: number };
  dividends: { done: number; total: number };
  costBasis: { done: number; total: number };
  /** Colonnes de grille occupées : le bandeau comble la rangée quel que soit le nombre de cartes. */
  spanColumns?: number;
  onOpenDetail?: () => void;
}) {
  const items = [
    { key: "quotes", label: "Cours", value: quotes, hint: "positions valorisées" },
    { key: "geo", label: "Géographie", value: geography, hint: "instruments renseignés" },
    { key: "sector", label: "Secteurs", value: sectors, hint: "instruments renseignés" },
    { key: "div", label: "Dividendes", value: dividends, hint: "instruments analysés" },
    { key: "cost", label: "Coûts d’acquisition", value: costBasis, hint: "positions calculables" },
  ];
  const incomplete = items.filter((item) => item.value.total > 0 && item.value.done < item.value.total);
  return (
    <section className="panel inv-coverage" aria-label="Couverture des données" style={{ gridColumn: `span ${Math.max(1, spanColumns)}` }}>
      <div className="inv-coverage-head">
        <h3 className="btc-panel-kicker">COUVERTURE DES DONNÉES</h3>
        {onOpenDetail && incomplete.length > 0 && (
          <button type="button" className="btc-link" onClick={onOpenDetail}>Voir les instruments non reconnus →</button>
        )}
      </div>
      <ul className="inv-coverage-grid">
        {items.map((item) => {
          const complete = item.value.total === 0 || item.value.done >= item.value.total;
          const pct = item.value.total > 0 ? (item.value.done / item.value.total) * 100 : 100;
          return (
            <li key={item.key} className={complete ? "is-complete" : "is-partial"}>
              <small>{item.label}</small>
              <strong>{item.value.done}/{item.value.total}</strong>
              <span className="inv-coverage-bar" aria-hidden="true"><i style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} /></span>
              <em>{item.hint}</em>
            </li>
          );
        })}
      </ul>
      {incomplete.length > 0 && (
        <p className="inv-detail-warn" role="note">
          Analyse partielle : {incomplete.map((item) => `${item.label.toLowerCase()} ${item.value.done}/${item.value.total}`).join(" · ")}. Les chiffres affichés ne portent que sur le périmètre renseigné.
        </p>
      )}
    </section>
  );
}

// ==========================================================================================
// CARTE DU RÉSUMÉ
// ==========================================================================================
export function ExposureCard({ model, dimension, loading, available, onOpenDetail }: {
  model: ExposureModel;
  dimension: ExposureDimension;
  loading: boolean;
  available: boolean;
  onOpenDetail: () => void;
}) {
  const title = dimension === "geography" ? "RÉPARTITION GÉOGRAPHIQUE" : "RÉPARTITION SECTORIELLE";
  const top = model.buckets.slice(0, 5);
  const segments = model.buckets.map((bucket) => ({ label: bucket.label, value: bucket.valueEur, color: bucket.color }));
  const sentence = coverageSentence(model);

  if (loading) {
    return (
      <section className="panel btc-alloc-card">
        <h3 className="btc-panel-kicker">{title}</h3>
        <p className="inv-muted">Chargement des expositions…</p>
      </section>
    );
  }
  // Référentiel absent (migration non jouée) : la carte reste affichée quand le repli par
  // domiciliation produit malgré tout une répartition exploitable pour les titres vifs. On le DIT,
  // au lieu de masquer une information que l'on possède — mais les ETF, eux, restent « Non
  // renseigné » : leur composition ne se devine pas.
  if (!available && model.buckets.every((bucket) => bucket.code === "UNKNOWN")) {
    return (
      <section className="panel btc-alloc-card">
        <h3 className="btc-panel-kicker">{title}</h3>
        <EmptyState icon="🌍" title="Référentiel d’exposition absent"
          description="La table des expositions n’est pas encore créée en base (migration 20260816). Aucune répartition n’est inventée en attendant." />
      </section>
    );
  }
  if (model.buckets.length === 0) {
    return (
      <section className="panel btc-alloc-card">
        <h3 className="btc-panel-kicker">{title}</h3>
        <EmptyState icon="🌍" title="Aucune position valorisée"
          description="La répartition se calcule à partir de la valeur des positions. Renseignez les cours pour la voir apparaître." />
      </section>
    );
  }

  return (
    <section className="panel btc-alloc-card inv-exposure-card">
      <h3 className="btc-panel-kicker">{title}</h3>
      <div className="btc-alloc-body">
        <DonutChart
          segments={segments}
          centerTop={`${(top[0]?.pct ?? 0).toFixed(0)} %`}
          centerBottom={top[0]?.label ?? ""}
          ariaLabel={dimension === "geography" ? "Répartition géographique" : "Répartition sectorielle"}
        />
        <ul className="btc-legend">
          {top.map((bucket) => (
            <LegendRow
              key={bucket.code}
              color={bucket.color}
              name={bucket.isEstimated ? `${bucket.label} ≈` : bucket.label}
              value={euro.format(bucket.valueEur)}
              pct={`${bucket.pct.toFixed(1)} %`}
            />
          ))}
        </ul>
      </div>
      {sentence && <p className="inv-detail-warn" role="note">{sentence}</p>}
      {!available && (
        <p className="btc-chart-source" role="note">
          Référentiel d’exposition absent en base (migration 20260816) : seules les actions en direct sont
          positionnées, par approximation de domiciliation. Les ETF restent « Non renseigné ».
        </p>
      )}
      {model.estimatedPct > 0.5 && (
        <p className="btc-chart-source">
          ≈ {model.estimatedPct.toFixed(0)} % de la répartition repose sur une approximation (composition d’indice indicative ou pays de domiciliation), signalée par « ≈ ».
        </p>
      )}
      <button type="button" className="btc-link" onClick={onOpenDetail}>Voir toute la diversification →</button>
    </section>
  );
}

// ==========================================================================================
// DÉTAIL COMPLET
// ==========================================================================================
export function DiversificationModal({ geography, sectors, onClose }: { geography: ExposureModel; sectors: ExposureModel; onClose: () => void }) {
  const [dimension, setDimension] = useState<ExposureDimension>("geography");
  const model = dimension === "geography" ? geography : sectors;
  const dialogRef = useDialogA11y(true, onClose);
  const total = model.buckets.reduce((sum, bucket) => sum + bucket.pct, 0);
  // Les instruments non reconnus, dédupliqués : une même ligne peut cumuler deux raisons.
  const gaps = useMemo(() => {
    const byKey = new Map<string, ExposureGap>();
    for (const gap of model.gaps) if (!byKey.has(`${gap.key}:${gap.reason}`)) byKey.set(`${gap.key}:${gap.reason}`, gap);
    return [...byKey.values()];
  }, [model.gaps]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="modal inv-diversification" role="dialog" aria-modal="true" aria-labelledby="diversification-title" ref={dialogRef as React.RefObject<HTMLDivElement>}>
        <header>
          <h2 id="diversification-title">Diversification</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Fermer">✕</button>
        </header>
        <div className="modal-body">
          <div className="inv-dimension-switch" role="tablist" aria-label="Dimension">
            <button type="button" role="tab" aria-selected={dimension === "geography"} className={dimension === "geography" ? "active" : ""} onClick={() => setDimension("geography")}>Géographie</button>
            <button type="button" role="tab" aria-selected={dimension === "sector"} className={dimension === "sector" ? "active" : ""} onClick={() => setDimension("sector")}>Secteurs</button>
          </div>

          {model.buckets.length === 0 ? (
            <EmptyState title="Aucune répartition calculable" description="Aucune position valorisée sur cette dimension." />
          ) : (
            <>
              <ul className="inv-exposure-bars">
                {model.buckets.map((bucket) => (
                  <li key={bucket.code} className={bucket.code === UNKNOWN_CODE ? "is-unknown" : ""}>
                    <div className="inv-exposure-label">
                      <span className="inv-exposure-dot" style={{ background: bucket.color }} aria-hidden="true" />
                      <strong>{bucket.label}</strong>
                      {bucket.isEstimated && <span className="inv-badge inv-badge-estimated">Approximation</span>}
                    </div>
                    <div className="inv-exposure-track" aria-hidden="true"><i style={{ width: `${Math.max(0.5, bucket.pct)}%`, background: bucket.color }} /></div>
                    <span className="inv-exposure-value">{bucket.pct.toFixed(1)} %</span>
                    <small>{euro.format(bucket.valueEur)} · {bucket.positions} ligne(s)</small>
                  </li>
                ))}
              </ul>
              <p className="btc-chart-source">
                Total {total.toFixed(1)} % — « Non renseigné » compris. Le poids inconnu n’est jamais réparti sur les autres zones.
              </p>
            </>
          )}

          {model.sources.length > 0 && (
            <section className="inv-exposure-sources">
              <h3 className="btc-panel-kicker">SOURCES</h3>
              <ul>{model.sources.map((source) => <li key={source}>{source}</li>)}</ul>
            </section>
          )}

          <section className="inv-exposure-gaps">
            <h3 className="btc-panel-kicker">INSTRUMENTS NON RECONNUS ({gaps.length})</h3>
            {gaps.length === 0 ? (
              <p className="inv-detail-note">Tous les instruments détenus sont renseignés sur cette dimension.</p>
            ) : (
              <ul>
                {gaps.map((gap) => (
                  <li key={`${gap.key}:${gap.reason}`}>
                    <div>
                      <strong>{gap.name}</strong>
                      <small>{gap.ticker ?? gap.isin ?? "identifiant non communiqué"}</small>
                    </div>
                    <p>{GAP_REASON[gap.reason]}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

/** Ouvre/ferme le détail sans dupliquer l'état dans chaque écran appelant. */
export function useDiversificationModal() {
  const [open, setOpen] = useState(false);
  return { open, show: useCallback(() => setOpen(true), []), hide: useCallback(() => setOpen(false), []) };
}
