import { authErrorResponse, requireAdmin } from "../../../lib/auth-server";
import { supabaseRest } from "../../../lib/supabase-rest";
import { deriveRange, parseExtendedKey, type ScriptType } from "../../../lib/bitcoin-xpub";
import type { HDKey } from "@scure/bip32";

const ESPLORA_API = "https://blockstream.info/api";
// Limite d'ecart BIP44 : on arrete de deriver apres GAP_LIMIT adresses consecutives non
// utilisees. MAX borne le nombre d'appels reseau par chaine pour un compte tres actif.
const GAP_LIMIT = 20;
const MAX_ADDRESSES_PER_CHAIN = 60;

type WalletSource = { member: string; address: string; xpub: string | null };

async function loadWallets(): Promise<WalletSource[]> {
  try {
    const rows = await supabaseRest<Array<{ member_name: string; public_address: string | null; xpub: string | null }>>(
      "wallets?select=member_name,public_address,xpub&or=(public_address.not.is.null,xpub.not.is.null)",
    );
    return rows
      .filter((row) => Boolean(row.public_address) || Boolean(row.xpub))
      .map((row) => ({ member: row.member_name, address: row.public_address ?? "", xpub: row.xpub }));
  } catch (error) {
    // Repli si la migration 20260727_wallet_xpub n'a pas encore ete jouee (colonne absente).
    if (error instanceof Error && /xpub/i.test(error.message)) {
      const rows = await supabaseRest<Array<{ member_name: string; public_address: string | null }>>(
        "wallets?select=member_name,public_address&public_address=not.is.null",
      );
      return rows
        .filter((row): row is { member_name: string; public_address: string } => Boolean(row.public_address))
        .map((row) => ({ member: row.member_name, address: row.public_address, xpub: null }));
    }
    throw error;
  }
}

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

