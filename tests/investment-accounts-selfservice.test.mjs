// Création SELF-SERVICE d'un PEA / compte-titres par le membre (app/api/investment-accounts).
//
// CE QUE CES TESTS VERROUILLENT, ET POURQUOI :
// le parcours « Bien démarrer » demandait au membre de configurer son PEA, mais la seule route de
// création (/api/admin/accounts) est requireAdmin. Le défi était donc littéralement impossible à
// terminer : ceux qui le voyaient (adult/child, cf. isChallengeEligible) ne pouvaient pas agir, et
// le seul qui pouvait agir (l'admin) ne voyait jamais le défi. Ces tests empêchent la régression
// dans les deux sens : que la route self-service disparaisse, ou qu'elle s'ouvre trop grand.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

/**
 * Retire les commentaires avant d'analyser le CODE. Ces fichiers sont abondamment commentés — et
 * les commentaires citent volontairement `requireAdmin` ou `onNavigate("parametres")` pour
 * expliquer ce qu'il ne faut PAS faire. Les compter comme du code produirait des échecs fantômes.
 */
const codeOnly = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("la route self-service existe et n'accepte QUE le membre authentifié", async () => {
  const route = codeOnly(await source("app/api/investment-accounts/route.ts"));
  assert.match(route, /requireFamilyMember/);
  assert.doesNotMatch(route, /requireAdmin/);
});

test("member_id est FORCÉ sur l'appelant, jamais lu depuis le corps de la requête", async () => {
  const route = await source("app/api/investment-accounts/route.ts");
  assert.match(route, /member_id: viewer\.id/);
  // Un membre ne doit jamais pouvoir créer un compte au nom d'un autre en forgeant la requête.
  assert.doesNotMatch(route, /body\.memberId/);
  assert.doesNotMatch(route, /body\.member_id/);
});

test("seuls PEA et compte-titres sont créables en self-service", async () => {
  const route = await source("app/api/investment-accounts/route.ts");
  assert.match(route, /SELF_SERVICE_TYPES = new Set\(\["pea", "securities"\]\)/);
  // Les types sensibles (portefeuille Bitcoin, compte bancaire…) restent réservés à l'admin.
  assert.doesNotMatch(route, /"bitcoin"/);
  assert.doesNotMatch(route, /"bank"/);
});

test("la route ne fait QUE créer : ni édition, ni archivage, ni suppression", async () => {
  const route = await source("app/api/investment-accounts/route.ts");
  assert.match(route, /export async function POST/);
  assert.doesNotMatch(route, /export async function PATCH/);
  assert.doesNotMatch(route, /export async function DELETE/);
  assert.doesNotMatch(route, /export async function PUT/);
});

test("aucun champ sensible n'est accepté (IBAN, n° de compte, wallet, solde)", async () => {
  const route = await source("app/api/investment-accounts/route.ts");
  for (const field of ["iban_last4", "account_number_last4", "wallet_address", "opening_balance"]) {
    assert.doesNotMatch(route, new RegExp(field), `${field} ne doit pas être écrit par la route self-service`);
  }
});

test("les points ne sont jamais fabriqués ici : seule la réconciliation relit les faits réels", async () => {
  const route = await source("app/api/investment-accounts/route.ts");
  assert.match(route, /reconcileOnboardingForMember\(viewer\.id\)/);
  // Aucune écriture directe de points depuis cette route.
  assert.doesNotMatch(route, /points_ledger/);
  assert.doesNotMatch(route, /apply_challenge_points/);
});

test("la route admin d'origine n'est ni modifiée ni affaiblie", async () => {
  const admin = await source("app/api/admin/accounts/route.ts");
  assert.match(admin, /requireAdmin/);
  // Les quatre verbes admin restent derrière requireAdmin.
  assert.equal((admin.match(/await requireAdmin\(request\)/g) ?? []).length, 4);
});

