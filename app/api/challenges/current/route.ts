import { authErrorResponse, requireFamilyMember } from "../../../../lib/auth-server";
import { getCurrentForMember, isMissingChallengeTable } from "../../../../lib/challenges-service";

// Contexte du défi COURANT pour le membre connecté : défi, état (no_plan / no_account /
// ready_to_join / in_progress / completed / challenge_ended), et sa PROPRE progression.
// Réconcilie à l'ouverture (reconnaît les achats importés/antérieurs). Aucun montant d'autrui.
export const runtime = "nodejs";

function daysRemaining(endsOn: string): number {
  const end = new Date(`${endsOn}T00:00:00Z`).getTime();
  const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`).getTime();
  return Math.max(0, Math.round((end - today) / 86_400_000));
}

export async function GET(request: Request) {
  try {
    const viewer = await requireFamilyMember(request);
    const ctx = await getCurrentForMember(viewer.id);
    return Response.json({
      available: true,
      state: ctx.state,
      hasPlan: ctx.hasPlan,
      hasTargetAccount: ctx.hasTargetAccount,
      isParticipant: ctx.isParticipant,
      challenge: ctx.challenge ? {
        id: ctx.challenge.id, title: ctx.challenge.title, description: ctx.challenge.description,
        startsOn: ctx.challenge.starts_on, endsOn: ctx.challenge.ends_on, pointsReward: ctx.challenge.points_reward,
        daysRemaining: daysRemaining(ctx.challenge.ends_on),
      } : null,
      progress: ctx.progress ? {
        invested: ctx.progress.invested, targetAmount: ctx.progress.targetAmount, pct: ctx.progress.pct,
        completed: ctx.progress.completed, status: ctx.progress.status, linkedOperations: ctx.progress.linkedOperations,
        lastEligibleDate: ctx.progress.lastEligibleDate,
      } : null,
    });
  } catch (error) {
    if (isMissingChallengeTable(error)) {
      return Response.json({ available: false, state: "challenge_ended", hasPlan: false, hasTargetAccount: false, isParticipant: false, challenge: null, progress: null });
    }
    return authErrorResponse(error);
  }
}
