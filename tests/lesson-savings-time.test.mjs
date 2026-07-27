// Leçon « Épargne et temps : le duo qui fait grandir votre argent ».
//
// Deux niveaux de vérification :
//  1. les CHIFFRES — les jeux de données servis aux cinq graphiques sont recalculés par
//     lib/savings-simulation.ts et comparés à la référence éditoriale validée, recopiée ici. Si
//     une formule dérive, le test tombe avant que l'article n'affiche un montant faux ;
//  2. le CÂBLAGE — la carte existe dans le catalogue, ouvre le bon article, les métadonnées et les
//     garde-fous d'accessibilité sont présents, et les deux CTA pointent sur des actions réelles.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  COMPOUND_ROWS, DOUBLING_ROWS, EFFORT_ROWS, FEE_ROWS, INFLATION_ROWS, WITHDRAWAL_ROWS,
  durationLabel, futureValue, monthlyRate, monthsToTarget, realValue,
} from "../lib/savings-simulation.ts";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("le taux mensuel est le taux ÉQUIVALENT, jamais le taux proportionnel", () => {
  // (1,05)^(1/12) − 1 = 0,4074 % et non 5 %/12 = 0,4167 %. L'écart paraît minuscule ; sur
  // 30 ans de versements il vaut plusieurs milliers d'euros.
  assert.ok(Math.abs(monthlyRate(0.05) - 0.0040741237) < 1e-9);
  assert.notEqual(monthlyRate(0.05).toFixed(6), (0.05 / 12).toFixed(6));
  assert.equal(Math.round(Math.pow(1 + monthlyRate(0.05), 12) * 1e10) / 1e10, 1.05);
});

test("graphique 1 — durées pour atteindre 500 000 € à 5 % par an", () => {
  const reference = [
    { monthlyAmount: 500, years: 33.33, displayDuration: "33 ans et 4 mois" },
    { monthlyAmount: 750, years: 26.92, displayDuration: "26 ans et 11 mois" },
    { monthlyAmount: 1000, years: 22.83, displayDuration: "22 ans et 10 mois" },
    { monthlyAmount: 1500, years: 17.58, displayDuration: "17 ans et 7 mois" },
    { monthlyAmount: 2000, years: 14.42, displayDuration: "14 ans et 5 mois" },
    { monthlyAmount: 2500, years: 12.25, displayDuration: "12 ans et 3 mois" },
  ];
  assert.deepEqual(EFFORT_ROWS.map(({ monthlyAmount, years, displayDuration }) => ({ monthlyAmount, years, displayDuration })), reference);

  // Le capital atteint à l'échéance annoncée couvre bien l'objectif (arrondi au mois supérieur).
  for (const row of EFFORT_ROWS) {
    assert.ok(futureValue(row.monthlyAmount, 0.05, row.months / 12) >= 500_000);
    assert.ok(futureValue(row.monthlyAmount, 0.05, (row.months - 1) / 12) < 500_000);
  }
  assert.equal(monthsToTarget(1000, 0.05, 500_000), 274);
});

test("graphique 2 — versements, gains et capital pour 1 000 € par mois à 5 %", () => {
  assert.deepEqual(COMPOUND_ROWS, [
    { year: 0, contributions: 0, capital: 0, gains: 0 },
    { year: 5, contributions: 60000, capital: 67814, gains: 7814 },
    { year: 10, contributions: 120000, capital: 154363, gains: 34363 },
    { year: 15, contributions: 180000, capital: 264825, gains: 84825 },
    { year: 20, contributions: 240000, capital: 405804, gains: 165804 },
    { year: 25, contributions: 300000, capital: 585735, gains: 285735 },
    { year: 30, contributions: 360000, capital: 815376, gains: 455376 },
  ]);
  // L'affirmation centrale de la section : à 30 ans les gains dépassent les versements.
  const last = COMPOUND_ROWS.at(-1);
  assert.ok(last.gains > last.contributions);
});

test("graphique 3 — règle des 72", () => {
  assert.deepEqual(DOUBLING_ROWS, [
    { rate: 3, years: 24 }, { rate: 4, years: 18 }, { rate: 5, years: 14.4 },
    { rate: 7, years: 10.3 }, { rate: 8, years: 9 }, { rate: 10, years: 7.2 },
  ]);
});

