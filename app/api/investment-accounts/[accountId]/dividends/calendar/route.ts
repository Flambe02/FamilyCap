// GET /api/investment-accounts/:accountId/dividends/calendar
//
// Calendrier complet des échéances de la période, pour l'écran « Voir tout le calendrier ». C'est
// une PROJECTION du même modèle que la route parente — jamais un second calcul : deux moteurs
// finiraient par afficher deux calendriers différents.

import { authErrorResponse } from "../../../../../../lib/auth-server";
import { monthLabelLong } from "../../../../../../lib/dividend-engine";
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
    const months = new Map<string, typeof model.entries>();
    for (const entry of model.entries) {
      if (!model.monthly.some((point) => point.monthKey === entry.scheduleMonth)) continue;
      months.set(entry.scheduleMonth, [...(months.get(entry.scheduleMonth) ?? []), entry]);
    }

    return Response.json({
      account: result.payload.account,
      window: model.window,
      currency: model.referenceCurrency,
      taxNetAvailable: model.tax.netAvailable,
      months: [...months.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([monthKey, entries]) => ({
          monthKey,
          label: monthLabelLong(monthKey),
          totalReference: entries.reduce((sum, entry) => sum + (entry.grossReference ?? 0), 0),
          entries: entries.sort((a, b) => (a.paymentDate ?? `${a.scheduleMonth}-99`).localeCompare(b.paymentDate ?? `${b.scheduleMonth}-99`)),
        })),
    });
  } catch (error) {
    return dividendErrorResponse(error) ?? authErrorResponse(error);
  }
}
