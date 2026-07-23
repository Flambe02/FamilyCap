// Suivi Bitcoin par cle publique etendue (xpub / ypub / zpub).
//
// On derive les adresses PUBLIQUES d'un compte Ledger a partir de sa cle etendue, pour
// lire soldes et transactions directement sur la blockchain (voir app/api/ledger).
// Ce module ne manipule QUE des cles publiques : jamais de cle privee, jamais de phrase
// de recuperation. Il est pur (aucun acces reseau) et teste (tests/bitcoin-xpub.test.mjs).
//
// SLIP-0132 : le prefixe de la cle etendue encode le type de script, donc le format
// d'adresse et le chemin de derivation standard :
//   xpub -> P2PKH        (BIP44, adresses "1...")
//   ypub -> P2SH-P2WPKH  (BIP49, adresses "3...")
//   zpub -> P2WPKH       (BIP84, adresses "bc1q...")  <- Ledger SegWit natif
import { HDKey } from "@scure/bip32";
import { base58check as base58checkWith, bech32 } from "@scure/base";
import { sha256 } from "@noble/hashes/sha256";
import { ripemd160 } from "@noble/hashes/ripemd160";

const base58check = base58checkWith(sha256);

export type ScriptType = "p2wpkh" | "p2sh-p2wpkh" | "p2pkh";

const PREFIX: Record<string, { scriptType: ScriptType; standard: string }> = {
  xpub: { scriptType: "p2pkh", standard: "BIP44" },
  ypub: { scriptType: "p2sh-p2wpkh", standard: "BIP49" },
  zpub: { scriptType: "p2wpkh", standard: "BIP84" },
};

// Octets de version d'un xpub mainnet standard : on y ramene toute cle etendue pour que
// @scure/bip32 (qui ne connait que xpub/xprv) accepte les ypub/zpub SLIP-0132.
const XPUB_VERSION = Uint8Array.from([0x04, 0x88, 0xb2, 0x1e]);

/** Vrai si la valeur ressemble a une cle publique etendue (et non a une adresse). */
export function isExtendedKey(value: string): boolean {
  return /^(xpub|ypub|zpub)[1-9A-HJ-NP-Za-km-z]{100,120}$/.test(value.trim());
}

/**
 * Parse une cle etendue xpub/ypub/zpub en HDKey derivable + type de script associe.
 * Rejette une cle inconnue ou au checksum invalide.
 */
export function parseExtendedKey(key: string): { hdkey: HDKey; scriptType: ScriptType; standard: string } {
  const trimmed = key.trim();
  const meta = PREFIX[trimmed.slice(0, 4).toLowerCase()];
  if (!meta) throw new Error("Cle publique etendue non reconnue (attendu xpub, ypub ou zpub).");
  let payload: Uint8Array;
  try {
    payload = base58check.decode(trimmed);
  } catch {
    throw new Error("Cle publique etendue invalide (encodage ou checksum incorrect).");
  }
  const normalised = Uint8Array.from(payload);
  normalised.set(XPUB_VERSION, 0);
  let hdkey: HDKey;
  try {
    hdkey = HDKey.fromExtendedKey(base58check.encode(normalised));
  } catch {
    throw new Error("Cle publique etendue invalide.");
  }
  if (hdkey.privateKey) throw new Error("Une cle PRIVEE a ete fournie : n'utilisez que la cle publique (xpub/ypub/zpub).");
  return { hdkey, scriptType: meta.scriptType, standard: meta.standard };
}

function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data));
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Encode une cle publique compressee (33 octets) en adresse selon le type de script. */
export function encodeAddress(pubkey: Uint8Array, scriptType: ScriptType): string {
  const keyHash = hash160(pubkey);
  if (scriptType === "p2wpkh") {
    return bech32.encode("bc", [0, ...bech32.toWords(keyHash)]);
  }
  if (scriptType === "p2pkh") {
    return base58check.encode(concatBytes(Uint8Array.of(0x00), keyHash));
  }
  // p2sh-p2wpkh : l'adresse est le P2SH du redeemScript "OP_0 PUSH20 <keyHash>".
  const redeemScript = concatBytes(Uint8Array.of(0x00, 0x14), keyHash);
  return base58check.encode(concatBytes(Uint8Array.of(0x05), hash160(redeemScript)));
}

/**
 * Derive une plage d'adresses sur une branche. chain 0 = reception, chain 1 = monnaie
 * (change). La cle etendue attendue est celle du COMPTE (m/purpose'/0'/0'), comme
 * exportee par Ledger Live.
 */
export function deriveRange(
  hdkey: HDKey,
  scriptType: ScriptType,
  chain: 0 | 1,
  start: number,
  count: number,
): Array<{ index: number; address: string }> {
  const branch = hdkey.deriveChild(chain);
  const result: Array<{ index: number; address: string }> = [];
  for (let index = start; index < start + count; index += 1) {
    const child = branch.deriveChild(index);
    if (!child.publicKey) throw new Error("Derivation impossible : cle publique manquante.");
    result.push({ index, address: encodeAddress(child.publicKey, scriptType) });
  }
  return result;
}

/** Premiere adresse de reception (m/.../0/0) — utile pour l'affichage et le repli mono-adresse. */
export function firstReceiveAddress(extendedKey: string): string {
  const { hdkey, scriptType } = parseExtendedKey(extendedKey);
  return deriveRange(hdkey, scriptType, 0, 0, 1)[0].address;
}
