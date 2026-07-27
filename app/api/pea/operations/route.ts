import { authErrorResponse, requireAdmin } from "../../../../lib/auth-server";
import { supabaseRest } from "../../../../lib/supabase-rest";
import { buildOperationRecord, requiresAssetSelection, type OperationInput } from "../../../../lib/account-operation";
import { applySelection } from "../../../../lib/asset-catalog-server";
import { instrumentKeyOf } from "../../../../lib/investment-import";
import { loadImportAccount, loadImportContext, isOperationAccount } from "../../../../lib/investment-import-server";
import { reconcileMemberForActive } from "../../../../lib/challenges-service";
import { reconcileOnboardingForMember } from "../../../../lib/onboarding-challenges-service";

// Écriture des opérations de compte (PEA / compte-titres). Route GÉNÉRIQUE malgré son nom
// historique `/api/pea/operations` : elle sert le PEA ET le compte-titres. Admin uniquement
// (requireAdmin) ; le member_id est FORCÉ sur celui du compte porteur, jamais fourni par le
// client. La validation d'opération passe par la SOURCE DE VÉRITÉ partagée
// (lib/account-operation.ts::buildOperationRecord), identique à l'import. Le portefeuille reste
// dérivé des opérations : aucune route ne modifie directement une quantité « totale ».
//
// Gardes serveur ajoutées : compte introuvable / de type incompatible / archivé, et — pour un
// PEA — refus d'une vente supérieure à la quantité détenue (dérivée des opérations existantes).
//
// Verbes :
//   POST   — créer une opération
//   PATCH  — MODIFIER une opération existante (même validation ; compte et titulaire immuables)
//   DELETE — supprimer : ?id= (une), ?ids=a,b,c (plusieurs, ex. toute une position),
//            ou ?accountId=…&scope=all&confirm=<nom du compte> (vider le compte)

export const runtime = "nodejs";

type OperationRow = { id: string; account_id: string; member_id: string };

type OperationBody = OperationInput & { accountId?: string; selection?: unknown };

/**
 * Remplace l'identité libre du corps de requête par celle de la COTATION SÉLECTIONNÉE, et la
 * matérialise en base (actif canonique + cotation) pour obtenir `asset_id` / `listing_id`.
 *
 * `requireSelection` n'est vrai qu'à la CRÉATION : en modification, une opération historique sans
 * identité stable doit rester corrigeable (quantité, prix, frais) sans qu'on la rattache d'office
 * à un actif deviné — le cahier interdit de réécrire silencieusement une ligne financière.
 */
async function resolveIdentity(body: OperationBody, type: string, requireSelection: boolean):
  Promise<{ ok: true; input: OperationInput } | { ok: false; status: number; error: string }> {
  const applied = await applySelection(body.selection);
  if (applied && !applied.ok) return { ok: false, status: 422, error: applied.error };
  if (applied) return { ok: true, input: { ...body, ...applied.fields } };
  if (requireSelection && requiresAssetSelection(type)) {
    return { ok: false, status: 400, error: "Sélectionnez un actif dans la liste avant d'enregistrer." };
  }
  return { ok: true, input: body };
}

function setupResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Erreur Supabase";
  if (message.includes("exchange_rate") || message.includes("taxes") || message.includes("PGRST204") || message.includes("_type_check") || message.includes("check constraint")) {
    return Response.json({ error: "La migration compte-titres (20260725_investment_multicurrency.sql) doit être appliquée dans Supabase (devise, transferts, taxes).", setupRequired: true }, { status: 503 });
  }
  if (message.includes("account_operations") || message.includes("PGRST205")) {
    return Response.json({ error: "La migration des opérations (20260722_account_operations.sql) doit être appliquée dans Supabase.", setupRequired: true }, { status: 503 });
  }
  return authErrorResponse(error);
}

