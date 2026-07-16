import { isSupabaseConfigured, supabaseRest } from "../../../lib/supabase-rest";
import { authErrorResponse, requireAdmin, requireFamilyMember } from "../../../lib/auth-server";

type GiftInput = {
  member?: string;
  occasion?: string;
  giftDate?: string;
  purchaseDate?: string;
  amountEur?: number;
  btcAmount?: number;
  custody?: string;
  transferDate?: string;
  ledgerAmount?: number;
  publicAddress?: string;
  txid?: string;
  blockchainStatus?: string;
  confirmations?: number;
  note?: string;
};

export async function GET(request: Request) {
  if (isSupabaseConfigured()) {
    try { await requireFamilyMember(request); } catch (error) { return authErrorResponse(error); }
  }
  if (isSupabaseConfigured()) {
    const records = await supabaseRest<Record<string, unknown>[]>("gift_records?select=*&order=purchase_date.desc,created_at.desc");
    return Response.json({ records, persistence: "supabase" });
  }
  return Response.json({ records: [], persistence: "unavailable" });
}

export async function POST(request: Request) {
  if (isSupabaseConfigured()) {
    try { await requireAdmin(request); } catch (error) { return authErrorResponse(error); }
  }
  const body = (await request.json()) as GiftInput;
  if (!body.member || !body.occasion || !body.giftDate || !body.purchaseDate || !body.custody) {
    return Response.json({ error: "Informations obligatoires manquantes." }, { status: 400 });
  }
  if (!Number.isFinite(body.amountEur) || !Number.isFinite(body.btcAmount) || Number(body.btcAmount) <= 0) {
    return Response.json({ error: "Montants invalides." }, { status: 400 });
  }
  if (isSupabaseConfigured()) {
    const records = await supabaseRest<Array<{ id: string }>>("gift_records", {
      method: "POST",
      headers: { prefer: "return=representation" },
      body: JSON.stringify({
        member_name: body.member,
        occasion: body.occasion,
        gift_date: body.giftDate,
        purchase_date: body.purchaseDate,
        amount_eur: body.amountEur,
        btc_amount: body.btcAmount,
        custody: body.custody,
        transfer_date: body.transferDate ?? null,
        ledger_amount: body.ledgerAmount ?? null,
        public_address: body.publicAddress ?? null,
        txid: body.txid ?? null,
        blockchain_status: body.blockchainStatus ?? "not_checked",
        confirmations: body.confirmations ?? 0,
        note: body.note ?? null,
      }),
    });
    return Response.json({ saved: true, id: records[0]?.id, persistence: "supabase" }, { status: 201 });
  }

  return Response.json({ saved: false, error: "Supabase est requis sur Vercel." }, { status: 503 });
}
