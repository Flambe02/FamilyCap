"use client";

// RECHERCHE ET SÉLECTION D'UN ACTIF COTÉ — remplace les champs libres Nom / Ticker / ISIN / Devise.
//
// L'utilisateur ne compose plus une identité champ par champ : il cherche, il choisit UNE cotation,
// et cette cotation verrouille nom, type, ticker, place, devise et ISIN d'un bloc. C'est ce qui rend
// structurellement impossible le couple observé « ticker CW8 + ISIN FR0010315770 ».
//
// Le composant n'appelle aucun fournisseur : il interroge /api/instruments/search, qui centralise
// la résolution côté serveur (aucune clé fournisseur dans le bundle client).
//
// Accessibilité : motif combobox + listbox de l'APG (aria-expanded / aria-controls /
// aria-activedescendant), navigation ↑ ↓ Entrée Échap, et cibles tactiles pleine largeur.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ASSET_TYPE_LABEL, classifyQuery, describeListing, type AssetCandidate } from "../lib/asset-catalog";
import { authenticatedFetch } from "./investment-shared";

const DEBOUNCE_MS = 280;
const MIN_QUERY = 2;

function formatPrice(value: number | null, currency: string): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  try {
    return new Intl.NumberFormat("fr-FR", { style: "currency", currency, maximumFractionDigits: 2 }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString("fr-FR");
}

/** Ligne de résultat : JAMAIS uniquement le nom et le ticker — un ticker peut désigner plusieurs
 *  instruments ou plusieurs places, c'est précisément ce que l'utilisateur doit arbitrer. */
function CandidateRow({ candidate }: { candidate: AssetCandidate }) {
  const price = formatPrice(candidate.lastPrice, candidate.currency);
  const priceDate = formatDate(candidate.lastPriceAt);
  return (
    <>
      <span className="asset-hit-head">
        <b className="asset-hit-name">{candidate.name}</b>
        <span className="asset-hit-type">{ASSET_TYPE_LABEL[candidate.assetType]}</span>
        {/* Le badge « Éligible PEA » n'est volontairement pas affiché : aucune de nos sources ne
            publie cette donnée, et la déduire du pays serait faux pour les ETF synthétiques. */}
      </span>
      <span className="asset-hit-line">{describeListing(candidate) || "Cotation non précisée"}</span>
      <span className="asset-hit-meta">
        <span>{candidate.isin ? `ISIN ${candidate.isin}` : "ISIN non communiqué"}</span>
        {price && <span className="asset-hit-price">{priceDate ? `Dernier cours ${price} · ${priceDate}` : `Dernier cours ${price}`}</span>}
      </span>
    </>
  );
}

/** Carte compacte de la sélection verrouillée. */
export function SelectedAssetCard({ candidate, onChange, disabled }: {
  candidate: AssetCandidate; onChange?: () => void; disabled?: boolean;
}) {
  const price = formatPrice(candidate.lastPrice, candidate.currency);
  const priceDate = formatDate(candidate.lastPriceAt);
  return (
    <div className="asset-selected">
      <span className="asset-selected-check" aria-hidden="true">✓</span>
      <div className="asset-selected-body">
        <span className="asset-hit-head">
          <b className="asset-hit-name">{candidate.name}</b>
          <span className="asset-hit-type">{ASSET_TYPE_LABEL[candidate.assetType]}</span>
        </span>
        <span className="asset-hit-line">{describeListing(candidate) || "Cotation non précisée"}</span>
        <span className="asset-hit-meta">
          <span>{candidate.isin ? `ISIN ${candidate.isin}` : "ISIN non communiqué"}</span>
          {price && <span className="asset-hit-price">{priceDate ? `Dernier cours ${price} · ${priceDate}` : `Dernier cours ${price}`}</span>}
        </span>
      </div>
      {onChange && (
        <button type="button" className="asset-change" onClick={onChange} disabled={disabled}>Changer</button>
      )}
    </div>
  );
}

export type AssetSearchFieldProps = {
  value: AssetCandidate | null;
  onSelect: (candidate: AssetCandidate | null) => void;
  /** Restreint la recherche aux actifs fournis (vente, dividende) au lieu d'interroger le catalogue. */
  restrictTo?: AssetCandidate[] | null;
  accountId?: string | null;
  label?: string;
  disabled?: boolean;
  /** Proposé quand rien n'est trouvé : bascule vers le parcours « actif non coté ». */
  onUnlisted?: () => void;
};

export function AssetSearchField({
  value, onSelect, restrictTo = null, accountId = null,
  label = "Rechercher une action, un ETF ou un fonds", disabled = false, onUnlisted,
}: AssetSearchFieldProps) {
  const listId = useId();
  const inputId = useId();
  const [query, setQuery] = useState("");
  // La réponse distante est stockée AVEC la requête à laquelle elle répond. Les résultats
  // deviennent alors DÉRIVABLES : plus besoin de les effacer à chaque frappe depuis un effet
  // (une réponse qui ne correspond plus à la saisie est simplement ignorée), ce qui supprime les
  // rendus en cascade et, accessoirement, tout risque d'afficher les résultats du terme précédent.
  const [remote, setRemote] = useState<{ query: string; candidates: AssetCandidate[]; error: string }>({ query: "", candidates: [], error: "" });
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Évite qu'une réponse lente écrase le résultat d'une frappe plus récente.
  const requestSeq = useRef(0);

  const isLocal = Array.isArray(restrictTo);
  const term = query.trim();

  const runLocalSearch = useCallback((term: string) => {
    const needle = term.trim().toLowerCase();
    const pool = restrictTo ?? [];
    if (!needle) return pool;
    return pool.filter((candidate) =>
      candidate.name.toLowerCase().includes(needle)
      || (candidate.ticker ?? "").toLowerCase().includes(needle)
      || (candidate.isin ?? "").toLowerCase().includes(needle));
  }, [restrictTo]);

  const runRemoteSearch = useCallback(async (searchTerm: string) => {
    const seq = ++requestSeq.current;
    setLoading(true);
    const fallback = "La recherche est momentanément indisponible. Réessayez dans quelques instants.";
    try {
      const params = new URLSearchParams({ q: searchTerm });
      if (accountId) params.set("accountId", accountId);
      const response = await authenticatedFetch(`/api/instruments/search?${params.toString()}`);
      const payload = (await response.json().catch(() => ({}))) as { results?: AssetCandidate[]; error?: string };
      if (seq !== requestSeq.current) return; // réponse obsolète
      setRemote(response.ok
        ? { query: searchTerm, candidates: payload.results ?? [], error: "" }
        : { query: searchTerm, candidates: [], error: payload.error ?? fallback });
    } catch {
      if (seq !== requestSeq.current) return;
      setRemote({ query: searchTerm, candidates: [], error: fallback });
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    if (value) return;                       // sélection verrouillée : plus aucune requête
    if (isLocal) return;                     // recherche locale : purement dérivée, aucun appel
    if (term.length < MIN_QUERY) return;     // rien à chercher — les résultats obsolètes sont ignorés
    if (remote.query === term) return;       // déjà répondu pour ce terme exact
    // Un ISIN complet ET valide est une identité exacte : on l'interroge sans attendre le délai
    // anti-rebond. Les deux chemins passent par un timer, pour qu'aucun état ne soit modifié
    // pendant l'effet lui-même (sinon React enchaîne des rendus en cascade).
    const delay = classifyQuery(term).kind === "isin" ? 0 : DEBOUNCE_MS;
    const timer = setTimeout(() => { void runRemoteSearch(term); }, delay);
    return () => clearTimeout(timer);
  }, [term, value, isLocal, remote.query, runRemoteSearch]);

  // Résultats DÉRIVÉS : locaux calculés à la volée, distants retenus seulement s'ils répondent
  // bien au terme affiché. Aucune synchronisation d'état à maintenir.
  const answered = remote.query === term;
  const results = term.length < MIN_QUERY ? [] : isLocal ? runLocalSearch(term) : (answered ? remote.candidates : []);
  const error = isLocal || !answered ? "" : remote.error;
  const searched = isLocal ? term.length >= MIN_QUERY : answered;
  // L'index actif est borné au rendu plutôt que réinitialisé par un effet à chaque nouvelle liste.
  const activeIndex = results.length === 0 ? -1 : Math.min(Math.max(active, 0), results.length - 1);

  const showList = open && !value && term.length >= MIN_QUERY;
  const empty = showList && !loading && searched && results.length === 0 && !error;

  const choose = useCallback((candidate: AssetCandidate) => {
    onSelect(candidate);
    setOpen(false);
    setQuery("");   // la requête vidée rend les résultats dérivés vides : rien d'autre à nettoyer
    setActive(0);
  }, [onSelect]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (!showList || results.length === 0) {
      if (event.key === "Escape") { setOpen(false); }
      return;
    }
    if (event.key === "ArrowDown") { event.preventDefault(); setActive((index) => (Math.max(index, 0) + 1) % results.length); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive((index) => (Math.max(index, 0) - 1 + results.length) % results.length); }
    else if (event.key === "Enter") { event.preventDefault(); const picked = results[activeIndex]; if (picked) choose(picked); }
    else if (event.key === "Escape") { event.preventDefault(); setOpen(false); }
  }

  const hint = useMemo(() => (isLocal
    ? "Seules les positions détenues sur ce compte sont proposées."
    : "Nom, ticker ou ISIN"), [isLocal]);

  if (value) {
    return (
      <div className="pea-field pea-field-wide">
        <span className="pea-field-label">Actif</span>
        <SelectedAssetCard candidate={value} disabled={disabled} onChange={() => { onSelect(null); setQuery(""); setOpen(true); setTimeout(() => inputRef.current?.focus(), 0); }} />
      </div>
    );
  }

  return (
    <div className="pea-field pea-field-wide asset-search">
      <label className="pea-field-label" htmlFor={inputId}>{label}</label>
      <div className={`asset-search-box${loading ? " is-loading" : ""}`}>
        <input
          id={inputId}
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList && activeIndex >= 0 ? `${listId}-option-${activeIndex}` : undefined}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          value={query}
          placeholder={hint}
          onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
        />
        {loading && <span className="asset-search-spinner" role="status" aria-label="Recherche en cours" />}
      </div>

      {showList && (
        <ul className="asset-results" id={listId} role="listbox" aria-label="Résultats de recherche">
          {results.map((candidate, index) => (
            <li
              key={`${candidate.assetId ?? candidate.isin ?? candidate.name}-${candidate.listingId ?? candidate.yahooSymbol ?? index}`}
              id={`${listId}-option-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              className={`asset-hit${index === activeIndex ? " is-active" : ""}`}
              onMouseEnter={() => setActive(index)}
              // onMouseDown plutôt que onClick : le blur de l'input fermerait la liste avant le clic.
              onMouseDown={(event) => { event.preventDefault(); choose(candidate); }}
            >
              <CandidateRow candidate={candidate} />
            </li>
          ))}
        </ul>
      )}

      {showList && error && <p className="pea-form-error asset-search-note" role="alert">{error}</p>}

      {empty && (
        <div className="asset-empty" role="status">
          <b>Aucun actif coté trouvé</b>
          <span>Vérifiez le nom, le ticker ou l’ISIN.</span>
          <div className="asset-empty-actions">
            <button type="button" className="secondary-button" onClick={() => { if (!isLocal) void runRemoteSearch(query.trim()); }}>Réessayer</button>
            {onUnlisted && <button type="button" className="secondary-button" onClick={onUnlisted}>Ajouter comme actif non coté</button>}
          </div>
        </div>
      )}
    </div>
  );
}
