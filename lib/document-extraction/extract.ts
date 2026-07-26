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
    // Relevé de POSITIONS : date d'arrêté + totaux imprimés sur le document. Les totaux ne sont
    // jamais importés — ils servent uniquement de contre-vérification arithmétique de la somme
    // des lignes retranscrites (cf. `crossCheckTotals`).
    as_of_date?: ExtractedField<string>;
    total_valuation?: ExtractedField<number>;
    total_gain?: ExtractedField<number>;
    cash_balance?: ExtractedField<number>;
  };
  // Un relevé de POSITIONS (« Mes positions », « Portefeuille », « Gestion libre ») ne contient
  // aucune opération datée : il décrit un état à une date. Il alimente `positions`, pas
  // `operations`. C'est le cas qui échouait auparavant : le schéma ne connaissait que les
  // opérations, l'IA renvoyait donc [] et l'import s'arrêtait sur « aucune ligne exploitable ».
  positions?: Array<{
    isin?: ExtractedField<string>;
    ticker?: ExtractedField<string>;
    instrument_name?: ExtractedField<string>;
    quantity?: ExtractedField<number>;
    average_cost?: ExtractedField<number>;
    last_price?: ExtractedField<number>;
    current_value?: ExtractedField<number>;
    day_change_pct?: ExtractedField<number>;
    gain_amount?: ExtractedField<number>;
    gain_pct?: ExtractedField<number>;
    weight_pct?: ExtractedField<number>;
    currency?: ExtractedField<string>;
    last_movement_date?: ExtractedField<string>;
    source_text?: string;
    page?: number | null;
    warnings?: string[];
  }>;
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
export const EXTRACTION_JSON_INSTRUCTION = `Tu retranscris un relevé de compte-titres ou de PEA. Deux familles de documents existent, et tu dois d'abord décider laquelle tu as sous les yeux :

A) RELEVÉ DE POSITIONS (« Mes positions », « Portefeuille », « Gestion libre », « Évaluation », « Titres en portefeuille ») : un tableau d'INSTRUMENTS DÉTENUS à une date donnée, avec des colonnes du genre Valeur/Libellé, Quantité, Px. Revient (PRU), Cours, Montant/Valorisation, +/- Values latentes, Dernier Mvt. Il n'y a PAS d'achats ni de ventes datés.
   → remplis "positions", laisse "operations" VIDE.

B) RELEVÉ D'OPÉRATIONS (« Mouvements », « Ordres », « Historique », « Relevé de compte ») : une ligne par transaction datée (achat, vente, versement, dividende…).
   → remplis "operations", laisse "positions" VIDE.

Si le document contient les deux tableaux, remplis les deux. Ne devine JAMAIS un achat à partir d'une position : une position n'est pas une opération.

Réponds UNIQUEMENT avec un objet JSON valide, sans texte autour, de la forme :
{
  "document": {
    "institution": {"value": string|null, "confidence": number, "page": number},
    "account_type": {"value": "pea"|"securities"|null, "confidence": number, "page": number},
    "currency": {"value": string|null, "confidence": number, "page": number},
    "holder": {"value": string|null, "confidence": number, "page": number},
    "period": {"value": string|null, "confidence": number, "page": number},
    "as_of_date": {"value": "YYYY-MM-DD"|null, "confidence": number, "page": number},
    "total_valuation": {"value": number|null, "confidence": number, "page": number},
    "total_gain": {"value": number|null, "confidence": number, "page": number},
    "cash_balance": {"value": number|null, "confidence": number, "page": number}
  },
  "positions": [
    {
      "instrument_name": {"value": string|null, "confidence": number, "page": number},
      "isin": {"value": string|null, "confidence": number, "page": number},
      "ticker": {"value": string|null, "confidence": number, "page": number},
      "quantity": {"value": number|null, "confidence": number, "page": number},
      "average_cost": {"value": number|null, "confidence": number, "page": number},
      "last_price": {"value": number|null, "confidence": number, "page": number},
      "current_value": {"value": number|null, "confidence": number, "page": number},
      "day_change_pct": {"value": number|null, "confidence": number, "page": number},
      "gain_amount": {"value": number|null, "confidence": number, "page": number},
      "gain_pct": {"value": number|null, "confidence": number, "page": number},
      "weight_pct": {"value": number|null, "confidence": number, "page": number},
      "currency": {"value": string|null, "confidence": number, "page": number},
      "last_movement_date": {"value": "YYYY-MM-DD"|null, "confidence": number, "page": number},
      "source_text": string,
      "page": number,
      "warnings": [string]
    }
  ],
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
Règles STRICTES :
- confidence est un nombre entre 0 et 1.
- N'invente AUCUNE valeur : si une information est absente, mets value=null et confidence basse.
- Les nombres sont des NOMBRES JSON, avec un POINT décimal et sans séparateur de milliers ni symbole : « 76 634,75 € » → 76634.75. Une perte ou un gain négatif est négatif : « -4 129,09 € » → -4129.09.
- Ne calcule RIEN : ni total de portefeuille, ni prix moyen, ni performance. Recopie uniquement ce qui est imprimé. Si une colonne est absente du document, mets null — ne la déduis pas des autres.
- Recopie le texte source de chaque ligne dans source_text (utile à la vérification humaine).
- Retranscris TOUTES les lignes du tableau, y compris celles qui sont partiellement lisibles (avec une confiance basse), jamais un échantillon.
- Attention aux caractères ambigus d'un ISIN (O/0, I/1, S/5) : en cas de doute, baisse la confiance de l'ISIN.`;

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

  const rawPositions = Array.isArray(root.positions)
    ? root.positions
    : Array.isArray(root.holdings) ? root.holdings
      : Array.isArray(root.portfolio) ? root.portfolio
        : isRecord(root.data) && Array.isArray(root.data.positions) ? root.data.positions : [];

  const positions = rawPositions.filter(isRecord).map(normalizePositionEntry);

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

  // Repêchage d'un mode de défaillance connu : le modèle range parfois les LIGNES DE POSITION
  // dans "operations". Elles s'y reconnaissent à coup sûr — ni type d'opération, ni date, mais
  // une quantité et un prix. Plutôt que de les présenter comme des opérations invalides (ce qui
  // vidait l'import), on les reclasse en positions. Purement déterministe, jamais une invention.
  const misfiled: RawExtraction["positions"] = [];
  const keptOperations = operations.filter((entry) => {
    const hasType = Boolean(normalizeType(String(fieldValue<unknown>(entry.type) ?? "")));
    const hasDate = Boolean(str(fieldValue(entry.date)));
    const hasQuantity = num(fieldValue(entry.quantity)) !== null;
    const hasPrice = num(fieldValue(entry.unit_price)) !== null;
    if (!hasType && !hasDate && hasQuantity && hasPrice) {
      misfiled.push(normalizePositionEntry(entry as unknown as Record<string, unknown>));
      return false;
    }
    return true;
  });

  return { document, operations: keptOperations, positions: [...positions, ...misfiled] } as RawExtraction;
}

