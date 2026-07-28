// Construction SERVEUR de l'objet déterministe envoyé à l'analyse IA.
//
// Le modèle ne voit jamais une opération brute. Il voit ce fichier : des agrégats déjà calculés
// par les moteurs existants (`computeAccountModel`, `computeExposureModel`, `computeDividendModel`,
// `computePerformanceModel`), donc déjà vérifiés et testés. C'est la seule façon de garantir que
// chaque chiffre cité dans l'analyse est un chiffre que l'application sait justifier ligne à ligne.
//
// Ce module ne recalcule RIEN par lui-même et n'introduit aucune règle métier nouvelle : il
// assemble. Toute divergence entre l'analyse et l'écran serait donc un bug d'assemblage, pas une
// seconde vérité.

import { computeAccountModel, type AccountModel, type AccountOperation, type InstrumentPrice } from "./portfolio-account.ts";
import { buildPriceIndex } from "./instrument-alias.ts";
import { computeExposureModel, UNKNOWN_CODE, type ExposureModel, type InstrumentExposure } from "./portfolio-exposure.ts";
import { computeDividendModel, next12mWindow, type DividendModel } from "./dividend-engine.ts";
import { loadDividendContext } from "./dividend-server.ts";
import { computePerformanceModel, rankPositions, type PerformanceModel } from "./portfolio-performance.ts";
import { MINIMUM_COVERAGE_PERCENT, type PortfolioFacts } from "./portfolio-insights.ts";
import { getLatestFxRate, type FxRateRow } from "./fx-rates.ts";
import { loadPortfolioFxRates } from "./fx-rates-server.ts";
import { supabaseRest } from "./supabase-rest.ts";

type HoldingRow = {
  id: string; account_id: string; asset_type: string | null; name: string | null; symbol: string | null; isin: string | null;
  last_price: number | null; last_price_at: string | null; currency: string;
  provider_symbol?: string | null; yahoo_symbol?: string | null; exchange?: string | null; mic_code?: string | null;
  data_provider?: string | null; quote_mode?: string | null; country?: string | null;
};
type QuoteRow = { asset_id: string; provider: string; provider_symbol: string; price: number; currency: string; quoted_at: string; fetched_at: string };
type OperationRow = {
  id: string; account_id: string; member_id: string; type: AccountOperation["type"]; operation_date: string;
  asset_name: string | null; ticker: string | null; isin: string | null; quantity: number | null; unit_price: number | null;
  gross_amount: number | null; fees: number | null; net_amount: number | null; currency: string; source: string | null;
  note: string | null; exchange_rate: number | null;
};
type ExposureRow = {
  instrument_isin: string | null; asset_id: string | null; dimension: string; exposure_code: string; exposure_label: string;
  weight_percent: number; source: string; source_as_of: string | null; confidence: string; is_estimated: boolean;
};
export type AccountContext = {
  account: { id: string; name: string; accountType: "PEA" | "CTO"; currency: string; memberId: string; dividendTaxRate: number | null };
  operations: AccountOperation[];
  model: AccountModel;
  geography: ExposureModel;
  sectors: ExposureModel;
  income: DividendModel;
  performance: PerformanceModel;
  /** Instruments détenus n'ayant pu être appariés à aucune ligne de référence de prix. */
  unmatchedInstruments: string[];
};

function asOperation(row: OperationRow): AccountOperation {
  return {
    id: row.id, accountId: row.account_id, memberId: row.member_id, type: row.type, date: row.operation_date,
    assetName: row.asset_name, ticker: row.ticker, isin: row.isin,
    quantity: row.quantity === null ? null : Number(row.quantity),
    unitPrice: row.unit_price === null ? null : Number(row.unit_price),
    grossAmount: row.gross_amount === null ? null : Number(row.gross_amount),
    fees: row.fees === null ? null : Number(row.fees),
    netAmount: row.net_amount === null ? null : Number(row.net_amount),
    currency: row.currency, source: row.source, note: row.note,
    exchangeRate: row.exchange_rate === null ? null : Number(row.exchange_rate),
  };
}

