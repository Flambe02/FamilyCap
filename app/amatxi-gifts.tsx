"use client";

import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import type { Viewer } from "../lib/auth-types";
import { supabaseBrowser } from "../lib/supabase-browser";
import { GIFT_HISTORY } from "../lib/gift-history";
import { InvestmentModal, type GiftEditingInput, type GiftSaveResult } from "./transactions";
import { useDialogA11y } from "./use-dialog-a11y";
import "./amatxi-gifts.css";

const ICON_COMMON = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
const ICONS = {
  gift: <svg {...ICON_COMMON}><rect x="3" y="8" width="18" height="4" rx="1" /><path d="M12 8v13" /><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7" /><path d="M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5" /></svg>,
  trendingUp: <svg {...ICON_COMMON}><polyline points="22 7 13.5 15.5 8.5 10.5 2 17" /><polyline points="16 7 22 7 22 13" /></svg>,
  shieldCheck: <svg {...ICON_COMMON}><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /><path d="m9 12 2 2 4-4" /></svg>,
  diamond: <svg {...ICON_COMMON}><path d="M12 2 22 12 12 22 2 12Z" /></svg>,
  users: <svg {...ICON_COMMON}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>,
  refresh: <svg {...ICON_COMMON}><path d="M3 12a9 9 0 0 1 15.3-6.4L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15.3 6.4L3 16" /><path d="M3 21v-5h5" /></svg>,
  grid: <svg {...ICON_COMMON}><rect x="3" y="3" width="7" height="7" rx="1.2" /><rect x="14" y="3" width="7" height="7" rx="1.2" /><rect x="3" y="14" width="7" height="7" rx="1.2" /><rect x="14" y="14" width="7" height="7" rx="1.2" /></svg>,
  list: <svg {...ICON_COMMON}><path d="M8 6h13" /><path d="M8 12h13" /><path d="M8 18h13" /><path d="M3 6h.01" /><path d="M3 12h.01" /><path d="M3 18h.01" /></svg>,
  arrowRight: <svg {...ICON_COMMON}><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></svg>,
} satisfies Record<string, ReactElement>;

type Occasion = "Anniversaire" | "Noël" | "Autre cadeau";
type Location = "Ledger" | "Binance" | "À classer";

type ApiGiftRecord = {
  id: string;
  member_name: string;
  occasion: string;
  gift_date: string;
  purchase_date?: string;
  amount_eur: number | string;
  btc_amount: number | string;
  custody: string;
  ledger_amount?: number | string | null;
  txid?: string | null;
  public_address?: string | null;
  blockchain_status?: string;
  confirmations?: number;
  note?: string | null;
  is_deleted?: boolean;
};

type GiftEntry = {
  id?: string;
  member: string;
  occasion: string;
  giftDate: string;
  purchaseDate?: string;
  amountEur: number;
  btcAmount: number;
  custody: string;
  ledgerAmount?: number | null;
  txid?: string | null;
  publicAddress?: string | null;
  blockchainStatus?: string;
  confirmations?: number;
  note?: string | null;
  origin: "database" | "historical";
};

type LedgerPriceResponse = { bitcoinEur?: number | null };

const euro = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });
const fullDate = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

function giftKey(entry: Pick<GiftEntry, "member" | "occasion" | "giftDate">) {
  return `${entry.member}|${entry.occasion}|${entry.giftDate.slice(0, 4)}`;
}
function ownedBtc(entry: GiftEntry) {
  return entry.custody === "Ledger" && Number(entry.ledgerAmount) > 0 ? Number(entry.ledgerAmount) : Math.max(0, Number(entry.btcAmount) || 0);
}
function locationOf(entry: GiftEntry): Location {
  if (entry.custody === "Ledger") return "Ledger";
  if (entry.custody === "Binance commun") return "Binance";
  return "À classer";
}
function isLocked(entry: GiftEntry) {
  return entry.origin === "database" && entry.custody === "Ledger";
}
function occasionIcon(occasion: string) {
  return occasion === "Noël" ? "🎄" : occasion === "Anniversaire" ? "🎂" : "🎁";
}
async function authHeaders(): Promise<Record<string, string>> {
  const session = (await supabaseBrowser.auth.getSession()).data.session;
  return session?.access_token ? { authorization: "Bearer " + session.access_token } : {};
}

const historical: GiftEntry[] = GIFT_HISTORY.map((gift) => ({
  member: gift.member,
  occasion: gift.occasion,
  giftDate: gift.giftDate,
  purchaseDate: gift.purchaseDate,
  amountEur: gift.amountEur,
  btcAmount: gift.btcAmount,
  custody: "Binance commun",
  note: gift.note,
  origin: "historical",
}));

