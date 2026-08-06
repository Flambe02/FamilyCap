import { requireFamilyMember } from "./auth-server";
import { supabaseRest } from "./supabase-rest";
import { isPrimaryAdminEmail } from "./primary-admin";

export async function requireConsoleAdmin(request: Request) {
  const member = await requireFamilyMember(request);
  if (member.role !== "admin") throw Response.json({ error: "Accès administrateur refusé" }, { status: 403 });
  const roles = await supabaseRest<Array<{ role: "super_admin" | "admin" }>>("user_roles?select=role&user_id=eq." + encodeURIComponent(member.authUserId) + "&limit=1").catch(() => []);
  const consoleRole = roles[0]?.role ?? (isPrimaryAdminEmail(member.email) ? "super_admin" : "admin");
  return { ...member, consoleRole };
}

export async function requireConsoleSuperAdmin(request: Request) {
  const member = await requireConsoleAdmin(request);
  if (member.consoleRole !== "super_admin") throw Response.json({ error: "Accès super administrateur refusé" }, { status: 403 });
  return member;
}
