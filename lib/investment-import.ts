// Moteur d'IMPORT d'opérations (CSV / XLSX / scan IA) — logique PURE, testable, sans réseau ni
// React. Il NE calcule PAS le portefeuille (c'est le rôle exclusif de computeAccountModel) : il
// transforme un fichier tabulaire en opérations NORMALISÉES + un rapport d'anomalies, puis laisse
// l'administrateur corriger avant tout enregistrement. Aucune donnée inventée : un champ illisible
// devient une erreur/avertissement explicite, jamais une valeur par défaut trompeuse.
//
// Format-agnostique : l'entrée du pipeline est toujours `string[][]` (lignes de cellules). Le CSV
// est parsé ici ; le XLSX est converti en `string[][]` en amont (même pipeline, même preview).

import { instrumentKey } from "./portfolio-account.ts";
import { validateOperation, type OperationInput, type OperationType } from "./account-operation.ts";

// ---- Champs cibles de l'import (colonnes documentées du modèle) --------------------------
export type ImportField =
  | "date" | "type" | "isin" | "ticker" | "instrumentName" | "quantity" | "unitPrice"
  | "amount" | "fees" | "taxes" | "currency" | "exchangeRate" | "externalReference" | "note";

export const IMPORT_FIELDS: ImportField[] = [
  "date", "type", "isin", "ticker", "instrumentName", "quantity", "unitPrice",
  "amount", "fees", "taxes", "currency", "exchangeRate", "externalReference", "note",
];

// Colonnes du modèle CSV téléchargeable (ordre documenté).
export const TEMPLATE_COLUMNS = [
  "date", "type", "isin", "ticker", "instrument_name", "quantity", "unit_price",
  "amount", "fees", "taxes", "currency", "exchange_rate", "external_reference", "note",
] as const;

export type NormalizedOp = {
  type: OperationType | null;
  date: string | null; // ISO yyyy-mm-dd
  isin: string | null;
  ticker: string | null;
  instrumentName: string | null;
  quantity: number | null;
  unitPrice: number | null;
  amount: number | null;
  fees: number | null;
  taxes: number | null;
  currency: string;
  exchangeRate: number | null;
  externalReference: string | null;
  note: string | null;
};

export type RowStatus = "valid" | "warning" | "error" | "duplicate_certain" | "duplicate_possible";

export type PreviewRow = {
  index: number; // numéro de ligne de données (1-based, hors en-tête)
  raw: string[];
  op: NormalizedOp;
  instrumentHoldingId: string | null;
  matchedBy: "isin" | "ticker" | "name" | null;
  fingerprint: string;
  status: RowStatus;
  errors: string[]; // bloquants
  warnings: string[]; // non bloquants (« à vérifier »)
};

export type PreviewSummary = {
  total: number;
  valid: number;
  toCheck: number;
  errors: number;
  duplicatesCertain: number;
  duplicatesPossible: number;
  unknownInstruments: number;
};

export type HoldingRef = { id: string; isin: string | null; symbol: string | null; name: string | null };

// ==========================================================================================
// 1) NORMALISATION DE TEXTE / EN-TÊTES
// ==========================================================================================
function stripAccents(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "");
}
function normKey(value: string): string {
  return stripAccents(String(value ?? "").toLowerCase()).replace(/[^a-z0-9]+/g, " ").trim();
}

