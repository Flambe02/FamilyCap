// FIXTURE DE RÉFÉRENCE — capture Boursobank « PEA LAMBERT », onglet Positions.
//
// C'est la retranscription attendue de la capture jointe au cahier des charges : elle sert de
// test de NON-RÉGRESSION du parcours complet (schéma → relevé canonique → contrôles comptables →
// opérations). Les valeurs ci-dessous sont celles IMPRIMÉES sur la capture, au centime.
//
// Deux formes du même document sont fournies :
//   • RAW_STRICT  : le modèle a respecté le contrat (nombres JSON, {value, confidence}).
//   • RAW_TEXTUAL : le modèle a recopié les cellules TELLES QU'AFFICHÉES (« 177 418,34 € »,
//     espaces insécables, « - 4 247,89 € »). Les deux doivent produire EXACTEMENT le même relevé :
//     c'est ce qui prouve que le parsing typographique ne perd ni un millier ni un signe.

const f = (value, confidence = 0.95, page = 1) => ({ value, confidence, page });

/** Espace insécable et fine insécable, tels qu'ils apparaissent dans une copie d'écran. */
const NBSP = " ";
const NNBSP = " ";

export const EXPECTED_HEADER = {
  broker: "boursobank",
  accountType: "PEA",
  accountName: "PEA LAMBERT",
  accountNumberMasked: "•••• 1306",
  snapshotDate: "2026-07-25",
  openingDate: "2023-11-22",
  managementMode: "Gestion Libre",
  totalPortfolio: 177418.34,
  availableCash: 21.09,
  securitiesValue: 177397.25,
  unrealizedGain: 28022.63,
  unrealizedGainPercent: 18.76,
  depositCeiling: 150000,
  cumulativeDeposits: 149500,
  currency: "EUR",
};

export const EXPECTED_POSITIONS = [
  {
    name: "ISHARES CORE EURO STOXX 50 ETF EUR ACC", isin: "IE00B53L3W79", quantity: 317,
    averageCostDisplayed: 199.5, currentPrice: 244.65, dailyChangePercent: 1.22,
    marketValue: 77554.05, unrealizedGain: 14313.05, unrealizedGainPercent: 22.63,
    lastMovementDate: "2025-12-09", costBasis: 63241.0,
  },
  {
    name: "ISHARES DIVERSIFIED COMMODITY SWAP (DE)", isin: "DE000A0H0728", quantity: 1000,
    averageCostDisplayed: 26.6, currentPrice: 34.58, dailyChangePercent: -1.21,
    marketValue: 34580.0, unrealizedGain: 7980.0, unrealizedGainPercent: 30.0,
    lastMovementDate: "2024-05-22", costBasis: 26600.0,
  },
  {
    name: "ISHARES MSCI WORLD SWAP PEA ETF", isin: "IE0002XZSHO1", quantity: 5000,
    averageCostDisplayed: 4.94, currentPrice: 6.86, dailyChangePercent: 0.63,
    marketValue: 34325.0, unrealizedGain: 9611.0, unrealizedGainPercent: 38.89,
    lastMovementDate: "2024-04-05", costBasis: 24714.0,
  },
  {
    name: "SANOFI", isin: "FR0000120578", quantity: 360,
    averageCostDisplayed: 87.83, currentPrice: 76.03, dailyChangePercent: -0.43,
    marketValue: 27370.8, unrealizedGain: -4247.89, unrealizedGainPercent: -13.42,
    lastMovementDate: "2026-02-23", costBasis: 31618.69,
  },
  {
    name: "AMUNDI PEA EMERG MSCI ESG TR UCITS ETFC", isin: "FR0013412020", quantity: 103,
    averageCostDisplayed: 31.08, currentPrice: 34.64, dailyChangePercent: -0.4,
    marketValue: 3567.4, unrealizedGain: 366.47, unrealizedGainPercent: 11.45,
    lastMovementDate: "2026-05-11", costBasis: 3200.93,
  },
];

/** Intitulés visibles sur la capture — c'est sur EUX que repose la reconnaissance du courtier. */
export const DETECTED_MARKERS = [
  "Total Portefeuille (titres + espèces)",
  "Solde Espèces disponible 25/07/2026",
  "Évaluation titres",
  "Montant +/- values latentes",
  "Plafond de versement",
  "Cumul des versements",
  "Tarification",
  "Date d'ouverture du compte",
  "Mode de gestion",
  "Gestion Libre",
  "Positions",
  "Ordres",
  "Performance",
  "Mouvements",
  "Valeur",
  "Quantité",
  "Px. Revient",
  "Cours",
  "Montant",
  "+/- Latentes",
  "+/- %",
  "Dernier Mvt",
  "Notification",
  "Accéder au TradingBoard",
  "Position instantanée",
  "Position comptable",
];

