import { authErrorResponse, requireAdmin } from "../../../../lib/auth-server";
import { loadFxRates, syncEcbFxRates } from "../../../../lib/fx-rates-server";
import { getLatestFxRate } from "../../../../lib/fx-rates";

// TAUX DE CHANGE — état et synchronisation manuelle. Admin uniquement.
//
// Le chemin nominal d'alimentation de `fx_rates` est la Fonction Edge `sync-fx-rates`, planifiée
// chaque jour ouvré. Cette route existe pour deux raisons pratiques :
//   • AMORCER la table sans rien déployer (c'est ce qui débloque l'affichage tout de suite) ;
//   • DÉPANNER : si la planification a été manquée, un administrateur relance en un clic et voit
//     immédiatement ce qui a été écrit.
// Les deux chemins écrivent exactement les mêmes lignes, avec la même clé : les rejouer est sans
// effet de bord (upsert idempotent).
//
// GET  → état : dernière date connue, âge, taux EUR/USD courant. Aucun écrit.
// POST → télécharge le fichier du jour à la BCE et enregistre. Aucun secret externe requis.

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    await requireAdmin(request);
    const rows = await loadFxRates();
    const usd = getLatestFxRate("USD", "EUR", rows);
    const latestDate = rows.reduce<string | null>((best, row) => (best === null || row.rateDate > best ? row.rateDate : best), null);
    return Response.json({
      configured: rows.length > 0,
      latestRateDate: latestDate,
      currencies: [...new Set(rows.map((row) => row.quoteCurrency))].sort(),
      // Exemple concret, celui qui parle : le facteur appliqué aux lignes en dollars.
      usdToEur: usd ? { rate: usd.rate, rateDate: usd.rateDate, ageDays: usd.ageDays, stale: usd.stale, legs: usd.legs } : null,
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    await requireAdmin(request);
    const report = await syncEcbFxRates();
    return Response.json(report, { status: report.ok ? 200 : 502 });
  } catch (error) {
    return authErrorResponse(error);
  }
}
