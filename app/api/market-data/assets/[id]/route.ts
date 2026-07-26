import { authErrorResponse, requireAdmin } from "../../../../../lib/auth-server";
import { supabaseRest } from "../../../../../lib/supabase-rest";

const TYPES = new Set(["stock", "etf", "fund", "bond", "reit", "gold", "crypto", "cash", "other"]);
const QUOTE_MODES = new Set(["eod", "delayed", "realtime", "manual"]);

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin(request);
    const { id } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    const assetType = String(body.assetType ?? "other").toLowerCase();
    if (!TYPES.has(assetType)) return Response.json({ error: "Type d'actif invalide." }, { status: 400 });
    const currency = String(body.currency ?? "EUR").trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) return Response.json({ error: "Devise ISO invalide." }, { status: 400 });
    const providerSymbol = String(body.providerSymbol ?? "").trim().toUpperCase() || null;
    const dataProvider = providerSymbol ? "eodhd" : "manual";
    await supabaseRest(`holdings?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH", headers: { prefer: "return=minimal" },
      body: JSON.stringify({ asset_type: assetType, symbol: String(body.ticker ?? "").trim().toUpperCase() || null, isin: String(body.isin ?? "").trim().toUpperCase() || null, provider_symbol: providerSymbol, exchange: String(body.exchange ?? "").trim() || null, mic_code: String(body.micCode ?? "").trim().toUpperCase() || null, currency, country: String(body.country ?? "").trim() || null, data_provider: dataProvider, quote_mode: QUOTE_MODES.has(String(body.quoteMode ?? "")) ? body.quoteMode : providerSymbol ? "eod" : "manual", updated_at: new Date().toISOString() }),
    });
    return Response.json({ updated: true });
  } catch (error) { return authErrorResponse(error); }
}
