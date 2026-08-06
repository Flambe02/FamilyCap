import { authErrorResponse, requireAdmin } from "../../../../../lib/auth-server";
import { getChallengeMembersAdmin, adminSetChallengePoints, unlockChallengeForMember, isMissingChallengeTable } from "../../../../../lib/challenges-service";

// Administration « Défis & animation » — vue unifiée « qui a fait ce défi, ou pas » (mensuel ET
// missions « Bien démarrer ») + attribution/retrait/ajustement manuel des points. Les montants
// (invested/targetAmount) sont admin-only, comme sur /api/admin/challenges/participants.
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    await requireAdmin(request);
    const challengeId = new URL(request.url).searchParams.get("challengeId");
    if (!challengeId) return Response.json({ error: "Le défi est obligatoire." }, { status: 400 });
    const members = await getChallengeMembersAdmin(challengeId);
    return Response.json({ members });
  } catch (error) {
    if (isMissingChallengeTable(error)) return Response.json({ members: [] });
    return authErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const admin = await requireAdmin(request);
    const body = (await request.json()) as { challengeId?: string; memberId?: string; points?: number; action?: string };
    if (!body.challengeId || !body.memberId) return Response.json({ error: "Défi et membre sont obligatoires." }, { status: 400 });
    if (body.action === "unlock") {
      const result = await unlockChallengeForMember(body.challengeId, body.memberId, admin.id);
      if (!result.ok) return Response.json({ error: result.error }, { status: 409 });
      return Response.json({ ok: true });
    }
    if (typeof body.points !== "number" || !Number.isFinite(body.points) || body.points < 0 || body.points > 10_000) {
      return Response.json({ error: "Les points doivent être un nombre entre 0 et 10 000." }, { status: 400 });
    }
    const result = await adminSetChallengePoints(body.challengeId, body.memberId, Math.round(body.points), admin.id);
    if (!result.ok) return Response.json({ error: result.error }, { status: 409 });
    return Response.json({ ok: true });
  } catch (error) {
    if (isMissingChallengeTable(error)) return Response.json({ error: "La migration des défis doit être appliquée dans Supabase." }, { status: 409 });
    return authErrorResponse(error);
  }
}
