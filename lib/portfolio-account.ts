// Moteur de portefeuille « comptes financiers » — SOURCE DE VÉRITÉ UNIQUE pour les écrans
// PEA (et, plus tard, Compte-titres : le moteur est générique `accountType: "PEA" | "CTO"`).
//
// Principe (Étape 3-4 du cahier des charges) : une position n'est JAMAIS saisie directement,
// elle est DÉRIVÉE des opérations (achat / vente / versement / retrait / dividende / frais /
// correction). Aucune donnée fictive : si une valeur n'est pas calculable (pas de cours, pas
// d'opération), on renvoie `null` / 0 et l'UI l'affiche honnêtement.
//
// Le cours actuel de chaque instrument provient du snapshot `holdings` (colonne `last_price`,
// déjà entretenue par l'admin via Alpha Vantage) : on l'utilise UNIQUEMENT comme référentiel
// de prix + classe d'actif, jamais comme quantité (la quantité vient des opérations).

export type AccountType = "PEA" | "CTO";

export type AccountOperationType =
  | "achat"
  | "vente"
  | "versement"
  | "retrait"
  | "dividende"
  | "frais"
  | "correction";

export type AccountOperation = {
  id: string;
  accountId: string;
  memberId?: string | null;
  memberName?: string | null;
  accountName?: string | null;
  type: AccountOperationType;
  date: string; // ISO yyyy-mm-dd
  assetName: string | null;
  ticker: string | null;
  isin: string | null;
  quantity: number | null;
  unitPrice: number | null;
  grossAmount: number | null;
  fees: number | null;
  netAmount: number | null;
  currency: string;
  source: string | null;
  note: string | null;
};

// Référentiel de prix (issu de `holdings`), indexé par clé d'instrument normalisée.
export type InstrumentPrice = {
  lastPrice: number | null;
  lastPriceAt: string | null;
  assetType: string | null; // 'stock' | 'etf' | 'fund' | 'bond' | 'crypto' | 'cash' | 'other'
  name: string | null;
};

export type AssetClass = "etf" | "action" | "obligation" | "fonds" | "autre";

export type PortfolioPosition = {
  key: string;
  name: string;
  ticker: string | null;
  isin: string | null;
  assetClass: AssetClass;
  quantity: number;
  averageCost: number | null; // prix de revient unitaire moyen pondéré (CUMP/PMP)
  investedEur: number; // prix de revient de la quantité encore détenue
  lastPrice: number | null;
  currentValueEur: number | null; // null si aucun cours disponible
  gainEur: number | null;
  gainPct: number | null;
  weightPct: number;
};

export type AssetAllocationBucket = { key: string; label: string; color: string; valueEur: number; pct: number; count: number };

export type MonthlyInvestment = {
  investedThisMonth: number; // Σ versements du mois courant
  monthLabel: string;
  status: "à_investir" | "partiellement_investi" | "investi" | "reporté";
};

export type AccountModel = {
  accountType: AccountType;
  hasOperations: boolean;
  startDate: string | null;

  // Trésorerie & versements
  netInvestedEur: number; // versements − retraits (argent apporté, cf. Étape 4)
  cashEur: number; // espèces disponibles
  dividendsNetEur: number;
  dividendsGrossEur: number;
  feesEur: number;

  // Positions
  positions: PortfolioPosition[];
  positionsValueEur: number | null; // Σ valeur des positions valorisées (null si aucune)
  investedInAssetsEur: number; // prix de revient des positions détenues
  averageBookPrice: number | null; // prix de revient moyen par part (Σ coût ÷ Σ quantité)
  pricedPositions: number;
  unpricedPositions: number;

  // Totaux & performance
  totalValueEur: number | null; // positions valorisées + espèces
  unrealizedGainEur: number | null; // +/- value latente des positions
  unrealizedGainPct: number | null;
  performanceEur: number | null; // valeur totale − montant net investi (depuis l'origine)
  performancePct: number | null;

  allocation: AssetAllocationBucket[]; // ETF / Actions / … / Espèces
  monthly: MonthlyInvestment;
  timeline: AccountTimelinePoint[];
};

