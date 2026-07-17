"use client";

import { FormEvent, useState } from "react";
import "./back-office.css";
import { AdminUsers } from "./admin-users";
import { supabaseBrowser } from "../lib/supabase-browser";
import { useDialogA11y } from "./use-dialog-a11y";

export type TransferRequest = {
  id: string;
  member: string;
  transactionId: string;
  btcAmount?: number;
  requestedAt: string;
  status: "Nouvelle" | "En traitement" | "Transférée";
};

export type GiftRecord = {
  member: string;
  occasion: string;
  giftDate: string;
  purchaseDate: string;
  amountEur: number;
  btcAmount: number;
  custody: "Binance commun" | "Ledger";
  transferDate?: string;
  ledgerAmount?: number;
  publicAddress?: string;
  txid?: string;
  note?: string;
  blockchainStatus: string;
  confirmations?: number;
};

const schedules = [
  { date: "15 mars", member: "Thibault", occasion: "Anniversaire", state: "Achat à compléter", tone: "late" },
  { date: "16 août", member: "Uhaina", occasion: "Anniversaire", state: "Dans 31 jours", tone: "soon" },
  { date: "27 août", member: "Aurore", occasion: "Anniversaire", state: "À venir", tone: "future" },
  { date: "18 nov.", member: "Paul", occasion: "Anniversaire", state: "À venir", tone: "future" },
  { date: "25 déc.", member: "Tous", occasion: "Noël · 5 cadeaux", state: "À venir", tone: "future" },
  { date: "29 déc.", member: "Thomas", occasion: "Anniversaire", state: "À venir", tone: "future" },
];

export function BackOffice({ requests, onGiftSaved, onRequestStatus }: {
  requests: TransferRequest[];
  onGiftSaved: (record: GiftRecord) => void;
  onRequestStatus: (id: string, status: TransferRequest["status"]) => void;
}) {
  const [giftModalOpen, setGiftModalOpen] = useState(false);

  return <div className="page-stack admin-space">
    <section className="admin-hero">
      <div><span>ESPACE ADMINISTRATEUR</span><h2>Les cadeaux BTC,<br />de l’achat jusqu’au Ledger.</h2><p>Tu pilotes les échéances, la part conservée sur Binance, les virements et leur validation sur la blockchain.</p></div>
      <button onClick={() => setGiftModalOpen(true)}>＋ Enregistrer un cadeau BTC</button>
    </section>

    <section className="admin-kpis">
      <AdminKpi label="Cadeaux à documenter" value="22" note="Quantités BTC historiques" tone="amber" />
      <AdminKpi label="Demandes de transfert" value={String(requests.filter((request) => request.status !== "Transférée").length)} note="Alertes des enfants" tone="coral" />
      <AdminKpi label="Sur Ledger" value="À rapprocher" note="Adresses publiques manquantes" tone="teal" />
      <AdminKpi label="Sur Binance commun" value="À ventiler" note="Parts individuelles" tone="navy" />
    </section>

    <div className="admin-columns">
      <section className="panel admin-panel">
        <header><div><span>CALENDRIER 2026</span><h2>Prochains cadeaux</h2></div><button onClick={() => setGiftModalOpen(true)}>Ajouter →</button></header>
        <div className="schedule-list">{schedules.map((item) => <article key={`${item.date}-${item.member}`}><time>{item.date}</time><div><strong>{item.member}</strong><small>{item.occasion} · 55 €, frais inclus</small></div><span className={`schedule-state ${item.tone}`}>{item.state}</span></article>)}</div>
      </section>

      <section className="panel admin-panel requests-panel">
        <header><div><span>ALERTES ENFANTS</span><h2>Demandes de transfert</h2></div><em>{requests.length}</em></header>
        {requests.length === 0 ? <div className="request-empty"><b>✓</b><strong>Aucune demande en attente</strong><p>Quand un enfant demandera le transfert de sa part Binance, l’alerte apparaîtra ici et un e-mail sera préparé.</p></div> : <div className="request-list">{requests.map((request) => <article key={request.id}><span className="request-avatar">{request.member.slice(0, 2).toUpperCase()}</span><div><strong>{request.member} demande un transfert</strong><small>{request.btcAmount ? `${request.btcAmount.toFixed(8)} BTC` : "Montant à confirmer"} · {request.requestedAt}</small></div><select value={request.status} onChange={(event) => onRequestStatus(request.id, event.target.value as TransferRequest["status"])}><option>Nouvelle</option><option>En traitement</option><option>Transférée</option></select></article>)}</div>}
      </section>
    </div>

    <section className="panel custody-panel">
      <header><div><span>RAPPROCHEMENT</span><h2>Où se trouvent les bitcoins ?</h2></div><button>Configurer les adresses publiques →</button></header>
      <div className="custody-flow"><div className="custody-source"><span>₿</span><strong>Binance commun</strong><small>Achat et stockage temporaire</small></div><i>parts à ventiler →</i><div className="custody-members">{["Thibault", "Uhaina", "Paul", "Aurore", "Thomas"].map((name) => <article key={name}><b>{name.slice(0, 2)}</b><span><strong>{name}</strong><small>Binance + Ledger à rapprocher</small></span><em>À vérifier</em></article>)}</div></div>
    </section>

    <AdminUsers />

    {giftModalOpen && <GiftEntryModal onClose={() => setGiftModalOpen(false)} onSave={(record) => { onGiftSaved(record); setGiftModalOpen(false); }} />}
  </div>;
}

