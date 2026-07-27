// COLLAGE D'UNE IMAGE (Ctrl+V / Cmd+V) — logique PURE, sans DOM, donc testable.
//
// Le composant React se contente de brancher un écouteur `paste` et de passer l'événement ici.
// Tout ce qui décide (« est-ce une image ? », « faut-il ignorer ce collage ? », « quel nom de
// fichier ? ») vit dans ce module, et le fichier produit part dans EXACTEMENT le même pipeline
// que le fichier téléversé : `File` → /api/investment-imports/scan. Il n'existe pas de second
// chemin pour les images collées.

/** Formats acceptés par le scan (alignés sur la liste blanche de la route serveur). */
export const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/webp"] as const;

export function isAcceptedImageType(type: string | null | undefined): boolean {
  const normalized = String(type ?? "").toLowerCase().split(";")[0].trim();
  return (ACCEPTED_IMAGE_TYPES as readonly string[]).includes(normalized);
}

/** Extension correspondant au type MIME, pour nommer la capture collée. */
function extensionFor(type: string): string {
  const normalized = type.toLowerCase();
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return "jpg";
  if (normalized.includes("webp")) return "webp";
  return "png";
}

/**
 * Nom donné à une capture collée. Il n'a aucune valeur d'identification (le dédoublonnage se
 * fait sur l'empreinte SHA-256 du contenu), mais il doit rester lisible dans l'historique
 * d'imports : « capture-2026-07-26-1432.png ».
 */
export function pastedCaptureName(type: string, at: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `capture-${stamp}.${extensionFor(type)}`;
}

// Formes minimales de `ClipboardEvent.clipboardData` : on ne dépend pas des types DOM, ce qui
// permet de tester ce module sous Node avec des objets simples.
type ClipboardItemLike = {
  kind?: string;
  type?: string;
  getAsFile?: () => File | null;
};
export type ClipboardDataLike = {
  items?: ArrayLike<ClipboardItemLike> | null;
  files?: ArrayLike<File> | null;
  types?: ReadonlyArray<string> | null;
};

/**
 * Extrait la première IMAGE d'un presse-papiers. Renvoie null si le collage ne contient pas
 * d'image (texte, HTML, fichier d'un autre type) : l'événement doit alors suivre son cours
 * normal, sans être intercepté.
 *
 * Deux sources sont examinées, dans cet ordre :
 *   1. `items` — c'est par là qu'arrive une capture d'écran (Impr. écran, Win+Maj+S, Cmd+Maj+4) :
 *      elle n'a pas de fichier d'origine, seulement un blob typé `image/png` ;
 *   2. `files` — un fichier image copié depuis l'explorateur.
 */
export function imageFileFromClipboard(data: ClipboardDataLike | null | undefined, at: Date = new Date()): File | null {
  if (!data) return null;

  const items = data.items ? Array.from(data.items as ArrayLike<ClipboardItemLike>) : [];
  for (const item of items) {
    const type = String(item?.type ?? "");
    if (!type.toLowerCase().startsWith("image/")) continue;
    if (item.kind && item.kind !== "file") continue;
    const file = item.getAsFile?.() ?? null;
    if (!file) continue;
    if (!isAcceptedImageType(file.type || type)) continue;
    // Une capture d'écran arrive sous le nom générique « image.png » : on le remplace par un nom
    // horodaté, plus parlant dans l'historique des imports.
    const named = !file.name || /^image\.[a-z]+$/i.test(file.name);
    return named ? renameFile(file, pastedCaptureName(file.type || type, at)) : file;
  }

  const files = data.files ? Array.from(data.files as ArrayLike<File>) : [];
  for (const file of files) {
    if (isAcceptedImageType(file.type)) return file;
  }
  return null;
}

/** Recrée un File avec un autre nom (File est immuable). */
function renameFile(file: File, name: string): File {
  try {
    return new File([file], name, { type: file.type || "image/png", lastModified: file.lastModified });
  } catch {
    return file;
  }
}

/**
 * Le collage doit-il être IGNORÉ ? Oui dès que l'utilisateur est en train d'écrire : coller du
 * texte dans un champ « date du relevé » ou « nom du compte » ne doit surtout pas déclencher
 * l'analyse d'une image restée dans le presse-papiers.
 */
export function shouldIgnorePaste(target: unknown): boolean {
  if (!target || typeof target !== "object") return false;
  const element = target as { tagName?: string; isContentEditable?: boolean; getAttribute?: (name: string) => string | null };
  const tag = String(element.tagName ?? "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (element.isContentEditable) return true;
  return element.getAttribute?.("contenteditable") === "true";
}

/**
 * Empreinte simple d'un fichier pour écarter un DOUBLE traitement immédiat : un même collage
 * peut être notifié deux fois (événement `paste` + `drop` sur certains navigateurs), et deux
 * analyses simultanées de la même capture consommeraient deux fois le service d'IA.
 * Ce n'est PAS le dédoublonnage d'import (qui, lui, repose sur le SHA-256 calculé côté serveur).
 */
export function localFileKey(file: File | null): string | null {
  return file ? `${file.name}|${file.size}|${file.type}|${file.lastModified}` : null;
}
