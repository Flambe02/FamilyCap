import { authErrorResponse, requireAdmin } from "../../../../../lib/auth-server";
import { getParticipantsForChallengeAdmin, isMissingChallengeTable } from "../../../../../lib/challenges-service";

// Suivi admin des participants d'un défi (montants inclus, pour l'animation familiale). Ces
// montants NE transitent JAMAIS par l'API publique du classement (/api/challenges/leaderboard).
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    await requireAdmin(request);
    const challengeId = new URL(request.url).searchParams.get("challengeId");
    if (!challengeId) return Response.json({ error: "Le défi est obligatoire." }, { status: 400 });
    const participants = await getParticipantsForChallengeAdmin(challengeId);
    return Response.json({ participants });
  } catch (error) {
    if (isMissingChallengeTable(error)) return Response.json({ participants: [] });
    return authErrorResponse(error);
  }
}
