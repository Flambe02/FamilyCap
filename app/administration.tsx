"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabaseBrowser } from "../lib/supabase-browser";
import { TransferRequest } from "./back-office";
import type { Viewer } from "../lib/auth-types";
import { GiftPortfolio } from "./gift-portfolio";
import { GIFT_HISTORY } from "../lib/gift-history";
import "./administration.css";

type Tab = "summary" | "gifts" | "members" | "accounts" | "settings";
type Member = { id:string; name:string; email?:string|null; role:string; access_status:string; is_active:boolean; auth_user_id?:string|null; auth?:{emailConfirmedAt?:string|null;lastSignInAt?:string|null;createdAt?:string;providers?:string[]}|null };
type Account = { id:string; member_id:string; name:string; account_type:string; institution?:string|null; currency:string; account_number_last4?:string|null; wallet_address?:string|null; network?:string|null };
type Holding = { id:string; account_id:string; asset_type:string; symbol?:string|null; isin?:string|null; name:string; quantity:number; average_cost?:number|null; currency:string; exchange?:string|null; last_price?:number|null; last_price_at?:string|null };
type MarketResult = { symbol:string; name:string; type:string; region:string; currency:string };

async function headers() {
  const session = (await supabaseBrowser.auth.getSession()).data.session;
  return { authorization: "Bearer " + (session?.access_token || ""), "content-type": "application/json" };
}
async function api(url:string, init:RequestInit = {}) {
  const response = await fetch(url, { ...init, headers: { ...(await headers()), ...init.headers } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Opération impossible");
  return result;
}
const formatDate = (value?:string|null) => value ? new Intl.DateTimeFormat("fr-FR", { dateStyle:"medium", timeStyle:"short" }).format(new Date(value)) : "Jamais";
const euro = new Intl.NumberFormat("fr-FR", { style:"currency", currency:"EUR" });

export function Administration({ viewer, requests, onRequestStatus }:{ viewer:Viewer; requests:TransferRequest[]; onRequestStatus:(id:string,status:TransferRequest["status"])=>void }) {
  const [tab,setTab] = useState<Tab>("summary");
  const tabs:{id:Tab;label:string;icon:string}[] = [
    {id:"summary",label:"Synthèse BTC",icon:"▦"},{id:"gifts",label:"Cadeaux BTC",icon:"₿"},{id:"members",label:"Membres & accès",icon:"◎"},
    {id:"accounts",label:"Comptes & positions",icon:"▥"},{id:"settings",label:"Réglages admin",icon:"⚙"}
  ];
  return <div className="admin-root">
    <section className="admin-command"><div><span>ZONE PRIVÉE · FLORENT UNIQUEMENT</span><h2>Administration familiale</h2><p>Gérer les accès, les comptes et les données financières sans stocker de mot de passe, clé privée ou phrase Ledger.</p></div><b>Administrateur vérifié</b></section>
    <nav className="admin-tabs">{tabs.map(item=><button key={item.id} className={tab===item.id?"active":""} onClick={()=>setTab(item.id)}><span>{item.icon}</span>{item.label}</button>)}</nav>
    {tab==="summary"&&<GiftSynthesis />}
    {tab==="gifts"&&<GiftPortfolio viewer={viewer} requests={requests} onRequestStatus={onRequestStatus} />}
    {tab==="members"&&<Members />}
    {tab==="accounts"&&<Accounts />}
    {tab==="settings"&&<Settings />}
  </div>;
}

type GiftSummaryRecord = {
  id?: string;
  member_name: string;
  occasion: string;
  gift_date: string;
  purchase_date?: string;
  amount_eur: number | string;
  btc_amount: number | string;
  custody: "Ledger" | "Binance commun" | "À rapprocher";
  ledger_amount?: number | string | null;
  ledger_value_forced?: boolean;
  ledger_force_reason?: string | null;
  txid?: string | null;
  note?: string | null;
  is_deleted?: boolean;
};
type LedgerTransaction = { txid: string; date?: string | null; amountBtc?: number; receivedBtc?: number; sentBtc?: number; direction?: string; confirmed?: boolean; confirmations?: number; explorerUrl?: string };
type LedgerWallet = { member: string; address?: string; confirmedBalanceBtc?: number; explorerUrl?: string; transactions?: LedgerTransaction[]; error?: string };
type LedgerSummary = { wallets?: LedgerWallet[]; bitcoinEur?: number | null; bitcoinEurSource?: string | null; updatedAt?: string };
type GiftPeriod = { date: string; occasion: "Anniversaire" | "Noël"; member?: string };
type SummaryDraft = {
  key: string;
  id?: string;
  member: string;
  occasion: "Anniversaire" | "Noël";
  giftDate: string;
  amountEur: string;
  btcAmount: string;
  note: string;
};
type DeliveryState = { date: string; tone: "ledger" | "binance" | "missing"; label: string; detail: string; offered: boolean };

const giftSummaryMembers = [
  { name: "Thibault", initials: "TH", birthday: "15 mars" },
  { name: "Uhaina", initials: "UH", birthday: "16 août" },
  { name: "Paul", initials: "PA", birthday: "18 novembre" },
  { name: "Aurore", initials: "AU", birthday: "27 août" },
  { name: "Thomas", initials: "TO", birthday: "29 décembre" },
] as const;
const birthdayDates: Record<(typeof giftSummaryMembers)[number]["name"], string> = {
  Thibault: "03-15", Uhaina: "08-16", Paul: "11-18", Aurore: "08-27", Thomas: "12-29",
};
const btc = (value: number) => `${value.toFixed(8)} BTC`;
const summaryDate = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" });
const summaryKey = (member: string, occasion: string, date: string) => `${member}:${occasion}:${date}`;
const isLedgerAssociated = (gift: GiftSummaryRecord) => gift.custody === "Ledger" || Boolean(gift.txid && Number(gift.ledger_amount ?? 0) > 0);

function GiftSynthesis() {
  const [stored,setStored] = useState<GiftSummaryRecord[]>([]);
  const [ledger,setLedger] = useState<LedgerSummary | null>(null);
  const [message,setMessage] = useState("");
  const [draft,setDraft] = useState<SummaryDraft | null>(null);
  const [busy,setBusy] = useState(false);
  const [selectedYear,setSelectedYear] = useState(() => new Date().getFullYear());
  const matrixRef = useRef<HTMLDivElement>(null);
  const today = new Date().toISOString().slice(0,10);
  const currentYear = new Date().getFullYear();

  const load = useCallback(async () => {
    const [gifts, wallets] = await Promise.all([api("/api/gifts"), api("/api/ledger")]);
    setStored((gifts.records ?? []).map((gift: GiftSummaryRecord) => ({ ...gift, amount_eur: Number(gift.amount_eur), btc_amount: Number(gift.btc_amount), ledger_amount: gift.ledger_amount === null || gift.ledger_amount === undefined ? null : Number(gift.ledger_amount), is_deleted: Boolean(gift.is_deleted) })));
    setLedger(wallets);
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => { void load().catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Synthèse indisponible.")); }, 0); return () => window.clearTimeout(timer); }, [load]);

  const records = useMemo(() => {
    const storedByKey = new Map<string, GiftSummaryRecord>();
    for (const gift of stored) {
      const key = summaryKey(gift.member_name, gift.occasion, gift.gift_date);
      const current = storedByKey.get(key);
      if (!current || (current.is_deleted && !gift.is_deleted)) storedByKey.set(key, gift);
    }
    const history = GIFT_HISTORY.flatMap((gift) => {
      const saved = storedByKey.get(summaryKey(gift.member, gift.occasion, gift.giftDate));
      if (saved?.is_deleted) return [];
      return [saved ? { ...saved, member_name: gift.member, occasion: gift.occasion, gift_date: gift.giftDate, purchase_date: saved.purchase_date || gift.purchaseDate, amount_eur: saved.amount_eur, btc_amount: saved.btc_amount, note: saved.note ?? gift.note } : {
        member_name: gift.member, occasion: gift.occasion, gift_date: gift.giftDate, purchase_date: gift.purchaseDate, amount_eur: gift.amountEur, btc_amount: gift.btcAmount, custody: "Binance commun" as const, note: gift.note,
      }];
    });
    const historicalKeys = new Set(GIFT_HISTORY.map((gift) => summaryKey(gift.member, gift.occasion, gift.giftDate)));
    return [...history, ...stored.filter((gift) => !historicalKeys.has(summaryKey(gift.member_name, gift.occasion, gift.gift_date)) && !gift.is_deleted)];
  }, [stored]);

  const periods = useMemo(() => {
    const unique = new Map<string, GiftPeriod>();
    for (const gift of GIFT_HISTORY) unique.set(`${gift.occasion}:${gift.giftDate}:${gift.occasion === "Anniversaire" ? gift.member : "all"}`, { date: gift.giftDate, occasion: gift.occasion, member: gift.occasion === "Anniversaire" ? gift.member : undefined });
    for (const member of giftSummaryMembers) {
      const date = `${currentYear}-${birthdayDates[member.name]}`;
      unique.set(`Anniversaire:${date}:${member.name}`, { date, occasion: "Anniversaire", member: member.name });
    }
    unique.set(`Noël:${currentYear}-12-25:all`, { date: `${currentYear}-12-25`, occasion: "Noël" });
    return [...unique.values()].sort((left,right) => left.date.localeCompare(right.date));
  }, [currentYear]);
  const availableYears = useMemo(() => [...new Set(periods.map((period) => Number(period.date.slice(0, 4))))].filter(Number.isFinite).sort((left, right) => right - left), [periods]);
  const activeYear = availableYears.includes(selectedYear) ? selectedYear : (availableYears[0] ?? currentYear);
  const yearPeriods = useMemo(() => periods.filter((period) => Number(period.date.slice(0, 4)) === activeYear), [activeYear, periods]);
  const yearRecords = useMemo(() => records.filter((gift) => Number(gift.gift_date.slice(0, 4)) === activeYear), [activeYear, records]);
  const yearRows = useMemo(() => giftSummaryMembers.map((member) => { const gifts = yearRecords.filter((gift) => gift.member_name === member.name); const ledgerGifts = gifts.filter(isLedgerAssociated); const binanceGifts = gifts.filter((gift) => !isLedgerAssociated(gift) && gift.custody === "Binance commun"); const pendingGifts = gifts.filter((gift) => !isLedgerAssociated(gift) && gift.custody === "À rapprocher"); const actual = (gift: GiftSummaryRecord) => Number(isLedgerAssociated(gift) ? gift.ledger_amount ?? gift.btc_amount : gift.btc_amount); return { ...member, gifts: gifts.length, ledger: ledgerGifts.length, binance: binanceGifts.length, pending: pendingGifts.length, btc: gifts.reduce((sum, gift) => sum + actual(gift), 0), eur: gifts.reduce((sum, gift) => sum + Number(gift.amount_eur), 0) }; }), [yearRecords]);
  const yearTotal = useMemo(() => yearRows.reduce((totalRow, row) => ({ gifts: totalRow.gifts + row.gifts, ledger: totalRow.ledger + row.ledger, binance: totalRow.binance + row.binance, pending: totalRow.pending + row.pending, btc: totalRow.btc + row.btc, eur: totalRow.eur + row.eur }), { gifts: 0, ledger: 0, binance: 0, pending: 0, btc: 0, eur: 0 }), [yearRows]);

  const rows = useMemo(() => giftSummaryMembers.map((member) => {
    const gifts = records.filter((gift) => gift.member_name === member.name);
    const ledgerGifts = gifts.filter(isLedgerAssociated);
    const binanceGifts = gifts.filter((gift) => !isLedgerAssociated(gift) && gift.custody === "Binance commun");
    const binanceChristmasGifts = binanceGifts.filter((gift) => gift.occasion === "Noël");
    const binanceBirthdayGifts = binanceGifts.filter((gift) => gift.occasion === "Anniversaire");
    const pendingGifts = gifts.filter((gift) => !isLedgerAssociated(gift) && gift.custody === "À rapprocher");
    const actual = (gift: GiftSummaryRecord) => Number(isLedgerAssociated(gift) ? gift.ledger_amount ?? gift.btc_amount : gift.btc_amount);
    const attributedEur = (gift: GiftSummaryRecord) => Number(gift.amount_eur) * (actual(gift) / Number(gift.btc_amount || 1));
    const ledgerBtc = ledgerGifts.reduce((sum,gift) => sum + actual(gift),0);
    const ledgerExpectedBtc = ledgerGifts.reduce((sum,gift) => sum + Number(gift.btc_amount),0);
    const binanceBtc = binanceGifts.reduce((sum,gift) => sum + Number(gift.btc_amount),0);
    const pendingBtc = pendingGifts.reduce((sum,gift) => sum + Number(gift.btc_amount),0);
    const offeredBtc = gifts.reduce((sum,gift) => sum + Number(gift.btc_amount),0);
    const inCustodyBtc = ledgerBtc + binanceBtc + pendingBtc;
    const ledgerGapBtc = ledgerExpectedBtc - ledgerBtc;
    const actualWallet = Number(ledger?.wallets?.find((wallet) => wallet.member === member.name)?.confirmedBalanceBtc ?? 0);
    return { ...member, ledgerBtc, binanceBtc, pendingBtc, offeredBtc, inCustodyBtc, ledgerGapBtc, binanceChristmasGifts, binanceBirthdayGifts, ledgerChristmasGifts: ledgerGifts.filter((gift) => gift.occasion === "No\u00ebl"), ledgerBirthdayGifts: ledgerGifts.filter((gift) => gift.occasion === "Anniversaire"), ledgerEur: ledgerGifts.reduce((sum,gift) => sum + attributedEur(gift),0), binanceEur: binanceGifts.reduce((sum,gift) => sum + Number(gift.amount_eur),0), pendingEur: pendingGifts.reduce((sum,gift) => sum + Number(gift.amount_eur),0), actualWallet, variance: actualWallet - ledgerBtc };
  }), [ledger?.wallets, records]);
  const total = rows.reduce((acc,row) => ({
    ledgerBtc: acc.ledgerBtc + row.ledgerBtc,
    binanceBtc: acc.binanceBtc + row.binanceBtc,
    pendingBtc: acc.pendingBtc + row.pendingBtc,
    offeredBtc: acc.offeredBtc + row.offeredBtc,
    inCustodyBtc: acc.inCustodyBtc + row.inCustodyBtc,
    ledgerGapBtc: acc.ledgerGapBtc + row.ledgerGapBtc,
    ledgerEur: acc.ledgerEur + row.ledgerEur,
    binanceEur: acc.binanceEur + row.binanceEur,
    pendingEur: acc.pendingEur + row.pendingEur,
    wallet: acc.wallet + row.actualWallet,
    variance: acc.variance + row.variance,
  }), { ledgerBtc:0,binanceBtc:0,pendingBtc:0,offeredBtc:0,inCustodyBtc:0,ledgerGapBtc:0,ledgerEur:0,binanceEur:0,pendingEur:0,wallet:0,variance:0 });
  const documented = records.filter((gift) => gift.id).length;
  const pendingCount = records.filter((gift) => gift.custody === "À rapprocher").length;
  const onLedgerPercent = total.ledgerBtc + total.binanceBtc + total.pendingBtc ? total.ledgerBtc / (total.ledgerBtc + total.binanceBtc + total.pendingBtc) * 100 : 0;
  const sharedChristmasYears = rows[0]?.binanceChristmasGifts.map((gift) => gift.gift_date.slice(0, 4)).sort() ?? [];
  const sharedChristmasEur = rows[0]?.binanceChristmasGifts.reduce((sum, gift) => sum + Number(gift.amount_eur), 0) ?? 0;
  const uniformChristmas = sharedChristmasYears.length > 0 && rows.every((row) => {
    const years = row.binanceChristmasGifts.map((gift) => gift.gift_date.slice(0, 4)).sort();
    const invested = row.binanceChristmasGifts.reduce((sum, gift) => sum + Number(gift.amount_eur), 0);
    return years.join(",") === sharedChristmasYears.join(",") && Math.abs(invested - sharedChristmasEur) < 0.01;
  });

  const bitcoinEur = Number(ledger?.bitcoinEur ?? 0);
  const bitcoinEurSource = ledger?.bitcoinEurSource ?? "Source publique";
  const quoteUpdatedAt = ledger?.updatedAt ? new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(ledger.updatedAt)) : null;
  const valuations = rows.map((row) => {
    const attributedBtc = row.ledgerBtc + row.binanceBtc + row.pendingBtc;
    const investedEur = row.ledgerEur + row.binanceEur + row.pendingEur;
    const currentValue = bitcoinEur > 0 ? attributedBtc * bitcoinEur : null;
    const gainEur = currentValue === null ? null : currentValue - investedEur;
    const gainPercent = gainEur === null || investedEur <= 0 ? null : gainEur / investedEur * 100;
    return { ...row, attributedBtc, investedEur, currentValue, gainEur, gainPercent };
  });
  const totalAttributedBtc = total.inCustodyBtc;
  const totalInvestedEur = total.ledgerEur + total.binanceEur + total.pendingEur;
  const totalMarketValue = bitcoinEur > 0 ? totalAttributedBtc * bitcoinEur : null;
  const totalGainEur = totalMarketValue === null ? null : totalMarketValue - totalInvestedEur;
  const ledgerActivity = giftSummaryMembers.map((member) => {
    const row = rows.find((item) => item.name === member.name);
    const wallet = ledger?.wallets?.find((item) => item.member === member.name);
    const allocationsByTxid = new Map<string, number>();
    for (const gift of records) {
      if (gift.member_name !== member.name || !isLedgerAssociated(gift) || !gift.txid) continue;
      const txid = gift.txid.toLowerCase();
      allocationsByTxid.set(txid, (allocationsByTxid.get(txid) ?? 0) + Number(gift.ledger_amount ?? gift.btc_amount));
    }
    const transactions = (wallet?.transactions ?? []).map((transaction) => {
      const isReceipt = transaction.direction === "Reçu";
      const receivedBtc = isReceipt ? Number(transaction.receivedBtc ?? transaction.amountBtc ?? 0) : 0;
      const allocatedBtc = isReceipt ? allocationsByTxid.get(transaction.txid.toLowerCase()) ?? 0 : 0;
      const remainingBtc = isReceipt ? Math.max(0, receivedBtc - allocatedBtc) : 0;
      const allocationState = !isReceipt ? "Sortie" : allocatedBtc <= 0.00000001 ? "À attribuer" : remainingBtc > 0.00000001 ? "Partiellement attribuée" : "Entièrement attribuée";
      const allocationTone = !isReceipt ? "sent" : allocatedBtc <= 0.00000001 ? "unallocated" : remainingBtc > 0.00000001 ? "partial" : "allocated";
      return { ...transaction, receivedBtc, allocatedBtc, remainingBtc, allocationState, allocationTone, shortTxid: `${transaction.txid.slice(0, 8)}…${transaction.txid.slice(-6)}`, explorerUrl: transaction.explorerUrl ?? `https://blockstream.info/tx/${transaction.txid}` };
    });
    const receivedBtc = transactions.reduce((sum, transaction) => sum + transaction.receivedBtc, 0);
    const allocatedBtc = row?.ledgerBtc ?? 0;
    return { ...member, wallet, transactions, receivedBtc, allocatedBtc, unallocatedBtc: Math.max(0, receivedBtc - allocatedBtc) };
  });
  const ledgerActivityTotal = ledgerActivity.reduce((summary, wallet) => ({
    receivedBtc: summary.receivedBtc + wallet.receivedBtc,
    allocatedBtc: summary.allocatedBtc + wallet.allocatedBtc,
    unallocatedBtc: summary.unallocatedBtc + wallet.unallocatedBtc,
    receipts: summary.receipts + wallet.transactions.filter((transaction) => transaction.receivedBtc > 0).length,
  }), { receivedBtc: 0, allocatedBtc: 0, unallocatedBtc: 0, receipts: 0 });
  function delivery(member: (typeof giftSummaryMembers)[number], occasion: "Anniversaire" | "Noël"): DeliveryState {
    const date = occasion === "Noël"
      ? `${today >= `${currentYear}-12-25` ? currentYear : currentYear - 1}-12-25`
      : `${today >= `${currentYear}-${birthdayDates[member.name]}` ? currentYear : currentYear - 1}-${birthdayDates[member.name]}`;
    const gift = records.find((item) => item.member_name === member.name && item.occasion === occasion && item.gift_date === date);
    const dateLabel = summaryDate.format(new Date(date + "T00:00:00Z"));
    if (!gift) return { date, tone: "missing", label: "Non offert", detail: `${occasion} du ${dateLabel} · achat Binance non visible`, offered: false };
    if (isLedgerAssociated(gift)) return { date, tone: "ledger", label: "Offert · Ledger", detail: `${euro.format(Number(gift.amount_eur))} · acheté puis transféré`, offered: true };
    if (gift.custody === "Binance commun") return { date, tone: "binance", label: "Offert · Binance", detail: `${euro.format(Number(gift.amount_eur))} · achat enregistré, transfert à faire`, offered: true };
    return { date, tone: "missing", label: "Non offert", detail: `${occasion} du ${dateLabel} · achat Binance à confirmer`, offered: false };
  }

  function startEdit(member: (typeof giftSummaryMembers)[number], period: GiftPeriod, gift?: GiftSummaryRecord) {
    if (gift && isLedgerAssociated(gift)) return;
    const tombstone = stored.find((record) => record.is_deleted && summaryKey(record.member_name, record.occasion, record.gift_date) === summaryKey(member.name, period.occasion, period.date));
    setDraft({ key: `${member.name}-${period.occasion}-${period.date}`, id: gift?.id ?? tombstone?.id, member: member.name, occasion: period.occasion, giftDate: period.date, amountEur: String(Number(gift?.amount_eur ?? tombstone?.amount_eur ?? 55)), btcAmount: gift?.btc_amount ? String(gift.btc_amount) : tombstone?.btc_amount ? String(tombstone.btc_amount) : "", note: gift?.note ?? tombstone?.note ?? "" });
    setMessage("");
  }
  function updateDraft(field: "amountEur" | "btcAmount" | "note", value: string) { setDraft((current) => current ? { ...current, [field]: value } : current); }
  async function saveDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    const amountEur = Number(draft.amountEur);
    const btcAmount = Number(draft.btcAmount);
    if (!Number.isFinite(amountEur) || amountEur <= 0 || !Number.isFinite(btcAmount) || btcAmount <= 0) { setMessage("Renseignez un montant en euros et une quantité BTC supérieurs à zéro."); return; }
    setBusy(true);
    try {
      const body = { id: draft.id, member: draft.member, occasion: draft.occasion, giftDate: draft.giftDate, purchaseDate: draft.giftDate, amountEur, btcAmount, custody: "Binance commun", note: draft.note };
      await api("/api/gifts", { method: draft.id ? "PATCH" : "POST", body: JSON.stringify(body) });
      setMessage(draft.id ? "Cadeau mis à jour dans le registre." : "Cadeau ajouté au registre Binance." );
      setDraft(null);
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Enregistrement impossible."); }
    finally { setBusy(false); }
  }
  async function deleteDraft() {
    if (!draft?.id || !window.confirm("Supprimer ce cadeau du registre ? Les cadeaux Ledger restent protégés.")) return;
    setBusy(true);
    try {
      await api("/api/gifts?id=" + encodeURIComponent(draft.id), { method: "DELETE" });
      setMessage("Cadeau supprimé du suivi.");
      setDraft(null);
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Suppression impossible."); }
    finally { setBusy(false); }
  }

  function changeYear(direction: number) {
    const index = availableYears.indexOf(activeYear);
    const next = availableYears[Math.min(Math.max(index + direction, 0), availableYears.length - 1)];
    if (next) setSelectedYear(next);
  }
  function scrollMatrix(direction: number) {
    matrixRef.current?.scrollBy({ left: direction * 520, behavior: "smooth" });
  }

  function cell(member: (typeof giftSummaryMembers)[number], period: GiftPeriod) {
    const cellKey = `${member.name}-${period.occasion}-${period.date}`;
    if (period.occasion === "Anniversaire" && period.member !== member.name) return <td key={cellKey} className="summary-matrix-empty" aria-label="Non concerné">—</td>;
    const gift = records.find((item) => item.member_name === member.name && item.occasion === period.occasion && item.gift_date === period.date);
    const isEditing = draft?.key === cellKey;
    if (isEditing && draft) return <td key={cellKey} className="summary-cell summary-cell-editing"><form className="summary-inline-editor" onSubmit={(event) => void saveDraft(event)}><label><span>€</span><input aria-label="Montant en euros" type="number" min="0" step="0.01" value={draft.amountEur} onChange={(event) => updateDraft("amountEur", event.target.value)} /></label><label><span>BTC</span><input aria-label="Quantité BTC" type="number" min="0" step="any" value={draft.btcAmount} onChange={(event) => updateDraft("btcAmount", event.target.value)} /></label><input aria-label="Note" value={draft.note} onChange={(event) => updateDraft("note", event.target.value)} placeholder="Note facultative" /><div><button type="submit" disabled={busy}>{busy ? "…" : "Enregistrer"}</button><button type="button" className="quiet" onClick={() => setDraft(null)} disabled={busy}>Annuler</button>{draft.id && <button type="button" className="delete" onClick={() => void deleteDraft()} disabled={busy}>Supprimer</button>}</div></form></td>;
    if (!gift) {
      const future = period.date > today;
      return <td key={cellKey} className={`summary-cell ${future ? "future" : "missing"} editable`}><button type="button" className="summary-cell-trigger" onClick={() => startEdit(member, period)}><b>{future ? "À venir" : "Non offert"}</b><small>{future ? summaryDate.format(new Date(period.date + "T00:00:00Z")) : "À enregistrer"}</small><em>{future ? "Préparer" : "Ajouter"}</em></button></td>;
    }
    const ledgerAssociated = isLedgerAssociated(gift);
    const receivedBtc = Number(ledgerAssociated ? gift.ledger_amount ?? gift.btc_amount : gift.btc_amount);
    const hasGap = ledgerAssociated && receivedBtc < Number(gift.btc_amount) - 0.00000001;
    const shownEur = hasGap ? Number(gift.amount_eur) * receivedBtc / Number(gift.btc_amount) : Number(gift.amount_eur);
    const tone = ledgerAssociated ? "ledger" : gift.custody === "Binance commun" ? "binance" : "missing";
    const status = gift.custody === "Binance commun" ? "⌛ Sur Binance" : "! À classer";
    const explanation = gift.ledger_force_reason || gift.note || "Écart entre la quantité achetée et la quantité reçue.";
    if (ledgerAssociated) return <td key={cellKey} className={`summary-cell ${tone}`}><b>{euro.format(shownEur)} · {btc(receivedBtc)}{hasGap && <span className="summary-gap" title={explanation}>*</span>}</b><small className="ledger-association"><span aria-hidden="true">⚑</span> Ledger associé · verrouillé</small></td>;
    return <td key={cellKey} className={`summary-cell ${tone} editable`}><button type="button" className="summary-cell-trigger" onClick={() => startEdit(member, period, gift)}><b>{euro.format(shownEur)} · {btc(receivedBtc)}</b><small>{status}</small><em>Modifier</em></button></td>;
  }

  return <div className="gift-synthesis">
    <section className="panel synthesis-head"><div><span>SUIVI OPÉRATIONNEL · VUE ADMIN</span><h2>Anniversaires & Noël, enfant par enfant</h2><p>Un cadeau est offert uniquement lorsqu’un achat est identifié sur Binance, qu’il y soit encore ou qu’il ait déjà été transféré sur Ledger. « À classer » ne compte pas comme offert.</p></div><button className="secondary-button" onClick={() => void load()}>↻ Actualiser</button></section>
    {message && <p className="admin-feedback">{message}</p>}
    <section className="synthesis-kpis" aria-label="Indicateurs de suivi"><article><span>✓</span><div><small>CADEAUX DOCUMENTÉS</small><strong>{documented}</strong></div></article><article><span>⌛</span><div><small>À TRANSFÉRER VERS LEDGER</small><strong>{btc(total.binanceBtc)}</strong><em>{euro.format(total.binanceEur)}</em></div></article><article><span>!</span><div><small>À CLASSER</small><strong>{pendingCount}</strong><em>{btc(total.pendingBtc)}</em></div></article><article><span>↗</span><div><small>PART DÉJÀ SUR LEDGER</small><strong>{onLedgerPercent.toFixed(0)} %</strong><em>{btc(total.ledgerBtc)}</em></div></article></section>
    <section className="panel transfer-plan">
      <header><div><span>PLAN DE TRANSFERT</span><h2>Ce qu’il reste à envoyer sur chaque Ledger</h2><p>Ces montants sont déjà achetés et attribués à chaque enfant, mais restent sur le Binance commun.</p></div><div className="transfer-plan-total"><small>TOTAL À TRANSFÉRER</small><strong>{btc(total.binanceBtc)}</strong><span>{euro.format(total.binanceEur)}</span></div></header>
      {uniformChristmas && <aside className="transfer-plan-explanation"><span aria-hidden="true">🎄</span><div><strong>La base Noël est identique pour tous</strong><p>{sharedChristmasYears.length} Noëls ({sharedChristmasYears.join(", ")}) représentent {euro.format(sharedChristmasEur)} par enfant. Les différences viennent donc des anniversaires encore conservés sur Binance.</p></div></aside>}
      <div className="transfer-plan-grid">{rows.map((row) => {
        const toTransfer = row.binanceBtc > 0.00000001;
        const christmasEur = row.binanceChristmasGifts.reduce((sum, gift) => sum + Number(gift.amount_eur), 0);
        const birthdayEur = row.binanceBirthdayGifts.reduce((sum, gift) => sum + Number(gift.amount_eur), 0);
        const christmasYears = row.binanceChristmasGifts.map((gift) => gift.gift_date.slice(0, 4)).sort();
        const birthdayYears = row.binanceBirthdayGifts.map((gift) => gift.gift_date.slice(0, 4)).sort();
        const giftCount = row.binanceChristmasGifts.length + row.binanceBirthdayGifts.length;
        const ledgerChristmasEur = row.ledgerChristmasGifts.reduce((sum, gift) => sum + Number(gift.amount_eur) * (Number(gift.ledger_amount ?? gift.btc_amount) / Number(gift.btc_amount || 1)), 0);
        const ledgerBirthdayEur = row.ledgerBirthdayGifts.reduce((sum, gift) => sum + Number(gift.amount_eur) * (Number(gift.ledger_amount ?? gift.btc_amount) / Number(gift.btc_amount || 1)), 0);
        const ledgerChristmasYears = row.ledgerChristmasGifts.map((gift) => gift.gift_date.slice(0, 4)).sort();
        const ledgerBirthdayYears = row.ledgerBirthdayGifts.map((gift) => gift.gift_date.slice(0, 4)).sort();
        const ledgerGiftCount = row.ledgerChristmasGifts.length + row.ledgerBirthdayGifts.length;
        return <article key={row.name} className={toTransfer ? "ready" : "complete"}>
          <span className="transfer-plan-avatar">{row.initials}</span>
          <div><strong>{row.name}</strong><small>{toTransfer ? `${giftCount} cadeau${giftCount > 1 ? "x" : ""} acheté${giftCount > 1 ? "s" : ""}, en attente de transfert` : "Aucun bitcoin à transférer"}</small></div>
          <div className="transfer-plan-amount"><b>{btc(row.binanceBtc)}</b><small>{euro.format(row.binanceEur)} investis</small></div>
          {toTransfer && <div className="transfer-plan-breakdown" aria-label={`Détail des cadeaux de ${row.name}`}>
            <div><span aria-hidden="true">🎄</span><p><b>Noël</b><small>{christmasYears.length ? christmasYears.join(", ") : "Aucun"}</small></p><strong>{euro.format(christmasEur)}</strong></div>
            <div><span aria-hidden="true">🎂</span><p><b>Anniversaires</b><small>{birthdayYears.length ? birthdayYears.join(", ") : "Aucun en attente"}</small></p><strong>{euro.format(birthdayEur)}</strong></div>
          </div>}
          {ledgerGiftCount > 0 && <div className="transfer-plan-ledger-breakdown" aria-label={"Cadeaux de " + row.name + " d\u00e9j\u00e0 sur Ledger"}><header><strong>D\u00e9j\u00e0 sur Ledger</strong><span>{btc(row.ledgerBtc)}</span></header><div><span aria-hidden="true">&#127876;</span><p><b>No\u00ebl</b><small>{ledgerChristmasYears.length ? ledgerChristmasYears.join(", ") : "Aucun"}</small></p><strong>{euro.format(ledgerChristmasEur)}</strong></div><div><span aria-hidden="true">&#127874;</span><p><b>Anniversaires</b><small>{ledgerBirthdayYears.length ? ledgerBirthdayYears.join(", ") : "Aucun"}</small></p><strong>{euro.format(ledgerBirthdayEur)}</strong></div></div>}
          <em>{toTransfer ? "À transférer" : "À jour"}</em>
        </article>;
      })}</div>
      <footer><span>Les montants « À classer » ne sont pas inclus : leur localisation doit d’abord être confirmée.</span><span>Un même virement Ledger peut regrouper plusieurs cadeaux d’un enfant.</span></footer>
    </section>    <section className="panel valuation-panel">
      <header>
        <div><span>VALORISATION INDICATIVE</span><h2>Valeur actuelle et plus-value théorique</h2><p>Le calcul rassemble les bitcoins attribués à chaque enfant, qu’ils soient sur Ledger, encore sur Binance commun ou à classer. Il compare leur valeur actuelle au coût d’achat historique, frais inclus.</p></div>
        <div className="valuation-quote" aria-live="polite"><small>COURS BTC / EUR</small><strong>{bitcoinEur > 0 ? euro.format(bitcoinEur) : "Cours indisponible"}</strong><span>{bitcoinEur > 0 ? `Mis à jour ${quoteUpdatedAt ?? "maintenant"} · ${bitcoinEurSource}` : "La valorisation reprendra dès que le cours sera disponible."}</span><button type="button" className="valuation-refresh" onClick={() => void load()}>↻ Actualiser le cours</button></div>
      </header>
      {bitcoinEur > 0 ? <><div className="valuation-grid">{valuations.map((row) => <article key={row.name}><div className="valuation-person"><span>{row.initials}</span><div><strong>{row.name}</strong><small>{btc(row.attributedBtc)} attribués</small></div></div><div className="valuation-amount"><small>VALEUR ACTUELLE</small><strong>{euro.format(row.currentValue ?? 0)}</strong><em className={(row.gainEur ?? 0) >= 0 ? "positive" : "negative"}>{(row.gainEur ?? 0) >= 0 ? "+" : ""}{euro.format(row.gainEur ?? 0)}{row.gainPercent !== null ? ` · ${row.gainPercent >= 0 ? "+" : ""}${row.gainPercent.toFixed(1)} %` : ""}</em></div></article>)}</div><footer><div><small>BTC ATTRIBUÉS</small><strong>{btc(totalAttributedBtc)}</strong></div><div><small>INVESTI HISTORIQUE</small><strong>{euro.format(totalInvestedEur)}</strong></div><div><small>VALEUR ACTUELLE</small><strong>{euro.format(totalMarketValue ?? 0)}</strong></div><div className={(totalGainEur ?? 0) >= 0 ? "positive" : "negative"}><small>PLUS-VALUE THÉORIQUE</small><strong>{(totalGainEur ?? 0) >= 0 ? "+" : ""}{euro.format(totalGainEur ?? 0)}</strong></div></footer></> : <p className="valuation-unavailable" role="status">Le cours BTC/EUR est momentanément indisponible. Les coûts historiques et les quantités restent consultables ci-dessous.</p>}
    </section>    <section className="panel delivery-summary"><header><div><span>RÉCAPITULATIF SIMPLE</span><h2>Les derniers cadeaux dus ont-ils bien été achetés ?</h2><p>Offert signifie « achat Binance visible » ou « achat déjà transféré sur Ledger ». Sans achat identifié, le cadeau reste non offert dans ce contrôle.</p></div></header><div className="synthesis-scroll"><table className="delivery-table"><thead><tr><th>Enfant</th><th>Dernier anniversaire dû</th><th>Dernier Noël dû</th><th>Suivi</th></tr></thead><tbody>{giftSummaryMembers.map((member) => { const birthday = delivery(member, "Anniversaire"); const christmas = delivery(member, "Noël"); const offered = Number(birthday.offered) + Number(christmas.offered); return <tr key={member.name}><th scope="row"><b>{member.initials}</b>{member.name}</th><td><span className={`delivery-state ${birthday.tone}`}>{birthday.label}</span><small>{birthday.detail}</small></td><td><span className={`delivery-state ${christmas.tone}`}>{christmas.label}</span><small>{christmas.detail}</small></td><td><strong className={offered === 2 ? "delivery-complete" : "delivery-incomplete"}>{offered}/2 offerts</strong><small>{offered === 2 ? "Achats enregistrés" : "Achat à enregistrer"}</small></td></tr>; })}</tbody></table></div></section>
    <section className="panel synthesis-panel matrix-panel">
      <header><div><span>MATRICE DES CADEAUX</span><h2>Où en est chaque cadeau ?</h2></div><div className="synthesis-legend"><span className="ledger">⚑ Ledger associé · verrouillé</span><span className="binance">⌛ Binance · modifiable</span><span className="missing">! À compléter · modifiable</span><span className="future">À venir</span></div></header>
      <div className="matrix-toolbar">
        <div className="matrix-years" role="group" aria-label="Choisir l’année affichée"><button type="button" className="matrix-arrow" onClick={() => changeYear(1)} disabled={activeYear === availableYears[availableYears.length - 1]} aria-label="Voir l’année précédente">←</button>{availableYears.map((year) => <button type="button" key={year} className={year === activeYear ? "active" : ""} onClick={() => setSelectedYear(year)} aria-pressed={year === activeYear}>{year}</button>)}<button type="button" className="matrix-arrow" onClick={() => changeYear(-1)} disabled={activeYear === availableYears[0]} aria-label="Voir l’année plus récente">→</button></div>
        <div className="matrix-scroll-actions"><span>Tableau large</span><button type="button" onClick={() => scrollMatrix(-1)} aria-label="Faire défiler le tableau vers la gauche">←</button><button type="button" onClick={() => scrollMatrix(1)} aria-label="Faire défiler le tableau vers la droite">→</button></div>
      </div>
      <div className="matrix-year-summary" aria-label={`Bilan de l’année ${activeYear}`}><span><b>{yearTotal.gifts}</b> cadeau{yearTotal.gifts > 1 ? "x" : ""}</span><span><b>{btc(yearTotal.btc)}</b> attribués</span><span><b>{euro.format(yearTotal.eur)}</b> investis</span><span className="matrix-summary-ledger"><b>{yearTotal.ledger}</b> sur Ledger</span><span className="matrix-summary-binance"><b>{yearTotal.binance}</b> sur Binance</span>{yearTotal.pending > 0 && <span className="matrix-summary-pending"><b>{yearTotal.pending}</b> à compléter</span>}</div>
      <p className="synthesis-hint">Cliquez sur une cellule Binance, à classer ou manquante pour modifier directement son montant, ses BTC ou la supprimer. Les cellules Ledger restent en lecture seule après confirmation blockchain. Utilisez les flèches ou faites défiler horizontalement pour consulter toutes les échéances.</p>
      <div ref={matrixRef} className="synthesis-scroll matrix-scroll" tabIndex={0} aria-label={`Matrice des cadeaux de ${activeYear}. Utilisez les flèches gauche et droite pour faire défiler.`} onKeyDown={(event) => { if (event.key === "ArrowLeft") { event.preventDefault(); scrollMatrix(-1); } if (event.key === "ArrowRight") { event.preventDefault(); scrollMatrix(1); } }}>
        <table className="summary-matrix"><thead><tr><th scope="col">Enfant</th>{yearPeriods.map((period) => <th key={`${period.occasion}-${period.date}-${period.member ?? "all"}`} scope="col"><small>{period.occasion === "Noël" ? "NOËL" : "ANNIVERSAIRE"}</small><strong>{period.member ?? "Famille"}</strong><span>{summaryDate.format(new Date(period.date + "T00:00:00Z"))}</span></th>)}<th scope="col" className="summary-year-total">Total {activeYear}</th></tr></thead><tbody>{giftSummaryMembers.map((member) => { const summary = yearRows.find((row) => row.name === member.name)!; return <tr key={member.name}><th scope="row"><b>{member.initials}</b><span>{member.name}</span></th>{yearPeriods.map((period) => cell(member, period))}<td className="summary-year-total"><strong>{summary.gifts} cadeau{summary.gifts > 1 ? "x" : ""}</strong><small>{btc(summary.btc)}</small><em>{summary.ledger} Ledger · {summary.binance} Binance{summary.pending ? ` · ${summary.pending} à classer` : ""}</em></td></tr>; })}</tbody><tfoot><tr><th scope="row">Famille</th><td colSpan={Math.max(1, yearPeriods.length)}><strong>{yearTotal.gifts} cadeaux · {btc(yearTotal.btc)} · {euro.format(yearTotal.eur)}</strong></td><td className="summary-year-total"><strong>{yearTotal.ledger} Ledger · {yearTotal.binance} Binance</strong>{yearTotal.pending > 0 && <small>{yearTotal.pending} à compléter</small>}</td></tr></tfoot></table>
      </div>
    </section>
    <section className="panel synthesis-panel wallet-control">
      <header><div><span>VÉRIFICATION PAR PORTEFEUILLE</span><h2>Contrôle des montants attribués</h2><p>Le total offert reprend le BTC acheté pour les cadeaux. Le BTC en conservation additionne la part réellement attribuée sur Ledger, le solde encore sur Binance et les montants à classer. Leur différence est l’écart de transfert documenté.</p></div></header>
      <div className="synthesis-scroll"><table className="wallet-summary"><thead><tr><th>Enfant</th><th>Reçu sur Ledger</th><th>Attribué Ledger</th><th>À attribuer</th><th>À transférer · Binance</th><th>À classer</th><th>BTC en conservation</th><th>Frais / écart Ledger</th><th>Total offert · achat</th><th>Solde Ledger public</th><th>Contrôle Ledger</th></tr></thead><tbody>{rows.map((row) => { const activity = ledgerActivity.find((wallet) => wallet.name === row.name)!; const hasLedgerGap = Math.abs(row.ledgerGapBtc) > 0.00000001; return <tr key={row.name}><th scope="row">{row.name}</th><td className="ledger-number">{btc(activity.receivedBtc)}</td><td className="ledger-number">{btc(row.ledgerBtc)}</td><td className={activity.unallocatedBtc > 0.00000001 ? "ledger-remaining" : "variance-ok"}>{activity.unallocatedBtc > 0.00000001 ? btc(activity.unallocatedBtc) : "—"}</td><td className="binance-number">{btc(row.binanceBtc)}</td><td>{row.pendingBtc ? btc(row.pendingBtc) : "—"}</td><td className="total-number">{btc(row.inCustodyBtc)}</td><td className={hasLedgerGap ? "fee-number" : "variance-ok"}>{hasLedgerGap ? btc(row.ledgerGapBtc) : "—"}</td><td className="offered-number">{btc(row.offeredBtc)}</td><td>{btc(row.actualWallet)}</td><td className={Math.abs(row.variance) < 0.00000001 ? "variance-ok" : "variance-warning"}>{btc(row.variance)}</td></tr>; })}<tr className="wallet-total"><th scope="row">Total famille</th><td>{btc(ledgerActivityTotal.receivedBtc)}</td><td>{btc(total.ledgerBtc)}</td><td>{ledgerActivityTotal.unallocatedBtc > 0.00000001 ? btc(ledgerActivityTotal.unallocatedBtc) : "—"}</td><td>{btc(total.binanceBtc)}</td><td>{total.pendingBtc ? btc(total.pendingBtc) : "—"}</td><td>{btc(total.inCustodyBtc)}</td><td>{Math.abs(total.ledgerGapBtc) > 0.00000001 ? btc(total.ledgerGapBtc) : "—"}</td><td>{btc(total.offeredBtc)}</td><td>{btc(total.wallet)}</td><td className={Math.abs(total.variance) < 0.00000001 ? "variance-ok" : "variance-warning"}>{btc(total.variance)}</td></tr></tbody></table></div>
      <footer><span>Reçu Ledger = total des réceptions On-Chain ; attribué = BTC relié à un cadeau dans Supabase.</span><span>BTC en conservation + frais/écart Ledger = total offert (BTC acheté).</span><span>Contrôle Ledger = solde public actuel − BTC attribué aux cadeaux.</span></footer>
    </section>
    <section className="panel ledger-transaction-panel">
      <header><div><span>RÉCEPTIONS LEDGER</span><h2>Transactions et allocations par portefeuille</h2><p>Chaque réception publique est rapprochée de son TxID dans Supabase. Une réception peut couvrir plusieurs cadeaux ; un reliquat reste visible jusqu’à son attribution.</p></div><div className="ledger-transaction-total"><small>RÉCEPTION À ATTRIBUER</small><strong>{btc(ledgerActivityTotal.unallocatedBtc)}</strong><span>{ledgerActivityTotal.receipts} réception{ledgerActivityTotal.receipts > 1 ? "s" : ""} Blockchain lue{ledgerActivityTotal.receipts > 1 ? "s" : ""}</span></div></header>
      <div className="ledger-wallet-list">{ledgerActivity.map((wallet) => <article key={wallet.name} className="ledger-wallet-allocation"><header><div className="ledger-wallet-title"><span>{wallet.initials}</span><div><strong>{wallet.name}</strong><small>{wallet.wallet?.address ? `${wallet.wallet.address.slice(0, 12)}…${wallet.wallet.address.slice(-6)}` : "Adresse publique indisponible"}</small></div></div><div className="ledger-wallet-metrics"><span><small>REÇU</small><b>{btc(wallet.receivedBtc)}</b></span><span><small>ATTRIBUÉ</small><b>{btc(wallet.allocatedBtc)}</b></span><span className={wallet.unallocatedBtc > 0.00000001 ? "outstanding" : "settled"}><small>RELIQUAT</small><b>{wallet.unallocatedBtc > 0.00000001 ? btc(wallet.unallocatedBtc) : "À jour"}</b></span>{wallet.wallet?.explorerUrl && <a href={wallet.wallet.explorerUrl} target="_blank" rel="noreferrer">Adresse ↗</a>}</div></header>{wallet.wallet?.error ? <p className="ledger-transaction-error">{wallet.wallet.error}</p> : wallet.transactions.length === 0 ? <p className="ledger-transaction-empty">Aucune transaction Blockchain disponible pour ce portefeuille.</p> : <div className="ledger-transaction-scroll"><table><thead><tr><th>Date</th><th>Transaction</th><th>Réception</th><th>Attribué</th><th>Reste</th><th>État</th></tr></thead><tbody>{wallet.transactions.map((transaction) => <tr key={transaction.txid}><td>{transaction.date ? new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(transaction.date)) : "En attente"}<small>{transaction.confirmed ? `${transaction.confirmations?.toLocaleString("fr-FR") ?? 0} confirmations` : "Non confirmée"}</small></td><td><a href={transaction.explorerUrl} target="_blank" rel="noreferrer" title={transaction.txid}>{transaction.shortTxid} ↗</a><small>{transaction.direction}</small></td><td>{transaction.receivedBtc > 0 ? btc(transaction.receivedBtc) : "—"}</td><td>{transaction.receivedBtc > 0 ? btc(transaction.allocatedBtc) : "—"}</td><td>{transaction.receivedBtc > 0 ? (transaction.remainingBtc > 0.00000001 ? btc(transaction.remainingBtc) : "—") : "—"}</td><td><span className={`ledger-allocation-state ${transaction.allocationTone}`}>{transaction.allocationState}</span></td></tr>)}</tbody></table></div>}</article>)}</div>
      <footer>Les sorties sont listées à titre de transparence et ne sont jamais attribuées à un cadeau. Source Blockchain : Blockstream · associations : Supabase.</footer>
    </section>
  </div>;
}
function Members() {
  const [users,setUsers]=useState<Member[]>([]),[open,setOpen]=useState(false),[busy,setBusy]=useState(""),[message,setMessage]=useState("");
  const [draft,setDraft]=useState({name:"",email:"",role:"child",birthdayDay:"",birthdayMonth:""});
  const load=useCallback(async()=>setUsers((await api("/api/admin/users")).users||[]),[]);
  useEffect(()=>{const timer=window.setTimeout(()=>{void load().catch(e=>setMessage(e.message));},0);return()=>window.clearTimeout(timer);},[load]);
  async function create(event:FormEvent){event.preventDefault();setBusy("create");try{const result=await api("/api/admin/users",{method:"POST",body:JSON.stringify({...draft,birthdayDay:Number(draft.birthdayDay)||undefined,birthdayMonth:Number(draft.birthdayMonth)||undefined,sendInvite:true,redirectTo:window.location.origin})});setMessage(result.invitation?.sent?"Membre ajouté et invitation envoyée.":"Membre ajouté, mais e-mail non envoyé : "+(result.invitation?.reason||"à vérifier"));setDraft({name:"",email:"",role:"child",birthdayDay:"",birthdayMonth:""});setOpen(false);await load();}catch(e){setMessage(e instanceof Error?e.message:"Ajout impossible");}finally{setBusy("");}}
  async function action(user:Member,type:"invite"|"reset"|"toggle"|"delete"){if(type==="delete"&&!window.confirm("Supprimer "+user.name+" et ses données associées ?"))return;setBusy(user.id+type);try{if(type==="invite"||type==="reset"){const r=await api("/api/admin/users/actions",{method:"POST",body:JSON.stringify({action:type==="reset"?"reset_password":"invite",memberId:user.id,redirectTo:window.location.origin})});setMessage(r.message);}else if(type==="toggle"){await api("/api/admin/users",{method:"PATCH",body:JSON.stringify({id:user.id,isActive:!user.is_active})});setMessage(user.is_active?"Accès suspendu.":"Accès réactivé.");}else{await api("/api/admin/users?id="+encodeURIComponent(user.id),{method:"DELETE"});setMessage("Membre supprimé.");}await load();}catch(e){setMessage(e instanceof Error?e.message:"Action impossible");}finally{setBusy("");}}
  return <div className="admin-section">
    <div className="admin-summary"><Summary label="Membres autorisés" value={String(users.length)} note={users.filter(u=>u.is_active).length+" accès actifs"}/><Summary label="Comptes créés" value={String(users.filter(u=>u.auth_user_id).length)} note="Authentification Supabase"/><Summary label="Administrateurs" value="1" note="Florent uniquement"/></div>
    <section className="panel admin-panel-new"><header><div><span>AUTHENTIFICATION SUPABASE</span><h2>Membres & détails de connexion</h2><p>Les mots de passe restent chiffrés chez Supabase et ne sont jamais visibles.</p></div><button onClick={()=>setOpen(!open)}>＋ Ajouter un membre</button></header>
      {open&&<form className="admin-form member-form" onSubmit={create}><Field label="Nom"><input required value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})}/></Field><Field label="E-mail"><input required type="email" value={draft.email} onChange={e=>setDraft({...draft,email:e.target.value})}/></Field><Field label="Rôle"><select value={draft.role} onChange={e=>setDraft({...draft,role:e.target.value})}><option value="child">Jeune investisseur</option><option value="adult">Adulte</option><option value="viewer">Lecture seule</option></select></Field><Field label="Jour"><input type="number" min="1" max="31" value={draft.birthdayDay} onChange={e=>setDraft({...draft,birthdayDay:e.target.value})}/></Field><Field label="Mois"><input type="number" min="1" max="12" value={draft.birthdayMonth} onChange={e=>setDraft({...draft,birthdayMonth:e.target.value})}/></Field><button disabled={busy==="create"}>{busy==="create"?"Envoi…":"Ajouter & inviter"}</button></form>}
      {message&&<p className="admin-feedback">{message}</p>}
      <div className="member-table"><div className="table-head"><span>Membre</span><span>Connexion</span><span>Dernière activité</span><span>Actions</span></div>{users.map(user=><article key={user.id} className={user.is_active?"":"disabled"}><div className="identity"><b>{user.name.slice(0,2).toUpperCase()}</b><span><strong>{user.name}</strong><small>{user.email||"E-mail manquant"} · {user.role}</small></span></div><div><Status ok={Boolean(user.auth_user_id&&user.auth?.emailConfirmedAt)}>{user.auth_user_id?(user.auth?.emailConfirmedAt?"Compte confirmé":"E-mail à confirmer"):"Jamais connecté"}</Status><small className="sub">{user.auth?.providers?.join(", ")||"E-mail"}</small></div><div><strong className="date">{formatDate(user.auth?.lastSignInAt)}</strong><small className="sub">Créé : {formatDate(user.auth?.createdAt)}</small></div><div className="actions">{!user.auth_user_id&&<button disabled={busy.startsWith(user.id)} onClick={()=>void action(user,"invite")}>Renvoyer invitation</button>}{user.auth_user_id&&<button disabled={busy.startsWith(user.id)} onClick={()=>void action(user,"reset")}>Réinitialiser mot de passe</button>}{user.role!=="admin"&&<><button className="quiet" onClick={()=>void action(user,"toggle")}>{user.is_active?"Suspendre":"Réactiver"}</button><button className="danger" onClick={()=>void action(user,"delete")}>Supprimer</button></>}</div></article>)}</div>
    </section>
  </div>;
}

function Accounts(){
  const [members,setMembers]=useState<Member[]>([]),[accounts,setAccounts]=useState<Account[]>([]),[holdings,setHoldings]=useState<Holding[]>([]),[message,setMessage]=useState("");
  const [accountOpen,setAccountOpen]=useState(false),[holdingOpen,setHoldingOpen]=useState(false),[selected,setSelected]=useState("");
  const [a,setA]=useState({memberId:"",name:"",accountType:"pea",institution:"",currency:"EUR",accountNumberLast4:"",ibanLast4:"",walletAddress:"",network:"bitcoin-mainnet",notes:""});
  const [h,setH]=useState({assetType:"stock",symbol:"",isin:"",name:"",quantity:"",averageCost:"",currency:"EUR",exchange:"Euronext Paris",lastPrice:""});
  const [query,setQuery]=useState(""),[results,setResults]=useState<MarketResult[]>([]),[market,setMarket]=useState<boolean|null>(null);
  const load=useCallback(async()=>{const r=await Promise.all([api("/api/admin/users"),api("/api/admin/accounts")]);setMembers(r[0].users||[]);setAccounts(r[1].accounts||[]);setHoldings(r[1].holdings||[]);},[]);
  useEffect(()=>{const timer=window.setTimeout(()=>{void load().catch(e=>setMessage(e.message));},0);return()=>window.clearTimeout(timer);},[load]);
  async function addAccount(e:FormEvent){e.preventDefault();try{await api("/api/admin/accounts",{method:"POST",body:JSON.stringify(a)});setMessage("Compte ajouté.");setAccountOpen(false);await load();}catch(x){setMessage(x instanceof Error?x.message:"Ajout impossible");}}
  async function importLedgers(){try{const r=await api("/api/admin/accounts",{method:"POST",body:JSON.stringify({importExistingWallets:true})});setMessage(r.message);await load();}catch(x){setMessage(x instanceof Error?x.message:"Import impossible");}}
  async function addHolding(e:FormEvent){e.preventDefault();try{await api("/api/admin/holdings",{method:"POST",body:JSON.stringify({...h,accountId:selected,quantity:Number(h.quantity),averageCost:h.averageCost?Number(h.averageCost):undefined,lastPrice:h.lastPrice?Number(h.lastPrice):undefined})});setMessage("Position ajoutée.");setHoldingOpen(false);await load();}catch(x){setMessage(x instanceof Error?x.message:"Ajout impossible");}}
  async function search(){try{const r=await api("/api/admin/market?q="+encodeURIComponent(query));setMarket(r.configured);setResults(r.results||[]);if(!r.configured)setMessage("Ajoutez ALPHA_VANTAGE_API_KEY dans Vercel. La saisie manuelle reste disponible.");}catch(x){setMessage(x instanceof Error?x.message:"Recherche indisponible");}}
  function choose(r:MarketResult){setH({...h,symbol:r.symbol,name:r.name,currency:r.currency||"EUR",exchange:r.region||"Euronext Paris",assetType:r.type.toLowerCase().includes("etf")?"etf":"stock"});setResults([]);}
  async function price(item:Holding){try{const r=await api("/api/admin/market?symbol="+encodeURIComponent(item.symbol||""));if(!r.quote?.price)throw new Error("Aucun cours disponible.");await api("/api/admin/holdings",{method:"PATCH",body:JSON.stringify({id:item.id,lastPrice:r.quote.price})});setMessage("Cours actualisé au "+(r.quote.asOf||"dernier jour de marché")+".");await load();}catch(x){setMessage(x instanceof Error?x.message:"Cours indisponible");}}
  async function remove(kind:"accounts"|"holdings",id:string,label:string){if(!window.confirm("Supprimer "+label+" ?"))return;try{await api("/api/admin/"+kind+"?id="+encodeURIComponent(id),{method:"DELETE"});setMessage("Élément supprimé.");await load();}catch(x){setMessage(x instanceof Error?x.message:"Suppression impossible");}}
  const total=useMemo(()=>holdings.reduce((s,x)=>s+Number(x.quantity)*Number(x.last_price||x.average_cost||0),0),[holdings]);
  return <div className="admin-section"><div className="admin-summary"><Summary label="Comptes financiers" value={String(accounts.length)} note="BTC, banque, PEA, CTO"/><Summary label="Positions" value={String(holdings.length)} note="Actions, ETF et autres"/><Summary label="Valeur documentée" value={euro.format(total)} note="Dernier cours connu"/></div>
    <section className="panel admin-panel-new"><header><div><span>PATRIMOINE MULTI-COMPTES</span><h2>Comptes & positions</h2><p>Ne saisissez que les 4 derniers caractères d&apos;un compte bancaire. Jamais d&apos;identifiant ou de clé privée.</p></div><div className="header-actions"><button onClick={()=>setAccountOpen(!accountOpen)}>＋ Ajouter un compte</button><button className="secondary" onClick={()=>void importLedgers()}>Importer les Ledger</button><button className="secondary" disabled={!accounts.length} onClick={()=>{setHoldingOpen(!holdingOpen);if(!selected&&accounts[0])setSelected(accounts[0].id);}}>＋ Ajouter une position</button></div></header>
      {message&&<p className="admin-feedback">{message}</p>}
      {accountOpen&&<form className="admin-form" onSubmit={addAccount}><Field label="Propriétaire"><select required value={a.memberId} onChange={e=>setA({...a,memberId:e.target.value})}><option value="">Choisir…</option>{members.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></Field><Field label="Type"><select value={a.accountType} onChange={e=>setA({...a,accountType:e.target.value})}><option value="pea">PEA</option><option value="securities">Compte-titres</option><option value="bitcoin">Portefeuille BTC</option><option value="crypto_exchange">Plateforme crypto</option><option value="bank">Compte bancaire</option><option value="savings">Épargne</option><option value="other">Autre</option></select></Field><Field label="Nom du compte"><input required value={a.name} onChange={e=>setA({...a,name:e.target.value})}/></Field><Field label="Établissement"><input value={a.institution} onChange={e=>setA({...a,institution:e.target.value})}/></Field><Field label="Devise"><input maxLength={3} value={a.currency} onChange={e=>setA({...a,currency:e.target.value})}/></Field>{a.accountType==="bitcoin"||a.accountType==="crypto_exchange"?<><Field label="Adresse publique"><input value={a.walletAddress} onChange={e=>setA({...a,walletAddress:e.target.value})}/></Field><Field label="Réseau"><input value={a.network} onChange={e=>setA({...a,network:e.target.value})}/></Field></>:<><Field label="4 derniers chiffres"><input maxLength={4} value={a.accountNumberLast4} onChange={e=>setA({...a,accountNumberLast4:e.target.value})}/></Field><Field label="4 derniers caractères IBAN"><input maxLength={4} value={a.ibanLast4} onChange={e=>setA({...a,ibanLast4:e.target.value})}/></Field></>}<button>Enregistrer</button></form>}
      {holdingOpen&&<form className="holding-form" onSubmit={addHolding}><div className="asset-search"><Field label="Rechercher une action ou un ETF français"><div><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Nom ou symbole"/><button type="button" onClick={()=>void search()}>Rechercher</button></div></Field>{results.length>0&&<div className="results">{results.map(r=><button type="button" key={r.symbol} onClick={()=>choose(r)}><strong>{r.name}</strong><small>{r.symbol} · {r.region} · {r.currency}</small></button>)}</div>}</div><p className="market-note">{market===false?"Recherche non configurée — saisie manuelle ci-dessous.":"Cours de clôture gratuits, adaptés au suivi mensuel d&apos;un PEA."}</p><div className="admin-form"><Field label="Compte"><select required value={selected} onChange={e=>setSelected(e.target.value)}>{accounts.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></Field><Field label="Type"><select value={h.assetType} onChange={e=>setH({...h,assetType:e.target.value})}><option value="stock">Action</option><option value="etf">ETF</option><option value="fund">Fonds</option><option value="bond">Obligation</option><option value="cash">Liquidités</option><option value="crypto">Crypto</option><option value="other">Autre</option></select></Field><Field label="Nom"><input required value={h.name} onChange={e=>setH({...h,name:e.target.value})}/></Field><Field label="Symbole"><input value={h.symbol} onChange={e=>setH({...h,symbol:e.target.value})}/></Field><Field label="ISIN"><input value={h.isin} onChange={e=>setH({...h,isin:e.target.value})}/></Field><Field label="Place de cotation"><input value={h.exchange} onChange={e=>setH({...h,exchange:e.target.value})}/></Field><Field label="Quantité"><input required type="number" min="0" step="any" value={h.quantity} onChange={e=>setH({...h,quantity:e.target.value})}/></Field><Field label="Prix moyen unitaire"><input type="number" min="0" step="any" value={h.averageCost} onChange={e=>setH({...h,averageCost:e.target.value})}/></Field><Field label="Dernier cours"><input type="number" min="0" step="any" value={h.lastPrice} onChange={e=>setH({...h,lastPrice:e.target.value})}/></Field><Field label="Devise"><input maxLength={3} value={h.currency} onChange={e=>setH({...h,currency:e.target.value})}/></Field><button>Enregistrer</button></div></form>}
      <div className="account-list">{accounts.length===0?<div className="empty"><strong>Aucun compte</strong><p>Ajoutez un Ledger, un PEA, un compte-titres ou un compte bancaire.</p></div>:accounts.map(account=>{const owner=members.find(m=>m.id===account.member_id),positions=holdings.filter(x=>x.account_id===account.id);return <article className="account-card" key={account.id}><header><div className="account-icon">{account.account_type.includes("bitcoin")||account.account_type.includes("crypto")?"₿":account.account_type==="pea"?"P":"€"}</div><div><span>{owner?.name||"Membre"} · {account.account_type.toUpperCase()}</span><h3>{account.name}</h3><p>{account.institution||account.network||"Établissement non renseigné"} · {account.currency}{account.account_number_last4?" · •••• "+account.account_number_last4:""}</p></div><button className="danger-link" onClick={()=>void remove("accounts",account.id,account.name)}>Supprimer</button></header>{account.wallet_address&&<p className="wallet">{account.wallet_address}</p>}<div className="positions">{positions.length===0?<p className="empty">Aucune position.</p>:positions.map(item=><div key={item.id}><b className="asset">{item.asset_type==="etf"?"ETF":item.asset_type==="stock"?"ACT":"AUT"}</b><span><strong>{item.name}</strong><small>{item.symbol||"Sans symbole"}{item.isin?" · "+item.isin:""}</small></span><span><strong>{Number(item.quantity).toLocaleString("fr-FR")} unités</strong><small>PRU {Number(item.average_cost||0).toLocaleString("fr-FR")} {item.currency}</small></span><span><strong>{Number(item.last_price||0).toLocaleString("fr-FR")} {item.currency}</strong><small>{item.last_price_at?formatDate(item.last_price_at):"Cours manuel"}</small></span><span className="position-actions">{item.symbol&&<button onClick={()=>void price(item)}>Actualiser</button>}<button onClick={()=>void remove("holdings",item.id,item.name)}>×</button></span></div>)}</div></article>;})}</div>
    </section>
  </div>;
}

function Settings(){
  const [db,setDb]=useState<{connected?:boolean;projectUrl?:string}|null>(null),[market,setMarket]=useState<{configured?:boolean;provider?:string}|null>(null);
  useEffect(()=>{void fetch("/api/supabase/status").then(r=>r.json()).then(setDb);void api("/api/admin/market").then(setMarket).catch(()=>setMarket({configured:false,provider:"Alpha Vantage"}));},[]);
  return <section className="panel admin-panel-new settings-admin"><header><div><span>CONFIGURATION SERVEUR</span><h2>Réglages administrateur</h2><p>Les clés secrètes restent dans Vercel et ne sont jamais envoyées au navigateur.</p></div></header><div className="services"><Service ok={Boolean(db?.connected)} title="Base Supabase" value={db?.projectUrl||"À configurer"} note="Membres, comptes, positions et cadeaux."/><Service ok={Boolean(market?.configured)} title="Données de marché" value={market?.provider||"Alpha Vantage"} note="Actions et ETF mondiaux · cours de clôture · 25 requêtes/jour."/><Service ok title="Administrateur" value="florent.lambert@gmail.com" note="Contrôle côté serveur sur toutes les routes."/></div>{!market?.configured&&<div className="setup"><b>Activer les cours actions / ETF</b><p>Ajoutez <code>ALPHA_VANTAGE_API_KEY</code> dans Vercel → Project Settings → Environment Variables, puis redéployez.</p><a href="https://www.alphavantage.co/support/#api-key" target="_blank" rel="noreferrer">Créer une clé gratuite ↗</a></div>}<div className="rules"><h3>Règles de sécurité</h3><ul><li>Jamais de 24 mots Ledger, clé privée, code PIN ou identifiant bancaire.</li><li>Seulement les 4 derniers caractères des comptes bancaires.</li><li>Les réinitialisations sont envoyées directement par Supabase.</li><li>Les cours sont informatifs et ne constituent pas un conseil financier.</li></ul></div></section>;
}
function Field({label,children}:{label:string;children:React.ReactNode}){return <label>{label}{children}</label>}
function Summary({label,value,note}:{label:string;value:string;note:string}){return <article><span>{label}</span><strong>{value}</strong><small>{note}</small></article>}
function Status({ok,children}:{ok:boolean;children:React.ReactNode}){return <span className={"admin-status "+(ok?"ok":"pending")}><i/>{children}</span>}
function Service({ok,title,value,note}:{ok:boolean;title:string;value:string;note:string}){return <article><Status ok={ok}>{ok?"Connect?":"Optionnel"}</Status><h3>{title}</h3><p>{value}</p><small>{note}</small></article>}
