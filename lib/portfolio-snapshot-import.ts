import {
  detectNumberFormat,
  matchInstrument,
  parseDate,
  parseDecimal,
  type HoldingRef,
  type NormalizedOp,
  type NumberFormat,
  type PreviewRow,
  type PreviewSummary,
  type RowStatus,
} from "./investment-import.ts";

export type SnapshotField =
  | "instrumentName" | "isin" | "ticker" | "lastPrice" | "currency" | "quantity"
  | "averageCost" | "currentValue" | "dayChangePct" | "gainEur" | "gainPct" | "weightPct";

export type SnapshotMapping = Record<SnapshotField, number>;

export type SnapshotPosition = {
  name: string;
  isin: string | null;
  ticker: string | null;
  currency: string;
  quantity: number;
  averageCost: number | null;
  lastPrice: number | null;
  currentValue: number | null;
  dayChangePct: number | null;
  gainEur: number | null;
  gainPct: number | null;
  weightPct: number | null;
  holdingId: string | null;
};

export type SnapshotRowMeta = {
  asOfDate: string;
  lastPrice: number | null;
  currentValue: number | null;
  dayChangePct: number | null;
  gainEur: number | null;
  gainPct: number | null;
  weightPct: number | null;
  // Cours RECALCULÉ à partir du relevé lui-même (valorisation ÷ quantité). Ce n'est pas une
  // estimation : c'est la même donnée, lue par une autre colonne du même document. Sert de
  // contre-vérification du cours saisi et de correction proposée en un clic dans l'assistant.
  derivedPrice: number | null;
  priceMismatch: boolean;
};

export type SnapshotPreviewRow = PreviewRow & { snapshot: SnapshotRowMeta };

const ALIASES: Record<SnapshotField, string[]> = {
  instrumentName: ["libelle", "libelle valeur", "valeur", "designation", "nom", "instrument", "name"],
  isin: ["isin", "code isin", "code valeur", "code valeur isin"],
  ticker: ["ticker", "symbole", "symbol", "mnemo", "mnemonique"],
  lastPrice: ["cours", "cours actuel", "dernier cours", "prix", "last price", "price"],
  currency: ["dev", "devise", "monnaie", "currency", "ccy"],
  quantity: ["qte", "quantite", "quantity", "qty", "parts", "units", "shares"],
  averageCost: ["pru", "prix de revient", "prix moyen", "prix de revient unitaire", "average cost", "cost basis"],
  currentValue: ["valorisation", "valeur actuelle", "montant", "market value", "value"],
  dayChangePct: ["var/veille", "var veille", "variation/veille", "variation veille", "variation du jour", "day change", "day change (%)"],
  gainEur: ["plus value", "moins value", "plus moins value", "+/- values", "gain", "loss", "unrealized gain"],
  gainPct: ["plus value (%)", "plus moins value (%)", "+/- values (%)", "gain (%)", "performance (%)"],
  weightPct: ["poids", "weight", "poids (%)", "weight (%)"],
};

function norm(value: unknown): string {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9+%/-]+/g, " ").trim();
}

function cell(row: string[], index: number): string {
  return index >= 0 ? String(row[index] ?? "").trim() : "";
}

function firstMatch(header: string[], aliases: string[], used: Set<number>): number {
  const normalized = header.map(norm);
  for (const alias of aliases.map(norm)) {
    const index = normalized.findIndex((value, position) => !used.has(position) && value === alias);
    if (index >= 0) return index;
  }
  return -1;
}

export function autoMapSnapshotHeaders(header: string[]): SnapshotMapping {
  const mapping = {} as SnapshotMapping;
  const used = new Set<number>();
  for (const field of Object.keys(ALIASES) as SnapshotField[]) {
    const index = firstMatch(header, ALIASES[field], used);
    mapping[field] = index;
    if (index >= 0) used.add(index);
  }
  return mapping;
}

export function isPortfolioSnapshotHeader(header: string[]): boolean {
  const mapping = autoMapSnapshotHeaders(header);
  const hasInstrument = mapping.instrumentName >= 0 || mapping.isin >= 0 || mapping.ticker >= 0;
  const hasQuantity = mapping.quantity >= 0;
  const hasPrice = mapping.lastPrice >= 0 || mapping.averageCost >= 0;
  return hasInstrument && hasQuantity && hasPrice;
}

export function extractSnapshotDate(preamble: string[][], fallback?: string | null): string | null {
  const source = preamble.flat().join(" ");
  const date = /\b(\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}|\d{4}[/.\-]\d{1,2}[/.\-]\d{1,2})\b/.exec(source)?.[1];
  return parseDate(date ?? fallback, "fr");
}

function statusFor(errors: string[], warnings: string[]): RowStatus {
  return errors.length > 0 ? "error" : warnings.length > 0 ? "warning" : "valid";
}

/** Colonnes numériques d'un relevé de positions : échantillon pour détecter le format du fichier. */
export function snapshotNumericSamples(rows: string[][], mapping: SnapshotMapping): string[] {
  const indexes = [mapping.quantity, mapping.averageCost, mapping.lastPrice, mapping.currentValue, mapping.gainEur]
    .filter((index) => index >= 0);
  return rows.flatMap((raw) => indexes.map((index) => cell(raw, index))).filter((value) => value !== "");
}

// Deux valeurs sont-elles cohérentes à 1 % près (tolérance d'arrondi du relevé) ?
function closeEnough(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(Math.abs(b) * 0.01, 0.02);
}

