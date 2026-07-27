// Orchestration serveur du quiz « Comprendre un ETF en 5 minutes » (Node uniquement : clé
// service-role via supabaseRest). Miroir exact de lib/onboarding-challenges-service.ts : la
// correction est PURE et vit dans lib/lesson-quiz-etf.ts ; ici on lit Supabase et on attribue les
// points via la RPC transactionnelle EXISTANTE apply_challenge_points — jamais d'INSERT direct
// dans points_ledger.
//
// SÉCURITÉ (frontière réelle) : toute fonction ici présume un memberId déjà déterminé côté route
// (requireFamilyMember) — un membre ne complète jamais que SON propre quiz. La correction finale
// est TOUJOURS recalculée ici à partir des indices soumis, jamais déduite d'un statut envoyé par
// le client.

import { supabaseRest } from "./supabase-rest.ts";
import {
  ETF_LESSON_SLUG, etfLessonCompletionKey, gradeEtfAnswer, gradeEtfQuizComplete, publicEtfQuizQuestions,
  type EtfAnswerCheck, type EtfQuizPublicQuestion,
} from "./lesson-quiz-etf.ts";

const REASON = "lesson_completion";

export function isMissingLessonQuizSchema(error: unknown): boolean {
  return error instanceof Error && (error.message.includes("PGRST205") || error.message.includes("42703") || error.message.includes("challenges"));
}

type ChallengeRow = { id: string; points_reward: number };

/** La ligne préconfigurée (seedée par la migration 20260815), lue par sa clé métier `slug`. */
async function getEtfChallenge(): Promise<ChallengeRow | null> {
  try {
    const rows = await supabaseRest<ChallengeRow[]>(
      `challenges?select=id,points_reward&slug=eq.${encodeURIComponent(ETF_LESSON_SLUG)}&challenge_type=eq.lesson_quiz&status=eq.active&limit=1`,
    );
    return rows[0] ?? null;
  } catch (error) {
    if (isMissingLessonQuizSchema(error)) return null; // migration 20260815 non encore jouée
    throw error;
  }
}

export type EtfQuizStatus = { available: boolean; completed: boolean; pointsAwarded: number | null; questions: EtfQuizPublicQuestion[] };

/** Statut du membre pour l'écran (restaure « déjà terminé » après rechargement) + les questions publiques. */
export async function getEtfQuizStatus(memberId: string): Promise<EtfQuizStatus> {
  const questions = publicEtfQuizQuestions();
  const challenge = await getEtfChallenge();
  if (!challenge) return { available: false, completed: false, pointsAwarded: null, questions };

  const rows = await supabaseRest<Array<{ points: number }>>(
    `points_ledger?select=points&member_id=eq.${encodeURIComponent(memberId)}&challenge_id=eq.${encodeURIComponent(challenge.id)}&reason=eq.${REASON}&limit=1`,
  ).catch(() => [] as Array<{ points: number }>);

  return { available: true, completed: rows.length > 0, pointsAwarded: rows[0]?.points ?? null, questions };
}

/** Correction immédiate d'UNE question (retour visuel immédiat), sans aucun effet de bord. */
export function checkEtfAnswer(questionId: string, answerIndex: number): EtfAnswerCheck | null {
  return gradeEtfAnswer(questionId, answerIndex);
}

export type EtfQuizCompleteResult =
  | { allCorrect: true; alreadyCompleted: boolean; pointsAwarded: number }
  | { allCorrect: false; wrongQuestionIds: string[] };

/**
 * Validation finale : recorrige TOUTES les réponses depuis lib/lesson-quiz-etf.ts (jamais un
 * score déclaré par le client), puis attribue les points une seule fois pour toujours si le
 * défi est configuré (migration jouée) et que les trois réponses sont correctes.
 */
export async function completeEtfQuiz(memberId: string, answers: Record<string, number>): Promise<EtfQuizCompleteResult> {
  const graded = gradeEtfQuizComplete(answers);
  if (!graded.allCorrect) return { allCorrect: false, wrongQuestionIds: graded.wrongQuestionIds };

  const challenge = await getEtfChallenge();
  if (!challenge) throw new Error("Le défi « Comprendre un ETF » n'est pas configuré (migration 20260815 non jouée).");

  const idempotencyKey = etfLessonCompletionKey(memberId);
  const alreadyRows = await supabaseRest<Array<{ id: string }>>(
    `points_ledger?select=id&idempotency_key=eq.${encodeURIComponent(idempotencyKey)}&limit=1`,
  ).catch(() => [] as Array<{ id: string }>);
  const alreadyCompleted = alreadyRows.length > 0;

  if (!alreadyCompleted) {
    // Réutilise TEL QUEL la RPC transactionnelle des défis : participant_id NULL est accepté
    // (colonne déjà nullable, même schéma que les missions onboarding) ; l'INSERT idempotent dans
    // points_ledger (ON CONFLICT idempotency_key DO NOTHING) reste l'unique effet réel.
    await supabaseRest("rpc/apply_challenge_points", {
      method: "POST",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({
        p_participant_id: null, p_challenge_id: challenge.id, p_member_id: memberId,
        p_points: challenge.points_reward, p_reason: REASON,
        p_idempotency_key: idempotencyKey,
        p_metadata: { slug: ETF_LESSON_SLUG }, p_new_status: "completed", p_completed: true,
      }),
    });
  }

  return { allCorrect: true, alreadyCompleted, pointsAwarded: challenge.points_reward };
}
