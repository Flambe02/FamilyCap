import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { EodhdProvider, MarketProviderError, YahooFinanceProvider, getQuoteFromProviders, quoteFreshness } from "../lib/market-data.ts";
import { resolveMarketIdentity } from "../lib/market-identity.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; delete process.env.EODHD_API_TOKEN; delete process.env.ENABLE_EXPERIMENTAL_YAHOO_PROVIDER; });

test("EODHD normalise une dernière clôture sans la présenter comme temps réel", async () => {
  process.env.EODHD_API_TOKEN = "server-only-test-token";
  globalThis.fetch = async () => new Response(JSON.stringify([{ date: "2026-07-24", close: 178.3, adjusted_close: 178.3 }]), { status: 200 });
  const quote = await new EodhdProvider().getQuote({ name: "Actif", providerSymbol: "AIR.PA", currency: "EUR" });
  assert.equal(quote.provider, "eodhd"); assert.equal(quote.quoteMode, "eod"); assert.equal(quote.marketStatus, "closed");
  assert.equal(quote.price, 178.3); assert.equal(quote.quotedAt, "2026-07-24T00:00:00.000Z");
});

test("EODHD normalise les annonces de dividendes de manière idempotente", async () => {
  process.env.EODHD_API_TOKEN = "server-only-test-token";
  globalThis.fetch = async () => new Response(JSON.stringify([{ date: "2026-08-10", declarationDate: "2026-07-20", recordDate: "2026-08-11", paymentDate: "2026-08-20", value: "1.25", currency: "EUR" }]), { status: 200 });
  const events = await new EodhdProvider().getDividends({ name: "Actif", providerSymbol: "AIR.PA", currency: "EUR" }, "2026-01-01", "2026-12-31");
  assert.equal(events.length, 1); assert.equal(events[0].providerEventId, "2026-08-10"); assert.equal(events[0].amountPerShare, 1.25); assert.equal(events[0].paymentDate, "2026-08-20");
});

test("un cache manuel ou ancien reste explicitement distingué", () => {
  assert.equal(quoteFreshness({ provider: "manual", quoteMode: "manual" }), "manual");
  assert.equal(quoteFreshness({ fetchedAt: "2020-01-01T00:00:00Z", quoteMode: "eod" }), "stale");
  assert.equal(quoteFreshness({ quoteMode: "eod" }), "unavailable");
});

test("Air Liquide est résolue par ISIN sans dépendre d'un fournisseur", () => {
  const asset = resolveMarketIdentity({ name: "AIR LIQUIDE FP28", isin: "FR0000120073", assetType: "other" });
  assert.equal(asset.assetType, "stock");
  assert.equal(asset.providerSymbol, "AI.PA");
  assert.equal(asset.yahooSymbol, "AI.PA");
  assert.equal(asset.classificationStatus, "inferred");
});

test("un quota EODHD bascule vers le secours sans modifier la classification", async () => {
  let eodCalls = 0; let yahooCalls = 0;
  const primary = { getQuote: async () => { eodCalls++; throw new MarketProviderError("rate_limited", "quota"); }, getDividends: async () => [] };
  const fallback = { getQuote: async () => { yahooCalls++; return { provider: "yahoo", providerSymbol: "AI.PA", price: 175, currency: "EUR", quotedAt: "2026-07-23T00:00:00.000Z", marketStatus: "unknown", dataDelayMinutes: null, quoteMode: "delayed", rawMetadata: {} }; }, getDividends: async () => [] };
  const asset = { name: "Air Liquide", isin: "FR0000120073", assetType: "stock", providerSymbol: "AI.PA", yahooSymbol: "AI.PA", currency: "EUR" };
  const result = await getQuoteFromProviders(asset, primary, fallback);
  assert.equal(result.source, "fallback"); assert.equal(eodCalls, 1); assert.equal(yahooCalls, 1); assert.equal(asset.assetType, "stock");
});

test("Yahoo normalise un cours serveur avec sa date et rejette une devise incohérente", async () => {
  process.env.ENABLE_EXPERIMENTAL_YAHOO_PROVIDER = "true";
  globalThis.fetch = async () => new Response(JSON.stringify({ chart: { result: [{ meta: { symbol: "AI.PA", regularMarketPrice: 175, currency: "EUR", regularMarketTime: 1784764800, fullExchangeName: "Paris" } }] } }), { status: 200 });
  const quote = await new YahooFinanceProvider().getQuote({ name: "Air Liquide", yahooSymbol: "AI.PA", currency: "EUR" });
  assert.equal(quote.provider, "yahoo"); assert.equal(quote.providerSymbol, "AI.PA"); assert.equal(quote.currency, "EUR");
  await assert.rejects(() => new YahooFinanceProvider().getQuote({ name: "Air Liquide", yahooSymbol: "AI.PA", currency: "USD" }), /currency/i);
});
