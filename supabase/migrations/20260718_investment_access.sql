-- Partage controle des investissements Cap Family.
-- A executer apres les migrations 20260716_*.


-- Synchronise le changement d'e-mail seulement lorsque Supabase Auth l'a confirme.
create or replace function public.link_auth_user_to_family_member()
returns trigger
language plpgsql
security definer
set search_path = public
as $capfamily_email_sync$
begin
  if TG_OP = 'UPDATE' and lower(new.email) <> lower(old.email) then
    update public.family_members
    set email = lower(new.email),
        auth_user_id = new.id,
        access_status = 'active',
        last_sign_in_at = coalesce(new.last_sign_in_at, last_sign_in_at)
    where lower(email) = lower(old.email);
  else
    update public.family_members
    set auth_user_id = new.id,
        access_status = 'active',
        last_sign_in_at = coalesce(new.last_sign_in_at, last_sign_in_at)
    where lower(email) = lower(new.email);
  end if;
  return new;
end;
$capfamily_email_sync$;

drop trigger if exists on_cap_family_auth_user_created on auth.users;
create trigger on_cap_family_auth_user_created
after insert or update of last_sign_in_at, email on auth.users
for each row execute function public.link_auth_user_to_family_member();

alter table public.family_members
  add column if not exists investment_access_scope text not null default 'family';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'family_members_investment_access_scope_check'
  ) then
    alter table public.family_members
      add constraint family_members_investment_access_scope_check
      check (investment_access_scope in ('family', 'selected'));
  end if;
end $$;

create table if not exists public.investment_access_grants (
  owner_member_id uuid not null references public.family_members(id) on delete cascade,
  viewer_member_id uuid not null references public.family_members(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (owner_member_id, viewer_member_id),
  check (owner_member_id <> viewer_member_id)
);

create index if not exists investment_access_grants_viewer_idx
  on public.investment_access_grants(viewer_member_id);

alter table public.investment_access_grants enable row level security;

create or replace function public.can_view_member_investments(target_member_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    public.is_cap_family_admin()
    or target_member_id = public.current_family_member_id()
    or exists (
      select 1
      from public.family_members owner
      where owner.id = target_member_id
        and owner.is_active = true
        and (
          owner.investment_access_scope = 'family'
          or exists (
            select 1
            from public.investment_access_grants access_grant
            where access_grant.owner_member_id = owner.id
              and access_grant.viewer_member_id = public.current_family_member_id()
          )
        )
    );
$$;

grant execute on function public.can_view_member_investments(uuid) to authenticated;

drop policy if exists "member reads own investment grants" on public.investment_access_grants;
create policy "member reads own investment grants"
on public.investment_access_grants for select to authenticated
using (owner_member_id = public.current_family_member_id() or public.is_cap_family_admin());

drop policy if exists "member manages own investment grants" on public.investment_access_grants;
create policy "member manages own investment grants"
on public.investment_access_grants for all to authenticated
using (owner_member_id = public.current_family_member_id() or public.is_cap_family_admin())
with check (owner_member_id = public.current_family_member_id() or public.is_cap_family_admin());

-- Anciennes lignes importees : rattachement au membre pour que la RLS puisse les proteger.
update public.gift_records gift
set member_id = member.id
from public.family_members member
where gift.member_id is null and gift.member_name = member.name;

-- Les administrateurs gardent leur acces de gestion. Les autres acces suivent le choix du proprietaire.
drop policy if exists "family member reads own wallets" on public.wallets;
drop policy if exists "family member reads shared wallets" on public.wallets;
create policy "family member reads shared wallets"
on public.wallets for select to authenticated
using (public.can_view_member_investments(member_id));

drop policy if exists "family member reads own gifts" on public.gift_records;
drop policy if exists "family member reads shared gifts" on public.gift_records;
create policy "family member reads shared gifts"
on public.gift_records for select to authenticated
using (public.can_view_member_investments(member_id));

-- Ces deux tables sont optionnelles dans les installations deja en production.
do $investment_policy$
begin
  if to_regclass('public.financial_accounts') is not null then
    execute 'drop policy if exists "family member reads own financial accounts" on public.financial_accounts';
    execute 'drop policy if exists "family member reads shared financial accounts" on public.financial_accounts';
    execute 'create policy "family member reads shared financial accounts" on public.financial_accounts for select to authenticated using (public.can_view_member_investments(member_id))';
  end if;

  if to_regclass('public.holdings') is not null then
    execute 'drop policy if exists "family member reads own holdings" on public.holdings';
    execute 'drop policy if exists "family member reads shared holdings" on public.holdings';
    execute 'create policy "family member reads shared holdings" on public.holdings for select to authenticated using (exists (select 1 from public.financial_accounts account where account.id = holdings.account_id and public.can_view_member_investments(account.member_id)))';
  end if;
end;
$investment_policy$;

-- Tous les membres portant le role Administrateur peuvent gerer la famille.
create or replace function public.is_cap_family_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $capfamily_admin$
  select exists (
    select 1 from public.family_members
    where auth_user_id = auth.uid()
      and role = 'admin'
      and is_active = true
  );
$capfamily_admin$;
