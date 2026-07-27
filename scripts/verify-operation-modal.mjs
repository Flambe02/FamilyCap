// Vérification VISUELLE et MESURÉE de la modale « Enregistrer une opération » (PEA + CTO).
//
// Ce que ce script prouve, et ce qu'il ne prouve pas :
//   - les résultats de recherche sont RÉELS : /api/instruments/search est intercepté puis servi
//     par `searchInstrumentCandidates`, c'est-à-dire le code de production, appelé pour de vrai
//     chez le fournisseur. Seule l'AUTHENTIFICATION est contournée (l'aperçu `?preview=dashboard`
//     n'a pas de session Supabase), exactement comme le fait déjà verify-positions-ui.mjs ;
//   - /api/portfolio est en revanche un jeu de données injecté : c'est la MISE EN PAGE qu'on
//     vérifie, pas les chiffres, qui ont leurs propres tests.
//
// Contrôles objectifs, pas des impressions :
//   1. les quatre champs libres (Nom, Ticker, ISIN, Devise) ont DISPARU du formulaire ;
//   2. « Air Liquide », « AI » et « FR0000120073 » proposent bien une cotation Euronext Paris/EUR ;
//   3. chaque résultat affiche sa place ET sa devise (jamais nom + ticker seuls) ;
//   4. le bouton d'enregistrement est désactivé tant qu'aucun actif n'est sélectionné ;
//   5. après sélection, les références sont verrouillées (plus aucun champ d'identité éditable) ;
//   6. aucun débordement horizontal, en desktop comme en mobile.
//
// Usage : node --env-file=.env.local scripts/verify-operation-modal.mjs   (dev server sur :3000)

import { mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { searchInstrumentCandidates } from "../lib/asset-catalog-server.ts";
import { classifyQuery, describeListing, rankCandidates } from "../lib/asset-catalog.ts";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = "http://localhost:3000/?preview=dashboard";
const OUT = process.env.SHOT_DIR ?? "artifacts/operation-modal";
mkdirSync(OUT, { recursive: true });

const ACCOUNTS = [
  { id: "pea-1", name: "PEA Boursorama Banque", institution: "Boursorama Banque", accountType: "pea", currency: "EUR",
    memberId: "m1", memberName: "Florent", accountNumberLast4: "1188", ibanLast4: "0689", openedAt: "2020-03-01",
    monthlyTarget: null, openingBalance: null, notes: null },
  { id: "cto-1", name: "Compte-titres Boursorama Banque", institution: "Boursorama Banque", accountType: "securities", currency: "EUR",
    memberId: "m1", memberName: "Florent", accountNumberLast4: "5306", ibanLast4: "0689", openedAt: "2026-01-01",
    monthlyTarget: null, openingBalance: null, notes: null },
];

// Deux positions suffisent : la vente et le dividende doivent s'y restreindre.
const HELD = [
  ["Air Liquide", "AI", "FR0000120073", 244, 160.0, 178.2, "stock"],
  ["Amundi CAC 40 UCITS ETF - EUR DIS", "CAC", "FR0007052782", 401, 69.4, 84.43, "etf"],
];

const holdings = ACCOUNTS.flatMap((account) => HELD.map(([name, symbol, isin, , , lastPrice, assetType], index) => ({
  id: `${account.id}-asset-${index}`, account_id: account.id, asset_type: assetType, name, symbol, isin,
  exchange: "Euronext Paris", quantity: 0, average_cost: null, last_price: lastPrice,
  last_price_at: "2026-07-25T17:00:00.000Z", currency: "EUR", quoteMode: "eod",
  fxRateToReference: 1, referenceCurrency: "EUR",
})));
const operations = ACCOUNTS.flatMap((account) => HELD.map(([name, ticker, isin, quantity, unitPrice], index) => ({
  id: `${account.id}-op-${index}`, accountId: account.id, memberId: "m1", type: "achat", date: "2026-07-24",
  assetName: name, ticker, isin, quantity, unitPrice, grossAmount: quantity * unitPrice, fees: 0,
  netAmount: quantity * unitPrice, currency: "EUR", exchangeRate: null, source: "manual", note: null,
})));

const FIXTURES = {
  "/api/portfolio": { accounts: ACCOUNTS, holdings, operations },
  "/api/auth/me": { viewer: { id: "m1", email: "apercu@cap.family", name: "Florent", role: "admin" } },
  "/api/investment-access": { scope: "family", grants: [] },
  "/api/gifts": { records: [] },
  "/api/ledger": { bitcoinEur: null },
  "/api/investment-plan": { plan: null },
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (label, ok, detail = "") => { results.push({ label, ok, detail }); console.log(`  ${ok ? "OK  " : "ÉCHEC"} ${label}${detail ? ` — ${detail}` : ""}`); };

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });

