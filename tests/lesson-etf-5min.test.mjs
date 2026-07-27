// Leçon « Comprendre un ETF en 5 minutes » + nettoyage du catalogue « Comprendre ».
//
// Comme pour les autres leçons (tests/lesson-savings-time.test.mjs), la vérification du câblage
// se fait par lecture de source : ces fichiers ne dépendent d'aucun état runtime, un test qui
// vérifie leur PRÉSENCE textuelle est fidèle et rapide. La logique de correction elle-même est
// couverte séparément par tests/lesson-quiz-etf.test.mjs (pure, sans Supabase).

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("le catalogue ne propose plus les deux cartes sans contenu", async () => {
  const catalogue = await source("app/family-dashboard.tsx");
  assert.doesNotMatch(catalogue, /invest-early/);
  assert.doesNotMatch(catalogue, /seed-words/);
  assert.doesNotMatch(catalogue, /Pourquoi investir tôt/);
  assert.doesNotMatch(catalogue, /Les 24 mots ne se partagent jamais/);
});

test("« Les 7 règles essentielles » a maintenant une illustration", async () => {
  const catalogue = await source("app/family-dashboard.tsx");
  assert.match(catalogue, /InvestingRulesIllustration variant="card"/);
  const lesson = await source("app/lesson-investing-rules.tsx");
  assert.match(lesson, /InvestingRulesIllustration variant="hero"/);
});

test("la leçon ETF figure dans le catalogue avec sa carte, sa récompense et son illustration", async () => {
  const catalogue = await source("app/family-dashboard.tsx");
  assert.match(catalogue, /id: "etf-5min"/);
  assert.match(catalogue, /Comprendre un ETF en 5 minutes/);
  assert.match(catalogue, /\+20 PTS/);
  assert.match(catalogue, /EtfIllustration variant="card"/);
  assert.match(catalogue, /openLessonId === "etf-5min"/);
  assert.match(catalogue, /onOpenChallenges=\{.*investissements-suggestions/);
});

test("l'article ETF couvre les sections attendues, sans image contenant du texte figé", async () => {
  const lesson = await source("app/lesson-etf-5min.tsx");
  assert.match(lesson, /Comprendre un ETF en 5 minutes/);
  assert.match(lesson, /Un ETF, c’est quoi/);
  assert.match(lesson, /Un exemple très simple/);
  assert.match(lesson, /Pourquoi les ETF sont-ils populaires/);
  assert.match(lesson, /Les risques à connaître/);
  assert.match(lesson, /Comment reconnaître un ETF/);
  assert.match(lesson, /Résumé en 20 secondes/);
  assert.match(lesson, /Exemple pédagogique/);
  assert.match(lesson, /Défi final/);
  assert.match(lesson, /Analyse ton premier ETF/);
  assert.match(lesson, /risque de perte en capital/);

  // Le diagramme « 100 € → ETF → secteurs » est du JSX/texte réel, jamais une image.
  assert.match(lesson, /etf-flow-money/);
  assert.doesNotMatch(lesson, /<img\b/);

  // Modale accessible : piège de focus, Échap et restauration du focus viennent du hook partagé.
  assert.match(lesson, /useDialogA11y/);
  assert.match(lesson, /role="dialog" aria-modal="true" aria-labelledby="etf-lesson-title"/);
  assert.match(lesson, /aria-label="Fermer la leçon/);

  // Barre de progression de lecture, explicitement demandée pour cette leçon.
  assert.match(lesson, /etf-lesson-progress/);
  assert.match(lesson, /trackProgress/);

  // Liens externes sécurisés (justETF).
  const externalLinks = lesson.match(/target="_blank"/g) ?? [];
  const safeLinks = lesson.match(/rel="noopener noreferrer"/g) ?? [];
  assert.ok(externalLinks.length >= 2);
  assert.equal(externalLinks.length, safeLinks.length);
  assert.match(lesson, /justetf\.com/);

  // Confettis déterministes : aucun appel à Math.random() qui casserait l'hydratation SSR/CSR
  // (le commentaire du fichier mentionne la formule en toutes lettres, d'où l'échappement du \().
  assert.doesNotMatch(lesson, /Math\.random\(/);

  const css = await source("app/lesson-etf-5min.css");
  assert.match(css, /prefers-reduced-motion/);
});

test("le quiz UI ne connaît jamais lui-même le corrigé", async () => {
  const quiz = await source("app/lesson-quiz.tsx");
  assert.doesNotMatch(quiz, /correctIndex/);
  assert.doesNotMatch(quiz, /from ["'].*lesson-quiz-etf["']/);
  assert.match(quiz, /onCheckAnswer/);
  assert.match(quiz, /onComplete/);
});

test("la route API dérive l'identité de la session, jamais du corps de la requête", async () => {
  const route = await source("app/api/lessons/etf-5min-quiz/route.ts");
  assert.match(route, /requireFamilyMember/);
  assert.match(route, /viewer\.id/);
  assert.doesNotMatch(route, /body\.memberId/);
  assert.doesNotMatch(route, /body\.member_id/);
});

test("le service serveur réutilise apply_challenge_points, jamais un INSERT direct dans points_ledger", async () => {
  const service = await source("lib/lesson-quiz-etf-service.ts");
  assert.match(service, /rpc\/apply_challenge_points/);
  assert.match(service, /p_participant_id: null/);
  assert.match(service, /etfLessonCompletionKey/);
  // La seule écriture doit passer par la RPC (`rpc/apply_challenge_points`) : aucun appel
  // n'écrit directement sur l'endpoint REST `points_ledger` (POST/PATCH/PUT).
  assert.doesNotMatch(service, /supabaseRest\(\s*["'`]points_ledger/);
});

test("la migration est additive : elle étend la contrainte existante, ne supprime aucun défi", async () => {
  const migration = await source("supabase/migrations/20260815_lesson_quiz_challenge.sql");
  assert.match(migration, /alter table public\.challenges add constraint challenges_challenge_type_check/);
  assert.match(migration, /'monthly_investment', 'onboarding_mission', 'lesson_quiz'/);
  assert.match(migration, /on conflict \(slug\) where slug is not null do nothing/);
  assert.doesNotMatch(migration, /drop table/i);
  assert.doesNotMatch(migration, /delete from/i);
});