// Alias FR/EN par champ (clés déjà normalisées). Ordre = priorité d'auto-détection.
const HEADER_ALIASES: Record<ImportField, string[]> = {
  date: ["date", "date operation", "date d operation", "date d execution", "date d execution ordre", "date execution", "date valeur", "date de valeur", "date comptable", "trade date", "operation date", "execution date", "value date", "settlement date"],
  type: ["type", "type d operation", "type operation", "operation", "sens", "nature", "nature operation", "transaction type", "side", "mouvement", "libelle operation"],
  isin: ["isin", "code isin", "isin code", "code valeur isin"],
  ticker: ["ticker", "symbole", "symbol", "mnemo", "mnemonique", "code mnemonique", "code", "code valeur"],
  instrumentName: ["instrument", "libelle", "libelle valeur", "designation", "valeur", "nom", "nom valeur", "name", "instrument name", "security", "security name", "description", "produit", "support"],
  quantity: ["quantite", "qte", "quantity", "nombre", "nombre de titres", "nb titres", "nb", "qty", "parts", "units", "shares"],
  unitPrice: ["prix", "prix unitaire", "cours", "prix d execution", "cours d execution", "unit price", "price", "execution price", "prix d achat", "prix de revient"],
  amount: ["montant", "montant net", "montant brut", "montant total", "amount", "net amount", "gross amount", "total", "value", "montant operation"],
  fees: ["frais", "frais de courtage", "commission", "commissions", "courtage", "fee", "fees", "brokerage", "frais courtage"],
  taxes: ["taxes", "taxe", "impots", "retenue", "retenue a la source", "prelevement", "prelevements", "tax", "withholding", "withholding tax", "twt"],
  currency: ["devise", "monnaie", "currency", "ccy", "devise cotation", "devise operation"],
  exchangeRate: ["taux de change", "taux change", "taux", "change", "exchange rate", "fx rate", "fx", "cours de change"],
  externalReference: ["reference", "ref", "reference externe", "reference operation", "numero", "numero operation", "id operation", "transaction id", "order id", "external reference", "id"],
  note: ["note", "commentaire", "remarque", "memo", "comment", "notes", "observation", "libelle complementaire"],
};

/** Auto-mappe l'en-tête → index de colonne par champ. Une colonne source n'est affectée qu'une fois. */
export function autoMapHeaders(header: string[]): Record<ImportField, number> {
  const norm = header.map(normKey);
  const used = new Set<number>();
  const mapping = {} as Record<ImportField, number>;
  for (const field of IMPORT_FIELDS) {
    mapping[field] = -1;
    for (const alias of HEADER_ALIASES[field]) {
      const idx = norm.findIndex((cell, i) => !used.has(i) && cell === alias);
      if (idx >= 0) { mapping[field] = idx; used.add(idx); break; }
    }
  }
  return mapping;
}

// ==========================================================================================
// 2) NORMALISATION DES TYPES D'OPÉRATION (FR / EN → canonique)
// ==========================================================================================
const TYPE_EXACT: Record<string, OperationType> = {
  achat: "achat", buy: "achat", purchase: "achat", acquisition: "achat", souscription: "achat", "achat comptant": "achat",
  vente: "vente", sell: "vente", sale: "vente", cession: "vente", "vente comptant": "vente", disposal: "vente",
  versement: "versement", deposit: "versement", "cash deposit": "versement", apport: "versement", alimentation: "versement", funding: "versement", "virement recu": "versement", "virement entrant": "versement",
  retrait: "retrait", withdrawal: "retrait", "cash withdrawal": "retrait", "virement emis": "retrait", "virement sortant": "retrait",
  dividende: "dividende", dividend: "dividende", coupon: "dividende", distribution: "dividende", "dividende brut": "dividende", "dividende net": "dividende",
  frais: "frais", fee: "frais", fees: "frais", commission: "frais", "frais de courtage": "frais", "frais de garde": "frais", "droits de garde": "frais",
  correction: "correction", ajustement: "correction", adjustment: "correction",
  "transfert entrant": "transfer_in", "transfer in": "transfer_in", "entree de titres": "transfer_in", "apport de titres": "transfer_in", "transfert de titres entrant": "transfer_in",
  "transfert sortant": "transfer_out", "transfer out": "transfer_out", "sortie de titres": "transfer_out", "transfert de titres sortant": "transfer_out",
};
// Mots-clés (fallback « contient ») quand la cellule est une phrase (« Achat 10 AIR LIQUIDE »).
const TYPE_KEYWORDS: Array<[string, OperationType]> = [
  ["transfert entrant", "transfer_in"], ["transfer in", "transfer_in"], ["transfert sortant", "transfer_out"], ["transfer out", "transfer_out"],
  ["dividende", "dividende"], ["dividend", "dividende"], ["coupon", "dividende"],
  ["versement", "versement"], ["deposit", "versement"], ["retrait", "retrait"], ["withdrawal", "retrait"],
  ["achat", "achat"], ["buy", "achat"], ["purchase", "achat"], ["vente", "vente"], ["sell", "vente"], ["sale", "vente"],
  ["frais", "frais"], ["commission", "frais"], ["fee", "frais"], ["correction", "correction"],
];

