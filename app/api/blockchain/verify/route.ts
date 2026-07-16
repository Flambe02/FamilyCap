import { authErrorResponse, requireAdmin } from "../../../../lib/auth-server";
import { isSupabaseConfigured } from "../../../../lib/supabase-rest";
const ESPLORA_API = "https://blockstream.info/api";

type EsploraTransaction = {
  txid: string;
  status: { confirmed: boolean; block_height?: number };
  vout: Array<{ scriptpubkey_address?: string; value: number }>;
};

export async function POST(request: Request) {
  if (isSupabaseConfigured()) {
    try { await requireAdmin(request); } catch (error) { return authErrorResponse(error); }
  }
  try {
    const payload = await request.json() as { address?: string; txid?: string; expectedBtc?: number };
    const address = payload.address?.trim() ?? "";
    const txid = payload.txid?.trim() ?? "";
    const expectedBtc = Number(payload.expectedBtc ?? 0);

    if (!isBitcoinAddress(address)) return Response.json({ error: "Adresse Bitcoin publique invalide." }, { status: 400 });
    if (!/^[a-fA-F0-9]{64}$/.test(txid)) return Response.json({ error: "Le TxID doit contenir 64 caractères hexadécimaux." }, { status: 400 });
    if (!Number.isFinite(expectedBtc) || expectedBtc <= 0) return Response.json({ error: "Le montant BTC attendu est invalide." }, { status: 400 });

    const [transactionResponse, tipResponse] = await Promise.all([
      fetch(`${ESPLORA_API}/tx/${encodeURIComponent(txid)}`, { headers: { accept: "application/json" } }),
      fetch(`${ESPLORA_API}/blocks/tip/height`, { headers: { accept: "text/plain" } }),
    ]);

    if (transactionResponse.status === 404) return Response.json({ error: "Transaction introuvable sur Bitcoin." }, { status: 404 });
    if (!transactionResponse.ok || !tipResponse.ok) return Response.json({ error: "Le service de vérification Bitcoin est temporairement indisponible." }, { status: 502 });

    const transaction = await transactionResponse.json() as EsploraTransaction;
    const tipHeight = Number(await tipResponse.text());
    const receivedSats = transaction.vout.filter((output) => output.scriptpubkey_address === address).reduce((sum, output) => sum + output.value, 0);
    const expectedSats = Math.round(expectedBtc * 100_000_000);
    const confirmations = transaction.status.confirmed && transaction.status.block_height ? Math.max(0, tipHeight - transaction.status.block_height + 1) : 0;
    const amountMatches = receivedSats === expectedSats;

    return Response.json({
      verified: transaction.status.confirmed && amountMatches,
      confirmed: transaction.status.confirmed,
      confirmations,
      amountMatches,
      expectedBtc,
      receivedBtc: receivedSats / 100_000_000,
      txid: transaction.txid,
      explorerUrl: `https://blockstream.info/tx/${transaction.txid}`,
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Vérification impossible." }, { status: 500 });
  }
}

function isBitcoinAddress(address: string) {
  return /^(bc1[a-zA-HJ-NP-Z0-9]{25,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,61})$/.test(address);
}
