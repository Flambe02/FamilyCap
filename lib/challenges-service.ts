// Orchestration serveur des Défis (Node uniquement : utilise la clé service-role via supabaseRest).
// La logique pure vit dans lib/challenges.ts ; ici on lit/écrit Supabase et on compose.
//
// SÉCURITÉ (frontière réelle) : toutes les fonctions présument un appelant déjà identifié côté
// route (requireFamilyMember / requireAdmin). Le member_id est TOUJOURS fourni par le serveur,
// jamais par le navigateur. L'attribution de points est IDEMPOTENTE (idempotency_key unique) ; la
// réconciliation est rejouable sans effet de bord (liens uniques par défi+opération).

import { supabaseRest } from "./supabase-rest.ts";
import { instrumentKey, priceKeyOf } from "./portfolio-account.ts";
import { getOnboardingProgressForMember, type OnboardingReconcileResult } from "./onboarding-challenges-service.ts";
import {
  isPurchaseEligible, computeChallengeProgress, completionKey, reversalKey, resolvePointsAction, buildLeaderboard, memberChallengeState,
  validateChallengeInput, canTransition, CHALLENGE_STATUSES, effectiveWindowStart, deriveChallengeLevel, calculateMonthlyStreak,
  isChallengeVisibleToMember,
  type ParticipantStatus, type MemberChallengeState, type ChallengeStatus, type ChallengeInput, type LeaderboardBuildRow, type AvailabilityMode,
} from "./challenges.ts";

export type ChallengeRow = {
  id: string; title: string; description: string | null; challenge_type: string; status: string;
  starts_on: string | null; ends_on: string | null; points_reward: number; // dates NULL = défi permanent
  eligible_account_types: string[]; eligible_instrument_types: string[];
  availability_mode: string; requires_challenge_id: string | null;
  created_by: string | null; created_at: string; updated_at: string;
};

export type ParticipantRow = {
  id: string; challenge_id: string; member_id: string; target_account_id: string | null;
  target_amount_snapshot: number | string; target_currency: string; status: ParticipantStatus;
  joined_at: string; completed_at: string | null;
};

type AccountRow = { id: string; member_id: string; account_type: string; currency: string; is_active: boolean };
type PlanRow = { monthly_target: number | string | null; target_account_id: string | null; leaderboard_opt_in: boolean };
type OperationRow = {
  id: string; account_id: string; member_id: string; type: string; operation_date: string;
  asset_name: string | null; ticker: string | null; isin: string | null;
  quantity: number | null; unit_price: number | null; gross_amount: number | null; fees: number | null; net_amount: number | null;
};
type HoldingRow = { asset_type: string | null; name: string | null; symbol: string | null; isin: string | null };
type LinkRow = { operation_id: string; eligible_amount: number | string };
type LedgerRow = { challenge_id: string | null; points: number; reason: string; created_at: string };