test("règle indicative des 4 % — capital = revenu mensuel × 300", () => {
  assert.deepEqual(WITHDRAWAL_ROWS, [
    { monthlyIncome: 500, indicativeCapital: 150000 },
    { monthlyIncome: 1000, indicativeCapital: 300000 },
    { monthlyIncome: 1500, indicativeCapital: 450000 },
    { monthlyIncome: 2000, indicativeCapital: 600000 },
    { monthlyIncome: 3000, indicativeCapital: 900000 },
  ]);
});

test("graphique 4 — 0,6 point de frais annuels sur 30 ans", () => {
  assert.deepEqual(FEE_ROWS, [
    { year: 5, gross: 33907, net: 33414, difference: 493 },
    { year: 10, gross: 77182, net: 74856, difference: 2326 },
    { year: 15, gross: 132412, net: 126252, difference: 6160 },
    { year: 20, gross: 202902, net: 189996, difference: 12906 },
    { year: 25, gross: 292867, net: 269054, difference: 23814 },
    { year: 30, gross: 407688, net: 367103, difference: 40585 },
  ]);
  // L'écart vient des valeurs exactes : il peut valoir 1 € de plus que la soustraction des deux
  // capitaux arrondis (année 25). C'est voulu — on annonce le montant réellement perdu.
  for (const row of FEE_ROWS) assert.ok(Math.abs(row.difference - (row.gross - row.net)) <= 1);
});

test("graphique 5 — capital nominal et pouvoir d'achat après 20 ans", () => {
  assert.deepEqual(INFLATION_ROWS, [
    { returnRate: 4, nominal: 363842, real: [{ rate: 1, value: 298184 }, { rate: 2.2, value: 235448 }, { rate: 5, value: 137128 }] },
    { returnRate: 8, nominal: 568999, real: [{ rate: 1, value: 466320 }, { rate: 2.2, value: 368208 }, { rate: 5, value: 214450 }] },
  ]);
  // Le pouvoir d'achat DIVISE par l'inflation cumulée : il est toujours inférieur au nominal.
  for (const row of INFLATION_ROWS) {
    for (const real of row.real) assert.ok(real.value < row.nominal);
  }
  assert.equal(Math.round(realValue(100, 0.02, 1)), 98);
});

test("les durées sont écrites en toutes lettres, jamais en décimales brutes", () => {
  assert.equal(durationLabel(400), "33 ans et 4 mois");
  assert.equal(durationLabel(12), "1 an");
  assert.equal(durationLabel(13), "1 an et 1 mois");
  assert.equal(durationLabel(5), "5 mois");
  for (const row of EFFORT_ROWS) assert.doesNotMatch(row.displayDuration, /[.,]/);
});

test("la carte figure dans le catalogue et ouvre le bon article", async () => {
  const catalogue = await source("app/family-dashboard.tsx");
  assert.match(catalogue, /id: "savings-time"/);
  assert.match(catalogue, /SavingsTimeLesson/);
  assert.match(catalogue, /Épargne et temps/);
  assert.match(catalogue, /INVESTISSEMENT · LEÇON/);
  assert.match(catalogue, /6 MIN · DÉBUTANT/);
  assert.match(catalogue, /openLessonId === "savings-time"/);
  // Le visuel de la carte est le recadrage 3:2 de l'illustration principale.
  assert.match(catalogue, /SavingsIllustration variant="card"/);
  // La carte reste dans le même catalogue que « Le portefeuille PEA type ».
  assert.match(catalogue, /id: "pea-portfolio-type"/);
});