/** Une table optionnelle absente (migration non jouée) ne casse jamais l'analyse : elle la réduit. */
async function optional<T>(query: string): Promise<T[]> {
  try {
    return (await supabaseRest<T[]>(query)) ?? [];
  } catch {
    return [];
  }
}

async function loadAccountRow(accountId: string) {
  const select = "id,name,account_type,currency,member_id,dividend_tax_rate";
  try {
    const rows = await supabaseRest<Array<{ id: string; name: string; account_type: string; currency: string; member_id: string; dividend_tax_rate: number | null }>>(
      `financial_accounts?select=${select}&id=eq.${encodeURIComponent(accountId)}&limit=1`,
    );
    return rows[0] ?? null;
  } catch (error) {
    // La colonne de fiscalité n'existe pas encore : le compte reste lisible, le taux est « non
    // paramétré » et l'hypothèse PFU est annoncée comme telle.
    const message = error instanceof Error ? error.message : "";
    if (!/dividend_tax_rate|42703|PGRST204/.test(message)) throw error;
    const rows = await supabaseRest<Array<{ id: string; name: string; account_type: string; currency: string; member_id: string }>>(
      `financial_accounts?select=id,name,account_type,currency,member_id&id=eq.${encodeURIComponent(accountId)}&limit=1`,
    );
    return rows[0] ? { ...rows[0], dividend_tax_rate: null } : null;
  }
}

