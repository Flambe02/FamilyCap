import { authErrorResponse, requireAdmin } from "../../../../lib/auth-server";
import { supabaseRest } from "../../../../lib/supabase-rest";

type HoldingInput = {
  id?: string;
  accountId?: string;
  assetType?: string;
  symbol?: string;
  isin?: string;
  name?: string;
  quantity?: number;
  averageCost?: number;
  currency?: string;
  exchange?: string;
  lastPrice?: number;
  notes?: string;
};

const assetTypes = new Set(["stock", "etf", "fund", "bond", "crypto", "cash", "other"]);

export async function POST(request: Request) {
  try {
    await requireAdmin(request);
    const body = await request.json() as HoldingInput;
    if (!body.accountId || !body.name?.trim()) return Response.json({ error: "Le compte et le nom de l'actif sont obligatoires." }, { status: 400 });
    const rows = await supabaseRest<Array<{ id: string }>>("holdings", {
      method: "POST",
      headers: { prefer: "return=representation" },
      body: JSON.stringify({
        account_id: body.accountId,
        asset_type: assetTypes.has(body.assetType ?? "") ? body.assetType : "other",
        symbol: body.symbol?.trim().toUpperCase() || null,
        isin: body.isin?.trim().toUpperCase() || null,
        name: body.name.trim(),
        quantity: Number.isFinite(Number(body.quantity)) ? Number(body.quantity) : 0,
        average_cost: Number.isFinite(Number(body.averageCost)) ? Number(body.averageCost) : null,
        currency: (body.currency || "EUR").toUpperCase(),
        exchange: body.exchange?.trim() || null,
        market_provider: body.symbol ? "Alpha Vantage" : "manual",
        last_price: Number.isFinite(Number(body.lastPrice)) ? Number(body.lastPrice) : null,
        last_price_at: Number.isFinite(Number(body.lastPrice)) ? new Date().toISOString() : null,
        notes: body.notes?.trim() || null,
      }),
    });
    return Response.json({ saved: true, id: rows[0]?.id }, { status: 201 });
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    await requireAdmin(request);
    const body = await request.json() as HoldingInput;
    if (!body.id) return Response.json({ error: "Position manquante." }, { status: 400 });
    const changes: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.quantity !== undefined) changes.quantity = Number(body.quantity);
    if (body.averageCost !== undefined) changes.average_cost = Number(body.averageCost);
    if (body.lastPrice !== undefined) {
      changes.last_price = Number(body.lastPrice);
      changes.last_price_at = new Date().toISOString();
    }
    if (body.notes !== undefined) changes.notes = body.notes.trim() || null;
    await supabaseRest(`holdings?id=eq.${encodeURIComponent(body.id)}`, {
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
    if (!id) return Response.json({ error: "Position manquante." }, { status: 400 });
    await supabaseRest(`holdings?id=eq.${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { prefer: "return=minimal" },
    });
    return Response.json({ deleted: true });
  } catch (error) {
    return authErrorResponse(error);
  }
}
