import { getSupabaseProjectInfo, isSupabaseConfigured, supabaseRest } from "../../../../lib/supabase-rest";

export async function GET() {
  const info = getSupabaseProjectInfo();
  if (!isSupabaseConfigured()) return Response.json({ ...info, connected: false, reason: "secret_missing" });

  try {
    await supabaseRest<Array<{ id: string }>>("family_members?select=id&limit=1");
    return Response.json({ ...info, connected: true });
  } catch (error) {
    return Response.json({ ...info, connected: false, reason: error instanceof Error ? error.message : "connection_failed" }, { status: 503 });
  }
}
