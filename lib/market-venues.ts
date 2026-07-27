// Places de cotation — table EXPLICITE, jamais déduite.
//
// Un suffixe Yahoo (« .PA ») ne dit pas à lui seul la devise : c'est la PLACE qui la fixe.
// Cette table est donc la seule autorité pour transformer un symbole fournisseur en cotation
// qualifiée (place lisible + MIC + devise + pays). Hors de cette table, on ne suppose RIEN :
// `venueForYahooSymbol` renvoie null et l'appelant laisse les champs vides plutôt que d'inventer
// une devise — c'est ce qui évitait déjà au repli Stooq de coter en euros une valeur suisse.
//
// Même contrat de confiance que la table MARKETS de lib/market-quotes.ts, qu'elle complète en
// ajoutant le code MIC et le libellé de place utilisés par le catalogue d'actifs.

export type Venue = {
  /** Libellé affiché à l'utilisateur. */
  exchange: string;
  /** Code MIC ISO 10383 — participe à l'identité d'une cotation (ISIN + MIC + devise). */
  mic: string;
  currency: string;
  country: string;
};

/** Suffixe de symbole Yahoo → place. La chaîne vide correspond aux places américaines. */
export const YAHOO_VENUES: Readonly<Record<string, Venue>> = {
  PA: { exchange: "Euronext Paris", mic: "XPAR", currency: "EUR", country: "France" },
  AS: { exchange: "Euronext Amsterdam", mic: "XAMS", currency: "EUR", country: "Pays-Bas" },
  BR: { exchange: "Euronext Bruxelles", mic: "XBRU", currency: "EUR", country: "Belgique" },
  LS: { exchange: "Euronext Lisbonne", mic: "XLIS", currency: "EUR", country: "Portugal" },
  IR: { exchange: "Euronext Dublin", mic: "XDUB", currency: "EUR", country: "Irlande" },
  MI: { exchange: "Borsa Italiana", mic: "XMIL", currency: "EUR", country: "Italie" },
  MC: { exchange: "Bolsa de Madrid", mic: "XMAD", currency: "EUR", country: "Espagne" },
  DE: { exchange: "Xetra", mic: "XETR", currency: "EUR", country: "Allemagne" },
  F: { exchange: "Francfort", mic: "XFRA", currency: "EUR", country: "Allemagne" },
  VI: { exchange: "Vienne", mic: "XWBO", currency: "EUR", country: "Autriche" },
  HE: { exchange: "Nasdaq Helsinki", mic: "XHEL", currency: "EUR", country: "Finlande" },
  L: { exchange: "London Stock Exchange", mic: "XLON", currency: "GBP", country: "Royaume-Uni" },
  SW: { exchange: "SIX Swiss Exchange", mic: "XSWX", currency: "CHF", country: "Suisse" },
  ST: { exchange: "Nasdaq Stockholm", mic: "XSTO", currency: "SEK", country: "Suède" },
  CO: { exchange: "Nasdaq Copenhague", mic: "XCSE", currency: "DKK", country: "Danemark" },
  OL: { exchange: "Oslo Børs", mic: "XOSL", currency: "NOK", country: "Norvège" },
  TO: { exchange: "Toronto Stock Exchange", mic: "XTSE", currency: "CAD", country: "Canada" },
  "": { exchange: "États-Unis", mic: "XNAS", currency: "USD", country: "États-Unis" },
};

/** Suffixe d'un symbole Yahoo (« AI.PA » → « PA », « AAPL » → « »). */
export function yahooSuffix(symbol: string): string {
  const parts = String(symbol ?? "").trim().split(".");
  return parts.length > 1 ? parts[parts.length - 1].toUpperCase() : "";
}

/**
 * Place d'un symbole Yahoo. `null` si la place est inconnue de la table : l'appelant doit alors
 * laisser devise et MIC vides, pas les supposer.
 */
export function venueForYahooSymbol(symbol: string): Venue | null {
  return YAHOO_VENUES[yahooSuffix(symbol)] ?? null;
}

/**
 * Reconnaît une place à partir du libellé renvoyé par le fournisseur (`exchDisp`), utilisé quand
 * le symbole n'a pas de suffixe exploitable. Correspondances explicites uniquement.
 */
const EXCHANGE_ALIASES: Readonly<Record<string, string>> = {
  paris: "PA", amsterdam: "AS", brussels: "BR", bruxelles: "BR", lisbon: "LS", lisbonne: "LS",
  dublin: "IR", milan: "MI", madrid: "MC", xetra: "DE", frankfurt: "F", francfort: "F",
  vienna: "VI", vienne: "VI", helsinki: "HE", london: "L", londres: "L", swiss: "SW",
  stockholm: "ST", copenhagen: "CO", oslo: "OL", toronto: "TO",
  nasdaq: "", nyse: "", "nyse arca": "", amex: "", "nyseamerican": "",
};

export function venueForExchangeLabel(label: string | null | undefined): Venue | null {
  const key = String(label ?? "").trim().toLowerCase();
  if (!key) return null;
  const suffix = EXCHANGE_ALIASES[key];
  return suffix === undefined ? null : YAHOO_VENUES[suffix] ?? null;
}
