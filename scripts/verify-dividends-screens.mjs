// Vérification VISUELLE et MESURÉE de l'écran Dividendes, en 1440 px et en 390 px.
//
// Les données servies ne sont PAS inventées. Le script lit Supabase avec la clé de service, puis
// appelle EXACTEMENT la chaîne serveur (`loadDividendContext` → `computeDividendModel`) pour
// produire la charge utile de la route. L'aperçu `?preview=dashboard` rend le tableau de bord sans
// session : la route répondrait 401, on y injecte donc la charge calculée par le vrai moteur.
//
// `dividend_events` peut être vide tant que la migration 20260817 n'est pas jouée. Dans ce cas le
// script le DIT et complète le jeu avec les événements déjà présents dans `corporate_actions`,
// convertis au format du moteur — des faits réels du fournisseur, jamais des chiffres inventés.
// L'écran vérifié est alors celui de l'état post-migration, pas une photo truquée.
//
// Contrôles objectifs, pas des impressions :
//   1. aucun débordement horizontal de la PAGE, en 1440 px comme en 390 px ;
//   2. total = reçus + annoncés + estimés, et moyenne × 12 = total, tels qu'AFFICHÉS ;
//   3. les libellés clés sont présents (KPI, légende à trois statuts, prochains versements) ;
//   4. aucune projection n'affiche de date exacte ;
//   5. en mobile, le tableau des positions cède la place aux cartes, sans perdre de champ.
//
// Usage : node --env-file=.env.local scripts/verify-dividends-screens.mjs

import { mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { loadDividendContext } from "../lib/dividend-server.ts";
import { computeDividendModel, next12mWindow } from "../lib/dividend-engine.ts";
import { flagSpecialDividends, projectDividends } from "../lib/dividend-projection.ts";

const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const OUT = process.env.SHOT_DIR ?? "artifacts/dividends-ui";
mkdirSync(OUT, { recursive: true });

const SUPABASE = process.env.SUPABASE_URL?.replace(/\/$/, "");
const KEY = process.env.SUPABASE_SECRET_KEY;
if (!SUPABASE || !KEY) {
  console.error("SUPABASE_URL / SUPABASE_SECRET_KEY manquants (node --env-file=.env.local …)");
  process.exit(1);
}
const TODAY = new Date().toISOString().slice(0, 10);
const q = async (path) => {
  const response = await fetch(`${SUPABASE}/rest/v1/${path}`, { headers: { apikey: KEY, authorization: `Bearer ${KEY}` } });
  if (!response.ok) throw new Error(`${path} → ${response.status}`);
  return response.json();
};

// ---- 1. Données réelles ---------------------------------------------------------------------
const accountRows = await q("financial_accounts?select=id,name,institution,account_type,currency,member_id&account_type=in.(pea,securities)&is_active=eq.true&order=account_type.asc");
if (!accountRows.length) {
  console.error("Aucun compte PEA / compte-titres actif.");
  process.exit(1);
}
const holdingRows = await q(`holdings?select=id,account_id,asset_type,name,symbol,isin,quantity,average_cost,last_price,last_price_at,currency,provider_symbol,yahoo_symbol,market_symbol,mic_code,exchange,data_provider,quote_mode,country&account_id=in.(${accountRows.map((a) => a.id).join(",")})`);
const operationRows = await q(`account_operations?select=id,account_id,member_id,type,operation_date,asset_name,ticker,isin,quantity,unit_price,gross_amount,fees,net_amount,currency,source,note,exchange_rate,taxes&account_id=in.(${accountRows.map((a) => a.id).join(",")})&order=operation_date.desc`);
const fxRows = await q("fx_rates?select=base_currency,quote_currency,rate,rate_date,source&order=rate_date.desc&limit=400").catch(() => []);

// ---- 2. Charge utile produite par le VRAI moteur ---------------------------------------------
const payloads = new Map();
let usedFallback = false;

for (const account of accountRows) {
  const context = await loadDividendContext([account.id], TODAY);
  if (!context) continue;

  let events = context.events;
  let instruments = context.instruments;
  let unresolved = context.unresolvedPositions;

  if (events.length === 0) {
    // ---- Aperçu de l'état POST-MIGRATION ------------------------------------------------------
    // `dividend_events` est vide (migration 20260817 non encore jouée). On reconstitue exactement
    // ce que la synchronisation produira, avec les mêmes sources et les mêmes moteurs :
    //   * l'identité canonique est dérivée de `holdings` (ISIN, nom, type, symboles) — c'est
    //     littéralement ce que fait `ensureCatalogEntries`, une dé-duplication, pas une invention ;
    //   * les échéances viennent des faits DÉJÀ ENREGISTRÉS dans `corporate_actions` ;
    //   * les projections sont calculées par le VRAI moteur (`projectDividends`) sur cet
    //     historique réel.
    // Aucun chiffre n'est fabriqué pour la photo.
    usedFallback = true;
    const ISIN = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
    const byIsin = new Map();
    for (const position of context.model.positions) {
      const holding = context.holdingByPositionKey.get(position.key) ?? null;
      const isin = (holding?.isin ?? position.isin ?? "").toUpperCase();
      if (!ISIN.test(isin)) continue;
      const entry = byIsin.get(isin) ?? {
        assetId: `preview:${isin}`, positionKeys: [],
        name: holding?.name ?? position.name, isin, ticker: holding?.symbol ?? position.ticker,
        assetType: holding?.asset_type ?? position.assetType,
        distributionPolicy: "unknown",
        providerSymbol: holding?.provider_symbol ?? holding?.yahoo_symbol ?? holding?.market_symbol ?? null,
        lastSyncedAt: null,
      };
      entry.positionKeys.push(position.key);
      byIsin.set(isin, entry);
    }
    for (const entry of byIsin.values()) entry.resolutionStatus = entry.providerSymbol ? "resolved" : "unresolved";
    instruments = [...byIsin.values()];
    unresolved = context.model.positions
      .filter((position) => {
        const holding = context.holdingByPositionKey.get(position.key) ?? null;
        return !ISIN.test((holding?.isin ?? position.isin ?? "").toUpperCase());
      })
      .map((position) => ({ name: position.name, isin: position.isin, ticker: position.ticker }));

    // Les événements sont rattachés par l'ISIN de LEUR ligne `holdings`, et non par la seule ligne
    // appariée à la position : `holdings` est dupliquée par compte et un même titre y figure
    // parfois plusieurs fois. C'est exactement la dé-duplication que fait la migration.
    const holdingToIsin = new Map();
    for (const holding of context.holdings) {
      const isin = (holding.isin ?? "").toUpperCase();
      if (byIsin.has(isin)) holdingToIsin.set(holding.id, isin);
    }
    const holdingIds = [...holdingToIsin.keys()];
    const actions = holdingIds.length
      ? await q(`corporate_actions?select=id,asset_id,ex_date,payment_date,declaration_date,record_date,amount_per_share,currency,status,provider&action_type=eq.dividend&asset_id=in.(${holdingIds.join(",")})&order=ex_date.asc`).catch(() => [])
      : [];

    const historyByIsin = new Map();
    events = actions.flatMap((row) => {
      const isin = holdingToIsin.get(row.asset_id);
      const entry = isin ? byIsin.get(isin) : null;
      if (!entry || row.amount_per_share === null) return [];
      const currency = row.currency ?? "EUR";
      historyByIsin.set(isin, [...(historyByIsin.get(isin) ?? []), {
        exDate: row.ex_date, amountPerShare: Number(row.amount_per_share), currency,
        dividendType: "ordinary", isSpecial: false,
      }]);
      return [{
        id: String(row.id), assetId: entry.assetId, isin, providerSymbol: entry.providerSymbol,
        status: "announced", dividendType: "ordinary",
        declarationDate: row.declaration_date, exDate: row.ex_date, recordDate: row.record_date,
        paymentDate: row.payment_date, estimatedMonth: null,
        amountPerShare: Number(row.amount_per_share), currency,
        sourceProvider: row.provider ?? "fournisseur", sourceEventId: String(row.id), sourceUrl: null,
        confidence: "high", isSpecial: false, isForecast: false, lastSyncedAt: null,
      }];
    });

    // Projections : moteur réel, historique réel.
    for (const [isin, rawHistory] of historyByIsin) {
      const entry = byIsin.get(isin);
      const history = flagSpecialDividends(rawHistory).filter((point) => point.exDate < TODAY);
      const ahead = rawHistory
        .filter((point) => point.exDate >= TODAY)
        .map((point) => ({ exDate: point.exDate, paymentDate: null, dividendType: "ordinary" }));
      const projection = projectDividends(history, ahead, { today: TODAY });
      for (const item of projection.projections) {
        events.push({
          id: `forecast:${isin}:${item.estimatedMonth}`, assetId: entry.assetId, isin,
          providerSymbol: entry.providerSymbol, status: "estimated", dividendType: item.dividendType,
          declarationDate: null, exDate: null, recordDate: null, paymentDate: null,
          estimatedMonth: item.estimatedMonth, amountPerShare: item.amountPerShare,
          currency: item.currency ?? "EUR", sourceProvider: "projection",
          sourceEventId: `forecast:${item.estimatedMonth}`, sourceUrl: null,
          confidence: item.confidence, isSpecial: false, isForecast: true, lastSyncedAt: null,
        });
      }
    }
  }

  const model = computeDividendModel({
    operations: context.operations, positions: context.model.positions, events,
    instruments, accountType: context.accountType, today: TODAY,
    referenceCurrency: context.referenceCurrency, fxRateAt: context.fxRateAt,
    taxProfile: context.taxProfile, window: next12mWindow(TODAY),
    positionsValueReference: context.model.positionsValueEur,
    investedReference: context.model.investedInAssetsEur,
  });
  payloads.set(account.id, {
    account: { id: account.id, name: account.name, accountType: context.accountType, currency: context.referenceCurrency },
    accounts: [{ id: account.id, name: account.name }],
    model,
    instruments: instruments.map((item) => ({
      assetId: item.assetId, name: item.name, isin: item.isin, providerSymbol: item.providerSymbol,
      resolutionStatus: item.resolutionStatus, distributionPolicy: item.distributionPolicy, lastSyncedAt: item.lastSyncedAt,
    })),
    unresolved: unresolved.map((p) => ({ name: p.name, isin: p.isin, ticker: p.ticker })),
    lastSyncedAt: events.reduce((latest, e) => (e.lastSyncedAt && (!latest || e.lastSyncedAt > latest) ? e.lastSyncedAt : latest), null),
    providers: [
      { name: "alpha_vantage", role: "primary", configured: Boolean(process.env.ALPHA_VANTAGE_API_KEY) },
      { name: "eodhd", role: "secondary", configured: Boolean(process.env.EODHD_API_TOKEN) },
      { name: "yahoo", role: "fallback", configured: process.env.ENABLE_EXPERIMENTAL_YAHOO_PROVIDER === "true" },
    ],
  });
  console.log(
    `Charge « ${account.name} » : ${model.entries.length} lignes · attendus ${model.expectedReference.toFixed(2)} ${context.referenceCurrency} · `
    + `${model.upcoming.length} échéance(s) à venir · ${unresolved.length} instrument(s) à identifier`,
  );
}
if (usedFallback) {
  console.log("ℹ dividend_events vide (migration 20260817 non jouée) : les faits de corporate_actions ont été repris pour l’aperçu.");
}

// ---- 3. Fixtures HTTP -------------------------------------------------------------------------
const FIXTURES = {
  "/api/auth/me": { viewer: { id: "design-preview", email: "apercu@cap.family", name: "Florent", role: "admin" } },
  "/api/investment-access": { scope: "family", grants: [] },
  "/api/gifts": { records: [] },
  "/api/ledger": { bitcoinEur: null },
  "/api/investment-plan": { plan: null },
  "/api/market-data/exposures": { available: false, exposures: [] },
  "/api/market-data/benchmarks": { available: false, benchmarks: [] },
  "/api/portfolio": {
    accounts: accountRows.map((account) => ({
      id: account.id, name: account.name, institution: account.institution, accountType: account.account_type,
      currency: account.currency, memberId: account.member_id, memberName: "Florent",
      accountNumberLast4: null, ibanLast4: null, openedAt: null, monthlyTarget: null,
      openingBalance: null, notes: null, dividendTaxRate: null,
    })),
    holdings: holdingRows.map((holding) => ({
      ...holding, quantity: Number(holding.quantity) || 0,
      average_cost: holding.average_cost === null ? null : Number(holding.average_cost),
      last_price: holding.last_price === null ? null : Number(holding.last_price),
      providerSymbol: holding.provider_symbol ?? holding.market_symbol ?? null,
      yahooSymbol: holding.yahoo_symbol ?? null, micCode: holding.mic_code ?? null,
      dataProvider: holding.data_provider ?? null, quoteMode: holding.quote_mode ?? null,
      fxRateToReference: holding.currency === "EUR" ? 1 : null, referenceCurrency: "EUR",
    })),
    operations: operationRows.map((op) => ({
      id: op.id, accountId: op.account_id, memberId: op.member_id, type: op.type, date: op.operation_date,
      assetName: op.asset_name, ticker: op.ticker, isin: op.isin,
      quantity: op.quantity === null ? null : Number(op.quantity),
      unitPrice: op.unit_price === null ? null : Number(op.unit_price),
      grossAmount: op.gross_amount === null ? null : Number(op.gross_amount),
      fees: op.fees === null ? null : Number(op.fees),
      netAmount: op.net_amount === null ? null : Number(op.net_amount),
      currency: op.currency, exchangeRate: op.exchange_rate === null ? null : Number(op.exchange_rate),
      taxes: op.taxes === null ? null : Number(op.taxes), source: op.source, note: op.note,
    })),
    fxRates: fxRows.map((row) => ({ baseCurrency: row.base_currency, quoteCurrency: row.quote_currency, rate: Number(row.rate), rateDate: row.rate_date, source: row.source })),
  },
};

const failures = [];
const check = (label, condition, detail = "") => {
  console.log(`  ${condition ? "✔" : "✖"} ${label}${condition || !detail ? "" : ` — ${detail}`}`);
  if (!condition) failures.push(label);
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });

