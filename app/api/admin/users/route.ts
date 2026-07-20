import { createClient } from "@supabase/supabase-js";
import { authErrorResponse, requireAdmin } from "../../../../lib/auth-server";
import { supabaseRest } from "../../../../lib/supabase-rest";

type RuntimeEnv = { SUPABASE_URL?: string; SUPABASE_SECRET_KEY?: string };
type Member = { id: string; email: string | null; auth_user_id: string | null; role: string; name: string; is_active?: boolean };
const PRIMARY_ADMIN_EMAIL = "florent.lambert@gmail.com";
function adminClient() { const runtime: RuntimeEnv = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY }; if (!runtime.SUPABASE_URL || !runtime.SUPABASE_SECRET_KEY) throw new Error("Supabase Admin non configure"); return createClient(runtime.SUPABASE_URL, runtime.SUPABASE_SECRET_KEY, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } }); }
async function findMember(id: string): Promise<Member | null> { const rows = await supabaseRest<Member[]>("family_members?select=id,name,email,auth_user_id,role,is_active&id=eq." + encodeURIComponent(id) + "&limit=1"); return rows[0] ?? null; }
function isPrimaryAdmin(member: Member) { return member.email?.toLowerCase() === PRIMARY_ADMIN_EMAIL; }
function birthdayParts(value?: string | null) { const iso = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/); const short = value?.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/); const year = iso ? Number(iso[1]) : short?.[3] ? Number(short[3]) : null; const month = iso ? Number(iso[2]) : short ? Number(short[2]) : null; const day = iso ? Number(iso[3]) : short ? Number(short[1]) : null; if (month !== null && day !== null && month >= 1 && month <= 12 && day >= 1 && day <= 31 && (year === null || (year >= 1900 && year <= new Date().getFullYear()))) return { year, month, day }; return { year: null, month: null, day: null }; }
const BTC_ADDRESS_RE = /^(bc1[a-zA-HJ-NP-Z0-9]{25,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,61})$/;
async function saveWallet(memberId: string, memberName: string, walletAddress?: string) {
  if (walletAddress === undefined) return;
  const trimmed = walletAddress.trim();
  if (!trimmed) {
    await supabaseRest("wallets?member_id=eq." + encodeURIComponent(memberId), { method: "DELETE", headers: { prefer: "return=minimal" } });
    return;
  }
  if (!BTC_ADDRESS_RE.test(trimmed)) throw new Error("Adresse Bitcoin publique invalide.");
  await supabaseRest("wallets?on_conflict=member_id", {
    method: "POST",
    headers: { prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ member_id: memberId, member_name: memberName, label: "Ledger de " + memberName, custody: "Ledger", public_address: trimmed, network: "bitcoin-mainnet", asset_code: "BTC" }),
  });
}

async function saveAccess(memberId: string, scope?: string, selectedIds?: unknown) {
  if (scope === undefined) return;
  if (scope !== "family" && scope !== "selected") throw new Error("Niveau de partage invalide.");
  const members = await supabaseRest<Member[]>("family_members?select=id,is_active&is_active=eq.true");
  const allowed = new Set(members.filter((member) => member.id !== memberId).map((member) => member.id));
  const ids = Array.isArray(selectedIds) ? [...new Set(selectedIds.filter((id): id is string => typeof id === "string"))].filter((id) => allowed.has(id)) : [];
  if (scope === "selected" && !ids.length) throw new Error("Selectionnez au moins une personne.");
  await supabaseRest("family_members?id=eq." + encodeURIComponent(memberId), { method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify({ investment_access_scope: scope }) });
  await supabaseRest("investment_access_grants?owner_member_id=eq." + encodeURIComponent(memberId), { method: "DELETE", headers: { prefer: "return=minimal" } });
  if (scope === "selected") await supabaseRest("investment_access_grants", { method: "POST", headers: { prefer: "return=minimal" }, body: JSON.stringify(ids.map((viewerMemberId) => ({ owner_member_id: memberId, viewer_member_id: viewerMemberId }))) });
}

export async function GET(request: Request) {
  try {
    await requireAdmin(request);
    const [users, grants, authResult] = await Promise.all([supabaseRest<Array<Record<string, unknown> & { id: string; auth_user_id?: string; wallets: Array<{ public_address: string | null }> }>>("family_members?select=*,wallets(public_address)&order=name.asc"), supabaseRest<Array<{ owner_member_id: string; viewer_member_id: string }>>("investment_access_grants?select=owner_member_id,viewer_member_id"), adminClient().auth.admin.listUsers({ page: 1, perPage: 1000 })]);
    if (authResult.error) throw authResult.error;
    const authById = new Map(authResult.data.users.map((user) => [user.id, user]));
    return Response.json({ users: users.map((member) => { const authUser = member.auth_user_id ? authById.get(String(member.auth_user_id)) : undefined; const { wallets, ...rest } = member; return { ...rest, wallet_address: wallets?.[0]?.public_address ?? null, selected_viewer_ids: grants.filter((grant) => grant.owner_member_id === member.id).map((grant) => grant.viewer_member_id), auth: authUser ? { emailConfirmedAt: authUser.email_confirmed_at, lastSignInAt: authUser.last_sign_in_at } : null }; }) });
  } catch (error) { return authErrorResponse(error); }
}

