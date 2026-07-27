// Lecture du fichier quotidien de la BCE — copie MIROIR de `web/lib/fx-rates.ts`.
//
// Pourquoi une copie : une Fonction Edge s'exécute sous Deno et doit rester autonome dans son
// dossier ; elle ne peut pas importer le `lib/` de l'application Next.js. La divergence entre
// les deux implémentations est le vrai risque, alors elle est verrouillée par un test :
// `web/tests/fx-rates.test.mjs` fait passer les MÊMES fichiers XML dans les deux versions et
// exige un résultat identique. Toute modification ici doit donc être reportée là-bas, sinon la
// suite de tests échoue.
//
// CONVENTION BCE : l'euro est la devise de base.
//     <Cube currency='USD' rate='1.1377'/>   ⟹   1 EUR = 1,1377 USD
//     montant_eur = montant_usd / 1,1377

export const ECB_BASE_CURRENCY = "EUR";

export type EcbDaily = { date: string; rates: Array<{ currency: string; rate: number }> };

export function normaliseCurrency(value: string | null | undefined): string | null {
  const code = String(value ?? "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

function isUsableRate(value: unknown): value is number {
  const rate = Number(value);
  return Number.isFinite(rate) && rate > 0;
}

export function parseEcbDailyXml(xml: string): EcbDaily | null {
  const text = String(xml ?? "");
  const date = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(text)?.[1];
  if (!date) return null;

  const rates: Array<{ currency: string; rate: number }> = [];
  const seen = new Set<string>();
  const pattern = /<Cube\s+currency=['"]([A-Za-z]{3})['"]\s+rate=['"]([0-9.,]+)['"]/g;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const currency = normaliseCurrency(match[1]);
    const rate = Number(match[2]);
    if (!currency || !isUsableRate(rate)) continue;
    if (currency === ECB_BASE_CURRENCY) continue;
    if (seen.has(currency)) continue;
    seen.add(currency);
    rates.push({ currency, rate });
  }
  return rates.length === 0 ? null : { date, rates };
}

export function ecbRowsFor(daily: EcbDaily, fetchedAt: string): Array<{
  base_currency: string; quote_currency: string; rate: number; rate_date: string; source: string; fetched_at: string;
}> {
  return daily.rates.map((entry) => ({
    base_currency: ECB_BASE_CURRENCY,
    quote_currency: entry.currency,
    rate: entry.rate,
    rate_date: daily.date,
    source: "ECB",
    fetched_at: fetchedAt,
  }));
}

/** Devises annoncées dans le fichier mais écartées par la validation (rapportées, jamais écrites). */
export function rejectedCurrencies(xml: string, kept: Array<{ currency: string }>): string[] {
  const keptSet = new Set(kept.map((entry) => entry.currency));
  const announced = (String(xml ?? "").match(/<Cube\s+currency=['"]([A-Za-z]{3})['"]/g) ?? [])
    .map((tag) => /['"]([A-Za-z]{3})['"]/.exec(tag)?.[1] ?? "")
    .filter(Boolean)
    .map((code) => code.toUpperCase());
  return [...new Set(announced.filter((code) => !keptSet.has(code)))];
}
