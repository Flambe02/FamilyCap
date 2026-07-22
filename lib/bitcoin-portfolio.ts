// Modèle Bitcoin dérivé — SOURCE DE VÉRITÉ UNIQUE pour tous les onglets de la section
// Bitcoin (Résumé, Mes BTC, Investir, Conservation, Performance, Historique).
//
// Objectif : ne JAMAIS recalculer les mêmes chiffres différemment d'un onglet à l'autre.
// Tout part des mêmes primitives déjà utilisées dans l'app :
//   - `computePurchasePriceData` (montant investi, prix moyen pondéré) — inchangé
//   - `computeCustody` (répartition Ledger / Binance) — repris ici à l'identique
//   - le BTC « détenu » tient compte de `ledger_amount` (montant réellement reçu) comme
//     partout ailleurs dans le code (family-dashboard, gift-portfolio).
//
// Aucune donnée fictive : si une origine n'existe pas encore dans les données réelles,
// son bucket vaut 0 et l'UI l'affiche honnêtement.

import { computePurchasePriceData, type PurchaseSourceRecord } from "./gift-history";
import { FAMILY_MEMBERS, type MemberColor } from "./family-roster";

export type BitcoinGiftRecord = {
  member_name: string;
  occasion: string;
  gift_date: string;
  amount_eur: number;
  btc_amount: number;
  custody?: string;
  ledger_amount?: number | null;
  is_deleted?: boolean;
  source?: string | null;
  note?: string | null;
};

export type OriginKey = "cadeau_amatxi" | "investissement_personnel" | "achat_groupe";

export type OriginConfig = { key: OriginKey; label: string; short: string; color: string; tone: "teal" | "blue" | "amber" };

// Couleurs alignées sur le tableau de bord (home) et la charte : cadeaux = vert/teal,
// investissements personnels = bleu, achats groupés = orange Bitcoin.
export const BITCOIN_ORIGINS: OriginConfig[] = [
  { key: "cadeau_amatxi", label: "Cadeaux d’Amatxi", short: "Cadeaux", color: "#1d706b", tone: "teal" },
  { key: "investissement_personnel", label: "Investissements personnels", short: "Perso", color: "#5a9bd4", tone: "blue" },
  { key: "achat_groupe", label: "Achats groupés / autres", short: "Groupés", color: "#f0a63a", tone: "amber" },
];

export const ORIGIN_BY_KEY: Record<OriginKey, OriginConfig> = Object.fromEntries(
  BITCOIN_ORIGINS.map((origin) => [origin.key, origin]),
) as Record<OriginKey, OriginConfig>;

export const CUSTODY_COLORS = { ledger: "#1d706b", binance: "#f0a63a", unclassified: "#c4ccce" };

// BTC réellement détenu : sur Ledger on compte le montant reçu (ledger_amount) s'il est
// renseigné, sinon la quantité achetée. Identique à family-dashboard / gift-portfolio.
export function ownedBtcOf(record: BitcoinGiftRecord): number {
  const effective = record.custody === "Ledger" && Number(record.ledger_amount) > 0 ? Number(record.ledger_amount) : Number(record.btc_amount);
  return Math.max(0, effective || 0);
}

// Origine d'un lot : la colonne `source` fait foi si elle existe (migration
// 20260721_gift_source). Sinon on retombe sur l'occasion : Anniversaire / Noël = cadeau
// d'Amatxi (100 % du réel aujourd'hui), « Autre cadeau » = achat groupé / autre.
export function classifyOrigin(record: BitcoinGiftRecord): OriginKey {
  const source = (record.source ?? "").trim();
  if (source === "investissement_personnel" || source === "achat_groupe" || source === "cadeau_amatxi") return source;
  if (record.occasion === "Anniversaire" || record.occasion === "Noël") return "cadeau_amatxi";
  if (record.occasion === "Autre cadeau") return "achat_groupe";
  return "cadeau_amatxi";
}

function cleanRecords(records: BitcoinGiftRecord[]): BitcoinGiftRecord[] {
  return records.filter((record) => !record.is_deleted && Number(record.btc_amount) > 0);
}

// ---- Types du modèle exposé ----------------------------------------------------------

export type OriginBucket = OriginConfig & { btc: number; investedEur: number; valueEur: number | null; pct: number; count: number };
export type CustodyBucket = { key: "ledger" | "binance" | "unclassified"; label: string; color: string; btc: number; valueEur: number | null; pct: number; count: number };

