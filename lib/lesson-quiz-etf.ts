// Quiz de la leçon « Comprendre un ETF en 5 minutes » — logique PURE (aucun accès réseau/DB),
// testable sans base (tests/lesson-quiz-etf.test.mjs).
//
// SÉCURITÉ CRITIQUE : ce module contient le corrigé (`correctIndex`, `explanation`). Il ne doit
// JAMAIS être importé par un composant "use client" — seuls la route API
// (app/api/lessons/etf-5min-quiz/route.ts) et son service serveur (lesson-quiz-etf-service.ts)
// l'importent. Si le corrigé atteignait le bundle navigateur, les +20 points seraient gagnables
// sans avoir répondu correctement (DevTools → lire le bundle JS). Le client ne reçoit jamais que
// `publicEtfQuizQuestions()` (question + options, sans `correctIndex` ni `explanation`) et soumet
// des INDICES de réponse ; la correction se fait exclusivement ici, côté serveur.
//
// Idempotence : même principe que onboardingCompletionKey (lib/onboarding-challenges.ts) — une
// clé STABLE et SANS VERSION, puisqu'une leçon terminée n'est jamais « reprise en arrière ».

export const ETF_LESSON_SLUG = "lesson_etf_5min";
export const ETF_LESSON_POINTS = 20;

export type EtfQuizQuestion = {
  id: string;
  question: string;
  options: string[];
  correctIndex: number;
  explanation: string;
};

export const ETF_QUIZ_QUESTIONS: readonly EtfQuizQuestion[] = [
  {
    id: "world-single-company",
    question: "Un ETF World investit-il dans une seule entreprise ?",
    options: ["Oui", "Non"],
    correctIndex: 1,
    explanation: "Un ETF World regroupe de nombreuses entreprises internationales : ton argent est réparti entre elles, jamais concentré sur une seule.",
  },
  {
    id: "accumulating-meaning",
    question: "Que signifie un ETF capitalisant ?",
    options: ["Il réinvestit automatiquement les dividendes", "Il garantit le capital", "Il ne facture aucuns frais"],
    correctIndex: 0,
    explanation: "Un ETF capitalisant réinvestit automatiquement les dividendes reçus dans le fonds, plutôt que de te les verser sur ton compte.",
  },
  {
    id: "identify-etf",
    question: "Quel élément permet d’identifier précisément un ETF ?",
    options: ["Sa couleur", "Son code ISIN", "Le nom de la banque"],
    correctIndex: 1,
    explanation: "Le code ISIN est l’identifiant unique international d’un produit financier : deux ETF proches par le nom n’ont jamais le même ISIN.",
  },
] as const;

export type EtfQuizPublicQuestion = { id: string; question: string; options: string[] };

/** Ce que le client reçoit : jamais `correctIndex` ni `explanation` avant validation. */
export function publicEtfQuizQuestions(): EtfQuizPublicQuestion[] {
  return ETF_QUIZ_QUESTIONS.map(({ id, question, options }) => ({ id, question, options }));
}

export type EtfAnswerCheck = { correct: boolean; explanation: string };

/** Corrige une réponse unique — utilisé pour le retour visuel immédiat après chaque question. */
export function gradeEtfAnswer(questionId: string, answerIndex: number): EtfAnswerCheck | null {
  const found = ETF_QUIZ_QUESTIONS.find((question) => question.id === questionId);
  if (!found) return null;
  return { correct: found.correctIndex === answerIndex, explanation: found.explanation };
}

export type EtfQuizGrade = { allCorrect: boolean; wrongQuestionIds: string[] };

/**
 * Corrige l'ensemble du quiz à partir des réponses soumises. Revalidé indépendamment de tout
 * retour intermédiaire côté client — un client malveillant ne peut pas s'auto-déclarer « tout
 * juste » sans que ce calcul ne le reconfirme réellement à partir des indices soumis.
 */
export function gradeEtfQuizComplete(answers: Record<string, number>): EtfQuizGrade {
  const wrongQuestionIds: string[] = [];
  for (const question of ETF_QUIZ_QUESTIONS) {
    if (answers[question.id] !== question.correctIndex) wrongQuestionIds.push(question.id);
  }
  return { allCorrect: wrongQuestionIds.length === 0, wrongQuestionIds };
}

/** Clé d'idempotence stable et sans version : `points_ledger.idempotency_key` empêche tout doublon. */
export function etfLessonCompletionKey(memberId: string): string {
  return `lesson_completion:${ETF_LESSON_SLUG}:${memberId}`;
}
