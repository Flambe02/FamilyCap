-- Ajoute Aurore comme membre RÉEL de la famille.
--
-- Contexte : Aurore figurait dans le roster codé en dur (lib/family-roster.ts) mais n'avait
-- jamais été insérée dans public.family_members. Résultat : l'aperçu admin des Paramètres
-- (« Vue Aurore ») affichait « Membre introuvable », et sa tuile apparaissait à 0 dans les
-- répartitions. On la matérialise ici comme les autres enfants (name, role, anniversaire).
--
-- Rôle « child » par défaut (modifiable ensuite dans Utilisateurs & accès). Anniversaire 27/08,
-- cohérent avec l'historique des cadeaux (lib/gift-history.ts). Idempotent : rejouable sans
-- créer de doublon (contrainte d'unicité sur name).
insert into public.family_members (name, role, birthday_day, birthday_month)
values ('Aurore', 'child', 27, 8)
on conflict (name) do nothing;
