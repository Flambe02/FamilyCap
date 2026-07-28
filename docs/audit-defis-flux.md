# Audit — flux Défis

Date : 28 juillet 2026. Audit effectué avant les corrections de cette livraison.

## Conclusion

Le dépôt possède déjà deux mécanismes distincts qui partageaient une même table : les défis
mensuels (`monthly_investment`) et les quatre missions permanentes (`onboarding_mission`). Les
points et les opérations sont correctement centralisés, mais les missions avaient une seconde
source de contenu TypeScript et l'administration les affichait en lecture seule. Le doublon
« Création PEA » est sémantique : un ancien défi mensuel répète la mission permanente de
configuration du compte.

## Architecture constatée

| Sujet | État vérifié |
| --- | --- |
| Tables Défis | `challenges`, `challenge_participants`, `challenge_operation_links`, `points_ledger` ; `financial_accounts`, `account_operations`, `user_investment_plan` sont les sources de faits du parcours. |
| Modèles | Lignes `challenges` avec `challenge_type`. Les slugs onboarding sont stables. Avant v3, les textes et CTA onboarding étaient également dans `lib/onboarding-challenges.ts`. |
| Opérations et positions | `account_operations` est la source unique ; `computeAccountModel` dérive les positions. Aucune table de positions parallèle n'est créée. |
| Points | `points_ledger` est immuable. La RPC `apply_challenge_points` porte l'unicité par `idempotency_key`; l'onboarding utilise `onboarding_completion:<slug>:<memberId>`. |
| Défi mensuel | Participation unique `(challenge_id, member_id)`, objectif mensuel figé à l'inscription, réconciliation à partir des achats réels éligibles. |
| Onboarding | Réconciliation sur les comptes, plan et opérations réels du membre. Une mission terminée n'attribue ses points qu'une fois. |
| API membre | `/api/challenges`, `/current`, `/current/join`, `/current/progress`, `/onboarding`, `/points`, `/summary`, `/leaderboard`. Toutes appellent `requireFamilyMember`. |
| API admin | `/api/admin/challenges` et `/api/admin/challenges/participants`, protégées par `requireAdmin`. |
| Navigation | SPA Next.js avec l'état `View` et le hash `#defis`, pas encore de segments `/defis` ou `/admin/defis`. La vue membre est `investissements-suggestions`, l'admin `administration-suggestions`. |
| Aperçu membre | `?asMember` n'est accepté que pour l'admin et les routes de lecture désactivent la réconciliation mutante. L'UI affiche la vue membre avec `canAct=false`. |
| RLS | Les tables Défis ont RLS de lecture ; les écritures sensibles transitent par la clé service-role et des routes contrôlées. La frontière réellement appliquée est `lib/auth-server.ts`. |

## Réponses aux anomalies

1. Les missions ne sont pas dupliquées techniquement dans la liste mensuelle : les requêtes
   mensuelles filtrent `challenge_type=monthly_investment`.
2. Le doublon visible « Configure ton PEA » / « Création PEA » est un doublon **sémantique** :
   une mission permanente et un modèle mensuel poursuivent la même action.
3. Les quatre missions étaient effectivement non modifiables :
   `updateChallenge()` refusait tout type différent de `monthly_investment`, l'API admin le
   documentait et l'écran les présentait comme « Préconfiguré ».
4. Les actions membre sont déjà focalisées : comptes et rythme utilisent des intentions d'URL,
   portefeuille et premier achat ouvrent respectivement l'import et le formulaire PEA. Les
   complétions sont déterminées côté serveur, pas par le client.
5. L'écran de réussite existe déjà dans `challenges-page.tsx` et n'est ouvert qu'après retour
   serveur (`justCompleted` ou marqueur de session confirmé). Il ne faut pas le déclencher à
   chaque consultation.
6. Une opération créée depuis `/api/investment-operations` est validée par le moteur partagé,
   écrite dans `account_operations`, puis réconciliée. Le contexte ne distingue pas encore une
   recommandation mensuelle figée : ce moteur de recommandation n'est pas présent dans le dépôt.
7. Le bouton « Défis » membre pointe vers `investissements-suggestions`; le risque historique
   venait des noms d'états proches et de l'architecture SPA, pas d'une route admin protégée mal
   gardée. Les routes URL recommandées restent une évolution structurante non effectuée ici.

## Corrections de cette livraison

- Migration `20260818_challenges_templates_v3.sql` : champs de présentation administrables,
  ordre des missions et archivage réversible du modèle mensuel « Création PEA ». Elle ne supprime
  ni opérations, ni participants, ni points.
- `lib/onboarding-challenges-service.ts` lit désormais les libellés, points, CTA, texte de
  réussite, ordre et activation depuis `challenges`; un repli compatible maintient le parcours
  opérationnel avant application de la migration.
- `/api/admin/challenges` et `admin-challenges.tsx` permettent d'éditer les missions
  onboarding sans changer leurs slugs. Les points déjà attribués restent les écritures
  historiques immuables du ledger.

## Risques et plan de migration

1. Appliquer `20260818_challenges_templates_v3.sql` manuellement après les migrations Défis
   existantes. Elle archive le modèle mensuel portant exactement le titre `Creation PEA` ou
   `Création PEA`; vérifier auparavant les titres localisés inhabituels.
2. Une modification de points ne réécrit jamais `points_ledger`; elle ne concerne donc que les
   futures complétions. Une version de règle complète (snapshot de template par instance) reste
   nécessaire avant de modifier les règles de validation métier.
3. Le dépôt ne contient pas encore de moteur de recommandation mensuelle persistée, de table de
   recommandation ni de RPC atomique recommandation + achat + défi. Ces éléments ne doivent pas
   être simulés avec des cours ou instruments fictifs.
4. La SPA ne possède pas encore les routes URL demandées. La garde serveur des APIs admin est
   réelle, mais l'ajout de routes Next dédiées devra préserver les anciens hashes et l'aperçu.

## Tests existants et à compléter

Les tests actuels couvrent les fonctions pures, les clés d'idempotence, les gardes API, les
contraintes SQL et le parcours onboarding. À ajouter lors du chantier recommandation : contrainte
unique membre/mois, recommandation figée, absence de cours, éligibilité PEA, double-clic,
transaction annulée, et E2E responsive/retour navigateur.
