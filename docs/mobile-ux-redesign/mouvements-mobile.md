# Mouvements (Transactions) — inventaire fonctionnel (mobile)

Source : `app/transactions.tsx` (+ `transactions.css`). Composant `TransactionsView` (écran) et `InvestmentModal` (saisie), rendus dans l'onglet **Mouvements** de la barre de menu mobile. Libellé interne « Transactions », renommé « Mouvements » pour le menu mobile.

Même logique que le Portefeuille : **un seul composant, deux comportements** selon `isAdmin`. **[Membre]** / **[Admin]** / **[Commun]** comme dans l'autre document.

---

## 1. D'où viennent les lignes affichées (à connaître avant toute refonte)

Le tableau ne lit pas une seule source — il **fusionne 3 origines** par une clé `membre|occasion|année` :
1. **Historique figé** (`GIFT_HISTORY`, `initialTransactions`) — les cadeaux passés déjà connus, saisis une fois pour toutes dans le code.
2. **Cadeaux live** (`/api/gifts`) — écrase l'historique si une valeur plus à jour existe en base (montant, quantité, date, note).
3. **Transactions on-chain live** (`/api/ledger`, `authorRole:"Blockchain"`) — les mouvements publics du Ledger de chaque enfant, avec un **PRU recalculé** à partir des cadeaux Binance associés (ou, à défaut, moyenné sur l'ensemble des achats Ledger du portefeuille).
4. **Lignes synthétiques « attendues »** — pour l'année en cours, si un anniversaire/Noël est déjà passé (`date <= aujourd'hui`) et qu'aucune ligne n'existe encore, une ligne fantôme est générée : « Achat Binance non visible : action administrateur requise. », montant 55 €, aucune quantité.

**Conséquence UX** : le nombre de lignes et leur contenu changent dynamiquement selon la date du jour et la disponibilité des API — un état de chargement/erreur soigné est important (aujourd'hui, une ligne peut apparaître avec `—` partout si une API échoue silencieusement).

## 2. Bandeau d'introduction (« transactions-guide »)

- **[Commun]** Pastille « REGISTRE PARTAGÉ ».
- **[Commun]** Titre + sous-titre qui changent totalement de ton entre rôles :
  - Admin : « Toutes les opérations, expliquées simplement. » / « Chaque ligne indique qui a investi, pour quel enfant, où se trouve l'actif et qui a saisi l'information. »
  - Membre : « Tes cadeaux Bitcoin, tout simplement. » / « Retrouve les cadeaux qui te sont attribués et suis leur évolution, sans jargon administratif. »
- **[Admin]** Mode d'emploi visuel en 3 étapes (Cliquer sur « Ajouter » → Recopier l'opération → Vérifier puis enregistrer).
- **[Admin]** Bouton « + Saisir une opération » → ouvre `InvestmentModal` (voir §6).
- **[Membre]** Aucun bouton d'ajout, aucune étape : bloc purement informatif, plus compact (déjà mis en page mono-colonne côté CSS pour la vue membre).

## 3. Barre d'outils du tableau

- **[Commun]** « HISTORIQUE » + « N transactions affichées ».
- **[Commun]** Si l'écran a été ouvert depuis un raccourci du Portefeuille (ex. « Voir les cadeaux de Noël »), un **chip de contexte actif** apparaît avec le libellé du raccourci et un bouton « Effacer le filtre × ». C'est le seul indice, côté membre, qu'un filtre est appliqué.
- **[Admin]** Deux menus déroulants : **Enfant** (Tous / prénom) et **Localisation** (Tous / Ledger / Binance / À classer).
- **[Membre]** Aucun filtre visible — mais en interne, la vue membre est **toujours** filtrée sur `transaction.member === viewerName` (un enfant ne voit jamais les lignes des autres, même sans UI de filtre).
- **[Commun]** Bandeau de retour après suppression (succès en vert / erreur en rouge).

## 4. Le tableau (aujourd'hui devenu des cartes empilées sur mobile)

Colonnes / champs par ligne :

| Champ | Contenu | Notes |
|---|---|---|
| **Date** | Date du cadeau/mouvement | Format court FR |
| **Bénéficiaire** | Prénom de l'enfant | Toujours visible même côté membre (répétitif si un seul enfant peut voir ses propres lignes — candidat à simplifier) |
| **Opération** | Emoji d'occasion (🎂/🎄) + nature + sous-texte | Sous-texte diffère : admin voit le compte technique (« Binance commun », « Ledger personnel · blockchain »…), membre voit une phrase reformulée (« Bitcoin attribué · transfert à venir », « Cadeau Bitcoin enregistré », « Transaction publique Ledger ») |
| **Montant / PRU** | Montant € investi + prix de revient unitaire calculé | « — » et « PRU à rattacher » si quantité ou montant manquants |
| **Quantité** | BTC (8 décimales) ou « À saisir » | |
| **Valeur actuelle** | BTC × cours actuel, + delta de performance (vert/rouge/gris) | « Cours indisponible » si le prix BTC n'a pas pu être chargé ; « Transfert sans PRU » si une valeur existe sans PRU de référence |
| **Saisie par** | Badge auteur (« Administrateur », prénom de l'enfant en style distinct, ou lien « Blockchain ↗ » vers Blockstream si la transaction est on-chain et le TxID valide) | |
| **Localisation** *(admin uniquement)* | Puce Ledger / Binance / À classer | Calculée par `transactionLocation()` — la même taxonomie qu'au Portefeuille |
| **Actions** | Voir §5 | |

## 5. Actions par ligne

- **[Admin]** Si la ligne nécessite une action (`status !== "Confirmée"` et pas une transaction blockchain) : bouton « Préparer le transfert » (si en attente de transfert) ou « Classer / valider » — renvoie vers le **Portefeuille** de cet enfant.
- **[Admin]** Bouton « Supprimer » si la ligne est supprimable (pas une transaction blockchain, pas déjà sur Ledger) — confirmation navigateur, puis suppression via l'API et retrait optimiste de la liste.
- **[Membre]** Bouton « Demander le transfert » si le statut est « À transférer » (le cadeau est encore sur Binance commun) — déclenche la même action que le bouton équivalent du Portefeuille.
- **[Commun]** Aucune action si la ligne est une transaction blockchain confirmée ou déjà entièrement traitée.

## 6. Saisie guidée (`InvestmentModal`, admin uniquement)

Modale à 3 étapes avec indicateur de progression :
1. **Qui fait quoi ?** — enfant bénéficiaire, personne qui saisit, nature de l'opération (Investissement mensuel / Anniversaire / Noël / Transfert vers Ledger / Achat PEA / Vente).
2. **Recopier les chiffres** — compte/enveloppe, actif (texte libre), montant €, quantité reçue, date, référence/TxID optionnel.
3. **Dernière vérification** — récapitulatif en liste + champ note pédagogique libre (« Pourquoi cet achat ? Qu'as-tu appris ? »).

Cette modale alimente un état local (`transactions` dans `FamilyDashboard`) séparé des vraies données `/api/gifts` — **à noter** : les opérations saisies ici ne sont donc pas forcément persistées de la même façon que les cadeaux du Portefeuille (deux chemins d'écriture différents à unifier dans une refonte).

## 7. État vide

- **[Commun]** « Aucune opération ne correspond à ces filtres. » si la liste filtrée est vide.

---

## Constats UX à retenir pour la refonte

1. **Un tableau de bureau devenu cartes** : la table HTML (7-8 colonnes) a été convertie récemment en cartes verticales sur mobile via CSS (`data-label` + `content: attr()`), mais la **densité d'information par ligne reste celle d'un tableau desktop** (7 champs empilés par carte). Une vraie refonte mobile devrait repenser la hiérarchie (ex. montant + statut en avant, détails secondaires repliables) plutôt que garder 100 % des colonnes.
2. **La colonne « Bénéficiaire » est un point mort côté membre** : un enfant ne voit que ses propres lignes, donc afficher son propre prénom sur chaque carte n'apporte rien — c'est de l'espace vertical mobile perdu.
3. **Absence totale de filtre côté membre** aujourd'hui, alors que l'historique peut couvrir plusieurs années (Noël + anniversaire × plusieurs années) — sur mobile, un filtre simple (Ledger / Binance / À venir), déjà esquissé ailleurs dans l'app, manque ici pour l'instant côté implémentation réelle.
4. **Le chip de contexte actif** (venant d'un raccourci Portefeuille) est une bonne mécanique de navigation contextuelle à conserver, mais son effacement ramène à *tous* les mouvements sans mémoriser qu'on vient d'un membre précis.
5. **Deux chemins d'écriture distincts** (modale de saisie admin vs formulaire du Portefeuille) à fusionner idéalement dans une refonte, pour éviter une source de vérité dupliquée.
6. **Le calcul du PRU on-chain** (récupéré des cadeaux Binance associés, sinon moyenné sur tout le Ledger) est une donnée dérivée assez subtile qui mériterait d'être expliquée à l'utilisateur (aujourd'hui uniquement visible dans le texte de la note, pas dans l'UI).
