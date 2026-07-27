// Lecture des NOMBRES et des DATES tels qu'ils sont IMPRIMÉS sur un relevé de courtier.
//
// Ce module ne sert qu'à une chose : convertir la chaîne recopiée d'une capture d'écran en
// nombre JavaScript, sans jamais inventer ni perdre d'information. Il est distinct de
// `parseDecimal` (lib/investment-import.ts), qui tranche l'ambiguïté FR/US d'un FICHIER
// tabulaire : ici on lit un relevé français affiché à l'écran, où la virgule est toujours
// décimale et où les pièges sont typographiques plutôt que culturels.
//
// Pièges réellement rencontrés sur les captures Boursobank (d'où chaque règle ci-dessous) :
//   • « 177 418,34 € » — espace INSÉCABLE (U+00A0) ou fine insécable (U+202F) en séparateur de
//     milliers. Supprimer les seuls espaces ASCII laissait la chaîne intacte, donc illisible.
//   • « 5 000 » — la quantité. Si l'espace n'est pas traité comme séparateur de milliers, la
//     valeur devient 5 : une position de 34 325 € tombe à 34 €. C'est le contrôle n° 7.
//   • « - 4 247,89 € » — signe détaché du chiffre, parfois signe moins UNICODE (U+2212) ou
//     tiret demi-cadratin (U+2013). Sans cette règle une moins-value devenait une plus-value
//     (contrôle n° 10).
//   • « (1 234,56) » — négatif entre parenthèses (convention comptable de certains exports).
//
// Règle de sûreté : en cas de doute irréductible, on renvoie null. Jamais de valeur par défaut.
//
// Les classes de caractères sont écrites en séquences d'échappement \uXXXX : ces caractères sont
// INVISIBLES dans un éditeur, et une classe qui les contiendrait littéralement se dégraderait
// silencieusement au premier copier-coller (c'est arrivé pendant l'écriture de ce fichier).

/** Espaces employés comme séparateurs de milliers : ASCII, insécable, fines, ponctuation. */
const SPACE_CLASS = /[\s      ⁠]/g;
/** Signes moins autres que le trait d'union ASCII, recopiés tels quels par les modèles. */
const MINUS_CLASS = /[−‒–—➖]/g;
/** Bruit à écarter : tout sauf chiffres, séparateurs décimaux et espaces de milliers. */
const NOISE = /[^0-9.,\s      ⁠]/g;

export type StatementNumberIssue = "empty" | "not_a_number" | "ambiguous_thousands";

export type StatementNumberResult = {
  value: number | null;
  /** Texte d'origine, conservé pour expliquer une correction à l'utilisateur. */
  raw: string;
  issue: StatementNumberIssue | null;
};

/**
 * Convertit un montant, une quantité ou un pourcentage imprimé sur un relevé français.
 *
 * Un nombre JSON est renvoyé tel quel (le modèle a déjà fait la conversion) ; seule une CHAÎNE
 * est analysée. Les symboles (€, $, %, EUR…) sont ignorés — la devise se lit ailleurs, jamais
 * dans le montant (exigence « la devise séparée des montants »).
 */