export type MemberSummary = {
  name: string;
  initials: string;
  color: MemberColor;
  btc: number;
  valueEur: number | null;
  investedEur: number;
  gainEur: number | null;
  gainPct: number | null;
  ledgerBtc: number;
  binanceBtc: number;
  pct: number;
  pending: number;
  topOrigin: OriginKey | null;
  lots: number;
};

export type BitcoinLot = {
  id: string;
  member: string;
  origin: OriginKey;
  occasion: string;
  date: string;
  btc: number;
  investedEur: number;
  purchasePrice: number | null;
  currentValueEur: number | null;
  gainEur: number | null;
  gainPct: number | null;
  custody: "Ledger" | "Binance" | "À classer";
  note?: string | null;
};

export type BitcoinOperation = {
  key: string;
  member: string;
  origin: OriginKey;
  occasion: string;
  label: string;
  amountEur: number;
  btcAmount: number;
  date: string;
  custody: "Ledger" | "Binance" | "À classer";
};

export type TimelinePoint = { label: string; monthKey: string; investedEur: number; valueEur: number; btc: number };

export type BitcoinModel = {
  totalBtc: number;
  investedEur: number;
  valueEur: number | null;
  gainEur: number | null;
  gainPct: number | null;
  averagePrice: number;
  purchasedBtc: number;
  origins: OriginBucket[];
  custody: { ledger: CustodyBucket; binance: CustodyBucket; unclassified: CustodyBucket; securedPct: number };
  members: MemberSummary[];
  memberCount: number;
  lots: BitcoinLot[];
  operations: BitcoinOperation[];
  timeline: TimelinePoint[];
};

function custodyOf(record: BitcoinGiftRecord): "Ledger" | "Binance" | "À classer" {
  if (record.custody === "Ledger") return "Ledger";
  if (record.custody === "À rapprocher") return "À classer";
  return "Binance";
}

function occasionLabel(record: BitcoinGiftRecord): string {
  const origin = classifyOrigin(record);
  if (origin === "investissement_personnel") return "Investissement personnel";
  if (origin === "achat_groupe") return record.occasion === "Autre cadeau" ? "Achat groupé / autre" : record.occasion;
  if (record.occasion === "Anniversaire") return "Cadeau d’anniversaire";
  if (record.occasion === "Noël") return "Cadeau de Noël";
  return "Cadeau d’Amatxi";
}

/**
 * Construit le modèle Bitcoin complet à partir des données RÉELLES déjà chargées.
 * `memberBalances` / `totalBtc` / `totalValueEur` proviennent de family-dashboard (mêmes
 * formules partout) ; on les réutilise pour garantir zéro divergence de chiffres.
 */
