import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");
const screen = read("app/admin-users.tsx");
const usersRoute = read("app/api/admin/users/route.ts");
const exportRoute = read("app/api/admin/users/export/route.ts");
const migration = read("supabase/migrations/20260820_invitation_login_truth.sql");

test("une invitation non utilisée reste affichée comme envoyée, même si Auth a déjà créé son utilisateur", () => {
  assert.match(screen, /invitationPending && !user\.auth\?\.lastSignInAt\) return "sent"/);
  assert.equal(screen.includes("user.auth?.emailConfirmedAt || user.auth.lastSignInAt || user.access_status === \"active\""), false);
  assert.match(screen, /return user\.auth\?\.lastSignInAt \? "active" : "to_send"/);
});

test("la date affichée, le tri et la réponse API utilisent uniquement la dernière connexion Auth", () => {
  assert.match(screen, /shortDate\(user\.auth\?\.lastSignInAt\)/);
  assert.match(screen, /dateLabel\(drawerUser\.auth\?\.lastSignInAt\)/);
  assert.match(screen, /String\(b\.auth\?\.lastSignInAt \?\? ""\)/);
  assert.match(usersRoute, /last_sign_in_at: authUser\?\.last_sign_in_at \?\? null/);
  assert.match(exportRoute, /lastSignInByAuthId/);
  assert.equal(exportRoute.includes("created_at,last_sign_in_at"), false);
  assert.equal(screen.includes("lastSignInAt ?? user.last_sign_in_at"), false);
});

test("le déclencheur SQL n'active plus ni ne date une invitation avant une vraie connexion", () => {
  assert.match(migration, /when new\.last_sign_in_at is not null then 'active'/);
  assert.match(migration, /when new\.last_sign_in_at is not null then new\.last_sign_in_at/);
  assert.match(migration, /if new\.last_sign_in_at is not null then/);
  assert.equal(migration.includes("coalesce(new.last_sign_in_at, now())"), false);
  assert.match(migration, /update public\.invitations as invitation/);
  assert.match(migration, /auth_user\.last_sign_in_at is null/);
});
