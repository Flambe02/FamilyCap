import { authErrorResponse, requireFamilyMember } from "../../../lib/auth-server";
import { getActiveChallenge, getMemberChallengeHistory, isMissingChallengeTable } from "../../../lib/challenges-service";

// Liste des défis visibles par le membre + un résumé de sa participation (historique). Lecture
// seule ; identité déterminée depuis la session. Aucun montant d'autrui.
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const viewer = await requireFamilyMember(request);
    const [active, history] = await Promise.all([getActiveChallenge(), getMemberChallengeHistory(viewer.id)]);
    return Response.json({
      available: true,
      current: active ? { id: active.id, title: active.title, status: active.status } : null,
      history,
    });
  } catch (error) {
    if (isMissingChallengeTable(error)) return Response.json({ available: false, current: null, history: [] });
    return authErrorResponse(error);
  }
}
