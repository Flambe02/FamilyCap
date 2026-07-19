# Accueil (Vue famille) — inventaire fonctionnel (mobile)

Source : `app/family-dashboard.tsx`, fonction `Dashboard` (+ styles `family.css`). C'est l'écran affiché par défaut à la connexion, premier onglet de la barre de menu mobile.

**Différence structurelle majeure avec Portefeuille et Mouvements : cet écran n'a *aucune* branche `isAdmin`.** Tout le monde — Florent comme un enfant — voit exactement le même contenu : toute la famille, tous les membres, la même mission, le même journal. C'est un écran de **transparence familiale totale**, pas un écran personnel. Convention **[Commun]** utilisée partout ci-dessous puisqu'il n'y a pas de variante membre/admin sur cet écran précis (contrairement aux deux autres documents).

---

## 0. Éléments globaux partagés (rendus par `FamilyDashboard`, pas par `Dashboard`)

Non détaillés ici (déjà redessinés lors des sessions précédentes) mais présents sur cet écran comme sur les 4 autres :
- Barre du haut : avatar → tiroir de menu, date + titre, pastille de cours BTC.
- Bannière d'aperçu (si un admin prévisualise un membre) ou tiroir « Voir l'app comme ».
- Barre de menu du bas (5 onglets) + bouton flottant « + » (ouvre la même modale `InvestmentModal` que 3 autres endroits de cet écran, voir §7).

## 1. Hero « Bonjour »

- Pastille « ● SITUATION AUJOURD'HUI ».
- Titre « Bonjour 👋 La famille avance bien. » + phrase d'état fixe (« Le suivi Bitcoin est prêt. La prochaine étape est de compléter les achats manquants puis de rapprocher Binance et les Ledger. »).
- **Ce texte est statique** : il ne reflète pas le nombre réel d'achats manquants ni l'état réel du rapprochement — c'est un message d'accueil générique, jamais mis à jour dynamiquement.
- CTA « Voir les portefeuilles → » (mobile uniquement) → onglet Portefeuille.
- CTA « + Ajouter une opération » (desktop ; sur mobile, cette action vit dans le bouton flottant) → ouvre `InvestmentModal`.
- Orbe décorative (pièce Bitcoin stylisée), purement visuelle.

## 2. Bandeau calendrier familial

