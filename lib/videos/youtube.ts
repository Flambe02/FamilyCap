// Extraction et validation robustes d'un identifiant vidéo YouTube, sans dépendance ni DOM
// (module pur, testé). L'iframe n'est JAMAIS construit à partir de l'URL brute : on n'utilise
// que l'identifiant 11 caractères validé, ce qui interdit toute injection via une URL utilisateur.

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

const ALLOWED_HOSTS = new Set([
  "youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "youtube-nocookie.com",
]);

export type YouTubeParts = {
  videoId: string;
  embedUrl: string;
  thumbnailUrl: string;
};

/** Retourne l'identifiant vidéo (11 caractères) ou `null` si l'entrée est invalide. */
export function extractYouTubeVideoId(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const raw = input.trim();
  if (!raw) return null;
  // Identifiant fourni directement.
  if (VIDEO_ID.test(raw)) return raw;

  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const host = url.hostname.replace(/^www\./i, "").toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) return null;

  // youtu.be/<id>
  if (host === "youtu.be") {
    const id = url.pathname.slice(1).split("/")[0] ?? "";
    return VIDEO_ID.test(id) ? id : null;
  }

  // youtube.com/watch?v=<id>
  const v = url.searchParams.get("v");
  if (v && VIDEO_ID.test(v)) return v;

  // /embed/<id>, /shorts/<id>, /live/<id>, /v/<id>
  const match = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/);
  if (match) return match[1];

  return null;
}

export function isValidYouTubeUrl(input: unknown): boolean {
  return extractYouTubeVideoId(input) !== null;
}

/** Miniature : URL personnalisée (http/https valide) si fournie, sinon la vignette YouTube. */
export function getYouTubeThumbnail(videoId: string, custom?: string | null): string {
  const trimmed = typeof custom === "string" ? custom.trim() : "";
  if (trimmed && /^https:\/\/[^\s]+$/i.test(trimmed)) return trimmed;
  return `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
}

/**
 * URL d'intégration. On privilégie youtube-nocookie.com (moins de suivi). L'autoplay n'est
 * activé que sur demande explicite (clic utilisateur) — jamais au chargement de la page.
 */
export function buildEmbedUrl(videoId: string, options: { autoplay?: boolean } = {}): string {
  if (!VIDEO_ID.test(videoId)) throw new Error("Identifiant vidéo YouTube invalide.");
  const params = new URLSearchParams({ rel: "0", modestbranding: "1", playsinline: "1" });
  if (options.autoplay) params.set("autoplay", "1");
  return `https://www.youtube-nocookie.com/embed/${videoId}?${params.toString()}`;
}

/** Analyse complète d'une URL : `{ videoId, embedUrl, thumbnailUrl }` ou `null` si invalide. */
export function parseYouTube(input: unknown, custom?: string | null): YouTubeParts | null {
  const videoId = extractYouTubeVideoId(input);
  if (!videoId) return null;
  return {
    videoId,
    embedUrl: buildEmbedUrl(videoId),
    thumbnailUrl: getYouTubeThumbnail(videoId, custom),
  };
}

/** Durée `H:MM:SS` / `M:SS` à partir d'un nombre de secondes, ou `null`. */
export function formatDuration(seconds: number | null | undefined): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}
