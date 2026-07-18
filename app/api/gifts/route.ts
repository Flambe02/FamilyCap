import { isSupabaseConfigured, supabaseRest } from "../../../lib/supabase-rest";
import { authErrorResponse, requireAdmin, requireFamilyMember } from "../../../lib/auth-server";

type GiftInput = {
  id?: string;
  action?: "unlinkLedger";
  member?: string;
  occasion?: string;
  giftDate?: string;
  purchaseDate?: string;
  amountEur?: number;
  btcAmount?: number;
  custody?: string;
  transferDate?: string | null;
  ledgerAmount?: number | null;
  forceLedgerAmount?: boolean;
  forceReason?: string | null;
  publicAddress?: string | null;
  txid?: string | null;
  blockchainStatus?: string;
  confirmations?: number;
  note?: string | null;
};

type StoredGift = {
  id: string;
  member_name: string;
  custody: string;
  txid: string | null;
  blockchain_status: string;
  confirmations: number;
  is_deleted?: boolean;
};


function validate(body: GiftInput) {
  if (!body.member || !body.occasion || !body.giftDate || !body.purchaseDate || !body.custody) return "Informations obligatoires manquantes.";
  if (!Number.isFinite(body.amountEur) || !Number.isFinite(body.btcAmount) || Number(body.btcAmount) <= 0) return "Montants invalides.";
  if (!["Anniversaire", "Noël", "Autre cadeau"].includes(body.occasion)) return "Occasion invalide.";
  if (!["Binance commun", "Ledger"].includes(body.custody)) return "Lieu de conservation invalide.";
  if (body.forceLedgerAmount === true && body.custody !== "Ledger") return "La correction forc\u00e9e exige un Ledger.";
  if (body.forceLedgerAmount === true && !body.forceReason?.trim()) return "Une explication est obligatoire pour forcer la valeur BTC achetée.";
  if (body.forceLedgerAmount === true && (!body.ledgerAmount || Number(body.btcAmount) <= Number(body.ledgerAmount))) return "La correction forcée doit concerner une valeur achetée supérieure au montant reçu sur le Ledger.";
  return null;
}

async function memberIdFor(name: string) {
  const rows = await supabaseRest<Array<{ id: string }>>(
    "family_members?select=id&name=eq." + encodeURIComponent(name) + "&limit=1",
  );
  return rows[0]?.id ?? null;
}

function payload(body: GiftInput, memberId: string | null) {
  return {
    member_id: memberId,
    member_name: body.member,
    occasion: body.occasion,
    gift_date: body.giftDate,
    purchase_date: body.purchaseDate,
    amount_eur: body.amountEur,
    btc_amount: body.btcAmount,
    custody: body.custody,
    transfer_date: body.transferDate || null,
    ledger_amount: body.ledgerAmount ?? null,
    ledger_value_forced: body.forceLedgerAmount === true,
    ledger_force_reason: body.forceLedgerAmount === true ? body.forceReason?.trim() || null : null,
    public_address: body.publicAddress || null,
    txid: body.txid || null,
    blockchain_status: body.blockchainStatus || (body.custody === "Ledger" ? "À vérifier" : "Stocké sur Binance commun"),
    confirmations: body.confirmations ?? 0,
    note: body.note || null,
    is_deleted: false,
  };
}

function hasMissingLedgerAuditColumn(error: unknown) {
  return error instanceof Error && error.message.includes("PGRST204") && /ledger_(force_reason|value_forced)/i.test(error.message);
}

function hasMissingSoftDeleteColumn(error: unknown) {
  return error instanceof Error && error.message.includes("PGRST204") && /is_deleted/i.test(error.message);
}

function withoutUnavailableLedgerAuditColumns(record: Record<string, unknown>, forceReason?: string | null) {
  const fallback = { ...record };
  delete fallback.ledger_force_reason;
  delete fallback.ledger_value_forced;
  if (forceReason?.trim()) {
    const auditNote = `Écart Ledger documenté : ${forceReason.trim()}`;
    fallback.note = [typeof fallback.note === "string" ? fallback.note.trim() : "", auditNote].filter(Boolean).join(" — ");
  }
  return fallback;
}