- Calcule et affiche le **prochain événement** (anniversaire ou Noël) parmi tous les membres, avec un compte à rebours (« dans N jours » / « Ce jour »).
- Regroupe les anniversaires simultanés du même mois (« Prochains anniversaires de Uhaina et Aurore : 16 et 17 août »).
- **Calculé côté client** à partir d'une liste de membres **codée en dur** dans ce fichier (`members`), distincte de la liste utilisée par le Portefeuille (`people` dans `gift-portfolio.tsx`) — les deux listes divergent réellement aujourd'hui (la date d'anniversaire d'Aurore n'est pas la même dans les deux fichiers), donc ce bandeau peut afficher une date différente de celle vue dans le Portefeuille du même enfant.

## 3. Indicateurs clés (3 cartes)

- **Valeur Bitcoin actuelle** : total € de tous les membres (réel, calculé à partir des cadeaux chargés + cours BTC live) ou « Cours indisponible » / « Mise à jour… ».
- **À compléter** : « N achats » — **valeur statique**, somme codée en dur des champs `missing` du tableau `members` (5+4+4+4+5=22), **pas un calcul réel** des cadeaux manquants (contrairement au Portefeuille, qui calcule un `missing` réel par membre).
- **Prochain événement** : jour + mois + libellé (anniversaire / Noël), dérivé du même calcul que le bandeau calendrier.

## 4. Vue d'ensemble des membres (carrousel de cartes)

Pour chacun des 5 membres (carte tactile, tap pour naviguer) :
- Avatar coloré + initiales, pastille « À vérifier » (texte fixe, jamais d'autre état).
- Prénom + date d'anniversaire.
- Valeur Bitcoin actuelle du membre (réelle, ou « — » / « Cours BTC indisponible »).
- Barre de progression « cadeaux documentés » — calculée par une formule arbitraire (`max(18, 100 − missing×12)`) à partir du même champ `missing` **statique** (voir §3), donc pas un vrai pourcentage de complétude.
- Pied de carte : quantité BTC attribuée (réelle) + « N à saisir » (statique, même champ `missing`).
- **Tap sur la carte** → ouvre l'onglet Portefeuille sur ce membre. **Point de vigilance déjà identifié** : pour un membre non-admin, `GiftPortfolio` ignore le membre demandé et rouvre toujours *son propre* portefeuille, quelle que soit la carte tapée (bug de confiance : le tap sur la carte d'un frère/soeur ne fait rien d'utile côté membre).

## 5. Mission du mois

- Bandeau « MISSION DE JUILLET · Faire travailler 55 € » avec :
  - Anneau de score (« 1/5 membre à jour ») — nombre statique.
  - Étiquette de niveau + durée (« NIVEAU DÉBUTANT · 8 MIN »).
  - Titre + description de la mission du mois (texte fixe : « Découvrir l'investissement régulier »).
  - Rangée d'avatars superposés (TH, UH, PA, AU, TO) + « 4 réponses attendues » (statique).
  - Bouton rond « → » (desktop only, masqué sur mobile) → onglet Missions.
- Action d'en-tête « Toutes les missions » → onglet Missions.

## 6. Journal d'activité récente

- Liste des 4 dernières activités (marque = initiale du membre, libellé, détail, horodatage relatif).
- **Alimenté uniquement par un état local React initialisé à 2 entrées codées en dur** (`Cadeau anniversaire` de Thibault, `Mission publiée`) — **aucun appel à une API**, aucune persistance. Une nouvelle entrée n'est ajoutée en tête de liste que lorsqu'une opération est saisie via `InvestmentModal` pendant la session en cours ; elle disparaît au rechargement de la page.
- Action d'en-tête « Ajouter » → ouvre la même `InvestmentModal` que le hero et le bouton flottant (3e point d'entrée vers la même action).

## 7. Modale de saisie (`InvestmentModal`)

Guidée en 3 étapes (identique à celle utilisée depuis Mouvements — voir l'autre document, §6) : qui/qui saisit/nature → compte/actif/montant/quantité/date/référence → récapitulatif + note. Accessible ici depuis **3 déclencheurs différents** sur ce seul écran (hero, bouton flottant, journal), tous équivalents.

---

## Constats UX à retenir pour la refonte

1. **Beaucoup de chiffres affichés ne sont pas réels.** « 22 achats à compléter », les barres de progression par membre, le score de mission « 1/5 », les « 4 réponses attendues » sont tous des valeurs codées en dur, pas des calculs sur les vraies données — alors que la « Valeur Bitcoin actuelle » (globale et par membre) est, elle, bien réelle. Un utilisateur ne peut pas distinguer visuellement ce qui est du vrai suivi de ce qui est un gabarit non branché. Une refonte devrait soit brancher ces chiffres sur les vraies données (le Portefeuille sait déjà calculer un `missing` réel par membre), soit clairement les présenter comme un exemple/à venir.
2. **Deux sources de vérité pour les membres et leurs anniversaires** (`members` ici vs `people` dans le Portefeuille) qui ont divergé dans les faits — à fusionner en une seule source partagée avant toute refonte visuelle, sinon le nouvel écran reproduira la même incohérence.
3. **Le tap sur une carte de membre est un « faux » lien pour un enfant** (rouvre toujours son propre portefeuille) — cf. même constat déjà noté pour le Portefeuille. Une refonte doit soit rendre ce tap réellement fonctionnel pour l'aperçu en lecture seule des autres membres, soit ne pas donner l'affordance de carte cliquable aux cartes des autres membres.
4. **Le journal d'activité ne survit pas à un rafraîchissement de page** — purement local à la session React. Pour qu'un « fil d'activité familial » soit crédible, il faudrait le persister (ex. dans la même base que les cadeaux/transferts).
5. **Trois chemins différents ouvrent la même modale d'ajout** (hero, bouton flottant, journal) sans différence de contexte pré-rempli — une refonte pourrait n'en garder qu'un seul (le bouton flottant, déjà en zone de pouce) et supprimer les doublons, ou au contraire leur donner un contexte différent (ex. le bouton du journal pré-sélectionnerait « aujourd'hui »).
6. **Aucune personnalisation par rôle** sur cet écran alors que Portefeuille et Mouvements en ont beaucoup : à décider consciemment si Accueil doit rester un tableau de bord familial commun (transparence assumée) ou si, en cohérence avec les deux autres refontes déjà faites (vue utilisateur épurée sans les outils admin), un enfant devrait voir une version simplifiée de ce tableau de bord familial lui aussi.
