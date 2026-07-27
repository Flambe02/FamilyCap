import { authErrorResponse, requireFamilyMember } from "../../../lib/auth-server";
import { supabaseRest } from "../../../lib/supabase-rest";
import { reconcileOnboardingForMember } from "../../../lib/onboarding-challenges-service";

// Création SELF-SERVICE de son PROPRE PEA / compte-titres, par le membre lui-même.
//
// POURQUOI cette route existe : le parcours « Bien démarrer » demande au membre de configurer son
// PEA, mais la seule route de création (/api/admin/accounts) est requireAdmin. Le défi était donc
// littéralement impossible à terminer : ceux qui le voyaient (adult/child) ne pouvaient pas agir,
// et le seul qui pouvait agir (l'admin) ne voyait jamais le défi (isChallengeEligible).
//
// Route SÉPARÉE de l'écriture admin (/api/admin/accounts, requireAdmin) : celle-ci n'est ni
// modifiée ni affaiblie. Même patron que /api/investment-operations (achat self-service).
// Garanties de sécurité :
//  - requireFamilyMember identifie l'appelant ;
//  - member_id FORCÉ sur l'appelant (jamais lu depuis le corps de la requête) : un membre ne peut
//    pas créer un compte au nom d'un autre, même en forgeant la requête ;
//  - accountType limité à 'pea' | 'securities' (jamais bitcoin/bank/other, réservés à l'admin) ;
//  - CRÉATION uniquement : ni édition, ni archivage, ni suppression (restent admin) ;
//  - un garde-fou anti-doublon empêche d'empiler des comptes vides du même type ;
//  - aucun champ sensible n'est accepté (n° de compte, IBAN, wallet, solde de départ, notes) ;
//  - les points ne sont JAMAIS attribués ici : la réconciliation relit les faits réels en base
//    (reconcileOnboardingForMember), exactement comme pour la création admin.

export const runtime = "nodejs";

type SelfAccountInput = { name?: string; accountType?: string; institution?: string; openedAt?: string };

const SELF_SERVICE_TYPES = new Set(["pea", "securities"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TYPE_LABEL: Record<string, string> = { pea: "PEA", securities: "compte-titres" };

function setupResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Erreur Supabase";
  if (message.includes("opened_at")) {
    return Response.json({ error: "La migration compte-titres (20260725_investment_multicurrency.sql) doit être appliquée pour la date d'ouverture.", setupRequired: true }, { status: 503 });
  }
  if (message.includes("financial_accounts") || message.includes("PGRST205")) {
    return Response.json({ error: "La migration des comptes financiers doit être appliquée dans Supabase.", setupRequired: true }, { status: 503 });
  }
  return authErrorResponse(error);
}

export async function POST(request: Request) {
  try {
    const viewer = await requireFamilyMember(request);
    const body = (await request.json()) as SelfAccountInput;

    const accountType = body.accountType?.trim() ?? "";
    if (!SELF_SERVICE_TYPES.has(accountType)) {
      return Response.json({ error: "Seuls un PEA ou un compte-titres peuvent être créés ici." }, { status: 400 });
    }
    const name = body.name?.trim() || (accountType === "pea" ? "Mon PEA" : "Mon compte-titres");
    const institution = body.institution?.trim() ?? "";
    if (!institution) return Response.json({ error: "L’établissement financier est obligatoire." }, { status: 400 });
    if (body.openedAt && !ISO_DATE.test(body.openedAt)) {
      return Response.json({ error: "La date d’ouverture doit être au format AAAA-MM-JJ." }, { status: 400 });
    }
    // Une date d'ouverture dans le futur décrirait un compte qui n'existe pas encore.
    if (body.openedAt && body.openedAt > new Date().toISOString().slice(0, 10)) {
      return Response.json({ error: "La date d’ouverture ne peut pas être dans le futur." }, { status: 400 });
    }

    // Anti-doublon : on refuse un SECOND compte du même type tant que le premier ne porte aucune
    // opération. Sans cela, un double-clic ou un retour en arrière empilerait des coquilles vides
    // que le membre ne peut pas supprimer lui-même (la suppression reste admin).
    const existing = await supabaseRest<Array<{ id: string; name: string | null }>>(
      `financial_accounts?select=id,name&member_id=eq.${encodeURIComponent(viewer.id)}&account_type=eq.${encodeURIComponent(accountType)}&is_active=is.true`,
    );
    if (existing.length > 0) {
      const ids = existing.map((account) => account.id);
      const operations = await supabaseRest<Array<{ id: string }>>(
        `account_operations?select=id&account_id=in.(${ids.map(encodeURIComponent).join(",")})&limit=1`,
      ).catch(() => [] as Array<{ id: string }>);
      if (operations.length === 0) {
        return Response.json({
          error: `Un ${TYPE_LABEL[accountType]} est déjà enregistré à ton nom (${existing[0].name ?? TYPE_LABEL[accountType]}). Demande à l’administrateur si tu souhaites en ajouter un second.`,
          alreadyExists: true,
          accountId: existing[0].id,
        }, { status: 409 });
      }
    }

    // member_id FORCÉ : jamais lu depuis le corps. Aucun champ sensible n'est accepté ici.
    const record: Record<string, unknown> = {
      member_id: viewer.id,
      name,
      account_type: accountType,
      institution,
      currency: "EUR",
    };
    if (body.openedAt) record.opened_at = body.openedAt;

    const rows = await supabaseRest<Array<{ id: string }>>("financial_accounts", {
      method: "POST",
      headers: { prefer: "return=representation" },
      body: JSON.stringify(record),
    });

    // Reconnaissance de la mission « Configure ton PEA » : la réconciliation RELIT les faits réels
    // en base (le compte qui vient d'être créé), elle ne fabrique aucun point sur déclaration.
    // Best-effort : n'affecte jamais la réponse de création.
    try { await reconcileOnboardingForMember(viewer.id); } catch { /* missions non déployées */ }

    return Response.json({ saved: true, id: rows[0]?.id, accountType }, { status: 201 });
  } catch (error) {
    return setupResponse(error);
  }
}
