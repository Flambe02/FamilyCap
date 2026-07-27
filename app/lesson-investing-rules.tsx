"use client";

import { useDialogA11y } from "./use-dialog-a11y";
import "./lesson-investing-rules.css";

const ESSENTIALS = [
  "Penser à long terme", "Investir régulièrement", "Respecter son profil de risque", "Comprendre ce que l’on achète",
  "Diversifier son portefeuille", "Regarder les perspectives futures", "Suivre ses investissements sans stress",
];

const CHAPTERS = [
  { group: "Construire une bonne méthode", number: "01", title: "Pensez en années, pas en semaines", body: ["La Bourse peut fortement varier à court terme. Sur une longue période, le capital profite davantage de la croissance des entreprises et du mécanisme des intérêts composés.", "Plus on commence tôt, plus le temps peut devenir un allié."], takeaway: "La patience compte souvent davantage que la rapidité." },
  { group: "Construire une bonne méthode", number: "02", title: "N’attendez pas le moment parfait", body: ["Personne ne sait prévoir précisément les hausses et les baisses des marchés. Attendre le moment idéal peut conduire à ne jamais commencer.", "Investir une somme fixe chaque mois permet de lisser le prix d’achat et de limiter les décisions dictées par les émotions."], takeaway: "La régularité est généralement plus efficace que la recherche du moment parfait." },
  { group: "Construire une bonne méthode", number: "03", title: "Respectez votre profil de risque", body: ["La bonne stratégie dépend de votre horizon, de vos objectifs et de votre capacité à supporter une baisse temporaire.", "Il ne faut pas investir en Bourse de l’argent dont on pourrait avoir besoin prochainement."], takeaway: "Choisissez un portefeuille que vous serez capable de conserver pendant les périodes difficiles." },
  { group: "Bien choisir ses investissements", number: "04", title: "Comprenez ce que vous achetez", body: ["Une entreprise populaire ou une technologie à la mode ne constitue pas automatiquement un bon investissement.", "Pour une action, examinez l’activité, la rentabilité, la dette et le prix demandé. Pour un ETF, vérifiez l’indice suivi, les frais, la diversification et l’éligibilité au compte utilisé."], takeaway: "N’investissez jamais dans un produit que vous ne comprenez pas." },
  { group: "Bien choisir ses investissements", number: "05", title: "Diversifiez simplement", body: ["Concentrer tout son argent sur une seule entreprise, un seul secteur ou un seul pays augmente fortement le risque.", "Un ETF Monde peut déjà donner accès à plusieurs centaines ou milliers d’entreprises. Il permet de construire simplement une base diversifiée."], takeaway: "Ne mettez pas tous vos œufs dans le même panier, mais gardez un portefeuille simple et lisible." },
  { group: "Garder le cap", number: "06", title: "Regardez l’avenir, pas uniquement le passé", body: ["Les performances passées ne garantissent pas les résultats futurs. Une action qui a beaucoup progressé peut ralentir. Une entreprise en difficulté peut aussi se redresser.", "Il faut surtout analyser ses perspectives, sa solidité et le prix actuel. Le prix auquel l’action a été achetée ne doit pas dicter seul la décision."], takeaway: "Le prix d’achat appartient au passé. Ce sont les perspectives futures qui comptent." },
  { group: "Garder le cap", number: "07", title: "Informez-vous sans surveiller constamment", body: ["Investir ne signifie pas consulter les cours toutes les heures. Il est cependant utile de vérifier périodiquement que les placements correspondent toujours à la stratégie initiale.", "Pour un investisseur de long terme, une revue du portefeuille une ou deux fois par an peut suffire."], takeaway: "Suivez votre stratégie, pas le bruit quotidien des marchés." },
] as const;

export function InvestingRulesLesson({ onClose, onDefineRhythm, onOpenPeaPortfolio }: { onClose: () => void; onDefineRhythm: () => void; onOpenPeaPortfolio: () => void }) {
  const dialogRef = useDialogA11y(true, onClose);
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className="modal investing-rules-modal" role="dialog" aria-modal="true" aria-labelledby="investing-rules-title" tabIndex={-1}>
        <header>
          <div><span>BOURSE · LEÇON</span><h2 id="investing-rules-title">Les 7 règles essentielles pour bien investir</h2></div>
          <button type="button" onClick={onClose} aria-label="Fermer la leçon">×</button>
        </header>
        <div className="investing-rules-body">
          <p className="investing-rules-intro">Investir efficacement ne consiste pas à prévoir chaque mouvement de la Bourse. Il s’agit surtout d’appliquer quelques principes simples avec régularité, patience et discipline.</p>
          <div className="investing-rules-meta" aria-label="Informations sur la leçon"><span>Lecture · 5 min</span><span>Niveau · Débutant</span><span>Thème · Bonnes pratiques</span></div>

          <section className="investing-rules-essential" aria-labelledby="investing-rules-essential-title">
            <h3 id="investing-rules-essential-title">L’essentiel en 30 secondes</h3>
            <ol>{ESSENTIALS.map((item, index) => <li key={item}><b>{String(index + 1).padStart(2, "0")}</b><span>{item}</span></li>)}</ol>
          </section>

          <div className="investing-rules-chapters">
            {CHAPTERS.map((chapter, index) => {
              const showGroup = index === 0 || chapter.group !== CHAPTERS[index - 1].group;
              return (
                <section className="investing-rules-chapter" key={chapter.number}>
                  {showGroup && <h3 className="investing-rules-group">{chapter.group}</h3>}
                  <div className="investing-rules-chapter-heading"><span>{chapter.number}</span><h4>{chapter.title}</h4></div>
                  {chapter.body.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
                  <aside className="investing-rules-takeaway"><b>À retenir</b><p>{chapter.takeaway}</p></aside>
                </section>
              );
            })}
          </div>

          <section className="investing-rules-start">
            <h3>Pour commencer simplement</h3>
            <ol>
              <li>Définir un montant à investir chaque mois</li><li>Choisir son horizon d’investissement</li>
              <li>Commencer avec un portefeuille diversifié</li><li>Programmer une revue tous les six mois</li>
            </ol>
          </section>
          <div className="investing-rules-actions">
            <button type="button" className="primary-button" onClick={onDefineRhythm}>Définir mon rythme d’investissement</button>
            <button type="button" className="secondary-button" onClick={onOpenPeaPortfolio}>Découvrir le portefeuille PEA type</button>
          </div>
          <p className="investing-rules-disclaimer">Investir comporte un risque de perte en capital. Ce contenu est pédagogique et ne constitue pas un conseil financier personnalisé.</p>
        </div>
      </section>
    </div>
  );
}