export async function POST(request: Request) {
  try {
    await requireAdmin(request);
    const body = await request.json() as { name?: string; email?: string; role?: string; birthday?: string; sendInvite?: boolean; redirectTo?: string };
    const name = body.name?.trim() ?? ""; const email = body.email?.trim().toLowerCase() ?? ""; const role = ["admin", "adult", "viewer"].includes(body.role ?? "") ? body.role : "adult"; const birthday = birthdayParts(body.birthday);
    if (!name || !/^\S+@\S+\.\S+$/.test(email)) return Response.json({ error: "Nom et e-mail valides obligatoires." }, { status: 400 });
    if (email === PRIMARY_ADMIN_EMAIL) return Response.json({ error: "Le compte administrateur existe deja." }, { status: 409 });
    const rows = await supabaseRest<Array<{ id: string }>>("family_members?on_conflict=email", { method: "POST", headers: { prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify({ name, email, role, birthday_day: birthday.day, birthday_month: birthday.month, birthday_year: birthday.year, is_active: true, access_status: body.sendInvite ? "invited" : "allowed", invited_at: body.sendInvite ? new Date().toISOString() : null }) });
    let invitation = { sent: false, reason: undefined as string | undefined };
    if (body.sendInvite) { const { error } = await adminClient().auth.admin.inviteUserByEmail(email, { data: { name, family_member_id: rows[0]?.id }, redirectTo: body.redirectTo }); invitation = error ? { sent: false, reason: error.message } : { sent: true, reason: undefined }; }
    return Response.json({ saved: true, id: rows[0]?.id, invitation }, { status: 201 });
  } catch (error) { return authErrorResponse(error); }
}

export async function PATCH(request: Request) {
  try {
    await requireAdmin(request);
    const body = await request.json() as { id?: string; name?: string; email?: string; role?: string; birthday?: string | null; isActive?: boolean; accessScope?: string; selectedViewerIds?: unknown; walletAddress?: string };
    if (!body.id) return Response.json({ error: "Utilisateur manquant." }, { status: 400 });
    const member = await findMember(body.id); if (!member) return Response.json({ error: "Membre introuvable." }, { status: 404 });
    if (isPrimaryAdmin(member) && (body.role !== undefined || body.isActive !== undefined || body.email !== undefined)) return Response.json({ error: "Le compte administrateur principal est protege." }, { status: 403 });
    const changes: Record<string, unknown> = {};
    if (body.name !== undefined) { const name = body.name.trim(); if (!name) return Response.json({ error: "Le nom est obligatoire." }, { status: 400 }); changes.name = name; }
    if (body.email !== undefined) { const email = body.email.trim().toLowerCase(); if (!/^\S+@\S+\.\S+$/.test(email)) return Response.json({ error: "Adresse e-mail invalide." }, { status: 400 }); if (email !== member.email?.toLowerCase() && member.auth_user_id) { const { error } = await adminClient().auth.admin.updateUserById(member.auth_user_id, { email }); if (error) throw error; } else if (!member.auth_user_id) changes.email = email; }
    if (body.role && ["admin", "adult", "viewer"].includes(body.role)) changes.role = body.role;
    if (body.birthday !== undefined) { const birthday = birthdayParts(body.birthday); changes.birthday_day = birthday.day; changes.birthday_month = birthday.month; changes.birthday_year = birthday.year; }
    if (body.isActive !== undefined) changes.is_active = body.isActive;
    if (Object.keys(changes).length) await supabaseRest("family_members?id=eq." + encodeURIComponent(body.id), { method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify(changes) });
    await saveAccess(body.id, body.accessScope, body.selectedViewerIds);
    await saveWallet(body.id, (changes.name as string | undefined) ?? member.name, body.walletAddress);
    return Response.json({ updated: true });
  } catch (error) { return authErrorResponse(error); }
}

export async function DELETE(request: Request) {
  try { await requireAdmin(request); const id = new URL(request.url).searchParams.get("id"); if (!id) return Response.json({ error: "Utilisateur manquant." }, { status: 400 }); const member = await findMember(id); if (!member) return Response.json({ error: "Membre introuvable." }, { status: 404 }); if (isPrimaryAdmin(member)) return Response.json({ error: "Le compte administrateur principal ne peut pas etre supprime." }, { status: 403 }); if (member.auth_user_id) { const { error } = await adminClient().auth.admin.deleteUser(member.auth_user_id); if (error) throw error; } await supabaseRest("family_members?id=eq." + encodeURIComponent(id), { method: "DELETE", headers: { prefer: "return=minimal" } }); return Response.json({ deleted: true }); } catch (error) { return authErrorResponse(error); }
}
