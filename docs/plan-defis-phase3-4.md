# Plan d'implémentation — Défis, Phases 3 & 4

> Plan de conception (pas d'implémentation). Aucun code applicatif écrit, aucune migration exécutée.
> Le SQL ci-dessous est un **brouillon à relire**, additif/idempotent, à jouer **manuellement** dans le SQL Editor Supabase (convention du projet).
> Prérequis : audit `docs/audit-defis.md`. Vérifs de départ : tsc 0 · lint 0 err · 149 tests.

Périmètre :
- **Phase 3** — « Mon rythme d'investissement » : objectif mensuel **au niveau du membre** + branchement du widget existant.
- **Phase 4** — Remplacer « Suggestions » (vide) par « Défis » : navigation + définition/CRUD des défis (la *progression réelle* et les *points* sont Phase 5-6).

Invariants respectés : source de vérité = `account_operations` ; écritures via routes `service_role` ; membre-inscriptible seulement là où c'est explicitement voulu ; aucun montant privé exposé ; pas de faux enforcement.

---

# PHASE 3 — Objectif mensuel membre

## 3.1 Décision de modèle
`financial_accounts.monthly_target` est **par compte et admin-only** (`app/api/admin/accounts/route.ts`, `requireAdmin`). L'objectif du membre est une **notion distincte** : il appartient au membre, doit être **auto-éditable**, et ne peut pas écrire `financial_accounts` sans passer par l'admin. → **nouvelle table membre-inscriptible** `user_investment_plan`, sur le patron `notification_preferences` (`20260721`) / `user_onboarding` (`20260723`).

## 3.2 Migration `2026xxxx_user_investment_plan.sql` (brouillon)

```sql
-- Additive, idempotente. À jouer manuellement, jamais en auto sur la prod.
create table if not exists public.user_investment_plan (
  member_id uuid primary key references public.family_members(id) on delete cascade,
  monthly_target_eur numeric(20,2) check (monthly_target_eur is null or monthly_target_eur >= 0),
  target_account_id uuid references public.financial_accounts(id) on delete set null,
  target_day int check (target_day is null or (target_day >= 1 and target_day <= 28)),
  instrument_preference text not null default 'both'
    check (instrument_preference in ('etf','stocks','both')),
  reminders_enabled boolean not null default true,
  leaderboard_opt_in boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.user_investment_plan enable row level security;

-- Lecture : soi + admin (filet de sécurité ; les routes appliquent déjà le périmètre).
drop policy if exists "member reads own investment plan" on public.user_investment_plan;
create policy "member reads own investment plan"
on public.user_investment_plan for select to authenticated
using (member_id = public.current_family_member_id() or public.is_cap_family_admin());

-- Écriture membre self-service (soi uniquement), comme notification_preferences.
drop policy if exists "member manages own investment plan" on public.user_investment_plan;
create policy "member manages own investment plan"
on public.user_investment_plan for all to authenticated
using (member_id = public.current_family_member_id())
with check (member_id = public.current_family_member_id());
```

Notes :
- `target_day` borné à 28 (tous les mois ont un jour 28).
- Pas de `challenge`/`points` ici : cette table = **préférences de rythme**, pas de la gamification.
- `target_account_id` = simple préférence ; `on delete set null` si le compte disparaît.

## 3.3 Route `app/api/investment-plan/route.ts` (contrat)

Calquée sur `app/api/notification-preferences/route.ts` :
- `GET` : `requireFamilyMember` → renvoie le plan du membre (défauts si absent). Admin peut cibler `?memberId=` via `resolveTargetId` (comme notifications).
- `PATCH` : `requireFamilyMember` → **member_id FORCÉ** (jamais issu du corps) ; upsert `on_conflict=member_id`. Admin ciblant `?memberId=` autorisé (parité aperçu).
- Tolérance migration absente : `isMissingTable(err)` → **409 `setupRequired`** avec message « jouer 2026xxxx_user_investment_plan.sql » (ne casse pas l'UI).
- Validation serveur : `instrument_preference ∈ {etf,stocks,both}` ; `target_day ∈ [1,28]|null` ; `monthly_target_eur ≥ 0|null` ; `target_account_id` doit appartenir au membre (vérif contre `financial_accounts.member_id`) sinon `null`.

## 3.4 Client `lib/account-settings-client.ts`
Ajouter `fetchInvestmentPlan(memberId?)` / `saveInvestmentPlan(payload, memberId?)` avec les mêmes `authHeaders` que les préférences de notification.

## 3.5 UI Paramètres
- **Créer** `app/settings-investment-rhythm.tsx` (`InvestmentRhythmSettings`, prop optionnelle `memberId?`) — calqué sur `settings-notifications.tsx` : chargement + champs + save immédiat, primitives `SettingsSection`/`SettingsSwitch`/`SettingsMessage`, classes `set-fields`/`set-field`/`set-rows`.
  - Champs : objectif mensuel (€), compte cible (`<select>` alimenté par `/api/portfolio` filtré `accountType ∈ {pea, securities}` du membre — même source que `settings-accounts.tsx`), jour cible (1–28), préférence ETF/actions/les deux, rappels (switch), participation au classement (switch, **libellé honnête** : « activera votre présence dans le futur classement »).
- **Modifier** `app/settings.tsx` : ajouter `SectionId "rythme"` à l'union + item dans le groupe **Investissements** (`GROUPS`) + rendu conditionnel dans le panneau.
- **Modifier** `app/settings-admin-member.tsx` : même item dans son `GROUPS` + rendu `<InvestmentRhythmSettings memberId={member.id} />` (parité aperçu admin).

## 3.6 Brancher le widget « Objectif mensuel »
`app/investment-account.tsx` — `ResumeTab`, section `pea-regular` (`:449-467`) :
- Remplacer le libellé codé en dur « À compléter » (`:453`) par `monthly_target_eur` du plan quand présent, sinon garder l'invite.
- Le shell `InvestmentAccountShell` doit recevoir le plan : soit le charger dans `family-dashboard.tsx` (là où `portfolioAccounts` est déjà fetché) et le passer en prop, soit un fetch interne. **Recommandé** : charger au niveau `family-dashboard` (une requête, réutilisable) et passer `investmentPlan` au shell PEA/CTO.
- **Métrique de progression** : le widget dérive aujourd'hui `model.monthly.investedThisMonth` des **`versement`** (`lib/portfolio-account.ts:377-386`). Décider explicitement : garder « versement » (apport de trésorerie) **ou** compléter avec « achat » (déploiement effectif). Recommandation Phase 3 : **conserver `versement`** (cohérent avec l'existant) et documenter ; le lien « achat d'ETF » sera traité en Phase 5.

## 3.7 Tests (`tests/*.mjs`, node --test)
- Validation du plan : bornes `target_day`, enum `instrument_preference`, `monthly_target_eur ≥ 0`.
- Permission : un membre ne peut PATCH que son propre plan ; admin peut cibler `?memberId=`.
- `target_account_id` rejeté si le compte n'appartient pas au membre.
- (UI) le widget affiche l'objectif quand le plan existe, l'invite sinon.

## 3.8 Dépendances, risques, effort
- **Dépendances** : migrations comptes déjà présentes ; pas de dépendance aux Défis.
- **Risques** : double sémantique « objectif mensuel » (compte vs membre) → séparer clairement dans l'UI ; ne PAS toucher `STEP_ORDER`/version d'onboarding (livrer d'abord en Paramètres évite un re-déclenchement du tunnel).
- **Effort : Moyen.**

---

# PHASE 4 — Remplacer « Suggestions » par « Défis »

> Objectif Phase 4 : **définir, programmer et exposer** les défis (admin les crée, le membre les voit). La *validation depuis une opération* et les *points* sont **Phase 5-6** — non inclus ici.

## 4.1 Navigation (`lib/navigation.ts` + `app/dashboard-ui.tsx`)
- `investmentSubNavigation` : renommer l'item `investissements-suggestions` → label **« Défis »** (garder l'id `View` pour limiter le churn, **ou** introduire `investissements-defis` et migrer les 3 points d'usage). Idem `adminNavigation` `administration-suggestions` → **« Défis & animation »**.
- `titleForView` : mettre à jour les libellés.
- Icône : réutiliser `star`/`sprout`/`trending-up` existantes, ou ajouter un `NavIconId "trophy"` (nouvel SVG dans `app/dashboard-ui.tsx`).
- **Décision** : conserver les ids `View` (`investissements-suggestions`, `administration-suggestions`) = plus sûr, aucune rupture de hash/deep-link ; seuls les libellés changent. (Renommage d'id = cosmétique, à faire plus tard si souhaité.)

## 4.2 Migration `2026xxxx_challenges.sql` (brouillon)

```sql
-- Additive, idempotente. Manuelle. uuid partout (compatibles family_members).
create table if not exists public.challenges (
  id uuid primary key default gen_random_uuid(),
  period_month date not null,                 -- 1er du mois concerné (ex. 2026-08-01)
  title text not null,
  description text,
  challenge_type text not null default 'custom'
    check (challenge_type in ('achat_etf','achat_action','versement','montant_mensuel','custom')),
  -- Règle d'éligibilité déclarative (interprétée par lib/challenge-engine en Phase 5) :
  -- { "account_types": ["pea","securities"], "instrument": "etf"|"stock"|null,
  --   "isin_in": ["..."]|null, "min_amount_eur": 50|null, "min_quantity": 1|null }
  rule jsonb not null default '{}'::jsonb,
  points int not null default 0 check (points >= 0),
  status text not null default 'draft'
    check (status in ('draft','scheduled','active','closed')),
  created_by uuid references public.family_members(id) on delete set null,
  created_at timestamptz not null default now(),
  published_at timestamptz
);
create index if not exists challenges_period_status_idx on public.challenges(period_month, status);

alter table public.challenges enable row level security;

-- Lecture : membres voient les défis publiés/actifs/clos ; admin voit tout (brouillons compris).
drop policy if exists "member reads published challenges" on public.challenges;
create policy "member reads published challenges"
on public.challenges for select to authenticated
using (status in ('scheduled','active','closed') or public.is_cap_family_admin());
-- Écriture : admin/service_role uniquement (aucune policy write → service_role via requireAdmin).

-- Participation / opt-in (le membre choisit de rejoindre ; ou l'admin cible).
create table if not exists public.challenge_participations (
  challenge_id uuid not null references public.challenges(id) on delete cascade,
  member_id uuid not null references public.family_members(id) on delete cascade,
  status text not null default 'joined'
    check (status in ('invited','joined','opted_out')),
  joined_at timestamptz not null default now(),
  primary key (challenge_id, member_id)
);
alter table public.challenge_participations enable row level security;

drop policy if exists "member reads own participation" on public.challenge_participations;
create policy "member reads own participation"
on public.challenge_participations for select to authenticated
using (member_id = public.current_family_member_id() or public.is_cap_family_admin());

-- Le membre gère SA participation (rejoindre / se retirer), pas celle des autres.
drop policy if exists "member manages own participation" on public.challenge_participations;
create policy "member manages own participation"
on public.challenge_participations for all to authenticated
using (member_id = public.current_family_member_id())
with check (member_id = public.current_family_member_id());
```

Notes :
- `rule jsonb` = règle **déclarative** ; l'interprétation (matching des opérations) est isolée dans `lib/challenge-engine.ts` en Phase 5. En Phase 4, on ne fait que **stocker et afficher**.
- Pas encore de `challenge_completions`/`points_ledger` (Phase 5-6).
- `period_month` = ancrage mensuel simple ; suffisant pour « défi du mois ».

## 4.3 Route admin `app/api/admin/challenges/route.ts` (contrat)
Patron `app/api/admin/accounts/route.ts` :
- `requireAdmin` sur toutes les méthodes.
- `GET` : liste des défis (+ filtre `period_month`/`status`).
- `POST` : créer (validation `challenge_type`, `points ≥ 0`, `rule` JSON bien formé, `period_month` date ISO). `created_by` = admin appelant.
- `PATCH` : éditer / changer de statut (`draft→scheduled→active→closed`) ; set `published_at` au passage `scheduled/active`.
- `DELETE` : suppression d'un brouillon (garde : refuser si des participations/complétions existent une fois la Phase 5 en place — `force=true` sinon, comme `accounts`).
- **Audit** : `writeAdminAudit({ action: "challenge.created" | "challenge.updated" | "challenge.status_changed" | "challenge.deleted", targetMemberId: null, before, after })` (`lib/admin-audit.ts` accepte toute action).
- `setupResponse` : 409/503 `setupRequired` si la table manque.

## 4.4 Route membre `app/api/challenges/route.ts` (contrat)
- `GET` : `requireFamilyMember` → défis visibles (`scheduled/active/closed`) + la participation du membre. Aucun montant d'autrui.
- `PATCH` (participation) : rejoindre / se retirer — **member_id forcé** ; upsert `challenge_participations`.

## 4.5 UI
- **Créer** `app/challenges.tsx` (`ChallengesPage`, props alignées sur les autres écrans : `viewer`, `isPreview`) : liste des défis du mois + description + objectif + bouton « Participer » / « Se retirer ». En Phase 4, la progression affichée est **l'objectif seul** (le calcul réel arrive en Phase 5) — libellé honnête « progression bientôt disponible ». Réutiliser les composants de `bitcoin-components.tsx` (cartes/panneaux) pour la cohérence visuelle.
- **Créer** `app/admin-challenges.tsx` (`AdminChallenges`) : liste + formulaire create/edit (titre, mois, type, règle, points, statut), calqué sur `Accounts`/`InvestmentModal`. Boutons de statut (programmer/activer/clôturer).
- **Modifier** `app/family-dashboard.tsx` : remplacer les deux `<ComingSoon>` (`:649`, `:654`) par `<ChallengesPage>` (gardé) et `<AdminChallenges>` (gardé `role === "admin"`), en respectant `isPreview`/`canManage`.

## 4.6 Tests
- CRUD challenge : validation type/points/rule/date, transitions de statut valides uniquement.
- RLS/visibilité : un membre ne voit pas les `draft` ; voit `scheduled/active/closed`.
- Participation : un membre ne peut modifier que la sienne.
- Rendu : les deux vues remplacent bien les placeholders.

## 4.7 Dépendances, risques, effort
- **Dépendances** : indépendante de Phase 3 pour la nav/définition ; la *progression* dépend de Phase 5 (moteur de dérivation) — **ne pas** livrer de faux calcul en Phase 4.
- **Risques** : renommage de nav (garder les ids `View`) ; modèle de ciblage (participation vs `member_product_access`) à trancher ; ne pas exposer de brouillons.
- **Effort : Moyen-Élevé.**

---

## Ordre de livraison conseillé
1. **Phase 3** d'abord (autonome, valeur immédiate, aucune dépendance Défis).
2. **Phase 4** ensuite (définition + nav), en laissant explicitement la **progression/points pour la Phase 5-6**.
3. Migrations `user_investment_plan` puis `challenges` jouées manuellement dans Supabase **avant** de brancher les routes (sinon 409 `setupRequired` propre, sans casse).

## Points à valider avant de coder
- Renommer l'id `View` `investissements-suggestions` → `investissements-defis` (churn) **ou** garder l'id et ne changer que le libellé ? (reco : garder l'id).
- Métrique de progression mensuelle : `versement` seul, ou `versement` + `achat` ? (reco Phase 3 : `versement`).
- Modèle d'éligibilité aux défis : participation explicite (`challenge_participations`) et/ou `member_product_access` (+`'challenges'`) ?
- Le classement (`leaderboard_opt_in`) reste une **intention** jusqu'à la Phase 7 — confirmer qu'on affiche un libellé honnête entre-temps.
