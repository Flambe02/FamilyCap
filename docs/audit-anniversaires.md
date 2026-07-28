# Audit — onglet Anniversaires

Date : 28 juillet 2026

## Données existantes

- La source de vérité est `public.family_members` (migration `20260716_cap_family.sql`). Elle contient déjà `birthday_day` et `birthday_month` ; `birthday_year` optionnel a été ajouté par `20260719_birth_year.sql`.
- Les photos sont dans `family_members.photo_url` (migration `20260729_member_avatar.sql`) et sont servies depuis le bucket Storage public `avatars`.
- Il ne faut donc ni table dédiée, ni colonne `birth_date` supplémentaire : la combinaison jour/mois/année est déjà le modèle retenu. Elle sera traitée comme une date civile, sans analyser une chaîne `YYYY-MM-DD` ni sérialiser en UTC.
- La route `GET /api/family/birthdays` existe, protégée par `requireFamilyMember`. Son filtre actuel `is_active=eq.true`, son filtre de rôle et l'exclusion des dates incomplètes ne répondent pas au nouvel écran : elle sera étendue pour retourner tous les profils familiaux non supprimés, avec les seules informations nécessaires (`id`, `name`, jour/mois/année, photo).

## Navigation, interface et composants réutilisables

- La navigation est une SPA pilotée par le type `View` et les ancres d'URL dans `lib/navigation.ts` et `app/family-dashboard.tsx` ; ce projet emploie donc les vues et `#…`, plutôt que des routes Next isolées. L'entrée Anniversaires utilisera cette convention, avec l'ancre `#anniversaires`.
- La sidebar desktop et le tiroir mobile partagent `familyNavigation`. Ajouter l'entrée à cette source unique assure un état actif et évite toute duplication. La barre basse reste volontairement limitée à quatre accès ; Anniversaires reste accessible dans le tiroir mobile.
- L'icône `calendar` est déjà disponible via `NavIcon` dans `app/dashboard-ui.tsx`.
- Les panneaux, couleurs, typographies, avatars et états responsive sont fournis par `app/family.css`. Le nouvel écran emploiera les mêmes jetons et des styles préfixés dédiés.
- `Famille & accès` est l'écran d'administration existant ; l'écran Anniversaires ne modifiera ni nom, ni photo, ni date. Seul un lien discret vers cet écran pourra apparaître pour un administrateur lorsqu'une date manque.

## Sécurité et lacunes constatées

- Les tables sont sous RLS ; les lectures métier de cette route passent par le serveur, qui impose `requireFamilyMember` avant son accès Supabase privilégié. Cette frontière est conservée.
- Le statut de connexion et `is_active` ne seront ni sélectionnés ni retournés par la route Anniversaires. Ils n'auront aucun effet sur la liste.
- Une date peut être absente ou partielle (notamment une année inconnue). Toute date sans jour, mois et année civils valides ira dans « Date à compléter » : l'âge ne sera jamais inventé.

## Stratégie retenue

1. Créer `lib/birthdays.ts`, une fonction pure de calcul et de tri des prochaines occurrences. Elle utilisera des objets civils `{ year, month, day }`, `Date.UTC` uniquement comme compteur de jours, et appliquera le 28 février aux naissances du 29 février lors d'une année non bissextile.
2. Étendre l'API existante sans exposer e-mail, rôle, statut, droits ou données financières.
3. Ajouter la vue Anniversaires, la navigation et un écran chaleureux : carte du ou des prochains anniversaires, recherche accent-insensible, groupes par prochain mois et section des dates à compléter.
4. Couvrir les règles de calcul par des tests unitaires : aujourd'hui, demain, changement d'année, 29 février, égalités, valeurs invalides et recherche normalisée.

## Fichiers prévus

- `lib/navigation.ts`
- `app/family-dashboard.tsx`
- `app/api/family/birthdays/route.ts`
- `lib/birthdays.ts` (nouveau)
- `app/birthdays-page.tsx` et `app/birthdays.css` (nouveaux)
- `tests/birthdays.test.mjs` (nouveau)
- `memory.md` du projet parent (journal de session)
