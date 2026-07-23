// Classification de la localisation d'un cadeau Bitcoin (Ledger / Binance commun / à
// rapprocher) et calcul des soldes associés. Centralise EN UN SEUL ENDROIT la logique
// jusque-la dupliquee dans les composants (gift-portfolio, administration, transactions),
// pour qu'elle soit testable et coherente.
//
// Regle metier clef : un cadeau transfere sur le Ledger reste sur Ledger MEME si des frais
// de reseau ont ete preleves (ledger_amount < btc_amount). Il ne doit JAMAIS etre recompte
// comme encore present sur Binance. C'est ce que verrouille tests/gift-custody.test.mjs.

export type CustodyGift = {
  custody: string;
  btc_amount: number | string;
  ledger_amount?: number | string | null;
  txid?: string | null;
};

const n = (value: number | string | null | undefined): number => Number(value ?? 0);

/** Montant achete (cout d'origine sur Binance), en BTC. */
export function purchasedBtc(gift: CustodyGift): number {
  return n(gift.btc_amount);
}

/** Vrai si le cadeau est detenu sur le Ledger. */
export function isLedgerGift(gift: CustodyGift): boolean {
  return gift.custody === "Ledger";
}

/** Vrai si le cadeau est encore sur Binance commun (donc a transferer). */
export function isBinanceGift(gift: CustodyGift): boolean {
  return gift.custody === "Binance commun";
}

/**
 * Quantite reellement detenue pour ce cadeau, en BTC : le montant net recu sur le Ledger
 * une fois transfere (frais deduits), sinon le montant achete tant qu'il est sur Binance.
 */
export function heldBtc(gift: CustodyGift): number {
  return isLedgerGift(gift) ? n(gift.ledger_amount ?? gift.btc_amount) : n(gift.btc_amount);
}

/** Frais de transfert d'un cadeau (achat − net recu sur Ledger), jamais negatif. */
export function transferFeeBtc(gift: CustodyGift): number {
  if (!isLedgerGift(gift)) return 0;
  return Math.max(0, n(gift.btc_amount) - n(gift.ledger_amount ?? gift.btc_amount));
}

/** Solde reellement rapproche sur le Ledger, en BTC (somme des montants nets recus). */
export function ledgerBalanceBtc(gifts: CustodyGift[]): number {
  return gifts.filter(isLedgerGift).reduce((sum, gift) => sum + n(gift.ledger_amount ?? gift.btc_amount), 0);
}

/** Solde encore sur Binance commun, en BTC (somme des montants achetes non transferes). */
export function binanceBalanceBtc(gifts: CustodyGift[]): number {
  return gifts.filter(isBinanceGift).reduce((sum, gift) => sum + n(gift.btc_amount), 0);
}

/** Frais de transfert historiques cumules, en BTC. */
export function transferFeesBtc(gifts: CustodyGift[]): number {
  return gifts.reduce((sum, gift) => sum + transferFeeBtc(gift), 0);
}

/**
 * BTC presents sur l'adresse Ledger (solde blockchain) mais pas encore rattaches a un
 * cadeau documente. Sert a ne pas laisser les montants rapproches masquer le veritable
 * solde on-chain : si le resultat est > 0, un cadeau manque a la comptabilite.
 */
export function unreconciledLedgerBtc(gifts: CustodyGift[], onChainBalanceBtc: number): number {
  return Math.max(0, onChainBalanceBtc - ledgerBalanceBtc(gifts));
}
