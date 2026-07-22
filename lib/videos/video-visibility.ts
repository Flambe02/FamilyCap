// Domaine « Souvenirs » : types partagés (serveur + client) et logique PURE de visibilité,
// de filtrage et de tri. Aucune dépendance réseau/DOM — module directement testable.

export type OccasionType = "birthday" | "christmas" | "general" | "other";
export type VisibilityScope = "private" | "selected_members" | "family";

export const OCCASION_TYPES: OccasionType[] = ["birthday", "christmas", "general", "other"];
export const VISIBILITY_SCOPES: VisibilityScope[] = ["private", "selected_members", "family"];

export const OCCASION_LABEL: Record<OccasionType, string> = {
  birthday: "Anniversaire",
  christmas: "Noël",
  general: "Message général",
  other: "Autre",
};

export type VideoRecipient = { memberId: string; name: string | null };

export type VideoGift = {
  amountEur: number;
  btcAmount: number;
  occasion: string | null;
  giftDate: string | null;
  memberName: string | null;
};

export type VideoRecord = {
  id: string;
  title: string;
  description: string | null;
  youtubeVideoId: string;
  youtubeUrl: string;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  occasionType: OccasionType;
  occasionDate: string | null;
  visibilityScope: VisibilityScope;
  isPublished: boolean;
  isArchived: boolean;
  publishedAt: string | null;
  giftId: string | null;
  gift: VideoGift | null;
  recipients: VideoRecipient[];
  viewed: boolean;
};

// Contexte de l'observateur. En aperçu administrateur, `memberId` reste celui de l'admin :
// on autorise donc aussi la correspondance par prénom (`name`) pour scoper l'affichage au
// membre simulé sans jamais s'appuyer sur l'identifiant admin.
export type ViewerContext = { memberId: string | null; name: string; isAdmin: boolean };

/**
 * Un observateur peut-il voir cette vidéo ?
 *  - administrateur                 -> oui (brouillons compris) ;
 *  - sinon, vidéo publiée non archivée ET
 *      portée `family`  OU  l'observateur figure parmi les destinataires (par id ou par prénom).
 * Les vidéos privées d'un AUTRE membre, les brouillons et les vidéos dépubliées restent masqués.
 */
export function canMemberViewVideo(video: VideoRecord, viewer: ViewerContext): boolean {
  if (viewer.isAdmin) return true;
  if (!video.isPublished || video.isArchived) return false;
  if (video.visibilityScope === "family") return true;
  return video.recipients.some(
    (recipient) =>
      (viewer.memberId !== null && recipient.memberId === viewer.memberId) ||
      (recipient.name !== null && recipient.name === viewer.name),
  );
}

export function occasionMatchesTab(video: VideoRecord, tab: OccasionTabKey): boolean {
  switch (tab) {
    case "all":
      return true;
    case "birthday":
      return video.occasionType === "birthday";
    case "christmas":
      return video.occasionType === "christmas";
    case "other":
      return video.occasionType === "general" || video.occasionType === "other";
    default:
      return false;
  }
}

export type OccasionTabKey = "all" | "birthday" | "christmas" | "other";

export const OCCASION_TABS: { key: OccasionTabKey; label: string }[] = [
  { key: "all", label: "Toutes les vidéos" },
  { key: "birthday", label: "Anniversaires" },
  { key: "christmas", label: "Noël" },
  { key: "other", label: "Autres occasions" },
];

/** Compteurs réels par onglet, sur l'ensemble déjà restreint aux droits de l'observateur. */
export function countByTab(videos: VideoRecord[]): Record<OccasionTabKey, number> {
  return {
    all: videos.length,
    birthday: videos.filter((video) => occasionMatchesTab(video, "birthday")).length,
    christmas: videos.filter((video) => occasionMatchesTab(video, "christmas")).length,
    other: videos.filter((video) => occasionMatchesTab(video, "other")).length,
  };
}

export type SortKey = "default" | "recent" | "oldest" | "unseen" | "birthday" | "christmas";

function occasionDateValue(video: VideoRecord): number {
  const source = video.occasionDate ?? video.publishedAt;
  const time = source ? new Date(source).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

/**
 * Tri par défaut : non-vues d'abord, puis date d'occasion décroissante, puis publication
 * décroissante. Les autres clés sont des variantes explicites choisies par l'utilisateur.
 */
export function sortVideos(videos: VideoRecord[], key: SortKey = "default"): VideoRecord[] {
  const list = [...videos];
  const byOccasionDesc = (a: VideoRecord, b: VideoRecord) => occasionDateValue(b) - occasionDateValue(a);
  switch (key) {
    case "recent":
      return list.sort(byOccasionDesc);
    case "oldest":
      return list.sort((a, b) => occasionDateValue(a) - occasionDateValue(b));
    case "unseen":
      return list.sort((a, b) => Number(a.viewed) - Number(b.viewed) || byOccasionDesc(a, b));
    case "birthday":
      return list.sort((a, b) => Number(b.occasionType === "birthday") - Number(a.occasionType === "birthday") || byOccasionDesc(a, b));
    case "christmas":
      return list.sort((a, b) => Number(b.occasionType === "christmas") - Number(a.occasionType === "christmas") || byOccasionDesc(a, b));
    case "default":
    default:
      return list.sort((a, b) => Number(a.viewed) - Number(b.viewed) || byOccasionDesc(a, b));
  }
}

export type VideoFilters = {
  recipient: string; // "Tous" | "Moi" | "Toute la famille" | prénom
  occasion: string; // "Toutes" | OccasionType
  year: string; // "Toutes" | "2026" ...
  tab: OccasionTabKey;
  search: string;
};

function videoYear(video: VideoRecord): string | null {
  const source = video.occasionDate ?? video.publishedAt;
  return source ? source.slice(0, 4) : null;
}

/** Filtrage combiné (destinataire + occasion + année + onglet + recherche). Pur et testable. */
export function filterVideos(videos: VideoRecord[], filters: VideoFilters, viewer: ViewerContext): VideoRecord[] {
  const search = filters.search.trim().toLowerCase();
  return videos.filter((video) => {
    if (!occasionMatchesTab(video, filters.tab)) return false;

    if (filters.occasion !== "Toutes" && video.occasionType !== filters.occasion) return false;

    if (filters.year !== "Toutes" && videoYear(video) !== filters.year) return false;

    if (filters.recipient !== "Tous") {
      if (filters.recipient === "Toute la famille") {
        if (video.visibilityScope !== "family") return false;
      } else if (filters.recipient === "Moi") {
        const mine = video.recipients.some(
          (recipient) =>
            (viewer.memberId !== null && recipient.memberId === viewer.memberId) ||
            (recipient.name !== null && recipient.name === viewer.name),
        );
        if (!mine) return false;
      } else if (!video.recipients.some((recipient) => recipient.name === filters.recipient)) {
        return false;
      }
    }

    if (search) {
      const haystack = [
        video.title,
        video.description ?? "",
        OCCASION_LABEL[video.occasionType],
        videoYear(video) ?? "",
        video.recipients.map((recipient) => recipient.name ?? "").join(" "),
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(search)) return false;
    }

    return true;
  });
}

/** Années présentes dans les données (pour le filtre dynamique), décroissantes. */
export function availableYears(videos: VideoRecord[]): string[] {
  return [...new Set(videos.map(videoYear).filter((year): year is string => year !== null))].sort().reverse();
}
