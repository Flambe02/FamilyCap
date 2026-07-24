import { authErrorResponse, requireFamilyMember } from "../../../../lib/auth-server";
import { getLeaderboard, isMissingChallengeTable } from "../../../../lib/challenges-service";

// Classement familial (mensuel ou annuel), calculé UNIQUEMENT depuis points_ledger côté serveur.
// N'expose QUE : rang, member_id, prénom, avatar, points, nombre de défis terminés. JAMAIS un
// montant privé (objectif, montant investi, valeur, performance, compte). Respecte
// leaderboard_opt_in. Accessible aux membres authentifiés de la famille.
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const viewer = await requireFamilyMember(request);
    const url = new URL(request.url);
    const type = url.searchParams.get("period") === "year" ? "year" : "month";
    const year = Number(url.searchParams.get("year")) || undefined;
    const month = Number(url.searchParams.get("month")) || undefined;
    const rows = await getLeaderboard({ type, year, month });
    return Response.json({
      available: true,
      period: type,
      leaderboard: rows.map((row) => ({ ...row, isCurrentMember: row.memberId === viewer.id })),
    });
  } catch (error) {
    if (isMissingChallengeTable(error)) return Response.json({ available: false, period: "month", leaderboard: [] });
    return authErrorResponse(error);
  }
}
