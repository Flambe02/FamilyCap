import { authErrorResponse, requireAdmin } from "../../../../lib/auth-server";
import { supabaseRest } from "../../../../lib/supabase-rest";

// Écriture des opérations de compte (PEA / compte-titres). Admin uniquement (requireAdmin) ;
// le member_id est FORCÉ sur celui du compte porteur, jamais fourni librement par le client.
// Le portefeuille étant dérivé des opérations, il n'existe volontairement aucune route qui
// modifie directement une quantité « totale » de position.

type OperationInput = {
  id?: string;
  accountId?: string;
  type?: string;
  date?: string;
  assetName?: string;
  ticker?: string;
  isin?: string;
  quantity?: number;
  unitPrice?: number;
  grossAmount?: number;
  fees?: number;
  netAmount?: number;
  currency?: string;
  source?: string;
  note?: string;
};

const OPERATION_TYPES = new Set(["achat", "vente", "versement", "retrait", "dividende", "frais", "correction"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function setupResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Erreur Supabase";
  if (message.includes("account_operations") || message.includes("PGRST205")) {
    return Response.json({ error: "La migration des opérations (20260722_account_operations.sql) doit être appliquée dans Supabase.", setupRequired: true }, { status: 503 });
  }
  return authErrorResponse(error);
}

function toAmount(value: number | undefined): number | null {
  return value === undefined || value === null || !Number.isFinite(Number(value)) ? null : Math.round(Number(value) * 100) / 100;
}

export async function POST(request: Request) {
  try {
    await requireAdmin(request);
    const body = (await request.json()) as OperationInput;

    const type = (body.type ?? "").trim();
    if (!body.accountId) return Response.json({ error: "Le compte est obligatoire." }, { status: 400 });
    if (!OPERATION_TYPES.has(type)) return Response.json({ error: "Type d'opération invalide." }, { status: 400 });
    if (!body.date || !ISO_DATE.test(body.date)) return Response.json({ error: "La date (AAAA-MM-JJ) est obligatoire." }, { status: 400 });

    const quantity = body.quantity === undefined || body.quantity === null ? null : Number(body.quantity);
    const unitPrice = body.unitPrice === undefined || body.unitPrice === null ? null : Number(body.unitPrice);
    const fees = toAmount(body.fees) ?? 0;
    let gross = toAmount(body.grossAmount);
    let net = toAmount(body.netAmount);

    // Validations spécifiques par type + calcul du montant net (mouvement de trésorerie).
    if (type === "achat" || type === "vente") {
      if (!(Number(quantity) > 0) || !(Number(unitPrice) > 0)) {
        return Response.json({ error: "Un achat ou une vente exige une quantité et un prix unitaire positifs." }, { status: 400 });
      }
      if (gross === null) gross = Math.round(Number(quantity) * Number(unitPrice) * 100) / 100;
      if (net === null) net = type === "achat" ? gross + fees : Math.max(0, gross - fees);
    } else if (type === "versement" || type === "retrait" || type === "frais") {
      if (net === null) net = gross;
      if (net === null || !(Number(net) > 0)) {
        return Response.json({ error: "Un versement, un retrait ou des frais exigent un montant positif." }, { status: 400 });
      }
      if (gross === null) gross = net;
    } else if (type === "dividende") {
      if (net === null) net = gross;
      if (net === null || !(Number(net) > 0)) {
        return Response.json({ error: "Un dividende exige un montant net positif." }, { status: 400 });
      }
      if (gross === null) gross = net;
    } else if (type === "correction") {
      if (quantity === null && net === null) {
        return Response.json({ error: "Une correction exige une quantité ou un montant." }, { status: 400 });
      }
    }

    // Identité forcée : on relit le compte pour en tirer le member_id (jamais fourni par le client).
    const accounts = await supabaseRest<Array<{ member_id: string }>>(
      `financial_accounts?select=member_id&id=eq.${encodeURIComponent(body.accountId)}&limit=1`,
    );
    const memberId = accounts[0]?.member_id;
    if (!memberId) return Response.json({ error: "Compte introuvable." }, { status: 404 });

    const rows = await supabaseRest<Array<{ id: string }>>("account_operations", {
      method: "POST",
      headers: { prefer: "return=representation" },
      body: JSON.stringify({
        account_id: body.accountId,
        member_id: memberId,
        type,
        operation_date: body.date,
        asset_name: body.assetName?.trim() || null,
        ticker: body.ticker?.trim().toUpperCase() || null,
        isin: body.isin?.trim().toUpperCase() || null,
        quantity,
        unit_price: unitPrice,
        gross_amount: gross,
        fees,
        net_amount: net,
        currency: (body.currency || "EUR").toUpperCase(),
        source: body.source?.trim() || "saisie manuelle",
        note: body.note?.trim() || null,
      }),
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