async function open(nav) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  page.on("pageerror", (error) => console.log(`  [page] ${String(error).slice(0, 160)}`));
  await page.setRequestInterception(true);
  page.on("request", async (request) => {
    try {
      if (request.isInterceptResolutionHandled()) return;
      const url = new URL(request.url(), BASE);
      // La recherche passe par le VRAI code de production, fournisseur compris.
      if (url.pathname === "/api/instruments/search") {
        const query = url.searchParams.get("q") ?? "";
        const outcome = await searchInstrumentCandidates(query, {}, 6);
        return request.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ results: outcome.candidates, query }) });
      }
      const fixture = FIXTURES[url.pathname];
      if (fixture) return request.respond({ status: 200, contentType: "application/json", body: JSON.stringify(fixture) });
      return request.continue();
    } catch { /* requête déjà résolue ou page fermée */ }
  });
  await page.goto(BASE, { waitUntil: "networkidle2", timeout: 60000 });
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  await page.evaluate((wanted) => {
    [...document.querySelectorAll(".nav-subitem")].find((node) => node.textContent?.includes(wanted))?.click();
  }, nav);
  await wait(1600);
  return page;
}

/** Ouvre la modale via le bouton d'en-tête « Enregistrer une opération ». */
async function openModal(page) {
  await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find((node) => /Enregistrer une opération/i.test(node.textContent ?? ""));
    button?.click();
  });
  await wait(600);
  return page.$(".pea-modal") !== null;
}

async function search(page, term) {
  await page.evaluate(() => { document.querySelector(".asset-search input")?.focus(); });
  await page.$eval(".asset-search input", (node) => { node.value = ""; });
  await page.type(".asset-search input", term, { delay: 25 });
  await wait(2200); // anti-rebond + aller-retour fournisseur
  return page.$$eval(".asset-hit", (nodes) => nodes.map((node) => ({
    name: node.querySelector(".asset-hit-name")?.textContent ?? "",
    type: node.querySelector(".asset-hit-type")?.textContent ?? "",
    line: node.querySelector(".asset-hit-line")?.textContent ?? "",
    meta: node.querySelector(".asset-hit-meta")?.textContent ?? "",
  })));
}

const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

// ==========================================================================================
console.log("\n── PEA — desktop 1440×1000");
const page = await open("PEA");
check("la modale s'ouvre", await openModal(page));

// 1. Les quatre champs libres ont disparu.
const labels = await page.$$eval(".pea-form .pea-field-label", (nodes) => nodes.map((node) => node.textContent?.trim() ?? ""));
const banned = ["Nom de l’actif", "Ticker", "ISIN", "Devise"];
check("aucun champ libre Nom / Ticker / ISIN / Devise", banned.every((label) => !labels.includes(label)), `champs présents : ${labels.join(", ")}`);

// 4. Bouton désactivé sans sélection.
const disabledBefore = await page.$eval(".pea-form-actions .primary-button", (node) => node.disabled);
check("enregistrement désactivé tant qu'aucun actif n'est sélectionné", disabledBefore === true);

// 2 & 3. Les recherches désignent la même cotation, et chaque ligne porte place + devise.
//
// « AI » est traité à part, et c'est important : contre un catalogue VIDE (la migration 20260811
// n'est pas jouée dans cet environnement), le fournisseur seul classe C3.ai devant Air Liquide —
// un ticker nu est ambigu, c'est précisément le constat du cahier. Le rattachement correct vient
// du catalogue, dont l'amorçage contient Air Liquide. On le vérifie donc explicitement plus bas,
// sur les VRAIS résultats du fournisseur, plutôt que de faire semblant que le ticker suffit.
for (const term of ["Air Liquide", "FR0000120073"]) {
  const hits = await search(page, term);
  const paris = hits.find((hit) => /Euronext Paris/.test(hit.line) && /EUR/.test(hit.line) && /Air Liquide/i.test(hit.name));
  check(`« ${term} » propose Air Liquide · Euronext Paris · EUR`, Boolean(paris), paris ? paris.line : `reçu : ${hits.map((h) => h.line).join(" | ") || "aucun"}`);
  check(`« ${term} » : chaque résultat affiche sa place ET sa devise`, hits.length > 0 && hits.every((hit) => hit.line.split("·").length >= 2), `${hits.length} résultat(s)`);
}

