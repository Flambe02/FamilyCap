// Vérification VISUELLE et MESURÉE de l'écran Compte-titres — onglet « Mes positions ».
//
// Pourquoi un jeu de données injecté : l'aperçu `?preview=dashboard` rend le tableau de bord
// sans session Supabase, donc /api/portfolio répond 401 et l'écran est vide. On intercepte donc
// les appels et on sert des positions RÉALISTES (libellés d'ETF longs, USD, ISIN) : c'est la
// mise en page qu'on vérifie ici, pas les données — celles-ci ont leurs propres tests.
//
// Trois contrôles OBJECTIFS, pas trois impressions :
//   1. `document.scrollWidth <= clientWidth` — aucun débordement horizontal de la page.
//   2. aucun nom d'actif rogné (`scrollWidth/scrollHeight` au-delà de la boîte qui l'affiche).
//   3. aucun nom COUPÉ AU MILIEU D'UN MOT : pour chaque mot, un Range DOM donne ses rectangles
//      de rendu ; s'ils occupent deux lignes, le mot est à cheval — c'est exactement le défaut
//      « Amun / di... » qu'aucune capture d'écran ne prouve absente à elle seule.
//
// Usage : node scripts/verify-positions-ui.mjs  (dev server sur :3000, puppeteer-core installé)

import { mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = "http://localhost:3000/?preview=dashboard";
const OUT = process.env.SHOT_DIR ?? "artifacts/positions-ui";
mkdirSync(OUT, { recursive: true });

// Les deux enveloppes partagent le shell : on les vérifie toutes les deux, car le PEA a montré
// exactement le même défaut d'affichage que le compte-titres.
const ACCOUNTS = {
  "Compte-titres": {
    id: "cto-1", name: "Compte-titres Boursorama Banque", institution: "Boursorama Banque",
    accountType: "securities", currency: "EUR", memberId: "m1", memberName: "Florent",
    accountNumberLast4: "5306", ibanLast4: "0689", openedAt: "2026-01-01",
    monthlyTarget: null, openingBalance: null, notes: null,
  },
  PEA: {
    id: "pea-1", name: "PEA Boursorama Banque", institution: "Boursorama Banque",
    accountType: "pea", currency: "EUR", memberId: "m1", memberName: "Florent",
    accountNumberLast4: "1188", ibanLast4: "0689", openedAt: "2020-03-01",
    monthlyTarget: null, openingBalance: null, notes: null,
  },
};

// Positions reprises de l'écran réel : libellés longs, deux devises, ISIN présents, types
// variés, une ligne sans cours, une ligne dont le ticker n'est PAS renseigné mais figure entre
// parenthèses dans le libellé (cas des relevés importés — c'est lui qui produisait le
// monogramme « T( »), et une ligne SANS référentiel d'actif (cas SANOFI : `assetId` null, donc
// classification impossible tant que la fiche n'existe pas).
// [nom, ticker, isin, quantité, PRU, cours, devise, type, place]
const ASSETS = [
  ["Amundi Core MSCI World UCITS ETF - USD ACC", "CW8", "IE000BI8OT95", 758, 130.81, 157.41, "EUR", "etf", "Euronext Paris"],
  ["TotalEnergies", "TTE", "FR0000120271", 1568, 51.83, 75.9, "EUR", "stock", "Euronext Paris"],
  ["Société Générale", "GLE", "FR0000130809", 887, 26.82, 77.17, "EUR", "stock", "Euronext Paris"],
  ["Sodexo", "SW", "FR0000121220", 1407, 71.16, 55.5, "EUR", "stock", "Euronext Paris"],
  ["Alphabet C", "GOOG", "US02079K1079", 200, 106.8, 319.09, "USD", "stock", "NASDAQ"],
  ["Vanguard FTSE All-World High Dividend Yield UCITS ETF - USD DIS", "VHYL", "IE00B8GKDB10", 719, 61.79, 81.02, "EUR", "etf", "Euronext Amsterdam"],
  ["Klépierre", "LI", "FR0000121964", 1157, 23.62, 38.64, "EUR", "reit", "Euronext Paris"],
  ["LVMH Moët Hennessy Louis Vuitton", "MC", "FR0000121014", 83, 484.07, 461.7, "EUR", "stock", "Euronext Paris"],
  ["Orange", "ORA", "FR0000133308", 2276, 11.55, 16.16, "EUR", "stock", "Euronext Paris"],
  ["Amundi Physical Gold ETC", "GOLD", "FR0013416716", 250, 70.33, 141.01, "EUR", "gold", "Euronext Paris"],
  ["Amundi CAC 40 UCITS ETF - EUR DIS", "CAC", "FR0007052782", 401, 69.4, 84.43, "EUR", "etf", "Euronext Paris"],
  ["Microsoft", "MSFT", "US5949181045", 81, 236.57, 381.7, "USD", "stock", "NASDAQ"],
  ["Air Liquide", "AI", "FR0000120073", 244, 160.0, 178.2, "EUR", "stock", "Euronext Paris"],
  ["TOTALENERGIES (TTE)", null, "FR0000120272", 310, 51.83, 75.9, "EUR", "stock", null],
  ["Air Liquide PF28", null, "FR0014010OO5", 44, 160.0, null, "EUR", "other", null],
  ["SANOFI", null, "FR0001200578", 360, 87.83, null, "EUR", "other", null],
];
// SANOFI est volontairement ABSENTE du référentiel : c'est l'état constaté en base, et c'est ce
// qui rendait sa classification impossible sans le dire.
const WITHOUT_REFERENCE = new Set(["SANOFI"]);

// Le taux de change est délibérément ABSENT pour l'USD : c'est l'état réel constaté en base
// (`market_fx_rates` vide). Une position cotée mais non convertible doit dire POURQUOI elle n'a
// pas de valeur — « Conversion indisponible », jamais « Cours indisponible ».
const holdingsFor = (account) => ASSETS
  .filter(([name]) => !WITHOUT_REFERENCE.has(name))
  .map(([name, symbol, isin, , , lastPrice, currency, assetType, exchange], index) => ({
    id: `asset-${index}`, account_id: account.id, asset_type: assetType, name, symbol, isin, exchange,
    quantity: 0, average_cost: null, last_price: lastPrice, last_price_at: "2026-07-25T17:00:00.000Z",
    currency, quoteMode: "eod", fxRateToReference: currency === "EUR" ? 1 : null, referenceCurrency: "EUR",
  }));

const operationsFor = (account) => ASSETS.map(([name, ticker, isin, quantity, unitPrice, , currency], index) => ({
  id: `op-${index}`, accountId: account.id, memberId: "m1", type: "achat", date: "2026-07-24",
  assetName: name, ticker, isin, quantity, unitPrice, grossAmount: quantity * unitPrice,
  fees: 0, netAmount: quantity * unitPrice, currency, exchangeRate: currency === "EUR" ? null : 0.92,
  source: "manual", note: null,
}));

const accountsFixture = Object.values(ACCOUNTS);
const FIXTURES = {
  "/api/portfolio": {
    accounts: accountsFixture,
    holdings: accountsFixture.flatMap(holdingsFor),
    operations: accountsFixture.flatMap(operationsFor),
  },
  "/api/auth/me": { viewer: { id: "design-preview", email: "apercu@cap.family", name: "Florent", role: "admin" } },
  "/api/investment-access": { scope: "family", grants: [] },
  "/api/gifts": { records: [] },
  "/api/ledger": { bitcoinEur: null },
  "/api/investment-plan": { plan: null },
  "/api/market/instrument": {
    currencyMismatch: false,
    instrument: {
      symbol: "TTE.PA", name: "TotalEnergies SE", exchange: "Paris", instrumentType: "EQUITY",
      currency: "EUR", price: 75.9, previousClose: 76.18, dayChange: -0.28, dayChangePct: -0.37,
      dayHigh: 76.62, dayLow: 75.39, fiftyTwoWeekHigh: 81.34, fiftyTwoWeekLow: 49.24,
      volume: 3383133, asOf: "2026-07-24T15:35:11.000Z", provider: "Yahoo Finance",
      history: [69.5, 70.2, 71.8, 71.1, 72.6, 73.4, 72.9, 74.1, 75.2, 74.8, 76.0, 76.18, 75.9]
        .map((close, i) => ({ date: `2026-07-${String(i + 12).padStart(2, "0")}`, close })),
    },
  },
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
const results = [];

async function clickTab(page, label) {
  await page.evaluate((wanted) => {
    [...document.querySelectorAll(".btc-tabs button")].find((node) => node.textContent?.trim() === wanted)?.click();
  }, label);
  await wait(700);
}

async function open({ width, height, isMobile }, nav = "Compte-titres") {
  const page = await browser.newPage();
  // On navigue TOUJOURS en large : sous 780px la barre latérale devient un tiroir, et le clic de
  // navigation l'ouvrirait — on mesurerait alors le débordement du tiroir, pas celui de l'écran.
  await page.setViewport({ width: 1440, height: 950, deviceScaleFactor: 1 });
  page.on("pageerror", (error) => console.log(`  [page] ${String(error).slice(0, 140)}`));
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    try {
      if (request.isInterceptResolutionHandled()) return;
      const path = new URL(request.url(), BASE).pathname;
      const fixture = FIXTURES[path];
      if (fixture) return request.respond({ status: 200, contentType: "application/json", body: JSON.stringify(fixture) });
      return request.continue();
    } catch { /* requête déjà résolue ou page fermée */ }
  });
  await page.goto(BASE, { waitUntil: "networkidle2", timeout: 60000 });
  // L'aperçu sans session provoque un écart d'hydratation attendu ; en dev, Next affiche alors
  // une surcouche plein écran qui intercepte les clics. Elle n'existe pas en production.
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  await page.evaluate((wanted) => {
    [...document.querySelectorAll(".nav-subitem")].find((node) => node.textContent?.includes(wanted))?.click();
  }, nav);
  await wait(1500);
  await page.setViewport({ width, height, isMobile, hasTouch: isMobile, deviceScaleFactor: 1 });
  await wait(900);
  return page;
}