export function normalizeType(label: string | null | undefined): OperationType | null {
  const key = normKey(label ?? "");
  if (!key) return null;
  if (TYPE_EXACT[key]) return TYPE_EXACT[key];
  for (const [kw, type] of TYPE_KEYWORDS) if (key.includes(kw)) return type;
  return null;
}

// ==========================================================================================
// 3) NOMBRES (virgule OU point décimal, milliers, symboles/espaces)
// ==========================================================================================
export function parseDecimal(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "number") return Number.isFinite(input) ? input : null;
  let s = String(input).trim();
  if (!s) return null;
  const negative = /^\(.*\)$/.test(s) || /^-/.test(s) || /-$/.test(s); // (123) ou -123 ou 123-
  s = s.replace(/[()]/g, "");
  // Retire tout sauf chiffres, séparateurs et signe.
  s = s.replace(/[^0-9.,-]/g, "");
  if (!s || !/[0-9]/.test(s)) return null;
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  if (hasComma && hasDot) {
    // Le dernier séparateur rencontré est le décimal ; l'autre = milliers.
    const decimal = s.lastIndexOf(",") > s.lastIndexOf(".") ? "," : ".";
    const thousands = decimal === "," ? "." : ",";
    s = s.split(thousands).join("").replace(decimal, ".");
  } else if (hasComma) {
    // Virgule seule → décimale, SAUF si elle groupe des milliers réguliers (1,234,567).
    s = /^\d{1,3}(,\d{3})+$/.test(s.replace(/-/g, "")) ? s.split(",").join("") : s.replace(",", ".");
  } else if (hasDot) {
    // Point seul → décimal, SAUF milliers réguliers (1.234.567 ou 1.234 exact groupé plusieurs fois).
    if (/^\d{1,3}(\.\d{3})+$/.test(s.replace(/-/g, ""))) s = s.split(".").join("");
  }
  const cleaned = s.replace(/-/g, "");
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

// ==========================================================================================
// 4) DATES (ISO, dd/mm/yyyy FR, mm/dd/yyyy US) → ISO yyyy-mm-dd
// ==========================================================================================
export type DateFormat = "iso" | "fr" | "us";

export function detectDateFormat(values: Array<string | null | undefined>): DateFormat {
  let sawFr = false, sawUs = false;
  for (const value of values) {
    const s = String(value ?? "").trim();
    const iso = /^(\d{4})[/.\-](\d{1,2})[/.\-](\d{1,2})$/.exec(s);
    if (iso) return "iso";
    const m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/.exec(s);
    if (!m) continue;
    const a = Number(m[1]), b = Number(m[2]);
    if (a > 12 && b <= 12) sawFr = true;
    else if (b > 12 && a <= 12) sawUs = true;
  }
  if (sawFr && !sawUs) return "fr";
  if (sawUs && !sawFr) return "us";
  return "fr"; // défaut européen (courtiers FR) ; l'admin peut corriger le mapping/format.
}

