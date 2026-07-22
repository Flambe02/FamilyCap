// Tests unitaires de la visibilité / filtrage / tri des vidéos (lib/videos/video-visibility.ts).
// Exécution : `node --test tests/video-visibility.test.mjs` (Node ≥ 22.18 : type-stripping natif).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canMemberViewVideo,
  countByTab,
  filterVideos,
  sortVideos,
  availableYears,
} from "../lib/videos/video-visibility.ts";

function video(partial) {
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
    giftId: null,
    gift: null,
    recipients: [],
    viewed: false,
    ...partial,
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