async function measure(page, label) {
  const metrics = await page.evaluate(() => {
    const visible = (node) => node.getClientRects().length > 0;
    const names = [...document.querySelectorAll(".pos-name")].filter(visible);

    // Un mot dont les rectangles de rendu occupent deux lignes est coupé en son milieu.
    const brokenWords = [];
    for (const node of names) {
      const text = node.firstChild;
      if (!text || text.nodeType !== Node.TEXT_NODE) continue;
      const value = text.textContent ?? "";
      const regex = /\S+/g;
      let match;
      while ((match = regex.exec(value)) !== null) {
        if (match[0].length < 2) continue;
        const range = document.createRange();
        range.setStart(text, match.index);
        range.setEnd(text, match.index + match[0].length);
        const rects = [...range.getClientRects()].filter((rect) => rect.width > 0.5);
        if (new Set(rects.map((rect) => Math.round(rect.top))).size > 1) {
          brokenWords.push(`${node.textContent.slice(0, 28)} → « ${match[0]} »`);
        }
      }
    }

    const assetCells = [...document.querySelectorAll(".pos-cell-asset, .pos-card-head .pos-identity")].filter(visible);
    const panel = document.querySelector(".inv-positions-panel");
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      layout: document.querySelector(".pos-list")?.getClientRects().length ? "liste" : "cartes",
      containerWidth: panel ? Math.round(panel.getBoundingClientRect().width) : 0,
      listWidth: Math.round([...document.querySelectorAll(".pos-row, .pos-card")].filter(visible)[0]?.getBoundingClientRect().width ?? 0),
      rows: names.length,
      assetWidth: assetCells.length ? Math.round(Math.min(...assetCells.map((cell) => cell.getBoundingClientRect().width))) : 0,
      clipped: names.filter((node) => node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1).length,
      brokenWords,
      // Les exigences de recette, nommément.
      readable: ["Amundi Core MSCI World", "TotalEnergies", "Société Générale"]
        .map((needle) => ({ needle, found: names.some((node) => node.textContent.includes(needle)) })),
      weightBars: [...document.querySelectorAll(".pos-weight-bar")].filter(visible).length,
      chevrons: [...document.querySelectorAll(".pos-chevron")].filter(visible).length,
      kpiStrips: document.querySelectorAll(".pf-strip").length,
      kpiHeight: Math.round(document.querySelector(".pf-strip")?.getBoundingClientRect().height ?? 0),
      isinShown: [...document.querySelectorAll(".pos-isin")].filter(visible).length,
      // Chaque position affiche SOIT un montant, SOIT la raison précise de son absence.
      // Une cellule Valeur vide, ou un « Indisponible » nu qui ne dit pas laquelle des deux
      // causes s'applique, est un échec.
      valueCells: (() => {
        const cells = [...document.querySelectorAll(".pos-cell-value > b, .pos-card-figure > b")].filter(visible);
        const texts = cells.map((cell) => (cell.textContent ?? "").trim());
        return {
          total: cells.length,
          empty: texts.filter((text) => text.length === 0).length,
          amount: texts.filter((text) => /\d/.test(text)).length,
          noQuote: texts.filter((text) => text === "Cours indisponible").length,
          noFx: texts.filter((text) => text === "Conversion indisponible").length,
          vague: texts.filter((text) => text === "Indisponible" || text === "—").length,
          untitled: cells.filter((cell) => !/\d/.test(cell.textContent ?? "") && !(cell.getAttribute("title") || cell.querySelector("[title]"))).length,
        };
      })(),
      // Colonnes réellement DISTINCTES : quantité, PRU, cours et valeur doivent occuper quatre
      // boîtes séparées et non superposées horizontalement (sinon elles sont regroupées).
      distinctColumns: (() => {
        const row = [...document.querySelectorAll(".pos-row")].filter(visible)[0];
        if (!row) return null;
        const box = (selector) => {
          const cell = row.querySelector(selector);
          if (!cell || cell.getClientRects().length === 0) return null;
          const rect = cell.getBoundingClientRect();
          return { left: Math.round(rect.left), right: Math.round(rect.right) };
        };
        const cells = { qty: box(".pos-cell-qty"), pru: box(".pos-cell-pru"), quote: box(".pos-cell-quote"), value: box(".pos-cell-value") };
        const present = Object.entries(cells).filter(([, value]) => value !== null);
        const overlaps = present.filter(([, a], i) => present.slice(i + 1).some(([, b]) => a.left < b.right && b.left < a.right)).length;
        return { present: present.map(([key]) => key), overlaps };
      })(),
      // Un monogramme ne contient que des lettres et des chiffres : « T( » signalait que le
      // ticker était déduit d'un libellé « TOTALENERGIES (TTE) » sans nettoyage.
      badMonograms: [...document.querySelectorAll(".pos-mono")].filter(visible)
        .map((node) => (node.textContent ?? "").trim())
        .filter((text) => !/^[A-Z0-9]{1,4}$/.test(text)),
      // Ce qui doit avoir DISPARU.
      legacyTable: document.querySelectorAll(".inv-table").length,
      viewButtons: document.querySelectorAll(".inv-view-button").length,
      innerButtons: [...document.querySelectorAll(".pos-row button, .pos-card button")].length,
    };
  });
  const value = metrics.valueCells;
  const ok = metrics.scrollWidth <= metrics.clientWidth + 1
    && metrics.clipped === 0 && metrics.brokenWords.length === 0
    && metrics.readable.every((item) => item.found)
    && metrics.legacyTable === 0 && metrics.viewButtons === 0 && metrics.innerButtons === 0
    && value.total === metrics.rows && value.empty === 0 && value.vague === 0 && value.untitled === 0
    && value.amount + value.noQuote + value.noFx === value.total
    && metrics.badMonograms.length === 0
    && (metrics.distinctColumns === null || metrics.distinctColumns.overlaps === 0);
  results.push({ label, ok, ...metrics });
  await page.screenshot({ path: `${OUT}/positions-${label}.png`, fullPage: false });
  // Seconde capture cadrée sur la liste : sur un téléphone, les cartes sont sous la ligne de
  // flottaison et la première capture ne montrerait que l'en-tête de l'écran.
  await page.evaluate(() => {
    const first = [...document.querySelectorAll(".pos-row, .pos-card")].find((node) => node.getClientRects().length > 0);
    first?.scrollIntoView({ block: "start" });
    window.scrollBy(0, -90);
  });
  await wait(400);
  await page.screenshot({ path: `${OUT}/positions-${label}-liste.png`, fullPage: false });
  return metrics;
}

