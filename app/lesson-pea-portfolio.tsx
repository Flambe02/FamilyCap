"use client";

import { useState } from "react";
import { useDialogA11y } from "./use-dialog-a11y";
import { DonutChart, LegendRow, useDonutSegments } from "./bitcoin-components";
import "./lesson-pea-portfolio.css";

// Contenu pédagogique statique — aucune donnée personnelle, aucun portefeuille réel.
// Les frais/caractéristiques sont indicatifs : l'utilisateur est renvoyé vers la fiche
// officielle de chaque ETF avant toute décision.
const ALLOCATION = [
  { key: "world", label: "MSCI World", pct: 80, color: "#3f6ea5" },
  { key: "emerging", label: "Marchés émergents", pct: 10, color: "#1d706b" },
  { key: "cac40", label: "CAC 40", pct: 10, color: "#f3b649" },
] as const;

const ETFS = [
  {
    name: "iShares MSCI World Swap PEA UCITS ETF",
    ticker: "WPEA",
    isin: "IE0002XZSHO1",
    allocationPct: 80,
    index: "MSCI World",
    features: ["Éligible au PEA", "Capitalisant", "Réplication synthétique", "Frais annuels indicatifs : 0,20 %"],
    url: "https://www.blackrock.com/fr/intermediaries/products/335178/ishares-msci-world-swap-pea-ucits-etf",
  },
  {
    name: "Amundi PEA Emergent (MSCI Emerging) ESG Transition UCITS ETF",
    ticker: "PAEEM",
    isin: "FR0013412020",
    allocationPct: 10,
    index: "Indice de marchés émergents intégrant des critères ESG et de transition climatique",
    features: ["Éligible au PEA", "Réplication synthétique", "Frais annuels indicatifs : 0,30 %", "Exposition aux principales économies émergentes"],
    url: "https://www.amundietf.fr/fr/professionnels/produits/equity/amundi-pea-emergent-msci-emerging-esg-transition-ucits-etf-acc/fr0013412020",
  },
  {
    name: "Amundi CAC 40 UCITS ETF Acc",
    ticker: null,
    isin: "FR0013380607",
    allocationPct: 10,
    index: "CAC 40 Total Return",
    features: ["Éligible au PEA", "Capitalisant", "Réplication physique", "Frais annuels indicatifs : 0,25 %"],
    url: "https://www.amundietf.fr/fr/professionnels/produits/equity/amundi-cac-40-ucits-etf-acc/fr0013380607",
  },
] as const;

