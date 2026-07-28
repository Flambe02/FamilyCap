// Garde d'accès et assemblage du modèle, PARTAGÉS par les quatre routes de dividendes.
//
// Écrire la vérification d'autorisation quatre fois, c'est se donner quatre occasions de l'écrire
// différemment. Elle vit donc ici, une seule fois, et chaque route l'appelle avant tout accès aux
// données. La règle est la même que partout ailleurs dans le projet : `requireFamilyMember`
// identifie l'appelant, puis le périmètre est filtré EN CODE (les routes serveur utilisent la clé
// de service et contournent le RLS).

import { requireFamilyMember, viewableInvestmentScope, type AuthenticatedMember } from "./auth-server.ts";
import { supabaseRest } from "./supabase-rest.ts";
import {
  calendarYearWindow, computeDividendModel, next12mWindow,
  type DividendModel, type DividendWindow,
} from "./dividend-engine.ts";
import { loadDividendContext, type DividendContext } from "./dividend-server.ts";

export class DividendAccessError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "DividendAccessError";
    this.status = status;
  }
}

/** Nombre maximal de comptes agrégés en une requête (vue « Mes comptes-titres »). */
const MAX_ACCOUNTS = 10;

type AccountRow = { id: string; member_id: string; account_type: string };

/**
 * Comptes réellement lisibles par l'appelant, parmi ceux demandés.
 *
 * `accountId` (segment d'URL) est le compte de RÉFÉRENCE : c'est lui qui donne la devise
 * d'affichage et le profil fiscal. `?accountIds=` permet d'élargir à la vue agrégée, et chaque
 * identifiant supplémentaire est vérifié exactement comme le premier — un compte non partagé reste
 * invisible même s'il est explicitement demandé.
 */
export async function resolveDividendScope(
  request: Request,
  accountId: string,
): Promise<{ viewer: AuthenticatedMember; accountIds: string[] }> {
  const viewer = await requireFamilyMember(request);
  const reference = String(accountId ?? "").trim();
  if (!reference) throw new DividendAccessError(400, "Compte manquant.");

  const extra = new URL(request.url).searchParams.get("accountIds")?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
  const requested = [...new Set([reference, ...extra])].slice(0, MAX_ACCOUNTS);

  const accounts = await supabaseRest<AccountRow[]>(
    `financial_accounts?select=id,member_id,account_type&id=in.(${requested.map(encodeURIComponent).join(",")})`,
  ).catch(() => [] as AccountRow[]);
  if (accounts.length === 0) throw new DividendAccessError(404, "Compte introuvable.");

  const scope = await viewableInvestmentScope(viewer);
  const allowed = accounts.filter((account) => {
    if (account.account_type !== "pea" && account.account_type !== "securities") return false;
    if (scope === null) return true; // administrateur
    const flags = scope.get(account.member_id);
    return account.account_type === "pea" ? flags?.pea === true : flags?.cto === true;
  });
  if (!allowed.some((account) => account.id === reference)) {
    // Refus EXPLICITE : renvoyer une liste vide laisserait croire à un compte sans dividende.
    throw new DividendAccessError(403, "Ce compte ne vous est pas accessible.");
  }
  // Le compte de référence en tête : c'est lui qui fixe devise et fiscalité.
  const ids = [reference, ...allowed.map((account) => account.id).filter((id) => id !== reference)];
  return { viewer, accountIds: ids };
}

export function parseWindow(searchParams: URLSearchParams, today: string): DividendWindow {
  const raw = (searchParams.get("window") ?? "next12m").trim();
  if (raw === "next12m") return next12mWindow(today);
  if (raw === "current_year") return calendarYearWindow(Number(today.slice(0, 4)));
  if (raw === "previous_year") return calendarYearWindow(Number(today.slice(0, 4)) - 1);
  if (/^\d{4}$/.test(raw)) return calendarYearWindow(Number(raw));
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  if (from && to && /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to) {
    const months = Math.max(
      1,
      (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + (Number(to.slice(5, 7)) - Number(from.slice(5, 7))) + 1,
    );
    return { from, to, months, label: "Période personnalisée", kind: "custom" };
  }
  return next12mWindow(today);
}

export type DividendPayload = {
  account: { id: string; name: string; accountType: "PEA" | "CTO"; currency: string };
  accounts: Array<{ id: string; name: string }>;
  model: DividendModel;
  instruments: Array<{ assetId: string; name: string; isin: string | null; providerSymbol: string | null; resolutionStatus: string; distributionPolicy: string; lastSyncedAt: string | null }>;
  unresolved: Array<{ name: string; isin: string | null; ticker: string | null }>;
  lastSyncedAt: string | null;
  providers: Array<{ name: string; role: string; configured: boolean }>;
};

/** Charge le contexte puis applique LE moteur — le même pour le PEA et le compte-titres. */
export async function buildDividendPayload(
  accountIds: string[],
  searchParams: URLSearchParams,
  today = new Date().toISOString().slice(0, 10),
): Promise<{ context: DividendContext; payload: DividendPayload } | null> {
  const context = await loadDividendContext(accountIds, today);
  if (!context) return null;
  return { context, payload: payloadFromContext(context, searchParams, today) };
}

export function payloadFromContext(
  context: DividendContext,
  searchParams: URLSearchParams,
  today: string,
  providers: DividendPayload["providers"] = [],
): DividendPayload {
  const window = parseWindow(searchParams, today);
  const includeForecast = searchParams.get("includeForecast") !== "0";
  const model = computeDividendModel({
    operations: context.operations,
    positions: context.model.positions,
    events: context.events,
    instruments: context.instruments,
    accountType: context.accountType,
    today,
    referenceCurrency: context.referenceCurrency,
    fxRateAt: context.fxRateAt,
    taxProfile: context.taxProfile,
    window,
    includeForecast,
    positionsValueReference: context.model.positionsValueEur,
    investedReference: context.model.investedInAssetsEur,
  });
  const lastSyncedAt = context.events.reduce<string | null>((latest, event) => {
    if (!event.lastSyncedAt) return latest;
    return latest === null || event.lastSyncedAt > latest ? event.lastSyncedAt : latest;
  }, null);
  return {
    account: {
      id: context.primaryAccount.id,
      name: context.primaryAccount.name,
      accountType: context.accountType,
      currency: context.referenceCurrency,
    },
    accounts: context.accounts.map((account) => ({ id: account.id, name: account.name })),
    model,
    instruments: context.instruments.map((instrument) => ({
      assetId: instrument.assetId,
      name: instrument.name,
      isin: instrument.isin,
      providerSymbol: instrument.providerSymbol,
      resolutionStatus: instrument.resolutionStatus,
      distributionPolicy: instrument.distributionPolicy,
      lastSyncedAt: instrument.lastSyncedAt,
    })),
    unresolved: context.unresolvedPositions.map((position) => ({ name: position.name, isin: position.isin, ticker: position.ticker })),
    lastSyncedAt,
    providers,
  };
}

export function dividendErrorResponse(error: unknown): Response | null {
  if (error instanceof DividendAccessError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  return null;
}
