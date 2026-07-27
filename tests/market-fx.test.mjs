// Taux de change : le portefeuille cesse d'être valorisé dès qu'un taux manque, et se met à
// mentir si un taux faux est accepté. Ces tests couvrent donc surtout les REFUS.

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { fetchFxRate, isRateFreshToday, isUsableRate, normaliseCurrency, parseFrankfurter, parseYahooFx } from "../lib/market-fx.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const json = (payload) => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });

test("normalise une devise et rejette tout ce qui n’est pas un code ISO à trois lettres", () => {
  assert.equal(normaliseCurrency(" usd "), "USD");
  assert.equal(normaliseCurrency("eur"), "EUR");
  assert.equal(normaliseCurrency("US"), null);
  assert.equal(normaliseCurrency("USDT"), null);
  assert.equal(normaliseCurrency(null), null);
});

test("un taux inexploitable n’est jamais accepté", () => {
  assert.equal(isUsableRate(0.879), true);
  assert.equal(isUsableRate(0), false);       // un taux nul annulerait la valeur du portefeuille
  assert.equal(isUsableRate(-1), false);
  assert.equal(isUsableRate("abc"), false);
  assert.equal(isUsableRate(null), false);
  assert.equal(isUsableRate(Infinity), false);
});

test("Frankfurter : taux BCE daté, converti en horodatage ISO", () => {
  const rate = parseFrankfurter({ amount: 1, base: "USD", date: "2026-07-24", rates: { EUR: 0.87897 } }, "USD", "EUR");
  assert.equal(rate.rate, 0.87897);
  assert.equal(rate.quotedAt, "2026-07-24T00:00:00.000Z");
  assert.equal(rate.baseCurrency, "USD");
  assert.equal(rate.quoteCurrency, "EUR");
  assert.match(rate.provider, /BCE/);
});

test("Frankfurter : une réponse portant sur une AUTRE base est rejetée", () => {
  // Sans ce contrôle, un taux GBP→EUR serait appliqué à des positions en USD.
  assert.equal(parseFrankfurter({ base: "GBP", date: "2026-07-24", rates: { EUR: 1.15 } }, "USD", "EUR"), null);
  assert.equal(parseFrankfurter({ base: "USD", date: "2026-07-24", rates: { CHF: 0.88 } }, "USD", "EUR"), null);
  assert.equal(parseFrankfurter(null, "USD", "EUR"), null);
});

test("Yahoo : la paire et la devise cible doivent toutes deux correspondre", () => {
  const meta = { symbol: "USDEUR=X", currency: "EUR", regularMarketPrice: 0.8776, regularMarketTime: 1785109943 };
  const rate = parseYahooFx({ chart: { result: [{ meta }] } }, "USD", "EUR");
  assert.equal(rate.rate, 0.8776);
  assert.equal(rate.quotedAt, new Date(1785109943 * 1000).toISOString());

  assert.equal(parseYahooFx({ chart: { result: [{ meta: { ...meta, symbol: "USDCHF=X" } }] } }, "USD", "EUR"), null);
  assert.equal(parseYahooFx({ chart: { result: [{ meta: { ...meta, currency: "CHF" } }] } }, "USD", "EUR"), null);
  assert.equal(parseYahooFx({ chart: { result: [{ meta: { ...meta, regularMarketPrice: 0 } }] } }, "USD", "EUR"), null);
  assert.equal(parseYahooFx({ chart: { result: [] } }, "USD", "EUR"), null);
});

test("une paire identique vaut 1 sans appel réseau", async () => {
  globalThis.fetch = async () => { throw new Error("aucun appel réseau ne doit avoir lieu"); };
  const outcome = await fetchFxRate("EUR", "eur");
  assert.equal(outcome.ok, true);
  assert.equal(outcome.rate.rate, 1);
});

test("Yahoo prend le relais quand la BCE ne répond pas", async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes("frankfurter")) return new Response("", { status: 503 });
    return json({ chart: { result: [{ meta: { symbol: "USDEUR=X", currency: "EUR", regularMarketPrice: 0.8776, regularMarketTime: 1785109943 } }] } });
  };
  const outcome = await fetchFxRate("USD", "EUR");
  assert.equal(outcome.ok, true);
  assert.equal(outcome.rate.provider, "Yahoo Finance");
  assert.equal(outcome.rate.rate, 0.8776);
});

test("deux fournisseurs muets ⇒ échec explicite, jamais un taux inventé", async () => {
  globalThis.fetch = async () => new Response("", { status: 500 });
  const outcome = await fetchFxRate("USD", "EUR");
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /USD→EUR/);
  assert.equal(outcome.rate, undefined);
});

test("un code devise invalide échoue avant tout appel réseau", async () => {
  globalThis.fetch = async () => { throw new Error("aucun appel réseau ne doit avoir lieu"); };
  const outcome = await fetchFxRate("US", "EUR");
  assert.equal(outcome.ok, false);
});

test("le cache du jour se juge sur la date de cotation, pas sur l’heure", () => {
  assert.equal(isRateFreshToday("2026-07-24T00:00:00.000Z", "2026-07-24"), true);
  assert.equal(isRateFreshToday("2026-07-23T23:59:59.000Z", "2026-07-24"), false);
  assert.equal(isRateFreshToday(null, "2026-07-24"), false);
});
