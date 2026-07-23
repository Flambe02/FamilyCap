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
  photoUrl: string | null;
  walletAddress: string | null;
};

type FamilyMemberRow = { id: string; email: string; name: string; role: AuthenticatedMember["role"]; is_active: boolean; birthday_day: number | null; birthday_month: number | null; birthday_year: number | null; photo_url?: string | null; wallets: Array<{ public_address: string | null }> };

function isMissingPhotoColumn(error: unknown) {
  return error instanceof Error && (error.message.includes("photo_url") || error.message.includes("42703") || error.message.includes("PGRST204"));
}

// select=... photo_url en tentative, avec repli si la migration 20260729_member_avatar n'a pas
// encore ete jouee (colonne absente) — meme logique que language/display_currency dans
// app/api/profile/route.ts.
async function loadFamilyMemberRow(email: string): Promise<FamilyMemberRow | undefined> {
  const base = `family_members?email=eq.${encodeURIComponent(email)}&is_active=eq.true&limit=1`;
  try {
    const rows = await supabaseRest<FamilyMemberRow[]>(`${base}&select=id,email,name,role,is_active,birthday_day,birthday_month,birthday_year,photo_url,wallets(public_address)`);
    return rows[0];
  } catch (error) {
    if (!isMissingPhotoColumn(error)) throw error;
    const rows = await supabaseRest<FamilyMemberRow[]>(`${base}&select=id,email,name,role,is_active,birthday_day,birthday_month,birthday_year,wallets(public_address)`);
    return rows[0];
  }
}

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

  const member = await loadFamilyMemberRow(user.email.toLowerCase());
  if (!member) throw Response.json({ error: "Cette adresse n’est pas autorisée dans LaBaJo & Co" }, { status: 403 });
  return { authUserId: user.id, id: member.id, email: member.email, name: member.name, role: member.role, birthdayDay: member.birthday_day, birthdayMonth: member.birthday_month, birthdayYear: member.birthday_year, photoUrl: member.photo_url ?? null, walletAddress: member.wallets?.[0]?.public_address ?? null };
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

// ---- Partage par CLASSE d'actif (BTC / PEA / CTO) -----------------------------------
// Chaque propriétaire expose indépendamment son BTC, son PEA et/ou son compte-titres aux
// personnes avec qui il partage (scope 'family' ou grant). Répliqué en code car le
// service-role contourne la RLS (cf. can_view_member_asset dans 20260728).

export type AssetClass = "btc" | "pea" | "cto";
export type MemberShareFlags = { btc: boolean; pea: boolean; cto: boolean };

type ShareRow = { id: string; share_btc?: boolean | null; share_pea?: boolean | null; share_cto?: boolean | null };
function flagsOf(row: ShareRow): MemberShareFlags {
  // Colonnes absentes (migration 20260728 non jouée) → true : on retombe sur le partage
  // global historique « tout ou rien », jamais sur une sur-restriction silencieuse.
  return { btc: row.share_btc !== false, pea: row.share_pea !== false, cto: row.share_cto !== false };
}

/**
 * Map `member_id` → classes visibles par le viewer. `null` pour un admin (aucun filtre).
 * Soi est toujours présent avec les trois classes ouvertes. Repli sûr (soi uniquement) si
 * les tables/colonnes de partage sont absentes.
 */
export async function viewableInvestmentScope(viewer: AuthenticatedMember): Promise<Map<string, MemberShareFlags> | null> {
  if (viewer.role === "admin") return null;
  const scope = new Map<string, MemberShareFlags>();
  scope.set(viewer.id, { btc: true, pea: true, cto: true });
  try {
    const [familyScoped, grants] = await Promise.all([
      supabaseRest<ShareRow[]>(
        "family_members?select=id,share_btc,share_pea,share_cto&is_active=eq.true&investment_access_scope=eq.family",
      ),
      supabaseRest<Array<{ owner_member_id: string }>>(
        "investment_access_grants?select=owner_member_id&viewer_member_id=eq." + encodeURIComponent(viewer.id),
      ),
    ]);
    for (const owner of familyScoped) {
      if (owner.id === viewer.id) continue;
      scope.set(owner.id, flagsOf(owner));
    }
    const missingGrantOwners = [...new Set(grants.map((grant) => grant.owner_member_id))].filter((id) => !scope.has(id));
    if (missingGrantOwners.length) {
      const owners = await supabaseRest<ShareRow[]>(
        "family_members?select=id,share_btc,share_pea,share_cto&is_active=eq.true&id=in.(" + missingGrantOwners.map(encodeURIComponent).join(",") + ")",
      );
      for (const owner of owners) scope.set(owner.id, flagsOf(owner));
    }
  } catch {
    return new Map([[viewer.id, { btc: true, pea: true, cto: true }]]);
  }
  return scope;
}

/** Liste des `member_id` visibles par le viewer pour UNE classe. `null` = admin (aucun filtre). */
export async function viewableMemberIdsForClass(viewer: AuthenticatedMember, assetClass: AssetClass): Promise<string[] | null> {
  const scope = await viewableInvestmentScope(viewer);
  if (scope === null) return null;
  const ids: string[] = [];
  for (const [id, flags] of scope) if (flags[assetClass]) ids.push(id);
  return ids;
}
