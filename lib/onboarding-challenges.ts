// Parcours permanent « Bien démarrer » — logique PURE (aucun accès réseau/DB), testable sans base.
// Distinct du défi mensuel (lib/challenges.ts) : 4 missions permanentes, réalisables une seule
// fois par membre, validées objectivement à partir de données réelles déjà modélisées ailleurs
// (financial_accounts, account_operations, user_investment_plan). Aucune donnée inventée : chaque
// condition ci-dessous se lit directement sur des colonnes existantes.
//
// PRINCIPES (miroir de lib/challenges.ts) :
//  - Les points ne sont JAMAIS retirés une fois attribués (contrairement au défi mensuel) : une
//    mission « Bien démarrer » récompense une étape accomplie, pas une condition continue.
//  - Les clés d'idempotence sont STABLES et SANS VERSION (pas de cycle attribution/annulation) :
//    onboarding_completion:<slug>:<memberId>, toujours la même, pour toujours.

import type { View } from "./navigation.ts";

export const ONBOARDING_CHALLENGE_TYPE = "onboarding_mission";

export const ONBOARDING_MISSION_SLUGS = [
  "onboarding_account_setup",
  "onboarding_existing_portfolio",
  "onboarding_monthly_plan",
  "onboarding_first_purchase",
] as const;
export type OnboardingMissionSlug = (typeof ONBOARDING_MISSION_SLUGS)[number];

export type OnboardingMissionDef = {
  slug: OnboardingMissionSlug;
  title: string;
  description: string;
  points: number; // valeur canonique de repli ; la source de vérité en fonctionnement normal reste challenges.points_reward
  cta: string;
  view: View; // écran existant vers lequel router le CTA (aucune nouvelle route)
  successMessage: string;
};

/**
 * Configuration lue dans `challenges`. Les définitions ci-dessous ne servent qu'à rendre
 * l'application lisible avant l'application de la migration : une fois la table à jour, le
 * contenu administrable vient de la base, jamais d'une seconde liste TypeScript.
 */
export type OnboardingMissionConfig = Partial<Pick<OnboardingMissionDef, "title" | "description" | "points" | "cta" | "successMessage">> & {
  active?: boolean;
  displayOrder?: number;
};

export const ONBOARDING_MISSIONS: readonly OnboardingMissionDef[] = [
  {
    slug: "onboarding_account_setup",
    title: "Configure ton PEA",
    description: "Ajoute ton PEA pour commencer à suivre tes investissements.",
    points: 300,
    cta: "Configurer mon PEA",
    view: "parametres",
    successMessage: "Ton PEA est configuré ! +300 points",
  },
  {
    slug: "onboarding_existing_portfolio",
    title: "Ajoute ton portefeuille",
    description: "Enregistre les placements que tu possèdes déjà pour obtenir une vue complète.",
    points: 200,
    cta: "Ajouter mes placements",
    view: "investissements-pea",
    successMessage: "Ton portefeuille prend forme ! +200 points",
  },
  {
    slug: "onboarding_monthly_plan",
    title: "Définis ton rythme",
    description: "Choisis le montant que tu souhaites investir chaque mois. Tu pourras le modifier à tout moment.",
    points: 100,
    cta: "Définir mon objectif",
    view: "parametres",
    successMessage: "Ton rythme mensuel est défini ! +100 points",
  },
  {
    slug: "onboarding_first_purchase",
    title: "Enregistre ton premier investissement",
    description: "Ajoute ton premier achat pour commencer à suivre réellement ta progression.",
    points: 250,
    cta: "Ajouter un achat",
    view: "investissements-pea",
    successMessage: "Premier investissement enregistré ! +250 points",
  },
] as const;

export const ONBOARDING_TOTAL_POINTS = ONBOARDING_MISSIONS.reduce((sum, mission) => sum + mission.points, 0);

// ---- Faits nécessaires à l'évaluation (déjà présents dans le modèle existant) -------------
export type OnboardingAccountFact = { id: string; accountType: string; isActive: boolean; name: string | null };
export type OnboardingPositionFact = { accountId: string; quantity: number };
export type OnboardingPlanFact = { monthlyTarget: number | null; targetAccountId: string | null };
export type OnboardingPurchaseFact = {
  accountId: string;
  type: string;
  quantity: number | null;
  unitPrice: number | null;
  assetName: string | null;
  ticker: string | null;
  isin: string | null;
  date: string | null;
};
export type OnboardingMemberFacts = {
  accounts: OnboardingAccountFact[]; // comptes PEA/compte-titres du membre (actifs ou non)
  positions: OnboardingPositionFact[]; // positions dérivées (quantity > 0) des comptes PEA/CTO du membre
  plan: OnboardingPlanFact | null;
  purchases: OnboardingPurchaseFact[]; // account_operations (tous types) des comptes PEA/CTO du membre
};

/** Mission 1 : un vrai PEA actif et nommé. Un CTO ou un projet d'ouverture ne le remplace pas. */
export function isOnboardingAccountReady(account: OnboardingAccountFact): boolean {
  return account.accountType === "pea" && account.isActive && Boolean(account.name && account.name.trim());
}

/** Mission 2 : au moins une position réelle détenue (achat, transfert entrant OU import de relevé — jamais une coquille vide). */
export function hasOnboardingPortfolio(positions: OnboardingPositionFact[]): boolean {
  return positions.some((position) => position.quantity > 1e-9);
}

/** Mission 2 : une opération confirmée sur le PEA. `account_operations` ne contient pas de brouillon :
 * les prévisualisations d'import restent côté client/assistant jusqu'au commit serveur. */
