// Appel texte au fournisseur d'IA pour l'analyse de portefeuille.
//
// Volontairement minuscule et séparé de `document-extraction/provider.ts` : celui-là lit des
// images et des PDF, celui-ci envoie du texte et attend du JSON. Les mélanger aurait fait grossir
// un module déjà dense pour deux besoins qui n'ont en commun que la clé d'API.
//
// Sans clé configurée, il n'y a pas d'erreur : `null` est renvoyé et l'écran affiche l'analyse
// déterministe (lib/portfolio-insights.ts). Une analyse est une mise en phrase de chiffres déjà
// calculés — elle ne doit jamais devenir une dépendance dure.

export type AnalysisProviderConfig = { provider: "anthropic" | "openai" | "none"; model: string; timeoutMs: number; configured: boolean };

export function getAnalysisConfig(): AnalysisProviderConfig {
  const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY);
  const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);
  const explicit = (process.env.PORTFOLIO_AI_PROVIDER ?? process.env.DOCUMENT_AI_PROVIDER ?? "").toLowerCase();
  const provider: AnalysisProviderConfig["provider"] =
    explicit === "anthropic" || explicit === "openai" || explicit === "none"
      ? explicit
      : hasAnthropic ? "anthropic" : hasOpenAI ? "openai" : "none";
  const timeout = Number(process.env.PORTFOLIO_AI_TIMEOUT_MS);
  return {
    provider,
    model: process.env.PORTFOLIO_AI_MODEL || (provider === "openai" ? "gpt-5" : "claude-sonnet-5"),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 45_000,
    configured: provider !== "none" && (provider === "anthropic" ? hasAnthropic : hasOpenAI),
  };
}

/** Extrait le premier objet JSON d'une réponse, en tolérant un bloc ```json. */
export function parseObservationsPayload(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Renvoie le texte brut du modèle, ou `null` si aucun fournisseur n'est disponible ou en échec. */
export async function requestAnalysis(prompt: string, config = getAnalysisConfig()): Promise<string | null> {
  if (!config.configured) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    if (config.provider === "anthropic") {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: controller.signal,
        headers: { "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: config.model, max_tokens: 1200, messages: [{ role: "user", content: prompt }] }),
      });
      if (!response.ok) return null;
      const data = (await response.json()) as { content?: Array<{ type: string; text?: string }> };
      return (data.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
    }
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY!}`, "content-type": "application/json" },
      body: JSON.stringify({ model: config.model, messages: [{ role: "user", content: prompt }] }),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content ?? null;
  } catch {
    return null; // délai dépassé, réseau, quota : l'analyse déterministe prend le relais
  } finally {
    clearTimeout(timer);
  }
}
