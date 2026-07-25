import { authErrorResponse, requireFamilyMember, type AuthenticatedMember } from "../../../lib/auth-server";
import { isSupabaseConfigured, supabaseRest } from "../../../lib/supabase-rest";
import { validateInvestmentPlanInput, type InvestmentPlanInput } from "../../../lib/investment-plan";
import { reconcileOnboardingForMember } from "../../../lib/onboarding-challenges-service";

// Plan d'investissement PERSONNEL du membre connecté (« Mon rythme d'investissement »), persisté
// dans public.user_investment_plan. Frontière de sécurité : requireFamilyMember identifie
// l'appelant ; le member_id est TOUJOURS forcé sur son identité — un membre ne peut ni lire ni
// écrire le plan d'un autre. Un ADMINISTRATEUR peut consulter/gérer le plan d'un membre via
// ?memberId= (même pattern que /api/notification-preferences). Le compte cible doit appartenir au
// membre (vérifié contre financial_accounts.member_id). Aucun point/défi n'est attribué ici.

export const runtime = "nodejs";

type Row = {
  monthly_target: number | string | null;
  target_account_id: string | null;
  target_day: number | null;
  instrument_preference: string;
  reminders_enabled: boolean;
  leaderboard_opt_in: boolean;
  effective_from: string | null;
};

const SELECT = "monthly_target,target_account_id,target_day,instrument_preference,reminders_enabled,leaderboard_opt_in,effective_from";

function isMissingTable(error: unknown) {
  return error instanceof Error && (error.message.includes("user_investment_plan") || error.message.includes("PGRST205") || error.message.includes("PGRST106"));
}

function toPlan(row: Row) {
  return {
    monthlyTarget: row.monthly_target === null || row.monthly_target === undefined ? null : Number(row.monthly_target),
    targetAccountId: row.target_account_id ?? null,
    targetDay: row.target_day ?? null,
    instrumentPreference: row.instrument_preference,
    remindersEnabled: row.reminders_enabled,
    leaderboardOptIn: row.leaderboard_opt_in,
    effectiveFrom: row.effective_from ?? null,
  };
}

// Cible : le membre connecté, ou — pour un administrateur uniquement — le membre passé en
// ?memberId=. Un non-admin ne peut jamais viser un id différent du sien.
function resolveTargetId(request: Request, viewer: AuthenticatedMember) {
  const requested = new URL(request.url).searchParams.get("memberId");
  return requested && viewer.role === "admin" ? requested : viewer.id;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export async function GET(request: Request) {
  if (!isSupabaseConfigured()) return Response.json({ plan: null, available: false });
  try {
    const viewer = await requireFamilyMember(request);
    const targetId = resolveTargetId(request, viewer);
    const rows = await supabaseRest<Row[]>(`user_investment_plan?select=${SELECT}&member_id=eq.${encodeURIComponent(targetId)}&limit=1`);
    return Response.json({ plan: rows[0] ? toPlan(rows[0]) : null, available: true });
  } catch (error) {
    if (isMissingTable(error)) return Response.json({ plan: null, available: false });
    return authErrorResponse(error);
  }
}

async function upsert(request: Request) {
  const viewer = await requireFamilyMember(request);
  const targetId = resolveTargetId(request, viewer);
  const body = (await request.json()) as InvestmentPlanInput;

  const validated = validateInvestmentPlanInput(body, todayISO());
  if (!validated.ok) return Response.json({ error: validated.error }, { status: 400 });
  const plan = validated.plan;

  // Un membre ne peut viser QUE l'un de ses propres comptes. L'appartenance est vérifiée contre
  // financial_accounts.member_id (jamais fournie par le navigateur) ; un compte d'un autre membre
  // est refusé plutôt que rattaché silencieusement.
  if (plan.targetAccountId) {
    const owned = await supabaseRest<Array<{ id: string }>>(
      `financial_accounts?select=id&id=eq.${encodeURIComponent(plan.targetAccountId)}&member_id=eq.${encodeURIComponent(targetId)}&limit=1`,
    );
    if (!owned[0]) return Response.json({ error: "Le compte choisi doit être l'un de vos comptes." }, { status: 400 });
  }

  await supabaseRest("user_investment_plan?on_conflict=member_id", {
    method: "POST",
    headers: { prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      member_id: targetId,
      monthly_target: plan.monthlyTarget,
      target_account_id: plan.targetAccountId,
      target_day: plan.targetDay,
      instrument_preference: plan.instrumentPreference,
      reminders_enabled: plan.remindersEnabled,
      leaderboard_opt_in: plan.leaderboardOptIn,
      effective_from: plan.effectiveFrom,
      updated_at: new Date().toISOString(),
    }),
  });
  // Reconnaissance automatique de la mission « Définis ton rythme » (best-effort ; n'affecte
  // jamais la réponse d'enregistrement du plan).
  try { await reconcileOnboardingForMember(targetId); } catch { /* missions non déployées / réconciliation différée à l'ouverture de l'écran */ }
  return Response.json({ saved: true, plan });
}

async function write(request: Request) {
  if (!isSupabaseConfigured()) return Response.json({ error: "Service indisponible : authentification requise." }, { status: 503 });
  try {
    return await upsert(request);
  } catch (error) {
    if (isMissingTable(error)) {
      return Response.json({ error: "L'enregistrement du rythme nécessite la migration Supabase 20260803_user_investment_plan.sql. Exécutez-la dans le SQL Editor, puis réessayez." }, { status: 409 });
    }
    return authErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  return write(request);
}

export async function PATCH(request: Request) {
  return write(request);
}
