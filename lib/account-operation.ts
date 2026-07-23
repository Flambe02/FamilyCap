// Validation + construction d'UNE opération de compte (PEA / compte-titres) — logique PURE,
// partagée par la saisie manuelle (/api/pea/operations) ET l'import (/api/investment-imports/commit).
// SOURCE DE VÉRITÉ UNIQUE de la validation d'opération : aucune autre route ne doit réimplémenter
// ces règles. Le portefeuille reste dérivé par computeAccountModel() ; on ne calcule ici que le
// montant net (mouvement de trésorerie) et les repli gross/net, comme un relevé bancaire réel.
//
// Aucune donnée inventée : si un montant n'est pas déductible, on renvoie une erreur explicite
// plutôt qu'une valeur par défaut trompeuse.

export type OperationType =
  | "achat" | "vente" | "versement" | "retrait" | "dividende" | "frais" | "correction"
  | "transfer_in" | "transfer_out";

// Types acceptés par la contrainte CHECK de account_operations (20260722 + 20260725).
export const OPERATION_TYPES: ReadonlySet<string> = new Set<OperationType>([
  "achat", "vente", "versement", "retrait", "dividende", "frais", "correction", "transfer_in", "transfer_out",
]);

// Types qui EXIGENT la migration 20260725 (transferts de titres). Le PEA n'en émet jamais.
export const ADVANCED_TYPES: ReadonlySet<string> = new Set<OperationType>(["transfer_in", "transfer_out"]);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type OperationInput = {
  type?: string;
  date?: string;
  assetName?: string;
  ticker?: string;
  isin?: string;
  quantity?: number | null;
  unitPrice?: number | null;
  grossAmount?: number | null;
  netAmount?: number | null;
  fees?: number | null;
  taxes?: number | null;
  currency?: string;
  exchangeRate?: number | null;
  source?: string;
  note?: string;
  externalReference?: string | null;
};

export type OperationExtras = {
  memberId: string;
  source?: string;
  importBatchId?: string | null;
  externalReference?: string | null;
  importFingerprint?: string | null;
};

export type BuildResult =
  | { ok: true; record: Record<string, unknown> }
  | { ok: false; error: string };

function toAmount(value: number | null | undefined): number | null {
  return value === undefined || value === null || !Number.isFinite(Number(value)) ? null : Math.round(Number(value) * 100) / 100;
}

function toNumberOrNull(value: number | null | undefined): number | null {
  return value === undefined || value === null || !Number.isFinite(Number(value)) ? null : Number(value);
}

/**
 * Valide une opération et calcule ses montants dérivés (gross/net). NE construit PAS l'insert :
 * renvoie les champs numériques normalisés + le type, pour que l'appelant assemble le record
 * (en y ajoutant member_id, source, colonnes d'import…). Séparé de buildOperationRecord pour
 * pouvoir tester la validation sans dépendre de la forme d'insertion Supabase.
 */
export function validateOperation(input: OperationInput):
  | { ok: true; type: OperationType; date: string; quantity: number | null; unitPrice: number | null; gross: number | null; net: number | null; fees: number; taxes: number | null; exchangeRate: number | null }
  | { ok: false; error: string } {
  const type = (input.type ?? "").trim() as OperationType;
  if (!OPERATION_TYPES.has(type)) return { ok: false, error: "Type d'opération invalide." };
  if (!input.date || !ISO_DATE.test(input.date)) return { ok: false, error: "La date (AAAA-MM-JJ) est obligatoire." };

  const quantity = toNumberOrNull(input.quantity);
  const unitPrice = toNumberOrNull(input.unitPrice);
  const fees = toAmount(input.fees) ?? 0;
  const taxes = toAmount(input.taxes);
  const exchangeRate = toNumberOrNull(input.exchangeRate);
  let gross = toAmount(input.grossAmount);
  let net = toAmount(input.netAmount);

  if (type === "achat" || type === "vente") {
    if (!(Number(quantity) > 0) || !(Number(unitPrice) > 0)) {
      return { ok: false, error: "Un achat ou une vente exige une quantité et un prix unitaire positifs." };
    }
    if (gross === null) gross = Math.round(Number(quantity) * Number(unitPrice) * 100) / 100;
    if (net === null) net = type === "achat" ? gross + fees : Math.max(0, gross - fees);
  } else if (type === "transfer_in" || type === "transfer_out") {
    if (!(Number(quantity) > 0)) return { ok: false, error: "Un transfert de titres exige une quantité positive." };
    if (gross === null) gross = Number(unitPrice) > 0 ? Math.round(Number(quantity) * Number(unitPrice) * 100) / 100 : 0;
    if (net === null) net = gross;
  } else if (type === "versement" || type === "retrait" || type === "frais") {
    if (net === null) net = gross;
    if (net === null || !(Number(net) > 0)) return { ok: false, error: "Un versement, un retrait ou des frais exigent un montant positif." };
    if (gross === null) gross = net;
  } else if (type === "dividende") {
    if (net === null) net = gross;
    if (net === null || !(Number(net) > 0)) return { ok: false, error: "Un dividende exige un montant net positif." };
    if (gross === null) gross = net;
  } else if (type === "correction") {
    if (quantity === null && net === null) return { ok: false, error: "Une correction exige une quantité ou un montant." };
  }

  return { ok: true, type, date: input.date, quantity, unitPrice, gross, net, fees, taxes, exchangeRate };
}

/**
 * Construit le record d'insertion account_operations. member_id est TOUJOURS fourni par
 * l'appelant (dérivé du compte côté serveur), jamais issu du navigateur. Les colonnes avancées
 * (taxes, exchange_rate — 20260725 ; import_batch_id, external_reference, import_fingerprint —
 * 20260726) ne sont ajoutées QUE si renseignées, pour ne pas casser l'écriture tant que la
 * migration correspondante n'est pas jouée.
 */
export function buildOperationRecord(input: OperationInput, extras: OperationExtras): BuildResult {
  const validated = validateOperation(input);
  if (!validated.ok) return validated;

  const record: Record<string, unknown> = {
    member_id: extras.memberId,
    type: validated.type,
    operation_date: validated.date,
    asset_name: input.assetName?.trim() || null,
    ticker: input.ticker?.trim().toUpperCase() || null,
    isin: input.isin?.trim().toUpperCase() || null,
    quantity: validated.quantity,
    unit_price: validated.unitPrice,
    gross_amount: validated.gross,
    fees: validated.fees,
    net_amount: validated.net,
    currency: (input.currency || "EUR").toUpperCase(),
    source: extras.source ?? input.source?.trim() ?? "saisie manuelle",
    note: input.note?.trim() || null,
  };
  if (validated.taxes !== null) record.taxes = validated.taxes;
  if (validated.exchangeRate !== null) record.exchange_rate = validated.exchangeRate;
  if (extras.importBatchId) record.import_batch_id = extras.importBatchId;
  const extRef = extras.externalReference ?? input.externalReference ?? null;
  if (extRef) record.external_reference = String(extRef).slice(0, 200);
  if (extras.importFingerprint) record.import_fingerprint = extras.importFingerprint;
  return { ok: true, record };
}
