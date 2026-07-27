import { authErrorResponse, requireFamilyMember, viewableInvestmentScope, type MemberShareFlags } from "../../../lib/auth-server";
import { supabaseRest } from "../../../lib/supabase-rest";
import { loadPortfolioFxRates } from "../../../lib/fx-rates-server";
import { getLatestFxRate, type FxRateRow } from "../../../lib/fx-rates";

// Un compte est-il visible pour le viewer, compte tenu des classes que son propriétaire
// partage ? PEA → flag PEA, compte-titres → flag CTO, wallet Bitcoin → flag BTC. Autres types
// (banque, épargne…) : réservés au propriétaire/admin (seul soi a les 3 flags ouverts).
function accountVisible(accountType: string, flags: MemberShareFlags): boolean {
  if (accountType === "securities") return flags.cto;
  if (accountType === "pea") return flags.pea;
  if (accountType === "bitcoin") return flags.btc;
  return flags.btc && flags.pea && flags.cto;
}

// Lecture des comptes financiers (PEA, compte-titres…), de leurs positions (référentiel de
// cours) et de leurs opérations, pour le tableau de bord « vue utilisateur », l'écran PEA et
// l'écran Paramètres › Mes comptes.
//
// Frontière de sécurité (comme toutes les routes) : `requireFamilyMember` identifie l'appelant
// côté serveur, puis le filtre est appliqué EN CODE. Le périmètre lisible respecte le partage
// familial (`viewableMemberIds`) : un membre voit ses propres comptes ET ceux réellement
// partagés avec lui (scope « famille » ou autorisation explicite) ; seul l'admin voit toute la
// famille. La clé service-role reste strictement serveur et ne fuit jamais au client.

type AccountRow = {
  id: string; name: string; institution: string | null; account_type: string; currency: string; member_id: string;
  account_number_last4?: string | null; iban_last4?: string | null; opened_at?: string | null;
  monthly_target?: number | null; opening_balance?: number | null; notes?: string | null;
};

// Colonnes de base (toujours présentes) + colonnes de contexte ajoutées par les migrations
// 20260725 (opened_at / monthly_target) et 20260730 (opening_balance). On tente la sélection
// riche ; si une colonne manque (migration pas encore jouée), on retombe sur la base sans erreur.
const ACCOUNT_SELECT_BASE = "id,name,institution,account_type,currency,member_id";
const ACCOUNT_SELECT_FULL = `${ACCOUNT_SELECT_BASE},account_number_last4,iban_last4,opened_at,monthly_target,opening_balance,notes`;

