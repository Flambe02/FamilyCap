import { env } from "cloudflare:workers";
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

async function ensureTable(db: D1Database) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS gift_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER,
    member_name TEXT NOT NULL,
    occasion TEXT NOT NULL,
    gift_date TEXT NOT NULL,
    purchase_date TEXT NOT NULL,
    amount_eur REAL NOT NULL,
    btc_amount REAL NOT NULL,
    custody TEXT NOT NULL,
    transfer_date TEXT,
    ledger_amount REAL,
    public_address TEXT,
    txid TEXT,
    blockchain_status TEXT NOT NULL DEFAULT 'not_checked',
    confirmations INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run();
}

export async function GET(request: Request) {
  if (isSupabaseConfigured()) {
    try { await requireFamilyMember(request); } catch (error) { return authErrorResponse(error); }
  }
  if (isSupabaseConfigured()) {
    const records = await supabaseRest<Record<string, unknown>[]>("gift_records?select=*&order=purchase_date.desc,created_at.desc");
    return Response.json({ records, persistence: "supabase" });
  }
  if (!env.DB) return Response.json({ records: [] });
  await ensureTable(env.DB);
  const result = await env.DB.prepare("SELECT * FROM gift_records ORDER BY purchase_date DESC, id DESC").all();
  return Response.json({ records: result.results });
}

export async function POST(request: Request) {
  if (isSupabaseConfigured()) {
    try { await requireAdmin(request); } catch (error) { return authErrorResponse(error); }
  }
  const body = await request.json<GiftInput>();
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

  if (!env.DB) return Response.json({ saved: false, error: "Base de données indisponible." }, { status: 503 });

  await ensureTable(env.DB);
  const result = await env.DB.prepare(`INSERT INTO gift_records (
    member_name, occasion, gift_date, purchase_date, amount_eur, btc_amount, custody,
    transfer_date, ledger_amount, public_address, txid, blockchain_status, confirmations, note
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      body.member, body.occasion, body.giftDate, body.purchaseDate, body.amountEur, body.btcAmount,
      body.custody, body.transferDate ?? null, body.ledgerAmount ?? null, body.publicAddress ?? null,
      body.txid ?? null, body.blockchainStatus ?? "not_checked", body.confirmations ?? 0, body.note ?? null,
    ).run();

  return Response.json({ saved: true, id: result.meta.last_row_id }, { status: 201 });
}
