import { authErrorResponse, requireFamilyMember } from "../../../../lib/auth-server";
import { getChallengeDashboardSummary, isMissingChallengeTable } from "../../../../lib/challenges-service";

// Synthèse légère du dashboard : le client reçoit en une fois ses deux défis prioritaires,
// ses points et le classement public. Aucun montant privé d'un autre membre n'est exposé.
export const runtime = "nodejs";

function resolveTarget(request: Request, viewer: { id: string; role: string }) {
  const asMember = new URL(request.url).searchParams.get("asMember");
  return { memberId: asMember && viewer.role === "admin" ? asMember : viewer.id, isPreview: viewer.role === "admin" && Boolean(asMember) };
}

function daysRemaining(endsOn: string | null): number | null {
  if (!endsOn) return null;
  const end = new Date(`${endsOn}T00:00:00Z`).getTime();
  const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`).getTime();
  return Math.max(0, Math.round((end - today) / 86_400_000));
}

export async function GET(request: Request) {
  try {
    const viewer = await requireFamilyMember(request);
    const { memberId, isPreview } = resolveTarget(request, viewer);
    const summary = await getChallengeDashboardSummary(memberId, { reconcile: !isPreview });
    // Le contrat du dashboard est volontairement le même que les routes Défis existantes :
    // il ne laisse jamais remonter les champs SQL ni un montant privé d'un autre membre.
    return Response.json({
      available: true,
      current: {
        available: true,
        state: summary.current.state,
        hasPlan: summary.current.hasPlan,
        hasTargetAccount: summary.current.hasTargetAccount,
        isParticipant: summary.current.isParticipant,
        challenge: summary.current.challenge ? {
          id: summary.current.challenge.id,
          title: summary.current.challenge.title,
          description: summary.current.challenge.description,
          startsOn: summary.current.challenge.starts_on,
          endsOn: summary.current.challenge.ends_on,
          pointsReward: summary.current.challenge.points_reward,
          daysRemaining: daysRemaining(summary.current.challenge.ends_on),
        } : null,
        progress: summary.current.progress ? {
          invested: summary.current.progress.invested,
          targetAmount: summary.current.progress.targetAmount,
          pct: summary.current.progress.pct,
          completed: summary.current.progress.completed,
          status: summary.current.progress.status,
        } : null,
      },
      onboarding: {
        available: summary.onboarding.available,
        ...summary.onboarding.progress,
        justCompleted: summary.onboarding.justCompleted,
      },
      points: summary.points,
      leaderboard: summary.leaderboard.map((entry) => ({ ...entry, isCurrentMember: entry.memberId === memberId })),
      leaderboardOptIn: summary.leaderboardOptIn,
    });
  } catch (error) {
    if (isMissingChallengeTable(error)) {
      // Trace explicite : sans elle, une migration non jouée se traduisait par une section vide
      // côté client et par RIEN côté serveur. Aucun identifiant ni montant n'est journalisé.
      console.warn("[challenges/summary] tables de défis absentes : appliquez 20260804_challenges_mvp.sql (et 20260805_onboarding_missions.sql) dans Supabase.");
      return Response.json({
        available: false,
        current: null,
        onboarding: null,
        points: null,
        leaderboard: [],
        leaderboardOptIn: false,
      });
    }
    return authErrorResponse(error);
  }
}
