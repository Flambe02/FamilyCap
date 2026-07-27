import { test } from "node:test";
import assert from "node:assert/strict";
import { createMarketRefreshPost } from "../lib/market-refresh-route.ts";

test("la route réelle transmet le compte, retourne le contrat et libère son verrou", async () => {
  const events = [];
  const contract = {
    total: 6, updated: 3,
    preserved: { total: 2, automaticCache: 1, manualHoldingPrice: 1 },
    unresolved: 1, failed: 0, skipped: 0,
    provider: {
      primary: "eodhd", primaryConfigured: true, primaryCircuitOpen: true,
      fallback: "yahoo", fallbackEnabled: true,
    },
    results: [{ instrumentKey: "isin:FR0000120578", name: "Sanofi", status: "updated", provider: "yahoo", symbol: "SAN.PA" }],
  };
  const post = createMarketRefreshPost({
    authorize: async () => { events.push("authorized"); },
    acquireLock: async (accountId) => { events.push(`lock:${accountId}`); return true; },
    releaseLock: async (accountId) => { events.push(`release:${accountId}`); },
    refresh: async (accountId) => {
      events.push(`refresh:${accountId}`);
      return Response.json(contract);
    },
    errorResponse: () => Response.json({ error: "unexpected" }, { status: 500 }),
  });
  const response = await post(new Request("http://localhost/api/market-data/refresh", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId: "pea-1" }),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), contract);
  assert.deepEqual(events, ["authorized", "lock:pea-1", "refresh:pea-1", "release:pea-1"]);
});

test("la route ne libère pas un verrou qu'elle n'a pas acquis", async () => {
  let released = false;
  const post = createMarketRefreshPost({
    authorize: async () => {},
    acquireLock: async () => false,
    releaseLock: async () => { released = true; },
    refresh: async () => Response.json({}),
    errorResponse: () => Response.json({ error: "unexpected" }, { status: 500 }),
  });
  const response = await post(new Request("http://localhost/api/market-data/refresh", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId: "pea-1" }),
  }));
  assert.equal(response.status, 409);
  assert.equal(released, false);
});
