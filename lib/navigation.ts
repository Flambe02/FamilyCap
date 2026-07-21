export type View =
  | "famille"
  | "cadeaux-amatxi"
  | "portefeuilles"
  | "bitcoin"
  | "investissements-pea"
  | "investissements-comptetitres"
  | "investissements-suggestions"
  | "investissements-historique"
  | "apprendre"
  | "videos"
  | "famille-roster"
  | "parametres"
  | "transactions"
  | "famille-acces"
  | "administration-suggestions"
  | "administration-globale";

export type NavIconId =
  | "house"
  | "gift"
  | "wallet"
  | "bitcoin"
  | "trending-up"
  | "landmark"
  | "square-play"
  | "users"
  | "book-open"
  | "settings"
  | "list-checks"
  | "star"
  | "shield-check"
  | "calendar";

export type NavLeaf = { id: View; label: string; icon: NavIconId; iconLabel: string; short?: string };

export const investmentSubNavigation: NavLeaf[] = [
  { id: "bitcoin", label: "Bitcoin", icon: "bitcoin", iconLabel: "Bitcoin" },
  { id: "investissements-pea", label: "PEA", icon: "landmark", iconLabel: "PEA" },
  { id: "investissements-comptetitres", label: "Compte-titres", icon: "landmark", iconLabel: "Compte-titres", short: "Titres" },
  { id: "investissements-suggestions", label: "Suggestions mensuelles", icon: "star", iconLabel: "Suggestions mensuelles" },
  { id: "investissements-historique", label: "Historique", icon: "list-checks", iconLabel: "Historique des investissements" },
  { id: "apprendre", label: "Comprendre", icon: "book-open", iconLabel: "Comprendre" },
];

export const INVESTMENT_VIEW_IDS: View[] = investmentSubNavigation.map((item) => item.id);

export const investmentGroupMeta = {
  label: "Investissements",
  icon: "trending-up" as NavIconId,
  iconLabel: "Investissements",
  short: "Investir",
};

export const familyNavigation: NavLeaf[] = [
  { id: "famille", label: "Tableau de bord", icon: "house", iconLabel: "Tableau de bord", short: "Accueil" },
  { id: "cadeaux-amatxi", label: "Cadeaux d’Amatxi", icon: "gift", iconLabel: "Cadeaux d’Amatxi", short: "Cadeaux" },
  { id: "videos", label: "Souvenirs", icon: "square-play", iconLabel: "Souvenirs", short: "Souvenirs" },
  { id: "parametres", label: "Paramètres", icon: "settings", iconLabel: "Paramètres", short: "Paramètres" },
];

export const adminNavigation: NavLeaf[] = [
  { id: "transactions", label: "Opérations", icon: "list-checks", iconLabel: "Opérations" },
  { id: "famille-acces", label: "Famille & accès", icon: "users", iconLabel: "Famille & accès" },
  { id: "administration-suggestions", label: "Suggestions", icon: "star", iconLabel: "Suggestions" },
  { id: "administration-globale", label: "Administration", icon: "shield-check", iconLabel: "Administration" },
];

export const ADMIN_ONLY_VIEW_IDS: View[] = adminNavigation.map((item) => item.id);
export const HIDDEN_FROM_SIDEBAR_VIEW_IDS: View[] = ["portefeuilles", "famille-roster"];

export const BOTTOM_NAV_ITEMS: { id: View; label: string; icon: NavIconId; short: string; groupIds?: View[] }[] = [
  { id: "famille", label: "Tableau de bord", icon: "house", short: "Accueil" },
  { id: "bitcoin", label: "Investissements", icon: "trending-up", short: "Investir", groupIds: INVESTMENT_VIEW_IDS },
  { id: "videos", label: "Souvenirs", icon: "square-play", short: "Souvenirs" },
  { id: "parametres", label: "Paramètres", icon: "settings", short: "Paramètres" },
];

export function titleForView(view: View): string {
  const titles: Record<View, string> = {
    famille: "Tableau de bord",
    "cadeaux-amatxi": "Cadeaux d’Amatxi",
    portefeuilles: "Portefeuille",
    bitcoin: "Bitcoin",
    transactions: "Opérations",
    "investissements-pea": "PEA",
    "investissements-comptetitres": "Compte-titres",
    "investissements-suggestions": "Suggestions mensuelles",
    "investissements-historique": "Historique",
    videos: "Souvenirs",
    "famille-roster": "Famille",
    "administration-suggestions": "Suggestions",
    "administration-globale": "Administration",
    "famille-acces": "Famille & accès",
    apprendre: "Comprendre",
    parametres: "Paramètres",
  };
  return titles[view];
}
