"use client";

// Liste « Mes positions » — composant DÉDIÉ, volontairement séparé du shell d'investissement.
//
// Ce n'est plus un <table>. Une position n'est pas une ligne de tableur : c'est une carte
// horizontale en CSS Grid EXPLICITE, dont la première zone (l'actif) est la plus large et la
// seule qui ne se comprime jamais. C'est la condition pour que « Amundi Core MSCI World UCITS
// ETF » se lise en entier au lieu de se découper verticalement en « Amun / di... ».
//
// Trois régimes, pilotés par la LARGEUR DU CONTENEUR (@container) et non par celle de l'écran :
// la liste ne sait pas si une barre latérale lui vole 252 px, elle sait seulement combien de
// place elle a. Complet (≥1040px) → intermédiaire (≥660px, ISIN masqué, poids sous la valeur)
// → cartes (<660px).
//
// AUCUN calcul ici : ce fichier ne fait que MISE EN FORME et MISE EN PAGE. Les quantités, PRU,
// valeurs, performances et poids viennent tels quels de `computeAccountModel`.

import type { PortfolioPosition } from "../lib/portfolio-account";
import "./positions-list.css";

// ---- Formatage partagé (importé aussi par le shell : une seule définition) ----------------
const qtyFormat = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 4 });

export function money(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat("fr-FR", { style: "currency", currency: (currency || "EUR").toUpperCase() }).format(value);
  } catch {
    return `${qtyFormat.format(value)} ${currency || "EUR"}`;
  }
}

// « Autre » n'est jamais affiché : une position non identifiée est « À classifier », ce qui dit
// à l'utilisateur qu'il y a une action à faire plutôt que de faire passer un trou pour une classe.
export const ASSET_LABEL: Record<PortfolioPosition["assetType"], string> = {
  stock: "Action", etf: "ETF", fund: "Fonds", bond: "Obligation", reit: "Immobilier coté",
  gold: "Or", crypto: "Crypto", cash: "Liquidités", other: "À classifier",
};

// Teinte du monogramme par classe d'actif : repère visuel constant d'une ligne à l'autre.
const MONO_TONE: Record<PortfolioPosition["assetType"], string> = {
  stock: "teal", etf: "blue", fund: "violet", bond: "slate", reit: "amber",
  gold: "gold", crypto: "orange", cash: "slate", other: "warn",
};

const QUOTE_MODE_LABEL: Record<string, string> = { eod: "clôture", delayed: "différé", realtime: "direct", manual: "saisi" };

/**
 * Monogramme : le TICKER réel quand il existe (AI, MC, TTE, CW8), sinon le suffixe entre
 * parenthèses du libellé (« TOTALENERGIES (TTE) » → TTE — les relevés importés y logent le
 * ticker), sinon les initiales.
 *
 * Le filtrage sur [A-Z0-9] n'est pas cosmétique : sans lui, « TOTALENERGIES (TTE) » découpé sur
 * les espaces donnait words[1] = « (TTE) » et donc le monogramme « T( ».
 * Purement décoratif : rien n'est déduit ici pour un calcul ni écrit en base.
 */