export function isMissingChallengeTable(error: unknown): boolean {
  return error instanceof Error && (/challenges|challenge_participants|challenge_operation_links|challenge_unlocks|points_ledger/.test(error.message) || error.message.includes("PGRST205") || error.message.includes("PGRST106"));
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
function num(value: number | string | null | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

const CHALLENGE_SELECT = "id,title,description,challenge_type,status,starts_on,ends_on,points_reward,eligible_account_types,eligible_instrument_types,availability_mode,requires_challenge_id,created_by,created_at,updated_at";
const PARTICIPANT_SELECT = "id,challenge_id,member_id,target_account_id,target_amount_snapshot,target_currency,status,joined_at,completed_at";

// Toutes les lectures « défi mensuel » ci-dessous filtrent explicitement challenge_type :
// depuis la migration 20260805, les 4 missions permanentes « Bien démarrer » partagent la même
// table `challenges` (status='active', starts_on/ends_on NULL) — sans ce filtre, elles fuiteraient
// dans la liste/l'historique du défi mensuel. Leur lecture dédiée vit dans
// lib/onboarding-challenges-service.ts.
const MONTHLY_TYPE_FILTER = "&challenge_type=eq.monthly_investment";

// ---- Lectures de base ---------------------------------------------------------------------
/**
 * Défis « courants » : actifs et dont la période contient aujourd'hui, les plus récents d'abord.
 * Un défi PERMANENT (starts_on/ends_on NULL) est toujours courant : une borne absente ne filtre
 * rien. Sans ce traitement des NULL, un défi sans date serait invisible côté membre.
 * `nullsfirst` : à statut égal, le défi permanent passe avant les défis datés.
 *
 * Depuis la migration 20260825, PLUSIEURS défis mensuels peuvent être actifs simultanément
 * (l'ancienne contrainte « un seul défi actif » a été retirée) : cette lecture renvoie TOUS ceux
 * dans leur période, sans filtrer par membre — c'est isChallengeVisibleForMember ci-dessous qui
 * décide, pour un membre donné, lesquels sont réellement visibles (mode 'always'/'sequential'/'special').
 */
export async function getActiveChallenges(): Promise<ChallengeRow[]> {
  const today = todayISO();
  const period = `and=(or(starts_on.is.null,starts_on.lte.${today}),or(ends_on.is.null,ends_on.gte.${today}))`;
  return supabaseRest<ChallengeRow[]>(
    `challenges?select=${CHALLENGE_SELECT}&status=eq.active&${period}${MONTHLY_TYPE_FILTER}&order=starts_on.desc.nullsfirst&limit=50`,
  );
}

/**
 * Visibilité RÉELLE d'un défi pour un membre donné : résout les faits (prérequis terminé,
 * déblocage explicite) puis délègue la décision au moteur pur isChallengeVisibleToMember.
 */
export async function isChallengeVisibleForMember(challenge: ChallengeRow, memberId: string): Promise<boolean> {
  const mode = (challenge.availability_mode || "always") as AvailabilityMode;
  if (mode === "always") return true;
  if (mode === "sequential") {
    if (!challenge.requires_challenge_id) return true; // mal configuré : ne bloque jamais silencieusement
    const rows = await supabaseRest<Array<{ points: number }>>(
      `points_ledger?select=points&member_id=eq.${encodeURIComponent(memberId)}&challenge_id=eq.${encodeURIComponent(challenge.requires_challenge_id)}`,
    );
    const net = rows.reduce((sum, row) => sum + num(row.points), 0);
    return isChallengeVisibleToMember({ availabilityMode: mode, requiresChallengeCompleted: net > 0, unlocked: false });
  }
  const unlocks = await supabaseRest<Array<{ id: string }>>(
    `challenge_unlocks?select=id&challenge_id=eq.${encodeURIComponent(challenge.id)}&member_id=eq.${encodeURIComponent(memberId)}&limit=1`,
  );
  return isChallengeVisibleToMember({ availabilityMode: mode, requiresChallengeCompleted: false, unlocked: unlocks.length > 0 });
}

/** Sous-ensemble de getActiveChallenges() réellement visible par CE membre, dans l'ordre reçu. */
export async function getVisibleActiveChallengesForMember(memberId: string): Promise<ChallengeRow[]> {
  const active = await getActiveChallenges();
  const visible: ChallengeRow[] = [];
  for (const challenge of active) {
    if (await isChallengeVisibleForMember(challenge, memberId)) visible.push(challenge);
  }
  return visible;
}

export async function getChallengeById(id: string): Promise<ChallengeRow | null> {
  const rows = await supabaseRest<ChallengeRow[]>(`challenges?select=${CHALLENGE_SELECT}&id=eq.${encodeURIComponent(id)}&limit=1`);
  return rows[0] ?? null;
}

/** Défis mensuels visibles par un membre (non-brouillon). */
export async function listVisibleChallenges(): Promise<ChallengeRow[]> {
  return supabaseRest<ChallengeRow[]>(`challenges?select=${CHALLENGE_SELECT}&status=neq.draft${MONTHLY_TYPE_FILTER}&order=starts_on.desc.nullsfirst&limit=50`);
}

export async function getParticipant(challengeId: string, memberId: string): Promise<ParticipantRow | null> {
  const rows = await supabaseRest<ParticipantRow[]>(
    `challenge_participants?select=${PARTICIPANT_SELECT}&challenge_id=eq.${encodeURIComponent(challengeId)}&member_id=eq.${encodeURIComponent(memberId)}&limit=1`,
  );
  return rows[0] ?? null;
}

// ---- Inscription + gel de l'objectif ------------------------------------------------------
export type JoinResult =
  | { ok: true; participant: ParticipantRow; progress: Awaited<ReturnType<typeof reconcileParticipant>> }
  | { ok: false; reason: "no_active_challenge" | "no_plan" | "no_account" | "ineligible_account" | "invalid_target"; message: string };

/**
 * Inscrit le membre au défi courant en FIGEANT son objectif (user_investment_plan.monthly_target)
 * dans target_amount_snapshot. Idempotent : réutilise la participation existante. Le montant figé
 * ne suit plus les modifications ultérieures du plan.
 */
export async function joinChallenge(memberId: string, challengeId: string): Promise<JoinResult> {
  const activeList = await getActiveChallenges();
  const active = activeList.find((item) => item.id === challengeId);
  if (!active) return { ok: false, reason: "no_active_challenge", message: "Ce défi n'est pas disponible actuellement." };
  if (!(await isChallengeVisibleForMember(active, memberId))) {
    return { ok: false, reason: "no_active_challenge", message: "Ce défi n'est pas encore disponible pour toi." };
  }

  const existing = await getParticipant(active.id, memberId);
  if (existing) {
    const progress = await reconcileParticipant(existing, active);
    return { ok: true, participant: existing, progress };
  }

  const planRows = await supabaseRest<PlanRow[]>(`user_investment_plan?select=monthly_target,target_account_id,leaderboard_opt_in&member_id=eq.${encodeURIComponent(memberId)}&limit=1`);
  const plan = planRows[0];
  const monthlyTarget = plan ? num(plan.monthly_target) : 0;
  if (!plan || !(monthlyTarget > 0)) return { ok: false, reason: "no_plan", message: "Configure d'abord ton rythme d'investissement (objectif mensuel)." };
  if (!plan.target_account_id) return { ok: false, reason: "no_account", message: "Choisis un compte PEA ou compte-titres dans « Mon rythme »." };

  const accountRows = await supabaseRest<AccountRow[]>(`financial_accounts?select=id,member_id,account_type,currency,is_active&id=eq.${encodeURIComponent(plan.target_account_id)}&limit=1`);
  const account = accountRows[0];
  if (!account || account.member_id !== memberId) return { ok: false, reason: "invalid_target", message: "Le compte choisi doit être l'un de tes comptes." };
  if (!account.is_active) return { ok: false, reason: "ineligible_account", message: "Ton compte cible est archivé : réactive-le ou choisis-en un autre." };
  const eligibleTypes = active.eligible_account_types?.length ? active.eligible_account_types : ["pea", "securities"];
  if (!eligibleTypes.includes(account.account_type)) return { ok: false, reason: "ineligible_account", message: "Ce type de compte n'est pas éligible à ce défi." };

  await supabaseRest("challenge_participants?on_conflict=challenge_id,member_id", {
    method: "POST",
    headers: { prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify({
      challenge_id: active.id,
      member_id: memberId,
      target_account_id: account.id,
      target_amount_snapshot: monthlyTarget,
      target_currency: account.currency || "EUR",
      status: "in_progress",
    }),
  });
  const participant = await getParticipant(active.id, memberId);
  if (!participant) return { ok: false, reason: "invalid_target", message: "Inscription impossible." };
  const progress = await reconcileParticipant(participant, active);
  return { ok: true, participant, progress };
}

// ---- Réconciliation : détection des achats + attribution/annulation idempotente des points ---
export type ReconcileResult = {
  invested: number; targetAmount: number; pct: number; completed: boolean; status: ParticipantStatus;
  linkedOperations: number; lastEligibleDate: string | null; skippedUnknownInstrument: number;
};

/**
 * Réconcilie la participation : lie les achats éligibles (idempotent), recalcule la progression,
 * puis attribue OU annule les points de façon idempotente. La « version » d'idempotence est le
 * NOMBRE d'annulations déjà écrites → deux appels concurrents produisent la même clé (aucun
 * double), et une re-complétion après annulation obtient une clé distincte (nouveaux points).
 */
export async function reconcileParticipant(participant: ParticipantRow, challenge: ChallengeRow): Promise<ReconcileResult> {
  const targetAmount = num(participant.target_amount_snapshot);
  const targetAccountId = participant.target_account_id;

  // 1) Achats candidats sur le compte cible, dans la période. Sans compte cible → rien à lier.
  // La fenêtre vient de effectiveWindowStart (source unique) : date de début du défi, ou date
  // d'inscription pour un défi permanent. Sans borne basse calculable, on ne charge rien plutôt
  // que de balayer tout l'historique du compte (le moteur pur refuserait de toute façon : fail-closed).
  const eligibleInstrumentTypes = challenge.eligible_instrument_types?.length ? challenge.eligible_instrument_types : ["etf", "stock"];
  const joinedOn = participant.joined_at ? participant.joined_at.slice(0, 10) : null;
  const windowStart = effectiveWindowStart(challenge.starts_on, joinedOn);
  let operations: OperationRow[] = [];
  let holdings: HoldingRow[] = [];
  if (targetAccountId && windowStart) {
    const upperBound = challenge.ends_on ? `&operation_date=lte.${challenge.ends_on}` : "";
    [operations, holdings] = await Promise.all([
      supabaseRest<OperationRow[]>(
        `account_operations?select=id,account_id,member_id,type,operation_date,asset_name,ticker,isin,quantity,unit_price,gross_amount,fees,net_amount&account_id=eq.${encodeURIComponent(targetAccountId)}&type=eq.achat&operation_date=gte.${windowStart}${upperBound}`,
      ),
      supabaseRest<HoldingRow[]>(`holdings?select=asset_type,name,symbol,isin&account_id=eq.${encodeURIComponent(targetAccountId)}`),
    ]);
  }
  const assetTypeByKey = new Map<string, string | null>();
  for (const holding of holdings) assetTypeByKey.set(priceKeyOf({ isin: holding.isin, symbol: holding.symbol, name: holding.name }), holding.asset_type);

  // 2) Liens déjà présents (dédoublonnage : une opération ne compte qu'une fois par défi).
  const existingLinks = await supabaseRest<LinkRow[]>(`challenge_operation_links?select=operation_id,eligible_amount&participant_id=eq.${encodeURIComponent(participant.id)}`);
  const linkedIds = new Set(existingLinks.map((link) => link.operation_id));

  // 3) Nouveaux achats éligibles → insertion des liens (idempotent via unique(challenge,operation)).
  const scope = { memberId: participant.member_id, targetAccountId, joinedOn };
  const window = { startsOn: challenge.starts_on, endsOn: challenge.ends_on, eligibleInstrumentTypes };
  let lastEligibleDate: string | null = null;
  let skippedUnknownInstrument = 0;
  for (const op of operations) {
    const assetType = assetTypeByKey.get(instrumentKey({ isin: op.isin, ticker: op.ticker, assetName: op.asset_name })) ?? null;
    const verdict = isPurchaseEligible({ memberId: op.member_id, accountId: op.account_id, type: op.type, date: op.operation_date, netAmount: op.net_amount, grossAmount: op.gross_amount, quantity: op.quantity, unitPrice: op.unit_price, assetType }, scope, window);
    if (!verdict.eligible) {
      // Documente la raison : un achat dont le type d'instrument n'est pas identifiable dans le
      // référentiel `holdings` est écarté (règle stricte). Comptabilisé pour observabilité.
      if (verdict.reason === "instrument_unknown") skippedUnknownInstrument += 1;
      continue;
    }
    if (!lastEligibleDate || op.operation_date > lastEligibleDate) lastEligibleDate = op.operation_date;
    if (linkedIds.has(op.id)) continue;
    await supabaseRest("challenge_operation_links?on_conflict=challenge_id,operation_id", {
      method: "POST",
      headers: { prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify({ challenge_id: challenge.id, participant_id: participant.id, operation_id: op.id, eligible_amount: verdict.amount }),
    });
    linkedIds.add(op.id);
  }
  if (skippedUnknownInstrument > 0) {
    console.warn(`[challenges] ${skippedUnknownInstrument} achat(s) écarté(s) (type d'instrument non identifié dans holdings) — participant ${participant.id}, défi ${challenge.id}.`);
  }

  // 4) Progression = Σ des montants éligibles réellement liés (source de vérité : les liens).
  const links = await supabaseRest<LinkRow[]>(`challenge_operation_links?select=operation_id,eligible_amount&participant_id=eq.${encodeURIComponent(participant.id)}`);
  const progress = computeChallengeProgress(links.map((link) => num(link.eligible_amount)), targetAmount);

  // 5) Attribution / annulation ATOMIQUE et idempotente des points (RPC apply_challenge_points :
  //    verrou de la participation + insert idempotent + update statut, dans une seule transaction).
  const ledger = await supabaseRest<LedgerRow[]>(`points_ledger?select=challenge_id,points,reason,created_at&member_id=eq.${encodeURIComponent(participant.member_id)}&challenge_id=eq.${encodeURIComponent(challenge.id)}`);
  const completionCount = ledger.filter((row) => row.reason === "challenge_completion").length;
  const reversalCount = ledger.filter((row) => row.reason === "challenge_reversal").length;
  const decision = resolvePointsAction({ progressCompleted: progress.completed, completionCount, reversalCount });

  let status: ParticipantStatus = participant.status;
  if (decision.action === "award") {
    await applyChallengePoints({
      participantId: participant.id, challengeId: challenge.id, memberId: participant.member_id,
      points: challenge.points_reward, reason: "challenge_completion",
      idempotencyKey: completionKey(challenge.id, participant.member_id, decision.version),
      metadata: { version: decision.version, target: targetAmount, invested: progress.invested },
      newStatus: "completed", completed: true,
    });
    status = "completed";
  } else if (decision.action === "reverse") {
    await applyChallengePoints({
      participantId: participant.id, challengeId: challenge.id, memberId: participant.member_id,
      points: -challenge.points_reward, reason: "challenge_reversal",
      idempotencyKey: reversalKey(challenge.id, participant.member_id, decision.version),
      metadata: { version: decision.version, invested: progress.invested, cause: "progress_below_target" },
      newStatus: "in_progress", completed: false,
    });
    status = "in_progress";
  } else {
    // Aucun mouvement de points : on aligne seulement le statut sur l'état réel du journal
    // (jamais 'completed' de force ; pas d'écriture dans le journal ici).
    const awarded = completionCount - reversalCount > 0;
    const expected: ParticipantStatus = awarded ? "completed" : "in_progress";
    if (participant.status !== expected && (participant.status === "in_progress" || participant.status === "completed")) {
      await setParticipantStatus(participant.id, expected, awarded);
    }
    status = expected;
  }

  return { invested: progress.invested, targetAmount, pct: progress.pct, completed: status === "completed", status, linkedOperations: links.length, lastEligibleDate, skippedUnknownInstrument };
}

/** Lecture stricte des liens existants pour l'aperçu admin : aucune mutation ni attribution. */
export async function readParticipantProgress(participant: ParticipantRow): Promise<ReconcileResult> {
  const links = await supabaseRest<LinkRow[]>(`challenge_operation_links?select=operation_id,eligible_amount&participant_id=eq.${encodeURIComponent(participant.id)}`);
  const progress = computeChallengeProgress(links.map((link) => num(link.eligible_amount)), num(participant.target_amount_snapshot));
  return {
    invested: progress.invested,
    targetAmount: num(participant.target_amount_snapshot),
    pct: progress.pct,
    completed: participant.status === "completed",
    status: participant.status,
    linkedOperations: links.length,
    lastEligibleDate: null,
    skippedUnknownInstrument: 0,
  };
}

async function setParticipantStatus(participantId: string, status: ParticipantStatus, completed: boolean) {
  await supabaseRest(`challenge_participants?id=eq.${encodeURIComponent(participantId)}`, {
    method: "PATCH",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify({ status, completed_at: completed ? new Date().toISOString() : null, updated_at: new Date().toISOString() }),
  });
}

// Attribution / annulation ATOMIQUE : appelle la fonction SQL transactionnelle apply_challenge_points
// (verrou participation + insert idempotent + update statut dans une seule transaction). L'unicité
// de idempotency_key reste le dernier rempart contre un double, même sous appels concurrents.
async function applyChallengePoints(params: {
  participantId: string | null; challengeId: string; memberId: string; points: number; reason: string;
  idempotencyKey: string; metadata: Record<string, unknown>; newStatus: ParticipantStatus; completed: boolean;
}): Promise<void> {
  await supabaseRest("rpc/apply_challenge_points", {
    method: "POST",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify({
      p_participant_id: params.participantId, p_challenge_id: params.challengeId, p_member_id: params.memberId,
      p_points: params.points, p_reason: params.reason, p_idempotency_key: params.idempotencyKey,
      p_metadata: params.metadata, p_new_status: params.newStatus, p_completed: params.completed,
    }),
  });
}

/** Réconcilie TOUTES les participations actives et visibles du membre. Best-effort, sûr à rejouer. */
export async function reconcileMemberForActive(memberId: string): Promise<void> {
  const visible = await getVisibleActiveChallengesForMember(memberId);
  for (const active of visible) {
    const participant = await getParticipant(active.id, memberId);
    if (!participant) continue;
    await reconcileParticipant(participant, active);
  }
}

// ---- Contexte complet des défis courants pour un membre (écran « Défis ») -----------------
// Depuis la migration 20260825, plusieurs défis mensuels peuvent être actifs et visibles EN MÊME
// TEMPS pour un membre (ex. un défi permanent + un défi spécial débloqué) : le contexte devient
// une LISTE, une entrée par défi visible, chacune réconciliée indépendamment.
export type CurrentForMember = {
  challenge: ChallengeRow | null;
  hasPlan: boolean;
  hasTargetAccount: boolean;
  isParticipant: boolean;
  participant: ParticipantRow | null;
  progress: ReconcileResult | null;
  state: MemberChallengeState;
};

export async function getCurrentChallengesForMember(memberId: string, options: { reconcile?: boolean } = {}): Promise<CurrentForMember[]> {
  const [visible, planRows] = await Promise.all([
    getVisibleActiveChallengesForMember(memberId),
    supabaseRest<PlanRow[]>(`user_investment_plan?select=monthly_target,target_account_id,leaderboard_opt_in&member_id=eq.${encodeURIComponent(memberId)}&limit=1`),
  ]);
  const plan = planRows[0];
  const hasPlan = Boolean(plan && num(plan.monthly_target) > 0);
  const hasTargetAccount = Boolean(plan && plan.target_account_id);

  const results: CurrentForMember[] = [];
  for (const active of visible) {
    const participant = await getParticipant(active.id, memberId);
    let progress: ReconcileResult | null = null;
    if (participant) {
      // Réconciliation à l'ouverture : reconnaît les achats importés/antérieurs et met à jour points.
      progress = options.reconcile === false ? await readParticipantProgress(participant) : await reconcileParticipant(participant, active);
    }
    const state = memberChallengeState({
      hasPlan, hasTargetAccount, isParticipant: Boolean(participant),
      participantStatus: participant ? participant.status : null,
      challengeStatus: active.status as ChallengeStatus,
    });
    results.push({ challenge: active, hasPlan, hasTargetAccount, isParticipant: Boolean(participant), participant, progress, state });
  }
  return results;
}

// ---- Historique des défis du membre (écran « Défis ») ------------------------------------
export type MemberChallengeSummary = {
  id: string; title: string; startsOn: string | null; endsOn: string | null; status: string; pointsReward: number;
  joined: boolean; participantStatus: ParticipantStatus | null; pointsEarned: number;
};

export async function getMemberChallengeHistory(memberId: string): Promise<MemberChallengeSummary[]> {
  const [challenges, participants, ledger] = await Promise.all([
    listVisibleChallenges(),
    supabaseRest<ParticipantRow[]>(`challenge_participants?select=${PARTICIPANT_SELECT}&member_id=eq.${encodeURIComponent(memberId)}`),
    supabaseRest<Array<{ challenge_id: string | null; points: number }>>(`points_ledger?select=challenge_id,points&member_id=eq.${encodeURIComponent(memberId)}`),
  ]);
  const participantByChallenge = new Map(participants.map((participant) => [participant.challenge_id, participant]));
  const pointsByChallenge = new Map<string, number>();
  for (const row of ledger) if (row.challenge_id) pointsByChallenge.set(row.challenge_id, (pointsByChallenge.get(row.challenge_id) ?? 0) + row.points);
  return challenges.map((challenge) => {
    const participant = participantByChallenge.get(challenge.id) ?? null;
    return {
      id: challenge.id, title: challenge.title, startsOn: challenge.starts_on, endsOn: challenge.ends_on,
      status: challenge.status, pointsReward: challenge.points_reward,
      joined: Boolean(participant), participantStatus: participant ? participant.status : null,
      pointsEarned: pointsByChallenge.get(challenge.id) ?? 0,
    };
  });
}

// ---- Points du membre ---------------------------------------------------------------------
export type MemberPoints = {
  monthPoints: number; yearPoints: number; totalPoints: number; challengesCompleted: number;
  rank: number | null; participantCount: number; level: string; nextLevel: string | null;
  nextLevelAt: number | null; levelProgressPct: number; monthlyStreak: number;
};

export async function getMemberPoints(memberId: string, leaderboard?: LeaderboardPublicRow[]): Promise<MemberPoints> {
  const rows = await supabaseRest<LedgerRow[]>(`points_ledger?select=challenge_id,points,reason,created_at&member_id=eq.${encodeURIComponent(memberId)}`);
  const year = new Date().getUTCFullYear();
  const monthRange = periodRange({ type: "month" });
  let totalPoints = 0;
  let yearPoints = 0;
  let monthPoints = 0;
  const netByChallenge = new Map<string, number>();
  for (const row of rows) {
    totalPoints += row.points;
    if (row.created_at.slice(0, 4) === String(year)) yearPoints += row.points;
    if (row.created_at >= monthRange.from && row.created_at < monthRange.to) monthPoints += row.points;
    if (row.challenge_id) netByChallenge.set(row.challenge_id, (netByChallenge.get(row.challenge_id) ?? 0) + (row.reason === "challenge_completion" ? 1 : row.reason === "challenge_reversal" ? -1 : 0));
  }
  const challengesCompleted = [...netByChallenge.values()].filter((net) => net > 0).length;
  const board = leaderboard ?? await getLeaderboard({ type: "month" });
  const rank = board.find((entry) => entry.memberId === memberId)?.rank ?? null;
  const level = deriveChallengeLevel(totalPoints);
  const monthlyChallenges = await supabaseRest<Array<{ id: string; challenge_type: string; starts_on: string | null; ends_on: string | null }>>(
    "challenges?select=id,challenge_type,starts_on,ends_on&challenge_type=eq.monthly_investment&limit=200",
  );
  const monthlyStreak = calculateMonthlyStreak(
    rows.map((row) => ({ challengeId: row.challenge_id, points: row.points })),
    monthlyChallenges.map((challenge) => ({ id: challenge.id, challengeType: challenge.challenge_type, startsOn: challenge.starts_on, endsOn: challenge.ends_on })),
  );
  return {
    monthPoints, totalPoints, yearPoints, challengesCompleted, rank, participantCount: board.length,
    level: level.level, nextLevel: level.nextLevel, nextLevelAt: level.nextLevelAt,
    levelProgressPct: level.levelProgressPct, monthlyStreak,
  };
}

export type ChallengeDashboardSummary = {
  available: boolean;
  current: CurrentForMember[];
  onboarding: OnboardingReconcileResult;
  points: MemberPoints;
  leaderboard: LeaderboardPublicRow[];
  leaderboardOptIn: boolean;
};

/** Une synthèse serveur pour le dashboard et sa pastille header : données cohérentes, une requête client. */
export async function getChallengeDashboardSummary(memberId: string, options: { reconcile?: boolean } = {}): Promise<ChallengeDashboardSummary> {
  // Réconcilier d'abord, puis calculer le classement : un point tout juste attribué doit être
  // visible dans le même résumé, sans requête client supplémentaire.
  const [current, onboarding, plans] = await Promise.all([
    getCurrentChallengesForMember(memberId, options),
    getOnboardingProgressForMember(memberId, options),
    supabaseRest<PlanRow[]>(`user_investment_plan?select=monthly_target,target_account_id,leaderboard_opt_in&member_id=eq.${encodeURIComponent(memberId)}&limit=1`),
  ]);
  const leaderboard = await getLeaderboard({ type: "month" });
  const points = await getMemberPoints(memberId, leaderboard);
  return {
    available: true,
    current,
    onboarding,
    points,
    leaderboard,
    leaderboardOptIn: plans[0]?.leaderboard_opt_in !== false,
  };
}

// ---- Classement (sans montants) -----------------------------------------------------------
export type LeaderboardPeriod = { type: "month" | "year"; year?: number; month?: number };
export type LeaderboardPublicRow = { rank: number; memberId: string; name: string; photoUrl: string | null; points: number; challengesCompleted: number; isCurrentMember?: boolean };

function periodRange(period: LeaderboardPeriod): { from: string; to: string } {
  // Bornes DATE-only (pas de ':' dans l'URL) : PostgreSQL caste la date en timestamp minuit, la
  // comparaison created_at >= 'YYYY-MM-01' et < 'mois suivant' est exacte pour un timestamptz.
  const now = new Date();
  const year = period.year ?? now.getUTCFullYear();
  const pad = (value: number) => String(value).padStart(2, "0");
  if (period.type === "year") return { from: `${year}-01-01`, to: `${year + 1}-01-01` };
  const month = period.month ?? now.getUTCMonth() + 1;
  const from = `${year}-${pad(month)}-01`;
  const to = month === 12 ? `${year + 1}-01-01` : `${year}-${pad(month + 1)}-01`;
  return { from, to };
}

/**
 * Classement familial calculé UNIQUEMENT depuis points_ledger. N'expose aucun montant privé
 * (objectif, montant investi, valeur, performance, compte). Respecte leaderboard_opt_in (un membre
 * opté-out n'apparaît pas). Les membres actifs opt-in restent visibles même avec zéro point.
 */
export async function getLeaderboard(period: LeaderboardPeriod): Promise<LeaderboardPublicRow[]> {
  const { from, to } = periodRange(period);
  const periodRows = await supabaseRest<Array<{ member_id: string; points: number; reason: string; created_at: string }>>(
    `points_ledger?select=member_id,points,reason,created_at&created_at=gte.${from}&created_at=lt.${to}`,
  );
  // Agrégats de la période par membre. Les zéros sont ajoutés plus bas pour tous les opt-in.
  const byMember = new Map<string, { points: number; lastPointsAt: string | null }>();
  for (const row of periodRows) {
    const current = byMember.get(row.member_id) ?? { points: 0, lastPointsAt: null };
    current.points += row.points;
    if (!current.lastPointsAt || row.created_at > current.lastPointsAt) current.lastPointsAt = row.created_at;
    byMember.set(row.member_id, current);
  }
  let memberRows: Array<{ id: string; name: string; photo_url?: string | null }>;
  try {
    memberRows = await supabaseRest<Array<{ id: string; name: string; photo_url: string | null }>>(
      "family_members?select=id,name,photo_url,is_active&is_active=eq.true&order=name.asc",
    );
  } catch {
    memberRows = await supabaseRest<Array<{ id: string; name: string; photo_url?: string | null }>>(
      "family_members?select=id,name,photo_url&order=name.asc",
    ).catch(() => supabaseRest<Array<{ id: string; name: string }>>("family_members?select=id,name&order=name.asc"));
  }
  const memberIds = memberRows.map((member) => member.id);
  if (memberIds.length === 0) return [];
  const ids = memberIds.map(encodeURIComponent).join(",");

  // Défis terminés (tous temps) + opt-in. Les données financières ne sont jamais lues ici.
  const [allLedger, plans, visibleMembers] = await Promise.all([
    supabaseRest<Array<{ member_id: string; challenge_id: string | null; reason: string }>>(`points_ledger?select=member_id,challenge_id,reason&member_id=in.(${ids})`),
    supabaseRest<Array<{ member_id: string; leaderboard_opt_in: boolean }>>(`user_investment_plan?select=member_id,leaderboard_opt_in&member_id=in.(${ids})`),
    Promise.resolve(memberRows),
  ]);

  const optIn = new Map(plans.map((plan) => [plan.member_id, plan.leaderboard_opt_in !== false]));
  const identity = new Map((visibleMembers as Array<{ id: string; name: string; photo_url?: string | null }>).map((member) => [member.id, { name: member.name, photoUrl: member.photo_url ?? null }]));
  const completedByMember = new Map<string, Map<string, number>>();
  for (const row of allLedger) {
    if (!row.challenge_id) continue;
    const perChallenge = completedByMember.get(row.member_id) ?? new Map<string, number>();
    perChallenge.set(row.challenge_id, (perChallenge.get(row.challenge_id) ?? 0) + (row.reason === "challenge_completion" ? 1 : row.reason === "challenge_reversal" ? -1 : 0));
    completedByMember.set(row.member_id, perChallenge);
  }

  // Construit les lignes puis délègue au moteur PUR buildLeaderboard : il exclut les opt-out et
  // ne produit que des champs publics (aucun montant/objectif/compte).
  const rows: LeaderboardBuildRow[] = [];
  for (const memberId of memberIds) {
    const ident = identity.get(memberId);
    if (!ident) continue;
    const agg = byMember.get(memberId) ?? { points: 0, lastPointsAt: null };
    const challengesCompleted = [...(completedByMember.get(memberId)?.values() ?? [])].filter((net) => net > 0).length;
    rows.push({ memberId, name: ident.name, photoUrl: ident.photoUrl, points: agg.points, defisCompleted: challengesCompleted, lastPointsAt: agg.lastPointsAt, optIn: optIn.get(memberId) !== false });
  }
  return buildLeaderboard(rows);
}

// ==========================================================================================
// ADMINISTRATION (« Défis & animation »). Toutes les mutations passent par des routes
// requireAdmin ; le rôle est vérifié côté serveur. L'admin peut voir les montants nécessaires au
// suivi familial — ces montants ne transitent JAMAIS par l'API publique du classement.
// ==========================================================================================
export type AdminChallengeRow = ChallengeRow & { participants: number; completed: number; completionRate: number; pointsAttributed: number };

export async function listChallengesForAdmin(): Promise<AdminChallengeRow[]> {
  const [challenges, participants, ledger] = await Promise.all([
    supabaseRest<ChallengeRow[]>(`challenges?select=${CHALLENGE_SELECT}${MONTHLY_TYPE_FILTER}&order=starts_on.desc.nullsfirst&limit=100`),
    supabaseRest<Array<{ challenge_id: string; status: ParticipantStatus }>>("challenge_participants?select=challenge_id,status"),
    supabaseRest<Array<{ challenge_id: string | null; points: number }>>("points_ledger?select=challenge_id,points"),
  ]);
  const stats = new Map<string, { participants: number; completed: number }>();
  for (const participant of participants) {
    const entry = stats.get(participant.challenge_id) ?? { participants: 0, completed: 0 };
    entry.participants += 1;
    if (participant.status === "completed") entry.completed += 1;
    stats.set(participant.challenge_id, entry);
  }
  const pointsByChallenge = new Map<string, number>();
  for (const row of ledger) if (row.challenge_id) pointsByChallenge.set(row.challenge_id, (pointsByChallenge.get(row.challenge_id) ?? 0) + row.points);
  return challenges.map((challenge) => {
    const entry = stats.get(challenge.id) ?? { participants: 0, completed: 0 };
    return {
      ...challenge,
      participants: entry.participants,
      completed: entry.completed,
      completionRate: entry.participants > 0 ? Math.round((entry.completed / entry.participants) * 100) : 0,
      pointsAttributed: pointsByChallenge.get(challenge.id) ?? 0,
    };
  });
}

export async function createChallenge(input: ChallengeInput & { status?: string }, createdBy: string | null): Promise<{ ok: true; challenge: ChallengeRow } | { ok: false; error: string }> {
  const validated = validateChallengeInput(input);
  if (!validated.ok) return validated;
  const value = validated.value;
  const status = input.status && (CHALLENGE_STATUSES as readonly string[]).includes(input.status) ? input.status : "draft";
  const rows = await supabaseRest<ChallengeRow[]>("challenges", {
    method: "POST",
    headers: { prefer: "return=representation" },
    body: JSON.stringify({
      title: value.title, description: value.description, challenge_type: value.challengeType, status,
      starts_on: value.startsOn, ends_on: value.endsOn, points_reward: value.pointsReward,
      eligible_account_types: value.eligibleAccountTypes, eligible_instrument_types: value.eligibleInstrumentTypes,
      availability_mode: value.availabilityMode, requires_challenge_id: value.requiresChallengeId,
      created_by: createdBy,
    }),
  });
  return { ok: true, challenge: rows[0] };
}

export async function updateChallenge(id: string, patch: ChallengeInput & { status?: string }): Promise<{ ok: true; challenge: ChallengeRow } | { ok: false; status: number; error: string }> {
  const current = await getChallengeById(id);
  if (!current) return { ok: false, status: 404, error: "Défi introuvable." };
  // Les 4 missions « Bien démarrer » sont préconfigurées et permanentes (migration 20260805) :
  // ni leur contenu ni leur statut ne se gèrent depuis l'admin « Défis & animation » (identifiant
  // stable, jamais de suppression accidentelle des points historiques qu'elles ont attribués).
  if (current.challenge_type !== "monthly_investment") {
    return { ok: false, status: 409, error: "Les missions « Bien démarrer » sont préconfigurées et permanentes : elles ne se modifient pas depuis cet écran." };
  }

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  const wantsContentEdit = ["title", "description", "startsOn", "endsOn", "pointsReward", "eligibleAccountTypes", "eligibleInstrumentTypes", "availabilityMode", "requiresChallengeId"].some((key) => key in patch);

  if (wantsContentEdit) {
    // Le contenu n'est modifiable qu'avant l'activation (brouillon / programmé).
    if (current.status !== "draft" && current.status !== "scheduled") {
      return { ok: false, status: 409, error: "Un défi actif, terminé ou archivé n'est plus modifiable (seul son statut peut changer)." };
    }
    const validated = validateChallengeInput({
      title: patch.title ?? current.title,
      description: patch.description ?? current.description,
      startsOn: patch.startsOn ?? current.starts_on,
      endsOn: patch.endsOn ?? current.ends_on,
      pointsReward: patch.pointsReward ?? current.points_reward,
      eligibleAccountTypes: patch.eligibleAccountTypes ?? current.eligible_account_types,
      eligibleInstrumentTypes: patch.eligibleInstrumentTypes ?? current.eligible_instrument_types,
      availabilityMode: patch.availabilityMode ?? current.availability_mode,
      requiresChallengeId: patch.requiresChallengeId ?? current.requires_challenge_id,
    });
    if (!validated.ok) return { ok: false, status: 400, error: validated.error };
    if (validated.value.requiresChallengeId === id) return { ok: false, status: 400, error: "Un défi ne peut pas dépendre de lui-même." };
    const value = validated.value;
    Object.assign(update, {
      title: value.title, description: value.description, starts_on: value.startsOn, ends_on: value.endsOn,
      points_reward: value.pointsReward, eligible_account_types: value.eligibleAccountTypes, eligible_instrument_types: value.eligibleInstrumentTypes,
      availability_mode: value.availabilityMode, requires_challenge_id: value.requiresChallengeId,
    });
  }

  if (patch.status && patch.status !== current.status) {
    if (!(CHALLENGE_STATUSES as readonly string[]).includes(patch.status)) return { ok: false, status: 400, error: "Statut invalide." };
    if (!canTransition(current.status as ChallengeStatus, patch.status as ChallengeStatus)) {
      return { ok: false, status: 409, error: `Transition ${current.status} vers ${patch.status} non autorisee.` };
    }
    update.status = patch.status;
  }

  const rows = await supabaseRest<ChallengeRow[]>(`challenges?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { prefer: "return=representation" },
    body: JSON.stringify(update),
  });
  return { ok: true, challenge: rows[0] ?? current };
}

// FK RESTRICT (points_ledger.challenge_id / challenge_participants.id) : un défi ayant déjà
// attribué des points ne peut PHYSIQUEMENT pas être supprimé (garanti par le schéma, pas par
// l'application). Détecte la violation Postgres 23503 pour un message clair côté admin.
function isPointsHistoryViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return message.includes("23503") || message.includes("foreign key constraint") || message.includes("points_ledger");
}

/**
 * Supprime définitivement un défi MENSUEL (jamais une mission « Bien démarrer », préconfigurée
 * et permanente). Un défi ayant déjà attribué des points est protégé par la contrainte FK
 * RESTRICT de points_ledger : la suppression échoue alors avec un message explicite plutôt
 * qu'une erreur brute — archivez-le pour conserver l'historique à la place. Un défi jamais actif
 * (brouillon/programmé) ou terminé sans le moindre point attribué se supprime sans risque
 * (challenge_participants / challenge_operation_links suivent en cascade).
 */
export async function deleteChallenge(id: string): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const current = await getChallengeById(id);
  if (!current) return { ok: false, status: 404, error: "Défi introuvable." };
  if (current.challenge_type !== "monthly_investment") {
    return { ok: false, status: 409, error: "Les missions « Bien démarrer » sont préconfigurées et permanentes : elles ne se suppriment pas depuis cet écran." };
  }
  try {
    await supabaseRest(`challenges?id=eq.${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { prefer: "return=minimal" },
    });
    return { ok: true };
  } catch (error) {
    if (isPointsHistoryViolation(error)) {
      return { ok: false, status: 409, error: "Ce défi a déjà attribué des points à un ou plusieurs membres : il ne peut pas être supprimé. Archivez-le pour conserver l'historique." };
    }
    throw error;
  }
}

export type AdminParticipantRow = {
  memberId: string; name: string; photoUrl: string | null; status: ParticipantStatus;
  pct: number; invested: number; targetAmount: number; pointsEarned: number; lastEligibleDate: string | null;
};

// Vue admin des participants d'un défi (avec montants, pour le suivi familial). Réconcilie chaque
// participation pour une progression fraîche. NE JAMAIS renvoyer ces montants via l'API publique.
export async function getParticipantsForChallengeAdmin(challengeId: string): Promise<AdminParticipantRow[]> {
  const challenge = await getChallengeById(challengeId);
  if (!challenge) return [];
  const participants = await supabaseRest<ParticipantRow[]>(`challenge_participants?select=${PARTICIPANT_SELECT}&challenge_id=eq.${encodeURIComponent(challengeId)}`);
  if (participants.length === 0) return [];
  const memberIds = participants.map((participant) => participant.member_id);
  const [members, ledger] = await Promise.all([
    supabaseRest<Array<{ id: string; name: string; photo_url: string | null }>>(`family_members?select=id,name,photo_url&id=in.(${memberIds.map(encodeURIComponent).join(",")})`).catch(() =>
      supabaseRest<Array<{ id: string; name: string }>>(`family_members?select=id,name&id=in.(${memberIds.map(encodeURIComponent).join(",")})`)),
    supabaseRest<Array<{ member_id: string; points: number }>>(`points_ledger?select=member_id,points&challenge_id=eq.${encodeURIComponent(challengeId)}`),
  ]);
  const identity = new Map((members as Array<{ id: string; name: string; photo_url?: string | null }>).map((member) => [member.id, { name: member.name, photoUrl: member.photo_url ?? null }]));
  const pointsByMember = new Map<string, number>();
  for (const row of ledger) pointsByMember.set(row.member_id, (pointsByMember.get(row.member_id) ?? 0) + row.points);

  const rows: AdminParticipantRow[] = [];
  for (const participant of participants) {
    const progress = await reconcileParticipant(participant, challenge);
    const ident = identity.get(participant.member_id);
    rows.push({
      memberId: participant.member_id,
      name: ident?.name ?? "Membre",
      photoUrl: ident?.photoUrl ?? null,
      status: progress.status,
      pct: progress.pct,
      invested: progress.invested,
      targetAmount: progress.targetAmount,
      pointsEarned: pointsByMember.get(participant.member_id) ?? 0,
      lastEligibleDate: progress.lastEligibleDate,
    });
  }
  return rows.sort((a, b) => b.pct - a.pct);
}

// ---- Administration : vue unifiée « qui a fait ce défi » + actions manuelles ---------------
// Contrairement à getParticipantsForChallengeAdmin (réservée aux défis mensuels REJOINTS), cette
// vue liste TOUS les membres actifs, qu'ils aient ou non rejoint/complété le défi — nécessaire
// pour les missions « Bien démarrer » qui n'ont jamais de ligne challenge_participants
// (participant_id NULL, cf. lib/onboarding-challenges-service.ts::applyOnboardingPoints).
export type AdminChallengeMemberRow = {
  memberId: string; name: string; photoUrl: string | null;
  status: "completed" | "in_progress" | "not_started";
  pointsEarned: number; completedAt: string | null;
  pct: number | null; invested: number | null; targetAmount: number | null; // monthly uniquement
  unlocked: boolean | null; // uniquement pour availability_mode='special' ; null = non pertinent
};

export async function getChallengeMembersAdmin(challengeId: string): Promise<AdminChallengeMemberRow[]> {
  const challenge = await getChallengeById(challengeId);
  if (!challenge) return [];
  const isMonthly = challenge.challenge_type === "monthly_investment";
  const isSpecial = challenge.availability_mode === "special";
  let members: Array<{ id: string; name: string; photo_url?: string | null }>;
  try {
    members = await supabaseRest<Array<{ id: string; name: string; photo_url: string | null }>>("family_members?select=id,name,photo_url&is_active=eq.true&order=name.asc");
  } catch {
    members = await supabaseRest<Array<{ id: string; name: string }>>("family_members?select=id,name&order=name.asc");
  }
  const ledger = await supabaseRest<Array<{ member_id: string; points: number; created_at: string }>>(
    `points_ledger?select=member_id,points,created_at&challenge_id=eq.${encodeURIComponent(challengeId)}&order=created_at.asc`,
  );
  const netByMember = new Map<string, { points: number; lastPositiveAt: string | null }>();
  for (const row of ledger) {
    const current = netByMember.get(row.member_id) ?? { points: 0, lastPositiveAt: null };
    current.points += num(row.points);
    if (row.points > 0) current.lastPositiveAt = row.created_at;
    netByMember.set(row.member_id, current);
  }
  let participantsByMember = new Map<string, ParticipantRow>();
  if (isMonthly) {
    const participants = await supabaseRest<ParticipantRow[]>(`challenge_participants?select=${PARTICIPANT_SELECT}&challenge_id=eq.${encodeURIComponent(challengeId)}`);
    participantsByMember = new Map(participants.map((row) => [row.member_id, row]));
  }
  let unlockedMembers = new Set<string>();
  if (isSpecial) {
    const unlocks = await supabaseRest<Array<{ member_id: string }>>(`challenge_unlocks?select=member_id&challenge_id=eq.${encodeURIComponent(challengeId)}`);
    unlockedMembers = new Set(unlocks.map((row) => row.member_id));
  }
  const rows: AdminChallengeMemberRow[] = [];
  for (const member of members) {
    const net = netByMember.get(member.id) ?? { points: 0, lastPositiveAt: null };
    const participant = participantsByMember.get(member.id);
    const status: AdminChallengeMemberRow["status"] = net.points > 0 ? "completed" : participant ? "in_progress" : "not_started";
    let pct: number | null = null;
    let invested: number | null = null;
    let targetAmount: number | null = null;
    if (isMonthly && participant) {
      const progress = await readParticipantProgress(participant);
      pct = progress.pct; invested = progress.invested; targetAmount = progress.targetAmount;
    }
    rows.push({
      memberId: member.id, name: member.name, photoUrl: member.photo_url ?? null, status,
      pointsEarned: net.points, completedAt: net.points > 0 ? net.lastPositiveAt : null, pct, invested, targetAmount,
      unlocked: isSpecial ? unlockedMembers.has(member.id) : null,
    });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name, "fr"));
}

/**
 * Débloque manuellement un défi 'special' pour UN membre (table challenge_unlocks). Donne
 * uniquement la VISIBILITÉ du défi — le membre doit ensuite le rejoindre lui-même comme tout
 * autre défi visible ; aucun point n'est attribué ici.
 */
export async function unlockChallengeForMember(challengeId: string, memberId: string, adminId: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  const challenge = await getChallengeById(challengeId);
  if (!challenge) return { ok: false, error: "Défi introuvable." };
  if (challenge.availability_mode !== "special") return { ok: false, error: "Seuls les défis en mode « spécial » se débloquent manuellement." };
  await supabaseRest("challenge_unlocks?on_conflict=challenge_id,member_id", {
    method: "POST",
    headers: { prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify({ challenge_id: challengeId, member_id: memberId, unlocked_by: adminId }),
  });
  return { ok: true };
}

/**
 * Fixe manuellement le solde de points d'UN membre pour UN défi à `targetPoints` (0 pour
 * « retirer », `challenge.points_reward` pour « valider », une valeur libre pour ajuster).
 *
 * points_ledger est un journal IMMUABLE (trigger points_ledger_no_update_delete, cf. migration
 * 20260804) : impossible de modifier ou supprimer une ligne existante, même en service-role. On
 * écrit donc une écriture de COMPENSATION dont le montant ramène le solde net exactement à
 * targetPoints — jamais une réécriture de l'historique. Réutilise la RPC transactionnelle
 * existante apply_challenge_points (verrou + insert idempotent + statut, une seule transaction).
 */
export async function adminSetChallengePoints(
  challengeId: string, memberId: string, targetPoints: number, adminId: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const challenge = await getChallengeById(challengeId);
  if (!challenge) return { ok: false, error: "Défi introuvable." };
  const ledger = await supabaseRest<LedgerRow[]>(`points_ledger?select=points&member_id=eq.${encodeURIComponent(memberId)}&challenge_id=eq.${encodeURIComponent(challengeId)}`);
  const currentNet = ledger.reduce((sum, row) => sum + num(row.points), 0);
  const delta = targetPoints - currentNet;
  if (delta === 0) return { ok: true };

  let participantId: string | null = null;
  if (challenge.challenge_type === "monthly_investment") {
    const existing = await getParticipant(challengeId, memberId);
    participantId = existing?.id ?? null;
  }
  const newStatus: ParticipantStatus = targetPoints > 0 ? "completed" : "in_progress";
  await applyChallengePoints({
    participantId, challengeId, memberId, points: delta, reason: "admin_adjustment",
    idempotencyKey: `admin_adjustment:${challengeId}:${memberId}:${crypto.randomUUID()}`,
    metadata: { adjustedBy: adminId, targetPoints, previousNet: currentNet },
    newStatus, completed: targetPoints > 0,
  });
  return { ok: true };
}
