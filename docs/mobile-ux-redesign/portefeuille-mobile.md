# Portefeuille — inventaire fonctionnel (mobile)

Source : `app/gift-portfolio.tsx` (+ `gift-portfolio.css`). Composant `GiftPortfolio`, rendu dans l'onglet **Portefeuille** de la barre de menu mobile.

Deux rendus du **même composant** selon le rôle (`viewer.role === "admin"`) :
- **Vue membre** (`.member-portfolio`) — un enfant ne voit que *son* portefeuille, aucune action de gestion.
- **Vue admin** (`.admin-portfolio`) — Florent voit le portefeuille de n'importe quel enfant + tous les outils de gestion/rapprochement.

But de ce document : lister **toutes** les fonctionnalités actuelles (pas seulement le style) pour permettre une refonte mobile de zéro. Chaque item est marqué **[Membre]**, **[Admin]** ou **[Commun]**.

---

## 1. Sélection du portefeuille affiché

- **[Admin]** Sélecteur de personne (« À qui appartient ce portefeuille ? ») : 5 pastilles (avatar coloré + initiales + prénom + date d'anniversaire), tap pour changer de portefeuille affiché. *(Vient d'être corrigé pour ne plus défiler horizontalement sur mobile — enroulement sur 2 lignes.)*
- **[Membre]** Pas de sélecteur : le portefeuille affiché est toujours celui du membre connecté (verrouillé sur `viewer.name`).
- **[Admin]** Bandeau « Prochain anniversaire de {X} : {date} · dans N jours ».

## 2. Bloc « hero » (résumé du portefeuille)

- **[Commun]** Orbe décorative (pièce Bitcoin stylisée) en fond de carte — purement visuelle.
- **[Commun]** Badge « Portefeuille de {prénom} ».
- **[Commun]** Ligne « Anniversaire le {date} · cadeau de Noël le 25 décembre ».
- **[Admin]** Bouton « + Saisir un cadeau » (ouvre l'éditeur de cadeau, voir §8).
- **[Commun]** **Valeur actuelle** en gros (Georgia serif) : montant € si le cours BTC est disponible, sinon quantité BTC brute (` BTC` en fallback) — *point de friction identifié : ce fallback affiche un nombre à 8 décimales qui peut déborder sur mobile (corrigé en `clamp()` récemment)*.
- **[Commun]** Ligne meta : quantité BTC totale + montant € investi à l'époque.
- **[Commun]** Deux compteurs cliquables inline : 🎄 nombre de Noëls, 🎂 nombre d'anniversaires — chaque tap ouvre **Mouvements** filtré sur les cadeaux de ce membre.
- **[Commun]** Ligne de métriques marché (3 valeurs) :
  - **PRU moyen pondéré** (prix de revient unitaire, calculé : total € investi / total BTC).
  - **Plus-value / moins-value totale** (valeur actuelle − investi), en €, avec un badge coloré (vert si positif, rouge si négatif, gris si cours indisponible) + pourcentage.
  - **Cours du Bitcoin** actuel (« 1 BTC = X € ») ou « Cours indisponible ».
- **[Commun]** Onglets d'enveloppe patrimoniale : **Total** / **Bitcoin** (actif) / **PEA** (désactivé, « Bientôt ») / **Compte-titres** (désactivé, « Bientôt ») — préfigure un futur multi-actifs.
- **[Commun]** Panneau « Total » : 3 mini-stats (valeur Bitcoin, PEA/CTO « Bientôt disponibles », total suivi).
- **[Commun]** Barre d'allocation (uni-actif à 100 % Bitcoin aujourd'hui) + note « PEA et compte-titres rejoindront cette vue ».

## 3. Message de statut

- **[Commun]** Bandeau transitoire (`gift-message`) affichant le résultat de la dernière action (ex. « Cadeau supprimé. », « Demande de transfert envoyée à Florent. »).

## 4. Carte « Où sont les bitcoins ? » (garde des actifs)

