"use client";

// Mini-quiz réutilisable pour les leçons pédagogiques : une question à la fois, une seule réponse
// possible, retour visuel immédiat + explication après validation, bouton Suivant, résultat final.
// La correction est TOUJOURS demandée au serveur (props `onCheckAnswer`/`onComplete`) — ce
// composant ne connaît lui-même AUCUNE bonne réponse, il ne fait qu'afficher ce que le serveur
// répond. Voir lib/lesson-quiz-etf.ts pour la raison : un corrigé embarqué ici serait visible dans
// le bundle navigateur.
//
// Accessible au clavier par construction : chaque option est un vrai <button>, l'ordre de
// tabulation suit l'ordre visuel, et une zone aria-live annonce le retour visuel aux lecteurs
// d'écran sans dépendre de la couleur seule (icône + texte « Correct »/« Pas tout à fait »).

import { useState } from "react";
import "./lesson-quiz.css";

export type LessonQuizQuestion = { id: string; question: string; options: string[] };
export type LessonQuizAnswerCheck = { correct: boolean; explanation: string };
export type LessonQuizCompleteResult = { allCorrect: boolean };

export function LessonQuiz({ questions, onCheckAnswer, onComplete, onFinished, rewardPoints }: {
  questions: LessonQuizQuestion[];
  onCheckAnswer: (questionId: string, answerIndex: number) => Promise<LessonQuizAnswerCheck | null>;
  onComplete: (answers: Record<string, number>) => Promise<LessonQuizCompleteResult>;
  onFinished: (result: LessonQuizCompleteResult) => void;
  rewardPoints: number;
}) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [correctness, setCorrectness] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<LessonQuizAnswerCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [result, setResult] = useState<LessonQuizCompleteResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const total = questions.length;
  const current = questions[index];
  const isLast = index === total - 1;

  async function selectOption(optionIndex: number) {
    if (feedback || checking || !current) return;
    setChecking(true);
    setError(null);
    setSelected(optionIndex);
    try {
      const check = await onCheckAnswer(current.id, optionIndex);
      if (!check) { setError("Impossible de vérifier cette réponse pour le moment."); setSelected(null); return; }
      setFeedback(check);
      setAnswers((current_) => ({ ...current_, [current.id]: optionIndex }));
      setCorrectness((current_) => ({ ...current_, [current.id]: check.correct }));
    } catch {
      setError("Impossible de vérifier cette réponse pour le moment.");
      setSelected(null);
    } finally {
      setChecking(false);
    }
  }

  async function goNext() {
    if (!isLast) {
      setIndex((value) => value + 1);
      setSelected(null);
      setFeedback(null);
      return;
    }
    setFinishing(true);
    setError(null);
    try {
      const finalResult = await onComplete(answers);
      setResult(finalResult);
      onFinished(finalResult);
    } catch {
      setError("Impossible d’enregistrer le résultat du quiz pour le moment. Réessaie dans un instant.");
    } finally {
      setFinishing(false);
    }
  }

  function restart() {
    setIndex(0);
    setAnswers({});
    setCorrectness({});
    setSelected(null);
    setFeedback(null);
    setResult(null);
    setError(null);
  }

  if (result) {
    // Score affiché à titre indicatif, à partir des retours déjà reçus question par question ;
    // la source de vérité de la réussite reste `result.allCorrect`, recalculée côté serveur.
    const scoreCorrect = Object.values(correctness).filter(Boolean).length;
    return (
      <div className="lesson-quiz lesson-quiz-result" role="status">
        {result.allCorrect ? (
          <>
            <span className="lesson-quiz-result-icon" aria-hidden="true">✓</span>
            <strong>Quiz réussi : {total}/{total} bonnes réponses.</strong>
            <p>+{rewardPoints} points en route.</p>
          </>
        ) : (
          <>
            <span className="lesson-quiz-result-icon lesson-quiz-result-icon-retry" aria-hidden="true">↻</span>
            <strong>{scoreCorrect}/{total} bonnes réponses pour l’instant.</strong>
            <p>Relis les explications puis retente le quiz pour valider les +{rewardPoints} points.</p>
            <button type="button" className="primary-button" onClick={restart}>Recommencer le quiz</button>
          </>
        )}
        {error && <p className="lesson-quiz-error" role="alert">{error}</p>}
      </div>
    );
  }

  if (!current) return null;

  return (
    <div className="lesson-quiz">
      <div className="lesson-quiz-progress" aria-label={`Question ${index + 1} sur ${total}`}>
        {questions.map((question, questionIndex) => (
          <span key={question.id} className={questionIndex <= index ? "is-done" : ""} aria-hidden="true" />
        ))}
      </div>
      <p className="lesson-quiz-step">Question {index + 1} / {total}</p>
      <h4 className="lesson-quiz-question">{current.question}</h4>
      <ul className="lesson-quiz-options">
        {current.options.map((option, optionIndex) => {
          const isSelected = selected === optionIndex;
          const state = !feedback ? "" : isSelected ? (feedback.correct ? "is-correct" : "is-wrong") : "is-muted";
          return (
            <li key={option}>
              <button
                type="button"
                className={`lesson-quiz-option ${state}`}
                disabled={Boolean(feedback) || checking}
                aria-pressed={isSelected}
                onClick={() => selectOption(optionIndex)}
              >
                <span>{option}</span>
                {isSelected && feedback && <b aria-hidden="true">{feedback.correct ? "✓" : "✗"}</b>}
              </button>
            </li>
          );
        })}
      </ul>
      <div aria-live="polite">
        {feedback && (
          <p className={feedback.correct ? "lesson-quiz-feedback is-correct" : "lesson-quiz-feedback is-wrong"}>
            <b>{feedback.correct ? "Correct." : "Pas tout à fait."}</b> {feedback.explanation}
          </p>
        )}
      </div>
      {error && <p className="lesson-quiz-error" role="alert">{error}</p>}
      {feedback && (
        <button type="button" className="primary-button" onClick={goNext} disabled={finishing}>
          {finishing ? "Enregistrement…" : isLast ? "Voir mon résultat" : "Suivant"}
        </button>
      )}
    </div>
  );
}
