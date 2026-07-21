"use client";

import { useMemo, useState } from "react";
import type { Viewer } from "../lib/auth-types";
import type { TransferRequest } from "./back-office";
import { GiftPortfolio } from "./gift-portfolio";
import { Indicators } from "./indicators";
import { TransactionsView, type TransactionRecord, type TransactionShortcut } from "./transactions";
import { computePurchasePriceData } from "../lib/gift-history";
import { FAMILY_MEMBERS } from "../lib/family-roster";
import { Stat, PanelTitle } from "./dashboard-ui";
import "./bitcoin-investments.css";

type FamilyGiftRecord = {
  member_name: string;
  occasion: string;
  gift_date: string;
  amount_eur: number;
  btc_amount: number;
  custody?: string;
  ledger_amount?: number | null;
  is_deleted?: boolean;
};
type FamilyMemberBalance = { name: string; btc: number; currentValueEur: number | null };

type BitcoinTab = "resume" | "membres" | "investir" | "conservation" | "transferts" | "performance" | "historique" | "comprendre";

const euro = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });
const fullDate = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

function occasionLabel(occasion: string) {
  if (occasion === "Anniversaire") return "Cadeau d’anniversaire";
  if (occasion === "Noël") return "Cadeau de Noël";
  return "Autre cadeau";
}

// Même formule que l'ancienne BitcoinOverview : "binanceBtc" regroupe Binance commun + À rapprocher
// (comportement conservé pour ne pas changer un chiffre déjà affiché) ; le détail par statut sert aux nouveaux usages (Conservation).
function computeCustody(records: FamilyGiftRecord[]) {
  return records.reduce(
    (acc, record) => {
      const effectiveBtc = record.custody === "Ledger" && Number(record.ledger_amount) > 0 ? Number(record.ledger_amount) : Number(record.btc_amount);
      const amount = Math.max(0, effectiveBtc || 0);
      if (record.custody === "Ledger") {
        acc.ledgerBtc += amount;
        acc.ledgerCount += 1;
      } else if (record.custody === "À rapprocher") {
        acc.unclassifiedBtc += amount;
        acc.unclassifiedCount += 1;
        acc.binanceBtc += amount;
      } else {
        acc.binanceCommunBtc += amount;
        acc.binanceCommunCount += 1;
        acc.binanceBtc += amount;
      }
      return acc;
    },
    { ledgerBtc: 0, ledgerCount: 0, binanceBtc: 0, binanceCommunBtc: 0, binanceCommunCount: 0, unclassifiedBtc: 0, unclassifiedCount: 0 },
  );
}

