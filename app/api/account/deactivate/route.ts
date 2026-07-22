import { authErrorResponse, requireFamilyMember } from "../../../../lib/auth-server";
import { isSupabaseConfigured, supabaseRest } from "../../../../lib/supabase-rest";

// Désactivation du compte membre demandée par l'intéressé lui-même.
//
// Choix produit : PAS de suppression destructive. Les cadeaux, virements et données du registre
// familial sont conservés (intégrité patrimoniale). On coupe simplement l'accès du membre en
// passant `is_active = false` / `access_status = 'disabled'` : le hook d'authentification Supabase
// (hook_allow_cap_family_member) refusera alors toute nouvelle connexion. L'action est réversible
// par l'administrateur depuis le back-office.
//
// Frontière de sécurité : requireFamilyMember identifie l'appelant ; l'action ne porte QUE sur son
// propre compte. Le mot de confirmation « SUPPRIMER » doit être saisi côté client.

const CONFIRM_WORD = "SUPPRIMER";

type RuntimeEnv = { RESEND_API_KEY?: string; ALERT_EMAIL_FROM?: string; ALERT_EMAIL_TO?: string };
const runtime: RuntimeEnv = {
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  ALERT_EMAIL_FROM: process.env.ALERT_EMAIL_FROM,
  ALERT_EMAIL_TO: process.env.ALERT_EMAIL_TO,
};

export async function POST(request: Request) {
  if (!isSupabaseConfigured()) return Response.json({ error: "Service indisponible : authentification requise." }, { status: 503 });
  try {
    const viewer = await requireFamilyMember(request);
    const body = await request.json().catch(() => ({})) as { confirm?: unknown };
    if (typeof body.confirm !== "string" || body.confirm.trim().toUpperCase() !== CONFIRM_WORD) {
      return Response.json({ error: `Saisissez « ${CONFIRM_WORD} » pour confirmer.` }, { status: 400 });
    }
    // Garde-fou : le compte administrateur unique ne peut pas se verrouiller lui-même hors ligne.
    if (viewer.role === "admin") {
      return Response.json({ error: "Le compte administrateur ne peut pas être désactivé depuis cet écran." }, { status: 403 });
    }

    await supabaseRest("family_members?id=eq." + encodeURIComponent(viewer.id), {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ is_active: false, access_status: "disabled" }),
    });

    await notifyAdmin(viewer.name, viewer.email).catch(() => undefined);

    return Response.json({ deactivated: true });
  } catch (error) {
    return authErrorResponse(error);
  }
}

async function notifyAdmin(name: string, email: string) {
  if (!runtime.RESEND_API_KEY || !runtime.ALERT_EMAIL_FROM) return;
  const to = runtime.ALERT_EMAIL_TO || "florent.lambert@gmail.com";
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${runtime.RESEND_API_KEY}`, "content-type": "application/json", "idempotency-key": `account-deactivate/${email}` },
    body: JSON.stringify({
      from: runtime.ALERT_EMAIL_FROM,
      to: [to],
      subject: `LaBaJo & Co — ${name} a désactivé son accès`,
      html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto"><h1 style="color:#17324D">Compte désactivé</h1><p><strong>${escapeHtml(name)}</strong> (${escapeHtml(email)}) a désactivé son accès à LaBaJo &amp; Co. Aucune donnée du registre familial n'a été supprimée.</p><p style="color:#667">Tu peux réactiver ce compte depuis le back-office si besoin.</p></div>`,
    }),
  });
}

function escapeHtml(value: string) { return value.replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[character] ?? character)); }
