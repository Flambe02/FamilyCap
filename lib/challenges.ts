// Moteur des Défis — logique PURE (aucun accès réseau/DB), testable. L'orchestration serveur
// (lecture/écriture Supabase) vit dans lib/challenges-service.ts.
//
// PRINCIPES :
//  - La progression provient EXCLUSIVEMENT des achats réels (account_operations, type 'achat')
//    sur le compte cible, dans la période du défi. Jamais les ventes/versements/retraits/
//    dividendes/transferts/corrections, ni la valeur du portefeuille ou les plus-values.
//  - Le « montant déboursé » réutilise purchaseCashAmount (même formule que la Phase 1 /
//    buildOperationRecord) — aucune formule contradictoire.
//  - Équité : les points récompensent l'atteinte de SON PROPRE objectif figé, jamais le montant.
//  - Les clés d'idempotence rendent l'attribution et l'annulation des points sûres et rejouables.

import { purchaseCashAmount } from "./investment-plan.ts";

export const CHALLENGE_STATUSES = ["draft", "scheduled", "active", "completed", "archived"] as const;
export type ChallengeStatus = (typeof CHALLENGE_STATUSES)[number];

export const PARTICIPANT_STATUSES = ["in_progress", "completed", "paused", "ineligible"] as const;
export type ParticipantStatus = (typeof PARTICIPANT_STATUSES)[number];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// ---- Éligibilité d'un achat ---------------------------------------------------------------
export type ChallengeWindow = {
  startsOn: string; // YYYY-MM-DD (inclus)
  endsOn: string; // YYYY-MM-DD (inclus)
  eligibleInstrumentTypes: string[]; // ex. ['etf','stock'] (holdings.asset_type)
};

export type ParticipantScope = {
  memberId: string;
  targetAccountId: string | null;
};

export type CandidateOperation = {
  memberId?: string | null;
  accountId: string;
  type: string;
  date: string; // YYYY-MM-DD
  netAmount?: number | null;
  grossAmount?: number | null;
  quantity?: number | null;
  unitPrice?: number | null;
  assetType?: string | null; // résolu depuis holdings ; null si inconnu
};

export type EligibilityResult = { eligible: boolean; amount: number; reason?: string };

function withinPeriod(date: string, startsOn: string, endsOn: string): boolean {
  // Comparaison lexicographique valide pour des dates ISO (YYYY-MM-DD), bornes incluses.
  return ISO_DATE.test(date) && date >= startsOn && date <= endsOn;
}

/**
 * Un achat est éligible s'il : est de type 'achat' ; appartient au participant ; est passé sur
 * son compte cible ; tombe dans la période ; et son type d'instrument est DÉTERMINÉ et figure
 * parmi les instruments éligibles. Règle STRICTE : si le type d'instrument (etf/action…) ne peut
 * pas être identifié à partir du référentiel `holdings` de l'opération, l'achat est NON éligible
 * (`instrument_unknown`) — on ne devine jamais une classification. Le montant est le montant
 * réellement déboursé (net = brut + frais).
 */
export function isPurchaseEligible(op: CandidateOperation, participant: ParticipantScope, challenge: ChallengeWindow): EligibilityResult {
  if (op.type !== "achat") return { eligible: false, amount: 0, reason: "type" };
  if (!participant.targetAccountId) return { eligible: false, amount: 0, reason: "no_target_account" };
  if (op.accountId !== participant.targetAccountId) return { eligible: false, amount: 0, reason: "account" };
  if (op.memberId != null && op.memberId !== participant.memberId) return { eligible: false, amount: 0, reason: "member" };
  if (!withinPeriod(op.date, challenge.startsOn, challenge.endsOn)) return { eligible: false, amount: 0, reason: "period" };
  if (challenge.eligibleInstrumentTypes.length > 0) {
    const assetType = op.assetType ? op.assetType.toLowerCase().trim() : null;
    if (!assetType) return { eligible: false, amount: 0, reason: "instrument_unknown" };
    if (!challenge.eligibleInstrumentTypes.map((type) => type.toLowerCase()).includes(assetType)) return { eligible: false, amount: 0, reason: "instrument" };
  }
  const amount = round2(purchaseCashAmount(op));
  if (!(amount > 0)) return { eligible: false, amount: 0, reason: "amount" };
  return { eligible: true, amount };
}

// ---- Progression --------------------------------------------------------------------------
export type ChallengeProgress = {
  invested: number; // Σ des montants éligibles
  targetAmount: number;
  ratio: number; // invested / target (peut dépasser 1)
  pct: number; // plafonné à 100 pour l'affichage
  completed: boolean;
};

