import { authErrorResponse, requireFamilyMember } from "../../../../../lib/auth-server";
import { getCurrentChallengesForMember, isMissingChallengeTable } from "../../../../../lib/challenges-service";

// Progression du membre pour un défi précis (réconcilie puis renvoie sa PROPRE progression).
// ?challengeId= sélectionne lequel des défis visibles ; à défaut, le premier de la liste (ordre
// serveur : les plus récents/permanents d'abord — cf. getCurrentChallengesForMember).
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const viewer = await requireFamilyMember(request);
    const challengeId = new URL(request.url).searchParams.get("challengeId");
    const list = await getCurrentChallengesForMember(viewer.id);
    const ctx = (challengeId ? list.find((item) => item.challenge?.id === challengeId) : list[0]) ?? null;
    return Response.json({
      available: true,
      state: ctx?.state ?? "challenge_ended",
      progress: ctx?.progress ? {
        invested: ctx.progress.invested, targetAmount: ctx.progress.targetAmount, pct: ctx.progress.pct,
        completed: ctx.progress.completed, status: ctx.progress.status,
      } : null,
    });
  } catch (error) {
    if (isMissingChallengeTable(error)) return Response.json({ available: false, state: "challenge_ended", progress: null });
    return authErrorResponse(error);
  }
}
