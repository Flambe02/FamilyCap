export type HistoricalGift = {
  member: "Thibault" | "Uhaina" | "Paul" | "Aurore" | "Thomas";
  occasion: "Anniversaire" | "Noël";
  giftDate: string;
  purchaseDate: string;
  amountEur: number;
  btcAmount: number;
  note: string;
};

const birthdays: HistoricalGift[] = [
  { member: "Paul", occasion: "Anniversaire", giftDate: "2022-11-18", purchaseDate: "2022-11-18", amountEur: 55, btcAmount: 0.00155968, note: "Valeur confirmée par le tableau familial." },
  { member: "Thibault", occasion: "Anniversaire", giftDate: "2023-03-15", purchaseDate: "2023-03-15", amountEur: 55, btcAmount: 0.00217, note: "Valeur confirmée par le tableau familial." },
  { member: "Uhaina", occasion: "Anniversaire", giftDate: "2023-08-16", purchaseDate: "2023-08-16", amountEur: 55.42, btcAmount: 0.00207, note: "Compensation du solde réduit reçu à Noël 2022, frais Binance inclus." },
  { member: "Paul", occasion: "Anniversaire", giftDate: "2023-11-18", purchaseDate: "2023-11-18", amountEur: 55, btcAmount: 0.00155968, note: "Valeur confirmée par le tableau familial." },
  { member: "Aurore", occasion: "Anniversaire", giftDate: "2023-08-27", purchaseDate: "2023-08-27", amountEur: 55, btcAmount: 0.00208, note: "Valeur confirmée par le tableau familial." },
  { member: "Aurore", occasion: "Anniversaire", giftDate: "2024-08-27", purchaseDate: "2024-08-27", amountEur: 55, btcAmount: 0.00147, note: "Valeur confirmée par le tableau familial." },
  { member: "Thomas", occasion: "Anniversaire", giftDate: "2024-12-29", purchaseDate: "2024-12-29", amountEur: 55, btcAmount: 0.00059, note: "Valeur confirmée par le tableau familial." },
  { member: "Thibault", occasion: "Anniversaire", giftDate: "2025-03-15", purchaseDate: "2025-03-15", amountEur: 55, btcAmount: 0.0006789, note: "Valeur confirmée par le tableau familial." },
  { member: "Uhaina", occasion: "Anniversaire", giftDate: "2025-08-16", purchaseDate: "2025-08-16", amountEur: 55, btcAmount: 0.00053622, note: "Valeur confirmée par le tableau familial." },
  { member: "Paul", occasion: "Anniversaire", giftDate: "2025-11-18", purchaseDate: "2025-11-18", amountEur: 55, btcAmount: 0.00065951, note: "Valeur confirmée par le tableau familial." },
  { member: "Aurore", occasion: "Anniversaire", giftDate: "2025-08-27", purchaseDate: "2025-08-27", amountEur: 55, btcAmount: 0.00054322, note: "Valeur confirmée par le tableau familial." },
];

const christmasByYear: Array<{ date: string; amounts: Record<HistoricalGift["member"], number>; eurAmounts?: Partial<Record<HistoricalGift["member"], number>> }> = [
  { date: "2022-12-27", amounts: { Thibault: 0.003094, Uhaina: 0.002894, Paul: 0.003094, Aurore: 0.003094, Thomas: 0.003094 }, eurAmounts: { Uhaina: 45.76, Paul: 48.97, Aurore: 48.93, Thomas: 48.93 } },
  { date: "2023-12-25", amounts: { Thibault: 0.001362, Uhaina: 0.001362, Paul: 0.001362, Aurore: 0.001362, Thomas: 0.001362 } },
  { date: "2024-12-25", amounts: { Thibault: 0.00053083, Uhaina: 0.00053083, Paul: 0.00053083, Aurore: 0.00053083, Thomas: 0.00053083 } },
  { date: "2025-12-25", amounts: { Thibault: 0.00071399, Uhaina: 0.00071399, Paul: 0.00071399, Aurore: 0.00071399, Thomas: 0.00071399 } },
];

const christmas = christmasByYear.flatMap(({ date, amounts, eurAmounts }) => Object.entries(amounts).map(([member, btcAmount]) => ({
  member: member as HistoricalGift["member"],
  occasion: "Noël" as const,
  giftDate: date,
  purchaseDate: date,
  amountEur: eurAmounts?.[member as HistoricalGift["member"]] ?? 55,
  btcAmount,
  note: date === "2022-12-27" && member === "Uhaina"
    ? "Montant net reçu réduit par les frais ; compensation appliquée à l’anniversaire 2023."
    : `Cadeau de Noël acheté le ${date.split("-").reverse().join("/")} · valeur confirmée par le tableau familial.`,
})));

export const GIFT_HISTORY: HistoricalGift[] = [...birthdays, ...christmas]
  .sort((left, right) => left.giftDate.localeCompare(right.giftDate));