export function computeChallengeProgress(eligibleAmounts: number[], targetAmount: number): ChallengeProgress {
  const invested = round2(eligibleAmounts.reduce((sum, amount) => sum + (Number.isFinite(amount) ? amount : 0), 0));
  const ratio = targetAmount > 0 ? invested / targetAmount : 0;
  const pct = targetAmount > 0 ? Math.min(100, Math.round(ratio * 1000) / 10) : 0;
  const completed = targetAmount > 0 && invested + 1e-9 >= targetAmount;
  return { invested, targetAmount, ratio, pct, completed };
}

// ---- Décision d'attribution / annulation (pure) ------------------------------------------
// `version` = nombre d'annulations déjà écrites : deux réconciliations concurrentes calculent la
// MÊME clé (aucun double) ; une re-complétion après annulation obtient une clé distincte. « none »
// garantit au plus UNE compensation : une fois annulé (awarded = false), on ne ré-annule pas.
export type PointsAction = { action: "award" | "reverse" | "none"; version: number };

export function resolvePointsAction(params: { progressCompleted: boolean; completionCount: number; reversalCount: number }): PointsAction {
  const awarded = params.completionCount - params.reversalCount > 0;
  if (params.progressCompleted && !awarded) return { action: "award", version: params.reversalCount };
  if (!params.progressCompleted && awarded) return { action: "reverse", version: params.reversalCount };
  return { action: "none", version: params.reversalCount };
}

// ---- Clés d'idempotence des points --------------------------------------------------------
// `version` distingue les cycles complétion/annulation successifs d'un même (défi, membre) :
// première complétion v0, son annulation v0, re-complétion v1, etc. Cf. challenges-service.
export function completionKey(challengeId: string, memberId: string, version: number): string {
  return `challenge_completion:${challengeId}:${memberId}:v${version}`;
}
export function reversalKey(challengeId: string, memberId: string, version: number): string {
  return `challenge_reversal:${challengeId}:${memberId}:v${version}`;
}

// ---- Classement (ordre + rangs, sans montants) -------------------------------------------
export type LeaderboardEntry = {
  memberId: string;
  points: number;
  defisCompleted: number;
  lastPointsAt: string | null; // ISO ; départage régularité
};

// Départage : points décroissants ; puis défis terminés décroissants ; puis derniers points les
// plus TÔT (régularité) ; sinon ex æquo. JAMAIS le montant investi.
export function compareLeaderboard(a: LeaderboardEntry, b: LeaderboardEntry): number {
  if (b.points !== a.points) return b.points - a.points;
  if (b.defisCompleted !== a.defisCompleted) return b.defisCompleted - a.defisCompleted;
  const at = a.lastPointsAt ?? "";
  const bt = b.lastPointsAt ?? "";
  if (at !== bt) return at < bt ? -1 : 1;
  return 0;
}

export function rankLeaderboard<T extends LeaderboardEntry>(rows: T[]): (T & { rank: number })[] {
  const sorted = [...rows].sort(compareLeaderboard);
  const ranked: (T & { rank: number })[] = [];
  for (let index = 0; index < sorted.length; index += 1) {
    const rank = index > 0 && compareLeaderboard(sorted[index - 1], sorted[index]) === 0 ? ranked[index - 1].rank : index + 1;
    ranked.push({ ...sorted[index], rank });
  }
  return ranked;
}

// Construit les lignes PUBLIQUES du classement : exclut les membres opt-out (leaderboard_opt_in =
// false), classe, et ne renvoie QUE des champs publics (aucun montant/objectif/compte). Pur pour
// être testé sans base.
export type LeaderboardBuildRow = { memberId: string; name: string; photoUrl: string | null; points: number; defisCompleted: number; lastPointsAt: string | null; optIn: boolean };
export type LeaderboardPublicEntry = { rank: number; memberId: string; name: string; photoUrl: string | null; points: number; challengesCompleted: number };

export function buildLeaderboard(rows: LeaderboardBuildRow[]): LeaderboardPublicEntry[] {
  const included = rows.filter((row) => row.optIn !== false);
  const identity = new Map(included.map((row) => [row.memberId, row]));
  const ranked = rankLeaderboard(included.map((row) => ({ memberId: row.memberId, points: row.points, defisCompleted: row.defisCompleted, lastPointsAt: row.lastPointsAt })));
  return ranked.map((entry) => {
    const row = identity.get(entry.memberId);
    return { rank: entry.rank, memberId: entry.memberId, name: row?.name ?? "", photoUrl: row?.photoUrl ?? null, points: entry.points, challengesCompleted: entry.defisCompleted };
  });
}

