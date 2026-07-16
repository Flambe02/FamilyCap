import { env } from "cloudflare:workers";

type SupabaseRuntimeEnv = {
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  SUPABASE_SECRET_KEY?: string;
};

const runtime = env as unknown as SupabaseRuntimeEnv;

export function isSupabaseConfigured() {
  return Boolean(runtime.SUPABASE_URL && runtime.SUPABASE_SECRET_KEY);
}

export function getSupabaseProjectInfo() {
  return {
    configured: isSupabaseConfigured(),
    projectUrl: runtime.SUPABASE_URL ?? null,
    hasPublishableKey: Boolean(runtime.SUPABASE_PUBLISHABLE_KEY),
    hasSecretKey: Boolean(runtime.SUPABASE_SECRET_KEY),
  };
}

export async function supabaseRest<T>(path: string, init: RequestInit = {}) {
  const projectUrl = runtime.SUPABASE_URL?.replace(/\/$/, "");
  const secretKey = runtime.SUPABASE_SECRET_KEY;
  if (!projectUrl || !secretKey) throw new Error("Supabase n’est pas configuré côté serveur.");

  const response = await fetch(`${projectUrl}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: secretKey,
      accept: "application/json",
      "content-type": "application/json",
      ...init.headers,
    },
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Supabase ${response.status}: ${message.slice(0, 300)}`);
  }

  if (response.status === 204) return null as T;
  return response.json() as Promise<T>;
}