function toEditingInput(entry: GiftEntry): GiftEditingInput {
  return {
    id: entry.origin === "database" ? entry.id : undefined,
    member: entry.member,
    occasion: (entry.occasion as Occasion) ?? "Anniversaire",
    custody: entry.custody === "Ledger" ? "Ledger" : "Binance commun",
    amountEur: entry.amountEur,
    btcAmount: entry.btcAmount,
    giftDate: entry.giftDate,
    txid: entry.txid,
    note: entry.note,
  };
}

export function AmatxiGifts({ viewer, previewReadOnly = false, onOpenPortfolio }: { viewer: Viewer; previewReadOnly?: boolean; onOpenPortfolio?: (member: string) => void }) {
  const isAdmin = viewer.role === "admin";
  const canManage = isAdmin && !previewReadOnly;
  const [databaseRecords, setDatabaseRecords] = useState<GiftEntry[]>([]);
  const [bitcoinEur, setBitcoinEur] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [memberFilter, setMemberFilter] = useState("Tous");
  const [occasionFilter, setOccasionFilter] = useState("Toutes");
  const [yearFilter, setYearFilter] = useState("Toutes");
  const [locationFilter, setLocationFilter] = useState<"Toutes" | Location>("Toutes");
  const [detail, setDetail] = useState<GiftEntry | null>(null);
  const [modal, setModal] = useState<"create" | GiftEntry | null>(null);
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");

  const load = useCallback(async (signal?: AbortSignal) => {
    const headers = await authHeaders();
    const [giftResponse, ledgerResponse] = await Promise.all([
      fetch("/api/gifts", { headers, signal }),
      fetch("/api/ledger?priceOnly=1", { headers, signal }),
    ]);
    const giftResult = await giftResponse.json() as { records?: ApiGiftRecord[]; error?: string };
    if (!giftResponse.ok) throw new Error(giftResult.error ?? "Cadeaux indisponibles.");
    setDatabaseRecords((giftResult.records ?? []).filter((record) => !record.is_deleted).map((record) => ({
      id: record.id,
      member: record.member_name,
      occasion: record.occasion,
      giftDate: record.gift_date,
      purchaseDate: record.purchase_date,
      amountEur: Number(record.amount_eur),
      btcAmount: Number(record.btc_amount),
      custody: record.custody,
      ledgerAmount: record.ledger_amount === null || record.ledger_amount === undefined ? null : Number(record.ledger_amount),
      txid: record.txid ?? null,
      publicAddress: record.public_address ?? null,
      blockchainStatus: record.blockchain_status,
      confirmations: record.confirmations,
      note: record.note ?? null,
      origin: "database" as const,
    })));
    if (ledgerResponse.ok) {
      const ledgerResult = await ledgerResponse.json() as LedgerPriceResponse;
      const price = Number(ledgerResult.bitcoinEur);
      setBitcoinEur(Number.isFinite(price) && price > 0 ? price : null);
    } else {
      setBitcoinEur(null);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void load(controller.signal)
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          setLoadError(error instanceof Error ? error.message : "Cadeaux indisponibles.");
        })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [load]);

  async function reload() {
    try { await load(); } catch (error) { setLoadError(error instanceof Error ? error.message : "Cadeaux indisponibles."); }
  }

  const allGifts = useMemo(() => {
    const historyKeys = new Set(historical.map(giftKey));
    const merged = historical.map((entry) => databaseRecords.find((record) => giftKey(record) === giftKey(entry)) ?? entry);
    const extras = databaseRecords.filter((record) => !historyKeys.has(giftKey(record)));
    return [...merged, ...extras].sort((a, b) => b.giftDate.localeCompare(a.giftDate));
  }, [databaseRecords]);

  const scopedGifts = useMemo(() => isAdmin ? allGifts : allGifts.filter((gift) => gift.member === viewer.name), [allGifts, isAdmin, viewer.name]);
  const members = useMemo(() => [...new Set(scopedGifts.map((gift) => gift.member))].sort(), [scopedGifts]);
  const occasions = useMemo(() => [...new Set(scopedGifts.map((gift) => gift.occasion))], [scopedGifts]);
  const years = useMemo(() => [...new Set(scopedGifts.map((gift) => gift.giftDate.slice(0, 4)))].sort().reverse(), [scopedGifts]);

  const filteredGifts = useMemo(() => scopedGifts.filter((gift) =>
    (memberFilter === "Tous" || gift.member === memberFilter) &&
    (occasionFilter === "Toutes" || gift.occasion === occasionFilter) &&
    (yearFilter === "Toutes" || gift.giftDate.startsWith(yearFilter)) &&
    (locationFilter === "Toutes" || locationOf(gift) === locationFilter),
  ), [scopedGifts, memberFilter, occasionFilter, yearFilter, locationFilter]);

  const summary = useMemo(() => {
    const totalEur = scopedGifts.reduce((sum, gift) => sum + gift.amountEur, 0);
    const totalBtc = scopedGifts.reduce((sum, gift) => sum + ownedBtc(gift), 0);
    const ledgerCount = scopedGifts.filter((gift) => locationOf(gift) === "Ledger").length;
    const binanceCount = scopedGifts.filter((gift) => locationOf(gift) === "Binance").length;
    const ledgerEur = scopedGifts.filter((gift) => locationOf(gift) === "Ledger").reduce((sum, gift) => sum + gift.amountEur, 0);
    const currentValueEur = bitcoinEur && totalBtc > 0 ? totalBtc * bitcoinEur : null;
    const firstYear = scopedGifts.reduce<number | null>((min, gift) => { const year = Number(gift.giftDate.slice(0, 4)); return min === null || year < min ? year : min; }, null);
    const securedShare = totalEur > 0 ? ledgerEur / totalEur : 0;
    return { totalEur, totalBtc, ledgerCount, binanceCount, currentValueEur, count: scopedGifts.length, beneficiaries: members.length, firstYear, securedShare };
  }, [scopedGifts, bitcoinEur, members.length]);

  function clearFilters() { setMemberFilter("Tous"); setOccasionFilter("Toutes"); setYearFilter("Toutes"); setLocationFilter("Toutes"); }

  async function handleSaved(result: GiftSaveResult) {
    setModal(null);
    setDetail(null);
    setFeedback(result.message);
    window.setTimeout(() => setFeedback(""), 3200);
    await reload();
  }

  return (
    <div className="page-stack amatxi-gifts-page">
      <section className="panel amatxi-head">
        <div className="amatxi-head-content">
          <div>
            <span className="soft-pill">MÉMOIRE FAMILIALE</span>
            <h2>Cadeaux d’Amatxi</h2>
            <p>Retrouvez tous les cadeaux offerts pour les anniversaires et Noël, ainsi que leur évolution en Bitcoin.</p>
          </div>
          {summary.count > 0 && (
            <p className="amatxi-member-summary">
              <span className="amatxi-member-summary-icon" aria-hidden="true">{ICONS.gift}</span>
              <span>
                {summary.firstYear ? `Depuis ${summary.firstYear}, ` : ""}Amatxi {isAdmin ? "a offert" : "t’a offert"} <strong>{euro.format(summary.totalEur)}</strong>.
                {" "}Ces cadeaux représentent aujourd’hui {summary.currentValueEur === null ? <strong>{summary.totalBtc.toFixed(8)} BTC</strong> : <strong>{euro.format(summary.currentValueEur)}</strong>}.
              </span>
            </p>
          )}
          {canManage && <button type="button" className="primary-button amatxi-add-button" onClick={() => setModal("create")}>＋ Ajouter un cadeau</button>}
        </div>
        <div className="amatxi-head-media" aria-hidden="true">
          <img src="/amatxi-hero.webp" alt="" />
        </div>
      </section>

      {summary.count > 0 && (
        <section className="amatxi-summary-grid" aria-label="Indicateurs des cadeaux">
          <SummaryCard label="Montant total offert" value={euro.format(summary.totalEur)} tone="teal" icon="€" progress={summary.securedShare} />
          <SummaryCard label="Valeur aujourd’hui" value={summary.currentValueEur === null ? (loading ? "Mise à jour…" : "Cours indisponible") : euro.format(summary.currentValueEur)} note={bitcoinEur ? `1 BTC = ${euro.format(bitcoinEur)}` : undefined} tone="amber" icon={ICONS.trendingUp} />
          <SummaryCard label="Bitcoin reçu" value={`${summary.totalBtc.toFixed(8)} BTC`} tone="neutral" icon="₿" />
          <SummaryCard label="Cadeaux" value={String(summary.count)} tone="coral" icon={ICONS.gift} />
          {isAdmin && <SummaryCard label="Bénéficiaires" value={String(summary.beneficiaries)} tone="neutral" icon={ICONS.users} />}
          <SummaryCard label="Conservés sur Binance" value={String(summary.binanceCount)} tone="amber" icon={ICONS.diamond} />
          <SummaryCard label="Transférés sur Ledger" value={String(summary.ledgerCount)} tone="teal" icon={ICONS.shieldCheck} />
        </section>
      )}

      {summary.count > 0 && (
        <section className="panel amatxi-filters" aria-label="Filtrer les cadeaux">
          {isAdmin && (
            <label className="amatxi-filter-field">Membre
              <select value={memberFilter} onChange={(event) => setMemberFilter(event.target.value)}><option>Tous</option>{members.map((name) => <option key={name}>{name}</option>)}</select>
            </label>
          )}
          <label className="amatxi-filter-field">Occasion
            <select value={occasionFilter} onChange={(event) => setOccasionFilter(event.target.value)}><option>Toutes</option>{occasions.map((occasion) => <option key={occasion}>{occasion}</option>)}</select>
          </label>
          <label className="amatxi-filter-field">Année
            <select value={yearFilter} onChange={(event) => setYearFilter(event.target.value)}><option>Toutes</option>{years.map((year) => <option key={year}>{year}</option>)}</select>
          </label>
          <div className="amatxi-filter-location">
            <span>Emplacement</span>
            <div className="amatxi-filter-chips" role="group" aria-label="Filtrer par emplacement">
              {(["Toutes", "Binance", "Ledger"] as const).map((location) => (
                <button type="button" key={location} className={locationFilter === location ? "active" : ""} aria-pressed={locationFilter === location} onClick={() => setLocationFilter(location)}>{location === "Toutes" ? "Tous les emplacements" : location}</button>
              ))}
            </div>
          </div>
          <button type="button" className="amatxi-filter-clear" onClick={clearFilters}><span aria-hidden="true">{ICONS.refresh}</span>Réinitialiser</button>
        </section>
      )}

      <section className="panel amatxi-list-panel">
        <header className="amatxi-list-head">
          <div>
            <span>CADEAUX</span>
            <h3>{loading ? "Chargement…" : `${filteredGifts.length} cadeau${filteredGifts.length > 1 ? "x" : ""} affiché${filteredGifts.length > 1 ? "s" : ""}`}</h3>
          </div>
          {!loading && filteredGifts.length > 0 && (
            <div className="amatxi-view-toggle" role="group" aria-label="Choisir l’affichage">
              <button type="button" className={viewMode === "grid" ? "active" : ""} aria-pressed={viewMode === "grid"} aria-label="Affichage en cartes" onClick={() => setViewMode("grid")}>{ICONS.grid}</button>
              <button type="button" className={viewMode === "list" ? "active" : ""} aria-pressed={viewMode === "list"} aria-label="Affichage en liste" onClick={() => setViewMode("list")}>{ICONS.list}</button>
            </div>
          )}
        </header>
        {loading ? (
          <div className="amatxi-skeleton-grid" aria-hidden="true">{Array.from({ length: 6 }).map((_, index) => <div className="amatxi-skeleton-card" key={index} />)}</div>
        ) : (
          <>
            {loadError && <p className="amatxi-load-warning" role="alert">{loadError} Les derniers cadeaux enregistrés peuvent manquer ci-dessous.</p>}
            {filteredGifts.length === 0 ? (
              <div className="amatxi-empty">{scopedGifts.length === 0 ? "Aucun cadeau n’est encore enregistré." : "Aucun cadeau ne correspond à ces filtres."}</div>
            ) : viewMode === "grid" ? (
              <div className="amatxi-grid">
                {filteredGifts.map((gift) => <GiftCard key={giftKey(gift) + (gift.id ?? "")} gift={gift} bitcoinEur={bitcoinEur} onOpen={() => setDetail(gift)} />)}
              </div>
            ) : (
              <div className="amatxi-rows" role="table" aria-label="Cadeaux, en liste">
                {filteredGifts.map((gift) => <GiftRow key={giftKey(gift) + (gift.id ?? "")} gift={gift} bitcoinEur={bitcoinEur} onOpen={() => setDetail(gift)} />)}
              </div>
            )}
          </>
        )}
      </section>

      {modal && canManage && (
        <InvestmentModal
          defaultMember={memberFilter !== "Tous" ? memberFilter : undefined}
          editing={modal !== "create" ? toEditingInput(modal) : undefined}
          onClose={() => setModal(null)}
          onSaved={(result) => void handleSaved(result)}
        />
      )}

      {detail && (
        <GiftDetailPanel
          gift={detail}
          bitcoinEur={bitcoinEur}
          isAdmin={isAdmin}
          canManage={canManage}
          onClose={() => setDetail(null)}
          onEdit={() => { setModal(detail); setDetail(null); }}
          onOpenPortfolio={onOpenPortfolio}
        />
      )}

      {feedback && <div className="toast" role="status">✓ {feedback}</div>}
    </div>
  );
}

