import { authErrorResponse, requireFamilyMember } from "../../../../lib/auth-server";
import { supabaseRest } from "../../../../lib/supabase-rest";

// Anniversaires RÉELS de la famille (Supabase = source de vérité unique). Remplace le repli
// statique de lib/family-roster.ts pour l'affichage — celui-ci avait dérivé silencieusement pour
// Aurore (27 → en réalité 26 août) et Uhaina (16 → en réalité 6 août), audit du 2026-07-25.
// Champs volontairement minimaux : identité, date civile et photo. L'e-mail, le rôle, les droits
// et le statut d'accès ne sont jamais exposés. Tout profil familial non supprimé est inclus,
// même lorsqu'il ne peut plus se connecter à l'application.
export const runtime = "nodejs";

type MemberRow = { id: string; name: string; birthday_day: number | null; birthday_month: number | null; birthday_year: number | null; photo_url: string | null };

export async function GET(request: Request) {
  try {
    await requireFamilyMember(request);
    const rows = await supabaseRest<MemberRow[]>(
      "family_members?select=id,name,birthday_day,birthday_month,birthday_year,photo_url&deleted_at=is.null&order=name.asc",
    );
    return Response.json({
      members: rows.map((row) => ({ id: row.id, name: row.name, birthdayDay: row.birthday_day, birthdayMonth: row.birthday_month, birthdayYear: row.birthday_year, photoUrl: row.photo_url })),
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}
