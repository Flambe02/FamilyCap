import { authErrorResponse, requireFamilyMember } from "../../../lib/auth-server";
import { isSupabaseConfigured, supabaseRest } from "../../../lib/supabase-rest";
import {
  CURRENT_ONBOARDING_VERSION,
  ONBOARDING_MODULES,
  STEP_ORDER,
  defaultOnboardingState,
  type OnboardingModule,
  type OnboardingState,
  type OnboardingStep,
  type PrivacyChoice,
} from "../../../lib/onboarding/onboarding-types";

// État d'onboarding du membre connecté (public.user_onboarding). Frontière de sécurité :
// requireFamilyMember identifie l'appelant.
// Lecture ET écriture : un administrateur peut cibler un autre membre via memberId (aperçu admin
// « comme si connecté via son compte » — parité complète, sur le modèle de
// /api/notification-preferences::resolveTargetId). Un non-admin ne peut JAMAIS viser un autre id.

type Row = {
  version: number;
  status: OnboardingState["status"];
  current_step: string | null;
  completed_steps: string[] | null;
  selected_modules: string[] | null;
  privacy_choice: string | null;
  admin_can_edit: boolean;
  started_at: string | null;
  completed_at: string | null;
  deferred_at: string | null;
  updated_at: string | null;
};

const STATUSES = new Set(["not_started", "in_progress", "deferred", "completed"]);
const PRIVACY = new Set<PrivacyChoice>(["private", "admin", "custom"]);

function toState(row: Row | undefined): OnboardingState {
  if (!row) return defaultOnboardingState();
  const steps = (row.completed_steps ?? []).filter((step): step is OnboardingStep => (STEP_ORDER as string[]).includes(step));
  const modules = (row.selected_modules ?? []).filter((module): module is OnboardingModule => (ONBOARDING_MODULES as string[]).includes(module));
  return {
    version: row.version ?? CURRENT_ONBOARDING_VERSION,
    status: STATUSES.has(row.status) ? row.status : "not_started",
    currentStep: row.current_step && (STEP_ORDER as string[]).includes(row.current_step) ? (row.current_step as OnboardingStep) : null,
    completedSteps: steps,
    selectedModules: modules,
    privacyChoice: row.privacy_choice && PRIVACY.has(row.privacy_choice as PrivacyChoice) ? (row.privacy_choice as PrivacyChoice) : null,
    adminCanEdit: Boolean(row.admin_can_edit),
    startedAt: row.started_at,
    completedAt: row.completed_at,
    deferredAt: row.deferred_at,
    updatedAt: row.updated_at,
  };
}

function isMissingTable(error: unknown) {
  return error instanceof Error && (error.message.includes("user_onboarding") || error.message.includes("PGRST205") || error.message.includes("PGRST106"));
}

// Cible : le membre connecté, ou — pour un administrateur uniquement — le memberId fourni
// (querystring en GET, corps en PATCH). Un non-admin ne peut jamais viser un autre id.
function resolveTargetId(requested: string | null | undefined, viewer: { id: string; role: string }): string {
  return requested && viewer.role === "admin" ? requested : viewer.id;
}

const SELECT = "version,status,current_step,completed_steps,selected_modules,privacy_choice,admin_can_edit,started_at,completed_at,deferred_at,updated_at";

async function readRow(memberId: string): Promise<Row | undefined> {
  const rows = await supabaseRest<Row[]>(`user_onboarding?select=${SELECT}&member_id=eq.${encodeURIComponent(memberId)}&limit=1`);
  return rows[0];
}

export async function GET(request: Request) {
  if (!isSupabaseConfigured()) return Response.json({ state: defaultOnboardingState(), available: false });
  try {
    const viewer = await requireFamilyMember(request);
    const requested = new URL(request.url).searchParams.get("memberId");
    const targetId = resolveTargetId(requested, viewer);
    const row = await readRow(targetId);
    return Response.json({ state: toState(row), available: true });
  } catch (error) {
    if (isMissingTable(error)) return Response.json({ state: defaultOnboardingState(), available: false });
    return authErrorResponse(error);
  }
}