test("l'article expose ses métadonnées, ses garde-fous et ses cinq graphiques", async () => {
  const lesson = await source("app/lesson-savings-time.tsx");

  assert.match(lesson, /LESSON_SLUG = "epargne-temps-interets-composes"/);
  assert.match(lesson, /Épargne et temps : le duo qui fait grandir votre argent/);
  assert.match(lesson, /Lecture · 6 min/);
  assert.match(lesson, /Niveau · Débutant/);
  assert.match(lesson, /Thème · Construire son patrimoine/);
  assert.match(lesson, /L’essentiel en 30 secondes/);

  // Modale accessible : piège de focus, Échap et restauration du focus viennent du hook partagé.
  assert.match(lesson, /useDialogA11y/);
  assert.match(lesson, /role="dialog" aria-modal="true" aria-labelledby="savings-lesson-title"/);
  assert.match(lesson, /aria-label="Fermer la leçon"/);

  // Les cinq graphiques, chacun alimenté par le jeu de données calculé correspondant.
  for (const id of ["sav-chart-effort", "sav-chart-compound", "sav-chart-doubling", "sav-chart-fees", "sav-chart-inflation"]) {
    assert.match(lesson, new RegExp(`id="${id}"`));
  }
  assert.match(lesson, /data=\{EFFORT_ROWS\.map/);
  assert.match(lesson, /COMPOUND_ROWS\.map\(\(row\) => row\.capital\)/);
  assert.match(lesson, /data=\{DOUBLING_ROWS\.map/);
  assert.match(lesson, /FEE_ROWS\.map\(\(row\) => row\.gross\)/);
  assert.match(lesson, /groups=\{INFLATION_ROWS\.map/);
  // Aucun montant du corps des graphiques n'est écrit en dur : tout passe par le module de calcul.
  assert.match(lesson, /from "\.\.\/lib\/savings-simulation"/);

  // Sections repliables et avertissement.
  assert.match(lesson, /Hypothèses de calcul/);
  assert.match(lesson, /Sources pédagogiques/);
  assert.match(lesson, /risque de perte en capital/);

  // Liens externes sécurisés.
  const externalLinks = lesson.match(/target="_blank"/g) ?? [];
  const safeLinks = lesson.match(/rel="noopener noreferrer"/g) ?? [];
  assert.ok(externalLinks.length >= 1);
  assert.equal(externalLinks.length, safeLinks.length);
  assert.match(lesson, /amf-france\.org/);
  assert.match(lesson, /lafinancepourtous\.com/);

  // Les deux CTA utilisent les actions réelles du projet (mêmes que la leçon « 7 règles »).
  assert.match(lesson, /Définir mon rythme d’investissement/);
  assert.match(lesson, /Découvrir le portefeuille PEA type/);
  assert.match(lesson, /onDefineRhythm/);
  assert.match(lesson, /onOpenPeaPortfolio/);
});

test("chaque graphique fournit un tableau de repli et la mention pédagogique", async () => {
  const [charts, lesson] = await Promise.all([source("app/lesson-charts.tsx"), source("app/lesson-savings-time.tsx")]);

  // Tableau accessible masqué visuellement, relié au titre et au sous-titre du graphique.
  // `.sr-only` doit être porté par le DIV : sur un `<table>`, `width: 1px` est ignoré (minimum)
  // et le tableau déborde la modale sur mobile.
  assert.match(charts, /<div className="sr-only">\s*<table>/);
  assert.doesNotMatch(charts, /<table className="sr-only">/);
  assert.match(charts, /<caption>\{table\.caption\}<\/caption>/);
  assert.match(charts, /aria-labelledby=\{`\$\{id\}-title`\} aria-describedby=\{`\$\{id\}-desc`\}/);
  assert.match(charts, /Simulation pédagogique/);
  // La zone de lecture est purement visuelle : le nom accessible des boutons porte l'information.
  assert.match(charts, /className="art-chart-readout" aria-hidden="true"/);
  assert.match(charts, /aria-label=\{datum\.description\}/);
  // Les cinq graphiques déclarent bien un tableau de données.
  assert.equal((lesson.match(/table=\{[A-Z_]+_TABLE\}/g) ?? []).length, 5);

  // Aucune bibliothèque de graphiques n'est introduite.
  const packageJson = JSON.parse(await source("package.json"));
  const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
  for (const forbidden of ["recharts", "chart.js", "react-chartjs-2", "@tremor/react", "victory", "d3"]) {
    assert.equal(dependencies[forbidden], undefined, `${forbidden} ne doit pas être ajouté pour cinq graphiques simples`);
  }
});

test("le graphique responsive ne dépend d'aucune media query lue en JavaScript", async () => {
  const [charts, css] = await Promise.all([source("app/lesson-charts.tsx"), source("app/lesson-charts.css")]);
  // Une largeur lue au rendu produirait un HTML serveur différent du HTML client (hydratation).
  assert.doesNotMatch(charts, /matchMedia|window\.innerWidth|useLayoutEffect/);
  // Le basculement desktop/mobile du graphique d'inflation est fait en CSS.
  assert.match(css, /\.art-group\[data-active="false"\] \{ display: none; \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});