export function computeBitcoinModel(params: {
  records: BitcoinGiftRecord[];
  bitcoinEur: number | null;
  memberBalances: { name: string; btc: number; currentValueEur: number | null }[];
  totalBtc: number;
  totalValueEur: number | null;
  pendingByMember?: Record<string, number>;
}): BitcoinModel {
  const { records, bitcoinEur, memberBalances, totalBtc, totalValueEur, pendingByMember = {} } = params;
  const clean = cleanRecords(records);

  // Investi + prix moyen : source de vérité historique inchangée.
  const purchase = computePurchasePriceData(records as PurchaseSourceRecord[]);
  const investedEur = purchase.totalInvestedEur;
  const gainEur = totalValueEur === null ? null : totalValueEur - investedEur;
  const gainPct = gainEur === null || investedEur <= 0 ? null : (gainEur / investedEur) * 100;

  // ---- Origines ----
  const originBtc: Record<OriginKey, { btc: number; invested: number; count: number }> = {
    cadeau_amatxi: { btc: 0, invested: 0, count: 0 },
    investissement_personnel: { btc: 0, invested: 0, count: 0 },
    achat_groupe: { btc: 0, invested: 0, count: 0 },
  };
  for (const record of clean) {
    const key = classifyOrigin(record);
    originBtc[key].btc += ownedBtcOf(record);
    originBtc[key].invested += Math.max(0, Number(record.amount_eur) || 0);
    originBtc[key].count += 1;
  }
  const origins: OriginBucket[] = BITCOIN_ORIGINS.map((origin) => {
    const bucket = originBtc[origin.key];
    return {
      ...origin,
      btc: bucket.btc,
      investedEur: bucket.invested,
      valueEur: bitcoinEur ? bucket.btc * bitcoinEur : null,
      pct: totalBtc > 0 ? (bucket.btc / totalBtc) * 100 : 0,
      count: bucket.count,
    };
  });

  // ---- Conservation (Ledger / Binance / à classer) ----
  const custodyTotals = { ledger: { btc: 0, count: 0 }, binance: { btc: 0, count: 0 }, unclassified: { btc: 0, count: 0 } };
  for (const record of clean) {
    const place = custodyOf(record);
    const btc = ownedBtcOf(record);
    if (place === "Ledger") { custodyTotals.ledger.btc += btc; custodyTotals.ledger.count += 1; }
    else if (place === "À classer") { custodyTotals.unclassified.btc += btc; custodyTotals.unclassified.count += 1; }
    else { custodyTotals.binance.btc += btc; custodyTotals.binance.count += 1; }
  }
  const custodyBucket = (key: CustodyBucket["key"], label: string, color: string, totals: { btc: number; count: number }): CustodyBucket => ({
    key, label, color, btc: totals.btc, valueEur: bitcoinEur ? totals.btc * bitcoinEur : null,
    pct: totalBtc > 0 ? (totals.btc / totalBtc) * 100 : 0, count: totals.count,
  });
  const custody = {
    ledger: custodyBucket("ledger", "Sur Ledger", CUSTODY_COLORS.ledger, custodyTotals.ledger),
    binance: custodyBucket("binance", "Sur Binance", CUSTODY_COLORS.binance, custodyTotals.binance),
    unclassified: custodyBucket("unclassified", "À rapprocher", CUSTODY_COLORS.unclassified, custodyTotals.unclassified),
    securedPct: totalBtc > 0 ? (custodyTotals.ledger.btc / totalBtc) * 100 : 0,
  };

  // ---- Membres ----
  const members: MemberSummary[] = FAMILY_MEMBERS.map((member) => {
    const memberRecords = clean.filter((record) => record.member_name === member.name);
    const balance = memberBalances.find((item) => item.name === member.name);
    const memberPurchase = computePurchasePriceData(memberRecords as PurchaseSourceRecord[]);
    const btc = balance?.btc ?? memberRecords.reduce((sum, record) => sum + ownedBtcOf(record), 0);
    const valueEur = balance?.currentValueEur ?? (bitcoinEur ? btc * bitcoinEur : null);
    const memberGain = valueEur === null ? null : valueEur - memberPurchase.totalInvestedEur;
    const memberGainPct = memberGain === null || memberPurchase.totalInvestedEur <= 0 ? null : (memberGain / memberPurchase.totalInvestedEur) * 100;
    let ledgerBtc = 0, binanceBtc = 0;
    const originCount: Record<OriginKey, number> = { cadeau_amatxi: 0, investissement_personnel: 0, achat_groupe: 0 };
    for (const record of memberRecords) {
      const place = custodyOf(record);
      if (place === "Ledger") ledgerBtc += ownedBtcOf(record); else binanceBtc += ownedBtcOf(record);
      originCount[classifyOrigin(record)] += 1;
    }
    const topOrigin = (Object.entries(originCount) as [OriginKey, number][]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    return {
      name: member.name, initials: member.initials, color: member.color,
      btc, valueEur, investedEur: memberPurchase.totalInvestedEur, gainEur: memberGain, gainPct: memberGainPct,
      ledgerBtc, binanceBtc, pct: totalBtc > 0 ? (btc / totalBtc) * 100 : 0,
      pending: pendingByMember[member.name] ?? 0, topOrigin, lots: memberRecords.length,
    };
  }).sort((a, b) => b.btc - a.btc);
  const memberCount = members.filter((member) => member.btc > 0).length;

  // ---- Lots (une ligne par cadeau/achat réel) ----
  const lots: BitcoinLot[] = clean
    .map((record, index) => {
      const btc = ownedBtcOf(record);
      const invested = Math.max(0, Number(record.amount_eur) || 0);
      const purchasedBtc = Number(record.btc_amount) || 0;
      const purchasePrice = purchasedBtc > 0 && invested > 0 ? invested / purchasedBtc : null;
      const currentValueEur = bitcoinEur ? btc * bitcoinEur : null;
      const lotGain = currentValueEur === null ? null : currentValueEur - invested;
      const lotGainPct = lotGain === null || invested <= 0 ? null : (lotGain / invested) * 100;
      return {
        id: `${record.member_name}-${record.occasion}-${record.gift_date}-${index}`,
        member: record.member_name, origin: classifyOrigin(record), occasion: record.occasion, date: record.gift_date,
        btc, investedEur: invested, purchasePrice, currentValueEur, gainEur: lotGain, gainPct: lotGainPct,
        custody: custodyOf(record), note: record.note ?? null,
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));

  const operations: BitcoinOperation[] = clean
    .slice()
    .sort((a, b) => b.gift_date.localeCompare(a.gift_date))
    .map((record, index) => ({
      key: `${record.member_name}-${record.occasion}-${record.gift_date}-${index}`,
      member: record.member_name, origin: classifyOrigin(record), occasion: record.occasion,
      label: occasionLabel(record), amountEur: Number(record.amount_eur) || 0, btcAmount: Number(record.btc_amount) || 0,
      date: record.gift_date, custody: custodyOf(record),
    }));

  return {
    totalBtc, investedEur, valueEur: totalValueEur, gainEur, gainPct,
    averagePrice: purchase.average, purchasedBtc: purchase.totalBtc,
    origins, custody, members, memberCount, lots, operations,
    timeline: buildTimeline(clean, bitcoinEur),
  };
}

// Évolution de la valeur : reconstruite à partir de données RÉELLES uniquement.
// - Montant investi cumulé = somme réelle des amount_eur par date.
// - Valeur = BTC détenu cumulé × prix. Le prix de chaque mois est le dernier prix d'achat
//   réel constaté (amount_eur / btc_amount d'un cadeau = cours du marché ce jour-là) ;
//   le mois courant utilise le cours en direct `bitcoinEur`. Échantillonnage mensuel pour
//   que les filtres 1M / 6M / 1A restent lisibles malgré des achats espacés.
function buildTimeline(clean: BitcoinGiftRecord[], bitcoinEur: number | null): TimelinePoint[] {
  if (clean.length === 0) return [];
  const events = clean
    .map((record) => ({
      date: record.gift_date,
      invested: Math.max(0, Number(record.amount_eur) || 0),
      btc: ownedBtcOf(record),
      price: Number(record.btc_amount) > 0 && Number(record.amount_eur) > 0 ? Number(record.amount_eur) / Number(record.btc_amount) : null,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const firstDate = events[0].date;
  const startYear = Number(firstDate.slice(0, 4));
  const startMonth = Number(firstDate.slice(5, 7));
  const now = events[events.length - 1].date > todayISO() ? events[events.length - 1].date : todayISO();
  const endYear = Number(now.slice(0, 4));
  const endMonth = Number(now.slice(5, 7));

  const months: string[] = [];
  for (let y = startYear, m = startMonth; y < endYear || (y === endYear && m <= endMonth); m += 1) {
    if (m > 12) { m = 1; y += 1; }
    months.push(`${y}-${String(m).padStart(2, "0")}`);
    if (y === endYear && m === endMonth) break;
  }

  const monthShort = new Intl.DateTimeFormat("fr-FR", { month: "short", year: "2-digit", timeZone: "UTC" });
  let lastPrice: number | null = null;
  const points: TimelinePoint[] = months.map((monthKey, index) => {
    const monthEnd = `${monthKey}-31`;
    let investedCum = 0, btcCum = 0;
    for (const event of events) {
      if (event.date <= monthEnd) { investedCum += event.invested; btcCum += event.btc; if (event.price) lastPrice = event.price; }
    }
    const isCurrentMonth = index === months.length - 1;
    const price = isCurrentMonth && bitcoinEur ? bitcoinEur : lastPrice;
    return {
      monthKey,
      label: monthShort.format(new Date(`${monthKey}-01T00:00:00Z`)).replace(".", ""),
      investedEur: investedCum,
      valueEur: price ? btcCum * price : investedCum,
      btc: btcCum,
    };
  });
  return points;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function windowTimeline(points: TimelinePoint[], range: "1M" | "6M" | "1A" | "TOUT"): TimelinePoint[] {
  if (range === "TOUT" || points.length === 0) return points;
  const months = range === "1M" ? 2 : range === "6M" ? 6 : 12;
  return points.slice(Math.max(0, points.length - months));
}
