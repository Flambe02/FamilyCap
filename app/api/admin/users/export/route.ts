import { authErrorResponse } from "../../../../../lib/auth-server";
import { requireConsoleAdmin } from "../../../../../lib/admin-console-auth";
import { supabaseRest } from "../../../../../lib/supabase-rest";

function csvCell(value: unknown) { return `"${String(value ?? "").replace(/"/g, '""')}"`; }

export async function GET(request: Request) {
  try {
    await requireConsoleAdmin(request);
    const rows = await supabaseRest<Array<{ name: string; email: string | null; role: string; access_status: string; is_active: boolean; created_at: string; last_sign_in_at: string | null }>>("family_members?select=name,email,role,access_status,is_active,created_at,last_sign_in_at&order=name.asc");
    const header = ["Nom", "Email", "Role", "Statut", "Actif", "Créé le", "Dernière connexion"];
    const body = rows.map((row) => [row.name, row.email, row.role, row.access_status, row.is_active ? "Oui" : "Non", row.created_at, row.last_sign_in_at].map(csvCell).join(";"));
    return new Response([header.map(csvCell).join(";"), ...body].join("\r\n"), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="labajo-famille-acces.csv"', "cache-control": "no-store" } });
  } catch (error) { return authErrorResponse(error); }
}
