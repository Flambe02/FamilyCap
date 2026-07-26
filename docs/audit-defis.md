# Audit — Intégration de la rubrique « Défis » dans LaBaJo & Co

> Audit strictement en lecture seule, réalisé sur la copie canonique `Cryptos Kids/web`.
> Aucun fichier applicatif modifié, aucune migration exécutée, aucun commit.
> Références sous la forme `chemin:ligne` relatives à `web/`.
> Vérifs à la date de l'audit : **tsc 0 erreur · lint 0 erreur / 16 warnings pré-existants · build OK · 149/149 tests**.

---

## 1. Résumé exécutif

L'architecture est **saine pour accueillir les Défis** : source de vérité unique (`account_operations`, d'où le portefeuille est *dérivé*), frontière de sécurité en code (`service_role` + `requireAdmin`/`requireFamilyMember`), RLS par membre et par classe d'actif, journal d'audit générique, console admin en place. La gamification (défis, points, badges, séries, classement) est **totalement absente**, schéma comme code.

Trois faits structurent la stratégie :

1. **Les écrans « Suggestions mensuelles » (membre) ET « Suggestions » (admin) sont des placeholders `ComingSoon` vides** — `app/family-dashboard.tsx:649` et `:654`. Rien à migrer : les Défis peuvent prendre ces deux emplacements de navigation directement.
2. **Le bloc « INVESTISSEMENT RÉGULIER » existe en UI, mais son « Objectif mensuel » est codé en dur « À compléter »** — `app/investment-account.tsx:453` ; la progression du mois est dérivée des `versement` réels. C'est le point d'ancrage du « rythme d'investissement ».
3. **Les opérations PEA/CTO sont admin-only** — `app/api/pea/operations/route.ts:32` ; seul le Bitcoin a une saisie self-service membre (`/api/personal-investment`). C'est la décision structurante pour « reconnaître automatiquement un achat » sans double saisie.

**Recommandation :** transformer par **remplacement** les Suggestions vides en Défis, **réutiliser `account_operations` comme moteur de validation** (dérivation, zéro double saisie), créer des tables gamification **service_role-only** (points immuables) branchées sur `family_members.id`, en réutilisant les patterns RLS et le journal d'audit existants.

---

## 2. Architecture actuelle

- **Stack** : Next.js 16.2 / React 19 (App Router), Supabase (Postgres + Auth + Storage), Vercel. Pas d'ORM en prod (le Drizzle/SQLite du dépôt est **mort**, cf. §8). Accès data via `lib/supabase-rest.ts` avec la **clé secrète service_role** (contourne la RLS → la sécurité réelle est dans les routes).
- **Navigation** (`lib/navigation.ts`) : SPA à `View` unique (état + hash), rendue par `app/family-dashboard.tsx`. Groupes : Famille · Investissements (Bitcoin, PEA, Compte-titres, **Suggestions**, **Historique**, Comprendre) · Administration (Opérations, Famille & accès, **Suggestions**, Administration).
- **Modèle pivot** : `family_members` (identité/rôle, `id uuid`), `financial_accounts`, `account_operations` (**source de vérité PEA/CTO**), `holdings` (référentiel de prix par compte), `gift_records` (cadeaux + BTC perso), + onboarding/notifications/vidéos/console admin.
- **Invariant central** : « une position n'est JAMAIS saisie directement, elle est DÉRIVÉE des opérations » (`lib/portfolio-account.ts:5`). Moteur `computeAccountModel` (PMP/CUMP) générique `AccountType = "PEA" | "CTO"`, pur et testé.
- **Double modèle d'identité** : Bitcoin/cadeaux clé par **nom** contre un roster **codé en dur à 5 membres** (`lib/family-roster.ts:17`) ; PEA/CTO/comptes clé par **`member_id` (uuid)**. Un classement doit être **DB-driven (uuid)**.

---

## 3. Fonctionnalités réellement disponibles

