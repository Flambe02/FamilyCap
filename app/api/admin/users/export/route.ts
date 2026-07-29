import { createClient } from "@supabase/supabase-js";
import { authErrorResponse } from "../../../../../lib/auth-server";
import { requireConsoleSuperAdmin } from "../../../../../lib/admin-console-auth";
import { supabaseRest } from "../../../../../lib/supabase-rest";

function csvCell(value: unknown) { return `"${String(value ?? "").replace(/"/g, '""')}"`; }

function adminClient() {
  const url = process.env.SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secret) throw new Error("Supabase Admin non configure");
  return createClient(url, secret, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } });
}

export async function GET(request: Request) {
  try {
    await requireConsoleSuperAdmin(request);
    const [rows, authResult] = await Promise.all([
      supabaseRest<Array<{ name: string; email: string | null; role: string; access_status: string; is_active: boolean; created_at: string; auth_user_id: string | null }>>("family_members?select=name,email,role,access_status,is_active,created_at,auth_user_id&order=name.asc"),
      adminClient().auth.admin.listUsers({ page: 1, perPage: 1000 }),
    ]);
    if (authResult.error) throw authResult.error;
    const lastSignInByAuthId = new Map(authResult.data.users.map((user) => [user.id, user.last_sign_in_at]));
    const header = ["Nom", "Email", "Role", "Statut", "Actif", "Créé le", "Dernière connexion"];
    const body = rows.map((row) => [row.name, row.email, row.role, row.access_status, row.is_active ? "Oui" : "Non", row.created_at, row.auth_user_id ? lastSignInByAuthId.get(row.auth_user_id) ?? null : null].map(csvCell).join(";"));
    return new Response([header.map(csvCell).join(";"), ...body].join("\r\n"), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="labajo-famille-acces.csv"', "cache-control": "no-store" } });
  } catch (error) { return authErrorResponse(error); }
}