function SummaryCard({ label, value, note, tone, icon, progress }: { label: string; value: string; note?: string; tone: "amber" | "teal" | "coral" | "neutral"; icon: ReactElement | string; progress?: number }) {
  const pct = progress === undefined ? null : Math.max(0, Math.min(1, progress)) * 100;
  return (
    <article className={`amatxi-stat ${tone}`}>
      <span className={`amatxi-stat-icon ${tone}`} aria-hidden="true">{icon}</span>
      <div className="amatxi-stat-body">
        <p>{label}</p>
        <strong>{value}</strong>
        {note && <small>{note}</small>}
      </div>
      {pct !== null && (
        <div className="amatxi-stat-progress" role="img" aria-label={`${Math.round(pct)} % du montant sécurisé sur Ledger`}>
          <span style={{ width: `${pct}%` }} />
        </div>
      )}
    </article>
  );
}

function GiftCard({ gift, bitcoinEur, onOpen }: { gift: GiftEntry; bitcoinEur: number | null; onOpen: () => void }) {
  const btc = ownedBtc(gift);
  const currentValue = bitcoinEur && btc > 0 ? btc * bitcoinEur : null;
  const gain = currentValue === null ? null : currentValue - gift.amountEur;
  const location = locationOf(gift);
  const year = gift.giftDate.slice(0, 4);
  return (
    <button type="button" className="amatxi-card" onClick={onOpen} aria-label={`Voir le détail du cadeau ${gift.occasion.toLowerCase()} de ${gift.member}, ${year}`}>
      <span className={`amatxi-card-icon ${gift.occasion === "Noël" ? "christmas" : "birthday"}`} aria-hidden="true">{occasionIcon(gift.occasion)}</span>
      <div className="amatxi-card-body">
        <strong>{gift.member}</strong>
        <span className="amatxi-card-meta">{gift.occasion} · {year}</span>
      </div>
      <div className="amatxi-card-amounts">
        <span className="amatxi-card-offered">{euro.format(gift.amountEur)} offerts</span>
        <span className="amatxi-card-btc">{btc > 0 ? `${btc.toFixed(8)} BTC` : "BTC à renseigner"}</span>
      </div>
      <div className="amatxi-card-value">
        <span>{currentValue === null ? "Cours indisponible" : euro.format(currentValue)}</span>
        {gain !== null && <small className={gain >= 0 ? "up" : "down"}>{gain >= 0 ? "+" : ""}{euro.format(gain)}</small>}
      </div>
      <div className="amatxi-card-footer">
        <span className={`amatxi-location-chip ${location === "Ledger" ? "ledger" : location === "Binance" ? "binance" : "pending"}`}>{location === "À classer" ? "À classer" : location === "Ledger" ? "Sur Ledger" : "Sur Binance"}</span>
        <span className="amatxi-card-detail-link">Voir le détail <span aria-hidden="true">{ICONS.arrowRight}</span></span>
      </div>
    </button>
  );
}