function strictPosition(expected) {
  return {
    instrument_name: f(expected.name),
    isin: f(expected.isin),
    ticker: f(null, 0.2),
    quantity: f(expected.quantity),
    average_cost: f(expected.averageCostDisplayed),
    last_price: f(expected.currentPrice),
    current_value: f(expected.marketValue),
    day_change_pct: f(expected.dailyChangePercent),
    gain_amount: f(expected.unrealizedGain),
    gain_pct: f(expected.unrealizedGainPercent),
    currency: f("EUR"),
    last_movement_date: f(expected.lastMovementDate),
    source_text: `${expected.name} ${expected.isin} ${expected.quantity}`,
    page: 1,
    warnings: [],
  };
}

export const RAW_STRICT = {
  document: {
    institution: f("Boursobank"),
    account_type: f("pea"),
    account_name: f("PEA LAMBERT"),
    account_number: f("00088051306"),
    currency: f("EUR"),
    as_of_date: f("2026-07-25"),
    opening_date: f("2023-11-22"),
    management_mode: f("Gestion Libre"),
    total_portfolio: f(177418.34),
    available_cash: f(21.09),
    securities_value: f(177397.25),
    unrealized_gain: f(28022.63),
    unrealized_gain_pct: f(18.76),
    deposit_ceiling: f(150000),
    cumulative_deposits: f(149500),
    detected_markers: DETECTED_MARKERS,
  },
  positions: EXPECTED_POSITIONS.map(strictPosition),
};

/** La MÊME capture, recopiée cellule par cellule telle qu'elle s'affiche à l'écran. */
export const RAW_TEXTUAL = {
  document: {
    institution: f("Boursobank"),
    account_type: f("PEA"),
    account_name: f("PEA LAMBERT"),
    account_number: f("00088051306"),
    currency: f("EUR"),
    as_of_date: f("25/07/2026"),
    opening_date: f("22/11/2023"),
    management_mode: f("Gestion Libre"),
    total_portfolio: f(`177${NBSP}418,34${NBSP}€`),
    available_cash: f(`21,09${NBSP}€`),
    securities_value: f(`177${NNBSP}397,25 €`),
    unrealized_gain: f(`28${NBSP}022,63 €`),
    unrealized_gain_pct: f("18,76 %"),
    deposit_ceiling: f(`150${NBSP}000${NBSP}€`),
    cumulative_deposits: f(`149${NBSP}500,00 €`),
    detected_markers: DETECTED_MARKERS,
  },
  positions: [
    {
      instrument_name: f("ISHARES CORE EURO STOXX 50 ETF EUR ACC"), isin: f("IE00B53L3W79"),
      quantity: f("317"), average_cost: f("199,50 €"), last_price: f(`244,65${NBSP}€`),
      day_change_pct: f("1,22 %"), current_value: f(`77${NBSP}554,05 €`),
      gain_amount: f(`14${NBSP}313,05 €`), gain_pct: f("22,63 %"), last_movement_date: f("09/12/2025"),
    },
    {
      instrument_name: f("ISHARES DIVERSIFIED COMMODITY SWAP (DE)"), isin: f("DE000A0H0728"),
      quantity: f(`1${NBSP}000`), average_cost: f("26,60 €"), last_price: f("34,58 €"),
      day_change_pct: f("- 1,21 %"), current_value: f(`34${NBSP}580,00 €`),
      gain_amount: f(`7${NBSP}980,00 €`), gain_pct: f("30,00 %"), last_movement_date: f("22/05/2024"),
    },
    {
      instrument_name: f("ISHARES MSCI WORLD SWAP PEA ETF"), isin: f("IE0002XZSHO1"),
      quantity: f(`5${NBSP}000`), average_cost: f("4,94 €"), last_price: f("6,86 €"),
      day_change_pct: f("0,63 %"), current_value: f(`34${NBSP}325,00 €`),
      gain_amount: f(`9${NBSP}611,00 €`), gain_pct: f("38,89 %"), last_movement_date: f("05/04/2024"),
    },
    {
      instrument_name: f("SANOFI"), isin: f("FR0000120578"),
      quantity: f("360"), average_cost: f("87,83 €"), last_price: f("76,03 €"),
      day_change_pct: f("- 0,43 %"), current_value: f(`27${NBSP}370,80 €`),
      // Valeur ROUGE sur la capture : le signe est dans le texte, pas dans la couleur.
      gain_amount: f(`- 4${NBSP}247,89 €`), gain_pct: f("- 13,42 %"), last_movement_date: f("23/02/2026"),
    },
    {
      instrument_name: f("AMUNDI PEA EMERG MSCI ESG TR UCITS ETFC"), isin: f("FR0013412020"),
      quantity: f("103"), average_cost: f("31,08 €"), last_price: f("34,64 €"),
      day_change_pct: f("- 0,40 %"), current_value: f(`3${NBSP}567,40 €`),
      gain_amount: f("366,47 €"), gain_pct: f("11,45 %"), last_movement_date: f("11/05/2026"),
    },
  ],
};
