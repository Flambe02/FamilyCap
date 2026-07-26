// Vérification VISUELLE de l'écran Compte-titres (desktop + mobile/PWA).
//
// Pourquoi un jeu de données injecté : l'aperçu `?preview=dashboard` rend le tableau de bord
// sans session Supabase, donc /api/portfolio répond 401 et l'écran est vide. On intercepte donc
// les appels et on sert des positions RÉALISTES (libellés d'ETF longs, USD, ISIN) : c'est la
// mise en page qu'on vérifie ici, pas les données — celles-ci ont leurs propres tests.
//
// Contrôle objectif principal : `document.scrollWidth <= clientWidth`. C'est la mesure qui
// prouve « aucune ligne coupée » / aucun débordement horizontal, sur les deux formats. En cas
// d'échec, le script NOMME l'élément fautif (il masque un candidat à la fois et remesure).
//
// Usage : node scripts/verify-positions-ui.mjs  (dev server sur :3000, puppeteer-core installé)

import puppeteer from "puppeteer-core";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = "http://localhost:3000/?preview=dashboard";
const OUT = process.env.SHOT_DIR ?? ".next/ui-check";

const ACCOUNT = {
  id: "cto-1", name: "Compte-titres Boursorama Banque", institution: "Boursorama Banque",
  accountType: "securities", currency: "EUR", memberId: "m1", memberName: "Florent",
  accountNumberLast4: "5306", ibanLast4: "0689", openedAt: "2026-01-01",
  monthlyTarget: null, openingBalance: null, notes: null,
};

// Positions reprises de l'écran réel : libellés longs, deux devises, ISIN présents,
// et une ligne sans cours (le cas « Cours indispo. » doit rester lisible).
const ASSETS = [
  ["Amundi Core MSCI World UCITS ETF - USD ACC", "MWRD", "IE000BI8OT95", 758, 130.81, 157.41, "EUR"],
  ["TOTALENERGIES", "TTE", "FR0000120271", 1568, 51.83, 75.9, "EUR"],
  ["SODEXO", "SW", "FR0000121220", 1407, 71.16, 55.5, "EUR"],
  ["SOCIETE GENERALE", "GLE", "FR0000130809", 887, 26.82, 77.17, "EUR"],
  ["Alphabet C", "GOOG", "US02079K1079", 200, 106.8, 319.09, "USD"],
  ["Vanguard FTSE All-World High Dividend Yield UCITS ETF - USD DIS", "VHYL", "IE00B8GKDB10", 719, 61.79, 81.02, "EUR"],
  ["KLEPIERRE", "LI", "FR0000121964", 1157, 23.62, 38.64, "EUR"],
  ["LVMH", "MC", "FR0000121014", 83, 484.07, 461.7, "EUR"],
  ["ORANGE", "ORA", "FR0000133308", 2276, 11.55, 16.16, "EUR"],
  ["AMUNDI PHYS GOLD", "GOLD-EUR", "FR0013416716", 250, 70.33, 141.01, "EUR"],
  ["Amundi CAC 40 UCITS ETF - EUR DIS", "CAC", "FR0007052782", 401, 69.4, 84.43, "EUR"],
  ["Microsoft", "MSFT", "US5949181045", 81, 236.57, 381.7, "USD"],
  ["AIR LIQUIDE PF28", null, "FR0014010OO5", 44, 160.0, null, "EUR"],
];

const holdings = ASSETS.map(([name, symbol, isin, , , lastPrice, currency]) => ({
  account_id: ACCOUNT.id, asset_type: "other", name, symbol, isin,
  quantity: 0, average_cost: null, last_price: lastPrice, last_price_at: "2026-07-25T17:00:00.000Z", currency,
}));

const operations = ASSETS.map(([name, ticker, isin, quantity, unitPrice, , currency], index) => ({
  id: `op-${index}`, accountId: ACCOUNT.id, memberId: "m1", type: "achat", date: "2026-07-24",
  assetName: name, ticker, isin, quantity, unitPrice, grossAmount: quantity * unitPrice,
  fees: 0, netAmount: quantity * unitPrice, currency, source: "manual", note: null,
}));

