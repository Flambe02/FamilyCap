"use client";

// Leçon « Épargne et temps : le duo qui fait grandir votre argent ».
// Slug éditorial : epargne-temps-interets-composes (voir LESSON_SLUG plus bas).
//
// Même architecture que les deux leçons existantes : contenu statique, modale accessible ouverte
// depuis le catalogue « Apprendre », `useDialogA11y` pour le piège de focus / Échap / restauration
// du focus, et les classes partagées de family.css (.modal, .info-callout, .primary-button).
// Aucune table Supabase, aucune route : les articles sont locaux dans ce projet.
//
// Tous les chiffres viennent de `lib/savings-simulation.ts`, qui les CALCULE. Rien n'est recopié
// à la main ici, et `tests/lesson-savings-time.test.mjs` vérifie que les valeurs produites sont
// bien celles de la référence éditoriale validée.

import { useDialogA11y } from "./use-dialog-a11y";
import { NavIcon } from "./dashboard-ui";
import { euro0 } from "./bitcoin-components";
import { SavingsIllustration } from "./lesson-savings-illustration";
import { ChartLegend, ColumnGroupChart, HorizontalBarChart, TimeSeriesChart, eurAxis, type ChartTable } from "./lesson-charts";
import {
  BASE_RETURN_RATE, COMPOUND_ROWS, DOUBLING_HIGHLIGHT, DOUBLING_ROWS, EFFORT_HIGHLIGHT, EFFORT_ROWS,
  FEE_ROWS, INFLATION_ROWS, SAVINGS_TARGET, WITHDRAWAL_ROWS, frNumber, frPercent,
} from "../lib/savings-simulation";
import "./lesson-savings-time.css";

export const LESSON_SLUG = "epargne-temps-interets-composes";

const TARGET_LABEL = euro0.format(SAVINGS_TARGET);
const BASE_RATE_LABEL = frPercent(BASE_RETURN_RATE * 100);

// Palette des graphiques : vert CapFamily (--teal), déclinaisons sauge et bleues de la charte de
// l'illustration, orange réservé au SEUL affichage d'un écart.
const GREEN = "#1d706b";
const GREEN_SOFT = "#67b88a";
const BLUE = "#3f6ea5";
const BLUE_PALE = "#8eb9d6";
const BLUE_NIGHT = "#2f5670";
const ORANGE = "#e5a45a";
/** Dégradé très discret bleu → vert du graphique de la règle des 72. */
const DOUBLING_RAMP = ["#3f6ea5", "#386e99", "#316f8e", "#2b6f82", "#247077", GREEN];

const ESSENTIALS = [
  "Plus vous épargnez chaque mois, plus vite vous atteignez votre objectif.",
  "Plus vous commencez tôt, plus les gains ont le temps de produire de nouveaux gains.",
  "Quelques dixièmes de frais annuels peuvent coûter cher sur plusieurs décennies.",
  "Le bon résultat n’est pas seulement le capital affiché. C’est aussi ce qu’il permettra réellement d’acheter.",
];

const ACTION_PLAN = [
  "Constituez d’abord une épargne de précaution.",
  "Choisissez un montant mensuel réaliste.",
  "Automatisez le versement si possible.",
  "Utilisez des placements diversifiés que vous comprenez.",
  "Vérifiez les frais.",
  "Revoyez votre stratégie une ou deux fois par an, sans réagir à chaque variation des marchés.",
];

const SOURCES = [
  { label: "AMF — simulateur d’effort d’épargne", url: "https://www.amf-france.org/fr/espace-epargnants/lexique-simulateurs-et-outils-pratiques/nos-simulateurs/combien-epargner-et-pour-quel-resultat" },
  { label: "AMF — simulateurs de frais et d’épargne", url: "https://www.amf-france.org/fr/espace-epargnants/lexique-simulateurs-et-outils-pratiques/nos-simulateurs" },
  { label: "La finance pour tous — intérêts composés et règle des 72", url: "https://www.lafinancepourtous.com/decryptages/finance-perso/epargne-et-placement/calculer-le-taux-de-rendement-d-un-placement-grace-a-la-regle-d-einstein/" },
  { label: "La finance pour tous — rendement nominal et rendement réel", url: "https://www.lafinancepourtous.com/decryptages/finance-perso/banque-et-credit/taux-d-interet/de-quels-taux-parle-t-on/" },
];