function isRealDate(y: number, mo: number, d: number): boolean {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1900 || y > 2100) return false;
  const days = [31, (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d <= days[mo - 1];
}
function iso(y: number, mo: number, d: number): string {
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function parseDate(input: string | null | undefined, format: DateFormat = "fr"): string | null {
  const s = String(input ?? "").trim();
  if (!s) return null;
  const isoMatch = /^(\d{4})[/.\-](\d{1,2})[/.\-](\d{1,2})$/.exec(s);
  if (isoMatch) {
    const y = Number(isoMatch[1]), mo = Number(isoMatch[2]), d = Number(isoMatch[3]);
    return isRealDate(y, mo, d) ? iso(y, mo, d) : null;
  }
  const m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/.exec(s);
  if (!m) return null;
  let y = Number(m[3]);
  if (y < 100) y += y < 70 ? 2000 : 1900;
  const first = Number(m[1]), second = Number(m[2]);
  let day: number, month: number;
  if (format === "us") { month = first; day = second; }
  else { day = first; month = second; } // fr par défaut
  return isRealDate(y, month, day) ? iso(y, month, day) : null;
}

// ==========================================================================================
// 5) ISIN (format + clé de contrôle Luhn)
// ==========================================================================================
export function isValidIsin(value: string | null | undefined): boolean {
  const s = String(value ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(s)) return false;
  // Conversion lettres → chiffres (A=10 … Z=35), puis Luhn depuis la droite.
  let digits = "";
  for (const ch of s) digits += ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch;
  let sum = 0, double = true;
  for (let i = digits.length - 2; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d; double = !double;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === digits.charCodeAt(digits.length - 1) - 48;
}

// ==========================================================================================
// 6) MATCHING INSTRUMENT (réutilise holdings — aucune 2e table d'instruments)
// ==========================================================================================
/** Clé d'instrument normalisée d'une opération importée (ISIN > ticker > nom), pour dédup/simulation. */
export function instrumentKeyOf(op: { isin: string | null; ticker: string | null; instrumentName: string | null }): string {
  return instrumentKey({ isin: op.isin, ticker: op.ticker, assetName: op.instrumentName });
}

export function matchInstrument(
  op: { isin: string | null; ticker: string | null; instrumentName: string | null },
  holdings: HoldingRef[],
): { holdingId: string | null; matchedBy: "isin" | "ticker" | "name" | null } {
  const isin = (op.isin ?? "").trim().toUpperCase();
  if (isin) {
    const hit = holdings.find((h) => (h.isin ?? "").trim().toUpperCase() === isin);
    if (hit) return { holdingId: hit.id, matchedBy: "isin" };
  }
  const ticker = (op.ticker ?? "").trim().toUpperCase();
  if (ticker) {
    const hit = holdings.find((h) => (h.symbol ?? "").trim().toUpperCase() === ticker);
    if (hit) return { holdingId: hit.id, matchedBy: "ticker" };
  }
  const name = (op.instrumentName ?? "").trim().toLowerCase();
  if (name) {
    const hit = holdings.find((h) => (h.name ?? "").trim().toLowerCase() === name);
    if (hit) return { holdingId: hit.id, matchedBy: "name" };
  }
  return { holdingId: null, matchedBy: null };
}

// ==========================================================================================
// 7) EMPREINTE (dédoublonnage) — hash FNV-1a déterministe (pas de crypto, isomorphe)
// ==========================================================================================
function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
const nz = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? "" : String(Math.round(Number(n) * 100) / 100));

export function computeFingerprint(accountId: string, op: NormalizedOp): string {
  const instrument = instrumentKey({ isin: op.isin, ticker: op.ticker, assetName: op.instrumentName });
  const parts = [accountId, op.date ?? "", op.type ?? "", instrument, nz(op.quantity), nz(op.unitPrice), nz(op.amount), (op.currency || "EUR").toUpperCase(), nz(op.fees), nz(op.taxes)];
  return fnv1a(parts.join("|"));
}

// ==========================================================================================
// 8) NORMALISATION D'UNE LIGNE + VALIDATION (réutilise validateOperation)
// ==========================================================================================
function cell(raw: string[], idx: number): string {
  return idx >= 0 && idx < raw.length ? String(raw[idx] ?? "").trim() : "";
}

export function normalizeRow(raw: string[], mapping: Record<ImportField, number>, dateFormat: DateFormat, accountCurrency: string): NormalizedOp {
  const currency = (cell(raw, mapping.currency) || accountCurrency || "EUR").toUpperCase().slice(0, 3);
  return {
    type: normalizeType(cell(raw, mapping.type)),
    date: parseDate(cell(raw, mapping.date), dateFormat),
    isin: cell(raw, mapping.isin).toUpperCase() || null,
    ticker: cell(raw, mapping.ticker).toUpperCase() || null,
    instrumentName: cell(raw, mapping.instrumentName) || null,
    quantity: parseDecimal(cell(raw, mapping.quantity)),
    unitPrice: parseDecimal(cell(raw, mapping.unitPrice)),
    amount: parseDecimal(cell(raw, mapping.amount)),
    fees: parseDecimal(cell(raw, mapping.fees)),
    taxes: parseDecimal(cell(raw, mapping.taxes)),
    currency: currency || "EUR",
    exchangeRate: parseDecimal(cell(raw, mapping.exchangeRate)),
    externalReference: cell(raw, mapping.externalReference) || null,
    note: cell(raw, mapping.note) || null,
  };
}

/** Convertit une opération normalisée en OperationInput pour réutiliser validateOperation(). */
export function toOperationInput(op: NormalizedOp): OperationInput {
  const t = op.type;
  const base: OperationInput = {
    type: t ?? undefined, date: op.date ?? undefined, assetName: op.instrumentName ?? undefined,
    ticker: op.ticker ?? undefined, isin: op.isin ?? undefined, currency: op.currency,
    fees: op.fees ?? undefined, taxes: op.taxes ?? undefined, exchangeRate: op.exchangeRate ?? undefined,
    note: op.note ?? undefined, externalReference: op.externalReference,
  };
  if (t === "achat" || t === "vente" || t === "transfer_in" || t === "transfer_out") {
    return { ...base, quantity: op.quantity, unitPrice: op.unitPrice, grossAmount: op.amount };
  }
  if (t === "correction") return { ...base, quantity: op.quantity, netAmount: op.amount };
  // versement / retrait / frais / dividende : le montant est le net.
  return { ...base, netAmount: op.amount };
}

// ==========================================================================================
// 9) CONSTRUCTION DE LA PRÉVISUALISATION (statuts + dédup) — AUCUNE écriture
// ==========================================================================================
export type BuildPreviewParams = {
  rows: string[][]; // lignes de DONNÉES (en-tête déjà retiré)
  mapping: Record<ImportField, number>;
  accountId: string;
  accountCurrency: string;
  accountType: "PEA" | "CTO";
  holdings: HoldingRef[];
  existingFingerprints?: Set<string>; // account_operations.import_fingerprint déjà en base
  existingExternalRefs?: Set<string>; // account_operations.external_reference déjà en base
  openingQuantities?: Record<string, number>; // quantité déjà détenue par instrument (ledger existant)
  dateFormat?: DateFormat;
  allowAdvanced?: boolean; // migration 20260725 jouée (transferts/taxes/change) — sinon avertir
};

// Paramètres communs (hors source des lignes) partagés par les deux points d'entrée de preview.
type EvalParams = Omit<BuildPreviewParams, "rows" | "mapping" | "dateFormat">;

export function buildPreview(params: BuildPreviewParams): { rows: PreviewRow[]; summary: PreviewSummary } {
  const { rows, mapping, accountCurrency } = params;
  const dateFormat = params.dateFormat ?? detectDateFormat(rows.map((r) => cell(r, mapping.date)));
  const items = rows.map((raw, i) => ({ raw, index: i, op: normalizeRow(raw, mapping, dateFormat, accountCurrency) }));
  return evaluatePreview(items, params);
}

// Point d'entrée « opérations déjà normalisées » (scan IA) : même évaluation, sans re-parsing.
// Les lignes brutes sont vides (le texte source / la confiance sont portés à part par le scan).
export function buildPreviewFromOps(ops: NormalizedOp[], params: EvalParams): { rows: PreviewRow[]; summary: PreviewSummary } {
  const items = ops.map((op, index) => ({ raw: [] as string[], index, op }));
  return evaluatePreview(items, params);
}

function evaluatePreview(items: Array<{ raw: string[]; index: number; op: NormalizedOp }>, params: EvalParams): { rows: PreviewRow[]; summary: PreviewSummary } {
  const { accountId, accountType, holdings } = params;
  const existingFingerprints = params.existingFingerprints ?? new Set<string>();
  const existingExternalRefs = params.existingExternalRefs ?? new Set<string>();
  const seenInFile = new Map<string, number>(); // empreinte → 1re occurrence

  // Quantités simulées par instrument (contrôle « vente > détenu » pour le PEA), dans l'ordre des dates.
  const held: Record<string, number> = { ...(params.openingQuantities ?? {}) };
  const order = [...items].sort((a, b) => (a.op.date ?? "9999").localeCompare(b.op.date ?? "9999") || a.index - b.index);

  const byIndex = new Map<number, PreviewRow>();
  for (const { raw, index: i, op } of order) {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Ligne vide : soit toutes les cellules brutes vides (CSV/XLSX), soit une opération sans
    // aucun champ exploitable (scan IA).
    const isBlank = raw.length > 0 ? raw.every((c) => String(c ?? "").trim() === "") : (!op.type && !op.date && op.amount == null && op.quantity == null);

    // Validation structurelle via la source de vérité partagée.
    const validation = validateOperation(toOperationInput(op));
    if (!op.type) errors.push("Type d'opération non reconnu.");
    if (!op.date) errors.push("Date illisible ou absente.");
    if (op.type && op.date && !validation.ok) errors.push(validation.error);

    // ISIN présent mais invalide → avertissement (pas bloquant : l'admin peut corriger).
    if (op.isin && !isValidIsin(op.isin)) warnings.push("ISIN invalide (clé de contrôle).");

    // Transferts / taxes / taux de change exigent la migration 20260725.
    if (params.allowAdvanced === false && (op.type === "transfer_in" || op.type === "transfer_out")) {
      errors.push("Les transferts de titres exigent la migration 20260725.");
    }

    const needsInstrument = op.type === "achat" || op.type === "vente" || op.type === "dividende" || op.type === "transfer_in" || op.type === "transfer_out";
    const match = matchInstrument(op, holdings);
    if (needsInstrument && !match.holdingId && !op.isin && !op.ticker && !op.instrumentName) {
      errors.push("Instrument manquant pour cette opération.");
    } else if (needsInstrument && !match.holdingId) {
      warnings.push("Instrument non reconnu — il sera créé (sans cours) ou à associer.");
    }

    // Contrôle PEA : vente supérieure à la quantité détenue (simulée à la date de l'opération).
    const key = instrumentKey({ isin: op.isin, ticker: op.ticker, assetName: op.instrumentName });
    if (op.type === "achat" || op.type === "transfer_in") held[key] = (held[key] ?? 0) + Number(op.quantity ?? 0);
    else if (op.type === "vente" || op.type === "transfer_out") {
      const available = held[key] ?? 0;
      if (accountType === "PEA" && Number(op.quantity ?? 0) > available + 1e-9) {
        errors.push(`Vente de ${op.quantity} > quantité détenue (${available}).`);
      }
      held[key] = available - Number(op.quantity ?? 0);
    }

    // Dédoublonnage.
    const fingerprint = computeFingerprint(accountId, op);
    let status: RowStatus = errors.length ? "error" : warnings.length ? "warning" : "valid";
    if (isBlank) { status = "error"; errors.push("Ligne vide."); }

    if (!isBlank && errors.length === 0) {
      const extRef = op.externalReference?.trim();
      if (extRef && existingExternalRefs.has(extRef)) status = "duplicate_certain";
      else if (existingFingerprints.has(fingerprint)) status = "duplicate_possible";
      else if (seenInFile.has(fingerprint)) status = "duplicate_possible";
    }
    if (!isBlank && !seenInFile.has(fingerprint)) seenInFile.set(fingerprint, i);

    byIndex.set(i, { index: i + 1, raw, op, instrumentHoldingId: match.holdingId, matchedBy: match.matchedBy, fingerprint, status, errors, warnings });
  }

  const previewRows = items.map((it) => byIndex.get(it.index)!).filter(Boolean);
  const summary: PreviewSummary = {
    total: previewRows.length,
    valid: previewRows.filter((r) => r.status === "valid").length,
    toCheck: previewRows.filter((r) => r.status === "warning").length,
    errors: previewRows.filter((r) => r.status === "error").length,
    duplicatesCertain: previewRows.filter((r) => r.status === "duplicate_certain").length,
    duplicatesPossible: previewRows.filter((r) => r.status === "duplicate_possible").length,
    unknownInstruments: previewRows.filter((r) => {
      const needsInstrument = r.op.type === "achat" || r.op.type === "vente" || r.op.type === "dividende" || r.op.type === "transfer_in" || r.op.type === "transfer_out";
      return needsInstrument && !r.instrumentHoldingId;
    }).length,
  };
  return { rows: previewRows, summary };
}

// ==========================================================================================
// 10) PARSING CSV (délimiteur auto, guillemets, BOM, CRLF, retours dans les champs)
// ==========================================================================================
export function detectDelimiter(sample: string): string {
  const firstLine = sample.replace(/^﻿/, "").split(/\r?\n/)[0] ?? "";
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0, "|": 0 };
  let inQuotes = false;
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch]++;
  }
  return (Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[1] ?? 0) > 0
    ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]
    : ",";
}

