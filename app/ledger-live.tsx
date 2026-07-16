"use client";

import { useEffect, useMemo, useState } from "react";
import "./ledger-live.css";
import { supabaseBrowser } from "../lib/supabase-browser";

type LedgerTransaction = {
  txid: string;
  date: string | null;
  amountBtc: number;
  direction: "Reçu" | "Envoyé";
  confirmed: boolean;
  confirmations: number;
  explorerUrl: string;
};

type LedgerWallet = {
  member: string;
  address: string;
  confirmedBalanceBtc?: number;
  pendingBalanceBtc?: number;
  receivedBtc?: number;
  spentBtc?: number;
  transactionCount?: number;
  explorerUrl?: string;
  transactions?: LedgerTransaction[];
  error?: string;
};

type LedgerResponse = { wallets: LedgerWallet[]; bitcoinEur: number | null; updatedAt: string; error?: string };

const euro = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });
const date = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });

export function LedgerLive({ visibleMember }: { visibleMember?: string }) {
  const [data, setData] = useState<LedgerResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedMember, setSelectedMember] = useState("Tous");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const { data: auth } = await supabaseBrowser.auth.getSession();
      const response = await fetch("/api/ledger?refresh=" + refreshKey, {
        signal: controller.signal,
        headers: auth.session ? { authorization: "Bearer " + auth.session.access_token } : {},
      });
      const result = await response.json() as LedgerResponse;
      if (!response.ok) throw new Error(result.error ?? "Lecture de la blockchain impossible");
      setData(result);
    })()
      .catch((reason: unknown) => {
        if (!(reason instanceof DOMException && reason.name === "AbortError")) setError(reason instanceof Error ? reason.message : "Lecture impossible");
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [refreshKey]);

  const visibleWallets = useMemo(() => (data?.wallets ?? []).filter((wallet) => !visibleMember || wallet.member === visibleMember), [data, visibleMember]);

  const transactions = useMemo(() => visibleWallets
    .flatMap((wallet) => (wallet.transactions ?? []).map((transaction) => ({ ...transaction, member: wallet.member })))
    .filter((transaction) => selectedMember === "Tous" || transaction.member === selectedMember)
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "")), [visibleWallets, selectedMember]);

  const totalBtc = visibleWallets.reduce((total, wallet) => total + (wallet.confirmedBalanceBtc ?? 0), 0);

  return <div className="ledger-live">
    <section className="panel ledger-head">
      <div><span>BLOCKCHAIN BITCOIN · LECTURE PUBLIQUE</span><h2>Les Ledger, vérifiés en direct.</h2><p>Les soldes et transactions proviennent des adresses publiques. Aucune clé privée n’est utilisée.</p></div>
      <div className="ledger-total"><small>Solde total Ledger</small><strong>{totalBtc.toFixed(8)} BTC</strong><b>{data?.bitcoinEur ? euro.format(totalBtc * data.bitcoinEur) : "Cours EUR indisponible"}</b></div>
      <button onClick={() => { setLoading(true); setError(""); setRefreshKey((key) => key + 1); }} disabled={loading}>{loading ? "Actualisation…" : "↻ Actualiser"}</button>
    </section>

    {error && <div className="ledger-error">{error}</div>}
    <section className="ledger-wallet-grid" aria-busy={loading}>
      {visibleWallets.map((wallet) => <article className="ledger-wallet-card" key={wallet.member}>
        <header><span>{wallet.member.slice(0, 2).toUpperCase()}</span><div><strong>{wallet.member}</strong><small>Ledger Bitcoin</small></div><em>{wallet.error ? "Erreur" : "✓ Vérifié"}</em></header>
        {wallet.error ? <p className="wallet-error">{wallet.error}</p> : <><div className="wallet-balance"><strong>{wallet.confirmedBalanceBtc?.toFixed(8)} BTC</strong><small>{data?.bitcoinEur && wallet.confirmedBalanceBtc !== undefined ? euro.format(wallet.confirmedBalanceBtc * data.bitcoinEur) : "Valeur EUR —"}</small></div><div className="wallet-meta"><span>{wallet.transactionCount} transaction{wallet.transactionCount === 1 ? "" : "s"}</span><span>{wallet.spentBtc ? `${wallet.spentBtc.toFixed(8)} BTC dépensés` : "Aucune sortie"}</span></div></>}
        <code title={wallet.address}>{wallet.address}</code>
        {wallet.explorerUrl && <a href={wallet.explorerUrl} target="_blank" rel="noreferrer">Voir l’adresse sur Blockstream ↗</a>}
      </article>)}
      {loading && !data && [1, 2, 3, 4, 5].map((item) => <article className="ledger-wallet-card skeleton" key={item} />)}
    </section>

    <section className="panel ledger-transactions">
      <header><div><span>HISTORIQUE ON-CHAIN</span><h2>{transactions.length} virements trouvés</h2></div><label>Enfant<select value={selectedMember} onChange={(event) => setSelectedMember(event.target.value)}><option>Tous</option>{visibleWallets.map((wallet) => <option key={wallet.member}>{wallet.member}</option>)}</select></label></header>
      <div className="responsive-table"><table><thead><tr><th>Date</th><th>Enfant</th><th>Mouvement</th><th>Montant</th><th>Validation</th><th>Transaction</th></tr></thead><tbody>{transactions.map((transaction) => <tr key={`${transaction.member}-${transaction.txid}`}><td>{transaction.date ? date.format(new Date(transaction.date)) : "En attente"}</td><td><strong>{transaction.member}</strong></td><td><span className={`chain-direction ${transaction.direction === "Reçu" ? "received" : "sent"}`}>{transaction.direction === "Reçu" ? "↓" : "↑"} {transaction.direction}</span></td><td className="chain-amount">{transaction.amountBtc.toFixed(8)} BTC</td><td><span className="chain-confirmed">✓ {transaction.confirmations.toLocaleString("fr-FR")} confirmations</span></td><td><a href={transaction.explorerUrl} target="_blank" rel="noreferrer" title={transaction.txid}>{transaction.txid.slice(0, 8)}…{transaction.txid.slice(-6)} ↗</a></td></tr>)}</tbody></table></div>
      {!loading && transactions.length === 0 && <div className="ledger-empty">Aucune transaction trouvée pour ce filtre.</div>}
      <footer>Dernière lecture : {data?.updatedAt ? new Date(data.updatedAt).toLocaleString("fr-FR") : "—"} · Source publique Blockstream</footer>
    </section>
  </div>;
}