export async function POST(request: Request) {
  try {
    await requireAdmin(request);
    const body = (await request.json()) as OperationBody;
    if (!body.accountId) return Response.json({ error: "Le compte est obligatoire." }, { status: 400 });

    // Identité + éligibilité du compte (jamais fournies par le client).
    const account = await loadImportAccount(body.accountId);
    if (!account) return Response.json({ error: "Compte introuvable." }, { status: 404 });
    if (!isOperationAccount(account.accountType)) return Response.json({ error: "Ce type de compte n'accepte pas d'opérations (PEA ou compte-titres uniquement)." }, { status: 400 });
    if (!account.isActive) return Response.json({ error: "Ce compte est archivé : réactivez-le avant d'enregistrer une opération." }, { status: 409 });

    const type = (body.type ?? "").trim();

    // L'identité est résolue AVANT la garde de vente : la garde doit raisonner sur la même clé
    // d'instrument que celle qui sera enregistrée, sinon un ticker libre contradictoire lui ferait
    // comparer la quantité demandée à celle d'une autre position.
    const identity = await resolveIdentity(body, type, true);
    if (!identity.ok) return Response.json({ error: identity.error }, { status: identity.status });
    const input = identity.input;

    // Garde PEA : une vente / sortie de titres ne peut excéder la quantité détenue.
    if (account.accountType === "pea" && (type === "vente" || type === "transfer_out")) {
      const context = await loadImportContext(account);
      const key = instrumentKeyOf({ isin: input.isin ?? null, ticker: input.ticker ?? null, instrumentName: input.assetName ?? null });
      const held = context.openingQuantities[key] ?? 0;
      const wanted = Number(input.quantity ?? 0);
      if (wanted > held + 1e-9) {
        return Response.json({ error: `Vente impossible : ${wanted} demandé(s) pour ${held} détenu(s) sur ce PEA.` }, { status: 422 });
      }
    }

    const built = buildOperationRecord(input, { memberId: account.memberId, source: body.source?.trim() || "saisie manuelle" });
    if (!built.ok) return Response.json({ error: built.error }, { status: 400 });

    const rows = await supabaseRest<Array<{ id: string }>>("account_operations", {
      method: "POST",
      headers: { prefer: "return=representation" },
      body: JSON.stringify({ ...built.record, account_id: body.accountId }),
    });
    // Reconnaissance automatique du défi du membre porteur (best-effort ; n'affecte pas la réponse).
    try { await reconcileMemberForActive(account.memberId); } catch { /* défis non déployés / réconciliation différée */ }
    // Reconnaissance automatique des missions « Bien démarrer » du membre porteur (best-effort).
    try { await reconcileOnboardingForMember(account.memberId); } catch { /* best-effort */ }
    return Response.json({ saved: true, id: rows[0]?.id }, { status: 201 });
  } catch (error) {
    return setupResponse(error);
  }
}

// ------------------------------------------------------------------------------------------
// PATCH — modification d'une opération existante
// ------------------------------------------------------------------------------------------
// Le compte porteur et le titulaire NE SONT PAS modifiables (une opération ne « déménage » pas
// d'un compte à l'autre : on la supprime et on la ressaisit). Tout le reste repasse par la même
// validation que la création. La garde PEA « vente > détenu » est rejouée en EXCLUANT la ligne
// en cours de modification, sinon elle se bloquerait elle-même.
export async function PATCH(request: Request) {
  try {
    await requireAdmin(request);
    const body = (await request.json()) as OperationBody & { id?: string };
    const id = String(body.id ?? "").trim();
    if (!id) return Response.json({ error: "Opération manquante." }, { status: 400 });

    const existing = await supabaseRest<OperationRow[]>(
      `account_operations?select=id,account_id,member_id&id=eq.${encodeURIComponent(id)}&limit=1`,
    );
    const current = existing[0];
    if (!current) return Response.json({ error: "Opération introuvable." }, { status: 404 });

    const account = await loadImportAccount(current.account_id);
    if (!account) return Response.json({ error: "Compte introuvable." }, { status: 404 });
    if (!isOperationAccount(account.accountType)) return Response.json({ error: "Ce type de compte n'accepte pas d'opérations (PEA ou compte-titres uniquement)." }, { status: 400 });
    if (!account.isActive) return Response.json({ error: "Ce compte est archivé : réactivez-le avant de modifier une opération." }, { status: 409 });

    const type = (body.type ?? "").trim();

    // Sélection FACULTATIVE en modification : si l'utilisateur en fournit une, elle rattache la
    // ligne à une identité stable ; sinon l'opération garde exactement ses références d'origine
    // (asset_id / listing_id ne sont alors pas dans le patch, donc pas écrasés).
    const identity = await resolveIdentity(body, type, false);
    if (!identity.ok) return Response.json({ error: identity.error }, { status: identity.status });
    const input = identity.input;

    if (account.accountType === "pea" && (type === "vente" || type === "transfer_out")) {
      const context = await loadImportContext(account, { excludeOperationIds: [id] });
      const key = instrumentKeyOf({ isin: input.isin ?? null, ticker: input.ticker ?? null, instrumentName: input.assetName ?? null });
      const held = context.openingQuantities[key] ?? 0;
      const wanted = Number(input.quantity ?? 0);
      if (wanted > held + 1e-9) {
        return Response.json({ error: `Vente impossible : ${wanted} demandé(s) pour ${held} détenu(s) sur ce PEA (hors cette ligne).` }, { status: 422 });
      }
    }

    // member_id repris de la ligne existante (jamais du client), source explicitée : une ligne
    // importée puis corrigée à la main ne doit plus se présenter comme une donnée brute d'import.
    const built = buildOperationRecord(input, { memberId: current.member_id, source: body.source?.trim() || "saisie manuelle (modifiée)" });
    if (!built.ok) return Response.json({ error: built.error }, { status: 400 });

    // account_id / member_id retirés du patch : immuables par construction.
    const { member_id: _member, ...changes } = built.record as Record<string, unknown> & { member_id?: unknown };
    void _member;
    // L'empreinte d'import ne décrit plus le contenu après correction : on la neutralise pour ne
    // pas faire échouer (ni faussement réussir) un dédoublonnage ultérieur.
    await patchOperation(id, { ...changes, import_fingerprint: null });

    try { await reconcileMemberForActive(current.member_id); } catch { /* best-effort */ }
    try { await reconcileOnboardingForMember(current.member_id); } catch { /* best-effort */ }
    return Response.json({ updated: true, id });
  } catch (error) {
    return setupResponse(error);
  }
}

