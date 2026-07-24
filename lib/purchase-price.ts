import { MEMBER_NAMES, type MemberName } from "./family-roster";

export type PurchasePricePoint = { index: number; price: number; amountEur: number; btcAmount: number; giftDate: string; onLedger: boolean };
export type PurchasePriceSeries = { member: MemberName; points: PurchasePricePoint[] };
export type PurchaseSourceRecord = { member_name: string; occasion: string; gift_date: string; amount_eur: number | string; btc_amount: number | string; custody?: string | null; is_deleted?: boolean };
export type PurchasePriceData = { categories: string[]; series: PurchasePriceSeries[]; years: number[]; totalInvestedEur: number; totalBtc: number; average: number };

export const PURCHASE_PRICE_MEMBERS: MemberName[] = MEMBER_NAMES;

export function computePurchasePriceData(records: PurchaseSourceRecord[]): PurchasePriceData {
  const clean = records.filter((record) => !record.is_deleted
    && (PURCHASE_PRICE_MEMBERS as string[]).includes(record.member_name)
    && (record.occasion === "Anniversaire" || record.occasion === "Noël")
    && Number(record.btc_amount) > 0);

  const recordYears = clean.map((record) => Number(record.gift_date.slice(0, 4)));
  const minYear = recordYears.length ? Math.min(...recordYears) : new Date().getFullYear();
  const maxYear = recordYears.length ? Math.max(...recordYears) : new Date().getFullYear();
  const years = Array.from({ length: maxYear - minYear + 1 }, (_, i) => minYear + i);
  const categories = years.flatMap((year) => [`Anniv. ’${String(year).slice(2)}`, `Noël ’${String(year).slice(2)}`]);

  function categoryIndex(record: PurchaseSourceRecord): number {
    const yearIndex = years.indexOf(Number(record.gift_date.slice(0, 4)));
    return yearIndex * 2 + (record.occasion === "Noël" ? 1 : 0);
  }

  const series: PurchasePriceSeries[] = PURCHASE_PRICE_MEMBERS.map((member) => ({
    member,
    points: clean.filter((record) => record.member_name === member)
      .map((record) => {
        const amountEur = Number(record.amount_eur);
        const btcAmount = Number(record.btc_amount);
        return { index: categoryIndex(record), price: amountEur / btcAmount, amountEur, btcAmount, giftDate: record.gift_date, onLedger: record.custody === "Ledger" };
      })
      .sort((left, right) => left.index - right.index),
  }));

  const totalInvestedEur = clean.reduce((sum, record) => sum + Number(record.amount_eur), 0);
  const totalBtc = clean.reduce((sum, record) => sum + Number(record.btc_amount), 0);

  return { categories, series, years, totalInvestedEur, totalBtc, average: totalBtc > 0 ? totalInvestedEur / totalBtc : 0 };
}
