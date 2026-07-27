// RELEVÉ DE PORTEFEUILLE (capture d'écran de courtier) → modèle canonique + CONTRÔLES COMPTABLES
// + conversion en opérations `account_operations`.
//
// Ce module est PUR et testable : aucun réseau, aucun accès Supabase, aucune dépendance React.
// Il occupe exactement une place dans la chaîne :
//
//   image → [modèle vision, serveur] → JSON → ZOD (contrat strict) → toStatement()  ← ICI
//         → runAccountingChecks()   ← ICI (arithmétique déterministe, jamais l'IA)
//         → buildStatementOperations() ← ICI (relevé → opérations)
//         → validation humaine → /commit → account_operations → computeAccountModel()
//
// Trois règles non négociables :
//  1. L'IA ne CALCULE rien. Elle recopie ; tout ce qui s'additionne, se divise ou se compare est
//     refait ici, en code. La conformité au schéma JSON n'est pas une preuve d'exactitude.
//  2. Le portefeuille reste DÉRIVÉ de `account_operations` par computeAccountModel. On n'écrit
//     jamais une position dans `holdings` (qui n'est qu'un référentiel de prix), et il n'existe
//     aucune seconde table de positions.
//  3. Le coût historique d'une position ne se déduit JAMAIS du prix de revient affiché : ce
//     dernier est arrondi par la banque (cf. `costBasisOf`).

import { z } from "zod";
import { isValidIsin, type NormalizedOp } from "../investment-import.ts";
import { parseStatementDate, parseStatementNumber, statementNumber } from "./statement-number.ts";
import { detectBroker, type BrokerId } from "./brokers.ts";

// ==========================================================================================
// 1) CONTRAT DE SORTIE DU MODÈLE — schéma Zod STRICT
// ==========================================================================================
// `z.strictObject` refuse toute clé non prévue : c'est ce qui rend le contrat vérifiable plutôt
// que déclaratif. Un modèle qui ajoute « total_estime » ou « commentaire » est signalé, jamais
// silencieusement accepté — une clé inventée est souvent le symptôme d'une valeur inventée.
//
// Deux niveaux, volontairement :
//   • parse STRICT   → le modèle a respecté le contrat ; c'est le cas nominal.
//   • parse TOLÉRANT → le contrat n'est pas respecté (clé en trop, valeur nue au lieu de
//     {value,confidence}…). Plutôt que de jeter une lecture par ailleurs correcte, on la
//     récupère ET on le signale à l'écran de validation, qui affichera le manquement.

const scalar = z.union([z.number(), z.string(), z.boolean(), z.null()]);

const field = z.strictObject({
  value: scalar.optional(),
  confidence: z.number().min(0).max(1).optional(),
  page: z.number().nullable().optional(),
  /** Texte exact lu sur l'image, conservé le temps de la validation pour expliquer une correction. */
  raw: z.string().nullable().optional(),
});

const positionSchema = z.strictObject({
  instrument_name: field.optional(),
  isin: field.optional(),
  ticker: field.optional(),
  quantity: field.optional(),
  average_cost: field.optional(),
  last_price: field.optional(),
  current_value: field.optional(),
  day_change_pct: field.optional(),
  gain_amount: field.optional(),
  gain_pct: field.optional(),
  weight_pct: field.optional(),
  currency: field.optional(),
  last_movement_date: field.optional(),
  source_text: z.string().nullable().optional(),
  page: z.number().nullable().optional(),
  warnings: z.array(z.string()).optional(),
});

const documentSchema = z.strictObject({
  institution: field.optional(),
  account_type: field.optional(),
  account_name: field.optional(),
  account_number: field.optional(),
  currency: field.optional(),
  holder: field.optional(),
  period: field.optional(),
  as_of_date: field.optional(),
  opening_date: field.optional(),
  management_mode: field.optional(),
  total_portfolio: field.optional(),
  available_cash: field.optional(),
  securities_value: field.optional(),
  unrealized_gain: field.optional(),
  unrealized_gain_pct: field.optional(),
  deposit_ceiling: field.optional(),
  cumulative_deposits: field.optional(),
  // Alias historiques du schéma « opérations » : conservés pour ne pas casser l'existant.
  total_valuation: field.optional(),
  total_gain: field.optional(),
  cash_balance: field.optional(),
  /** Intitulés recopiés verbatim : ils servent à reconnaître le courtier (cf. brokers.ts). */
  detected_markers: z.array(z.string()).optional(),
});

/** Contrat complet attendu du modèle pour un relevé de POSITIONS. */
export const StatementExtractionSchema = z.strictObject({
  document: documentSchema.optional(),
  positions: z.array(positionSchema).optional(),
  operations: z.array(z.unknown()).optional(),
});

export type StatementExtraction = z.infer<typeof StatementExtractionSchema>;

export type SchemaVerdict = {
  /** true = le modèle a produit exactement le schéma demandé. */
  strict: boolean;
  data: StatementExtraction;
  /** Manquements relevés (au plus 8, lisibles par un humain). */
  issues: string[];
};

/**
 * Valide la sortie du modèle contre le contrat. En cas de manquement, la donnée est récupérée
 * en mode tolérant (clés inconnues retirées) et les manquements sont RENDUS VISIBLES.
 */
export function parseModelStatement(input: unknown): SchemaVerdict {
  const strict = StatementExtractionSchema.safeParse(input);
  if (strict.success) return { strict: true, data: strict.data, issues: [] };

  const issues = strict.error.issues.slice(0, 8).map((issue) => {
    const path = issue.path.length ? issue.path.join(".") : "(racine)";
    return `${path} : ${issue.message}`;
  });
  // Repli tolérant : on retire les clés inconnues plutôt que de perdre toute la lecture.
  const cleaned = stripUnknown(input);
  const loose = StatementExtractionSchema.safeParse(cleaned);
  return {
    strict: false,
    data: loose.success ? loose.data : { document: {}, positions: [] },
    issues: loose.success ? issues : [...issues, "La lecture n'a pas pu être récupérée : réessayez l'analyse."],
  };
}

