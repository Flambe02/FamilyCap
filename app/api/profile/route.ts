import { authErrorResponse, requireFamilyMember } from "../../../lib/auth-server";
import { isSupabaseConfigured, supabaseRest } from "../../../lib/supabase-rest";

// Profil en libre-service du membre connecté (family_members) : prénom, date d'anniversaire,
// langue, devise d'affichage. Frontière de sécurité : requireFamilyMember ; l'écriture cible
// l'appelant, SAUF pour un administrateur qui peut viser un autre membre via memberId (aperçu
// admin « comme si connecté via son compte » — parité complète). Un non-admin ne peut jamais
// viser un autre id. L'adresse e-mail (identifiant Supabase Auth) reste gérée par Supabase, pas ici.

type MemberRow = {
  name: string;
  birthday_day: number | null;
  birthday_month: number | null;
  birthday_year: number | null;
  language?: string | null;
  display_currency?: string | null;
};

function toProfile(row: MemberRow | undefined) {
  return {
    firstName: row?.name ?? "",
    lastName: "",
    birthdayDay: row?.birthday_day ?? null,
    birthdayMonth: row?.birthday_month ?? null,
    birthdayYear: row?.birthday_year ?? null,
    language: row?.language ?? "fr",
    displayCurrency: row?.display_currency ?? "EUR",
  };
}

function isMissingColumn(error: unknown) {
  return error instanceof Error && (error.message.includes("language") || error.message.includes("display_currency") || error.message.includes("42703") || error.message.includes("PGRST204"));
}

// Cible : le membre connecté, ou — pour un administrateur uniquement — le memberId fourni.
// Un non-admin ne peut jamais viser un autre id.
function resolveTargetId(requested: string | null | undefined, viewer: { id: string; role: string }): string {
  return requested && viewer.role === "admin" ? requested : viewer.id;
}

export async function GET(request: Request) {
  if (!isSupabaseConfigured()) return Response.json({ error: "Service indisponible." }, { status: 503 });
  try {
    const viewer = await requireFamilyMember(request);
    const requested = new URL(request.url).searchParams.get("memberId");
    const targetId = resolveTargetId(requested, viewer);
    // select=* : les colonnes language/display_currency sont lues si présentes, ignorées sinon
    // (aucune erreur si la migration 20260723 n'est pas encore jouée).
    const rows = await supabaseRest<MemberRow[]>("family_members?select=*&id=eq." + encodeURIComponent(targetId) + "&limit=1");
    return Response.json({ profile: toProfile(rows[0]) });
  } catch (error) {
    return authErrorResponse(error);
  }
}

function validBirthday(day: unknown, month: unknown, year: unknown) {
  const d = Number(day), m = Number(month), y = year === null || year === undefined || year === "" ? null : Number(year);
  if (!Number.isInteger(d) || d < 1 || d > 31) return null;
  if (!Number.isInteger(m) || m < 1 || m > 12) return null;
  if (y !== null && (!Number.isInteger(y) || y < 1900 || y > new Date().getFullYear())) return null;
  return { day: d, month: m, year: y };
}

const LANGUAGES = new Set(["fr"]);
const CURRENCIES = new Set(["EUR"]);

export async function PATCH(request: Request) {
  if (!isSupabaseConfigured()) return Response.json({ error: "Service indisponible : authentification requise." }, { status: 503 });
  try {
    const viewer = await requireFamilyMember(request);
    const body = await request.json() as {
      memberId?: unknown;
      firstName?: unknown; birthdayDay?: unknown; birthdayMonth?: unknown; birthdayYear?: unknown;
      language?: unknown; displayCurrency?: unknown;
    };
    const targetId = resolveTargetId(typeof body.memberId === "string" ? body.memberId : null, viewer);

    const core: Record<string, unknown> = {};
    // Prénom : jamais écrasé par une valeur vide (« ne pas écraser une donnée existante par du vide »).
    if (typeof body.firstName === "string") {
      const name = body.firstName.trim();
      if (!name) return Response.json({ error: "Le prénom est obligatoire." }, { status: 400 });
      core.name = name;
    }
    // Anniversaire : ne s'écrit que si les trois champs forment une date valide.
    if (body.birthdayDay !== undefined || body.birthdayMonth !== undefined) {
      const birthday = validBirthday(body.birthdayDay, body.birthdayMonth, body.birthdayYear);
      if (!birthday) return Response.json({ error: "Date d’anniversaire invalide." }, { status: 400 });
      core.birthday_day = birthday.day;
      core.birthday_month = birthday.month;
      core.birthday_year = birthday.year;
    }

    if (Object.keys(core).length) {
      await supabaseRest("family_members?id=eq." + encodeURIComponent(targetId), {
        method: "PATCH",
        headers: { prefer: "return=minimal" },
        body: JSON.stringify(core),
      });
    }

    // Préférences d'affichage : appliquées séparément, en tolérant l'absence des colonnes tant
    // que la migration 20260723 n'est pas jouée (le prénom/anniversaire restent enregistrés).
    const prefs: Record<string, unknown> = {};
    if (typeof body.language === "string" && LANGUAGES.has(body.language)) prefs.language = body.language;
    if (typeof body.displayCurrency === "string" && CURRENCIES.has(body.displayCurrency)) prefs.display_currency = body.displayCurrency;
    if (Object.keys(prefs).length) {
      try {
        await supabaseRest("family_members?id=eq." + encodeURIComponent(targetId), {
          method: "PATCH",
          headers: { prefer: "return=minimal" },
          body: JSON.stringify(prefs),
        });
      } catch (error) {
        if (!isMissingColumn(error)) throw error;
        // Colonnes absentes (migration non jouée) → on ignore, sans bloquer le parcours.
      }
    }

    return Response.json({ saved: true });
  } catch (error) {
    return authErrorResponse(error);
  }
}