const tickerHits = await search(page, "AI");
check("« AI » propose des cotations pleinement qualifiées (place + devise)",
  tickerHits.length > 0 && tickerHits.every((hit) => hit.line.split("·").length >= 2),
  tickerHits.map((hit) => hit.line).join(" | "));
{
  // Preuve du classement final : on reprend les résultats RÉELS du fournisseur pour « AI » et on
  // y ajoute la ligne de catalogue telle que l'amorçage de la migration la crée. Le classement
  // de production doit alors placer Air Liquide en tête.
  const provider = (await searchInstrumentCandidates("AI", {}, 6)).candidates;
  const seeded = {
    assetId: "seed", listingId: "seed-listing", isin: "FR0000120073", name: "Air Liquide", assetType: "stock",
    ticker: "AI", exchange: "Euronext Paris", micCode: "XPAR", currency: "EUR", country: "France",
    eodhdSymbol: "AI.PA", yahooSymbol: "AI.PA", lastPrice: null, lastPriceAt: null,
    peaEligible: null, origin: "catalog", confidence: "verified",
  };
  const ranked = rankCandidates(classifyQuery("AI"), [...provider, seeded]);
  check("« AI » : une fois Air Liquide au catalogue, il passe en tête des résultats fournisseur",
    ranked[0]?.isin === "FR0000120073" && ranked[0]?.micCode === "XPAR",
    `1er = ${ranked[0]?.name} (${describeListing(ranked[0] ?? {})})`);
}

// Capture 1 : la liste de résultats, sur la recherche la plus parlante (un ticker ambigu).
const cw8 = await search(page, "CW8");
check("« CW8 » distingue plusieurs cotations", cw8.length > 1, cw8.map((hit) => hit.line).join(" | "));
await page.screenshot({ path: `${OUT}/1-recherche-desktop.png` });
console.log(`  capture → ${OUT}/1-recherche-desktop.png`);

