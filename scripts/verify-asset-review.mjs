// Vérification VISUELLE de l'écran d'administration « Actifs & cotations ».
//
// Trois états sont contrôlés, car ce sont les trois que l'administrateur rencontrera vraiment :
//   1. migration non jouée  → une consigne claire, pas une erreur brute ;
//   2. catalogue sain       → un état vide explicite (et non un écran qui semble cassé) ;
//   3. actifs à vérifier    → motifs, conséquences et formulaire de correction.
//
// La réponse de /api/admin/asset-review est injectée (l'aperçu n'a pas de session Supabase), mais
// le CLASSEMENT et les MOTIFS viennent du vrai code : le script appelle `buildReviewList`.
//
// Usage : node scripts/verify-asset-review.mjs   (dev server sur :3000)

import { mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { buildReviewList } from "../lib/asset-catalog.ts";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = "http://localhost:3000/?preview=dashboard";
const OUT = process.env.SHOT_DIR ?? "artifacts/asset-review";
mkdirSync(OUT, { recursive: true });

const listing = (over = {}) => ({
  listingId: "l1", ticker: "AI", exchange: "Euronext Paris", micCode: "XPAR", currency: "EUR",
  eodhdSymbol: "AI.PA", yahooSymbol: "AI.PA", validationStatus: "inferred", ...over,
});

// Jeu d'actifs couvrant chaque motif. Les motifs eux-mêmes sont calculés par le vrai moteur.
const CATALOG = [
  { assetId: "a1", name: "Air Liquide", isin: "FR0000120073", assetType: "stock", classificationStatus: "verified", listings: [listing()], operationCount: 12 },
  { assetId: "a2", name: "AIR LIQUIDE (doublon importé)", isin: "FR0000120271", assetType: "stock", classificationStatus: "inferred", listings: [listing({ listingId: "l2" })], operationCount: 3 },
  { assetId: "a3", name: "Amundi MSCI World", isin: "FR0007052782", assetType: "etf", classificationStatus: "verified", listings: [], operationCount: 40 },
  { assetId: "a4", name: "Fonds interne PEA", isin: null, assetType: "fund", classificationStatus: "needs_review", listings: [listing({ listingId: "l4", ticker: "FIP", eodhdSymbol: null, yahooSymbol: null })], operationCount: 1 },
];

const review = buildReviewList(CATALOG);
console.log(`Motifs calculés par le vrai moteur : ${review.map((a) => `${a.name} → ${a.reasons.join("+")}`).join(" | ")}`);

const SCENARIOS = {
  pending: { status: 200, body: { assets: review, total: CATALOG.length, pending: review.length } },
  healthy: { status: 200, body: { assets: [], total: 12, pending: 0 } },
  setup: { status: 503, body: { error: "Le catalogue d'actifs n'est pas encore installé. Appliquez la migration 20260811_asset_catalog.sql dans Supabase.", setupRequired: true } },
};

const FIXTURES = {
  "/api/auth/me": { viewer: { id: "m1", email: "apercu@cap.family", name: "Florent", role: "admin" } },
  "/api/portfolio": { accounts: [], holdings: [], operations: [] },
  "/api/gifts": { records: [] },
  "/api/ledger": { bitcoinEur: null },
  "/api/admin/users": { users: [] },
  "/api/admin/accounts": { accounts: [], holdings: [] },
  "/api/transfer-requests": { requests: [] },
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (label, ok, detail = "") => { results.push({ label, ok }); console.log(`  ${ok ? "OK  " : "ÉCHEC"} ${label}${detail ? ` — ${detail}` : ""}`); };

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });

async function open(scenario) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    try {
      if (request.isInterceptResolutionHandled()) return;
      const path = new URL(request.url(), BASE).pathname;
      if (path === "/api/admin/asset-review") {
        const { status, body } = SCENARIOS[scenario];
        return request.respond({ status, contentType: "application/json", body: JSON.stringify(body) });
      }
      const fixture = FIXTURES[path];
      if (fixture) return request.respond({ status: 200, contentType: "application/json", body: JSON.stringify(fixture) });
      return request.continue();
    } catch { /* déjà résolue */ }
  });
  await page.goto(BASE, { waitUntil: "networkidle2", timeout: 60000 });
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  await page.evaluate(() => {
    [...document.querySelectorAll(".nav-subitem, .nav-item")].find((node) => node.textContent?.includes("Administration"))?.click();
  });
  await wait(1200);
  await page.evaluate(() => {
    [...document.querySelectorAll(".admin-tabs button")].find((node) => node.textContent?.includes("Actifs"))?.click();
  });
  await wait(1200);
  return page;
}

