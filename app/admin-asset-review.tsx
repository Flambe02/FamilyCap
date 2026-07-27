"use client";

// ÉCRAN ADMIN « ACTIFS & COTATIONS » — revue légère du catalogue (§13 du cahier).
//
// N'affiche PAS tout le catalogue : uniquement ce qui empêche quelque chose de fonctionner, avec
// la raison en clair et sa conséquence. Un catalogue sain affiche donc une liste vide — c'est le
// résultat attendu, pas un écran cassé.
//
// Une correction validée ici devient `verified` : ni une panne fournisseur, ni une déduction
// automatique ultérieure ne peuvent l'écraser. C'est le seul endroit qui confère ce statut.

import { useCallback, useEffect, useState } from "react";
import {
  ASSET_TYPES, ASSET_TYPE_LABEL, REVIEW_REASON_DETAIL, REVIEW_REASON_LABEL,
  type NormalizedAssetType, type ReviewReason, type ReviewableAsset,
} from "../lib/asset-catalog";
import { authenticatedFetch } from "./investment-shared";
import "./admin-asset-review.css";

type ReviewRow = ReviewableAsset & { reasons: ReviewReason[] };

type Draft = {
  name: string;
  isin: string;
  assetType: NormalizedAssetType;
  listingId: string | null;
  ticker: string;
  exchange: string;
  micCode: string;
  currency: string;
  eodhdSymbol: string;
  yahooSymbol: string;
};

function draftFrom(asset: ReviewRow): Draft {
  const listing = asset.listings[0];
  return {
    name: asset.name,
    isin: asset.isin ?? "",
    assetType: asset.assetType,
    listingId: listing?.listingId ?? null,
    ticker: listing?.ticker ?? "",
    exchange: listing?.exchange ?? "",
    micCode: listing?.micCode ?? "",
    currency: listing?.currency ?? "EUR",
    eodhdSymbol: listing?.eodhdSymbol ?? "",
    yahooSymbol: listing?.yahooSymbol ?? "",
  };
}

