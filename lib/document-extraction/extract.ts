// Extraction IA d'un relevé (PDF/image) → opérations NORMALISÉES + niveaux de confiance.
// PARTIE PURE et TESTABLE : la sortie brute de l'IA (validée par schéma) est convertie en
// NormalizedOp et soumise à des CONTRÔLES DÉTERMINISTES (code classique). L'IA ne calcule JAMAIS
// le portefeuille, le prix moyen, la performance ni la quantité finale : ces calculs restent dans
// computeAccountModel. La conformité au schéma JSON n'est PAS une preuve d'exactitude financière —
// d'où les contrôles ci-dessous et la validation humaine obligatoire avant tout enregistrement.

import { normalizeType, parseDate, isValidIsin, type NormalizedOp } from "../investment-import.ts";
import { validateOperation } from "../account-operation.ts";

export type ExtractedField<T> = { value: T | null; confidence: number; page?: number | null };

export type RawExtraction = {
  document?: {
    institution?: ExtractedField<string>;
    account_type?: ExtractedField<string>;
    currency?: ExtractedField<string>;
    period?: ExtractedField<string>;
    holder?: ExtractedField<string>;
  };
  operations?: Array<{
    date?: ExtractedField<string>;
    type?: ExtractedField<string>;
    isin?: ExtractedField<string>;
    ticker?: ExtractedField<string>;
    instrument_name?: ExtractedField<string>;
    quantity?: ExtractedField<number>;
    unit_price?: ExtractedField<number>;
    gross_amount?: ExtractedField<number>;
    fees?: ExtractedField<number>;
    taxes?: ExtractedField<number>;
    net_amount?: ExtractedField<number>;
    currency?: ExtractedField<string>;
    exchange_rate?: ExtractedField<number>;
    external_reference?: ExtractedField<string>;
    source_text?: string;
    page?: number | null;
    warnings?: string[];
  }>;
};

export type ConfidenceBand = "high" | "medium" | "low";

export type ExtractedOperation = {
  op: NormalizedOp;
  confidence: number; // min des confiances des champs clés
  band: ConfidenceBand;
  page: number | null;
  sourceText: string | null;
  warnings: string[]; // avertissements déterministes (jamais fournis par l'IA)
};

export type ExtractionThresholds = { high: number; low: number };
export const DEFAULT_THRESHOLDS: ExtractionThresholds = { high: 0.85, low: 0.6 };

// Schéma (description) fourni au fournisseur IA. Aligné sur account_operations / holdings.
export const EXTRACTION_JSON_INSTRUCTION = `Réponds UNIQUEMENT avec un objet JSON valide, sans texte autour, de la forme :
{
  "document": {
    "institution": {"value": string|null, "confidence": number, "page": number},
    "account_type": {"value": "pea"|"securities"|null, "confidence": number, "page": number},
    "currency": {"value": string|null, "confidence": number, "page": number},
    "holder": {"value": string|null, "confidence": number, "page": number},
    "period": {"value": string|null, "confidence": number, "page": number}
  },
  "operations": [
    {
      "date": {"value": "YYYY-MM-DD"|null, "confidence": number, "page": number},
      "type": {"value": "achat"|"vente"|"versement"|"retrait"|"dividende"|"frais"|"transfer_in"|"transfer_out"|null, "confidence": number, "page": number},
      "isin": {"value": string|null, "confidence": number, "page": number},
      "ticker": {"value": string|null, "confidence": number, "page": number},
      "instrument_name": {"value": string|null, "confidence": number, "page": number},
      "quantity": {"value": number|null, "confidence": number, "page": number},
      "unit_price": {"value": number|null, "confidence": number, "page": number},
      "gross_amount": {"value": number|null, "confidence": number, "page": number},
      "fees": {"value": number|null, "confidence": number, "page": number},
      "taxes": {"value": number|null, "confidence": number, "page": number},
      "net_amount": {"value": number|null, "confidence": number, "page": number},
      "currency": {"value": string|null, "confidence": number, "page": number},
      "exchange_rate": {"value": number|null, "confidence": number, "page": number},
      "external_reference": {"value": string|null, "confidence": number, "page": number},
      "source_text": string,
      "page": number,
      "warnings": [string]
    }
  ]
}
Règles STRICTES : confidence est un nombre entre 0 et 1. N'invente AUCUNE valeur : si une information est absente, mets value=null et confidence basse. Ne calcule ni total de portefeuille, ni prix moyen, ni performance. Recopie le texte source de chaque opération dans source_text.`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

