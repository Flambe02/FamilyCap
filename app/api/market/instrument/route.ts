import { authErrorResponse, requireFamilyMember } from "../../../../lib/auth-server";
import { fetchInstrument } from "../../../../lib/market-quotes";

// FICHE INSTRUMENT — données de marché EXTERNES pour l'écran de détail d'une position.
// Lecture seule : rien n'est écrit en base (contrairement à /api/admin/market/refresh, qui est
// admin et met à jour holdings.last_price). Ouverte à tout membre de la famille, car elle ne
// révèle aucune donnée patrimoniale : seuls des identifiants publics d'instrument transitent.
//
// Les identifiants viennent de la position affichée. Aucun cours n'est inventé : si le
// fournisseur ne répond pas ou ne connaît pas l'instrument, la route le dit explicitement.

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    await requireFamilyMember(request);
    const params = new URL(request.url).searchParams;
    const isin = (params.get("isin") ?? "").trim().toUpperCase() || null;
    const ticker = (params.get("ticker") ?? "").trim().toUpperCase() || null;
    const name = (params.get("name") ?? "").trim() || null;
    const currency = (params.get("currency") ?? "").trim().toUpperCase() || null;

    if (!isin && !ticker && !name) {
      return Response.json({ error: "Aucun identifiant d'instrument fourni." }, { status: 400 });
    }

    const outcome = await fetchInstrument({ isin, ticker, name, currency });
    if (!outcome.ok) {
      return Response.json({ error: outcome.message, reason: outcome.reason }, { status: 404 });
    }
    return Response.json({ instrument: outcome.instrument, currencyMismatch: outcome.currencyMismatch });
  } catch (error) {
    return authErrorResponse(error);
  }
}
