// Dividendes annoncés — onglet Revenus (PEA / compte-titres).
//
// Deux responsabilités, toutes deux PURES (aucun accès réseau, aucune écriture) et testées dans
// tests/dividend-projection.test.mjs :
//
//  1. `withEstimatedDividends` complète les annonces du fournisseur par une PROJECTION quand la
//     période équivalente de l'année suivante n'a pas encore été annoncée, en reprenant le
//     dernier montant par part CONNU pour le même instrument. Rien n'est jamais écrit en base ni
//     présenté comme confirmé : chaque entrée ajoutée porte `estimated: true`, à charge du
//     composant d'appeler ça « Estimé » et jamais un dividende annoncé. C'est un calcul
//     d'affichage au même titre que les simulations pédagogiques de la leçon Épargne — jamais une
//     donnée stockée.
//  2. `dividendToReceive` calcule le montant total à recevoir (quantité actuellement détenue ×
//     montant par part) puis, pour un compte-titres uniquement, le montant net après un
//     prélèvement forfaitaire simplifié de 30 % (12,8 % d'impôt sur le revenu + 17,2 % de
//     prélèvements sociaux — le « flat tax » français, PFU). Un PEA n'est PAS netté ici : les
//     dividendes perçus dans l'enveloppe ne subissent pas cette retenue tant que le plan reste
//     ouvert ; y appliquer 30 % serait une désinformation fiscale, pas une simplification.
//
// Limite assumée : la quantité utilisée est la quantité DÉTENUE AUJOURD'HUI, jamais celle détenue
// à la date de détachement (le moteur ne conserve pas de quantité historique par date). La liste
// « Dividendes annoncés » est déjà explicitement une annonce fournisseur, pas un calcul certifié :
// ce montant reste une indication, cohérente avec le reste de la section.

// Extension `.ts` explicite : ce module est exécuté tel quel par `node --test` (type-stripping
// natif), qui ne résout pas les imports sans extension.
import { instrumentKey, type AccountType, type PortfolioPosition } from "./portfolio-account.ts";

/** Prélèvement forfaitaire unique (« flat tax ») : 12,8 % d'impôt + 17,2 % de prélèvements sociaux. */
export const FLAT_TAX_RATE = 0.3;

export type DividendAsset = { isin: string | null; symbol: string | null; name: string | null } | null;

export type AnnouncedDividendLike = {
  id: string;
  ex_date: string;
  payment_date: string | null;
  amount_per_share: number | null;
  currency: string | null;
  asset: DividendAsset;
};

export type ProjectedDividend<T> = T & { estimated: boolean };

// Au-delà de cet horizon, projeter serait davantage une supposition qu'une estimation utile.
// ~6 mois, volontairement COURT : un instrument dont l'annonce vient de tomber (il y a quelques
// semaines ou mois) n'a pas besoin d'une supposition sur « dans un an » — la vraie annonce
// suivante arrivera par le fournisseur bien avant, quel que soit son rythme de versement
// (trimestriel, semestriel…). Seul un instrument dont la DERNIÈRE annonce connue approche déjà
// de son anniversaire (le fournisseur semble en retard, ou l'échéance est simplement proche)
// reçoit une estimation. Une fenêtre large aurait produit une projection « + 1 an » pour CHAQUE
// annonce récente, qui aurait alors noyé les vrais dividendes proches dans le tri chronologique
// (les estimations 2027 seraient apparues avant les vrais dividendes 2026 encore à afficher).
const PROJECTION_HORIZON_DAYS = 180;
// Tolérance pour dire qu'une date projetée est déjà couverte par une annonce réelle du même
// instrument : la date de détachement glisse de quelques jours d'une année sur l'autre.
const ALREADY_ANNOUNCED_WINDOW_DAYS = 45;

function parseISO(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}
function toISO(date: Date): string {
  return date.toISOString().slice(0, 10);
}
function addYears(date: string, years: number): string {
  const next = parseISO(date);
  next.setUTCFullYear(next.getUTCFullYear() + years);
  return toISO(next);
}
function daysBetween(from: string, to: string): number {
  return Math.round((parseISO(to).getTime() - parseISO(from).getTime()) / 86_400_000);
}
/** Année d'une date ISO (`"2026-12-19"` → `2026`). Exportée pour l'affichage (« Estimé, d'après {année} »). */
export function yearOf(date: string): number {
  return parseISO(date).getUTCFullYear();
}