/** Normalise une ligne de POSITION (tolère les variantes de nommage des modèles). */
function normalizePositionEntry(entry: Record<string, unknown>) {
  return {
    isin: firstDefined(entry, ["isin", "ISIN", "code_isin"]),
    ticker: firstDefined(entry, ["ticker", "symbol", "symbole", "mnemo"]),
    instrument_name: firstDefined(entry, ["instrument_name", "instrumentName", "name", "label", "libelle", "valeur", "security", "asset_name", "designation"]),
    quantity: firstDefined(entry, ["quantity", "qty", "quantite", "shares", "units", "parts"]),
    average_cost: firstDefined(entry, ["average_cost", "averageCost", "pru", "cost_basis", "unit_cost", "prix_de_revient", "purchase_price"]),
    last_price: firstDefined(entry, ["last_price", "lastPrice", "price", "cours", "current_price", "market_price", "unit_price", "unitPrice"]),
    current_value: firstDefined(entry, ["current_value", "currentValue", "market_value", "marketValue", "valorisation", "montant", "amount", "value", "total"]),
    day_change_pct: firstDefined(entry, ["day_change_pct", "dayChangePct", "variation", "var_veille", "daily_change"]),
    gain_amount: firstDefined(entry, ["gain_amount", "gainAmount", "gain", "unrealized_gain", "plus_value", "pnl", "latent_gain"]),
    gain_pct: firstDefined(entry, ["gain_pct", "gainPct", "gain_percent", "performance", "plus_value_pct"]),
    weight_pct: firstDefined(entry, ["weight_pct", "weightPct", "weight", "poids"]),
    currency: firstDefined(entry, ["currency", "devise", "ccy"]),
    last_movement_date: firstDefined(entry, ["last_movement_date", "lastMovementDate", "dernier_mvt", "last_trade_date", "date"]),
    source_text: String(fieldValue<unknown>(firstDefined(entry, ["source_text", "sourceText", "raw_text", "rawText"])) ?? "") || undefined,
    page: num(firstDefined(entry, ["page", "page_number", "pageNumber"])),
    warnings: Array.isArray(entry.warnings) ? entry.warnings.filter((warning): warning is string => typeof warning === "string") : [],
  } as NonNullable<RawExtraction["positions"]>[number];
}

