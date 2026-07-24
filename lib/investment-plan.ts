// Plan d'investissement du membre + progression mensuelle — logique PURE (aucun accès réseau),
// partagée par la route /api/investment-plan, la route self-service /api/investment-operations et
// l'écran « Mon rythme d'investissement ». Séparée de la couche réseau pour être testable.
//
// PRINCIPES :
//  - user_investment_plan.monthly_target = ENGAGEMENT personnel du membre (distinct de
//    financial_accounts.monthly_target, qui est une info administrative du compte).
//  - La progression mensuelle est dérivée des ACHATS RÉELS (account_operations, type 'achat'),
//    jamais des versements, ni de la valeur du portefeuille, ni de holdings.quantity.
//  - Aucune donnée inventée : un montant non exploitable renvoie une erreur explicite.

export const INSTRUMENT_PREFERENCES = ["etf", "stocks", "both"] as const;
export type InstrumentPreference = (typeof INSTRUMENT_PREFERENCES)[number];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// ---- Plan : validation & normalisation ---------------------------------------------------
export type InvestmentPlanInput = {
  monthlyTarget?: number | string | null;
  targetAccountId?: string | null;
  targetDay?: number | string | null;
  instrumentPreference?: string | null;
  remindersEnabled?: boolean | null;
  leaderboardOptIn?: boolean | null;
  effectiveFrom?: string | null;
};

export type InvestmentPlan = {
  monthlyTarget: number;
  targetAccountId: string | null;
  targetDay: number | null;
  instrumentPreference: InstrumentPreference;
  remindersEnabled: boolean;
  leaderboardOptIn: boolean;
  effectiveFrom: string; // YYYY-MM-DD (1er du mois par défaut)
};

/** 1er jour du mois de `today` (YYYY-MM-01). */
export function firstOfMonth(today: string): string {
  return `${today.slice(0, 7)}-01`;
}

function optionalBoolean(value: boolean | null | undefined, fallback: boolean): boolean {
  return value === undefined || value === null ? fallback : Boolean(value);
}

export function validateInvestmentPlanInput(
  input: InvestmentPlanInput,
  today: string,
): { ok: true; plan: InvestmentPlan } | { ok: false; error: string } {
  const target = Number(input.monthlyTarget);
  if (input.monthlyTarget === undefined || input.monthlyTarget === null || input.monthlyTarget === "" || !Number.isFinite(target) || target < 0) {
    return { ok: false, error: "Indique un montant mensuel valide (0 € ou plus)." };
  }
  const monthlyTarget = Math.round(target * 100) / 100;

  let targetDay: number | null = null;
  if (input.targetDay !== undefined && input.targetDay !== null && String(input.targetDay).trim() !== "") {
    const day = Number(input.targetDay);
    if (!Number.isInteger(day) || day < 1 || day > 28) {
      return { ok: false, error: "Le jour cible doit être compris entre 1 et 28." };
    }
    targetDay = day;
  }

  const pref = (input.instrumentPreference ?? "etf") as InstrumentPreference;
  if (!INSTRUMENT_PREFERENCES.includes(pref)) {
    return { ok: false, error: "Préférence d'instrument invalide." };
  }

  const effectiveFrom = input.effectiveFrom && ISO_DATE.test(input.effectiveFrom) ? input.effectiveFrom : firstOfMonth(today);

  return {
    ok: true,
    plan: {
      monthlyTarget,
      targetAccountId: input.targetAccountId && input.targetAccountId.trim() ? input.targetAccountId.trim() : null,
      targetDay,
      instrumentPreference: pref,
      remindersEnabled: optionalBoolean(input.remindersEnabled, true),
      leaderboardOptIn: optionalBoolean(input.leaderboardOptIn, true),
      effectiveFrom,
    },
  };
}

// ---- Achat self-service : autorisation (pure) --------------------------------------------
// La saisie manuelle admin (/api/pea/operations) n'est JAMAIS affaiblie : cette autorisation
// concerne uniquement la route membre /api/investment-operations. Un membre ne peut enregistrer
// qu'un ACHAT, sur un PEA/compte-titres ACTIF lui appartenant.
export type MemberOperationAccount = { memberId: string; accountType: string; isActive: boolean };

