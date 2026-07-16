"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import type { Viewer } from "../lib/auth-types";
import type { TransferRequest } from "./back-office";
import { supabaseBrowser } from "../lib/supabase-browser";
import "./gift-portfolio.css";

type GiftRecord = {
  id?: string;
  member_name: string;
  occasion: string;
  gift_date: string;
  purchase_date: string;
  amount_eur: number;
  btc_amount: number;
  custody: "Ledger" | "Binance commun";
  transfer_date?: string | null;
  ledger_amount?: number | null;
  public_address?: string | null;
  txid?: string | null;
  blockchain_status?: string;
  confirmations?: number;
  note?: string | null;
  origin: "database" | "historical" | "expected";
};

type LedgerTransaction = { txid: string; date: string | null; amountBtc: number; direction: string; confirmations: number; explorerUrl: string };
type LedgerWallet = { member: string; address: string; confirmedBalanceBtc?: number; transactions?: LedgerTransaction[]; explorerUrl?: string; error?: string };
type LedgerResponse = { wallets: LedgerWallet[]; bitcoinEur: number | null; updatedAt: string };

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
const PROGRAM_START_DATE = "2023-12-25";
const CHRISTMAS_2023_EUR_PER_CHILD = 55;
const CHRISTMAS_2023_BTC_PER_CHILD = 0.001362;
const historical: Omit<GiftRecord, "origin">[] = people.map((person) => ({
  member_name: person.name,
  occasion: "Noël",
  gift_date: PROGRAM_START_DATE,
  purchase_date: PROGRAM_START_DATE,
  amount_eur: CHRISTMAS_2023_EUR_PER_CHILD,
  btc_amount: CHRISTMAS_2023_BTC_PER_CHILD,
  custody: "Binance commun" as const,
  note: "Achat réalisé pour les cinq enfants le même jour. Valeurs historiques indiquées pour chaque enfant.",
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
function locked(record: GiftRecord) {
  return record.origin === "database" && record.custody === "Ledger" && Boolean((record.confirmations ?? 0) > 0 || (record.txid && /valid|confirm/i.test(record.blockchain_status ?? "")));
}
function expectedRecords() {
  const currentYear = new Date().getFullYear();
  const records: GiftRecord[] = [];
  for (const person of people) {
    for (let year = 2023; year <= currentYear; year += 1) {
      const birthdayDate = `${year}-${String(person.month).padStart(2, "0")}-${String(person.day).padStart(2, "0")}`;
      if (birthdayDate >= PROGRAM_START_DATE) records.push({ member_name: person.name, occasion: "Anniversaire", gift_date: birthdayDate, purchase_date: "", amount_eur: 55, btc_amount: 0, custody: "Binance commun", origin: "expected" });
      records.push({ member_name: person.name, occasion: "Noël", gift_date: `${year}-12-25`, purchase_date: "", amount_eur: 55, btc_amount: 0, custody: "Binance commun", origin: "expected" });
    }
  }
  return records;
}

export function GiftPortfolio({ viewer, requests = [], onRequestStatus }: { viewer: Viewer; requests?: TransferRequest[]; onRequestStatus?: (id: string, status: TransferRequest["status"]) => void }) {
  const isAdmin = viewer.role === "admin";
  const [databaseRecords, setDatabaseRecords] = useState<GiftRecord[]>([]);
  const [ledger, setLedger] = useState<LedgerResponse | null>(null);
  const [selected, setSelected] = useState(isAdmin ? "Thibault" : viewer.name);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [editor, setEditor] = useState<GiftRecord | null>(null);

  const load = useCallback(async () => {
    const [giftResult, ledgerResult] = await Promise.all([request("/api/gifts"), request("/api/ledger")]);
    setDatabaseRecords((giftResult.records ?? []).map((record: GiftRecord) => ({ ...record, amount_eur: Number(record.amount_eur), btc_amount: Number(record.btc_amount), ledger_amount: record.ledger_amount ? Number(record.ledger_amount) : null, origin: "database" })));
    setLedger(ledgerResult);
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => { void load().catch((error) => setMessage(error.message)).finally(() => setLoading(false)); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const allRecords = useMemo(() => {
    const eligibleDatabaseRecords = databaseRecords.filter((record) => record.gift_date >= PROGRAM_START_DATE);
    const databaseKeys = new Set(eligibleDatabaseRecords.map(keyOf));
    const history = historical.filter((record) => !databaseKeys.has(keyOf(record))).map((record) => ({ ...record, origin: "historical" as const }));
    const recordedKeys = new Set([...eligibleDatabaseRecords, ...history].map(keyOf));
    const expected = expectedRecords().filter((record) => !recordedKeys.has(keyOf(record)));
    return [...eligibleDatabaseRecords, ...history, ...expected].sort((a, b) => b.gift_date.localeCompare(a.gift_date));
  }, [databaseRecords]);
  const records = allRecords.filter((record) => record.member_name === selected);
  const recorded = records.filter((record) => record.origin !== "expected");
  const wallet = ledger?.wallets?.find((item) => item.member === selected);
  const totalBtc = recorded.reduce((sum, record) => sum + record.btc_amount, 0);
  const ledgerGiftBtc = recorded.filter((record) => record.custody === "Ledger").reduce((sum, record) => sum + record.btc_amount, 0);
  const binanceBtc = recorded.filter((record) => record.custody === "Binance commun").reduce((sum, record) => sum + record.btc_amount, 0);
  const totalEur = recorded.reduce((sum, record) => sum + record.amount_eur, 0);
  const missing = records.filter((record) => record.origin === "expected" && new Date(record.gift_date + "T23:59:59Z") < new Date()).length;
  const years = [...new Set(records.map((record) => record.gift_date.slice(0, 4)))];
  const person = people.find((item) => item.name === selected) ?? people[0];

  function startEntry(record?: GiftRecord) {
    const today = new Date().toISOString().slice(0, 10);
    setEditor(record ? { ...record, purchase_date: record.purchase_date || today } : { member_name: selected, occasion: "Anniversaire", gift_date: today, purchase_date: today, amount_eur: 55, btc_amount: 0, custody: "Binance commun", origin: "expected" });
  }
  async function remove(record: GiftRecord) {
    if (!record.id || !window.confirm("Supprimer ce cadeau du registre ?")) return;
    try { await request("/api/gifts?id=" + encodeURIComponent(record.id), { method: "DELETE" }); setMessage("Cadeau supprimé."); await load(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Suppression impossible"); }
  }

  return <div className="gift-portfolio">
    <section className="gift-person-picker panel">
      <div><span>LES CADEAUX BITCOIN D’AMATXI</span><h2>À qui appartient ce portefeuille ?</h2><p>Sélectionne une personne pour comprendre ce qu’elle a reçu et où se trouvent ses bitcoins.</p></div>
      <div className="person-tabs">{(isAdmin ? people : people.filter((item) => item.name === viewer.name)).map((item) => <button key={item.name} className={selected === item.name ? "active" : ""} onClick={() => setSelected(item.name)}><b className={`avatar ${item.color}`}>{item.initials}</b><span><strong>{item.name}</strong><small>{item.birthday}</small></span></button>)}</div>
    </section>

    <section className="gift-identity">
      <div><span className={`avatar large ${person.color}`}>{person.initials}</span><div><small>PORTEFEUILLE DE</small><h2>{person.name}</h2><p>Anniversaire le {person.birthday} · cadeau de Noël le 25 décembre</p></div></div>
      {isAdmin && <button className="primary-button" onClick={() => startEntry()}>＋ Saisir un cadeau</button>}
    </section>

    {message && <p className="gift-message">{message}</p>}
    <section className="gift-explainer panel">
      <div className="gift-total"><small>CADEAUX D’AMATXI ENREGISTRÉS</small><strong>{totalBtc.toFixed(8)} BTC</strong><b>{euro.format(totalEur)} investis à l’époque</b><p>Valeur indicative aujourd’hui : {ledger?.bitcoinEur ? euro.format(totalBtc * ledger.bitcoinEur) : "cours indisponible"}</p></div>
      <div className="custody-explanation"><h3>Où sont les bitcoins ?</h3><div className="custody-bars"><div><span><b>Ledger personnel</b><em>{ledgerGiftBtc.toFixed(8)} BTC attribués</em></span><i><b style={{ width: totalBtc ? `${ledgerGiftBtc / totalBtc * 100}%` : "0%" }} /></i><small>Conservés sur l’adresse publique de {selected}. Les données blockchain sont en lecture seule.</small></div><div><span><b>Binance commun</b><em>{binanceBtc.toFixed(8)} BTC attribués</em></span><i className="binance"><b style={{ width: totalBtc ? `${binanceBtc / totalBtc * 100}%` : "0%" }} /></i><small>Achetés pour {selected}, mais encore conservés sur le compte commun de Florent.</small></div></div></div>
      <div className="ledger-fact"><span>₿</span><small>SOLDE PUBLIC DU LEDGER</small><strong>{wallet?.confirmedBalanceBtc?.toFixed(8) ?? "—"} BTC</strong><b>{wallet?.confirmedBalanceBtc !== undefined && ledger?.bitcoinEur ? euro.format(wallet.confirmedBalanceBtc * ledger.bitcoinEur) : "Blockchain en lecture"}</b><p>Ce solde peut inclure d’autres bitcoins que les cadeaux d’Amatxi.</p>{wallet?.explorerUrl && <a href={wallet.explorerUrl} target="_blank" rel="noreferrer">Voir sur Blockstream ↗</a>}</div>
    </section>

    <section className="gift-stats"><article><span>✓</span><div><strong>{recorded.length}</strong><small>cadeaux documentés</small></div></article><article><span>!</span><div><strong>{missing}</strong><small>cadeaux passés à compléter</small></div></article><article><span>↗</span><div><strong>{wallet?.transactions?.length ?? 0}</strong><small>transactions Ledger publiques</small></div></article></section>

    <section className="panel gift-timeline-panel"><header><div><span>HISTOIRE DES CADEAUX</span><h2>Anniversaires et Noëls, année après année</h2><p>Le registre commence le 25 décembre 2023. Chaque ligne raconte le cadeau, la quantité achetée et son lieu de conservation.</p></div><div className="timeline-legend"><span className="ledger">Ledger</span><span className="binance">Binance commun</span><span className="missing">À compléter</span></div></header>
      <div className="gift-years">{years.map((year) => <section key={year} className="gift-year"><h3>{year}</h3><div>{records.filter((record) => record.gift_date.startsWith(year)).map((record) => {
        const isMissing = record.origin === "expected";
        const isFuture = isMissing && new Date(record.gift_date + "T23:59:59Z") >= new Date();
        const isLocked = locked(record);
        return <article key={keyOf(record)} className={isMissing ? "missing" : ""}><div className={`occasion-icon ${record.occasion === "Noël" ? "christmas" : "birthday"}`}>{record.occasion === "Noël" ? "✦" : "♕"}</div><div className="gift-story"><span>{record.occasion.toUpperCase()} · {monthYear.format(new Date(record.gift_date + "T00:00:00Z"))}</span><strong>{record.occasion === "Noël" ? "Le cadeau de Noël d’Amatxi" : `Le cadeau d’anniversaire de ${selected}`}</strong><small>{isMissing ? (isFuture ? `Prévu le ${fullDate.format(new Date(record.gift_date + "T00:00:00Z"))}` : "Achat ou quantité BTC à renseigner") : `Acheté le ${fullDate.format(new Date(record.purchase_date + "T00:00:00Z"))}`}</small>{record.note && !isMissing && <em>{record.note}</em>}</div><div className="gift-amount">{isMissing ? <><strong>55,00 €</strong><small>BTC à saisir</small></> : <><strong>{record.btc_amount.toFixed(8)} BTC</strong><small>{euro.format(record.amount_eur)} · frais inclus</small></>}</div><div className={`custody-chip ${isMissing ? "missing" : record.custody === "Ledger" ? "ledger" : "binance"}`}><b>{isMissing ? "?" : record.custody === "Ledger" ? "L" : "₿"}</b><span><strong>{isMissing ? (isFuture ? "À venir" : "À compléter") : record.custody}</strong><small>{isLocked ? `${record.confirmations} confirmations` : record.origin === "historical" ? "Historique à confirmer" : record.custody === "Ledger" ? "Déclaré sur Ledger" : "En attente de transfert"}</small></span></div>{isAdmin && <div className="gift-actions">{isLocked ? <span title="Donnée confirmée par la blockchain">🔒 Lecture seule</span> : <><button onClick={() => startEntry(record)}>{record.origin === "database" ? "Modifier" : "Renseigner"}</button>{record.origin === "database" && <button className="delete" onClick={() => void remove(record)}>Supprimer</button>}</>}</div>}</article>;
      })}</div></section>)}</div>
    </section>

    <section className="panel chain-readonly"><header><div><span>LEDGER · DONNÉES NON MODIFIABLES</span><h2>Transactions visibles sur la blockchain</h2></div><b>🔒 Lecture seule</b></header>{wallet?.transactions?.length ? <div className="chain-list">{wallet.transactions.map((transaction) => <a key={transaction.txid} href={transaction.explorerUrl} target="_blank" rel="noreferrer"><span className={transaction.direction === "Reçu" ? "received" : "sent"}>{transaction.direction === "Reçu" ? "↓" : "↑"}</span><div><strong>{transaction.direction} · {transaction.amountBtc.toFixed(8)} BTC</strong><small>{transaction.date ? fullDate.format(new Date(transaction.date)) : "En attente"} · {transaction.confirmations} confirmations</small></div><code>{transaction.txid.slice(0, 10)}…{transaction.txid.slice(-8)}</code><b>↗</b></a>)}</div> : <div className="chain-empty">{loading ? "Lecture de la blockchain…" : "Aucune transaction publique trouvée pour ce Ledger."}</div>}</section>

    {isAdmin && requests.length > 0 && <section className="panel gift-requests"><header><div><span>DEMANDES DES ENFANTS</span><h2>Transferts Binance vers Ledger</h2></div></header>{requests.map((item) => <article key={item.id}><div><strong>{item.member}</strong><small>{item.btcAmount?.toFixed(8) ?? "Montant à confirmer"} BTC · {item.requestedAt}</small></div><select value={item.status} onChange={(event) => onRequestStatus?.(item.id, event.target.value as TransferRequest["status"])}><option>Nouvelle</option><option>En traitement</option><option>Transférée</option></select></article>)}</section>}

    {editor && <GiftEditor record={editor} wallets={ledger?.wallets ?? []} onClose={() => setEditor(null)} onSaved={async (text) => { setEditor(null); setMessage(text); await load(); }} />}
  </div>;
}

function GiftEditor({ record, wallets, onClose, onSaved }: { record: GiftRecord; wallets: LedgerWallet[]; onClose: () => void; onSaved: (message: string) => Promise<void> }) {
  const [draft, setDraft] = useState({ member: record.member_name, occasion: record.occasion, giftDate: record.gift_date, purchaseDate: record.purchase_date || new Date().toISOString().slice(0, 10), amountEur: String(record.amount_eur || 55), btcAmount: record.btc_amount ? String(record.btc_amount) : "", custody: record.custody, transferDate: record.transfer_date ?? "", ledgerAmount: record.ledger_amount ? String(record.ledger_amount) : "", publicAddress: record.public_address ?? addresses[record.member_name] ?? "", txid: record.txid ?? "", blockchainStatus: record.blockchain_status ?? "", confirmations: record.confirmations ?? 0, note: record.note ?? "" });
  const [busy, setBusy] = useState(false);
  const [verification, setVerification] = useState("");
  function update(key: keyof typeof draft, value: string | number) { setDraft((current) => ({ ...current, [key]: value })); }
  function changeMember(member: string) { setDraft((current) => ({ ...current, member, publicAddress: addresses[member] ?? "", txid: "", confirmations: 0, blockchainStatus: "" })); }

  const candidateWallet = wallets.find((wallet) => wallet.member === draft.member);
  const candidates = useMemo(() => {
    const expected = Number(draft.btcAmount || 0);
    const referenceDate = new Date((draft.transferDate || draft.giftDate || draft.purchaseDate) + "T00:00:00Z").getTime();
    return (candidateWallet?.transactions ?? []).filter((transaction) => transaction.direction === "Reçu").map((transaction) => {
      const differenceBtc = expected ? Math.abs(transaction.amountBtc - expected) : transaction.amountBtc;
      const relativeDifference = expected ? differenceBtc / expected : 1;
      const transactionTime = transaction.date ? new Date(transaction.date).getTime() : referenceDate;
      const daysDifference = Math.round(Math.abs(transactionTime - referenceDate) / 86_400_000);
      const quality = differenceBtc <= Math.max(0.00000001, expected * 0.001) ? "exact" : relativeDifference <= 0.03 ? "probable" : "manual";
      return { ...transaction, differenceBtc, daysDifference, quality, score: relativeDifference * 1000 + daysDifference / 365 };
    }).sort((left, right) => left.score - right.score);
  }, [candidateWallet?.transactions, draft.btcAmount, draft.giftDate, draft.purchaseDate, draft.transferDate]);

  function chooseCandidate(transaction: (typeof candidates)[number]) {
    const transferDate = transaction.date?.slice(0, 10) ?? draft.transferDate;
    setDraft((current) => ({
      ...current,
      publicAddress: candidateWallet?.address ?? current.publicAddress,
      txid: transaction.txid,
      transferDate,
      ledgerAmount: String(transaction.amountBtc),
      confirmations: transaction.confirmations,
      blockchainStatus: transaction.quality === "manual" ? "Rapproché manuellement sur la blockchain" : "Validé sur la blockchain",
    }));
    setVerification(transaction.quality === "exact"
      ? `✓ Correspondance exacte trouvée : ${transaction.amountBtc.toFixed(8)} BTC · ${transaction.confirmations} confirmations.`
      : transaction.quality === "probable"
        ? `✓ Correspondance probable sélectionnée : écart de ${transaction.differenceBtc.toFixed(8)} BTC. Vérifiez avant d’enregistrer.`
        : "Transaction Ledger sélectionnée manuellement. Vérifiez le montant avant d’enregistrer.");
  }

  async function verify() {
    if (!draft.publicAddress || !draft.txid) { setVerification("Sélectionnez une réception Ledger ou saisissez son TxID."); return; }
    setBusy(true);
    try {
      const result = await request("/api/blockchain/verify", { method: "POST", body: JSON.stringify({ address: draft.publicAddress, txid: draft.txid, expectedBtc: Number(draft.ledgerAmount || draft.btcAmount) }) });
      update("confirmations", result.confirmations ?? 0);
      update("blockchainStatus", result.verified ? "Validé sur la blockchain" : "À vérifier");
      setVerification(result.verified ? `✓ Transaction confirmée · ${result.confirmations} confirmations` : "La transaction ne correspond pas encore au montant attendu.");
    } catch (error) { setVerification(error instanceof Error ? error.message : "Vérification impossible"); }
    finally { setBusy(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true);
    try {
      const body = { id: record.origin === "database" ? record.id : undefined, ...draft, amountEur: Number(draft.amountEur), btcAmount: Number(draft.btcAmount), ledgerAmount: draft.ledgerAmount ? Number(draft.ledgerAmount) : null };
      await request("/api/gifts", { method: body.id ? "PATCH" : "POST", body: JSON.stringify(body) });
      await onSaved(body.id ? "Cadeau modifié." : "Cadeau enregistré.");
    } catch (error) { setVerification(error instanceof Error ? error.message : "Enregistrement impossible"); }
    finally { setBusy(false); }
  }
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="modal simple-gift-editor" role="dialog" aria-modal="true"><header><div><span>REGISTRE DES CADEAUX D’AMATXI</span><h2>{record.origin === "database" ? "Modifier le cadeau" : "Renseigner le cadeau"}</h2><p>Tout est sur une seule page. Les champs Ledger seront verrouillés après confirmation blockchain.</p></div><button onClick={onClose} aria-label="Fermer">×</button></header><form onSubmit={submit}>
    <div className="editor-section"><h3>1 · Le cadeau</h3><div className="form-grid"><label>Enfant<select value={draft.member} onChange={(event) => changeMember(event.target.value)}>{people.map((person) => <option key={person.name}>{person.name}</option>)}</select></label><label>Occasion<select value={draft.occasion} onChange={(event) => update("occasion", event.target.value)}><option>Anniversaire</option><option>Noël</option><option>Autre cadeau</option></select></label><label>Date du cadeau<input type="date" required value={draft.giftDate} onChange={(event) => update("giftDate", event.target.value)} /></label><label>Date d’achat<input type="date" required value={draft.purchaseDate} onChange={(event) => update("purchaseDate", event.target.value)} /></label></div></div>
    <div className="editor-section"><h3>2 · L’achat Bitcoin</h3><div className="form-grid"><label>Montant total, frais inclus (€)<input type="number" min="0" step="0.01" required value={draft.amountEur} onChange={(event) => update("amountEur", event.target.value)} /></label><label>BTC achetés<input type="number" min="0" step="any" required value={draft.btcAmount} onChange={(event) => update("btcAmount", event.target.value)} placeholder="0,00123456" /></label><label className="span-2">Commentaire<input value={draft.note} onChange={(event) => update("note", event.target.value)} placeholder="Information utile pour la famille" /></label></div></div>
    <div className="editor-section"><h3>3 · Où sont les bitcoins ?</h3><div className="simple-custody"><button type="button" className={draft.custody === "Binance commun" ? "active" : ""} onClick={() => update("custody", "Binance commun")}><b>₿</b><span><strong>Binance commun</strong><small>Attribués à l’enfant, en attente de transfert</small></span></button><button type="button" className={draft.custody === "Ledger" ? "active" : ""} onClick={() => update("custody", "Ledger")}><b>L</b><span><strong>Ledger personnel</strong><small>Rechercher automatiquement sur la blockchain</small></span></button></div>
      {draft.custody === "Ledger" && <div className="form-grid ledger-editor">
        <section className="ledger-matcher span-2"><header><div><span>RAPPROCHEMENT BLOCKCHAIN</span><h4>Quelle réception correspond à ce cadeau ?</h4><p>Nous comparons les {Number(draft.btcAmount || 0).toFixed(8)} BTC attendus avec les réceptions publiques du Ledger de {draft.member}.</p></div><b>{candidates.length} trouvée{candidates.length > 1 ? "s" : ""}</b></header>
          {candidates.length > 0 ? <div className="ledger-candidates">{candidates.slice(0, 5).map((transaction, index) => <button type="button" key={transaction.txid} className={draft.txid === transaction.txid ? "selected" : ""} onClick={() => chooseCandidate(transaction)}><span><b>{index === 0 && transaction.quality !== "manual" ? "★ Proposition" : transaction.quality === "exact" ? "Montant exact" : transaction.quality === "probable" ? "Montant proche" : "Autre réception"}</b><small>{transaction.date ? fullDate.format(new Date(transaction.date)) : "En attente"} · {transaction.confirmations} confirmations</small></span><strong>{transaction.amountBtc.toFixed(8)} BTC</strong><em>{draft.txid === transaction.txid ? "Sélectionnée ✓" : "Associer"}</em></button>)}</div> : <p className="ledger-no-match">Aucune réception publique n’a été trouvée sur cette adresse. Vous pouvez saisir le TxID manuellement ci-dessous.</p>}
        </section>
        <label>Date du transfert<input type="date" value={draft.transferDate} onChange={(event) => update("transferDate", event.target.value)} /></label><label>BTC réellement reçus sur Ledger<input type="number" min="0" step="any" value={draft.ledgerAmount} onChange={(event) => update("ledgerAmount", event.target.value)} /></label><label className="span-2">Adresse Bitcoin publique<input value={draft.publicAddress} onChange={(event) => update("publicAddress", event.target.value)} /></label><details className="manual-txid span-2"><summary>Saisir ou vérifier le TxID manuellement</summary><label>TxID public<input value={draft.txid} onChange={(event) => update("txid", event.target.value)} /></label></details><button type="button" onClick={() => void verify()} disabled={busy}>{draft.txid ? "Confirmer le rapprochement" : "Vérifier sur la blockchain"}</button>
      </div>}
      {draft.custody === "Binance commun" && <p className="binance-note">Cette quantité restera comptabilisée pour {draft.member}, même si elle se trouve encore sur le compte Binance commun.</p>}
    </div>{verification && <p className="editor-feedback">{verification}</p>}<footer><button type="button" className="secondary-button" onClick={onClose}>Annuler</button><button className="primary-button" disabled={busy}>{busy ? "Enregistrement…" : record.origin === "database" ? "Enregistrer les modifications" : "Ajouter au registre"}</button></footer></form></section></div>;
}