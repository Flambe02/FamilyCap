import { createClient } from "@supabase/supabase-js";
import { authErrorResponse, requireAdmin } from "../../../../lib/auth-server";
import { supabaseRest } from "../../../../lib/supabase-rest";

type RuntimeEnv = { SUPABASE_URL?: string; SUPABASE_SECRET_KEY?: string };
function adminClient() {
  const runtime: RuntimeEnv = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY };
  if (!runtime.SUPABASE_URL || !runtime.SUPABASE_SECRET_KEY) throw new Error("Supabase Admin non configuré");
  return createClient(runtime.SUPABASE_URL, runtime.SUPABASE_SECRET_KEY, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}

export async function GET(request: Request) {
  try {
    await requireAdmin(request);
    const [users, authResult] = await Promise.all([
      supabaseRest<Array<Record<string, unknown> & { email?: string; auth_user_id?: string }>>("family_members?select=*&order=name.asc"),
      adminClient().auth.admin.listUsers({ page: 1, perPage: 1000 }),
    ]);
    if (authResult.error) throw authResult.error;
    const authById = new Map(authResult.data.users.map((user) => [user.id, user]));
    return Response.json({
      users: users.map((member) => {
        const authUser = member.auth_user_id ? authById.get(String(member.auth_user_id)) : undefined;
        return {
          ...member,
          auth: authUser ? {
            emailConfirmedAt: authUser.email_confirmed_at,
            lastSignInAt: authUser.last_sign_in_at,
            createdAt: authUser.created_at,
            providers: authUser.app_metadata?.providers ?? [],
          } : null,
        };
      }),
    });
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
    const body = await request.json() as { id?: string; name?: string; email?: string; role?: string; isActive?: boolean; birthdayDay?: number | null; birthdayMonth?: number | null };
    if (!body.id) return Response.json({ error: "Utilisateur manquant." }, { status: 400 });
    const changes: Record<string, unknown> = {};
    if (body.name !== undefined) changes.name = body.name.trim();
    if (body.email !== undefined) changes.email = body.email.trim().toLowerCase() || null;
    if (body.role && ["adult", "child", "viewer"].includes(body.role)) changes.role = body.role;
    if (body.birthdayDay !== undefined) changes.birthday_day = body.birthdayDay;
    if (body.birthdayMonth !== undefined) changes.birthday_month = body.birthdayMonth;
    if (body.isActive !== undefined) changes.is_active = body.isActive;
    await supabaseRest(`family_members?id=eq.${encodeURIComponent(body.id)}`, {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify(changes),
    });
    return Response.json({ updated: true });
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    await requireAdmin(request);
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return Response.json({ error: "Utilisateur manquant." }, { status: 400 });
    const rows = await supabaseRest<Array<{ email: string | null; auth_user_id: string | null }>>(
      `family_members?select=email,auth_user_id&id=eq.${encodeURIComponent(id)}&limit=1`,
    );
    const member = rows[0];
    if (!member) return Response.json({ error: "Membre introuvable." }, { status: 404 });
    if (member.email?.toLowerCase() === "florent.lambert@gmail.com") {
      return Response.json({ error: "Le compte administrateur principal ne peut pas être supprimé." }, { status: 403 });
    }
    if (member.auth_user_id) {
      const { error } = await adminClient().auth.admin.deleteUser(member.auth_user_id);
      if (error) throw error;
    }
    await supabaseRest(`family_members?id=eq.${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { prefer: "return=minimal" },
    });
    return Response.json({ deleted: true });
  } catch (error) {
    return authErrorResponse(error);
  }
}