import { isSupabaseConfigured, supabaseRest } from "../../../../lib/supabase-rest";

export async function GET() {
  if (!isSupabaseConfigured()) return Response.json({ configured: false, connected: false, reason: "secret_missing" });

  try {
    await supabaseRest<Array<{ id: string }>>("family_members?select=id&limit=1");
    return Response.json({ configured: true, connected: true });
  } catch {
    return Response.json({ configured: true, connected: false, reason: "connection_failed" }, { status: 503 });
  }
}
