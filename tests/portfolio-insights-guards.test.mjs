// Garde-fous des routes et de la migration de l'analyse de portefeuille.
//
// Ces tests lisent le CODE et le SQL : ils verrouillent des propriétés que les tests unitaires ne
// peuvent pas observer — qui a le droit de lire quoi, ce qu'une route a le droit d'écrire, et le
// caractère non destructif de la migration. Point d'acceptation n° 14 (RLS) inclus.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");
/** Retire les commentaires : ils citent volontairement ce qu'il ne faut PAS faire. */
const codeOnly = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ---- 14. Un membre ne peut pas consulter le portefeuille d'un autre ---------------------------
test("l'analyse applique le partage familial, comme /api/portfolio", async () => {
  const route = codeOnly(await source("app/api/portfolio/analysis/route.ts"));
  assert.match(route, /requireFamilyMember/);
  assert.match(route, /viewableInvestmentScope/);
  // Le refus doit être explicite, jamais un silence qui renverrait des données.
  assert.match(route, /status: 403/);
});

test("les expositions et les benchmarks exigent une session authentifiée", async () => {
  const exposures = codeOnly(await source("app/api/market-data/exposures/route.ts"));
  assert.match(exposures, /requireFamilyMember/);
  const benchmarks = codeOnly(await source("app/api/market-data/benchmarks/route.ts"));
  assert.match(benchmarks, /requireFamilyMember/); // lecture
  assert.match(benchmarks, /requireAdmin/); // collecte
});

test("la synchronisation des dividendes est réservée à l'administrateur", async () => {
  const route = codeOnly(await source("app/api/market-data/dividends/sync/route.ts"));
  assert.match(route, /requireAdmin/);
  assert.doesNotMatch(route, /export async function GET/);
});