export function monogramOf(position: PortfolioPosition): string {
  const ticker = (position.ticker ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (ticker) return ticker.slice(0, 4);
  const parenthesised = /\(([A-Za-z0-9.\-]{1,6})\)\s*$/.exec(position.name.trim());
  if (parenthesised) return parenthesised[1].toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
  const words = position.name.toUpperCase().replace(/[^A-Z0-9\s]+/g, " ").split(/\s+/).filter(Boolean);
  if (words.length >= 2) return `${words[0][0]}${words[1][0]}`;
  return (words[0] ?? "").slice(0, 2) || "?";
}

type Freshness = "fresh" | "stale" | "manual" | "none";

/** Fraîcheur telle quelle : jamais arrondie à l'avantage de l'affichage. */
function freshnessOf(position: PortfolioPosition): Freshness {
  if (position.lastPrice === null) return "none";
  if (position.quoteMode === "manual") return "manual";
  if (!position.lastPriceAt) return "manual";
  const stamp = new Date(position.lastPriceAt).getTime();
  if (!Number.isFinite(stamp)) return "manual";
  return Date.now() - stamp > 2 * 86_400_000 ? "stale" : "fresh";
}

const FRESHNESS_TITLE: Record<Freshness, string> = {
  fresh: "Cours récent", stale: "Cours possiblement périmé", manual: "Cours saisi manuellement", none: "Aucun cours",
};

function shortQuoteDate(lastPriceAt: string | null): string | null {
  if (!lastPriceAt) return null;
  const date = new Date(lastPriceAt);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" }).format(date).replace(/\.$/, "");
}

// Pourquoi une position n'a PAS de valeur. Les deux causes n'appellent pas la même action et ne
// doivent donc jamais être confondues sous un « Indisponible » unique :
//   — pas de cours  → « Actualiser » peut le récupérer ;
//   — cours présent mais pas de taux de change → « Actualiser » n'y changera rien, il manque une
//     ligne dans market_fx_rates. Dire « sans cours » enverrait l'utilisateur sur une fausse piste.
export function missingValueReason(position: PortfolioPosition): "quote" | "fx" | null {
  if (position.currentValueEur !== null) return null;
  return position.lastPrice === null ? "quote" : "fx";
}
const MISSING_LABEL = { quote: "Cours indisponible", fx: "Conversion indisponible" } as const;
const MISSING_TITLE = {
  quote: "Aucun cours enregistré pour cet actif : sa valeur n’est pas calculable et n’est pas comptée dans le total.",
  fx: "Le cours est connu, mais aucun taux de change vers la devise du compte n’est enregistré. Aucune conversion n’est estimée : la valeur reste non calculable et n’est pas comptée dans le total.",
} as const;

const signedMoney = (value: number, currency: string) => `${value > 0 ? "+" : value < 0 ? "−" : ""}${money(Math.abs(value), currency)}`;
const signedPct = (value: number) => `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(1).replace(".", ",")} %`;
const toneOf = (value: number | null) => (value === null || value === 0 ? "" : value > 0 ? " is-up" : " is-down");
const partsLabel = (quantity: number) => `${qtyFormat.format(quantity)} ${Math.abs(quantity) === 1 ? "part" : "parts"}`;

function Chevron() {
  return (
    <svg className="pos-chevron" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
      <path d="M9 5.5 15.5 12 9 18.5" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ==========================================================================================
// BANDE DE SYNTHÈSE
// ==========================================================================================
/** Une seule bande blanche, quatre zones séparées par de fines bordures — pas quatre cartes. */
export function PortfolioSummaryStrip({ positionsValue, cash, totalValue, invested, gainEur, gainPct, dividends, currency, unvaluedPositions, unvaluedCost }: {
  positionsValue: number | null; cash: number;
  totalValue: number | null; invested: number; gainEur: number | null; gainPct: number | null;
  dividends: number; currency: string; unvaluedPositions: number; unvaluedCost: number;
}) {
  return (
    <div className="pf-strip" aria-label="Synthèse du portefeuille">
      <div className="pf-cell pf-cell-lead">
        <small>Valeur des positions</small>
        <strong>{positionsValue === null ? "Indisponible" : money(positionsValue, currency)}</strong>
      </div>
      <div className="pf-cell">
        <small>Trésorerie</small>
        <strong className={cash < 0 ? "pf-perf is-down" : undefined}>{money(cash, currency)}</strong>
      </div>
      <div className="pf-cell">
        <small>Valeur totale du compte</small>
        <strong>{totalValue === null ? "Indisponible" : money(totalValue, currency)}</strong>
      </div>
      <div className="pf-cell">
        <small>Investi</small>
        <strong>{money(invested, currency)}</strong>
      </div>
      <div className="pf-cell">
        <small>{unvaluedPositions > 0 ? "Performance partielle" : "Performance des positions"}</small>
        <strong className={`pf-perf${toneOf(gainEur)}`}>
          {gainEur === null ? "Indisponible" : signedMoney(gainEur, currency)}
          {gainPct !== null && <em> · {signedPct(gainPct)}</em>}
        </strong>
        {unvaluedPositions > 0 && <em>{unvaluedPositions} position(s), coût {money(unvaluedCost, currency)}, exclue(s)</em>}
      </div>
      <div className="pf-cell">
        {/* Le moteur ne ventile pas les dividendes par année civile : on ne datera pas ce
            libellé tant que le chiffre est « depuis l'origine ». */}
        <small>Dividendes encaissés</small>
        <strong>{money(dividends, currency)}</strong>
      </div>
    </div>
  );
}

// ==========================================================================================
// IDENTITÉ D'UN ACTIF
// ==========================================================================================
/** Monogramme + nom complet + (ticker · type · place) + ISIN. Le nom ne se coupe JAMAIS. */
export function PositionAssetIdentity({ position, compact = false }: { position: PortfolioPosition; compact?: boolean }) {
  const meta = [position.ticker, ASSET_LABEL[position.assetType], compact ? null : position.exchange]
    .filter((item): item is string => Boolean(item && String(item).trim()));
  return (
    <span className="pos-identity">
      <span className={`pos-mono pos-mono-${MONO_TONE[position.assetType]}`} aria-hidden="true">{monogramOf(position)}</span>
      <span className="pos-identity-copy">
        <span className="pos-name">{position.name}</span>
        <span className="pos-meta">
          {meta.map((item, index) => (
            <span key={`${item}-${index}`} className={item === ASSET_LABEL[position.assetType] ? `pos-type${position.assetType === "other" ? " is-warn" : ""}` : undefined}>{item}</span>
          ))}
          {meta.length === 0 && <span>{position.currency}</span>}
        </span>
        {position.isin && <span className="pos-isin">{position.isin}</span>}
      </span>
    </span>
  );
}

// ==========================================================================================
// LIGNE (desktop + intermédiaire)
// ==========================================================================================
function rowLabel(position: PortfolioPosition): string {
  const missing = missingValueReason(position);
  const value = missing ? MISSING_LABEL[missing].toLowerCase() : `valeur ${money(position.currentValueEur!, position.referenceCurrency)}`;
  const perf = position.gainEur === null
    ? "performance indisponible"
    : `performance ${signedMoney(position.gainEur, position.referenceCurrency)}${position.gainPct === null ? "" : ` soit ${signedPct(position.gainPct)}`}`;
  const weight = position.currentValueEur === null ? "" : `, poids ${position.weightPct.toFixed(1).replace(".", ",")} %`;
  return `${position.name}, ${partsLabel(position.quantity)}, ${value}, ${perf}${weight}. Ouvrir le détail de la position.`;
}

export function PositionRow({ position, onOpen }: { position: PortfolioPosition; onOpen: (position: PortfolioPosition) => void }) {
  const freshness = freshnessOf(position);
  const quoteDate = shortQuoteDate(position.lastPriceAt);
  const mode = position.quoteMode ? QUOTE_MODE_LABEL[position.quoteMode] : null;
  const missing = missingValueReason(position);

  return (
    <li className="pos-item">
      <button type="button" className="pos-row" onClick={() => onOpen(position)} aria-label={rowLabel(position)}>
        <span className="pos-cell pos-cell-asset"><PositionAssetIdentity position={position} /></span>

        {/* Quantité et PRU sont DEUX zones distinctes sur desktop. Le repli du PRI sous la
            quantité n'existe qu'au palier intermédiaire, où huit colonnes ne tiennent plus. */}
        <span className="pos-cell pos-cell-qty">
          {/* Pas d'unité sous le nombre : l'en-tête dit déjà « Quantité ». Elle reste dans
              l'aria-label, où le contexte visuel n'existe pas. */}
          <b>{qtyFormat.format(position.quantity)}</b>
          <em className="pos-qty-pru">{position.averageCost === null ? "PRU —" : `PRU ${money(position.averageCost, position.currency)}`}</em>
        </span>

        <span className="pos-cell pos-cell-pru">
          <b>{position.averageCost === null ? <span className="pos-na">—</span> : money(position.averageCost, position.currency)}</b>
        </span>

        <span className="pos-cell pos-cell-quote">
          {position.lastPrice === null ? (
            <b className="pos-na">Indisponible</b>
          ) : (
            <>
              <b>{money(position.lastPrice, position.currency)}</b>
              <em title={FRESHNESS_TITLE[freshness]}>
                <i className={`pos-dot pos-dot-${freshness}`} aria-hidden="true" />
                <span>{quoteDate ?? "date inconnue"}</span>
                {/* Le mode de cotation s'efface au palier intermédiaire : la date, elle, reste. */}
                {mode && <span className="pos-quote-mode">· {mode}</span>}
              </em>
            </>
          )}
        </span>

        <span className="pos-cell pos-cell-value">
          <b>{missing ? <span className="pos-na" title={MISSING_TITLE[missing]}>{MISSING_LABEL[missing]}</span> : money(position.currentValueEur!, position.referenceCurrency)}</b>
          {/* Repli du palier intermédiaire : le poids vient se loger sous la valeur. */}
          <em className="pos-value-weight">{missing ? "" : `Poids ${position.weightPct.toFixed(1).replace(".", ",")} %`}</em>
        </span>

        <span className={`pos-cell pos-cell-perf${toneOf(position.gainEur)}`}>
          {position.gainEur === null ? (
            <b className="pos-na" title={missing ? MISSING_TITLE[missing] : undefined}>—</b>
          ) : (
            <>
              <b>{signedMoney(position.gainEur, position.referenceCurrency)}</b>
              {position.gainPct !== null && <em>{signedPct(position.gainPct)}</em>}
            </>
          )}
        </span>

        <span className="pos-cell pos-cell-weight">
          {missing ? (
            <b className="pos-na" title={MISSING_TITLE[missing]}>—</b>
          ) : (
            <>
              <b>{position.weightPct.toFixed(1).replace(".", ",")} %</b>
              <span className="pos-weight-bar" aria-hidden="true"><i style={{ width: `${Math.min(100, Math.max(2, position.weightPct))}%` }} /></span>
            </>
          )}
        </span>

        <Chevron />
      </button>
    </li>
  );
}

// ==========================================================================================
// CARTE (mobile)
// ==========================================================================================
export function PositionMobileCard({ position, onOpen }: { position: PortfolioPosition; onOpen: (position: PortfolioPosition) => void }) {
  const freshness = freshnessOf(position);
  const quoteDate = shortQuoteDate(position.lastPriceAt);
  const missing = missingValueReason(position);

  return (
    <li className="pos-card-item">
      <button type="button" className="pos-card" onClick={() => onOpen(position)} aria-label={rowLabel(position)}>
        <span className="pos-card-head">
          <PositionAssetIdentity position={position} compact />
          <span className={`pos-card-pct${toneOf(position.gainPct)}`}>{position.gainPct === null ? "—" : signedPct(position.gainPct)}</span>
        </span>
        <span className="pos-card-body">
          <span className="pos-card-row is-lead">
            <span>Valeur</span>
            <span className="pos-card-figure">
              <b className={missing ? "pos-na" : undefined} title={missing ? MISSING_TITLE[missing] : undefined}>
                {missing ? MISSING_LABEL[missing] : money(position.currentValueEur!, position.referenceCurrency)}
              </b>
              {position.gainEur !== null && <em className={`pos-card-gain${toneOf(position.gainEur)}`}>{signedMoney(position.gainEur, position.referenceCurrency)}</em>}
            </span>
          </span>
          <span className="pos-card-row"><span>Quantité</span><b>{qtyFormat.format(position.quantity)}</b></span>
          <span className="pos-card-row"><span>PRU</span><b>{position.averageCost === null ? "—" : money(position.averageCost, position.currency)}</b></span>
          <span className="pos-card-row">
            <span>Cours</span>
            <b>
              {position.lastPrice === null ? "Indisponible" : money(position.lastPrice, position.currency)}
              {position.lastPrice !== null && <em title={FRESHNESS_TITLE[freshness]}><i className={`pos-dot pos-dot-${freshness}`} aria-hidden="true" />{quoteDate ?? "date inconnue"}</em>}
            </b>
          </span>
          <span className="pos-card-row"><span>Poids</span><b>{missing ? "—" : `${position.weightPct.toFixed(1).replace(".", ",")} %`}</b></span>
        </span>
        <Chevron />
      </button>
    </li>
  );
}

// ==========================================================================================
// LISTE
// ==========================================================================================
export function PositionsList({ positions, onOpen }: { positions: PortfolioPosition[]; onOpen: (position: PortfolioPosition) => void }) {
  return (
    <div className="pos-listing">
      <div className="pos-head" aria-hidden="true">
        <span className="pos-head-asset">Actif</span>
        {/* Deux libellés, un seul visible : « Quantité » quand le PRU a sa propre colonne,
            « Position » quand il se replie dessous au palier intermédiaire. */}
        <span><i className="pos-lab-full">Quantité</i><i className="pos-lab-mid">Position</i></span>
        <span className="pos-head-pru">PRU</span>
        <span>Cours</span>
        <span>Valeur</span>
        <span>Performance</span>
        <span className="pos-head-weight">Poids</span>
        <span />
      </div>
      <ul className="pos-list">
        {positions.map((position) => <PositionRow key={position.key} position={position} onOpen={onOpen} />)}
      </ul>
      <ul className="pos-cards">
        {positions.map((position) => <PositionMobileCard key={position.key} position={position} onOpen={onOpen} />)}
      </ul>
    </div>
  );
}
