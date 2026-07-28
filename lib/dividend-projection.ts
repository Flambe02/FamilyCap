// MOTEUR DE PROJECTION DES DIVIDENDES — déterministe, pur, séparé du code fournisseur.
//
// Ce module ne connaît AUCUN fournisseur, aucune base, aucun réseau. Il reçoit un historique de
// dividendes déjà normalisé et rend des échéances probables. C'est cette séparation qui permet de
// tester la méthode de calcul sans dépendre d'une réponse HTTP, et de la remplacer sans toucher
// aux adaptateurs.
//
// CE QU'UNE PROJECTION EST, ET CE QU'ELLE N'EST PAS
//   * elle porte un MOIS, jamais un jour. Une date exacte non annoncée serait une invention
//     présentée comme un fait — c'est exactement ce que le projet refuse ;
//   * elle s'appuie sur des dividendes ORDINAIRES. Les dividendes exceptionnels sont exclus par
//     défaut : les inclure ferait croire qu'un versement de circonstance se répétera ;
//   * elle est PRUDENTE : on ne prolonge jamais une croissance passée. Le montant retenu est le
//     plus faible entre la dernière occurrence comparable et la médiane des trois dernières ;
//   * elle disparaît dès qu'une annonce officielle couvre la même échéance ;
//   * elle est accompagnée d'une CONFIANCE explicite et de la méthode employée.
//
// Testé dans tests/dividend-projection.test.mjs.

import type { Confidence, DividendType } from "./dividend-engine.ts";

/** Un dividende déjà détaché, tel que normalisé par la couche fournisseur. */
export type HistoricalDividendPoint = {
  exDate: string; // YYYY-MM-DD
  amountPerShare: number;
  currency: string | null;
  dividendType: DividendType;
  isSpecial: boolean;
};

/** Une échéance officiellement annoncée, qui rend toute projection concurrente inutile. */
export type AnnouncedPoint = {
  exDate: string | null;
  paymentDate: string | null;
  dividendType: DividendType;
};

export type DividendFrequency = "monthly" | "quarterly" | "semiannual" | "annual" | "irregular";

export type ProjectedDividend = {
  /** « YYYY-MM ». Seul repère temporel : la date exacte n'est pas annoncée. */
  estimatedMonth: string;
  amountPerShare: number;
  currency: string | null;
  dividendType: DividendType;
  confidence: Confidence;
  /** Phrase affichable expliquant d'où sort le montant. */
  method: string;
  /** Détachements ayant servi de base, pour l'audit. */
  basedOn: string[];
};

export type ProjectionResult = {
  frequency: DividendFrequency;
  projections: ProjectedDividend[];
  /** Raison pour laquelle rien n'a été projeté, quand c'est le cas. */
  skippedReason: null | "no_history" | "suspended" | "irregular" | "fully_announced";
  /** Observations à afficher : suspension, changement de fréquence, changement de devise. */
  notes: string[];
};

export type ProjectionOptions = {
  today: string;
  /** Horizon glissant, en mois. 12 par défaut : exactement ce qu'affiche l'écran. */
  horizonMonths?: number;
  /** Inclure les dividendes exceptionnels dans la base de calcul. Faux par défaut. */
  includeSpecial?: boolean;
};

/** Une projection tombant à moins de 45 jours d'une annonce réelle est abandonnée (doublon). */
export const ANNOUNCEMENT_WINDOW_DAYS = 45;
/** Au-delà de 1,6 × la période habituelle sans versement, le dividende est considéré suspendu. */
export const SUSPENSION_FACTOR = 1.6;

const DAY_MS = 86_400_000;

