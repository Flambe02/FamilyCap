import { authErrorResponse, requireFamilyMember } from "../../../../lib/auth-server";
import { reconcileOnboardingForMember } from "../../../../lib/onboarding-challenges-service";

// Parcours permanent « Bien démarrer » du membre connecté. Réconcilie à l'ouverture (filet de
// sécurité : reconnaît rétroactivement les actions déjà réalisées), puis renvoie la progression
// fraîche + les missions VENANT d'être complétées par cet appel (message de réussite ciblé côté
// client). Identité déterminée depuis la session — jamais du corps de la requête. Aucun montant
// (compte, plan, opération) n'est exposé ici : uniquement statut par mission et points.
export const runtime = "nodejs";

// Aperçu admin (lecture seule côté UI) : ?asMember=<id> affiche le parcours du membre
// prévisualisé. Jamais honoré pour un non-admin (un membre ne peut jamais réconcilier/lire le
// parcours d'un autre). La réconciliation ne fait qu'reconnaître des conditions déjà réelles :
// aucun point n'est jamais fabriqué, qu'elle soit déclenchée par le membre ou par un aperçu admin.
function resolveTargetId(request: Request, viewer: { id: string; role: string }): string {
  const asMember = new URL(request.url).searchParams.get("asMember");
  return asMember && viewer.role === "admin" ? asMember : viewer.id;
}

export async function GET(request: Request) {
  try {
    const viewer = await requireFamilyMember(request);
    const result = await reconcileOnboardingForMember(resolveTargetId(request, viewer));
    return Response.json({
      available: result.available,
      missions: result.progress.missions,
      completedCount: result.progress.completedCount,
      totalCount: result.progress.totalCount,
      earnedPoints: result.progress.earnedPoints,
      totalPoints: result.progress.totalPoints,
      justCompleted: result.justCompleted,
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}
