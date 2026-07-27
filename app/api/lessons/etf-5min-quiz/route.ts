import { authErrorResponse, requireFamilyMember } from "../../../../lib/auth-server";
import { checkEtfAnswer, completeEtfQuiz, getEtfQuizStatus } from "../../../../lib/lesson-quiz-etf-service";

// Quiz de la leçon « Comprendre un ETF en 5 minutes ». Identité déterminée depuis la session
// (requireFamilyMember) — jamais du corps de la requête. Le corrigé ne quitte jamais ce fichier
// serveur : GET ne renvoie que question + options (lib/lesson-quiz-etf.ts::publicEtfQuizQuestions),
// POST ne renvoie qu'un verdict correct/faux + l'explication après coup, jamais la bonne réponse
// à l'avance.
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const viewer = await requireFamilyMember(request);
    const status = await getEtfQuizStatus(viewer.id);
    return Response.json(status);
  } catch (error) {
    return authErrorResponse(error);
  }
}

type QuizBody = { action?: unknown; questionId?: unknown; answerIndex?: unknown; answers?: unknown };

export async function POST(request: Request) {
  try {
    const viewer = await requireFamilyMember(request);
    const body = (await request.json()) as QuizBody;

    if (body.action === "check") {
      if (typeof body.questionId !== "string" || typeof body.answerIndex !== "number") {
        return Response.json({ error: "Requête invalide." }, { status: 400 });
      }
      const result = checkEtfAnswer(body.questionId, body.answerIndex);
      if (!result) return Response.json({ error: "Question inconnue." }, { status: 400 });
      return Response.json(result);
    }

    if (body.action === "complete") {
      if (typeof body.answers !== "object" || body.answers === null) {
        return Response.json({ error: "Requête invalide." }, { status: 400 });
      }
      const result = await completeEtfQuiz(viewer.id, body.answers as Record<string, number>);
      return Response.json(result);
    }

    return Response.json({ error: "Action inconnue." }, { status: 400 });
  } catch (error) {
    return authErrorResponse(error);
  }
}