function assetGroupKey(asset: DividendAsset): string {
  if (!asset) return "";
  return instrumentKey({ isin: asset.isin, ticker: asset.symbol, assetName: asset.name });
}

/**
 * Complète une liste d'annonces par des projections quand la période équivalente de l'année
 * suivante manque encore. Chaque annonce réelle est candidate à projection indépendamment des
 * autres — PAS seulement celles de la dernière année connue de l'instrument.
 *
 * C'est délibéré : un instrument qui verse plusieurs fois par an (un acompte en décembre, puis
 * des échéances en mars et juin l'année suivante) a des annonces réelles qui chevauchent DEUX
 * années civiles pour le MÊME instrument. Ne projeter que depuis « la dernière année connue »
 * aurait ignoré le créneau de décembre — exactement le trou que ce module doit combler (repéré
 * en rejouant les vraies annonces TotalEnergies avant livraison : Dec 2025 + Mars/Juin 2026 ne
 * générait alors aucune estimation pour Dec 2026). La garde contre les doublons n'est donc pas
 * « une seule année source », mais `alreadyCovered` ci-dessous : si la date projetée tombe à
 * moins de 45 jours d'une annonce réelle du même instrument, la projection est abandonnée.
 */
export function withEstimatedDividends<T extends AnnouncedDividendLike>(events: T[], todayISODate: string): ProjectedDividend<T>[] {
  const byAsset = new Map<string, T[]>();
  for (const event of events) {
    const key = assetGroupKey(event.asset);
    if (!key) continue;
    const list = byAsset.get(key) ?? [];
    list.push(event);
    byAsset.set(key, list);
  }

  const projected: ProjectedDividend<T>[] = [];
  for (const list of byAsset.values()) {
    for (const seed of list) {
      if (seed.amount_per_share === null) continue;
      const projectedExDate = addYears(seed.ex_date, 1);
      const distance = daysBetween(todayISODate, projectedExDate);
      if (distance < -30 || distance > PROJECTION_HORIZON_DAYS) continue;
      const alreadyCovered = list.some((other) => Math.abs(daysBetween(other.ex_date, projectedExDate)) <= ALREADY_ANNOUNCED_WINDOW_DAYS);
      if (alreadyCovered) continue;
      projected.push({
        ...seed,
        id: `${seed.id}:estimated`,
        ex_date: projectedExDate,
        payment_date: seed.payment_date ? addYears(seed.payment_date, 1) : null,
        estimated: true,
      });
    }
  }

  return [...events.map((event) => ({ ...event, estimated: false })), ...projected].sort((a, b) => b.ex_date.localeCompare(a.ex_date));
}

/** Quantité actuellement détenue pour l'instrument d'une annonce (0 si non détenu / non identifié). */
export function heldQuantityFor(positions: Pick<PortfolioPosition, "key" | "quantity">[], asset: DividendAsset): number {
  const key = assetGroupKey(asset);
  if (!key) return 0;
  return positions.find((position) => position.key === key)?.quantity ?? 0;
}

export type DividendToReceive = { gross: number | null; net: number | null };

/**
 * Montant total à recevoir pour une annonce : quantité détenue × montant par part.
 * `net` n'est renseigné que pour un compte-titres (retrait du prélèvement forfaitaire) ; il vaut
 * toujours `null` pour un PEA — l'absence de valeur signifie « non applicable », pas « inconnu ».
 */
export function dividendToReceive(params: { amountPerShare: number | null; quantityHeld: number; accountType: AccountType }): DividendToReceive {
  if (params.amountPerShare === null) return { gross: null, net: null };
  const gross = params.amountPerShare * Math.max(0, params.quantityHeld);
  const net = params.accountType === "CTO" ? gross * (1 - FLAT_TAX_RATE) : null;
  return { gross, net };
}
