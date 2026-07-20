"use client";

import { supabaseBrowser } from "./supabase-browser";

export async function giftAuthHeaders() {
  const session = (await supabaseBrowser.auth.getSession()).data.session;
  return { authorization: "Bearer " + (session?.access_token ?? ""), "content-type": "application/json" };
}

export async function requestGiftsApi<T = unknown>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...init, headers: { ...(await giftAuthHeaders()), ...init.headers } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Opération impossible.");
  return result;
}

export type GiftSavePayload = {
  id?: string;
  member: string;
  occasion: "Anniversaire" | "Noël" | "Autre cadeau";
  giftDate: string;
  purchaseDate: string;
  amountEur: number;
  btcAmount: number;
  custody: "Binance commun" | "Ledger";
  transferDate?: string | null;
  ledgerAmount?: number | null;
  forceLedgerAmount?: boolean;
  forceReason?: string | null;
  publicAddress?: string | null;
  txid?: string | null;
  blockchainStatus?: string;
  confirmations?: number;
  note?: string | null;
};

// Single real write path shared by every "add/edit a gift" entry point (GiftEditor,
// quick-add InvestmentModal): always goes through /api/gifts, never a local-only state.
export async function saveGift(payload: GiftSavePayload) {
  const { id, ...body } = payload;
  return requestGiftsApi<{ saved?: boolean; updated?: boolean; id?: string; error?: string }>("/api/gifts", {
    method: id ? "PATCH" : "POST",
    body: JSON.stringify(id ? { id, ...body } : body),
  });
}
