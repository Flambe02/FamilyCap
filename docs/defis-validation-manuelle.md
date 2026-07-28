# Validation manuelle — Défis

1. Appliquer `supabase/migrations/20260818_challenges_templates_v3.sql` dans le SQL Editor,
   après les migrations Défis déjà présentes. Vérifier que le modèle mensuel « Création PEA » est
   `archived`, sans suppression de `points_ledger` ni `challenge_participants`.
2. Avec un nouveau membre : ouvrir Défis, créer un PEA, définir le rythme, importer/saisir le
   portefeuille puis enregistrer un premier achat. Après chaque transition réelle, revenir à
   Défis et vérifier le message de réussite, les points et la prochaine étape.
3. Avec un membre déjà configuré : ouvrir Défis une fois. Les missions correspondantes doivent
   être reconnues, sans nouvelle opération ni doublon de point après actualisation.
4. Avec l'admin : ouvrir Gestion des défis, modifier le titre/CTA d'une mission, désactiver puis
   réactiver une mission. Vérifier que le membre voit le contenu mis à jour et que les slugs et
   historiques restent inchangés.
5. En aperçu membre admin : sélectionner un membre, ouvrir Défis. Vérifier la bannière lecture
   seule, l'absence d'action de participation/enregistrement et les données du membre aperçu.
6. Pour le défi mensuel actuel : rejoindre une fois, enregistrer un achat réel sur le compte cible
   puis recharger. Vérifier une seule participation, une progression dérivée de l'opération et une
   seule attribution de points.
7. Mobile (largeur <= 780 px) : vérifier les boutons de mission, le formulaire, le message de
   réussite et l'absence de table Défis horizontale.
8. Activer « réduire les animations » au niveau système et vérifier que la réussite reste lisible
   et immédiatement navigable.
