import { authErrorResponse, requireFamilyMember } from "../../../../../lib/auth-server";
import { joinChallenge, isMissingChallengeTable } from "../../../../../lib/challenges-service";

// Inscription du membre à UN défi (choisi par challengeId, plusieurs pouvant être visibles en
// même temps depuis la migration 20260825) + GEL de son objectif (target_amount_snapshot). Le
// member_id est FORCÉ depuis la session : un membre ne peut jamais s'inscrire pour un autre. Le
// statut « completed » et les points ne sont JAMAIS acceptés du client (calculés serveur) ;
// challengeId ne fait que SÉLECTIONNER lequel des défis déjà visibles pour ce membre rejoindre —
// joinChallenge revérifie côté serveur qu'il est bien actif, dans sa période et visible.
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const viewer = await requireFamilyMember(request);
    const body = (await request.json().catch(() => ({}))) as { challengeId?: unknown };
    if (typeof body.challengeId !== "string" || !body.challengeId) {
      return Response.json({ ok: false, error: "Le défi est obligatoire." }, { status: 400 });
    }
    const result = await joinChallenge(viewer.id, body.challengeId);
    if (!result.ok) {
      const status = result.reason === "no_active_challenge" ? 404 : 409;
      return Response.json({ ok: false, reason: result.reason, error: result.message }, { status });
    }
    return Response.json({
      ok: true,
      participant: { status: result.participant.status },
      progress: {
        invested: result.progress.invested, targetAmount: result.progress.targetAmount,
        pct: result.progress.pct, completed: result.progress.completed, status: result.progress.status,
      },
    }, { status: 201 });
  } catch (error) {
    if (isMissingChallengeTable(error)) {
      return Response.json({ error: "La migration des défis (20260804_challenges_mvp.sql) doit être appliquée dans Supabase.", setupRequired: true }, { status: 409 });
    }
    return authErrorResponse(error);
  }
}
