import { authErrorResponse, requireAdmin, requireAdminOrBtcViewer } from "../../../lib/auth-server";
import { supabaseRest } from "../../../lib/supabase-rest";
import { deriveRange, parseExtendedKey, type ScriptType } from "../../../lib/bitcoin-xpub";
import type { HDKey } from "@scure/bip32";

const ESPLORA_API = "https://blockstream.info/api";
// Limite d'ecart BIP44 : on arrete de deriver apres GAP_LIMIT adresses consecutives non
// utilisees. MAX borne le nombre d'appels reseau par chaine pour un compte tres actif.
const GAP_LIMIT = 20;
const MAX_ADDRESSES_PER_CHAIN = 60;
const EXTERNAL_TIMEOUT_MS = 10_000;

function fetchExternal(input: string, init: RequestInit = {}) {
  return fetch(input, { ...init, signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS) });
}

type WalletSource = { id: string; member: string; address: string; xpub: string | null; lastVerifiedBalanceBtc: number | null; lastVerifiedAt: string | null };

async function loadWallets(): Promise<WalletSource[]> {
  try {
    const rows = await supabaseRest<Array<{ id: string; member_name: string; public_address: string | null; xpub: string | null; last_verified_balance_btc: number | string | null; last_verified_at: string | null }>>(
      "wallets?select=id,member_name,public_address,xpub,last_verified_balance_btc,last_verified_at&or=(public_address.not.is.null,xpub.not.is.null)",
    );
    return rows
      .filter((row) => Boolean(row.public_address) || Boolean(row.xpub))
      .map((row) => ({ id: row.id, member: row.member_name, address: row.public_address ?? "", xpub: row.xpub, lastVerifiedBalanceBtc: row.last_verified_balance_btc === null ? null : Number(row.last_verified_balance_btc), lastVerifiedAt: row.last_verified_at }));
  } catch (error) {
    // Repli si la migration 20260822_wallet_last_verified n'a pas encore ete jouee (colonnes absentes).
    if (error instanceof Error && /last_verified/i.test(error.message)) {
      const rows = await supabaseRest<Array<{ id: string; member_name: string; public_address: string | null; xpub: string | null }>>(
        "wallets?select=id,member_name,public_address,xpub&or=(public_address.not.is.null,xpub.not.is.null)",
      );
      return rows
        .filter((row) => Boolean(row.public_address) || Boolean(row.xpub))
        .map((row) => ({ id: row.id, member: row.member_name, address: row.public_address ?? "", xpub: row.xpub, lastVerifiedBalanceBtc: null, lastVerifiedAt: null }));
    }
    // Repli si la migration 20260727_wallet_xpub n'a pas encore ete jouee (colonne absente).
    if (error instanceof Error && /xpub/i.test(error.message)) {
      const rows = await supabaseRest<Array<{ id: string; member_name: string; public_address: string | null }>>(
        "wallets?select=id,member_name,public_address&public_address=not.is.null",
      );
      return rows
        .filter((row): row is { id: string; member_name: string; public_address: string } => Boolean(row.public_address))
        .map((row) => ({ id: row.id, member: row.member_name, address: row.public_address, xpub: null, lastVerifiedBalanceBtc: null, lastVerifiedAt: null }));
    }
    throw error;
  }
}