async function fetchAccounts(filter: string): Promise<AccountRow[]> {
  try {
    return await supabaseRest<AccountRow[]>(`financial_accounts?select=${ACCOUNT_SELECT_FULL}&is_active=eq.true${filter}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/opening_balance|opened_at|monthly_target|account_number_last4|iban_last4|42703|PGRST20[0-9]/.test(message)) {
      return await supabaseRest<AccountRow[]>(`financial_accounts?select=${ACCOUNT_SELECT_BASE}&is_active=eq.true${filter}`);
    }
    throw error;
  }
}
type HoldingRow = { id: string; account_id: string; asset_type: string | null; name: string | null; symbol: string | null; isin: string | null; quantity: number; average_cost: number | null; last_price: number | null; last_price_at: string | null; currency: string; exchange?: string | null; provider_symbol?: string | null; yahoo_symbol?: string | null; market_symbol?: string | null; mic_code?: string | null; data_provider?: string | null; quote_mode?: string | null; country?: string | null };
type QuoteRow = { asset_id: string; provider: string; provider_symbol: string; price: number; currency: string; quoted_at: string; market_status: string; data_delay_minutes: number | null; fetched_at: string };
type MemberRow = { id: string; name: string };
type OperationRow = {
  id: string; account_id: string; member_id: string; type: string; operation_date: string;
  asset_name: string | null; ticker: string | null; isin: string | null; quantity: number | null;
  unit_price: number | null; gross_amount: number | null; fees: number | null; net_amount: number | null;
  currency: string; source: string | null; note: string | null; exchange_rate?: number | null; taxes?: number | null;
};

function isMissingTable(message: string) {
  return message.includes("financial_accounts") || message.includes("holdings") || message.includes("PGRST205") || message.includes("PGRST200");
}

function isValidTimestamp(value: string | null | undefined) {
  return !value || Number.isFinite(new Date(value).getTime());
}

function usableQuote(row: QuoteRow | undefined, expectedCurrency: string | null | undefined) {
  if (!row || !Number.isFinite(Number(row.price)) || Number(row.price) <= 0) return null;
  const currency = String(row.currency ?? "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency) || !isValidTimestamp(row.quoted_at)) return null;
  if (expectedCurrency && currency !== expectedCurrency.toUpperCase()) return null;
  return row;
}

function usableManualPrice(holding: HoldingRow) {
  const price = Number(holding.last_price);
  if (!Number.isFinite(price) || price <= 0 || !isValidTimestamp(holding.last_price_at)) return null;
  return price;
}

export async function GET(request: Request) {
  try {
    const viewer = await requireFamilyMember(request);
    // Filtre serveur respectant le partage PAR CLASSE : admin → toute la famille ; membre →
    // soi + comptes dont le propriétaire a ouvert la classe correspondante (PEA / CTO / BTC).
    // Aperçu admin fidèle : ?asMember=<id> calcule le périmètre de CE membre (admin, lecture seule).
    const asMember = new URL(request.url).searchParams.get("asMember");
    const scopeViewer = viewer.role === "admin" && asMember ? { ...viewer, id: asMember, role: "adult" as const } : viewer;
    const scope = await viewableInvestmentScope(scopeViewer);
    const scopeFilter = scope === null ? "" : `&member_id=in.(${[...scope.keys()].map((id) => encodeURIComponent(id)).join(",")})`;

    const rawAccountRows = await fetchAccounts(scopeFilter);
    // Deuxième passe par classe : un membre peut partager son CTO mais pas son PEA.
    const accountRows = scope === null
      ? rawAccountRows
      : rawAccountRows.filter((account) => {
          const flags = scope.get(account.member_id);
          return flags ? accountVisible(account.account_type, flags) : false;
        });
    const accountIds = accountRows.map((account) => account.id);
    const memberIds = [...new Set(accountRows.map((account) => account.member_id))];

    const [memberRows, holdingRows] = await Promise.all([
      memberIds.length
        ? supabaseRest<MemberRow[]>(`family_members?select=id,name&id=in.(${memberIds.join(",")})`)
        : Promise.resolve<MemberRow[]>([]),
      accountIds.length
        ? fetchHoldings(accountIds)
        : Promise.resolve<HoldingRow[]>([]),
    ]);

    // Opérations (table optionnelle : migration 20260722 non encore jouée → liste vide).
    const operationRows = accountIds.length ? await fetchOperations(accountIds) : [];

    const nameById = new Map(memberRows.map((member) => [member.id, member.name]));
    const accounts = accountRows.map((account) => ({
      id: account.id,
      name: account.name,
      institution: account.institution,
      accountType: account.account_type,
      currency: account.currency,
      memberId: account.member_id,
      memberName: nameById.get(account.member_id) ?? null,
      accountNumberLast4: account.account_number_last4 ?? null,
      ibanLast4: account.iban_last4 ?? null,
      openedAt: account.opened_at ?? null,
      monthlyTarget: account.monthly_target === null || account.monthly_target === undefined ? null : Number(account.monthly_target),
      openingBalance: account.opening_balance === null || account.opening_balance === undefined ? null : Number(account.opening_balance),
      notes: account.notes ?? null,
    }));
    const quoteRows = holdingRows.length ? await fetchQuotes(holdingRows.map((holding) => holding.id)) : [];
    const latestQuoteByAsset = new Map<string, QuoteRow>();
    const latestQuoteBySymbol = new Map<string, QuoteRow>();
    for (const quote of quoteRows) if (!latestQuoteByAsset.has(quote.asset_id)) latestQuoteByAsset.set(quote.asset_id, quote);
    for (const quote of quoteRows) if (!latestQuoteBySymbol.has(`${quote.provider}:${quote.provider_symbol}`)) latestQuoteBySymbol.set(`${quote.provider}:${quote.provider_symbol}`, quote);
    const accountCurrencyById = new Map(accountRows.map((account) => [account.id, account.currency.toUpperCase()]));

    // ---- Taux de change : UNE seule requête pour tout le portefeuille -----------------------
    // Les devises utiles sont celles réellement cotées (le cours peut différer de la devise du
    // référentiel) ET celles des opérations (nécessaires au coût historique en euros). Elles
    // sont collectées d'abord, puis un seul appel charge les taux : jamais une requête par
    // position.
    const currenciesInUse = new Set<string>();
    for (const holding of holdingRows) {
      const quote = usableQuote(latestQuoteByAsset.get(holding.id)
        ?? (holding.provider_symbol ? latestQuoteBySymbol.get(`eodhd:${holding.provider_symbol}`) : undefined)
        ?? (holding.yahoo_symbol ? latestQuoteBySymbol.get(`yahoo:${holding.yahoo_symbol}`) : undefined), holding.currency);
      currenciesInUse.add((quote?.currency ?? holding.currency ?? "EUR").toUpperCase());
    }
    for (const operation of operationRows) currenciesInUse.add((operation.currency ?? "EUR").toUpperCase());
    for (const account of accountRows) currenciesInUse.add(account.currency.toUpperCase());
    const fxRows: FxRateRow[] = await loadPortfolioFxRates([...currenciesInUse]);

    const holdings = holdingRows.map((holding) => {
      const quote = usableQuote(latestQuoteByAsset.get(holding.id)
        ?? (holding.provider_symbol ? latestQuoteBySymbol.get(`eodhd:${holding.provider_symbol}`) : undefined)
        ?? (holding.yahoo_symbol ? latestQuoteBySymbol.get(`yahoo:${holding.yahoo_symbol}`) : undefined), holding.currency);
      const manualPrice = usableManualPrice(holding);
      const referenceCurrency = accountCurrencyById.get(holding.account_id) ?? "EUR";
      const nativeCurrency = (quote?.currency ?? holding.currency).toUpperCase();
      // Facteur résolu par le SEUL module qui connaît la formule (lib/fx-rates.ts). La route ne
      // fait qu'appliquer ce qu'il renvoie : c'est ce qui rend une double inversion impossible.
      const conversion = getLatestFxRate(nativeCurrency, referenceCurrency, fxRows);
      const fx = conversion?.rate ?? null;
      return ({
      id: holding.id,
      account_id: holding.account_id,
      asset_type: holding.asset_type,
      name: holding.name,
      symbol: holding.symbol,
      isin: holding.isin,
      quantity: Number(holding.quantity) || 0,
      average_cost: holding.average_cost === null || holding.average_cost === undefined ? null : Number(holding.average_cost),
      last_price: quote ? Number(quote.price) : manualPrice,
      last_price_at: quote?.quoted_at ?? (manualPrice === null ? null : holding.last_price_at ?? null),
      currency: holding.currency,
      exchange: holding.exchange ?? null, providerSymbol: holding.provider_symbol ?? holding.market_symbol ?? null, yahooSymbol: holding.yahoo_symbol ?? null, micCode: holding.mic_code ?? null,
      dataProvider: quote?.provider ?? holding.data_provider ?? null, quoteMode: holding.quote_mode ?? (quote ? "eod" : null), country: holding.country ?? null,
      marketStatus: quote?.market_status ?? null, dataDelayMinutes: quote?.data_delay_minutes ?? null, fetchedAt: quote?.fetched_at ?? null,
      fxRateToReference: fx, referenceCurrency,
      // Traçabilité du change, pour l'infobulle et la mention de bas de tableau. Jamais affichée
      // ligne à ligne : c'est une justification, pas une donnée de portefeuille.
      fxRateDate: conversion?.rateDate ?? null,
      fxStale: conversion?.stale ?? false,
      fxLegs: conversion?.legs ?? [],
    }); });
    const operations = operationRows.map((op) => ({
      id: op.id,
      accountId: op.account_id,
      memberId: op.member_id,
      type: op.type,
      date: op.operation_date,
      assetName: op.asset_name,
      ticker: op.ticker,
      isin: op.isin,
      quantity: op.quantity === null || op.quantity === undefined ? null : Number(op.quantity),
      unitPrice: op.unit_price === null || op.unit_price === undefined ? null : Number(op.unit_price),
      grossAmount: op.gross_amount === null || op.gross_amount === undefined ? null : Number(op.gross_amount),
      fees: op.fees === null || op.fees === undefined ? null : Number(op.fees),
      netAmount: op.net_amount === null || op.net_amount === undefined ? null : Number(op.net_amount),
      currency: op.currency,
      exchangeRate: op.exchange_rate === null || op.exchange_rate === undefined ? null : Number(op.exchange_rate),
      taxes: op.taxes === null || op.taxes === undefined ? null : Number(op.taxes),
      source: op.source,
      note: op.note,
    }));

    // Les taux sont renvoyés TELS QUELS (base EUR, datés) plutôt que sous forme de facteurs
    // pré-calculés : le client en a besoin pour convertir le COÛT HISTORIQUE d'une opération au
    // taux de SA date, ce qu'un facteur unique « du jour » ne permettrait pas.
    return Response.json({ accounts, holdings, operations, fxRates: fxRows });
  } catch (error) {
    // Migration des portefeuilles pas encore appliquée → renvoyer un état vide plutôt qu'une
    // erreur : le tableau de bord affiche alors simplement le Bitcoin, sans PEA ni compte-titres.
    if (error instanceof Error && isMissingTable(error.message)) {
      return Response.json({ accounts: [], holdings: [], operations: [] });
    }
    return authErrorResponse(error);
  }
}

async function fetchOperations(accountIds: string[]): Promise<OperationRow[]> {
  try {
    return await supabaseRest<OperationRow[]>(
      `account_operations?select=id,account_id,member_id,type,operation_date,asset_name,ticker,isin,quantity,unit_price,gross_amount,fees,net_amount,currency,source,note,exchange_rate,taxes&account_id=in.(${accountIds.join(",")})&order=operation_date.desc`,
    );
  } catch (error) {
    // Table account_operations absente (migration non jouée) → aucune opération, pas d'erreur.
    if (error instanceof Error && (error.message.includes("account_operations") || error.message.includes("PGRST205"))) return [];
    throw error;
  }
}

async function fetchHoldings(accountIds: string[]): Promise<HoldingRow[]> {
  const select = "id,account_id,asset_type,name,symbol,isin,quantity,average_cost,last_price,last_price_at,currency,exchange,provider_symbol,yahoo_symbol,market_symbol,mic_code,data_provider,quote_mode,country";
  try { return await supabaseRest<HoldingRow[]>(`holdings?select=${select}&account_id=in.(${accountIds.join(",")})`); }
  catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!/provider_symbol|yahoo_symbol|mic_code|data_provider|quote_mode|country|PGRST20[0-9]|42703/.test(message)) throw error;
    return await supabaseRest<HoldingRow[]>(`holdings?select=id,account_id,asset_type,name,symbol,isin,quantity,average_cost,last_price,last_price_at,currency&account_id=in.(${accountIds.join(",")})`);
  }
}
async function fetchQuotes(assetIds: string[]): Promise<QuoteRow[]> {
  try { return await supabaseRest<QuoteRow[]>(`market_quotes?select=asset_id,provider,provider_symbol,price,currency,quoted_at,market_status,data_delay_minutes,fetched_at&asset_id=in.(${assetIds.join(",")})&order=fetched_at.desc`); }
  catch { return []; }
}
// Les taux sont désormais chargés par `loadPortfolioFxRates` (lib/fx-rates-server.ts) : une
// seule requête, filtrée sur les devises réellement présentes, avec repli sur l'ancienne table
// `market_fx_rates` tant que `fx_rates` n'a pas été alimentée.