// Micro-illustrations de section. Le jeu d'icônes de l'application (NavIcon) fournit déjà le
// calendrier et la pousse ; les trois autres n'y existent pas et sont dessinées ici avec exactement
// la même grammaire (24×24, trait courant, épaisseur 1,9, extrémités arrondies, une seule couleur).
const STROKE = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

const ClockArrowIcon = () => (
  <svg {...STROKE}><path d="M20.5 12a8.5 8.5 0 1 1-2.9-6.4" /><polyline points="21 3.4 20.8 8.4 15.9 7.6" /><path d="M12 7.6V12l3 1.9" /></svg>
);
const DivergingIcon = () => (
  <svg {...STROKE}><path d="M3 17c5.5 0 11.5-3.9 18-12" /><path d="M3 17.6c5.5.4 11.5-2.2 18-7.4" /><path d="M20.6 5.6v4.4" /></svg>
);
const ShrinkIcon = () => (
  <svg {...STROKE}><rect x="3" y="6.4" width="8" height="11.2" rx="2.2" /><path d="M14 6.4h7" strokeDasharray="2.4 2.6" /><rect x="14" y="11" width="7" height="6.6" rx="2" /></svg>
);

// Volontairement un <div> et non un <header> : family.css style TOUT `header` situé dans une
// `.modal` (`justify-content: space-between`, `align-items: start`, `span` en 8 px capitales) pour
// l'en-tête de la modale elle-même. Un second `header` imbriqué héritait de ces règles et
// renvoyait le titre de section à droite de l'écran.
function SectionHead({ number, icon, title, id }: { number: string; icon: React.ReactNode; title: string; id: string }) {
  return (
    <div className="sav-head">
      <span className="sav-head-icon" aria-hidden="true">{icon}</span>
      <div>
        <span className="sav-head-number" aria-hidden="true">{number}</span>
        <h3 id={id}>{title}</h3>
      </div>
    </div>
  );
}

function Takeaway({ children }: { children: React.ReactNode }) {
  return <aside className="sav-takeaway"><b>À retenir</b><p>{children}</p></aside>;
}

// ---------------------------------------------------------------------------------------------
// Jeux de données transformés pour les graphiques
// ---------------------------------------------------------------------------------------------

const EFFORT_TABLE: ChartTable = {
  caption: `Durée nécessaire pour atteindre ${TARGET_LABEL} selon le versement mensuel, avec un rendement annualisé constant de ${BASE_RATE_LABEL}.`,
  head: ["Versement mensuel", "Durée estimée"],
  rows: EFFORT_ROWS.map((row) => [`${euro0.format(row.monthlyAmount)} par mois`, row.displayDuration]),
};

const COMPOUND_TABLE: ChartTable = {
  caption: `Versements cumulés, gains et capital estimé pour 1 000 € investis chaque mois à ${BASE_RATE_LABEL} par an.`,
  head: ["Année", "Versements cumulés", "Gains estimés", "Capital estimé"],
  rows: COMPOUND_ROWS.map((row) => [`Année ${row.year}`, euro0.format(row.contributions), euro0.format(row.gains), euro0.format(row.capital)]),
};

const DOUBLING_TABLE: ChartTable = {
  caption: "Temps de doublement approximatif d’un capital selon le rendement annuel supposé, estimé avec la règle des 72.",
  head: ["Rendement annuel", "Temps de doublement"],
  rows: DOUBLING_ROWS.map((row) => [frPercent(row.rate), `${frNumber(row.years)} ans`]),
};

const FEE_TABLE: ChartTable = {
  caption: "Capital estimé pour 500 € investis chaque mois, sans frais (5 % brut) puis après 0,6 % de frais annuels (4,4 % net simplifié).",
  head: ["Année", "Sans frais", "Après frais", "Écart"],
  rows: FEE_ROWS.map((row) => [`Année ${row.year}`, euro0.format(row.gross), euro0.format(row.net), euro0.format(row.difference)]),
};

const INFLATION_TABLE: ChartTable = {
  caption: "Capital nominal après 20 ans pour 1 000 € investis chaque mois, puis pouvoir d’achat correspondant en euros d’aujourd’hui selon l’inflation moyenne.",
  head: ["Scénario", "Capital nominal", "Inflation 1 %", "Inflation 2,2 %", "Inflation 5 %"],
  rows: INFLATION_ROWS.map((row) => [
    `Rendement de ${frPercent(row.returnRate)} par an`,
    euro0.format(row.nominal),
    ...row.real.map((real) => euro0.format(real.value)),
  ]),
};

