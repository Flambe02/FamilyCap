// Expositions géographiques / sectorielles des instruments demandés.
//
// Ce sont des MÉTADONNÉES DE MARCHÉ : elles ne contiennent ni quantité, ni montant, ni compte.
// Elles sont donc lisibles par tout membre authentifié (même modèle que `assets` /
// `asset_listings`), et le filtre par ISIN sert la performance, pas la confidentialité — c'est
// le portefeuille qui est protégé, pas la composition publique d'un indice.

import { authErrorResponse, requireFamilyMember } from "../../../../lib/auth-server";
import { supabaseRest } from "../../../../lib/supabase-rest";

type ExposureRow = {
  instrument_isin: string | null;
  asset_id: string | null;
  dimension: string;
  exposure_code: string;
  exposure_label: string;
  weight_percent: number;
  source: string;
  source_as_of: string | null;
  confidence: string;
  is_estimated: boolean;
};

const ISIN_SHAPE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
const MAX_ISINS = 200;

export async function GET(request: Request) {
  try {
    await requireFamilyMember(request);
    const isins = [...new Set(
      (new URL(request.url).searchParams.get("isins") ?? "")
        .split(",")
        .map((value) => value.trim().toUpperCase())
        .filter((value) => ISIN_SHAPE.test(value)),
    )].slice(0, MAX_ISINS);
    if (isins.length === 0) return Response.json({ exposures: [], available: true });

    const rows = await supabaseRest<ExposureRow[]>(
      `instrument_exposures?select=instrument_isin,asset_id,dimension,exposure_code,exposure_label,weight_percent,source,source_as_of,confidence,is_estimated&instrument_isin=in.(${isins.join(",")})`,
    );
    return Response.json({
      available: true,
      exposures: (rows ?? []).map((row) => ({
        isin: row.instrument_isin,
        assetId: row.asset_id,
        instrumentKey: null,
        dimension: row.dimension,
        code: row.exposure_code,
        label: row.exposure_label,
        weightPercent: Number(row.weight_percent),
        source: row.source,
        sourceAsOf: row.source_as_of,
        confidence: row.confidence,
        isEstimated: row.is_estimated,
      })),
    });
  } catch (error) {
    // Migration 20260816 pas encore jouée : l'écran affiche « exposition non renseignée » plutôt
    // qu'une erreur. `available: false` permet de le DIRE au lieu de laisser croire à un portefeuille
    // réellement sans exposition connue.
    const message = error instanceof Error ? error.message : "";
    if (/instrument_exposures|PGRST20[0-9]|42P01/.test(message)) {
      return Response.json({ exposures: [], available: false });
    }
    return authErrorResponse(error);
  }
}
