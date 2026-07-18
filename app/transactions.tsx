"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "../lib/supabase-browser";
import { GIFT_HISTORY } from "../lib/gift-history";
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

export const initialTransactions: TransactionRecord[] = GIFT_HISTORY.map((gift) => ({
  id: `history-${gift.member.toLowerCase()}-${gift.occasion}-${gift.giftDate}`,
  date: gift.giftDate,
  member: gift.member,
  kind: gift.occasion,
  asset: "Bitcoin",
  account: "À rapprocher : Ledger ou Binance commun",
  amount: gift.amountEur,
  quantity: gift.btcAmount,
  author: "Administrateur",
  authorRole: "Administrateur",
  status: "À compléter",
  reference: "Tableau familial",
  note: gift.note,
}));

const memberNames = ["Thibault", "Uhaina", "Paul", "Aurore", "Thomas"];
const memberBirthdays = [
  { member: "Thibault", monthDay: "03-15" },
  { member: "Uhaina", monthDay: "08-16" },
  { member: "Paul", monthDay: "11-18" },
  { member: "Aurore", monthDay: "08-27" },
  { member: "Thomas", monthDay: "12-29" },
];
const euro = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });
const dateFormat = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });

export function TransactionsView({ transactions, isAdmin, viewerName, onAdd, onTransferRequest, onOpenPortfolio, shortcut }: { transactions: TransactionRecord[]; isAdmin: boolean; viewerName: string; onAdd: () => void; onTransferRequest: (transaction: TransactionRecord) => void; onOpenPortfolio?: (member: string) => void; shortcut?: TransactionShortcut | null }) {
  const [memberFilter, setMemberFilter] = useState(shortcut?.member ?? "Tous");
  const [locationFilter, setLocationFilter] = useState<string>(shortcut?.location ?? "Tous");
  const [scopeFilter, setScopeFilter] = useState<TransactionShortcut["scope"]>(shortcut?.scope ?? "all");
  const [giftTransactions, setGiftTransactions] = useState<TransactionRecord[]>([]);
  const [deletedGiftKeys, setDeletedGiftKeys] = useState<string[]>([]);
  const [ledgerTransactions, setLedgerTransactions] = useState<TransactionRecord[]>([]);
  const [bitcoinEur, setBitcoinEur] = useState<number | null>(null);
  const [deletingTransactionId, setDeletingTransactionId] = useState<string | null>(null);
  const [mutationMessage, setMutationMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

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
      const giftResult = await giftResponse.json() as { records?: GiftApiRecord[] };
      const ledgerResult = await ledgerResponse.json() as { bitcoinEur?: number | null; wallets?: Array<{ member: string; transactions?: Array<{ txid: string; date: string | null; amountBtc: number; direction: string; confirmations: number }> }> };
      const nextBitcoinEur = Number(ledgerResult.bitcoinEur);
      setBitcoinEur(Number.isFinite(nextBitcoinEur) && nextBitcoinEur > 0 ? nextBitcoinEur : null);
      const giftRecords = giftResult.records ?? [];
      setDeletedGiftKeys(giftRecords.filter((record) => record.is_deleted).map((record) => record.member_name + "|" + record.occasion + "|" + record.gift_date.slice(0, 4)));
      setGiftTransactions(giftRecords.filter((record) => !record.is_deleted).filter((record) => record.gift_date > "2025-12-31" || GIFT_HISTORY.some((gift) => gift.member === record.member_name && gift.occasion === record.occasion && gift.giftDate.slice(0, 4) === record.gift_date.slice(0, 4))).map((record) => ({
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
  }, [isAdmin]);

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
                <td>{dateFormat.format(new Date(`${transaction.date}T00:00:00Z`))}</td>
                <td><strong>{transaction.member}</strong></td>
                <td><div className="transaction-kind">{occasionEmoji && <span className={"occasion-emoji " + (transaction.kind === "Noël" ? "christmas" : "birthday")} aria-hidden="true">{occasionEmoji}</span>}<div><strong>{transaction.kind}</strong><small>{transaction.asset} · {isAdmin ? transaction.account : memberSummary}</small></div></div></td>
                <td className="number-cell transaction-investment"><strong>{hasPurchasePrice ? euro.format(transaction.amount) : "—"}</strong><small>{averagePurchasePrice ? "PRU " + euro.format(averagePurchasePrice) + " / BTC" : "PRU à rattacher"}</small></td>
                <td className="number-cell">{transaction.quantity ? transaction.quantity.toFixed(8) + " BTC" : "À saisir"}</td>
                <td className="number-cell transaction-current-value"><strong>{currentValue === null ? "—" : euro.format(currentValue)}</strong><small className={performance === null ? "performance neutral" : performance >= 0 ? "performance positive" : "performance negative"}>{performance === null ? (currentValue === null ? "Cours indisponible" : "Transfert sans PRU") : (performance >= 0 ? "+" : "") + euro.format(performance)}</small></td>
                <td>{blockchainUrl ? <a className="author-chip blockchain-link" href={blockchainUrl} target="_blank" rel="noreferrer" title="Voir la transaction sur la blockchain">Blockchain<span aria-hidden="true">↗</span></a> : <span className={transaction.authorRole === "Enfant" ? "author-chip child" : "author-chip"}>{transaction.author}</span>}</td>
                {isAdmin && <td><span className={"transaction-location " + (location === "Ledger" ? "ledger" : location === "Binance" ? "binance" : "unclassified")}>{location}</span></td>}
                <td><div className="transaction-actions">{isAdmin && needsAdminAction && <button className="admin-work-button" onClick={() => onOpenPortfolio?.(transaction.member)}>{transaction.status === "À transférer" ? "Préparer le transfert" : "Classer / valider"}</button>}{canDelete && <button type="button" className="admin-delete-button" disabled={deletingTransactionId === transaction.id} onClick={() => void deleteGiftTransaction(transaction)}>{deletingTransactionId === transaction.id ? "Suppression…" : "Supprimer"}</button>}{!isAdmin && transaction.status === "À transférer" && <button className="request-transfer-button" onClick={() => onTransferRequest(transaction)}>Demander le transfert</button>}</div></td>
              </tr>;
            })}</tbody>
          </table>
        </div>
        {filtered.length === 0 && <div className="empty-transactions">Aucune opération ne correspond à ces filtres.</div>}
      </section>
    </div>
  );
}