// ---- Validation d'un défi (création / édition admin), PURE -------------------------------
export const ELIGIBLE_ACCOUNT_TYPES = ["pea", "securities"] as const;
export const ELIGIBLE_INSTRUMENT_TYPES = ["etf", "stock", "fund", "bond"] as const;

export type ChallengeInput = {
  title?: string; description?: string | null;
  startsOn?: string; endsOn?: string;
  pointsReward?: number | string | null;
  eligibleAccountTypes?: string[] | null;
  eligibleInstrumentTypes?: string[] | null;
  challengeType?: string;
};

export type ValidatedChallenge = {
  title: string; description: string | null; startsOn: string; endsOn: string; pointsReward: number;
  eligibleAccountTypes: string[]; eligibleInstrumentTypes: string[]; challengeType: "monthly_investment";
};

export function validateChallengeInput(input: ChallengeInput): { ok: true; value: ValidatedChallenge } | { ok: false; error: string } {
  const title = (input.title ?? "").trim();
  if (!title) return { ok: false, error: "Le titre est obligatoire." };
  if ((input.challengeType ?? "monthly_investment") !== "monthly_investment") return { ok: false, error: "Type de défi non supporté dans cette phase." };
  if (!input.startsOn || !ISO_DATE.test(input.startsOn)) return { ok: false, error: "La date de début (AAAA-MM-JJ) est obligatoire." };
  if (!input.endsOn || !ISO_DATE.test(input.endsOn)) return { ok: false, error: "La date de fin (AAAA-MM-JJ) est obligatoire." };
  if (input.endsOn < input.startsOn) return { ok: false, error: "La date de fin doit être postérieure ou égale à la date de début." };

  const points = Math.round(Number(input.pointsReward ?? 300));
  if (!Number.isInteger(points) || points < 1 || points > 1000) return { ok: false, error: "Les points doivent être un entier entre 1 et 1000." };

  const accountTypes = normalizeList(input.eligibleAccountTypes, ELIGIBLE_ACCOUNT_TYPES as readonly string[], ["pea", "securities"]);
  if (accountTypes.length === 0) return { ok: false, error: "Choisissez au moins un type de compte éligible." };
  const instrumentTypes = normalizeList(input.eligibleInstrumentTypes, ELIGIBLE_INSTRUMENT_TYPES as readonly string[], ["etf", "stock"]);
  if (instrumentTypes.length === 0) return { ok: false, error: "Choisissez au moins un type d'instrument éligible." };

  return {
    ok: true,
    value: { title, description: (input.description ?? "").trim() || null, startsOn: input.startsOn, endsOn: input.endsOn, pointsReward: points, eligibleAccountTypes: accountTypes, eligibleInstrumentTypes: instrumentTypes, challengeType: "monthly_investment" },
  };
}

function normalizeList(value: string[] | null | undefined, allowed: readonly string[], fallback: string[]): string[] {
  if (!Array.isArray(value) || value.length === 0) return [...fallback];
  return [...new Set(value.map((item) => String(item).toLowerCase().trim()).filter((item) => allowed.includes(item)))];
}

// ---- Transitions de statut (admin), PURE --------------------------------------------------
const STATUS_TRANSITIONS: Record<ChallengeStatus, ChallengeStatus[]> = {
  draft: ["scheduled", "active", "archived"],
  scheduled: ["active", "draft", "archived"],
  active: ["completed", "archived"],
  completed: ["archived"],
  archived: [],
};

export function canTransition(from: ChallengeStatus, to: ChallengeStatus): boolean {
  return from === to || (STATUS_TRANSITIONS[from]?.includes(to) ?? false);
}

// ---- État visuel côté membre --------------------------------------------------------------
export type MemberChallengeState = "no_plan" | "no_account" | "ready_to_join" | "in_progress" | "completed" | "challenge_ended";

export function memberChallengeState(params: {
  hasPlan: boolean;
  hasTargetAccount: boolean;
  isParticipant: boolean;
  participantStatus: ParticipantStatus | null;
  challengeStatus: ChallengeStatus;
}): MemberChallengeState {
  if (params.challengeStatus === "completed" || params.challengeStatus === "archived") return "challenge_ended";
  if (!params.hasPlan) return "no_plan";
  if (!params.hasTargetAccount) return "no_account";
  if (!params.isParticipant) return "ready_to_join";
  if (params.participantStatus === "completed") return "completed";
  return "in_progress";
}
