import type { MarketAsset, MarketAssetType } from "./market-data";

export type ClassificationStatus = "verified" | "inferred" | "needs_review";

/**
 * Les correspondances ci-dessous sont des identités ISIN vérifiées, jamais une inférence
 * depuis le seul nom. Les corrections administrateur (`verified`) restent prioritaires.
 */
const VERIFIED_ISIN: Record<string, Partial<MarketAsset> & { assetType: MarketAssetType }> = {
  FR0000120073: {
    name: "Air Liquide", assetType: "stock", currency: "EUR", exchange: "Euronext Paris", micCode: "XPAR",
    providerSymbol: "AI.PA", yahooSymbol: "AI.PA", country: "FR",
  },
};

function cleanIsin(value: string | null | undefined) { return String(value ?? "").trim().toUpperCase(); }

export function resolveMarketIdentity(asset: MarketAsset): MarketAsset & { classificationStatus: ClassificationStatus } {
  const status = asset.classificationStatus === "verified" ? "verified" : asset.classificationStatus === "inferred" ? "inferred" : "needs_review";
  // Une association admin est immuable par les synchronisations automatiques.
  if (status === "verified") return { ...asset, classificationStatus: status };
  const known = VERIFIED_ISIN[cleanIsin(asset.isin)];
  if (known) {
    return {
      ...known,
      ...asset,
      assetType: asset.assetType && asset.assetType !== "other" ? asset.assetType : known.assetType,
      currency: asset.currency || known.currency,
      exchange: asset.exchange || known.exchange,
      micCode: asset.micCode || known.micCode,
      providerSymbol: asset.providerSymbol || known.providerSymbol,
      yahooSymbol: asset.yahooSymbol || known.yahooSymbol,
      country: asset.country || known.country,
      classificationStatus: "inferred",
    };
  }
  if (asset.assetType && asset.assetType !== "other") return { ...asset, classificationStatus: "inferred" };
  return { ...asset, classificationStatus: "needs_review" };
}

export function isClassified(asset: MarketAsset) { return resolveMarketIdentity(asset).assetType !== "other"; }