// ---- 1. Actifs à vérifier ----------------------------------------------------------------
console.log("\n── Catalogue avec actifs à vérifier");
let page = await open("pending");
const items = await page.$$eval(".asset-review-item", (nodes) => nodes.map((node) => ({
  title: node.querySelector(".asset-review-main b")?.textContent ?? "",
  tags: [...node.querySelectorAll(".asset-review-tag")].map((tag) => tag.textContent),
})));
check("la liste s'affiche", items.length > 0, `${items.length} actif(s)`);
check("le doublon probable est signalé « En conflit »", items.some((item) => item.tags.includes("En conflit")), items.map((i) => `${i.title}:${i.tags.join("/")}`).join(" | "));
check("l'actif sans cotation est signalé", items.some((item) => item.tags.includes("Sans cotation")));
check("la cotation sans symbole fournisseur est signalée", items.some((item) => item.tags.includes("Sans symbole fournisseur")));
check("le plus bloquant est en tête", items[0]?.tags.includes("En conflit"));
await page.screenshot({ path: `${OUT}/1-actifs-a-verifier.png` });
console.log(`  capture → ${OUT}/1-actifs-a-verifier.png`);

// Ouvrir une fiche : motifs expliqués + formulaire de correction.
await page.evaluate(() => document.querySelector(".asset-review-row")?.click());
await wait(500);
const editor = await page.evaluate(() => ({
  why: [...document.querySelectorAll(".asset-review-why li")].map((node) => node.textContent ?? ""),
  fields: [...document.querySelectorAll(".asset-review-grid label span")].map((node) => node.textContent ?? ""),
  confirm: [...document.querySelectorAll(".asset-review-actions button")].map((node) => node.textContent ?? ""),
}));
check("le motif est expliqué par sa conséquence", editor.why.length > 0 && editor.why.every((text) => text.length > 20), editor.why[0]?.slice(0, 70));
check("le formulaire permet de corriger identité ET cotation",
  ["Nom canonique", "Type", "ISIN"].every((field) => editor.fields.includes(field))
  && ["Ticker", "Code MIC", "Devise", "Symbole EODHD", "Symbole Yahoo"].every((field) => editor.fields.includes(field)),
  editor.fields.join(", "));
check("l'action de confirmation est explicite", editor.confirm.some((label) => /Confirmer cet actif/.test(label)));
const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
check("aucun débordement horizontal", noOverflow);
await page.screenshot({ path: `${OUT}/2-correction.png` });
console.log(`  capture → ${OUT}/2-correction.png`);
await page.close();

// ---- 2. Catalogue sain -------------------------------------------------------------------
console.log("\n── Catalogue sain");
page = await open("healthy");
const empty = await page.$eval(".asset-review-empty", (node) => node.textContent ?? "").catch(() => "");
check("un catalogue sain affiche un état vide explicite", /Aucun actif à vérifier/.test(empty), empty.trim().slice(0, 80));
check("aucune liste résiduelle", (await page.$(".asset-review-item")) === null);
await page.screenshot({ path: `${OUT}/3-catalogue-sain.png` });
console.log(`  capture → ${OUT}/3-catalogue-sain.png`);
await page.close();

// ---- 3. Migration non jouée --------------------------------------------------------------
console.log("\n── Migration non appliquée");
page = await open("setup");
const setup = await page.$eval(".asset-review-setup", (node) => node.textContent ?? "").catch(() => "");
check("la migration manquante donne une consigne, pas une erreur technique", /20260811_asset_catalog\.sql/.test(setup), setup.trim().slice(0, 90));
check("aucune erreur SQL brute affichée", !/PGRST|42P01|relation .* does not exist/i.test(setup));
await page.screenshot({ path: `${OUT}/4-migration-absente.png` });
console.log(`  capture → ${OUT}/4-migration-absente.png`);
await page.close();

await browser.close();
const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} contrôles OK`);
if (failed.length) process.exit(1);
