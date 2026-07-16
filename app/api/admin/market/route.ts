import { authErrorResponse, requireAdmin } from "../../../../lib/auth-server";

type AlphaSearchMatch = {
  "1. symbol"?: string;
  "2. name"?: string;
  "3. type"?: string;
  "4. region"?: string;
  "8. currency"?: string;
  "9. matchScore"?: string;
};

export async function GET(request: Request) {
  try {
    await requireAdmin(request);
    const url = new URL(request.url);
    const query = url.searchParams.get("q")?.trim();
    const symbol = url.searchParams.get("symbol")?.trim();
    const key = process.env.ALPHA_VANTAGE_API_KEY;

    if (!key) return Response.json({ configured: false, provider: "Alpha Vantage", results: [] });
    if (!query && !symbol) return Response.json({ configured: true, provider: "Alpha Vantage", results: [] });

    const params = new URLSearchParams({ apikey: key });
    if (symbol) {
      params.set("function", "GLOBAL_QUOTE");
      params.set("symbol", symbol);
    } else {
      params.set("function", "SYMBOL_SEARCH");
      params.set("keywords", query ?? "");
    }

    const response = await fetch(`https://www.alphavantage.co/query?${params}`, { cache: "no-store" });
    if (!response.ok) return Response.json({ error: "Le fournisseur de marché ne répond pas." }, { status: 502 });
    const data = await response.json() as Record<string, unknown>;
    const providerMessage = String(data.Note ?? data.Information ?? "");
    if (providerMessage) return Response.json({ error: providerMessage, configured: true, provider: "Alpha Vantage" }, { status: 429 });

    if (symbol) {
      const quote = (data["Global Quote"] ?? {}) as Record<string, string>;
      return Response.json({
        configured: true,
        provider: "Alpha Vantage",
        quote: {
          symbol: quote["01. symbol"] ?? symbol,
          price: Number(quote["05. price"] ?? 0),
          previousClose: Number(quote["08. previous close"] ?? 0),
          changePercent: quote["10. change percent"] ?? null,
          asOf: quote["07. latest trading day"] ?? null,
        },
      });
    }

    const matches = (data.bestMatches ?? []) as AlphaSearchMatch[];
    const results = matches.map((match) => ({
      symbol: match["1. symbol"] ?? "",
      name: match["2. name"] ?? "",
      type: match["3. type"] ?? "",
      region: match["4. region"] ?? "",
      currency: match["8. currency"] ?? "EUR",
      score: Number(match["9. matchScore"] ?? 0),
    }));
    return Response.json({ configured: true, provider: "Alpha Vantage", results });
  } catch (error) {
    return authErrorResponse(error);
  }
}
