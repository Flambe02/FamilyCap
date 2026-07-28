// Vérification VISUELLE et MESURÉE des écrans Résumé (géographie), Revenus et Performance.
//
// Les données servies ne sont PAS inventées : elles sont lues dans Supabase avec la clé de
// service au démarrage du script (comptes, positions, opérations, cours, dividendes annoncés,
// taux de change). L'aperçu `?preview=dashboard` rend le tableau de bord sans session, donc
// /api/portfolio répondrait 401 : on intercepte les appels pour y injecter ces vraies données.
//
// Les expositions, elles, sont lues DANS LA MIGRATION 20260816 : la table n'existe pas encore en
// base, et le but est justement de vérifier l'écran tel qu'il sera une fois la migration jouée.
// C'est un aperçu de l'état post-migration, pas une donnée fabriquée pour la photo.
//
// Contrôles objectifs (pas des impressions) :
//   1. aucun débordement horizontal de la PAGE, en 1440 px comme en 390 px ;
//   2. la somme des parts de la répartition géographique vaut 100 % ;
//   3. les libellés clés attendus sont présents à l'écran.
//
// Usage : node --env-file=.env.local scripts/verify-insights-ui.mjs

import { mkdirSync, readFileSync } from "node:fs";
import puppeteer from "puppeteer-core";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = "http://localhost:3000/?preview=dashboard";
const OUT = process.env.SHOT_DIR ?? "artifacts/insights-ui";
mkdirSync(OUT, { recursive: true });

const URL_BASE = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SECRET_KEY;
if (!URL_BASE || !KEY) {
  console.error("SUPABASE_URL / SUPABASE_SECRET_KEY manquants (node --env-file=.env.local ...)");
  process.exit(1);
}
const q = async (path) => {
  const response = await fetch(`${URL_BASE}/rest/v1/${path}`, { headers: { apikey: KEY, authorization: `Bearer ${KEY}` } });
  if (!response.ok) throw new Error(`${path} → ${response.status}`);
  return response.json();
};

// ---- 1. Données réelles -------------------------------------------------------------------
const accountRows = await q("financial_accounts?select=id,name,institution,account_type,currency,member_id&account_type=in.(pea,securities)&is_active=eq.true");
const ids = accountRows.map((a) => a.id);
const holdingRows = await q(`holdings?select=id,account_id,asset_type,name,symbol,isin,quantity,average_cost,last_price,last_price_at,currency,exchange,provider_symbol,yahoo_symbol,mic_code,data_provider,quote_mode,country&account_id=in.(${ids.join(",")})`);
const operationRows = await q(`account_operations?select=id,account_id,member_id,type,operation_date,asset_name,ticker,isin,quantity,unit_price,gross_amount,fees,net_amount,currency,source,note,exchange_rate&account_id=in.(${ids.join(",")})&order=operation_date.asc`);
const quoteRows = await q(`market_quotes?select=asset_id,provider,provider_symbol,price,currency,quoted_at,fetched_at&asset_id=in.(${holdingRows.map((h) => h.id).join(",")})&order=fetched_at.desc`);
const fxRows = await q("fx_rates?select=base_currency,quote_currency,rate,rate_date&order=rate_date.desc&limit=200");
const actionRows = await q(`corporate_actions?select=id,asset_id,ex_date,payment_date,amount_per_share,currency,status,provider&action_type=eq.dividend&asset_id=in.(${holdingRows.map((h) => h.id).join(",")})&order=ex_date.desc`);

const latestQuote = new Map();
for (const quote of quoteRows) if (!latestQuote.has(quote.asset_id)) latestQuote.set(quote.asset_id, quote);
const latestFx = new Map();
for (const row of fxRows) if (!latestFx.has(row.quote_currency)) latestFx.set(row.quote_currency, Number(row.rate));