export function InvestmentModal({ onClose, onSave }: { onClose: () => void; onSave: (transaction: TransactionRecord) => void }) {
  const [step, setStep] = useState(1);
  const [draft, setDraft] = useState({ member: "Thibault", author: "Administrateur", kind: "Investissement mensuel", account: "Binance commun", asset: "Bitcoin", amount: "55", quantity: "", date: "2026-07-16", reference: "", note: "" });
  const update = (key: keyof typeof draft, value: string) => setDraft((current) => ({ ...current, [key]: value }));
  const dialogRef = useDialogA11y(true, onClose);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step < 3) { setStep((current) => current + 1); return; }
    onSave({
      id: `manual-${Date.now()}`,
      date: draft.date,
      member: draft.member,
      kind: draft.kind,
      asset: draft.asset,
      account: draft.account,
      amount: Number(draft.amount),
      quantity: draft.quantity ? Number(draft.quantity) : undefined,
      author: draft.author,
      authorRole: draft.author === "Administrateur" ? "Administrateur" : "Enfant",
      status: draft.quantity ? "Confirmée" : "À compléter",
      reference: draft.reference || undefined,
      note: draft.note || undefined,
    });
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className="modal guided-modal" role="dialog" aria-modal="true" aria-labelledby="entry-title" tabIndex={-1}>
        <header><div><span>SAISIE GUIDÉE · ÉTAPE {step} SUR 3</span><h2 id="entry-title">{stepTitle(step)}</h2></div><button onClick={onClose} aria-label="Fermer">×</button></header>
        <div className="step-progress"><span className={step >= 1 ? "done" : ""} /><span className={step >= 2 ? "done" : ""} /><span className={step >= 3 ? "done" : ""} /></div>
        <p className="modal-help">{stepHelp(step)}</p>
        <form onSubmit={submit}>
          {step === 1 && <div className="form-grid"><label>Pour quel enfant ?<select value={draft.member} onChange={(event) => update("member", event.target.value)}>{memberNames.map((name) => <option key={name}>{name}</option>)}</select></label><label>Qui saisit l’opération ?<select value={draft.author} onChange={(event) => update("author", event.target.value)}><option>Administrateur</option>{memberNames.map((name) => <option key={name}>{name}</option>)}</select></label><label className="span-2">Nature de l’opération<select value={draft.kind} onChange={(event) => update("kind", event.target.value)}><option>Investissement mensuel</option><option>Anniversaire</option><option>Noël</option><option>Transfert vers Ledger</option><option>Achat PEA</option><option>Vente</option></select></label></div>}
          {step === 2 && <div className="form-grid"><label>Compte / enveloppe<select value={draft.account} onChange={(event) => update("account", event.target.value)}><option>Binance commun</option><option>Ledger personnel</option><option>PEA</option><option>Compte-titres</option><option>Autre</option></select></label><label>Actif<input value={draft.asset} onChange={(event) => update("asset", event.target.value)} placeholder="Bitcoin, ETF World…" required /></label><label>Montant total, frais inclus (€)<input value={draft.amount} onChange={(event) => update("amount", event.target.value)} type="number" min="0" step="0.01" required /></label><label>Quantité reçue<input value={draft.quantity} onChange={(event) => update("quantity", event.target.value)} type="number" min="0" step="any" placeholder="Ex. 0,001234" /></label><label>Date<input value={draft.date} onChange={(event) => update("date", event.target.value)} type="date" required /></label><label>Référence / TxID<input value={draft.reference} onChange={(event) => update("reference", event.target.value)} placeholder="Optionnel" /></label></div>}
          {step === 3 && <div className="entry-review"><span className="review-icon">✓</span><h3>Vérifie avant d’enregistrer</h3><dl><div><dt>Bénéficiaire</dt><dd>{draft.member}</dd></div><div><dt>Saisie par</dt><dd>{draft.author}</dd></div><div><dt>Opération</dt><dd>{draft.kind}</dd></div><div><dt>Compte</dt><dd>{draft.account}</dd></div><div><dt>Montant</dt><dd>{euro.format(Number(draft.amount))}</dd></div><div><dt>Quantité</dt><dd>{draft.quantity ? `${Number(draft.quantity).toFixed(8)} ${draft.asset === "Bitcoin" ? "BTC" : ""}` : "À compléter plus tard"}</dd></div></dl><label>Note pédagogique ou commentaire<textarea value={draft.note} onChange={(event) => update("note", event.target.value)} placeholder="Pourquoi cet achat ? Qu’as-tu appris ?" /></label></div>}
          <footer><button type="button" className="secondary-button" onClick={() => step === 1 ? onClose() : setStep((current) => current - 1)}>{step === 1 ? "Annuler" : "← Retour"}</button><button type="submit" className="primary-button">{step === 3 ? "Enregistrer l’opération" : "Continuer →"}</button></footer>
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
