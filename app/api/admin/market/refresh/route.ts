import { authErrorResponse, requireAdmin } from "../../../../../lib/auth-server";
import { supabaseRest } from "../../../../../lib/supabase-rest";
import { fetchQuote, type QuoteOutcome } from "../../../../../lib/market-quotes";
import { computeAccountModel, priceKeyOf, instrumentKey, type AccountOperation, type InstrumentPrice } from "../../../../../lib/portfolio-account";
import { loadImportAccount, isOperationAccount } from "../../../../../lib/investment-import-server";
import { matchInstrument } from "../../../../../lib/investment-import";

// RAFRAÎCHISSEMENT DES COURS d'un compte (PEA / compte-titres). Admin uniquement.
//
// Le cours n'est plus une donnée de fichier : il est relu auprès d'un fournisseur de marché
// gratuit (Yahoo Finance, repli Stooq — voir lib/market-quotes.ts). La quantité, elle, reste
// dérivée des opérations : cette route n'écrit JAMAIS de quantité ni de prix de revient.
//
// Elle réconcilie aussi le référentiel : toute position détenue (dérivée des opérations) qui
// n'a pas encore de ligne `holdings` en reçoit une (quantité 0 — le moteur ignore ce champ),
// afin qu'un cours puisse s'y rattacher. C'est ce qui débloque les positions « Cours indispo. ».
//
// Aucune donnée inventée : un instrument introuvable, un fournisseur muet ou un cours dans une
// devise différente de la position sont RAPPORTÉS, jamais écrits.

export const runtime = "nodejs";

type HoldingRow = {
  id: string; account_id: string; asset_type: string | null; name: string | null; symbol: string | null;
  isin: string | null; quantity: number; last_price: number | null; last_price_at: string | null; currency: string;
  market_symbol?: string | null;
};
type OperationRow = {
  id: string; account_id: string; member_id: string; type: string; operation_date: string;
  asset_name: string | null; ticker: string | null; isin: string | null; quantity: number | null;
  unit_price: number | null; gross_amount: number | null; fees: number | null; net_amount: number | null;
  currency: string; source: string | null; note: string | null;
};

export type RefreshResult = {
  key: string;
  name: string;
  isin: string | null;
  ticker: string | null;
  status: "updated" | "unchanged" | "not_found" | "currency_mismatch" | "provider_error";
  price: number | null;
  currency: string | null;
  previousPrice: number | null;
  asOf: string | null;
  provider: string | null;
  symbol: string | null;
  message: string | null;
};

// Concurrence volontairement basse : ces API publiques gratuites n'aiment pas les rafales.
const CONCURRENCY = 4;

const HOLDING_SELECT = "id,account_id,asset_type,name,symbol,isin,quantity,last_price,last_price_at,currency";

async function fetchHoldings(accountId: string): Promise<{ rows: HoldingRow[]; hasMarketSymbol: boolean }> {
  const filter = `account_id=eq.${encodeURIComponent(accountId)}`;
  try {
    const rows = await supabaseRest<HoldingRow[]>(`holdings?select=${HOLDING_SELECT},market_symbol&${filter}`);
    return { rows: rows ?? [], hasMarketSymbol: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!/market_symbol|42703|PGRST20[0-9]/.test(message)) throw error;
    const rows = await supabaseRest<HoldingRow[]>(`holdings?select=${HOLDING_SELECT}&${filter}`);
    return { rows: rows ?? [], hasMarketSymbol: false };
  }
}