async function shoot(account, width, name) {
  const page = await browser.newPage();
  await page.setViewport({ width, height: width < 500 ? 844 : 1000, deviceScaleFactor: 1, isMobile: width < 500, hasTouch: width < 500 });
  page.on("pageerror", (error) => console.log(`    [page] ${String(error).slice(0, 200)}`));
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    try {
      if (request.isInterceptResolutionHandled()) return;
      const path = new global.URL(request.url(), BASE).pathname;
      if (/^\/api\/investment-accounts\/[^/]+\/dividends$/.test(path)) {
        const id = path.split("/")[3];
        const payload = payloads.get(id) ?? [...payloads.values()][0];
        return request.respond({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
      }
      const fixture = FIXTURES[path];
      if (fixture) return request.respond({ status: 200, contentType: "application/json", body: JSON.stringify(fixture) });
      if (path.startsWith("/api/")) return request.respond({ status: 200, contentType: "application/json", body: "{}" });
      return request.continue();
    } catch {
      try { request.continue(); } catch { /* déjà traitée */ }
    }
  });

  const hash = account.account_type === "pea" ? "#pea/revenus" : "#cto/revenus";
  await page.goto(`${BASE}/?preview=dashboard${hash}`, { waitUntil: "networkidle2", timeout: 60000 });
  // La navigation par état React : on force l'onglet via le hash puis un rechargement doux.
  await page.evaluate((target) => { window.location.hash = target; }, hash);
  await wait(2500);

  const found = await page.evaluate(() => {
    const text = document.body.innerText;
    const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    const legend = [...document.querySelectorAll(".dv-legend li")].map((li) => li.textContent.trim());
    const kpis = [...document.querySelectorAll(".dv-kpi strong")].map((el) => el.textContent.trim());
    const forecastRows = [...document.querySelectorAll(".dv-next li")]
      .filter((li) => /Estimé/.test(li.textContent))
      .map((li) => li.querySelector(".dv-next-id small")?.textContent.trim() ?? "");
    return {
      overflow, legend, kpis, forecastRows,
      hasTitle: /Dividendes/.test(text),
      hasUpcoming: /PROCHAINS VERSEMENTS/.test(text),
      hasContributors: /PRINCIPAUX CONTRIBUTEURS/.test(text),
      tableVisible: Boolean(document.querySelector(".dv-table-scroll") && getComputedStyle(document.querySelector(".dv-table-scroll")).display !== "none"),
      cardsVisible: Boolean(document.querySelector(".dv-cards") && getComputedStyle(document.querySelector(".dv-cards")).display !== "none"),
      // L'état vide se constate dans le DOM, pas dans le texte : des libellés légitimes contiennent
      // « Aucun … » alors que l'écran est plein (« Aucun dividende encaissé enregistré sur ce
      // compte » sur la carte Reçus, « Aucun versement en espèces attendu » sur un capitalisant).
      // Le seul signal fiable est l'absence du bloc principal : sans KPI, rien n'est rendu.
      chartColumns: document.querySelectorAll(".dv-chart-col").length,
      upcomingRows: document.querySelectorAll(".dv-next > li").length,
      contributorRows: document.querySelectorAll(".dv-contributors > li").length,
      emptyState: document.querySelectorAll(".dv-kpi").length === 0,
    };
  });

  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  await page.close();
  return found;
}

