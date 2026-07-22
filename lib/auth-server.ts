import { supabaseRest } from "./supabase-rest";

type RuntimeEnv = { SUPABASE_URL?: string; SUPABASE_PUBLISHABLE_KEY?: string };
function runtimeEnv(): RuntimeEnv {
  return {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY,
  };
}

export type AuthenticatedMember = {
  authUserId: string;
  id: string;
  email: string;
  name: string;
  role: "admin" | "adult" | "child" | "viewer";
  birthdayDay: number | null;
  birthdayMonth: number | null;
  birthdayYear: number | null;
  walletAddress: string | null;
};

export async function requireFamilyMember(request: Request): Promise<AuthenticatedMember> {
  const runtime = runtimeEnv();
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) throw Response.json({ error: "Non authentifié" }, { status: 401 });
  if (!runtime.SUPABASE_URL || !runtime.SUPABASE_PUBLISHABLE_KEY) throw Response.json({ error: "Authentification non configurée" }, { status: 503 });

  const userResponse = await fetch(`${runtime.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/user`, {
    headers: { apikey: runtime.SUPABASE_PUBLISHABLE_KEY, authorization: `Bearer ${token}` },
  });
  if (!userResponse.ok) throw Response.json({ error: "Session invalide" }, { status: 401 });
  const user = await userResponse.json() as { id: string; email?: string };
  if (!user.email) throw Response.json({ error: "Adresse e-mail absente" }, { status: 403 });

  const rows = await supabaseRest<Array<{ id: string; email: string; name: string; role: AuthenticatedMember["role"]; is_active: boolean; birthday_day: number | null; birthday_month: number | null; birthday_year: number | null; wallets: Array<{ public_address: string | null }> }>>(
    `family_members?select=id,email,name,role,is_active,birthday_day,birthday_month,birthday_year,wallets(public_address)&email=eq.${encodeURIComponent(user.email.toLowerCase())}&is_active=eq.true&limit=1`,
  );
  const member = rows[0];
  if (!member) throw Response.json({ error: "Cette adresse n’est pas autorisée dans LaBaJo & Co" }, { status: 403 });
  return { authUserId: user.id, id: member.id, email: member.email, name: member.name, role: member.role, birthdayDay: member.birthday_day, birthdayMonth: member.birthday_month, birthdayYear: member.birthday_year, walletAddress: member.wallets?.[0]?.public_address ?? null };
}

export async function requireAdmin(request: Request) {
  const member = await requireFamilyMember(request);
  if (member.role !== "admin") {
    throw Response.json({ error: "Accès administrateur refusé" }, { status: 403 });
  }
  return member;
}

export function authErrorResponse(error: unknown) {
  if (error instanceof Response) return error;
  return Response.json({ error: error instanceof Error ? error.message : "Erreur d’authentification" }, { status: 500 });
}

/**
 * Ensemble des `member_id` que l'appelant est autorisé à consulter côté investissements,
 * en répliquant EN CODE la logique de la fonction SQL `can_view_member_investments`
 * (le service-role contourne la RLS, la frontière de sécurité est donc ici) :
 *  - admin  → `null` (aucun filtre : accès de gestion à toute la famille) ;
 *  - membre → soi + les membres dont le partage est ouvert à toute la famille
 *             (`investment_access_scope = 'family'`) + ceux qui l'ont explicitement autorisé
 *             via `investment_access_grants`.
 *
 * Repli sûr : si les colonnes/tables de partage ne sont pas encore présentes (migration
 * 20260718 non jouée), on renvoie le périmètre le plus restrictif (soi uniquement) —
 * jamais une sur-exposition.
 */
export async function viewableMemberIds(viewer: AuthenticatedMember): Promise<string[] | null> {
  if (viewer.role === "admin") return null;
  const ids = new Set<string>([viewer.id]);
  try {
    const [familyScoped, grants] = await Promise.all([
      supabaseRest<Array<{ id: string }>>(
        "family_members?select=id&is_active=eq.true&investment_access_scope=eq.family",
      ),
      supabaseRest<Array<{ owner_member_id: string }>>(
        "investment_access_grants?select=owner_member_id&viewer_member_id=eq." + encodeURIComponent(viewer.id),
      ),
    ]);
    for (const member of familyScoped) ids.add(member.id);
    for (const grant of grants) ids.add(grant.owner_member_id);
  } catch {
    // Partage non déployé → périmètre minimal (soi uniquement).
    return [viewer.id];
  }
  return [...ids];
}
