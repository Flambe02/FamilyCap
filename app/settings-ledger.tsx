"use client";

import { useState } from "react";
import type { Viewer } from "../lib/auth-types";
import { SettingsSection } from "./settings-ui";

// Onglet « Ledger » : adresse publique du membre (lecture blockchain uniquement, jamais de clé
// privée). L'adresse vient de la jointure family_members → wallets déjà exposée par
// requireFamilyMember() / memberAsViewer(), donc aucun nouvel appel réseau n'est nécessaire ici.

function explorerUrl(address: string) {
  return `https://blockstream.info/address/${address}`;
}

function LedgerIllustration() {
  return (
    <svg viewBox="0 0 96 160" width="72" height="120" aria-hidden="true" className="ledger-illustration-svg">
      <rect x="10" y="4" width="60" height="152" rx="24" fill="#14171d" stroke="#3a3f4b" strokeWidth="2" />
      <rect x="34" y="4" width="36" height="152" rx="24" fill="#1f232b" />
      <rect x="22" y="28" width="30" height="54" rx="5" fill="#0a0c0f" />
      <rect x="28" y="40" width="18" height="3.5" rx="1.75" fill="#c9a24b" />
      <rect x="28" y="49" width="12" height="3.5" rx="1.75" fill="#565c68" />
      <rect x="28" y="58" width="15" height="3.5" rx="1.75" fill="#565c68" />
      <circle cx="37" cy="118" r="15" fill="#0a0c0f" stroke="#c9a24b" strokeWidth="2" />
      <circle cx="37" cy="118" r="5" fill="#c9a24b" />
    </svg>
  );
}

export function LedgerSettings({ viewer }: { viewer: Viewer }) {
  const [copied, setCopied] = useState(false);
  const address = viewer.walletAddress ?? null;

  async function copyAddress() {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <SettingsSection title="Ledger" subtitle="Ton adresse publique Ledger, pour vérifier tes bitcoins directement sur la blockchain.">
      <div className="ledger-card">
        <div className="ledger-illustration"><LedgerIllustration /></div>
        <div className="ledger-details">
          {address ? (
            <>
              <p className="set-hint">Adresse publique (lecture seule) :</p>
              <div className="ledger-address-row">
                <a href={explorerUrl(address)} target="_blank" rel="noreferrer" className="ledger-address" title="Ouvrir sur la blockchain">{address}</a>
                <button type="button" className="set-btn" onClick={() => void copyAddress()}>{copied ? "Copié !" : "Copier"}</button>
              </div>
              <a href={explorerUrl(address)} target="_blank" rel="noreferrer" className="set-btn set-btn-quiet ledger-explorer-link">Voir sur la blockchain ›</a>
            </>
          ) : (
            <p className="set-hint">Aucune adresse Ledger n’est encore enregistrée pour toi. Demande à l’administrateur familial de l’ajouter.</p>
          )}
        </div>
      </div>
      <div className="info-callout">
        <b>Important</b>
        <p>Cette adresse sert uniquement à consulter des soldes et transactions publics. Les 24 mots, la clé privée et le code PIN de la Ledger ne doivent jamais être saisis ici.</p>
      </div>
    </SettingsSection>
  );
}
