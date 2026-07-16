import { createClient } from "@supabase/supabase-js";
import { env } from "cloudflare:workers";
import { authErrorResponse, requireAdmin } from "../../../../lib/auth-server";
import { supabaseRest } from "../../../../lib/supabase-rest";

type RuntimeEnv = { SUPABASE_URL?: string; SUPABASE_SECRET_KEY?: string };
const runtime = env as unknown as RuntimeEnv;

function adminClient() {
  if (!runtime.SUPABASE_URL || !runtime.SUPABASE_SECRET_KEY) throw new Error("Supabase Admin non configuré");
  return createClient(runtime.SUPABASE_URL, runtime.SUPABASE_SECRET_KEY, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}

export async function GET(request: Request) {
  try {
    await requireAdmin(request);
    const users = await supabaseRest<Record<string, unknown>[]>("family_members?select=*&order=name.asc");
    return Response.json({ users });
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    await requireAdmin(request);
    const body = await request.json() as { name?: string; email?: string; role?: string; birthdayDay?: number; birthdayMonth?: number; sendInvite?: boolean; redirectTo?: string };
    const name = body.name?.trim() ?? "";
    const email = body.email?.trim().toLowerCase() ?? "";
    const role = ["adult", "child", "viewer"].includes(body.role ?? "") ? body.role : "child";
    if (!name || !/^\S+@\S+\.\S+$/.test(email)) return Response.json({ error: "Nom et e-mail valides obligatoires." }, { status: 400 });
    if (email === "florent.lambert@gmail.com") return Response.json({ error: "Le compte administrateur existe déjà." }, { status: 409 });

    const rows = await supabaseRest<Array<{ id: string }>>("family_members?on_conflict=email", {
      method: "POST",
      headers: { prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({ name, email, role, birthday_day: body.birthdayDay ?? null, birthday_month: body.birthdayMonth ?? null, is_active: true, access_status: body.sendInvite ? "invited" : "allowed", invited_at: body.sendInvite ? new Date().toISOString() : null }),
    });

    let invitation: { sent: boolean; reason?: string } = { sent: false };
    if (body.sendInvite) {
      const { error } = await adminClient().auth.admin.inviteUserByEmail(email, {
        data: { name, family_member_id: rows[0]?.id },
        redirectTo: body.redirectTo,
      });
      invitation = error ? { sent: false, reason: error.message } : { sent: true };
    }
    return Response.json({ saved: true, id: rows[0]?.id, invitation }, { status: 201 });
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    await requireAdmin(request);
    const body = await request.json() as { id?: string; role?: string; isActive?: boolean };
    if (!body.id) return Response.json({ error: "Utilisateur manquant." }, { status: 400 });
    await supabaseRest(`family_members?id=eq.${encodeURIComponent(body.id)}`, {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ ...(body.role ? { role: body.role } : {}), ...(body.isActive !== undefined ? { is_active: body.isActive } : {}) }),
    });
    return Response.json({ updated: true });
  } catch (error) {
    return authErrorResponse(error);
  }
}
