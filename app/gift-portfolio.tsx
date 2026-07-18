"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import type { Viewer } from "../lib/auth-types";
import type { TransferRequest } from "./back-office";
import type { TransactionShortcut } from "./transactions";
import { supabaseBrowser } from "../lib/supabase-browser";
import { GIFT_HISTORY } from "../lib/gift-history";
import { useDialogA11y } from "./use-dialog-a11y";
import "./gift-portfolio.css";

type GiftRecord = {
  id?: string;
  member_name: string;
  occasion: string;
  gift_date: string;
  purchase_date: string;
  amount_eur: number;
  btc_amount: number;
  custody: "Ledger" | "Binance commun" | "À rapprocher";
  transfer_date?: string | null;
  ledger_amount?: number | null;
  ledger_value_forced?: boolean;
  ledger_force_reason?: string | null;
  public_address?: string | null;
  txid?: string | null;
  blockchain_status?: string;
  confirmations?: number;
  note?: string | null;
  is_deleted?: boolean;
  origin: "database" | "historical" | "expected";
};

type LedgerTransaction = { txid: string; date: string | null; amountBtc: number; direction: string; confirmations: number; explorerUrl: string };
type LedgerWallet = { member: string; address: string; confirmedBalanceBtc?: number; transactions?: LedgerTransaction[]; explorerUrl?: string; error?: string };
type LedgerResponse = { wallets?: LedgerWallet[]; bitcoinEur: number | null; updatedAt?: string };

type MemberInfo = { name: string; initials: string; birthday: string; day: number; month: number; color: string };
const people: MemberInfo[] = [
  { name: "Thibault", initials: "TH", birthday: "15 mars", day: 15, month: 3, color: "mint" },
  { name: "Uhaina", initials: "UH", birthday: "16 août", day: 16, month: 8, color: "coral" },
  { name: "Paul", initials: "PA", birthday: "18 novembre", day: 18, month: 11, color: "blue" },
  { name: "Aurore", initials: "AU", birthday: "27 août", day: 27, month: 8, color: "yellow" },
  { name: "Thomas", initials: "TO", birthday: "29 décembre", day: 29, month: 12, color: "purple" },
];
const addresses: Record<string, string> = {
  Thibault: "bc1qcy4jt8fh5dhj9fq9d4lu2hq6klvvdmlkeqcgks",
  Uhaina: "bc1qqkfmts27j07y8u7a6ap7wyczfhe5afyrkn7y2t",
  Paul: "bc1qxx7ve23aggf0596zf45kx0ppk5qjggpak82wd5",
  Aurore: "bc1qxs2uy67myzfx8z2vtzr6lm3cgrx808azqkt4pg",
  Thomas: "bc1qfwuze87xnhxjfdmr3wnfy3wguu5ymedk4qcwjr",
};
const historical: Omit<GiftRecord, "origin">[] = GIFT_HISTORY.map((gift) => ({
  member_name: gift.member,
  occasion: gift.occasion,
  gift_date: gift.giftDate,
  purchase_date: gift.purchaseDate,
  amount_eur: gift.amountEur,
  btc_amount: gift.btcAmount,
  custody: "Binance commun" as const,
  note: gift.note,
}));
const euro = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });
const monthYear = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" });
const fullDate = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