function GiftEntryModal({ onClose, onSave }: { onClose: () => void; onSave: (record: GiftRecord) => void }) {
  const [step, setStep] = useState(1);
  const [checking, setChecking] = useState(false);
  const [verification, setVerification] = useState<{ ok: boolean; message: string; confirmations?: number } | null>(null);
  const [draft, setDraft] = useState({ member: "Thibault", occasion: "Anniversaire", giftDate: "2026-03-15", purchaseDate: "2026-03-15", eur: "55", btc: "", custody: "Binance commun", transferDate: "", ledgerAmount: "", address: "", txid: "", note: "" });
  const update = (key: keyof typeof draft, value: string) => setDraft((current) => ({ ...current, [key]: value }));
  const dialogRef = useDialogA11y(true, onClose);

  async function verifyBlockchain() {
    if (!draft.address || !draft.txid) { setVerification({ ok: false, message: "Renseigne l’adresse publique et le TxID." }); return; }
    setChecking(true); setVerification(null);
    try {
      const { data: auth } = await supabaseBrowser.auth.getSession();
      const response = await fetch("/api/blockchain/verify", { method: "POST", headers: { "content-type": "application/json", ...(auth.session ? { authorization: "Bearer " + auth.session.access_token } : {}) }, body: JSON.stringify({ address: draft.address.trim(), txid: draft.txid.trim(), expectedBtc: Number(draft.ledgerAmount || draft.btc) }) });
      const result = await response.json() as { verified?: boolean; confirmations?: number; receivedBtc?: number; error?: string };
      if (!response.ok) throw new Error(result.error ?? "Vérification impossible");
      setVerification({ ok: Boolean(result.verified), confirmations: result.confirmations, message: result.verified ? `Virement confirmé : ${result.receivedBtc?.toFixed(8)} BTC reçus.` : "La transaction ne correspond pas encore au montant et à l’adresse attendus." });
    } catch (error) { setVerification({ ok: false, message: error instanceof Error ? error.message : "Vérification indisponible" }); }
    finally { setChecking(false); }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step < 3) { setStep((current) => current + 1); return; }
    onSave({ member: draft.member, occasion: draft.occasion, giftDate: draft.giftDate, purchaseDate: draft.purchaseDate, amountEur: Number(draft.eur), btcAmount: Number(draft.btc), custody: draft.custody as GiftRecord["custody"], transferDate: draft.transferDate || undefined, ledgerAmount: draft.ledgerAmount ? Number(draft.ledgerAmount) : undefined, publicAddress: draft.address || undefined, txid: draft.txid || undefined, note: draft.note || undefined, blockchainStatus: draft.custody === "Ledger" ? (verification?.ok ? "Validé sur la blockchain" : "À vérifier") : "Stocké sur Binance commun", confirmations: verification?.confirmations });
  }

  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section ref={dialogRef} className="modal gift-modal" role="dialog" aria-modal="true" aria-labelledby="gift-title" tabIndex={-1}><header><div><span>CADEAU BTC · ÉTAPE {step} SUR 3</span><h2 id="gift-title">{step === 1 ? "Enregistrer l’achat" : step === 2 ? "Où sont les BTC ?" : "Contrôler et valider"}</h2></div><button onClick={onClose} aria-label="Fermer">×</button></header><div className="step-progress"><span className={step >= 1 ? "done" : ""} /><span className={step >= 2 ? "done" : ""} /><span className={step >= 3 ? "done" : ""} /></div><form onSubmit={submit}>
    {step === 1 && <><p className="modal-help">Associe précisément l’achat au cadeau de ta mère.</p><div className="form-grid"><label>Enfant<select value={draft.member} onChange={(event) => update("member", event.target.value)}>{["Thibault", "Uhaina", "Paul", "Aurore", "Thomas"].map((name) => <option key={name}>{name}</option>)}</select></label><label>Occasion<select value={draft.occasion} onChange={(event) => update("occasion", event.target.value)}><option>Anniversaire</option><option>Noël</option><option>Autre cadeau</option></select></label><label>Date prévue du cadeau<input type="date" value={draft.giftDate} onChange={(event) => update("giftDate", event.target.value)} required /></label><label>Date réelle d’achat<input type="date" value={draft.purchaseDate} onChange={(event) => update("purchaseDate", event.target.value)} required /></label><label>Coût total, frais inclus (€)<input type="number" value={draft.eur} onChange={(event) => update("eur", event.target.value)} min="0" step="0.01" required /></label><label>Quantité BTC achetée<input type="number" value={draft.btc} onChange={(event) => update("btc", event.target.value)} min="0" step="any" placeholder="0,00123456" required /></label></div></>}
    {step === 2 && <><p className="modal-help">Indique si la part reste sur Binance ou si elle a déjà été envoyée sur le Ledger de l’enfant.</p><div className="custody-choice"><button type="button" className={draft.custody === "Binance commun" ? "selected" : ""} onClick={() => update("custody", "Binance commun")}><span>₿</span><strong>Binance commun</strong><small>La part est attribuée à l’enfant mais attend le transfert.</small></button><button type="button" className={draft.custody === "Ledger" ? "selected" : ""} onClick={() => update("custody", "Ledger")}><span>L</span><strong>Clé Ledger</strong><small>Les BTC ont été transférés vers son portefeuille public.</small></button></div>{draft.custody === "Ledger" && <div className="form-grid ledger-fields"><label>Date du virement<input type="date" value={draft.transferDate} onChange={(event) => update("transferDate", event.target.value)} required /></label><label>BTC reçus sur Ledger<input type="number" value={draft.ledgerAmount} onChange={(event) => update("ledgerAmount", event.target.value)} min="0" step="any" required /></label><label className="span-2">Adresse Bitcoin publique de l’enfant<input value={draft.address} onChange={(event) => update("address", event.target.value)} placeholder="bc1q… (jamais les 24 mots)" required /></label><label className="span-2">TxID du virement<input value={draft.txid} onChange={(event) => update("txid", event.target.value)} placeholder="Identifiant public de la transaction" required /></label></div>}{draft.custody === "Binance commun" && <div className="binance-allocation"><span>✓</span><div><strong>{draft.btc || "0"} BTC seront attribués à {draft.member}</strong><p>Ils resteront comptabilisés sur le compte commun jusqu’à une demande ou un transfert.</p></div></div>}</>}
    {step === 3 && <><p className="modal-help">Relis le cadeau et, si nécessaire, contrôle le virement directement sur Bitcoin.</p><div className="gift-review"><dl><div><dt>Cadeau</dt><dd>{draft.member} · {draft.occasion}</dd></div><div><dt>Achat</dt><dd>{draft.purchaseDate} · {Number(draft.eur).toFixed(2)} €</dd></div><div><dt>Bitcoin acheté</dt><dd>{Number(draft.btc || 0).toFixed(8)} BTC</dd></div><div><dt>Conservation</dt><dd>{draft.custody}</dd></div>{draft.custody === "Ledger" && <><div><dt>BTC envoyés</dt><dd>{Number(draft.ledgerAmount || 0).toFixed(8)} BTC</dd></div><div><dt>Adresse</dt><dd className="mono-value">{draft.address}</dd></div></>}</dl>{draft.custody === "Ledger" ? <div className="blockchain-check"><button type="button" onClick={verifyBlockchain} disabled={checking}>{checking ? "Vérification…" : "⌕ Vérifier sur la blockchain"}</button>{verification && <p className={verification.ok ? "success" : "failure"}>{verification.ok ? "✓" : "!"} {verification.message}{verification.confirmations !== undefined ? ` · ${verification.confirmations} confirmations` : ""}</p>}</div> : <div className="binance-confirmation"><b>Binance commun</b><p>L’enfant pourra demander le transfert de cette part depuis son registre.</p></div>}</div><label className="gift-note">Note / commentaire<textarea value={draft.note} onChange={(event) => update("note", event.target.value)} placeholder="Information utile pour la famille" /></label></>}
    <footer><button type="button" className="secondary-button" onClick={() => step === 1 ? onClose() : setStep((current) => current - 1)}>{step === 1 ? "Annuler" : "← Retour"}</button><button type="submit" className="primary-button">{step === 3 ? "Valider le cadeau BTC" : "Continuer →"}</button></footer>
  </form></section></div>;
}

function AdminKpi({ label, value, note, tone }: { label: string; value: string; note: string; tone: string }) { return <article className={`admin-kpi ${tone}`}><span>{label}</span><strong>{value}</strong><small>{note}</small></article>; }