async function persistVerifiedBalance(walletId: string, balanceBtc: number, checkedAt: string) {
  try {
    await supabaseRest(`wallets?id=eq.${encodeURIComponent(walletId)}`, {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ last_verified_balance_btc: balanceBtc, last_verified_at: checkedAt }),
    });
  } catch {
    // Best-effort : une écriture cache ratée ne doit jamais transformer une lecture blockchain
    // réussie en erreur pour l'appelant.
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
  const response = await fetchExternal(`${ESPLORA_API}/address/${address}`, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("Lecture d'adresse impossible.");
  return response.json() as Promise<AddressSummary>;
}

async function getAddressTransactions(address: string) {
  const transactions: ChainTransaction[] = [];
  let path = `${ESPLORA_API}/address/${address}/txs`;

  for (let pageCount = 0; pageCount < 20; pageCount += 1) {
    const response = await fetchExternal(path, { headers: { accept: "application/json" } });
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

let bitcoinPriceCache: { value: number | null; source: string | null; expiresAt: number } | null = null;

async function getBitcoinEurPrice() {
  if (bitcoinPriceCache && bitcoinPriceCache.expiresAt > Date.now()) return bitcoinPriceCache;
  const fallback: { value: number | null; source: string | null } = { value: null, source: null };
  try {
    const response = await fetchExternal("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=eur", { headers: { accept: "application/json" } });
    if (response.ok) {
      const result = await response.json() as { bitcoin?: { eur?: number } };
      if (result.bitcoin?.eur) return bitcoinPriceCache = { value: result.bitcoin.eur, source: "CoinGecko", expiresAt: Date.now() + 30_000 };
    }
  } catch {
    // Une seconde source publique est utilisée ci-dessous.
  }

  try {
    const response = await fetchExternal("https://api.kraken.com/0/public/Ticker?pair=XBTEUR", { headers: { accept: "application/json" } });
    if (!response.ok) return bitcoinPriceCache = { ...fallback, expiresAt: Date.now() + 10_000 };
    const krakenResult = await response.json() as { result?: { XXBTZEUR?: { c?: string[] } } };
    const price = Number(krakenResult.result?.XXBTZEUR?.c?.[0]);
    return bitcoinPriceCache = Number.isFinite(price) ? { value: price, source: "Kraken", expiresAt: Date.now() + 30_000 } : { value: null, source: null, expiresAt: Date.now() + 10_000 };
  } catch {
    return bitcoinPriceCache = { ...fallback, expiresAt: Date.now() + 10_000 };
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const priceOnly = url.searchParams.get("priceOnly") === "1";
  // Lecture seule du dernier solde blockchain déjà constaté (colonnes wallets.last_verified_*) :
  // aucun appel Blockstream, pour afficher « dernière vérification » au chargement d'un écran
  // sans en faire une vérification live. Seul le mode complet (ni priceOnly, ni cachedOnly)
  // interroge réellement la blockchain et met ce cache à jour.
  const cachedOnly = url.searchParams.get("cachedOnly") === "1";
  if (!priceOnly) {
    try { await requireAdminOrBtcViewer(request); } catch (error) { return authErrorResponse(error); }
  }
  try {
    if (priceOnly) {
      const bitcoinPrice = await getBitcoinEurPrice();
      return Response.json(
        { bitcoinEur: bitcoinPrice.value, bitcoinEurSource: bitcoinPrice.source, updatedAt: new Date().toISOString() },
        { headers: { "cache-control": "public, max-age=30, s-maxage=60" } },
      );
    }
    if (cachedOnly) {
      const wallets = await loadWallets();
      return Response.json({
        wallets: wallets.map((wallet) => ({ member: wallet.member, address: wallet.address, confirmedBalanceBtc: wallet.lastVerifiedBalanceBtc ?? undefined, lastVerifiedBalanceBtc: wallet.lastVerifiedBalanceBtc, lastVerifiedAt: wallet.lastVerifiedAt })),
      });
    }
    const [tipResponse, bitcoinPrice, wallets] = await Promise.all([
      fetchExternal(`${ESPLORA_API}/blocks/tip/height`),
      getBitcoinEurPrice(),
      loadWallets(),
    ]);
    if (!tipResponse.ok) throw new Error("Hauteur de chaîne indisponible");
    const tipHeight = Number(await tipResponse.text());
    const results = await Promise.allSettled(wallets.map((wallet) => wallet.xpub
      ? getXpubWallet(wallet.member, wallet.xpub, tipHeight)
      : getWallet(wallet.member, wallet.address, tipHeight)));
    const checkedAt = new Date().toISOString();
    const ledgerWallets = results.map((result, index) => result.status === "fulfilled"
      ? { ...result.value, lastVerifiedAt: checkedAt }
      : { member: wallets[index].member, address: wallets[index].address, error: result.reason instanceof Error ? result.reason.message : "Lecture indisponible" });

    // Écrit le cache AVANT de répondre : une fonction serverless peut être suspendue dès la
    // réponse envoyée, un "fire-and-forget" non attendu risquerait donc de ne jamais s'exécuter.
    // Reste best-effort : persistVerifiedBalance() avale ses propres erreurs, jamais throw ici.
    await Promise.allSettled(
      results
        .map((result, index) => (result.status === "fulfilled" ? persistVerifiedBalance(wallets[index].id, result.value.confirmedBalanceBtc, checkedAt) : null))
        .filter((promise): promise is Promise<void> => promise !== null),
    );

    return Response.json(
      { wallets: ledgerWallets, bitcoinEur: bitcoinPrice.value, bitcoinEurSource: bitcoinPrice.source, updatedAt: checkedAt, source: "Blockstream" },
      { headers: { "cache-control": "public, max-age=30, s-maxage=60" } },
    );
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Blockchain indisponible" }, { status: 502 });
  }
}

// Renomme le portefeuille Ledger d'un membre (wallets.label) — même geste que le renommage
// d'un PEA/compte-titres (AccountDetailModal), admin uniquement. Ne crée jamais de portefeuille :
// seul un membre disposant déjà d'une adresse/xpub enregistrée peut être renommé.
export async function PATCH(request: Request) {
  try {
    await requireAdmin(request);
    const body = await request.json() as { memberId?: string; label?: string };
    const memberId = body.memberId?.trim();
    const label = body.label?.trim();
    if (!memberId || !label) return Response.json({ error: "Membre et nom du portefeuille obligatoires." }, { status: 400 });
    const rows = await supabaseRest<Array<{ id: string }>>(`wallets?member_id=eq.${encodeURIComponent(memberId)}&select=id`);
    if (!rows.length) return Response.json({ error: "Aucun portefeuille Ledger enregistré pour ce membre." }, { status: 404 });
    await supabaseRest(`wallets?member_id=eq.${encodeURIComponent(memberId)}`, {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ label }),
    });
    return Response.json({ updated: true, label });
  } catch (error) {
    return authErrorResponse(error);
  }
}
