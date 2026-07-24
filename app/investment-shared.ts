"use client";

// Helpers partagés entre le shell d'investissement (investment-account.tsx) et l'assistant
// d'import (investment-import-wizard.tsx). Isolés ici pour éviter tout cycle d'import entre ces
// deux modules. Aucune logique métier : juste l'appel authentifié et les libellés d'opération.

import { getAccessToken } from "../lib/supabase-session";
import type { AccountOperationType } from "../lib/portfolio-account";

export async function authenticatedFetch(url: string, init: RequestInit = {}) {
  const token = await getAccessToken();
  return fetch(url, { ...init, headers: { ...init.headers, ...(token ? { authorization: "Bearer " + token } : {}) } });
}

export const OP_LABEL: Record<AccountOperationType, string> = {
  achat: "Achat", vente: "Vente", versement: "Versement", retrait: "Retrait",
  dividende: "Dividende", frais: "Frais", correction: "Correction",
  transfer_in: "Transfert entrant", transfer_out: "Transfert sortant",
};
export const OP_ICON: Record<AccountOperationType, string> = {
  achat: "📈", vente: "📉", versement: "➕", retrait: "➖", dividende: "💶", frais: "🧾", correction: "✏️",
  transfer_in: "📥", transfer_out: "📤",
};
// Sens du mouvement affiché (+ / −). Les transferts de titres ne bougent pas les espèces :
// le signe ne colore que la flèche, le montant reste la valeur des titres transférés.
export const OP_INFLOW: Record<AccountOperationType, boolean> = {
  versement: true, vente: true, dividende: true, transfer_in: true, correction: true,
  achat: false, retrait: false, frais: false, transfer_out: false,
};
