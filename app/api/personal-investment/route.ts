import { isSupabaseConfigured, supabaseRest } from "../../../lib/supabase-rest";
import { authErrorResponse, requireFamilyMember } from "../../../lib/auth-server";

// Enregistrement d'un investissement Bitcoin personnel par le membre lui-même.
// Même base que les cadeaux (table gift_records), mais :
//  - protégé par requireFamilyMember() ;
//  - member_id / member_name FORCÉS sur l'identité du jeton (jamais le corps) ;
//  - origine FORCÉE sur « investissement_personnel ».
// Un membre ne peut donc écrire qu'un investissement à son propre nom.

type PersonalInvestmentInput = {
  amountEur?: number;
  btcAmount?: number;
  custody?: string;
  date?: string;
  note?: string | null;
};

function validate(body: PersonalInvestmentInput) {
  if (!body.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) return "Date invalide.";
  if (!Number.isFinite(body.amountEur) || Number(body.amountEur) < 0) return "Montant invalide.";
  if (!Number.isFinite(body.btcAmount) || Number(body.btcAmount) <= 0) return "Quantité BTC invalide.";
  if (!["Binance commun", "Ledger"].includes(body.custody ?? "")) return "Lieu de conservation invalide.";
  return null;
}

function hasMissingSourceColumn(error: unknown) {
  return error instanceof Error && error.message.includes("PGRST204") && /['"`]source['"`]/i.test(error.message);
}

export async function POST(request: Request) {
  if (!isSupabaseConfigured()) return Response.json({ error: "Supabase est requis pour enregistrer un investissement." }, { status: 503 });
  try {
    const viewer = await requireFamilyMember(request);
    const body = await request.json() as PersonalInvestmentInput;
    const error = validate(body);
    if (error) return Response.json({ error }, { status: 400 });

    const custody = body.custody as "Binance commun" | "Ledger";
    let record: Record<string, unknown> = {
      member_id: viewer.id,
      member_name: viewer.name,
      occasion: "Autre cadeau",
      gift_date: body.date,
      purchase_date: body.date,
      amount_eur: Number(body.amountEur),
      btc_amount: Number(body.btcAmount),
      custody,
      transfer_date: null,
      ledger_amount: null,
      public_address: null,
      txid: null,
      blockchain_status: custody === "Ledger" ? "À vérifier" : "Stocké sur Binance commun",
      confirmations: 0,
      note: body.note?.trim() || null,
      source: "investissement_personnel",
      is_deleted: false,
    };

    // Tolère l'absence de la colonne optionnelle `source` tant que sa migration n'a pas
    // été jouée : on retire la colonne manquante et on réessaie, sans bloquer la saisie.
    let saved: Array<{ id: string }> | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        saved = await supabaseRest<Array<{ id: string }>>("gift_records", {
          method: "POST",
          headers: { prefer: "return=representation" },
          body: JSON.stringify(record),
        });
        break;
      } catch (caught) {
        if (hasMissingSourceColumn(caught) && "source" in record) {
          const next = { ...record }; delete next.source; record = next; continue;
        }
        throw caught;
      }
    }
    return Response.json({ saved: true, id: saved?.[0]?.id, persistence: "supabase" }, { status: 201 });
  } catch (error) {
    return authErrorResponse(error);
  }
}