function toTime(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}
function daysBetween(from: string, to: string): number {
  return Math.round((toTime(to) - toTime(from)) / DAY_MS);
}
function monthOf(date: string): string {
  return date.slice(0, 7);
}
function addMonths(monthKey: string, count: number): string {
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7)) - 1 + count;
  const nextYear = year + Math.floor(month / 12);
  const nextMonth = ((month % 12) + 12) % 12;
  return `${nextYear}-${String(nextMonth + 1).padStart(2, "0")}`;
}
function monthDiff(from: string, to: string): number {
  return (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + (Number(to.slice(5, 7)) - Number(from.slice(5, 7)));
}
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Fréquence habituelle, déduite de l'écart MÉDIAN entre détachements consécutifs.
 *
 * La médiane plutôt que la moyenne : un seul versement exceptionnel ou un décalage d'un trimestre
 * suffirait à faire passer une moyenne annuelle pour semestrielle, alors que la médiane l'ignore.
 */
export function detectFrequency(history: HistoricalDividendPoint[]): DividendFrequency {
  const dates = [...new Set(history.map((point) => point.exDate))].sort();
  if (dates.length < 2) return "irregular";
  const gaps: number[] = [];
  for (let index = 1; index < dates.length; index += 1) gaps.push(daysBetween(dates[index - 1], dates[index]));
  const usable = gaps.filter((gap) => gap > 5);
  if (usable.length === 0) return "irregular";
  const gap = median(usable);
  if (gap <= 45) return "monthly";
  if (gap <= 135) return "quarterly";
  if (gap <= 250) return "semiannual";
  if (gap <= 460) return "annual";
  return "irregular";
}

function periodMonths(frequency: DividendFrequency): number {
  switch (frequency) {
    case "monthly": return 1;
    case "quarterly": return 3;
    case "semiannual": return 6;
    case "annual": return 12;
    default: return 12;
  }
}

/**
 * Regroupe l'historique en CRÉNEAUX : les échéances récurrentes de l'instrument (l'acompte de
 * décembre, le solde de mai…). Sans cette notion, un titre avec cinq ans d'historique annuel
 * recevrait cinq projections au lieu d'une, et un titre trimestriel n'en recevrait qu'une au lieu
 * de quatre.
 *
 * Deux détachements appartiennent au même créneau lorsqu'ils sont séparés d'un nombre ENTIER de
 * périodes, à un mois près — ce qui tolère qu'une assemblée générale glisse d'une année sur l'autre.
 */
export function groupIntoSlots(history: HistoricalDividendPoint[], frequency: DividendFrequency): HistoricalDividendPoint[][] {
  const sorted = [...history].sort((a, b) => b.exDate.localeCompare(a.exDate));
  if (sorted.length === 0) return [];
  const period = periodMonths(frequency);
  const cycle = frequency === "irregular" ? 12 : Math.max(1, Math.round(12 / period) * period);
  const slots: HistoricalDividendPoint[][] = [];
  for (const point of sorted) {
    const slot = slots.find((existing) => {
      const gap = Math.abs(monthDiff(point.exDate.slice(0, 7), existing[0].exDate.slice(0, 7)));
      return gap % 12 <= 1 || gap % 12 >= 11;
    });
    // Un créneau annuel se répète tous les 12 mois quelle que soit la fréquence : c'est cette
    // congruence, et non l'ordre des lignes, qui décide de l'appartenance.
    if (slot && cycle > 0) slot.push(point);
    else slots.push([point]);
  }
  return slots;
}

/**
 * Montant PRUDENT d'un créneau : le plus faible entre la dernière occurrence et la médiane des
 * trois dernières. Reconduire simplement la dernière valeur transformerait une hausse ponctuelle
 * en promesse ; prendre la médiane seule ignorerait une baisse récente réelle. Le minimum des deux
 * ne surestime jamais.
 */
export function prudentAmount(slot: HistoricalDividendPoint[]): number {
  const recent = [...slot].sort((a, b) => b.exDate.localeCompare(a.exDate)).slice(0, 3);
  const last = recent[0]?.amountPerShare ?? 0;
  return Math.min(last, median(recent.map((point) => point.amountPerShare)));
}

/**
 * Confiance :
 *   élevée — au moins 3 occurrences, calendrier stable (±1 mois) et montants stables (≤ 10 %) ;
 *   moyenne — calendrier régulier mais montant variable, ou 2 occurrences seulement ;
 *   faible — historique incomplet ou irrégulier.
 */
export function slotConfidence(slot: HistoricalDividendPoint[], frequency: DividendFrequency): Confidence {
  if (frequency === "irregular" || slot.length < 2) return "low";
  const sorted = [...slot].sort((a, b) => a.exDate.localeCompare(b.exDate));
  const months = sorted.map((point) => Number(point.exDate.slice(5, 7)));
  const spread = Math.max(...months) - Math.min(...months);
  const calendarStable = spread <= 1 || spread >= 11;
  const amounts = sorted.map((point) => point.amountPerShare);
  const low = Math.min(...amounts);
  const high = Math.max(...amounts);
  const amountStable = low > 0 && (high - low) / high <= 0.1;
  if (slot.length >= 3 && calendarStable && amountStable) return "high";
  if (calendarStable) return "medium";
  return "low";
}

/**
 * Projette les échéances manquantes des `horizonMonths` prochains mois.
 *
 * `announced` sert de filtre : une échéance déjà confirmée par le fournisseur n'est jamais
 * doublée d'une supposition. Le remplacement d'une projection par une annonce se joue donc ici,
 * à la source — plutôt qu'à l'affichage, où deux lignes concurrentes coexisteraient.
 */
export function projectDividends(
  history: HistoricalDividendPoint[],
  announced: AnnouncedPoint[],
  options: ProjectionOptions,
): ProjectionResult {
  const { today } = options;
  const horizonMonths = options.horizonMonths ?? 12;
  const notes: string[] = [];

  const usable = history
    .filter((point) => Number.isFinite(point.amountPerShare) && point.amountPerShare > 0)
    .filter((point) => /^\d{4}-\d{2}-\d{2}$/.test(point.exDate))
    .filter((point) => (options.includeSpecial === true ? true : !point.isSpecial && point.dividendType !== "special"));

  const excludedSpecials = history.length - usable.length;
  if (excludedSpecials > 0 && options.includeSpecial !== true) {
    notes.push(`${excludedSpecials} dividende(s) exceptionnel(s) exclus de la projection.`);
  }

  if (usable.length === 0) {
    return { frequency: "irregular", projections: [], skippedReason: "no_history", notes };
  }

  const frequency = detectFrequency(usable);
  const sorted = [...usable].sort((a, b) => a.exDate.localeCompare(b.exDate));
  const latest = sorted[sorted.length - 1];

  // Changement de devise : la dernière devise fait foi, et on le signale plutôt que de mélanger.
  const currencies = [...new Set(sorted.map((point) => (point.currency ?? "").toUpperCase()).filter(Boolean))];
  if (currencies.length > 1) {
    notes.push(`Devise de versement modifiée au fil du temps (${currencies.join(" → ")}) : la plus récente est retenue.`);
  }

  // Suspension : plus aucun versement depuis nettement plus longtemps que la période habituelle.
  const sinceLast = daysBetween(latest.exDate, today);
  const expectedGapDays = periodMonths(frequency) * 30.4;
  if (frequency !== "irregular" && sinceLast > expectedGapDays * SUSPENSION_FACTOR) {
    notes.push(`Aucun versement depuis le ${latest.exDate}, soit nettement plus que la périodicité habituelle : le dividende est considéré comme suspendu et n’est pas projeté.`);
    return { frequency, projections: [], skippedReason: "suspended", notes };
  }
  if (frequency === "irregular") {
    notes.push("Historique irrégulier : aucune échéance ne peut être projetée honnêtement.");
    return { frequency, projections: [], skippedReason: "irregular", notes };
  }

  // Changement de fréquence : le nombre de versements de la dernière année complète diffère.
  const perYear = countPerYear(sorted);
  const years = [...perYear.keys()].sort();
  if (years.length >= 2) {
    const lastCount = perYear.get(years[years.length - 1]) ?? 0;
    const previousCount = perYear.get(years[years.length - 2]) ?? 0;
    if (lastCount !== previousCount && lastCount > 0 && previousCount > 0) {
      notes.push(`Nombre de versements passé de ${previousCount} à ${lastCount} par an : la projection suit le rythme le plus récent, avec une confiance réduite.`);
    }
  }

  const announcedMonths = new Set<string>();
  for (const point of announced) {
    const reference = point.paymentDate ?? point.exDate;
    if (reference) announcedMonths.add(monthOf(reference));
  }

  const horizonStart = monthOf(today);
  const horizonEnd = addMonths(horizonStart, horizonMonths - 1);
  const period = periodMonths(frequency);
  const projections: ProjectedDividend[] = [];

  for (const slot of groupIntoSlots(usable, frequency)) {
    const reference = [...slot].sort((a, b) => b.exDate.localeCompare(a.exDate))[0];
    const amount = prudentAmount(slot);
    if (!(amount > 0)) continue;
    const confidence = slotConfidence(slot, frequency);
    // Avance d'autant de périodes que nécessaire pour retomber dans l'horizon. Ajouter « une
    // période » à l'aveugle produirait une date déjà passée quand l'historique du fournisseur
    // s'arrête un an en arrière.
    let month = monthOf(reference.exDate);
    let steps = 0;
    while (month < horizonStart && steps < 240) {
      month = addMonths(month, period);
      steps += 1;
    }
    while (month <= horizonEnd && steps < 240) {
      if (!isCoveredByAnnouncement(month, announcedMonths)) {
        projections.push({
          estimatedMonth: month,
          amountPerShare: amount,
          currency: reference.currency,
          dividendType: reference.dividendType === "special" ? "ordinary" : reference.dividendType,
          confidence,
          method: describeMethod(slot, frequency),
          basedOn: slot.map((point) => point.exDate).sort(),
        });
      }
      month = addMonths(month, period);
      steps += 1;
    }
  }

  projections.sort((a, b) => a.estimatedMonth.localeCompare(b.estimatedMonth));
  // Deux créneaux peuvent converger vers le même mois après plusieurs reports : une seule
  // projection par mois, sinon le même versement serait compté deux fois.
  const byMonth = new Map<string, ProjectedDividend>();
  for (const projection of projections) {
    const existing = byMonth.get(projection.estimatedMonth);
    if (!existing || projection.amountPerShare < existing.amountPerShare) byMonth.set(projection.estimatedMonth, projection);
  }
  const deduped = [...byMonth.values()].sort((a, b) => a.estimatedMonth.localeCompare(b.estimatedMonth));

  return {
    frequency,
    projections: deduped,
    skippedReason: deduped.length === 0 ? "fully_announced" : null,
    notes,
  };
}

/** Une annonce dans le mois, ou dans un mois adjacent, couvre l'échéance (fenêtre de 45 jours). */
function isCoveredByAnnouncement(month: string, announcedMonths: Set<string>): boolean {
  if (announcedMonths.has(month)) return true;
  return announcedMonths.has(addMonths(month, -1)) || announcedMonths.has(addMonths(month, 1));
}

function countPerYear(history: HistoricalDividendPoint[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const point of history) {
    const year = point.exDate.slice(0, 4);
    counts.set(year, (counts.get(year) ?? 0) + 1);
  }
  return counts;
}

const FREQUENCY_LABEL: Record<DividendFrequency, string> = {
  monthly: "mensuel",
  quarterly: "trimestriel",
  semiannual: "semestriel",
  annual: "annuel",
  irregular: "irrégulier",
};

function describeMethod(slot: HistoricalDividendPoint[], frequency: DividendFrequency): string {
  const count = slot.length;
  return `Rythme ${FREQUENCY_LABEL[frequency]} observé sur ${count} versement${count > 1 ? "s" : ""}. `
    + "Montant retenu : le plus faible entre le dernier versement et la médiane des trois derniers — aucune croissance n’est extrapolée.";
}

export function frequencyLabel(frequency: DividendFrequency): string {
  return FREQUENCY_LABEL[frequency];
}

/**
 * Détection des dividendes EXCEPTIONNELS lorsque le fournisseur ne les étiquette pas (c'est le
 * cas d'Alpha Vantage et de Yahoo).
 *
 * La règle est déterministe et volontairement stricte, parce qu'une erreur coûte cher dans les
 * deux sens : classer un solde annuel en « exceptionnel » amputerait durablement la projection,
 * et laisser passer un versement de circonstance promettrait un revenu qui ne reviendra pas.
 *
 * Un versement est marqué exceptionnel s'il réunit DEUX conditions :
 *   1. son montant vaut au moins 2,5 fois la médiane des autres versements ;
 *   2. son créneau calendaire est ISOLÉ — aucun autre versement du même mois (±1) une autre
 *      année. Un acompte de décembre suivi d'un solde de mai, tous deux récurrents, échappe donc
 *      à la règle quel que soit l'écart de montant entre les deux.
 * En dessous de quatre versements connus, on ne classe rien : l'échantillon ne permet aucune
 * comparaison honnête.
 */
export function flagSpecialDividends<T extends { exDate: string; amountPerShare: number; dividendType: DividendType; isSpecial: boolean }>(
  points: T[],
): T[] {
  if (points.length < 4) return points;
  const amounts = points.map((point) => point.amountPerShare).filter((amount) => amount > 0);
  const reference = median(amounts);
  if (!(reference > 0)) return points;
  return points.map((point) => {
    if (point.isSpecial || point.dividendType === "special") return point;
    if (point.amountPerShare < reference * 2.5) return point;
    const month = Number(point.exDate.slice(5, 7));
    const year = point.exDate.slice(0, 4);
    const recurring = points.some((other) => {
      if (other === point) return false;
      if (other.exDate.slice(0, 4) === year) return false;
      const gap = Math.abs(Number(other.exDate.slice(5, 7)) - month);
      return gap <= 1 || gap >= 11;
    });
    return recurring ? point : { ...point, dividendType: "special" as DividendType, isSpecial: true };
  });
}

export function confidenceLabel(confidence: Confidence): string {
  return confidence === "high" ? "Confiance élevée" : confidence === "medium" ? "Confiance moyenne" : "Confiance faible";
}
