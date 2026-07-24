-- Console d'administration Famille & accès.
-- Les tables sont volontairement séparées des données financières : la suppression
-- d'un compte ne peut donc pas supprimer un portefeuille, un cadeau ou une opération.

alter table public.family_members
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references public.family_members(id) on delete set null,
  add column if not exists relationship text;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  member_id uuid unique references public.family_members(id) on delete set null,
  first_name text,
  last_name text,
  relationship text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  member_id uuid unique references public.family_members(id) on delete set null,
  role text not null check (role in ('super_admin', 'admin', 'member', 'viewer')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.member_product_access (
  member_id uuid not null references public.family_members(id) on delete cascade,
  product text not null check (product in ('bitcoin', 'pea', 'cto', 'gifts', 'videos', 'operations')),
  access_level text not null default 'none' check (access_level in ('none', 'read', 'contribute', 'admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (member_id, product)
);

create table if not exists public.invitations (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.family_members(id) on delete cascade,
  email text not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'accepted', 'expired', 'cancelled', 'failed')),
  sent_at timestamptz,
  expires_at timestamptz,
  accepted_at timestamptz,
  created_by uuid references public.family_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists invitations_member_status_idx on public.invitations(member_id, status);
create index if not exists invitations_expires_at_idx on public.invitations(expires_at);
create unique index if not exists invitations_one_open_per_member_idx
  on public.invitations(member_id)
  where status in ('pending', 'sent');

create table if not exists public.admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_member_id uuid references public.family_members(id) on delete set null,
  target_member_id uuid references public.family_members(id) on delete set null,
  action text not null,
  before_values jsonb,
  after_values jsonb,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create index if not exists admin_audit_log_target_created_idx
  on public.admin_audit_log(target_member_id, created_at desc);
create index if not exists admin_audit_log_actor_created_idx
  on public.admin_audit_log(actor_member_id, created_at desc);

alter table public.profiles enable row level security;
alter table public.user_roles enable row level security;
alter table public.member_product_access enable row level security;
alter table public.invitations enable row level security;
alter table public.admin_audit_log enable row level security;

-- Aucune de ces tables ne doit être modifiable depuis le navigateur.
-- Les politiques existantes de family_members/investment_access_grants continuent
-- de gérer la lecture métier ; les opérations d'administration passent par service_role.

create or replace function public.touch_admin_console_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at before update on public.profiles
for each row execute function public.touch_admin_console_updated_at();

drop trigger if exists user_roles_touch_updated_at on public.user_roles;
create trigger user_roles_touch_updated_at before update on public.user_roles
for each row execute function public.touch_admin_console_updated_at();

drop trigger if exists member_product_access_touch_updated_at on public.member_product_access;
create trigger member_product_access_touch_updated_at before update on public.member_product_access
for each row execute function public.touch_admin_console_updated_at();

drop trigger if exists invitations_touch_updated_at on public.invitations;
create trigger invitations_touch_updated_at before update on public.invitations
for each row execute function public.touch_admin_console_updated_at();

-- Complète le trigger d'association déjà présent dans 20260716_cap_family :
-- il conserve la compatibilité avec family_members tout en créant les projections
-- d'administration. Aucun secret Auth n'est copié dans le schéma public.
create or replace function public.link_auth_user_to_family_member()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  linked_member_id uuid;
  linked_role text;
  linked_relationship text;
begin
  select id, role, relationship into linked_member_id, linked_role, linked_relationship
  from public.family_members
  where lower(email) = lower(new.email)
  limit 1;

  if linked_member_id is null then return new; end if;

  update public.family_members
  set auth_user_id = new.id,
      access_status = 'active',
      last_sign_in_at = coalesce(new.last_sign_in_at, now())
  where id = linked_member_id;

  insert into public.profiles as profile(user_id, member_id, relationship)
  values (new.id, linked_member_id, linked_relationship)
  on conflict (user_id) do update set member_id = excluded.member_id, relationship = coalesce(excluded.relationship, profile.relationship);

  insert into public.user_roles(user_id, member_id, role)
  values (new.id, linked_member_id, case when lower(new.email) = 'florent.lambert@gmail.com' then 'super_admin' when linked_role = 'admin' then 'admin' when linked_role = 'viewer' then 'viewer' else 'member' end)
  on conflict (user_id) do update set member_id = excluded.member_id, role = excluded.role;

  if new.email_confirmed_at is not null or new.last_sign_in_at is not null then
    update public.invitations
    set status = 'accepted', accepted_at = coalesce(accepted_at, now()), updated_at = now()
    where member_id = linked_member_id and status in ('pending', 'sent');
  end if;
  return new;
end;
$$;
