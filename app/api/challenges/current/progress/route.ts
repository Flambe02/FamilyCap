import { authErrorResponse, requireFamilyMember } from "../../../../../lib/auth-server";
import { getCurrentForMember, isMissingChallengeTable } from "../../../../../lib/challenges-service";

// Progression du membre pour le défi courant (réconcilie puis renvoie sa PROPRE progression).
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const viewer = await requireFamilyMember(request);
    const ctx = await getCurrentForMember(viewer.id);
    return Response.json({
      available: true,
      state: ctx.state,
      progress: ctx.progress ? {
        invested: ctx.progress.invested, targetAmount: ctx.progress.targetAmount, pct: ctx.progress.pct,
        completed: ctx.progress.completed, status: ctx.progress.status,
      } : null,
    });
  } catch (error) {
    if (isMissingChallengeTable(error)) return Response.json({ available: false, state: "challenge_ended", progress: null });
    return authErrorResponse(error);
  }
}