| Domaine | État |
|---|---|
| Cadeaux BTC (Amatxi) | ✅ Complet |
| Investissement BTC perso (membre) | ✅ Self-service `/api/personal-investment` (identité+origine forcées) |
| PEA / Compte-titres | ✅ Écrans complets (7 onglets), moteur dérivé, **admin-only en écriture** |
| Import CSV / XLSX / snapshot / scan IA | ✅ Fonctionnels (admin-only) |
| Paramètres (6 sections) + onboarding (5 écrans) | ✅ Livrés |
| Partage par classe BTC/PEA/CTO | ✅ Serveur + RLS |
| Console admin membres + audit log | ✅ Livrés |
| **Suggestions (membre + admin)** | ⛔ Placeholders vides |
| **Historique consolidé** | ⛔ Placeholder vide |
| **Objectif mensuel membre / jour / rythme** | ⛔ Absent (seul `financial_accounts.monthly_target`, par-compte, admin) |
| **Défis / points / badges / séries / classement** | ⛔ Inexistants |
| Scheduler / rappels planifiés / broadcast admin→membres | ⛔ Absents |

---

## 4. Audit PEA & Compte-titres

- **Moteur partagé** : `lib/portfolio-account.ts::computeAccountModel` — positions **dérivées** (holdings.quantity non lu), trésorerie, PMP frais inclus, +/- value latente, performance depuis l'origine, allocation par classe + par devise (non convertie), timeline reconstruite des op réelles, impact de change `null` (assumé). Shell unique `app/investment-account.tsx` + wrappers `pea-investments.tsx` / `cto-investments.tsx` (config `EnvelopeConfig`).
- **Onglets** : Résumé, Positions, **Investir**, Revenus, Performance, Historique, Comprendre, Infos.
- **9 types d'opération** : `achat, vente, versement, retrait, dividende, frais, correction, transfer_in, transfer_out` (`lib/account-operation.ts:10`). Validation = source de vérité unique `validateOperation`/`buildOperationRecord`, partagée saisie manuelle + import.
- **Cours** : `holdings.last_price`, entretenu **manuellement** (Alpha Vantage à la demande, pas de cron). Instrument identifié par clé normalisée **ISIN > ticker > nom** (`lib/portfolio-account.ts:141`).

**Confirmations :**
- Positions dérivées des opérations : ✅.
- ⚠️ **Deux chemins de valorisation concurrents** : écran PEA/CTO (moteur) vs « Mes comptes » (`app/settings-accounts.tsx:79`) et total console (`app/administration.tsx:391`) qui valorisent `holdings.quantity × last_price`. Une position saisie en direct dans `holdings` n'apparaît pas dans le tableau de positions PEA/CTO tant qu'aucune opération ne l'a créée. À réconcilier avant tout défi « progression de portefeuille ».
- **Objectif mensuel** du widget « Investissement régulier » = placeholder « À compléter » (`app/investment-account.tsx:453`), non branché sur `financial_accounts.monthly_target`.

---

## 5. Audit Suggestions

Les deux vues sont des coquilles :
- Membre `investissements-suggestions` → `<ComingSoon>` (`app/family-dashboard.tsx:649`).
- Admin `administration-suggestions` → `<ComingSoon>` (`app/family-dashboard.tsx:654`).

**Aucune** table/route/composant/donnée/notification derrière.

**Recommandation : REMPLACER par les Défis** (ni transformer ni garder séparé). Rien à migrer ; on récupère deux emplacements de navigation validés (membre + admin) et leur câblage. Renommer `investissements-suggestions` → **« Défis »** et `administration-suggestions` → **« Défis & animation »**.

---

## 6. Audit Paramètres

- **Structure** : `app/settings.tsx` (orchestrateur), `app/settings-ui.tsx` (primitives). 6 groupes : Compte, **Investissements** (Mes comptes, Ledger, Partage), Préférences (Notifications), Confidentialité, Aide, Administration. Desktop 3 zones / mobile index→détail. Parité admin `app/settings-admin-member.tsx`.
- **Le membre peut définir** : prénom, anniversaire, photo, e-mail, mot de passe, partage (scope + grants + par classe), 5 toggles notifications, export JSON, désactivation. **Langue/devise** = colonnes existantes, UI verrouillée.
- **Rythme d'investissement** : objectif mensuel existe **par compte, admin-only** ; jour / compte régulier / préférence ETF-actions / participation classement = **absents** ; rappels = toggle `notification_preferences.investments` (stocké, aucune campagne).
- **Insertion recommandée** : sous-section dans le groupe **Investissements**, composant calqué sur `settings-notifications.tsx`, écrivant dans une **nouvelle table membre-inscriptible** via une **route type `notification-preferences`** (pas `/api/admin/accounts`). `leaderboard_opt_in` = intention tant que le classement n'existe pas.
- **Onboarding** : 5 écrans (welcome/profile/**modules**/privacy/completion), persistés `user_onboarding`. `modules` (`gifts|bitcoin|pea|cto`) = choix d'affichage, **pas d'objectifs**. Gate : seuls `adult`/`child` tunnelisés.

