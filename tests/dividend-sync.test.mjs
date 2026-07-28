// Couche fournisseur et orchestration (lib/dividend-providers.ts, lib/dividend-sync.ts).
//
// Aucune requête réseau réelle : `fetch` est remplacé le temps du test. Ce qui est vérifié est ce
// qui protège l'utilisateur — quota respecté, échec fournisseur qui ne détruit rien, absence de
// doublon entre deux sources, et refus d'enregistrer un montant dont la devise est inconnue.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AlphaVantageDividendProvider, DividlandDividendProvider, EodhdDividendProvider, YahooDividendProvider,
  alphaVantageDailyLimit, dividendCacheTtlHours, dividendProviderChain, projectionsEnabled,
  orderDividendProviders, parseDividlandDividendPage, providerAvailability,
} from "../lib/dividend-providers.ts";
import { mergeProviderEvents, normalizeCurrency, providerDailyLimit, EODHD_DAILY_LIMIT } from "../lib/dividend-sync.ts";

const ENV_KEYS = [
  "ALPHA_VANTAGE_API_KEY", "EODHD_API_TOKEN", "ENABLE_EXPERIMENTAL_YAHOO_PROVIDER",
  "DIVIDEND_PRIMARY_PROVIDER", "DIVIDEND_SECONDARY_PROVIDER", "DIVIDEND_FALLBACK_PROVIDER",
  "DIVIDEND_FRANCE_FALLBACK_PROVIDER", "DIVIDENDS_DIVIDLAND_ENABLED",
  "ALPHA_VANTAGE_DAILY_LIMIT", "DIVIDEND_CACHE_TTL_HOURS", "ENABLE_DIVIDEND_PROJECTIONS",
];

/**
 * Isole les variables d'environnement le temps d'un test. `await` est indispensable : sans lui,
 * la restauration s'exécuterait AVANT la fin d'un `run` asynchrone, et le second appel du test
 * trouverait une clé déjà effacée — un faux « non configuré » impossible à comprendre.
 */
async function withEnv(values, run) {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, values);
  try {
    return await run();
  } finally {
    for (const key of ENV_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(saved)) if (value !== undefined) process.env[key] = value;
  }
}

async function withFetch(handler, run) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const listing = (over = {}) => ({
  isin: "FR0000120073", ticker: "AI", name: "Air Liquide", currency: "EUR",
  micCode: "XPAR", exchange: "Euronext Paris",
  alphaVantageSymbol: null, eodhdSymbol: "AI.PA", yahooSymbol: "AI.PA", ...over,
});

// ==========================================================================================
// 18. Quota Alpha Vantage
// ==========================================================================================
test("18 — le quota quotidien Alpha Vantage est configurable et vaut 25 par défaut", async () => {
  await withEnv({}, () => {
    assert.equal(alphaVantageDailyLimit(), 25);
    assert.equal(providerDailyLimit("alpha_vantage"), 25);
  });
  await withEnv({ ALPHA_VANTAGE_DAILY_LIMIT: "5" }, () => {
    assert.equal(alphaVantageDailyLimit(), 5);
    assert.equal(providerDailyLimit("alpha_vantage"), 5);
  });
  assert.equal(providerDailyLimit("eodhd"), EODHD_DAILY_LIMIT);
  assert.equal(providerDailyLimit("yahoo"), null, "Yahoo n’a pas de quota contractuel");
});