export function isOnboardingPortfolioOperationEligible(op: OnboardingPurchaseFact): boolean {
  if (!['achat', 'vente', 'correction'].includes(op.type)) return false;
  if (!op.date || !(op.assetName?.trim() || op.ticker?.trim() || op.isin?.trim())) return false;
  return Number(op.quantity) > 0 || Number(op.unitPrice) > 0;
}

export function hasOnboardingPortfolioOperation(operations: OnboardingPurchaseFact[], peaAccountIds: Set<string>): boolean {
  return operations.some((op) => peaAccountIds.has(op.accountId) && isOnboardingPortfolioOperationEligible(op));
}

/** Mission 3 : plan enregistré, montant strictement positif, rattaché à un compte PEA/CTO utilisable du membre. */
export function hasOnboardingPlan(plan: OnboardingPlanFact | null, accounts: OnboardingAccountFact[]): boolean {
  if (!plan) return false;
  if (!(Number(plan.monthlyTarget) > 0)) return false;
  if (!plan.targetAccountId) return false;
  const account = accounts.find((candidate) => candidate.id === plan.targetAccountId);
  return Boolean(account && isOnboardingAccountReady(account));
}

/**
 * Mission 4 : UN VRAI achat — type 'achat' strictement (exclut correction/versement/retrait/
 * dividende/frais/transferts), quantité et prix unitaire positifs (déjà garantis à l'écriture par
 * validateOperation, revérifiés ici par défense en profondeur), date et instrument renseignés.
 * Une position initiale importée via un relevé (type 'correction') n'est JAMAIS éligible ici.
 */
export function isOnboardingPurchaseEligible(op: OnboardingPurchaseFact): boolean {
  if (op.type !== "achat") return false;
  if (!(Number(op.quantity) > 0) || !(Number(op.unitPrice) > 0)) return false;
  if (!op.date) return false;
  if (!(op.assetName?.trim() || op.ticker?.trim() || op.isin?.trim())) return false;
  return true;
}

export function hasOnboardingFirstPurchase(purchases: OnboardingPurchaseFact[]): boolean {
  return purchases.some(isOnboardingPurchaseEligible);
}

export type OnboardingMissionResults = Record<OnboardingMissionSlug, boolean>;

/** Évalue les 4 missions à partir des faits du membre. Idempotent, sans effet de bord. */
export function evaluateOnboardingMissions(facts: OnboardingMemberFacts): OnboardingMissionResults {
  const peaAccounts = facts.accounts.filter((account) => account.accountType === "pea");
  const peaAccountIds = new Set(peaAccounts.map((account) => account.id));
  return {
    onboarding_account_setup: peaAccounts.some(isOnboardingAccountReady),
    onboarding_existing_portfolio: hasOnboardingPortfolioOperation(facts.purchases, peaAccountIds),
    onboarding_monthly_plan: hasOnboardingPlan(facts.plan, facts.accounts),
    onboarding_first_purchase: facts.purchases.some((op) => peaAccountIds.has(op.accountId) && isOnboardingPurchaseEligible(op)),
  };
}

// ---- Idempotence des points : clé STABLE, sans version (jamais annulée) ------------------
export function onboardingCompletionKey(slug: string, memberId: string): string {
  return `onboarding_completion:${slug}:${memberId}`;
}

// ---- Vue prête pour l'écran (progression globale + statut par mission) -------------------
export type OnboardingMissionStatus = "todo" | "done";
export type OnboardingMissionView = {
  slug: OnboardingMissionSlug;
  title: string;
  description: string;
  points: number;
  cta: string;
  view: View;
  status: OnboardingMissionStatus;
  successMessage: string;
};
export type OnboardingProgress = {
  missions: OnboardingMissionView[];
  completedCount: number;
  totalCount: number;
  earnedPoints: number;
  totalPoints: number;
};

/**
 * Construit la vue de progression. `pointsBySlug` (facultatif) permet de refléter le
 * points_reward RÉEL stocké en base (source de vérité) ; en son absence (migration non encore
 * lue), on retombe sur les valeurs canoniques de ONBOARDING_MISSIONS — jamais une valeur inventée.
 */
export function buildOnboardingProgress(
  results: OnboardingMissionResults,
  configs?: Partial<Record<OnboardingMissionSlug, OnboardingMissionConfig>>,
): OnboardingProgress {
  const missions = ONBOARDING_MISSIONS
    .filter((def) => configs?.[def.slug]?.active !== false)
    .map((def) => {
      const config = configs?.[def.slug];
      return {
    slug: def.slug,
    title: config?.title ?? def.title,
    description: config?.description ?? def.description,
    points: config?.points ?? def.points,
    cta: config?.cta ?? def.cta,
    view: def.view,
    status: (results[def.slug] ? "done" : "todo") as OnboardingMissionStatus,
    successMessage: config?.successMessage ?? def.successMessage,
    displayOrder: config?.displayOrder ?? Number.MAX_SAFE_INTEGER,
  };
    })
    .sort((a, b) => a.displayOrder - b.displayOrder)
    .map((mission) => ({
      slug: mission.slug,
      title: mission.title,
      description: mission.description,
      points: mission.points,
      cta: mission.cta,
      view: mission.view,
      status: mission.status,
      successMessage: mission.successMessage,
    }));
  const done = missions.filter((mission) => mission.status === "done");
  return {
    missions,
    completedCount: done.length,
    totalCount: missions.length,
    earnedPoints: done.reduce((sum, mission) => sum + mission.points, 0),
    totalPoints: missions.reduce((sum, mission) => sum + mission.points, 0),
  };
}