/** PATCH tolérant : réessaie sans les colonnes d'import si la migration 20260726 n'est pas jouée. */
async function patchOperation(id: string, changes: Record<string, unknown>) {
  const path = `account_operations?id=eq.${encodeURIComponent(id)}`;
  try {
    await supabaseRest(path, { method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify(changes) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!/import_fingerprint|external_reference|42703|PGRST204/.test(message)) throw error;
    const { import_fingerprint: _fp, external_reference: _ref, ...rest } = changes;
    void _fp; void _ref;
    await supabaseRest(path, { method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify(rest) });
  }
}

// ------------------------------------------------------------------------------------------
// DELETE — une opération, un lot d'opérations (position entière), ou tout un compte
// ------------------------------------------------------------------------------------------
export async function DELETE(request: Request) {
  try {
    await requireAdmin(request);
    const params = new URL(request.url).searchParams;
    const id = params.get("id");
    const idsRaw = params.get("ids");
    const accountId = params.get("accountId");
    const scope = params.get("scope");

    // ---- Vidage complet d'un compte (destructif : confirmation explicite exigée) ----
    if (scope === "all") {
      if (!accountId) return Response.json({ error: "Le compte est obligatoire." }, { status: 400 });
      const account = await loadImportAccount(accountId);
      if (!account) return Response.json({ error: "Compte introuvable." }, { status: 404 });
      // Garde-fou anti-clic accidentel : le nom exact du compte doit être renvoyé par l'appelant.
      const confirm = (params.get("confirm") ?? "").trim();
      if (confirm !== account.name.trim()) {
        return Response.json({ error: `Confirmation requise : saisissez le nom exact du compte (« ${account.name} »).` }, { status: 428 });
      }
      const rows = await supabaseRest<Array<{ id: string }>>(
        `account_operations?account_id=eq.${encodeURIComponent(account.id)}`,
        { method: "DELETE", headers: { prefer: "return=representation" } },
      );
      const removed = rows?.length ?? 0;
      try { await reconcileMemberForActive(account.memberId); } catch { /* best-effort */ }
      try { await reconcileOnboardingForMember(account.memberId); } catch { /* best-effort */ }
      return Response.json({ deleted: true, removed });
    }

    // ---- Suppression ciblée (une ou plusieurs lignes, ex. toutes celles d'une position) ----
    const ids = [...new Set([...(id ? [id] : []), ...(idsRaw ? idsRaw.split(",") : [])].map((value) => value.trim()).filter(Boolean))];
    if (ids.length === 0) return Response.json({ error: "Opération manquante." }, { status: 400 });
    if (ids.length > 500) return Response.json({ error: "Trop d'opérations en une fois (max 500)." }, { status: 413 });

    const list = ids.map((value) => encodeURIComponent(value)).join(",");
    // Membres porteurs (avant suppression) pour recalculer leur progression de défi ensuite.
    const owners = await supabaseRest<Array<{ member_id: string }>>(
      `account_operations?select=member_id&id=in.(${list})`,
    ).catch(() => [] as Array<{ member_id: string }>);

    const removedRows = await supabaseRest<Array<{ id: string }>>(`account_operations?id=in.(${list})`, {
      method: "DELETE",
      headers: { prefer: "return=representation" },
    });

    // La suppression retire le lien (cascade) : on recalcule la progression et, si elle repasse
    // sous l'objectif, une écriture négative de compensation est créée (best-effort).
    for (const memberId of new Set((owners ?? []).map((owner) => owner.member_id))) {
      try { await reconcileMemberForActive(memberId); } catch { /* best-effort */ }
    }
    return Response.json({ deleted: true, removed: removedRows?.length ?? ids.length });
  } catch (error) {
    return setupResponse(error);
  }
}
