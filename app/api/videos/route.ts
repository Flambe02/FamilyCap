import { authErrorResponse, requireAdmin, requireFamilyMember, type AuthenticatedMember } from "../../../lib/auth-server";
import { isSupabaseConfigured, supabaseRest } from "../../../lib/supabase-rest";
import { extractYouTubeVideoId } from "../../../lib/videos/youtube";
import { OCCASION_TYPES, VISIBILITY_SCOPES, type OccasionType, type VisibilityScope } from "../../../lib/videos/video-visibility";

// Espace « Souvenirs ». La frontière de sécurité réelle est ce code serveur (la service-role
// contourne la RLS) : un membre ne reçoit QUE les vidéos qu'il a le droit de voir, calculées ici.
// L'administrateur gère les vidéos ; un membre lit ; personne n'écrit une vidéo côté membre.

const SELECT =
  "id,title,description,youtube_url,youtube_video_id,thumbnail_url,duration_seconds,occasion_type,occasion_date,visibility_scope,is_published,is_archived,published_at,gift_id," +
  "recipients:family_video_recipients(member_id,member:family_members(name))," +
  "gift:gift_records(amount_eur,btc_amount,occasion,gift_date,member_name)";

type RecipientRow = { member_id: string; member: { name: string | null } | null };
type VideoRow = {
  id: string;
  visibility_scope: VisibilityScope;
  is_published: boolean;
  is_archived: boolean;
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
  giftId?: string | null;
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

function validate(body: VideoInput): string | null {
  if (!body.title?.trim()) return "Le titre est obligatoire.";
  if (!body.youtubeUrl || !extractYouTubeVideoId(body.youtubeUrl)) return "L'URL YouTube est invalide.";
  if (!body.occasionType || !OCCASION_TYPES.includes(body.occasionType as OccasionType)) return "Occasion invalide.";
  if (!body.visibilityScope || !VISIBILITY_SCOPES.includes(body.visibilityScope as VisibilityScope)) return "Portée de visibilité invalide.";
  if (body.occasionDate && !DATE_RE.test(body.occasionDate)) return "Date d'occasion invalide.";
  if (body.durationSeconds !== undefined && body.durationSeconds !== null && (!Number.isFinite(body.durationSeconds) || Number(body.durationSeconds) < 0)) return "Durée invalide.";
  const recipients = Array.isArray(body.recipientNames) ? body.recipientNames.filter((name): name is string => typeof name === "string" && name.trim() !== "") : [];
  if (body.visibilityScope !== "family" && recipients.length === 0) return "Sélectionnez au moins un destinataire (ou choisissez « toute la famille »).";
  return null;
}

async function memberNameMap(): Promise<Map<string, string>> {
  const rows = await supabaseRest<Array<{ id: string; name: string }>>("family_members?select=id,name&is_active=eq.true");
  return new Map(rows.map((row) => [row.name, row.id]));
}

async function resolveRecipientIds(body: VideoInput): Promise<{ ids: string[]; error?: string }> {
  if (body.visibilityScope === "family") return { ids: [] };
  const names = (body.recipientNames as string[]).map((name) => name.trim()).filter(Boolean);
  const map = await memberNameMap();
  const ids: string[] = [];
  for (const name of names) {
    const id = map.get(name);
    if (!id) return { ids: [], error: `Destinataire inconnu : ${name}.` };
    ids.push(id);
  }
  return { ids: [...new Set(ids)] };
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
    ...(createdBy ? { created_by: createdBy } : {}),
    is_published: publish,
    published_at: publish ? new Date().toISOString() : null,
    is_archived: false,
    updated_at: new Date().toISOString(),
  };
}

async function replaceRecipients(videoId: string, ids: string[]) {
  await supabaseRest("family_video_recipients?video_id=eq." + encodeURIComponent(videoId), { method: "DELETE", headers: { prefer: "return=minimal" } });
  if (ids.length > 0) {
    await supabaseRest("family_video_recipients", {
      method: "POST",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify(ids.map((memberId) => ({ video_id: videoId, member_id: memberId }))),
    });
  }
}

function canView(video: VideoRow, viewer: AuthenticatedMember): boolean {
  if (viewer.role === "admin") return true;
  if (!video.is_published || video.is_archived) return false;
  if (video.visibility_scope === "family") return true;
  return (video.recipients ?? []).some((recipient) => recipient.member_id === viewer.id);
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
    const { ids, error: recipientError } = await resolveRecipientIds(body);
    if (recipientError) return Response.json({ error: recipientError }, { status: 400 });

    const created = await supabaseRest<Array<{ id: string }>>("family_videos", {
      method: "POST",
      headers: { prefer: "return=representation" },
      body: JSON.stringify(buildRow(body, videoId, admin.id, body.publish === true)),
    });
    const newId = created[0]?.id;
    if (newId) await replaceRecipients(newId, ids);
    return Response.json({ saved: true, id: newId }, { status: 201 });
  } catch (error) {
    if (isMissingVideoSchema(error)) return Response.json({ error: "La migration Supabase 20260724_family_videos.sql doit être exécutée." }, { status: 409 });
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
    const { ids, error: recipientError } = await resolveRecipientIds(body);
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
    await replaceRecipients(body.id, ids);
    return Response.json({ updated: true });
  } catch (error) {
    if (isMissingVideoSchema(error)) return Response.json({ error: "La migration Supabase 20260724_family_videos.sql doit être exécutée." }, { status: 409 });
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
    if (isMissingVideoSchema(error)) return Response.json({ error: "La migration Supabase 20260724_family_videos.sql doit être exécutée." }, { status: 409 });
    return authErrorResponse(error);
  }
}
