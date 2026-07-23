// Tests unitaires de la derivation d'adresses par cle etendue (lib/bitcoin-xpub.ts).
// Execution : `node --test tests/bitcoin-xpub.test.mjs` (Node >= 22.18 / 24 : type-stripping natif).
//
// Vecteurs officiels BIP84 (https://github.com/bitcoin/bips/blob/master/bip-0084.mediawiki) :
// prouvent que la derivation zpub -> adresses bc1q est exacte, independamment de toute
// donnee reelle. Si un jour @scure change de comportement, ce test casse immediatement.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseExtendedKey,
  deriveRange,
  firstReceiveAddress,
  isExtendedKey,
  encodeAddress,
} from "../lib/bitcoin-xpub.ts";

// zpub du compte 0 (m/84'/0'/0') du vecteur de reference BIP84.
const BIP84_ZPUB =
  "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";

test("BIP84 : derivation des adresses de reception (chain 0)", () => {
  const { hdkey, scriptType, standard } = parseExtendedKey(BIP84_ZPUB);
  assert.equal(scriptType, "p2wpkh");
  assert.equal(standard, "BIP84");
  const receive = deriveRange(hdkey, scriptType, 0, 0, 2);
  assert.equal(receive[0].address, "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
  assert.equal(receive[1].address, "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g");
});

test("BIP84 : derivation des adresses de monnaie (chain 1)", () => {
  const { hdkey, scriptType } = parseExtendedKey(BIP84_ZPUB);
  const change = deriveRange(hdkey, scriptType, 1, 0, 1);
  assert.equal(change[0].address, "bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el");
});

test("firstReceiveAddress renvoie m/.../0/0", () => {
  assert.equal(firstReceiveAddress(BIP84_ZPUB), "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
});

test("isExtendedKey distingue cle etendue et adresse", () => {
  assert.equal(isExtendedKey(BIP84_ZPUB), true);
  assert.equal(isExtendedKey("bc1qfwuze87xnhxjfdmr3wnfy3wguu5ymedk4qcwjr"), false);
  assert.equal(isExtendedKey("pas une cle"), false);
});

test("parseExtendedKey rejette une cle invalide ou tronquee", () => {
  assert.throws(() => parseExtendedKey("zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCtoUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYt"));
  assert.throws(() => parseExtendedKey("xpubINVALID"));
  assert.throws(() => parseExtendedKey("bc1qfwuze87xnhxjfdmr3wnfy3wguu5ymedk4qcwjr"));
});

test("encodeAddress supporte les trois formats", () => {
  const { hdkey } = parseExtendedKey(BIP84_ZPUB);
  const pubkey = hdkey.deriveChild(0).deriveChild(0).publicKey;
  assert.equal(encodeAddress(pubkey, "p2wpkh"), "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
  // Meme cle publique, encodages legacy/imbrique : formats valides et distincts.
  assert.match(encodeAddress(pubkey, "p2pkh"), /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/);
  assert.match(encodeAddress(pubkey, "p2sh-p2wpkh"), /^3[1-9A-HJ-NP-Za-km-z]{25,34}$/);
});