// Le prompt demande { value, confidence }, mais les modèles peuvent renvoyer une valeur
// directe malgré cette consigne. Tolérer les deux formes évite de transformer une extraction
// lisible en ligne entièrement vide et permet de la soumettre quand même à la validation humaine.
function fieldValue<T>(field: unknown): T | null {
  if (field === null || field === undefined) return null;
  if (isRecord(field) && Object.prototype.hasOwnProperty.call(field, "value")) {
    return (field.value ?? null) as T | null;
  }
  return field as T;
}

function fieldConf(field: unknown): number {
  if (field === null || field === undefined) return 0;
  const c = isRecord(field) && Object.prototype.hasOwnProperty.call(field, "confidence")
    ? Number(field.confidence)
    : 0.65; // valeur directe : confiance prudente, toujours à vérifier dans l'UI
  return Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0;
}
function num(value: unknown): number | null {
  const n = Number(value);
  return value === null || value === undefined || !Number.isFinite(n) ? null : n;
}
function str(value: unknown): string | null {
  const s = value === null || value === undefined ? "" : String(value).trim();
  return s || null;
}

const CURRENCY_RE = /^[A-Z]{3}$/;

function firstDefined(record: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    if (record[name] !== undefined && record[name] !== null) return record[name];
  }
  return null;
}

/**
 * Normalise les variantes de forme que peuvent produire les modèles multimodaux.
 * La validation métier reste ensuite entièrement déterministe.
 */
export function normalizeRawExtraction(input: unknown): RawExtraction {
  const root = isRecord(input) ? input : {};
  const document = isRecord(root.document)
    ? root.document
    : isRecord(root.metadata) ? root.metadata : {};
  const rawOperations = Array.isArray(root.operations)
    ? root.operations
    : Array.isArray(root.transactions) ? root.transactions
      : Array.isArray(root.entries) ? root.entries
        : isRecord(root.data) && Array.isArray(root.data.operations) ? root.data.operations : [];

  const operations = rawOperations.filter(isRecord).map((entry) => {
    const rawType = firstDefined(entry, ["type", "operation_type", "operationType", "action"]);
    const normalizedType = normalizeType(String(fieldValue<unknown>(rawType) ?? ""));
    const genericAmount = firstDefined(entry, ["amount", "total", "value"]);
    const securityOperation = normalizedType === "achat" || normalizedType === "vente" || normalizedType === "transfer_in" || normalizedType === "transfer_out";
    return {
      date: firstDefined(entry, ["date", "operation_date", "operationDate"]),
      type: rawType,
      isin: firstDefined(entry, ["isin", "ISIN"]),
      ticker: firstDefined(entry, ["ticker", "symbol", "symbol_code"]),
      instrument_name: firstDefined(entry, ["instrument_name", "instrumentName", "asset_name", "assetName", "security", "name"]),
      quantity: firstDefined(entry, ["quantity", "qty"]),
      unit_price: firstDefined(entry, ["unit_price", "unitPrice", "price"]),
      gross_amount: firstDefined(entry, ["gross_amount", "grossAmount"]) ?? (securityOperation ? genericAmount : null),
      fees: firstDefined(entry, ["fees", "fee", "charges"]),
      taxes: firstDefined(entry, ["taxes", "tax"]),
      net_amount: firstDefined(entry, ["net_amount", "netAmount"]) ?? (!securityOperation ? genericAmount : null),
      currency: firstDefined(entry, ["currency", "ccy"]),
      exchange_rate: firstDefined(entry, ["exchange_rate", "exchangeRate", "fx_rate"]),
      external_reference: firstDefined(entry, ["external_reference", "externalReference", "reference", "transaction_id"]),
      source_text: String(fieldValue<unknown>(firstDefined(entry, ["source_text", "sourceText", "raw_text", "rawText"])) ?? "") || undefined,
      page: num(firstDefined(entry, ["page", "page_number", "pageNumber"])),
      warnings: Array.isArray(entry.warnings) ? entry.warnings.filter((warning): warning is string => typeof warning === "string") : [],
    };
  });

  return { document, operations } as RawExtraction;
}

