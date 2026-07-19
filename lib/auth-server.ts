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

  const rows = await supabaseRest<Array<{ id: string; email: string; name: string; role: AuthenticatedMember["role"]; is_active: boolean; birthday_day: number | null; birthday_month: number | null; birthday_year: number | null }>>(
    `family_members?select=id,email,name,role,is_active,birthday_day,birthday_month,birthday_year&email=eq.${encodeURIComponent(user.email.toLowerCase())}&is_active=eq.true&limit=1`,
  );
  const member = rows[0];
  if (!member) throw Response.json({ error: "Cette adresse n’est pas autorisée dans LaBaJo & Co" }, { status: 403 });
  return { authUserId: user.id, id: member.id, email: member.email, name: member.name, role: member.role, birthdayDay: member.birthday_day, birthdayMonth: member.birthday_month, birthdayYear: member.birthday_year };
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
