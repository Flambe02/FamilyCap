// CONSENSUS DE RELECTURE — remplace la confiance auto-déclarée par un signal mesurable.
//
// Constat, mesuré sur un vrai relevé PEA (5 positions, 30 cellules chiffrées) :
//   • le modèle annonce une confiance de 0,90 à 0,98 sur des valeurs FAUSSES
//     (« 1 000 » lu « 100 », « 34 980 » lu « 3 498 », « 87,83 » lu « 83,78 ») ;
//   • augmenter l'effort de raisonnement ne corrige rien — 92 s et 10 880 jetons de
//     raisonnement donnent autant d'erreurs que 16 s sans raisonnement. Lire un tableau est
//     une tâche de PERCEPTION, pas de déduction ;
//   • en revanche les erreurs sont ALÉATOIRES : deux relectures ne se trompent pas sur les
//     mêmes cellules.
//
// D'où cette approche : plusieurs relectures indépendantes, un vote cellule par cellule.
// Mesure sur ce même relevé, 3 passes : 0 erreur survivante parmi les cellules unanimes,
// et les 7 valeurs fausses toutes signalées comme litigieuses. Les passes étant lancées en
// parallèle, le coût en temps est celui d'UNE passe (14 s constatées).
//
// Règle de sûreté : l'unanimité vaut confiance haute ; tout désaccord vaut « à vérifier »
// et n'est JAMAIS résolu silencieusement — la valeur majoritaire est proposée, pas validée.

import { SNAPSHOT_TABLE_HEADER, type ExtractedPositionMeta } from "./extract.ts";

export type PositionPass = { rows: string[][]; meta: ExtractedPositionMeta[] };

export type ConsensusRow = {
  row: string[];
  /** Libellés des colonnes sur lesquelles les relectures divergent (vide = unanimité). */
  disputed: string[];
  /** Valeurs proposées par chaque relecture, par colonne litigieuse. */
  variants: Record<string, string[]>;
  /** Part des colonnes renseignées sur lesquelles toutes les relectures s'accordent (0 à 1). */
  agreement: number;
  /** Nombre de relectures ayant vu cette ligne (une ligne vue par une seule passe est suspecte). */
  seenBy: number;
};

export type ConsensusResult = {
  rows: string[][];
  meta: ExtractedPositionMeta[];
  consensus: ConsensusRow[];
  passes: number;
};

const COLUMN = { name: 0, isin: 1, ticker: 2, quantity: 3, value: 7 } as const;

/**
 * Colonnes DÉCISIVES : celles dont dépend le portefeuille. Un désaccord sur l'une d'elles
 * interdit la confiance haute. Les autres (libellé, devise, variation, poids) sont signalées
 * mais ne déclassent pas une ligne au même titre — un libellé orthographié différemment d'une
 * relecture à l'autre n'a pas les mêmes conséquences qu'une quantité.
 */
const CRITICAL = new Set(["ISIN", "Quantité", "PRU", "Cours", "Valorisation", "+/- values"]);

function words(value: string): Set<string> {
  return new Set(
    String(value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ")
      .filter((token) => token.length > 1),
  );
}

/**
 * Deux lignes de deux relectures désignent-elles la MÊME position ? (0 = non, 1 = certain)
 *
 * Surtout PAS une simple égalité d'ISIN : l'ISIN fait partie de ce que le modèle lit mal
 * (IE0002XZSHO1 relu IE00D2Q55Z01). S'y fier dédoublait les lignes — le même titre apparaissait
 * deux ou trois fois, une par orthographe d'ISIN. Le libellé, long et distinctif, est bien plus
 * stable ; la quantité sert d'appoint.
 */
function similarity(a: string[], b: string[]): number {
  const isinA = (a[COLUMN.isin] ?? "").trim().toUpperCase();
  const isinB = (b[COLUMN.isin] ?? "").trim().toUpperCase();
  if (isinA && isinA === isinB) return 1;

  const wordsA = words(a[COLUMN.name]);
  const wordsB = words(b[COLUMN.name]);
  let score = 0;
  if (wordsA.size > 0 && wordsB.size > 0) {
    const shared = [...wordsA].filter((token) => wordsB.has(token)).length;
    score = shared / Math.min(wordsA.size, wordsB.size); // recouvrement du plus court
  }
  const quantityA = Number(a[COLUMN.quantity]);
  const quantityB = Number(b[COLUMN.quantity]);
  if (Number.isFinite(quantityA) && Number.isFinite(quantityB) && quantityA === quantityB && quantityA !== 0) {
    score = Math.min(1, score + 0.25);
  }
  return score;
}

const MATCH_THRESHOLD = 0.6;

/**
 * Deux écritures d'un même nombre ne doivent pas compter comme un désaccord : « 34980 »,
 * « 34980.0 » et « 34980.00 » sont la même valeur. Les textes, eux, sont comparés bruts
 * (à la casse et aux espaces près) : un libellé n'a pas de forme canonique.
 */
function canonical(value: string): string {
  const trimmed = String(value ?? "").trim();
  if (trimmed === "") return "";
  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber)) return String(Math.round(asNumber * 1e6) / 1e6);
  return trimmed.toUpperCase().replace(/\s+/g, " ");
}

