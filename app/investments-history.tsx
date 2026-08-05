"use client";

// Écran « Investissements › Historique » (sidebar) : liste UNIQUE et simple qui relie les
// opérations déjà enregistrées par les trois moteurs existants (Bitcoin, PEA, compte-titres) —
// aucun nouveau moteur, aucune écriture ici. Bitcoin vient de `transactions` (TransactionRecord[],
// déjà utilisé par transactions.tsx) ; PEA/CTO viennent de `operations` (AccountOperation[],
// déjà utilisé par investment-account.tsx), rattachées à leur compte via `accounts` pour
// distinguer PEA de compte-titres et retrouver le membre.
//
// Portée par classe d'actif — PAS le même périmètre partout : Amatxi (rôle `viewer`) voit tout
// le Bitcoin de la famille (règle déjà appliquée à l'identique dans bitcoin-investments.tsx /
// transactions.tsx), mais reste au périmètre "admin ou soi-même" pour PEA/CTO, exactement comme
// investment-account.tsx (`isAdmin || account.memberName === viewer.name`) — son rôle ne lui
// donne aucun accès élargi hors Bitcoin, quel que soit le partage familial d'un autre membre.
// `portfolioAccounts`/`portfolioOperations` (family-dashboard.tsx) sont toujours la vue COMPLÈTE
// (fetch avec le jeton admin réel), donc ce filtrage client est la seule frontière ici.

import { useCallback, useMemo, useState } from "react";
import type { Viewer } from "../lib/auth-types";
import type { TransactionRecord } from "./transactions";
import type { AccountOperation } from "../lib/portfolio-account";
import { OP_LABEL, OP_INFLOW } from "./investment-shared";
import "./bitcoin-investments.css";
import "./investments-history.css";

type PortfolioAccountLite = { id: string; name: string; accountType: string; memberName: string | null };

type AssetClass = "BTC" | "PEA" | "CTO";

type HistoryRow = {
  id: string;
  date: string;
  assetClass: AssetClass;
  member: string;
  label: string;
  detail: string;
  amountEur: number | null;
  inflow: boolean;
};

const euro = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });
const fullDate = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const ASSET_LABEL: Record<AssetClass, string> = { BTC: "Bitcoin", PEA: "PEA", CTO: "Compte-titres" };
const ASSET_ICON: Record<AssetClass, string> = { BTC: "₿", PEA: "🏦", CTO: "🏛️" };

