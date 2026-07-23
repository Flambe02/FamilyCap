// Abstraction de FOURNISSEUR d'extraction documentaire (serveur UNIQUEMENT). Permet de changer
// de fournisseur (Claude, OpenAI, …) sans réécrire le parcours d'import : la route appelle
// getDocumentProvider().extract(...) et reçoit une RawExtraction, validée ensuite par extract.ts.
// La clé d'API n'est JAMAIS envoyée au navigateur (aucune variable préfixée NEXT_PUBLIC_).

import { EXTRACTION_JSON_INSTRUCTION, type RawExtraction, DEFAULT_THRESHOLDS, type ExtractionThresholds } from "./extract.ts";

export type ExtractInput = { base64: string; mediaType: string; filename: string };
export type DocumentProvider = { name: string; extract(input: ExtractInput): Promise<RawExtraction> };

export type DocumentAiConfig = {
  provider: "anthropic" | "openai" | "none";
  model: string;
  maxPages: number;
  maxFileBytes: number;
  thresholds: ExtractionThresholds;
  configured: boolean;
};

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function getDocumentAiConfig(): DocumentAiConfig {
  const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY);
  const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);
  const explicit = (process.env.DOCUMENT_AI_PROVIDER ?? "").toLowerCase();
  const provider: DocumentAiConfig["provider"] =
    explicit === "anthropic" || explicit === "openai" || explicit === "none"
      ? explicit
      : hasAnthropic ? "anthropic" : hasOpenAI ? "openai" : "none";
  return {
    provider,
    model: process.env.DOCUMENT_AI_MODEL || (provider === "openai" ? "gpt-5" : "claude-sonnet-5"),
    maxPages: envNumber("DOCUMENT_AI_MAX_PAGES", 15),
    maxFileBytes: envNumber("DOCUMENT_AI_MAX_FILE_SIZE_MB", 10) * 1024 * 1024,
    thresholds: {
      high: envNumber("DOCUMENT_AI_HIGH_CONFIDENCE", DEFAULT_THRESHOLDS.high * 100) / 100,
      low: envNumber("DOCUMENT_AI_LOW_CONFIDENCE", DEFAULT_THRESHOLDS.low * 100) / 100,
    },
    configured: provider !== "none" && (provider === "anthropic" ? hasAnthropic : hasOpenAI),
  };
}

// Extrait le premier objet JSON d'une réponse texte (tolère un éventuel bloc ```json).
function parseJsonBlock(text: string): RawExtraction {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Réponse IA sans JSON exploitable.");
  return JSON.parse(candidate.slice(start, end + 1)) as RawExtraction;
}

// Fournisseur Anthropic (Claude) via l'API Messages, en fetch brut (aucune dépendance SDK).
function anthropicProvider(config: DocumentAiConfig): DocumentProvider {
  return {
    name: "anthropic",
    async extract(input: ExtractInput): Promise<RawExtraction> {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) throw new Error("ANTHROPIC_API_KEY absente.");
      const isPdf = input.mediaType === "application/pdf";
      const contentBlock = isPdf
        ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: input.base64 } }
        : { type: "image", source: { type: "base64", media_type: input.mediaType, data: input.base64 } };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60000);
      try {
        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            model: config.model,
            max_tokens: 4096,
            system: EXTRACTION_JSON_INSTRUCTION,
            messages: [{ role: "user", content: [contentBlock, { type: "text", text: `Extrais le compte et toutes les opérations de ce relevé (${input.filename}). Maximum ${config.maxPages} pages. Réponds en JSON strict conforme au schéma.` }] }],
          }),
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          throw new Error(`Fournisseur IA: ${response.status} ${detail.slice(0, 200)}`);
        }
        const data = (await response.json()) as { content?: Array<{ type: string; text?: string }> };
        const text = (data.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
        return parseJsonBlock(text);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// Fournisseur OpenAI (Vision) — squelette symétrique ; activé via OPENAI_API_KEY + DOCUMENT_AI_PROVIDER=openai.
function openaiProvider(config: DocumentAiConfig): DocumentProvider {
  return {
    name: "openai",
    async extract(input: ExtractInput): Promise<RawExtraction> {
      const key = process.env.OPENAI_API_KEY;
      if (!key) throw new Error("OPENAI_API_KEY absente.");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60000);
      try {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            model: config.model,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: EXTRACTION_JSON_INSTRUCTION },
              { role: "user", content: [
                { type: "text", text: `Extrais le compte et toutes les opérations de ce relevé (${input.filename}).` },
                { type: "image_url", image_url: { url: `data:${input.mediaType};base64,${input.base64}` } },
              ] },
            ],
          }),
        });
        if (!response.ok) throw new Error(`Fournisseur IA: ${response.status} ${(await response.text().catch(() => "")).slice(0, 200)}`);
        const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
        return parseJsonBlock(data.choices?.[0]?.message?.content ?? "");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function getDocumentProvider(config = getDocumentAiConfig()): DocumentProvider | null {
  if (config.provider === "anthropic") return anthropicProvider(config);
  if (config.provider === "openai") return openaiProvider(config);
  return null;
}