---

## 7. Audit Administration

- **Vues admin** (`app/family-dashboard.tsx:653-655`) : Opérations, Famille & accès (`AdminUsers`), Suggestions (**vide**), Administration (console 5 onglets, dont **Membres redondant** avec `AdminUsers`).
- **Réutilisable pour « Défis & animation »** : pattern de route admin (`requireAdmin` + `service_role` + `setupResponse`), journal d'audit générique `writeAdminAudit({action})` (`lib/admin-audit.ts:18`), `member_product_access` (ajouter `'challenges'`), patron `transfer_requests` (machine à statuts + email Resend), wizards, ajout trivial de vue.
- **Manques** : scheduler/cron, broadcast admin→membres, moteur de règles/scoring, audit limité à la gestion des membres.

---

## 8. Audit Supabase & RLS

- **27 migrations** (20260716→20260802), RLS partout, écritures `service_role` sauf policies `FOR ALL` ciblées.
- Tables clés : `family_members` (`id uuid`, `role admin/adult/child/viewer`, `share_btc/pea/cto`), `financial_accounts` (`account_type`, `monthly_target`, `opened_at`, `opening_balance` ; **pas de `is_primary`**), `account_operations` (**source de vérité**), `holdings` (par-compte ; **pas de `pea_eligible`**).
- **Membre-inscriptibles via RLS `FOR ALL (soi)`** : `notification_preferences`, `user_onboarding`, `investment_access_grants`, `family_video_views` → patron pour l'opt-in et le plan d'investissement.
- Console `service_role-only` (RLS sans policy) : `user_roles` (`super_admin/admin/member/viewer`), `member_product_access`, `invitations`, `profiles`, `admin_audit_log`.
- Fonctions `SECURITY DEFINER` réutilisables : `current_family_member_id()`, `is_cap_family_admin()`, `can_view_member_asset(member,classe)`, `can_view_member_investments`, `can_view_video`, `apply_ledger_transfer`.
- **Existence** : objectifs/goals ⛔ ; suggestions/challenges/points/badges/streaks/leaderboard ⛔ ; audit ✅ (`admin_audit_log`, écrit par code).

**Signalements :**
- **Schéma legacy MORT** `db/schema.ts` + `drizzle/*.sql` (SQLite) non branché ; contient `monthly_missions(month, title, lesson, suggested_amount_eur, status)` → **inspiration de champs uniquement**.
- **4 migrations manuelles / jamais en auto** : `20260722`, `20260725`, `20260726`, `20260730` (plus d'autres en attente selon l'instance — à confirmer avant de bâtir).
- `member_product_access` écrit/lu en UI mais **jamais appliqué** par les routes métier.
- Incohérence rôles : UI ouvre les vues admin sur `role === "admin"` mais la gestion des membres exige **super-admin** (403 sinon) ; rôle **`child` converti en `adult`** à la création (`app/api/admin/users/route.ts:26`).

---

## 9. Écarts existant / cible (matrice)