async function fetchOperations(accountId: string): Promise<OperationRow[]> {
  try {
    return (await supabaseRest<OperationRow[]>(
      `account_operations?select=id,account_id,member_id,type,operation_date,asset_name,ticker,isin,quantity,unit_price,gross_amount,fees,net_amount,currency,source,note&account_id=eq.${encodeURIComponent(accountId)}`,
    )) ?? [];
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
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

/** Exécute `task` sur chaque élément, par vagues de `CONCURRENCY`, en préservant l'ordre. */
async function mapLimited<T, R>(items: T[], task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += CONCURRENCY) {
    results.push(...(await Promise.all(items.slice(index, index + CONCURRENCY).map(task))));
  }
  return results;
}

export async function POST(request: Request) {
  try {
    await requireAdmin(request);
    const body = (await request.json().catch(() => ({}))) as { accountId?: string };
    const accountId = String(body.accountId ?? "").trim();
    if (!accountId) return Response.json({ error: "Le compte est obligatoire." }, { status: 400 });

    const account = await loadImportAccount(accountId);
    if (!account) return Response.json({ error: "Compte introuvable." }, { status: 404 });
    if (!isOperationAccount(account.accountType)) return Response.json({ error: "Ce type de compte n'a pas de cours à rafraîchir." }, { status: 400 });

    const [{ rows: holdingRows, hasMarketSymbol }, operationRows] = await Promise.all([
      fetchHoldings(account.id),
      fetchOperations(account.id),
    ]);

    // Positions RÉELLEMENT détenues (dérivées des opérations) — seules celles-ci méritent un cours.
    const priceByKey = new Map<string, InstrumentPrice>();
    for (const holding of holdingRows) {
      priceByKey.set(priceKeyOf({ isin: holding.isin, symbol: holding.symbol, name: holding.name }), {
        lastPrice: holding.last_price, lastPriceAt: holding.last_price_at, assetType: holding.asset_type, name: holding.name,
      });
    }
    const model = computeAccountModel({
      operations: operationRows.map(toAccountOperation),
      priceByKey,
      accountType: account.accountType === "pea" ? "PEA" : "CTO",
    });
    if (model.positions.length === 0) {
      return Response.json({ refreshed: 0, results: [] as RefreshResult[], message: "Aucune position détenue : rien à rafraîchir." });
    }

    const holdingByKey = new Map(holdingRows.map((holding) => [priceKeyOf({ isin: holding.isin, symbol: holding.symbol, name: holding.name }), holding]));
    const holdingById = new Map(holdingRows.map((holding) => [holding.id, holding]));

    const results = await mapLimited(model.positions, async (position): Promise<RefreshResult> => {
      const key = instrumentKey({ isin: position.isin, ticker: position.ticker, assetName: position.name });
      // Rapprochement en deux temps : clé exacte du moteur, puis rapprochement tolérant
      // (ISIN → ticker → nom), comme à l'import. Sans ce second passage, une ligne `holdings`
      // créée sans ISIN produirait un doublon à chaque rafraîchissement.
      const matched = holdingByKey.get(key)
        ?? holdingById.get(matchInstrument(
          { isin: position.isin, ticker: position.ticker, instrumentName: position.name },
          holdingRows.map((holding) => ({ id: holding.id, isin: holding.isin, symbol: holding.symbol, name: holding.name })),
        ).holdingId ?? "");
      const holding = matched ?? null;
      const base = {
        key, name: position.name, isin: position.isin, ticker: position.ticker,
        previousPrice: holding?.last_price ?? null,
      };
      const outcome: QuoteOutcome = await fetchQuote({
        isin: position.isin,
        ticker: position.ticker,
        name: position.name,
        currency: holding?.currency ?? position.currency,
        marketSymbol: holding?.market_symbol ?? null,
      });
      if (!outcome.ok) {
        return {
          ...base, status: outcome.reason, price: outcome.quote?.price ?? null, currency: outcome.quote?.currency ?? null,
          asOf: outcome.quote?.asOf ?? null, provider: outcome.quote?.provider ?? null, symbol: outcome.quote?.symbol ?? null,
          message: outcome.message,
        };
      }

      const { quote } = outcome;
      const changes: Record<string, unknown> = {
        last_price: quote.price,
        last_price_at: quote.asOf ?? new Date().toISOString(),
        market_provider: quote.provider,
        updated_at: new Date().toISOString(),
      };
      if (hasMarketSymbol) changes.market_symbol = quote.symbol;

      if (holding) {
        await supabaseRest(`holdings?id=eq.${encodeURIComponent(holding.id)}&account_id=eq.${encodeURIComponent(account.id)}`, {
          method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify(changes),
        });
      } else {
        // Position sans ligne de référentiel : on la crée pour pouvoir y rattacher un cours.
        // quantity = 0 volontairement — la quantité reste dérivée des opérations, jamais stockée.
        await supabaseRest("holdings", {
          method: "POST", headers: { prefer: "return=minimal" },
          body: JSON.stringify({
            account_id: account.id, asset_type: "other", name: position.name,
            symbol: position.ticker, isin: position.isin, quantity: 0, average_cost: null,
            currency: quote.currency, ...changes,
          }),
        });
      }

      return {
        ...base, status: base.previousPrice === quote.price ? "unchanged" : "updated",
        price: quote.price, currency: quote.currency, asOf: quote.asOf, provider: quote.provider,
        symbol: quote.symbol, message: null,
      };
    });

    const refreshed = results.filter((result) => result.status === "updated" || result.status === "unchanged").length;
    return Response.json({
      refreshed,
      failed: results.length - refreshed,
      results,
      marketSymbolStored: hasMarketSymbol,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("holdings") && message.includes("PGRST205")) {
      return Response.json({ error: "La migration des portefeuilles doit être appliquée dans Supabase.", setupRequired: true }, { status: 503 });
    }
    return authErrorResponse(error);
  }
}