const FIXTURES = {
  "/api/portfolio": { accounts: [ACCOUNT], holdings, operations },
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

/** Clic sur un onglet de l'écran (barre `.btc-tabs`), à ne pas confondre avec la navigation latérale. */
async function clickTab(page, label) {
  await page.evaluate((wanted) => {
    [...document.querySelectorAll(".btc-tabs button")].find((node) => node.textContent?.trim() === wanted)?.click();
  }, label);
  await wait(700);
}

async function open(label, { width, height, isMobile }) {
  const page = await browser.newPage();
  // On navigue TOUJOURS en large : sous 780px la barre latérale devient un tiroir, et le clic de
  // navigation l'ouvrirait — on mesurerait alors le débordement du tiroir, pas celui de l'écran.
  // Le passage en 390px se fait juste après, une fois le bon écran affiché.
  await page.setViewport({ width: 1440, height: 950, deviceScaleFactor: 1 });
  page.on("pageerror", (error) => console.log(`  [page] ${String(error).slice(0, 140)}`));
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    // Toute exception ici casse l'interception et fait échouer la page entière.
    try {
      if (request.isInterceptResolutionHandled()) return;
      const path = new URL(request.url(), BASE).pathname;
      const fixture = FIXTURES[path];
      if (fixture) return request.respond({ status: 200, contentType: "application/json", body: JSON.stringify(fixture) });
      return request.continue();
    } catch { /* requête déjà résolue ou page fermée */ }
  });
  await page.goto(BASE, { waitUntil: "networkidle2", timeout: 60000 });
  // L'aperçu sans session provoque un écart d'hydratation (attendu : le serveur rend l'écran de
  // chargement, le client l'aperçu). En dev, Next affiche alors une surcouche plein écran qui
  // intercepte les clics et fausse les captures. On la masque : elle n'existe pas en production.
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });

  await page.evaluate(() => {
    // Le libellé du bouton contient aussi le texte alternatif de l'icône (« Compte-titres :… ») :
    // on cherche donc une inclusion, pas une égalité.
    [...document.querySelectorAll(".nav-subitem")].find((node) => node.textContent?.includes("Compte-titres"))?.click();
  });
  await wait(1500);
  await page.setViewport({ width, height, isMobile, hasTouch: isMobile, deviceScaleFactor: 1 });
  await wait(800);
  return page;
}

async function measure(page, label, name) {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    // Un tableau qui déborde de son panneau est acceptable (il défile DANS .responsive-table) ;
    // ce qui ne l'est pas, c'est que la PAGE déborde.
    tableOverflow: (() => {
      const wrap = document.querySelector(".responsive-table");
      return wrap ? { scroll: wrap.scrollWidth, client: wrap.clientWidth } : null;
    })(),
    rows: document.querySelectorAll(".inv-table tbody tr").length,
    // Rogné = le libellé sort de sa boîte, verticalement (au-delà du clamp) ou horizontalement
    // (il refuse de se replier). Le second cas est celui qui coupait les noms d'ETF sur mobile.
    clipped: [...document.querySelectorAll(".inv-asset-name")]
      .filter((node) => node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1).length,
    tags: document.querySelectorAll(".inv-tag").length,
    faq: document.querySelectorAll(".pea-faq-item").length,
    detail: document.querySelectorAll(".inv-detail-row").length,
  }));
  const ok = metrics.scrollWidth <= metrics.clientWidth + 1;
  // En cas de débordement, on NOMME le coupable : on masque un candidat à la fois et on
  // remesure. Ce qui fait retomber scrollWidth est l'élément à corriger — pas une supposition.
  const probe = ok ? [] : await page.evaluate(() => {
    const found = [];
    for (const selector of [".mobile-menu-backdrop", ".modal-backdrop", ".btc-tabs", ".responsive-table",
      ".inv-table", ".inv-positions-head", ".inv-filters", ".inv-actions", ".btc-header", ".pea-faq"]) {
      const nodes = [...document.querySelectorAll(selector)];
      if (nodes.length === 0) continue;
      const saved = nodes.map((node) => node.style.display);
      nodes.forEach((node) => { node.style.display = "none"; });
      const width = document.documentElement.scrollWidth;
      nodes.forEach((node, i) => { node.style.display = saved[i]; });
      if (width <= document.documentElement.clientWidth + 1) found.push(selector);
    }
    return found;
  });
  results.push({ label: `${label} · ${name}`, ok, probe, ...metrics });
  await page.screenshot({ path: `${OUT}/${label}-${name}.png`, fullPage: false });
}

for (const [label, viewport] of [["desktop", { width: 1440, height: 950, isMobile: false }], ["mobile", { width: 390, height: 844, isMobile: true }]]) {
  const page = await open(label, viewport);

  await clickTab(page, "Mes positions");
  await measure(page, label, "positions");

  // Fiche d'un actif : clic sur le nom de la première ligne.
  await page.evaluate(() => document.querySelector(".inv-asset-btn")?.click());
  await wait(900);
  await measure(page, label, "fiche-actif");
  await page.evaluate(() => [...document.querySelectorAll(".modal button")].find((n) => n.textContent?.trim() === "Fermer")?.click());
  await wait(400);

  await clickTab(page, "Comprendre");
  await measure(page, label, "comprendre");

  await clickTab(page, "Résumé");
  await measure(page, label, "resume");

  await page.close();
}

await browser.close();

let failed = 0;
for (const row of results) {
  if (!row.ok) failed++;
  console.log(
    `${row.ok ? "✓" : "✗"} ${row.label} — page ${row.scrollWidth}/${row.clientWidth}px` +
    (row.tableOverflow ? ` · tableau ${row.tableOverflow.scroll}/${row.tableOverflow.client}px` : "") +
    ` · ${row.rows} ligne(s) · ${row.clipped} nom(s) rogné(s) · ${row.tags} pastille(s)` +
    (row.faq ? ` · ${row.faq} question(s)` : "") +
    (row.detail ? ` · ${row.detail} champ(s) de fiche` : "") +
    (row.probe.length > 0 ? `\n    masquer ceci corrige : ${row.probe.join(", ")}` : ""),
  );
}
console.log(failed === 0 ? "\nAucun débordement horizontal." : `\n${failed} écran(s) en débordement.`);
process.exit(failed === 0 ? 0 : 1);
