"use client";

import { supabaseBrowser } from "../supabase-browser";
import { defaultOnboardingState, type OnboardingState } from "./onboarding-types";

// Client réseau de l'onboarding. Deux responsabilités :
//  1. persister l'état côté serveur (/api/onboarding) — source de vérité multi-appareils ;
//  2. maintenir un miroir localStorage de secours, pour ne jamais « piéger » l'utilisateur ni
//     réafficher le tunnel si le serveur/migration est indisponible (report & reprise locaux).
// Aucune donnée d'investissement n'est écrite ici hors du choix explicite de confidentialité,
// délégué au serveur (mapping vers investment_access_scope, member_id forcé sur l'appelant).

const MIRROR_PREFIX = "labajo-onboarding-v1:";
// Ancienne clé de la modale localStorage : un membre l'ayant « done » ne doit pas être re-tunnelé.
const LEGACY_KEY_PREFIX = "cap-family-onboarding-v1:";

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabaseBrowser.auth.getSession();
  return { authorization: "Bearer " + (data.session?.access_token ?? ""), "content-type": "application/json" };
}

function mirrorKey(memberId: string) {
  return MIRROR_PREFIX + memberId;
}

export function readMirror(memberId: string): OnboardingState {
  if (typeof window === "undefined") return defaultOnboardingState();
  try {
    const raw = window.localStorage.getItem(mirrorKey(memberId));
    if (raw) return { ...defaultOnboardingState(), ...(JSON.parse(raw) as Partial<OnboardingState>) };
    // Rétro-compatibilité : ancienne modale marquée « done » = parcours terminé.
    if (window.localStorage.getItem(LEGACY_KEY_PREFIX + memberId) === "done") {
      return { ...defaultOnboardingState(), status: "completed", completedSteps: ["welcome", "profile", "modules", "privacy"] };
    }
  } catch {
    // localStorage inaccessible (mode privé, quota) → état par défaut.
  }
  return defaultOnboardingState();
}

export function writeMirror(memberId: string, state: OnboardingState) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(mirrorKey(memberId), JSON.stringify(state));
  } catch {
    // Échec silencieux : le miroir n'est qu'un secours.
  }
}

export function clearTipsFor(memberId: string) {
  if (typeof window === "undefined") return;
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith(`labajo-tip:`) && key.endsWith(`:${memberId}`)) toRemove.push(key);
    }
    toRemove.forEach((key) => window.localStorage.removeItem(key));
  } catch {
    // ignore
  }
}

export type LoadResult = { state: OnboardingState; available: boolean };

// Charge l'état : serveur prioritaire, repli sur le miroir local si indisponible.
export async function loadOnboardingState(memberId: string): Promise<LoadResult> {
  try {
    const response = await fetch("/api/onboarding", { headers: await authHeaders() });
    const result = await response.json() as { state?: OnboardingState; available?: boolean; error?: string };
    if (response.ok && result.state) {
      // Si le serveur ne persiste pas encore (table absente), on préfère le miroir local
      // s'il indique un parcours plus avancé, pour respecter un report/achèvement déjà fait.
      if (result.available === false) {
        const mirror = readMirror(memberId);
        if (mirror.status !== "not_started") return { state: mirror, available: false };
      }
      return { state: result.state, available: result.available !== false };
    }
  } catch {
    // réseau indisponible → miroir local
  }
  return { state: readMirror(memberId), available: false };
}

export type OnboardingSavePatch = {
  status?: OnboardingState["status"];
  currentStep?: OnboardingState["currentStep"];
  completedStep?: OnboardingState["currentStep"];
  selectedModules?: OnboardingState["selectedModules"];
  privacyChoice?: OnboardingState["privacyChoice"];
  adminCanEdit?: boolean;
};

// Persiste un changement d'état (serveur + miroir). Ne jette jamais : en cas d'échec serveur,
// le miroir local garantit la continuité (reprise après rechargement, report).
export async function saveOnboardingState(memberId: string, current: OnboardingState, patch: OnboardingSavePatch): Promise<OnboardingState> {
  const next: OnboardingState = { ...current };
  if (patch.status) next.status = patch.status;
  if (patch.currentStep !== undefined) next.currentStep = patch.currentStep;
  if (patch.completedStep && !next.completedSteps.includes(patch.completedStep)) next.completedSteps = [...next.completedSteps, patch.completedStep];
  if (patch.selectedModules) next.selectedModules = patch.selectedModules;
  if (patch.privacyChoice !== undefined) next.privacyChoice = patch.privacyChoice;
  if (patch.adminCanEdit !== undefined) next.adminCanEdit = patch.adminCanEdit;
  if (!next.startedAt && next.status !== "not_started") next.startedAt = new Date().toISOString();
  if (patch.status === "completed") next.completedAt = new Date().toISOString();
  if (patch.status === "deferred") next.deferredAt = new Date().toISOString();
  next.updatedAt = new Date().toISOString();

  writeMirror(memberId, next);
  try {
    await fetch("/api/onboarding", { method: "PATCH", headers: await authHeaders(), body: JSON.stringify(patch) });
  } catch {
    // Le miroir local a déjà été écrit ; on n'interrompt pas le parcours.
  }
  return next;
}