export type ExtractedDocument = {
  institution: string | null; accountType: string | null; currency: string | null;
  holder: string | null; period: string | null;
  asOfDate: string | null; totalValuation: number | null; totalGain: number | null; cashBalance: number | null;
};

/** En-tête et métadonnées du document, communs aux deux familles de relevés. */
export function extractDocument(raw: RawExtraction): ExtractedDocument {
  const doc = raw.document ?? {};
  const rawAsOf = str(fieldValue(doc.as_of_date));
  return {
    institution: str(fieldValue(doc.institution)),
    accountType: str(fieldValue(doc.account_type)),
    currency: str(fieldValue(doc.currency)),
    holder: str(fieldValue(doc.holder)),
    period: str(fieldValue(doc.period)),
    asOfDate: parseDate(rawAsOf, "iso") ?? parseDate(rawAsOf, "fr") ?? parseDate(rawAsOf, "us"),
    totalValuation: num(fieldValue(doc.total_valuation)),
    totalGain: num(fieldValue(doc.total_gain)),
    cashBalance: num(fieldValue(doc.cash_balance)),
  };
}

export function validateExtraction(raw: RawExtraction, options: { accountCurrency: string; thresholds?: ExtractionThresholds }): {
  document: ExtractedDocument;
  operations: ExtractedOperation[];
} {
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  const document = extractDocument(raw);

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

// ==========================================================================================
// RELEVÉ DE POSITIONS → tableau canonique
// ==========================================================================================
// Un relevé de positions retranscrit par l'IA est reversé dans le MÊME pipeline que le CSV
// (`buildSnapshotPreview`) plutôt que dans un second moteur : on fabrique ici le tableau
// `string[][]` et son en-tête, avec des libellés que `autoMapSnapshotHeaders` reconnaît déjà.
// Bénéfice direct : toutes les contre-vérifications déterministes existantes (cours recalculé
// = valorisation ÷ quantité, prix de revient vs +/- value, rapprochement d'instrument) portent
// aussi sur le scan IA, sans être réécrites.

/** En-tête canonique — les libellés sont ceux que reconnaît `autoMapSnapshotHeaders`. */
export const SNAPSHOT_TABLE_HEADER = [
  "Libellé", "ISIN", "Ticker", "Quantité", "PRU", "Cours", "Devise",
  "Valorisation", "Var/veille", "+/- values", "+/- values (%)", "Poids",
] as const;

export type ExtractedPositionMeta = {
  confidence: number;
  band: ConfidenceBand;
  page: number | null;
  sourceText: string | null;
  warnings: string[];
  lastMovementDate: string | null;
};

/**
 * Nombre → cellule texte NON AMBIGUË (point décimal, aucun séparateur de milliers).
 * Le JSON de l'IA porte de vrais nombres : contrairement à un CSV, il n'y a donc aucune
 * ambiguïté « 81,023 » à trancher. On la supprime à la source plutôt que de la redétecter.
 */
function numCell(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "";
  if (value !== 0 && Math.abs(value) < 1e-4) return value.toFixed(10); // jamais de notation exponentielle
  return String(value);
}

export function validateExtractedPositions(raw: RawExtraction, options: { accountCurrency: string; thresholds?: ExtractionThresholds }): {
  header: string[];
  rows: string[][];
  meta: ExtractedPositionMeta[];
} {
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  const entries = Array.isArray(raw.positions) ? raw.positions : [];
  const rows: string[][] = [];
  const meta: ExtractedPositionMeta[] = [];

  for (const entry of entries) {
    const name = str(fieldValue(entry.instrument_name));
    const isin = (str(fieldValue(entry.isin)) ?? "").toUpperCase() || null;
    const ticker = (str(fieldValue(entry.ticker)) ?? "").toUpperCase() || null;
    const quantity = num(fieldValue(entry.quantity));
    const averageCost = num(fieldValue(entry.average_cost));
    const lastPrice = num(fieldValue(entry.last_price));
    const currentValue = num(fieldValue(entry.current_value));
    const currency = (str(fieldValue(entry.currency)) || options.accountCurrency || "EUR").toUpperCase().slice(0, 3);

    // Ligne entièrement vide : l'IA a parfois retranscrit un séparateur de tableau.
    if (!name && !isin && !ticker && quantity === null) continue;

    rows.push([
      name ?? "",
      isin ?? "",
      ticker ?? "",
      numCell(quantity),
      numCell(averageCost),
      numCell(lastPrice),
      currency,
      numCell(currentValue),
      numCell(num(fieldValue(entry.day_change_pct))),
      numCell(num(fieldValue(entry.gain_amount))),
      numCell(num(fieldValue(entry.gain_pct))),
      numCell(num(fieldValue(entry.weight_pct))),
    ]);

    // Confiance de ligne = min des champs qui DÉCIDENT de la position (identité + quantité + prix).
    const confidence = Math.min(
      fieldConf(entry.instrument_name),
      fieldConf(entry.quantity),
      Math.max(fieldConf(entry.average_cost), fieldConf(entry.last_price)),
    );
    const band: ConfidenceBand = confidence >= thresholds.high ? "high" : confidence >= thresholds.low ? "medium" : "low";

    // ---- CONTRÔLES DÉTERMINISTES propres au scan (les contrôles arithmétiques de cohérence
    // cours/valorisation sont ajoutés ensuite par buildSnapshotPreview, non dupliqués ici). ----
    const warnings: string[] = [];
    if (isin && !isValidIsin(isin)) warnings.push("ISIN invalide (clé de contrôle) : vérifiez les caractères ambigus (O/0, I/1, S/5).");
    if (!isin && !ticker) warnings.push("Aucun code ISIN ni ticker lu : le rapprochement se fera sur le nom.");
    if (quantity !== null && quantity <= 0) warnings.push("Quantité nulle ou négative.");
    if (!CURRENCY_RE.test(currency)) warnings.push("Devise non standard.");
    for (const w of entry.warnings ?? []) if (typeof w === "string" && w.trim()) warnings.push(w.trim());

    const rawMovement = str(fieldValue(entry.last_movement_date));
    meta.push({
      confidence, band,
      page: entry.page ?? null,
      sourceText: entry.source_text ?? null,
      warnings,
      lastMovementDate: parseDate(rawMovement, "iso") ?? parseDate(rawMovement, "fr") ?? parseDate(rawMovement, "us"),
    });
  }

  return { header: [...SNAPSHOT_TABLE_HEADER], rows, meta };
}

/**
 * Contre-vérification : la SOMME des lignes retranscrites doit redonner le total imprimé sur le
 * relevé. C'est le contrôle le plus utile d'un scan — il détecte une ligne oubliée ou mal lue,
 * ce qu'aucune confiance déclarée par le modèle ne peut garantir. Aucun total n'est importé.
 */
export function crossCheckTotals(params: { sumValuation: number | null; sumGain: number | null; document: ExtractedDocument }): {
  valuation: { expected: number; actual: number; ok: boolean } | null;
  gain: { expected: number; actual: number; ok: boolean } | null;
} {
  const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(Math.abs(b) * 0.005, 0.5);
  const { document, sumValuation, sumGain } = params;
  return {
    valuation: document.totalValuation !== null && sumValuation !== null
      ? { expected: document.totalValuation, actual: sumValuation, ok: close(sumValuation, document.totalValuation) }
      : null,
    gain: document.totalGain !== null && sumGain !== null
      ? { expected: document.totalGain, actual: sumGain, ok: close(sumGain, document.totalGain) }
      : null,
  };
}
