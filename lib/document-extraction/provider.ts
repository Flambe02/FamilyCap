// Abstraction de FOURNISSEUR d'extraction documentaire (serveur UNIQUEMENT). Permet de changer
// de fournisseur (Claude, OpenAI, …) sans réécrire le parcours d'import : la route appelle
// getDocumentProvider().extract(...) et reçoit une RawExtraction, validée ensuite par extract.ts.
// La clé d'API n'est JAMAIS envoyée au navigateur (aucune variable préfixée NEXT_PUBLIC_).

import { EXTRACTION_JSON_INSTRUCTION, normalizeRawExtraction, type RawExtraction, DEFAULT_THRESHOLDS, type ExtractionThresholds } from "./extract.ts";

// Consigne utilisateur, commune aux fournisseurs. Elle nomme EXPLICITEMENT les deux familles de
// relevés : un tableau de positions (« Mes positions ») n'a aucune opération datée, et une
// consigne qui ne parlait que d'« opérations » le faisait retranscrire à vide.
const EXTRACTION_USER_PROMPT =
  "Retranscris ce relevé : d'abord l'en-tête du compte, puis SOIT le tableau des positions détenues (relevé de portefeuille), SOIT les opérations datées (relevé de mouvements), selon ce que contient réellement le document. Retranscris toutes les lignes, sans en résumer ni en omettre. Si une ligne est lisible mais incertaine, inclus-la avec une confiance basse et un avertissement.";

/** Consigne de relecture : chaque passe aborde le tableau autrement pour décorréler les erreurs. */
function passHint(pass: number | undefined): string {
  if (!pass || pass <= 1) return "";
  const angles = [
    " Relecture indépendante : reprends le tableau ligne par ligne et recopie chaque cellule chiffrée chiffre à chiffre.",
    " Relecture indépendante : parcours le tableau colonne par colonne et vérifie l'ordre de grandeur de chaque montant.",
    " Relecture indépendante : traite chaque ligne isolément, en repartant de son libellé puis de son code ISIN.",
    " Relecture indépendante : accorde une attention particulière aux séparateurs de milliers et de décimales.",
  ];
  return angles[(pass - 2) % angles.length];
}

export type ExtractInput = {
  base64: string; mediaType: string; filename: string;
  /**
   * Numéro de relecture (1..N). Il varie légèrement la consigne : deux appels rigoureusement
   * identiques ont toutes les chances de reproduire la MÊME erreur de lecture, ce qui priverait
   * le vote de tout pouvoir de détection.
   */
  pass?: number;
  /**
   * Consignes de lecture SUPPLÉMENTAIRES, propres au courtier reconnu (cf. brokers.ts) et à la
   * passe en cours. Elles décrivent la structure réelle du tableau (colonnes empilées, boutons à
   * ignorer…) : c'est ce qui distingue une retranscription fiable d'une lecture approximative.
   */
  extraInstructions?: string;
  /** Consigne courte ajoutée au message utilisateur (ex. seconde passe ciblée sur le tableau). */
  focusHint?: string;
};

/**
 * Résultat d'une passe. `raw` est la sortie JSON BRUTE du modèle, conservée pour la vérifier
 * contre le contrat Zod strict : la normaliser d'abord masquerait précisément les manquements
 * que ce contrôle doit révéler. `normalized` est la forme tolérante utilisée par le pipeline.
 */
export type ExtractResult = { raw: unknown; normalized: RawExtraction };

export type DocumentProvider = { name: string; extract(input: ExtractInput): Promise<ExtractResult> };

export type DocumentAiConfig = {
  provider: "anthropic" | "openai" | "none";
  model: string;
  maxPages: number;
  maxFileBytes: number;
  thresholds: ExtractionThresholds;
  configured: boolean;
  /**
   * Effort de raisonnement (modèles OpenAI de la série gpt-5). MESURÉ sur un relevé PEA réel :
   * « high » coûte 92 s et 10 880 jetons de raisonnement pour AUTANT d'erreurs de lecture que
   * « minimal » à 16 s. Retranscrire un tableau est une tâche de perception, pas de déduction :
   * le raisonnement n'y apporte rien et faisait dépasser le délai d'expiration.
   */
  reasoningEffort: "minimal" | "low" | "medium" | "high";
  /** Nombre de relectures indépendantes votant cellule par cellule (cf. consensus.ts). */
  passes: number;
  timeoutMs: number;
  maxOutputTokens: number;
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
  const effort = (process.env.DOCUMENT_AI_REASONING_EFFORT ?? "").toLowerCase();
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
    reasoningEffort: effort === "low" || effort === "medium" || effort === "high" ? effort : "minimal",
    // Les relectures partent EN PARALLÈLE : 3 passes coûtent le temps d'une seule (14 s mesurées).
    passes: Math.max(1, Math.min(5, Math.round(envNumber("DOCUMENT_AI_PASSES", 3)))),
    // 60 s était trop court : une passe gpt-5 à effort par défaut prenait 59,6 s, d'où des
    // expirations aléatoires (« L'analyse IA a expiré ») sur un document pourtant bien lu.
    timeoutMs: envNumber("DOCUMENT_AI_TIMEOUT_MS", 120000),
    maxOutputTokens: envNumber("DOCUMENT_AI_MAX_OUTPUT_TOKENS", 16000),
  };
}

