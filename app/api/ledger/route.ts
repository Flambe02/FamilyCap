import { authErrorResponse, requireAdmin } from "../../../lib/auth-server";
import { isSupabaseConfigured } from "../../../lib/supabase-rest";
const wallets = [
  { member: "Thibault", address: "bc1qcy4jt8fh5dhj9fq9d4lu2hq6klvvdmlkeqcgks" },
  { member: "Uhaina", address: "bc1qqkfmts27j07y8u7a6ap7wyczfhe5afyrkn7y2t" },
  { member: "Paul", address: "bc1qxx7ve23aggf0596zf45kx0ppk5qjggpak82wd5" },
  { member: "Aurore", address: "bc1qxs2uy67myzfx8z2vtzr6lm3cgrx808azqkt4pg" },
  { member: "Thomas", address: "bc1qfwuze87xnhxjfdmr3wnfy3wguu5ymedk4qcwjr" },
] as const;

type AddressSummary = {
  chain_stats: { funded_txo_sum: number; spent_txo_sum: number; tx_count: number };
  mempool_stats: { funded_txo_sum: number; spent_txo_sum: number; tx_count: number };
};

type ChainTransaction = {
  txid: string;
  vin: Array<{ prevout?: { scriptpubkey_address?: string; value: number } }>;
  vout: Array<{ scriptpubkey_address?: string; value: number }>;
  status: { confirmed: boolean; block_height?: number; block_time?: number };
};

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

async function getWalletTransactions(address: string) {
  const transactions: ChainTransaction[] = [];
  let path = `https://blockstream.info/api/address/${address}/txs`;

  for (let pageCount = 0; pageCount < 20; pageCount += 1) {
    const response = await fetch(path, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("Lecture des transactions impossible.");
    const page = await response.json() as ChainTransaction[];
    transactions.push(...page);
    if (page.length < 25 || !page[page.length - 1]?.txid) break;
    path = `https://blockstream.info/api/address/${address}/txs/chain/${page[page.length - 1].txid}`;
  }

  return transactions;
}

async function getWallet(member: string, address: string, tipHeight: number) {
  const [summaryResponse, transactions] = await Promise.all([
    fetch(`https://blockstream.info/api/address/${address}`, { headers: { accept: "application/json" } }),
    getWalletTransactions(address),
  ]);

  if (!summaryResponse.ok) throw new Error(`Lecture impossible pour ${member}`);
  const summary = await summaryResponse.json() as AddressSummary;
  const confirmedBalanceSats = summary.chain_stats.funded_txo_sum - summary.chain_stats.spent_txo_sum;
  const pendingBalanceSats = summary.mempool_stats.funded_txo_sum - summary.mempool_stats.spent_txo_sum;

  return {
    member,
    address,
    confirmedBalanceBtc: confirmedBalanceSats / 100_000_000,
    pendingBalanceBtc: pendingBalanceSats / 100_000_000,
    receivedBtc: summary.chain_stats.funded_txo_sum / 100_000_000,
    spentBtc: summary.chain_stats.spent_txo_sum / 100_000_000,
    transactionCount: summary.chain_stats.tx_count + summary.mempool_stats.tx_count,
    explorerUrl: `https://blockstream.info/address/${address}`,
    transactions: transactions.map((transaction) => {
      const receivedSats = sum(transaction.vout.filter((output) => output.scriptpubkey_address === address).map((output) => output.value));
      const spentSats = sum(transaction.vin.filter((input) => input.prevout?.scriptpubkey_address === address).map((input) => input.prevout?.value ?? 0));
      const netSats = receivedSats - spentSats;
      const confirmations = transaction.status.confirmed && transaction.status.block_height
        ? Math.max(1, tipHeight - transaction.status.block_height + 1)
        : 0;
      return {
        txid: transaction.txid,
        date: transaction.status.block_time ? new Date(transaction.status.block_time * 1000).toISOString() : null,
        amountBtc: Math.abs(netSats) / 100_000_000,
        receivedBtc: receivedSats / 100_000_000,
        sentBtc: spentSats / 100_000_000,
        direction: netSats >= 0 ? "Reçu" : "Envoyé",
        confirmed: transaction.status.confirmed,
        confirmations,
        explorerUrl: `https://blockstream.info/tx/${transaction.txid}`,
      };
    }),
  };
}

async function getBitcoinEurPrice() {
  try {
    const response = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=eur", { headers: { accept: "application/json" } });
    if (response.ok) {
      const result = await response.json() as { bitcoin?: { eur?: number } };
      if (result.bitcoin?.eur) return { value: result.bitcoin.eur, source: "CoinGecko" };
    }
  } catch {
    // Une seconde source publique est utilisée ci-dessous.
  }

  try {
    const response = await fetch("https://api.kraken.com/0/public/Ticker?pair=XBTEUR", { headers: { accept: "application/json" } });
    if (!response.ok) return { value: null, source: null };
    const result = await response.json() as { result?: { XXBTZEUR?: { c?: string[] } } };
    const price = Number(result.result?.XXBTZEUR?.c?.[0]);
    return Number.isFinite(price) ? { value: price, source: "Kraken" } : { value: null, source: null };
  } catch {
    return { value: null, source: null };
  }
}

export async function GET(request: Request) {
  if (isSupabaseConfigured()) {
    try { await requireAdmin(request); } catch (error) { return authErrorResponse(error); }
  }
  try {
    const [tipResponse, bitcoinPrice] = await Promise.all([
      fetch("https://blockstream.info/api/blocks/tip/height"),
      getBitcoinEurPrice(),
    ]);
    if (!tipResponse.ok) throw new Error("Hauteur de chaîne indisponible");
    const tipHeight = Number(await tipResponse.text());
    const results = await Promise.allSettled(wallets.map((wallet) => getWallet(wallet.member, wallet.address, tipHeight)));
    const ledgerWallets = results.map((result, index) => result.status === "fulfilled"
      ? result.value
      : { member: wallets[index].member, address: wallets[index].address, error: result.reason instanceof Error ? result.reason.message : "Lecture indisponible" });

    return Response.json(
      { wallets: ledgerWallets, bitcoinEur: bitcoinPrice.value, bitcoinEurSource: bitcoinPrice.source, updatedAt: new Date().toISOString(), source: "Blockstream" },
      { headers: { "cache-control": "public, max-age=30, s-maxage=60" } },
    );
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Blockchain indisponible" }, { status: 502 });
  }
}