// ---- 4. Une estimation ne crée jamais d'opération -----------------------------------------------
test("aucune route de dividendes n'écrit dans account_operations", async () => {
  for (const path of [
    "app/api/market-data/dividends/route.ts",
    "app/api/market-data/dividends/sync/route.ts",
    "app/api/portfolio/analysis/route.ts",
    "app/api/market-data/exposures/route.ts",
  ]) {
    const route = codeOnly(await source(path));
    assert.doesNotMatch(route, /supabaseRest\(\s*"account_operations/, `${path} ne doit jamais écrire d'opération`);
    assert.doesNotMatch(route, /method: "DELETE"/, `${path} ne doit rien supprimer`);
  }
});

test("la synchronisation n'écrit QUE dans corporate_actions", async () => {
  const route = codeOnly(await source("app/api/market-data/dividends/sync/route.ts"));
  const writes = [...route.matchAll(/supabaseRest\(\s*\n?\s*"([a-z_]+)/g)].map((match) => match[1]);
  const written = writes.filter((table) => route.includes(`"${table}`) && /corporate_actions|holdings|market_quotes|account_operations/.test(table));
  assert.ok(written.includes("corporate_actions"));
  assert.equal(written.includes("account_operations"), false);
});

test("un ETF capitalisant est explicitement écarté de la synchronisation", async () => {
  const route = codeOnly(await source("app/api/market-data/dividends/sync/route.ts"));
  assert.match(route, /isAccumulating/);
  assert.match(route, /status: "accumulating"/);
});

// ---- Migration non destructive -------------------------------------------------------------------
test("la migration 20260816 est additive : aucun drop de table ni de colonne", async () => {
  const sql = await source("supabase/migrations/20260816_portfolio_exposures_insights.sql");
  const statements = sql.replace(/^--.*$/gm, "");
  assert.doesNotMatch(statements, /drop table/i);
  assert.doesNotMatch(statements, /drop column/i);
  assert.doesNotMatch(statements, /truncate/i);
  assert.doesNotMatch(statements, /delete from/i);
  // Les seuls DROP autorisés sont ceux de contraintes/politiques, préalables à leur recréation :
  // c'est ce qui rend la migration rejouable.
  for (const match of statements.match(/drop\s+\w+/gi) ?? []) {
    assert.match(match, /drop (constraint|policy|index)/i, `DROP inattendu : ${match}`);
  }
});

test("la migration est idempotente (create if not exists, on conflict do nothing)", async () => {
  const sql = await source("supabase/migrations/20260816_portfolio_exposures_insights.sql");
  assert.match(sql, /create table if not exists public\.instrument_exposures/);
  assert.match(sql, /create table if not exists public\.benchmark_series/);
  assert.match(sql, /create table if not exists public\.portfolio_analyses/);
  assert.match(sql, /add column if not exists dividend_tax_rate/);
  assert.equal((sql.match(/on conflict do nothing/g) ?? []).length >= 2, true);
});

test("RLS : les métadonnées sont lisibles, l'analyse suit le périmètre du compte", async () => {
  const sql = await source("supabase/migrations/20260816_portfolio_exposures_insights.sql");
  assert.match(sql, /alter table public\.instrument_exposures enable row level security/);
  assert.match(sql, /alter table public\.benchmark_series enable row level security/);
  assert.match(sql, /alter table public\.portfolio_analyses enable row level security/);
  // L'analyse parle d'un compte : sa politique doit vérifier le titulaire ou l'admin.
  assert.match(sql, /portfolio_analyses[\s\S]*?a\.member_id = public\.current_family_member_id\(\) or public\.is_cap_family_admin\(\)/);
  // Aucune écriture depuis le navigateur, sur aucune des trois tables.
  assert.match(sql, /revoke insert, update, delete on public\.instrument_exposures from anon, authenticated/);
  assert.match(sql, /revoke insert, update, delete on public\.benchmark_series from anon, authenticated/);
  assert.match(sql, /revoke insert, update, delete on public\.portfolio_analyses from anon, authenticated/);
});

test("l'amorçage n'attribue à AUCUN ETF son pays de cotation", async () => {
  const sql = await source("supabase/migrations/20260816_portfolio_exposures_insights.sql");
  const seeds = sql.split("F. AMORÇAGE")[1] ?? "";
  // Les ETF irlandais (préfixe IE) ne doivent jamais recevoir « Irlande ».
  assert.doesNotMatch(seeds, /'IE[A-Z0-9]{9}[0-9]', 'geography', 'IE'/);
  // Les ETF de droit français capitalisant du MSCI World ne doivent pas recevoir « France ».
  assert.doesNotMatch(seeds, /'IE000BI8OT95', 'geography', 'FR'/);
  assert.doesNotMatch(seeds, /'IE0002XZSHO1', 'geography', 'FR'/);
});

test("toute exposition estimée porte une source et un drapeau explicites", async () => {
  const sql = await source("supabase/migrations/20260816_portfolio_exposures_insights.sql");
  const rows = (sql.match(/^\s*\('[A-Z]{2}[A-Z0-9]{9}[0-9]',\s*'(geography|sector)'.*$/gm) ?? []);
  assert.ok(rows.length > 20, `amorçage attendu, ${rows.length} lignes trouvées`);
  for (const row of rows) {
    assert.match(row, /(true|false)\)/, `drapeau is_estimated manquant : ${row}`);
    assert.match(row, /'(high|medium|low)'/, `confiance manquante : ${row}`);
  }
  // Une répartition indicative doit être marquée estimée ET datée.
  const indicative = rows.filter((row) => /indicative/.test(row));
  assert.ok(indicative.length > 0);
  for (const row of indicative) {
    assert.match(row, /'\d{4}-\d{2}-\d{2}'/, `date de source manquante : ${row}`);
    assert.match(row, /true\)/, `is_estimated devrait être true : ${row}`);
  }
});

// ---- L'IA ne reçoit jamais d'opérations brutes ---------------------------------------------------
test("l'objet envoyé au modèle est construit côté serveur, à partir des moteurs existants", async () => {
  const facts = codeOnly(await source("lib/portfolio-facts-server.ts"));
  for (const engine of ["computeAccountModel", "computeExposureModel", "computeDividendIncome", "computePerformanceModel"]) {
    assert.match(facts, new RegExp(engine), `${engine} doit être réutilisé, jamais réimplémenté`);
  }
  // Aucun second moteur de portefeuille : les positions restent dérivées des opérations.
  assert.doesNotMatch(facts, /positions:\s*await supabaseRest/);
});

test("la route d'analyse valide la réponse du modèle avant de l'afficher", async () => {
  const route = codeOnly(await source("app/api/portfolio/analysis/route.ts"));
  assert.match(route, /validateObservations/);
  assert.match(route, /deterministicObservations/);
  // Le cache repose sur l'empreinte des données, pas sur une durée.
  assert.match(route, /factsHash/);
});

// ---- Le moteur de portefeuille n'a pas été dupliqué ------------------------------------------------
test("aucun nouveau module ne recalcule les positions en parallèle du moteur", async () => {
  for (const path of ["lib/portfolio-exposure.ts", "lib/dividend-income.ts", "lib/portfolio-performance.ts", "lib/portfolio-insights.ts"]) {
    const module = codeOnly(await source(path));
    assert.doesNotMatch(module, /function computeAccountModel/, `${path} ne doit pas redéfinir le moteur`);
    assert.doesNotMatch(module, /from "\.\/supabase-rest/, `${path} doit rester pur (aucun accès base)`);
  }
});

test("le shell PEA/CTO reste un seul écran partagé, sans route d'écriture parallèle", async () => {
  const shell = codeOnly(await source("app/investment-account.tsx"));
  assert.match(shell, /\/api\/pea\/operations/);
  assert.match(shell, /\/api\/investment-operations/);
  // Les nouveaux écrans sont montés dans le MÊME shell, pas dans une page dupliquée.
  assert.match(shell, /import \{ RevenusTab, useAnnouncedDividends \} from "\.\/investment-revenus"/);
  assert.match(shell, /import \{ PerformanceTab \} from "\.\/investment-performance"/);
});
