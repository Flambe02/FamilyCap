import { createClient } from "@supabase/supabase-js";
import { authErrorResponse, requireAdmin } from "../../../../../lib/auth-server";
import { supabaseRest } from "../../../../../lib/supabase-rest";

function clients() {
  const url = process.env.SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;
  const publishable = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !secret || !publishable) throw new Error("Supabase Auth n'est pas configure.");
  return { admin: createClient(url, secret, { auth: { autoRefreshToken: false, persistSession: false } }), public: createClient(url, publishable, { auth: { autoRefreshToken: false, persistSession: false } }) };
}

export async function POST(request: Request) {
  try {
    await requireAdmin(request);
    const body = await request.json() as { action?: string; memberId?: string; redirectTo?: string };
    if (!body.memberId) return Response.json({ error: "Membre manquant." }, { status: 400 });
    const members = await supabaseRest<Array<{ id: string; name: string; email: string | null; auth_user_id: string | null }>>("family_members?select=id,name,email,auth_user_id&id=eq." + encodeURIComponent(body.memberId) + "&limit=1");
    const member = members[0];
    if (!member?.email) return Response.json({ error: "Ce membre n'a pas encore d'adresse e-mail." }, { status: 400 });
    const { admin, public: publicClient } = clients();

    if (body.action === "reset_password") {
      const { error } = await publicClient.auth.resetPasswordForEmail(member.email, { redirectTo: body.redirectTo });
      if (error) throw error;
      return Response.json({ sent: true, message: "E-mail de r\u00e9initialisation envoy\u00e9." });
    }
    if (body.action === "invite") {
      if (member.auth_user_id) return Response.json({ error: "Ce membre a deja un compte. Utilisez le lien de mot de passe." }, { status: 409 });
      const { error } = await admin.auth.admin.inviteUserByEmail(member.email, { data: { name: member.name, family_member_id: member.id }, redirectTo: body.redirectTo });
      if (error) throw error;
      await supabaseRest("family_members?id=eq." + encodeURIComponent(member.id), { method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify({ access_status: "invited", invited_at: new Date().toISOString() }) });
      return Response.json({ sent: true, message: "Invitation envoy\u00e9e." });
    }
    return Response.json({ error: "Action inconnue." }, { status: 400 });
  } catch (error) { return authErrorResponse(error); }
}
