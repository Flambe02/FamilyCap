// Seed ponctuel : message vidéo personnel pour Uhaina (migration 20260724_family_videos.sql).
// Portée `selected_members` + un seul destinataire => visible UNIQUEMENT par Uhaina et
// l'administrateur (can_view_video / canView côté API). Idempotent : ne réinsère pas si une
// vidéo avec le même youtube_video_id + destinataire existe déjà.
//
// Usage : node --env-file=.env.local scripts/seed-uhaina-welcome-video.mjs

import { supabaseRest } from "../lib/supabase-rest.ts";
import { extractYouTubeVideoId } from "../lib/videos/youtube.ts";

const YOUTUBE_URL = "https://www.youtube.com/shorts/fCPMLEygIq8";
const RECIPIENT_NAME = "Uhaina";
const TITLE = "Un petit message pour toi";

async function main() {
  const videoId = extractYouTubeVideoId(YOUTUBE_URL);
  if (!videoId) throw new Error(`URL YouTube invalide : ${YOUTUBE_URL}`);

  const members = await supabaseRest(`family_members?select=id,name,role&is_active=eq.true`);
  const recipient = members.find((member) => member.name.toLowerCase() === RECIPIENT_NAME.toLowerCase());
  if (!recipient) throw new Error(`Destinataire introuvable dans family_members : ${RECIPIENT_NAME}`);
  const admin = members.find((member) => member.role === "admin");

  const existingVideos = await supabaseRest(
    `family_videos?select=id&youtube_video_id=eq.${encodeURIComponent(videoId)}`,
  );
  let videoRowId;
  if (existingVideos[0]) {
    videoRowId = existingVideos[0].id;
    console.log(`Vidéo déjà présente (id=${videoRowId}), mise à jour des destinataires uniquement.`);
  } else {
    const now = new Date().toISOString();
    const created = await supabaseRest("family_videos", {
      method: "POST",
      headers: { prefer: "return=representation" },
      body: JSON.stringify({
        title: TITLE,
        description: null,
        youtube_url: YOUTUBE_URL,
        youtube_video_id: videoId,
        occasion_type: "general",
        visibility_scope: "selected_members",
        ...(admin ? { created_by: admin.id } : {}),
        is_published: true,
        published_at: now,
        is_archived: false,
      }),
    });
    videoRowId = created[0]?.id;
    console.log(`Vidéo créée (id=${videoRowId}).`);
  }

  const existingRecipients = await supabaseRest(
    `family_video_recipients?select=member_id&video_id=eq.${encodeURIComponent(videoRowId)}`,
  );
  if (!existingRecipients.some((row) => row.member_id === recipient.id)) {
    await supabaseRest("family_video_recipients", {
      method: "POST",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ video_id: videoRowId, member_id: recipient.id }),
    });
    console.log(`Destinataire ajouté : ${recipient.name} (${recipient.id}).`);
  } else {
    console.log(`Destinataire déjà lié : ${recipient.name}.`);
  }

  console.log("OK — vidéo visible uniquement par Uhaina et l'administrateur.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