export function parseCsv(text: string, delimiter?: string): { header: string[]; rows: string[][]; delimiter: string } {
  const clean = text.replace(/^﻿/, "");
  const delim = delimiter ?? detectDelimiter(clean);
  const records: string[][] = [];
  let field = "", record: string[] = [], inQuotes = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delim) { record.push(field); field = ""; }
    else if (ch === "\n") { record.push(field); records.push(record); field = ""; record = []; }
    else if (ch === "\r") { /* CRLF : ignoré, le \n suit */ }
    else field += ch;
  }
  if (field !== "" || record.length) { record.push(field); records.push(record); }
  const nonEmpty = records.filter((r) => r.some((c) => String(c ?? "").trim() !== ""));
  const header = nonEmpty[0] ?? [];
  return { header: header.map((c) => String(c ?? "").trim()), rows: nonEmpty.slice(1), delimiter: delim };
}

// ==========================================================================================
// 11) SÉCURITÉ CSV : neutralisation des cellules pouvant devenir des formules (export/modèle)
// ==========================================================================================
export function sanitizeCsvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s) || /^[\t\r]/.test(s)) s = "'" + s;
  if (s.includes('"') || s.includes(",") || s.includes(";") || s.includes("\n")) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// Modèle CSV documenté + quelques lignes d'exemple réalistes (à NE PAS importer telles quelles).
