// Tests STRUCTURELS du parcours « Bien démarrer » : vérifient, par lecture des fichiers source,
// les garanties que les tests purs ne peuvent pas exécuter sans une base Supabase réelle — seed
// idempotent des 4 missions, contrainte « un seul défi actif » restreinte au type mensuel,
// attribution exclusivement via la RPC transactionnelle existante (jamais d'INSERT direct),
// frontière de session sur la route membre, et confidentialité (aucun montant financier exposé).
// Miroir de tests/challenges-guards.test.mjs pour le défi mensuel.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");
const migration = read("supabase/migrations/20260805_onboarding_missions.sql");
const service = read("lib/onboarding-challenges-service.ts");
const route = read("app/api/challenges/onboarding/route.ts");
const challengesService = read("lib/challenges-service.ts");

// ---- Migration additive : seed idempotent des 4 missions ---------------------------------
test("les 4 missions sont seedées via une clé métier stable (slug), pas le titre", () => {
  for (const slug of ["onboarding_account_setup", "onboarding_existing_portfolio", "onboarding_monthly_plan", "onboarding_first_purchase"]) {
    assert.match(migration, new RegExp(`'${slug}'`), `slug ${slug} absent du seed`);
  }
  assert.match(migration, /on conflict \(slug\) where slug is not null do nothing/);
});

test("le total des points seedés est bien 400 (50 + 100 + 100 + 150)", () => {
  const points = [...migration.matchAll(/'onboarding_mission', 'active', null, null, (\d+),/g)].map((match) => Number(match[1]));
  assert.deepEqual(points.sort((a, b) => a - b), [50, 100, 100, 150]);
});

// ---- Un seul défi MENSUEL actif ; les missions onboarding coexistent librement -----------
test("l'unicité « un seul défi actif » est restreinte au type mensuel (les missions onboarding peuvent toutes être actives)", () => {
  assert.match(migration, /create unique index if not exists challenges_single_active_idx\s*\n\s*on public\.challenges\(status\) where status = 'active' and challenge_type = 'monthly_investment'/);
});

test("le nouveau type 'onboarding_mission' est ajouté sans retirer 'monthly_investment'", () => {
  assert.match(migration, /check \(challenge_type in \('monthly_investment', 'onboarding_mission'\)\)/);
});

test("starts_on / ends_on deviennent nullable (parcours permanent, sans date)", () => {
  assert.match(migration, /alter column starts_on drop not null/);
  assert.match(migration, /alter column ends_on drop not null/);
});

test("aucune donnée financière ni défi existant supprimé : migration purement additive (aucun DROP TABLE ni DELETE)", () => {
  assert.equal(/drop table/i.test(migration), false);
  assert.equal(/\bdelete from\b/i.test(migration), false);
});

// ---- Attribution des points : exclusivement via la RPC existante -------------------------
test("le service attribue via apply_challenge_points (aucun INSERT direct dans points_ledger)", () => {
  assert.match(service, /rpc\/apply_challenge_points/);
  assert.equal(/supabaseRest\(\s*["'`]points_ledger[^"'`]*["'`]\s*,\s*\{\s*\n?\s*method:\s*["'`]POST/.test(service), false);
});

test("participant_id est explicitement NULL (aucune table challenge_participants requise pour l'onboarding)", () => {
  assert.match(service, /p_participant_id:\s*null/);
});

test("la clé d'idempotence utilisée par le service est stable (onboardingCompletionKey), sans compteur d'annulation", () => {
  assert.match(service, /onboardingCompletionKey\(/);
  assert.equal(/p_idempotency_key:\s*.*version/i.test(service), false);
});

test("les points onboarding ne sont jamais annulés : aucune écriture négative, aucun statut 'reverse'", () => {
  assert.equal(/reverse/i.test(service), false);
  assert.equal(/p_points:\s*-/.test(service), false);
});

// ---- Frontière de session : identité du membre connecté, jamais du client ----------------
test("la route onboarding identifie le membre via la session (requireFamilyMember), jamais via le corps de la requête", () => {
  assert.match(route, /requireFamilyMember/);
  assert.match(route, /reconcileOnboardingForMember\(viewer\.id\)/);
  assert.equal(route.includes("request.json"), false); // GET : aucun corps, aucun memberId injectable
});

test("le service ne lit jamais memberId depuis un paramètre non authentifié (toujours un argument de fonction)", () => {
  assert.equal(/req(uest)?\.(body|json)\(\)[\s\S]{0,80}memberId/.test(service), false);
});

// ---- Confidentialité : aucun montant financier exposé côté membre ------------------------
test("la route membre n'expose aucun montant (compte, plan, opération)", () => {
  for (const forbidden of ["monthly_target", "monthlyTarget", "target_account", "targetAccount", "invested", "opening_balance", "iban", "account_number"]) {
    assert.equal(route.includes(forbidden), false, `la route onboarding ne doit pas exposer ${forbidden}`);
  }
});

test("le listing admin des missions n'expose ni montant ni compte, uniquement des compteurs", () => {
  // Isole le TYPE exposé à l'admin (AdminOnboardingMissionRow) : les lectures internes de
  // monthly_target/target_account_id (nécessaires pour ÉVALUER la mission 3) vivent ailleurs
  // dans le fichier et ne doivent pas fausser ce test — seule la forme RENVOYÉE compte ici.
  const start = service.indexOf("export type AdminOnboardingMissionRow");
  assert.ok(start >= 0, "AdminOnboardingMissionRow introuvable");
  const adminSlice = service.slice(start);
  assert.match(adminSlice, /completedCount/);
  for (const forbidden of ["invested", "target_amount", "monthly_target", "targetAccountId", "account_number", "iban"]) {
    assert.equal(adminSlice.includes(forbidden), false, `le listing admin ne doit pas exposer ${forbidden}`);
  }
});

// ---- Les lectures « défi mensuel » excluent désormais les missions onboarding ------------
test("getActiveChallenge / listVisibleChallenges / listChallengesForAdmin filtrent challenge_type=monthly_investment", () => {
  assert.match(challengesService, /MONTHLY_TYPE_FILTER\s*=\s*["'`]&challenge_type=eq\.monthly_investment["'`]/);
  const usages = (challengesService.match(/\$\{MONTHLY_TYPE_FILTER\}/g) ?? []).length;
  assert.ok(usages >= 3, "les 3 lectures mensuelles (getActiveChallenge, listVisibleChallenges, listChallengesForAdmin) doivent référencer MONTHLY_TYPE_FILTER");
});

test("l'admin ne peut pas éditer une mission onboarding depuis updateChallenge (garde explicite)", () => {
  assert.match(challengesService, /challenge_type !== "monthly_investment"/);
});