const VIEWPORTS = [
  ["CTO 1600", { width: 1600, height: 1000, isMobile: false }, "Compte-titres"],
  ["CTO 1366", { width: 1366, height: 900, isMobile: false }, "Compte-titres"],
  ["CTO 1024", { width: 1024, height: 860, isMobile: false }, "Compte-titres"],
  ["CTO 390", { width: 390, height: 844, isMobile: true }, "Compte-titres"],
  // Le PEA partage le shell : il doit se comporter à l'identique, aux mêmes largeurs.
  ["PEA 1366", { width: 1366, height: 900, isMobile: false }, "PEA"],
  ["PEA 390", { width: 390, height: 844, isMobile: true }, "PEA"],
];

for (const [label, viewport, nav] of VIEWPORTS) {
  const page = await open(viewport, nav);
  await clickTab(page, "Mes positions");
  await measure(page, label.replace(/\s+/g, "-"));

  // La LIGNE ENTIÈRE ouvre le détail (plus de bouton « Voir »), y compris AU CLAVIER.
  const opened = await page.evaluate(async () => {
    // La ligne VISIBLE : liste et cartes coexistent dans le DOM, seul l'un des deux est rendu.
    const row = [...document.querySelectorAll(".pos-row, .pos-card")].find((node) => node.getClientRects().length > 0);
    row?.focus();
    const focused = document.activeElement === row;
    row?.click();
    await new Promise((resolve) => setTimeout(resolve, 700));
    return { modals: document.querySelectorAll(".inv-detail-modal").length, focused, label: row?.getAttribute("aria-label") ?? "" };
  });
  Object.assign(results[results.length - 1], { detailOpens: opened.modals, focusable: opened.focused, ariaLabel: opened.label });

  // SANOFI : position sans référentiel d'actif. Le bloc « À classifier » doit exister ET offrir
  // une action — le masquer rendait la classification impossible sans jamais dire pourquoi.
  const classify = await page.evaluate(async () => {
    document.querySelector(".modal-backdrop button[aria-label='Fermer']")?.click();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const target = [...document.querySelectorAll(".pos-row, .pos-card")]
      .filter((node) => node.getClientRects().length > 0)
      .find((node) => (node.textContent ?? "").includes("SANOFI"));
    if (!target) return { found: false };
    target.click();
    await new Promise((resolve) => setTimeout(resolve, 800));
    const block = document.querySelector(".inv-classify");
    return {
      found: true,
      hasBlock: Boolean(block),
      hasAction: Boolean(block?.querySelector("button, input")),
      explains: /fiche d’actif/i.test(block?.textContent ?? ""),
    };
  });
  Object.assign(results[results.length - 1], { classify });
  if (classify.found && classify.hasBlock) await page.screenshot({ path: `${OUT}/classifier-${label.replace(/\s+/g, "-")}.png`, fullPage: false });
  await page.close();
}