export function PeaPortfolioLesson({ onClose }: { onClose: () => void }) {
  const dialogRef = useDialogA11y(true, onClose);
  const segments = useDonutSegments(ALLOCATION.map((a) => ({ label: a.label, value: a.pct, color: a.color })));
  const [copiedIsin, setCopiedIsin] = useState<string | null>(null);

  async function copyIsin(isin: string) {
    try {
      await navigator.clipboard.writeText(isin);
      setCopiedIsin(isin);
      window.setTimeout(() => setCopiedIsin((current) => (current === isin ? null : current)), 2000);
    } catch {
      setCopiedIsin(null);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className="modal pea-lesson-modal" role="dialog" aria-modal="true" aria-labelledby="pea-lesson-title" tabIndex={-1}>
        <header>
          <div><span>PEA · LEÇON</span><h2 id="pea-lesson-title">Le portefeuille PEA type</h2></div>
          <button type="button" onClick={onClose} aria-label="Fermer la leçon">×</button>
        </header>

        <div className="pea-lesson-body">
          <p className="pea-lesson-intro">
            Pour investir sur une durée de 15 ans ou plus, il n’est pas nécessaire de multiplier les actions et les
            produits financiers. Trois ETF peuvent permettre de construire un portefeuille mondial, diversifié et
            facile à suivre.
          </p>

          <div className="pea-lesson-alloc">
            <div className="pea-lesson-alloc-chart">
              <DonutChart segments={segments} centerTop="100 %" centerBottom="Allocation cible" ariaLabel="Répartition cible : 80 % MSCI World, 10 % marchés émergents, 10 % CAC 40" />
              <ul className="btc-legend">
                {ALLOCATION.map((a) => <LegendRow key={a.key} color={a.color} name={a.label} value={`${a.pct} %`} />)}
              </ul>
            </div>
            <div className="responsive-table pea-lesson-table-wrap">
              <table className="btc-table pea-lesson-table">
                <thead><tr><th>Allocation</th><th>Support</th></tr></thead>
                <tbody>
                  {ALLOCATION.map((a) => (
                    <tr key={a.key}>
                      <td data-label="Allocation"><b>{a.pct} %</b></td>
                      <td data-label="Support">{a.label}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <section className="pea-lesson-section">
            <h3>Pourquoi cette allocation ?</h3>
            <div className="pea-lesson-why">
              <article>
                <h4>80 % MSCI World</h4>
                <p>Le cœur du portefeuille. Il donne accès aux grandes et moyennes entreprises des principaux pays développés, notamment les États-Unis, le Japon, le Royaume-Uni, le Canada et plusieurs pays européens.</p>
              </article>
              <article>
                <h4>10 % Marchés émergents</h4>
                <p>Cette poche complète le MSCI World avec des pays qui n’y figurent pas, comme l’Inde, la Chine, Taïwan ou le Brésil.</p>
              </article>
              <article>
                <h4>10 % CAC 40</h4>
                <p>Cette allocation ajoute volontairement une exposition aux grandes entreprises françaises. Elle crée un léger biais France, tout en conservant une diversification principalement mondiale.</p>
              </article>
            </div>
            <div className="info-callout">
              <b>À savoir</b>
              <p>Le CAC 40 et le MSCI World peuvent détenir certaines entreprises françaises en commun. Cette poche de 10 % correspond donc à un choix volontaire de renforcer modérément la France.</p>
            </div>
          </section>

          <section className="pea-lesson-section">
            <h3>Les trois ETF de référence</h3>
            <div className="pea-etf-grid">
              {ETFS.map((etf) => (
                <article className="pea-etf-card" key={etf.isin}>
                  <header>
                    <span className="pea-etf-alloc">{etf.allocationPct} %</span>
                    <div>
                      <h4>{etf.name}</h4>
                      {etf.ticker && <span className="pea-etf-ticker">{etf.ticker}</span>}
                    </div>
                  </header>
                  <dl className="pea-etf-meta">
                    <div>
                      <dt>ISIN</dt>
                      <dd>
                        <code>{etf.isin}</code>
                        <button type="button" className="set-btn" onClick={() => void copyIsin(etf.isin)}>{copiedIsin === etf.isin ? "Copié !" : "Copier"}</button>
                      </dd>
                    </div>
                    <div><dt>Indice suivi</dt><dd>{etf.index}</dd></div>
                  </dl>
                  <ul className="pea-etf-features">
                    {etf.features.map((feature) => <li key={feature}>{feature}</li>)}
                  </ul>
                  <a className="set-btn pea-etf-link" href={etf.url} target="_blank" rel="noopener noreferrer">Voir la fiche officielle ↗</a>
                </article>
              ))}
            </div>
            <p className="pea-lesson-note">Les frais et caractéristiques indiqués sont donnés à titre indicatif : vérifiez-les toujours sur la fiche officielle de chaque ETF avant tout investissement.</p>
          </section>

          <section className="pea-lesson-section">
            <h3>Comment gérer ce portefeuille ?</h3>
            <ol className="pea-lesson-rules">
              <li>Investir régulièrement sans chercher à prévoir le meilleur moment.</li>
              <li>Utiliser les nouveaux versements pour renforcer la poche la plus éloignée de son allocation cible.</li>
              <li>Vérifier et rééquilibrer le portefeuille une fois par an.</li>
              <li>Conserver un horizon d’au moins 15 ans et accepter les fluctuations temporaires des marchés.</li>
            </ol>
            <div className="pea-lesson-example">
              <strong>Exemple — pour 1 000 € investis</strong>
              <ul>
                <li>800 € sur le MSCI World</li>
                <li>100 € sur les marchés émergents</li>
                <li>100 € sur le CAC 40</li>
              </ul>
              <p>Pour de petits versements, il n’est pas nécessaire de passer trois ordres à chaque fois : mieux vaut acheter en priorité l’ETF le plus sous-pondéré.</p>
            </div>
          </section>

          <div className="info-callout">
            <b>Avertissement pédagogique</b>
            <p>Ce portefeuille est un modèle pédagogique de long terme. Il ne constitue pas un conseil financier personnalisé. La valeur des ETF peut monter ou baisser et une perte en capital reste possible. L’éligibilité au PEA et les caractéristiques des fonds doivent être vérifiées sur les fiches officielles avant toute opération.</p>
          </div>
        </div>
      </section>
    </div>
  );
}
