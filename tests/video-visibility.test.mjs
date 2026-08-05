// Tests unitaires de la visibilité / filtrage / tri des vidéos (lib/videos/video-visibility.ts).
// Exécution : `node --test tests/video-visibility.test.mjs` (Node ≥ 22.18 : type-stripping natif).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canMemberViewVideo,
  countByTab,
  filterVideos,
  findWelcomePopupVideo,
  sortVideos,
  availableYears,
} from "../lib/videos/video-visibility.ts";

// `recipients` est retiré de `partial` puis renormalisé séparément : chaque entrée passée par un
// test (ex. `{ memberId, name }`) reçoit `isNotify: true, isLibrary: true` par défaut — un
// destinataire « classique », comptant pour les deux publics — sauf override explicite (ex.
// `{ ..., isLibrary: false }` pour tester un destinataire pop-up seulement).
function video({ recipients: rawRecipients, ...partial }) {
  return {
    id: "v",
    title: "Titre",
    description: null,
    youtubeVideoId: "dQw4w9WgXcQ",
    youtubeUrl: "https://youtu.be/dQw4w9WgXcQ",
    thumbnailUrl: null,
    durationSeconds: null,
    occasionType: "birthday",
    occasionDate: "2026-03-15",
    visibilityScope: "family",
    isPublished: true,
    isArchived: false,
    publishedAt: "2026-03-15T00:00:00Z",
    publishAt: null,
    notifyOnLogin: false,
    notifyAll: false,
    giftId: null,
    gift: null,
    viewed: false,
    ...partial,
    recipients: (rawRecipients ?? []).map((recipient) => ({ isNotify: true, isLibrary: true, ...recipient })),
  };
}

const admin = { memberId: "admin-id", name: "Florent", isAdmin: true };
const thibault = { memberId: "thibault-id", name: "Thibault", isAdmin: false };
const paul = { memberId: "paul-id", name: "Paul", isAdmin: false };
// Aperçu admin : l'identifiant reste celui de l'admin, seul le prénom change.
const previewThibault = { memberId: "admin-id", name: "Thibault", isAdmin: false };

/* ---- Visibilité ---- */
test("admin voit tout, brouillons compris", () => {
  assert.equal(canMemberViewVideo(video({ isPublished: false }), admin), true);
  assert.equal(canMemberViewVideo(video({ visibilityScope: "private", recipients: [{ memberId: "x", name: "Autre" }] }), admin), true);
});

test("vidéo famille publiée visible par tout membre", () => {
  assert.equal(canMemberViewVideo(video({ visibilityScope: "family" }), thibault), true);
});

test("vidéo privée visible par son destinataire (par id)", () => {
  const v = video({ visibilityScope: "private", recipients: [{ memberId: "thibault-id", name: "Thibault" }] });
  assert.equal(canMemberViewVideo(v, thibault), true);
});

test("vidéo privée d'un autre membre refusée", () => {
  const v = video({ visibilityScope: "private", recipients: [{ memberId: "thibault-id", name: "Thibault" }] });
  assert.equal(canMemberViewVideo(v, paul), false);
});

test("vidéo multi-destinataires visible par chacun d'eux", () => {
  const v = video({ visibilityScope: "selected_members", recipients: [{ memberId: "thibault-id", name: "Thibault" }, { memberId: "paul-id", name: "Paul" }] });
  assert.equal(canMemberViewVideo(v, thibault), true);
  assert.equal(canMemberViewVideo(v, paul), true);
});

test("brouillon / dépubliée jamais visible pour un membre", () => {
  assert.equal(canMemberViewVideo(video({ isPublished: false }), thibault), false);
  assert.equal(canMemberViewVideo(video({ isArchived: true }), thibault), false);
});

test("aperçu admin : correspondance par prénom, pas par id admin", () => {
  const v = video({ visibilityScope: "private", recipients: [{ memberId: "thibault-id", name: "Thibault" }] });
  assert.equal(canMemberViewVideo(v, previewThibault), true);
  const other = video({ visibilityScope: "private", recipients: [{ memberId: "paul-id", name: "Paul" }] });
  assert.equal(canMemberViewVideo(other, previewThibault), false);
});

