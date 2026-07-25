import { authErrorResponse, requireFamilyMember } from "../../../lib/auth-server";
import { supabaseRest } from "../../../lib/supabase-rest";
import { buildOperationRecord, type OperationInput } from "../../../lib/account-operation";
import { loadImportAccount } from "../../../lib/investment-import-server";
import { authorizeMemberOperation } from "../../../lib/investment-plan";
import { reconcileMemberForActive } from "../../../lib/challenges-service";
import { reconcileOnboardingForMember } from "../../../lib/onboarding-challenges-service";

// Saisie SELF-SERVICE d'un achat sur son PROPRE PEA / compte-titres, par le membre lui-même.
// Route SÉPARÉE de l'écriture admin (/api/pea/operations, requireAdmin) : celle-ci n'est pas
// modifiée ni affaiblie. Garanties de sécurité :
//  - requireFamilyMember identifie l'appelant ;
//  - member_id FORCÉ sur celui du compte porteur (jamais fourni par le navigateur) ;
//  - le compte doit APPARTENIR à l'appelant (financial_accounts.member_id === viewer.id) ;
//  - type limité à 'achat' ; compte PEA/securities uniquement ; compte archivé refusé ;
//  - validation partagée (validateOperation/buildOperationRecord), identique à l'admin ;
//  - source tracée 'member_manual' ; AUCUN point/défi n'est attribué ici.
// Le portefeuille reste dérivé des opérations : aucune quantité « totale » n'est écrite.

export const runtime = "nodejs";

function setupResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Erreur Supabase";
  if (message.includes("exchange_rate") || message.includes("taxes") || message.includes("PGRST204") || message.includes("_type_check") || message.includes("check constraint")) {
    return Response.json({ error: "La migration compte-titres (20260725_investment_multicurrency.sql) doit être appliquée dans Supabase.", setupRequired: true }, { status: 503 });
  }
  if (message.includes("account_operations") || message.includes("PGRST205")) {
    return Response.json({ error: "La migration des opérations (20260722_account_operations.sql) doit être appliquée dans Supabase.", setupRequired: true }, { status: 503 });
  }
  return authErrorResponse(error);
}

export async function POST(request: Request) {
  try {
    const viewer = await requireFamilyMember(request);
    const body = (await request.json()) as OperationInput & { accountId?: string };
    if (!body.accountId) return Response.json({ error: "Le compte est obligatoire." }, { status: 400 });

    // Identité + éligibilité du compte : chargées côté serveur, jamais fournies par le client.
    const account = await loadImportAccount(body.accountId);
    const auth = authorizeMemberOperation({
      account: account ? { memberId: account.memberId, accountType: account.accountType, isActive: account.isActive } : null,
      viewerId: viewer.id,
      type: body.type,
    });
    if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

    // member_id FORCÉ depuis le compte (== viewer.id, déjà vérifié) ; type forcé 'achat' ;
    // source tracée. Le corps ne peut pas injecter member_id (buildOperationRecord ne lit que
    // extras.memberId).
    const built = buildOperationRecord({ ...body, type: "achat" }, { memberId: account!.memberId, source: "member_manual" });
    if (!built.ok) return Response.json({ error: built.error }, { status: 400 });

    const rows = await supabaseRest<Array<{ id: string }>>("account_operations", {
      method: "POST",
      headers: { prefer: "return=representation" },
      body: JSON.stringify({ ...built.record, account_id: body.accountId }),
    });
    // Reconnaissance automatique du défi (best-effort) : un achat éligible fait progresser le
    // défi courant du membre. N'affecte jamais la réponse d'enregistrement de l'opération.
    try { await reconcileMemberForActive(account!.memberId); } catch { /* défis non déployés / réconciliation différée à l'ouverture de l'écran */ }
    // Reconnaissance automatique des missions « Ajoute ton portefeuille » / « Premier
    // investissement » (best-effort ; centralisée, indépendante du type de compte PEA/CTO).
    try { await reconcileOnboardingForMember(account!.memberId); } catch { /* best-effort */ }
    return Response.json({ saved: true, id: rows[0]?.id }, { status: 201 });
  } catch (error) {
    return setupResponse(error);
  }
}