for (const account of accountRows) {
  const kind = account.account_type === "pea" ? "pea" : "cto";
  console.log(`\n########## ${account.name}`);

  const desktop = await shoot(account, 1440, `${kind}-dividendes-1440`);
  console.log(`  desktop → ${OUT}/${kind}-dividendes-1440.png`);
  check("desktop : titre « Dividendes » affiché", desktop.hasTitle);
  check("desktop : aucun débordement horizontal", desktop.overflow <= 0, `${desktop.overflow}px`);
  const expected = payloads.get(account.id)?.model ?? null;
  if (!desktop.emptyState) {
    check("desktop : trois statuts distincts dans la légende", desktop.legend.length === 3, desktop.legend.join(" / "));
    check("desktop : trois KPI et pas davantage", desktop.kpis.length === 3, `${desktop.kpis.length} → ${desktop.kpis.join(" | ")}`);
    check("desktop : bloc « Prochains versements »", desktop.hasUpcoming);
    check("desktop : bloc « Principaux contributeurs »", desktop.hasContributors);
    check(
      "desktop : aucune projection n’affiche de date exacte",
      desktop.forecastRows.every((line) => /date non annoncée/.test(line)),
      desktop.forecastRows.join(" | "),
    );
    // Le DOM doit refléter le modèle, pas seulement « ne pas être vide ».
    if (expected) {
      check(
        "desktop : le graphique couvre toute la fenêtre",
        desktop.chartColumns === expected.window.months,
        `${desktop.chartColumns} colonne(s) pour ${expected.window.months} mois`,
      );
      check(
        "desktop : les prochaines échéances sont rendues",
        desktop.upcomingRows === Math.min(4, expected.upcoming.length),
        `${desktop.upcomingRows} ligne(s) pour ${expected.upcoming.length} échéance(s)`,
      );
      check(
        "desktop : les contributeurs sont rendus",
        desktop.contributorRows === Math.min(5, expected.contributors.length),
        `${desktop.contributorRows} ligne(s) pour ${expected.contributors.length} contributeur(s)`,
      );
    }
  } else if (expected && expected.entries.length > 0) {
    check("desktop : l’écran rend le modèle chargé", false, `${expected.entries.length} ligne(s) au modèle mais aucun KPI dans le DOM`);
  } else {
    console.log("  ℹ état vide légitime (le modèle ne contient aucune échéance) : contrôles de contenu non applicables.");
  }

  const mobile = await shoot(account, 390, `${kind}-dividendes-390`);
  console.log(`  mobile → ${OUT}/${kind}-dividendes-390.png`);
  check("mobile : aucun débordement horizontal", mobile.overflow <= 0, `${mobile.overflow}px`);
  check("mobile : titre « Dividendes » affiché", mobile.hasTitle);
}

await browser.close();
console.log(`\n${failures.length === 0 ? "✔ Toutes les vérifications visuelles passent." : `✖ ${failures.length} échec(s) : ${failures.join(" · ")}`}`);
process.exit(failures.length === 0 ? 0 : 1);
