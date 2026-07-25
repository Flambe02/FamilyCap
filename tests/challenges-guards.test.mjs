// Tests STRUCTURELS des Défis : vérifient, par lecture des fichiers source, les garanties que les
// tests purs ne peuvent pas exécuter sans une base Supabase réelle — immutabilité SQL, FKs
// RESTRICT, index « un seul défi actif », RPC atomique, gardes d'autorisation des routes, et
// confidentialité du classement. Ils NE remplacent PAS un smoke test Supabase (voir rapport) mais
// démontrent que les protections sont bien présentes dans la migration et le code.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");
const migration = read("supabase/migrations/20260804_challenges_mvp.sql");
const service = read("lib/challenges-service.ts");

// ---- Migration : immutabilité, FKs, défi actif unique, RPC -------------------------------
test("points_ledger : trigger BEFORE UPDATE OR DELETE (immutabilité réelle)", () => {
  assert.match(migration, /create or replace function public\.points_ledger_reject_mutation/);
  assert.match(migration, /before update or delete on public\.points_ledger/);
});

test("points_ledger : FKs en ON DELETE RESTRICT (aucune cascade n'efface un point)", () => {
  const block = migration.slice(migration.indexOf("create table if not exists public.points_ledger"), migration.indexOf("create index if not exists points_ledger_member_idx"));
  assert.equal((block.match(/on delete restrict/g) ?? []).length, 3);
  assert.equal(block.includes("on delete cascade"), false);
  assert.equal(block.includes("on delete set null"), false);
});

test("challenges : index unique partiel « un seul défi actif »", () => {
  assert.match(migration, /create unique index if not exists challenges_single_active_idx on public\.challenges\(status\) where status = 'active'/);
});

test("RPC transactionnelle apply_challenge_points (verrou + insert idempotent + update)", () => {
  assert.match(migration, /create or replace function public\.apply_challenge_points/);
  assert.match(migration, /for update/);
  assert.match(migration, /on conflict \(idempotency_key\) do nothing/);
  assert.match(migration, /grant execute on function public\.apply_challenge_points[\s\S]*to service_role/);
});

test("le service attribue les points via la RPC atomique (pas d'insert points_ledger direct)", () => {
  assert.match(service, /rpc\/apply_challenge_points/);
  // Aucune insertion directe dans points_ledger depuis le service (tout passe par la RPC).
  assert.equal(/supabaseRest\(\s*["'`]points_ledger[^"'`]*["'`]\s*,\s*\{\s*\n?\s*method:\s*["'`]POST/.test(service), false);
});

// ---- Objectif figé : jamais modifié après l'inscription ----------------------------------
test("target_amount_snapshot n'est écrit qu'à l'inscription (jamais via un PATCH)", () => {
  assert.match(service, /target_amount_snapshot: monthlyTarget/); // gel à l'inscription
  assert.equal(/method:\s*["'`]PATCH["'`][\s\S]{0,400}target_amount_snapshot/.test(service), false);
});

// ---- Routes membre : identité de session, jamais du client -------------------------------
const joinRoute = read("app/api/challenges/current/join/route.ts");
const leaderboardRoute = read("app/api/challenges/leaderboard/route.ts");

test("route join : identité serveur (viewer.id), aucune lecture de champ client sensible", () => {
  assert.match(joinRoute, /requireFamilyMember/);
  assert.match(joinRoute, /joinChallenge\(viewer\.id\)/);
  assert.equal(joinRoute.includes("request.json"), false); // n'accepte aucun corps → ni member_id, ni points, ni status
});

test("routes membre : aucune ne lit un member_id / points / status='completed' du corps", () => {
  for (const path of [
    "app/api/challenges/route.ts",
    "app/api/challenges/current/route.ts",
    "app/api/challenges/current/progress/route.ts",
    "app/api/challenges/points/route.ts",
  ]) {
    const source = read(path);
    assert.match(source, /requireFamilyMember/);
    assert.equal(/body\.(memberId|member_id|points|status)/.test(source), false, `${path} ne doit pas lire un champ sensible du corps`);
  }
});

// ---- Aperçu admin (lecture seule) : ?asMember= réservé à l'admin, jamais pour écrire --------
test("routes de lecture des défis : ?asMember= n'est honoré que si viewer.role === 'admin'", () => {
  for (const path of [
    "app/api/challenges/route.ts",
    "app/api/challenges/current/route.ts",
    "app/api/challenges/points/route.ts",
    "app/api/challenges/leaderboard/route.ts",
    "app/api/challenges/onboarding/route.ts",
  ]) {
    const source = read(path);
    assert.match(source, /asMember/, `${path} devrait supporter l'aperçu admin ?asMember=`);
    assert.match(source, /viewer\.role\s*===\s*["'`]admin["'`]/, `${path} doit réserver asMember à l'admin`);
  }
});

test("route join : n'honore JAMAIS ?asMember= (un aperçu admin ne peut jamais rejoindre un défi au nom d'un membre)", () => {
  assert.equal(joinRoute.includes("asMember"), false);
});

// ---- Classement : aucune donnée privée dans la route ni son DTO --------------------------
test("route classement : aucun champ montant/objectif/compte", () => {
  assert.match(leaderboardRoute, /requireFamilyMember/);
  for (const forbidden of ["invested", "targetAmount", "target_amount", "monthly_target", "monthlyTarget", "eligible_amount", "account"]) {
    assert.equal(leaderboardRoute.includes(forbidden), false, `la route classement ne doit pas mentionner ${forbidden}`);
  }
});

// ---- Routes admin : rôle vérifié côté serveur pour chaque mutation -----------------------
test("routes admin : requireAdmin présent (création/gestion/suppression réservées à l'admin)", () => {
  const adminChallenges = read("app/api/admin/challenges/route.ts");
  const adminParticipants = read("app/api/admin/challenges/participants/route.ts");
  assert.match(adminChallenges, /requireAdmin/);
  assert.equal((adminChallenges.match(/requireAdmin/g) ?? []).length >= 4, true); // GET + POST + PATCH + DELETE
  assert.match(adminParticipants, /requireAdmin/);
});

// ---- Suppression : protège l'historique des points et les missions onboarding -----------
test("deleteChallenge refuse de supprimer une mission « Bien démarrer » (challenge_type non monthly_investment)", () => {
  const source = read("lib/challenges-service.ts");
  const start = source.indexOf("export async function deleteChallenge");
  assert.ok(start >= 0, "deleteChallenge introuvable");
  const fn = source.slice(start, source.indexOf("\n}\n", start) + 3);
  assert.match(fn, /challenge_type !== "monthly_investment"/);
});

test("deleteChallenge n'écrit jamais dans points_ledger : la protection vient de la contrainte FK (23503)", () => {
  const source = read("lib/challenges-service.ts");
  const start = source.indexOf("export async function deleteChallenge");
  const fn = source.slice(start, source.indexOf("\n}\n", start) + 3);
  assert.match(fn, /method:\s*["'`]DELETE["'`]/);
  assert.match(fn, /isPointsHistoryViolation\(error\)/); // détection déléguée, définie juste au-dessus
  assert.match(source, /function isPointsHistoryViolation[\s\S]{0,200}23503/);
  assert.equal(/points_ledger["'`]\s*,\s*\{\s*\n?\s*method/.test(fn), false);
});

test("route admin : DELETE présent, id lu depuis les query params (jamais un corps arbitraire)", () => {
  const adminChallenges = read("app/api/admin/challenges/route.ts");
  assert.match(adminChallenges, /export async function DELETE/);
  assert.match(adminChallenges, /searchParams\.get\(["'`]id["'`]\)/);
});