// ---- Contexte réel (données existantes) pour les badges de modules et l'écran de fin ----

export type OnboardingContext = {
  giftCount: number;
  earliestGiftYear: number | null;
  btcAttributed: number;
  hasPersonalBitcoin: boolean;
  hasPea: boolean;
  hasCto: boolean;
  adminName: string;
  currentScope: "family" | "selected" | null;
};

const EMPTY_CONTEXT: OnboardingContext = {
  giftCount: 0,
  earliestGiftYear: null,
  btcAttributed: 0,
  hasPersonalBitcoin: false,
  hasPea: false,
  hasCto: false,
  adminName: "l’administrateur",
  currentScope: null,
};

type GiftRecord = { gift_date?: string; btc_amount?: number; ledger_amount?: number | null; custody?: string; source?: string | null };
type PortfolioAccount = { accountType?: string };
type AccessMember = { name: string; role: string };

export async function loadOnboardingContext(): Promise<OnboardingContext> {
  const headers = await authHeaders();
  const [gifts, portfolio, access] = await Promise.allSettled([
    fetch("/api/gifts", { headers }).then((r) => (r.ok ? r.json() : { records: [] })),
    fetch("/api/portfolio", { headers }).then((r) => (r.ok ? r.json() : { accounts: [] })),
    fetch("/api/investment-access", { headers }).then((r) => (r.ok ? r.json() : {})),
  ]);

  const context: OnboardingContext = { ...EMPTY_CONTEXT };

  if (gifts.status === "fulfilled") {
    const records: GiftRecord[] = Array.isArray(gifts.value?.records) ? gifts.value.records : [];
    context.giftCount = records.length;
    for (const record of records) {
      const owned = record.custody === "Ledger" && Number(record.ledger_amount) > 0 ? Number(record.ledger_amount) : Number(record.btc_amount);
      if (Number.isFinite(owned) && owned > 0) context.btcAttributed += owned;
      if (record.source === "investissement_personnel") context.hasPersonalBitcoin = true;
      const year = Number(record.gift_date?.slice(0, 4));
      if (Number.isFinite(year) && year > 0) context.earliestGiftYear = context.earliestGiftYear === null ? year : Math.min(context.earliestGiftYear, year);
    }
  }

  if (portfolio.status === "fulfilled") {
    const accounts: PortfolioAccount[] = Array.isArray(portfolio.value?.accounts) ? portfolio.value.accounts : [];
    context.hasPea = accounts.some((account) => account.accountType === "pea");
    context.hasCto = accounts.some((account) => account.accountType === "securities");
  }

  if (access.status === "fulfilled" && access.value) {
    const accessValue = access.value as { members?: AccessMember[]; scope?: "family" | "selected" };
    const members: AccessMember[] = Array.isArray(accessValue.members) ? accessValue.members : [];
    const admin = members.find((member) => member.role === "admin");
    if (admin?.name) context.adminName = admin.name;
    if (accessValue.scope === "family" || accessValue.scope === "selected") context.currentScope = accessValue.scope;
  }

  return context;
}

// ---- Profil en libre-service (prénom, anniversaire, langue, devise) ----

export type ProfileData = {
  firstName: string;
  lastName: string;
  birthdayDay: number | null;
  birthdayMonth: number | null;
  birthdayYear: number | null;
  language: string;
  displayCurrency: string;
};

export async function loadProfile(): Promise<ProfileData | null> {
  try {
    const response = await fetch("/api/profile", { headers: await authHeaders() });
    if (!response.ok) return null;
    const result = await response.json() as { profile?: ProfileData };
    return result.profile ?? null;
  } catch {
    return null;
  }
}

export async function saveProfile(patch: Partial<ProfileData>): Promise<void> {
  const response = await fetch("/api/profile", { method: "PATCH", headers: await authHeaders(), body: JSON.stringify(patch) });
  const result = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(result.error ?? "Enregistrement du profil impossible.");
}
