// Séries de référence (benchmark) de l'écran Performance.
//
// GET  — renvoie les séries déjà collectées. Une série absente est dite ABSENTE : l'écran affiche
//        « comparaison indisponible » plutôt qu'une courbe reconstituée. Une courbe de référence
//        inventée est pire qu'aucune comparaison : elle donne un jugement sur la gestion.
// POST — collecte (administrateur) depuis un fournisseur gratuit et sans clé, puis enregistre.

import { authErrorResponse, requireAdmin, requireFamilyMember } from "../../../../lib/auth-server";
import { supabaseRest } from "../../../../lib/supabase-rest";
import { BENCHMARKS, benchmarkByCode, fetchBenchmarkSeries } from "../../../../lib/market-history";

export const runtime = "nodejs";

type SeriesRow = { benchmark_code: string; series_date: string; close: number; currency: string; source: string };

const MISSING_TABLE = /benchmark_series|PGRST20[0-9]|42P01/;

export async function GET(request: Request) {
  try {
    await requireFamilyMember(request);
    const url = new URL(request.url);
    const codes = (url.searchParams.get("codes") ?? BENCHMARKS.map((benchmark) => benchmark.code).join(","))
      .split(",")
      .map((value) => value.trim())
      .filter((value) => benchmarkByCode(value) !== null);
    if (codes.length === 0) return Response.json({ available: true, benchmarks: [] });

    const rows = await supabaseRest<SeriesRow[]>(
      `benchmark_series?select=benchmark_code,series_date,close,currency,source&benchmark_code=in.(${codes.map(encodeURIComponent).join(",")})&order=series_date.asc`,
    );
    const byCode = new Map<string, SeriesRow[]>();
    for (const row of rows ?? []) byCode.set(row.benchmark_code, [...(byCode.get(row.benchmark_code) ?? []), row]);

    return Response.json({
      available: true,
      benchmarks: codes.map((code) => {
        const definition = benchmarkByCode(code)!;
        const series = byCode.get(code) ?? [];
        return {
          code,
          label: definition.label,
          proxyNote: definition.proxyNote,
          currency: series[0]?.currency ?? null,
          source: series[0]?.source ?? null,
          points: series.map((row) => ({ date: row.series_date, close: Number(row.close) })),
        };
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (MISSING_TABLE.test(message)) return Response.json({ available: false, benchmarks: [] });
    return authErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    await requireAdmin(request);
    const body = (await request.json().catch(() => ({}))) as { codes?: string[] };
    const codes = (body.codes?.length ? body.codes : BENCHMARKS.map((benchmark) => benchmark.code))
      .map((code) => benchmarkByCode(code))
      .filter((benchmark): benchmark is NonNullable<typeof benchmark> => benchmark !== null);

    const results: Array<{ code: string; status: "updated" | "unavailable"; points: number; message?: string }> = [];
    for (const benchmark of codes) {
      const series = await fetchBenchmarkSeries(benchmark.symbol, 10);
      if (series === null || series.length === 0) {
        // Aucune suppression : une collecte ratée laisse la série précédente en place.
        results.push({ code: benchmark.code, status: "unavailable", points: 0, message: "Le fournisseur n'a pas répondu. La série existante est conservée." });
        continue;
      }
      await supabaseRest("benchmark_series?on_conflict=benchmark_code,series_date", {
        method: "POST",
        headers: { prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(series.map((point) => ({
          benchmark_code: benchmark.code,
          series_date: point.date,
          close: point.close,
          currency: point.currency,
          source: benchmark.proxyNote ?? `Cours de clôture ${benchmark.symbol}`,
          fetched_at: new Date().toISOString(),
        }))),
      });
      results.push({ code: benchmark.code, status: "updated", points: series.length });
    }
    return Response.json({ results });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (MISSING_TABLE.test(message)) {
      return Response.json({ error: "La table benchmark_series est absente : jouez la migration 20260816." }, { status: 503 });
    }
    return authErrorResponse(error);
  }
}
