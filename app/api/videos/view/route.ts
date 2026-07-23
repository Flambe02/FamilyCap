import { authErrorResponse, requireFamilyMember } from "../../../../lib/auth-server";
import { isSupabaseConfigured, supabaseRest } from "../../../../lib/supabase-rest";

// Événement de lecture. Frontière de sécurité : requireFamilyMember identifie l'appelant ;
// viewer_member_id cible l'appelant, SAUF pour un administrateur qui peut viser un autre membre
// via memberId (aperçu admin « comme si connecté via son compte » — parité complète). Un
// non-admin ne peut jamais viser un autre id. Le compteur est incrémenté à l'ouverture réelle.

function isMissingVideoSchema(error: unknown) {
  return error instanceof Error && (error.message.includes("family_video") || error.message.includes("PGRST205") || error.message.includes("PGRST106"));
}

// Cible : le membre connecté, ou — pour un administrateur uniquement — le memberId fourni.
function resolveTargetId(requested: string | null | undefined, viewer: { id: string; role: string }): string {
  return requested && viewer.role === "admin" ? requested : viewer.id;
}

export async function POST(request: Request) {
  if (!isSupabaseConfigured()) return Response.json({ recorded: false });
  try {
    const viewer = await requireFamilyMember(request);
    const body = (await request.json()) as { videoId?: string; memberId?: string };
    const videoId = body.videoId?.trim();
    if (!videoId) return Response.json({ error: "Vidéo manquante." }, { status: 400 });
    const targetId = resolveTargetId(body.memberId, viewer);

    // La vidéo doit exister (on ne crée pas d'événement pour un identifiant fantaisiste).
    const video = await supabaseRest<Array<{ id: string }>>("family_videos?select=id&id=eq." + encodeURIComponent(videoId) + "&limit=1");
    if (!video[0]) return Response.json({ error: "Vidéo introuvable." }, { status: 404 });

    const now = new Date().toISOString();
    const existing = await supabaseRest<Array<{ id: string; view_count: number }>>(
      "family_video_views?select=id,view_count&viewer_member_id=eq." + encodeURIComponent(targetId) + "&video_id=eq." + encodeURIComponent(videoId) + "&limit=1",
    );

    if (existing[0]) {
      await supabaseRest("family_video_views?id=eq." + encodeURIComponent(existing[0].id), {
        method: "PATCH",
        headers: { prefer: "return=minimal" },
        body: JSON.stringify({ view_count: Number(existing[0].view_count ?? 0) + 1, last_viewed_at: now, updated_at: now }),
      });
    } else {
      await supabaseRest("family_video_views", {
        method: "POST",
        headers: { prefer: "return=minimal" },
        body: JSON.stringify({ video_id: videoId, viewer_member_id: targetId, first_viewed_at: now, last_viewed_at: now, view_count: 1, updated_at: now }),
      });
    }
    return Response.json({ recorded: true });
  } catch (error) {
    if (isMissingVideoSchema(error)) return Response.json({ recorded: false });
    return authErrorResponse(error);
  }
}