test("canMemberViewVideo : notifyAll ne donne jamais accès à la bibliothèque Souvenirs (réglages indépendants)", () => {
  const v = video({ visibilityScope: "selected_members", notifyOnLogin: true, notifyAll: true, recipients: [{ memberId: "thibault-id", name: "Thibault" }] });
  assert.equal(canMemberViewVideo(v, paul), false);
});

/* ---- Deux LISTES de destinataires indépendantes (isNotify / isLibrary sur une même vidéo) ----
 * Pas seulement deux réglages globaux : deux membres différents peuvent chacun être destinataire
 * d'un seul des deux publics sur la MÊME vidéo (ex. Thibault pour le pop-up, Paul pour Souvenirs). */
test("canMemberViewVideo : un destinataire isNotify-only n'a pas accès à la bibliothèque Souvenirs", () => {
  const v = video({ visibilityScope: "selected_members", recipients: [{ memberId: "thibault-id", name: "Thibault", isLibrary: false }] });
  assert.equal(canMemberViewVideo(v, thibault), false);
});

test("canMemberViewVideo : un destinataire isLibrary-only garde l'accès à la bibliothèque Souvenirs", () => {
  const v = video({ visibilityScope: "selected_members", recipients: [{ memberId: "paul-id", name: "Paul", isNotify: false }] });
  assert.equal(canMemberViewVideo(v, paul), true);
});

test("findWelcomePopupVideo : un destinataire isLibrary-only ne reçoit jamais le pop-up", () => {
  const v = video({ visibilityScope: "selected_members", notifyOnLogin: true, recipients: [{ memberId: "paul-id", name: "Paul", isNotify: false }] });
  assert.equal(findWelcomePopupVideo([v], paul), null);
});

test("findWelcomePopupVideo : un destinataire isNotify-only reçoit le pop-up malgré isLibrary=false", () => {
  const v = video({ visibilityScope: "selected_members", notifyOnLogin: true, recipients: [{ memberId: "thibault-id", name: "Thibault", isLibrary: false }] });
  assert.equal(findWelcomePopupVideo([v], thibault)?.id, "v");
});

test("deux listes vraiment distinctes sur la même vidéo : Thibault pop-up seul, Paul Souvenirs seul", () => {
  const v = video({
    visibilityScope: "selected_members",
    notifyOnLogin: true,
    recipients: [
      { memberId: "thibault-id", name: "Thibault", isLibrary: false },
      { memberId: "paul-id", name: "Paul", isNotify: false },
    ],
  });
  assert.equal(findWelcomePopupVideo([v], thibault)?.id, "v");
  assert.equal(findWelcomePopupVideo([v], paul), null);
  assert.equal(canMemberViewVideo(v, thibault), false);
  assert.equal(canMemberViewVideo(v, paul), true);
});

/* ---- Publication programmée (publishAt) ---- */
test("canMemberViewVideo : publication programmée dans le futur masquée à un membre, visible à l'admin", () => {
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const v = video({ visibilityScope: "family", publishAt: future });
  assert.equal(canMemberViewVideo(v, thibault), false);
  assert.equal(canMemberViewVideo(v, admin), true);
});

test("canMemberViewVideo : publication programmée déjà atteinte visible normalement", () => {
  const past = new Date(Date.now() - 86_400_000).toISOString();
  const v = video({ visibilityScope: "family", publishAt: past });
  assert.equal(canMemberViewVideo(v, thibault), true);
});

/* ---- Pop-up de bienvenue (notifyOnLogin — posé par un cadeau lié ou le formulaire admin) ---- */
test("findWelcomePopupVideo : jamais pour l'administrateur", () => {
  const v = video({ visibilityScope: "selected_members", notifyOnLogin: true, recipients: [{ memberId: "thibault-id", name: "Thibault" }] });
  assert.equal(findWelcomePopupVideo([v], admin), null);
});

/* ---- notifyAll / visibilityScope : deux réglages INDÉPENDANTS ----
 * notifyAll pilote le public du pop-up ; visibilityScope ne pilote que l'accès à la bibliothèque
 * Souvenirs après coup. Aucune des quatre combinaisons ne doit influencer l'autre réglage. */
