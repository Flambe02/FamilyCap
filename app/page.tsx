import { AuthShell } from "./auth-shell";
import "./family.css";
// Design system partagé (.btc-*) : consommé par PEA/CTO (investment-account.tsx), « Comprendre »,
// le portefeuille et le tableau de bord — pas seulement par l'écran Bitcoin. Chargé ici pour que la
// cascade soit déterministe et ne dépende plus du parcours de navigation : sans cet import, un accès
// direct à PEA/CTO sans être passé par Bitcoin rendait l'écran sans styles (chunk CSS jamais requêté).
// bitcoin-investments.tsx garde son propre import (même module → un seul <link>), et les surcharges
// pea/cto/lesson-pea-portfolio, chargées après, continuent de gagner.
import "./bitcoin-investments.css";
// Styles des Défis (.cha-*, tous préfixés → aucune fuite) : la carte « Mes défis » est rendue sur
// le TABLEAU DE BORD, donc dès le premier écran. Sans cet import, elle s'afficherait brièvement
// sans styles le temps que le chunk de l'écran Défis arrive.
import "./challenges.css";
// Finitions mobile / PWA (≤780px uniquement). Chargé en dernier, mais les feuilles d'écran
// arrivant en chunks dynamiques peuvent passer après : les sélecteurs y sont qualifiés par
// `.app-shell` pour ne pas dépendre de l'ordre de la cascade.
import "./mobile-pwa.css";

export default function Home() {
  const version = process.env.NEXT_PUBLIC_APP_VERSION ?? "local";
  return <div className="version-shell"><AuthShell /><span className="app-version" title={`Commit Git ${version}`}>Version {version}</span></div>;
}
