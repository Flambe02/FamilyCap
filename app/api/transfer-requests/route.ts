import { isSupabaseConfigured, supabaseRest } from "../../../lib/supabase-rest";
import { authErrorResponse, requireAdmin, requireFamilyMember, type AuthenticatedMember } from "../../../lib/auth-server";

type RuntimeEnv = {
  RESEND_API_KEY?: string;
  ALERT_EMAIL_FROM?: string;
  ALERT_EMAIL_TO?: string;
};

const runtime: RuntimeEnv = {
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  ALERT_EMAIL_FROM: process.env.ALERT_EMAIL_FROM,
  ALERT_EMAIL_TO: process.env.ALERT_EMAIL_TO,
};

export async function GET(request: Request) {
  let viewer: AuthenticatedMember | null = null;
  if (isSupabaseConfigured()) {
    try { viewer = await requireFamilyMember(request); } catch (error) { return authErrorResponse(error); }
  }
  if (isSupabaseConfigured()) {
    const ownRequests = viewer && viewer.role !== "admin" ? "&member_id=eq." + encodeURIComponent(viewer.id) : "";
    const rows = await supabaseRest<Array<{ id: string; member_name: string; transaction_id: string; btc_amount: number | null; requested_at: string; status: string }>>("transfer_requests?select=id,member_name,transaction_id,btc_amount,requested_at,status&order=requested_at.desc&limit=100" + ownRequests);
    return Response.json({
      requests: rows.map((row) => ({
        id: row.id,
        member: row.member_name,
        transactionId: row.transaction_id,
        btcAmount: row.btc_amount,
        requestedAt: row.requested_at,
        status: row.status,
      })),
      persistence: "supabase",
    });
  }
  return Response.json({ requests: [], persistence: "unavailable" });
}

export async function POST(request: Request) {
  try {
    const viewer = isSupabaseConfigured() ? await requireFamilyMember(request) : null;
    const payload = await request.json() as { id?: string; member?: string; transactionId?: string; btcAmount?: number; requestedAt?: string };
    const id = payload.id?.trim() || crypto.randomUUID();
    const member = viewer?.name ?? payload.member?.trim() ?? "";
    const transactionId = payload.transactionId?.trim() ?? "";
    const btcAmount = payload.btcAmount === undefined ? null : Number(payload.btcAmount);
    const requestedAt = payload.requestedAt ?? new Date().toISOString();
    if (!member || !transactionId) return Response.json({ error: "Membre et transaction obligatoires." }, { status: 400 });
    if (viewer && payload.member?.trim() && payload.member.trim() !== viewer.name) {
      return Response.json({ error: "Une demande ne peut concerner que votre propre portefeuille." }, { status: 403 });
    }

    let persisted = false;
    let persistence = "unavailable";
    if (isSupabaseConfigured()) {
      await supabaseRest("transfer_requests", {
        method: "POST",
        headers: { prefer: "resolution=ignore-duplicates,return=minimal" },
        body: JSON.stringify({
          id,
          member_id: viewer?.id ?? null,
          member_name: member,
          transaction_id: transactionId,
          btc_amount: btcAmount,
          requested_at: requestedAt,
          status: "Nouvelle",
        }),
      });
      persisted = true;
      persistence = "supabase";
    }

    const email = await sendAlertEmail({ id, member, transactionId, btcAmount, requestedAt });
    return Response.json({ request: { id, member, transactionId, btcAmount, requestedAt, status: "Nouvelle" }, persisted, persistence, email }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "Demande impossible." }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  if (isSupabaseConfigured()) {
    try { await requireAdmin(request); } catch (error) { return authErrorResponse(error); }
  }
  const payload = await request.json() as { id?: string; status?: string };
  if (!payload.id || !["Nouvelle", "En traitement", "Transférée"].includes(payload.status ?? "")) return Response.json({ error: "Mise à jour invalide." }, { status: 400 });
  if (isSupabaseConfigured()) {
    await supabaseRest("transfer_requests?id=eq." + encodeURIComponent(payload.id), {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({
        status: payload.status,
        processed_at: payload.status === "Transférée" ? new Date().toISOString() : null,
      }),
    });
    return Response.json({ updated: true, persistence: "supabase" });
  }
  return Response.json({ updated: false, persistence: "unavailable" }, { status: 503 });
}

async function sendAlertEmail(data: { id: string; member: string; transactionId: string; btcAmount: number | null; requestedAt: string }) {
  if (!runtime.RESEND_API_KEY || !runtime.ALERT_EMAIL_FROM) return { sent: false, reason: "Email non configuré" };
  const to = runtime.ALERT_EMAIL_TO || "florent.lambert@gmail.com";
  const amount = data.btcAmount ? `${data.btcAmount.toFixed(8)} BTC` : "montant à confirmer";
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${runtime.RESEND_API_KEY}`, "content-type": "application/json", "idempotency-key": `transfer-request/${data.id}` },
    body: JSON.stringify({
      from: runtime.ALERT_EMAIL_FROM,
      to: [to],
      subject: `LaBaJo & Co — ${data.member} demande un transfert BTC`,
      html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto"><h1 style="color:#17324D">Demande de transfert Bitcoin</h1><p><strong>${escapeHtml(data.member)}</strong> demande le transfert de sa part actuellement conservée sur Binance commun.</p><p>Montant : <strong>${amount}</strong><br>Transaction de suivi : ${escapeHtml(data.transactionId)}<br>Date : ${escapeHtml(data.requestedAt)}</p><p style="color:#667">Ouvre le back-office LaBaJo &amp; Co pour traiter cette demande.</p></div>`,
    }),
  });
  if (!response.ok) return { sent: false, reason: `Resend ${response.status}` };
  const result = await response.json() as { id?: string };
  return { sent: true, id: result.id };
}

function escapeHtml(value: string) { return value.replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[character] ?? character)); }
