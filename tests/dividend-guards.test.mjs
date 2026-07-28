// Garde-fous des dividendes — sécurité, confidentialité et invariants d'écriture.
//
// Ces tests lisent le CODE SOURCE. C'est volontaire : ils vérifient des propriétés qu'aucun test
// fonctionnel ne peut établir de l'extérieur (« cette route n'écrit jamais dans account_operations »,
// « aucune clé fournisseur ne porte le préfixe NEXT_PUBLIC_ »), et ils échouent le jour où
// quelqu'un les contredit — y compris par inadvertance.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
/** Retire commentaires et chaînes pour ne raisonner que sur du code exécutable. */
const codeOnly = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const ROUTES = [
  "app/api/investment-accounts/[accountId]/dividends/route.ts",
  "app/api/investment-accounts/[accountId]/dividends/sync/route.ts",
  "app/api/investment-accounts/[accountId]/dividends/calendar/route.ts",
  "app/api/investment-accounts/[accountId]/dividends/positions/route.ts",
];

// ==========================================================================================
// 20. RLS et confidentialité entre membres
// ==========================================================================================
test("20 — toutes les routes de dividendes exigent une session et vérifient le périmètre", async () => {
  for (const path of ROUTES) {
    const route = codeOnly(await source(path));
    assert.match(route, /resolveDividendScope/, `${path} doit filtrer le périmètre du compte`);
  }
  const guard = codeOnly(await source("lib/dividend-route.ts"));
  assert.match(guard, /requireFamilyMember/);
  assert.match(guard, /viewableInvestmentScope/);
  // Le refus est EXPLICITE : renvoyer une liste vide laisserait croire à un compte sans dividende.
  assert.match(guard, /DividendAccessError\(403/);
  assert.match(guard, /DividendAccessError\(404/);
  // Le partage se lit CLASSE PAR CLASSE : un membre peut partager son compte-titres sans son PEA.
  assert.match(guard, /flags\?\.pea === true/);
  assert.match(guard, /flags\?\.cto === true/);
});

test("20 bis — la synchronisation est réservée à l'administrateur et n'expose aucun GET", async () => {
  const route = codeOnly(await source(ROUTES[1]));
  assert.match(route, /requireAdmin/);
  assert.doesNotMatch(route, /export async function GET/);
  // Être administrateur ne dispense pas de la garde de périmètre.
  assert.match(route, /resolveDividendScope/);
});

test("20 ter — la migration protège les tables financières sans politique permissive générale", async () => {
  const sql = await source("supabase/migrations/20260817_dividend_engine.sql");
  const statements = sql.replace(/^--.*$/gm, "");
  assert.match(statements, /alter table public\.dividend_events enable row level security/);
  assert.match(statements, /alter table public\.account_tax_profiles enable row level security/);
  assert.match(statements, /alter table public\.dividend_sync_state enable row level security/);
  // Écriture réservée au serveur : aucune politique d'insertion/mise à jour pour `authenticated`.
  assert.match(statements, /revoke insert, update, delete on public\.dividend_events from anon, authenticated/);
  assert.match(statements, /revoke insert, update, delete on public\.account_tax_profiles from anon, authenticated/);
  assert.doesNotMatch(statements, /for (insert|update|delete) to authenticated/i);
  // Un événement rattaché à un compte suit la règle de partage familial déjà en vigueur.
  assert.match(statements, /can_view_member_investments\(a\.member_id\)/);
  // Le profil fiscal ne sort jamais du propriétaire (ou de l'administrateur).
  assert.match(statements, /current_family_member_id\(\) or public\.is_cap_family_admin\(\)/);
  assert.match(statements, /admin reads dividend sync state/);
});

// ==========================================================================================
// Une estimation ne devient JAMAIS une opération
// ==========================================================================================
test("aucune route de dividendes n'écrit dans account_operations", async () => {
  for (const path of ROUTES) {
    const route = codeOnly(await source(path));
    assert.doesNotMatch(route, /account_operations/, `${path} ne doit jamais toucher aux opérations`);
  }
  const sync = codeOnly(await source("lib/dividend-sync.ts"));
  assert.doesNotMatch(sync, /supabaseRest\(\s*"account_operations/);
  assert.doesNotMatch(sync, /supabaseRest\(\s*`account_operations/);
});

test("la synchronisation ne supprime QUE des projections, jamais un fait ni un encaissement", async () => {
  const sync = codeOnly(await source("lib/dividend-sync.ts"));
  const deletes = [...sync.matchAll(/method:\s*"DELETE"/g)];
  assert.equal(deletes.length, 1, "une seule suppression est autorisée dans tout le module");
  // Et elle est bornée : cet instrument, ses projections, et rien d'autre.
  assert.match(sync, /is_forecast=is\.true/);
  assert.match(sync, /account_id=is\.null/);
  assert.match(sync, /asset_id=eq\./);
});

test("la migration est additive : aucune table, colonne ni donnée supprimée", async () => {
  const sql = await source("supabase/migrations/20260817_dividend_engine.sql");
  const statements = sql.replace(/^--.*$/gm, "");
  assert.doesNotMatch(statements, /drop table/i);
  assert.doesNotMatch(statements, /drop column/i);
  assert.doesNotMatch(statements, /truncate/i);
  assert.doesNotMatch(statements, /delete from/i);
  // Les seuls DROP autorisés portent sur des contraintes et politiques, aussitôt recréées.
  for (const match of statements.match(/drop\s+\w+/gi) ?? []) {
    assert.match(match, /drop (constraint|policy|index)/i, `DROP inattendu : ${match}`);
  }
  // Idempotence : rejouable sans effet de bord.
  assert.match(statements, /create table if not exists public\.dividend_events/);
  assert.match(statements, /create table if not exists public\.account_tax_profiles/);
  assert.match(statements, /add column if not exists/);
});

// ==========================================================================================
// Clés fournisseurs : strictement serveur
// ==========================================================================================
test("aucune clé fournisseur n'est exposée au navigateur", async () => {
  const providers = await source("lib/dividend-providers.ts");
  assert.doesNotMatch(providers, /NEXT_PUBLIC_/);
  assert.match(providers, /process\.env\.ALPHA_VANTAGE_API_KEY/);
  assert.match(providers, /process\.env\.EODHD_API_TOKEN/);
  // Le module fournisseur n'est jamais importé par un composant client.
  const screen = await source("app/investment-revenus.tsx");
  assert.doesNotMatch(screen, /dividend-providers|dividend-sync|dividend-server/);
  // Le composant peut NOMMER une variable d'environnement dans un message d'aide (« ajoutez
  // ALPHA_VANTAGE_API_KEY »), mais il ne doit jamais en LIRE une : `process.env` n'existe pas côté
  // navigateur, et sa présence signalerait une valeur embarquée dans le bundle.
  assert.doesNotMatch(codeOnly(screen), /process\.env/);
  assert.match(screen, /"use client"/);
});

test("les routes déclarent le runtime Node et n'exposent que le NOM des fournisseurs", async () => {
  for (const path of ROUTES) {
    const route = codeOnly(await source(path));
    assert.match(route, /export const runtime = "nodejs"/);
    assert.doesNotMatch(route, /API_KEY|API_TOKEN/);
  }
});

// ==========================================================================================
// Le moteur reste pur, et le portefeuille n'est pas dupliqué
// ==========================================================================================
test("les modules de calcul restent purs : aucun accès base, aucun réseau", async () => {
  for (const path of ["lib/dividend-engine.ts", "lib/dividend-projection.ts"]) {
    const module = codeOnly(await source(path));
    assert.doesNotMatch(module, /from "\.\/supabase-rest/, `${path} doit rester pur`);
    assert.doesNotMatch(module, /fetch\(/, `${path} ne doit faire aucune requête`);
    assert.doesNotMatch(module, /process\.env/, `${path} ne doit lire aucune variable d'environnement`);
    assert.doesNotMatch(module, /function computeAccountModel/, `${path} ne doit pas redéfinir le moteur de portefeuille`);
  }
});

test("PEA et compte-titres utilisent le MÊME écran et le MÊME moteur", async () => {
  const shell = codeOnly(await source("app/investment-account.tsx"));
  assert.match(shell, /import \{ DividendsTab \} from "\.\/investment-revenus"/);
  assert.match(shell, /<DividendsTab accountIds=\{scopeAccountIds\} canManage=\{canManage\} \/>/);
  // Les deux enveloppes sont deux CONFIGURATIONS du même shell, pas deux écrans.
  const pea = await source("app/pea-investments.tsx");
  const cto = await source("app/cto-investments.tsx");
  for (const wrapper of [pea, cto]) {
    assert.match(wrapper, /InvestmentAccountShell/);
    assert.doesNotMatch(wrapper, /DividendsTab/, "aucun wrapper ne monte son propre écran de dividendes");
  }
  // Et un seul moteur est appelé, depuis la couche serveur partagée.
  const route = codeOnly(await source("lib/dividend-route.ts"));
  assert.match(route, /computeDividendModel/);
  assert.equal((route.match(/computeDividendModel\(/g) ?? []).length, 1);
});

test("le chargement de la page ne déclenche aucune requête fournisseur", async () => {
  // La lecture passe par `loadDividendContext`, qui ne lit que Supabase. Les fournisseurs ne sont
  // sollicités que par la synchronisation explicite, protégée par requireAdmin.
  const server = codeOnly(await source("lib/dividend-server.ts"));
  assert.doesNotMatch(server, /dividend-providers/);
  assert.doesNotMatch(server, /fetch\(/);
  const read = codeOnly(await source(ROUTES[0]));
  assert.doesNotMatch(read, /syncAccountDividends|resolveAlphaVantageSymbols/);
});