export function AdminAssetReview() {
  const [rows, setRows] = useState<ReviewRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState("");
  const [setupRequired, setSetupRequired] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");

  // Aucun état n'est modifié AVANT le premier `await` : appelée depuis un effet, une mise à jour
  // synchrone déclencherait une cascade de rendus. L'état est donc posé une fois, à l'arrivée
  // de la réponse — ce qui évite au passage un affichage « vide » clignotant à chaque actualisation.
  const load = useCallback(async () => {
    try {
      const response = await authenticatedFetch("/api/admin/asset-review");
      const payload = (await response.json().catch(() => ({}))) as { assets?: ReviewRow[]; total?: number; error?: string; setupRequired?: boolean };
      if (!response.ok) {
        setRows([]);
        setSetupRequired(Boolean(payload.setupRequired));
        setError(payload.error ?? "Chargement impossible.");
        return;
      }
      setRows(payload.assets ?? []);
      setTotal(payload.total ?? 0);
      setSetupRequired(false);
      setError("");
    } catch {
      setRows([]);
      setSetupRequired(false);
      setError("Chargement impossible. Réessayez dans quelques instants.");
    }
  }, []);

  // Chargement différé d'un tick, comme les autres écrans d'administration : appeler `load`
  // directement dans le corps de l'effet enchaînerait des rendus en cascade.
  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  function openRow(asset: ReviewRow) {
    setNotice("");
    setError("");
    if (openId === asset.assetId) { setOpenId(null); setDraft(null); return; }
    setOpenId(asset.assetId);
    setDraft(draftFrom(asset));
  }

  async function save(assetId: string) {
    if (!draft) return;
    setSaving(true);
    setError("");
    try {
      const response = await authenticatedFetch("/api/admin/asset-review", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          assetId,
          name: draft.name,
          isin: draft.isin.trim() || null,
          assetType: draft.assetType,
          listing: draft.listingId ? {
            listingId: draft.listingId,
            ticker: draft.ticker.trim() || null,
            exchange: draft.exchange.trim() || null,
            micCode: draft.micCode.trim() || null,
            currency: draft.currency,
            eodhdSymbol: draft.eodhdSymbol.trim() || null,
            yahooSymbol: draft.yahooSymbol.trim() || null,
          } : undefined,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) { setError(payload.error ?? "Enregistrement impossible."); return; }
      setNotice("Actif confirmé. Cette correction ne sera plus écrasée automatiquement.");
      setOpenId(null);
      setDraft(null);
      await load();
    } catch {
      setError("Enregistrement impossible. Réessayez dans quelques instants.");
    } finally {
      setSaving(false);
    }
  }

  if (rows === null) return <section className="admin-card"><p>Chargement du catalogue…</p></section>;

  return (
    <section className="admin-card asset-review">
      <header className="asset-review-head">
        <div>
          <h3>Actifs &amp; cotations</h3>
          {/* `{" "}` explicite : JSX supprime l'espace situé avant un retour à la ligne, ce qui
              collait « chose » et « sont ». */}
          <p>
            Seuls les actifs qui <b>empêchent réellement quelque chose</b>{" "}
            sont listés ici — un catalogue sain n’affiche rien. Une correction validée devient
            définitive&nbsp;: aucune panne de fournisseur ne pourra la remplacer.
          </p>
        </div>
        <button type="button" className="secondary-button" onClick={() => void load()}>Actualiser</button>
      </header>

      {error && (
        <p className={setupRequired ? "asset-review-setup" : "pea-form-error"} role="alert">{error}</p>
      )}
      {notice && <p className="asset-review-notice" role="status">{notice}</p>}

      {!error && rows.length === 0 && (
        <div className="asset-review-empty">
          <b>Aucun actif à vérifier</b>
          <span>{total} actif(s) au catalogue, tous correctement identifiés.</span>
        </div>
      )}

      {rows.length > 0 && (
        <>
          <p className="asset-review-count">{rows.length} actif(s) à vérifier sur {total} au catalogue.</p>
          <ul className="asset-review-list">
            {rows.map((asset) => {
              const listing = asset.listings[0];
              const isOpen = openId === asset.assetId;
              return (
                <li key={asset.assetId} className={`asset-review-item${isOpen ? " is-open" : ""}`}>
                  <button type="button" className="asset-review-row" onClick={() => openRow(asset)} aria-expanded={isOpen}>
                    <span className="asset-review-main">
                      <b>{asset.name}</b>
                      <span className="asset-review-sub">
                        {[listing?.ticker, listing?.exchange, listing?.currency].filter(Boolean).join(" · ") || "Aucune cotation"}
                        {" · "}
                        {asset.isin ? `ISIN ${asset.isin}` : "sans ISIN"}
                        {asset.operationCount > 0 && ` · ${asset.operationCount} opération(s)`}
                      </span>
                    </span>
                    <span className="asset-review-tags">
                      {asset.reasons.map((reason) => (
                        <span key={reason} className={`asset-review-tag reason-${reason}`}>{REVIEW_REASON_LABEL[reason]}</span>
                      ))}
                    </span>
                  </button>

                  {isOpen && draft && (
                    <div className="asset-review-editor">
                      <ul className="asset-review-why">
                        {asset.reasons.map((reason) => <li key={reason}>{REVIEW_REASON_DETAIL[reason]}</li>)}
                      </ul>

                      <div className="asset-review-grid">
                        <label><span>Nom canonique</span>
                          <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
                        <label><span>Type</span>
                          <select value={draft.assetType} onChange={(event) => setDraft({ ...draft, assetType: event.target.value as NormalizedAssetType })}>
                            {ASSET_TYPES.map((value) => <option key={value} value={value}>{ASSET_TYPE_LABEL[value]}</option>)}
                          </select></label>
                        <label><span>ISIN</span>
                          <input value={draft.isin} onChange={(event) => setDraft({ ...draft, isin: event.target.value.toUpperCase() })} placeholder="FR0000120073" /></label>

                        {draft.listingId ? (
                          <>
                            <label><span>Ticker</span>
                              <input value={draft.ticker} onChange={(event) => setDraft({ ...draft, ticker: event.target.value.toUpperCase() })} /></label>
                            <label><span>Place</span>
                              <input value={draft.exchange} onChange={(event) => setDraft({ ...draft, exchange: event.target.value })} placeholder="Euronext Paris" /></label>
                            <label><span>Code MIC</span>
                              <input value={draft.micCode} maxLength={4} onChange={(event) => setDraft({ ...draft, micCode: event.target.value.toUpperCase() })} placeholder="XPAR" /></label>
                            <label><span>Devise</span>
                              <input value={draft.currency} maxLength={3} onChange={(event) => setDraft({ ...draft, currency: event.target.value.toUpperCase() })} /></label>
                            <label><span>Symbole EODHD</span>
                              <input value={draft.eodhdSymbol} onChange={(event) => setDraft({ ...draft, eodhdSymbol: event.target.value.toUpperCase() })} placeholder="AI.PA" /></label>
                            <label><span>Symbole Yahoo</span>
                              <input value={draft.yahooSymbol} onChange={(event) => setDraft({ ...draft, yahooSymbol: event.target.value.toUpperCase() })} placeholder="AI.PA" /></label>
                          </>
                        ) : (
                          <p className="asset-review-nolisting">
                            Cet actif n’a aucune cotation. Rattachez-en une en enregistrant une opération
                            sur cet actif via l’écran PEA/CTO&nbsp;: la cotation choisie y sera créée.
                          </p>
                        )}
                      </div>

                      <div className="asset-review-actions">
                        <button type="button" className="secondary-button" onClick={() => { setOpenId(null); setDraft(null); }}>Annuler</button>
                        <button type="button" className="primary-button" onClick={() => void save(asset.assetId)} disabled={saving || !draft.name.trim()}>
                          {saving ? "Enregistrement…" : "Confirmer cet actif"}
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
