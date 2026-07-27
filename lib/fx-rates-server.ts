// Accès BASE + réseau pour les taux de change. Côté serveur UNIQUEMENT (clé de service).
//
// Séparé de `lib/fx-rates.ts`, qui reste pur et testable : ici on lit la table, on télécharge le
// fichier de la BCE et on écrit. Toute la logique de conversion, elle, vit dans le module pur.
//
// Deux chemins d'alimentation, volontairement redondants :
//   • la Fonction Edge `sync-fx-rates`, planifiée une fois par jour ouvré (chemin nominal) ;
//   • cette fonction, appelée par `/api/admin/fx` (exécution manuelle sécurisée, admin) — elle
//     permet d'amorcer la table et de dépanner sans déployer quoi que ce soit.
// Les deux écrivent exactement les mêmes lignes, avec la même clé primaire : les rejouer n'a
// aucun effet de bord.

import { ecbRowsFor, normaliseCurrency, parseEcbDailyXml, type FxRateRow } from "./fx-rates.ts";
import { supabaseRest } from "./supabase-rest.ts";

export const ECB_DAILY_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
const FETCH_TIMEOUT_MS = 10_000;
/**
 * Profondeur d'historique chargée pour valoriser. 40 jours couvrent largement la règle de repli
 * (dernier taux ≤ date de valorisation) même après une longue interruption de la synchronisation,
 * tout en gardant une réponse légère : ~30 devises × 40 jours au maximum.
 */
const LOOKBACK_DAYS = 40;

type FxRateDbRow = { base_currency: string; quote_currency: string; rate: number | string; rate_date: string; source: string | null };

function toRow(row: FxRateDbRow): FxRateRow | null {
  const baseCurrency = normaliseCurrency(row.base_currency);
  const quoteCurrency = normaliseCurrency(row.quote_currency);
  const rate = Number(row.rate);
  if (!baseCurrency || !quoteCurrency || !Number.isFinite(rate) || rate <= 0) return null;
  return { baseCurrency, quoteCurrency, rate, rateDate: String(row.rate_date).slice(0, 10), source: row.source ?? "ECB" };
}

/**
 * Charge les taux nécessaires EN UNE SEULE REQUÊTE. On ne filtre volontairement pas par devise
 * quand la liste est vide (portefeuille encore inconnu) : le volume reste négligeable et cela
 * évite un aller-retour supplémentaire.
 *
 * Une table absente n'est pas une erreur fonctionnelle : sans taux, les positions en devises
 * restent affichées « Conversion indisponible », le reste du portefeuille fonctionne.
 */
