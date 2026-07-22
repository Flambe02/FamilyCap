"use client";

// Écran PEA — désormais un WRAPPER fin par-dessus le shell d'investissement partagé
// (app/investment-account.tsx). Tout le rendu (onglets, KPI, positions, modale, mobile) est
// mutualisé avec le compte-titres ; seule la config PEA ci-dessous diffère. Comportement
// identique à l'ancienne page PEA (même moteur, même route, même hash #pea/…).

import type { Viewer } from "../lib/auth-types";
import {
  InvestmentAccountShell,
  type EnvelopeConfig, type InvestmentAccount, type InvestmentHolding, type InvestmentOperation,
} from "./investment-account";

// Alias rétro-compatibles (aucun importeur externe, conservés par prudence).
export type PeaAccount = InvestmentAccount;
export type PeaHolding = InvestmentHolding;
export type PeaOperation = InvestmentOperation;

const PEA_CONFIG: EnvelopeConfig = {
  kind: "PEA",
  accountType: "pea",
  hashPrefix: "pea",
  pageClass: "pea-page",
  logoGlyph: "₧",
  logoClass: "pea-logo",
  singularTitle: (name) => (name ? `PEA de ${name}` : "PEA"),
  aggregateTitle: "Mes PEA",
  subtitle: "Suivez le Plan d’Épargne en Actions : valeur, positions, versements réguliers et performance — calculés à partir de vos opérations réelles.",
  allowAggregate: false,
  thirdCard: "geo",
  sixthKpi: "performance",
  showRegular: true,
  positionsVariant: "pea",
  investCards: ["versement", "achat", "vente", "dividende", "retrait", "frais"],
  modalAdvanced: false,
  faq: [
    { q: "Qu’est-ce qu’un PEA ?", a: "Le Plan d’Épargne en Actions est une enveloppe qui permet d’investir en actions et ETF européens avec une fiscalité avantageuse après 5 ans." },
    { q: "Comment est calculée la valeur ?", a: "Valeur = somme (quantité détenue × cours actuel) + espèces disponibles. Si un cours manque, la position est signalée « cours non disponible » plutôt qu’estimée." },
    { q: "Qu’est-ce que le prix de revient moyen ?", a: "C’est la moyenne pondérée de tous vos achats (frais inclus) rapportée à la quantité détenue. Il sert de référence pour la plus ou moins-value." },
    { q: "Comment lisons-nous la performance ?", a: "« Depuis l’origine » = valeur totale actuelle − montant net investi (versements − retraits). Nous n’affichons pas de TWR/IRR tant qu’ils ne sont pas réellement calculés." },
  ],
  emptyNoAccount: {
    icon: "🏦",
    title: "Aucun PEA n’est encore configuré pour ce membre.",
    description: "Un administrateur peut créer un compte PEA depuis Administration › Comptes & positions. Les opérations et positions apparaîtront ensuite ici.",
    action: "Configurer le PEA",
  },
  emptyNoOperation: {
    icon: "📄",
    title: "Le PEA est configuré, mais aucune opération n’a encore été enregistrée.",
    description: "Enregistrez un versement, un achat d’ETF ou d’actions : la valeur, le prix de revient et la performance se calculeront automatiquement à partir de ces opérations.",
    action: "Enregistrer la première opération",
  },
  resumeNote: "Chaque chiffre est calculé à partir de vos opérations réelles (versements, achats, ventes, dividendes). Le prix de revient utilise la moyenne pondérée. Aucune donnée n’est inventée : si un cours manque, la valeur est signalée comme indisponible.",
};

export function PeaInvestmentPage(props: {
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
  return <InvestmentAccountShell config={PEA_CONFIG} {...props} />;
}
