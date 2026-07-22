"use client";

import { supabaseBrowser } from "./supabase-browser";

// Service client isolant les appels réseau des écrans Paramètres (notifications, export,
// désactivation). Aucune logique métier ici : uniquement l'authentification par jeton Supabase
// et le typage des réponses.

export type NotificationPreferences = {
  gifts: boolean;
  events: boolean;
  investments: boolean;
  security: boolean;
  emailWeekly: boolean;
};

export type NotificationPreferencesResult = {
  preferences: NotificationPreferences;
  available: boolean;
  persisted: boolean;
};

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabaseBrowser.auth.getSession();
  return { authorization: "Bearer " + (data.session?.access_token ?? ""), "content-type": "application/json" };
}

// `memberId` (facultatif) est réservé à l'administrateur qui gère un autre membre ; côté
// serveur, un non-admin ne peut jamais viser un id différent du sien.
function notificationsUrl(memberId?: string) {
  return "/api/notification-preferences" + (memberId ? "?memberId=" + encodeURIComponent(memberId) : "");
}

export async function fetchNotificationPreferences(memberId?: string): Promise<NotificationPreferencesResult> {
  const response = await fetch(notificationsUrl(memberId), { headers: await authHeaders() });
  const result = await response.json() as NotificationPreferencesResult & { error?: string };
  if (!response.ok) throw new Error(result.error ?? "Chargement des préférences impossible.");
  return result;
}

export async function saveNotificationPreferences(preferences: NotificationPreferences, memberId?: string): Promise<void> {
  const response = await fetch(notificationsUrl(memberId), {
    method: "PATCH",
    headers: await authHeaders(),
    body: JSON.stringify(preferences),
  });
  const result = await response.json() as { error?: string };
  if (!response.ok) throw new Error(result.error ?? "Enregistrement des préférences impossible.");
}

export async function requestAccountDeactivation(confirm: string): Promise<void> {
  const response = await fetch("/api/account/deactivate", {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ confirm }),
  });
  const result = await response.json() as { error?: string };
  if (!response.ok) throw new Error(result.error ?? "Désactivation impossible.");
}

// Télécharge l'export JSON des données personnelles via un lien temporaire (aucune donnée
// n'est stockée ni exposée hors de la session authentifiée).
export async function downloadAccountExport(memberId?: string): Promise<void> {
  const { data } = await supabaseBrowser.auth.getSession();
  const response = await fetch("/api/account/export" + (memberId ? "?memberId=" + encodeURIComponent(memberId) : ""), {
    headers: { authorization: "Bearer " + (data.session?.access_token ?? "") },
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(result.error ?? "Export impossible.");
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "labajo-mes-donnees.json";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
