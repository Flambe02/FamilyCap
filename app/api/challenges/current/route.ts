import { authErrorResponse, requireFamilyMember } from "../../../../lib/auth-server";
import { getCurrentChallengesForMember, isMissingChallengeTable } from "../../../../lib/challenges-service";

// Contexte des défis COURANTS pour le membre connecté : liste (plusieurs défis mensuels peuvent
// être actifs et visibles en même temps depuis la migration 20260825 — ex. un défi permanent et
// un défi spécial débloqué), chacun avec son état (no_plan / no_account / ready_to_join /
// in_progress / completed / challenge_ended) et sa PROPRE progression. Réconcilie à l'ouverture
// (reconnaît les achats importés/antérieurs). Aucun montant d'autrui.
export const runtime = "nodejs";

// null pour un défi PERMANENT (ends_on NULL) : il n'y a pas de compte à rebours. Le client doit
// afficher « Sans échéance » plutôt que d'inventer un nombre de jours.
function daysRemaining(endsOn: string | null): number | null {
  if (!endsOn) return null;
  const end = new Date(`${endsOn}T00:00:00Z`).getTime();
  const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`).getTime();
  return Math.max(0, Math.round((end - today) / 86_400_000));
}

// Aperçu admin (lecture seule, cf. CLAUDE.md « Admin preview is UI-only ») : ?asMember=<id>
// affiche le contexte du membre prévisualisé plutôt que celui de l'admin — jamais l'inverse, et
// jamais pour un non-admin (un membre ne peut jamais lire le défi d'un autre via ce paramètre).
function resolveTargetId(request: Request, viewer: { id: string; role: string }): string {
  const asMember = new URL(request.url).searchParams.get("asMember");
  return asMember && viewer.role === "admin" ? asMember : viewer.id;
}

export async function GET(request: Request) {
  try {
    const viewer = await requireFamilyMember(request);
    const isAdminPreview = viewer.role === "admin" && Boolean(new URL(request.url).searchParams.get("asMember"));
    const list = await getCurrentChallengesForMember(resolveTargetId(request, viewer), { reconcile: !isAdminPreview });
    return Response.json({
      available: true,
      challenges: list.map((ctx) => ({
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
      })),
    });
  } catch (error) {
    if (isMissingChallengeTable(error)) return Response.json({ available: false, challenges: [] });
    return authErrorResponse(error);
  }
}