test("la gestion admin d'un membre peut supprimer son PEA, avec confirmation et garde d'historique", async () => {
  const ui = await source("app/settings-accounts.tsx");
  const admin = await source("app/api/admin/accounts/route.ts");
  // L'aperçu est toujours exécuté avec la session admin : il peut donc gérer le compte existant
  // du membre sans ouvrir la création self-service à une autre identité.
  assert.match(ui, /const canEdit = viewer\.role === "admin" \|\| isAdminPreview/);
  assert.match(ui, /const canDelete = canEdit && account\.accountType === "pea"/);
  assert.match(ui, /Supprimer définitivement le PEA/);
  assert.match(ui, /\/api\/admin\/accounts\?id=\$\{encodeURIComponent\(account\.id\)\}/);
  // En cas d'opérations, l'UI ne force pas la suppression : le compte doit d'abord être vidé.
  assert.match(ui, /requiresConfirmation/);
  assert.match(ui, /Utilisez d’abord « Tout effacer »/);
  assert.match(admin, /if \(!force\)/);
  assert.match(admin, /Ce compte contient des opérations/);
});

test("le formulaire guidé écrit via la route self-service pour un membre, admin pour un admin", async () => {
  const ui = await source("app/settings-accounts.tsx");
  // Le routage des deux chemins est verrouillé ici car il ne peut pas être exercé en navigateur :
  // le bypass ?preview=dashboard code en dur `role: "admin"` (app/auth-shell.tsx), et aucun
  // identifiant de membre n'est disponible hors session Supabase réelle.
  assert.match(ui, /const response = isAdmin/);
  assert.match(ui, /\?\s*await fetch\("\/api\/admin\/accounts"/);
  assert.match(ui, /:\s*await fetch\("\/api\/investment-accounts"/);
  // Le corps envoyé par le membre ne porte AUCUN memberId : le serveur le force depuis la session.
  const selfServiceCall = ui.slice(ui.indexOf('await fetch("/api/investment-accounts"'));
  assert.doesNotMatch(selfServiceCall.slice(0, 400), /memberId/);
  // Le verrou historique `canEdit === admin` sur le formulaire a bien disparu.
  assert.doesNotMatch(ui, /canEdit=\{canEdit\}\s+onSaved/);
  assert.match(ui, /canWrite/);
  // En aperçu admin (scopeOverride), aucune écriture : sinon le compte serait créé au nom de
  // l'administrateur (member_id = session appelante), pas du membre affiché.
  assert.match(ui, /const isAdminPreview = scopeOverride !== undefined/);
  assert.match(ui, /const canWrite = !isAdminPreview/);
});

test("les CTA de défi posent TOUJOURS leur ancre de section (sinon on atterrit sur « Mon compte »)", async () => {
  const page = await source("app/challenges-page.tsx");
  assert.match(page, /function openSettingsSection/);
  // Ce sont exactement les deux boutons qui menaient nulle part.
  assert.match(page, /openSettingsSection\("rythme", onNavigate\)\}>Configurer mon rythme/);
  assert.match(page, /openSettingsSection\("comptes", onNavigate\)\}>Choisir un compte/);
  // dashboardCta transporte la section pour le tableau de bord.
  assert.match(page, /settings: "rythme"/);
  assert.match(page, /settings: "comptes"/);

  // Plus aucune navigation NUE vers « parametres » : chacune atterrirait sur « Mon compte ».
  // La seule occurrence légitime est celle DANS openSettingsSection, qui vient de poser l'ancre.
  const bare = codeOnly(page).match(/\b(?:onNavigate|navigate)\("parametres"\)/g) ?? [];
  assert.equal(bare.length, 1, `navigation nue vers parametres restante : ${bare.length}`);
});

test("settings.tsx lit enfin le paramètre accountType posé par les défis", async () => {
  const settings = await source("app/settings.tsx");
  assert.match(settings, /params\.get\("accountType"\)/);
  assert.match(settings, /guidedAccountType=\{guidedIntent\.accountType\}/);
});

test("« Mon rythme » sans compte propose la création au lieu de renvoyer vers l'administrateur", async () => {
  const rhythm = await source("app/settings-investment-rhythm.tsx");
  assert.match(rhythm, /onCreateAccount/);
  assert.doesNotMatch(rhythm, /Demande à l’administrateur d’en créer un/);
});