/** Retire récursivement les clés absentes du contrat (repli, jamais le chemin nominal). */
function stripUnknown(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const root = input as Record<string, unknown>;
  const documentKeys = Object.keys(documentSchema.shape);
  const positionKeys = Object.keys(positionSchema.shape);
  const fieldKeys = ["value", "confidence", "page", "raw"];

  const pickField = (value: unknown): unknown => {
    if (value === null || value === undefined) return undefined;
    if (typeof value !== "object" || Array.isArray(value)) return { value: value as never };
    const out: Record<string, unknown> = {};
    for (const key of fieldKeys) {
      const candidate = (value as Record<string, unknown>)[key];
      if (candidate !== undefined) out[key] = key === "confidence" ? clamp01(candidate) : candidate;
    }
    return Object.keys(out).length ? out : undefined;
  };

  const document: Record<string, unknown> = {};
  const rawDocument = (root.document ?? root.metadata) as Record<string, unknown> | undefined;
  if (rawDocument && typeof rawDocument === "object") {
    for (const key of documentKeys) {
      if (key === "detected_markers") {
        const markers = rawDocument[key];
        if (Array.isArray(markers)) document[key] = markers.filter((entry) => typeof entry === "string");
        continue;
      }
      const picked = pickField(rawDocument[key]);
      if (picked !== undefined) document[key] = picked;
    }
  }

  const positions = Array.isArray(root.positions) ? root.positions : [];
  const cleanPositions = positions
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
    .map((entry) => {
      const out: Record<string, unknown> = {};
      for (const key of positionKeys) {
        if (key === "source_text") { if (typeof entry[key] === "string") out[key] = entry[key]; continue; }
        if (key === "page") { if (typeof entry[key] === "number") out[key] = entry[key]; continue; }
        if (key === "warnings") { if (Array.isArray(entry[key])) out[key] = (entry[key] as unknown[]).filter((w) => typeof w === "string"); continue; }
        const picked = pickField(entry[key]);
        if (picked !== undefined) out[key] = picked;
      }
      return out;
    });

  return { document, positions: cleanPositions };
}

function clamp01(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : undefined;
}

// ==========================================================================================
// 2) MODÈLE CANONIQUE DU RELEVÉ
// ==========================================================================================

export type ConfidenceBand = "high" | "medium" | "low";

export type StatementHeader = {
  broker: BrokerId;
  brokerLabel: string | null;
  institution: string | null;
  /** Type canonique de l'application (PEA / compte-titres), déduit du libellé lu. */
  accountType: "PEA" | "CTO" | null;
  accountName: string | null;
  /**
   * Numéro de compte MASQUÉ (quatre derniers caractères). Le numéro complet n'est ni renvoyé au
   * navigateur, ni stocké, ni journalisé : il ne sert qu'au masquage, ici, côté serveur.
   */
  accountNumberMasked: string | null;
  snapshotDate: string | null;
  openingDate: string | null;
  managementMode: string | null;
  totalPortfolio: number | null;
  availableCash: number | null;
  securitiesValue: number | null;
  unrealizedGain: number | null;
  unrealizedGainPercent: number | null;
  depositCeiling: number | null;
  cumulativeDeposits: number | null;
  currency: string;
  /** Confiance déclarée par le modèle, par champ (0..1). Indicative, jamais probante. */
  confidence: Record<string, number>;
  /** Texte exact lu, par champ — conservé le temps de la validation pour expliquer un écart. */
  raw: Record<string, string>;
};

export type StatementPosition = {
  index: number;
  name: string | null;
  isin: string | null;
  ticker: string | null;
  quantity: number | null;
  /** Prix de revient tel qu'AFFICHÉ par la banque : arrondi, informatif, jamais multiplié. */
  averageCostDisplayed: number | null;
  currentPrice: number | null;
  dailyChangePercent: number | null;
  marketValue: number | null;
  unrealizedGain: number | null;
  unrealizedGainPercent: number | null;
  lastMovementDate: string | null;
  currency: string;
  /** Coût historique retenu (cf. costBasisOf) et sa provenance. */
  costBasis: number | null;
  costBasisSource: "gain" | "average_cost" | null;
  confidence: Record<string, number>;
  raw: Record<string, string>;
  lineConfidence: number;
  band: ConfidenceBand;
  page: number | null;
  sourceText: string | null;
  warnings: string[];
};

export type BrokerStatement = {
  header: StatementHeader;
  positions: StatementPosition[];
  /** Avertissements de niveau document (schéma non respecté, courtier non reconnu…). */
  warnings: string[];
};

export type ToStatementOptions = {
  accountCurrency: string;
  /** Date d'arrêté saisie par l'administrateur, utilisée seulement si le relevé n'en porte pas. */
  fallbackSnapshotDate?: string | null;
  thresholds?: { high: number; low: number };
};

const DEFAULT_THRESHOLDS = { high: 0.85, low: 0.6 };

function fieldOf(input: unknown): { value: unknown; confidence: number; raw: string | null; page: number | null } {
  if (input === null || input === undefined) return { value: null, confidence: 0, raw: null, page: null };
  if (typeof input !== "object" || Array.isArray(input)) return { value: input, confidence: 0.65, raw: null, page: null };
  const record = input as Record<string, unknown>;
  const confidence = Number(record.confidence);
  return {
    value: record.value ?? null,
    // Une valeur nue (sans confiance déclarée) reste « à vérifier » : 0,65, jamais 1.
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.65,
    raw: typeof record.raw === "string" ? record.raw : null,
    page: typeof record.page === "number" ? record.page : null,
  };
}

function text(value: unknown): string | null {
  const s = value === null || value === undefined ? "" : String(value).trim();
  return s || null;
}

/** Quatre derniers caractères visibles : « 00088051306 » → « •••• 1306 ». */
export function maskAccountNumber(value: string | null | undefined): string | null {
  const digits = String(value ?? "").replace(/[^0-9A-Za-z]/g, "");
  if (!digits) return null;
  return digits.length <= 4 ? `•••• ${digits}` : `•••• ${digits.slice(-4)}`;
}

function accountTypeOf(raw: string | null, accountName: string | null): "PEA" | "CTO" | null {
  const haystack = `${raw ?? ""} ${accountName ?? ""}`.toLowerCase();
  if (/\bpea\b/.test(haystack)) return "PEA";
  if (/securities|compte[- ]titres?|\bcto\b|ordinaire/.test(haystack)) return "CTO";
  return null;
}

/**
 * COÛT HISTORIQUE d'une position.
 *
 * Boursobank affiche un « Px. Revient » ARRONDI : 360 × 87,83 = 31 618,80 € alors que le coût
 * réel est 31 618,69 €. Multiplier la quantité par le prix affiché fabrique donc une erreur de
 * quelques dizaines de centimes par ligne, qui se propage dans la performance et empêche les
 * contrôles comptables de tomber juste.
 *
 * La valorisation et la plus-value latente, elles, sont imprimées au centime : leur DIFFÉRENCE
 * est le coût exact. C'est la source prioritaire ; le produit quantité × prix affiché n'est
 * qu'un repli, signalé comme tel.
 */
