import { authErrorResponse, requireFamilyMember, viewableInvestmentScope, type MemberShareFlags } from "../../../lib/auth-server";
import { supabaseRest } from "../../../lib/supabase-rest";

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
type HoldingRow = { account_id: string; asset_type: string | null; name: string | null; symbol: string | null; isin: string | null; quantity: number; average_cost: number | null; last_price: number | null; last_price_at: string | null; currency: string };
type MemberRow = { id: string; name: string };
type OperationRow = {
  id: string; account_id: string; member_id: string; type: string; operation_date: string;
  asset_name: string | null; ticker: string | null; isin: string | null; quantity: number | null;
  unit_price: number | null; gross_amount: number | null; fees: number | null; net_amount: number | null;
  currency: string; source: string | null; note: string | null;
};

function isMissingTable(message: string) {
  return message.includes("financial_accounts") || message.includes("holdings") || message.includes("PGRST205") || message.includes("PGRST200");
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
        ? supabaseRest<HoldingRow[]>(`holdings?select=account_id,asset_type,name,symbol,isin,quantity,average_cost,last_price,last_price_at,currency&account_id=in.(${accountIds.join(",")})`)
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
    const holdings = holdingRows.map((holding) => ({
      account_id: holding.account_id,
      asset_type: holding.asset_type,
      name: holding.name,
      symbol: holding.symbol,
      isin: holding.isin,
      quantity: Number(holding.quantity) || 0,
      average_cost: holding.average_cost === null || holding.average_cost === undefined ? null : Number(holding.average_cost),
      last_price: holding.last_price === null || holding.last_price === undefined ? null : Number(holding.last_price),
      last_price_at: holding.last_price_at ?? null,
      currency: holding.currency,
    }));
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
      source: op.source,
      note: op.note,
    }));

    return Response.json({ accounts, holdings, operations });
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
      `account_operations?select=id,account_id,member_id,type,operation_date,asset_name,ticker,isin,quantity,unit_price,gross_amount,fees,net_amount,currency,source,note&account_id=in.(${accountIds.join(",")})&order=operation_date.desc`,
    );
  } catch (error) {
    // Table account_operations absente (migration non jouée) → aucune opération, pas d'erreur.
    if (error instanceof Error && (error.message.includes("account_operations") || error.message.includes("PGRST205"))) return [];
    throw error;
  }
}