async function fetchAddressSummary(address: string): Promise<AddressSummary> {
  const response = await fetch(`${ESPLORA_API}/address/${address}`, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("Lecture d'adresse impossible.");
  return response.json() as Promise<AddressSummary>;
}

async function getAddressTransactions(address: string) {
  const transactions: ChainTransaction[] = [];
  let path = `${ESPLORA_API}/address/${address}/txs`;

  for (let pageCount = 0; pageCount < 20; pageCount += 1) {
    const response = await fetch(path, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("Lecture des transactions impossible.");
    const page = await response.json() as ChainTransaction[];
    transactions.push(...page);
    if (page.length < 25 || !page[page.length - 1]?.txid) break;
    path = `${ESPLORA_API}/address/${address}/txs/chain/${page[page.length - 1].txid}`;
  }

  return transactions;
}

function mapTransaction(tx: ChainTransaction, ownedSet: Set<string>, tipHeight: number, fallbackAddress: string) {
  const ownedOutputs = tx.vout.filter((output) => output.scriptpubkey_address && ownedSet.has(output.scriptpubkey_address));
  const receivedSats = sum(ownedOutputs.map((output) => output.value));
  const spentSats = sum(tx.vin.filter((input) => input.prevout?.scriptpubkey_address && ownedSet.has(input.prevout.scriptpubkey_address)).map((input) => input.prevout?.value ?? 0));
  const netSats = receivedSats - spentSats;
  const confirmations = tx.status.confirmed && tx.status.block_height ? Math.max(1, tipHeight - tx.status.block_height + 1) : 0;
  // Adresse creditee = sortie possedee ayant recu le plus. C'est elle que le rapprochement
  // on-chain (/api/ledger-transfers, /api/blockchain/verify) doit verifier pour cette tx.
  const creditedAddress = [...ownedOutputs].sort((left, right) => right.value - left.value)[0]?.scriptpubkey_address ?? fallbackAddress;
  return {
    txid: tx.txid,
    date: tx.status.block_time ? new Date(tx.status.block_time * 1000).toISOString() : null,
    amountBtc: Math.abs(netSats) / 100_000_000,
    receivedBtc: receivedSats / 100_000_000,
    sentBtc: spentSats / 100_000_000,
    direction: netSats >= 0 ? "Reçu" : "Envoyé",
    address: creditedAddress,
    confirmed: tx.status.confirmed,
    confirmations,
    explorerUrl: `${ESPLORA_API.replace("/api", "")}/tx/${tx.txid}`,
  };
}

// ---- Suivi mono-adresse (repli historique) --------------------------------------------
async function getWallet(member: string, address: string, tipHeight: number) {
  const [summary, transactions] = await Promise.all([fetchAddressSummary(address), getAddressTransactions(address)]);
  const confirmedBalanceSats = summary.chain_stats.funded_txo_sum - summary.chain_stats.spent_txo_sum;
  const pendingBalanceSats = summary.mempool_stats.funded_txo_sum - summary.mempool_stats.spent_txo_sum;
  const ownedSet = new Set([address]);

  return {
    member,
    address,
    xpubTracked: false,
    confirmedBalanceBtc: confirmedBalanceSats / 100_000_000,
    pendingBalanceBtc: pendingBalanceSats / 100_000_000,
    receivedBtc: summary.chain_stats.funded_txo_sum / 100_000_000,
    spentBtc: summary.chain_stats.spent_txo_sum / 100_000_000,
    transactionCount: summary.chain_stats.tx_count + summary.mempool_stats.tx_count,
    explorerUrl: `https://blockstream.info/address/${address}`,
    transactions: transactions.map((transaction) => mapTransaction(transaction, ownedSet, tipHeight, address)),
  };
}

// ---- Suivi par cle etendue (xpub/ypub/zpub) -------------------------------------------
type ScannedAddress = { address: string; summary: AddressSummary };

async function scanChain(hdkey: HDKey, scriptType: ScriptType, chain: 0 | 1, member: string): Promise<ScannedAddress[]> {
  const used: ScannedAddress[] = [];
  let start = 0;
  let gap = 0;
  while (gap < GAP_LIMIT && start < MAX_ADDRESSES_PER_CHAIN) {
    const batchSize = Math.min(GAP_LIMIT, MAX_ADDRESSES_PER_CHAIN - start);
    const batch = deriveRange(hdkey, scriptType, chain, start, batchSize);
    const summaries = await Promise.all(batch.map((entry) => fetchAddressSummary(entry.address)));
    for (let index = 0; index < batch.length; index += 1) {
      const summary = summaries[index];
      if (summary.chain_stats.tx_count + summary.mempool_stats.tx_count > 0) {
        used.push({ address: batch[index].address, summary });
        gap = 0;
      } else if ((gap += 1) >= GAP_LIMIT) {
        break;
      }
    }
    start += batch.length;
  }
  if (start >= MAX_ADDRESSES_PER_CHAIN && gap < GAP_LIMIT) {
    console.warn(`[ledger] scan xpub de ${member} (chain ${chain}) plafonne a ${MAX_ADDRESSES_PER_CHAIN} adresses.`);
  }
  return used;
}

async function getXpubWallet(member: string, extendedKey: string, tipHeight: number) {
  const { hdkey, scriptType, standard } = parseExtendedKey(extendedKey);
  const receive = await scanChain(hdkey, scriptType, 0, member);
  // Une chaine de monnaie (change) n'existe que si le compte a deja recu quelque chose.
  const change = receive.length > 0 ? await scanChain(hdkey, scriptType, 1, member) : [];
  const usedAddresses = [...receive, ...change];
  const ownedSet = new Set(usedAddresses.map((entry) => entry.address));
  const firstReceive = receive[0]?.address ?? deriveRange(hdkey, scriptType, 0, 0, 1)[0].address;

  let fundedSats = 0;
  let spentSats = 0;
  let mempoolFundedSats = 0;
  let mempoolSpentSats = 0;
  let txCount = 0;
  for (const entry of usedAddresses) {
    fundedSats += entry.summary.chain_stats.funded_txo_sum;
    spentSats += entry.summary.chain_stats.spent_txo_sum;
    mempoolFundedSats += entry.summary.mempool_stats.funded_txo_sum;
    mempoolSpentSats += entry.summary.mempool_stats.spent_txo_sum;
    txCount += entry.summary.chain_stats.tx_count + entry.summary.mempool_stats.tx_count;
  }

  const txMap = new Map<string, ChainTransaction>();
  await Promise.all(usedAddresses.map(async (entry) => {
    const txs = await getAddressTransactions(entry.address);
    for (const tx of txs) if (!txMap.has(tx.txid)) txMap.set(tx.txid, tx);
  }));

  const transactions = [...txMap.values()]
    .map((tx) => mapTransaction(tx, ownedSet, tipHeight, firstReceive))
    .sort((left, right) => (right.date ?? "").localeCompare(left.date ?? ""));

  return {
    member,
    address: firstReceive,
    xpubTracked: true,
    derivationStandard: standard,
    addressCount: ownedSet.size,
    confirmedBalanceBtc: (fundedSats - spentSats) / 100_000_000,
    pendingBalanceBtc: (mempoolFundedSats - mempoolSpentSats) / 100_000_000,
    receivedBtc: fundedSats / 100_000_000,
    spentBtc: spentSats / 100_000_000,
    transactionCount: txCount,
    explorerUrl: `https://blockstream.info/address/${firstReceive}`,
    transactions,
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
  const priceOnly = new URL(request.url).searchParams.get("priceOnly") === "1";
  if (!priceOnly) {
    try { await requireAdmin(request); } catch (error) { return authErrorResponse(error); }
  }
  try {
    if (priceOnly) {
      const bitcoinPrice = await getBitcoinEurPrice();
      return Response.json(
        { bitcoinEur: bitcoinPrice.value, bitcoinEurSource: bitcoinPrice.source, updatedAt: new Date().toISOString() },
        { headers: { "cache-control": "public, max-age=30, s-maxage=60" } },
      );
    }
    const [tipResponse, bitcoinPrice, wallets] = await Promise.all([
      fetch(`${ESPLORA_API}/blocks/tip/height`),
      getBitcoinEurPrice(),
      loadWallets(),
    ]);
    if (!tipResponse.ok) throw new Error("Hauteur de chaîne indisponible");
    const tipHeight = Number(await tipResponse.text());
    const results = await Promise.allSettled(wallets.map((wallet) => wallet.xpub
      ? getXpubWallet(wallet.member, wallet.xpub, tipHeight)
      : getWallet(wallet.member, wallet.address, tipHeight)));
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