- **[Commun]** Barre **Ledger personnel** : quantité BTC + %, barre de progression, tap → **Mouvements** filtré « Ledger ».
- **[Commun]** Barre **Binance commun** : idem, tap → **Mouvements** filtré « Binance ».
- **[Admin]** Si des BTC sont « à rapprocher » (non classés) : bouton dépliant qui affiche la liste des cadeaux à classer, avec bouton « Classer / valider » par ligne (ouvre l'éditeur, voir §8).
- **[Commun]** Disclosure (`<details>`) : « Comprendre où sont tes bitcoins » (texte pédagogique côté membre) / « Voir le détail et l'adresse publique » (côté admin, avec en plus le solde public de l'adresse Ledger, sa valeur € et un lien externe vers l'explorateur Blockstream).

## 5. Raccourcis chiffrés (3 boutons)

- **[Commun]** « X cadeaux documentés » → Mouvements filtré (documentés).
- **[Commun]** « X cadeaux passés à compléter » → Mouvements filtré (à traiter). Libellé du bouton change (« Traiter → » si > 0, sinon « Vérifier → »).
- **[Admin]** « X transactions Ledger publiques » → Mouvements filtré (blockchain).
- **[Membre]** « X BTC encore sur Binance commun » → Mouvements filtré (Binance).

## 6. Historique des cadeaux (chronologie)

- **[Commun]** En-tête cliquable « Histoire des cadeaux » → ouvre Mouvements filtré sur tous les cadeaux du membre.
- **[Commun]** Groupé par année, chaque année est un `<details>` repliable (l'année la plus récente ouverte par défaut).
- Par cadeau :
  - **[Commun]** Icône d'occasion (✦ Noël / ♛ Anniversaire), titre narratif (« Le cadeau de Noël d'Amatxi »), date d'achat (ou état « à venir » / « à compléter » si le cadeau attendu n'a pas encore été saisi).
  - **[Commun]** Commentaire optionnel affiché en italique.
  - **[Commun]** Montant : quantité BTC + € (frais inclus) ; si cadeau attendu non saisi → « 55,00 € · BTC à saisir ».
  - **[Commun]** Prix moyen BTC de l'achat affiché sous le montant.
  - **[Admin]** Marqueur d'écart (`*`) si le montant reçu sur Ledger diffère du montant acheté — dépliant qui explique l'écart (frais, etc.).
  - **[Commun]** Puce de garde (« chip ») : Ledger / Binance commun / À rapprocher / manquant, avec un texte de détail qui change de formulation entre admin (technique) et membre (pédagogique — ex. « Transfert déjà réalisé », « Florent vérifiera l'emplacement »).
  - **[Admin]** Actions : Modifier / Renseigner, Supprimer (sauf si verrouillé côté Ledger — alors bouton « Désassocier Ledger »).
  - **[Membre]** Action « Demander le transfert » si le cadeau est sur Binance commun (désactivée une fois la demande envoyée, texte devient « Transfert demandé »). **Absente en mode aperçu lecture seule.**

## 7. Outils réservés à l'administrateur (invisibles côté membre)

Ces blocs n'existent **jamais** dans la vue membre — à garder en tête pour la refonte car ils partagent l'écran avec le contenu membre sur desktop, mais devraient être clairement séparés (ou déplacés) sur mobile :

- **[Admin] Atelier de rapprochement Binance → Ledger** (« TransferWorkbench ») : file des réceptions Ledger (montant reçu / déjà attribué / disponible), bouton « Préparer un rapprochement » ouvrant une modale à 3 étapes (choisir la réception → cocher les achats Binance à débiter → contrôler le résumé débit/crédit/écart avec motif obligatoire si écart → enregistrer).
- **[Admin] Transactions blockchain en lecture seule** : liste des mouvements on-chain avec lien vers Blockstream.
- **[Admin] Demandes des enfants** : liste des demandes de transfert en attente, avec sélecteur de statut (Nouvelle / En traitement / Transférée).

## 8. Éditeur de cadeau (modale plein écran, admin uniquement)

Formulaire en une seule page, 3 sections :
1. **Le cadeau** : enfant, occasion, date du cadeau.
2. **L'achat Bitcoin** : montant € (frais inclus), quantité BTC achetée, commentaire libre.
3. **Où sont les bitcoins ?** : choix Binance commun / Ledger personnel ; si Ledger → association manuelle à une réception blockchain (liste des transactions reçues, quantité déjà associée/disponible), champ TxID manuel, vérification blockchain via API, et mécanisme de « forçage » (la quantité achetée reste la référence même si le Ledger a reçu moins) avec explication obligatoire.

---

## Constats UX à retenir pour la refonte

1. **Le débordement mobile est réel** : la carte « hero » condense énormément d'information dense (5 métriques + 2 onglets + panneau) dans un espace vertical réduit — c'est l'écran le plus chargé de l'app sur mobile.
2. **Deux publics, un seul écran** : la vue admin ajoute ~6 blocs entiers (picker, anniversaire, rapprochement, blockchain, demandes, éditeur) qui n'existent pas côté membre — sur mobile, ce mélange peut justifier une séparation plus nette (ex. onglet « Portefeuille » simplifié pour les membres, outils admin regroupés ailleurs — le menu portable actuel a déjà commencé ce travail pour la navigation générale).
3. **Taxonomie de garde des actifs** (Ledger / Binance commun / À rapprocher) est *la* colonne vertébrale de tout l'écran (barres, puces, raccourcis, filtres de Mouvements) — toute refonte doit la préserver ou la remplacer consciemment partout à la fois.
4. **Le fallback « cours indisponible »** change beaucoup de textes en cascade (valeur affichée en BTC brut, plus-value → « Cours indisponible », etc.) — un état à concevoir soigneusement plutôt qu'en dernier recours.
5. **Navigation croisée** : quasiment tout renvoie vers Mouvements avec un filtre pré-appliqué (raccourci actif affiché comme un chip effaçable) — c'est un pattern de navigation contextuelle fort, à conserver dans la refonte.
