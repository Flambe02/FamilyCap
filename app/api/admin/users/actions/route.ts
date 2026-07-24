import { createClient } from "@supabase/supabase-js";
import { authErrorResponse } from "../../../../../lib/auth-server";
import { requireConsoleSuperAdmin } from "../../../../../lib/admin-console-auth";
import { assertNotLastSuperAdmin } from "../../../../../lib/admin-super-admin";
import { writeAdminAudit } from "../../../../../lib/admin-audit";
import { supabaseRest } from "../../../../../lib/supabase-rest";

function clients() {
  const url = process.env.SUPABASE_URL; const secret = process.env.SUPABASE_SECRET_KEY; const publishable = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !secret || !publishable) throw new Error("Supabase Auth n'est pas configure.");
  return { admin: createClient(url, secret, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } }), public: createClient(url, publishable, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } }) };
}
type ActionBody = { action?: string; memberId?: string; redirectTo?: string; confirmation?: string };
type Member = { id: string; name: string; email: string | null; auth_user_id: string | null; role: string; is_active: boolean; access_status: string };
const PRIMARY_ADMIN_EMAIL = "florent.lambert@gmail.com";

async function memberFor(id: string) {
  const rows = await supabaseRest<Member[]>("family_members?select=id,name,email,auth_user_id,role,is_active,access_status&id=eq." + encodeURIComponent(id) + "&limit=1");
  return rows[0];
}
async function audit(actorId: string, memberId: string, action: string, afterValues?: Record<string, unknown>, metadata?: Record<string, unknown>) {
  await writeAdminAudit({ actorMemberId: actorId, targetMemberId: memberId, action, afterValues, metadata }).catch(() => undefined);
}
function redirect(value?: string) { return value || undefined; }

