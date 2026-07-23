import { authErrorResponse, requireAdmin } from "../../../../lib/auth-server";
import { supabaseRest } from "../../../../lib/supabase-rest";
import { buildOperationRecord, type OperationInput } from "../../../../lib/account-operation";
import { instrumentKeyOf } from "../../../../lib/investment-import";
import { loadImportAccount, loadImportContext, isOperationAccount } from "../../../../lib/investment-import-server";

// Écriture des opérations de compte (PEA / compte-titres). Route GÉNÉRIQUE malgré son nom
// historique `/api/pea/operations` : elle sert le PEA ET le compte-titres. Admin uniquement
// (requireAdmin) ; le member_id est FORCÉ sur celui du compte porteur, jamais fourni par le
// client. La validation d'opération passe par la SOURCE DE VÉRITÉ partagée
// (lib/account-operation.ts::buildOperationRecord), identique à l'import. Le portefeuille reste
// dérivé des opérations : aucune route ne modifie directement une quantité « totale ».
//
// Gardes serveur ajoutées : compte introuvable / de type incompatible / archivé, et — pour un
// PEA — refus d'une vente supérieure à la quantité détenue (dérivée des opérations existantes).

export const runtime = "nodejs";

function setupResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Erreur Supabase";
  if (message.includes("exchange_rate") || message.includes("taxes") || message.includes("PGRST204") || message.includes("_type_check") || message.includes("check constraint")) {
    return Response.json({ error: "La migration compte-titres (20260725_investment_multicurrency.sql) doit être appliquée dans Supabase (devise, transferts, taxes).", setupRequired: true }, { status: 503 });
  }
  if (message.includes("account_operations") || message.includes("PGRST205")) {
    return Response.json({ error: "La migration des opérations (20260722_account_operations.sql) doit être appliquée dans Supabase.", setupRequired: true }, { status: 503 });
  }
  return authErrorResponse(error);
}

export async function POST(request: Request) {
  try {
    await requireAdmin(request);
    const body = (await request.json()) as OperationInput & { accountId?: string };
    if (!body.accountId) return Response.json({ error: "Le compte est obligatoire." }, { status: 400 });

    // Identité + éligibilité du compte (jamais fournies par le client).
    const account = await loadImportAccount(body.accountId);
    if (!account) return Response.json({ error: "Compte introuvable." }, { status: 404 });
    if (!isOperationAccount(account.accountType)) return Response.json({ error: "Ce type de compte n'accepte pas d'opérations (PEA ou compte-titres uniquement)." }, { status: 400 });
    if (!account.isActive) return Response.json({ error: "Ce compte est archivé : réactivez-le avant d'enregistrer une opération." }, { status: 409 });

    const type = (body.type ?? "").trim();

    // Garde PEA : une vente / sortie de titres ne peut excéder la quantité détenue.
    if (account.accountType === "pea" && (type === "vente" || type === "transfer_out")) {
      const context = await loadImportContext(account);
      const key = instrumentKeyOf({ isin: body.isin ?? null, ticker: body.ticker ?? null, instrumentName: body.assetName ?? null });
      const held = context.openingQuantities[key] ?? 0;
      const wanted = Number(body.quantity ?? 0);
      if (wanted > held + 1e-9) {
        return Response.json({ error: `Vente impossible : ${wanted} demandé(s) pour ${held} détenu(s) sur ce PEA.` }, { status: 422 });
      }
    }

    const built = buildOperationRecord(body, { memberId: account.memberId, source: body.source?.trim() || "saisie manuelle" });
    if (!built.ok) return Response.json({ error: built.error }, { status: 400 });

    const rows = await supabaseRest<Array<{ id: string }>>("account_operations", {
      method: "POST",
      headers: { prefer: "return=representation" },
      body: JSON.stringify({ ...built.record, account_id: body.accountId }),
    });
    return Response.json({ saved: true, id: rows[0]?.id }, { status: 201 });
  } catch (error) {
    return setupResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    await requireAdmin(request);
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return Response.json({ error: "Opération manquante." }, { status: 400 });
    await supabaseRest(`account_operations?id=eq.${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { prefer: "return=minimal" },
    });
    return Response.json({ deleted: true });
  } catch (error) {
    return setupResponse(error);
  }
}
