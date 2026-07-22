import { authErrorResponse, requireFamilyMember, viewableMemberIds } from "../../../lib/auth-server";
import { supabaseRest } from "../../../lib/supabase-rest";

// Lecture des comptes financiers (PEA, compte-titres…) et de leurs positions, pour le
// tableau de bord « vue utilisateur » et l'écran Paramètres › Mes comptes.
//
// Frontière de sécurité (comme toutes les routes) : `requireFamilyMember` identifie
// l'appelant côté serveur, puis le filtre est appliqué EN CODE. Le périmètre lisible
// respecte désormais le partage familial (`viewableMemberIds`) : un membre voit ses
// propres comptes ET ceux réellement partagés avec lui (scope « famille » ou autorisation
// explicite) ; seul l'admin voit toute la famille. La clé service-role reste strictement
// serveur et ne fuit jamais au client.

type AccountRow = { id: string; name: string; institution: string | null; account_type: string; currency: string; member_id: string };
type HoldingRow = { account_id: string; quantity: number; average_cost: number | null; last_price: number | null; currency: string };
type MemberRow = { id: string; name: string };

function isMissingTable(message: string) {
  return message.includes("financial_accounts") || message.includes("holdings") || message.includes("PGRST205") || message.includes("PGRST200");
}

export async function GET(request: Request) {
  try {
    const viewer = await requireFamilyMember(request);
    // Filtre serveur respectant le partage : admin → toute la famille ; membre → soi + comptes partagés.
    const viewable = await viewableMemberIds(viewer);
    if (viewable !== null && viewable.length === 0) return Response.json({ accounts: [], holdings: [] });
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
        ? supabaseRest<HoldingRow[]>(`holdings?select=account_id,quantity,average_cost,last_price,currency&account_id=in.(${accountIds.join(",")})`)
        : Promise.resolve<HoldingRow[]>([]),
    ]);

    const nameById = new Map(memberRows.map((member) => [member.id, member.name]));
    const accounts = accountRows.map((account) => ({
      id: account.id,
      name: account.name,
      institution: account.institution,
      accountType: account.account_type,
      currency: account.currency,
      memberName: nameById.get(account.member_id) ?? null,
    }));
    const holdings = holdingRows.map((holding) => ({
      account_id: holding.account_id,
      quantity: Number(holding.quantity) || 0,
      average_cost: holding.average_cost === null || holding.average_cost === undefined ? null : Number(holding.average_cost),
      last_price: holding.last_price === null || holding.last_price === undefined ? null : Number(holding.last_price),
      currency: holding.currency,
    }));

    return Response.json({ accounts, holdings });
  } catch (error) {
    // Migration des portefeuilles pas encore appliquée → renvoyer un état vide plutôt qu'une
    // erreur : le tableau de bord affiche alors simplement le Bitcoin, sans PEA ni compte-titres.
    if (error instanceof Error && isMissingTable(error.message)) {
      return Response.json({ accounts: [], holdings: [] });
    }
    return authErrorResponse(error);
  }
}
