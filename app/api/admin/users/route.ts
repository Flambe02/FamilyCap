import { createClient } from "@supabase/supabase-js";
import { authErrorResponse } from "../../../../lib/auth-server";
import { requireConsoleSuperAdmin } from "../../../../lib/admin-console-auth";
import { assertNotLastSuperAdmin } from "../../../../lib/admin-super-admin";
import { writeAdminAudit } from "../../../../lib/admin-audit";
import { firstReceiveAddress, isExtendedKey } from "../../../../lib/bitcoin-xpub";
import { supabaseRest } from "../../../../lib/supabase-rest";

type RuntimeEnv = { SUPABASE_URL?: string; SUPABASE_SECRET_KEY?: string };
type DbRole = "admin" | "adult" | "child" | "viewer";
type ConsoleRole = "super_admin" | "admin" | "member" | "viewer";
type Member = { id: string; email: string | null; auth_user_id: string | null; role: DbRole; name: string; is_active?: boolean; access_status?: string; deleted_at?: string | null };
type Product = "bitcoin" | "pea" | "cto" | "gifts" | "videos" | "operations";
type AccessLevel = "none" | "read" | "contribute" | "admin";
type ProductAccess = Partial<Record<Product, AccessLevel>>;
const PRIMARY_ADMIN_EMAIL = "florent.lambert@gmail.com";
const PRODUCTS: Product[] = ["bitcoin", "pea", "cto", "gifts", "videos", "operations"];

function adminClient() {
  const runtime: RuntimeEnv = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY };
  if (!runtime.SUPABASE_URL || !runtime.SUPABASE_SECRET_KEY) throw new Error("Supabase Admin non configure");
  return createClient(runtime.SUPABASE_URL, runtime.SUPABASE_SECRET_KEY, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } });
}

function isPrimaryAdmin(member: Pick<Member, "email">) { return member.email?.toLowerCase() === PRIMARY_ADMIN_EMAIL; }
function roleToDb(role?: string): DbRole { return role === "admin" || role === "super_admin" ? "admin" : role === "viewer" ? "viewer" : "adult"; }
function dbRoleToConsole(role: string): ConsoleRole { return role === "admin" ? "admin" : role === "viewer" ? "viewer" : "member"; }
function birthdayParts(value?: string | null) {
  const iso = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const short = value?.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/);
  const year = iso ? Number(iso[1]) : short?.[3] ? Number(short[3]) : null;
  const month = iso ? Number(iso[2]) : short ? Number(short[2]) : null;
  const day = iso ? Number(iso[3]) : short ? Number(short[1]) : null;
  if (month !== null && day !== null && month >= 1 && month <= 12 && day >= 1 && day <= 31 && (year === null || (year >= 1900 && year <= new Date().getFullYear()))) return { year, month, day };
  return { year: null, month: null, day: null };
}

async function findMember(id: string): Promise<Member | null> {
  const rows = await supabaseRest<Member[]>("family_members?select=id,name,email,auth_user_id,role,is_active,access_status,deleted_at&id=eq." + encodeURIComponent(id) + "&limit=1");
  return rows[0] ?? null;
}
async function findMemberByEmail(email: string): Promise<Member | null> {
  const rows = await supabaseRest<Member[]>("family_members?select=id,name,email,auth_user_id,role,is_active,access_status,deleted_at&email=ilike." + encodeURIComponent(email) + "&limit=1");
  return rows[0] ?? null;
}
async function audit(actorId: string, targetId: string, action: string, beforeValues?: Record<string, unknown>, afterValues?: Record<string, unknown>, metadata?: Record<string, unknown>) {
  // Une migration non encore déployée ne doit pas rendre l'administration inutilisable.
  // Dès que la table existe, chaque action est journalisée côté serveur.
  await writeAdminAudit({ actorMemberId: actorId, targetMemberId: targetId, action, beforeValues, afterValues, metadata }).catch(() => undefined);
}

