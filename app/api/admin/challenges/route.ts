import { authErrorResponse, requireAdmin } from "../../../../lib/auth-server";
import { listChallengesForAdmin, createChallenge, updateChallenge, isMissingChallengeTable, type AdminChallengeRow } from "../../../../lib/challenges-service";
import type { ChallengeInput } from "../../../../lib/challenges";

// Back-office « Défis & animation » — création et gestion des défis. requireAdmin sur chaque
// mutation ; le rôle est vérifié côté serveur. Les points ne sont jamais saisis ici : ils sont
// attribués automatiquement par la réconciliation (challenges-service).
export const runtime = "nodejs";

function setup(error: unknown) {
  if (isMissingChallengeTable(error)) {
    return Response.json({ error: "La migration des défis (20260804_challenges_mvp.sql) doit être appliquée dans Supabase.", setupRequired: true }, { status: 409 });
  }
  return authErrorResponse(error);
}

export async function GET(request: Request) {
  try {
    await requireAdmin(request);
    const challenges = await listChallengesForAdmin();
    return Response.json({ challenges: challenges.map(toDto) });
  } catch (error) {
    if (isMissingChallengeTable(error)) return Response.json({ challenges: [] });
    return authErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const admin = await requireAdmin(request);
    const body = (await request.json()) as ChallengeInput & { status?: string };
    const result = await createChallenge(body, admin.id);
    if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
    return Response.json({ challenge: toDto({ ...result.challenge, participants: 0, completed: 0, completionRate: 0, pointsAttributed: 0 }) }, { status: 201 });
  } catch (error) {
    return setup(error);
  }
}

export async function PATCH(request: Request) {
  try {
    await requireAdmin(request);
    const body = (await request.json()) as ChallengeInput & { id?: string; status?: string };
    if (!body.id) return Response.json({ error: "Le défi est obligatoire." }, { status: 400 });
    const { id, ...patch } = body;
    const result = await updateChallenge(id, patch);
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    return Response.json({ challenge: toDto({ ...result.challenge, participants: 0, completed: 0, completionRate: 0, pointsAttributed: 0 }) });
  } catch (error) {
    return setup(error);
  }
}

function toDto(row: AdminChallengeRow) {
  return {
    id: row.id, title: row.title, description: row.description, status: row.status,
    startsOn: row.starts_on, endsOn: row.ends_on, pointsReward: row.points_reward,
    eligibleAccountTypes: row.eligible_account_types, eligibleInstrumentTypes: row.eligible_instrument_types,
    participants: row.participants, completed: row.completed, completionRate: row.completionRate, pointsAttributed: row.pointsAttributed,
  };
}