// Applique le choix de confidentialité sur le modèle RÉEL et appliqué en code
// (family_members.investment_access_scope + investment_access_grants), sans jamais sur-partager
// ni élargir silencieusement un droit. L'intention riche (private/admin/custom, adminCanEdit) est,
// elle, conservée dans user_onboarding. Aucun droit d'ÉCRITURE n'est accordé ici : `admin_can_edit`
// n'est qu'une préférence enregistrée (aucun enforcement d'écriture n'existe côté lecture/écriture).
async function applyPrivacyScope(memberId: string, choice: PrivacyChoice) {
  if (choice === "custom") {
    // On n'impose pas la sélection dans le tunnel : on ne partage pas largement, mais on ne
    // supprime pas non plus des autorisations déjà configurées (la config fine se fait après).
    await supabaseRest("family_members?id=eq." + encodeURIComponent(memberId), {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ investment_access_scope: "selected" }),
    });
    return;
  }
  // private / admin : périmètre le plus restrictif applicable (seul l'administrateur, qui garde
  // un accès de gestion, peut voir) — scope "selected" sans autorisation explicite.
  await supabaseRest("family_members?id=eq." + encodeURIComponent(memberId), {
    method: "PATCH",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify({ investment_access_scope: "selected" }),
  });
  await supabaseRest("investment_access_grants?owner_member_id=eq." + encodeURIComponent(memberId), {
    method: "DELETE",
    headers: { prefer: "return=minimal" },
  });
}

export async function PATCH(request: Request) {
  if (!isSupabaseConfigured()) return Response.json({ error: "Service indisponible : authentification requise." }, { status: 503 });
  try {
    const viewer = await requireFamilyMember(request);
    const body = await request.json() as {
      memberId?: unknown;
      status?: unknown; currentStep?: unknown; completedStep?: unknown;
      selectedModules?: unknown; privacyChoice?: unknown; adminCanEdit?: unknown;
    };
    const targetId = resolveTargetId(typeof body.memberId === "string" ? body.memberId : null, viewer);

    const current = await readRow(targetId).catch((error: unknown) => { if (isMissingTable(error)) throw error; return undefined; });
    const state = toState(current);

    const next: OnboardingState = { ...state };
    if (typeof body.status === "string" && STATUSES.has(body.status)) next.status = body.status as OnboardingState["status"];
    if (body.currentStep === null || (typeof body.currentStep === "string" && (STEP_ORDER as string[]).includes(body.currentStep))) next.currentStep = (body.currentStep as OnboardingStep) ?? null;
    if (typeof body.completedStep === "string" && (STEP_ORDER as string[]).includes(body.completedStep) && !next.completedSteps.includes(body.completedStep as OnboardingStep)) {
      next.completedSteps = [...next.completedSteps, body.completedStep as OnboardingStep];
    }
    if (Array.isArray(body.selectedModules)) {
      next.selectedModules = [...new Set(body.selectedModules.filter((m): m is OnboardingModule => typeof m === "string" && (ONBOARDING_MODULES as string[]).includes(m)))];
    }
    if (body.privacyChoice === null || (typeof body.privacyChoice === "string" && PRIVACY.has(body.privacyChoice as PrivacyChoice))) {
      next.privacyChoice = (body.privacyChoice as PrivacyChoice) ?? null;
    }
    if (typeof body.adminCanEdit === "boolean") next.adminCanEdit = body.adminCanEdit;

    const now = new Date().toISOString();
    if (!next.startedAt && next.status !== "not_started") next.startedAt = now;
    if (next.status === "completed" && !next.completedAt) next.completedAt = now;
    if (next.status === "deferred") next.deferredAt = now;

    // Appliquer d'abord la portée réelle : en cas d'échec, on ne persiste pas un état
    // d'onboarding qui prétendrait que la confidentialité a été configurée.
    if (typeof body.privacyChoice === "string" && PRIVACY.has(body.privacyChoice as PrivacyChoice)) {
      await applyPrivacyScope(targetId, body.privacyChoice as PrivacyChoice);
    }

    await supabaseRest("user_onboarding?on_conflict=member_id", {
      method: "POST",
      headers: { prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        member_id: targetId,
        version: CURRENT_ONBOARDING_VERSION,
        status: next.status,
        current_step: next.currentStep,
        completed_steps: next.completedSteps,
        selected_modules: next.selectedModules,
        privacy_choice: next.privacyChoice,
        admin_can_edit: next.adminCanEdit,
        started_at: next.startedAt,
        completed_at: next.completedAt,
        deferred_at: next.deferredAt,
        updated_at: now,
      }),
    });

    return Response.json({ saved: true, state: next });
  } catch (error) {
    if (isMissingTable(error)) {
      return Response.json({ error: "L'enregistrement de l'accueil nécessite la migration Supabase 20260723_user_onboarding.sql. Exécutez-la dans le SQL Editor, puis réessayez." }, { status: 409 });
    }
    return authErrorResponse(error);
  }
}
