// POST /api/investment-accounts/:accountId/dividends/sync
//
// Déclenche l'orchestration serveur : résolution des instruments, quota, récupération, fusion,
// enregistrement, projections. Réservée à l'administrateur.
//
// CE QUE CETTE ROUTE N'ÉCRIT JAMAIS : `account_operations`. Un dividende annoncé n'est pas un
// dividende encaissé ; en faire une opération fabriquerait une recette que personne n'a reçue et
// fausserait la trésorerie. Elle ne supprime que des PROJECTIONS, qui sont dérivées par
// construction — jamais un fait fournisseur, jamais un encaissement.

import { authErrorResponse, requireAdmin } from "../../../../../../lib/auth-server";
import { describeSyncReport } from "../../../../../../lib/dividend-engine";
import { providerAvailability } from "../../../../../../lib/dividend-providers";
import { resolveAlphaVantageSymbols, syncAccountDividends } from "../../../../../../lib/dividend-sync";
import {
  buildDividendPayload, dividendErrorResponse, resolveDividendScope,
} from "../../../../../../lib/dividend-route";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request, context: { params: Promise<{ accountId: string }> }) {
  try {
    await requireAdmin(request);
    const { accountId } = await context.params;
    // Même garde de périmètre que la lecture : être administrateur n'autorise pas à synchroniser
    // un compte qui n'est pas un PEA ou un compte-titres.
    const { accountIds } = await resolveDividendScope(request, accountId);
    const body = (await request.json().catch(() => ({}))) as { force?: boolean; resolveSymbols?: boolean };

    // La résolution de symbole consomme le MÊME quota que la récupération : elle est donc
    // explicite et bornée, jamais déclenchée à chaque synchronisation.
    const resolutions = body.resolveSymbols === true ? await resolveAlphaVantageSymbols(accountIds, { limit: 5 }) : [];

    const result = await syncAccountDividends(accountIds, { force: body.force === true });
    if (!result) return Response.json({ error: "Compte PEA ou compte-titres introuvable." }, { status: 404 });

    const url = new URL(request.url);
    const refreshed = await buildDividendPayload(accountIds, url.searchParams);

    return Response.json({
      message: describeSyncReport(result.report),
      report: result.report,
      outcomes: result.outcomes,
      quota: result.quota,
      resolutions,
      projectionsEnabled: result.projectionsEnabled,
      ranAt: result.ranAt,
      providers: providerAvailability(),
      ...(refreshed ? { payload: refreshed.payload } : {}),
    });
  } catch (error) {
    return dividendErrorResponse(error) ?? authErrorResponse(error);
  }
}
