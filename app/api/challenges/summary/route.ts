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
    // Plusieurs défis peuvent être visibles en même temps (migration 20260825) ; la carte/section
    // dashboard garde volontairement UN SEUL point focal (cf. doc de ChallengesDashboardCard) —
    // on ne remonte donc que le premier défi visible ici. L'écran « Défis » complet, lui, lit la
    // liste entière via /api/challenges/current.
    const primary = summary.current[0] ?? null;
    return Response.json({
      available: true,
      current: {
        available: true,
        state: primary?.state ?? "challenge_ended",
        hasPlan: primary?.hasPlan ?? false,
        hasTargetAccount: primary?.hasTargetAccount ?? false,
        isParticipant: primary?.isParticipant ?? false,
        challenge: primary?.challenge ? {
          id: primary.challenge.id,
          title: primary.challenge.title,
          description: primary.challenge.description,
          startsOn: primary.challenge.starts_on,
          endsOn: primary.challenge.ends_on,
          pointsReward: primary.challenge.points_reward,
          daysRemaining: daysRemaining(primary.challenge.ends_on),
        } : null,
        progress: primary?.progress ? {
          invested: primary.progress.invested,
          targetAmount: primary.progress.targetAmount,
          pct: primary.progress.pct,
          completed: primary.progress.completed,
          status: primary.progress.status,
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
