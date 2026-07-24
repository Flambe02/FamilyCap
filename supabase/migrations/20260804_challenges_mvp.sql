-- Défis familiaux — MVP (Phase 2). Un seul type de défi : investissement mensuel régulier.
-- Le portefeuille et la progression restent DÉRIVÉS de public.account_operations (source de
-- vérité unique) : aucune table ne stocke une valeur de portefeuille. Les points vivent dans un
-- JOURNAL IMMUABLE (points_ledger) ; aucun total n'est stocké — il se calcule par SUM(points).
--
-- Additive et rejouable autant que possible. À exécuter MANUELLEMENT dans le SQL Editor Supabase,
-- APRÈS 20260716_* (family_members, financial_accounts, current_family_member_id,
-- is_cap_family_admin), 20260722_account_operations.sql et 20260803_user_investment_plan.sql.
-- Ne JAMAIS l'exécuter automatiquement sur la production.
--
-- Sécurité : comme le reste du projet, les ÉCRITURES passent par des routes serveur (clé
-- service-role qui contourne la RLS). Les policies RLS ci-dessous sont le filet de sécurité pour
-- un éventuel accès direct via la clé publishable : lecture restreinte, aucune écriture cliente.

-- 1) Définition d'un défi (créé par l'administration).
create table if not exists public.challenges (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  challenge_type text not null default 'monthly_investment' check (challenge_type in ('monthly_investment')),
  status text not null default 'draft' check (status in ('draft', 'scheduled', 'active', 'completed', 'archived')),
  starts_on date not null,
  ends_on date not null,
  points_reward integer not null default 300 check (points_reward >= 1 and points_reward <= 1000),
  -- Types de comptes éligibles (financial_accounts.account_type) et d'instruments (holdings.asset_type).
  eligible_account_types text[] not null default array['pea', 'securities'],
  eligible_instrument_types text[] not null default array['etf', 'stock'],
  created_by uuid references public.family_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint challenges_period_chk check (ends_on >= starts_on)
);
create index if not exists challenges_status_idx on public.challenges(status, starts_on desc);
create index if not exists challenges_period_idx on public.challenges(starts_on, ends_on);
-- MVP : au plus UN défi actif à la fois. Index unique partiel → une seconde activation échoue
-- (violation 23505) ; la route d'activation renvoie alors une erreur métier explicite.
create unique index if not exists challenges_single_active_idx on public.challenges(status) where status = 'active';

-- 2) Inscription d'un membre + PHOTOGRAPHIE FIGÉE de son objectif au moment de rejoindre.
--    Une modification ultérieure de user_investment_plan ne change PAS target_amount_snapshot.
create table if not exists public.challenge_participants (
  id uuid primary key default gen_random_uuid(),
  challenge_id uuid not null references public.challenges(id) on delete cascade,
  member_id uuid not null references public.family_members(id) on delete cascade,
  target_account_id uuid references public.financial_accounts(id) on delete set null,
  target_amount_snapshot numeric(20, 2) not null check (target_amount_snapshot > 0),
  target_currency text not null,
  status text not null default 'in_progress' check (status in ('in_progress', 'completed', 'paused', 'ineligible')),
  joined_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint challenge_participants_unique unique (challenge_id, member_id)
);
create index if not exists challenge_participants_member_idx on public.challenge_participants(member_id);
create index if not exists challenge_participants_challenge_idx on public.challenge_participants(challenge_id);

-- 3) Rattachement des achats éligibles à un participant. Une opération ne peut compter QU'UNE
--    fois dans un même défi (unique). L'opération reste dans account_operations (jamais dupliquée).
create table if not exists public.challenge_operation_links (
  id uuid primary key default gen_random_uuid(),
  challenge_id uuid not null references public.challenges(id) on delete cascade,
  participant_id uuid not null references public.challenge_participants(id) on delete cascade,
  operation_id uuid not null references public.account_operations(id) on delete cascade,
  eligible_amount numeric(20, 2) not null check (eligible_amount > 0),
  created_at timestamptz not null default now(),
  constraint challenge_operation_links_unique unique (challenge_id, operation_id)
);
create index if not exists challenge_operation_links_participant_idx on public.challenge_operation_links(participant_id);
create index if not exists challenge_operation_links_challenge_idx on public.challenge_operation_links(challenge_id);