export type AccountTimelinePoint = { monthKey: string; label: string; investedEur: number; valueEur: number };

// Couleurs alignées sur la charte (accueil / Bitcoin) : ETF bleu, actions vert, espèces jaune.
export const ASSET_CLASS_META: Record<AssetClass, { label: string; color: string }> = {
  etf: { label: "ETF", color: "#5a9bd4" },
  action: { label: "Actions", color: "#1d706b" },
  obligation: { label: "Obligations", color: "#9b7fd4" },
  fonds: { label: "Fonds", color: "#3aa17e" },
  autre: { label: "Autres", color: "#94a3ab" },
};
const CASH_COLOR = "#f0a63a";

const EPS = 1e-9;

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Clé d'instrument : ISIN prioritaire (identifiant stable), sinon ticker, sinon nom.
export function instrumentKey(op: { isin: string | null; ticker: string | null; assetName: string | null }): string {
  const isin = (op.isin ?? "").trim().toUpperCase();
  if (isin) return `isin:${isin}`;
  const ticker = (op.ticker ?? "").trim().toUpperCase();
  if (ticker) return `tkr:${ticker}`;
  const name = (op.assetName ?? "").trim().toLowerCase();
  return name ? `name:${name}` : "sans-actif";
}

export function priceKeyOf(holding: { isin: string | null; symbol: string | null; name: string | null }): string {
  return instrumentKey({ isin: holding.isin, ticker: holding.symbol, assetName: holding.name });
}

function assetClassOf(assetType: string | null): AssetClass {
  switch ((assetType ?? "").toLowerCase()) {
    case "etf":
      return "etf";
    case "stock":
      return "action";
    case "bond":
      return "obligation";
    case "fund":
      return "fonds";
    default:
      return "autre";
  }
}

// Montant net (mouvement de trésorerie réel) d'une opération, en repli si non renseigné.
// Convention : + = entrée d'espèces, calculé positif ici puis signé par `cashDelta`.
function magnitude(op: AccountOperation): number {
  if (op.netAmount !== null && op.netAmount !== undefined && Number.isFinite(op.netAmount)) return Math.abs(num(op.netAmount));
  const gross = op.grossAmount !== null && op.grossAmount !== undefined && Number.isFinite(op.grossAmount)
    ? Math.abs(num(op.grossAmount))
    : Math.abs(num(op.quantity) * num(op.unitPrice));
  const fees = Math.abs(num(op.fees));
  if (op.type === "achat") return gross + fees; // l'achat consomme brut + frais
  if (op.type === "vente") return Math.max(0, gross - fees); // la vente rapporte brut − frais
  return gross; // versement / retrait / dividende / frais / correction
}

// Effet sur la trésorerie (espèces) : + entrée, − sortie.
function cashDelta(op: AccountOperation): number {
  const m = magnitude(op);
  switch (op.type) {
    case "versement":
    case "vente":
    case "dividende":
      return m;
    case "achat":
    case "retrait":
    case "frais":
      return -m;
    default:
      return 0; // correction : neutre sur les espèces
  }
}

// Coût d'un achat porté au prix de revient (frais inclus, comme pour un PEA réel).
function buyCost(op: AccountOperation): number {
  const gross = op.grossAmount !== null && op.grossAmount !== undefined && Number.isFinite(op.grossAmount)
    ? Math.abs(num(op.grossAmount))
    : Math.abs(num(op.quantity) * num(op.unitPrice));
  return gross + Math.abs(num(op.fees));
}

/**
 * Construit le modèle de compte à partir des opérations RÉELLES et d'un référentiel de cours.
 * Méthode de prix de revient : moyenne pondérée mobile (CUMP/PMP), cohérente avec le calcul
 * du « prix moyen » Bitcoin déjà présent dans l'app (montant investi ÷ quantité).
 */
