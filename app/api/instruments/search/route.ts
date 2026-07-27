import { authErrorResponse, requireFamilyMember, viewableMemberIds } from "../../../../lib/auth-server";
import { searchInstrumentCandidates } from "../../../../lib/asset-catalog-server";

// RECHERCHE D'UN ACTIF COTÉ — remplace la saisie libre Nom / Ticker / ISIN / Devise.
//
// Ouverte à tout membre de la famille : elle ne renvoie que des métadonnées PUBLIQUES d'instrument
// (nom, ISIN, place, devise, cours). Aucune quantité, aucun montant, aucun compte, aucun nom de
// membre ne transite — la recherche d'un autre membre ne révèle donc rien de son patrimoine.
//
// C'est la SEULE porte vers le fournisseur : le navigateur n'appelle jamais Yahoo ni EODHD
// directement, et aucune clé fournisseur ne quitte le serveur.
//
// `accountId` sert uniquement à remonter les actifs déjà détenus dans ce compte en tête de liste.
// Il n'ouvre aucun accès : au pire il ne correspond à rien et le classement est simplement moins
// pertinent — la route ne lit ni solde ni opération financière, seulement des `asset_id`.

export const runtime = "nodejs";

const MIN_QUERY_LENGTH = 2;

export async function GET(request: Request) {
  try {
    const viewer = await requireFamilyMember(request);
    const params = new URL(request.url).searchParams;
    const query = (params.get("q") ?? "").trim();
    const accountId = (params.get("accountId") ?? "").trim() || null;

    if (query.length < MIN_QUERY_LENGTH) {
      return Response.json({ results: [], query, tooShort: true });
    }

    const memberIds = (await viewableMemberIds(viewer)) ?? [viewer.id];
    const outcome = await searchInstrumentCandidates(query, { accountId, memberIds });

    if (outcome.candidates.length === 0 && outcome.providerUnavailable) {
      // On distingue « rien trouvé » d'« indisponible » : le premier invite à corriger la saisie,
      // le second à réessayer. Confondre les deux envoyait l'utilisateur corriger un ISIN correct.
      return Response.json(
        { results: [], query, error: "La recherche est momentanément indisponible. Réessayez dans quelques instants." },
        { status: 503 },
      );
    }

    return Response.json({ results: outcome.candidates, query });
  } catch (error) {
    // Aucune erreur brute Yahoo / EODHD / Supabase / SQL ne remonte à la modale.
    if (error instanceof Error && !/authentifi|autoris|session|token/i.test(error.message)) {
      return Response.json(
        { results: [], error: "La recherche est momentanément indisponible. Réessayez dans quelques instants." },
        { status: 503 },
      );
    }
    return authErrorResponse(error);
  }
}