| Fonctionnalité | Existe | Partiel | Absent | Réutilisable | Travail |
|---|:--:|:--:|:--:|---|---|
| Comptes PEA & CTO | ✅ | | | `financial_accounts`, moteur, shell | Réconcilier valorisation ; `is_primary` optionnel |
| Ajout de positions | ✅ | | | Imports, `account_operations` | Choisir source de progression |
| Opérations | ✅ | | | `validateOperation`, route générique | Décider self-service membre |
| Objectif mensuel (membre) | | ⚠️ (compte) | | `monthly_target`, widget UI | `user_investment_plan` + route + widget |
| Challenge mensuel | | | ⛔ | Slots nav, patron `monthly_missions` | `challenges` + admin CRUD |
| Validation depuis opération | | | ⛔ | `account_operations` | Moteur dérivation + idempotence |
| Points | | | ⛔ | `admin_audit_log` (patron append-only) | `points_ledger` immuable |
| Badges | | | ⛔ | — | `badges` + `member_badges` |
| Séries | | ⚠️ (viz `indicators.runsOf`) | | | Calcul dérivé |
| Classement familial | | | ⛔ | `family_members.id` | Vue **sans montants** |
| Confidentialité / opt-in | | ⚠️ | | RLS `FOR ALL soi` | Flag opt-in |
| Back-office | ✅ | | | Patterns routes/UI | Écran Défis & animation |
| Communications | | | ⛔ | Resend, `notification_preferences` | Moteur messages/rappels |
| Notifications planifiées | | | ⛔ | Toggle `investments` | Scheduler (Vercel Cron) |
| Audit actions admin | ✅ | | | `writeAdminAudit` | Étendre aux Défis |

---

## 10. Architecture cible recommandée

**Principe : les Défis sont une COUCHE DÉRIVÉE au-dessus des opérations, jamais une seconde source de vérité.**

- **Réutiliser** : `family_members`, `account_operations`, `financial_accounts`, `gift_records`, `admin_audit_log`, `member_product_access` (+`'challenges'`), `notification_preferences` ; fonctions `current_family_member_id()`, `is_cap_family_admin()`, `can_view_member_asset()`.
- **Nouvelles tables (Postgres/uuid)** : `user_investment_plan` (membre-inscriptible), `challenges`, `challenge_participations`, `challenge_completions` (**UNIQUE `challenge_id,operation_id`**), `points_ledger` (append-only, service_role only), `badges` + `member_badges`. Séries & classement = **dérivés**.
- **Serveur** : attribution de points (service_role), validation idempotente dérivée d'`account_operations`, recalcul sur suppression/modif d'op, clôture mensuelle (Vercel Cron ou action admin).
- **Réponses clés** : objectif mensuel dans `user_investment_plan` (≠ `monthly_target` compte) · achat→défi par dérivation · double validation bloquée par UNIQUE · points immuables · classement agrégé sans euros · automatisations via Cron à ajouter.

---

## 11. Sécurité & intégrité (Défis)

| Risque | Protection |
|---|---|
| Auto-attribution de points | `points_ledger` jamais membre-inscriptible → service_role only |
| Validation arbitraire | Dérivée d'`account_operations` ou approbation admin ; jamais côté client |
| Double validation | UNIQUE `(challenge_id, operation_id)` + idempotence |
| Modif objectif après progression | Objectif **figé au début de période** (snapshot immuable) |
| Montants privés dans le classement | DTO **sans euros**, agrégation points/rang |
| Admin suit sans contourner | Lecture service_role **journalisée** ; pas d'usurpation |
| Opérations = source de vérité | Progression **dérivée** |
| Suppression/modif d'op | Recompute déterministe |

---

## 12. Risques & décisions

1. **Saisie achats PEA/CTO par le membre** (décision majeure) : rester admin-only (dérivation) **ou** ouvrir un self-service. Recommandé : admin-only au départ.
2. **Équité du classement** : classer sur comportement (points/séries/régularité), pas sur les montants ; pondération âge/rôle possible.
3. **Dualité d'identité** : classement DB-driven (`family_members.id`).
4. **Infra manquante** : Vercel Cron + mini-moteur de messages.
5. **Deux chemins de valorisation** à réconcilier.
6. **`member_product_access` non appliqué** : décider s'il cadre l'éligibilité aux défis.
7. **Rôle `child` non créable** (converti en `adult`).
8. **Migrations en attente** : confirmer l'état Supabase.

---

## 13. Fichiers probablement concernés

