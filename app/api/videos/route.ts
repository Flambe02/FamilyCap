import { authErrorResponse, requireAdmin, requireFamilyMember, type AuthenticatedMember } from "../../../lib/auth-server";
import { isSupabaseConfigured, supabaseRest } from "../../../lib/supabase-rest";
import { extractYouTubeVideoId } from "../../../lib/videos/youtube";
import { OCCASION_TYPES, VISIBILITY_SCOPES, type OccasionType, type VisibilityScope } from "../../../lib/videos/video-visibility";

// Espace « Souvenirs ». La frontière de sécurité réelle est ce code serveur (la service-role
// contourne la RLS) : un membre ne reçoit QUE les vidéos qu'il a le droit de voir, calculées ici.
// L'administrateur gère les vidéos ; un membre lit ; personne n'écrit une vidéo côté membre.

const SELECT =
  "id,title,description,youtube_url,youtube_video_id,thumbnail_url,duration_seconds,occasion_type,occasion_date,visibility_scope,is_published,is_archived,published_at,publish_at,notify_on_login,notify_all,gift_id," +
  "recipients:family_video_recipients(member_id,is_notify,is_library,member:family_members(name))," +
  "gift:gift_records(amount_eur,btc_amount,occasion,gift_date,member_name)";

type RecipientRow = { member_id: string; is_notify: boolean; is_library: boolean; member: { name: string | null } | null };
type VideoRow = {
  id: string;
  visibility_scope: VisibilityScope;
  is_published: boolean;
  is_archived: boolean;
  publish_at: string | null;
  notify_on_login: boolean;
  notify_all: boolean;
  recipients: RecipientRow[] | null;
  [key: string]: unknown;
};

type VideoInput = {
  id?: string;
  action?: "publish" | "unpublish";
  title?: string;
  description?: string | null;
  youtubeUrl?: string;
  thumbnailUrl?: string | null;
  durationSeconds?: number | null;
  occasionType?: string;
  occasionDate?: string | null;
  visibilityScope?: string;
  recipientNames?: unknown;
  notifyRecipientNames?: unknown;
  giftId?: string | null;
  publishAt?: string | null;
  notifyOnLogin?: boolean;
  notifyAll?: boolean;
  publish?: boolean;
};