export function BitcoinInvestmentPage({
  records,
  bitcoinEur,
  totalBtc,
  totalBitcoinValueEur,
  marketLoading,
  memberBalances,
  transferRequests,
  transactions,
  transactionShortcut,
  transactionsReloadKey,
  viewer,
  isPreview,
  canManageGifts,
  openModal,
  onOpenMemberDetail,
  onTransferRequest,
  onRequestStatus,
  onOpenTransactions,
}: {
  records: FamilyGiftRecord[];
  bitcoinEur: number | null;
  totalBtc: number;
  totalBitcoinValueEur: number | null;
  marketLoading: boolean;
  memberBalances: FamilyMemberBalance[];
  transferRequests: TransferRequest[];
  transactions: TransactionRecord[];
  transactionShortcut: TransactionShortcut | null;
  transactionsReloadKey: number;
  viewer: Viewer;
  isPreview: boolean;
  canManageGifts: boolean;
  openModal: () => void;
  onOpenMemberDetail: (member: string) => void;
  onTransferRequest: (transaction: TransactionRecord) => void;
  onRequestStatus: (id: string, status: TransferRequest["status"]) => void;
  onOpenTransactions: (shortcut: Omit<TransactionShortcut, "requestId">) => void;
}) {
  const isAdmin = viewer.role === "admin";
  const [tab, setTab] = useState<BitcoinTab>("resume");
  const activeTab = !isAdmin && tab === "transferts" ? "resume" : tab;

  const purchase = useMemo(() => computePurchasePriceData(records), [records]);
  const custody = useMemo(() => computeCustody(records), [records]);
  const totalGainEur = totalBitcoinValueEur === null ? null : totalBitcoinValueEur - purchase.totalInvestedEur;
  const totalGainPct = totalGainEur === null || purchase.totalInvestedEur <= 0 ? null : (totalGainEur / purchase.totalInvestedEur) * 100;

  const pendingTransfers = useMemo(() => transferRequests.filter((request) => request.status !== "Transférée"), [transferRequests]);
  const pendingTransferBtc = useMemo(() => pendingTransfers.reduce((sum, request) => sum + (request.btcAmount ?? 0), 0), [pendingTransfers]);
  const lastCompletedTransfer = useMemo(
    () => [...transferRequests].filter((request) => request.status === "Transférée").sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0],
    [transferRequests],
  );

  const memberSummaries = useMemo(
    () =>
      FAMILY_MEMBERS.map((member) => {
        const memberRecords = records.filter((record) => record.member_name === member.name);
        const balance = memberBalances.find((item) => item.name === member.name);
        const memberPurchase = computePurchasePriceData(memberRecords);
        const memberCustody = computeCustody(memberRecords);
        const btc = balance?.btc ?? 0;
        const valueEur = balance?.currentValueEur ?? null;
        const gainEur = valueEur === null ? null : valueEur - memberPurchase.totalInvestedEur;
        const pending = transferRequests.filter((request) => request.member === member.name && request.status !== "Transférée").length;
        return {
          name: member.name,
          btc,
          valueEur,
          investedEur: memberPurchase.totalInvestedEur,
          gainEur,
          ledgerBtc: memberCustody.ledgerBtc,
          binanceBtc: memberCustody.binanceBtc,
          pending,
        };
      }),
    [records, memberBalances, transferRequests],
  );

  const recentOperations = useMemo(
    () =>
      [...records]
        .sort((a, b) => b.gift_date.localeCompare(a.gift_date))
        .slice(0, 6)
        .map((record) => ({
          key: `${record.member_name}-${record.occasion}-${record.gift_date}`,
          member: record.member_name,
          label: occasionLabel(record.occasion),
          amountEur: record.amount_eur,
          btcAmount: record.btc_amount,
          date: record.gift_date,
        })),
    [records],
  );

  const tabs: { id: BitcoinTab; label: string }[] = [
    { id: "resume", label: "Résumé" },
    { id: "membres", label: isAdmin ? "Membres" : "Mes BTC" },
    { id: "investir", label: "Investir" },
    { id: "conservation", label: "Conservation" },
    ...(isAdmin ? [{ id: "transferts" as const, label: "Transferts" }] : []),
    { id: "performance", label: "Performance" },
    { id: "historique", label: "Historique" },
    { id: "comprendre", label: "Comprendre" },
  ];

  return (
    <div className="page-stack bitcoin-page">
      <section className="bitcoin-page-header">
        <div className="bitcoin-page-header-copy">
          <span className="soft-pill">BITCOIN</span>
          <h1>Bitcoin</h1>
          <p>Suivez vos BTC : cadeaux d’Amatxi, investissements personnels, conservation et performance.</p>
        </div>
        <div className="bitcoin-page-actions">
          {pendingTransfers.length > 0 && (
            <span className="bitcoin-transfer-badge">
              {pendingTransfers.length} transfert{pendingTransfers.length > 1 ? "s" : ""} en attente
            </span>
          )}
          {canManageGifts && (
            <button type="button" className="primary-button" onClick={openModal}>
              ＋ Enregistrer un achat BTC
            </button>
          )}
          {canManageGifts && (
            <button type="button" className="secondary-button" onClick={() => setTab("membres")}>
              Préparer un transfert Ledger
            </button>
          )}
        </div>
      </section>

      <nav className="bitcoin-tabs" aria-label="Sections Bitcoin">
        {tabs.map((item) => (
          <button key={item.id} type="button" className={activeTab === item.id ? "active" : ""} onClick={() => setTab(item.id)} aria-current={activeTab === item.id ? "page" : undefined}>
            {item.label}
          </button>
        ))}
      </nav>

      {activeTab === "resume" && (
        <>
          <section className="panel">
            <PanelTitle eyebrow="SUIVI BITCOIN" title="Vue d’ensemble Bitcoin" />
            <div className="stats-row stats-row-wide" aria-label="Indicateurs Bitcoin">
              <Stat label="Quantité totale BTC" value={`${totalBtc.toFixed(8)} BTC`} note="Cadeaux attribués à la famille" tone="amber" icon="bitcoin" />
              <Stat
                label="Valeur actuelle"
                value={totalBitcoinValueEur === null ? (marketLoading ? "Mise à jour…" : "Cours indisponible") : euro.format(totalBitcoinValueEur)}
                note={bitcoinEur ? `1 BTC = ${euro.format(bitcoinEur)}` : "Cours indisponible"}
                tone="teal"
                icon="trending-up"
              />
              <Stat label="Montant investi" value={euro.format(purchase.totalInvestedEur)} note="Coût d’achat historique" tone="amber" icon="wallet" />
              <Stat
                label="Plus / moins-value"
                value={totalGainEur === null ? "—" : `${totalGainEur >= 0 ? "+" : ""}${euro.format(totalGainEur)}`}
                note={totalGainPct !== null ? `${totalGainPct >= 0 ? "+" : ""}${totalGainPct.toFixed(1)} %` : "Cours indisponible"}
                tone="teal"
                icon="trending-up"
              />
            </div>
            <div className="stats-row stats-row-wide" aria-label="Prix moyen, garde et transferts">
              <Stat label="Prix moyen d’achat" value={purchase.totalBtc > 0 ? `${euro.format(purchase.average)} / BTC` : "—"} note="Moyenne pondérée famille" tone="teal" icon="landmark" />
              <Stat label="Sur Ledger" value={`${custody.ledgerBtc.toFixed(8)} BTC`} note="Transférés et verrouillés" tone="teal" icon="shield-check" />
              <Stat label="Sur Binance commun" value={`${custody.binanceBtc.toFixed(8)} BTC`} note="En attente de transfert" tone="amber" icon="wallet" />
              <Stat
                label="Transferts en attente"
                value={`${pendingTransfers.length}`}
                note={pendingTransfers.length > 0 ? `${pendingTransferBtc.toFixed(8)} BTC en attente` : "Aucun transfert en attente"}
                tone="teal"
                icon="shield-check"
                action={isAdmin ? "Voir les transferts" : undefined}
                onAction={isAdmin ? () => setTab("transferts") : undefined}
              />
            </div>
          </section>

          <section className="panel">
            <PanelTitle eyebrow="ORIGINES" title="Répartition par origine" />
            <div className="bitcoin-origin-grid">
              <div className="bitcoin-origin-row">
                <span className="bitcoin-origin-dot amber" aria-hidden="true" />
                <div>
                  <strong>Cadeaux d’Amatxi</strong>
                  <small>{totalBtc.toFixed(8)} BTC · 100 %</small>
                </div>
              </div>
              <div className="bitcoin-origin-row empty">
                <span className="bitcoin-origin-dot" aria-hidden="true" />
                <div>
                  <strong>Investissements personnels</strong>
                  <small>Aucun investissement personnel enregistré pour l’instant.</small>
                </div>
              </div>
              <div className="bitcoin-origin-row empty">
                <span className="bitcoin-origin-dot" aria-hidden="true" />
                <div>
                  <strong>Achats groupés / autres</strong>
                  <small>Aucun achat groupé enregistré pour l’instant.</small>
                </div>
              </div>
            </div>
          </section>

          <section className="panel">
            <PanelTitle eyebrow="LES MEMBRES" title="Répartition par membre" action={isAdmin ? "Voir le détail par membre" : undefined} onAction={isAdmin ? () => setTab("membres") : undefined} />
            <div className="bitcoin-member-mini-list">
              {memberSummaries.map((member) => {
                const pct = totalBtc > 0 ? Math.round((member.btc / totalBtc) * 100) : 0;
                return (
                  <div className="bitcoin-member-mini-row" key={member.name}>
                    <strong>{member.name}</strong>
                    <div className="progress"><span style={{ width: `${pct}%` }} /></div>
                    <small>
                      {member.btc.toFixed(8)} BTC · {member.valueEur === null ? "—" : euro.format(member.valueEur)} · {pct} %
                    </small>
                  </div>
                );
              })}
            </div>
          </section>

          <Indicators records={records} bitcoinEur={bitcoinEur} embedded />

          <section className="panel activity-panel">
            <PanelTitle eyebrow="JOURNAL" title="Dernières opérations Bitcoin" action="Voir l’historique complet" onAction={() => setTab("historique")} />
            <div className="activity-list">
              {recentOperations.length === 0 ? (
                <p>Aucune opération enregistrée pour l’instant.</p>
              ) : (
                recentOperations.map((item) => (
                  <div className="activity-item" key={item.key}>
                    <span className="activity-mark">{item.member.slice(0, 1)}</span>
                    <div>
                      <strong>{item.label}</strong>
                      <p>
                        {item.member} · {euro.format(item.amountEur)} · {item.btcAmount.toFixed(8)} BTC
                      </p>
                    </div>
                    <time>{fullDate.format(new Date(item.date + "T00:00:00Z"))}</time>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="panel">
            <PanelTitle eyebrow="PÉDAGOGIE" title="Comprendre votre Bitcoin" action="En savoir plus" onAction={() => setTab("comprendre")} />
            <ul className="bitcoin-teaching-list">
              <li>Les cadeaux d’Amatxi sont une origine d’investissement parmi d’autres.</li>
              <li>Les achats personnels sont suivis séparément des cadeaux.</li>
              <li>Les BTC peuvent être conservés sur Binance avant d’être transférés vers Ledger.</li>
              <li>Le prix moyen d’achat aide à suivre votre performance dans le temps.</li>
            </ul>
          </section>
        </>
      )}

      {activeTab === "membres" &&
        (isAdmin ? (
          <>
            <div className="bitcoin-member-table-wrap table-panel panel">
              <PanelTitle eyebrow="MEMBRES" title="Répartition par membre" />
              <div className="responsive-table">
                <table>
                  <thead>
                    <tr>
                      <th>Membre</th>
                      <th>BTC total</th>
                      <th>Valeur actuelle</th>
                      <th>Montant offert</th>
                      <th>Plus-value</th>
                      <th>Binance</th>
                      <th>Ledger</th>
                      <th>Transferts</th>
                      <th aria-hidden="true" />
                    </tr>
                  </thead>
                  <tbody>
                    {memberSummaries.map((member) => (
                      <tr key={member.name}>
                        <td>{member.name}</td>
                        <td>{member.btc.toFixed(8)} BTC</td>
                        <td>{member.valueEur === null ? "—" : euro.format(member.valueEur)}</td>
                        <td>{euro.format(member.investedEur)}</td>
                        <td>{member.gainEur === null ? "—" : `${member.gainEur >= 0 ? "+" : ""}${euro.format(member.gainEur)}`}</td>
                        <td>{member.binanceBtc.toFixed(8)} BTC</td>
                        <td>{member.ledgerBtc.toFixed(8)} BTC</td>
                        <td>{member.pending > 0 ? `${member.pending} en attente` : "—"}</td>
                        <td>
                          <button type="button" className="stat-card-link" onClick={() => onOpenMemberDetail(member.name)}>
                            Voir le détail →
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="bitcoin-member-cards">
              {memberSummaries.map((member) => (
                <article className="bitcoin-member-card" key={member.name}>
                  <header>
                    <strong>{member.name}</strong>
                    <button type="button" onClick={() => onOpenMemberDetail(member.name)}>
                      Détail →
                    </button>
                  </header>
                  <p className="bitcoin-member-card-value">{member.valueEur === null ? `${member.btc.toFixed(8)} BTC` : euro.format(member.valueEur)}</p>
                  <dl>
                    <div><dt>BTC total</dt><dd>{member.btc.toFixed(8)}</dd></div>
                    <div><dt>Offert</dt><dd>{euro.format(member.investedEur)}</dd></div>
                    <div><dt>Plus-value</dt><dd>{member.gainEur === null ? "—" : euro.format(member.gainEur)}</dd></div>
                    <div><dt>Binance</dt><dd>{member.binanceBtc.toFixed(8)}</dd></div>
                    <div><dt>Ledger</dt><dd>{member.ledgerBtc.toFixed(8)}</dd></div>
                    <div><dt>Transferts</dt><dd>{member.pending}</dd></div>
                  </dl>
                </article>
              ))}
            </div>
          </>
        ) : (
          <GiftPortfolio viewer={viewer} requests={transferRequests} onRequestStatus={onRequestStatus} selectedMember={viewer.name} previewReadOnly={isPreview} onOpenTransactions={onOpenTransactions} />
        ))}

      {activeTab === "investir" &&
        (isAdmin ? (
          <>
            <section className="panel">
              <PanelTitle eyebrow="INVESTIR" title="Enregistrer un achat Bitcoin" />
              <p>Utilisez le formulaire habituel pour enregistrer un cadeau d’Amatxi, un achat personnel ou un achat groupé. Chaque opération est écrite directement dans le registre familial.</p>
              {canManageGifts && (
                <button type="button" className="primary-button" onClick={openModal}>
                  ＋ Enregistrer un achat BTC
                </button>
              )}
            </section>
            <section className="panel activity-panel">
              <PanelTitle eyebrow="JOURNAL" title="Derniers achats enregistrés" />
              <div className="activity-list">
                {recentOperations.length === 0 ? (
                  <p>Aucun achat enregistré pour l’instant.</p>
                ) : (
                  recentOperations.map((item) => (
                    <div className="activity-item" key={item.key}>
                      <span className="activity-mark">{item.member.slice(0, 1)}</span>
                      <div>
                        <strong>{item.label}</strong>
                        <p>
                          {item.member} · {euro.format(item.amountEur)} · {item.btcAmount.toFixed(8)} BTC
                        </p>
                      </div>
                      <time>{fullDate.format(new Date(item.date + "T00:00:00Z"))}</time>
                    </div>
                  ))
                )}
              </div>
            </section>
          </>
        ) : (
          <section className="panel coming-soon-panel">
            <span className="soft-pill">INVESTIR</span>
            <h2>Les achats sont gérés par l’administrateur</h2>
            <p>Pour l’instant, seul l’administrateur enregistre les achats Bitcoin pour la famille (cadeaux d’Amatxi, achats personnels ou groupés). Vous pouvez suivre l’ensemble de vos BTC dans l’onglet « Mes BTC ».</p>
            <span className="coming-soon-badge">Bientôt : demande d’investissement</span>
          </section>
        ))}

      {activeTab === "conservation" && (
        <>
          <section className="panel">
            <PanelTitle eyebrow="CONSERVATION" title="Où sont les bitcoins de la famille ?" />
            <div className="bitcoin-custody-grid">
              <div className="bitcoin-custody-row">
                <div className="bitcoin-custody-row-head">
                  <span>Sur Binance commun</span>
                  <strong>{custody.binanceCommunBtc.toFixed(8)} BTC{bitcoinEur ? ` · ${euro.format(custody.binanceCommunBtc * bitcoinEur)}` : ""}</strong>
                </div>
                <div className="progress"><span style={{ width: `${totalBtc > 0 ? Math.round((custody.binanceCommunBtc / totalBtc) * 100) : 0}%` }} /></div>
                <small>{custody.binanceCommunCount} lot{custody.binanceCommunCount > 1 ? "s" : ""} · {totalBtc > 0 ? Math.round((custody.binanceCommunBtc / totalBtc) * 100) : 0} % du total</small>
              </div>
              <div className="bitcoin-custody-row">
                <div className="bitcoin-custody-row-head">
                  <span>Sur Ledger</span>
                  <strong>{custody.ledgerBtc.toFixed(8)} BTC{bitcoinEur ? ` · ${euro.format(custody.ledgerBtc * bitcoinEur)}` : ""}</strong>
                </div>
                <div className="progress"><span style={{ width: `${totalBtc > 0 ? Math.round((custody.ledgerBtc / totalBtc) * 100) : 0}%` }} /></div>
                <small>{custody.ledgerCount} lot{custody.ledgerCount > 1 ? "s" : ""} · {totalBtc > 0 ? Math.round((custody.ledgerBtc / totalBtc) * 100) : 0} % du total</small>
              </div>
              {custody.unclassifiedBtc > 0 && (
                <div className="bitcoin-custody-row">
                  <div className="bitcoin-custody-row-head">
                    <span>À rapprocher</span>
                    <strong>{custody.unclassifiedBtc.toFixed(8)} BTC</strong>
                  </div>
                  <div className="progress"><span style={{ width: `${totalBtc > 0 ? Math.round((custody.unclassifiedBtc / totalBtc) * 100) : 0}%` }} /></div>
                  <small>{custody.unclassifiedCount} lot{custody.unclassifiedCount > 1 ? "s" : ""} à classer</small>
                </div>
              )}
            </div>
          </section>

          <section className="panel">
            <PanelTitle eyebrow="TRANSFERTS" title="Transferts vers Ledger" action={isAdmin ? "Voir tous les transferts" : undefined} onAction={isAdmin ? () => setTab("transferts") : undefined} />
            {pendingTransfers.length === 0 ? (
              <p>Aucun transfert en attente.</p>
            ) : (
              <ul className="bitcoin-transfers-list">
                {pendingTransfers.map((request) => (
                  <li key={request.id}>
                    <div>
                      <strong>{request.member}</strong>
                      <small>{request.btcAmount?.toFixed(8) ?? "Montant à confirmer"} BTC · {request.requestedAt}</small>
                    </div>
                    <span className="access pending">{request.status}</span>
                  </li>
                ))}
              </ul>
            )}
            {lastCompletedTransfer && (
              <p className="bitcoin-last-transfer">
                Dernier transfert effectué : {lastCompletedTransfer.member} · {lastCompletedTransfer.btcAmount?.toFixed(8) ?? "—"} BTC
              </p>
            )}
          </section>

          <div className="info-callout">
            <b>Statut de sécurité</b>
            <p>Le Ledger est un portefeuille personnel : vous seuls détenez les clés. Binance commun est une plateforme tierce, en attente de transfert vers Ledger.</p>
          </div>

          {canManageGifts && (
            <button type="button" className="secondary-button" onClick={() => setTab("membres")}>
              Préparer un transfert
            </button>
          )}
        </>
      )}

      {activeTab === "transferts" && isAdmin && (
        <section className="panel">
          <PanelTitle eyebrow="TRANSFERTS" title="Demandes de transfert Binance → Ledger" />
          {transferRequests.length === 0 ? (
            <p>Aucune demande de transfert pour l’instant.</p>
          ) : (
            <ul className="bitcoin-transfers-list">
              {transferRequests.map((request) => (
                <li key={request.id}>
                  <div>
                    <strong>{request.member}</strong>
                    <small>{request.btcAmount?.toFixed(8) ?? "Montant à confirmer"} BTC · {request.requestedAt}</small>
                  </div>
                  <select value={request.status} onChange={(event) => onRequestStatus(request.id, event.target.value as TransferRequest["status"])}>
                    <option>Nouvelle</option>
                    <option>En traitement</option>
                    <option>Transférée</option>
                  </select>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {activeTab === "performance" && <Indicators records={records} bitcoinEur={bitcoinEur} />}

      {activeTab === "historique" && (
        <TransactionsView
          transactions={transactions}
          isAdmin={isAdmin}
          viewerName={viewer.name}
          onAdd={openModal}
          onTransferRequest={onTransferRequest}
          onOpenPortfolio={(member) => onOpenMemberDetail(member)}
          shortcut={transactionShortcut}
          reloadKey={transactionsReloadKey}
        />
      )}

      {activeTab === "comprendre" && (
        <>
          <section className="learn-head">
            <span className="soft-pill">COMPRENDRE</span>
            <h2>Le Bitcoin de la famille, expliqué simplement.</h2>
            <p>Des réponses courtes aux questions les plus utiles pour suivre vos BTC sereinement.</p>
          </section>
          <section className="lesson-grid">
            <article className="lesson-card">
              <div className="lesson-icon amber">₿</div>
              <span>LES BASES</span>
              <h3>Qu’est-ce que le Bitcoin ?</h3>
              <p>Une monnaie numérique que l’on peut recevoir en cadeau ou acheter, puis conserver sur un portefeuille sécurisé.</p>
            </article>
            <article className="lesson-card">
              <div className="lesson-icon teal">🎁</div>
              <span>CADEAU OU INVESTISSEMENT</span>
              <h3>Cadeau ou investissement personnel ?</h3>
              <p>Un cadeau d’Amatxi est offert par la famille ; un investissement personnel est un achat que vous financez vous-même. Les deux sont suivis séparément.</p>
            </article>
            <article className="lesson-card">
              <div className="lesson-icon navy">↗</div>
              <span>PERFORMANCE</span>
              <h3>C’est quoi le prix moyen d’achat ?</h3>
              <p>La moyenne pondérée de tous les prix payés pour vos BTC : elle sert de référence pour calculer votre gain ou votre perte.</p>
            </article>
            <article className="lesson-card">
              <div className="lesson-icon teal">⌾</div>
              <span>SÉCURITÉ</span>
              <h3>Pourquoi transférer vers Ledger ?</h3>
              <p>Ledger est un portefeuille personnel : vous seuls détenez les clés. Binance commun est une plateforme tierce, en attente de transfert.</p>
            </article>
            <article className="lesson-card">
              <div className="lesson-icon amber">⇅</div>
              <span>MARCHÉ</span>
              <h3>Pourquoi le prix du Bitcoin varie ?</h3>
              <p>Comme toute monnaie ou tout actif, son prix évolue selon l’offre et la demande sur les marchés, jour après jour.</p>
            </article>
            <article className="lesson-card">
              <div className="lesson-icon coral">📅</div>
              <span>MÉTHODE</span>
              <h3>Pourquoi investir régulièrement ?</h3>
              <p>Investir un peu, souvent, lisse les variations de prix et évite de devoir deviner le bon moment.</p>
            </article>
          </section>
        </>
      )}
    </div>
  );
}
