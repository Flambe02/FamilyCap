// Contribution des enveloppes PEA et compte-titres au « Patrimoine total » du tableau de bord.
//
// Pur, sans React : c'est ce qui permet de VÉRIFIER le total affiché en accueil
// (tests/home-portfolio.test.mjs) plutôt que de le croire sur parole.
//
// Règle unique : la valeur d'un compte est celle que produit `computeAccountModel`, le moteur
// déjà utilisé par les écrans PEA et Compte-titres. Le tableau de bord et ces écrans ne peuvent
// donc pas diverger.
//
// PIÈGE HISTORIQUE — ne jamais valoriser un compte par `holdings.quantity × holdings.last_price`.
// `holdings` est un référentiel de COURS, pas une table de positions : l'import CSV, l'import de
// capture courtier et le rafraîchissement des cours y écrivent tous `quantity: 0` (seule la route
// héritée /api/admin/holdings y met une quantité). Un portefeuille constitué par import valait
// alors 0 € en accueil et disparaissait du patrimoine total, tandis que l'écran PEA affichait sa
// vraie valeur. Les espèces n'étaient pas comptées non plus.

// Extensions `.ts` explicites : ce module est exécuté tel quel par `node --test`
// (type-stripping natif), qui ne résout pas les imports sans extension.
import { computeAccountModel, priceKeyOf, type AccountOperation, type AccountType, type InstrumentPrice } from "./portfolio-account.ts";
import { getLatestFxRate, type FxRateRow } from "./fx-rates.ts";

/** Compte financier, réduit à ce dont le calcul a besoin. */
export type WealthAccount = { id: string; accountType: string };

/** Ligne `holdings` : uniquement la référence de cours, jamais une quantité. */
export type WealthHolding = {
  account_id: string;
  asset_type?: string | null;
  name?: string | null;
  symbol?: string | null;
  isin?: string | null;
  last_price: number | null;
  last_price_at?: string | null;
};

export type WealthBucket = {
  /** Positions valorisées + espèces, en euros. 0 quand l'enveloppe n'existe pas. */
  value: number;
  /** Base de coût du moteur (versements − retraits) : `value − cost` = performance de l'écran. */
  cost: number;
  /** Le moteur n'a pas pu produire de total (position sans cours, espèces non converties). */
  unpriced: boolean;
};

const EMPTY: WealthBucket = { value: 0, cost: 0, unpriced: false };

/**
 * Valorise une enveloppe. `accounts` doit DÉJÀ être limité au périmètre visible (famille pour
 * l'admin, membre courant sinon) et aux comptes actifs — /api/portfolio ne renvoie que
 * `is_active = true`, un compte archivé n'entre donc jamais dans le patrimoine.
 */
export function investmentBucket(params: {
  accountType: string;
  kind: AccountType;
  accounts: WealthAccount[];
  holdings: WealthHolding[];
  operations: AccountOperation[];
  fxRates: FxRateRow[];
  today?: string;
}): WealthBucket {
  const ids = new Set(params.accounts.filter((account) => account.accountType === params.accountType).map((account) => account.id));
  if (ids.size === 0) return EMPTY;
  const operations = params.operations.filter((operation) => ids.has(operation.accountId));
  if (operations.length === 0) return EMPTY;

  const priceByKey = new Map<string, InstrumentPrice>();
  for (const holding of params.holdings) {
    if (!ids.has(holding.account_id)) continue;
    priceByKey.set(priceKeyOf({ isin: holding.isin ?? null, symbol: holding.symbol ?? null, name: holding.name ?? null }), {
      lastPrice: holding.last_price,
      lastPriceAt: holding.last_price_at ?? null,
      assetType: holding.asset_type ?? null,
      name: holding.name ?? null,
    });
  }

  // Change de repli : consulté uniquement quand l'opération ne porte pas son propre taux —
  // un taux enregistré est une donnée historique et reste prioritaire.
  const fxRateAt = (currency: string, date: string) =>
    getLatestFxRate(currency, "EUR", params.fxRates, { asOf: date, fallbackToEarliest: true })?.rate ?? null;

  const model = computeAccountModel({
    operations,
    priceByKey,
    accountType: params.kind,
    referenceCurrency: "EUR",
    fxRateAt,
    ...(params.today ? { today: params.today } : {}),
  });

  return { value: model.totalValueEur ?? 0, cost: model.netInvestedEur, unpriced: model.totalValueEur === null };
}

/** Les deux enveloppes d'un coup, telles que le tableau de bord les additionne. */
export function investmentWealth(params: {
  accounts: WealthAccount[];
  holdings: WealthHolding[];
  operations: AccountOperation[];
  fxRates: FxRateRow[];
  today?: string;
}): { pea: WealthBucket; cto: WealthBucket } {
  return {
    pea: investmentBucket({ ...params, accountType: "pea", kind: "PEA" }),
    cto: investmentBucket({ ...params, accountType: "securities", kind: "CTO" }),
  };
}
