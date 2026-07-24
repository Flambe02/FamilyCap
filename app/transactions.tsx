"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "../lib/supabase-browser";
import { saveGift, savePersonalInvestment } from "../lib/gifts-client";
import { FAMILY_MEMBERS, MEMBER_NAMES, BIRTHDAY_MONTH_DAY } from "../lib/family-roster";
import { useDialogA11y } from "./use-dialog-a11y";
import "./transactions.css";

export type TransactionRecord = {
  id: string;
  date: string;
  member: string;
  kind: string;
  asset: string;
  account: string;
  amount: number;
  quantity?: number;
  author: string;
  authorRole: "Administrateur" | "Enfant" | "Adulte" | "Blockchain";
  status: "Confirmée" | "À transférer" | "À compléter";
  reference?: string;
  note?: string;
};

export type TransactionShortcut = {
  requestId: number;
  member?: string;
  location?: "Tous" | "Ledger" | "Binance" | "À classer";
  scope?: "all" | "gifts" | "documented" | "needs-action" | "blockchain";
  label: string;
};

type MemberQuickFilter = "all" | "ledger" | "binance" | "pending" | "noel";

type GiftApiRecord = {
  id: string;
  member_name: string;
  occasion: string;
  gift_date: string;
  amount_eur: number | string;
  btc_amount: number | string;
  ledger_amount?: number | string | null;
  custody: string;
  confirmations?: number;
  txid?: string | null;
  note?: string | null;
  is_deleted?: boolean;
};

type LedgerCostBasis = { costEur: number; quantityBtc: number };

function addLedgerCostBasis(map: Map<string, LedgerCostBasis>, key: string, costEur: number, quantityBtc: number) {
  const current = map.get(key) ?? { costEur: 0, quantityBtc: 0 };
  map.set(key, { costEur: current.costEur + costEur, quantityBtc: current.quantityBtc + quantityBtc });
}

// Les cadeaux historiques sont fournis par /api/gifts après authentification.
// Aucun montant financier n'est embarqué dans le bundle client initial.
export const initialTransactions: TransactionRecord[] = [];

const memberNames = MEMBER_NAMES;
const memberBirthdays = FAMILY_MEMBERS.map((member) => ({ member: member.name, monthDay: BIRTHDAY_MONTH_DAY[member.name] }));
const euro = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });
const dateFormat = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });

export function TransactionsView({ transactions, isAdmin, viewerName, onAdd, onTransferRequest, onOpenPortfolio, shortcut, reloadKey }: { transactions: TransactionRecord[]; isAdmin: boolean; viewerName: string; onAdd: () => void; onTransferRequest: (transaction: TransactionRecord) => void; onOpenPortfolio?: (member: string) => void; shortcut?: TransactionShortcut | null; reloadKey?: number }) {
  const [memberFilter, setMemberFilter] = useState(shortcut?.member ?? "Tous");
  const [locationFilter, setLocationFilter] = useState<string>(shortcut?.location ?? "Tous");
  const [scopeFilter, setScopeFilter] = useState<TransactionShortcut["scope"]>(shortcut?.scope ?? "all");
  const [giftTransactions, setGiftTransactions] = useState<TransactionRecord[]>([]);
  const [deletedGiftKeys, setDeletedGiftKeys] = useState<string[]>([]);
  const [ledgerTransactions, setLedgerTransactions] = useState<TransactionRecord[]>([]);
  const [bitcoinEur, setBitcoinEur] = useState<number | null>(null);
  const [deletingTransactionId, setDeletingTransactionId] = useState<string | null>(null);
  const [mutationMessage, setMutationMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [mobileSortDir, setMobileSortDir] = useState<"desc" | "asc">("desc");
  const [memberQuickFilter, setMemberQuickFilter] = useState<MemberQuickFilter>(() => shortcut?.location === "Ledger" ? "ledger" : shortcut?.location === "Binance" ? "binance" : "all");
  const [requestedIds, setRequestedIds] = useState<string[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const { data } = await supabaseBrowser.auth.getSession();
      const headers: Record<string, string> = data.session ? { authorization: "Bearer " + data.session.access_token } : {};
      const [giftResponse, ledgerResponse] = await Promise.all([
        fetch("/api/gifts", { signal: controller.signal, headers }),
        fetch(isAdmin ? "/api/ledger" : "/api/ledger?priceOnly=1", { signal: controller.signal, headers }),
      ]);
      if (!giftResponse.ok || !ledgerResponse.ok) throw new Error("Historique financier indisponible");
      const giftResult = await giftResponse.json() as { records?: GiftApiRecord[]; deletedRecords?: GiftApiRecord[] };
      const ledgerResult = await ledgerResponse.json() as { bitcoinEur?: number | null; wallets?: Array<{ member: string; transactions?: Array<{ txid: string; date: string | null; amountBtc: number; direction: string; confirmations: number }> }> };
      const nextBitcoinEur = Number(ledgerResult.bitcoinEur);
      setBitcoinEur(Number.isFinite(nextBitcoinEur) && nextBitcoinEur > 0 ? nextBitcoinEur : null);
      const giftRecords = giftResult.records ?? [];
      setDeletedGiftKeys((giftResult.deletedRecords ?? []).map((record) => record.member_name + "|" + record.occasion + "|" + record.gift_date.slice(0, 4)));
      setGiftTransactions(giftRecords.filter((record) => !record.is_deleted).map((record) => ({
        id: "gift-" + record.id,
        date: record.gift_date,
        member: record.member_name,
        kind: record.occasion,
        asset: "Bitcoin",
        account: record.custody,
        amount: Number(record.amount_eur),
        quantity: Number(record.btc_amount),
        author: "Administrateur",
        authorRole: "Administrateur" as const,
        status: record.custody === "Binance commun" ? "À transférer" as const : (record.confirmations ?? 0) > 0 ? "Confirmée" as const : "À compléter" as const,
        reference: record.txid ?? undefined,
        note: record.note ?? undefined,
      })));
      const costBasisByTxid = new Map<string, LedgerCostBasis>();
      const costBasisByMember = new Map<string, LedgerCostBasis>();
      for (const record of giftRecords) {
        if (record.is_deleted || record.custody !== "Ledger") continue;
        const purchasedBtc = Number(record.btc_amount);
        const amountEur = Number(record.amount_eur);
        const receivedBtc = Number(record.ledger_amount ?? record.btc_amount);
        if (!(purchasedBtc > 0) || !(amountEur > 0) || !(receivedBtc > 0)) continue;
        const receivedCostEur = receivedBtc * amountEur / purchasedBtc;
        addLedgerCostBasis(costBasisByMember, record.member_name, receivedCostEur, receivedBtc);
        if (record.txid) addLedgerCostBasis(costBasisByTxid, `${record.member_name}|${record.txid}`, receivedCostEur, receivedBtc);
      }
      setLedgerTransactions((ledgerResult.wallets ?? []).flatMap((wallet) => (wallet.transactions ?? []).map((transaction) => {
        const linkedBasis = costBasisByTxid.get(`${wallet.member}|${transaction.txid}`);
        const recalculatedBasis = linkedBasis ?? costBasisByMember.get(wallet.member);
        const purchasePrice = recalculatedBasis && recalculatedBasis.quantityBtc > 0 ? recalculatedBasis.costEur / recalculatedBasis.quantityBtc : null;
        return {
          id: "ledger-" + transaction.txid,
          date: transaction.date?.slice(0, 10) ?? new Date().toISOString().slice(0, 10),
          member: wallet.member,
          kind: "Transaction Ledger",
          asset: "Bitcoin",
          account: "Ledger personnel · blockchain",
          amount: purchasePrice === null ? 0 : purchasePrice * transaction.amountBtc,
          quantity: transaction.amountBtc,
          author: "Blockchain",
          authorRole: "Blockchain" as const,
          status: transaction.confirmations > 0 ? "Confirmée" as const : "À compléter" as const,
          reference: transaction.txid,
          note: `${transaction.direction} sur l’adresse Ledger publique · ${transaction.confirmations} confirmations. ${linkedBasis ? "PRU repris des achats Binance associés." : purchasePrice !== null ? "PRU recalculé sur les achats Ledger de ce portefeuille." : "PRU à rattacher à un achat Binance."}`,
        };
      })));
    })().catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) console.error(error);
    });
    return () => controller.abort();
  }, [isAdmin, reloadKey]);

  const detailedTransactions = useMemo(() => {
    const giftsByEvent = new Map<string, TransactionRecord>();
    for (const transaction of transactions) {
      const key = transaction.member + "|" + transaction.kind + "|" + transaction.date.slice(0, 4);
      if (!deletedGiftKeys.includes(key)) giftsByEvent.set(key, transaction);
    }
    for (const transaction of giftTransactions) {
      const key = `${transaction.member}|${transaction.kind}|${transaction.date.slice(0, 4)}`;
      const truth = giftsByEvent.get(key);
      giftsByEvent.set(key, truth ? { ...transaction, date: truth.date, amount: truth.amount, quantity: truth.quantity, note: truth.note } : transaction);
    }
    const currentYear = new Date().getFullYear().toString();
    const today = new Date().toISOString().slice(0, 10);
    for (const birthday of memberBirthdays) {
      const expected = [
        { kind: "Anniversaire", date: currentYear + "-" + birthday.monthDay },
        { kind: "Noël", date: currentYear + "-12-25" },
      ];
      for (const event of expected) {
        const key = birthday.member + "|" + event.kind + "|" + currentYear;
        if (event.date > today || giftsByEvent.has(key) || deletedGiftKeys.includes(key)) continue;
        giftsByEvent.set(key, {
          id: "expected-" + birthday.member.toLowerCase() + "-" + event.kind + "-" + currentYear,
          date: event.date,
          member: birthday.member,
          kind: event.kind,
          asset: "Bitcoin",
          account: "À rapprocher : Ledger ou Binance commun",
          amount: 55,
          author: "Administrateur",
          authorRole: "Administrateur",
          status: "À compléter",
          note: "Achat Binance non visible : action administrateur requise.",
        });
      }
    }
    const giftRecords = [...giftsByEvent.values()];
    return [...giftRecords, ...ledgerTransactions]
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [transactions, giftTransactions, ledgerTransactions, deletedGiftKeys]);

  const filtered = useMemo(() => detailedTransactions.filter((transaction) => {
    const memberMatches = isAdmin ? memberFilter === "Tous" || transaction.member === memberFilter : transaction.member === viewerName;
    const location = transactionLocation(transaction);
    const locationMatches = locationFilter === "Tous" || location === locationFilter;
    const scopeMatches = scopeFilter === "all"
      || (scopeFilter === "gifts" && transaction.authorRole !== "Blockchain")
      || (scopeFilter === "documented" && transaction.authorRole !== "Blockchain" && Number(transaction.quantity ?? 0) > 0)
      || (scopeFilter === "needs-action" && transaction.authorRole !== "Blockchain" && (transaction.status === "À compléter" || location === "À classer"))
      || (scopeFilter === "blockchain" && transaction.authorRole === "Blockchain");
    return memberMatches && locationMatches && scopeMatches;
  }), [detailedTransactions, memberFilter, locationFilter, scopeFilter, isAdmin, viewerName]);

  /* Mobile — vue membre : total personnel (indépendant des filtres) + filtre rapide indépendant de l'ancien mécanisme admin. */
  const memberOwnTransactions = useMemo(() => detailedTransactions.filter((transaction) => transaction.member === viewerName), [detailedTransactions, viewerName]);
  const memberReceived = useMemo(() => memberOwnTransactions.filter((transaction) => transaction.authorRole !== "Blockchain" && Number(transaction.quantity ?? 0) > 0), [memberOwnTransactions]);
  const memberTotalInvested = memberReceived.reduce((sum, transaction) => sum + transaction.amount, 0);
  const memberTotalBtc = memberReceived.reduce((sum, transaction) => sum + Number(transaction.quantity ?? 0), 0);
  const memberTotalValue = bitcoinEur ? memberTotalBtc * bitcoinEur : null;
  const memberGainEur = memberTotalValue !== null ? memberTotalValue - memberTotalInvested : null;
  const memberGainPct = memberGainEur !== null && memberTotalInvested > 0 ? memberGainEur / memberTotalInvested * 100 : null;
  function matchesMemberQuickFilter(transaction: TransactionRecord, mode: MemberQuickFilter) {
    if (mode === "all") return true;
    if (mode === "noel") return transaction.kind === "Noël";
    if (mode === "pending") return transaction.status === "À transférer";
    const location = transactionLocation(transaction);
    if (mode === "ledger") return location === "Ledger";
    if (mode === "binance") return location === "Binance";
    return true;
  }
  const memberQuickFiltered = useMemo(() => memberOwnTransactions.filter((transaction) => matchesMemberQuickFilter(transaction, memberQuickFilter)), [memberOwnTransactions, memberQuickFilter]);

  /* Mobile — vue admin : même liste que le tableau classique, simplement triable (nouveau, mobile uniquement). */
  const adminMobileSorted = useMemo(() => {
    const list = [...filtered];
    return mobileSortDir === "desc" ? list : list.reverse();
  }, [filtered, mobileSortDir]);

  function clearShortcut() {
    setMemberFilter("Tous");
    setLocationFilter("Tous");
    setScopeFilter("all");
  }

  async function deleteGiftTransaction(transaction: TransactionRecord) {
    const location = transactionLocation(transaction);
    if (!isAdmin || transaction.authorRole === "Blockchain" || location === "Ledger") return;
    const formattedDate = dateFormat.format(new Date(`${transaction.date}T00:00:00Z`));
    if (!window.confirm(`Supprimer définitivement du suivi le cadeau ${transaction.kind.toLowerCase()} de ${transaction.member} du ${formattedDate} ?`)) return;
    setDeletingTransactionId(transaction.id);
    setMutationMessage(null);
    try {
      const params = new URLSearchParams();
      if (transaction.id.startsWith("gift-")) {
        params.set("id", transaction.id.slice(5));
      } else {
        params.set("member", transaction.member);
        params.set("occasion", transaction.kind);
        params.set("giftDate", transaction.date);
        params.set("amountEur", String(transaction.amount));
        params.set("btcAmount", String(transaction.quantity ?? 0));
      }
      const { data } = await supabaseBrowser.auth.getSession();
      const response = await fetch(`/api/gifts?${params.toString()}`, {
        method: "DELETE",
        headers: data.session ? { authorization: "Bearer " + data.session.access_token } : {},
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Suppression impossible.");
      const eventKey = `${transaction.member}|${transaction.kind}|${transaction.date.slice(0, 4)}`;
      setDeletedGiftKeys((current) => current.includes(eventKey) ? current : [...current, eventKey]);
      setGiftTransactions((current) => current.filter((gift) => `${gift.member}|${gift.kind}|${gift.date.slice(0, 4)}` !== eventKey));
      setMutationMessage({ tone: "success", text: `${transaction.kind} ${transaction.date.slice(0, 4)} de ${transaction.member} supprimé du registre.` });
    } catch (error) {
      setMutationMessage({ tone: "error", text: error instanceof Error ? error.message : "Suppression impossible." });
    } finally {
      setDeletingTransactionId(null);
    }
  }
  return (
    <div className={`page-stack transactions-page ${isAdmin ? "admin-transactions" : "member-transactions"}`}>
      {!isAdmin && <MemberMovementsMobile
        transactions={memberQuickFiltered}
        totalValueEur={memberTotalValue}
        totalBtc={memberTotalBtc}
        receivedCount={memberReceived.length}
        totalInvested={memberTotalInvested}
        gainEur={memberGainEur}
        gainPct={memberGainPct}
        bitcoinEur={bitcoinEur}
        quickFilter={memberQuickFilter}
        onQuickFilter={setMemberQuickFilter}
        requestedIds={requestedIds}
        message={mutationMessage}
        onRequestTransfer={(transaction) => {
          setRequestedIds((current) => current.includes(transaction.id) ? current : [...current, transaction.id]);
          onTransferRequest(transaction);
          setMutationMessage({ tone: "success", text: "Demande de transfert envoyée à Florent." });
        }}
      />}
      <section className="transactions-guide panel">
        <div>
          <span className="soft-pill">REGISTRE PARTAGÉ</span>
          <h2>{isAdmin ? <>Toutes les opérations,<br />expliquées simplement.</> : <>Tes cadeaux Bitcoin,<br />tout simplement.</>}</h2>
          <p>{isAdmin ? "Chaque ligne indique qui a investi, pour quel enfant, où se trouve l’actif et qui a saisi l’information." : "Retrouve les cadeaux qui te sont attribués et suis leur évolution, sans jargon administratif."}</p>
        </div>
        {isAdmin && <div className="entry-steps" aria-label="Étapes de saisie">
          <span><b>1</b><small>Cliquer sur<br />« Ajouter »</small></span>
          <i>→</i>
          <span><b>2</b><small>Recopier<br />l’opération</small></span>
          <i>→</i>
          <span><b>3</b><small>Vérifier puis<br />enregistrer</small></span>
        </div>}
        {isAdmin && <button className="primary-button" onClick={onAdd}>＋ Saisir une opération</button>}
      </section>

      <section className="panel transactions-panel">
        <header className="transactions-toolbar">
          <div><span>HISTORIQUE</span><h2>{filtered.length} transactions affichées</h2>{shortcut && (memberFilter !== "Tous" || locationFilter !== "Tous" || scopeFilter !== "all") && <button type="button" className="active-transaction-shortcut" onClick={clearShortcut}><b>{shortcut.label}</b><span>Effacer le filtre ×</span></button>}</div>
          {isAdmin && <div className="transaction-filters">
            <label>Enfant<select value={memberFilter} onChange={(event) => setMemberFilter(event.target.value)}><option>Tous</option>{memberNames.map((name) => <option key={name}>{name}</option>)}</select></label>
            <label>Localisation<select value={locationFilter} onChange={(event) => setLocationFilter(event.target.value)}><option>Tous</option><option>Ledger</option><option>Binance</option><option>À classer</option></select></label>
          </div>}
        </header>
        {mutationMessage && <p className={`transactions-feedback ${mutationMessage.tone}`} role={mutationMessage.tone === "error" ? "alert" : "status"}>{mutationMessage.text}</p>}
        <div className="responsive-table">
          <table className="transactions-table">
            <thead><tr><th>Date</th><th>Bénéficiaire</th><th>Opération</th><th>Montant / PRU</th><th>Quantité</th><th>Valeur actuelle</th><th>Saisie par</th>{isAdmin && <th>Localisation</th>}<th /></tr></thead>
            <tbody>{filtered.map((transaction) => {
              const memberSummary = transaction.authorRole === "Blockchain" ? "Transaction publique Ledger" : transaction.account === "Binance commun" ? "Bitcoin attribué · transfert à venir" : "Cadeau Bitcoin enregistré";
              const needsAdminAction = transaction.authorRole !== "Blockchain" && transaction.status !== "Confirmée";
              const quantity = Number(transaction.quantity ?? 0);
              const hasPurchasePrice = transaction.amount > 0 && quantity > 0;
              const averagePurchasePrice = hasPurchasePrice ? transaction.amount / quantity : null;
              const currentValue = bitcoinEur && quantity > 0 ? bitcoinEur * quantity : null;
              const performance = currentValue !== null && hasPurchasePrice ? currentValue - transaction.amount : null;
              const location = transactionLocation(transaction);
              const occasionEmoji = transaction.kind === "Anniversaire" ? "🎂" : transaction.kind === "Noël" ? "🎄" : null;
              const canDelete = isAdmin && transaction.authorRole !== "Blockchain" && location !== "Ledger";
              const blockchainUrl = transaction.authorRole === "Blockchain" && transaction.reference && /^[0-9a-f]{64}$/i.test(transaction.reference)
                ? `https://blockstream.info/tx/${transaction.reference}`
                : null;
              return <tr key={transaction.id}>
                <td data-label="Date">{dateFormat.format(new Date(`${transaction.date}T00:00:00Z`))}</td>
                <td data-label="Bénéficiaire"><strong>{transaction.member}</strong></td>
                <td data-label="Opération"><div className="transaction-kind">{occasionEmoji && <span className={"occasion-emoji " + (transaction.kind === "Noël" ? "christmas" : "birthday")} aria-hidden="true">{occasionEmoji}</span>}<div><strong>{transaction.kind}</strong><small>{transaction.asset} · {isAdmin ? transaction.account : memberSummary}</small></div></div></td>
                <td className="number-cell transaction-investment" data-label="Montant / PRU"><strong>{hasPurchasePrice ? euro.format(transaction.amount) : "—"}</strong><small>{averagePurchasePrice ? "PRU " + euro.format(averagePurchasePrice) + " / BTC" : "PRU à rattacher"}</small></td>
                <td className="number-cell" data-label="Quantité">{transaction.quantity ? transaction.quantity.toFixed(8) + " BTC" : "À saisir"}</td>
                <td className="number-cell transaction-current-value" data-label="Valeur actuelle"><strong>{currentValue === null ? "—" : euro.format(currentValue)}</strong><small className={performance === null ? "performance neutral" : performance >= 0 ? "performance positive" : "performance negative"}>{performance === null ? (currentValue === null ? "Cours indisponible" : "Transfert sans PRU") : (performance >= 0 ? "+" : "") + euro.format(performance)}</small></td>
                <td data-label="Saisie par">{blockchainUrl ? <a className="author-chip blockchain-link" href={blockchainUrl} target="_blank" rel="noreferrer" title="Voir la transaction sur la blockchain">Blockchain<span aria-hidden="true">↗</span></a> : <span className={transaction.authorRole === "Enfant" ? "author-chip child" : "author-chip"}>{transaction.author}</span>}</td>
                {isAdmin && <td data-label="Localisation"><span className={"transaction-location " + (location === "Ledger" ? "ledger" : location === "Binance" ? "binance" : "unclassified")}>{location}</span></td>}
                <td><div className="transaction-actions">{isAdmin && needsAdminAction && <button className="admin-work-button" onClick={() => onOpenPortfolio?.(transaction.member)}>{transaction.status === "À transférer" ? "Préparer le transfert" : "Classer / valider"}</button>}{canDelete && <button type="button" className="admin-delete-button" disabled={deletingTransactionId === transaction.id} onClick={() => void deleteGiftTransaction(transaction)}>{deletingTransactionId === transaction.id ? "Suppression…" : "Supprimer"}</button>}{!isAdmin && transaction.status === "À transférer" && <button className="request-transfer-button" onClick={() => onTransferRequest(transaction)}>Demander le transfert</button>}</div></td>
              </tr>;
            })}</tbody>
          </table>
        </div>
        {filtered.length === 0 && <div className="empty-transactions">Aucune opération ne correspond à ces filtres.</div>}
        {isAdmin && filtered.length > 0 && <AdminMovementsMobile
          transactions={adminMobileSorted}
          bitcoinEur={bitcoinEur}
          sortDir={mobileSortDir}
          onToggleSort={() => setMobileSortDir((current) => current === "desc" ? "asc" : "desc")}
          onOpenPortfolio={onOpenPortfolio}
          onDelete={(transaction) => void deleteGiftTransaction(transaction)}
          deletingId={deletingTransactionId}
        />}
      </section>
    </div>
  );
}

function MemberMovementsMobile({ transactions, totalValueEur, totalBtc, receivedCount, totalInvested, gainEur, gainPct, bitcoinEur, quickFilter, onQuickFilter, requestedIds, message, onRequestTransfer }: {
  transactions: TransactionRecord[];
  totalValueEur: number | null;
  totalBtc: number;
  receivedCount: number;
  totalInvested: number;
  gainEur: number | null;
  gainPct: number | null;
  bitcoinEur: number | null;
  quickFilter: MemberQuickFilter;
  onQuickFilter: (mode: MemberQuickFilter) => void;
  requestedIds: string[];
  message: { tone: "success" | "error"; text: string } | null;
  onRequestTransfer: (transaction: TransactionRecord) => void;
}) {
  const chips: { id: MemberQuickFilter; label: string }[] = [
    { id: "all", label: "Tous" },
    { id: "ledger", label: "Sur Ledger" },
    { id: "binance", label: "Sur Binance" },
    { id: "pending", label: "À transférer" },
    { id: "noel", label: "🎄 Noël" },
  ];
  const activeChip = chips.find((chip) => chip.id === quickFilter);
  return <div className="mmv-mobile">
    <section className="panel mmv-summary">
      <div className="mmv-summary-head">
        <span className="mmv-summary-icon" aria-hidden="true">🎁</span>
        <div><h2>Mes mouvements</h2><p>Retrouve l’histoire de tes cadeaux Bitcoin et de leurs transferts.</p></div>
      </div>
      <div className="mmv-summary-stats">
        <div><small>VALEUR TOTALE</small><strong>{totalValueEur === null ? `${totalBtc.toFixed(8)} BTC` : euro.format(totalValueEur)}</strong><span>aujourd’hui</span></div>
        <div><small>CADEAUX REÇUS</small><strong>{receivedCount}</strong><span>cadeaux</span></div>
        <div><small>MONTANT INVESTI</small><strong>{euro.format(totalInvested)}</strong><span>au total</span></div>
        <div><small>GAIN TOTAL</small><strong className={gainEur === null ? "gain neutral" : gainEur >= 0 ? "gain up" : "gain down"}>{gainPct === null ? "—" : (gainPct >= 0 ? "+" : "") + gainPct.toFixed(1) + " %"}</strong><span>{gainEur === null ? "Cours indisponible" : (gainEur >= 0 ? "+" : "") + euro.format(gainEur)}</span></div>
      </div>
    </section>

    <div className="mmv-chips">
      {chips.map((chip) => <button key={chip.id} type="button" className={quickFilter === chip.id ? "active" : ""} onClick={() => onQuickFilter(chip.id)}>{chip.label}</button>)}
    </div>
    {quickFilter !== "all" && activeChip && <button type="button" className="mmv-active-chip" onClick={() => onQuickFilter("all")}>{activeChip.label}<span aria-hidden="true">×</span></button>}

    <section className="mmv-history">
      <header><span>Historique</span><h3>{transactions.length} mouvement{transactions.length > 1 ? "s" : ""} affiché{transactions.length > 1 ? "s" : ""}</h3></header>
      <div className="mmv-cards">{transactions.map((transaction) => {
        const quantity = Number(transaction.quantity ?? 0);
        const hasPurchasePrice = transaction.amount > 0 && quantity > 0;
        const currentValue = bitcoinEur && quantity > 0 ? bitcoinEur * quantity : null;
        const performance = currentValue !== null && hasPurchasePrice ? currentValue - transaction.amount : null;
        const performancePct = performance !== null && transaction.amount > 0 ? performance / transaction.amount * 100 : null;
        const location = transactionLocation(transaction);
        const blockchainUrl = transaction.authorRole === "Blockchain" && transaction.reference && /^[0-9a-f]{64}$/i.test(transaction.reference) ? `https://blockstream.info/tx/${transaction.reference}` : null;
        const pending = requestedIds.includes(transaction.id);
        const isBlockchainRow = transaction.authorRole === "Blockchain";
        return <article className="mmv-card" key={transaction.id}>
          <div className="mmv-card-top">
            <span className={`mmv-card-icon ${isBlockchainRow ? "transfer" : transaction.kind === "Noël" ? "christmas" : "birthday"}`} aria-hidden="true">{isBlockchainRow ? "⇄" : transaction.kind === "Noël" ? "🎄" : "🎂"}</span>
            <div className="mmv-card-title">
              <small>{dateFormat.format(new Date(`${transaction.date}T00:00:00Z`)).toUpperCase()}</small>
              <strong>{isBlockchainRow ? "Transfert vers mon Ledger" : transaction.kind}</strong>
              <span>{isBlockchainRow ? "Depuis Binance commun" : "Cadeau pour moi"}</span>
            </div>
            <div className="mmv-card-status">
              {isBlockchainRow
                ? <span className="mmv-pill ledger">✓ Confirmé sur la blockchain</span>
                : quantity <= 0
                ? <span className="mmv-pill missing">{new Date(`${transaction.date}T23:59:59Z`) >= new Date() ? "À venir" : "À compléter"}</span>
                : location === "Ledger"
                ? <span className="mmv-pill ledger">✓ Sur mon Ledger</span>
                : <span className="mmv-pill binance">Sur Binance commun</span>}
              {isBlockchainRow && blockchainUrl && <a href={blockchainUrl} target="_blank" rel="noreferrer" className="mmv-proof-link">Voir la preuve ↗</a>}
              {!isBlockchainRow && quantity > 0 && location === "Ledger" && <small className="mmv-status-caption">Transfert réalisé</small>}
              {!isBlockchainRow && quantity > 0 && location !== "Ledger" && transaction.status === "À transférer" && <button type="button" className="mmv-request-button" disabled={pending} onClick={() => onRequestTransfer(transaction)}>{pending ? "Demandé" : "Demander le transfert"}</button>}
            </div>
          </div>
          <div className="mmv-card-stats">
            {isBlockchainRow ? <>
              <div><small>BTC TRANSFÉRÉS</small><strong>{quantity.toFixed(8)} BTC</strong></div>
              <div><small>DATE</small><strong>{dateFormat.format(new Date(`${transaction.date}T00:00:00Z`))}</strong></div>
            </> : <>
              <div><small>OFFERTS</small><strong>{transaction.amount > 0 ? euro.format(transaction.amount) : "—"}</strong></div>
              <div><small>AUJOURD’HUI</small><strong>{currentValue === null ? (quantity > 0 ? "Indisponible" : "—") : euro.format(currentValue)}</strong></div>
              <div><small>GAIN</small><strong className={performance === null ? "" : performance >= 0 ? "up" : "down"}>{performancePct === null ? "—" : (performancePct >= 0 ? "+" : "") + performancePct.toFixed(1) + " %"}</strong></div>
            </>}
          </div>
          {!isBlockchainRow && quantity > 0 && <div className="mmv-card-detail"><span><small>QUANTITÉ BTC</small><strong>{quantity.toFixed(8)} BTC</strong></span>{hasPurchasePrice && <span><small>PRIX MOYEN D’ACHAT</small><strong>{euro.format(transaction.amount / quantity)}</strong></span>}</div>}
        </article>;
      })}</div>
      {transactions.length === 0 && <div className="empty-transactions">Aucun mouvement pour ce filtre.</div>}
    </section>

    {message && <div className={`mpm-toast ${message.tone === "error" ? "error" : ""}`} role="status">
      <span className="mpm-toast-icon" aria-hidden="true">{message.tone === "error" ? "!" : "✓"}</span>
      <div><strong>{message.text}</strong>{/transfert/i.test(message.text) && message.tone === "success" && <small>Tu seras prévenu·e dès son traitement.</small>}</div>
    </div>}
  </div>;
}

function AdminMovementsMobile({ transactions, bitcoinEur, sortDir, onToggleSort, onOpenPortfolio, onDelete, deletingId }: {
  transactions: TransactionRecord[];
  bitcoinEur: number | null;
  sortDir: "desc" | "asc";
  onToggleSort: () => void;
  onOpenPortfolio?: (member: string) => void;
  onDelete: (transaction: TransactionRecord) => void;
  deletingId: string | null;
}) {
  return <div className="amv-mobile">
    <div className="amv-toolbar">
      <button type="button" className="amv-sort-button" onClick={onToggleSort}>Trier <span aria-hidden="true">{sortDir === "desc" ? "↓" : "↑"}</span></button>
    </div>
    <div className="amv-cards">{transactions.map((transaction) => {
      const quantity = Number(transaction.quantity ?? 0);
      const hasPurchasePrice = transaction.amount > 0 && quantity > 0;
      const currentValue = bitcoinEur && quantity > 0 ? bitcoinEur * quantity : null;
      const performance = currentValue !== null && hasPurchasePrice ? currentValue - transaction.amount : null;
      const performancePct = performance !== null && transaction.amount > 0 ? performance / transaction.amount * 100 : null;
      const location = transactionLocation(transaction);
      const needsAdminAction = transaction.authorRole !== "Blockchain" && transaction.status !== "Confirmée";
      const canDelete = transaction.authorRole !== "Blockchain" && location !== "Ledger";
      return <article className="amv-card" key={transaction.id}>
        <div className="amv-card-top">
          <span className={`amv-card-icon ${transaction.kind === "Noël" ? "christmas" : "birthday"}`} aria-hidden="true">{transaction.kind === "Noël" ? "🎄" : "🎂"}</span>
          <div className="amv-card-title">
            <small>{dateFormat.format(new Date(`${transaction.date}T00:00:00Z`)).toUpperCase()}</small>
            <strong>{transaction.member}</strong>
            <span className="amv-kind">{transaction.kind}</span>
            <small className="amv-account">Bitcoin · {transaction.account}</small>
          </div>
          <div className="amv-card-status">
            <span className={"transaction-location " + (location === "Ledger" ? "ledger" : location === "Binance" ? "binance" : "unclassified")}>{location === "À classer" ? "⏳ À classer" : location}</span>
            <strong>{hasPurchasePrice ? euro.format(transaction.amount) : "—"}<small> investis</small></strong>
          </div>
        </div>
        <div className="amv-card-stats">
          <div><small>QUANTITÉ BTC</small><strong>{quantity ? quantity.toFixed(8) + " BTC" : "À saisir"}</strong></div>
          <div><small>VALEUR AUJOURD’HUI</small><strong>{currentValue === null ? "—" : euro.format(currentValue)}</strong>{performancePct !== null && <small className={performancePct >= 0 ? "up" : "down"}>{(performancePct >= 0 ? "+" : "") + performancePct.toFixed(1) + " %"}</small>}</div>
          <div><small>LOCALISATION</small><strong>{location === "À classer" ? "Non classée" : location}</strong></div>
        </div>
        <div className="amv-card-actions">
          {needsAdminAction && <button type="button" className="admin-work-button" onClick={() => onOpenPortfolio?.(transaction.member)}>{transaction.status === "À transférer" ? "↗ Préparer le transfert" : "✓ Classer / valider"}</button>}
          {canDelete && <button type="button" className="admin-delete-button" disabled={deletingId === transaction.id} onClick={() => onDelete(transaction)}>{deletingId === transaction.id ? "Suppression…" : "🗑 Supprimer"}</button>}
        </div>
      </article>;
    })}</div>
  </div>;
}

export type GiftSaveResult = { message: string; member: string; amountEur: number };

export type GiftSource = "cadeau_amatxi" | "investissement_personnel" | "achat_groupe";

export type GiftEditingInput = {
  id?: string;
  member: string;
  occasion: "Anniversaire" | "Noël" | "Autre cadeau";
  custody: "Binance commun" | "Ledger";
  amountEur: number;
  btcAmount: number;
  giftDate: string;
  txid?: string | null;
  note?: string | null;
  source?: GiftSource;
};

const SOURCE_LABELS: Record<GiftSource, string> = {
  cadeau_amatxi: "Cadeau d’Amatxi",
  investissement_personnel: "Investissement personnel",
  achat_groupe: "Achat groupé / autre",
};

export function InvestmentModal({ defaultMember, defaultSource, editing, personalMode, memberInvestor, adminForMember, onClose, onSaved }: { defaultMember?: string; defaultSource?: GiftSource; editing?: GiftEditingInput; personalMode?: boolean; memberInvestor?: string; adminForMember?: string; onClose: () => void; onSaved: (result: GiftSaveResult) => void }) {
  const [step, setStep] = useState(1);
  // Mode personnel (membre) : origine et bénéficiaire verrouillés sur l'appelant.
  const initialSource: GiftSource = personalMode ? "investissement_personnel" : editing?.source ?? defaultSource ?? "cadeau_amatxi";
  const [draft, setDraft] = useState({
    member: memberInvestor ?? editing?.member ?? defaultMember ?? memberNames[0],
    source: initialSource,
    occasion: editing?.occasion ?? (initialSource === "cadeau_amatxi" ? "Anniversaire" : "Autre cadeau") as "Anniversaire" | "Noël" | "Autre cadeau",
    custody: editing?.custody ?? ("Binance commun" as "Binance commun" | "Ledger"),
    amount: editing ? String(editing.amountEur) : "55",
    quantity: editing?.btcAmount ? String(editing.btcAmount) : "",
    price: editing?.btcAmount && editing?.amountEur ? String(Number((editing.amountEur / editing.btcAmount).toFixed(2))) : "",
    date: editing?.giftDate ?? new Date().toISOString().slice(0, 10),
    txid: editing?.txid ?? "",
    note: editing?.note ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const update = <K extends keyof typeof draft>(key: K, value: typeof draft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const dialogRef = useDialogA11y(true, onClose);
  const isEditing = Boolean(editing?.id);

  // Type d'opération : hors cadeau, l'occasion n'a pas de sens → forcée sur « Autre cadeau ».
  function changeSource(value: GiftSource) {
    setDraft((current) => ({ ...current, source: value, occasion: value === "cadeau_amatxi" ? current.occasion : "Autre cadeau" }));
  }
  // Trio montant / prix BTC / quantité : renseigner deux valeurs calcule la troisième.
  const round = (value: number, decimals: number) => (Number.isFinite(value) && value > 0 ? String(Number(value.toFixed(decimals))) : "");
  function changeAmount(value: string) {
    const amount = Number(value), price = Number(draft.price), quantity = Number(draft.quantity);
    setDraft((current) => ({ ...current, amount: value, ...(value && price > 0 ? { quantity: round(amount / price, 8) } : value && quantity > 0 ? { price: round(amount / quantity, 2) } : {}) }));
  }
  function changeQuantity(value: string) {
    const quantity = Number(value), price = Number(draft.price), amount = Number(draft.amount);
    setDraft((current) => ({ ...current, quantity: value, ...(value && price > 0 ? { amount: round(price * quantity, 2) } : value && amount > 0 ? { price: round(amount / quantity, 2) } : {}) }));
  }
  function changePrice(value: string) {
    const price = Number(value), amount = Number(draft.amount), quantity = Number(draft.quantity);
    setDraft((current) => ({ ...current, price: value, ...(value && amount > 0 ? { quantity: round(amount / price, 8) } : value && quantity > 0 ? { amount: round(price * quantity, 2) } : {}) }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (step < 3) { setStep((current) => current + 1); return; }
    setBusy(true);
    setError("");
    try {
      const amountEur = Number(draft.amount);
      const btcAmount = Number(draft.quantity);
      if (personalMode && adminForMember) {
        // Aperçu admin (parité complète) : la route self-service ne peut viser que l'appelant
        // (son identité vient du jeton), donc un administrateur écrit via la route cadeaux
        // (Cas A, memberId explicite), avec la même origine « investissement_personnel ».
        await saveGift({ member: adminForMember, occasion: "Autre cadeau", giftDate: draft.date, purchaseDate: draft.date, amountEur, btcAmount, custody: draft.custody, note: draft.note.trim() || null, source: "investissement_personnel" });
        onSaved({ message: "Investissement enregistré et visible dans « Mes BTC ».", member: adminForMember, amountEur });
      } else if (personalMode) {
        // Écriture membre : l'identité et l'origine sont forcées côté serveur.
        await savePersonalInvestment({ amountEur, btcAmount, custody: draft.custody, date: draft.date, note: draft.note.trim() || null });
        onSaved({ message: "Investissement enregistré et visible dans « Mes BTC ».", member: draft.member, amountEur });
      } else {
        await saveGift({
          id: editing?.id,
          member: draft.member,
          occasion: draft.occasion,
          giftDate: draft.date,
          purchaseDate: draft.date,
          amountEur,
          btcAmount,
          custody: draft.custody,
          txid: draft.custody === "Ledger" && draft.txid.trim() ? draft.txid.trim() : null,
          note: draft.note.trim() || null,
          // Sur une création, on enregistre l'origine choisie ; sur une modification, on ne
          // l'envoie pas pour préserver l'origine déjà stockée côté serveur.
          source: isEditing ? undefined : draft.source,
        });
        onSaved({ message: isEditing ? "Cadeau modifié et visible dans Cadeaux d’Amatxi." : "Cadeau enregistré et visible dans Transactions.", member: draft.member, amountEur });
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Enregistrement impossible.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => !busy && event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className="modal guided-modal" role="dialog" aria-modal="true" aria-labelledby="entry-title" tabIndex={-1}>
        <header><div><span>{personalMode ? "INVESTISSEMENT PERSONNEL" : isEditing ? "MODIFIER LE CADEAU" : "SAISIE GUIDÉE"} · ÉTAPE {step} SUR 3</span><h2 id="entry-title">{stepTitle(step)}</h2></div><button onClick={onClose} aria-label="Fermer" disabled={busy}>×</button></header>
        <div className="step-progress"><span className={step >= 1 ? "done" : ""} /><span className={step >= 2 ? "done" : ""} /><span className={step >= 3 ? "done" : ""} /></div>
        <p className="modal-help">{stepHelp(step)}</p>
        <form onSubmit={submit}>
          {step === 1 && (personalMode ? <div className="form-grid">
            <div className="entry-review span-2"><span className="review-icon">📈</span><h3>Investissement personnel</h3><dl><div><dt>Type</dt><dd>Investissement personnel</dd></div><div><dt>À votre nom</dt><dd>{draft.member}</dd></div></dl><p className="modal-help">Un achat que vous avez financé vous-même. Il est suivi séparément des cadeaux et rejoint votre portefeuille « Mes BTC ».</p></div>
          </div> : <div className="form-grid">
            <label className="span-2">Type d’opération<select value={draft.source} onChange={(event) => changeSource(event.target.value as GiftSource)}><option value="cadeau_amatxi">Cadeau d’Amatxi</option><option value="investissement_personnel">Investissement personnel</option><option value="achat_groupe">Achat groupé / autre</option></select></label>
            <label className={draft.source === "cadeau_amatxi" ? "" : "span-2"}>{draft.source === "investissement_personnel" ? "Pour quel membre ?" : "Pour quel bénéficiaire ?"}<select value={draft.member} onChange={(event) => update("member", event.target.value)}>{memberNames.map((name) => <option key={name}>{name}</option>)}</select></label>
            {draft.source === "cadeau_amatxi" && <label>Occasion<select value={draft.occasion} onChange={(event) => update("occasion", event.target.value as typeof draft.occasion)}><option>Anniversaire</option><option>Noël</option><option>Autre cadeau</option></select></label>}
          </div>)}
          {step === 2 && <div className="form-grid">
            <label>Montant total, frais inclus (€)<input value={draft.amount} onChange={(event) => changeAmount(event.target.value)} type="number" min="0" step="0.01" required /></label>
            <label>Prix du BTC (€)<input value={draft.price} onChange={(event) => changePrice(event.target.value)} type="number" min="0" step="any" placeholder="Cours au moment de l’achat" /></label>
            <label>BTC achetés<input value={draft.quantity} onChange={(event) => changeQuantity(event.target.value)} type="number" min="0" step="any" placeholder="Ex. 0,001234" required /></label>
            <label>Date de l’opération<input value={draft.date} onChange={(event) => update("date", event.target.value)} type="date" required /></label>
            <p className="modal-help span-2">Renseignez deux valeurs parmi montant, prix et quantité : la troisième se calcule automatiquement.</p>
            <label>Où sont les bitcoins ?<select value={draft.custody} onChange={(event) => update("custody", event.target.value as typeof draft.custody)}><option value="Binance commun">Binance commun</option><option value="Ledger">Ledger personnel</option></select></label>
            {draft.custody === "Ledger" && <label>TxID (optionnel)<input value={draft.txid} onChange={(event) => update("txid", event.target.value)} placeholder="Laisser vide si le virement n’a pas encore eu lieu" /></label>}
          </div>}
          {step === 3 && <div className="entry-review"><span className="review-icon">✓</span><h3>Vérifie avant d’enregistrer</h3><dl><div><dt>Type</dt><dd>{SOURCE_LABELS[draft.source]}</dd></div><div><dt>{personalMode ? "À votre nom" : "Bénéficiaire"}</dt><dd>{draft.member}</dd></div>{!personalMode && <div><dt>Occasion</dt><dd>{draft.occasion}</dd></div>}<div><dt>Localisation</dt><dd>{draft.custody}</dd></div><div><dt>Montant</dt><dd>{euro.format(Number(draft.amount) || 0)}</dd></div><div><dt>Prix du BTC</dt><dd>{draft.price ? euro.format(Number(draft.price)) : "—"}</dd></div><div><dt>Quantité</dt><dd>{draft.quantity ? `${Number(draft.quantity).toFixed(8)} BTC` : "—"}</dd></div></dl><label>Note pédagogique ou commentaire<textarea value={draft.note} onChange={(event) => update("note", event.target.value)} placeholder="Pourquoi cet achat ? Qu’as-tu appris ?" /></label>{error && <p className="editor-feedback" role="alert">{error}</p>}</div>}
          <footer><button type="button" className="secondary-button" disabled={busy} onClick={() => step === 1 ? onClose() : setStep((current) => current - 1)}>{step === 1 ? "Annuler" : "← Retour"}</button><button type="submit" className="primary-button" disabled={busy}>{busy ? "Enregistrement…" : step === 3 ? (isEditing ? "Enregistrer les modifications" : "Enregistrer l’opération") : "Continuer →"}</button></footer>
        </form>
      </section>
    </div>
  );
}

type TransactionLocation = "Ledger" | "Binance" | "À classer";

function transactionLocation(transaction: TransactionRecord): TransactionLocation {
  const account = transaction.account.toLocaleLowerCase("fr");
  if (account.includes("à rapprocher") || (account.includes("ledger") && account.includes("binance"))) return "À classer";
  if (transaction.authorRole === "Blockchain" || account.includes("ledger")) return "Ledger";
  if (account.includes("binance") || transaction.status === "À transférer") return "Binance";
  return "À classer";
}
function stepTitle(step: number) { return step === 1 ? "Qui fait quoi ?" : step === 2 ? "Recopier les chiffres" : "Dernière vérification"; }
function stepHelp(step: number) { return step === 1 ? "Indique le bénéficiaire et la personne qui effectue la saisie." : step === 2 ? "Recopie les informations affichées sur Binance, Ledger ou ton courtier." : "Tout est lisible : tu peux corriger ou confirmer l’opération."; }