function GiftRow({ gift, bitcoinEur, onOpen }: { gift: GiftEntry; bitcoinEur: number | null; onOpen: () => void }) {
  const btc = ownedBtc(gift);
  const currentValue = bitcoinEur && btc > 0 ? btc * bitcoinEur : null;
  const gain = currentValue === null ? null : currentValue - gift.amountEur;
  const location = locationOf(gift);
  const year = gift.giftDate.slice(0, 4);
  return (
    <button type="button" className="amatxi-row" role="row" onClick={onOpen} aria-label={`Voir le détail du cadeau ${gift.occasion.toLowerCase()} de ${gift.member}, ${year}`}>
      <span className={`amatxi-row-icon ${gift.occasion === "Noël" ? "christmas" : "birthday"}`} aria-hidden="true">{occasionIcon(gift.occasion)}</span>
      <span className="amatxi-row-cell amatxi-row-member"><strong>{gift.member}</strong><small>{gift.occasion} · {year}</small></span>
      <span className="amatxi-row-cell">{euro.format(gift.amountEur)} offerts<small>{btc > 0 ? `${btc.toFixed(8)} BTC` : "BTC à renseigner"}</small></span>
      <span className="amatxi-row-cell">
        <strong>{currentValue === null ? "Cours indisponible" : euro.format(currentValue)}</strong>
        {gain !== null && <small className={gain >= 0 ? "up" : "down"}>{gain >= 0 ? "+" : ""}{euro.format(gain)}</small>}
      </span>
      <span className={`amatxi-location-chip ${location === "Ledger" ? "ledger" : location === "Binance" ? "binance" : "pending"}`}>{location === "À classer" ? "À classer" : location === "Ledger" ? "Sur Ledger" : "Sur Binance"}</span>
      <span className="amatxi-row-arrow" aria-hidden="true">{ICONS.arrowRight}</span>
    </button>
  );
}

