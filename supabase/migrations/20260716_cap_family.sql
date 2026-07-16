create extension if not exists pgcrypto;

create table if not exists public.family_members (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  email text unique,
  role text not null default 'child' check (role in ('admin', 'adult', 'child', 'viewer')),
  birthday_day integer check (birthday_day between 1 and 31),
  birthday_month integer check (birthday_month between 1 and 12),
  access_status text not null default 'pending',
  auth_user_id uuid unique references auth.users(id) on delete set null,
  is_active boolean not null default true,
  invited_at timestamptz,
  last_sign_in_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.wallets (
  id uuid primary key default gen_random_uuid(),
  member_id uuid references public.family_members(id) on delete cascade,
  member_name text not null,
  label text not null,
  asset_code text not null default 'BTC',
  custody text not null check (custody in ('Ledger', 'Binance commun', 'Autre')),
  public_address text unique,
  network text not null default 'bitcoin-mainnet',
  created_at timestamptz not null default now()
);

create table if not exists public.gift_records (
  id uuid primary key default gen_random_uuid(),
  member_id uuid references public.family_members(id) on delete set null,
  member_name text not null,
  occasion text not null,
  gift_date date not null,
  purchase_date date not null,
  amount_eur numeric(12,2) not null check (amount_eur >= 0),
  btc_amount numeric(18,8) not null check (btc_amount > 0),
  custody text not null check (custody in ('Ledger', 'Binance commun')),
  transfer_date date,
  ledger_amount numeric(18,8),
  public_address text,
  txid text,
  blockchain_status text not null default 'not_checked',
  confirmations integer not null default 0,
  note text,
  created_at timestamptz not null default now()
);

create table if not exists public.transfer_requests (
  id text primary key,
  member_id uuid references public.family_members(id) on delete set null,
  member_name text not null,
  transaction_id text not null,
  btc_amount numeric(18,8),
  requested_at timestamptz not null default now(),
  status text not null default 'Nouvelle' check (status in ('Nouvelle', 'En traitement', 'Transférée')),
  processed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists gift_records_member_date_idx on public.gift_records(member_name, gift_date desc);
create index if not exists transfer_requests_status_idx on public.transfer_requests(status, requested_at desc);

alter table public.family_members enable row level security;
alter table public.wallets enable row level security;
alter table public.gift_records enable row level security;
alter table public.transfer_requests enable row level security;

insert into public.family_members (name, role, birthday_day, birthday_month)
values
  ('Thibault', 'child', 15, 3),
  ('Uhaina', 'child', 16, 8),
  ('Paul', 'child', 18, 11),
  ('Aurore', 'child', 27, 8),
  ('Thomas', 'child', 29, 12)
on conflict (name) do update set
  birthday_day = excluded.birthday_day,
  birthday_month = excluded.birthday_month;

insert into public.wallets (member_id, member_name, label, custody, public_address)
select id, name, 'Ledger de ' || name, 'Ledger',
  case name
    when 'Thibault' then 'bc1qcy4jt8fh5dhj9fq9d4lu2hq6klvvdmlkeqcgks'
    when 'Uhaina' then 'bc1qqkfmts27j07y8u7a6ap7wyczfhe5afyrkn7y2t'
    when 'Paul' then 'bc1qxx7ve23aggf0596zf45kx0ppk5qjggpak82wd5'
    when 'Aurore' then 'bc1qxs2uy67myzfx8z2vtzr6lm3cgrx808azqkt4pg'
    when 'Thomas' then 'bc1qfwuze87xnhxjfdmr3wnfy3wguu5ymedk4qcwjr'
  end
from public.family_members
where name in ('Thibault', 'Uhaina', 'Paul', 'Aurore', 'Thomas')
on conflict (public_address) do update set member_name = excluded.member_name, label = excluded.label;

-- Aucune politique publique n’est créée volontairement.
-- La clé publishable ne peut donc lire aucune donnée avant la mise en place de Supabase Auth
-- et de politiques RLS propres à chaque membre de la famille.
alter table public.family_members add column if not exists auth_user_id uuid references auth.users(id) on delete set null;
alter table public.family_members add column if not exists is_active boolean not null default true;
alter table public.family_members add column if not exists invited_at timestamptz;
alter table public.family_members add column if not exists last_sign_in_at timestamptz;
create unique index if not exists family_members_email_unique_idx on public.family_members(email);
create unique index if not exists family_members_auth_user_unique_idx on public.family_members(auth_user_id);
insert into public.family_members (name, email, role, access_status, is_active)
values ('Florent', 'florent.lambert@gmail.com', 'admin', 'allowed', true)
on conflict (name) do update set
  email = excluded.email,
  role = 'admin',
  is_active = true;

create or replace function public.hook_allow_cap_family_member(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  requested_email text;
  allowed_count integer;
begin
  requested_email := lower(event->'user'->>'email');
  select count(*) into allowed_count
  from public.family_members
  where lower(email) = requested_email and is_active = true;

  if allowed_count = 1 then
    return '{}'::jsonb;
  end if;

  return jsonb_build_object(
    'error', jsonb_build_object(
      'http_code', 403,
      'message', 'Cette adresse e-mail ne fait pas partie de Cap Family.'
    )
  );
end;
$$;

grant execute on function public.hook_allow_cap_family_member(jsonb) to supabase_auth_admin;
revoke execute on function public.hook_allow_cap_family_member(jsonb) from authenticated, anon, public;

create or replace function public.link_auth_user_to_family_member()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.family_members
  set auth_user_id = new.id,
      access_status = 'active',
      last_sign_in_at = now()
  where lower(email) = lower(new.email);
  return new;
end;
$$;

drop trigger if exists on_cap_family_auth_user_created on auth.users;
create trigger on_cap_family_auth_user_created
after insert or update of last_sign_in_at on auth.users
for each row execute function public.link_auth_user_to_family_member();

create or replace function public.current_family_member_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.family_members where auth_user_id = auth.uid() and is_active = true limit 1;
$$;

create or replace function public.is_cap_family_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.family_members
    where auth_user_id = auth.uid()
      and role = 'admin'
      and lower(email) = 'florent.lambert@gmail.com'
      and is_active = true
  );
$$;

grant execute on function public.current_family_member_id() to authenticated;
grant execute on function public.is_cap_family_admin() to authenticated;

drop policy if exists "family member reads own profile" on public.family_members;
create policy "family member reads own profile"
on public.family_members for select to authenticated
using (auth_user_id = auth.uid() or public.is_cap_family_admin());

drop policy if exists "family member reads own wallets" on public.wallets;
create policy "family member reads own wallets"
on public.wallets for select to authenticated
using (member_id = public.current_family_member_id() or public.is_cap_family_admin());

drop policy if exists "family member reads own gifts" on public.gift_records;
create policy "family member reads own gifts"
on public.gift_records for select to authenticated
using (member_id = public.current_family_member_id() or public.is_cap_family_admin());

drop policy if exists "family member reads own transfer requests" on public.transfer_requests;
create policy "family member reads own transfer requests"
on public.transfer_requests for select to authenticated
using (member_id = public.current_family_member_id() or public.is_cap_family_admin());

-- À activer ensuite dans Authentication > Hooks :
-- Before User Created -> Postgres function -> public.hook_allow_cap_family_member
