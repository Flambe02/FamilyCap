// GET /api/investment-accounts/:accountId/dividends/positions
//
// Détail par position pour la vue secondaire « Voir toutes les positions ». Comme le calendrier,
// c'est une PROJECTION du modèle unique, pas un recalcul.

import { authErrorResponse } from "../../../../../../lib/auth-server";
import {
  buildDividendPayload, dividendErrorResponse, resolveDividendScope,
} from "../../../../../../lib/dividend-route";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ accountId: string }> }) {
  try {
    const { accountId } = await context.params;
    const { accountIds } = await resolveDividendScope(request, accountId);
    const url = new URL(request.url);
    const result = await buildDividendPayload(accountIds, url.searchParams);
    if (!result) return Response.json({ error: "Compte PEA ou compte-titres introuvable." }, { status: 404 });

    const { model } = result.payload;
    return Response.json({
      account: result.payload.account,
      window: model.window,
      currency: model.referenceCurrency,
      coverage: model.coverage,
      // Les positions les plus contributrices d'abord ; une position sans donnée reste LISTÉE,
      // avec son statut, plutôt que d'être silencieusement omise.
      positions: [...model.positions].sort((a, b) => (b.expectedReference ?? -1) - (a.expectedReference ?? -1)),
      unresolved: result.payload.unresolved,
    });
  } catch (error) {
    return dividendErrorResponse(error) ?? authErrorResponse(error);
  }
}
