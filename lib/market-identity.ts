import { normalizeCurrency, normalizeMic, normalizeTicker, validIsinOrNull } from "./asset-catalog.ts";
import type { MarketAsset, MarketAssetType } from "./market-data.ts";

export type ClassificationStatus = "verified" | "inferred" | "needs_review";
export type MarketIdentityConfidence = "exact" | "resolved" | "ambiguous" | "unresolved";

export type ResolvedMarketIdentity = MarketAsset & {
  instrumentKey: string;
  assetId: string | null;
  listingId: string | null;
  isin: string | null;
  ticker: string | null;
  micCode: string | null;
  currency: string | null;
  providerSymbol: string | null;
  yahooSymbol: string | null;
  confidence: MarketIdentityConfidence;
  reason: string | null;
  classificationStatus: ClassificationStatus;
};

/**
 * Identités vérifiées applicativement. Elles ne remplacent pas le catalogue :
 * elles servent uniquement de garde-fou pour les cas historiques déjà connus.
 */
const VERIFIED_ISIN: Record<string, Partial<MarketAsset> & { assetType: MarketAssetType }> = {
  FR0000120073: {
    name: "Air Liquide",
    assetType: "stock",
    currency: "EUR",
    exchange: "Euronext Paris",
    micCode: "XPAR",
    providerSymbol: "AI.PA",
    yahooSymbol: "AI.PA",
    country: "FR",
  },
};

function clean(value: string | null | undefined) {
  const result = String(value ?? "").trim();
  return result || null;
}

function instrumentKey(asset: {
  listingId?: string | null;
  assetId?: string | null;
  isin?: string | null;
  ticker?: string | null;
  name?: string | null;
}) {
  if (clean(asset.listingId)) return `listing:${clean(asset.listingId)}`;
  if (clean(asset.assetId)) return `asset:${clean(asset.assetId)}`;
  if (clean(asset.isin)) return `isin:${clean(asset.isin)!.toUpperCase()}`;
  if (clean(asset.ticker)) return `tkr:${clean(asset.ticker)!.toUpperCase()}`;
  return `name:${String(asset.name ?? "").trim().toLowerCase() || "sans-actif"}`;
}

/**
 * Résolution centrale, déterministe et sans appel réseau.
 *
 * L'ordre de confiance est : listing, actif, symboles explicites, ISIN, ticker.
 * Aucun suffixe de marché n'est inventé à partir du seul MIC. Le tuple Sanofi
 * ci-dessous est volontairement strict afin de ne jamais transformer SAN (Santander
 * aux États-Unis) en Sanofi sans place et devise concordantes.
 */
export function resolveMarketIdentity(asset: MarketAsset): ResolvedMarketIdentity {
  const listingId = clean(asset.listingId);
  const assetId = clean(asset.assetId);
  const rawIsin = clean(asset.isin)?.toUpperCase() ?? null;
  const validIsin = validIsinOrNull(rawIsin);
  const ticker = normalizeTicker(asset.ticker);
  const micCode = normalizeMic(asset.micCode);
  const currency = normalizeCurrency(asset.currency);
  const providerSymbol = clean(asset.providerSymbol)?.toUpperCase() ?? null;
  const yahooSymbol = clean(asset.yahooSymbol)?.toUpperCase() ?? null;
  const classificationStatus: ClassificationStatus =
    asset.classificationStatus === "verified"
      ? "verified"
      : asset.classificationStatus === "inferred"
        ? "inferred"
        : "needs_review";

  const isStrictSanofiListing =
    ticker === "SAN"
    && micCode === "XPAR"
    && currency === "EUR"
    && (providerSymbol === "SAN.PA" || yahooSymbol === "SAN.PA");

  // L'ancien ISIN erroné est refusé par la résolution. Sa correction reste une
  // opération de données explicite, encadrée par la migration non exécutée fournie.
  if (rawIsin === "FR0001200578") {
    return {
      ...asset,
      instrumentKey: instrumentKey({ listingId, assetId, isin: rawIsin, ticker, name: asset.name }),
      assetId,
      listingId,
      isin: null,
      ticker,
      micCode,
      currency,
      providerSymbol,
      yahooSymbol,
      confidence: "ambiguous",
      reason: "known_incorrect_sanofi_isin",
      classificationStatus,
    };
  }

  if (isStrictSanofiListing && (!rawIsin || rawIsin === "FR0000120578")) {
    const isin = "FR0000120578";
    return {
      ...asset,
      name: asset.name || "Sanofi",
      instrumentKey: instrumentKey({ listingId, assetId, isin, ticker, name: asset.name }),
      assetId,
      listingId,
      isin,
      ticker,
      micCode,
      currency,
      providerSymbol: "SAN.PA",
      yahooSymbol: "SAN.PA",
      assetType: asset.assetType && asset.assetType !== "other" ? asset.assetType : "stock",
      confidence: rawIsin ? "exact" : "resolved",
      reason: rawIsin ? null : "resolved_from_exact_listing",
      classificationStatus: classificationStatus === "needs_review" ? "inferred" : classificationStatus,
    };
  }

  const known = validIsin ? VERIFIED_ISIN[validIsin] : null;
  const merged = known
    ? {
        ...known,
        ...asset,
        assetType: asset.assetType && asset.assetType !== "other" ? asset.assetType : known.assetType,
        currency: currency || known.currency || null,
        exchange: asset.exchange || known.exchange,
        micCode: micCode || known.micCode || null,
        providerSymbol: providerSymbol || known.providerSymbol || null,
        yahooSymbol: yahooSymbol || known.yahooSymbol || null,
        country: asset.country || known.country,
      }
    : asset;

  const finalProviderSymbol = clean(merged.providerSymbol)?.toUpperCase() ?? null;
  const finalYahooSymbol = clean(merged.yahooSymbol)?.toUpperCase() ?? null;
  const finalTicker = normalizeTicker(merged.ticker);
  const finalMic = normalizeMic(merged.micCode);
  const finalCurrency = normalizeCurrency(merged.currency);
  const hasExplicitIdentity = Boolean(listingId || assetId || finalProviderSymbol || finalYahooSymbol);
  const hasQualifiedTicker = Boolean(finalTicker && finalMic && finalCurrency);
  const confidence: MarketIdentityConfidence = hasExplicitIdentity || validIsin
    ? "exact"
    : hasQualifiedTicker
      ? "resolved"
      : finalTicker
        ? "ambiguous"
        : "unresolved";

  return {
    ...merged,
    instrumentKey: instrumentKey({ listingId, assetId, isin: validIsin, ticker: finalTicker, name: asset.name }),
    assetId,
    listingId,
    isin: validIsin,
    ticker: finalTicker,
    micCode: finalMic,
    currency: finalCurrency,
    providerSymbol: finalProviderSymbol,
    yahooSymbol: finalYahooSymbol,
    confidence,
    reason: rawIsin && !validIsin
      ? "invalid_isin"
      : confidence === "ambiguous"
        ? "ticker_requires_market"
        : confidence === "unresolved"
          ? "missing_market_identity"
          : known
            ? "resolved_from_verified_isin"
            : null,
    classificationStatus: known && classificationStatus === "needs_review" ? "inferred" : classificationStatus,
  };
}

export function isClassified(asset: MarketAsset) {
  return resolveMarketIdentity(asset).assetType !== "other";
}
