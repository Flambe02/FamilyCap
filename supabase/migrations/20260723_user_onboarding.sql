-- État d'onboarding par membre + préférences d'affichage éditables par le membre lui-même.
-- Additive et rejouable sans perte de données. À exécuter après les migrations
-- 20260716_*/20260718_investment_access.sql (dépend de public.family_members,
-- public.current_family_member_id, public.is_cap_family_admin).
--
-- Aucune donnée d'investissement n'est touchée : ce lot ne persiste que l'avancement du
-- parcours d'accueil et deux préférences d'affichage (langue, devise).

-- 1) Préférences de profil, en libre-service pour le membre (parcours « Vérifier mon profil »).
--    Valeurs par défaut identiques au comportement actuel figé de l'application (fr / EUR).
alter table public.family_members add column if not exists language text not null default 'fr';
alter table public.family_members add column if not exists display_currency text not null default 'EUR';

-- 2) État d'onboarding : une ligne par membre.
create table if not exists public.user_onboarding (
  member_id uuid primary key references public.family_members(id) on delete cascade,
  version integer not null default 1,
  status text not null default 'not_started' check (status in ('not_started', 'in_progress', 'deferred', 'completed')),
  current_step text,
  completed_steps text[] not null default '{}',
  selected_modules text[] not null default '{}',
  privacy_choice text check (privacy_choice in ('private', 'admin', 'custom')),
  admin_can_edit boolean not null default false,
  started_at timestamptz,
  completed_at timestamptz,
  deferred_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_onboarding enable row level security;

-- Un membre lit son propre onboarding ; l'administrateur peut le lire (aperçu en lecture seule).
drop policy if exists "member reads own onboarding" on public.user_onboarding;
create policy "member reads own onboarding"
on public.user_onboarding for select to authenticated
using (member_id = public.current_family_member_id() or public.is_cap_family_admin());

-- Un membre ne gère que SON propre onboarding. Le `with check` restreint l'écriture à sa
-- propre ligne : l'administrateur ne peut pas modifier arbitrairement, via RLS, les préférences
-- privées d'un membre (règle « l'aperçu admin n'écrit rien chez le membre »). Les écritures
-- applicatives passent par la route serveur /api/onboarding (service-role, protégée par
-- requireFamilyMember) ; le member_id y est forcé sur l'identité de l'appelant.
drop policy if exists "member manages own onboarding" on public.user_onboarding;
create policy "member manages own onboarding"
on public.user_onboarding for all to authenticated
using (member_id = public.current_family_member_id())
with check (member_id = public.current_family_member_id());
