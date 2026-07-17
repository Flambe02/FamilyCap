import { authErrorResponse, requireAdmin } from "../../../lib/auth-server";
import { isSupabaseConfigured, supabaseRest } from "../../../lib/supabase-rest";

type TransferInput = {
  member?: string;
  txid?: string;
  publicAddress?: string;
  transferDate?: string;
  giftIds?: string[];
  forceReason?: string;
};

type StoredGift = Record<string, unknown> & {
  id: string;
  member_name: string;
  btc_amount: number | string;
  ledger_amount: number | string | null;
  custody: string;
  txid: string | null;
  is_deleted?: boolean;
};

type ChainTransaction = {
  vout: Array<{ scriptpubkey_address?: string; value: number }>;
  status: { confirmed: boolean; block_height?: number };
};

const SATOSHIS_PER_BTC = 100_000_000;

function toSats(value: number | string | null | undefined) {
  return Math.round(Number(value ?? 0) * SATOSHIS_PER_BTC);
}

function btcFromSats(value: number) {
  return Number((value / SATOSHIS_PER_BTC).toFixed(8));
}

function error(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

function hasMissingLedgerAuditColumn(error: unknown) {
  return error instanceof Error && error.message.includes("PGRST204") && /ledger_(force_reason|value_forced)/i.test(error.message);
}

function withoutUnavailableLedgerAuditColumns(records: Record<string, unknown>[], forceReason: string | null) {
  return records.map((record) => {
    const fallback = { ...record };
    delete fallback.ledger_force_reason;
    delete fallback.ledger_value_forced;
    if (forceReason) {
      const auditNote = `Écart Ledger documenté : ${forceReason}`;
      fallback.note = [typeof fallback.note === "string" ? fallback.note.trim() : "", auditNote].filter(Boolean).join(" — ");
    }
    return fallback;
  });
}
export async function POST(request: Request) {
  if (!isSupabaseConfigured()) return error("Supabase est requis pour enregistrer un transfert.", 503);

  try {
    await requireAdmin(request);
    const body = await request.json() as TransferInput;
    const member = body.member?.trim();
    const txid = body.txid?.trim();
    const publicAddress = body.publicAddress?.trim();
    const transferDate = body.transferDate?.trim();
    const giftIds = [...new Set(body.giftIds ?? [])];

    if (!member || !txid || !publicAddress || !transferDate || giftIds.length === 0) {
      return error("Virement, adresse, date et cadeaux \u00e0 transf\u00e9rer sont obligatoires.");
    }
    if (!/^[0-9a-f]{64}$/i.test(txid)) return error("Le TxID Bitcoin est invalide.");
    if (giftIds.some((id) => !/^[0-9a-f-]{36}$/i.test(id))) return error("Un identifiant de cadeau est invalide.");

    const idFilter = giftIds.join(",");
    const gifts = await supabaseRest<StoredGift[]>(
      `gift_records?select=*&id=in.(${idFilter})`,
    );
    if (gifts.length !== giftIds.length) return error("Un ou plusieurs cadeaux sont introuvables.", 404);
    if (gifts.some((gift) => gift.is_deleted)) return error("Un cadeau supprimé ne peut pas être transféré.", 409);
    if (gifts.some((gift) => gift.member_name !== member)) return error("Tous les cadeaux doivent appartenir au m\u00eame enfant.");
    if (gifts.some((gift) => gift.custody === "Ledger")) return error("Un cadeau d\u00e9j\u00e0 transf\u00e9r\u00e9 sur Ledger ne peut pas \u00eatre d\u00e9bit\u00e9 une seconde fois.", 409);

    const [transactionResponse, tipResponse] = await Promise.all([
      fetch(`https://blockstream.info/api/tx/${encodeURIComponent(txid)}`, { headers: { accept: "application/json" } }),
      fetch("https://blockstream.info/api/blocks/tip/height", { headers: { accept: "text/plain" } }),
    ]);
    if (!transactionResponse.ok) return error("Cette transaction Bitcoin est introuvable.");

    const transaction = await transactionResponse.json() as ChainTransaction;
    const receivedSats = transaction.vout
      .filter((output) => output.scriptpubkey_address === publicAddress)
      .reduce((sum, output) => sum + output.value, 0);
    if (receivedSats <= 0) return error("Cette transaction n'a rien re\u00e7u sur l'adresse Ledger s\u00e9lectionn\u00e9e.");

    const existing = await supabaseRest<Array<{ id: string; ledger_amount: number | string | null; btc_amount: number | string }>>(
      `gift_records?select=id,ledger_amount,btc_amount&txid=eq.${encodeURIComponent(txid)}`,
    );
    const selectedIds = new Set(giftIds);
    const alreadyAllocatedSats = existing
      .filter((gift) => !selectedIds.has(gift.id))
      .reduce((sum, gift) => sum + toSats(gift.ledger_amount ?? gift.btc_amount), 0);
    const availableSats = Math.max(0, receivedSats - alreadyAllocatedSats);
    if (availableSats <= 0) return error("Ce virement Ledger est d\u00e9j\u00e0 enti\u00e8rement attribu\u00e9.", 409);

    const purchasedSats = gifts.map((gift) => toSats(gift.btc_amount));
    const totalPurchasedSats = purchasedSats.reduce((sum, value) => sum + value, 0);
    const totalAllocatedSats = Math.min(totalPurchasedSats, availableSats);
    const shortfallSats = Math.max(0, totalPurchasedSats - totalAllocatedSats);
    if (shortfallSats > 0 && (body.forceReason?.trim().length ?? 0) < 5) {
      return error("Expliquez l'\u00e9cart entre le d\u00e9bit Binance et le montant re\u00e7u sur Ledger.");
    }

    let distributedSats = 0;
    const allocationSats = purchasedSats.map((giftSats, index) => {
      if (index === purchasedSats.length - 1) return totalAllocatedSats - distributedSats;
      const share = Math.floor(totalAllocatedSats * giftSats / totalPurchasedSats);
      distributedSats += share;
      return share;
    });
    if (allocationSats.some((value) => value <= 0)) return error("Le reliquat du virement est trop faible pour r\u00e9partir tous les cadeaux s\u00e9lectionn\u00e9s.");

    const tipHeight = tipResponse.ok ? Number(await tipResponse.text()) : 0;
    const confirmations = transaction.status.confirmed && transaction.status.block_height && tipHeight
      ? Math.max(1, tipHeight - transaction.status.block_height + 1)
      : 0;
    const forceReason = shortfallSats > 0 ? body.forceReason?.trim() || null : null;
    const updatedRecords = gifts.map((gift, index) => {
      const allocated = allocationSats[index];
      const purchased = purchasedSats[index];
      return {
        ...gift,
        custody: "Ledger",
        transfer_date: transferDate,
        ledger_amount: btcFromSats(allocated),
        ledger_value_forced: allocated < purchased,
        ledger_force_reason: allocated < purchased ? forceReason : null,
        public_address: publicAddress,
        txid,
        blockchain_status: confirmations > 0 ? "Valid\u00e9 sur la blockchain" : "En attente de confirmation",
        confirmations,
      };
    });

    try {
      await supabaseRest("gift_records?on_conflict=id", {
        method: "POST",
        headers: { prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(updatedRecords),
      });
    } catch (caught) {
      if (!hasMissingLedgerAuditColumn(caught)) throw caught;
      await supabaseRest("gift_records?on_conflict=id", {
        method: "POST",
        headers: { prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(withoutUnavailableLedgerAuditColumns(updatedRecords, forceReason)),
      });
    }

    return Response.json({
      saved: true,
      giftsUpdated: updatedRecords.length,
      receivedBtc: btcFromSats(receivedSats),
      alreadyAllocatedBtc: btcFromSats(alreadyAllocatedSats),
      allocatedBtc: btcFromSats(totalAllocatedSats),
      debitedFromBinanceBtc: btcFromSats(totalPurchasedSats),
      transferCostBtc: btcFromSats(shortfallSats),
      transactionRemainingBtc: btcFromSats(Math.max(0, availableSats - totalAllocatedSats)),
      confirmations,
    });
  } catch (caught) {
    return authErrorResponse(caught);
  }
}