// ---------------------------------------------------------------------------------------------

export function SavingsTimeLesson({ onClose, onDefineRhythm, onOpenPeaPortfolio }: {
  onClose: () => void; onDefineRhythm: () => void; onOpenPeaPortfolio: () => void;
}) {
  const dialogRef = useDialogA11y(true, onClose);

  // Pas de barre de progression de lecture : `.modal` porte 28 px de padding et son en-tête n'est
  // pas collant. Un filet `sticky` s'y épingle sous le padding, donc du texte défile au-dessus de
  // lui et le barre visuellement. Le cahier des charges la demande « uniquement si elle s'intègre
  // naturellement au système existant » — ce n'est pas le cas sans retoucher la modale partagée.
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className="modal savings-lesson-modal" role="dialog" aria-modal="true" aria-labelledby="savings-lesson-title" tabIndex={-1}>
        <header>
          <div>
            <span>INVESTISSEMENT · LEÇON</span>
            <h2 id="savings-lesson-title">Épargne et temps : le duo qui fait grandir votre argent</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Fermer la leçon">×</button>
        </header>

        <div className="savings-lesson-body">
          <SavingsIllustration variant="hero" label="Formes géométriques progressant le long d’une courbe pour illustrer les intérêts composés." />

          <p className="sav-intro">
            Construire un patrimoine ne demande pas forcément de trouver l’investissement parfait. Le plus important
            est souvent plus simple : commencer, investir régulièrement et laisser du temps à son argent.
          </p>
          <p className="sav-intro sav-intro-second">
            Les intérêts composés accélèrent progressivement la croissance du capital. Mais les frais et l’inflation
            peuvent aussi ralentir le résultat. Voici les idées essentielles à comprendre.
          </p>

          <div className="sav-meta" aria-label="Informations sur la leçon">
            <span>Lecture · 6 min</span><span>Niveau · Débutant</span><span>Thème · Construire son patrimoine</span>
          </div>

          <section className="sav-essential" aria-labelledby="sav-essential-title">
            <h3 id="sav-essential-title">L’essentiel en 30 secondes</h3>
            <ol>
              {ESSENTIALS.map((item, index) => (
                <li key={item}><b aria-hidden="true">{String(index + 1).padStart(2, "0")}</b><span>{item}</span></li>
              ))}
            </ol>
          </section>

          {/* -------------------------------------------------------------------- 01 */}
          <section className="sav-section" aria-labelledby="sav-s1-title">
            <SectionHead number="01" icon={<NavIcon id="calendar" />} title="Votre effort mensuel détermine la vitesse" id="sav-s1-title" />
            <p>
              Imaginons un objectif de {TARGET_LABEL}, avec un rendement moyen théorique de {BASE_RATE_LABEL} par an.
            </p>
            <p>
              Avec 500 € investis chaque mois, il faudrait environ 33 ans et 4 mois pour atteindre cet objectif. Avec
              1 000 € par mois, la durée tombe à environ 22 ans et 10 mois. Avec 2 000 € par mois, elle descend à
              environ 14 ans et 5 mois.
            </p>
            <p>
              Le message est simple. Augmenter son effort mensuel raccourcit fortement le parcours. Mais un montant
              modeste reste utile s’il est investi avec régularité pendant suffisamment longtemps.
            </p>

            <HorizontalBarChart
              id="sav-chart-effort"
              title={`Combien de temps pour atteindre ${TARGET_LABEL} ?`}
              subtitle={`Simulation avec versements mensuels en fin de mois et rendement annualisé constant de ${BASE_RATE_LABEL}.`}
              hint={`Survolez ou sélectionnez une barre pour le détail. Repère : ${euro0.format(EFFORT_HIGHLIGHT)} par mois.`}
              table={EFFORT_TABLE}
              data={EFFORT_ROWS.map((row) => {
                const flagged = row.monthlyAmount === EFFORT_HIGHLIGHT;
                return {
                  key: `effort-${row.monthlyAmount}`,
                  label: `${euro0.format(row.monthlyAmount)} / mois`,
                  value: row.years,
                  valueLabel: row.displayDuration,
                  color: flagged ? GREEN : GREEN_SOFT,
                  badge: flagged ? "Repère" : undefined,
                  description: `${euro0.format(row.monthlyAmount)} par mois : ${row.displayDuration} pour atteindre ${TARGET_LABEL}, avec un rendement supposé de ${BASE_RATE_LABEL} par an.`,
                  readout: (
                    <span>
                      <strong>{euro0.format(row.monthlyAmount)} par mois</strong> · objectif {TARGET_LABEL} · rendement supposé {BASE_RATE_LABEL} par an → <em>{row.displayDuration}</em>
                    </span>
                  ),
                };
              })}
            />

            <Takeaway>
              Le meilleur montant n’est pas nécessairement le plus élevé. C’est celui que vous pouvez investir chaque
              mois sans fragiliser votre budget.
            </Takeaway>
          </section>

          {/* -------------------------------------------------------------------- 02 */}
          <section className="sav-section" aria-labelledby="sav-s2-title">
            <SectionHead number="02" icon={<NavIcon id="sprout" />} title="Les intérêts composés font travailler le temps" id="sav-s2-title" />
            <p>
              Les intérêts composés apparaissent lorsque les gains restent investis. Ils rejoignent le capital, puis
              peuvent à leur tour générer de nouveaux gains.
            </p>
            <p>
              Prenons l’exemple d’une personne qui investit 1 000 € par mois avec un rendement moyen théorique de
              {" "}{BASE_RATE_LABEL} par an.
            </p>
            <p>
              Après 10 ans, elle aurait versé 120 000 € et disposerait d’environ 154 000 €. Après 20 ans, ses 240 000 €
              de versements atteindraient environ 406 000 €. Après 30 ans, les 360 000 € versés représenteraient
              environ 815 000 €.
            </p>
            <p>
              À ce stade, les gains théoriques, environ 455 000 €, seraient supérieurs au total des sommes investies.
            </p>

            <TimeSeriesChart
              id="sav-chart-compound"
              title="Quand les gains prennent le relais"
              subtitle={`1 000 € investis chaque mois, avec un rendement annualisé constant de ${BASE_RATE_LABEL}.`}
              hint="Survolez ou sélectionnez une année pour voir les versements, les gains et le capital."
              xUnit="Années"
              table={COMPOUND_TABLE}
              annotation={{ index: COMPOUND_ROWS.length - 1, text: "Les gains dépassent les versements", top: 4 }}
              series={[
                { key: "capital", label: "Capital estimé", color: GREEN, values: COMPOUND_ROWS.map((row) => row.capital) },
                { key: "contributions", label: "Versements cumulés", color: BLUE, values: COMPOUND_ROWS.map((row) => row.contributions), area: true },
              ]}
              band={{ from: "capital", to: "contributions", color: "rgba(103, 184, 138, .17)" }}
              legend={<ChartLegend items={[
                { key: "capital", color: GREEN, label: "Capital estimé", note: "trait vert, courbe haute" },
                { key: "contributions", color: BLUE, label: "Versements cumulés", note: "trait bleu, courbe basse" },
                { key: "gains", color: "rgba(103, 184, 138, .35)", label: "Gains accumulés", note: "zone verte entre les deux courbes" },
              ]} />}
              points={COMPOUND_ROWS.map((row) => ({
                key: `compound-${row.year}`,
                label: String(row.year),
                description: `Année ${row.year} : ${euro0.format(row.contributions)} versés, ${euro0.format(row.gains)} de gains estimés, soit un capital de ${euro0.format(row.capital)}.`,
                readout: (
                  <span>
                    <strong>Année {row.year}</strong> · versements {euro0.format(row.contributions)} · gains {euro0.format(row.gains)} → <em>capital {euro0.format(row.capital)}</em>
                  </span>
                ),
              }))}
            />

            <Takeaway>
              Au début, le capital progresse surtout grâce à vos versements. Avec le temps, une part croissante de sa
              progression peut venir des gains accumulés.
            </Takeaway>
          </section>

          {/* -------------------------------------------------------------------- 03 */}
          <section className="sav-section" aria-labelledby="sav-s3-title">
            <SectionHead number="03" icon={<ClockArrowIcon />} title="Deux règles simples pour se repérer" id="sav-s3-title" />

            <h4 className="sav-sub">La règle des 72</h4>
            <p>La règle des 72 permet d’estimer rapidement le temps nécessaire pour doubler un capital.</p>
            <p>Il suffit de diviser 72 par le rendement annuel supposé.</p>
            <p className="sav-formula" aria-label="Formule : temps de doublement approximatif égale 72 divisé par le rendement annuel">
              <b aria-hidden="true">Temps de doublement approximatif</b>
              <span aria-hidden="true">=</span>
              <b aria-hidden="true">72 ÷ rendement annuel</b>
            </p>
            <p>
              Cette règle est un raccourci pédagogique. Elle suppose un rendement régulier et le réinvestissement des
              gains.
            </p>

            <HorizontalBarChart
              id="sav-chart-doubling"
              title="Rendement et temps de doublement"
              subtitle="Estimation obtenue avec la règle des 72."
              hint={`Survolez ou sélectionnez un taux. Repère : ${frPercent(DOUBLING_HIGHLIGHT)} par an, soit un doublement en environ 14 ans.`}
              table={DOUBLING_TABLE}
              data={DOUBLING_ROWS.map((row, index) => {
                const flagged = row.rate === DOUBLING_HIGHLIGHT;
                return {
                  key: `doubling-${row.rate}`,
                  label: frPercent(row.rate),
                  value: row.years,
                  valueLabel: `${frNumber(row.years)} ans`,
                  color: DOUBLING_RAMP[index] ?? BLUE,
                  badge: flagged ? "Repère" : undefined,
                  description: `Rendement de ${frPercent(row.rate)} par an : capital doublé en environ ${frNumber(row.years)} ans selon la règle des 72.`,
                  readout: (
                    <span>
                      <strong>{frPercent(row.rate)} par an</strong> · règle des 72 → capital doublé en <em>environ {frNumber(row.years)} ans</em>. Un rendement plus élevé implique généralement davantage de risque.
                    </span>
                  ),
                };
              })}
            />
            <p className="sav-note">
              Un rendement plus élevé implique généralement davantage de risque. Ces valeurs sont des ordres de
              grandeur, jamais des performances garanties.
            </p>

            <h4 className="sav-sub">La règle indicative des 4 %</h4>
            <p>
              La règle des 4 % donne un ordre de grandeur du capital qui pourrait être nécessaire pour financer un
              retrait annuel égal à 4 % du portefeuille.
            </p>
            <p className="sav-formula" aria-label="Formule : capital indicatif égale revenu mensuel souhaité multiplié par 300">
              <b aria-hidden="true">Capital indicatif</b>
              <span aria-hidden="true">=</span>
              <b aria-hidden="true">revenu mensuel souhaité × 300</b>
            </p>

            <div className="sav-table-wrap">
              <table className="sav-table">
                <caption className="sr-only">Capital indicatif correspondant à un revenu mensuel souhaité, selon la règle des 4 %.</caption>
                <thead><tr><th scope="col">Revenu mensuel souhaité</th><th scope="col">Capital indicatif</th></tr></thead>
                <tbody>
                  {WITHDRAWAL_ROWS.map((row) => (
                    <tr key={row.monthlyIncome}>
                      <th scope="row">{euro0.format(row.monthlyIncome)} par mois</th>
                      <td>{euro0.format(row.indicativeCapital)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="info-callout sav-warning">
              <b>Ce n’est ni une promesse ni une garantie</b>
              <p>
                La durée des retraits, les variations des marchés, les frais, la fiscalité et l’inflation peuvent
                modifier fortement le résultat.
              </p>
            </div>

            <Takeaway>
              Ces règles servent à se fixer des repères. Elles ne remplacent pas une simulation adaptée à votre
              situation.
            </Takeaway>
          </section>

          {/* -------------------------------------------------------------------- 04 */}
          <section className="sav-section" aria-labelledby="sav-s4-title">
            <SectionHead number="04" icon={<DivergingIcon />} title="Les frais semblent petits, leur effet ne l’est pas" id="sav-s4-title" />
            <p>
              Un écart de frais de 0,6 point par an peut paraître faible. Sur 30 ans, il devient pourtant important.
            </p>
            <p>
              Pour 500 € investis chaque mois, un rendement brut constant de {BASE_RATE_LABEL} donnerait environ
              407 700 € après 30 ans. Avec 0,6 % de frais annuels, soit un rendement net simplifié de 4,4 %, le capital
              tomberait à environ 367 100 €.
            </p>
            <p>La différence dépasserait 40 000 €.</p>

            <TimeSeriesChart
              id="sav-chart-fees"
              title="L’effet cumulé de 0,6 % de frais"
              subtitle={`500 € investis chaque mois. Comparaison entre ${BASE_RATE_LABEL} brut et 4,4 % net simplifié.`}
              hint="Survolez ou sélectionnez une année pour comparer le capital brut, le capital net et l’écart."
              xUnit="Années"
              table={FEE_TABLE}
              annotation={{ index: FEE_ROWS.length - 1, text: `${euro0.format(FEE_ROWS[FEE_ROWS.length - 1].difference)} d’écart après 30 ans`, top: 36 }}
              series={[
                { key: "gross", label: "Sans frais", color: GREEN, values: FEE_ROWS.map((row) => row.gross) },
                { key: "net", label: "Après frais", color: BLUE_NIGHT, values: FEE_ROWS.map((row) => row.net), dashed: true },
              ]}
              band={{ from: "gross", to: "net", color: "rgba(229, 164, 90, .3)" }}
              legend={<ChartLegend items={[
                { key: "gross", color: GREEN, label: `Sans frais (${BASE_RATE_LABEL} brut)`, note: "trait plein" },
                { key: "net", color: BLUE_NIGHT, label: "Après 0,6 % de frais (4,4 %)", note: "trait pointillé" },
                { key: "gap", color: ORANGE, label: "Écart cumulé", note: "zone orange entre les deux courbes" },
              ]} />}
              points={FEE_ROWS.map((row) => ({
                key: `fee-${row.year}`,
                label: String(row.year),
                description: `Année ${row.year} : ${euro0.format(row.gross)} sans frais, ${euro0.format(row.net)} après frais, soit ${euro0.format(row.difference)} d’écart.`,
                readout: (
                  <span>
                    <strong>Année {row.year}</strong> · sans frais {euro0.format(row.gross)} · après frais {euro0.format(row.net)} → <em>écart {euro0.format(row.difference)}</em>
                  </span>
                ),
              }))}
            />

            <Takeaway>
              Avant d’investir, regardez les frais du produit, mais aussi ceux du compte, des transactions et de la
              gestion.
            </Takeaway>
          </section>

          {/* -------------------------------------------------------------------- 05 */}
          <section className="sav-section" aria-labelledby="sav-s5-title">
            <SectionHead number="05" icon={<ShrinkIcon />} title="L’inflation change la valeur réelle du résultat" id="sav-s5-title" />
            <p>
              Le capital affiché dans vingt ans ne dira pas tout. Si les prix augmentent, chaque euro futur permettra
              d’acheter moins de biens et de services qu’aujourd’hui.
            </p>
            <p>
              Avec 1 000 € investis chaque mois pendant 20 ans et un rendement annuel théorique de 4 %, le capital
              nominal atteindrait environ 363 800 €. Avec une inflation moyenne de 2,2 %, son pouvoir d’achat
              correspondrait à environ 235 400 € d’aujourd’hui.
            </p>
            <p>
              Avec un rendement théorique de 8 %, le capital nominal atteindrait environ 569 000 €. Après la même
              correction pour l’inflation, il représenterait environ 368 200 € d’aujourd’hui.
            </p>

            <ColumnGroupChart
              id="sav-chart-inflation"
              title="Capital nominal et pouvoir d’achat après 20 ans"
              subtitle="1 000 € investis chaque mois pendant 20 ans. Les montants réels sont exprimés en euros d’aujourd’hui."
              hint="Survolez ou sélectionnez une barre pour voir le rendement, l’inflation retenue et le pouvoir d’achat estimé."
              pickerLabel="Choisir le rendement simulé"
              table={INFLATION_TABLE}
              legend={<ChartLegend items={[
                { key: "nominal", color: GREEN, label: "Capital nominal", note: "euros futurs, avant inflation" },
                { key: "i1", color: BLUE_PALE, label: "Inflation 1 %", note: "euros d’aujourd’hui" },
                { key: "i22", color: BLUE, label: "Inflation 2,2 %", note: "euros d’aujourd’hui" },
                { key: "i5", color: ORANGE, label: "Inflation 5 %", note: "euros d’aujourd’hui" },
              ]} />}
              groups={INFLATION_ROWS.map((row) => ({
                key: `rate-${row.returnRate}`,
                label: `Rendement de ${frPercent(row.returnRate)} par an`,
                pickerLabel: frPercent(row.returnRate),
                columns: [
                  {
                    key: `nominal-${row.returnRate}`,
                    label: "Capital nominal",
                    value: row.nominal,
                    valueLabel: eurAxis(row.nominal),
                    color: GREEN,
                    description: `Rendement de ${frPercent(row.returnRate)} par an : capital nominal de ${euro0.format(row.nominal)} après 20 ans, exprimé en euros futurs.`,
                    readout: (
                      <span><strong>Rendement {frPercent(row.returnRate)}</strong> · capital nominal après 20 ans → <em>{euro0.format(row.nominal)}</em> en euros futurs</span>
                    ),
                  },
                  ...row.real.map((real) => ({
                    key: `real-${row.returnRate}-${real.rate}`,
                    label: `Inflation ${frPercent(real.rate)}`,
                    value: real.value,
                    valueLabel: eurAxis(real.value),
                    color: real.rate === 1 ? BLUE_PALE : real.rate === 5 ? ORANGE : BLUE,
                    description: `Rendement de ${frPercent(row.returnRate)} par an avec une inflation moyenne de ${frPercent(real.rate)} : pouvoir d’achat estimé de ${euro0.format(real.value)} en euros d’aujourd’hui.`,
                    readout: (
                      <span><strong>Rendement {frPercent(row.returnRate)}</strong> · inflation {frPercent(real.rate)} → pouvoir d’achat <em>{euro0.format(real.value)}</em> en euros d’aujourd’hui</span>
                    ),
                  })),
                ],
              }))}
            />
            <p className="sav-note">
              Un montant en <b>euros futurs</b> est celui qui s’affichera sur le relevé dans vingt ans. Le même montant
              exprimé en <b>euros d’aujourd’hui</b> répond à une autre question : ce qu’il permettrait d’acheter au
              niveau de prix actuel.
            </p>

            <Takeaway>
              Pour préserver votre pouvoir d’achat, raisonnez en rendement réel. Il dépend du rendement obtenu, diminué
              des frais, de la fiscalité et de l’effet de l’inflation.
            </Takeaway>
          </section>

          {/* -------------------------------------------------------------------- Plan d'action */}
          <section className="sav-plan" aria-labelledby="sav-plan-title">
            <h3 id="sav-plan-title">Comment commencer simplement</h3>
            <ol>{ACTION_PLAN.map((step) => <li key={step}>{step}</li>)}</ol>
          </section>

          <section className="sav-section sav-conclusion" aria-labelledby="sav-conclusion-title">
            <h3 id="sav-conclusion-title">Le vrai avantage, c’est de commencer</h3>
            <p>
              Le temps ne garantit pas un rendement. Les marchés peuvent baisser et les performances ne sont jamais
              régulières. Mais commencer tôt permet de répartir l’effort sur davantage d’années et donne plus de temps
              au mécanisme des intérêts composés.
            </p>
            <p>
              Le bon réflexe n’est donc pas d’attendre le placement parfait. C’est de construire une méthode simple,
              compatible avec son budget, puis de la suivre avec régularité.
            </p>
          </section>

          <div className="sav-actions">
            <button type="button" className="primary-button" onClick={onDefineRhythm}>Définir mon rythme d’investissement</button>
            <button type="button" className="secondary-button" onClick={onOpenPeaPortfolio}>Découvrir le portefeuille PEA type</button>
          </div>

          <details className="sav-details">
            <summary>Hypothèses de calcul</summary>
            <p>
              Les simulations utilisent des versements effectués en fin de mois, un rendement annualisé constant
              converti en taux mensuel équivalent et le réinvestissement des gains. Elles n’intègrent pas la fiscalité.
              Le scénario de frais retranche, de façon simplifiée, 0,6 point au rendement brut annuel. Les résultats
              sont arrondis à l’euro et ne reflètent pas les variations réelles des marchés.
            </p>
          </details>

          <details className="sav-details">
            <summary>Sources pédagogiques</summary>
            <ul className="sav-sources">
              {SOURCES.map((source) => (
                <li key={source.url}>
                  <a href={source.url} target="_blank" rel="noopener noreferrer">
                    {source.label} <span aria-hidden="true">↗</span><span className="sr-only">(nouvel onglet)</span>
                  </a>
                </li>
              ))}
            </ul>
          </details>

          <p className="sav-disclaimer">
            Investir comporte un risque de perte en capital. Les simulations présentées sont pédagogiques. Elles ne
            constituent ni une promesse de rendement ni un conseil financier personnalisé.
          </p>
        </div>
      </section>
    </div>
  );
}