test("findWelcomePopupVideo : notifyAll déclenche le pop-up pour tout le monde, même en bibliothèque family", () => {
  const v = video({ visibilityScope: "family", notifyOnLogin: true, notifyAll: true });
  assert.equal(findWelcomePopupVideo([v], thibault)?.id, "v");
  assert.equal(findWelcomePopupVideo([v], paul)?.id, "v");
});

test("findWelcomePopupVideo : notifyAll déclenche le pop-up même pour un non-destinataire d'une bibliothèque restreinte", () => {
  const v = video({ visibilityScope: "selected_members", notifyOnLogin: true, notifyAll: true, recipients: [{ memberId: "thibault-id", name: "Thibault" }] });
  // Paul n'est pas destinataire (donc ne pourra pas la retrouver dans Souvenirs), mais reçoit le pop-up.
  assert.equal(findWelcomePopupVideo([v], paul)?.id, "v");
});

test("findWelcomePopupVideo : sans notifyAll, une bibliothèque family n'ouvre pas le pop-up à un non-destinataire", () => {
  const v = video({ visibilityScope: "family", notifyOnLogin: true, notifyAll: false, recipients: [{ memberId: "thibault-id", name: "Thibault" }] });
  assert.equal(findWelcomePopupVideo([v], thibault)?.id, "v");
  assert.equal(findWelcomePopupVideo([v], paul), null);
});

test("findWelcomePopupVideo : sans notifyOnLogin, pas de pop-up (une vidéo de bibliothèque ne surgit jamais seule)", () => {
  const v = video({ visibilityScope: "selected_members", notifyOnLogin: false, giftId: "g1", recipients: [{ memberId: "thibault-id", name: "Thibault" }] });
  assert.equal(findWelcomePopupVideo([v], thibault), null);
});

test("findWelcomePopupVideo : vidéo déjà vue exclue", () => {
  const v = video({ visibilityScope: "selected_members", notifyOnLogin: true, viewed: true, recipients: [{ memberId: "thibault-id", name: "Thibault" }] });
  assert.equal(findWelcomePopupVideo([v], thibault), null);
});

test("findWelcomePopupVideo : notifyOnLogin, non vue, pour le bon destinataire → retenue", () => {
  const v = video({ id: "v1", visibilityScope: "selected_members", notifyOnLogin: true, recipients: [{ memberId: "thibault-id", name: "Thibault" }] });
  assert.equal(findWelcomePopupVideo([v], thibault)?.id, "v1");
  assert.equal(findWelcomePopupVideo([v], paul), null);
});

test("findWelcomePopupVideo : la plus ancienne non vue sort en premier", () => {
  const recent = video({ id: "recent", occasionDate: "2026-06-01", visibilityScope: "selected_members", notifyOnLogin: true, recipients: [{ memberId: "thibault-id", name: "Thibault" }] });
  const old = video({ id: "old", occasionDate: "2025-01-01", visibilityScope: "selected_members", notifyOnLogin: true, recipients: [{ memberId: "thibault-id", name: "Thibault" }] });
  assert.equal(findWelcomePopupVideo([recent, old], thibault)?.id, "old");
});

test("findWelcomePopupVideo : publication programmée dans le futur ne se déclenche pas encore", () => {
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const v = video({ visibilityScope: "selected_members", notifyOnLogin: true, publishAt: future, recipients: [{ memberId: "thibault-id", name: "Thibault" }] });
  assert.equal(findWelcomePopupVideo([v], thibault), null);
});

test("findWelcomePopupVideo : publication programmée déjà atteinte se déclenche", () => {
  const past = new Date(Date.now() - 86_400_000).toISOString();
  const v = video({ id: "v1", visibilityScope: "selected_members", notifyOnLogin: true, publishAt: past, recipients: [{ memberId: "thibault-id", name: "Thibault" }] });
  assert.equal(findWelcomePopupVideo([v], thibault)?.id, "v1");
});

