-- Plan d'investissement PERSONNEL du membre (« Mon rythme d'investissement »).
-- Engagement mensuel choisi par le membre, distinct de financial_accounts.monthly_target :
--   * financial_accounts.monthly_target = information ADMINISTRATIVE liée à un compte (admin) ;
--   * user_investment_plan.monthly_target = ENGAGEMENT personnel du membre, utilisé par la
--     progression mensuelle et, plus tard, par les Défis.
--
-- Additive et rejouable sans perte de données. À exécuter MANUELLEMENT dans le SQL Editor
-- Supabase, APRÈS 20260716_*/20260718_investment_access.sql (dépend de public.family_members,
-- public.financial_accounts, public.current_family_member_id, public.is_cap_family_admin).
-- Ne JAMAIS l'exécuter automatiquement sur la production. Tant qu'elle n'est pas jouée,
-- l'application reste fonctionnelle : la route /api/investment-plan renvoie un 409 explicite.

create table if not exists public.user_investment_plan (
  member_id uuid primary key references public.family_members(id) on delete cascade,
  -- Montant mensuel cible (engagement personnel, jamais comparé à celui des autres).
  monthly_target numeric(20, 2) not null,
  -- Compte PEA / compte-titres utilisé pour l'investissement régulier (facultatif).
  -- L'appartenance au membre est FORCÉE côté serveur (route /api/investment-plan).
  target_account_id uuid references public.financial_accounts(id) on delete set null,
  -- Jour habituel d'investissement (1..28 : présent dans tous les mois).
  target_day integer check (target_day is null or (target_day >= 1 and target_day <= 28)),
  -- Préférence d'instrument (indicative).
  instrument_preference text not null default 'etf' check (instrument_preference in ('etf', 'stocks', 'both')),
  reminders_enabled boolean not null default true,
  -- Participation au FUTUR classement familial : intention stockée (aucun classement n'existe
  -- encore ; ce drapeau ne déclenche aucun comportement tant que les Défis ne sont pas livrés).
  leaderboard_opt_in boolean not null default true,
  -- Mois d'entrée en vigueur du plan (1er du mois). Le gel mensuel de l'objectif viendra avec
  -- le moteur des Défis ; en phase 1, une modification s'applique immédiatement.
  effective_from date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists user_investment_plan_account_idx on public.user_investment_plan(target_account_id);

alter table public.user_investment_plan enable row level security;

-- Lecture : le membre lit son propre plan ; l'administrateur peut le consulter.
drop policy if exists "member reads own investment plan" on public.user_investment_plan;
create policy "member reads own investment plan"
on public.user_investment_plan for select to authenticated
using (member_id = public.current_family_member_id() or public.is_cap_family_admin());

-- Écriture : le membre gère UNIQUEMENT son propre plan (jamais celui d'un autre). L'admin qui
-- gère le plan d'un membre passe par la route serveur (clé service-role) : cette policy reste le
-- filet de sécurité pour un accès direct via la clé publishable.
drop policy if exists "member manages own investment plan" on public.user_investment_plan;
create policy "member manages own investment plan"
on public.user_investment_plan for all to authenticated
using (member_id = public.current_family_member_id())
with check (member_id = public.current_family_member_id());

-- Note : les écritures applicatives passent par /api/investment-plan, protégée par
-- requireFamilyMember() ; le member_id est TOUJOURS forcé sur l'identité de l'appelant (ou, pour
-- un administrateur ciblant un membre via ?memberId=, sur ce membre). Un compte cible doit
-- appartenir au membre : la route le vérifie contre financial_accounts.member_id.