export function buildSnapshotPreview(params: {
  rows: string[][];
  mapping: SnapshotMapping;
  asOfDate: string;
  accountCurrency: string;
  holdings: HoldingRef[];
  numberFormat?: NumberFormat;
}): { rows: SnapshotPreviewRow[]; summary: PreviewSummary; positions: SnapshotPosition[] } {
  const { rows, mapping, asOfDate, accountCurrency, holdings } = params;
  const numberFormat = params.numberFormat ?? detectNumberFormat(snapshotNumericSamples(rows, mapping));
  const previewRows: SnapshotPreviewRow[] = [];
  const positions: SnapshotPosition[] = [];

  rows.forEach((raw, index) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    const dec = (position: number) => parseDecimal(cell(raw, position), numberFormat);
    const name = cell(raw, mapping.instrumentName);
    const isin = cell(raw, mapping.isin).toUpperCase() || null;
    const ticker = cell(raw, mapping.ticker).toUpperCase() || null;
    const quantity = dec(mapping.quantity);
    const averageCost = dec(mapping.averageCost);
    const lastPrice = dec(mapping.lastPrice);
    const currentValue = dec(mapping.currentValue);
    const dayChangePct = dec(mapping.dayChangePct);
    const gainEur = dec(mapping.gainEur);
    const gainPct = dec(mapping.gainPct);
    const weightPct = dec(mapping.weightPct);
    const currency = (cell(raw, mapping.currency) || accountCurrency || "EUR").toUpperCase().slice(0, 3);

    if (!name && !isin && !ticker) errors.push("Instrument absent.");
    if (quantity === null || quantity < 0) errors.push("Quantité absente ou invalide.");
    if (averageCost === null && lastPrice === null) errors.push("Prix de revient ou cours absent.");

    // ---- Contre-vérification du cours par la valorisation du MÊME relevé -------------------
    // valorisation ÷ quantité doit redonner le cours. Un écart d'un facteur 1000 trahit un
    // séparateur décimal mal interprété ; la ligne passe « à vérifier » avec le cours recalculé
    // proposé, au lieu d'entrer telle quelle dans le portefeuille.
    const derivedPrice = currentValue !== null && quantity !== null && quantity > 0
      ? Math.round((currentValue / quantity) * 1e6) / 1e6
      : null;
    const priceMismatch = derivedPrice !== null && lastPrice !== null && lastPrice > 0 && !closeEnough(lastPrice, derivedPrice);
    if (priceMismatch) {
      warnings.push(`Cours incohérent : ${lastPrice} × ${quantity} ≠ valorisation ${currentValue}. Cours recalculé depuis le relevé : ${derivedPrice}.`);
    }
    // Même contrôle sur le prix de revient quand le relevé fournit la +/- value.
    if (gainEur !== null && currentValue !== null && averageCost !== null && quantity !== null && quantity > 0) {
      const impliedCost = currentValue - gainEur;
      if (!closeEnough(averageCost * quantity, impliedCost)) {
        warnings.push(`Prix de revient incohérent : ${averageCost} × ${quantity} ≠ valorisation − plus-value (${Math.round(impliedCost * 100) / 100}).`);
      }
    }

    const match = matchInstrument({ isin, ticker, instrumentName: name || null }, holdings);
    if (!match.holdingId) warnings.push("Instrument non reconnu : il sera créé avec son dernier cours.");
    const known = holdings.find((holding) => holding.id === match.holdingId);
    const operation: NormalizedOp = {
      type: "correction",
      date: asOfDate,
      isin,
      ticker: ticker ?? known?.symbol ?? null,
      instrumentName: name || known?.name || null,
      quantity,
      unitPrice: averageCost ?? lastPrice,
      amount: null,
      fees: 0,
      taxes: null,
      currency,
      exchangeRate: null,
      externalReference: null,
      note: `Position importée depuis un relevé au ${asOfDate}`,
    };
    const snapshot: SnapshotRowMeta = { asOfDate, lastPrice, currentValue, dayChangePct, gainEur, gainPct, weightPct, derivedPrice, priceMismatch };
    const fingerprint = `snapshot:${asOfDate}:${isin ?? ticker ?? name.toLowerCase()}:${index}`;
    const position: SnapshotPosition = {
      name: operation.instrumentName ?? "Actif sans nom",
      isin,
      ticker: operation.ticker,
      currency,
      quantity: quantity ?? 0,
      averageCost,
      lastPrice,
      currentValue,
      dayChangePct,
      gainEur,
      gainPct,
      weightPct,
      holdingId: match.holdingId,
    };
    positions.push(position);
    previewRows.push({
      index: index + 1,
      raw,
      op: operation,
      instrumentHoldingId: match.holdingId,
      matchedBy: match.matchedBy,
      fingerprint,
      status: statusFor(errors, warnings),
      errors,
      warnings,
      snapshot,
    });
  });

  return {
    rows: previewRows,
    positions,
    summary: {
      total: previewRows.length,
      valid: previewRows.filter((row) => row.status === "valid").length,
      toCheck: previewRows.filter((row) => row.status === "warning").length,
      errors: previewRows.filter((row) => row.status === "error").length,
      duplicatesCertain: 0,
      duplicatesPossible: 0,
      unknownInstruments: previewRows.filter((row) => !row.instrumentHoldingId).length,
    },
  };
}
