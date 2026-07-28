// GET /api/investment-accounts/:accountId/dividends
//
// Modèle de dividendes complet d'un compte (ou d'un périmètre agrégé via ?accountIds=), calculé
// SERVEUR par le moteur pur. Le navigateur ne recalcule rien et ne reçoit aucune clé fournisseur.
//
// Le PEA et le compte-titres empruntent cette route sans distinction : c'est le profil fiscal du
// compte, et lui seul, qui différencie les deux enveloppes à l'affichage.
//
// Paramètres : ?window=next12m|current_year|previous_year|YYYY|from&to · ?includeForecast=0|1

import { authErrorResponse } from "../../../../../lib/auth-server";
import { providerAvailability } from "../../../../../lib/dividend-providers";
import {
  buildDividendPayload, dividendErrorResponse, resolveDividendScope,
} from "../../../../../lib/dividend-route";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ accountId: string }> }) {
  try {
    const { accountId } = await context.params;
    const { accountIds } = await resolveDividendScope(request, accountId);
    const url = new URL(request.url);
    const result = await buildDividendPayload(accountIds, url.searchParams);
    if (!result) return Response.json({ error: "Compte PEA ou compte-titres introuvable." }, { status: 404 });
    return Response.json({
      ...result.payload,
      // Les noms de fournisseurs sont publics ; les CLÉS ne quittent jamais le serveur. Cette
      // information sert l'état vide « fournisseur non configuré », qui serait sinon inexplicable.
      providers: providerAvailability().map((entry) => ({ name: entry.name, role: entry.role, configured: entry.configured })),
    });
  } catch (error) {
    return dividendErrorResponse(error) ?? authErrorResponse(error);
  }
}