async function writeGiftRecord<T>(path: string, init: RequestInit, record: Record<string, unknown>, forceReason?: string | null) {
  try {
    return await supabaseRest<T>(path, { ...init, body: JSON.stringify(record) });
  } catch (caught) {
    if (!hasMissingLedgerAuditColumn(caught)) throw caught;
    return supabaseRest<T>(path, { ...init, body: JSON.stringify(withoutUnavailableLedgerAuditColumns(record, forceReason)) });
  }
}
async function validateLedgerAllocation(body: GiftInput, excludingId?: string) {
  if (body.custody !== "Ledger" || !body.txid) return null;
  if (!body.publicAddress) return "L'adresse publique Ledger est obligatoire.";
  const allocationBtc = Number(body.ledgerAmount ?? body.btcAmount ?? 0);
  if (!Number.isFinite(allocationBtc) || allocationBtc <= 0) return "La part BTC attribuée au cadeau est invalide.";
  const existing = await supabaseRest<Array<{ id: string; ledger_amount: number | string | null; btc_amount: number | string }>>(
    "gift_records?select=id,ledger_amount,btc_amount&txid=eq." + encodeURIComponent(body.txid),
  );
  const alreadyAllocatedBtc = existing.filter((gift) => gift.id !== excludingId).reduce((sum, gift) => sum + Number(gift.ledger_amount ?? gift.btc_amount ?? 0), 0);
  const transactionResponse = await fetch("https://blockstream.info/api/tx/" + encodeURIComponent(body.txid), { headers: { accept: "application/json" } });
  if (!transactionResponse.ok) return "Cette transaction Bitcoin est introuvable.";
  const transaction = await transactionResponse.json() as { vout: Array<{ scriptpubkey_address?: string; value: number }> };
  const receivedBtc = transaction.vout.filter((output) => output.scriptpubkey_address === body.publicAddress).reduce((sum, output) => sum + output.value, 0) / 100_000_000;
  if (alreadyAllocatedBtc + allocationBtc > receivedBtc + 0.00000001) {
    return `Allocation impossible : ${(alreadyAllocatedBtc + allocationBtc).toFixed(8)} BTC seraient associés, mais le virement n'a reçu que ${receivedBtc.toFixed(8)} BTC sur ce Ledger.`;
  }
  return null;
}
export async function GET(request: Request) {
  if (!isSupabaseConfigured()) return Response.json({ records: [], persistence: "unavailable" });
  try {
    const viewer = await requireFamilyMember(request);
    const filter = viewer.role === "admin" ? "" : "&member_id=eq." + encodeURIComponent(viewer.id);
    const records = await supabaseRest<Record<string, unknown>[]>(
      "gift_records?select=*&order=gift_date.desc,created_at.desc" + filter,
    );
    const visibleRecords = viewer.role === "admin" ? records : records.map((record) => { const gift = { ...record }; for (const privateField of ["public_address", "txid", "blockchain_status", "confirmations", "transfer_date"]) delete gift[privateField]; return gift; });
    return Response.json({ records: visibleRecords, persistence: "supabase" });
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function POST(request: Request) {
  if (!isSupabaseConfigured()) return Response.json({ error: "Supabase est requis sur Vercel." }, { status: 503 });
  try {
    await requireAdmin(request);
    const body = await request.json() as GiftInput;
    const error = validate(body);
    if (error) return Response.json({ error }, { status: 400 });
    const allocationError = await validateLedgerAllocation(body);
    if (allocationError) return Response.json({ error: allocationError }, { status: 400 });
    const memberId = await memberIdFor(body.member!);
    const records = await writeGiftRecord<Array<{ id: string }>>("gift_records", {
      method: "POST",
      headers: { prefer: "return=representation" },
    }, payload(body, memberId), body.forceLedgerAmount ? body.forceReason : null);
    return Response.json({ saved: true, id: records[0]?.id, persistence: "supabase" }, { status: 201 });
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  if (!isSupabaseConfigured()) return Response.json({ error: "Supabase est requis sur Vercel." }, { status: 503 });
  try {
    await requireAdmin(request);
    const body = await request.json() as GiftInput;
    if (!body.id) return Response.json({ error: "Cadeau manquant." }, { status: 400 });
    const current = await supabaseRest<StoredGift[]>(
      "gift_records?select=id,member_name,custody,txid,blockchain_status,confirmations&id=eq." + encodeURIComponent(body.id) + "&limit=1",
    );
    if (!current[0]) return Response.json({ error: "Cadeau introuvable." }, { status: 404 });
    if (body.action === "unlinkLedger") {
      if (current[0].custody !== "Ledger" || !current[0].txid) {
        return Response.json({ error: "Ce cadeau n’est associé à aucun virement Ledger." }, { status: 400 });
      }
      await supabaseRest("gift_records?id=eq." + encodeURIComponent(body.id), {
        method: "PATCH",
        headers: { prefer: "return=minimal" },
        body: JSON.stringify({
          custody: "À rapprocher",
          transfer_date: null,
          ledger_amount: null,
          public_address: null,
          txid: null,
          blockchain_status: "À rapprocher manuellement",
          confirmations: 0,
        }),
      });
      return Response.json({ unlinked: true });
    }
    if (current[0].custody === "Ledger") return Response.json({ error: "Un cadeau sur Ledger ne peut pas être modifié depuis le tableau. Utilisez d’abord l’action de désassociation dédiée si nécessaire." }, { status: 409 });
    const error = validate(body);
    if (error) return Response.json({ error }, { status: 400 });
    const allocationError = await validateLedgerAllocation(body, body.id);
    if (allocationError) return Response.json({ error: allocationError }, { status: 400 });
    const memberId = await memberIdFor(body.member!);
    await writeGiftRecord("gift_records?id=eq." + encodeURIComponent(body.id), {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
    }, payload(body, memberId), body.forceLedgerAmount ? body.forceReason : null);
    return Response.json({ updated: true });
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  if (!isSupabaseConfigured()) return Response.json({ error: "Supabase est requis sur Vercel." }, { status: 503 });
  try {
    await requireAdmin(request);
    const searchParams = new URL(request.url).searchParams;
    const id = searchParams.get("id");
    const member = searchParams.get("member")?.trim() ?? "";
    const occasion = searchParams.get("occasion")?.trim() ?? "";
    const giftDate = searchParams.get("giftDate")?.trim() ?? "";
    if (!id && (!member || !occasion || !/^\d{4}-\d{2}-\d{2}$/.test(giftDate))) {
      return Response.json({ error: "Cadeau manquant." }, { status: 400 });
    }
    if (!id && !["Anniversaire", "Noël", "Autre cadeau"].includes(occasion)) {
      return Response.json({ error: "Occasion invalide." }, { status: 400 });
    }
    const current = await supabaseRest<StoredGift[]>(id
      ? "gift_records?select=id,member_name,custody,txid,blockchain_status,confirmations&id=eq." + encodeURIComponent(id) + "&limit=1"
      : "gift_records?select=id,member_name,custody,txid,blockchain_status,confirmations&member_name=eq." + encodeURIComponent(member) + "&occasion=eq." + encodeURIComponent(occasion) + "&gift_date=eq." + encodeURIComponent(giftDate) + "&order=created_at.desc");
    if (id && !current[0]) return Response.json({ error: "Cadeau introuvable." }, { status: 404 });
    if (current.some((gift) => gift.custody === "Ledger")) {
      return Response.json({ error: "Un cadeau sur Ledger ne peut pas être supprimé." }, { status: 409 });
    }
    const target = current[0];
    try {
      if (target) {
        await supabaseRest("gift_records?id=eq." + encodeURIComponent(target.id), { method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify({ is_deleted: true }) });
      } else {
        const amountEur = Number(searchParams.get("amountEur"));
        const btcAmount = Number(searchParams.get("btcAmount"));
        if (!Number.isFinite(amountEur) || amountEur < 0 || !Number.isFinite(btcAmount) || btcAmount <= 0) {
          return Response.json({ error: "Les montants de la ligne historique sont invalides." }, { status: 400 });
        }
        const memberId = await memberIdFor(member);
        await supabaseRest("gift_records", {
          method: "POST",
          headers: { prefer: "return=minimal" },
          body: JSON.stringify({
            member_id: memberId,
            member_name: member,
            occasion,
            gift_date: giftDate,
            purchase_date: giftDate,
            amount_eur: amountEur,
            btc_amount: btcAmount,
            custody: "Binance commun",
            transfer_date: null,
            ledger_amount: null,
            public_address: null,
            txid: null,
            blockchain_status: "Supprimé du suivi",
            confirmations: 0,
            note: "Ligne historique masquée depuis le registre Transactions.",
            is_deleted: true,
          }),
        });
      }
    } catch (error) {
      if (hasMissingSoftDeleteColumn(error)) {
        return Response.json({ error: "La suppression sécurisée nécessite la migration Supabase 20260717_soft_delete_gift_records.sql. Exécutez-la dans le SQL Editor, puis réessayez." }, { status: 409 });
      }
      throw error;
    }
    return Response.json({ deleted: true, tombstoneCreated: !target });
  } catch (error) {
    return authErrorResponse(error);
  }
}