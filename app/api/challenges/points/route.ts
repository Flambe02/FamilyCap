import { authErrorResponse, requireFamilyMember } from "../../../../lib/auth-server";
import { getMemberPoints, isMissingChallengeTable } from "../../../../lib/challenges-service";

// Indicateurs de points du membre connecté (total, année, défis terminés, rang du mois courant).
// Le total est TOUJOURS dérivé du journal (SUM), jamais stocké. Points d'autrui jamais exposés.
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const viewer = await requireFamilyMember(request);
    const points = await getMemberPoints(viewer.id);
    return Response.json({ available: true, ...points });
  } catch (error) {
    if (isMissingChallengeTable(error)) return Response.json({ available: false, totalPoints: 0, yearPoints: 0, challengesCompleted: 0, rank: null });
    return authErrorResponse(error);
  }
}
