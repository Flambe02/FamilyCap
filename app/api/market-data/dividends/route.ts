import { authErrorResponse, requireFamilyMember, viewableInvestmentScope } from "../../../../lib/auth-server";
import { supabaseRest } from "../../../../lib/supabase-rest";

type AccountRow = { id: string; member_id: string; account_type: string };

export async function GET(request: Request) {
  try {
    const viewer = await requireFamilyMember(request);
    const ids = new URL(request.url).searchParams.get("accountIds")?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
    if (!ids.length || ids.length > 20) return Response.json({ dividends: [] });
    const accounts = await supabaseRest<AccountRow[]>(`financial_accounts?select=id,member_id,account_type&id=in.(${ids.map(encodeURIComponent).join(",")})`);
    const scope = await viewableInvestmentScope(viewer);
    const allowed = accounts.filter((account) => {
      if (account.account_type !== "pea" && account.account_type !== "securities") return false;
      if (scope === null) return true;
      const flags = scope.get(account.member_id);
      return account.account_type === "pea" ? flags?.pea === true : flags?.cto === true;
    }).map((account) => account.id);
    if (!allowed.length) return Response.json({ dividends: [] });
    const assets = await supabaseRest<Array<{ id: string; name: string; symbol: string | null; isin: string | null; account_id: string }>>(`holdings?select=id,name,symbol,isin,account_id&account_id=in.(${allowed.join(",")})`);
    if (!assets.length) return Response.json({ dividends: [] });
    const byId = new Map(assets.map((asset) => [asset.id, asset]));
    // `provider` et `status` remontent désormais jusqu'à l'écran : c'est ce qui permet de
    // distinguer une annonce d'un versement déjà détaché, et de nommer la source. Sans eux,
    // l'interface ne pouvait qu'appeler « annoncé » tout ce qui sortait de cette table.
    const rows = await supabaseRest<Array<{ id: string; asset_id: string; ex_date: string; payment_date: string | null; amount_per_share: number | null; currency: string | null; status: string; provider: string | null }>>(`corporate_actions?select=id,asset_id,ex_date,payment_date,amount_per_share,currency,status,provider&action_type=eq.dividend&asset_id=in.(${assets.map((asset) => asset.id).join(",")})&order=ex_date.desc`);
    return Response.json({ dividends: rows.map((row) => ({ ...row, asset: byId.get(row.asset_id) ?? null })) });
  } catch (error) { return authErrorResponse(error); }
}