export function validateExtraction(raw: RawExtraction, options: { accountCurrency: string; thresholds?: ExtractionThresholds }): {
  document: { institution: string | null; accountType: string | null; currency: string | null; holder: string | null; period: string | null };
  operations: ExtractedOperation[];
} {
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  const doc = raw.document ?? {};
  const document = {
    institution: str(fieldValue(doc.institution)),
    accountType: str(fieldValue(doc.account_type)),
    currency: str(fieldValue(doc.currency)),
    holder: str(fieldValue(doc.holder)),
    period: str(fieldValue(doc.period)),
  };

  const operations: ExtractedOperation[] = (Array.isArray(raw.operations) ? raw.operations : []).map((entry) => {
    const type = normalizeType(str(fieldValue(entry.type)));
    const currency = (str(fieldValue(entry.currency)) || options.accountCurrency || "EUR").toUpperCase().slice(0, 3);
    const grossAmount = num(fieldValue(entry.gross_amount));
    const netAmount = num(fieldValue(entry.net_amount));
    const quantity = num(fieldValue(entry.quantity));
    const unitPrice = num(fieldValue(entry.unit_price));
    const fees = num(fieldValue(entry.fees));
    const taxes = num(fieldValue(entry.taxes));

    // Montant retenu selon le type (cohérent avec le moteur) : net pour flux d'espèces,
    // brut (=qté×prix) pour achats/ventes/transferts. On ne calcule rien qui ne soit fourni.
    const amount = (type === "achat" || type === "vente" || type === "transfer_in" || type === "transfer_out")
      ? (grossAmount ?? null)
      : (netAmount ?? grossAmount ?? null);

    // L'IA doit sortir en ISO, mais on tolère FR/US si elle recopie le format du relevé.
    const rawDate = str(fieldValue(entry.date));
    const date = parseDate(rawDate, "iso") ?? parseDate(rawDate, "fr") ?? parseDate(rawDate, "us");

    const op: NormalizedOp = {
      type,
      date,
      isin: (str(fieldValue(entry.isin)) ?? "").toUpperCase() || null,
      ticker: (str(fieldValue(entry.ticker)) ?? "").toUpperCase() || null,
      instrumentName: str(fieldValue(entry.instrument_name)),
      quantity, unitPrice, amount, fees, taxes,
      currency: currency || "EUR",
      exchangeRate: num(fieldValue(entry.exchange_rate)),
      externalReference: str(fieldValue(entry.external_reference)),
      note: null,
    };

    // Confiance de ligne = min des confiances des champs réellement clés selon le type.
    const keyConfs: number[] = [fieldConf(entry.date), fieldConf(entry.type)];
    if (type === "achat" || type === "vente" || type === "transfer_in" || type === "transfer_out") {
      keyConfs.push(fieldConf(entry.quantity), fieldConf(entry.unit_price));
    } else {
      keyConfs.push(fieldConf(entry.net_amount) || fieldConf(entry.gross_amount));
    }
    const confidence = Math.min(...keyConfs);
    const band: ConfidenceBand = confidence >= thresholds.high ? "high" : confidence >= thresholds.low ? "medium" : "low";

    // ---- CONTRÔLES DÉTERMINISTES (code, jamais l'IA) ----
    const warnings: string[] = [];
    const structural = validateOperation({
      type: type ?? undefined, date: op.date ?? undefined,
      quantity: op.quantity, unitPrice: op.unitPrice,
      grossAmount: (type === "achat" || type === "vente" || type === "transfer_in" || type === "transfer_out") ? amount : undefined,
      netAmount: (type === "achat" || type === "vente" || type === "transfer_in" || type === "transfer_out") ? undefined : amount,
      fees: op.fees ?? undefined, taxes: op.taxes ?? undefined,
    });
    if (!type) warnings.push("Type d'opération non reconnu.");
    if (!op.date) warnings.push("Date illisible.");
    if (type && op.date && !structural.ok) warnings.push(structural.error);
    if (op.isin && !isValidIsin(op.isin)) warnings.push("ISIN invalide (clé de contrôle).");
    if (op.currency && !CURRENCY_RE.test(op.currency)) warnings.push("Devise non standard.");
    // Cohérence quantité × prix ≈ montant brut.
    if (quantity !== null && unitPrice !== null && grossAmount !== null) {
      const expected = quantity * unitPrice;
      if (Math.abs(expected - grossAmount) > Math.max(0.02, expected * 0.01)) warnings.push("Incohérence quantité × prix vs montant brut.");
    }
    // Cohérence brut / frais / taxes / net.
    if (grossAmount !== null && netAmount !== null) {
      const f = fees ?? 0, t = taxes ?? 0;
      const expectedNet = type === "achat" || type === "transfer_in" ? grossAmount + f
        : type === "vente" || type === "transfer_out" || type === "dividende" ? grossAmount - f - t
        : netAmount;
      if (Math.abs(expectedNet - netAmount) > Math.max(0.02, Math.abs(expectedNet) * 0.01)) warnings.push("Incohérence brut − frais − taxes vs net.");
    }
    for (const w of entry.warnings ?? []) if (typeof w === "string" && w.trim()) warnings.push(w.trim());

    return { op, confidence, band, page: entry.page ?? null, sourceText: entry.source_text ?? null, warnings };
  });

  return { document, operations };
}