export function computeAccountModel(params: {
  operations: AccountOperation[];
  priceByKey: Map<string, InstrumentPrice>;
  accountType: AccountType;
  today?: string; // injectable pour les tests
}): AccountModel {
  const { operations, priceByKey, accountType } = params;
  const today = params.today ?? new Date().toISOString().slice(0, 10);
  const ops = [...operations].sort((a, b) => a.date.localeCompare(b.date));

  // ---- Trésorerie, versements, dividendes, frais ----
  let netInvested = 0;
  let cash = 0;
  let dividendsNet = 0;
  let dividendsGross = 0;
  let feesTotal = 0;
  for (const op of ops) {
    cash += cashDelta(op);
    if (op.type === "versement") netInvested += magnitude(op);
    else if (op.type === "retrait") netInvested -= magnitude(op);
    else if (op.type === "dividende") {
      dividendsNet += magnitude(op);
      dividendsGross += op.grossAmount !== null && op.grossAmount !== undefined ? Math.abs(num(op.grossAmount)) : magnitude(op);
    } else if (op.type === "frais") feesTotal += magnitude(op);
    feesTotal += Math.abs(num(op.fees)); // frais embarqués dans achats/ventes
  }

  // ---- Positions dérivées (CUMP/PMP) ----
  type Acc = { name: string; ticker: string | null; isin: string | null; qty: number; cost: number };
  const byKey = new Map<string, Acc>();
  const getAcc = (op: AccountOperation): Acc => {
    const key = instrumentKey(op);
    let acc = byKey.get(key);
    if (!acc) {
      acc = { name: (op.assetName ?? "").trim() || "Actif sans nom", ticker: op.ticker, isin: op.isin, qty: 0, cost: 0 };
      byKey.set(key, acc);
    }
    if (!acc.name || acc.name === "Actif sans nom") acc.name = (op.assetName ?? acc.name).trim() || acc.name;
    if (!acc.ticker && op.ticker) acc.ticker = op.ticker;
    if (!acc.isin && op.isin) acc.isin = op.isin;
    return acc;
  };

  for (const op of ops) {
    if (op.type === "achat") {
      const acc = getAcc(op);
      acc.qty += num(op.quantity);
      acc.cost += buyCost(op);
    } else if (op.type === "vente") {
      const acc = getAcc(op);
      const avg = acc.qty > EPS ? acc.cost / acc.qty : 0;
      const soldQty = Math.min(num(op.quantity), acc.qty);
      acc.qty -= num(op.quantity);
      acc.cost -= avg * soldQty; // on retire le coût moyen de la quantité vendue (plus/moins-value réalisée ignorée ici)
      if (acc.qty < EPS) {
        acc.qty = 0;
        acc.cost = 0;
      }
    } else if (op.type === "correction") {
      const acc = getAcc(op);
      const q = num(op.quantity); // quantité signée
      acc.qty += q;
      if (q > 0) acc.cost += buyCost(op); // une correction positive avec valeur ajuste le coût
      else if (acc.qty > EPS) acc.cost = (acc.cost / (acc.qty - q)) * acc.qty; // proportionnel
      if (acc.qty < EPS) {
        acc.qty = 0;
        acc.cost = 0;
      }
    }
  }

  const rawPositions = [...byKey.entries()]
    .map(([key, acc]) => {
      const price = priceByKey.get(key) ?? null;
      const lastPrice = price && price.lastPrice !== null && Number.isFinite(price.lastPrice) ? Number(price.lastPrice) : null;
      const currentValueEur = lastPrice !== null ? acc.qty * lastPrice : null;
      const gainEur = currentValueEur === null ? null : currentValueEur - acc.cost;
      const gainPct = gainEur === null || acc.cost <= EPS ? null : (gainEur / acc.cost) * 100;
      return {
        key,
        name: price?.name?.trim() || acc.name,
        ticker: acc.ticker,
        isin: acc.isin,
        assetClass: assetClassOf(price?.assetType ?? null),
        quantity: acc.qty,
        averageCost: acc.qty > EPS ? acc.cost / acc.qty : null,
        investedEur: acc.cost,
        lastPrice,
        currentValueEur,
        gainEur,
        gainPct,
        weightPct: 0,
      } satisfies PortfolioPosition;
    })
    .filter((position) => position.quantity > EPS);

  const positionsValueEur = rawPositions.some((position) => position.currentValueEur !== null)
    ? rawPositions.reduce((sum, position) => sum + (position.currentValueEur ?? 0), 0)
    : null;
  const investedInAssetsEur = rawPositions.reduce((sum, position) => sum + position.investedEur, 0);
  const totalQty = rawPositions.reduce((sum, position) => sum + position.quantity, 0);

  const positions = rawPositions
    .map((position) => ({
      ...position,
      weightPct: positionsValueEur && positionsValueEur > 0 && position.currentValueEur !== null
        ? (position.currentValueEur / positionsValueEur) * 100
        : 0,
    }))
    .sort((a, b) => (b.currentValueEur ?? -1) - (a.currentValueEur ?? -1) || b.investedEur - a.investedEur);

  const totalValueEur = positionsValueEur === null && Math.abs(cash) < EPS ? null : (positionsValueEur ?? 0) + cash;
  const unrealizedGainEur = positionsValueEur === null ? null : positionsValueEur - investedInAssetsEur;
  const unrealizedGainPct = unrealizedGainEur === null || investedInAssetsEur <= EPS ? null : (unrealizedGainEur / investedInAssetsEur) * 100;
  const performanceEur = totalValueEur === null ? null : totalValueEur - netInvested;
  const performancePct = performanceEur === null || netInvested <= EPS ? null : (performanceEur / netInvested) * 100;

  // ---- Répartition par type d'actif (+ espèces) ----
  const allocationTotal = (positionsValueEur ?? 0) + Math.max(0, cash);
  const classSums = new Map<AssetClass, { value: number; count: number }>();
  for (const position of positions) {
    if (position.currentValueEur === null) continue;
    const entry = classSums.get(position.assetClass) ?? { value: 0, count: 0 };
    entry.value += position.currentValueEur;
    entry.count += 1;
    classSums.set(position.assetClass, entry);
  }
  const allocation: AssetAllocationBucket[] = [...classSums.entries()]
    .map(([cls, entry]) => ({
      key: cls,
      label: ASSET_CLASS_META[cls].label,
      color: ASSET_CLASS_META[cls].color,
      valueEur: entry.value,
      pct: allocationTotal > 0 ? (entry.value / allocationTotal) * 100 : 0,
      count: entry.count,
    }))
    .sort((a, b) => b.valueEur - a.valueEur);
  if (cash > EPS) {
    allocation.push({ key: "cash", label: "Espèces", color: CASH_COLOR, valueEur: cash, pct: allocationTotal > 0 ? (cash / allocationTotal) * 100 : 0, count: 1 });
  }

  // ---- Investissement régulier (mois courant) ----
  const monthKey = today.slice(0, 7);
  const investedThisMonth = ops
    .filter((op) => op.type === "versement" && op.date.slice(0, 7) === monthKey)
    .reduce((sum, op) => sum + magnitude(op), 0);
  const monthLabel = monthLabelFr(monthKey);
  const monthly: MonthlyInvestment = {
    investedThisMonth,
    monthLabel,
    status: investedThisMonth > 0 ? "investi" : "à_investir",
  };

  return {
    accountType,
    hasOperations: ops.length > 0,
    startDate: ops[0]?.date ?? null,
    netInvestedEur: netInvested,
    cashEur: cash,
    dividendsNetEur: dividendsNet,
    dividendsGrossEur: dividendsGross,
    feesEur: feesTotal,
    positions,
    positionsValueEur,
    investedInAssetsEur,
    averageBookPrice: totalQty > EPS ? investedInAssetsEur / totalQty : null,
    pricedPositions: positions.filter((position) => position.currentValueEur !== null).length,
    unpricedPositions: positions.filter((position) => position.currentValueEur === null).length,
    totalValueEur,
    unrealizedGainEur,
    unrealizedGainPct,
    performanceEur,
    performancePct,
    allocation,
    monthly,
    timeline: buildAccountTimeline(ops, priceByKey, today),
  };
}

