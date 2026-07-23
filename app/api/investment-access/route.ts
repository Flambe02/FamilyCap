import { authErrorResponse, requireFamilyMember } from "../../../lib/auth-server";
import { supabaseRest } from "../../../lib/supabase-rest";

type Member = { id: string; name: string; role: "admin" | "adult" | "child" | "viewer"; is_active: boolean; email: string | null };
type Grant = { viewer_member_id: string };

type OwnerRow = { investment_access_scope?: "family" | "selected"; share_btc?: boolean | null; share_pea?: boolean | null; share_cto?: boolean | null };

// Colonnes de classe absentes (migration 20260728 non jouée) → true : le partage global
// historique s'applique tel quel, jamais une restriction silencieuse.
function shareClassesOf(owner: OwnerRow | undefined) {
  return { btc: owner?.share_btc !== false, pea: owner?.share_pea !== false, cto: owner?.share_cto !== false };
}

export async function GET(request: Request) {
  try {
    const viewer = await requireFamilyMember(request);
    const [members, owner, grants] = await Promise.all([
      supabaseRest<Member[]>("family_members?select=id,name,role,is_active,email&is_active=eq.true&order=name.asc"),
      // Tolère l'absence des colonnes de classe : on réessaie sans elles si la migration n'est pas jouée.
      supabaseRest<OwnerRow[]>("family_members?select=investment_access_scope,share_btc,share_pea,share_cto&id=eq." + encodeURIComponent(viewer.id) + "&limit=1")
        .catch(() => supabaseRest<OwnerRow[]>("family_members?select=investment_access_scope&id=eq." + encodeURIComponent(viewer.id) + "&limit=1")),
      supabaseRest<Grant[]>("investment_access_grants?select=viewer_member_id&owner_member_id=eq." + encodeURIComponent(viewer.id)),
    ]);
    return Response.json({
      scope: owner[0]?.investment_access_scope ?? "family",
      selectedIds: grants.map((grant) => grant.viewer_member_id),
      shareClasses: shareClassesOf(owner[0]),
      members: members.filter((member) => member.id !== viewer.id),
    });
  } catch (error) { return authErrorResponse(error); }
}

// Écrit le membre en tolérant l'absence des colonnes de classe (migration 20260728 non jouée) :
// on retire share_* et on réessaie, sans jamais bloquer l'enregistrement du scope.
async function patchOwner(ownerId: string, payload: Record<string, unknown>) {
  try {
    await supabaseRest("family_members?id=eq." + encodeURIComponent(ownerId), { method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify(payload) });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("PGRST204") && /share_(btc|pea|cto)/i.test(message)) {
      const fallback = { ...payload };
      delete fallback.share_btc; delete fallback.share_pea; delete fallback.share_cto;
      await supabaseRest("family_members?id=eq." + encodeURIComponent(ownerId), { method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify(fallback) });
      return false;
    }
    throw error;
  }
}

function readFlag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export async function PATCH(request: Request) {
  try {
    const owner = await requireFamilyMember(request);
    const body = await request.json() as { scope?: string; selectedIds?: unknown; shareClasses?: { btc?: unknown; pea?: unknown; cto?: unknown } };
    const scope = body.scope === "selected" ? "selected" : body.scope === "family" ? "family" : null;
    if (!scope) return Response.json({ error: "Niveau de partage invalide." }, { status: 400 });
    const requestedIds = Array.isArray(body.selectedIds) ? body.selectedIds.filter((id): id is string => typeof id === "string") : [];
    const members = await supabaseRest<Member[]>("family_members?select=id,name,role,is_active,email&is_active=eq.true");
    const allowedIds = new Set(members.filter((member) => member.id !== owner.id).map((member) => member.id));
    const selectedIds = [...new Set(requestedIds)].filter((id) => allowedIds.has(id));
    if (scope === "selected" && selectedIds.length === 0) return Response.json({ error: "Choisissez au moins une personne ou partagez avec toute la famille." }, { status: 400 });
    const shareClasses = {
      btc: readFlag(body.shareClasses?.btc, true),
      pea: readFlag(body.shareClasses?.pea, true),
      cto: readFlag(body.shareClasses?.cto, true),
    };
    const persistedClasses = await patchOwner(owner.id, {
      investment_access_scope: scope,
      share_btc: shareClasses.btc, share_pea: shareClasses.pea, share_cto: shareClasses.cto,
    });
    await supabaseRest("investment_access_grants?owner_member_id=eq." + encodeURIComponent(owner.id), { method: "DELETE", headers: { prefer: "return=minimal" } });
    if (scope === "selected" && selectedIds.length) {
      await supabaseRest("investment_access_grants", { method: "POST", headers: { prefer: "return=minimal" }, body: JSON.stringify(selectedIds.map((viewerMemberId) => ({ owner_member_id: owner.id, viewer_member_id: viewerMemberId }))) });
    }
    return Response.json({
      saved: true, scope, selectedIds: scope === "selected" ? selectedIds : [],
      shareClasses, shareClassesPersisted: persistedClasses,
    });
  } catch (error) { return authErrorResponse(error); }
}
