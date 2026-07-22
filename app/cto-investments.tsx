"use client";

// Écran Compte-titres (CTO) — WRAPPER fin par-dessus le shell d'investissement partagé
// (app/investment-account.tsx), exactement comme le PEA. Même moteur (lib/portfolio-account.ts),
// même route d'écriture (/api/pea/operations), mêmes composants. Seule la config CTO diffère :
// multi-compte agrégé, répartition par devise, impact du change « Non disponible », transferts
// de titres, FAQ dédiée. Aucune donnée fictive ; les manques sont signalés honnêtement.

import type { Viewer } from "../lib/auth-types";
import {
  InvestmentAccountShell,
  type EnvelopeConfig, type InvestmentAccount, type InvestmentHolding, type InvestmentOperation,
} from "./investment-account";
import "./cto-investments.css";

const CTO_CONFIG: EnvelopeConfig = {
  kind: "CTO",
  accountType: "securities",
  hashPrefix: "cto",
  pageClass: "pea-page cto-page",
  logoGlyph: "◫",
  logoClass: "cto-logo",
  singularTitle: (name) => (name ? `Compte-titres de ${name}` : "Compte-titres"),
  aggregateTitle: "Mes comptes-titres",
  subtitle: "Suivez vos comptes-titres : positions, achats/ventes, dividendes, espèces et devises — calculés à partir de vos opérations réelles.",
  allowAggregate: true,
  thirdCard: "currency",
  sixthKpi: "fxImpact",
  showRegular: true,
  positionsVariant: "cto",
  investCards: ["versement", "achat", "vente", "dividende", "retrait", "frais", "transfer_in", "transfer_out"],
  modalAdvanced: true,
  faq: [
    { q: "Qu’est-ce qu’un compte-titres ?", a: "Le compte-titres ordinaire (CTO) permet d’investir sans limite de montant sur presque tous les marchés (actions, ETF, obligations, fonds) et dans toutes les devises. Contrairement au PEA, il n’a pas d’avantage fiscal spécifique." },
    { q: "Quelle différence avec un PEA ?", a: "Le PEA est limité aux actions et ETF européens, plafonné, et fiscalement avantageux après 5 ans. Le CTO est plus souple (monde entier, toutes devises, pas de plafond) mais sans cadre fiscal privilégié." },
    { q: "Actions et ETF, quelle différence ?", a: "Une action, c’est une part d’une seule entreprise. Un ETF (tracker) regroupe des centaines d’entreprises en une seule ligne : c’est un moyen simple de diversifier." },
    { q: "Comment lisons-nous les dividendes ?", a: "Le dividende est un revenu versé par certaines sociétés ou ETF. Nous affichons le montant net reçu ; la retenue éventuelle est enregistrée à part et n’est pas inventée." },
    { q: "Et les devises ?", a: "Chaque position conserve sa devise d’origine (EUR, USD, GBP…). Nous ne convertissons pas automatiquement les montants tant qu’un taux fiable n’est pas saisi : la répartition par devise est donc affichée « telle que saisie »." },
    { q: "Qu’est-ce que l’impact du change ?", a: "C’est la part de performance due uniquement à la variation des devises, distincte de celle du prix des actifs. Ce calcul arrivera dans un prochain lot ; d’ici là, il est marqué « Non disponible » plutôt qu’estimé." },
    { q: "Les frais comptent-ils ?", a: "Oui : les frais de courtage sont inclus dans le prix de revient, et les frais isolés (tenue de compte) sont suivis à part. Ils réduisent la performance réelle." },
    { q: "Pourquoi diversifier ?", a: "Répartir entre plusieurs actifs, secteurs, pays et devises réduit le risque : si l’un baisse, les autres peuvent compenser. Un ETF mondial diversifie en une seule ligne." },
  ],
  emptyNoAccount: {
    icon: "🏦",
    title: "Aucun compte-titres n’est encore configuré.",
    description: "Ajoute ton premier compte pour commencer à suivre tes investissements. Un administrateur peut le créer depuis Administration › Comptes & positions.",
    action: "Configurer un compte-titres",
  },
  emptyNoOperation: {
    icon: "📄",
    title: "Ton compte-titres est configuré, mais aucune opération n’a encore été enregistrée.",
    description: "Enregistre un versement, un achat d’action ou d’ETF : la valeur, le prix de revient et la performance se calculeront automatiquement à partir de ces opérations.",
    action: "Enregistrer la première opération",
  },
  resumeNote: "Chaque chiffre est calculé à partir de tes opérations réelles. Le prix de revient utilise la moyenne pondérée. Les devises sont conservées telles quelles : tant qu’un taux de change fiable n’est pas saisi, aucune conversion n’est inventée et l’impact du change reste « Non disponible ».",
};

export function CtoInvestmentPage(props: {
  accounts: InvestmentAccount[];
  holdings: InvestmentHolding[];
  operations: InvestmentOperation[];
  marketLoading: boolean;
  viewer: Viewer;
  isPreview: boolean;
  canManage: boolean;
  onReload: () => void;
  onConfigure: () => void;
}) {
  return <InvestmentAccountShell config={CTO_CONFIG} {...props} />;
}
