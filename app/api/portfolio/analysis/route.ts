// Analyse pédagogique d'un compte PEA / compte-titres.
//
// Chaîne, dans cet ordre, et l'ordre est le sujet :
//   1. le SERVEUR construit un objet déterministe à partir des moteurs existants ;
//   2. cet objet est haché ; si l'analyse correspondante existe déjà en cache, elle est renvoyée
//      telle quelle — inutile de payer un appel pour rephraser des chiffres inchangés ;
//   3. sinon le modèle est appelé, avec pour seule matière cet objet ;
//   4. sa réponse est VALIDÉE : toute observation citant un chiffre absent de l'objet, nommant un
//      actif inconnu, ou formulant un ordre / une promesse, est rejetée ;
//   5. s'il ne reste rien, l'analyse déterministe prend le relais. Un écran ne reste jamais vide,
//      et ne contient jamais une phrase invérifiable.
//
// Sécurité : le périmètre de lecture est celui du partage familial, exactement comme /api/portfolio.

import { authErrorResponse, requireFamilyMember, viewableInvestmentScope } from "../../../../lib/auth-server";
import { supabaseRest } from "../../../../lib/supabase-rest";
import { buildPortfolioFacts, loadAccountContext } from "../../../../lib/portfolio-facts-server";
import {
  DISCLAIMER, buildAnalysisPrompt, coverageLabel, deterministicObservations, factsHash, validateObservations,
  type Observation, type PortfolioFacts,
} from "../../../../lib/portfolio-insights";
import { getAnalysisConfig, parseObservationsPayload, requestAnalysis } from "../../../../lib/portfolio-analysis-provider";

export const runtime = "nodejs";

type CachedAnalysis = { facts_hash: string; observations: Observation[]; coverage_label: string | null; provider: string; generated_at: string };

const TONES = new Set(["positive", "risk", "action"]);

function asObservations(payload: unknown): Observation[] {
  const list = (payload as { observations?: unknown } | null)?.observations;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry): Observation[] => {
    const row = entry as Record<string, unknown>;
    const tone = String(row.tone ?? "");
    const title = String(row.title ?? "").trim();
    const body = String(row.body ?? "").trim();
    if (!TONES.has(tone) || !title || !body) return [];
    return [{ tone: tone as Observation["tone"], title, body, metric: String(row.metric ?? "").trim() }];
  });
}

/** Le compte est-il lisible par l'appelant ? Même règle que /api/portfolio, appliquée en code. */
async function assertReadable(request: Request, accountId: string) {
  const viewer = await requireFamilyMember(request);
  const rows = await supabaseRest<Array<{ id: string; member_id: string; account_type: string }>>(
    `financial_accounts?select=id,member_id,account_type&id=eq.${encodeURIComponent(accountId)}&limit=1`,
  );
  const account = rows[0];
  if (!account) return { ok: false as const, response: Response.json({ error: "Compte introuvable." }, { status: 404 }) };
  const scope = await viewableInvestmentScope(viewer);
  if (scope !== null) {
    const flags = scope.get(account.member_id);
    const visible = account.account_type === "pea" ? flags?.pea === true : account.account_type === "securities" ? flags?.cto === true : false;
    if (!visible) return { ok: false as const, response: Response.json({ error: "Accès refusé." }, { status: 403 }) };
  }
  return { ok: true as const, viewer, isAdmin: viewer.role === "admin" };
}

async function readCache(accountId: string, hash: string): Promise<CachedAnalysis | null> {
  const rows = await supabaseRest<CachedAnalysis[]>(
    `portfolio_analyses?select=facts_hash,observations,coverage_label,provider,generated_at&account_id=eq.${encodeURIComponent(accountId)}&facts_hash=eq.${encodeURIComponent(hash)}&limit=1`,
  ).catch(() => [] as CachedAnalysis[]);
  return rows[0] ?? null;
}

async function writeCache(accountId: string, facts: PortfolioFacts, hash: string, observations: Observation[], provider: string) {
  await supabaseRest("portfolio_analyses?on_conflict=account_id,facts_hash", {
    method: "POST",
    headers: { prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      account_id: accountId,
      facts_hash: hash,
      facts,
      observations,
      coverage_label: coverageLabel(facts),
      provider,
      generated_at: new Date().toISOString(),
    }),
  }).catch(() => undefined); // le cache est un confort : son échec ne prive pas d'analyse
}

async function handle(request: Request, force: boolean) {
  const url = new URL(request.url);
  const accountId = (url.searchParams.get("accountId") ?? "").trim();
  if (!accountId) return Response.json({ error: "accountId manquant." }, { status: 400 });

  const access = await assertReadable(request, accountId);
  if (!access.ok) return access.response;

  const context = await loadAccountContext(accountId);
  if (!context) return Response.json({ error: "Compte PEA ou compte-titres introuvable." }, { status: 404 });

  const generatedAt = new Date().toISOString();
  const facts = buildPortfolioFacts(context, generatedAt);
  const hash = factsHash(facts);

  if (!force) {
    const cached = await readCache(accountId, hash);
    if (cached) {
      return Response.json({
        observations: cached.observations,
        generatedAt: cached.generated_at,
        factsHash: cached.facts_hash,
        coverageLabel: cached.coverage_label ?? coverageLabel(facts),
        provider: cached.provider,
        cached: true,
        disclaimer: DISCLAIMER,
        facts,
      });
    }
  }

  const config = getAnalysisConfig();
  let observations: Observation[] = [];
  let provider = "deterministic";
  let rejected: Array<{ reason: string }> = [];

  if (config.configured) {
    const text = await requestAnalysis(buildAnalysisPrompt(facts), config);
    if (text) {
      const validation = validateObservations(asObservations(parseObservationsPayload(text)), facts);
      observations = validation.accepted;
      rejected = validation.rejected.map((entry) => ({ reason: entry.reason }));
      if (observations.length > 0) provider = config.provider;
    }
  }
  // Repli — et garde-fou : une couverture insuffisante doit être DITE, quelle que soit la
  // formulation retenue par le modèle.
  if (observations.length === 0) observations = deterministicObservations(facts);
  else if (!facts.coverage.sufficient && !observations.some((observation) => /couvert|partiel|valoris/i.test(`${observation.title} ${observation.body}`))) {
    observations = [deterministicObservations(facts)[0], ...observations].filter(Boolean).slice(0, 3);
  }

  await writeCache(accountId, facts, hash, observations, provider);

  return Response.json({
    observations,
    generatedAt,
    factsHash: hash,
    coverageLabel: coverageLabel(facts),
    provider,
    cached: false,
    rejected,
    disclaimer: DISCLAIMER,
    facts,
  });
}

export async function GET(request: Request) {
  try {
    return await handle(request, false);
  } catch (error) {
    return authErrorResponse(error);
  }
}

/** Régénération explicite (bouton « Actualiser l'analyse »). */
export async function POST(request: Request) {
  try {
    return await handle(request, true);
  } catch (error) {
    return authErrorResponse(error);
  }
}