export function buildTemplateCsv(delimiter = ","): string {
  const examples: Array<Record<(typeof TEMPLATE_COLUMNS)[number], string>> = [
    { date: "2026-01-05", type: "versement", isin: "", ticker: "", instrument_name: "", quantity: "", unit_price: "", amount: "500", fees: "", taxes: "", currency: "EUR", exchange_rate: "", external_reference: "VRS-2026-001", note: "Versement mensuel" },
    { date: "2026-01-06", type: "achat", isin: "FR0010315770", ticker: "CW8", instrument_name: "Amundi MSCI World", quantity: "1.2", unit_price: "410,50", amount: "", fees: "1,50", taxes: "", currency: "EUR", exchange_rate: "", external_reference: "ORD-2026-014", note: "" },
    { date: "2026-03-20", type: "dividende", isin: "FR0000120073", ticker: "AI", instrument_name: "Air Liquide", quantity: "", unit_price: "", amount: "12,80", fees: "", taxes: "3,20", currency: "EUR", exchange_rate: "", external_reference: "DIV-2026-003", note: "Dividende annuel" },
    { date: "2026-04-02", type: "frais", isin: "", ticker: "", instrument_name: "", quantity: "", unit_price: "", amount: "2,50", fees: "", taxes: "", currency: "EUR", exchange_rate: "", external_reference: "", note: "Frais de tenue de compte" },
    { date: "2026-05-15", type: "vente", isin: "FR0010315770", ticker: "CW8", instrument_name: "Amundi MSCI World", quantity: "0.5", unit_price: "432,10", amount: "", fees: "1,50", taxes: "", currency: "EUR", exchange_rate: "", external_reference: "ORD-2026-051", note: "" },
  ];
  const header = TEMPLATE_COLUMNS.map(sanitizeCsvCell).join(delimiter);
  const lines = examples.map((row) => TEMPLATE_COLUMNS.map((col) => sanitizeCsvCell(row[col])).join(delimiter));
  return [header, ...lines].join("\r\n") + "\r\n";
}
