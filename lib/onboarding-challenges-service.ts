// Orchestration serveur du parcours « Bien démarrer » (Node uniquement : clé service-role via
// supabaseRest). La logique de décision est PURE et vit dans lib/onboarding-challenges.ts ; ici on
// lit Supabase, dérive les positions avec le MÊME moteur que l'écran PEA/CTO (computeAccountModel),
// et attribue les points via la RPC transactionnelle EXISTANTE apply_challenge_points — jamais
// d'INSERT direct dans points_ledger.
//
// SÉCURITÉ (frontière réelle) : toute fonction ici présume un memberId déjà déterminé côté route
// (requireFamilyMember). Un membre ne réconcilie JAMAIS que SES propres missions. Un seul appel
// centralisé (reconcileOnboardingForMember) est réutilisé par toutes les routes d'écriture PEA/CTO
// et par le filet de sécurité au chargement de l'écran Défis — aucune logique dupliquée par type
// de compte.

import { supabaseRest } from "./supabase-rest.ts";
import { computeAccountModel, type AccountOperation, type AccountType } from "./portfolio-account.ts";
import {
  ONBOARDING_CHALLENGE_TYPE, ONBOARDING_MISSIONS, ONBOARDING_MISSION_SLUGS,
  evaluateOnboardingMissions, buildOnboardingProgress, onboardingCompletionKey,
  type OnboardingMemberFacts, type OnboardingMissionSlug, type OnboardingPositionFact, type OnboardingPurchaseFact, type OnboardingProgress,
} from "./onboarding-challenges.ts";

const REASON = "onboarding_completion";

export function isMissingOnboardingSchema(error: unknown): boolean {
  return error instanceof Error && (/\bslug\b/.test(error.message) || error.message.includes("PGRST204") || error.message.includes("42703") || error.message.includes("challenges") || error.message.includes("PGRST205"));
}

type ChallengeRow = { id: string; slug: string | null; points_reward: number };
type MissionRow = { id: string; points: number };

/** Les 4 lignes préconfigurées (seedées par la migration 20260805), indexées par leur slug métier. */
async function getOnboardingMissionRows(): Promise<Map<OnboardingMissionSlug, MissionRow>> {
  const map = new Map<OnboardingMissionSlug, MissionRow>();
  let rows: ChallengeRow[];
  try {
    rows = await supabaseRest<ChallengeRow[]>(
      `challenges?select=id,slug,points_reward&challenge_type=eq.${ONBOARDING_CHALLENGE_TYPE}&status=eq.active`,
    );
  } catch (error) {
    if (isMissingOnboardingSchema(error)) return map; // migration 20260805 non encore jouée
    throw error;
  }
  for (const row of rows) {
    if (row.slug && (ONBOARDING_MISSION_SLUGS as readonly string[]).includes(row.slug)) {
      map.set(row.slug as OnboardingMissionSlug, { id: row.id, points: Number(row.points_reward) });
    }
  }
  return map;
}

type AccountRow = { id: string; account_type: string; is_active: boolean; name: string | null };
type OperationRow = {
  id: string; account_id: string; type: string; operation_date: string;
  asset_name: string | null; ticker: string | null; isin: string | null;
  quantity: number | null; unit_price: number | null; gross_amount: number | null; fees: number | null; net_amount: number | null;
  currency: string;
};
type PlanRow = { monthly_target: number | string | null; target_account_id: string | null };

function toAccountOperation(op: OperationRow): AccountOperation {
  return {
    id: op.id, accountId: op.account_id, type: op.type as AccountOperation["type"], date: op.operation_date,
    assetName: op.asset_name, ticker: op.ticker, isin: op.isin,
    quantity: op.quantity === null ? null : Number(op.quantity), unitPrice: op.unit_price === null ? null : Number(op.unit_price),
    grossAmount: op.gross_amount === null ? null : Number(op.gross_amount), fees: op.fees === null ? null : Number(op.fees),
    netAmount: op.net_amount === null ? null : Number(op.net_amount), currency: op.currency, source: null, note: null,
  };
}

