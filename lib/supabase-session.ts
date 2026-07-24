import { supabaseBrowser } from "./supabase-browser";

// Récupération d'un access token TOUJOURS frais côté navigateur.
//
// `supabaseBrowser.auth.getSession()` renvoie la session stockée telle quelle : après une mise
// en veille de la machine ou un onglet resté ouvert plus d'une heure, le token peut être DÉJÀ
// expiré alors que le rafraîchissement automatique n'a pas encore eu lieu. Les routes API
// répondent alors 401 (« Ta session a expiré ») de façon intempestive. On rafraîchit donc
// proactivement dès que le token est expiré ou sur le point de l'être. Si le refresh token est
// lui aussi périmé, on renvoie ce que l'on a : le serveur répondra 401 et l'UI proposera « Se
// reconnecter » — comportement correct pour une vraie fin de session.

const REFRESH_MARGIN_MS = 60_000; // rafraîchit si le token expire dans moins d'une minute

export async function getAccessToken(): Promise<string> {
  const { data } = await supabaseBrowser.auth.getSession();
  const session = data.session;
  if (!session) return "";
  const expiresAtMs = (session.expires_at ?? 0) * 1000;
  if (expiresAtMs && expiresAtMs - Date.now() < REFRESH_MARGIN_MS) {
    try {
      const { data: refreshed } = await supabaseBrowser.auth.refreshSession();
      return refreshed.session?.access_token ?? session.access_token ?? "";
    } catch {
      return session.access_token ?? "";
    }
  }
  return session.access_token ?? "";
}

/** En-tête d'autorisation Bearer avec un token frais. */
export async function authHeader(): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await getAccessToken()}` };
}