test("18 bis — un refus de quota est reconnu même derrière un HTTP 200", async () => {
  await withEnv({ ALPHA_VANTAGE_API_KEY: "clef-test" }, async () => {
    const provider = new AlphaVantageDividendProvider();
    // Alpha Vantage répond 200 avec un message : le lire est indispensable, sinon un quota épuisé
    // se lirait « aucun dividende » et effacerait des revenus réels de l'écran.
    const result = await withFetch(
      async () => json({ Information: "Thank you for using Alpha Vantage! Our standard API rate limit is 25 requests per day." }),
      () => provider.fetchDividends("AI.PA", { from: "2020-01-01", to: "2027-01-01" }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, "rate_limited");
    assert.match(result.message, /[Qq]uota/);
  });
});

test("18 ter — un fournisseur non configuré est écarté de la chaîne, jamais appelé", async () => {
  await withEnv({}, () => {
    assert.deepEqual(dividendProviderChain().map((provider) => provider.name), []);
    const availability = providerAvailability();
    assert.deepEqual(availability.map((entry) => entry.configured), [false, false, false, false]);
    assert.deepEqual(availability.map((entry) => entry.role), ["primary", "secondary", "fallback", "france_fallback"]);
  });
  await withEnv({ ALPHA_VANTAGE_API_KEY: "k", EODHD_API_TOKEN: "t", ENABLE_EXPERIMENTAL_YAHOO_PROVIDER: "true" }, () => {
    assert.deepEqual(dividendProviderChain().map((provider) => provider.name), ["alpha_vantage", "eodhd", "yahoo"]);
  });
  await withEnv({ EODHD_API_TOKEN: "t" }, () => {
    assert.deepEqual(dividendProviderChain().map((provider) => provider.name), ["eodhd"]);
  });
});

test("DividLand ne lit qu'une fiche française explicitement associée et extrait les versements datés", async () => {
  const provider = new DividlandDividendProvider();
  assert.equal(provider.isConfigured(), false, "le drapeau reste nécessaire avant toute requête");
  await withEnv({ DIVIDENDS_DIVIDLAND_ENABLED: "true" }, async () => {
    assert.equal(provider.symbolFor(listing({ dividlandSlug: "4-AIR%20LIQUIDE", assetType: "stock" })), "4-AIR%20LIQUIDE");
    assert.equal(provider.symbolFor(listing({ dividlandSlug: "4-AIR%20LIQUIDE", assetType: "etf" })), null);
    const html = `<article>19 Mai 2025 Détachement Classique DIVIDENDE : 3,30 € / action PAIEMENT : 21 Mai 2025</article>`;
    const rows = parseDividlandDividendPage(html, "https://www.dividland.fr/company/4-AIR%20LIQUIDE/");
    assert.deepEqual(rows.map(({ exDate, paymentDate, amountPerShare, currency }) => ({ exDate, paymentDate, amountPerShare, currency })), [{ exDate: "2025-05-19", paymentDate: "2025-05-21", amountPerShare: 3.3, currency: "EUR" }]);
  });
});

test("la priorité dépend de l'instrument : EODHD/DividLand en France, Alpha Vantage aux États-Unis", async () => {
  await withEnv({ ALPHA_VANTAGE_API_KEY: "k", EODHD_API_TOKEN: "t", DIVIDENDS_DIVIDLAND_ENABLED: "true" }, () => {
    const chain = dividendProviderChain();
    assert.deepEqual(orderDividendProviders(chain, listing({ dividlandSlug: "4-AIR%20LIQUIDE", assetType: "stock" })).map((provider) => provider.name).slice(0, 3), ["eodhd", "dividland", "alpha_vantage"]);
    assert.equal(orderDividendProviders(chain, listing({ isin: "US0378331005", ticker: "AAPL", currency: "USD", micCode: "XNAS", exchange: null, assetType: "stock" }))[0].name, "alpha_vantage");
  });
});

// ==========================================================================================
// 19. Cache et reprise après échec fournisseur
// ==========================================================================================
test("19 — la durée de cache est configurable et vaut 24 h par défaut", async () => {
  await withEnv({}, () => assert.equal(dividendCacheTtlHours(), 24));
  await withEnv({ DIVIDEND_CACHE_TTL_HOURS: "6" }, () => assert.equal(dividendCacheTtlHours(), 6));
  await withEnv({}, () => assert.equal(projectionsEnabled(), true));
  await withEnv({ ENABLE_DIVIDEND_PROJECTIONS: "false" }, () => assert.equal(projectionsEnabled(), false));
});

test("19 bis — un fournisseur muet renvoie un CODE, jamais une liste vide déguisée", async () => {
  await withEnv({ ALPHA_VANTAGE_API_KEY: "k" }, async () => {
    const provider = new AlphaVantageDividendProvider();
    const timeout = await withFetch(
      async () => { const error = new Error("aborted"); error.name = "AbortError"; throw error; },
      () => provider.fetchDividends("AI.PA", { from: "2020-01-01", to: "2027-01-01" }),
    );
    assert.equal(timeout.ok, false);
    assert.equal(timeout.code, "timeout");

    const notFound = await withFetch(
      async () => json({}, 404),
      () => provider.fetchDividends("ZZZZ", { from: "2020-01-01", to: "2027-01-01" }),
    );
    assert.equal(notFound.ok, false);
    assert.equal(notFound.code, "not_found");
  });
});

test("19 ter — une réponse valide SANS dividende est un fait, distinct d'une panne", async () => {
  await withEnv({ ALPHA_VANTAGE_API_KEY: "k" }, async () => {
    const provider = new AlphaVantageDividendProvider();
    const result = await withFetch(
      async () => json({ symbol: "MWRD.PA", data: [] }),
      () => provider.fetchDividends("MWRD.PA", { from: "2020-01-01", to: "2027-01-01" }),
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.dividends, []);
  });
});

// ==========================================================================================
// 6. Aucun doublon entre fournisseurs
// ==========================================================================================
const providerEvent = (over = {}) => ({
  providerEventId: null, declarationDate: null, exDate: "2026-09-10", recordDate: null,
  paymentDate: null, amountPerShare: 3.92, currency: "EUR", dividendType: "ordinary",
  isSpecial: false, sourceUrl: null, provider: "eodhd", ...over,
});

test("6 — deux fournisseurs décrivant le même versement ne produisent qu'une ligne", () => {
  const merged = mergeProviderEvents([
    [providerEvent({ provider: "alpha_vantage", paymentDate: "2026-09-14", declarationDate: "2026-02-20" })],
    [providerEvent({ provider: "eodhd", exDate: "2026-09-11", amountPerShare: 3.93 })],
  ]);
  assert.equal(merged.length, 1);
  // Le gagnant est celui qui apporte le plus d'information : c'est l'absence de date de paiement
  // qui faisait afficher le détachement à sa place.
  assert.equal(merged[0].paymentDate, "2026-09-14");
  assert.equal(merged[0].provider, "alpha_vantage");
});

test("6 bis — deux versements réellement distincts ne sont PAS fusionnés", () => {
  const merged = mergeProviderEvents([[
    providerEvent({ exDate: "2026-06-10", amountPerShare: 0.5 }),
    providerEvent({ exDate: "2026-12-10", amountPerShare: 0.5 }),
    providerEvent({ exDate: "2026-06-11", amountPerShare: 2.4 }), // même date, montant très différent
  ]]);
  assert.equal(merged.length, 3);
});

test("6 ter — une même date dans deux devises reste deux lignes", () => {
  const merged = mergeProviderEvents([[
    providerEvent({ currency: "EUR" }),
    providerEvent({ currency: "USD" }),
  ]]);
  assert.equal(merged.length, 2);
});

// ==========================================================================================
// Devise : Alpha Vantage n'en publie pas
// ==========================================================================================
test("la devise absente est reprise de la COTATION, jamais supposée en euros", async () => {
  await withEnv({ ALPHA_VANTAGE_API_KEY: "k" }, async () => {
    const provider = new AlphaVantageDividendProvider();
    const result = await withFetch(
      async () => json({
        symbol: "IBM",
        data: [{ ex_dividend_date: "2026-08-10", declaration_date: "2026-07-22", record_date: "2026-08-10", payment_date: "2026-09-10", amount: "1.69" }],
      }),
      () => provider.fetchDividends("IBM", { from: "2020-01-01", to: "2027-01-01" }),
    );
    assert.equal(result.ok, true);
    assert.equal(result.dividends[0].currency, null, "l'endpoint DIVIDENDS ne publie aucune devise");
    assert.equal(result.dividends[0].paymentDate, "2026-09-10");
    assert.equal(result.dividends[0].declarationDate, "2026-07-22");
    // La cotation fournit la devise ; sans cotation connue, l'événement est abandonné plutôt
    // qu'enregistré en euros — un dividende américain compté en euros vaut ~15 % de trop.
    assert.equal(normalizeCurrency(result.dividends[0], "USD"), "USD");
    assert.equal(normalizeCurrency(result.dividends[0], null), null);
    assert.equal(normalizeCurrency({ ...result.dividends[0], currency: "GBP" }, "USD"), "GBP");
  });
});

// ==========================================================================================
// Symboles : jamais devinés
// ==========================================================================================
test("aucun symbole n'est deviné : un ticker parisien nu ne suffit pas à Alpha Vantage", () => {
  const provider = new AlphaVantageDividendProvider();
  assert.equal(provider.symbolFor(listing()), null, "« AI » sans suffixe de place n'est pas interrogeable");
  assert.equal(provider.symbolFor(listing({ alphaVantageSymbol: "AI.PAR" })), "AI.PAR");
  // Une cotation américaine sans suffixe est le seul cas où le ticker nu est valide.
  assert.equal(provider.symbolFor(listing({ isin: "US0378331005", ticker: "AAPL", currency: "USD", micCode: "XNAS" })), "AAPL");
  assert.equal(provider.symbolFor(listing({ ticker: "AI.PA" })), null, "un ticker déjà suffixé n'est pas un symbole Alpha Vantage");

  assert.equal(new EodhdDividendProvider().symbolFor(listing()), "AI.PA");
  assert.equal(new EodhdDividendProvider().symbolFor(listing({ eodhdSymbol: null })), null);
  assert.equal(new YahooDividendProvider().symbolFor(listing({ yahooSymbol: null })), null);
});

// ==========================================================================================
// EODHD et Yahoo
// ==========================================================================================
test("EODHD publie la devise et la période : les deux sont reprises telles quelles", async () => {
  await withEnv({ EODHD_API_TOKEN: "t" }, async () => {
    const provider = new EodhdDividendProvider();
    const result = await withFetch(
      async () => json([
        { date: "2026-06-30", declarationDate: "2024-02-08", recordDate: null, paymentDate: "2026-07-02", value: 0.85, currency: "EUR", period: "Interim" },
        { date: "2026-11-20", paymentDate: null, value: 12, currency: "EUR", period: "Special" },
      ]),
      () => provider.fetchDividends("TTE.PA", { from: "2020-01-01", to: "2027-01-01" }),
    );
    assert.equal(result.ok, true);
    assert.equal(result.dividends[0].dividendType, "interim");
    assert.equal(result.dividends[0].currency, "EUR");
    assert.equal(result.dividends[0].paymentDate, "2026-07-02");
    assert.equal(result.dividends[1].dividendType, "special");
    assert.equal(result.dividends[1].isSpecial, true);
  });
});

test("Yahoo reste désactivé par défaut, et ne publie jamais de date de paiement", async () => {
  await withEnv({}, async () => {
    const disabled = await new YahooDividendProvider().fetchDividends("AI.PA", { from: "2024-01-01", to: "2026-01-01" });
    assert.equal(disabled.ok, false);
    assert.equal(disabled.code, "disabled");
  });
  await withEnv({ ENABLE_EXPERIMENTAL_YAHOO_PROVIDER: "true" }, async () => {
    const result = await withFetch(
      async () => json({ chart: { result: [{ meta: { currency: "EUR" }, events: { dividends: { "1749000000": { amount: 3.3, date: 1749000000 } } } }] } }),
      () => new YahooDividendProvider().fetchDividends("AI.PA", { from: "2025-01-01", to: "2026-01-01" }),
    );
    assert.equal(result.ok, true);
    assert.equal(result.dividends.length, 1);
    assert.equal(result.dividends[0].paymentDate, null, "Yahoo ne publie pas la date de paiement : elle reste inconnue");
    assert.equal(result.dividends[0].currency, "EUR");
  });
});

test("une réponse HTTP en erreur devient un code, pas une exception non gérée", async () => {
  await withEnv({ EODHD_API_TOKEN: "t" }, async () => {
    const result = await withFetch(
      async () => json({}, 500),
      () => new EodhdDividendProvider().fetchDividends("AI.PA", { from: "2020-01-01", to: "2027-01-01" }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, "http_error");
  });
});