const BTC_ADDRESS_RE = /^(bc1[a-zA-HJ-NP-Z0-9]{25,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,61})$/;
function upsertWallet(record: Record<string, unknown>) { return supabaseRest("wallets?on_conflict=member_id", { method: "POST", headers: { prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(record) }); }
async function saveWallet(memberId: string, memberName: string, walletAddress?: string) {
  if (walletAddress === undefined) return;
  const trimmed = walletAddress.trim();
  if (!trimmed) { await supabaseRest("wallets?member_id=eq." + encodeURIComponent(memberId), { method: "DELETE", headers: { prefer: "return=minimal" } }); return; }
  let publicAddress = trimmed; let xpub: string | null = null;
  if (isExtendedKey(trimmed)) { try { publicAddress = firstReceiveAddress(trimmed); } catch { throw new Error("Cle publique etendue (xpub/ypub/zpub) invalide."); } xpub = trimmed; }
  else if (!BTC_ADDRESS_RE.test(trimmed)) throw new Error("Adresse Bitcoin ou cle publique etendue (xpub/ypub/zpub) invalide.");
  const record: Record<string, unknown> = { member_id: memberId, member_name: memberName, label: "Ledger de " + memberName, custody: "Ledger", public_address: publicAddress, xpub, network: "bitcoin-mainnet", asset_code: "BTC" };
  try { await upsertWallet(record); } catch (error) {
    if (error instanceof Error && /42P10|ON CONFLICT|unique|exclusion constraint/i.test(error.message)) throw new Error("La contrainte unique wallets(member_id) manque. Executez la migration 20260802_admin_upsert_constraints.sql dans Supabase.");
    const missingXpubColumn = error instanceof Error && /xpub/i.test(error.message) && /(PGRST|column|schema cache)/i.test(error.message);
    if (missingXpubColumn && xpub === null) { const withoutXpub = { ...record }; delete withoutXpub.xpub; await upsertWallet(withoutXpub); return; }
    if (missingXpubColumn) throw new Error("Suivi xpub indisponible : jouez d'abord la migration 20260727_wallet_xpub.sql dans Supabase.");
    throw error;
  }
}

async function saveAccess(memberId: string, scope?: string, selectedIds?: unknown) {
  if (scope === undefined) return;
  if (scope !== "family" && scope !== "selected") throw new Error("Niveau de partage invalide.");
  const members = await supabaseRest<Array<{ id: string; is_active: boolean }>>("family_members?select=id,is_active&is_active=eq.true");
  const allowed = new Set(members.filter((member) => member.id !== memberId).map((member) => member.id));
  const ids = Array.isArray(selectedIds) ? [...new Set(selectedIds.filter((id): id is string => typeof id === "string"))].filter((id) => allowed.has(id)) : [];
  if (scope === "selected" && !ids.length) throw new Error("Selectionnez au moins une personne.");
  await supabaseRest("family_members?id=eq." + encodeURIComponent(memberId), { method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify({ investment_access_scope: scope }) });
  await supabaseRest("investment_access_grants?owner_member_id=eq." + encodeURIComponent(memberId), { method: "DELETE", headers: { prefer: "return=minimal" } });
  if (scope === "selected") await supabaseRest("investment_access_grants", { method: "POST", headers: { prefer: "return=minimal" }, body: JSON.stringify(ids.map((viewerMemberId) => ({ owner_member_id: memberId, viewer_member_id: viewerMemberId }))) });
}

async function saveProductAccess(memberId: string, access?: ProductAccess) {
  if (!access) return;
  const rows = PRODUCTS.map((product) => ({ member_id: memberId, product, access_level: access[product] ?? "none" }));
  try {
    await supabaseRest("member_product_access?on_conflict=member_id,product", { method: "POST", headers: { prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(rows) });
  } catch (error) {
    if (error instanceof Error && /42P10|ON CONFLICT|unique|exclusion constraint/i.test(error.message)) throw new Error("La contrainte unique member_product_access(member_id, product) manque. Executez la migration 20260802_admin_upsert_constraints.sql dans Supabase.");
    throw error;
  }
}
async function saveInvitation(memberId: string, email: string, status: string, actorId: string, sent: boolean) {
  await supabaseRest("invitations?member_id=eq." + encodeURIComponent(memberId) + "&status=in.(pending,sent)", { method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify({ status: "cancelled" }) }).catch(() => undefined);
  await supabaseRest("invitations", { method: "POST", headers: { prefer: "return=minimal" }, body: JSON.stringify({ member_id: memberId, email, status, sent_at: sent ? new Date().toISOString() : null, expires_at: sent ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() : null, created_by: actorId }) });
}

async function listProducts() { return supabaseRest<Array<{ member_id: string; product: Product; access_level: AccessLevel }>>("member_product_access?select=member_id,product,access_level").catch(() => []); }
async function listInvitations() { return supabaseRest<Array<{ id: string; member_id: string; email: string; status: string; sent_at: string | null; expires_at: string | null; accepted_at: string | null; created_at: string }>>("invitations?select=id,member_id,email,status,sent_at,expires_at,accepted_at,created_at&order=created_at.desc").catch(() => []); }

function isAdminConsoleSchemaError(error: unknown) {
  return error instanceof Error && /(family_members\.(deleted_at|deleted_by|relationship)|relation .*?(profiles|user_roles|member_product_access|invitations|admin_audit_log).*does not exist|column .* does not exist|Could not find the table .*?(profiles|user_roles|member_product_access|invitations|admin_audit_log).*schema cache)/i.test(error.message);
}

async function assertAdminConsoleSchema() {
  try {
    await Promise.all([
      supabaseRest("family_members?select=id,deleted_at,deleted_by,relationship&limit=1"),
      supabaseRest("profiles?select=user_id&limit=1"),
      supabaseRest("user_roles?select=user_id&limit=1"),
      supabaseRest("member_product_access?select=member_id&limit=1"),
      supabaseRest("invitations?select=id&limit=1"),
      supabaseRest("admin_audit_log?select=id&limit=1"),
    ]);
  } catch (error) {
    if (isAdminConsoleSchemaError(error)) {
      throw new Error("La migration Supabase 20260801_admin_family_console.sql n'est pas appliquee. Executez-la dans le projet Supabase avant de creer un membre.");
    }
    throw error;
  }
}

export async function GET(request: Request) {
  try {
    await requireConsoleSuperAdmin(request);
    const admin = adminClient();
    const [members, grants, products, invitations, authResult, roles, profiles] = await Promise.all([
      supabaseRest<Array<Record<string, unknown> & { id: string; auth_user_id?: string; wallets: Array<{ public_address: string | null; xpub: string | null }> }>>("family_members?select=*,wallets(public_address,xpub)&order=name.asc"),
      supabaseRest<Array<{ owner_member_id: string; viewer_member_id: string }>>("investment_access_grants?select=owner_member_id,viewer_member_id").catch(() => []),
      listProducts(), listInvitations(), admin.auth.admin.listUsers({ page: 1, perPage: 1000 }),
      supabaseRest<Array<{ user_id: string; role: ConsoleRole }>>("user_roles?select=user_id,role").catch(() => []),
      supabaseRest<Array<{ user_id: string; member_id: string | null; relationship: string | null }>>("profiles?select=user_id,member_id,relationship").catch(() => []),
    ]);
    if (authResult.error) throw authResult.error;
    const authById = new Map(authResult.data.users.map((user) => [user.id, user]));
    const roleByUser = new Map(roles.map((role) => [role.user_id, role.role]));
    const profileByMember = new Map(profiles.map((profile) => [profile.member_id, profile]));
    const linkedAuthIds = new Set(members.map((member) => String(member.auth_user_id ?? "")).filter(Boolean));
    const mfa = await Promise.all(authResult.data.users.filter((user) => linkedAuthIds.has(user.id)).map(async (user) => {
      try { const result = await admin.auth.admin.mfa.listFactors({ userId: user.id }); return [user.id, result.data?.factors?.some((factor) => factor.status === "verified") ?? false] as const; } catch { return [user.id, false] as const; }
    }));
    const mfaById = new Map(mfa);
    return Response.json({ users: members.map((member) => {
      const authUser = member.auth_user_id ? authById.get(String(member.auth_user_id)) : undefined;
      const invitation = invitations.find((item) => item.member_id === member.id && ["pending", "sent"].includes(item.status)) ?? invitations.find((item) => item.member_id === member.id);
      const role = authUser ? roleByUser.get(authUser.id) ?? (isPrimaryAdmin({ email: String(member.email ?? "") }) ? "super_admin" : dbRoleToConsole(String(member.role))) : dbRoleToConsole(String(member.role));
      const { wallets, ...rest } = member;
      return {
        ...rest,
        role,
        relationship: String(member.relationship ?? profileByMember.get(member.id)?.relationship ?? ""),
        wallet_address: wallets?.[0]?.xpub ?? wallets?.[0]?.public_address ?? null,
        selected_viewer_ids: grants.filter((grant) => grant.owner_member_id === member.id).map((grant) => grant.viewer_member_id),
        product_access: Object.fromEntries(products.filter((item) => item.member_id === member.id).map((item) => [item.product, item.access_level])),
        invitation: invitation ? { id: invitation.id, status: invitation.status, sentAt: invitation.sent_at, expiresAt: invitation.expires_at, acceptedAt: invitation.accepted_at } : null,
        auth: authUser ? { id: authUser.id, createdAt: authUser.created_at, emailConfirmedAt: authUser.email_confirmed_at, lastSignInAt: authUser.last_sign_in_at, providers: authUser.identities?.map((identity) => identity.provider) ?? [], mfaConfigured: mfaById.get(authUser.id) ?? false, bannedUntil: authUser.banned_until ?? null } : null,
      };
    }) });
  } catch (error) { return authErrorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const actor = await requireConsoleSuperAdmin(request);
    await assertAdminConsoleSchema();
    const body = await request.json() as { memberId?: string; name?: string; email?: string; role?: string; birthday?: string; relationship?: string; accessScope?: string; selectedViewerIds?: unknown; productAccess?: ProductAccess; sendInvite?: boolean; redirectTo?: string };
    const name = body.name?.trim() ?? ""; const email = body.email?.trim().toLowerCase() ?? "";
    if (!name || !/^\S+@\S+\.\S+$/.test(email)) return Response.json({ error: "Nom et e-mail valides obligatoires." }, { status: 400 });
    if (email === PRIMARY_ADMIN_EMAIL && body.memberId === undefined) return Response.json({ error: "Le compte administrateur principal existe deja." }, { status: 409 });
    const birthday = birthdayParts(body.birthday);
    let member = body.memberId ? await findMember(body.memberId) : await findMemberByEmail(email);
    if (body.memberId && !member) return Response.json({ error: "Membre introuvable." }, { status: 404 });
    if (member) {
      await supabaseRest("family_members?id=eq." + encodeURIComponent(member.id), { method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify({ name, email, role: roleToDb(body.role), relationship: body.relationship ?? null, birthday_day: birthday.day, birthday_month: birthday.month, birthday_year: birthday.year, is_active: true, access_status: body.sendInvite ? "invited" : "allowed", deleted_at: null }) });
    } else {
      const rows = await supabaseRest<Array<{ id: string }>>("family_members", { method: "POST", headers: { prefer: "return=representation" }, body: JSON.stringify({ name, email, role: roleToDb(body.role), relationship: body.relationship ?? null, birthday_day: birthday.day, birthday_month: birthday.month, birthday_year: birthday.year, is_active: true, access_status: body.sendInvite ? "invited" : "allowed" }) });
      member = { id: rows[0].id, name, email, auth_user_id: null, role: roleToDb(body.role), is_active: true };
    }
    await saveAccess(member.id, body.accessScope, body.selectedViewerIds);
    await saveProductAccess(member.id, body.productAccess);
    if (body.relationship && member.auth_user_id) await supabaseRest("profiles?on_conflict=user_id", { method: "POST", headers: { prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ user_id: member.auth_user_id, member_id: member.id, relationship: body.relationship }) }).catch(() => undefined);
    let invitation = { sent: false, reason: undefined as string | undefined };
    if (body.sendInvite !== false) {
      const { error } = await adminClient().auth.admin.inviteUserByEmail(email, { data: { name, family_member_id: member.id }, redirectTo: body.redirectTo });
      invitation = error ? { sent: false, reason: error.message } : { sent: true, reason: undefined };
      await saveInvitation(member.id, email, error ? "failed" : "sent", actor.id, !error).catch(() => undefined);
      if (error) { await supabaseRest("family_members?id=" + encodeURIComponent(member.id), { method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify({ access_status: "invitation_failed" }) }); return Response.json({ saved: true, id: member.id, invitation, error: "Le membre a ete enregistre, mais l'invitation n'a pas ete envoyee : " + error.message }, { status: 502 }); }
    }
    await audit(actor.id, member.id, "invitation.created", undefined, { role: body.role ?? roleToDb(member.role), accessScope: body.accessScope ?? "family" }, { emailDomain: email.split("@")[1], invitationSent: invitation.sent });
    return Response.json({ saved: true, id: member.id, invitation }, { status: 201 });
  } catch (error) {
    if (isAdminConsoleSchemaError(error) || error instanceof Error && error.message.includes("20260801_admin_family_console.sql")) {
      return Response.json({ error: error instanceof Error ? error.message : "Migration Supabase requise." }, { status: 503 });
    }
    return authErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const actor = await requireConsoleSuperAdmin(request);
    const body = await request.json() as { id?: string; name?: string; email?: string; role?: string; birthday?: string | null; relationship?: string; isActive?: boolean; accessScope?: string; selectedViewerIds?: unknown; walletAddress?: string; productAccess?: ProductAccess };
    if (!body.id) return Response.json({ error: "Utilisateur manquant." }, { status: 400 });
    const member = await findMember(body.id); if (!member) return Response.json({ error: "Membre introuvable." }, { status: 404 });
    if (isPrimaryAdmin(member) && (body.role !== undefined || body.isActive !== undefined || body.email !== undefined)) return Response.json({ error: "Le compte administrateur principal est protege." }, { status: 403 });
    const requestedRole = body.role as ConsoleRole | undefined;
    if (requestedRole === "super_admin" && !member.auth_user_id) return Response.json({ error: "Un super administrateur doit d'abord disposer d'un compte Auth." }, { status: 400 });
    if (member.auth_user_id && (requestedRole === "super_admin" || (member.role === "admin" && requestedRole && requestedRole !== "admin"))) {
      const roles = await supabaseRest<Array<{ user_id: string; role: ConsoleRole }>>("user_roles?select=user_id,role").catch(() => []);
      const superCount = roles.filter((role) => role.role === "super_admin").length + (roles.some((role) => role.user_id === member.auth_user_id && role.role === "super_admin") ? 0 : isPrimaryAdmin(member) ? 1 : 0);
      const targetIsSuperAdmin = roles.some((role) => role.user_id === member.auth_user_id && role.role === "super_admin") || isPrimaryAdmin(member);
      if (body.role !== undefined && body.role !== "admin" && targetIsSuperAdmin && superCount <= 1) return Response.json({ error: "Le dernier super administrateur ne peut pas etre retrograde." }, { status: 403 });
    }
    const changes: Record<string, unknown> = {};
    if (body.name !== undefined) { const name = body.name.trim(); if (!name) return Response.json({ error: "Le nom est obligatoire." }, { status: 400 }); changes.name = name; }
    if (body.email !== undefined) {
      const email = body.email.trim().toLowerCase();
      if (!email) { if (!member.auth_user_id) changes.email = null; }
      else if (!/^\S+@\S+\.\S+$/.test(email)) return Response.json({ error: "Adresse e-mail invalide." }, { status: 400 });
      else { if (member.auth_user_id && email !== member.email?.toLowerCase()) { const { error } = await adminClient().auth.admin.updateUserById(member.auth_user_id, { email }); if (error) throw error; } changes.email = email; }
    }
    if (requestedRole && ["super_admin", "admin", "member", "viewer"].includes(requestedRole)) changes.role = roleToDb(requestedRole);
    if (body.birthday !== undefined) { const birthday = birthdayParts(body.birthday); changes.birthday_day = birthday.day; changes.birthday_month = birthday.month; changes.birthday_year = birthday.year; }
    if (body.isActive !== undefined) changes.is_active = body.isActive;
    if (body.relationship !== undefined) changes.relationship = body.relationship.trim() || null;
    if (Object.keys(changes).length) await supabaseRest("family_members?id=eq." + encodeURIComponent(body.id), { method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify(changes) });
    await saveAccess(body.id, body.accessScope, body.selectedViewerIds); await saveProductAccess(body.id, body.productAccess); await saveWallet(body.id, (changes.name as string | undefined) ?? member.name, body.walletAddress);
    if (member.auth_user_id && requestedRole) await supabaseRest("user_roles?user_id=eq." + encodeURIComponent(member.auth_user_id), { method: "POST", headers: { prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ user_id: member.auth_user_id, member_id: body.id, role: requestedRole }) }).catch(() => undefined);
    if (member.auth_user_id && body.isActive !== undefined) { const { error } = await adminClient().auth.admin.updateUserById(member.auth_user_id, { ban_duration: body.isActive ? "none" : "876000h" }); if (error) throw error; }
    await audit(actor.id, body.id, "member.updated", { role: member.role, name: member.name, isActive: member.is_active }, { ...changes, requestedRole, accessScope: body.accessScope }, { productAccessChanged: Boolean(body.productAccess) });
    return Response.json({ updated: true });
  } catch (error) { return authErrorResponse(error); }
}

export async function DELETE(request: Request) {
  try {
    const actor = await requireConsoleSuperAdmin(request); const id = new URL(request.url).searchParams.get("id");
    if (!id) return Response.json({ error: "Utilisateur manquant." }, { status: 400 });
    const member = await findMember(id); if (!member) return Response.json({ error: "Membre introuvable." }, { status: 404 });
    if (isPrimaryAdmin(member) || (member.role === "admin" && !member.auth_user_id)) return Response.json({ error: "Le dernier super administrateur ne peut pas etre supprime." }, { status: 403 });
    await assertNotLastSuperAdmin(member);
    await supabaseRest("family_members?id=eq." + encodeURIComponent(id), { method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify({ is_active: false, access_status: "deleted", deleted_at: new Date().toISOString(), deleted_by: actor.id }) });
    if (member.auth_user_id) await adminClient().auth.admin.updateUserById(member.auth_user_id, { ban_duration: "876000h" });
    await audit(actor.id, id, "member.soft_deleted", { isActive: member.is_active }, { isActive: false, accessStatus: "deleted" });
    return Response.json({ deleted: true, softDeleted: true });
  } catch (error) { return authErrorResponse(error); }
}