-- 4) JOURNAL IMMUABLE des points. Aucun total stocké. Une attribution = une écriture positive ;
--    une annulation = une écriture négative distincte. On ne modifie/supprime JAMAIS une ligne.
--    idempotency_key (unique) empêche toute double attribution, même sous appels concurrents.
-- FKs en ON DELETE RESTRICT : aucune suppression en cascade ne doit pouvoir effacer une écriture
-- de points (immutabilité). Conséquence assumée : un défi/membre AYANT des points ne peut pas
-- être supprimé physiquement — on ARCHIVE les défis (changement de statut) et on SOFT-DELETE les
-- membres (deleted_at), jamais de hard-delete. Cohérent avec le modèle existant.
create table if not exists public.points_ledger (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.family_members(id) on delete restrict,
  challenge_id uuid references public.challenges(id) on delete restrict,
  participant_id uuid references public.challenge_participants(id) on delete restrict,
  points integer not null,
  reason text not null,
  idempotency_key text not null unique,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists points_ledger_member_idx on public.points_ledger(member_id, created_at desc);
create index if not exists points_ledger_challenge_idx on public.points_ledger(challenge_id);

-- ==========================================================================================
-- RLS : lecture restreinte pour authenticated ; AUCUNE écriture cliente (service-role serveur).
-- ==========================================================================================
alter table public.challenges enable row level security;
alter table public.challenge_participants enable row level security;
alter table public.challenge_operation_links enable row level security;
alter table public.points_ledger enable row level security;

-- challenges : un membre voit les défis non-brouillon (programmés/actifs/terminés/archivés) ;
-- l'admin voit tout (brouillons compris). Écriture : service-role uniquement (routes requireAdmin).
drop policy if exists "member reads visible challenges" on public.challenges;
create policy "member reads visible challenges"
on public.challenges for select to authenticated
using (status <> 'draft' or public.is_cap_family_admin());

-- challenge_participants : un membre lit SA participation ; l'admin lit tout. Aucune écriture
-- cliente (inscription/gel/complétion faits côté serveur ; le navigateur ne choisit ni member_id
-- ni status='completed').
drop policy if exists "member reads own participation" on public.challenge_participants;
create policy "member reads own participation"
on public.challenge_participants for select to authenticated
using (member_id = public.current_family_member_id() or public.is_cap_family_admin());

-- challenge_operation_links : un membre lit les liens de SA participation ; l'admin lit tout.
-- Aucune écriture cliente.
drop policy if exists "member reads own operation links" on public.challenge_operation_links;
create policy "member reads own operation links"
on public.challenge_operation_links for select to authenticated
using (
  public.is_cap_family_admin()
  or exists (
    select 1 from public.challenge_participants p
    where p.id = challenge_operation_links.participant_id
      and p.member_id = public.current_family_member_id()
  )
);

-- points_ledger : un membre lit UNIQUEMENT ses points ; l'admin lit tout. Aucune écriture,
-- mise à jour ni suppression cliente : l'attribution passe exclusivement par le serveur, et le
-- journal est immuable (aucune policy update/delete → refus total via la clé publishable).
drop policy if exists "member reads own points" on public.points_ledger;
create policy "member reads own points"
on public.points_ledger for select to authenticated
using (member_id = public.current_family_member_id() or public.is_cap_family_admin());

-- Note classement : la vue « classement familial » est calculée CÔTÉ SERVEUR (route
-- /api/challenges/leaderboard via la clé service-role), qui n'expose que member_id, prénom,
-- avatar, points du mois/année, nombre de défis terminés et rang — JAMAIS un montant privé
-- (target_amount_snapshot, eligible_amount, monthly_target, valeur/quantité, performance, compte).
-- Elle respecte user_investment_plan.leaderboard_opt_in.

-- ==========================================================================================
-- IMMUTABILITÉ RÉELLE de points_ledger (au-delà de la RLS, y compris pour la clé service-role).
-- Un trigger BEFORE UPDATE OR DELETE lève une exception : seules les INSERT sont permises. Les
-- compensations restent de NOUVELLES écritures négatives. Le trigger s'applique à TOUS les rôles.
-- ==========================================================================================
create or replace function public.points_ledger_reject_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'points_ledger est un journal immuable : % interdit. Utilisez une nouvelle écriture (compensation).', tg_op
    using errcode = 'check_violation';
end;
$$;

drop trigger if exists points_ledger_no_update_delete on public.points_ledger;
create trigger points_ledger_no_update_delete
before update or delete on public.points_ledger
for each row execute function public.points_ledger_reject_mutation();

-- ==========================================================================================
-- ATTRIBUTION ATOMIQUE des points. Une seule fonction transactionnelle : verrouille la
-- participation (FOR UPDATE), insère l'écriture idempotente (ON CONFLICT DO NOTHING sur
-- idempotency_key), puis met à jour le statut/compléted_at — le tout dans une même transaction.
-- Évite tout état partiel ; l'unicité de idempotency_key reste le dernier rempart. Réutilisée
-- pour l'attribution (points > 0, statut 'completed') ET la compensation (points < 0, 'in_progress').
-- ==========================================================================================
create or replace function public.apply_challenge_points(
  p_participant_id uuid,
  p_challenge_id uuid,
  p_member_id uuid,
  p_points integer,
  p_reason text,
  p_idempotency_key text,
  p_metadata jsonb,
  p_new_status text,
  p_completed boolean
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Verrou de la participation : sérialise les réconciliations concurrentes sur ce participant.
  perform 1 from public.challenge_participants where id = p_participant_id for update;

  insert into public.points_ledger (member_id, challenge_id, participant_id, points, reason, idempotency_key, metadata)
  values (p_member_id, p_challenge_id, p_participant_id, p_points, p_reason, p_idempotency_key, coalesce(p_metadata, '{}'::jsonb))
  on conflict (idempotency_key) do nothing;

  update public.challenge_participants
     set status = p_new_status,
         completed_at = case when p_completed then now() else null end,
         updated_at = now()
   where id = p_participant_id;
end;
$$;

revoke all on function public.apply_challenge_points(uuid, uuid, uuid, integer, text, text, jsonb, text, boolean) from public, anon, authenticated;
grant execute on function public.apply_challenge_points(uuid, uuid, uuid, integer, text, text, jsonb, text, boolean) to service_role;