/** Faits RÉELS du membre — uniquement ses propres comptes PEA/compte-titres. Aucune donnée d'autrui. */
async function loadMemberFacts(memberId: string): Promise<OnboardingMemberFacts> {
  const [accountRows, planRows] = await Promise.all([
    supabaseRest<AccountRow[]>(`financial_accounts?select=id,account_type,is_active,name&member_id=eq.${encodeURIComponent(memberId)}&account_type=in.(pea,securities)`),
    supabaseRest<PlanRow[]>(`user_investment_plan?select=monthly_target,target_account_id&member_id=eq.${encodeURIComponent(memberId)}&limit=1`).catch(() => [] as PlanRow[]),
  ]);
  const accounts = accountRows.map((row) => ({ id: row.id, accountType: row.account_type, isActive: row.is_active, name: row.name }));
  const accountIds = accounts.map((account) => account.id);

  let operationRows: OperationRow[] = [];
  if (accountIds.length > 0) {
    operationRows = await supabaseRest<OperationRow[]>(
      `account_operations?select=id,account_id,type,operation_date,asset_name,ticker,isin,quantity,unit_price,gross_amount,fees,net_amount,currency&account_id=in.(${accountIds.join(",")})`,
    ).catch(() => [] as OperationRow[]);
  }

  const purchases: OnboardingPurchaseFact[] = operationRows.map((op) => ({
    accountId: op.account_id, type: op.type,
    quantity: op.quantity === null ? null : Number(op.quantity), unitPrice: op.unit_price === null ? null : Number(op.unit_price),
    assetName: op.asset_name, ticker: op.ticker, isin: op.isin, date: op.operation_date,
  }));

  // Positions dérivées avec le MÊME moteur que l'écran PEA/CTO (computeAccountModel), par compte
  // (le référentiel de cours est inutile ici : seule quantity > 0 nous intéresse, jamais une valorisation).
  const positions: OnboardingPositionFact[] = [];
  for (const account of accounts) {
    const accountOps = operationRows.filter((op) => op.account_id === account.id);
    if (accountOps.length === 0) continue;
    const kind: AccountType = account.accountType === "pea" ? "PEA" : "CTO";
    const model = computeAccountModel({ operations: accountOps.map(toAccountOperation), priceByKey: new Map(), accountType: kind });
    for (const position of model.positions) positions.push({ accountId: account.id, quantity: position.quantity });
  }

  const plan: OnboardingMemberFacts["plan"] = planRows[0]
    ? { monthlyTarget: planRows[0].monthly_target === null ? null : Number(planRows[0].monthly_target), targetAccountId: planRows[0].target_account_id }
    : null;

  return { accounts, positions, plan, purchases };
}

async function applyOnboardingPoints(params: { memberId: string; challengeId: string; points: number; slug: OnboardingMissionSlug }): Promise<void> {
  // Réutilise TEL QUEL la RPC transactionnelle du défi mensuel : participant_id NULL est accepté
  // (colonne déjà nullable) ; le verrou et l'UPDATE sur challenge_participants portent alors sur
  // 0 ligne (no-op sûr), l'INSERT idempotent dans points_ledger reste l'unique effet réel.
  await supabaseRest("rpc/apply_challenge_points", {
    method: "POST",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify({
      p_participant_id: null, p_challenge_id: params.challengeId, p_member_id: params.memberId,
      p_points: params.points, p_reason: REASON,
      p_idempotency_key: onboardingCompletionKey(params.slug, params.memberId),
      p_metadata: { slug: params.slug }, p_new_status: "completed", p_completed: true,
    }),
  });
}

export type OnboardingReconcileResult = { available: boolean; progress: OnboardingProgress; justCompleted: OnboardingMissionSlug[] };

const EMPTY_RESULTS = { onboarding_account_setup: false, onboarding_existing_portfolio: false, onboarding_monthly_plan: false, onboarding_first_purchase: false } as const;

/**
 * Réconcilie le parcours « Bien démarrer » d'UN membre : détermine objectivement les missions
 * terminées (y compris rétroactivement, à partir de données déjà existantes), attribue les points
 * des missions nouvellement terminées (idempotent : une écriture par mission et par membre, pour
 * toujours), et renvoie la progression fraîche + la liste des missions VENANT d'être complétées
 * (pour un message de réussite ciblé côté client).
 */