export function parseStatementNumber(input: unknown): StatementNumberResult {
  if (typeof input === "number") {
    const finite = Number.isFinite(input);
    return { value: finite ? input : null, raw: String(input), issue: finite ? null : "not_a_number" };
  }
  const raw = input === null || input === undefined ? "" : String(input);
  const text = raw.trim().replace(MINUS_CLASS, "-");
  if (!text) return { value: null, raw, issue: "empty" };

  // Signe : parenthèses comptables, ou tout « - » placé AVANT le premier chiffre (le signe est
  // souvent détaché : « - 4 247,89 € »), ou un « - » final (exports mainframe).
  const firstDigit = text.search(/[0-9]/);
  if (firstDigit < 0) return { value: null, raw, issue: "not_a_number" };
  let negative = /^\(.*\)$/.test(text)
    || text.slice(0, firstDigit).includes("-")
    || /-\s*$/.test(text);

  const kept = text.replace(/[()]/g, "").replace(NOISE, "");
  if (!/[0-9]/.test(kept)) return { value: null, raw, issue: "not_a_number" };

  // Les espaces séparent les milliers : « 5 000 » → « 5000 », « 177 418,34 » → « 177418,34 ».
  const compact = kept.replace(SPACE_CLASS, "");
  const commas = (compact.match(/,/g) ?? []).length;
  const dots = (compact.match(/\./g) ?? []).length;

  let normalized = compact;
  let issue: StatementNumberIssue | null = null;
  if (commas > 0 && dots > 0) {
    // Les deux séparateurs présents : le DERNIER est le décimal, quelle que soit la convention.
    normalized = compact.lastIndexOf(",") > compact.lastIndexOf(".")
      ? compact.split(".").join("").replace(/,/g, ".")
      : compact.split(",").join("");
  } else if (commas > 0) {
    // Relevé français : la virgule est décimale. Plusieurs virgules = milliers anglo-saxons
    // recopiés (« 1,234,567 ») : elles sont alors toutes des séparateurs de milliers.
    normalized = commas === 1 ? compact.replace(",", ".") : compact.split(",").join("");
  } else if (dots > 1) {
    normalized = compact.split(".").join(""); // « 1.234.567 » : points de milliers
  } else if (dots === 1 && /^\d{1,3}\.\d{3}$/.test(compact)) {
    // « 1.000 » sur un relevé français : la virgule y étant décimale, le point ne peut être
    // qu'un séparateur de milliers. On tranche dans ce sens, mais on le SIGNALE pour que
    // l'écran de validation l'affiche au lieu de l'appliquer en silence.
    normalized = compact.replace(".", "");
    issue = "ambiguous_thousands";
  }

  const value = Number(normalized);
  if (!Number.isFinite(value)) return { value: null, raw, issue: "not_a_number" };
  if (value === 0) negative = false; // « -0 » n'existe pas sur un relevé
  return { value: negative ? -value : value, raw, issue };
}

/** Raccourci : la valeur seule (null si illisible). */
export function statementNumber(input: unknown): number | null {
  return parseStatementNumber(input).value;
}

/**
 * Pourcentage imprimé. Identique au nombre, à un détail près : « 22,63 % » et « 22,63 » valent
 * tous deux 22.63 — jamais 0.2263. Le relevé imprime des points de pourcentage.
 */
export function statementPercent(input: unknown): number | null {
  return statementNumber(input);
}

const MONTHS_FR: Record<string, number> = {
  janvier: 1, janv: 1, jan: 1, fevrier: 2, fevr: 2, fev: 2, mars: 3, avril: 4, avr: 4,
  mai: 5, juin: 6, juillet: 7, juil: 7, aout: 8, septembre: 9, sept: 9, sep: 9,
  octobre: 10, oct: 10, novembre: 11, nov: 11, decembre: 12, dec: 12,
};

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function realDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || year < 1900 || year > 2100) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/**
 * Date imprimée sur un relevé français → ISO `YYYY-MM-DD`.
 * Accepte « 25/07/2026 », « 25-07-2026 », « 22.11.2023 », « 2026-07-25 » et « 25 juillet 2026 ».
 * Le jour précède TOUJOURS le mois : un relevé Boursobank n'est jamais au format américain.
 */
export function parseStatementDate(input: unknown): string | null {
  const text = String(input ?? "").trim().toLowerCase();
  if (!text) return null;

  const isoMatch = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(text);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    return realDate(year, month, day) ? `${year}-${pad(month)}-${pad(day)}` : null;
  }

  const frMatch = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(text);
  if (frMatch) {
    const day = Number(frMatch[1]);
    const month = Number(frMatch[2]);
    let year = Number(frMatch[3]);
    if (year < 100) year += year < 70 ? 2000 : 1900;
    return realDate(year, month, day) ? `${year}-${pad(month)}-${pad(day)}` : null;
  }

  const ascii = text.normalize("NFD").replace(/[̀-ͯ]/g, "");
  const literal = /^(\d{1,2})\s+([a-z.]+)\s+(\d{4})/.exec(ascii);
  if (literal) {
    const day = Number(literal[1]);
    const month = MONTHS_FR[literal[2].replace(/\.$/, "")];
    const year = Number(literal[3]);
    if (month && realDate(year, month, day)) return `${year}-${pad(month)}-${pad(day)}`;
  }
  return null;
}
