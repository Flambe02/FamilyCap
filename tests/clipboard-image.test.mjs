// COLLAGE D'UNE CAPTURE (Ctrl+V / Cmd+V) — logique pure, testée sans DOM.
//
// Le composant React ne fait que brancher l'écouteur `paste` et appeler ces fonctions ; tout ce
// qui décide est ici, donc testable. Le point vérifié en dernier est le plus important : une
// image collée et un fichier téléversé produisent le MÊME objet `File`, envoyé dans le même
// pipeline — il n'existe pas de second chemin pour les captures collées.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ACCEPTED_IMAGE_TYPES, imageFileFromClipboard, isAcceptedImageType, localFileKey,
  pastedCaptureName, shouldIgnorePaste,
} from "../lib/clipboard-image.ts";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const AT = new Date(2026, 6, 26, 14, 32, 5);

/** Élément de presse-papiers, tel que le navigateur en fournit pour une capture d'écran. */
function imageItem(type = "image/png", name = "image.png") {
  const file = new File([PNG_BYTES], name, { type, lastModified: AT.getTime() });
  return { kind: "file", type, getAsFile: () => file };
}
function textItem(text = "bonjour") {
  return { kind: "string", type: "text/plain", getAsFile: () => null, text };
}

test("une capture d'écran collée devient un File image", () => {
  const file = imageFileFromClipboard({ items: [textItem(), imageItem()] }, AT);
  assert.ok(file instanceof File);
  assert.equal(file.type, "image/png");
  assert.equal(file.size, PNG_BYTES.length);
});

test("la capture générique « image.png » est renommée avec un horodatage lisible", () => {
  const file = imageFileFromClipboard({ items: [imageItem()] }, AT);
  assert.equal(file.name, "capture-2026-07-26-143205.png");
  assert.equal(pastedCaptureName("image/jpeg", AT), "capture-2026-07-26-143205.jpg");
  assert.equal(pastedCaptureName("image/webp", AT), "capture-2026-07-26-143205.webp");
});

test("un fichier image copié depuis l'explorateur conserve son nom", () => {
  const file = imageFileFromClipboard({ items: [imageItem("image/jpeg", "releve-pea-juillet.jpg")] }, AT);
  assert.equal(file.name, "releve-pea-juillet.jpg");
});

test("le collage de texte n'est PAS intercepté", () => {
  assert.equal(imageFileFromClipboard({ items: [textItem()] }, AT), null);
  assert.equal(imageFileFromClipboard({ items: [] }, AT), null);
  assert.equal(imageFileFromClipboard(null, AT), null);
  assert.equal(imageFileFromClipboard({}, AT), null);
});

test("un format d'image non pris en charge est refusé (pas d'échec serveur en 415)", () => {
  assert.equal(imageFileFromClipboard({ items: [imageItem("image/gif", "anim.gif")] }, AT), null);
  assert.equal(imageFileFromClipboard({ items: [imageItem("image/svg+xml", "vecteur.svg")] }, AT), null);
  for (const type of ACCEPTED_IMAGE_TYPES) assert.equal(isAcceptedImageType(type), true);
  assert.equal(isAcceptedImageType("IMAGE/PNG"), true);
  assert.equal(isAcceptedImageType("image/png; charset=binary"), true);
  assert.equal(isAcceptedImageType("application/pdf"), false);
  assert.equal(isAcceptedImageType(null), false);
});

test("le presse-papiers `files` est aussi accepté (glisser d'un fichier copié)", () => {
  const dropped = new File([PNG_BYTES], "capture.webp", { type: "image/webp" });
  assert.equal(imageFileFromClipboard({ files: [dropped] }, AT)?.name, "capture.webp");
});

test("le collage dans un champ de saisie est ignoré", () => {
  // Coller une date dans « Date du relevé » ne doit surtout pas lancer l'analyse d'une image
  // restée dans le presse-papiers.
  assert.equal(shouldIgnorePaste({ tagName: "INPUT" }), true);
  assert.equal(shouldIgnorePaste({ tagName: "TEXTAREA" }), true);
  assert.equal(shouldIgnorePaste({ tagName: "SELECT" }), true);
  assert.equal(shouldIgnorePaste({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(shouldIgnorePaste({ tagName: "DIV", getAttribute: () => "true" }), true);
  assert.equal(shouldIgnorePaste({ tagName: "DIV" }), false);
  assert.equal(shouldIgnorePaste(null), false);
});

test("un même contenu collé deux fois porte la même clé : pas de double analyse", () => {
  const first = imageFileFromClipboard({ items: [imageItem()] }, AT);
  const second = imageFileFromClipboard({ items: [imageItem()] }, AT);
  assert.equal(localFileKey(first), localFileKey(second));
  const other = new File([new Uint8Array([1, 2, 3])], "autre.png", { type: "image/png", lastModified: AT.getTime() });
  assert.notEqual(localFileKey(first), localFileKey(other));
  assert.equal(localFileKey(null), null);
});

test("collage et téléversement empruntent le MÊME pipeline", () => {
  const source = readFileSync(new URL("../app/investment-import-wizard.tsx", import.meta.url), "utf8");
  // Une seule fonction reçoit le fichier, quelle que soit son origine…
  const origins = source.match(/selectFile\([^)]*?"(picked|dropped|pasted)"\)/g) ?? [];
  assert.deepEqual(
    [...new Set(origins.map((call) => call.match(/"(picked|dropped|pasted)"/)[1]))].sort(),
    ["dropped", "pasted", "picked"],
  );
  // …et une seule fonction envoie au serveur (aucune route parallèle pour les images collées).
  assert.equal((source.match(/investment-imports\/scan/g) ?? []).length, 1);
  // L'écouteur n'existe que pendant les étapes où un document peut être choisi, et il est retiré.
  assert.match(source, /document\.addEventListener\("paste", onPaste\)/);
  assert.match(source, /return \(\) => document\.removeEventListener\("paste", onPaste\)/);
  assert.match(source, /if \(shouldIgnorePaste\(event\.target\)\) return;/);
  // Garde anti-double traitement.
  assert.match(source, /lastKey\.current/);
  // Libellés exigés par le cahier des charges.
  assert.ok(source.includes("Déposez, sélectionnez ou collez une capture avec Ctrl+V"));
  assert.ok(source.includes("Image collée"));
  assert.ok(source.includes("Remplacer"));
  assert.ok(source.includes("Supprimer"));
  assert.ok(source.includes("Valider et intégrer le portefeuille"));
});
