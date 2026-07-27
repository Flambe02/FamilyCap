// Fonction Edge `sync-fx-rates` — enregistre les taux de référence quotidiens de la BCE.
//
// Déploiement :
//     supabase functions deploy sync-fx-rates
// Exécution manuelle (clé de service, jamais depuis un navigateur) :
//     curl -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/sync-fx-rates" \
//          -H "Authorization: Bearer <SERVICE_ROLE_KEY>"
// Planification : voir le bloc commenté en fin de `supabase/migrations/20260809_fx_rates.sql`
// (pg_cron + pg_net, tous les jours ouvrés à 18 h UTC).
//
// Garanties :
//   • IDEMPOTENTE — upsert sur la clé (base_currency, quote_currency, rate_date). Dix exécutions
//     dans la même journée laissent exactement la même table.
//   • NON DESTRUCTIVE — aucun DELETE. Si la BCE est injoignable, le dernier taux valide reste en
//     place : c'est lui qui permet de valoriser le week-end et les jours fériés.
//   • FERMÉE — refuse tout appel qui ne présente pas la clé de service du projet. La BCE, elle,
//     n'exige aucune clé : aucun secret externe n'est nécessaire.
//
// La lecture du fichier BCE vit dans `./ecb.ts`, miroir de `web/lib/fx-rates.ts` verrouillé par
// un test d'équivalence (`web/tests/fx-rates.test.mjs`).

import { ecbRowsFor, parseEcbDailyXml, rejectedCurrencies } from "./ecb.ts";

const ECB_DAILY_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
const FETCH_TIMEOUT_MS = 10_000;

type Summary = {
  ok: boolean;
  rateDate: string | null;
  written: number;
  rejected: string[];
  durationMs: number;
  message: string;
};

function json(body: Summary, status: number): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * Seule la clé de service du projet autorise l'exécution. Un jeton d'utilisateur, même valide,
 * est refusé : écrire un taux de change revient à réévaluer tous les portefeuilles.
 */
function authorised(request: Request, serviceKey: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  return token.length > 0 && token === serviceKey;
}

async function fetchEcbXml(): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(ECB_DAILY_URL, {
      cache: "no-store",
      signal: controller.signal,
      headers: { accept: "application/xml,text/xml,*/*", "user-agent": "LaBaJoCo/1.0 (portefeuille familial)" },
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

Deno.serve(async (request: Request) => {
  const startedAt = Date.now();
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  if (!supabaseUrl || !serviceKey) {
    return json({ ok: false, rateDate: null, written: 0, rejected: [], durationMs: Date.now() - startedAt, message: "Variables SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY absentes." }, 500);
  }
  if (!authorised(request, serviceKey)) {
    return json({ ok: false, rateDate: null, written: 0, rejected: [], durationMs: Date.now() - startedAt, message: "Non autorisé." }, 401);
  }

  const xml = await fetchEcbXml();
  if (!xml) {
    // Historique minimal : la trace part dans les logs de la fonction, sans aucune donnée
    // personnelle (un taux de change ne concerne personne en particulier).
    console.warn("sync-fx-rates: fichier BCE injoignable, aucun taux modifié");
    return json({ ok: false, rateDate: null, written: 0, rejected: [], durationMs: Date.now() - startedAt, message: "Fichier BCE injoignable. Les taux déjà enregistrés restent en place." }, 502);
  }

  const daily = parseEcbDailyXml(xml);
  if (!daily) {
    console.warn("sync-fx-rates: fichier BCE illisible, aucun taux modifié");
    return json({ ok: false, rateDate: null, written: 0, rejected: [], durationMs: Date.now() - startedAt, message: "Fichier BCE illisible. Rien n'a été modifié." }, 502);
  }

  const rows = ecbRowsFor(daily, new Date().toISOString());
  const rejected = rejectedCurrencies(xml, daily.rates);

  const response = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/fx_rates?on_conflict=base_currency,quote_currency,rate_date`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      "content-type": "application/json",
      prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    console.error(`sync-fx-rates: écriture refusée (${response.status})`);
    return json({ ok: false, rateDate: daily.date, written: 0, rejected, durationMs: Date.now() - startedAt, message: `Enregistrement impossible (${response.status}) : ${detail}. Les taux déjà enregistrés restent en place.` }, 500);
  }

  console.log(`sync-fx-rates: ${rows.length} taux enregistrés pour le ${daily.date}`);
  return json({
    ok: true,
    rateDate: daily.date,
    written: rows.length,
    rejected,
    durationMs: Date.now() - startedAt,
    message: `${rows.length} taux BCE enregistrés pour le ${daily.date}.`,
  }, 200);
});