function GiftDetailPanel({ gift, bitcoinEur, isAdmin, canManage, onClose, onEdit, onOpenPortfolio }: {
  gift: GiftEntry;
  bitcoinEur: number | null;
  isAdmin: boolean;
  canManage: boolean;
  onClose: () => void;
  onEdit: () => void;
  onOpenPortfolio?: (member: string) => void;
}) {
  const dialogRef = useDialogA11y(true, onClose);
  const btc = ownedBtc(gift);
  const currentValue = bitcoinEur && btc > 0 ? btc * bitcoinEur : null;
  const gain = currentValue === null ? null : currentValue - gift.amountEur;
  const locked = isLocked(gift);
  const location = locationOf(gift);
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className="modal amatxi-detail-modal" role="dialog" aria-modal="true" aria-labelledby="amatxi-detail-title" tabIndex={-1}>
        <header>
          <div>
            <span>{occasionIcon(gift.occasion)} {gift.occasion.toUpperCase()}</span>
            <h2 id="amatxi-detail-title">{gift.occasion === "Noël" ? "Le cadeau de Noël d’Amatxi" : gift.occasion === "Anniversaire" ? "Le cadeau d’anniversaire d’Amatxi" : "Le cadeau d’Amatxi"}</h2>
          </div>
          <button onClick={onClose} aria-label="Fermer">×</button>
        </header>
        <dl className="amatxi-detail-grid">
          <div><dt>Bénéficiaire</dt><dd>{gift.member}</dd></div>
          <div><dt>Date du cadeau</dt><dd>{fullDate.format(new Date(gift.giftDate + "T00:00:00Z"))}</dd></div>
          <div><dt>Montant offert</dt><dd>{euro.format(gift.amountEur)}</dd></div>
          <div><dt>Bitcoin reçu</dt><dd>{btc > 0 ? `${btc.toFixed(8)} BTC` : "À renseigner"}</dd></div>
          {isAdmin && gift.purchaseDate && <div><dt>Date d’achat</dt><dd>{fullDate.format(new Date(gift.purchaseDate + "T00:00:00Z"))}</dd></div>}
          <div><dt>Où sont les bitcoins</dt><dd>{location === "Ledger" ? "Transféré sur le Ledger familial" : location === "Binance" ? "Conservé sur Binance commun" : "À classer"}</dd></div>
          <div><dt>Valeur aujourd’hui</dt><dd>{currentValue === null ? "Cours indisponible" : euro.format(currentValue)}</dd></div>
          {gain !== null && <div><dt>Évolution</dt><dd className={gain >= 0 ? "gain up" : "gain down"}>{gain >= 0 ? "+" : ""}{euro.format(gain)}</dd></div>}
          {isAdmin && <div><dt>TxID</dt><dd>{gift.txid ? <code>{gift.txid.slice(0, 10)}…{gift.txid.slice(-8)}</code> : "TxID non renseigné"}</dd></div>}
          {isAdmin && gift.blockchainStatus && <div><dt>Statut blockchain</dt><dd>{gift.blockchainStatus}</dd></div>}
          {gift.note && <div className="span-2"><dt>Note</dt><dd>{gift.note}</dd></div>}
        </dl>
        {canManage && (
          <footer className="amatxi-detail-footer">
            {locked ? (
              <p className="amatxi-locked-note">Verrouillé après transfert Ledger — non modifiable ici.{onOpenPortfolio && <button type="button" onClick={() => onOpenPortfolio(gift.member)}>Ouvrir le portefeuille détaillé →</button>}</p>
            ) : (
              <button type="button" className="primary-button" onClick={onEdit}>Modifier ce cadeau</button>
            )}
          </footer>
        )}
      </section>
    </div>
  );
}