async function authHeaders() {
  const session = (await supabaseBrowser.auth.getSession()).data.session;
  return { authorization: "Bearer " + (session?.access_token ?? ""), "content-type": "application/json" };
}
async function request(url: string, init: RequestInit = {}) {
  const response = await fetch(url, { ...init, headers: { ...(await authHeaders()), ...init.headers } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Opération impossible");
  return result;
}
function keyOf(record: Pick<GiftRecord, "member_name" | "occasion" | "gift_date">) {
  return record.member_name + "|" + record.occasion + "|" + record.gift_date.slice(0, 4);
}
function portfolioNote(note?: string | null) {
  return note
    ?.replace(/(?:\s*[·-]\s*)?valeur confirmée par le tableau familial\.?/gi, "")
    .replace(/\s*[·-]\s*$/, "")
    .trim() || "";
}
function locked(record: GiftRecord) {
  return record.origin === "database" && record.custody === "Ledger";
}
function expectedRecords() {
  const currentYear = new Date().getFullYear();
  const records: GiftRecord[] = [];
  for (const person of people) {
    for (let year = 2026; year <= currentYear; year += 1) {
      const birthdayDate = `${year}-${String(person.month).padStart(2, "0")}-${String(person.day).padStart(2, "0")}`;
      records.push({ member_name: person.name, occasion: "Anniversaire", gift_date: birthdayDate, purchase_date: "", amount_eur: 55, btc_amount: 0, custody: "À rapprocher", origin: "expected" });
      records.push({ member_name: person.name, occasion: "Noël", gift_date: `${year}-12-25`, purchase_date: "", amount_eur: 55, btc_amount: 0, custody: "À rapprocher", origin: "expected" });
    }
  }
  return records;
}

export function GiftPortfolio({ viewer, requests = [], onRequestStatus, selectedMember, previewReadOnly = false, onOpenTransactions }: { viewer: Viewer; requests?: TransferRequest[]; onRequestStatus?: (id: string, status: TransferRequest["status"]) => void; selectedMember?: string; previewReadOnly?: boolean; onOpenTransactions?: (shortcut: Omit<TransactionShortcut, "requestId">) => void }) {
  const isAdmin = viewer.role === "admin";
  const [databaseRecords, setDatabaseRecords] = useState<GiftRecord[]>([]);
  const [ledger, setLedger] = useState<LedgerResponse | null>(null);
  const [selected, setSelected] = useState(isAdmin ? (selectedMember ?? "Thibault") : viewer.name);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [expandedLedgerExplanation, setExpandedLedgerExplanation] = useState<string | null>(null);
  const [editor, setEditor] = useState<GiftRecord | null>(null);
  const [requestedGiftIds, setRequestedGiftIds] = useState<string[]>([]);
  const [activeEnvelope, setActiveEnvelope] = useState<"total" | "btc" | "pea" | "cto">("btc");
  const [reconciliationOpen, setReconciliationOpen] = useState(false);

  const load = useCallback(async () => {
    const giftResult = await request("/api/gifts");
    const ledgerResult = await request(isAdmin ? "/api/ledger" : "/api/ledger?priceOnly=1");
    setDatabaseRecords((giftResult.records ?? []).map((record: GiftRecord) => ({ ...record, amount_eur: Number(record.amount_eur), btc_amount: Number(record.btc_amount), ledger_amount: record.ledger_amount ? Number(record.ledger_amount) : null, origin: "database" })));
    setLedger(ledgerResult);
  }, [isAdmin]);
  useEffect(() => {
    if (!isAdmin || !selectedMember) return;
    const timer = window.setTimeout(() => setSelected(selectedMember), 0);
    return () => window.clearTimeout(timer);
  }, [isAdmin, selectedMember]);
  useEffect(() => {
    const timer = window.setTimeout(() => { void load().catch((error) => setMessage(error.message)).finally(() => setLoading(false)); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const allRecords = useMemo(() => {
    const historyKeys = new Set(historical.map(keyOf));
    const history: GiftRecord[] = [];
    for (const truth of historical) {
      const stored = databaseRecords.find((record) => keyOf(record) === keyOf(truth));
      if (stored?.is_deleted) continue;
      history.push(stored
        ? { ...stored, member_name: truth.member_name, occasion: truth.occasion, gift_date: truth.gift_date, purchase_date: stored.purchase_date || truth.purchase_date, amount_eur: stored.amount_eur, btc_amount: stored.btc_amount, note: stored.note ?? truth.note, origin: "database" }
        : { ...truth, origin: "historical" });
    }
    const extraDatabaseRecords = databaseRecords.filter((record) => !historyKeys.has(keyOf(record)) && !record.is_deleted);
    const recordedKeys = new Set([...extraDatabaseRecords, ...history].map(keyOf));
    const expected = expectedRecords().filter((record) => !recordedKeys.has(keyOf(record)));
    return [...extraDatabaseRecords, ...history, ...expected].sort((a, b) => b.gift_date.localeCompare(a.gift_date));
  }, [databaseRecords]);
  const records = allRecords.filter((record) => record.member_name === selected);
  const recorded = records.filter((record) => record.origin !== "expected");
  const wallet = ledger?.wallets?.find((item) => item.member === selected);
  const totalBtc = recorded.reduce((sum, record) => sum + (record.custody === "Ledger" ? Number(record.ledger_amount ?? record.btc_amount) : record.btc_amount), 0);
  const ledgerGiftBtc = recorded.filter((record) => record.custody === "Ledger").reduce((sum, record) => sum + Number(record.ledger_amount ?? record.btc_amount), 0);
  const binanceBtc = recorded.filter((record) => record.custody === "Binance commun" || (!isAdmin && record.custody === "À rapprocher" && record.btc_amount > 0)).reduce((sum, record) => sum + record.btc_amount, 0);
  const unassignedRecords = recorded.filter((record) => record.custody === "À rapprocher" && Number(record.btc_amount) > 0);
  const unassignedBtc = unassignedRecords.reduce((sum, record) => sum + Number(record.btc_amount), 0);
  const transferCostsBtc = recorded.filter((record) => record.custody === "Ledger").reduce((sum, record) => sum + Math.max(0, record.btc_amount - Number(record.ledger_amount ?? record.btc_amount)), 0);
  const totalEur = recorded.reduce((sum, record) => sum + record.amount_eur, 0);
  const christmasCount = recorded.filter((record) => record.occasion === "Noël").length;
  const birthdayCount = recorded.filter((record) => record.occasion === "Anniversaire").length;
  const missing = records.filter((record) => record.origin === "expected" && new Date(record.gift_date + "T23:59:59Z") < new Date()).length;
  const years = [...new Set(records.map((record) => record.gift_date.slice(0, 4)))];
const person = people.find((item) => item.name === selected) ?? people[0];
  const today = new Date();
  const nextBirthday = new Date(Date.UTC(today.getUTCFullYear(), person.month - 1, person.day));
  if (nextBirthday.getTime() < Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) nextBirthday.setUTCFullYear(today.getUTCFullYear() + 1);
  const daysUntilBirthday = Math.max(0, Math.ceil((nextBirthday.getTime() - Date.now()) / 86400000));
  const currentValueEur = ledger?.bitcoinEur ? totalBtc * ledger.bitcoinEur : null;
  const theoreticalGainEur = currentValueEur === null ? null : currentValueEur - totalEur;
  const theoreticalGainPct = theoreticalGainEur === null || totalEur <= 0 ? null : theoreticalGainEur / totalEur * 100;
  const averagePurchasePriceEur = totalBtc > 0 ? totalEur / totalBtc : null;

  function openTransactions(label: string, location: TransactionShortcut["location"] = "Tous", scope: TransactionShortcut["scope"] = "all") {
    onOpenTransactions?.({ member: selected, location, scope, label });
  }

  function startEntry(record?: GiftRecord) {
    const today = new Date().toISOString().slice(0, 10);
    setEditor(record ? { ...record, purchase_date: record.purchase_date || record.gift_date || today } : { member_name: selected, occasion: "Anniversaire", gift_date: today, purchase_date: today, amount_eur: 55, btc_amount: 0, custody: "À rapprocher", origin: "expected" });
  }
  async function remove(record: GiftRecord) {
    if (!record.id || !window.confirm("Supprimer ce cadeau du registre ?")) return;
    try { await request("/api/gifts?id=" + encodeURIComponent(record.id), { method: "DELETE" }); setMessage("Cadeau supprimé."); await load(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Suppression impossible"); }
  }

  function giftRequestId(record: GiftRecord) {
    return `gift-${record.id ?? keyOf(record)}`;
  }
  function hasPendingTransfer(record: GiftRecord) {
    const id = giftRequestId(record);
    return requestedGiftIds.includes(id) || requests.some((item) => item.transactionId === id && item.status !== "Transférée");
  }
  async function requestGiftTransfer(record: GiftRecord) {
    const transactionId = giftRequestId(record);
    if (!record.btc_amount || hasPendingTransfer(record)) return;
    try {
      await request("/api/transfer-requests", {
        method: "POST",
        body: JSON.stringify({ id: `request-${transactionId}`, member: viewer.name, transactionId, btcAmount: record.btc_amount, requestedAt: new Date().toISOString() }),
      });
      setRequestedGiftIds((current) => [...current, transactionId]);
      setMessage("Demande de transfert envoyée à Florent.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Demande de transfert impossible.");
    }
  }
  async function unlinkLedger(record: GiftRecord) {
    if (!record.id || !window.confirm("Désassocier ce cadeau du virement Ledger ? Le mouvement blockchain ne sera pas modifié.")) return;
    try {
      await request("/api/gifts", { method: "PATCH", body: JSON.stringify({ id: record.id, action: "unlinkLedger" }) });
      setMessage("Association Ledger retirée. Le cadeau est de nouveau à rapprocher.");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Désassociation impossible.");
    }
  }
  return <div className={`gift-portfolio ${isAdmin ? "admin-portfolio" : "member-portfolio"}`}>
    {isAdmin && <section className="gift-person-picker" aria-label="Choisir un portefeuille">
      <span className="picker-label">À QUI APPARTIENT CE PORTEFEUILLE ?</span>
      <div className="person-tabs">{people.map((item) => <button type="button" key={item.name} className={selected === item.name ? "active" : ""} aria-pressed={selected === item.name} onClick={() => setSelected(item.name)}><b className={`avatar ${item.color}`}>{item.initials}</b><span><strong>{item.name}</strong><small>{item.birthday}</small></span></button>)}</div>
    </section>}

<div className="next-birthday-notice" role="status"><span aria-hidden="true">&#127874;</span><span>Prochain anniversaire de <strong>{person.name}</strong> : {fullDate.format(nextBirthday)}</span><b>{daysUntilBirthday === 0 ? "Ce jour" : "dans " + daysUntilBirthday + " jours"}</b></div>
    <section className="portfolio-hero">
      <span className="hero-orb" aria-hidden="true" />
      <span className="hero-orb-ring" aria-hidden="true" />
      <div className="portfolio-hero-top">
        <div className="portfolio-hero-copy">
          <span className="hero-badge">Portefeuille de {person.name}</span>
          <p className="hero-birthday">Anniversaire le {person.birthday} · cadeau de Noël le 25 décembre</p>
          <strong className="portfolio-current-value">{currentValueEur === null ? `${totalBtc.toFixed(8)} BTC` : euro.format(currentValueEur)}</strong>
          <span className="portfolio-current-meta"><b>{totalBtc.toFixed(8)} BTC</b> · {euro.format(totalEur)} investis à l’époque <span className="portfolio-occasion-counts"><button type="button" className="portfolio-occasion-count christmas" title="Voir les cadeaux de Noël dans Transactions" onClick={() => openTransactions("Noël de " + selected, "Tous", "gifts")}>&#127876; {christmasCount}</button><button type="button" className="portfolio-occasion-count birthday" title="Voir les anniversaires dans Transactions" onClick={() => openTransactions("Anniversaires de " + selected, "Tous", "gifts")}>&#127874; {birthdayCount}</button></span></span>
        </div>
        {isAdmin && <button className="primary-button hero-action" onClick={() => startEntry()}>＋ Saisir un cadeau</button>}
      </div>
      <div className="portfolio-market-metrics"><span><small>PRU moyen pondéré</small><b>{averagePurchasePriceEur === null ? "À calculer" : euro.format(averagePurchasePriceEur) + " / BTC"}</b></span><span><small>{theoreticalGainEur !== null && theoreticalGainEur < 0 ? "Moins-value totale" : "Plus-value totale"}</small><b className={theoreticalGainEur === null ? "gain neutral" : theoreticalGainEur >= 0 ? "gain up" : "gain down"}>{theoreticalGainEur === null || theoreticalGainPct === null ? "Cours indisponible" : (theoreticalGainEur >= 0 ? "+" : "") + euro.format(theoreticalGainEur) + " · " + (theoreticalGainEur >= 0 ? "+" : "") + theoreticalGainPct.toFixed(1) + " %"}</b></span><span><small>Cours du Bitcoin</small><b>{ledger?.bitcoinEur ? "1 BTC = " + euro.format(ledger.bitcoinEur) : "Cours indisponible"}</b></span></div>
      <div className="portfolio-asset-tabs" role="tablist" aria-label="Patrimoine suivi">
        <button id="portfolio-tab-total" type="button" role="tab" aria-selected={activeEnvelope === "total"} aria-controls="portfolio-envelope" className={activeEnvelope === "total" ? "active" : ""} onClick={() => setActiveEnvelope("total")}>Total</button>
        <button id="portfolio-tab-btc" type="button" role="tab" aria-selected={activeEnvelope === "btc"} aria-controls="portfolio-envelope" className={activeEnvelope === "btc" ? "active" : ""} onClick={() => setActiveEnvelope("btc")}>Bitcoin</button>
        <button id="portfolio-tab-pea" type="button" role="tab" disabled>PEA <em>Bientôt</em></button>
        <button id="portfolio-tab-cto" type="button" role="tab" disabled>Compte-titres <em>Bientôt</em></button>
      </div>
      <div id="portfolio-envelope" role="tabpanel" aria-labelledby={`portfolio-tab-${activeEnvelope}`} className={activeEnvelope === "total" ? "portfolio-total-panel" : "portfolio-tab-panel"}>
        {activeEnvelope === "total" && <><div><span>Bitcoin</span><strong>{currentValueEur === null ? `${totalBtc.toFixed(8)} BTC` : euro.format(currentValueEur)}</strong></div><div><span>PEA et compte-titres</span><strong>Bientôt disponibles</strong></div><div><span>Total suivi</span><strong>{currentValueEur === null ? `${totalBtc.toFixed(8)} BTC` : euro.format(currentValueEur)}</strong></div></>}
      </div>
      <div className="portfolio-allocation" aria-label="Allocation suivie"><i><b /></i><span>Bitcoin — 100 % du patrimoine suivi</span><span>PEA et compte-titres rejoindront cette vue</span></div>
    </section>
    {message && <p className="gift-message" role="status">{message}</p>}

    <section className="portfolio-main-grid">
      <div className="portfolio-custody-column">
        <section className="portfolio-card custody-card">
          <h2>Où sont les bitcoins ?</h2>
          <div className="custody-bars">
            <button type="button" className="custody-shortcut" onClick={() => openTransactions("Ledger de " + selected + " · blockchain", "Ledger", "all")} aria-label={"Voir les cadeaux et transactions Ledger de " + selected}><span><b>Ledger personnel</b><em>{ledgerGiftBtc.toFixed(8)} BTC · {totalBtc ? Math.round(ledgerGiftBtc / totalBtc * 100) : 0} %</em></span><i role="progressbar" aria-label="Part attribuée sur Ledger" aria-valuemin={0} aria-valuemax={100} aria-valuenow={totalBtc ? Math.round(ledgerGiftBtc / totalBtc * 100) : 0} aria-valuetext={ledgerGiftBtc.toFixed(8) + " BTC sur Ledger"}><b style={{ width: totalBtc ? (ledgerGiftBtc / totalBtc * 100) + "%" : "0%" }} /></i><small>Voir les informations blockchain <b aria-hidden="true">→</b></small></button>
            <button type="button" className="custody-shortcut" onClick={() => openTransactions("Bitcoins de " + selected + " sur Binance", "Binance", "gifts")} aria-label={"Voir les cadeaux de " + selected + " encore sur Binance"}><span><b>Binance commun</b><em>{binanceBtc.toFixed(8)} BTC · {totalBtc ? Math.round(binanceBtc / totalBtc * 100) : 0} %</em></span><i className="binance" role="progressbar" aria-label="Part attribuée sur Binance commun" aria-valuemin={0} aria-valuemax={100} aria-valuenow={totalBtc ? Math.round(binanceBtc / totalBtc * 100) : 0} aria-valuetext={binanceBtc.toFixed(8) + " BTC sur Binance commun"}><b style={{ width: totalBtc ? (binanceBtc / totalBtc * 100) + "%" : "0%" }} /></i><small>Voir les achats en attente de transfert <b aria-hidden="true">→</b></small></button>
            {isAdmin && unassignedBtc > 0 && <div className="custody-reconciliation"><button type="button" className="custody-reconcile-trigger" aria-expanded={reconciliationOpen} aria-controls="gifts-to-reconcile" onClick={() => setReconciliationOpen((open) => !open)}><span><b>À rapprocher</b><em>{unassignedBtc.toFixed(8)} BTC · {totalBtc ? Math.round(unassignedBtc / totalBtc * 100) : 0} %</em><small>{unassignedRecords.length} cadeau{unassignedRecords.length > 1 ? "x" : ""} à classer · voir le détail</small></span><i className="unassigned" role="progressbar" aria-label="Part à classer" aria-valuemin={0} aria-valuemax={100} aria-valuenow={totalBtc ? Math.round(unassignedBtc / totalBtc * 100) : 0} aria-valuetext={`${unassignedBtc.toFixed(8)} BTC à classer`}><b style={{ width: totalBtc ? `${unassignedBtc / totalBtc * 100}%` : "0%" }} /></i><strong aria-hidden="true">{reconciliationOpen ? "⌃" : "⌄"}</strong></button></div>}
          </div>
          {isAdmin && reconciliationOpen && unassignedRecords.length > 0 && <section id="gifts-to-reconcile" className="reconciliation-list" aria-label="Cadeaux à rapprocher"><header><div><small>À RAPPROCHER</small><h3>{unassignedRecords.length} cadeau{unassignedRecords.length > 1 ? "x" : ""} à classer</h3></div><span>{unassignedBtc.toFixed(8)} BTC</span></header><p>Choisissez où se trouvent ces bitcoins : Binance commun ou un virement Ledger. Vous pouvez vérifier et valider chaque ligne.</p><ul>{unassignedRecords.map((record) => <li key={keyOf(record)}><div><strong>{record.occasion} · {fullDate.format(new Date(record.gift_date + "T00:00:00Z"))}</strong><small>{euro.format(record.amount_eur)} · {Number(record.btc_amount).toFixed(8)} BTC</small></div><button type="button" onClick={() => startEntry(record)}>Classer / valider</button></li>)}</ul></section>}
          <details className="reveal">
            <summary>{isAdmin ? "Voir le détail et l’adresse publique" : "Comprendre où sont tes bitcoins"}</summary>
            <div className="reveal-content"><p>Les bitcoins sur Ledger sont conservés sur l’adresse publique de {selected}. Les données blockchain sont en lecture seule.</p><p>Les bitcoins sur Binance commun sont déjà attribués à {selected}, mais attendent encore leur transfert vers le Ledger.</p>{isAdmin && unassignedBtc > 0 && <p>Les bitcoins à rapprocher doivent encore être classés par Florent.</p>}{isAdmin && <div className="reveal-wallet"><small>SOLDE PUBLIC DE L’ADRESSE LEDGER</small><strong>{wallet?.confirmedBalanceBtc?.toFixed(8) ?? "—"} BTC</strong><span>{wallet?.confirmedBalanceBtc !== undefined && ledger?.bitcoinEur ? euro.format(wallet.confirmedBalanceBtc * ledger.bitcoinEur) : "Blockchain en lecture"}</span>{wallet?.explorerUrl && <a href={wallet.explorerUrl} target="_blank" rel="noreferrer">Voir sur Blockstream ↗</a>}</div>}</div>
          </details>
        </section>
        <section className="gift-stats" aria-label="Raccourcis du portefeuille"><button type="button" onClick={() => openTransactions("Cadeaux documentés de " + selected, "Tous", "documented")}><span>✓</span><div><strong>{recorded.length}</strong><small>cadeaux documentés</small></div><em>Voir →</em></button><button type="button" onClick={() => openTransactions("Actions à traiter pour " + selected, "À classer", "needs-action")}><span>!</span><div><strong>{missing}</strong><small>cadeaux passés à compléter</small></div><em>{missing > 0 ? "Traiter →" : "Vérifier →"}</em></button>{isAdmin ? <button type="button" onClick={() => openTransactions("Transactions Ledger de " + selected, "Ledger", "blockchain")}><span>↗</span><div><strong>{wallet?.transactions?.length ?? 0}</strong><small>transactions Ledger publiques</small></div><em>Voir →</em></button> : <button type="button" onClick={() => openTransactions("Bitcoins de " + selected + " sur Binance", "Binance", "gifts")}><span>→</span><div><strong>{binanceBtc.toFixed(8)} BTC</strong><small>encore sur Binance commun</small></div><em>Voir →</em></button>}</section>
      </div>

      <section className="portfolio-card gift-timeline-panel"><header className="card-head"><button type="button" className="timeline-shortcut" onClick={() => openTransactions("Histoire des cadeaux de " + selected, "Tous", "gifts")}><span><small>HISTORIQUE COMPLET</small><strong>Histoire des cadeaux</strong></span><em>Voir dans Transactions →</em></button></header>
        <div className="gift-years">{years.map((year, yearIndex) => <details key={year} className="gift-year" open={yearIndex === 0}><summary>{year}</summary><div>{records.filter((record) => record.gift_date.startsWith(year)).map((record) => {
          const isMissing = record.origin === "expected";
          const isFuture = isMissing && new Date(record.gift_date + "T23:59:59Z") >= new Date();
          const isLocked = locked(record);
          const displayCustody = !isAdmin && !isMissing && record.custody === "À rapprocher" && record.btc_amount > 0 ? "Binance commun" : record.custody;
          const custodyClass = isMissing ? "missing" : displayCustody === "Ledger" ? "ledger" : displayCustody === "Binance commun" ? "binance" : "missing";
          const custodyIcon = isMissing || displayCustody === "À rapprocher" ? "?" : displayCustody === "Ledger" ? "L" : "₿";
          const custodyTitle = isMissing ? (isFuture ? "À venir" : "À compléter") : displayCustody;
          const custodyDetail = !isAdmin ? (displayCustody === "Ledger" ? "Transfert déjà réalisé" : displayCustody === "Binance commun" ? (hasPendingTransfer(record) ? "Transfert demandé" : "Disponible sur demande") : "Florent vérifiera l’emplacement") : isLocked ? `${record.confirmations} confirmations` : record.custody === "À rapprocher" ? "Choisir Ledger ou Binance" : record.custody === "Ledger" ? "Déclaré sur Ledger" : "Sur le compte commun";
          const receivedLedgerBtc = record.custody === "Ledger" ? Number(record.ledger_amount ?? record.btc_amount) : record.btc_amount;
          const ledgerShortfall = record.custody === "Ledger" && receivedLedgerBtc < record.btc_amount - 0.00000001;
          const displayedEur = ledgerShortfall && record.btc_amount > 0 ? record.amount_eur * receivedLedgerBtc / record.btc_amount : record.amount_eur;
          const averageBtcPrice = Number(record.btc_amount) > 0 ? Number(record.amount_eur) / Number(record.btc_amount) : null;
          const ledgerShortfallExplanation = record.ledger_force_reason || record.note || "Écart documenté entre le montant acheté et le montant effectivement reçu sur le Ledger.";
          const displayedNote = portfolioNote(record.note);
          const recordKey = keyOf(record);
          return <article key={recordKey} className={`hist-item ${isMissing ? "missing" : ""}`}><div className={`occasion-icon ${record.occasion === "Noël" ? "christmas" : "birthday"}`}>{record.occasion === "Noël" ? "✦" : "♛"}</div><div className="gift-story"><span>{record.occasion.toUpperCase()} · {monthYear.format(new Date(record.gift_date + "T00:00:00Z"))}</span><strong>{record.occasion === "Noël" ? "Le cadeau de Noël d’Amatxi" : record.occasion === "Anniversaire" ? "Le cadeau d’anniversaire d’Amatxi" : "Le cadeau d’Amatxi"}</strong><small>{isMissing ? (isFuture ? `Prévu le ${fullDate.format(new Date(record.gift_date + "T00:00:00Z"))}` : "Achat ou quantité BTC à renseigner") : `Acheté le ${fullDate.format(new Date(record.purchase_date + "T00:00:00Z"))}`}</small>{displayedNote && !isMissing && <em>{displayedNote}</em>}</div><div className="gift-amount">{isMissing ? <><strong>55,00 €</strong><small>BTC à saisir</small></> : <><strong>{receivedLedgerBtc.toFixed(8)} BTC{ledgerShortfall && <button type="button" className="forced-ledger-marker" aria-label="Voir l’explication de l’écart Ledger" aria-expanded={expandedLedgerExplanation === recordKey} onClick={() => setExpandedLedgerExplanation((current) => current === recordKey ? null : recordKey)}>*</button>}</strong><small>{euro.format(displayedEur)} · {ledgerShortfall ? "reçu sur Ledger" : "frais inclus"}</small>{averageBtcPrice !== null && <small className="gift-btc-price">Prix moyen BTC : <b>{euro.format(averageBtcPrice)}</b></small>}{ledgerShortfall && expandedLedgerExplanation === recordKey && <p className="forced-ledger-explanation" role="note"><b>* Écart expliqué</b>{ledgerShortfallExplanation}</p>}</>}</div><div className={`custody-chip ${custodyClass}`}><b>{custodyIcon}</b><span><strong>{custodyTitle}</strong><small>{custodyDetail}</small></span></div>{isAdmin && <div className="gift-actions gift-actions-admin">{isLocked ? <button className="unlink" onClick={() => void unlinkLedger(record)}>Désassocier Ledger</button> : <><button onClick={() => startEntry(record)}>{record.origin === "database" ? "Modifier" : "Renseigner"}</button>{record.origin === "database" && <button className="delete" onClick={() => void remove(record)}>Supprimer</button>}</>}</div>}{!isAdmin && !previewReadOnly && !isMissing && displayCustody === "Binance commun" && <div className="gift-actions"><button onClick={() => void requestGiftTransfer(record)} disabled={hasPendingTransfer(record)}>{hasPendingTransfer(record) ? "Transfert demandé" : "Demander le transfert"}</button></div>}</article>;
        })}</div></details>)}</div>
      </section>
    </section>

    {isAdmin && <TransferWorkbench member={selected} wallet={wallet} giftRecords={databaseRecords} transferCostsBtc={transferCostsBtc} onSaved={async (text) => { setMessage(text); await load(); }} />}

    {isAdmin && <section className="panel chain-readonly"><header><div><span>LEDGER · DONNÉES NON MODIFIABLES</span><h2>Transactions visibles sur la blockchain</h2></div><b>🔒 Lecture seule</b></header>{wallet?.transactions?.length ? <div className="chain-list">{wallet.transactions.map((transaction) => <a key={transaction.txid} href={transaction.explorerUrl} target="_blank" rel="noreferrer"><span className={transaction.direction === "Reçu" ? "received" : "sent"}>{transaction.direction === "Reçu" ? "↓" : "↑"}</span><div><strong>{transaction.direction} · {transaction.amountBtc.toFixed(8)} BTC</strong><small>{transaction.date ? fullDate.format(new Date(transaction.date)) : "En attente"} · {transaction.confirmations} confirmations</small></div><code>{transaction.txid.slice(0, 10)}…{transaction.txid.slice(-8)}</code><b>↗</b></a>)}</div> : <div className="chain-empty">{loading ? "Lecture de la blockchain…" : "Aucune transaction publique trouvée pour ce Ledger."}</div>}</section>}

    {isAdmin && requests.length > 0 && <section className="panel gift-requests"><header><div><span>DEMANDES DES ENFANTS</span><h2>Transferts Binance vers Ledger</h2></div></header>{requests.map((item) => <article key={item.id}><div><strong>{item.member}</strong><small>{item.btcAmount?.toFixed(8) ?? "Montant à confirmer"} BTC · {item.requestedAt}</small></div><select value={item.status} onChange={(event) => onRequestStatus?.(item.id, event.target.value as TransferRequest["status"])}><option>Nouvelle</option><option>En traitement</option><option>Transférée</option></select></article>)}</section>}

    {editor && <GiftEditor record={editor} wallets={ledger?.wallets ?? []} giftRecords={databaseRecords} onClose={() => setEditor(null)} onSaved={async (text) => { setEditor(null); setMessage(text); await load(); }} />}
  </div>;
}

function TransferWorkbench({ member, wallet, giftRecords, transferCostsBtc, onSaved }: { member: string; wallet?: LedgerWallet; giftRecords: GiftRecord[]; transferCostsBtc: number; onSaved: (message: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const transferDialogRef = useDialogA11y(open, () => setOpen(false));
  const [selectedTxid, setSelectedTxid] = useState("");
  const [selectedGiftIds, setSelectedGiftIds] = useState<string[]>([]);
  const [forceReason, setForceReason] = useState("Frais de retrait Binance constatés lors du transfert groupé.");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");

  const transferable = useMemo(() => giftRecords
    .filter((gift) => gift.member_name === member && !gift.is_deleted && gift.custody === "Binance commun" && gift.id && gift.btc_amount > 0)
    .sort((left, right) => left.gift_date.localeCompare(right.gift_date)), [giftRecords, member]);
  const allocatedByTxid = useMemo(() => {
    const allocations = new Map<string, number>();
    for (const gift of giftRecords) {
      if (gift.is_deleted || !gift.txid || gift.member_name !== member) continue;
      allocations.set(gift.txid, (allocations.get(gift.txid) ?? 0) + Number(gift.ledger_amount ?? gift.btc_amount));
    }
    return allocations;
  }, [giftRecords, member]);
  const ledgerReceipts = useMemo(() => (wallet?.transactions ?? [])
    .filter((transaction) => transaction.direction === "Reçu")
    .map((transaction) => ({
      ...transaction,
      allocatedBtc: allocatedByTxid.get(transaction.txid) ?? 0,
      remainingBtc: Math.max(0, transaction.amountBtc - (allocatedByTxid.get(transaction.txid) ?? 0)),
    }))
    .sort((left, right) => (right.date ?? "").localeCompare(left.date ?? "")), [allocatedByTxid, wallet?.transactions]);
  const transactions = useMemo(() => ledgerReceipts
    .filter((transaction) => transaction.remainingBtc > 0.000000001), [ledgerReceipts]);
  const selectedTransaction = transactions.find((transaction) => transaction.txid === selectedTxid);
  const selectedGifts = transferable.filter((gift) => gift.id && selectedGiftIds.includes(gift.id));
  const debitedBtc = selectedGifts.reduce((sum, gift) => sum + gift.btc_amount, 0);
  const receivedBtc = Math.min(debitedBtc, selectedTransaction?.remainingBtc ?? 0);
  const differenceBtc = Math.max(0, debitedBtc - receivedBtc);
  const transactionRemainderBtc = Math.max(0, (selectedTransaction?.remainingBtc ?? 0) - debitedBtc);

  function start(transactionId = transactions[0]?.txid ?? "") {
    setSelectedGiftIds(transferable.flatMap((gift) => gift.id ? [gift.id] : []));
    setSelectedTxid(transactionId);
    setFeedback("");
    setOpen(true);
  }
  function toggleGift(id: string) {
    setSelectedGiftIds((current) => current.includes(id) ? current.filter((giftId) => giftId !== id) : [...current, id]);
  }
  async function saveTransfer() {
    if (!selectedTransaction || selectedGiftIds.length === 0) return;
    if (differenceBtc > 0.00000001 && forceReason.trim().length < 5) {
      setFeedback("Expliquez les frais ou l’écart avant de solder les cadeaux.");
      return;
    }
    if (!window.confirm(`Débiter ${debitedBtc.toFixed(8)} BTC du solde Binance de ${member} et attribuer ${receivedBtc.toFixed(8)} BTC au Ledger ?`)) return;
    setBusy(true);
    setFeedback("");
    try {
      const result = await request("/api/ledger-transfers", {
        method: "POST",
        body: JSON.stringify({
          member,
          txid: selectedTransaction.txid,
          publicAddress: wallet?.address,
          transferDate: selectedTransaction.date?.slice(0, 10) ?? new Date().toISOString().slice(0, 10),
          giftIds: selectedGiftIds,
          forceReason: differenceBtc > 0.00000001 ? forceReason : null,
        }),
      });
      setOpen(false);
      await onSaved(`${result.giftsUpdated} cadeau${result.giftsUpdated > 1 ? "x" : ""} soldé${result.giftsUpdated > 1 ? "s" : ""} sur Binance · ${Number(result.allocatedBtc).toFixed(8)} BTC rapprochés sur Ledger.`);
    } catch (caught) {
      setFeedback(caught instanceof Error ? caught.message : "Transfert impossible.");
    } finally {
      setBusy(false);
    }
  }

  const binanceBalance = transferable.reduce((sum, gift) => sum + gift.btc_amount, 0);
  return <section className="panel transfer-workbench admin-panel">
    <header className="transfer-workbench-head">
      <div className="transfer-workbench-copy"><span className="admin-tag">OUTIL ADMIN — VISIBLE PAR TOI SEUL</span><h2>Rapprochement Binance → Ledger</h2><p>Retrouvez ici toutes les réceptions du Ledger de {member}. Une réception peut couvrir plusieurs achats Binance et conserver un reliquat disponible.</p></div>
      <div className="transfer-workbench-metrics"><div><small>SOLDE À TRANSFÉRER</small><strong>{binanceBalance.toFixed(8)} BTC</strong><span>{transferable.length} achat{transferable.length > 1 ? "s" : ""} sur Binance</span></div><div><small>FRAIS HISTORIQUES</small><strong>{transferCostsBtc.toFixed(8)} BTC</strong><span>écarts documentés</span></div></div>
    </header>
    <section className="ledger-receipt-queue" aria-labelledby="ledger-receipt-title">
      <header><div><small>RÉCEPTIONS LEDGER</small><h3 id="ledger-receipt-title">Transactions disponibles pour le rapprochement</h3><p>Les transactions déjà attribuées restent visibles pour contrôle. Seul le solde encore disponible peut être rapproché.</p></div><span>{ledgerReceipts.length} réception{ledgerReceipts.length > 1 ? "s" : ""}</span></header>
      {ledgerReceipts.length ? <div className="ledger-receipt-list">{ledgerReceipts.map((transaction) => {
        const available = transaction.remainingBtc > 0.000000001;
        const canReconcile = available && transferable.length > 0;
        return <article key={transaction.txid} className={`ledger-receipt-row ${available ? "available" : "allocated"}`}>
          <span className="ledger-receipt-icon" aria-hidden="true">↓</span>
          <div className="ledger-receipt-identity"><strong>{transaction.date ? fullDate.format(new Date(transaction.date)) : "Date en attente"}</strong><small>{transaction.confirmations} confirmations · TxID {transaction.txid.slice(0, 10)}…{transaction.txid.slice(-6)}</small></div>
          <div className="ledger-receipt-value"><small>REÇU</small><strong>{transaction.amountBtc.toFixed(8)} BTC</strong></div>
          <div className="ledger-receipt-value"><small>DÉJÀ ATTRIBUÉ</small><strong>{transaction.allocatedBtc.toFixed(8)} BTC</strong></div>
          <div className="ledger-receipt-value remaining"><small>DISPONIBLE</small><strong>{transaction.remainingBtc.toFixed(8)} BTC</strong></div>
          <span className={`ledger-receipt-status ${available ? "open" : "done"}`}>{available ? "À rapprocher" : "Déjà attribuée"}</span>
          <button type="button" onClick={() => start(transaction.txid)} disabled={!canReconcile}>{!available ? "Soldée" : !transferable.length ? "Aucun achat" : "Rapprocher"}</button>
        </article>;
      })}</div> : <p className="ledger-receipt-empty">Aucune réception publique n’a été trouvée sur ce Ledger.</p>}
    </section>
    <footer className="transfer-workbench-footer"><p>{transactions.length} réception{transactions.length > 1 ? "s" : ""} avec un solde disponible · {transferable.length} achat{transferable.length > 1 ? "s" : ""} Binance à traiter.</p><button className="primary-button" onClick={() => start()} disabled={!transferable.length || !transactions.length}>{!transferable.length ? "Binance soldé" : !transactions.length ? "Aucun virement disponible" : "Préparer un rapprochement"}</button></footer>

    {open && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}><section ref={transferDialogRef} className="modal transfer-modal" role="dialog" aria-modal="true" aria-labelledby="transfer-title" tabIndex={-1}><header><div><span>RAPPROCHEMENT GROUPÉ</span><h2 id="transfer-title">Transférer le solde de {member}</h2><p>Une seule opération peut solder plusieurs achats Binance.</p></div><button onClick={() => setOpen(false)} aria-label="Fermer">×</button></header><div className="transfer-modal-body">
      <section className="transfer-step"><div className="transfer-step-title"><b>1</b><div><h3>Choisir la réception Ledger</h3><p>Le reliquat tient compte des cadeaux déjà associés au même TxID.</p></div></div><div className="transfer-transaction-list">{transactions.map((transaction) => <button type="button" key={transaction.txid} className={selectedTxid === transaction.txid ? "selected" : ""} onClick={() => setSelectedTxid(transaction.txid)}><span><strong>{transaction.date ? fullDate.format(new Date(transaction.date)) : "En attente"}</strong><small>{transaction.confirmations} confirmations · {transaction.txid.slice(0, 9)}…</small></span><span><strong>{transaction.amountBtc.toFixed(8)} BTC</strong><small>{transaction.remainingBtc.toFixed(8)} disponibles</small></span><em>{selectedTxid === transaction.txid ? "Sélectionné ✓" : "Choisir"}</em></button>)}</div></section>
      <section className="transfer-step"><div className="transfer-step-title"><b>2</b><div><h3>Débiter les achats Binance</h3><p>Tous les achats sont sélectionnés par défaut pour viser un solde Binance à zéro.</p></div></div><div className="transfer-gift-list">{transferable.map((gift) => <label key={gift.id} className={gift.id && selectedGiftIds.includes(gift.id) ? "selected" : ""}><input type="checkbox" checked={Boolean(gift.id && selectedGiftIds.includes(gift.id))} onChange={() => gift.id && toggleGift(gift.id)} /><span><strong>{gift.occasion} · {fullDate.format(new Date(gift.gift_date + "T00:00:00Z"))}</strong><small>{euro.format(gift.amount_eur)} investis</small></span><b>{gift.btc_amount.toFixed(8)} BTC</b></label>)}</div></section>
      <section className="transfer-step"><div className="transfer-step-title"><b>3</b><div><h3>Contrôler avant d’enregistrer</h3><p>Le serveur vérifiera encore le TxID, l’adresse et le montant reçu.</p></div></div><div className="transfer-summary"><div><small>DÉBIT BINANCE</small><strong>{debitedBtc.toFixed(8)} BTC</strong></div><div><small>CRÉDIT LEDGER</small><strong>{receivedBtc.toFixed(8)} BTC</strong></div><div className={differenceBtc > 0.00000001 ? "warning" : ""}><small>FRAIS / ÉCART</small><strong>{differenceBtc.toFixed(8)} BTC</strong></div><div><small>RELIQUAT DU VIREMENT</small><strong>{transactionRemainderBtc.toFixed(8)} BTC</strong></div></div>{differenceBtc > 0.00000001 && <label className="transfer-reason">Motif obligatoire<textarea value={forceReason} onChange={(event) => setForceReason(event.target.value)} placeholder="Ex. Frais de retrait Binance." /></label>}{transactionRemainderBtc > 0.00000001 && <p className="transfer-info">Il restera {transactionRemainderBtc.toFixed(8)} BTC sur ce virement, disponibles pour d’autres achats.</p>}</section>
      {feedback && <p className="editor-feedback">{feedback}</p>}
    </div><footer><button className="secondary-button" onClick={() => setOpen(false)}>Annuler</button><button className="primary-button" onClick={() => void saveTransfer()} disabled={busy || !selectedTransaction || selectedGiftIds.length === 0}>{busy ? "Vérification…" : "Enregistrer le transfert"}</button></footer></section></div>}
  </section>;
}
function GiftEditor({ record, wallets, giftRecords, onClose, onSaved }: { record: GiftRecord; wallets: LedgerWallet[]; giftRecords: GiftRecord[]; onClose: () => void; onSaved: (message: string) => Promise<void> }) {
  const [draft, setDraft] = useState({ member: record.member_name, occasion: record.occasion, giftDate: record.gift_date, purchaseDate: record.purchase_date || record.gift_date || new Date().toISOString().slice(0, 10), amountEur: String(record.amount_eur || 55), btcAmount: record.btc_amount ? String(record.btc_amount) : "", custody: record.custody, transferDate: record.transfer_date ?? "", ledgerAmount: record.ledger_amount ? String(record.ledger_amount) : "", forceLedgerAmount: Boolean(record.ledger_value_forced), forceReason: record.ledger_force_reason ?? "", publicAddress: record.public_address ?? addresses[record.member_name] ?? "", txid: record.txid ?? "", blockchainStatus: record.blockchain_status ?? "", confirmations: record.confirmations ?? 0, note: record.note ?? "" });
  const [busy, setBusy] = useState(false);
  const [verification, setVerification] = useState("");
  const dialogRef = useDialogA11y(true, onClose);
  function update(key: keyof typeof draft, value: string | number) { setDraft((current) => ({ ...current, [key]: value })); }
  function changeGiftDate(giftDate: string) { setDraft((current) => ({ ...current, giftDate, purchaseDate: giftDate })); }
  function changeMember(member: string) { setDraft((current) => ({ ...current, member, publicAddress: addresses[member] ?? "", txid: "", confirmations: 0, blockchainStatus: "" })); }

  const candidateWallet = wallets.find((wallet) => wallet.member === draft.member);
  const allocatedByTxid = useMemo(() => {
    const allocations = new Map<string, number>();
    for (const gift of giftRecords) {
      if (gift.is_deleted || !gift.txid || gift.id === record.id) continue;
      allocations.set(gift.txid, (allocations.get(gift.txid) ?? 0) + Number(gift.ledger_amount ?? gift.btc_amount ?? 0));
    }
    return allocations;
  }, [giftRecords, record.id]);
  const candidates = useMemo(() => (candidateWallet?.transactions ?? [])
    .filter((transaction) => transaction.direction === "Reçu")
    .map((transaction) => ({
      ...transaction,
      allocatedBtc: allocatedByTxid.get(transaction.txid) ?? 0,
      remainingBtc: Math.max(0, transaction.amountBtc - (allocatedByTxid.get(transaction.txid) ?? 0)),
    }))
    .sort((left, right) => (right.date ?? "").localeCompare(left.date ?? "")), [allocatedByTxid, candidateWallet?.transactions]);
  const availableCandidates = candidates.filter((transaction) => transaction.remainingBtc > 0.00000001);
  const selectedCandidate = candidates.find((transaction) => transaction.txid === draft.txid);
  function chooseCandidate(transaction: (typeof candidates)[number]) {
    if (transaction.remainingBtc <= 0.00000001) {
      setVerification("Ce virement est déjà entièrement attribué à d’autres cadeaux.");
      return;
    }
    const transferDate = transaction.date?.slice(0, 10) ?? draft.transferDate;
    setDraft((current) => ({
      ...current,
      publicAddress: candidateWallet?.address ?? current.publicAddress,
      txid: transaction.txid,
      transferDate,
      ledgerAmount: String(Math.min(Number(current.btcAmount || 0), transaction.remainingBtc)),
      forceLedgerAmount: Number(current.btcAmount || 0) > transaction.remainingBtc + 0.00000001,
      confirmations: 0,
      blockchainStatus: "Association manuelle à confirmer",
    }));
    const allocation = Math.min(Number(draft.btcAmount || 0), transaction.remainingBtc);
    const remainder = Math.max(0, transaction.remainingBtc - allocation);
    setVerification("Ce cadeau reçoit " + allocation.toFixed(8) + " BTC, soit sa quantité achetée. Il restera " + remainder.toFixed(8) + " BTC sur ce virement pour un autre cadeau.");
  }
  function forcePurchasedValue() {
    if (!selectedCandidate) { setVerification("Selectionnez d abord un virement Ledger."); return; }
    const purchasedBtc = Number(draft.btcAmount);
    const receivedBtc = selectedCandidate.remainingBtc;
    if (!Number.isFinite(purchasedBtc) || purchasedBtc <= 0) { setVerification("Renseignez d'abord la quantité BTC achetée."); return; }
    if (purchasedBtc <= receivedBtc + 0.00000001) { setVerification("Le rapprochement d’écart est réservé aux cas où la quantité achetée dépasse le reliquat disponible du virement Ledger."); return; }
    if (!window.confirm("Attention : " + purchasedBtc.toFixed(8) + " BTC achetés seront conservés malgré " + receivedBtc.toFixed(8) + " BTC reçus sur le Ledger. Continuer ?")) return;
    setDraft((current) => ({ ...current, ledgerAmount: String(receivedBtc), forceLedgerAmount: true }));
    setVerification("Forçage activé : la valeur achetée reste la référence du cadeau. Une explication est obligatoire avant l'enregistrement.");
  }
  async function verify() {
    if (!draft.publicAddress || !draft.txid) { setVerification("Sélectionnez une réception Ledger ou saisissez son TxID."); return; }
    setBusy(true);
    try {
      const result = await request("/api/blockchain/verify", { method: "POST", body: JSON.stringify({ address: draft.publicAddress, txid: draft.txid, expectedBtc: Number(draft.ledgerAmount || draft.btcAmount), allowGrouped: true }) });
      update("confirmations", result.confirmations ?? 0);
      update("blockchainStatus", result.verified ? "Validé sur la blockchain" : "À vérifier");
      setVerification(result.verified ? (result.groupedTransfer ? `✓ Association confirmée dans un virement groupé · ${result.confirmations} confirmations` : `✓ Transaction confirmée · ${result.confirmations} confirmations`) : "La part indiquée dépasse le montant reçu ou la transaction n'est pas encore confirmée.");
    } catch (error) { setVerification(error instanceof Error ? error.message : "Vérification impossible"); }
    finally { setBusy(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (draft.custody === "À rapprocher") { setVerification("Choisissez si ce cadeau est encore sur Binance commun ou déjà présent sur le Ledger."); return; }
    setBusy(true);
    try {
      const body = { id: record.origin === "database" ? record.id : undefined, ...draft, purchaseDate: draft.giftDate, amountEur: Number(draft.amountEur), btcAmount: Number(draft.btcAmount), ledgerAmount: draft.ledgerAmount ? Number(draft.ledgerAmount) : null };
      await request("/api/gifts", { method: body.id ? "PATCH" : "POST", body: JSON.stringify(body) });
      await onSaved(body.id ? "Cadeau modifié." : "Cadeau enregistré.");
    } catch (error) { setVerification(error instanceof Error ? error.message : "Enregistrement impossible"); }
    finally { setBusy(false); }
  }
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section ref={dialogRef} className="modal simple-gift-editor" role="dialog" aria-modal="true" aria-labelledby="gift-editor-title" tabIndex={-1}><header><div><span>REGISTRE DES CADEAUX D’AMATXI</span><h2 id="gift-editor-title">{record.origin === "database" ? "Modifier le cadeau" : "Renseigner le cadeau"}</h2><p>Tout est sur une seule page. Les champs Ledger seront verrouillés après confirmation blockchain.</p></div><button onClick={onClose} aria-label="Fermer">×</button></header><form onSubmit={submit}>
    <div className="editor-section"><h3>1 · Le cadeau</h3><div className="form-grid"><label>Enfant<select value={draft.member} onChange={(event) => changeMember(event.target.value)}>{people.map((person) => <option key={person.name}>{person.name}</option>)}</select></label><label>Occasion<select value={draft.occasion} onChange={(event) => update("occasion", event.target.value)}><option>Anniversaire</option><option>Noël</option><option>Autre cadeau</option></select></label><label>Date du cadeau<input type="date" required value={draft.giftDate} onChange={(event) => changeGiftDate(event.target.value)} /></label><label>Date d’achat<input type="date" required value={draft.giftDate} readOnly /></label></div></div>
    <div className="editor-section"><h3>2 · L’achat Bitcoin</h3><div className="form-grid"><label>Montant total, frais inclus (€)<input type="number" min="0" step="0.01" required value={draft.amountEur} onChange={(event) => update("amountEur", event.target.value)} /></label><label>BTC achetés<input type="number" min="0" step="any" required value={draft.btcAmount} onChange={(event) => setDraft((current) => ({ ...current, btcAmount: event.target.value, forceLedgerAmount: false }))} placeholder="0,00123456" /></label><label className="span-2">Commentaire<input value={draft.note} onChange={(event) => update("note", event.target.value)} placeholder="Information utile pour la famille" /></label></div></div>
    <div className="editor-section"><h3>3 · Où sont les bitcoins ?</h3><div className="simple-custody"><button type="button" className={draft.custody === "Binance commun" ? "active" : ""} onClick={() => update("custody", "Binance commun")}><b>₿</b><span><strong>Binance commun</strong><small>Attribués à l’enfant, en attente de transfert</small></span></button><button type="button" className={draft.custody === "Ledger" ? "active" : ""} onClick={() => update("custody", "Ledger")}><b>L</b><span><strong>Ledger personnel</strong><small>Associer manuellement à un virement blockchain</small></span></button></div>
      {draft.custody === "Ledger" && <div className="form-grid ledger-editor">
        <section className="ledger-matcher span-2"><header><div><span>ASSOCIATION MANUELLE</span><h4>Sélectionnez le virement Ledger</h4><p>Un virement peut regrouper plusieurs cadeaux. Les réceptions déjà entièrement attribuées restent visibles pour contrôle, mais ne peuvent plus être sélectionnées.</p></div><b>{availableCandidates.length} disponible{availableCandidates.length > 1 ? "s" : ""} · {candidates.length} réception{candidates.length > 1 ? "s" : ""}</b></header>
          {candidates.length > 0 ? <div className="ledger-candidates">{candidates.slice(0, 10).map((transaction) => { const isAvailable = transaction.remainingBtc > 0.00000001; const allocationForGift = Math.min(Number(draft.btcAmount || 0), transaction.remainingBtc); const remainderAfterGift = Math.max(0, transaction.remainingBtc - allocationForGift); return <button type="button" key={transaction.txid} disabled={!isAvailable} className={(draft.txid === transaction.txid ? "selected " : "") + (isAvailable ? "available" : "fully-allocated")} onClick={() => chooseCandidate(transaction)}><span><b>{transaction.date ? fullDate.format(new Date(transaction.date)) : "En attente"}</b><small>{transaction.confirmations} confirmations · TxID {transaction.txid.slice(0, 8)}…</small></span><strong>{transaction.amountBtc.toFixed(8)} BTC<small>{transaction.allocatedBtc.toFixed(8)} déjà associés · {isAvailable ? transaction.remainingBtc.toFixed(8) + " BTC disponibles" : "entièrement attribué"}</small>{isAvailable && <small className="candidate-allocation-preview">Pour ce cadeau : {allocationForGift.toFixed(8)} BTC · restera {remainderAfterGift.toFixed(8)} BTC</small>}</strong><em>{!isAvailable ? "Déjà attribué" : draft.txid === transaction.txid ? "Sélectionnée ✓" : "Associer"}</em></button>; })}</div> : <p className="ledger-no-match">Aucune réception publique n’a été trouvée sur cette adresse. Vous pouvez saisir le TxID manuellement ci-dessous.</p>}
          {draft.txid && <p className="allocation-help"><b>Part à attribuer à ce cadeau :</b> renseignez le champ ci-dessous. Le solde du virement pourra être affecté à d’autres cadeaux.</p>}{selectedCandidate && !draft.forceLedgerAmount && Number(draft.btcAmount) > selectedCandidate.remainingBtc + 0.00000001 && <button type="button" className="force-ledger-value" onClick={forcePurchasedValue}>Constater l’écart et solder ce cadeau</button>}{draft.forceLedgerAmount && <div className="force-ledger-alert"><strong>Forçage actif : la valeur achetée reste {Number(draft.btcAmount || 0).toFixed(8)} BTC</strong><span>Le Ledger n’a reçu que {Number(draft.ledgerAmount || 0).toFixed(8)} BTC.</span><label>Explication obligatoire<textarea value={draft.forceReason} onChange={(event) => update("forceReason", event.target.value)} required placeholder="Ex. Frais de retrait Binance prélevés lors du transfert." /></label></div>}
        </section>
        <label>Date du transfert<input type="date" value={draft.transferDate} onChange={(event) => update("transferDate", event.target.value)} /></label><label>BTC attribués à ce cadeau<input type="number" min="0" step="any" value={draft.ledgerAmount} onChange={(event) => update("ledgerAmount", event.target.value)} /></label><label className="span-2">Adresse Bitcoin publique<input value={draft.publicAddress} onChange={(event) => update("publicAddress", event.target.value)} /></label><details className="manual-txid span-2"><summary>Saisir ou vérifier le TxID manuellement</summary><label>TxID public<input value={draft.txid} onChange={(event) => update("txid", event.target.value)} /></label></details><button type="button" onClick={() => void verify()} disabled={busy}>{draft.txid ? "Confirmer le rapprochement" : "Vérifier sur la blockchain"}</button>
      </div>}
      {draft.custody === "Binance commun" && <p className="binance-note">Cette quantité restera comptabilisée pour {draft.member}, même si elle se trouve encore sur le compte Binance commun.</p>}
    </div>{verification && <p className="editor-feedback">{verification}</p>}<footer><button type="button" className="secondary-button" onClick={onClose}>Annuler</button><button className="primary-button" disabled={busy}>{busy ? "Enregistrement…" : record.origin === "database" ? "Enregistrer les modifications" : "Ajouter au registre"}</button></footer></form></section></div>;
}