export function authorizeMemberOperation(params: {
  account: MemberOperationAccount | null;
  viewerId: string;
  type: string | undefined;
}): { ok: true } | { ok: false; status: number; error: string } {
  const { account, viewerId, type } = params;
  if ((type ?? "achat") !== "achat") {
    return { ok: false, status: 400, error: "Pour l'instant, seuls les achats peuvent être enregistrés en libre-service." };
  }
  if (!account) return { ok: false, status: 404, error: "Compte introuvable." };
  if (account.memberId !== viewerId) {
    return { ok: false, status: 403, error: "Vous ne pouvez enregistrer une opération que sur votre propre compte." };
  }
  if (account.accountType !== "pea" && account.accountType !== "securities") {
    return { ok: false, status: 400, error: "Seuls un PEA ou un compte-titres acceptent un achat en libre-service." };
  }
  if (!account.isActive) {
    return { ok: false, status: 409, error: "Ce compte est archivé : demandez à l'administrateur de le réactiver." };
  }
  return { ok: true };
}

// ---- Progression mensuelle (dérivée des achats réels) ------------------------------------
export type MonthlyProgressStatus = "a_commencer" | "en_cours" | "atteint";

export type MonthlyPlanProgress = {
  investedThisMonth: number; // Σ des montants d'achats du mois civil (sur les comptes ciblés)
  monthlyTarget: number | null;
  pct: number | null; // plafonné à 100 ; null si aucun objectif exploitable
  daysRemaining: number; // jours restants avant la fin du mois civil
  status: MonthlyProgressStatus | null;
};

type ProgressOperation = {
  type: string;
  date: string;
  accountId: string;
  netAmount?: number | null;
  grossAmount?: number | null;
  quantity?: number | null;
  unitPrice?: number | null;
};

// Montant d'un achat : net_amount en priorité (coût de trésorerie réel = brut + frais), puis
// repli brut, puis quantité × prix. Jamais une valeur inventée. Exporté pour être RÉUTILISÉ par
// le moteur des Défis (lib/challenges.ts) — une seule formule de « montant déboursé », cohérente
// avec buildOperationRecord/computeAccountModel.
export function purchaseCashAmount(op: { netAmount?: number | null; grossAmount?: number | null; quantity?: number | null; unitPrice?: number | null }): number {
  if (op.netAmount !== null && op.netAmount !== undefined && Number.isFinite(Number(op.netAmount))) return Math.abs(Number(op.netAmount));
  if (op.grossAmount !== null && op.grossAmount !== undefined && Number.isFinite(Number(op.grossAmount))) return Math.abs(Number(op.grossAmount));
  const quantity = Number(op.quantity);
  const unitPrice = Number(op.unitPrice);
  return Number.isFinite(quantity) && Number.isFinite(unitPrice) ? Math.abs(quantity * unitPrice) : 0;
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate(); // month = 1..12 → dernier jour du mois
}

/**
 * Progression de l'objectif mensuel : somme des net_amount des opérations de type 'achat' du
 * mois civil de `today`, restreinte à `accountIds` (le compte cible du plan, ou le périmètre
 * affiché). N'utilise NI la valeur du portefeuille, NI la performance, NI holdings.quantity,
 * NI les versements — uniquement les achats réels.
 */
export function computeMonthlyPlanProgress(params: {
  operations: ProgressOperation[];
  accountIds?: string[] | null;
  monthlyTarget: number | null;
  today?: string;
}): MonthlyPlanProgress {
  const today = params.today ?? new Date().toISOString().slice(0, 10);
  const monthKey = today.slice(0, 7);
  const idSet = params.accountIds && params.accountIds.length ? new Set(params.accountIds) : null;

  const invested = params.operations
    .filter((op) => op.type === "achat" && typeof op.date === "string" && op.date.slice(0, 7) === monthKey && (idSet ? idSet.has(op.accountId) : true))
    .reduce((sum, op) => sum + purchaseCashAmount(op), 0);
  const investedThisMonth = Math.round(invested * 100) / 100;

  const target = params.monthlyTarget !== null && params.monthlyTarget !== undefined && Number.isFinite(params.monthlyTarget) && params.monthlyTarget > 0
    ? params.monthlyTarget
    : null;
  const pct = target ? Math.min(100, Math.round((investedThisMonth / target) * 1000) / 10) : null;

  const [year, month, day] = today.split("-").map(Number);
  const daysRemaining = Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)
    ? Math.max(0, daysInMonth(year, month) - day)
    : 0;

  let status: MonthlyProgressStatus | null = null;
  if (target !== null) {
    status = investedThisMonth <= 0 ? "a_commencer" : investedThisMonth + 1e-9 >= target ? "atteint" : "en_cours";
  }

  return { investedThisMonth, monthlyTarget: target, pct, daysRemaining, status };
}
