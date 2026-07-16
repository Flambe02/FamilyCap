import { createClient } from "@supabase/supabase-js";

export const supabaseBrowser = createClient(
  "https://jcyexmuoelglryzdweuh.supabase.co",
  "sb_publishable_rnqG9_2u4ys45cpPOgYO8A_dJnreaw1",
  { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } },
);
