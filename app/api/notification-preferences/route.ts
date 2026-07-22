import { authErrorResponse, requireFamilyMember } from "../../../lib/auth-server";
import { isSupabaseConfigured, supabaseRest } from "../../../lib/supabase-rest";

// Préférences de notifications du membre connecté (persistées dans public.notification_preferences).
// Frontière de sécurité : requireFamilyMember identifie l'appelant ; le member_id est FORCÉ sur
// son identité — un membre ne peut ni lire ni écrire les préférences d'un autre.
// Aucune campagne d'e-mail n'est déclenchée : seules les préférences sont enregistrées.

type Preferences = {
  gifts: boolean;
  events: boolean;
  investments: boolean;
  security: boolean;
  emailWeekly: boolean;
};

const DEFAULTS: Preferences = { gifts: true, events: true, investments: true, security: true, emailWeekly: true };
const KEYS: (keyof Preferences)[] = ["gifts", "events", "investments", "security", "emailWeekly"];

type Row = { gifts: boolean; events: boolean; investments: boolean; security: boolean; email_weekly: boolean };

function toPreferences(row: Row): Preferences {
  return { gifts: row.gifts, events: row.events, investments: row.investments, security: row.security, emailWeekly: row.email_weekly };
}

function isMissingTable(error: unknown) {
  return error instanceof Error && (error.message.includes("notification_preferences") || error.message.includes("PGRST205") || error.message.includes("PGRST106"));
}

// Cible : le membre connecté, ou — pour un administrateur uniquement — le membre passé en
// ?memberId= (gestion des réglages d'un membre). Un non-admin ne peut jamais viser un autre id.
function resolveTargetId(request: Request, viewer: { id: string; role: string }) {
  const requested = new URL(request.url).searchParams.get("memberId");
  return requested && viewer.role === "admin" ? requested : viewer.id;
}

export async function GET(request: Request) {
  if (!isSupabaseConfigured()) return Response.json({ preferences: DEFAULTS, available: false, persisted: false });
  try {
    const viewer = await requireFamilyMember(request);
    const targetId = resolveTargetId(request, viewer);
    const rows = await supabaseRest<Row[]>(
      "notification_preferences?select=gifts,events,investments,security,email_weekly&member_id=eq." + encodeURIComponent(targetId) + "&limit=1",
    );
    return Response.json({ preferences: rows[0] ? toPreferences(rows[0]) : DEFAULTS, available: true, persisted: Boolean(rows[0]) });
  } catch (error) {
    if (isMissingTable(error)) return Response.json({ preferences: DEFAULTS, available: false, persisted: false });
    return authErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  if (!isSupabaseConfigured()) return Response.json({ error: "Service indisponible : authentification requise." }, { status: 503 });
  try {
    const viewer = await requireFamilyMember(request);
    const targetId = resolveTargetId(request, viewer);
    const body = await request.json() as Partial<Record<keyof Preferences, unknown>>;
    // On part des préférences existantes (ou des défauts) puis on applique uniquement les
    // booléens fournis : une requête partielle ne réinitialise jamais les autres réglages.
    const current = await supabaseRest<Row[]>(
      "notification_preferences?select=gifts,events,investments,security,email_weekly&member_id=eq." + encodeURIComponent(targetId) + "&limit=1",
    ).catch((error: unknown) => { if (isMissingTable(error)) throw error; return [] as Row[]; });
    const merged: Preferences = current[0] ? toPreferences(current[0]) : { ...DEFAULTS };
    for (const key of KEYS) {
      if (typeof body[key] === "boolean") merged[key] = body[key] as boolean;
    }
    await supabaseRest("notification_preferences?on_conflict=member_id", {
      method: "POST",
      headers: { prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        member_id: targetId,
        gifts: merged.gifts,
        events: merged.events,
        investments: merged.investments,
        security: merged.security,
        email_weekly: merged.emailWeekly,
        updated_at: new Date().toISOString(),
      }),
    });
    return Response.json({ saved: true, preferences: merged });
  } catch (error) {
    if (isMissingTable(error)) {
      return Response.json({ error: "L'enregistrement des notifications nécessite la migration Supabase 20260721_notification_preferences.sql. Exécutez-la dans le SQL Editor, puis réessayez." }, { status: 409 });
    }
    return authErrorResponse(error);
  }
}
