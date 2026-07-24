import { authErrorResponse } from "../../../../../lib/auth-server";
import { requireConsoleAdmin } from "../../../../../lib/admin-console-auth";
import { supabaseRest } from "../../../../../lib/supabase-rest";

type AuditRow = { id: string; actor_member_id: string | null; target_member_id: string | null; action: string; before_values: Record<string, unknown> | null; after_values: Record<string, unknown> | null; metadata: Record<string, unknown> | null; created_at: string };

export async function GET(request: Request) {
  try {
    await requireConsoleAdmin(request);
    const memberId = new URL(request.url).searchParams.get("memberId");
    if (!memberId) return Response.json({ error: "Membre manquant." }, { status: 400 });
    const rows = await supabaseRest<AuditRow[]>("admin_audit_log?select=id,actor_member_id,target_member_id,action,before_values,after_values,metadata,created_at&target_member_id=eq." + encodeURIComponent(memberId) + "&order=created_at.desc&limit=100").catch(() => []);
    const ids = [...new Set(rows.flatMap((row) => row.actor_member_id ? [row.actor_member_id] : []))];
    const names = ids.length ? await supabaseRest<Array<{ id: string; name: string }>>("family_members?select=id,name&id=in.(" + ids.map(encodeURIComponent).join(",") + ")").catch(() => []) : [];
    const nameById = new Map(names.map((member) => [member.id, member.name]));
    return Response.json({ activities: rows.map((row) => ({ ...row, actorName: row.actor_member_id ? nameById.get(row.actor_member_id) ?? "Administration" : "Système" })) });
  } catch (error) { return authErrorResponse(error); }
}
