import { test } from "node:test";
import assert from "node:assert/strict";
import { MarketProviderError } from "../lib/market-data.ts";
import { resolveMarketIdentity } from "../lib/market-identity.ts";
import { DAILY_EODHD_LIMIT, syncMarketData } from "../lib/market-sync.ts";

function quote(provider, symbol, price = 100) {
  return {
    provider, providerSymbol: symbol, price, currency: "EUR",
    quotedAt: "2026-07-24T00:00:00.000Z", marketStatus: "closed",
    dataDelayMinutes: null, quoteMode: provider === "eodhd" ? "eod" : "delayed",
    rawMetadata: {},
  };
}

function asset(overrides = {}) {
  return {
    id: "holding-1", accountId: "account-1", instrumentKey: "listing:listing-1",
    assetId: "asset-1", listingId: "listing-1", name: "Sanofi",
    isin: "FR0000120578", ticker: "SAN", micCode: "XPAR", currency: "EUR",
    providerSymbol: "SAN.PA", yahooSymbol: "SAN.PA", assetType: "stock",
    confidence: "exact", referenceCurrency: "EUR", lastQuote: null, manualPrice: null,
    ...overrides,
  };
}

function dependencies(overrides = {}) {
  return {
    primaryName: "eodhd", fallbackName: "yahoo",
    primaryConfigured: true, fallbackEnabled: true,
    primary: { getQuote: async (item) => quote("eodhd", item.providerSymbol), getDividends: async () => [] },
    fallback: { getQuote: async (item) => quote("yahoo", item.yahooSymbol), getDividends: async () => [] },
    countUsage: async () => ({ total: 0, quote: 0, dividend: 0 }),
    recordCall: async () => {}, saveQuote: async () => {}, saveEvents: async () => {},
    syncFx: async () => [],
    ...overrides,
  };
}

test("EODHD configuré et disponible sauvegarde le cours sans appeler Yahoo", async () => {
  let yahooCalls = 0;
  const report = await syncMarketData([asset()], { dependencies: dependencies({
    fallback: { getQuote: async () => { yahooCalls += 1; return quote("yahoo", "SAN.PA"); }, getDividends: async () => [] },
  }) });
  assert.equal(report.updated, 1);
  assert.equal(report.results[0].provider, "eodhd");
  assert.equal(report.results[0].reason, "primary_success");
  assert.equal(yahooCalls, 0);
});

test("sans token EODHD, Yahoo est essayé directement avec SAN.PA", async () => {
  let received = null;
  const report = await syncMarketData([asset()], { dependencies: dependencies({
    primary: null, primaryConfigured: false,
    fallback: {
      getQuote: async (item) => { received = item.yahooSymbol; return quote("yahoo", item.yahooSymbol); },
      getDividends: async () => [],
    },
  }) });
  assert.equal(received, "SAN.PA");
  assert.equal(report.results[0].provider, "yahoo");
  assert.equal(report.results[0].reason, "primary_not_configured");
  assert.equal(report.results[0].diagnostic.fallbackReason, "fallback_success");
});

test("quota EODHD atteint : circuit ouvert et Yahoo pour chaque position", async () => {
  let primaryCalls = 0;
  let yahooCalls = 0;
  const report = await syncMarketData([
    asset(),
    asset({ id: "holding-2", instrumentKey: "listing:listing-2", listingId: "listing-2", name: "WPEA", isin: "IE0002XZSHO1", ticker: "WPEA", providerSymbol: "WPEA.PA", yahooSymbol: "WPEA.PA" }),
  ], { dependencies: dependencies({
    countUsage: async () => ({ total: DAILY_EODHD_LIMIT, quote: DAILY_EODHD_LIMIT, dividend: 0 }),
    primary: { getQuote: async () => { primaryCalls += 1; return quote("eodhd", "X"); }, getDividends: async () => [] },
    fallback: { getQuote: async (item) => { yahooCalls += 1; return quote("yahoo", item.yahooSymbol); }, getDividends: async () => [] },
  }) });
  assert.equal(primaryCalls, 0);
  assert.equal(yahooCalls, 2);
  assert.equal(report.updated, 2);
  assert.equal(report.provider.primaryCircuitOpen, true);
  assert.ok(report.results.every((row) => row.reason === "primary_quota_exhausted"));
});

for (const [label, code, expected] of [
  ["404", "not_found", "primary_symbol_not_found"],
  ["429", "rate_limited", "primary_quota_exhausted"],
  ["timeout", "timeout", "primary_timeout"],
  ["réponse vide", "invalid_quote", "primary_symbol_not_found"],
  ["JSON invalide", "parse_error", "primary_parse_error"],
  ["erreur HTTP", "http_error", "primary_http_error"],
]) {
  test(`EODHD ${label} déclenche Yahoo`, async () => {
    let yahooCalls = 0;
    const report = await syncMarketData([asset()], { dependencies: dependencies({
      primary: { getQuote: async () => { throw new MarketProviderError(code, label); }, getDividends: async () => [] },
      fallback: {
        getQuote: async (item) => { yahooCalls += 1; return quote("yahoo", item.yahooSymbol); },
        getDividends: async () => [],
      },
    }) });
    assert.equal(yahooCalls, 1);
    assert.equal(report.updated, 1);
    assert.equal(report.results[0].reason, expected);
  });
}

