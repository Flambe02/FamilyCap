export type Viewer = {
  id: string;
  email: string;
  name: string;
  role: "admin" | "adult" | "child" | "viewer";
  birthdayDay?: number | null;
  birthdayMonth?: number | null;
  birthdayYear?: number | null;
  photoUrl?: string | null;
  walletAddress?: string | null;
};

/**
 * DEUX VOCABULAIRES DE RÔLE COEXISTENT, et les confondre coûte cher :
 *   • le rôle FAMILIAL, stocké en base et porté par Viewer : admin | adult | child | viewer ;
 *   • le rôle CONSOLE, renvoyé par /api/admin/users pour l'écran d'administration, qui replie
 *     `adult` ET `child` sur un unique `member` (et l'administrateur principal sur `super_admin`).
 *
 * L'aperçu « Vue <membre> » reconstruit un Viewer à partir de la réponse d'administration : sans
 * conversion, son rôle valait « member », qui ne correspond à AUCUNE branche `adult`/`child`.
 * Résultat : défis, classement et checklist d'accueil disparaissaient de l'aperçu, sans erreur ni
 * requête réseau — donc sans rien à voir dans les journaux.
 */
export function toFamilyRole(role: string | null | undefined): Viewer["role"] {
  switch (String(role ?? "").toLowerCase()) {
    case "admin":
    case "super_admin":
      return "admin";
    case "viewer":
      return "viewer";
    case "child":
      return "child";
    // `member` (vocabulaire console) et `adult` désignent la même chose côté famille.
    case "adult":
    case "member":
      return "adult";
    // Rôle inconnu ou absent : on retombe sur le MOINS privilégié plutôt que sur `adult`.
    default:
      return "viewer";
  }
}

/**
 * Tout profil familial voit les défis, le classement et la checklist d'accueil.
 * Les permissions d'ÉCRITURE restent vérifiées par les routes concernées : la visibilité du
 * parcours « Bien démarrer » ne doit pas dépendre du droit d'enregistrer une opération.
 */
export function isChallengeEligible(role: string | null | undefined): boolean {
  // `toFamilyRole()` garde le repli le moins privilégié (`viewer`) pour un rôle inconnu ; ce
  // rôle doit néanmoins pouvoir découvrir et suivre ses étapes, comme Amatxi.
  void toFamilyRole(role);
  return true;
}
