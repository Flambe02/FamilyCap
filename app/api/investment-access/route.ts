import { authErrorResponse, requireFamilyMember } from "../../../lib/auth-server";
import { supabaseRest } from "../../../lib/supabase-rest";

type Member = { id: string; name: string; role: "admin" | "adult" | "child" | "viewer"; is_active: boolean; email: string | null };
type Grant = { viewer_member_id: string };

export async function GET(request: Request) {
  try {
    const viewer = await requireFamilyMember(request);
    const [members, owner, grants] = await Promise.all([
      supabaseRest<Member[]>("family_members?select=id,name,role,is_active,email&is_active=eq.true&order=name.asc"),
      supabaseRest<Array<{ investment_access_scope?: "family" | "selected" }>>("family_members?select=investment_access_scope&id=eq." + encodeURIComponent(viewer.id) + "&limit=1"),
      supabaseRest<Grant[]>("investment_access_grants?select=viewer_member_id&owner_member_id=eq." + encodeURIComponent(viewer.id)),
    ]);
    return Response.json({ scope: owner[0]?.investment_access_scope ?? "family", selectedIds: grants.map((grant) => grant.viewer_member_id), members: members.filter((member) => member.id !== viewer.id) });
  } catch (error) { return authErrorResponse(error); }
}

export async function PATCH(request: Request) {
  try {
    const owner = await requireFamilyMember(request);
    const body = await request.json() as { scope?: string; selectedIds?: unknown };
    const scope = body.scope === "selected" ? "selected" : body.scope === "family" ? "family" : null;
    if (!scope) return Response.json({ error: "Niveau de partage invalide." }, { status: 400 });
    const requestedIds = Array.isArray(body.selectedIds) ? body.selectedIds.filter((id): id is string => typeof id === "string") : [];
    const members = await supabaseRest<Member[]>("family_members?select=id,name,role,is_active,email&is_active=eq.true");
    const allowedIds = new Set(members.filter((member) => member.id !== owner.id).map((member) => member.id));
    const selectedIds = [...new Set(requestedIds)].filter((id) => allowedIds.has(id));
    if (scope === "selected" && selectedIds.length === 0) return Response.json({ error: "Choisissez au moins une personne ou partagez avec toute la famille." }, { status: 400 });
    await supabaseRest("family_members?id=eq." + encodeURIComponent(owner.id), { method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify({ investment_access_scope: scope }) });
    await supabaseRest("investment_access_grants?owner_member_id=eq." + encodeURIComponent(owner.id), { method: "DELETE", headers: { prefer: "return=minimal" } });
    if (scope === "selected" && selectedIds.length) {
      await supabaseRest("investment_access_grants", { method: "POST", headers: { prefer: "return=minimal" }, body: JSON.stringify(selectedIds.map((viewerMemberId) => ({ owner_member_id: owner.id, viewer_member_id: viewerMemberId }))) });
    }
    return Response.json({ saved: true, scope, selectedIds: scope === "selected" ? selectedIds : [] });
  } catch (error) { return authErrorResponse(error); }
}
