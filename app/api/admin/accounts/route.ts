import { authErrorResponse, requireAdmin } from "../../../../lib/auth-server";
import { supabaseRest } from "../../../../lib/supabase-rest";

type AccountInput = {
  id?: string;
  memberId?: string;
  name?: string;
  accountType?: string;
  institution?: string;
  currency?: string;
  accountNumberLast4?: string;
  ibanLast4?: string;
  walletAddress?: string;
  network?: string;
  notes?: string;
  isActive?: boolean;
  importExistingWallets?: boolean;
};

const accountTypes = new Set(["bitcoin", "crypto_exchange", "bank", "pea", "securities", "savings", "other"]);

function setupResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Erreur Supabase";
  if (message.includes("financial_accounts") || message.includes("PGRST205")) {
    return Response.json({ error: "La migration des comptes financiers doit être appliquée dans Supabase.", setupRequired: true }, { status: 503 });
  }
  return authErrorResponse(error);
}

export async function GET(request: Request) {
  try {
    await requireAdmin(request);
    const [accounts, holdings] = await Promise.all([
      supabaseRest<Record<string, unknown>[]>("financial_accounts?select=*&order=created_at.desc"),
      supabaseRest<Record<string, unknown>[]>("holdings?select=*&order=created_at.desc"),
    ]);
    return Response.json({ accounts, holdings });
  } catch (error) {
    return setupResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    await requireAdmin(request);
    const body = await request.json() as AccountInput;
    if (body.importExistingWallets) {
      const [wallets, existing] = await Promise.all([
        supabaseRest<Array<{ member_id: string; member_name: string; label: string; custody: string; public_address: string | null; network: string }>>("wallets?select=member_id,member_name,label,custody,public_address,network"),
        supabaseRest<Array<{ wallet_address: string | null }>>("financial_accounts?select=wallet_address"),
      ]);
      const known = new Set(existing.map((account) => account.wallet_address).filter(Boolean));
      const missing = wallets.filter((wallet) => wallet.public_address && !known.has(wallet.public_address));
      for (const wallet of missing) {
        await supabaseRest("financial_accounts", {
          method: "POST",
          headers: { prefer: "return=minimal" },
          body: JSON.stringify({ member_id: wallet.member_id, name: wallet.label, account_type: "bitcoin", institution: wallet.custody, currency: "BTC", wallet_address: wallet.public_address, network: wallet.network }),
        });
      }
      return Response.json({ imported: missing.length, message: missing.length ? missing.length + " portefeuille(s) Ledger importé(s)." : "Tous les Ledger existants sont déjà importés." });
    }
    const name = body.name?.trim() ?? "";
    const memberId = body.memberId?.trim() ?? "";
    const accountType = accountTypes.has(body.accountType ?? "") ? body.accountType : "other";
    if (!name || !memberId) return Response.json({ error: "Le membre et le nom du compte sont obligatoires." }, { status: 400 });

    const rows = await supabaseRest<Array<{ id: string }>>("financial_accounts", {
      method: "POST",
      headers: { prefer: "return=representation" },
      body: JSON.stringify({
        member_id: memberId,
        name,
        account_type: accountType,
        institution: body.institution?.trim() || null,
        currency: (body.currency || "EUR").toUpperCase(),
        account_number_last4: body.accountNumberLast4?.trim().slice(-4) || null,
        iban_last4: body.ibanLast4?.trim().slice(-4) || null,
        wallet_address: body.walletAddress?.trim() || null,
        network: body.network?.trim() || null,
        notes: body.notes?.trim() || null,
      }),
    });
    return Response.json({ saved: true, id: rows[0]?.id }, { status: 201 });
  } catch (error) {
    return setupResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    await requireAdmin(request);
    const body = await request.json() as AccountInput;
    if (!body.id) return Response.json({ error: "Compte manquant." }, { status: 400 });
    const changes: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.name !== undefined) changes.name = body.name.trim();
    if (body.institution !== undefined) changes.institution = body.institution.trim() || null;
    if (body.isActive !== undefined) changes.is_active = body.isActive;
    if (body.notes !== undefined) changes.notes = body.notes.trim() || null;
    await supabaseRest(`financial_accounts?id=eq.${encodeURIComponent(body.id)}`, {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify(changes),
    });
    return Response.json({ updated: true });
  } catch (error) {
    return setupResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    await requireAdmin(request);
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return Response.json({ error: "Compte manquant." }, { status: 400 });
    await supabaseRest(`financial_accounts?id=eq.${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { prefer: "return=minimal" },
    });
    return Response.json({ deleted: true });
  } catch (error) {
    return setupResponse(error);
  }
}
