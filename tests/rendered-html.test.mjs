import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(relativePath) {
  return readFile(new URL(relativePath, root), "utf8");
}

test("uses the Cap Family shell rather than the retired starter preview", async () => {
  const [page, layout, authShell, packageJson] = await Promise.all([
    source("app/page.tsx"),
    source("app/layout.tsx"),
    source("app/auth-shell.tsx"),
    source("package.json"),
  ]);

  assert.match(page, /<AuthShell\s*\/>/);
  assert.match(page, /app-version/);
  assert.match(layout, /lang="fr"/);
  assert.match(layout, /Cap Family/);
  assert.match(layout, /skip-link/);
  assert.match(authShell, /auth-loading/);
  assert.match(authShell, /Ouverture de Cap Family/);
  assert.match(authShell, /api\/supabase\/status/);
  assert.match(authShell, /FamilyDashboard/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});

test("keeps the retired Codex preview outside the application", async () => {
  await assert.rejects(access(new URL("app/_sites-preview", root)));

  const [page, layout] = await Promise.all([
    source("app/page.tsx"),
    source("app/layout.tsx"),
  ]);
  assert.doesNotMatch(page, /codex-preview|SkeletonPreview|react-loading-skeleton/i);
  assert.doesNotMatch(layout, /codex-preview|SkeletonPreview|react-loading-skeleton/i);
});