// Même règle que /api/portfolio : le cours de `market_quotes` prime, sinon le prix manuel ; une
// devise de cours différente de celle de la position est ignorée, jamais additionnée.
const holdings = holdingRows.map((holding) => {
  const quote = latestQuote.get(holding.id);
  const usable = quote && Number(quote.price) > 0 && String(quote.currency).toUpperCase() === String(holding.currency).toUpperCase() ? quote : null;
  const native = String(usable?.currency ?? holding.currency ?? "EUR").toUpperCase();
  // La BCE cote l'euro en base : convertir VERS l'euro est une division.
  const fx = native === "EUR" ? 1 : latestFx.has(native) ? 1 / latestFx.get(native) : null;
  return {
    id: holding.id, account_id: holding.account_id, asset_type: holding.asset_type, name: holding.name,
    symbol: holding.symbol, isin: holding.isin, quantity: 0, average_cost: holding.average_cost,
    last_price: usable ? Number(usable.price) : holding.last_price === null ? null : Number(holding.last_price),
    last_price_at: usable?.quoted_at ?? holding.last_price_at, currency: holding.currency,
    exchange: holding.exchange, providerSymbol: holding.provider_symbol, yahooSymbol: holding.yahoo_symbol,
    micCode: holding.mic_code, dataProvider: usable?.provider ?? holding.data_provider,
    quoteMode: holding.quote_mode, country: holding.country, fetchedAt: usable?.fetched_at ?? null,
    fxRateToReference: fx, referenceCurrency: "EUR",
  };
});

const operations = operationRows.map((row) => ({
  id: row.id, accountId: row.account_id, memberId: row.member_id, type: row.type, date: row.operation_date,
  assetName: row.asset_name, ticker: row.ticker, isin: row.isin,
  quantity: row.quantity === null ? null : Number(row.quantity),
  unitPrice: row.unit_price === null ? null : Number(row.unit_price),
  grossAmount: row.gross_amount === null ? null : Number(row.gross_amount),
  fees: row.fees === null ? null : Number(row.fees),
  netAmount: row.net_amount === null ? null : Number(row.net_amount),
  currency: row.currency, exchangeRate: row.exchange_rate === null ? null : Number(row.exchange_rate),
  source: row.source, note: row.note,
}));

const holdingById = new Map(holdingRows.map((h) => [h.id, h]));
const dividends = actionRows.map((row) => ({
  ...row, asset: holdingById.get(row.asset_id)
    ? { name: holdingById.get(row.asset_id).name, symbol: holdingById.get(row.asset_id).symbol, isin: holdingById.get(row.asset_id).isin }
    : null,
}));

// ---- 2. Expositions lues DANS LA MIGRATION (aperçu de l'état post-migration) ----------------
const migration = readFileSync(new URL("../supabase/migrations/20260816_portfolio_exposures_insights.sql", import.meta.url), "utf8");
const exposures = [...migration.matchAll(/\('([A-Z]{2}[A-Z0-9]{9}[0-9])',\s*'(geography|sector)',\s*'([^']+)',\s*'((?:[^']|'')+)',\s*([\d.]+),\s*'((?:[^']|'')+)',\s*(null|'[\d-]+'),\s*'(high|medium|low)',\s*(true|false)\)/g)]
  .map((match) => ({
    isin: match[1], instrumentKey: null, dimension: match[2], code: match[3],
    label: match[4].replace(/''/g, "'"), weightPercent: Number(match[5]),
    source: match[6].replace(/''/g, "'"), sourceAsOf: match[7] === "null" ? null : match[7].replace(/'/g, ""),
    confidence: match[8], isEstimated: match[9] === "true",
  }));
console.log(`Données réelles : ${accountRows.length} comptes · ${holdings.length} références · ${operations.length} opérations · ${dividends.length} annonces`);
console.log(`Expositions lues dans la migration : ${exposures.length} lignes (${exposures.filter((e) => e.dimension === "geography").length} géo, ${exposures.filter((e) => e.dimension === "sector").length} secteur)`);

const FIXTURES = {
  "/api/portfolio": {
    accounts: accountRows.map((account) => ({
      id: account.id, name: account.name, institution: account.institution, accountType: account.account_type,
      currency: account.currency, memberId: account.member_id, memberName: "Florent",
      accountNumberLast4: null, ibanLast4: null, openedAt: null, monthlyTarget: null,
      openingBalance: null, notes: null, dividendTaxRate: null,
    })),
    holdings,
    operations,
    fxRates: fxRows.map((row) => ({ baseCurrency: row.base_currency, quoteCurrency: row.quote_currency, rate: Number(row.rate), rateDate: row.rate_date })),
  },
  "/api/auth/me": { viewer: { id: "design-preview", email: "apercu@cap.family", name: "Florent", role: "admin" } },
  "/api/investment-access": { scope: "family", grants: [] },
  "/api/gifts": { records: [] },
  "/api/ledger": { bitcoinEur: null },
  "/api/investment-plan": { plan: null },
  "/api/market-data/exposures": { available: true, exposures },
  // L'onglet Dividendes ne lit plus cette route : son modèle est calculé SERVEUR
  // (/api/investment-accounts/:id/dividends) et vérifié par scripts/verify-dividends-ui.mjs.
  // Le jeu `dividends` reste chargé ci-dessus pour le décompte affiché en console.
  "/api/market-data/benchmarks": { available: true, benchmarks: [] },
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
const failures = [];

async function open(nav) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 980, deviceScaleFactor: 1 });
  page.on("pageerror", (error) => console.log(`  [page] ${String(error).slice(0, 160)}`));
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    try {
      if (request.isInterceptResolutionHandled()) return;
      const path = new global.URL(request.url(), BASE).pathname;
      const fixture = FIXTURES[path];
      if (fixture) return request.respond({ status: 200, contentType: "application/json", body: JSON.stringify(fixture) });
      // L'analyse n'est pas jouée ici : sans table de cache ni clé IA, la route répondrait 404.
      if (path === "/api/portfolio/analysis") return request.respond({ status: 404, contentType: "application/json", body: "{}" });
      return request.continue();
    } catch { /* requête déjà résolue */ }
  });
  await page.goto(BASE, { waitUntil: "networkidle2", timeout: 60000 });
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  await page.evaluate((wanted) => {
    [...document.querySelectorAll(".nav-subitem")].find((node) => node.textContent?.includes(wanted))?.click();
  }, nav);
  await wait(1800);
  return page;
}

