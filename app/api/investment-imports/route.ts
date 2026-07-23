import { authErrorResponse, requireAdmin } from "../../../lib/auth-server";
import { supabaseRest } from "../../../lib/supabase-rest";

// Liste des lots d'import d'un compte (suivi + annulation côté admin). Admin uniquement : les
// membres ne gèrent pas les imports (interface, route et validations serveur cohérentes).

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    await requireAdmin(request);
    const accountId = new URL(request.url).searchParams.get("accountId")?.trim();
    const filter = accountId ? `&account_id=eq.${encodeURIComponent(accountId)}` : "";
    try {
      const batches = await supabaseRest<Record<string, unknown>[]>(
        `investment_import_batches?select=id,account_id,original_filename,file_type,source_kind,status,total_rows,imported_rows,duplicate_rows,error_rows,created_at,completed_at,cancelled_at&order=created_at.desc${filter}`,
      );
      return Response.json({ batches });
    } catch (error) {
      // Migration 20260726 non jouée → liste vide (état dégradé propre, pas d'erreur).
      const message = error instanceof Error ? error.message : "";
      if (message.includes("investment_import_batches") || message.includes("PGRST205")) return Response.json({ batches: [] });
      throw error;
    }
  } catch (error) {
    return authErrorResponse(error);
  }
}
