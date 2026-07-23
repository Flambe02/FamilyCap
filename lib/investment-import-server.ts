// Contexte serveur d'un import : côté Node uniquement (utilise la clé service-role via
// supabaseRest). Charge, pour un compte donné, tout ce dont buildPreview/commit ont besoin :
// le compte lui-même (type + statut actif), le référentiel holdings, les empreintes/références
// déjà en base (dédoublonnage) et les quantités déjà détenues (contrôle « vente > détenu »).
//
// SÉCURITÉ : le member_id n'est JAMAIS pris du client — il est dérivé du compte ici. Les
// écritures passent par des routes requireAdmin ; ce helper ne fait que lire/assembler.

import { supabaseRest } from "./supabase-rest.ts";
import { computeAccountModel, instrumentKey, priceKeyOf, type AccountOperation, type InstrumentPrice } from "./portfolio-account.ts";
import type { HoldingRef } from "./investment-import.ts";

// Limites anti-abus (fichier + lignes). Un relevé familial dépasse rarement ces bornes.
export const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 Mo
export const MAX_ROWS = 5000;

export type ImportAccount = {
  id: string;
  memberId: string;
  memberName: string | null;
  name: string;
  accountType: string; // 'pea' | 'securities' | …
  currency: string;
  isActive: boolean;
};

export type ImportContext = {
  account: ImportAccount;
  kind: "PEA" | "CTO";
  holdings: HoldingRef[];
  existingFingerprints: Set<string>;
  existingExternalRefs: Set<string>;
  openingQuantities: Record<string, number>;
  allowAdvanced: boolean; // migration 20260725 jouée (taxes / exchange_rate / transferts)
};

type AccountRow = { id: string; member_id: string; name: string; account_type: string; currency: string; is_active: boolean };
type MemberRow = { id: string; name: string };
type HoldingRow = { id: string; account_id: string; asset_type: string | null; name: string | null; symbol: string | null; isin: string | null; quantity: number; average_cost: number | null; last_price: number | null; last_price_at: string | null; currency: string };
type OperationRow = {
  id: string; account_id: string; member_id: string; type: string; operation_date: string;
  asset_name: string | null; ticker: string | null; isin: string | null; quantity: number | null;
  unit_price: number | null; gross_amount: number | null; fees: number | null; net_amount: number | null;
  currency: string; source: string | null; note: string | null;
};

/** Charge un compte porteur d'opérations (PEA / compte-titres) et vérifie son éligibilité. */
export async function loadImportAccount(accountId: string): Promise<ImportAccount | null> {
  const rows = await supabaseRest<AccountRow[]>(
    `financial_accounts?select=id,member_id,name,account_type,currency,is_active&id=eq.${encodeURIComponent(accountId)}&limit=1`,
  );
  const row = rows[0];
  if (!row) return null;
  let memberName: string | null = null;
  try {
    const members = await supabaseRest<MemberRow[]>(`family_members?select=id,name&id=eq.${encodeURIComponent(row.member_id)}&limit=1`);
    memberName = members[0]?.name ?? null;
  } catch { /* nom facultatif */ }
  return { id: row.id, memberId: row.member_id, memberName, name: row.name, accountType: row.account_type, currency: row.currency, isActive: row.is_active };
}

/** true si les comptes de ce type portent des opérations (PEA / compte-titres). */
export function isOperationAccount(accountType: string): boolean {
  return accountType === "pea" || accountType === "securities";
}

async function detectAdvanced(): Promise<boolean> {
  try {
    await supabaseRest<unknown[]>("account_operations?select=exchange_rate&limit=1");
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("exchange_rate") || message.includes("42703") || message.includes("PGRST204")) return false;
    return true; // autre erreur (table vide etc.) → ne pas bloquer inutilement
  }
}

export async function loadImportContext(account: ImportAccount): Promise<ImportContext> {
  const kind: "PEA" | "CTO" = account.accountType === "pea" ? "PEA" : "CTO";
  const [holdingRows, operationRows, allowAdvanced] = await Promise.all([
    supabaseRest<HoldingRow[]>(`holdings?select=id,account_id,asset_type,name,symbol,isin,quantity,average_cost,last_price,last_price_at,currency&account_id=eq.${encodeURIComponent(account.id)}`),
    fetchExistingOperations(account.id),
    detectAdvanced(),
  ]);

  const holdings: HoldingRef[] = holdingRows.map((h) => ({ id: h.id, isin: h.isin, symbol: h.symbol, name: h.name }));

  // Empreintes & références externes déjà en base (dédoublonnage inter-imports).
  const existingFingerprints = new Set<string>();
  const existingExternalRefs = new Set<string>();
  for (const op of operationRows) {
    if ((op as OperationRow & { import_fingerprint?: string }).import_fingerprint) existingFingerprints.add((op as OperationRow & { import_fingerprint?: string }).import_fingerprint!);
    const ref = (op as OperationRow & { external_reference?: string }).external_reference;
    if (ref) existingExternalRefs.add(ref);
  }

  // Quantités déjà détenues (par instrument) : dérivées des opérations existantes via le moteur.
  const priceByKey = new Map<string, InstrumentPrice>();
  for (const h of holdingRows) {
    priceByKey.set(priceKeyOf({ isin: h.isin, symbol: h.symbol, name: h.name }), { lastPrice: h.last_price, lastPriceAt: h.last_price_at ?? null, assetType: h.asset_type ?? null, name: h.name });
  }
  const model = computeAccountModel({ operations: operationRows.map(toAccountOperation), priceByKey, accountType: kind });
  const openingQuantities: Record<string, number> = {};
  for (const position of model.positions) {
    openingQuantities[instrumentKey({ isin: position.isin, ticker: position.ticker, assetName: position.name })] = position.quantity;
  }

  return { account, kind, holdings, existingFingerprints, existingExternalRefs, openingQuantities, allowAdvanced };
}

async function fetchExistingOperations(accountId: string): Promise<OperationRow[]> {
  try {
    return await supabaseRest<OperationRow[]>(
      `account_operations?select=id,account_id,member_id,type,operation_date,asset_name,ticker,isin,quantity,unit_price,gross_amount,fees,net_amount,currency,source,note,external_reference,import_fingerprint&account_id=eq.${encodeURIComponent(accountId)}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("external_reference") || message.includes("import_fingerprint")) {
      // Migration 20260726 non jouée → recharger sans les colonnes d'import.
      return supabaseRest<OperationRow[]>(
        `account_operations?select=id,account_id,member_id,type,operation_date,asset_name,ticker,isin,quantity,unit_price,gross_amount,fees,net_amount,currency,source,note&account_id=eq.${encodeURIComponent(accountId)}`,
      );
    }
    if (message.includes("account_operations") || message.includes("PGRST205")) return [];
    throw error;
  }
}

function toAccountOperation(op: OperationRow): AccountOperation {
  return {
    id: op.id, accountId: op.account_id, memberId: op.member_id, type: op.type as AccountOperation["type"],
    date: op.operation_date, assetName: op.asset_name, ticker: op.ticker, isin: op.isin,
    quantity: op.quantity === null ? null : Number(op.quantity), unitPrice: op.unit_price === null ? null : Number(op.unit_price),
    grossAmount: op.gross_amount === null ? null : Number(op.gross_amount), fees: op.fees === null ? null : Number(op.fees),
    netAmount: op.net_amount === null ? null : Number(op.net_amount), currency: op.currency, source: op.source, note: op.note,
  };
}
