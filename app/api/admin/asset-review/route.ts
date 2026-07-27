import { authErrorResponse, requireAdmin } from "../../../../lib/auth-server";
import { applyAdminCorrection, loadReviewableAssets, type AdminCorrection } from "../../../../lib/asset-catalog-server";
import { buildReviewList } from "../../../../lib/asset-catalog";

// REVUE DES ACTIFS DU CATALOGUE — administrateur uniquement.
//
// Sert l'écran « Actifs & cotations » : la liste de ce qui empêche réellement une synchronisation
// (actif sans cotation, cotation sans symbole fournisseur, doublon probable) plutôt qu'un vidage
// brut de table. Le classement et les motifs viennent de `buildReviewList`, fonction PURE et
// testée — la route ne fait que lire, écrire, et traduire les erreurs.
//
// Le PATCH est la SOURCE DE CONFIANCE LA PLUS HAUTE du système : il marque l'actif `verified`,
// statut qu'aucun échec fournisseur ni aucune déduction ultérieure ne peut écraser.

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    await requireAdmin(request);
    const assets = await loadReviewableAssets();
    if (assets === null) {
      return Response.json({
        error: "Le catalogue d'actifs n'est pas encore installé. Appliquez la migration 20260811_asset_catalog.sql dans Supabase.",
        setupRequired: true,
      }, { status: 503 });
    }
    const review = buildReviewList(assets);
    return Response.json({
      assets: review,
      total: assets.length,
      // Un catalogue sain renvoie une liste vide : c'est un état normal, pas une erreur.
      pending: review.length,
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    await requireAdmin(request);
    const body = (await request.json()) as AdminCorrection;
    if (!body?.assetId) return Response.json({ error: "L'actif est obligatoire." }, { status: 400 });

    const result = await applyAdminCorrection(body);
    if (!result.ok) return Response.json({ error: result.error }, { status: 422 });
    return Response.json({ updated: true, assetId: body.assetId });
  } catch (error) {
    return authErrorResponse(error);
  }
}