await browser.close();

let failed = 0;
for (const row of results) {
  const classifyOk = row.classify?.found === true && row.classify.hasBlock && row.classify.hasAction && row.classify.explains;
  const pass = row.ok && row.detailOpens === 1 && row.focusable && row.ariaLabel.length > 30 && classifyOk;
  if (!pass) failed++;
  console.log(
    `${pass ? "✓" : "✗"} ${row.label} — page ${row.scrollWidth}/${row.clientWidth}px` +
    ` · ${row.layout} (conteneur ${row.containerWidth}px, ligne ${row.listWidth}px, actif ${row.assetWidth}px)` +
    ` · ${row.rows} position(s) · ${row.clipped} nom(s) rogné(s) · ${row.brokenWords.length} mot(s) coupé(s)` +
    `\n    ISIN ×${row.isinShown} · barre de poids ×${row.weightBars} · chevron ×${row.chevrons}` +
    ` · bande KPI ×${row.kpiStrips} (${row.kpiHeight}px) · tableau hérité ×${row.legacyTable}` +
    ` · bouton « Voir » ×${row.viewButtons} · bouton imbriqué ×${row.innerButtons}` +
    `\n    ligne focusable ${row.focusable ? "oui" : "NON"} · détail ${row.detailOpens === 1 ? "ouvert" : "NON OUVERT"} · aria-label « ${row.ariaLabel.slice(0, 70)}… »` +
    `\n    valeur : ${row.valueCells.total}/${row.rows} cellule(s) — ${row.valueCells.amount} montant(s), ${row.valueCells.noQuote} « cours indisponible », ${row.valueCells.noFx} « conversion indisponible »` +
    ` · ${row.valueCells.empty} vide(s) · ${row.valueCells.vague} libellé(s) vague(s) · ${row.valueCells.untitled} sans explication` +
    `\n    colonnes distinctes : ${row.distinctColumns ? `${row.distinctColumns.present.join(" | ")} — ${row.distinctColumns.overlaps} chevauchement(s)` : "n/a (cartes)"}` +
    ` · monogramme(s) invalide(s) : ${row.badMonograms.length}${row.badMonograms.length ? ` (${row.badMonograms.join(", ")})` : ""}` +
    `\n    classification SANOFI : ${row.classify?.found ? `bloc ${row.classify.hasBlock ? "présent" : "ABSENT"}, action ${row.classify.hasAction ? "présente" : "ABSENTE"}, explication ${row.classify.explains ? "oui" : "NON"}` : "position INTROUVABLE"}` +
    `\n    recette : ${row.readable.map((item) => `${item.found ? "✓" : "✗"} ${item.needle}`).join(" · ")}` +
    (row.brokenWords.length ? `\n    coupures : ${row.brokenWords.slice(0, 5).join(" | ")}` : ""),
  );
}
console.log(failed === 0 ? "\nTous les paliers sont conformes." : `\n${failed} palier(s) en échec.`);
process.exit(failed === 0 ? 0 : 1);