function isMissingVideoSchema(error: unknown) {
  return (
    error instanceof Error &&
    (error.message.includes("family_video") ||
      error.message.includes("PGRST205") ||
      error.message.includes("PGRST200") ||
      error.message.includes("PGRST106"))
  );
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseNames(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((name): name is string => typeof name === "string" && name.trim() !== "").map((name) => name.trim()) : [];
}

// `recipientNames` (bibliothèque Souvenirs, visibilityScope="selected_members") et
// `notifyRecipientNames` (public du pop-up, notifyOnLogin sans notifyAll) sont deux listes
// INDÉPENDANTES : un destinataire peut figurer dans l'une, l'autre, ou les deux (voir
// family_video_recipients.is_notify/is_library, migration 20260824). Quand
// `notifyRecipientNames` est omis (appelants historiques : lien cadeau, ajout depuis Souvenirs),
// on retombe sur `recipientNames` — reproduisant exactement le comportement d'avant la
// dissociation, où une seule liste servait aux deux fins.
function libraryNamesOf(body: VideoInput): string[] {
  return parseNames(body.recipientNames);
}
function notifyNamesOf(body: VideoInput): string[] {
  return body.notifyRecipientNames !== undefined ? parseNames(body.notifyRecipientNames) : libraryNamesOf(body);
}

function validate(body: VideoInput): string | null {
  if (!body.title?.trim()) return "Le titre est obligatoire.";
  if (!body.youtubeUrl || !extractYouTubeVideoId(body.youtubeUrl)) return "L'URL YouTube est invalide.";
  if (!body.occasionType || !OCCASION_TYPES.includes(body.occasionType as OccasionType)) return "Occasion invalide.";
  if (!body.visibilityScope || !VISIBILITY_SCOPES.includes(body.visibilityScope as VisibilityScope)) return "Portée de visibilité invalide.";
  if (body.occasionDate && !DATE_RE.test(body.occasionDate)) return "Date d'occasion invalide.";
  if (body.durationSeconds !== undefined && body.durationSeconds !== null && (!Number.isFinite(body.durationSeconds) || Number(body.durationSeconds) < 0)) return "Durée invalide.";
  if (body.publishAt && Number.isNaN(new Date(body.publishAt).getTime())) return "Date de publication invalide.";
  // Chaque liste de destinataires est requise indépendamment, dès que SON réglage en a besoin :
  // la bibliothèque Souvenirs restreinte (visibilityScope "selected_members") a besoin de
  // recipientNames ; un pop-up ciblé (notifyOnLogin sans notifyAll) a besoin de
  // notifyRecipientNames. Un pop-up « tout le monde » ou une bibliothèque « toute la famille »
  // n'en ont, chacun pour leur part, pas besoin.
  if (body.visibilityScope === "selected_members" && libraryNamesOf(body).length === 0) return "Sélectionnez au moins un destinataire pour Souvenirs, ou choisissez « tout le monde » pour ce réglage.";
  if (body.notifyOnLogin === true && body.notifyAll !== true && notifyNamesOf(body).length === 0) return "Sélectionnez au moins un destinataire pour le pop-up, ou choisissez « tout le monde » pour ce réglage.";
  return null;
}

async function memberNameMap(): Promise<Map<string, string>> {
  const rows = await supabaseRest<Array<{ id: string; name: string }>>("family_members?select=id,name&is_active=eq.true");
  return new Map(rows.map((row) => [row.name, row.id]));
}

async function resolveIds(names: string[], map: Map<string, string>): Promise<{ ids: string[]; error?: string }> {
  const ids: string[] = [];
  for (const name of names) {
    const id = map.get(name);
    if (!id) return { ids: [], error: `Destinataire inconnu : ${name}.` };
    ids.push(id);
  }
  return { ids: [...new Set(ids)] };
}

// Résout les DEUX listes (bibliothèque et pop-up) en une seule requête membres.
async function resolveRecipientIds(body: VideoInput): Promise<{ libraryIds: string[]; notifyIds: string[]; error?: string }> {
  const map = await memberNameMap();
  const library = await resolveIds(libraryNamesOf(body), map);
  if (library.error) return { libraryIds: [], notifyIds: [], error: library.error };
  const notify = await resolveIds(notifyNamesOf(body), map);
  if (notify.error) return { libraryIds: [], notifyIds: [], error: notify.error };
  return { libraryIds: library.ids, notifyIds: notify.ids };
}

function buildRow(body: VideoInput, videoId: string, createdBy: string | null, publish: boolean) {
  return {
    title: body.title!.trim(),
    description: body.description?.trim() || null,
    youtube_url: body.youtubeUrl!.trim(),
    youtube_video_id: videoId,
    thumbnail_url: body.thumbnailUrl?.trim() || null,
    duration_seconds: body.durationSeconds ?? null,
    occasion_type: body.occasionType,
    occasion_date: body.occasionDate || null,
    visibility_scope: body.visibilityScope,
    gift_id: body.giftId || null,
    publish_at: body.publishAt || null,
    notify_on_login: body.notifyOnLogin === true,
    notify_all: body.notifyAll === true,
    ...(createdBy ? { created_by: createdBy } : {}),
    is_published: publish,
    published_at: publish ? new Date().toISOString() : null,
    is_archived: false,
    updated_at: new Date().toISOString(),
  };
}

// Remplace la liste des destinataires par l'UNION des deux publics, chaque ligne portant ses
// propres drapeaux is_library / is_notify — un membre peut donc être destinataire Souvenirs
// seulement, pop-up seulement, ou les deux (voir migration 20260824).
async function replaceRecipients(videoId: string, libraryIds: string[], notifyIds: string[]) {
  await supabaseRest("family_video_recipients?video_id=eq." + encodeURIComponent(videoId), { method: "DELETE", headers: { prefer: "return=minimal" } });
  const librarySet = new Set(libraryIds);
  const notifySet = new Set(notifyIds);
  const union = [...new Set([...libraryIds, ...notifyIds])];
  if (union.length > 0) {
    await supabaseRest("family_video_recipients", {
      method: "POST",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify(union.map((memberId) => ({ video_id: videoId, member_id: memberId, is_library: librarySet.has(memberId), is_notify: notifySet.has(memberId) }))),
    });
  }
}

// Détermine si CETTE ligne doit atteindre le client du viewer — pas seulement pour la
// bibliothèque Souvenirs, mais aussi pour que le pop-up de connexion (calculé côté client par
// findWelcomePopupVideo) puisse la trouver. Les deux publics sont indépendants (voir
// video-visibility.ts) : une vidéo notifiée à « tout le monde » (notify_all), ou dont le viewer
// est destinataire is_notify SEULEMENT (pas is_library), doit donc atteindre son client même si
// visibility_scope reste 'selected_members' et qu'il n'en est pas destinataire bibliothèque — il
// pourra la voir une fois en pop-up, sans qu'elle reste dans sa bibliothèque Souvenirs ensuite
// (filtrée côté client par canMemberViewVideo, qui ne compte que is_library).
function canView(video: VideoRow, viewer: AuthenticatedMember): boolean {
  if (viewer.role === "admin") return true;
  if (!video.is_published || video.is_archived) return false;
  if (video.publish_at && new Date(video.publish_at).getTime() > Date.now()) return false;
  if (video.visibility_scope === "family") return true;
  const recipients = video.recipients ?? [];
  const isLibraryRecipient = recipients.some((recipient) => recipient.is_library && recipient.member_id === viewer.id);
  if (isLibraryRecipient) return true;
  const isNotifyRecipient = recipients.some((recipient) => recipient.is_notify && recipient.member_id === viewer.id);
  if (isNotifyRecipient) return true;
  return video.notify_on_login === true && video.notify_all === true;
}

async function viewedIdsFor(memberId: string, videoIds: string[]): Promise<Set<string>> {
  if (videoIds.length === 0) return new Set();
  const rows = await supabaseRest<Array<{ video_id: string }>>(
    "family_video_views?select=video_id&viewer_member_id=eq." + encodeURIComponent(memberId) + "&video_id=in.(" + videoIds.map((id) => encodeURIComponent(id)).join(",") + ")",
  );
  return new Set(rows.map((row) => row.video_id));
}

export async function GET(request: Request) {
  if (!isSupabaseConfigured()) return Response.json({ videos: [], available: false });
  try {
    const viewer = await requireFamilyMember(request);
    const filter = viewer.role === "admin"
      ? "is_archived=eq.false"
      : "is_archived=eq.false&is_published=eq.true";
    const rows = await supabaseRest<VideoRow[]>(
      `family_videos?select=${SELECT}&${filter}&order=occasion_date.desc.nullslast,published_at.desc.nullslast`,
    );
    const visible = rows.filter((video) => canView(video, viewer));
    const viewed = await viewedIdsFor(viewer.id, visible.map((video) => video.id));
    const videos = visible.map((video) => ({ ...video, viewed: viewed.has(video.id) }));
    return Response.json({ videos, available: true, persistence: "supabase" });
  } catch (error) {
    if (isMissingVideoSchema(error)) return Response.json({ videos: [], available: false });
    return authErrorResponse(error);
  }
}

export async function POST(request: Request) {
  if (!isSupabaseConfigured()) return Response.json({ error: "Supabase est requis." }, { status: 503 });
  try {
    const admin = await requireAdmin(request);
    const body = (await request.json()) as VideoInput;
    const invalid = validate(body);
    if (invalid) return Response.json({ error: invalid }, { status: 400 });
    const videoId = extractYouTubeVideoId(body.youtubeUrl)!;
    const { libraryIds, notifyIds, error: recipientError } = await resolveRecipientIds(body);
    if (recipientError) return Response.json({ error: recipientError }, { status: 400 });

    const created = await supabaseRest<Array<{ id: string }>>("family_videos", {
      method: "POST",
      headers: { prefer: "return=representation" },
      body: JSON.stringify(buildRow(body, videoId, admin.id, body.publish === true)),
    });
    const newId = created[0]?.id;
    if (newId) await replaceRecipients(newId, libraryIds, notifyIds);
    return Response.json({ saved: true, id: newId }, { status: 201 });
  } catch (error) {
    if (isMissingVideoSchema(error)) return Response.json({ error: "La migration Supabase des vidéos (20260724_family_videos.sql, 20260821_family_video_publish_schedule.sql, 20260823_family_video_notify_all.sql et 20260824_family_video_recipient_kind.sql) doit être exécutée." }, { status: 409 });
    return authErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  if (!isSupabaseConfigured()) return Response.json({ error: "Supabase est requis." }, { status: 503 });
  try {
    await requireAdmin(request);
    const body = (await request.json()) as VideoInput;
    if (!body.id) return Response.json({ error: "Vidéo manquante." }, { status: 400 });

    if (body.action === "publish" || body.action === "unpublish") {
      const publish = body.action === "publish";
      await supabaseRest("family_videos?id=eq." + encodeURIComponent(body.id), {
        method: "PATCH",
        headers: { prefer: "return=minimal" },
        body: JSON.stringify({ is_published: publish, published_at: publish ? new Date().toISOString() : null, updated_at: new Date().toISOString() }),
      });
      return Response.json({ updated: true });
    }

    const invalid = validate(body);
    if (invalid) return Response.json({ error: invalid }, { status: 400 });
    const videoId = extractYouTubeVideoId(body.youtubeUrl)!;
    const { libraryIds, notifyIds, error: recipientError } = await resolveRecipientIds(body);
    if (recipientError) return Response.json({ error: recipientError }, { status: 400 });

    // Ne pas réécraser l'état de publication existant lors d'une simple édition de contenu.
    const current = await supabaseRest<Array<{ is_published: boolean }>>("family_videos?select=is_published&id=eq." + encodeURIComponent(body.id) + "&limit=1");
    if (!current[0]) return Response.json({ error: "Vidéo introuvable." }, { status: 404 });
    const publish = body.publish === undefined ? current[0].is_published : body.publish === true;

    const row = buildRow(body, videoId, null, publish);
    await supabaseRest("family_videos?id=eq." + encodeURIComponent(body.id), {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify(row),
    });
    await replaceRecipients(body.id, libraryIds, notifyIds);
    return Response.json({ updated: true });
  } catch (error) {
    if (isMissingVideoSchema(error)) return Response.json({ error: "La migration Supabase des vidéos (20260724_family_videos.sql, 20260821_family_video_publish_schedule.sql, 20260823_family_video_notify_all.sql et 20260824_family_video_recipient_kind.sql) doit être exécutée." }, { status: 409 });
    return authErrorResponse(error);
  }
}

// Archivage (soft delete) : la vidéo sort de la galerie sans suppression destructive.
export async function DELETE(request: Request) {
  if (!isSupabaseConfigured()) return Response.json({ error: "Supabase est requis." }, { status: 503 });
  try {
    await requireAdmin(request);
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return Response.json({ error: "Vidéo manquante." }, { status: 400 });
    await supabaseRest("family_videos?id=eq." + encodeURIComponent(id), {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ is_archived: true, is_published: false, updated_at: new Date().toISOString() }),
    });
    return Response.json({ archived: true });
  } catch (error) {
    if (isMissingVideoSchema(error)) return Response.json({ error: "La migration Supabase des vidéos (20260724_family_videos.sql, 20260821_family_video_publish_schedule.sql, 20260823_family_video_notify_all.sql et 20260824_family_video_recipient_kind.sql) doit être exécutée." }, { status: 409 });
    return authErrorResponse(error);
  }
}
