// Tests unitaires de l'extraction / validation / construction YouTube (lib/videos/youtube.ts).
// Exécution : `node --test tests/youtube.test.mjs` (Node ≥ 22.18 : type-stripping natif).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractYouTubeVideoId,
  isValidYouTubeUrl,
  getYouTubeThumbnail,
  buildEmbedUrl,
  parseYouTube,
  formatDuration,
} from "../lib/videos/youtube.ts";

const ID = "dQw4w9WgXcQ";

/* ---- Extraction d'identifiant ---- */
test("watch?v=ID", () => {
  assert.equal(extractYouTubeVideoId(`https://www.youtube.com/watch?v=${ID}`), ID);
});

test("youtu.be/ID", () => {
  assert.equal(extractYouTubeVideoId(`https://youtu.be/${ID}`), ID);
});

test("youtube.com/shorts/ID", () => {
  assert.equal(extractYouTubeVideoId(`https://www.youtube.com/shorts/${ID}`), ID);
});

test("youtube.com/embed/ID", () => {
  assert.equal(extractYouTubeVideoId(`https://www.youtube.com/embed/${ID}`), ID);
});

test("youtube-nocookie.com/embed/ID", () => {
  assert.equal(extractYouTubeVideoId(`https://www.youtube-nocookie.com/embed/${ID}`), ID);
});

test("paramètres additionnels (t, si, list) ignorés", () => {
  assert.equal(extractYouTubeVideoId(`https://www.youtube.com/watch?v=${ID}&t=42s&list=PL123`), ID);
  assert.equal(extractYouTubeVideoId(`https://youtu.be/${ID}?si=abcdEFGH`), ID);
});

test("identifiant nu accepté", () => {
  assert.equal(extractYouTubeVideoId(ID), ID);
});

test("sans schéma mais hôte youtube", () => {
  assert.equal(extractYouTubeVideoId(`youtube.com/watch?v=${ID}`), ID);
});

/* ---- Refus des entrées invalides ---- */
test("hôte non-YouTube refusé (anti-injection)", () => {
  assert.equal(extractYouTubeVideoId(`https://evil.com/watch?v=${ID}`), null);
  assert.equal(extractYouTubeVideoId(`https://evil.com/embed/${ID}`), null);
});

test("javascript: refusé", () => {
  assert.equal(extractYouTubeVideoId(`javascript:alert(1)//youtube.com/watch?v=${ID}`), null);
});

test("id de mauvaise longueur refusé", () => {
  assert.equal(extractYouTubeVideoId("https://youtu.be/tooshort"), null);
  assert.equal(extractYouTubeVideoId("https://www.youtube.com/watch?v=waytoolongid123"), null);
});

test("entrées vides / non-string refusées", () => {
  assert.equal(extractYouTubeVideoId(""), null);
  assert.equal(extractYouTubeVideoId("   "), null);
  assert.equal(extractYouTubeVideoId(null), null);
  assert.equal(extractYouTubeVideoId(undefined), null);
  assert.equal(extractYouTubeVideoId(42), null);
});

test("isValidYouTubeUrl reflète l'extraction", () => {
  assert.equal(isValidYouTubeUrl(`https://youtu.be/${ID}`), true);
  assert.equal(isValidYouTubeUrl("https://evil.com/x"), false);
});

/* ---- Miniature ---- */
test("miniature YouTube par défaut", () => {
  assert.equal(getYouTubeThumbnail(ID), `https://img.youtube.com/vi/${ID}/hqdefault.jpg`);
});

test("miniature personnalisée https respectée", () => {
  assert.equal(getYouTubeThumbnail(ID, "https://cdn.example.com/thumb.jpg"), "https://cdn.example.com/thumb.jpg");
});

test("miniature personnalisée non-https ignorée", () => {
  assert.equal(getYouTubeThumbnail(ID, "http://cdn.example.com/x.jpg"), `https://img.youtube.com/vi/${ID}/hqdefault.jpg`);
  assert.equal(getYouTubeThumbnail(ID, "  "), `https://img.youtube.com/vi/${ID}/hqdefault.jpg`);
});

/* ---- Embed ---- */
test("embed nocookie sans autoplay", () => {
  const url = buildEmbedUrl(ID);
  assert.ok(url.startsWith(`https://www.youtube-nocookie.com/embed/${ID}?`));
  assert.match(url, /rel=0/);
  assert.match(url, /modestbranding=1/);
  assert.match(url, /playsinline=1/);
  assert.doesNotMatch(url, /autoplay/);
});

test("embed avec autoplay explicite", () => {
  assert.match(buildEmbedUrl(ID, { autoplay: true }), /autoplay=1/);
});

test("embed refuse un id invalide", () => {
  assert.throws(() => buildEmbedUrl("bad"));
});

/* ---- parseYouTube ---- */
test("parseYouTube renvoie le triplet complet", () => {
  const parts = parseYouTube(`https://www.youtube.com/watch?v=${ID}`);
  assert.deepEqual(parts, {
    videoId: ID,
    embedUrl: buildEmbedUrl(ID),
    thumbnailUrl: `https://img.youtube.com/vi/${ID}/hqdefault.jpg`,
  });
});

test("parseYouTube renvoie null si invalide", () => {
  assert.equal(parseYouTube("https://evil.com/x"), null);
});

/* ---- Durée ---- */
test("formatDuration", () => {
  assert.equal(formatDuration(84), "1:24");
  assert.equal(formatDuration(70), "1:10");
  assert.equal(formatDuration(3661), "1:01:01");
  assert.equal(formatDuration(0), null);
  assert.equal(formatDuration(null), null);
  assert.equal(formatDuration(undefined), null);
});