export async function reconcileOnboardingForMember(memberId: string): Promise<OnboardingReconcileResult> {
  const missionRows = await getOnboardingMissionRows();
  if (missionRows.size === 0) {
    return { available: false, progress: buildOnboardingProgress(EMPTY_RESULTS), justCompleted: [] };
  }

  // financial_accounts / account_operations / user_investment_plan sont des tables socle déjà
  // requises par le reste de l'application ; si l'une d'elles manque malgré tout (installation
  // partielle), on dégrade proprement plutôt que de faire échouer tout l'écran Défis.
  let facts: OnboardingMemberFacts;
  try {
    facts = await loadMemberFacts(memberId);
  } catch (error) {
    if (isMissingOnboardingSchema(error)) return { available: false, progress: buildOnboardingProgress(EMPTY_RESULTS), justCompleted: [] };
    throw error;
  }
  const results = evaluateOnboardingMissions(facts);

  const missionIds = [...missionRows.values()].map((mission) => mission.id);
  const alreadyAwarded = new Set<string>();
  if (missionIds.length > 0) {
    const ledgerRows = await supabaseRest<Array<{ challenge_id: string | null }>>(
      `points_ledger?select=challenge_id&member_id=eq.${encodeURIComponent(memberId)}&reason=eq.${REASON}&challenge_id=in.(${missionIds.map(encodeURIComponent).join(",")})`,
    ).catch(() => [] as Array<{ challenge_id: string | null }>);
    for (const row of ledgerRows) if (row.challenge_id) alreadyAwarded.add(row.challenge_id);
  }

  const justCompleted: OnboardingMissionSlug[] = [];
  for (const slug of ONBOARDING_MISSION_SLUGS) {
    if (!results[slug]) continue;
    const mission = missionRows.get(slug);
    if (!mission || alreadyAwarded.has(mission.id)) continue; // pas seedée, ou déjà attribuée pour toujours
    await applyOnboardingPoints({ memberId, challengeId: mission.id, points: mission.points, slug });
    justCompleted.push(slug);
  }

  const pointsBySlug: Partial<Record<OnboardingMissionSlug, number>> = {};
  for (const [slug, mission] of missionRows) pointsBySlug[slug] = mission.points;

  return { available: true, progress: buildOnboardingProgress(results, pointsBySlug), justCompleted };
}

/** Lecture + réconciliation en un appel, pour l'écran Défis (filet de sécurité au chargement). */
export async function getOnboardingProgressForMember(memberId: string): Promise<OnboardingReconcileResult> {
  return reconcileOnboardingForMember(memberId);
}

// ---- Administration (lecture seule) --------------------------------------------------------
export type AdminOnboardingMissionRow = { slug: OnboardingMissionSlug; title: string; points: number; completedCount: number };

/** Vue admin minimale : les 4 missions préconfigurées + combien de membres ont terminé chacune. */
export async function listOnboardingMissionsForAdmin(): Promise<AdminOnboardingMissionRow[]> {
  const missionRows = await getOnboardingMissionRows();
  if (missionRows.size === 0) return [];
  const missionIds = [...missionRows.values()].map((mission) => mission.id);
  const ledgerRows = await supabaseRest<Array<{ challenge_id: string | null; member_id: string }>>(
    `points_ledger?select=challenge_id,member_id&reason=eq.${REASON}&challenge_id=in.(${missionIds.map(encodeURIComponent).join(",")})`,
  ).catch(() => [] as Array<{ challenge_id: string | null; member_id: string }>);
  const completedByChallenge = new Map<string, Set<string>>();
  for (const row of ledgerRows) {
    if (!row.challenge_id) continue;
    const set = completedByChallenge.get(row.challenge_id) ?? new Set<string>();
    set.add(row.member_id);
    completedByChallenge.set(row.challenge_id, set);
  }
  return ONBOARDING_MISSIONS.map((def) => {
    const mission = missionRows.get(def.slug);
    return {
      slug: def.slug, title: def.title,
      points: mission?.points ?? def.points,
      completedCount: mission ? (completedByChallenge.get(mission.id)?.size ?? 0) : 0,
    };
  });
}
