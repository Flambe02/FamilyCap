import { createClient } from "@supabase/supabase-js";
import { authErrorResponse, requireFamilyMember } from "../../../../lib/auth-server";
import { supabaseRest } from "../../../../lib/supabase-rest";

// Photo de profil (avatar) : upload et suppression. Frontiere de securite : requireFamilyMember ;
// la cible est l'appelant, SAUF pour un administrateur qui peut viser un autre membre via le
// champ memberId (edition depuis l'apercu admin "Vue <membre>" — meme parite que /api/profile).
// Stockage : bucket Supabase "avatars" (public en lecture, cf. migration 20260729_member_avatar),
// ecrit uniquement ici via la cle service-role — jamais depuis le navigateur.

export const runtime = "nodejs";

const ALLOWED: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const EXTENSIONS = ["jpg", "png", "webp"];
const MAX_BYTES = 5 * 1024 * 1024;

type RuntimeEnv = { SUPABASE_URL?: string; SUPABASE_SECRET_KEY?: string };
function adminClient() {
  const runtime: RuntimeEnv = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY };
  if (!runtime.SUPABASE_URL || !runtime.SUPABASE_SECRET_KEY) throw new Error("Supabase Admin non configuré");
  return createClient(runtime.SUPABASE_URL, runtime.SUPABASE_SECRET_KEY, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } });
}

function resolveTargetId(requested: string | null, viewer: { id: string; role: string }): string {
  return requested && viewer.role === "admin" ? requested : viewer.id;
}

async function removeExistingFiles(targetId: string) {
  try {
    await adminClient().storage.from("avatars").remove(EXTENSIONS.map((ext) => `${targetId}.${ext}`));
  } catch {
    // Best-effort : un fichier absent n'est pas une erreur bloquante.
  }
}

function isMissingPhotoColumn(error: unknown) {
  return error instanceof Error && (error.message.includes("photo_url") || error.message.includes("42703") || error.message.includes("PGRST204"));
}

async function savePhotoUrl(targetId: string, photoUrl: string | null) {
  try {
    await supabaseRest("family_members?id=eq." + encodeURIComponent(targetId), {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ photo_url: photoUrl }),
    });
  } catch (error) {
    if (isMissingPhotoColumn(error)) throw new Error("Photo de profil indisponible : jouez d'abord la migration 20260729_member_avatar.sql dans Supabase.");
    throw error;
  }
}

export async function POST(request: Request) {
  try {
    const viewer = await requireFamilyMember(request);
    const form = await request.formData().catch(() => null);
    if (!form) return Response.json({ error: "Fichier manquant." }, { status: 400 });
    const file = form.get("file");
    if (!(file instanceof File)) return Response.json({ error: "Fichier manquant." }, { status: 400 });
    if (file.size === 0) return Response.json({ error: "Le fichier est vide." }, { status: 400 });
    if (file.size > MAX_BYTES) return Response.json({ error: "Photo trop volumineuse (max 5 Mo)." }, { status: 413 });
    const ext = ALLOWED[file.type];
    if (!ext) return Response.json({ error: "Format non pris en charge. Utilisez JPG, PNG ou WEBP." }, { status: 415 });

    const requestedId = String(form.get("memberId") ?? "").trim() || null;
    const targetId = resolveTargetId(requestedId, viewer);

    const client = adminClient();
    await removeExistingFiles(targetId);
    const path = `${targetId}.${ext}`;
    const { error: uploadError } = await client.storage.from("avatars").upload(path, file, { contentType: file.type, upsert: true });
    if (uploadError) throw uploadError;

    const { data } = client.storage.from("avatars").getPublicUrl(path);
    const photoUrl = `${data.publicUrl}?v=${Date.now()}`;
    await savePhotoUrl(targetId, photoUrl);

    return Response.json({ photoUrl });
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const viewer = await requireFamilyMember(request);
    const requestedId = new URL(request.url).searchParams.get("memberId");
    const targetId = resolveTargetId(requestedId, viewer);
    await removeExistingFiles(targetId);
    await savePhotoUrl(targetId, null);
    return Response.json({ photoUrl: null });
  } catch (error) {
    return authErrorResponse(error);
  }
}