async function loadHoldings(accountId: string): Promise<HoldingRow[]> {
  const full = "id,account_id,asset_type,name,symbol,isin,last_price,last_price_at,currency,provider_symbol,yahoo_symbol,exchange,mic_code,data_provider,quote_mode,country";
  try {
    return await supabaseRest<HoldingRow[]>(`holdings?select=${full}&account_id=eq.${encodeURIComponent(accountId)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!/provider_symbol|yahoo_symbol|mic_code|data_provider|quote_mode|country|42703|PGRST20[0-9]/.test(message)) throw error;
    return await supabaseRest<HoldingRow[]>(`holdings?select=id,account_id,asset_type,name,symbol,isin,last_price,last_price_at,currency&account_id=eq.${encodeURIComponent(accountId)}`);
  }
}

/**
 * Charge et assemble tout ce qui décrit un compte. C'est le pendant serveur de ce que le shell
 * calcule côté navigateur — mêmes fonctions, mêmes règles, même appariement par alias.
 */
export async function loadAccountContext(accountId: string, today = new Date().toISOString().slice(0, 10)): Promise<AccountContext | null> {
  const accountRow = await loadAccountRow(accountId);
  if (!accountRow || (accountRow.account_type !== "pea" && accountRow.account_type !== "securities")) return null;
  const accountType: "PEA" | "CTO" = accountRow.account_type === "pea" ? "PEA" : "CTO";
  const referenceCurrency = (accountRow.currency || "EUR").toUpperCase();

  const [operationRows, holdingRows] = await Promise.all([
    supabaseRest<OperationRow[]>(`account_operations?select=id,account_id,member_id,type,operation_date,asset_name,ticker,isin,quantity,unit_price,gross_amount,fees,net_amount,currency,source,note,exchange_rate&account_id=eq.${encodeURIComponent(accountId)}&order=operation_date.asc`),
    loadHoldings(accountId),
  ]);
  const operations = operationRows.map(asOperation);

  const quoteRows = holdingRows.length
    ? await optional<QuoteRow>(`market_quotes?select=asset_id,provider,provider_symbol,price,currency,quoted_at,fetched_at&asset_id=in.(${holdingRows.map((holding) => holding.id).join(",")})&order=fetched_at.desc`)
    : [];
  const latestQuote = new Map<string, QuoteRow>();
  for (const quote of quoteRows) if (!latestQuote.has(quote.asset_id)) latestQuote.set(quote.asset_id, quote);

  const currencies = new Set<string>([referenceCurrency]);
  for (const holding of holdingRows) currencies.add((latestQuote.get(holding.id)?.currency ?? holding.currency ?? "EUR").toUpperCase());
  for (const operation of operations) currencies.add((operation.currency ?? "EUR").toUpperCase());
  const fxRows: FxRateRow[] = await loadPortfolioFxRates([...currencies]).catch(() => [] as FxRateRow[]);
  const fxRateAt = (currency: string, date: string) =>
    getLatestFxRate(currency, referenceCurrency, fxRows, { asOf: date, fallbackToEarliest: true })?.rate ?? null;

  // Appariement par alias : c'est ce qui rattache une opération sans ISIN à sa ligne de référence.
  const index = buildPriceIndex(
    holdingRows,
    (holding) => ({ isin: holding.isin, symbol: holding.symbol, name: holding.name }),
    operations,
  );
  const priceByKey = new Map<string, InstrumentPrice>();
  for (const [key, holding] of index.byKey) {
    const quote = latestQuote.get(holding.id) ?? null;
    const usableQuote = quote && Number(quote.price) > 0 && (!holding.currency || quote.currency.toUpperCase() === holding.currency.toUpperCase()) ? quote : null;
    const price = usableQuote ? Number(usableQuote.price) : holding.last_price === null ? null : Number(holding.last_price);
    const nativeCurrency = (usableQuote?.currency ?? holding.currency ?? referenceCurrency).toUpperCase();
    priceByKey.set(key, {
      lastPrice: price !== null && Number.isFinite(price) && price > 0 ? price : null,
      lastPriceAt: usableQuote?.quoted_at ?? holding.last_price_at ?? null,
      assetType: holding.asset_type ?? null,
      name: holding.name ?? null,
      assetId: holding.id,
      providerSymbol: holding.provider_symbol ?? null,
      yahooSymbol: holding.yahoo_symbol ?? null,
      exchange: holding.exchange ?? null,
      micCode: holding.mic_code ?? null,
      dataProvider: usableQuote?.provider ?? holding.data_provider ?? null,
      country: holding.country ?? null,
      fetchedAt: usableQuote?.fetched_at ?? null,
      fxRateToReference: getLatestFxRate(nativeCurrency, referenceCurrency, fxRows)?.rate ?? null,
      referenceCurrency,
    });
  }

  const model = computeAccountModel({ operations, priceByKey, accountType, today, referenceCurrency, fxRateAt });

  const isins = [...new Set(model.positions.map((position) => position.isin?.trim().toUpperCase()).filter((isin): isin is string => /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(isin ?? "")))];
  const exposureRows = isins.length
    ? await optional<ExposureRow>(`instrument_exposures?select=instrument_isin,asset_id,dimension,exposure_code,exposure_label,weight_percent,source,source_as_of,confidence,is_estimated&instrument_isin=in.(${isins.join(",")})`)
    : [];
  const exposures: InstrumentExposure[] = exposureRows.map((row) => ({
    isin: row.instrument_isin,
    instrumentKey: null,
    dimension: row.dimension === "sector" ? "sector" : "geography",
    code: row.exposure_code,
    label: row.exposure_label,
    weightPercent: Number(row.weight_percent),
    source: row.source,
    sourceAsOf: row.source_as_of,
    confidence: row.confidence === "high" || row.confidence === "low" ? row.confidence : "medium",
    isEstimated: Boolean(row.is_estimated),
  }));

  // Dividendes : MÊME moteur que l'écran (lib/dividend-engine.ts), alimenté par le MÊME
  // chargement (lib/dividend-server.ts). Recalculer ici avec une autre source produirait une
  // analyse citant des chiffres que l'écran ne sait pas justifier.
  const dividendContext = await loadDividendContext([accountId], today);
  const income = computeDividendModel({
    operations,
    positions: model.positions,
    events: dividendContext?.events ?? [],
    instruments: dividendContext?.instruments ?? [],
    accountType,
    today,
    referenceCurrency,
    fxRateAt,
    taxProfile: dividendContext?.taxProfile ?? null,
    window: next12mWindow(today),
    positionsValueReference: model.positionsValueEur,
    investedReference: model.investedInAssetsEur,
  });

  const toReference = (operation: AccountOperation, amount: number): number | null => {
    const currency = (operation.currency || referenceCurrency).toUpperCase();
    if (currency === referenceCurrency) return amount;
    const recorded = Number(operation.exchangeRate);
    if (Number.isFinite(recorded) && recorded > 0) return amount * recorded;
    const resolved = fxRateAt(currency, operation.date);
    return resolved !== null ? amount * resolved : null;
  };
  const cashDeltaOf = (operation: AccountOperation): number => {
    const gross = operation.grossAmount !== null && operation.grossAmount !== undefined
      ? Math.abs(Number(operation.grossAmount))
      : Math.abs(Number(operation.quantity ?? 0) * Number(operation.unitPrice ?? 0));
    const fees = Math.abs(Number(operation.fees ?? 0));
    const magnitude = operation.netAmount !== null && operation.netAmount !== undefined
      ? Math.abs(Number(operation.netAmount))
      : operation.type === "achat" ? gross + fees : operation.type === "vente" ? Math.max(0, gross - fees) : gross;
    const converted = toReference(operation, magnitude) ?? 0;
    if (operation.type === "versement" || operation.type === "vente" || operation.type === "dividende") return converted;
    if (operation.type === "achat" || operation.type === "retrait" || operation.type === "frais") return -converted;
    return 0;
  };

  const performance = computePerformanceModel({
    model,
    operations,
    today,
    toReference,
    cashDeltaOf,
    valuations: model.timeline.map((point) => ({ date: `${point.monthKey}-28`, valueEur: point.valueEur })),
  });

  return {
    account: {
      id: accountRow.id,
      name: accountRow.name,
      accountType,
      currency: referenceCurrency,
      memberId: accountRow.member_id,
      dividendTaxRate: accountRow.dividend_tax_rate === null || accountRow.dividend_tax_rate === undefined ? null : Number(accountRow.dividend_tax_rate),
    },
    operations,
    model,
    geography: computeExposureModel({ positions: model.positions, exposures, dimension: "geography" }),
    sectors: computeExposureModel({ positions: model.positions, exposures, dimension: "sector" }),
    income,
    performance,
    unmatchedInstruments: index.unmatched.map((identity) => identity.name ?? identity.ticker ?? identity.isin ?? identity.key),
  };
}

function topBucket(model: ExposureModel) {
  return model.buckets.find((bucket) => bucket.code !== UNKNOWN_CODE) ?? null;
}

/** Projette le contexte en objet déterministe — la SEULE chose que le modèle reçoit. */
export function buildPortfolioFacts(context: AccountContext, generatedAt: string): PortfolioFacts {
  const { model, performance, geography, sectors, income } = context;
  const valued = model.positions.filter((position) => position.currentValueEur !== null).sort((a, b) => (b.currentValueEur ?? 0) - (a.currentValueEur ?? 0));
  const total = valued.reduce((sum, position) => sum + (position.currentValueEur ?? 0), 0);
  const share = (count: number) => (total > 0 ? Number(((valued.slice(0, count).reduce((sum, position) => sum + (position.currentValueEur ?? 0), 0) / total) * 100).toFixed(2)) : null);
  const ranking = rankPositions(model.positions, "contribution", 3);
  const round = (value: number | null, digits = 2) => (value === null || !Number.isFinite(value) ? null : Number(value.toFixed(digits)));

  const costBasisPositions = model.positions.filter((position) => position.investedEur > 0).length;
  const coveragePercent = model.valuationCoverage.coveragePercent;

  const anomalies: string[] = [];
  if (model.cashEur < -1) anomalies.push("Trésorerie négative : des versements ou transferts entrants manquent.");
  if (model.netInvestedEur <= 0 && model.positions.length > 0) anomalies.push("Aucun versement enregistré alors que des positions existent.");
  if (model.valuationCoverage.unvaluedPositions > 0) anomalies.push(`${model.valuationCoverage.unvaluedPositions} position(s) sans cours.`);
  if (context.unmatchedInstruments.length > 0) anomalies.push(`${context.unmatchedInstruments.length} instrument(s) sans ligne de référence de prix.`);
  if (model.hasUnconvertedCash) anomalies.push("Des montants en devise n'ont pas pu être convertis.");

  return {
    generatedAt,
    accountType: context.account.accountType,
    accountLabel: context.account.name,
    referenceCurrency: context.account.currency,
    totalValueEur: round(model.totalValueEur),
    positionsValueEur: round(model.positionsValueEur),
    cashEur: round(model.cashEur) ?? 0,
    netInvestedEur: round(model.netInvestedEur) ?? 0,
    positionsCount: model.positions.length,
    performance: {
      unrealizedGainEur: round(performance.unrealizedGainEur),
      unrealizedGainPct: round(performance.unrealizedGainPct),
      realizedGainEur: round(performance.realizedGainEur) ?? 0,
      dividendsNetEur: round(performance.dividendsNetEur) ?? 0,
      feesEur: round(performance.feesEur) ?? 0,
      totalReturnEur: round(performance.totalReturnEur),
      totalReturnPct: round(performance.totalReturnPct),
      annualizedPct: round(performance.annualizedPct),
      twrPct: round(performance.twrPct),
      xirrPct: round(performance.xirrPct),
      isReliable: performance.isReliable,
      unreliableReason: performance.unreliableReason,
    },
    coverage: {
      pricedPositions: model.valuationCoverage.valuedPositions,
      totalPositions: model.valuationCoverage.totalPositions,
      pricePercent: round(coveragePercent, 1) ?? 0,
      geographyPercent: round(geography.coverage.coveragePercent, 1) ?? 0,
      sectorPercent: round(sectors.coverage.coveragePercent, 1) ?? 0,
      dividendPercent: round(income.coverage.coveragePercent, 1) ?? 0,
      costBasisPercent: round(model.positions.length ? (costBasisPositions / model.positions.length) * 100 : 100, 1) ?? 0,
      sufficient: coveragePercent >= MINIMUM_COVERAGE_PERCENT && geography.unknownPct < 50,
    },
    concentration: { top1Pct: share(1), top3Pct: share(3), top5Pct: share(5) },
    best: ranking.best.map((item) => ({ name: item.name, gainPct: round(item.gainPct), gainEur: round(item.gainEur), valueEur: round(item.valueEur) })),
    worst: ranking.worst.map((item) => ({ name: item.name, gainPct: round(item.gainPct), gainEur: round(item.gainEur), valueEur: round(item.valueEur) })),
    geography: geography.buckets.map((bucket) => ({ label: bucket.label, pct: round(bucket.pct, 1) ?? 0, isEstimated: bucket.isEstimated })),
    sectors: sectors.buckets.map((bucket) => ({ label: bucket.label, pct: round(bucket.pct, 1) ?? 0, isEstimated: bucket.isEstimated })),
    dividends: {
      receivedThisYearEur: round(income.receivedThisYearReference) ?? 0,
      expected12mEur: round(income.expectedReference) ?? 0,
      portfolioYieldPct: round(income.forwardYieldPct),
      topContributorName: income.contributors[0]?.name ?? null,
      topContributorPct: round(income.contributors[0]?.pct ?? null, 1),
      monthsWithoutIncome: income.monthly.filter((point) => point.totalReference <= 0).length,
      hasRealOperations: income.hasRealDividendOperations,
    },
    benchmark: null,
    anomalies,
  };
}

export { topBucket };