const MONTHS_SHORT = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
function monthLabelFr(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);
  return `${MONTHS_SHORT[(month || 1) - 1]} ${year}`;
}

// Évolution de la valeur : reconstruite à partir des opérations réelles uniquement.
// Le cours de chaque mois est le dernier prix connu (prix d'achat des opérations), le mois
// courant utilisant le cours de référence `holdings`. Aucune donnée fictive ; on ne trace
// que les mois réellement couverts par des opérations.
function buildAccountTimeline(ops: AccountOperation[], priceByKey: Map<string, InstrumentPrice>, today: string): AccountTimelinePoint[] {
  const dated = ops.filter((op) => /^\d{4}-\d{2}-\d{2}$/.test(op.date));
  if (dated.length === 0) return [];
  const first = dated[0].date.slice(0, 7);
  const last = (dated[dated.length - 1].date > today ? dated[dated.length - 1].date : today).slice(0, 7);

  const months: string[] = [];
  let [y, m] = first.split("-").map(Number);
  const [ey, em] = last.split("-").map(Number);
  while (y < ey || (y === ey && m <= em)) {
    months.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    if (months.length > 600) break; // garde-fou
  }

  return months.map((mKey, index) => {
    const cutoff = `${mKey}-31`;
    // Positions détenues + coût investi cumulés jusqu'à la fin du mois.
    const acc = new Map<string, { qty: number; lastPrice: number | null }>();
    let invested = 0;
    for (const op of dated) {
      if (op.date > cutoff) continue;
      if (op.type === "versement") invested += magnitude(op);
      else if (op.type === "retrait") invested -= magnitude(op);
      const key = instrumentKey(op);
      const entry = acc.get(key) ?? { qty: 0, lastPrice: null };
      if (op.type === "achat") {
        entry.qty += num(op.quantity);
        if (num(op.unitPrice) > 0) entry.lastPrice = num(op.unitPrice);
      } else if (op.type === "vente") {
        entry.qty -= num(op.quantity);
        if (num(op.unitPrice) > 0) entry.lastPrice = num(op.unitPrice);
      } else if (op.type === "correction") entry.qty += num(op.quantity);
      acc.set(key, entry);
    }
    const isCurrent = index === months.length - 1;
    let value = 0;
    for (const [key, entry] of acc) {
      if (entry.qty <= EPS) continue;
      const ref = priceByKey.get(key);
      const price = isCurrent && ref && ref.lastPrice !== null ? Number(ref.lastPrice) : entry.lastPrice;
      value += price !== null ? entry.qty * price : 0;
    }
    return { monthKey: mKey, label: `${MONTHS_SHORT[Number(mKey.slice(5, 7)) - 1]} ${mKey.slice(2, 4)}`, investedEur: invested, valueEur: value };
  });
}

export function windowAccountTimeline(points: AccountTimelinePoint[], range: "1M" | "3M" | "6M" | "1A" | "3A" | "TOUT"): AccountTimelinePoint[] {
  if (range === "TOUT" || points.length === 0) return points;
  const months = range === "1M" ? 2 : range === "3M" ? 3 : range === "6M" ? 6 : range === "1A" ? 12 : 36;
  return points.slice(Math.max(0, points.length - months));
}

// Périodes réellement supportées : on n'affiche que celles couvertes par l'historique
// (Étape 2 : ne pas proposer 3A si l'on n'a pas 3 ans de données).
export function supportedRanges(points: AccountTimelinePoint[]): Array<"1M" | "3M" | "6M" | "1A" | "3A" | "TOUT"> {
  const span = points.length;
  const ranges: Array<"1M" | "3M" | "6M" | "1A" | "3A" | "TOUT"> = ["1M"];
  if (span > 3) ranges.push("3M");
  if (span > 6) ranges.push("6M");
  if (span > 12) ranges.push("1A");
  if (span > 36) ranges.push("3A");
  ranges.push("TOUT");
  return ranges;
}