/** Valeur la plus fréquente, en conservant l'ordre d'apparition pour départager les ex æquo. */
function majority(values: string[]): { winner: string; unanimous: boolean } {
  const present = values.filter((value) => canonical(value) !== "");
  if (present.length === 0) return { winner: "", unanimous: true };
  const tally = new Map<string, { count: number; raw: string }>();
  for (const value of present) {
    const key = canonical(value);
    const entry = tally.get(key);
    if (entry) entry.count++;
    else tally.set(key, { count: 1, raw: value });
  }
  let best = { count: 0, raw: present[0] };
  for (const entry of tally.values()) if (entry.count > best.count) best = entry;
  // Unanime = une seule valeur distincte ET toutes les relectures l'ont renseignée.
  return { winner: best.raw, unanimous: tally.size === 1 && present.length === values.length };
}

/**
 * Réconcilie N relectures du même document. Les lignes sont rapprochées par ISIN (à défaut
 * ticker, à défaut nom normalisé) : l'ordre des lignes peut varier d'une relecture à l'autre.
 */
export function reconcilePositionPasses(passes: PositionPass[]): ConsensusResult {
  const usable = passes.filter((pass) => pass && pass.rows.length > 0);
  if (usable.length === 0) return { rows: [], meta: [], consensus: [], passes: 0 };
  if (usable.length === 1) {
    // Une seule relecture exploitable : aucun vote possible. On ne prétend PAS à un consensus —
    // toutes les lignes sont marquées non confirmées, ce que l'écran de vérification signale.
    return {
      rows: usable[0].rows,
      meta: usable[0].meta,
      consensus: usable[0].rows.map(() => ({ row: [], disputed: [], variants: {}, agreement: 0, seenBy: 1 })),
      passes: 1,
    };
  }

  // Référence : la relecture la plus complète fixe la liste et l'ordre des positions.
  const reference = usable.reduce((best, current) => (current.rows.length > best.rows.length ? current : best), usable[0]);
  const groups: Array<Array<{ row: string[]; meta: ExtractedPositionMeta }>> = reference.rows.map((row, i) => [{ row, meta: reference.meta[i] }]);

  // Chaque autre relecture est APPARIÉE à la référence, au mieux et une seule fois par position
  // (appariement glouton par similarité décroissante). Une ligne sans correspondance devient un
  // groupe à part : elle sera signalée comme vue par une seule relecture, jamais fondue ailleurs.
  for (const pass of usable) {
    if (pass === reference) continue;
    const taken = new Set<number>();
    const pairs: Array<{ score: number; from: number; to: number }> = [];
    pass.rows.forEach((row, from) => {
      groups.forEach((group, to) => {
        const score = similarity(row, group[0].row);
        if (score >= MATCH_THRESHOLD) pairs.push({ score, from, to });
      });
    });
    pairs.sort((a, b) => b.score - a.score);
    const assigned = new Set<number>();
    for (const pair of pairs) {
      if (assigned.has(pair.from) || taken.has(pair.to)) continue;
      assigned.add(pair.from);
      taken.add(pair.to);
      groups[pair.to].push({ row: pass.rows[pair.from], meta: pass.meta[pair.from] });
    }
    pass.rows.forEach((row, index) => {
      if (!assigned.has(index)) groups.push([{ row, meta: pass.meta[index] }]);
    });
  }

  const rows: string[][] = [];
  const meta: ExtractedPositionMeta[] = [];
  const consensus: ConsensusRow[] = [];

  for (const seen of groups) {
    const row: string[] = [];
    const disputed: string[] = [];
    const variants: Record<string, string[]> = {};
    let comparable = 0;
    let agreed = 0;

    for (let column = 0; column < SNAPSHOT_TABLE_HEADER.length; column++) {
      const values = seen.map((entry) => entry.row[column] ?? "");
      const { winner, unanimous } = majority(values);
      row[column] = winner;
      if (values.some((value) => canonical(value) !== "")) {
        comparable++;
        if (unanimous && seen.length === usable.length) agreed++;
        else {
          const label = SNAPSHOT_TABLE_HEADER[column];
          disputed.push(label);
          variants[label] = values.map((value) => (String(value).trim() === "" ? "—" : value));
        }
      }
    }

    // Avertissements : l'union de ceux de chaque relecture, plus le rappel des divergences.
    const warnings = [...new Set(seen.flatMap((entry) => entry.meta?.warnings ?? []))];
    if (seen.length < usable.length) {
      warnings.push(`Ligne absente de ${usable.length - seen.length} relecture(s) sur ${usable.length} : vérifiez qu'elle figure bien au relevé.`);
    }
    for (const label of disputed) {
      warnings.push(`« ${label} » lu différemment d'une relecture à l'autre (${variants[label].join(" / ")}) : la valeur la plus fréquente est proposée, vérifiez-la.`);
    }

    const agreement = comparable === 0 ? 0 : agreed / comparable;
    const criticalDisputed = disputed.some((label) => CRITICAL.has(label));
    const complete = seen.length === usable.length;
    rows.push(row);
    meta.push({
      // La confiance affichée est désormais l'ACCORD MESURÉ entre relectures, pas la confiance
      // que le modèle s'attribue — celle-ci valait 0,98 sur des valeurs fausses.
      confidence: agreement,
      // « high » exige l'unanimité pleine ; un désaccord sur une colonne décisive (quantité,
      // prix, valorisation…) fait directement tomber en « low », donc décoché par défaut.
      band: disputed.length === 0 && complete ? "high" : criticalDisputed || !complete ? "low" : "medium",
      page: seen[0]?.meta?.page ?? null,
      sourceText: seen[0]?.meta?.sourceText ?? null,
      warnings,
      lastMovementDate: seen[0]?.meta?.lastMovementDate ?? null,
    });
    consensus.push({ row, disputed, variants, agreement, seenBy: seen.length });
  }

  return { rows, meta, consensus, passes: usable.length };
}
