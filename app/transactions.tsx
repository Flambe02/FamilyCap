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
const euro = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });
const dateFormat = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });

export function TransactionsView({ transactions, onAdd, onTransferRequest }: { transactions: TransactionRecord[]; onAdd: () => void; onTransferRequest: (transaction: TransactionRecord) => void }) {
  const [memberFilter, setMemberFilter] = useState("Tous");
  const [statusFilter, setStatusFilter] = useState("Tous");
  const [selected, setSelected] = useState<TransactionRecord | null>(null);
  const [giftTransactions, setGiftTransactions] = useState<TransactionRecord[]>([]);
  const [ledgerTransactions, setLedgerTransactions] = useState<TransactionRecord[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const { data } = await supabaseBrowser.auth.getSession();
      const headers: Record<string, string> = data.session ? { authorization: "Bearer " + data.session.access_token } : {};
      const [giftResponse, ledgerResponse] = await Promise.all([
        fetch("/api/gifts", { signal: controller.signal, headers }),
        fetch("/api/ledger", { signal: controller.signal, headers }),
      ]);
      if (!giftResponse.ok || !ledgerResponse.ok) throw new Error("Historique financier indisponible");
      const giftResult = await giftResponse.json() as { records?: Array<{ id: string; member_name: string; occasion: string; gift_date: string; amount_eur: number | string; btc_amount: number | string; custody: string; confirmations?: number; txid?: string | null; note?: string | null }> };
      const ledgerResult = await ledgerResponse.json() as { wallets?: Array<{ member: string; transactions?: Array<{ txid: string; date: string | null; amountBtc: number; direction: string; confirmations: number }> }> };
      setGiftTransactions((giftResult.records ?? []).filter((record) => record.gift_date > "2025-12-31" || GIFT_HISTORY.some((gift) => gift.member === record.member_name && gift.occasion === record.occasion && gift.giftDate.slice(0, 4) === record.gift_date.slice(0, 4))).map((record) => ({
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
      setLedgerTransactions((ledgerResult.wallets ?? []).flatMap((wallet) => (wallet.transactions ?? []).map((transaction) => ({
        id: "ledger-" + transaction.txid,
        date: transaction.date?.slice(0, 10) ?? new Date().toISOString().slice(0, 10),
        member: wallet.member,
        kind: "Transaction Ledger",
        asset: "Bitcoin",
        account: "Ledger personnel · blockchain",
        amount: 0,
        quantity: transaction.amountBtc,
        author: "Blockchain",
        authorRole: "Blockchain" as const,
        status: transaction.confirmations > 0 ? "Confirmée" as const : "À compléter" as const,
        reference: transaction.txid,
        note: `${transaction.direction} sur l’adresse Ledger publique · ${transaction.confirmations} confirmations. Donnée en lecture seule.`,
      }))));
    })().catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) console.error(error);
    });
    return () => controller.abort();
  }, []);

  const detailedTransactions = useMemo(() => {
    const giftsByEvent = new Map<string, TransactionRecord>();
    for (const transaction of transactions) giftsByEvent.set(`${transaction.member}|${transaction.kind}|${transaction.date.slice(0, 4)}`, transaction);
    for (const transaction of giftTransactions) {
      const key = `${transaction.member}|${transaction.kind}|${transaction.date.slice(0, 4)}`;
      const truth = giftsByEvent.get(key);
      giftsByEvent.set(key, truth ? { ...transaction, date: truth.date, amount: truth.amount, quantity: truth.quantity, note: truth.note } : transaction);
    }
    const giftRecords = [...giftsByEvent.values()];
    return [...giftRecords, ...ledgerTransactions]
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [transactions, giftTransactions, ledgerTransactions]);

  const filtered = useMemo(() => detailedTransactions.filter((transaction) => {
    const memberMatches = memberFilter === "Tous" || transaction.member === memberFilter;
    const statusMatches = statusFilter === "Tous" || transaction.status === statusFilter;
    return memberMatches && statusMatches;
  }), [detailedTransactions, memberFilter, statusFilter]);

  return (
    <div className="page-stack">
      <section className="transactions-guide panel">
        <div>
          <span className="soft-pill">REGISTRE PARTAGÉ</span>
          <h2>Toutes les opérations,<br />expliquées simplement.</h2>
          <p>Chaque ligne indique qui a investi, pour quel enfant, où se trouve l’actif et qui a saisi l’information.</p>
        </div>
        <div className="entry-steps" aria-label="Étapes de saisie">
          <span><b>1</b><small>Cliquer sur<br />« Ajouter »</small></span>
          <i>→</i>
          <span><b>2</b><small>Recopier<br />l’opération</small></span>
          <i>→</i>
          <span><b>3</b><small>Vérifier puis<br />enregistrer</small></span>
        </div>
        <button className="primary-button" onClick={onAdd}>＋ Saisir une opération</button>
      </section>

      <section className="panel transactions-panel">
        <header className="transactions-toolbar">
          <div><span>HISTORIQUE</span><h2>{filtered.length} transactions affichées</h2></div>
          <div className="transaction-filters">
            <label>Enfant<select value={memberFilter} onChange={(event) => setMemberFilter(event.target.value)}><option>Tous</option>{memberNames.map((name) => <option key={name}>{name}</option>)}</select></label>
            <label>État<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option>Tous</option><option>Confirmée</option><option>À transférer</option><option>À compléter</option></select></label>
          </div>
        </header>
        <div className="responsive-table">
          <table className="transactions-table">
            <thead><tr><th>Date</th><th>Bénéficiaire</th><th>Opération</th><th>Montant</th><th>Quantité</th><th>Saisie par</th><th>État</th><th /></tr></thead>
            <tbody>{filtered.map((transaction) => (
              <tr key={transaction.id}>
                <td>{dateFormat.format(new Date(`${transaction.date}T00:00:00Z`))}</td>
                <td><strong>{transaction.member}</strong></td>
                <td><strong>{transaction.kind}</strong><small>{transaction.asset} · {transaction.account}</small></td>
                <td className="number-cell">{transaction.authorRole === "Blockchain" ? "—" : euro.format(transaction.amount)}</td>
                <td className="number-cell">{transaction.quantity ? `${transaction.quantity.toFixed(8)} BTC` : "À saisir"}</td>
                <td><span className={transaction.authorRole === "Enfant" ? "author-chip child" : "author-chip"}>{transaction.author}</span></td>
                <td><span className={`transaction-status ${statusClass(transaction.status)}`}>{transaction.status}</span></td>
                <td><div className="transaction-actions"><button className="detail-button" onClick={() => setSelected(transaction)}>Voir le détail</button>{transaction.status === "À transférer" && <button className="request-transfer-button" onClick={() => onTransferRequest(transaction)}>Demander le transfert</button>}</div></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        {filtered.length === 0 && <div className="empty-transactions">Aucune opération ne correspond à ces filtres.</div>}
      </section>

      {selected && <TransactionDetail transaction={selected} onClose={() => setSelected(null)} />}
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

function TransactionDetail({ transaction, onClose }: { transaction: TransactionRecord; onClose: () => void }) {
  const dialogRef = useDialogA11y(true, onClose);
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section ref={dialogRef} className="transaction-detail" role="dialog" aria-modal="true" aria-labelledby="transaction-title" tabIndex={-1}><header><div><span>DÉTAIL DE L’OPÉRATION</span><h2 id="transaction-title">{transaction.kind}</h2><p>{transaction.member} · {dateFormat.format(new Date(`${transaction.date}T00:00:00Z`))}</p></div><button onClick={onClose} aria-label="Fermer">×</button></header><div className="detail-amount"><small>{transaction.authorRole === "Blockchain" ? "Valeur publique" : "Montant investi"}</small><strong>{transaction.authorRole === "Blockchain" ? "Transaction Ledger" : euro.format(transaction.amount)}</strong><span className={`transaction-status ${statusClass(transaction.status)}`}>{transaction.status}</span></div><dl className="detail-list"><div><dt>Actif</dt><dd>{transaction.asset}</dd></div><div><dt>Quantité</dt><dd>{transaction.quantity ? transaction.quantity.toFixed(8) : "Non renseignée"}</dd></div><div><dt>Compte</dt><dd>{transaction.account}</dd></div><div><dt>Saisie par</dt><dd>{transaction.author} · {transaction.authorRole}</dd></div><div><dt>Référence</dt><dd>{transaction.reference ?? "Aucune"}</dd></div><div><dt>Commentaire</dt><dd>{transaction.note ?? "Aucun commentaire"}</dd></div></dl><div className="detail-safety">Cette fiche contient uniquement des informations de suivi. Elle ne contient aucune clé privée ni aucun mot Ledger.</div><button className="primary-button" onClick={onClose}>Fermer</button></section></div>;
}

function statusClass(status: TransactionRecord["status"]) { return status === "Confirmée" ? "confirmed" : status === "À transférer" ? "transfer" : "incomplete"; }
function stepTitle(step: number) { return step === 1 ? "Qui fait quoi ?" : step === 2 ? "Recopier les chiffres" : "Dernière vérification"; }
function stepHelp(step: number) { return step === 1 ? "Indique le bénéficiaire et la personne qui effectue la saisie." : step === 2 ? "Recopie les informations affichées sur Binance, Ledger ou ton courtier." : "Tout est lisible : tu peux corriger ou confirmer l’opération."; }