export function costBasisOf(position: {
  marketValue: number | null;
  unrealizedGain: number | null;
  quantity: number | null;
  averageCostDisplayed: number | null;
}): { costBasis: number | null; source: "gain" | "average_cost" | null } {
  if (position.marketValue !== null && position.unrealizedGain !== null) {
    return { costBasis: round2(position.marketValue - position.unrealizedGain), source: "gain" };
  }
  if (position.quantity !== null && position.averageCostDisplayed !== null) {
    return { costBasis: round2(position.quantity * position.averageCostDisplayed), source: "average_cost" };
  }
  return { costBasis: null, source: null };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** Convertit la sortie validée du modèle en relevé canonique. Aucun calcul financier ici. */
export function toStatement(extraction: StatementExtraction, options: ToStatementOptions): BrokerStatement {
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  const doc = (extraction.document ?? {}) as Record<string, unknown>;
  const warnings: string[] = [];

  const confidence: Record<string, number> = {};
  const raw: Record<string, string> = {};
  // Le texte d'origine est conservé pour expliquer une correction — SAUF pour le numéro de
  // compte : le garder en clair dans `raw` le ferait ressortir tel quel dans la réponse HTTP,
  // le state du navigateur et le lot d'import, alors que seul son masque doit circuler.
  const NEVER_KEPT_RAW = new Set(["account_number"]);
  const read = (key: string, aliases: string[] = []) => {
    for (const name of [key, ...aliases]) {
      const entry = fieldOf(doc[name]);
      if (entry.value !== null && entry.value !== undefined && String(entry.value).trim() !== "") {
        confidence[key] = entry.confidence;
        if (!NEVER_KEPT_RAW.has(key)) {
          if (entry.raw) raw[key] = entry.raw;
          else if (typeof entry.value === "string") raw[key] = entry.value;
        }
        return entry.value;
      }
    }
    return null;
  };

  const institution = text(read("institution"));
  const accountName = text(read("account_name", ["holder"]));
  const accountNumberRaw = text(read("account_number"));
  const markers = Array.isArray(doc.detected_markers) ? (doc.detected_markers as string[]) : [];
  const positionsRaw = extraction.positions ?? [];

  const detection = detectBroker({
    markers,
    institution,
    freeText: [accountName, text(doc.period as unknown), ...positionsRaw.map((entry) => (typeof entry.source_text === "string" ? entry.source_text : null))],
  });

  const snapshotDate = parseStatementDate(read("as_of_date", ["snapshot_date"]))
    ?? (options.fallbackSnapshotDate ? parseStatementDate(options.fallbackSnapshotDate) : null);
  const currencyRead = text(read("currency"));
  const currency = (currencyRead || options.accountCurrency || "EUR").toUpperCase().slice(0, 3);

  const header: StatementHeader = {
    broker: detection.broker,
    brokerLabel: detection.label,
    institution,
    accountType: accountTypeOf(text(read("account_type")), accountName),
    accountName,
    accountNumberMasked: maskAccountNumber(accountNumberRaw),
    snapshotDate,
    openingDate: parseStatementDate(read("opening_date")),
    managementMode: text(read("management_mode")),
    totalPortfolio: statementNumber(read("total_portfolio")),
    availableCash: statementNumber(read("available_cash", ["cash_balance"])),
    securitiesValue: statementNumber(read("securities_value", ["total_valuation"])),
    unrealizedGain: statementNumber(read("unrealized_gain", ["total_gain"])),
    unrealizedGainPercent: statementNumber(read("unrealized_gain_pct")),
    depositCeiling: statementNumber(read("deposit_ceiling")),
    cumulativeDeposits: statementNumber(read("cumulative_deposits")),
    currency,
    confidence,
    raw,
  };

  if (detection.broker === "unknown") {
    warnings.push(
      `Courtier non reconnu à partir des libellés lus (score ${Math.round(detection.score * 10) / 10}). `
      + "La lecture reste utilisable, mais les contrôles propres au relevé Boursobank ne s'appliquent pas.",
    );
  }

  const positions: StatementPosition[] = [];
  for (const entry of positionsRaw) {
    const record = entry as Record<string, unknown>;
    const conf: Record<string, number> = {};
    const rawCells: Record<string, string> = {};
    const cell = (key: string) => {
      const parsed = fieldOf(record[key]);
      conf[key] = parsed.confidence;
      if (parsed.raw) rawCells[key] = parsed.raw;
      else if (typeof parsed.value === "string") rawCells[key] = parsed.value;
      return parsed.value;
    };

    const name = text(cell("instrument_name"));
    const isin = (text(cell("isin")) ?? "").toUpperCase() || null;
    const ticker = (text(cell("ticker")) ?? "").toUpperCase() || null;
    const quantityCell = parseStatementNumber(cell("quantity"));
    const averageCostDisplayed = statementNumber(cell("average_cost"));
    const currentPrice = statementNumber(cell("last_price"));
    const dailyChangePercent = statementNumber(cell("day_change_pct"));
    const marketValue = statementNumber(cell("current_value"));
    const gainAmount = statementNumber(cell("gain_amount"));
    const gainPct = statementNumber(cell("gain_pct"));
    const lastMovementDate = parseStatementDate(cell("last_movement_date"));
    const positionCurrency = (text(cell("currency")) || currency).toUpperCase().slice(0, 3);

    // Ligne entièrement vide : le modèle a parfois recopié un séparateur de tableau.
    if (!name && !isin && !ticker && quantityCell.value === null) continue;

    const rowWarnings: string[] = [];
    if (isin && !isValidIsin(isin)) {
      rowWarnings.push("ISIN invalide (clé de contrôle) : vérifiez les caractères ambigus (O/0, I/1, S/5).");
    }
    if (!isin && !ticker) rowWarnings.push("Aucun code ISIN ni ticker lu : le rapprochement se fera sur le nom.");
    if (quantityCell.issue === "ambiguous_thousands") {
      rowWarnings.push(`Quantité « ${quantityCell.raw} » : le point a été interprété comme séparateur de milliers. Vérifiez-la.`);
    }
    if (quantityCell.value !== null && quantityCell.value <= 0) rowWarnings.push("Quantité nulle ou négative.");
    for (const entryWarning of entry.warnings ?? []) {
      if (typeof entryWarning === "string" && entryWarning.trim()) rowWarnings.push(entryWarning.trim());
    }

    const { costBasis, source } = costBasisOf({
      marketValue, unrealizedGain: gainAmount, quantity: quantityCell.value, averageCostDisplayed,
    });
    if (source === "average_cost") {
      rowWarnings.push("Coût historique estimé à partir du prix de revient AFFICHÉ (arrondi par la banque) : la valorisation ou la plus-value manquait. Vérifiez-le.");
    }

    // Confiance de LIGNE = minimum des champs qui décident de la position. Une confiance élevée
    // annoncée par le modèle ne vaut rien en soi (mesuré : 0,98 sur des valeurs fausses) ; c'est
    // le consensus entre relectures et les contrôles arithmétiques qui tranchent.
    const lineConfidence = Math.min(
      conf.instrument_name ?? 0,
      conf.quantity ?? 0,
      Math.max(conf.current_value ?? 0, conf.last_price ?? 0),
    );

    positions.push({
      index: positions.length + 1,
      name, isin, ticker,
      quantity: quantityCell.value,
      averageCostDisplayed, currentPrice, dailyChangePercent,
      marketValue,
      unrealizedGain: gainAmount,
      unrealizedGainPercent: gainPct,
      lastMovementDate,
      currency: positionCurrency,
      costBasis,
      costBasisSource: source,
      confidence: conf,
      raw: rawCells,
      lineConfidence,
      band: lineConfidence >= thresholds.high ? "high" : lineConfidence >= thresholds.low ? "medium" : "low",
      page: typeof record.page === "number" ? record.page : null,
      sourceText: typeof record.source_text === "string" ? record.source_text : null,
      warnings: rowWarnings,
    });
  }

  return { header, positions, warnings };
}

// ==========================================================================================
// 2 bis) PONT AVEC LE CONSENSUS DE RELECTURE
// ==========================================================================================
// Le vote cellule par cellule entre relectures indépendantes (consensus.ts) travaille sur le
// tableau canonique `SNAPSHOT_TABLE_HEADER`. Plutôt que d'écrire un SECOND mécanisme de vote
// pour le relevé, on convertit le relevé vers ce tableau, on vote, puis on reconstruit le
// relevé. Une seule machinerie de consensus, éprouvée et déjà testée.

// Correspondance des colonnes de `SNAPSHOT_TABLE_HEADER`, dans l'ordre :
//   0 Libellé · 1 ISIN · 2 Ticker · 3 Quantité · 4 PRU · 5 Cours · 6 Devise
//   7 Valorisation · 8 Var/veille · 9 +/- values · 10 +/- values (%) · 11 Poids

/** Nombre → cellule non ambiguë (point décimal, aucun séparateur de milliers). */
function numCell(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "";
  if (value !== 0 && Math.abs(value) < 1e-4) return value.toFixed(10); // jamais d'exposant
  return String(value);
}

export type StatementPositionMeta = {
  confidence: number;
  band: ConfidenceBand;
  page: number | null;
  sourceText: string | null;
  warnings: string[];
  lastMovementDate: string | null;
};

/** Relevé → tableau canonique + métadonnées, prêt pour `reconcilePositionPasses`. */
export function statementPositionRows(statement: BrokerStatement): { rows: string[][]; meta: StatementPositionMeta[] } {
  const rows = statement.positions.map((position) => [
    position.name ?? "",
    position.isin ?? "",
    position.ticker ?? "",
    numCell(position.quantity),
    numCell(position.averageCostDisplayed),
    numCell(position.currentPrice),
    position.currency,
    numCell(position.marketValue),
    numCell(position.dailyChangePercent),
    numCell(position.unrealizedGain),
    numCell(position.unrealizedGainPercent),
    "",
  ]);
  const meta = statement.positions.map((position) => ({
    confidence: position.lineConfidence,
    band: position.band,
    page: position.page,
    sourceText: position.sourceText,
    warnings: position.warnings,
    lastMovementDate: position.lastMovementDate,
  }));
  return { rows, meta };
}

function numberCell(row: string[], index: number): number | null {
  const value = String(row[index] ?? "").trim();
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : statementNumber(value);
}

/**
 * Tableau voté → relevé. Les valeurs qui ne participent pas au vote (texte OCR d'origine,
 * confiance déclarée par champ) sont reprises de la relecture de RÉFÉRENCE, appariée par ISIN
 * puis par nom : elles n'ont qu'une valeur explicative, jamais décisionnelle.
 */
export function statementFromConsensus(
  reference: BrokerStatement,
  rows: string[][],
  meta: StatementPositionMeta[],
  options: { accountCurrency: string },
): BrokerStatement {
  const byIsin = new Map(reference.positions.filter((p) => p.isin).map((p) => [p.isin as string, p]));
  const byName = new Map(reference.positions.filter((p) => p.name).map((p) => [(p.name as string).toLowerCase(), p]));

  const positions: StatementPosition[] = rows.map((row, order) => {
    const entry = meta[order];
    const name = String(row[0] ?? "").trim() || null;
    const isin = String(row[1] ?? "").trim().toUpperCase() || null;
    const source = (isin ? byIsin.get(isin) : undefined) ?? (name ? byName.get(name.toLowerCase()) : undefined) ?? null;
    const quantity = numberCell(row, 3);
    const marketValue = numberCell(row, 7);
    const unrealizedGain = numberCell(row, 9);
    const averageCostDisplayed = numberCell(row, 4);
    const { costBasis, source: costSource } = costBasisOf({ marketValue, unrealizedGain, quantity, averageCostDisplayed });
    const warnings = [...new Set([...(entry?.warnings ?? [])])];
    if (costSource === "average_cost") {
      warnings.push("Coût historique estimé à partir du prix de revient AFFICHÉ (arrondi par la banque). Vérifiez-le.");
    }
    return {
      index: order + 1,
      name, isin,
      ticker: String(row[2] ?? "").trim().toUpperCase() || null,
      quantity,
      averageCostDisplayed,
      currentPrice: numberCell(row, 5),
      dailyChangePercent: numberCell(row, 8),
      marketValue,
      unrealizedGain,
      unrealizedGainPercent: numberCell(row, 10),
      lastMovementDate: entry?.lastMovementDate ?? source?.lastMovementDate ?? null,
      currency: (String(row[6] ?? "").trim() || options.accountCurrency || "EUR").toUpperCase().slice(0, 3),
      costBasis,
      costBasisSource: costSource,
      confidence: source?.confidence ?? {},
      raw: source?.raw ?? {},
      // La confiance affichée est l'ACCORD MESURÉ entre relectures, pas celle que le modèle
      // s'attribue : mesuré à 0,98 sur des valeurs fausses, elle ne prouve rien.
      lineConfidence: entry?.confidence ?? 0,
      band: entry?.band ?? "low",
      page: entry?.page ?? source?.page ?? null,
      sourceText: entry?.sourceText ?? source?.sourceText ?? null,
      warnings: [...new Set(warnings)],
    };
  });

  return { header: reference.header, positions, warnings: reference.warnings };
}

/**
 * Vote sur l'EN-TÊTE : chaque relecture propose ses totaux, on retient la valeur majoritaire et
 * on signale les champs sur lesquels les relectures divergent. Un total litigieux fait échouer
 * les contrôles comptables — c'est voulu : mieux vaut une validation manuelle qu'un chiffre
 * majoritaire mais faux repris en silence.
 */
export function reconcileHeaders(headers: StatementHeader[]): { header: StatementHeader; disputed: string[] } {
  if (headers.length === 0) throw new Error("reconcileHeaders : aucune relecture.");
  if (headers.length === 1) return { header: headers[0], disputed: [] };

  const numericFields = [
    "totalPortfolio", "availableCash", "securitiesValue", "unrealizedGain",
    "unrealizedGainPercent", "depositCeiling", "cumulativeDeposits",
  ] as const;
  const textFields = ["accountName", "accountNumberMasked", "snapshotDate", "openingDate", "managementMode", "institution"] as const;

  const merged = { ...headers[0] } as StatementHeader & Record<string, unknown>;
  const disputed: string[] = [];

  const vote = <T extends string | number>(field: string, values: T[]) => {
    if (values.length === 0) { merged[field] = null; return; }
    const tally = new Map<T, number>();
    for (const value of values) tally.set(value, (tally.get(value) ?? 0) + 1);
    // Valeur la plus fréquente ; à égalité, celle de la première relecture (ordre d'insertion).
    merged[field] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
    if (tally.size > 1) disputed.push(field);
  };

  for (const field of numericFields) {
    vote(field, headers.map((header) => header[field]).filter((value): value is number => value !== null));
  }
  for (const field of textFields) {
    vote(field, headers.map((header) => header[field]).filter((value): value is string => Boolean(value)));
  }

  return { header: merged as StatementHeader, disputed };
}

// ==========================================================================================
// 3) CONTRÔLES COMPTABLES DÉTERMINISTES
// ==========================================================================================
// Tout est refait en code. Ces contrôles sont la vraie garantie : ils détectent une ligne
// oubliée, un chiffre mal lu ou un signe perdu, là où la confiance auto-déclarée du modèle ne
// détecte rien. Un contrôle « bloquant » en échec interdit l'import automatique.

export type CheckSeverity = "blocking" | "warning" | "info";

export type AccountingCheck = {
  id: string;
  label: string;
  scope: "header" | "position";
  /** Index (1-based) de la position concernée, pour pointer le champ fautif dans l'écran. */
  positionIndex?: number;
  /** Champ concerné, pour surligner la bonne cellule. */
  field?: string;
  expected: number | null;
  actual: number | null;
  delta: number | null;
  tolerance: number;
  ok: boolean;
  severity: CheckSeverity;
  message: string;
};

/** Tolérance des sommes comptables imprimées : le relevé est au centime. */
export const MONEY_TOLERANCE = 0.02;
/** Tolérance des pourcentages imprimés (deux décimales). */
const PERCENT_TOLERANCE = 0.05;
/**
 * Tolérance de « quantité × cours ≈ valorisation ». Le cours est affiché à deux décimales : la
 * valeur vraie est à ±0,005 près, soit une erreur pouvant atteindre quantité × 0,005. Sur une
 * ligne de 5 000 parts cela fait 25 € — parfaitement normal, et non une erreur de lecture.
 */
export function priceRoundingTolerance(quantity: number): number {
  return Math.abs(quantity) * 0.005 + MONEY_TOLERANCE;
}

function sumOf(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : round2(present.reduce((total, value) => total + value, 0));
}

function check(params: Omit<AccountingCheck, "ok" | "delta"> & { ok?: boolean }): AccountingCheck {
  const delta = params.expected !== null && params.actual !== null ? round2(params.actual - params.expected) : null;
  const ok = params.ok ?? (delta === null ? true : Math.abs(delta) <= params.tolerance + 1e-9);
  return { ...params, delta, ok };
}

/**
 * Exécute tous les contrôles comptables sur un relevé. Le résultat est ORDONNÉ : contrôles de
 * document d'abord (ce sont eux qui disent si une ligne manque), puis contrôles de ligne.
 */
export function runAccountingChecks(statement: BrokerStatement): AccountingCheck[] {
  const { header, positions } = statement;
  const checks: AccountingCheck[] = [];

  // 1) Total portefeuille = évaluation titres + espèces.
  if (header.totalPortfolio !== null && (header.securitiesValue !== null || header.availableCash !== null)) {
    const expected = round2((header.securitiesValue ?? 0) + (header.availableCash ?? 0));
    checks.push(check({
      id: "total_vs_parts", scope: "header", field: "totalPortfolio",
      label: "Total portefeuille = évaluation titres + espèces",
      expected, actual: header.totalPortfolio, tolerance: MONEY_TOLERANCE, severity: "blocking",
      message: `Titres ${fmt(header.securitiesValue)} + espèces ${fmt(header.availableCash)} = ${fmt(expected)} ; total imprimé ${fmt(header.totalPortfolio)}.`,
    }));
  }

  // 2) Somme des valorisations de ligne = évaluation titres imprimée. Le contrôle qui détecte
  //    une ligne oubliée — aucune confiance déclarée ne le remplace.
  const sumMarketValue = sumOf(positions.map((position) => position.marketValue));
  if (header.securitiesValue !== null && sumMarketValue !== null) {
    checks.push(check({
      id: "sum_positions", scope: "header", field: "securitiesValue",
      label: "Somme des positions = évaluation titres",
      expected: header.securitiesValue, actual: sumMarketValue, tolerance: MONEY_TOLERANCE, severity: "blocking",
      message: `${positions.length} ligne(s) retranscrite(s) pour ${fmt(sumMarketValue)} ; évaluation titres imprimée ${fmt(header.securitiesValue)}.`,
    }));
  }

  // 3) Somme des plus-values de ligne = plus-value latente imprimée.
  const sumGain = sumOf(positions.map((position) => position.unrealizedGain));
  if (header.unrealizedGain !== null && sumGain !== null) {
    checks.push(check({
      id: "sum_gains", scope: "header", field: "unrealizedGain",
      label: "Somme des +/- values = +/- values latentes",
      expected: header.unrealizedGain, actual: sumGain, tolerance: MONEY_TOLERANCE, severity: "blocking",
      message: `Somme des lignes ${fmt(sumGain)} ; +/- values latentes imprimées ${fmt(header.unrealizedGain)}.`,
    }));
  }

  // 3 bis) Cohérence du pourcentage global de plus-value.
  const globalCost = header.securitiesValue !== null && header.unrealizedGain !== null
    ? round2(header.securitiesValue - header.unrealizedGain) : null;
  if (header.unrealizedGainPercent !== null && globalCost !== null && globalCost > 0 && header.unrealizedGain !== null) {
    const expected = round2((header.unrealizedGain / globalCost) * 100);
    checks.push(check({
      id: "global_gain_pct", scope: "header", field: "unrealizedGainPercent",
      label: "Pourcentage global de +/- value",
      expected, actual: header.unrealizedGainPercent, tolerance: PERCENT_TOLERANCE, severity: "warning",
      message: `${fmt(header.unrealizedGain)} ÷ ${fmt(globalCost)} = ${expected} % ; imprimé ${header.unrealizedGainPercent} %.`,
    }));
  }

  // 4) Par ligne : quantité × cours ≈ valorisation.
  for (const position of positions) {
    const label = position.name ?? position.isin ?? `ligne ${position.index}`;
    if (position.quantity !== null && position.currentPrice !== null && position.marketValue !== null) {
      const expected = round2(position.quantity * position.currentPrice);
      checks.push(check({
        id: `qty_price_${position.index}`, scope: "position", positionIndex: position.index, field: "marketValue",
        label: `${label} — quantité × cours = valorisation`,
        expected, actual: position.marketValue,
        // BLOQUANT : la tolérance couvre déjà tout l'arrondi possible du cours affiché
        // (quantité × 0,005). Ce qui la dépasse est une quantité ou un cours mal lu — c'est ce
        // contrôle, et lui seul, qui rattrape un « 5 000 » retranscrit « 5 ».
        tolerance: priceRoundingTolerance(position.quantity), severity: "blocking",
        message: `${position.quantity} × ${position.currentPrice} = ${expected} ; valorisation lue ${fmt(position.marketValue)}. Un écart supérieur à l'arrondi du cours trahit une quantité ou un cours mal lu.`,
      }));
    }

    // 5) Par ligne : +/- value % ≈ +/- value ÷ coût historique.
    if (position.unrealizedGainPercent !== null && position.costBasis !== null && position.costBasis > 0 && position.unrealizedGain !== null) {
      const expected = round2((position.unrealizedGain / position.costBasis) * 100);
      checks.push(check({
        id: `gain_pct_${position.index}`, scope: "position", positionIndex: position.index, field: "unrealizedGainPercent",
        label: `${label} — pourcentage de +/- value`,
        expected, actual: position.unrealizedGainPercent,
        tolerance: Math.max(PERCENT_TOLERANCE, Math.abs(position.unrealizedGainPercent) * 0.005), severity: "warning",
        message: `${fmt(position.unrealizedGain)} ÷ coût ${fmt(position.costBasis)} = ${expected} % ; imprimé ${position.unrealizedGainPercent} %.`,
      }));
    }

    // 10/11) Signes : montant et pourcentage de +/- value doivent aller dans le MÊME sens.
    //        C'est ce contrôle qui rattrape un « - » perdu à la lecture (valeur rouge lue en
    //        positif), là où la couleur ne prouve rien.
    if (position.unrealizedGain !== null && position.unrealizedGainPercent !== null
      && Math.abs(position.unrealizedGain) > 1e-9 && Math.abs(position.unrealizedGainPercent) > 1e-9
      && Math.sign(position.unrealizedGain) !== Math.sign(position.unrealizedGainPercent)) {
      checks.push({
        id: `gain_sign_${position.index}`, scope: "position", positionIndex: position.index, field: "unrealizedGain",
        label: `${label} — signe de la +/- value`,
        expected: null, actual: null, delta: null, tolerance: 0, ok: false, severity: "blocking",
        message: `La +/- value (${position.unrealizedGain}) et son pourcentage (${position.unrealizedGainPercent} %) n'ont pas le même signe : un « - » a probablement été perdu à la lecture.`,
      });
    }

    // 6) Format de l'ISIN (deux lettres pays + 9 caractères + clé de contrôle).
    if (position.isin) {
      const valid = isValidIsin(position.isin);
      checks.push({
        id: `isin_${position.index}`, scope: "position", positionIndex: position.index, field: "isin",
        label: `${label} — code ISIN`,
        expected: null, actual: null, delta: null, tolerance: 0, ok: valid, severity: "warning",
        message: valid ? `${position.isin} : format et clé de contrôle valides.` : `${position.isin} : clé de contrôle invalide (caractères ambigus O/0, I/1, S/5 ?).`,
      });
    } else {
      checks.push({
        id: `isin_${position.index}`, scope: "position", positionIndex: position.index, field: "isin",
        label: `${label} — code ISIN`,
        expected: null, actual: null, delta: null, tolerance: 0, ok: false, severity: "warning",
        message: "Aucun code ISIN lu : le rapprochement se fera sur le nom, moins fiable.",
      });
    }

    // 7) Quantité plausible : une quantité nulle après lecture est presque toujours un « 5 000 »
    //    lu « 5 » puis contredit par le contrôle 4 ; on la signale explicitement.
    if (position.quantity === null || position.quantity <= 0) {
      checks.push({
        id: `qty_${position.index}`, scope: "position", positionIndex: position.index, field: "quantity",
        label: `${label} — quantité`,
        expected: null, actual: position.quantity, delta: null, tolerance: 0, ok: false, severity: "blocking",
        message: "Quantité absente ou non positive : une position détenue en a toujours une.",
      });
    }
  }

  return checks;
}

function fmt(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export type ChecksSummary = {
  total: number;
  passed: number;
  failed: number;
  blockingFailures: number;
  /** true quand aucun contrôle bloquant n'échoue : l'import peut être proposé à la validation. */
  importable: boolean;
};

export function summarizeChecks(checks: AccountingCheck[]): ChecksSummary {
  const failed = checks.filter((entry) => !entry.ok);
  const blockingFailures = failed.filter((entry) => entry.severity === "blocking").length;
  return {
    total: checks.length,
    passed: checks.length - failed.length,
    failed: failed.length,
    blockingFailures,
    importable: blockingFailures === 0,
  };
}

// ==========================================================================================
// 3 bis) RELEVÉ RENVOYÉ PAR LE NAVIGATEUR
// ==========================================================================================
// L'administrateur corrige les valeurs à l'écran, puis renvoie le relevé pour enregistrement.
// Ce relevé est une ENTRÉE UTILISATEUR : il est revalidé intégralement ici (types, bornes),
// les montants dérivés sont RECALCULÉS (jamais repris du client) et les contrôles comptables
// sont rejoués côté serveur avant toute écriture.

const clientNumber = z.union([z.number(), z.string(), z.null()]).optional();

const clientPosition = z.object({
  index: z.number().optional(),
  name: z.string().nullable().optional(),
  isin: z.string().nullable().optional(),
  ticker: z.string().nullable().optional(),
  quantity: clientNumber,
  averageCostDisplayed: clientNumber,
  currentPrice: clientNumber,
  dailyChangePercent: clientNumber,
  marketValue: clientNumber,
  unrealizedGain: clientNumber,
  unrealizedGainPercent: clientNumber,
  lastMovementDate: z.string().nullable().optional(),
  currency: z.string().nullable().optional(),
});

const clientHeader = z.object({
  broker: z.string().nullable().optional(),
  brokerLabel: z.string().nullable().optional(),
  institution: z.string().nullable().optional(),
  accountType: z.string().nullable().optional(),
  accountName: z.string().nullable().optional(),
  accountNumberMasked: z.string().nullable().optional(),
  snapshotDate: z.string().nullable().optional(),
  openingDate: z.string().nullable().optional(),
  managementMode: z.string().nullable().optional(),
  totalPortfolio: clientNumber,
  availableCash: clientNumber,
  securitiesValue: clientNumber,
  unrealizedGain: clientNumber,
  unrealizedGainPercent: clientNumber,
  depositCeiling: clientNumber,
  cumulativeDeposits: clientNumber,
  currency: z.string().nullable().optional(),
});

export const StatementInputSchema = z.object({
  header: clientHeader,
  positions: z.array(clientPosition).max(500),
});

/**
 * Relevé corrigé par l'administrateur → relevé canonique de confiance. Tout ce qui se calcule
 * (coût historique, masquage du numéro de compte) est REFAIT ici : le serveur ne reprend du
 * client que ce que le client a le droit de décider, c'est-à-dire les valeurs LUES.
 */
export function sanitizeStatementInput(input: unknown, options: { accountCurrency: string }): BrokerStatement | null {
  const parsed = StatementInputSchema.safeParse(input);
  if (!parsed.success) return null;
  const currency = (text(parsed.data.header.currency) || options.accountCurrency || "EUR").toUpperCase().slice(0, 3);
  const brokerValue = text(parsed.data.header.broker);

  const header: StatementHeader = {
    broker: brokerValue === "boursobank" ? "boursobank" : "unknown",
    brokerLabel: text(parsed.data.header.brokerLabel),
    institution: text(parsed.data.header.institution),
    accountType: accountTypeOf(text(parsed.data.header.accountType), text(parsed.data.header.accountName)),
    accountName: text(parsed.data.header.accountName)?.slice(0, 120) ?? null,
    // Le client ne renvoie qu'un numéro déjà masqué ; on le re-masque pour être certain qu'un
    // numéro complet renvoyé par erreur ne soit jamais stocké ni réémis.
    accountNumberMasked: maskAccountNumber(text(parsed.data.header.accountNumberMasked)?.replace(/[^0-9A-Za-z]/g, "") ?? null),
    snapshotDate: parseStatementDate(parsed.data.header.snapshotDate),
    openingDate: parseStatementDate(parsed.data.header.openingDate),
    managementMode: text(parsed.data.header.managementMode)?.slice(0, 60) ?? null,
    totalPortfolio: statementNumber(parsed.data.header.totalPortfolio),
    availableCash: statementNumber(parsed.data.header.availableCash),
    securitiesValue: statementNumber(parsed.data.header.securitiesValue),
    unrealizedGain: statementNumber(parsed.data.header.unrealizedGain),
    unrealizedGainPercent: statementNumber(parsed.data.header.unrealizedGainPercent),
    depositCeiling: statementNumber(parsed.data.header.depositCeiling),
    cumulativeDeposits: statementNumber(parsed.data.header.cumulativeDeposits),
    currency,
    confidence: {},
    raw: {},
  };

  const positions: StatementPosition[] = parsed.data.positions.map((entry, order) => {
    const quantity = statementNumber(entry.quantity);
    const marketValue = statementNumber(entry.marketValue);
    const unrealizedGain = statementNumber(entry.unrealizedGain);
    const averageCostDisplayed = statementNumber(entry.averageCostDisplayed);
    // Recalculé, jamais repris du navigateur : c'est le montant qui deviendra le coût de revient.
    const { costBasis, source } = costBasisOf({ marketValue, unrealizedGain, quantity, averageCostDisplayed });
    return {
      index: order + 1,
      name: text(entry.name)?.slice(0, 200) ?? null,
      isin: (text(entry.isin) ?? "").toUpperCase().slice(0, 12) || null,
      ticker: (text(entry.ticker) ?? "").toUpperCase().slice(0, 20) || null,
      quantity,
      averageCostDisplayed,
      currentPrice: statementNumber(entry.currentPrice),
      dailyChangePercent: statementNumber(entry.dailyChangePercent),
      marketValue,
      unrealizedGain,
      unrealizedGainPercent: statementNumber(entry.unrealizedGainPercent),
      lastMovementDate: parseStatementDate(entry.lastMovementDate),
      currency: (text(entry.currency) || currency).toUpperCase().slice(0, 3),
      costBasis,
      costBasisSource: source,
      confidence: {},
      raw: {},
      lineConfidence: 1,
      band: "high",
      page: null,
      sourceText: null,
      warnings: [],
    };
  });

  return { header, positions, warnings: [] };
}

// ==========================================================================================
// 4) RELEVÉ → OPÉRATIONS `account_operations`
// ==========================================================================================
// Une capture est un INSTANTANÉ, pas un historique de transactions. On ne fabrique donc pas de
// faux achats : chaque position devient une opération de type `correction` — le type que le
// moteur interprète déjà comme « ajustement de quantité et de coût », sans mouvement d'espèces.
//
// Ce qui rend le coût exact : l'opération porte `amount` = COÛT HISTORIQUE (valorisation −
// plus-value), qui devient `gross_amount` au commit. `computeAccountModel` lit ce montant tel
// quel (buyCost) au lieu de recalculer quantité × prix de revient affiché — c'est précisément
// l'écart de 11 centimes constaté sur SANOFI (360 × 87,83 = 31 618,80 ≠ 31 618,69).
//
// Le prix unitaire porté par l'opération est le coût EXACT rapporté à la quantité (et non le
// prix affiché) : les deux informations restent donc cohérentes entre elles, et le prix affiché
// par la banque est conservé dans la note.

export type StatementOperationsOptions = {
  /**
   * Enregistrer le solde espèces du relevé. C'est la seule façon, avec le moteur actuel, de
   * reconstituer la trésorerie : `correction` est neutre sur les espèces par construction.
   */
  includeCash?: boolean;
  /** Positions à exclure (index 1-based) — l'administrateur en a décoché certaines. */
  excludeIndexes?: number[];
};

export type StatementOperationsResult = {
  operations: NormalizedOp[];
  /** Total du coût historique repris (contrôle d'affichage). */
  totalCostBasis: number;
  /** Solde espèces repris, s'il l'a été. */
  cashRecorded: number | null;
  /** Informations du relevé volontairement NON converties en opérations. */
  notImported: Array<{ label: string; value: number | null; reason: string }>;
};

/**
 * Construit les opérations à écrire. Fonction PURE : le commit la rejoue côté serveur à partir
 * du relevé validé, plutôt que de faire confiance à des opérations fabriquées par le navigateur.
 */
export function buildStatementOperations(
  statement: BrokerStatement,
  options: StatementOperationsOptions = {},
): StatementOperationsResult {
  const { header } = statement;
  const asOfDate = header.snapshotDate;
  const excluded = new Set(options.excludeIndexes ?? []);
  const operations: NormalizedOp[] = [];
  let totalCostBasis = 0;

  const brokerLabel = header.brokerLabel ?? header.institution ?? "courtier";

  for (const position of statement.positions) {
    if (excluded.has(position.index)) continue;
    if (position.quantity === null || position.quantity <= 0) continue;
    const costBasis = position.costBasis;
    // Coût inconnu : la position est reprise en quantité seule plutôt qu'avec un coût inventé.
    const unitCost = costBasis === null ? null : round6(costBasis / position.quantity);
    totalCostBasis += costBasis ?? 0;

    const noteParts = [
      `Position reprise du relevé ${brokerLabel}${asOfDate ? ` au ${asOfDate}` : ""}`,
      position.averageCostDisplayed !== null ? `prix de revient affiché ${position.averageCostDisplayed}` : null,
      position.currentPrice !== null ? `cours du relevé ${position.currentPrice}` : null,
      // « Dernier Mvt » n'est PAS une date d'opération : elle ne sert qu'à documenter la ligne.
      position.lastMovementDate ? `dernier mouvement ${position.lastMovementDate}` : null,
      costBasis === null ? "coût historique non lisible sur le relevé" : null,
    ].filter(Boolean);

    operations.push({
      type: "correction",
      date: asOfDate,
      isin: position.isin,
      ticker: position.ticker,
      instrumentName: position.name,
      quantity: position.quantity,
      unitPrice: unitCost,
      amount: costBasis,
      fees: 0,
      taxes: null,
      currency: position.currency,
      exchangeRate: null,
      externalReference: null,
      note: noteParts.join(" · ").slice(0, 500),
    });
  }

  let cashRecorded: number | null = null;
  const notImported: Array<{ label: string; value: number | null; reason: string }> = [];

  if (options.includeCash !== false && header.availableCash !== null && header.availableCash > 0) {
    cashRecorded = round2(header.availableCash);
    operations.push({
      type: "versement",
      date: asOfDate,
      isin: null, ticker: null, instrumentName: null,
      quantity: null, unitPrice: null,
      amount: cashRecorded,
      fees: 0, taxes: null,
      currency: header.currency,
      exchangeRate: null,
      externalReference: null,
      note: `Solde espèces au relevé ${brokerLabel}${asOfDate ? ` du ${asOfDate}` : ""}`,
    });
  } else if (header.availableCash !== null && header.availableCash > 0) {
    notImported.push({
      label: "Solde espèces disponible", value: header.availableCash,
      reason: "Non repris à votre demande : la trésorerie du compte restera celle des opérations déjà enregistrées.",
    });
  }

  // Le « Cumul des versements » N'EST PAS converti en versement : il ferait double emploi avec
  // les versements déjà enregistrés et gonflerait la trésorerie du compte (le moteur crédite les
  // espèces de tout versement). Il reste une information du relevé, utilisée pour le
  // rapprochement à l'écran de validation.
  if (header.cumulativeDeposits !== null) {
    notImported.push({
      label: "Cumul des versements", value: header.cumulativeDeposits,
      reason: "Conservé comme information du relevé (rapprochement). L'enregistrer comme versement créerait un doublon avec l'historique déjà saisi et fausserait le solde espèces.",
    });
  }
  if (header.depositCeiling !== null) {
    notImported.push({
      label: "Plafond de versement", value: header.depositCeiling,
      reason: "Caractéristique du contrat, pas un mouvement : rien à enregistrer.",
    });
  }

  return { operations, totalCostBasis: round2(totalCostBasis), cashRecorded, notImported };
}

export type StatementInstrument = {
  isin: string | null;
  ticker: string | null;
  name: string | null;
  currency: string;
  /** Cours retenu pour valoriser la position à la date du relevé. */
  lastPrice: number | null;
  lastPriceAt: string | null;
  /** D'où vient ce cours : recalculé depuis la valorisation, ou lu tel quel. */
  priceSource: "derived" | "displayed" | null;
};

/**
 * Référentiel d'instruments à créer / mettre à jour dans `holdings` — le référentiel de PRIX,
 * jamais un stockage de positions : sa quantité reste à zéro, la quantité détenue étant dérivée
 * des opérations par computeAccountModel.
 *
 * Le cours retenu est `valorisation ÷ quantité` quand les deux sont lus, et non le cours affiché.
 * Raison : le cours imprimé est arrondi à deux décimales. Sur 5 000 parts, « 6,86 € » redonne
 * 34 300 € alors que le relevé annonce 34 325 € — l'écran afficherait un portefeuille 25 € plus
 * bas que le relevé qu'on vient d'importer, sans explication possible. Le cours affiché reste
 * consigné dans la note de l'opération, et « Actualiser les cours » remplacera de toute façon
 * cette valeur par un vrai cours de marché.
 */
export function statementInstruments(statement: BrokerStatement, excludeIndexes: number[] = []): StatementInstrument[] {
  const excluded = new Set(excludeIndexes);
  return statement.positions
    .filter((position) => !excluded.has(position.index))
    .map((position) => {
      const derived = position.marketValue !== null && position.quantity !== null && position.quantity > 0
        ? round6(position.marketValue / position.quantity)
        : null;
      const lastPrice = derived ?? position.currentPrice;
      return {
        isin: position.isin,
        ticker: position.ticker,
        name: position.name ?? position.ticker ?? position.isin,
        currency: position.currency,
        lastPrice,
        lastPriceAt: statement.header.snapshotDate,
        priceSource: lastPrice === null ? null : derived !== null ? "derived" : "displayed",
      };
    });
}