export async function POST(request: Request) {
  try {
    const actor = await requireConsoleSuperAdmin(request); const body = await request.json() as ActionBody;
    if (!body.memberId) return Response.json({ error: "Membre manquant." }, { status: 400 });
    const member = await memberFor(body.memberId);
    if (!member?.email) return Response.json({ error: "Ce membre n'a pas encore d'adresse e-mail." }, { status: 400 });
    if (member.email.toLowerCase() === PRIMARY_ADMIN_EMAIL && ["disable", "soft_delete", "delete_auth", "dissociate_auth"].includes(body.action ?? "")) return Response.json({ error: "Le compte administrateur principal est protege." }, { status: 403 });
    if (["disable", "soft_delete", "delete_auth", "dissociate_auth"].includes(body.action ?? "")) await assertNotLastSuperAdmin(member);
    const { admin, public: publicClient } = clients();

    if (body.action === "invite") {
      if (member.auth_user_id) return Response.json({ error: "Ce membre a deja un compte. Envoyez un magic link ou un lien de recuperation." }, { status: 409 });
      const { error } = await admin.auth.admin.inviteUserByEmail(member.email, { data: { name: member.name, family_member_id: member.id }, redirectTo: redirect(body.redirectTo) });
      if (error) throw error;
      const now = new Date().toISOString(); const expiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      await supabaseRest("invitations?member_id=eq." + encodeURIComponent(member.id) + "&status=in.(pending,sent)", { method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify({ status: "cancelled" }) }).catch(() => undefined);
      await supabaseRest("invitations", { method: "POST", headers: { prefer: "return=minimal" }, body: JSON.stringify({ member_id: member.id, email: member.email, status: "sent", sent_at: now, expires_at: expiry, created_by: actor.id }) }).catch(() => undefined);
      await supabaseRest("family_members?id=eq." + encodeURIComponent(member.id), { method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify({ access_status: "invited", invited_at: now }) });
      await audit(actor.id, member.id, "invitation.resent", { status: "sent" }, { emailDomain: member.email.split("@")[1] });
      return Response.json({ sent: true, message: "Invitation envoyee." });
    }
    if (body.action === "generate_invitation_link") {
      if (member.auth_user_id) return Response.json({ error: "Ce membre a deja un compte. Utilisez le magic link." }, { status: 409 });
      const { data, error } = await admin.auth.admin.generateLink({ type: "invite", email: member.email, options: { redirectTo: redirect(body.redirectTo), data: { name: member.name, family_member_id: member.id } } });
      if (error || !data.properties?.action_link) throw error ?? new Error("Lien d'invitation indisponible.");
      const now = new Date().toISOString(); const expiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      await supabaseRest("family_members?id=eq." + encodeURIComponent(member.id), { method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify({ access_status: "invited", invited_at: now }) });
      await supabaseRest("invitations?member_id=eq." + encodeURIComponent(member.id) + "&status=in.(pending,sent)", { method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify({ status: "cancelled" }) }).catch(() => undefined);
      await supabaseRest("invitations", { method: "POST", headers: { prefer: "return=minimal" }, body: JSON.stringify({ member_id: member.id, email: member.email, status: "sent", sent_at: now, expires_at: expiry, created_by: actor.id }) }).catch(() => undefined);
      await audit(actor.id, member.id, "invitation.link_generated", undefined, { emailDomain: member.email.split("@")[1] });
      return Response.json({ link: data.properties.action_link, message: "Lien genere. Il peut maintenant etre copie." });
    }
    if (body.action === "reset_password") {
      const { error } = await publicClient.auth.resetPasswordForEmail(member.email, { redirectTo: redirect(body.redirectTo) });
      if (error) throw error;
      await audit(actor.id, member.id, "password.reset_requested");
      return Response.json({ sent: true, message: "E-mail de reinitialisation envoye." });
    }
    if (body.action === "magic_link") {
      if (!member.auth_user_id) return Response.json({ error: "Ce membre doit d'abord recevoir une invitation." }, { status: 409 });
      const { error } = await publicClient.auth.signInWithOtp({ email: member.email, options: { shouldCreateUser: false, emailRedirectTo: redirect(body.redirectTo) } });
      if (error) throw error;
      await audit(actor.id, member.id, "magic_link.sent");
      return Response.json({ sent: true, message: "Magic link envoye." });
    }
    if (body.action === "cancel_invitation") {
      await supabaseRest("invitations?member_id=eq." + encodeURIComponent(member.id) + "&status=in.(pending,sent)", { method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify({ status: "cancelled" }) });
      await supabaseRest("family_members?id=eq." + encodeURIComponent(member.id), { method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify({ access_status: "allowed" }) });
      await audit(actor.id, member.id, "invitation.cancelled", { status: "cancelled" });
      return Response.json({ updated: true, message: "Invitation annulee." });
    }
    if (["disable", "reactivate"].includes(body.action ?? "")) {
      const active = body.action === "reactivate";
      if (!member.auth_user_id && active) return Response.json({ error: "Ce membre n'a pas encore de compte Auth." }, { status: 409 });
      if (member.auth_user_id) { const { error } = await admin.auth.admin.updateUserById(member.auth_user_id, { ban_duration: active ? "none" : "876000h" }); if (error) throw error; }
      await supabaseRest("family_members?id=eq." + encodeURIComponent(member.id), { method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify({ is_active: active, access_status: active ? "active" : "disabled" }) });
      await audit(actor.id, member.id, active ? "member.reactivated" : "member.disabled", { isActive: active });
      return Response.json({ updated: true, message: active ? "Compte reactive." : "Compte desactive." });
    }
    if (body.action === "dissociate_auth") {
      if (!member.auth_user_id) return Response.json({ error: "Aucun compte Auth n'est associe." }, { status: 409 });
      await supabaseRest("family_members?id=eq." + encodeURIComponent(member.id), { method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify({ auth_user_id: null, access_status: "allowed" }) });
      await supabaseRest("profiles?member_id=eq." + encodeURIComponent(member.id), { method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify({ member_id: null }) }).catch(() => undefined);
      await supabaseRest("user_roles?member_id=eq." + encodeURIComponent(member.id), { method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify({ member_id: null }) }).catch(() => undefined);
      await audit(actor.id, member.id, "auth.dissociated", { authUserId: null });
      return Response.json({ updated: true, message: "Compte Auth dissocie. Le compte Auth n'a pas ete supprime." });
    }
    if (body.action === "soft_delete") {
      if (body.confirmation !== "SUPPRIMER") return Response.json({ error: "Saisissez SUPPRIMER pour confirmer." }, { status: 400 });
      await supabaseRest("family_members?id=eq." + encodeURIComponent(member.id), { method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify({ is_active: false, access_status: "deleted", deleted_at: new Date().toISOString(), deleted_by: actor.id }) });
      if (member.auth_user_id) await admin.auth.admin.updateUserById(member.auth_user_id, { ban_duration: "876000h" });
      await audit(actor.id, member.id, "member.soft_deleted", { isActive: false, accessStatus: "deleted" });
      return Response.json({ updated: true, message: "Membre archive. Les donnees financieres sont conservees." });
    }
    if (body.action === "delete_auth") {
      if (body.confirmation !== "SUPPRIMER LE COMPTE") return Response.json({ error: "Saisissez SUPPRIMER LE COMPTE pour confirmer." }, { status: 400 });
      if (!member.auth_user_id) return Response.json({ error: "Aucun compte Auth n'est associe." }, { status: 409 });
      const { error } = await admin.auth.admin.deleteUser(member.auth_user_id); if (error) throw error;
      await supabaseRest("family_members?id=eq." + encodeURIComponent(member.id), { method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify({ auth_user_id: null, is_active: false, access_status: "deleted", deleted_at: new Date().toISOString(), deleted_by: actor.id }) });
      await audit(actor.id, member.id, "auth.deleted", { authDeleted: true, financialDataRetained: true });
      return Response.json({ updated: true, message: "Compte Auth supprime. Les donnees financieres sont conservees." });
    }
    return Response.json({ error: "Action inconnue." }, { status: 400 });
  } catch (error) { return authErrorResponse(error); }
}
