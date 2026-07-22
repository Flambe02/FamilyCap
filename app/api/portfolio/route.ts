import { authErrorResponse, requireFamilyMember, viewableMemberIds } from "../../../lib/auth-server";
import { supabaseRest } from "../../../lib/supabase-rest";

// Lecture des comptes financiers (PEA, compte-titres…), de leurs positions (référentiel de
// cours) et de leurs opérations, pour le tableau de bord « vue utilisateur », l'écran PEA et
// l'écran Paramètres › Mes comptes.
//
// Frontière de sécurité (comme toutes les routes) : `requireFamilyMember` identifie l'appelant
// côté serveur, puis le filtre est appliqué EN CODE. Le périmètre lisible respecte le partage
// familial (`viewableMemberIds`) : un membre voit ses propres comptes ET ceux réellement
// partagés avec lui (scope « famille » ou autorisation explicite) ; seul l'admin voit toute la
// famille. La clé service-role reste strictement serveur et ne fuit jamais au client.

type AccountRow = { id: string; name: string; institution: string | null; account_type: string; currency: string; member_id: string };
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
    // Filtre serveur respectant le partage : admin → toute la famille ; membre → soi + comptes partagés.
    const viewable = await viewableMemberIds(viewer);
    if (viewable !== null && viewable.length === 0) return Response.json({ accounts: [], holdings: [], operations: [] });
    const scopeFilter = viewable === null ? "" : `&member_id=in.(${viewable.map((id) => encodeURIComponent(id)).join(",")})`;

    const accountRows = await supabaseRest<AccountRow[]>(
      `financial_accounts?select=id,name,institution,account_type,currency,member_id&is_active=eq.true${scopeFilter}`,
    );
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