/* ---- Compteurs d'onglets ---- */
test("compteurs par onglet réels", () => {
  const list = [
    video({ occasionType: "birthday" }),
    video({ occasionType: "birthday" }),
    video({ occasionType: "christmas" }),
    video({ occasionType: "general" }),
    video({ occasionType: "other" }),
  ];
  const counts = countByTab(list);
  assert.equal(counts.all, 5);
  assert.equal(counts.birthday, 2);
  assert.equal(counts.christmas, 1);
  assert.equal(counts.other, 2); // general + other
});

/* ---- Filtres ---- */
test("filtre destinataire « Moi »", () => {
  const list = [
    video({ id: "a", visibilityScope: "private", recipients: [{ memberId: "thibault-id", name: "Thibault" }] }),
    video({ id: "b", visibilityScope: "private", recipients: [{ memberId: "paul-id", name: "Paul" }] }),
  ];
  const filtered = filterVideos(list, { recipient: "Moi", occasion: "Toutes", year: "Toutes", tab: "all", search: "" }, thibault);
  assert.deepEqual(filtered.map((v) => v.id), ["a"]);
});

test("filtre destinataire « Toute la famille »", () => {
  const list = [video({ id: "a", visibilityScope: "family" }), video({ id: "b", visibilityScope: "private", recipients: [{ memberId: "paul-id", name: "Paul" }] })];
  const filtered = filterVideos(list, { recipient: "Toute la famille", occasion: "Toutes", year: "Toutes", tab: "all", search: "" }, admin);
  assert.deepEqual(filtered.map((v) => v.id), ["a"]);
});

test("filtre occasion + année + onglet", () => {
  const list = [
    video({ id: "a", occasionType: "birthday", occasionDate: "2026-03-15" }),
    video({ id: "b", occasionType: "christmas", occasionDate: "2025-12-25" }),
  ];
  assert.deepEqual(filterVideos(list, { recipient: "Tous", occasion: "birthday", year: "Toutes", tab: "all", search: "" }, admin).map((v) => v.id), ["a"]);
  assert.deepEqual(filterVideos(list, { recipient: "Tous", occasion: "Toutes", year: "2025", tab: "all", search: "" }, admin).map((v) => v.id), ["b"]);
  assert.deepEqual(filterVideos(list, { recipient: "Tous", occasion: "Toutes", year: "Toutes", tab: "christmas", search: "" }, admin).map((v) => v.id), ["b"]);
});

test("recherche sur titre / prénom / occasion", () => {
  const list = [
    video({ id: "a", title: "Joyeux anniversaire Thibault", recipients: [{ memberId: "thibault-id", name: "Thibault" }] }),
    video({ id: "b", title: "Message pour tous", occasionType: "general" }),
  ];
  assert.deepEqual(filterVideos(list, { recipient: "Tous", occasion: "Toutes", year: "Toutes", tab: "all", search: "thibault" }, admin).map((v) => v.id), ["a"]);
  assert.deepEqual(filterVideos(list, { recipient: "Tous", occasion: "Toutes", year: "Toutes", tab: "all", search: "général" }, admin).map((v) => v.id), ["b"]);
});

/* ---- Tri ---- */
test("tri par défaut : non-vues d'abord puis date d'occasion décroissante", () => {
  const list = [
    video({ id: "vieux-vu", occasionDate: "2024-01-01", viewed: true }),
    video({ id: "recent-vu", occasionDate: "2026-05-01", viewed: true }),
    video({ id: "non-vu", occasionDate: "2025-01-01", viewed: false }),
  ];
  assert.deepEqual(sortVideos(list).map((v) => v.id), ["non-vu", "recent-vu", "vieux-vu"]);
});

test("tri « plus anciennes »", () => {
  const list = [video({ id: "a", occasionDate: "2026-01-01" }), video({ id: "b", occasionDate: "2024-01-01" })];
  assert.deepEqual(sortVideos(list, "oldest").map((v) => v.id), ["b", "a"]);
});

/* ---- Années dynamiques ---- */
test("availableYears décroissantes et dédupliquées", () => {
  const list = [video({ occasionDate: "2026-03-15" }), video({ occasionDate: "2025-12-25" }), video({ occasionDate: "2026-01-01" })];
  assert.deepEqual(availableYears(list), ["2026", "2025"]);
});
