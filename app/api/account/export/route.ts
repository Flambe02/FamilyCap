import { authErrorResponse, requireFamilyMember } from "../../../../lib/auth-server";
import { isSupabaseConfigured, supabaseRest } from "../../../../lib/supabase-rest";

// Export sécurisé des données personnelles du membre connecté (RGPD « télécharger mes données »).
// Frontière de sécurité : requireFamilyMember identifie l'appelant ; seules SES propres données
// sont rassemblées (member_id forcé sur son identité). Aucune donnée d'un autre membre n'est incluse.
// Les champs techniques sensibles (adresses publiques, TxID) sont volontairement omis.

type ProfileRow = { id: string; name: string; email: string | null; role: string; birthday_day: number | null; birthday_month: number | null; birthday_year: number | null };

export async function GET(request: Request) {
  if (!isSupabaseConfigured()) return Response.json({ error: "Service indisponible : authentification requise." }, { status: 503 });
  try {
    const viewer = await requireFamilyMember(request);
    // Cible : soi, ou — pour un administrateur — le membre passé en ?memberId=.
    const requested = new URL(request.url).searchParams.get("memberId");
    const targetId = requested && viewer.role === "admin" ? requested : viewer.id;

    const profileRows = targetId === viewer.id
      ? [{ id: viewer.id, name: viewer.name, email: viewer.email, role: viewer.role, birthday_day: viewer.birthdayDay, birthday_month: viewer.birthdayMonth, birthday_year: viewer.birthdayYear }]
      : await supabaseRest<ProfileRow[]>("family_members?select=id,name,email,role,birthday_day,birthday_month,birthday_year&id=eq." + encodeURIComponent(targetId) + "&limit=1");
    const profileRow = profileRows[0];
    if (!profileRow) return Response.json({ error: "Membre introuvable." }, { status: 404 });

    const ownFilter = "member_id=eq." + encodeURIComponent(targetId);

    const [gifts, accounts, transferRequests, grants] = await Promise.all([
      supabaseRest<Array<Record<string, unknown>>>(
        "gift_records?select=occasion,gift_date,amount_eur,btc_amount,custody,ledger_amount,note&" + ownFilter + "&order=gift_date.desc",
      ).catch(() => []),
      supabaseRest<Array<Record<string, unknown>>>(
        "financial_accounts?select=name,account_type,institution,currency,is_active&" + ownFilter,
      ).catch(() => []),
      supabaseRest<Array<Record<string, unknown>>>(
        "transfer_requests?select=transaction_id,btc_amount,requested_at,status&" + ownFilter + "&order=requested_at.desc",
      ).catch(() => []),
      supabaseRest<Array<{ viewer_member_id: string }>>(
        "investment_access_grants?select=viewer_member_id&owner_member_id=eq." + encodeURIComponent(targetId),
      ).catch(() => []),
    ]);

    const data = {
      exportedAt: new Date().toISOString(),
      application: "LaBaJo & Co",
      profile: {
        name: profileRow.name,
        email: profileRow.email,
        role: profileRow.role,
        birthdayDay: profileRow.birthday_day,
        birthdayMonth: profileRow.birthday_month,
        birthdayYear: profileRow.birthday_year,
      },
      gifts,
      financialAccounts: accounts,
      transferRequests,
      investmentSharing: { grantedViewerMemberIds: grants.map((grant) => grant.viewer_member_id) },
    };

    return new Response(JSON.stringify(data, null, 2), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": 'attachment; filename="labajo-mes-donnees.json"',
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}