- **À modifier** : `lib/navigation.ts`, `app/family-dashboard.tsx`, `app/investment-account.tsx`, `app/settings.tsx`, `app/settings-admin-member.tsx`, `lib/account-settings-client.ts`, `app/administration.tsx`.
- **À créer** : `app/settings-investment-rhythm.tsx`, `app/challenges.tsx`, `app/admin-challenges.tsx`, `app/api/investment-plan/route.ts`, `app/api/challenges/route.ts`, `app/api/admin/challenges/route.ts`, `lib/challenge-engine.ts`, migrations `supabase/migrations/2026xxxx_*`, tests.
- **À réutiliser tel quel** : `app/settings-ui.tsx`, `lib/account-operation.ts`, `lib/admin-audit.ts`, `/api/portfolio`, patrons `transfer-requests`/`notification-preferences`.

---

## 14. Vérifications

| Vérification | Commande | Résultat |
|---|---|---|
| TypeScript | `tsc --noEmit` | ✅ 0 erreur |
| Lint | `npm run lint` | ✅ 0 erreur, 16 warnings pré-existants (15 × `no-img-element` + 1 × `exhaustive-deps`) |
| Build + Tests | `npm test` | ✅ build OK, 149/149 tests |

- **Tests existants** : moteur portefeuille (17), imports, XLSX, snapshot, extraction IA, xpub, custody, vidéos, onboarding, YouTube, rendu HTML. **Aucun** test permissions/RLS ni routes API.
- **À ajouter** : dérivation défi (validation/idempotence/recalcul), immuabilité `points_ledger`, séries, classement sans montants, gardes de permission.

---

## 15. Recommandation finale

Feu vert architectural. Ne créez pas de seconde source de vérité : dérivez les défis d'`account_operations`. Remplacez les Suggestions vides par les Défis. Points en journal immuable service_role, classement sans montants, objectif mensuel membre séparé du `monthly_target` de compte.

### Plan par phases

| # | Phase | Effort |
|---|---|---|
| 1 | Consolider PEA/CTO (réconcilier valorisation) | Faible-Moyen |
| 2 | Fiabiliser ajout de positions | Faible (déjà là) |
| 3 | Objectif mensuel membre (`user_investment_plan`) | Moyen |
| 4 | Remplacer Suggestions par Défis (`challenges`) | Moyen-Élevé |
| 5 | Relier achats aux défis (dérivation) | Moyen |
| 6 | Points & séries | Moyen |
| 7 | Classement familial (sans montants) | Moyen |
| 8 | Back-office Défis & animation | Moyen-Élevé |
| 9 | Rappels & communications (Cron + messages) | Élevé |
| 10 | Import PDF/IA (réutilisé) | Faible |

---

## A. À conserver tel quel
- Moteur `computeAccountModel` + `validateOperation`/`buildOperationRecord`.
- RLS par membre/classe + fonctions `current_family_member_id()`, `is_cap_family_admin()`, `can_view_member_asset()`.
- `admin_audit_log` + `writeAdminAudit()`.
- Patrons `transfer_requests`, `notification_preferences`/`user_onboarding` (membre-inscriptible), `/api/personal-investment`.
- `settings-ui.tsx`, `InvestmentAccountShell`, imports CSV/XLSX/snapshot/IA.

## B. À étendre ou refactoriser
- Réconcilier les deux chemins de valorisation.
- Brancher le widget « Objectif mensuel ».
- `member_product_access` : appliquer réellement (+`'challenges'`) ou acter indicatif.
- Renommer nav Suggestions → Défis.
- Étendre l'audit aux actions Défis.
- Corriger : rôle `child`→`adult` ; incohérence admin/super-admin ; unifier `AdminUsers` vs `Members`.
- Classement sur `family_members.id`, pas le roster figé.

## C. À créer
- Tables : `user_investment_plan`, `challenges`, `challenge_participations`, `challenge_completions` (UNIQUE `challenge_id,operation_id`), `points_ledger` (append-only service_role), `badges`, `member_badges`.
- Moteur `lib/challenge-engine.ts`.
- Routes `/api/investment-plan`, `/api/challenges`, `/api/admin/challenges`.
- Écrans `settings-investment-rhythm.tsx`, `challenges.tsx`, `admin-challenges.tsx`.
- Infra : Vercel Cron + mini-moteur de messages.
- Classement dérivé sans montants ; tests de permission et d'immuabilité.
