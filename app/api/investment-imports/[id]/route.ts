import { authErrorResponse, requireAdmin } from "../../../../lib/auth-server";
import { supabaseRest } from "../../../../lib/supabase-rest";

// ANNULATION d'un lot d'import. Admin uniquement. Supprime UNIQUEMENT les opérations rattachées
// à ce lot (import_batch_id) — jamais les opérations saisies manuellement — puis marque le lot
// 'cancelled' (sa ligne d'audit est conservée). Le moteur (computeAccountModel) recalcule ensuite
// les positions à partir des opérations restantes : aucune quantité n'est stockée.

export const runtime = "nodejs";

type BatchRow = { id: string; status: string; account_id: string; imported_rows: number };

function setupResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Erreur Supabase";
  if (message.includes("investment_import_batches") || message.includes("import_batch_id") || message.includes("PGRST205")) {
    return Response.json({ error: "La migration d'import (20260726_investment_imports.sql) doit être appliquée dans Supabase.", setupRequired: true }, { status: 503 });
  }
  return authErrorResponse(error);
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin(request);
    const { id } = await context.params;
    const batchId = String(id ?? "").trim();
    if (!batchId) return Response.json({ error: "Lot d'import manquant." }, { status: 400 });

    const batches = await supabaseRest<BatchRow[]>(
      `investment_import_batches?select=id,status,account_id,imported_rows&id=eq.${encodeURIComponent(batchId)}&limit=1`,
    );
    const batch = batches[0];
    if (!batch) return Response.json({ error: "Lot d'import introuvable." }, { status: 404 });
    if (batch.status === "cancelled") return Response.json({ error: "Ce lot est déjà annulé." }, { status: 409 });

    // Supprime STRICTEMENT les opérations de ce lot (les opérations manuelles ont import_batch_id null).
    await supabaseRest(`account_operations?import_batch_id=eq.${encodeURIComponent(batchId)}`, {
      method: "DELETE",
      headers: { prefer: "return=minimal" },
    });

    await supabaseRest(`investment_import_batches?id=eq.${encodeURIComponent(batchId)}`, {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ status: "cancelled", cancelled_at: new Date().toISOString() }),
    });

    return Response.json({ cancelled: true, removed: batch.imported_rows ?? 0 });
  } catch (error) {
    return setupResponse(error);
  }
}

// Détail d'un lot (facultatif : suivi côté admin). Lecture admin uniquement.
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin(request);
    const { id } = await context.params;
    const batches = await supabaseRest<Record<string, unknown>[]>(
      `investment_import_batches?select=*&id=eq.${encodeURIComponent(String(id ?? "").trim())}&limit=1`,
    );
    if (!batches[0]) return Response.json({ error: "Lot d'import introuvable." }, { status: 404 });
    return Response.json({ batch: batches[0] });
  } catch (error) {
    return setupResponse(error);
  }
}
