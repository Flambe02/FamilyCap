import { authErrorResponse, requireFamilyMember } from "../../../lib/auth-server";
import { getActiveChallenge, getMemberChallengeHistory, isMissingChallengeTable } from "../../../lib/challenges-service";

// Liste des défis visibles par le membre + un résumé de sa participation (historique). Lecture
// seule ; identité déterminée depuis la session. Aucun montant d'autrui.
export const runtime = "nodejs";

// Aperçu admin (lecture seule) : ?asMember=<id> affiche l'historique du membre prévisualisé.
// Jamais honoré pour un non-admin (un membre ne peut jamais lire l'historique d'un autre).
function resolveTargetId(request: Request, viewer: { id: string; role: string }): string {
  const asMember = new URL(request.url).searchParams.get("asMember");
  return asMember && viewer.role === "admin" ? asMember : viewer.id;
}

export async function GET(request: Request) {
  try {
    const viewer = await requireFamilyMember(request);
    const [active, history] = await Promise.all([getActiveChallenge(), getMemberChallengeHistory(resolveTargetId(request, viewer))]);
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