test("Yahoo désactivé est diagnostiqué explicitement", async () => {
  const report = await syncMarketData([asset()], { dependencies: dependencies({
    primary: null, primaryConfigured: false, fallbackEnabled: false,
  }) });
  assert.equal(report.failed, 1);
  assert.equal(report.results[0].reason, "fallback_disabled");
  assert.equal(report.provider.fallbackEnabled, false);
});

test("Sanofi et WPEA utilisent toujours les symboles Yahoo qualifiés", async () => {
  const symbols = [];
  const sanofi = resolveMarketIdentity({
    name: "Sanofi", ticker: "SAN", micCode: "XPAR", currency: "EUR",
    providerSymbol: "SAN.PA", yahooSymbol: "SAN.PA", assetType: "stock",
  });
  const wpea = resolveMarketIdentity({
    name: "iShares MSCI World Swap PEA UCITS ETF", isin: "IE0002XZSHO1",
    ticker: "WPEA", micCode: "XPAR", currency: "EUR",
    providerSymbol: "WPEA.PA", yahooSymbol: "WPEA.PA", assetType: "etf",
  });
  assert.equal(sanofi.isin, "FR0000120578");
  assert.equal(sanofi.yahooSymbol, "SAN.PA");
  assert.equal(wpea.yahooSymbol, "WPEA.PA");
  await syncMarketData([
    asset({ ...sanofi, id: "h-san", instrumentKey: sanofi.instrumentKey }),
    asset({ ...wpea, id: "h-wpea", instrumentKey: wpea.instrumentKey }),
  ], { dependencies: dependencies({
    primary: null, primaryConfigured: false,
    fallback: {
      getQuote: async (item) => { symbols.push(item.yahooSymbol); return quote("yahoo", item.yahooSymbol); },
      getDividends: async () => [],
    },
  }) });
  assert.deepEqual(symbols, ["SAN.PA", "WPEA.PA"]);
  assert.ok(!symbols.includes("SAN"));
});

test("l'ISIN historique erroné de Sanofi n'est jamais corrigé silencieusement", () => {
  const identity = resolveMarketIdentity({
    name: "Sanofi", isin: "FR0001200578", ticker: "SAN", micCode: "XPAR",
    currency: "EUR", providerSymbol: "SAN.PA", yahooSymbol: "SAN.PA",
  });
  assert.equal(identity.isin, null);
  assert.equal(identity.confidence, "ambiguous");
  assert.equal(identity.reason, "known_incorrect_sanofi_isin");
});

test("cache automatique puis cours manuel sont conservés et comptabilisés", async () => {
  const automatic = asset({
    id: "auto", instrumentKey: "tkr:AUTO", name: "Auto",
    lastQuote: {
      provider: "eodhd", provider_symbol: "AUTO.PA", price: 42, currency: "EUR",
      quoted_at: "2026-07-20T00:00:00.000Z", market_status: "closed",
      data_delay_minutes: null, fetched_at: "2026-07-20T01:00:00.000Z", raw_metadata: {},
    },
  });
  const manual = asset({
    id: "manual", instrumentKey: "tkr:MANUAL", name: "Manual", lastQuote: null,
    manualPrice: { price: 17.5, priceAt: "2026-06-30T00:00:00.000Z", currency: "EUR" },
  });
  const report = await syncMarketData([automatic, manual], { dependencies: dependencies({
    primary: { getQuote: async () => { throw new MarketProviderError("unavailable", "down"); }, getDividends: async () => [] },
    fallback: { getQuote: async () => { throw new MarketProviderError("not_found", "missing"); }, getDividends: async () => [] },
  }) });
  assert.deepEqual(report.preserved, { total: 2, automaticCache: 1, manualHoldingPrice: 1 });
  assert.deepEqual(report.results.map((row) => row.status), ["preserved", "preserved"]);
});

test("une position sans identité et sans cours est unresolved", async () => {
  const report = await syncMarketData([asset({
    instrumentKey: "name:inconnu", name: "Inconnu", isin: null, ticker: null,
    providerSymbol: null, yahooSymbol: null, confidence: "unresolved",
  })], { dependencies: dependencies() });
  assert.equal(report.unresolved, 1);
  assert.equal(report.results[0].reason, "missing_market_identity");
});

