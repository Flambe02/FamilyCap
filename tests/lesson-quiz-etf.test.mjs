// Quiz de la leçon « Comprendre un ETF en 5 minutes » (lib/lesson-quiz-etf.ts).
//
// Couvre : correction par question, correction complète, non-fuite du corrigé côté client, et la
// clé d'idempotence qui garantit que les +20 points ne sont jamais gagnés deux fois.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  ETF_LESSON_POINTS, ETF_QUIZ_QUESTIONS, etfLessonCompletionKey,
  gradeEtfAnswer, gradeEtfQuizComplete, publicEtfQuizQuestions,
} from "../lib/lesson-quiz-etf.ts";

test("le quiz compte exactement trois questions, chacune avec un corrigé et une explication", () => {
  assert.equal(ETF_QUIZ_QUESTIONS.length, 3);
  for (const question of ETF_QUIZ_QUESTIONS) {
    assert.ok(question.options.length >= 2);
    assert.ok(question.correctIndex >= 0 && question.correctIndex < question.options.length);
    assert.ok(question.explanation.length > 0);
  }
});

test("publicEtfQuizQuestions ne transmet jamais le corrigé ni l'explication", () => {
  const publicQuestions = publicEtfQuizQuestions();
  assert.equal(publicQuestions.length, 3);
  for (const question of publicQuestions) {
    assert.ok(!("correctIndex" in question));
    assert.ok(!("explanation" in question));
  }
});

test("gradeEtfAnswer corrige une réponse juste et une réponse fausse", () => {
  const [first] = ETF_QUIZ_QUESTIONS;
  const correct = gradeEtfAnswer(first.id, first.correctIndex);
  assert.equal(correct.correct, true);
  assert.equal(correct.explanation, first.explanation);

  const wrongIndex = first.correctIndex === 0 ? 1 : 0;
  const wrong = gradeEtfAnswer(first.id, wrongIndex);
  assert.equal(wrong.correct, false);
  // L'explication est TOUJOURS renvoyée, juste ou faux — elle sert de pédagogie, pas de récompense.
  assert.equal(wrong.explanation, first.explanation);
});

test("gradeEtfAnswer renvoie null pour une question inconnue (jamais une correction inventée)", () => {
  assert.equal(gradeEtfAnswer("question-inexistante", 0), null);
});

test("gradeEtfQuizComplete exige les trois bonnes réponses, jamais un score partiel", () => {
  const allCorrectAnswers = Object.fromEntries(ETF_QUIZ_QUESTIONS.map((question) => [question.id, question.correctIndex]));
  const perfect = gradeEtfQuizComplete(allCorrectAnswers);
  assert.equal(perfect.allCorrect, true);
  assert.deepEqual(perfect.wrongQuestionIds, []);

  const oneWrong = { ...allCorrectAnswers, [ETF_QUIZ_QUESTIONS[1].id]: (ETF_QUIZ_QUESTIONS[1].correctIndex + 1) % ETF_QUIZ_QUESTIONS[1].options.length };
  const imperfect = gradeEtfQuizComplete(oneWrong);
  assert.equal(imperfect.allCorrect, false);
  assert.deepEqual(imperfect.wrongQuestionIds, [ETF_QUIZ_QUESTIONS[1].id]);
});

test("gradeEtfQuizComplete traite une réponse manquante comme fausse (pas comme correcte par défaut)", () => {
  const missingOne = Object.fromEntries(ETF_QUIZ_QUESTIONS.slice(1).map((question) => [question.id, question.correctIndex]));
  const result = gradeEtfQuizComplete(missingOne);
  assert.equal(result.allCorrect, false);
  assert.deepEqual(result.wrongQuestionIds, [ETF_QUIZ_QUESTIONS[0].id]);
});

test("etfLessonCompletionKey est stable (même membre → même clé, jamais versionnée)", () => {
  const key = etfLessonCompletionKey("member-123");
  assert.equal(key, "lesson_completion:lesson_etf_5min:member-123");
  assert.equal(key, etfLessonCompletionKey("member-123")); // rejouable, toujours identique
  assert.notEqual(key, etfLessonCompletionKey("member-456"));
});

test("ETF_LESSON_POINTS vaut 20, conformément à la spécification", () => {
  assert.equal(ETF_LESSON_POINTS, 20);
});

test("le corrigé du quiz n'est importé par AUCUN composant client (use client)", async () => {
  // Garde-fou structurel : si un fichier "use client" importait un jour lesson-quiz-etf.ts, le
  // corrigé (correctIndex/explanation) serait expédié dans le bundle navigateur — les +20 points
  // deviendraient gagnables sans répondre correctement.
  const { readdir } = await import("node:fs/promises");
  const appDir = new URL("../app/", import.meta.url);
  const entries = await readdir(appDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue;
    const source = await readFile(new URL(entry.name, appDir), "utf8");
    if (!/^\s*"use client"/.test(source)) continue; // seuls les composants client sont concernés
    assert.doesNotMatch(source, /from ["'].*lesson-quiz-etf["']/, `${entry.name} ne doit pas importer le corrigé du quiz`);
  }
});
