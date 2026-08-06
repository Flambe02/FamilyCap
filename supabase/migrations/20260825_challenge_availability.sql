-- Défis : disponibilité configurable par défi (toujours / séquentiel / spécial) et plusieurs
-- défis mensuels actifs SIMULTANÉMENT. L'ancienne contrainte « un seul défi mensuel actif »
-- (20260805) limitait l'animation familiale à un seul défi à la fois ; elle est retirée pour
-- permettre p. ex. un défi permanent + un défi spécial débloqué en même temps.
--
-- Additive et rejouable. À exécuter MANUELLEMENT dans le SQL Editor Supabase, APRÈS
-- 20260818_challenges_templates_v3.sql.

-- 1) Plusieurs défis MENSUELS peuvent désormais être actifs en même temps (les missions
--    onboarding et lesson_quiz n'étaient déjà plus concernées par cet index depuis 20260805).
drop index if exists public.challenges_single_active_idx;

-- 2) Mode de disponibilité par défi.
--    'always'     : visible dès que actif et dans sa période (comportement historique, inchangé).
--    'sequential' : visible seulement une fois requires_challenge_id terminé par CE membre
--                   (solde net points_ledger > 0 pour ce défi prérequis).
--    'special'    : visible seulement après déblocage explicite par l'admin, PAR MEMBRE
--                   (table challenge_unlocks ci-dessous). Un défi 'special' peut en plus être
--                   daté : il reste alors AUSSI soumis à sa période, comme tout défi.
alter table public.challenges add column if not exists availability_mode text not null default 'always';
alter table public.challenges drop constraint if exists challenges_availability_mode_check;
alter table public.challenges add constraint challenges_availability_mode_check
  check (availability_mode in ('always', 'sequential', 'special'));

alter table public.challenges add column if not exists requires_challenge_id uuid references public.challenges(id) on delete set null;

-- 3) Déblocages manuels par membre (défis 'special' uniquement). Un déblocage donne la
--    VISIBILITÉ du défi, jamais une inscription (challenge_participants) ni des points : le
--    membre débloqué doit ensuite rejoindre le défi comme n'importe quel autre défi visible.
create table if not exists public.challenge_unlocks (
  id uuid primary key default gen_random_uuid(),
  challenge_id uuid not null references public.challenges(id) on delete cascade,
  member_id uuid not null references public.family_members(id) on delete cascade,
  unlocked_by uuid references public.family_members(id) on delete set null,
  unlocked_at timestamptz not null default now(),
  constraint challenge_unlocks_unique unique (challenge_id, member_id)
);
create index if not exists challenge_unlocks_member_idx on public.challenge_unlocks(member_id);

alter table public.challenge_unlocks enable row level security;
drop policy if exists "member reads own unlocks" on public.challenge_unlocks;
create policy "member reads own unlocks"
on public.challenge_unlocks for select to authenticated
using (member_id = public.current_family_member_id() or public.is_cap_family_admin());
-- Aucune policy d'écriture : le déblocage passe exclusivement par une route serveur
-- requireAdmin (clé service-role, qui contourne la RLS comme le reste des écritures Défis).

comment on column public.challenges.availability_mode is 'always | sequential (requires_challenge_id doit être terminé par le membre) | special (déblocage manuel via challenge_unlocks)';
comment on column public.challenges.requires_challenge_id is 'Défi prérequis, utilisé uniquement quand availability_mode = ''sequential''. NULL sinon.';
comment on table public.challenge_unlocks is 'Déblocage manuel, par membre, des défis en mode ''special''. Donne la visibilité, pas une inscription ni des points.';