export function InvestmentsHistoryPage({ transactions, accounts, operations, viewer, isPreview }: {
  transactions: TransactionRecord[];
  accounts: PortfolioAccountLite[];
  operations: AccountOperation[];
  viewer: Viewer;
  isPreview: boolean;
}) {
  const isAdmin = viewer.role === "admin";
  // Bitcoin uniquement : Amatxi voit tout, comme sur son propre écran Bitcoin.
  const canViewAllBtc = isAdmin || viewer.role === "viewer";
  // PEA/CTO : jamais élargi par le rôle `viewer` (cf. investment-account.tsx:247).
  const canViewAllInvest = isAdmin;
  const canViewAll = canViewAllBtc && canViewAllInvest; // pour le texte d'en-tête uniquement

  const [filter, setFilter] = useState<"all" | AssetClass>("all");
  const [pageSize] = useState(() => (typeof window !== "undefined" && window.matchMedia("(max-width: 780px)").matches ? 8 : 15));
  const [visibleCount, setVisibleCount] = useState(pageSize);
  const resetPage = useCallback(() => setVisibleCount(pageSize), [pageSize]);

  const rows = useMemo(() => {
    const accountById = new Map(accounts.map((account) => [account.id, account]));

    const btcRows: HistoryRow[] = transactions
      .filter((transaction) => canViewAllBtc || transaction.member === viewer.name)
      .map((transaction) => ({
        id: `btc-${transaction.id}`,
        date: transaction.date,
        assetClass: "BTC" as const,
        member: transaction.member,
        label: transaction.kind,
        detail: transaction.account,
        amountEur: transaction.amount,
        inflow: true,
      }));

    const investRows: HistoryRow[] = operations
      .map((operation): HistoryRow | null => {
        const account = accountById.get(operation.accountId);
        if (!account || (account.accountType !== "pea" && account.accountType !== "securities")) return null;
        const member = operation.memberName ?? account.memberName ?? "—";
        if (!canViewAllInvest && member !== viewer.name) return null;
        return {
          id: `inv-${operation.id}`,
          date: operation.date,
          assetClass: account.accountType === "pea" ? ("PEA" as const) : ("CTO" as const),
          member,
          label: OP_LABEL[operation.type],
          detail: operation.assetName ?? account.name,
          amountEur: operation.netAmount ?? operation.grossAmount,
          inflow: OP_INFLOW[operation.type],
        };
      })
      .filter((row): row is HistoryRow => row !== null);

    return [...btcRows, ...investRows].sort((a, b) => b.date.localeCompare(a.date));
  }, [transactions, operations, accounts, canViewAllBtc, canViewAllInvest, viewer.name]);

  const filtered = filter === "all" ? rows : rows.filter((row) => row.assetClass === filter);
  const paged = filtered.slice(0, visibleCount);
  const counts = {
    all: rows.length,
    BTC: rows.filter((row) => row.assetClass === "BTC").length,
    PEA: rows.filter((row) => row.assetClass === "PEA").length,
    CTO: rows.filter((row) => row.assetClass === "CTO").length,
  };

  function changeFilter(next: "all" | AssetClass) {
    setFilter(next);
    resetPage();
  }

  return (
    <div className="page-stack">
      <section className="panel history-head">
        <span className="soft-pill">INVESTISSEMENTS</span>
        <h2>Historique</h2>
        <p>Toutes les opérations Bitcoin, PEA et compte-titres {canViewAll && !isPreview ? "de la famille" : `de ${viewer.name}`}, de la plus récente à la plus ancienne.</p>
      </section>

      <section className="panel">
        <div className="history-filter-tabs" role="tablist" aria-label="Filtrer par type d’actif">
          <button type="button" role="tab" aria-selected={filter === "all"} className={filter === "all" ? "active" : ""} onClick={() => changeFilter("all")}>Toutes <em>{counts.all}</em></button>
          <button type="button" role="tab" aria-selected={filter === "BTC"} className={filter === "BTC" ? "active" : ""} onClick={() => changeFilter("BTC")}>Bitcoin <em>{counts.BTC}</em></button>
          <button type="button" role="tab" aria-selected={filter === "PEA"} className={filter === "PEA" ? "active" : ""} onClick={() => changeFilter("PEA")}>PEA <em>{counts.PEA}</em></button>
          <button type="button" role="tab" aria-selected={filter === "CTO"} className={filter === "CTO" ? "active" : ""} onClick={() => changeFilter("CTO")}>Compte-titres <em>{counts.CTO}</em></button>
        </div>

        {filtered.length === 0 ? (
          <div className="history-empty">
            <strong>Aucune opération pour l’instant</strong>
            <span>Les cadeaux, achats et versements enregistrés sur Bitcoin, PEA et compte-titres apparaîtront ici.</span>
          </div>
        ) : (
          <>
            <ul className="btc-ops history-list">
              {paged.map((row) => (
                <li key={row.id}>
                  <span className="btc-ops-mark" aria-hidden="true">{ASSET_ICON[row.assetClass]}</span>
                  <div className="btc-ops-info"><strong>{row.label}</strong><small>{row.member} · {row.detail}</small></div>
                  <div className="btc-ops-amount">
                    <b className={row.inflow ? "up" : "down"}>{row.amountEur !== null ? `${row.inflow ? "+" : "−"}${euro.format(Math.abs(row.amountEur))}` : "—"}</b>
                    <small>{ASSET_LABEL[row.assetClass]}</small>
                  </div>
                  <div className="btc-ops-meta"><time>{fullDate.format(new Date(`${row.date}T00:00:00Z`))}</time></div>
                </li>
              ))}
            </ul>
            {filtered.length > paged.length && (
              <div className="history-more">
                <button type="button" className="secondary-button" onClick={() => setVisibleCount((count) => count + pageSize)}>
                  Afficher plus ({filtered.length - paged.length})
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