// Extrait le premier objet JSON d'une réponse texte (tolère un éventuel bloc ```json).
function parseJsonBlock(text: string): ExtractResult {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Réponse IA sans JSON exploitable.");
  const raw: unknown = JSON.parse(candidate.slice(start, end + 1));
  return { raw, normalized: normalizeRawExtraction(raw) };
}

/** Consigne système d'une passe : contrat JSON commun + consignes propres au courtier. */
function systemPrompt(extra: string | undefined): string {
  return extra ? `${EXTRACTION_JSON_INSTRUCTION}\n\n${extra}` : EXTRACTION_JSON_INSTRUCTION;
}

/** Consigne utilisateur d'une passe : consigne commune + angle de relecture + zone ciblée. */
function userPrompt(input: ExtractInput, config: DocumentAiConfig): string {
  return `${EXTRACTION_USER_PROMPT} Document : ${input.filename}. Maximum ${config.maxPages} page(s).`
    + `${passHint(input.pass)}${input.focusHint ? ` ${input.focusHint}` : ""} Réponds en JSON strict conforme au schéma.`;
}

// Fournisseur Anthropic (Claude) via l'API Messages, en fetch brut (aucune dépendance SDK).
function anthropicProvider(config: DocumentAiConfig): DocumentProvider {
  return {
    name: "anthropic",
    async extract(input: ExtractInput): Promise<ExtractResult> {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) throw new Error("ANTHROPIC_API_KEY absente.");
      const isPdf = input.mediaType === "application/pdf";
      const contentBlock = isPdf
        ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: input.base64 } }
        : { type: "image", source: { type: "base64", media_type: input.mediaType, data: input.base64 } };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            model: config.model,
            // Le schéma est verbeux (≈ 300 jetons par ligne : chaque champ porte value/confidence/
            // page). À 4096 jetons, un relevé de plus d'une douzaine de lignes était TRONQUÉ, donc
            // illisible en JSON — l'import échouait alors sans que la cause soit visible.
            max_tokens: config.maxOutputTokens,
            system: systemPrompt(input.extraInstructions),
            messages: [{ role: "user", content: [contentBlock, { type: "text", text: userPrompt(input, config) }] }],
          }),
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          throw new Error(`Fournisseur IA: ${response.status} ${detail.slice(0, 200)}`);
        }
        const data = (await response.json()) as { content?: Array<{ type: string; text?: string }>; stop_reason?: string };
        const text = (data.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
        if (data.stop_reason === "max_tokens") {
          throw new Error("la retranscription a été tronquée (relevé trop long). Scannez une page à la fois, ou utilisez le CSV.");
        }
        return parseJsonBlock(text);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function responseText(data: { output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> }): string {
  if (data.output_text) return data.output_text;
  return (data.output ?? [])
    .flatMap((message) => message.content ?? [])
    .filter((content) => content.type === "output_text")
    .map((content) => content.text ?? "")
    .join("\n");
}

// Fournisseur OpenAI. Les images passent par Chat Completions ; les PDF passent par Responses
// et input_file, car un PDF n'est pas une image_url valide.
function openaiProvider(config: DocumentAiConfig): DocumentProvider {
  return {
    name: "openai",
    async extract(input: ExtractInput): Promise<ExtractResult> {
      const key = process.env.OPENAI_API_KEY;
      if (!key) throw new Error("OPENAI_API_KEY absente.");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        const isPdf = input.mediaType === "application/pdf";
        const endpoint = isPdf ? "https://api.openai.com/v1/responses" : "https://api.openai.com/v1/chat/completions";
        const body = isPdf
          ? {
              model: config.model,
              input: [{
                role: "user",
                content: [
                  { type: "input_text", text: `${systemPrompt(input.extraInstructions)}\n\n${userPrompt(input, config)}` },
                  { type: "input_file", filename: input.filename, file_data: `data:${input.mediaType};base64,${input.base64}` },
                ],
              }],
              text: { format: { type: "json_object" } },
              reasoning: { effort: config.reasoningEffort },
              max_output_tokens: config.maxOutputTokens,
            }
          : {
              model: config.model,
              response_format: { type: "json_object" },
              // Deux réglages MESURÉS sur un relevé PEA réel :
              //  • reasoning_effort : « minimal » lit aussi bien que « high » (même nombre
              //    d'erreurs) en 16 s au lieu de 92 s. Le raisonnement ne sert pas à lire.
              //  • max_completion_tokens : sans plafond, rien n'arrêtait une phase de
              //    raisonnement qui consommait tout le délai avant d'écrire la moindre ligne.
              reasoning_effort: config.reasoningEffort,
              max_completion_tokens: config.maxOutputTokens,
              messages: [
                { role: "system", content: systemPrompt(input.extraInstructions) },
                { role: "user", content: [
                  { type: "text", text: userPrompt(input, config) },
                  { type: "image_url", image_url: { url: `data:${input.mediaType};base64,${input.base64}`, detail: "high" } },
                ] },
              ],
            };
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error(`Fournisseur IA: ${response.status} ${(await response.text().catch(() => "")).slice(0, 200)}`);
        const data = await response.json() as { choices?: Array<{ message?: { content?: string } }>; output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> };
        const text = isPdf ? responseText(data) : data.choices?.[0]?.message?.content ?? "";
        return parseJsonBlock(text);
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
