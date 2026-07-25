import { authErrorResponse, requireFamilyMember } from "../../../../lib/auth-server";
import { supabaseRest } from "../../../../lib/supabase-rest";

// Anniversaires RÉELS de la famille (Supabase = source de vérité unique). Remplace le repli
// statique de lib/family-roster.ts pour l'affichage — celui-ci avait dérivé silencieusement pour
// Aurore (27 → en réalité 26 août) et Uhaina (16 → en réalité 6 août), audit du 2026-07-25.
// Champs volontairement minimaux (jour/mois seulement, jamais l'année, l'e-mail, le rôle exact ou
// tout autre champ sensible) ; accessible à N'IMPORTE QUEL membre authentifié — un anniversaire
// familial n'est pas une donnée privée au sein du foyer, contrairement aux montants financiers.
// Restreint aux membres « du foyer » (adult/child), à l'exclusion de l'administrateur et des
// comptes de test/aperçu (role='viewer') — même périmètre que l'ancien roster codé en dur.
export const runtime = "nodejs";

type MemberRow = { id: string; name: string; birthday_day: number | null; birthday_month: number | null };

export async function GET(request: Request) {
  try {
    await requireFamilyMember(request);
    const rows = await supabaseRest<MemberRow[]>(
      "family_members?select=id,name,birthday_day,birthday_month&is_active=eq.true&role=in.(adult,child)&birthday_day=not.is.null&birthday_month=not.is.null&order=name.asc",
    );
    return Response.json({
      members: rows.map((row) => ({ id: row.id, name: row.name, birthdayDay: row.birthday_day, birthdayMonth: row.birthday_month })),
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}