export async function loadFxRates(currencies: string[] = [], asOf = new Date().toISOString().slice(0, 10)): Promise<FxRateRow[]> {
  const wanted = [...new Set(currencies.map(normaliseCurrency).filter((code): code is string => Boolean(code) && code !== "EUR"))];
  const since = new Date(Date.parse(`${asOf}T00:00:00Z`) - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const filter = wanted.length > 0 ? `&quote_currency=in.(${wanted.join(",")})` : "";
  try {
    const rows = await supabaseRest<FxRateDbRow[]>(
      `fx_rates?select=base_currency,quote_currency,rate,rate_date,source`
      + `&base_currency=eq.EUR&rate_date=lte.${asOf}&rate_date=gte.${since}${filter}`
      + `&order=rate_date.desc`,
    );
    return (rows ?? []).map(toRow).filter((row): row is FxRateRow => row !== null);
  } catch {
    return [];
  }
}

/**
 * Taux hérités de `market_fx_rates` (ancienne table, alimentée par « Actualiser les cours »).
 * Convention INVERSE de la BCE : la ligne y est stockée dans le sens `native → référence`
 * (1 USD = 0,879 EUR). On la retourne donc en base EUR pour que le module pur n'ait qu'UNE
 * convention à connaître — c'est précisément le genre de détail qui, laissé à l'appelant,
 * finit par produire une double inversion.
 *
 * Utilisée en dernier recours : elle dépanne tant que `fx_rates` n'a pas été alimentée.
 */
export async function loadLegacyFxRates(): Promise<FxRateRow[]> {
  try {
    const rows = await supabaseRest<Array<{ base_currency: string; quote_currency: string; rate: number | string; quoted_at: string }>>(
      "market_fx_rates?select=base_currency,quote_currency,rate,quoted_at&order=quoted_at.desc&limit=200",
    );
    const converted: FxRateRow[] = [];
    for (const row of rows ?? []) {
      const base = normaliseCurrency(row.base_currency);
      const quote = normaliseCurrency(row.quote_currency);
      const rate = Number(row.rate);
      if (!base || !quote || !Number.isFinite(rate) || rate <= 0) continue;
      if (quote !== "EUR") continue; // seules les paires « X → EUR » sont réinterprétables ici
      converted.push({
        baseCurrency: "EUR", quoteCurrency: base,
        rate: 1 / rate, // 1 USD = 0,879 EUR  ⟹  1 EUR = 1,1377 USD
        rateDate: String(row.quoted_at).slice(0, 10),
        source: "market_fx_rates",
      });
    }
    return converted;
  } catch {
    return [];
  }
}

/**
 * Taux BCE en priorité, taux hérités en complément : une devise déjà couverte par la BCE n'est
 * jamais recouverte par l'ancienne table (source de référence unique quand elle existe).
 */
export async function loadPortfolioFxRates(currencies: string[] = [], asOf?: string): Promise<FxRateRow[]> {
  const primary = await loadFxRates(currencies, asOf);
  const covered = new Set(primary.map((row) => row.quoteCurrency));
  const legacy = (await loadLegacyFxRates()).filter((row) => !covered.has(row.quoteCurrency));
  return [...primary, ...legacy];
}

export type FxSyncReport = {
  ok: boolean;
  /** Date de référence publiée par la BCE (jamais la date d'exécution). */
  rateDate: string | null;
  /** Nombre de devises écrites (insérées ou mises à jour). */
  written: number;
  /** Devises reçues mais écartées par la validation. */
  rejected: string[];
  /** true quand la date publiée était déjà en base : rien de neuf, aucune écriture nécessaire. */
  alreadyUpToDate: boolean;
  message: string;
};

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

/**
 * Télécharge le fichier quotidien de la BCE et enregistre les taux.
 *
 * Propriétés voulues :
 *   • IDEMPOTENTE — la clé primaire est (base, quote, date) et l'écriture est un upsert :
 *     rejouer la synchronisation dix fois donne exactement la même table ;
 *   • NON DESTRUCTIVE — aucun DELETE, jamais. Un échec de téléchargement laisse le dernier taux
 *     valide en place, ce qui est précisément ce qui permet de valoriser le week-end ;
 *   • VALIDANTE — une devise mal formée ou un taux nul sont écartés et RAPPORTÉS, pas écrits.
 */
export async function syncEcbFxRates(): Promise<FxSyncReport> {
  const xml = await fetchEcbXml();
  if (!xml) {
    return { ok: false, rateDate: null, written: 0, rejected: [], alreadyUpToDate: false, message: "Fichier BCE injoignable. Les taux déjà enregistrés restent en place." };
  }
  const daily = parseEcbDailyXml(xml);
  if (!daily) {
    return { ok: false, rateDate: null, written: 0, rejected: [], alreadyUpToDate: false, message: "Fichier BCE illisible (aucune date ou aucun taux exploitable). Rien n'a été modifié." };
  }

  // Ce que le fichier annonçait mais que la validation a écarté : rapporté, jamais deviné.
  const announced = (xml.match(/<Cube\s+currency=['"]([A-Za-z]{3})['"]/g) ?? [])
    .map((tag) => /['"]([A-Za-z]{3})['"]/.exec(tag)?.[1] ?? "")
    .filter(Boolean)
    .map((code) => code.toUpperCase());
  const kept = new Set(daily.rates.map((entry) => entry.currency));
  const rejected = [...new Set(announced.filter((code) => !kept.has(code)))];

  const rows = ecbRowsFor(daily, new Date().toISOString());
  try {
    await supabaseRest("fx_rates?on_conflict=base_currency,quote_currency,rate_date", {
      method: "POST",
      headers: { prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur Supabase";
    if (/fx_rates|PGRST205/.test(message)) {
      return { ok: false, rateDate: daily.date, written: 0, rejected, alreadyUpToDate: false, message: "La table fx_rates n'existe pas encore : appliquez la migration 20260809_fx_rates.sql dans Supabase." };
    }
    return { ok: false, rateDate: daily.date, written: 0, rejected, alreadyUpToDate: false, message: `Enregistrement impossible : ${message}. Les taux déjà enregistrés restent en place.` };
  }

  return {
    ok: true,
    rateDate: daily.date,
    written: rows.length,
    rejected,
    alreadyUpToDate: false,
    message: `${rows.length} taux BCE enregistrés pour le ${daily.date}.`,
  };
}
