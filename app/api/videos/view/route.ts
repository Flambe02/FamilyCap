import { authErrorResponse, requireFamilyMember } from "../../../../lib/auth-server";
import { isSupabaseConfigured, supabaseRest } from "../../../../lib/supabase-rest";

// Événement de lecture. Frontière de sécurité : requireFamilyMember identifie l'appelant ;
// viewer_member_id est FORCÉ sur son identité (jamais fourni par le client). Le compteur est
// incrémenté à l'ouverture réelle. En mode aperçu, le client N'APPELLE PAS cette route : aucune
// vue n'est donc écrite au nom du membre simulé (règle « l'aperçu admin n'écrit rien »).

function isMissingVideoSchema(error: unknown) {
  return error instanceof Error && (error.message.includes("family_video") || error.message.includes("PGRST205") || error.message.includes("PGRST106"));
}

export async function POST(request: Request) {
  if (!isSupabaseConfigured()) return Response.json({ recorded: false });
  try {
    const viewer = await requireFamilyMember(request);
    const body = (await request.json()) as { videoId?: string };
    const videoId = body.videoId?.trim();
    if (!videoId) return Response.json({ error: "Vidéo manquante." }, { status: 400 });

    // La vidéo doit exister (on ne crée pas d'événement pour un identifiant fantaisiste).
    const video = await supabaseRest<Array<{ id: string }>>("family_videos?select=id&id=eq." + encodeURIComponent(videoId) + "&limit=1");
    if (!video[0]) return Response.json({ error: "Vidéo introuvable." }, { status: 404 });

    const now = new Date().toISOString();
    const existing = await supabaseRest<Array<{ id: string; view_count: number }>>(
      "family_video_views?select=id,view_count&viewer_member_id=eq." + encodeURIComponent(viewer.id) + "&video_id=eq." + encodeURIComponent(videoId) + "&limit=1",
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
        body: JSON.stringify({ video_id: videoId, viewer_member_id: viewer.id, first_viewed_at: now, last_viewed_at: now, view_count: 1, updated_at: now }),
      });
    }
    return Response.json({ recorded: true });
  } catch (error) {
    if (isMissingVideoSchema(error)) return Response.json({ recorded: false });
    return authErrorResponse(error);
  }
}
