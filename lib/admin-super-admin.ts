import { supabaseRest } from "./supabase-rest";

type ProtectedMember = { id: string; email: string | null; auth_user_id: string | null };

export async function assertNotLastSuperAdmin(member: ProtectedMember) {
  if (!member.auth_user_id) return;
  const roles = await supabaseRest<Array<{ user_id: string; role: string }>>("user_roles?select=user_id,role&role=eq.super_admin").catch(() => []);
  const superAdminIds = new Set(roles.map((role) => role.user_id));
  if (member.email?.toLowerCase() === "florent.lambert@gmail.com") superAdminIds.add(member.auth_user_id);
  if (superAdminIds.has(member.auth_user_id) && superAdminIds.size <= 1) throw Response.json({ error: "Le dernier super administrateur ne peut pas etre supprime, desactive ou dissocie." }, { status: 403 });
}