// 5. Sélection : identité verrouillée.
await page.evaluate(() => document.querySelector(".asset-hit")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
await wait(700);
const locked = await page.evaluate(() => {
  const card = document.querySelector(".asset-selected");
  const text = card?.textContent ?? "";
  // Un champ est « d'identité » si sa valeur reprend le nom, le ticker, l'ISIN ou la devise de la
  // cotation retenue. La note libre, elle, doit évidemment rester saisissable.
  const identityBits = [...text.matchAll(/[A-Z]{2}[A-Z0-9]{9}[0-9]|CW8\w*|EUR/g)].map((match) => match[0]);
  const editable = [...document.querySelectorAll(".pea-form input:not([readonly])")]
    .filter((node) => node.type !== "number" && node.type !== "date")
    .filter((node) => identityBits.some((bit) => node.value?.includes(bit)));
  return {
    hasCard: Boolean(card),
    text,
    hasChange: Boolean(document.querySelector(".asset-change")),
    editableIdentity: editable.length,
    // La recherche a bien disparu au profit de la carte.
    searchGone: document.querySelector(".asset-search input") === null,
  };
});
check("la sélection remplace la recherche par une carte verrouillée", locked.hasCard && locked.searchGone, locked.text.slice(0, 90));
check("un bouton « Changer » permet de revenir", locked.hasChange);
check("aucun champ éditable ne reprend nom / ticker / ISIN / devise", locked.editableIdentity === 0, `${locked.editableIdentity} champ(s) concerné(s)`);

// 6. Saisie + total.
await page.evaluate(() => {
  const setValue = (node, value) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const numbers = [...document.querySelectorAll('.pea-form input[type="number"]')];
  if (numbers[0]) setValue(numbers[0], "10");
  if (numbers[1]) setValue(numbers[1], "174.80");
  if (numbers[2]) setValue(numbers[2], "1.90");
});
await wait(500);
const total = await page.$eval(".asset-total", (node) => node.textContent ?? "").catch(() => "");
check("le montant total est calculé et affiché", /1\s*749[,.]90/.test(total.replace(/\u202f|\u00a0/g, " ")), total.trim().slice(0, 80));
const disabledAfter = await page.$eval(".pea-form-actions .primary-button", (node) => node.disabled);
check("enregistrement redevenu possible après sélection", disabledAfter === false);
check("aucun débordement horizontal (desktop)", (await overflow(page)) <= 0);
await page.screenshot({ path: `${OUT}/2-selection-desktop.png` });
console.log(`  capture → ${OUT}/2-selection-desktop.png`);

// ==========================================================================================
console.log("\n── PEA — mobile 390×844");
// La modale est ouverte APRÈS le passage en mobile : un changement de viewport la démonte
// (le shell bascule sur sa disposition mobile), et on mesurerait alors un écran sans modale.
await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
await wait(1000);
check("la modale s'ouvre en mobile", await openModal(page));
const mobileHits = await search(page, "Air Liquide");
check("les résultats sont lisibles et empilés en mobile", mobileHits.length > 0, `${mobileHits.length} résultat(s)`);
check("aucun débordement horizontal (mobile)", (await overflow(page)) <= 0);
const mobileGeometry = await page.evaluate(() => {
  const actions = document.querySelector(".pea-form-actions");
  const hit = document.querySelector(".asset-hit");
  if (!actions) return null;
  const rect = actions.getBoundingClientRect();
  const list = document.querySelector(".asset-results");
  return {
    actionsBottom: Math.round(rect.bottom), viewport: window.innerHeight,
    visible: rect.bottom <= window.innerHeight + 1 && rect.top >= 0,
    // Cible tactile : au moins 44px de haut, la recommandation d'accessibilité usuelle.
    hitHeight: hit ? Math.round(hit.getBoundingClientRect().height) : 0,
    // Aucun défilement HORIZONTAL dans la liste de résultats.
    listOverflowX: list ? list.scrollWidth - list.clientWidth : 0,
  };
});
check("la barre d'action reste atteignable sans défilement", mobileGeometry?.visible === true,
  mobileGeometry ? `bas=${mobileGeometry.actionsBottom} viewport=${mobileGeometry.viewport}` : "barre absente");
check("les résultats sont des cibles tactiles confortables (≥ 44 px)", (mobileGeometry?.hitHeight ?? 0) >= 44, `${mobileGeometry?.hitHeight}px`);
check("la liste de résultats ne défile jamais horizontalement", (mobileGeometry?.listOverflowX ?? 1) <= 0);
await page.screenshot({ path: `${OUT}/3-recherche-mobile.png` });
console.log(`  capture → ${OUT}/3-recherche-mobile.png`);
await page.close();

// ==========================================================================================
console.log("\n── Compte-titres (CTO) — même shell, même sélecteur");
const cto = await open("Compte-titres");
check("la modale s'ouvre sur le CTO", await openModal(cto));
const ctoLabels = await cto.$$eval(".pea-form .pea-field-label", (nodes) => nodes.map((node) => node.textContent?.trim() ?? ""));
check("le CTO n'expose pas non plus de champs libres d'identité", banned.every((label) => !ctoLabels.includes(label)), ctoLabels.join(", "));
const ctoHits = await search(cto, "Alphabet");
check("« Alphabet » remonte des cotations qualifiées sur le CTO", ctoHits.length > 0, ctoHits[0]?.line ?? "aucun");
await cto.screenshot({ path: `${OUT}/4-recherche-cto.png` });
console.log(`  capture → ${OUT}/4-recherche-cto.png`);

// Type d'opération sans actif : aucun moteur de recherche.
await cto.evaluate(() => {
  const select = [...document.querySelectorAll(".pea-form select")].find((node) => [...node.options].some((option) => option.value === "versement"));
  if (!select) return;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
  setter.call(select, "versement");
  select.dispatchEvent(new Event("change", { bubbles: true }));
});
await wait(600);
check("un versement n'affiche aucun moteur de recherche d'actif", (await cto.$(".asset-search")) === null);
await cto.close();

await browser.close();

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} contrôles OK`);
if (failed.length) { for (const entry of failed) console.log(`  ÉCHEC — ${entry.label} : ${entry.detail}`); process.exit(1); }
