import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { EodhdProvider, quoteFreshness } from "../lib/market-data.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; delete process.env.EODHD_API_TOKEN; });

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