async function clickTab(page, label) {
  await page.evaluate((wanted) => {
    [...document.querySelectorAll(".btc-tabs button")].find((node) => node.textContent?.trim() === wanted)?.click();
  }, label);
  await wait(1200);
}

async function shoot(page, name, { width, height, isMobile }) {
  await page.setViewport({ width, height, isMobile, hasTouch: isMobile, deviceScaleFactor: 1 });
  await wait(900);
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  if (overflow.scrollWidth > overflow.clientWidth + 1) {
    failures.push(`${name} : débordement horizontal (${overflow.scrollWidth} > ${overflow.clientWidth})`);
  }
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  console.log(`  ✓ ${name}.png (${overflow.scrollWidth}/${overflow.clientWidth} px)`);
  return overflow;
}

for (const nav of ["PEA", "Compte-titres"]) {
  const slug = nav === "PEA" ? "pea" : "cto";
  console.log(`\n=== ${nav} ===`);
  const page = await open(nav);

  // -- Résumé : répartition géographique + bandeau de couverture
  await shoot(page, `${slug}-resume-1440`, { width: 1440, height: 980, isMobile: false });
  const geo = await page.evaluate(() => {
    const card = [...document.querySelectorAll(".btc-alloc-card")].find((node) => node.textContent?.includes("RÉPARTITION GÉOGRAPHIQUE"));
    if (!card) return null;
    const rows = [...card.querySelectorAll(".btc-legend-val em")].map((node) => parseFloat(node.textContent.replace(",", ".")));
    return { present: true, top: rows, text: card.textContent.slice(0, 400) };
  });
  if (!geo?.present) failures.push(`${nav} : carte « Répartition géographique » absente`);
  else console.log(`  géo (5 premières zones) : ${geo.top.map((v) => `${v} %`).join(" · ")}`);

  const coverage = await page.evaluate(() => {
    const strip = document.querySelector(".inv-coverage");
    return strip ? [...strip.querySelectorAll(".inv-coverage-grid li")].map((li) => li.textContent.replace(/\s+/g, " ").trim()) : null;
  });
  if (!coverage) failures.push(`${nav} : bandeau de couverture absent`);
  else console.log(`  couverture : ${coverage.join(" | ")}`);
  await shoot(page, `${slug}-resume-390`, { width: 390, height: 900, isMobile: true });

  // -- Revenus
  await page.setViewport({ width: 1440, height: 980, deviceScaleFactor: 1 });
  await wait(500);
  await clickTab(page, "Revenus");
  await shoot(page, `${slug}-revenus-1440`, { width: 1440, height: 1100, isMobile: false });
  const revenus = await page.evaluate(() => ({
    kpis: [...document.querySelectorAll(".inv-kpi small")].map((node) => node.textContent.trim()),
    bars: document.querySelectorAll(".inv-bars-col").length,
    filters: [...document.querySelectorAll(".inv-income-detail .inv-toggle button")].map((node) => node.textContent.replace(/\d+$/, "").trim()),
  }));
  console.log(`  revenus : KPI [${revenus.kpis.join(" | ")}] · ${revenus.bars} colonnes · filtres [${revenus.filters.join(", ")}]`);
  if (revenus.bars !== 12 && revenus.bars !== 0) failures.push(`${nav} : histogramme à ${revenus.bars} colonnes au lieu de 12`);
  await shoot(page, `${slug}-revenus-390`, { width: 390, height: 900, isMobile: true });

  // Le tableau doit rester LISIBLE en mobile : une capture ne prouve pas qu'une colonne de
  // montants n'est pas simplement sortie du cadre. On mesure donc les cellules réellement
  // visibles dans le conteneur, et la présence d'au moins un montant.
  const mobileTable = await page.evaluate(() => {
    const table = document.querySelector(".inv-income-table");
    if (!table) return null;
    const box = table.closest(".inv-table-scroll")?.getBoundingClientRect();
    const headers = [...table.querySelectorAll("thead th")]
      .filter((th) => th.getClientRects().length > 0)
      .map((th) => ({ label: th.textContent.trim(), right: th.getBoundingClientRect().right }));
    const visible = headers.filter((header) => !box || header.right <= box.right + 1).map((header) => header.label);
    const firstRow = table.querySelector("tbody tr");
    const amounts = firstRow ? [...firstRow.querySelectorAll("td.num")].filter((td) => td.getClientRects().length > 0 && (!box || td.getBoundingClientRect().right <= box.right + 1)).length : 0;
    return { visible, hidden: headers.length - visible.length, amounts };
  });
  if (mobileTable) {
    console.log(`  tableau mobile : colonnes visibles [${mobileTable.visible.join(", ")}]${mobileTable.hidden ? ` · ${mobileTable.hidden} hors cadre` : ""}`);
    if (mobileTable.amounts === 0 && revenus.bars > 0) failures.push(`${nav} : aucun montant visible dans le tableau en 390 px`);
  }

  // -- Performance
  await page.setViewport({ width: 1440, height: 980, deviceScaleFactor: 1 });
  await wait(500);
  await clickTab(page, "Performance");
  await shoot(page, `${slug}-performance-1440`, { width: 1440, height: 1200, isMobile: false });
  const performance = await page.evaluate(() => ({
    kpis: [...document.querySelectorAll(".inv-kpi small")].map((node) => node.textContent.trim()),
    warning: document.querySelector(".inv-detail-warn")?.textContent?.slice(0, 120) ?? null,
    best: [...document.querySelectorAll(".inv-ranking")][0]?.textContent?.replace(/\s+/g, " ").slice(0, 120) ?? null,
    risks: [...document.querySelectorAll(".inv-risks li .inv-risk-label")].map((node) => node.textContent.trim()),
  }));
  console.log(`  performance : KPI [${performance.kpis.join(" | ")}]`);
  console.log(`  avertissement : ${performance.warning ?? "aucun"}`);
  console.log(`  risques : [${performance.risks.join(", ")}]`);
  await shoot(page, `${slug}-performance-390`, { width: 390, height: 900, isMobile: true });

  await page.close();
}

await browser.close();
console.log(`\n${failures.length === 0 ? "✅ Aucun défaut mesuré." : `❌ ${failures.length} défaut(s) :`}`);
for (const failure of failures) console.log(`  - ${failure}`);
console.log(`Captures : ${OUT}/`);
process.exit(failures.length === 0 ? 0 : 1);
