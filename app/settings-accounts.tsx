"use client";

import { useCallback, useEffect, useState } from "react";
import type { Viewer } from "../lib/auth-types";
import type { View } from "../lib/navigation";
import { supabaseBrowser } from "../lib/supabase-browser";
import { SettingsSection } from "./settings-ui";

// Écran « Mes comptes » : vue simple des comptes appartenant au membre (Bitcoin cadeaux réels +
// comptes financiers PEA/compte-titres). Données réelles uniquement, portée serveur au membre.
// Ne remplace pas la section principale Investissements ; aucun bouton d'ajout (réservé admin).

type GiftRow = { member_name: string; occasion: string; gift_date: string; amount_eur: number; btc_amount: number; custody?: string; ledger_amount?: number | null; is_deleted?: boolean };
type PortfolioAccount = { id: string; name?: string; institution?: string | null; accountType: string; currency: string; memberName: string | null };
type PortfolioHolding = { account_id: string; quantity: number; last_price: number | null };
type AccountLine = { key: string; name: string; type: string; valueEur: number | null; navigate?: View };

const euro = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });

const TYPE_LABELS: Record<string, string> = {
  bitcoin: "Bitcoin", pea: "PEA", securities: "Compte-titres", bank: "Compte courant",
  savings: "Épargne", crypto_exchange: "Plateforme crypto", other: "Autre",
};

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabaseBrowser.auth.getSession();
  return { authorization: "Bearer " + (data.session?.access_token ?? "") };
}

export function AccountsSettings({ viewer, onNavigate, scopeOverride }: { viewer: Viewer; onNavigate?: (view: View) => void; scopeOverride?: "family" | "selected" }) {
  const [lines, setLines] = useState<AccountLine[] | null>(null);
  const [visible, setVisible] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const headers = await authHeaders();
    // En gestion admin (scopeOverride fourni), la visibilité vient du membre ciblé : on n'interroge
    // pas /api/investment-access (qui renverrait le partage de l'administrateur, pas celui du membre).
    const [giftsRes, ledgerRes, portfolioRes, accessRes] = await Promise.all([
      fetch("/api/gifts", { headers }),
      fetch("/api/ledger?priceOnly=1", { headers }),
      fetch("/api/portfolio", { headers }),
      scopeOverride ? Promise.resolve(null) : fetch("/api/investment-access", { headers }),
    ]);

    const giftsBody = await giftsRes.json() as { records?: GiftRow[]; error?: string };
    if (!giftsRes.ok) throw new Error(giftsBody.error ?? "Comptes indisponibles.");
    const ledgerBody = ledgerRes.ok ? await ledgerRes.json() as { bitcoinEur?: number | null } : null;
    const price = ledgerBody && Number(ledgerBody.bitcoinEur) > 0 ? Number(ledgerBody.bitcoinEur) : null;
    const portfolioBody = portfolioRes.ok ? await portfolioRes.json() as { accounts?: PortfolioAccount[]; holdings?: PortfolioHolding[] } : { accounts: [], holdings: [] };
    if (scopeOverride) {
      setVisible(scopeOverride === "family");
    } else {
      const accessBody = accessRes && accessRes.ok ? await accessRes.json() as { scope?: "family" | "selected" } : null;
      setVisible((accessBody?.scope ?? "family") === "family");
    }

    // L'API renvoie les cadeaux actifs et l'historique fusionné dans le périmètre autorisé.
    const memberGifts = (giftsBody.records ?? [])
      .filter((record) => record.member_name === viewer.name && !record.is_deleted)
      .map((record) => ({ ...record, amount_eur: Number(record.amount_eur), btc_amount: Number(record.btc_amount), ledger_amount: record.ledger_amount == null ? null : Number(record.ledger_amount) }));
    const btc = memberGifts.reduce((sum, record) => {
      const owned = record.custody === "Ledger" && Number(record.ledger_amount) > 0 ? Number(record.ledger_amount) : Number(record.btc_amount);
      return sum + Math.max(0, owned || 0);
    }, 0);

    const result: AccountLine[] = [];
    if (btc > 0) result.push({ key: "bitcoin", name: "Bitcoin cadeaux", type: "Bitcoin", valueEur: price ? btc * price : null, navigate: "bitcoin" });

    // Comptes financiers du membre (hors Bitcoin, déjà couvert par les cadeaux) valorisés par positions.
    const holdings = portfolioBody.holdings ?? [];
    const valueByAccount = new Map<string, number>();
    for (const holding of holdings) {
      valueByAccount.set(holding.account_id, (valueByAccount.get(holding.account_id) ?? 0) + holding.quantity * (holding.last_price ?? 0));
    }
    for (const account of (portfolioBody.accounts ?? []).filter((item) => item.memberName === viewer.name && item.accountType !== "bitcoin")) {
      result.push({
        key: account.id,
        name: account.name?.trim() || TYPE_LABELS[account.accountType] || "Compte",
        type: TYPE_LABELS[account.accountType] ?? account.accountType,
        valueEur: valueByAccount.has(account.id) ? (valueByAccount.get(account.id) as number) : null,
      });
    }

    setLines(result);
  }, [viewer.name, scopeOverride]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try { await load(); }
      catch (caught) { if (!cancelled) { setError(caught instanceof Error ? caught.message : "Comptes indisponibles."); setLines([]); } }
    })();
    return () => { cancelled = true; };
  }, [load]);

  return (
    <SettingsSection title="Mes comptes" subtitle="Suivez vos comptes et la valeur de vos investissements.">
      {error && <p className="set-message error" role="status">{error}</p>}
      {lines === null ? (
        <p className="set-hint">Chargement…</p>
      ) : lines.length === 0 ? (
        <div className="set-empty">
          <p>Aucun compte d’investissement n’est encore associé à votre profil.</p>
          <span>Vos comptes (Bitcoin, PEA, compte-titres) apparaîtront ici dès leur saisie par un administrateur.</span>
        </div>
      ) : (
        <ul className="set-account-list">
          {lines.map((line) => {
            const clickable = line.navigate && onNavigate;
            const content = (
              <>
                <span className={`set-account-logo ${line.key === "bitcoin" ? "bitcoin" : "generic"}`} aria-hidden="true">{line.key === "bitcoin" ? "₿" : line.type.slice(0, 2).toUpperCase()}</span>
                <span className="set-account-info"><strong>{line.name}</strong><small>{line.type}</small></span>
                <span className="set-account-value">{line.valueEur !== null ? euro.format(line.valueEur) : "—"}<small>{line.valueEur !== null ? "Valeur actuelle" : "Valeur indisponible"}</small></span>
                <span className={`set-badge ${visible ? "ok" : "muted"}`}>{visible ? "Visible" : "Restreint"}</span>
                {clickable ? <span className="set-account-chevron" aria-hidden="true">›</span> : <span className="set-account-chevron placeholder" aria-hidden="true" />}
              </>
            );
            return (
              <li key={line.key}>
                {clickable
                  ? <button type="button" className="set-account-row is-link" onClick={() => { if (line.navigate) onNavigate?.(line.navigate); }} aria-label={`Voir le détail : ${line.name}`}>{content}</button>
                  : <div className="set-account-row">{content}</div>}
              </li>
            );
          })}
        </ul>
      )}
      <p className="set-note">Seuls les comptes qui vous appartiennent ou qui ont été partagés avec vous sont affichés ici.</p>
    </SettingsSection>
  );
}