test("l'échec d'une position n'interrompt pas les suivantes et les compteurs restent cohérents", async () => {
  const report = await syncMarketData([
    asset({ id: "bad", instrumentKey: "tkr:BAD", ticker: "BAD", providerSymbol: "BAD.PA", yahooSymbol: "BAD.PA" }),
    asset({ id: "good", instrumentKey: "tkr:GOOD", ticker: "GOOD", providerSymbol: "GOOD.PA", yahooSymbol: "GOOD.PA" }),
  ], { dependencies: dependencies({
    primary: { getQuote: async () => { throw new MarketProviderError("http_error", "down"); }, getDividends: async () => [] },
    fallback: {
      getQuote: async (item) => {
        if (item.ticker === "BAD") throw new MarketProviderError("http_error", "down");
        return quote("yahoo", item.yahooSymbol);
      },
      getDividends: async () => [],
    },
  }) });
  assert.deepEqual({
    total: report.total, updated: report.updated, preserved: report.preserved.total,
    unresolved: report.unresolved, failed: report.failed, skipped: report.skipped,
    resultCount: report.results.length,
  }, { total: 2, updated: 1, preserved: 0, unresolved: 0, failed: 1, skipped: 0, resultCount: 2 });
});

test("les dividendes sont appelés après toutes les quotes", async () => {
  const order = [];
  const provider = {
    getQuote: async (item) => { order.push(`quote:${item.ticker}`); return quote("eodhd", item.providerSymbol); },
    getDividends: async (item) => { order.push(`dividend:${item.ticker}`); return []; },
  };
  await syncMarketData([
    asset({ id: "a", instrumentKey: "tkr:A", ticker: "A", providerSymbol: "A.PA" }),
    asset({ id: "b", instrumentKey: "tkr:B", ticker: "B", providerSymbol: "B.PA" }),
  ], { includeCorporateActions: true, dependencies: dependencies({ primary: provider }) });
  assert.deepEqual(order, ["quote:A", "quote:B", "dividend:A", "dividend:B"]);
});

test("contrat complet simulé : EODHD, deux Yahoo, deux conservés et un non résolu", async () => {
  const today = new Date().toISOString();
  const items = [
    asset({ id: "primary", instrumentKey: "tkr:PRIMARY", ticker: "PRIMARY", providerSymbol: "PRIMARY.PA", yahooSymbol: "PRIMARY.PA" }),
    asset({ id: "sanofi", instrumentKey: "isin:FR0000120578" }),
    asset({ id: "wpea", instrumentKey: "isin:IE0002XZSHO1", name: "WPEA", isin: "IE0002XZSHO1", ticker: "WPEA", providerSymbol: "WPEA.PA", yahooSymbol: "WPEA.PA" }),
    asset({
      id: "cached", instrumentKey: "tkr:CACHED", ticker: "CACHED", providerSymbol: "CACHED.PA", yahooSymbol: "CACHED.PA",
      lastQuote: {
        provider: "eodhd", provider_symbol: "CACHED.PA", price: 40, currency: "EUR",
        quoted_at: today, market_status: "closed", data_delay_minutes: null,
        fetched_at: today, raw_metadata: {},
      },
    }),
    asset({
      id: "manual", instrumentKey: "tkr:MANUAL", ticker: "MANUAL", providerSymbol: "MANUAL.PA", yahooSymbol: "MANUAL.PA",
      manualPrice: { price: 25, priceAt: "2026-07-01T00:00:00.000Z", currency: "EUR" },
    }),
    asset({
      id: "unknown", instrumentKey: "name:unknown", name: "Unknown", isin: null,
      ticker: null, providerSymbol: null, yahooSymbol: null, confidence: "unresolved",
    }),
  ];
  const report = await syncMarketData(items, { dependencies: dependencies({
    primary: {
      getQuote: async (item) => {
        if (item.ticker === "PRIMARY") return quote("eodhd", item.providerSymbol, 90);
        throw new MarketProviderError("not_found", "missing");
      },
      getDividends: async () => [],
    },
    fallback: {
      getQuote: async (item) => {
        if (item.ticker === "MANUAL") throw new MarketProviderError("not_found", "missing");
        return quote("yahoo", item.yahooSymbol, item.ticker === "SAN" ? 76.07 : 5.5);
      },
      getDividends: async () => [],
    },
  }) });
  assert.deepEqual({
    total: report.total,
    updated: report.updated,
    preserved: report.preserved,
    unresolved: report.unresolved,
    failed: report.failed,
    skipped: report.skipped,
  }, {
    total: 6,
    updated: 3,
    preserved: { total: 2, automaticCache: 1, manualHoldingPrice: 1 },
    unresolved: 1,
    failed: 0,
    skipped: 0,
  });
  assert.equal(report.results.length, 6);
  assert.ok(report.results.every((row) => row.price === null || row.price > 0));
});
