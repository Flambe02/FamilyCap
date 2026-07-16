-- Comptes financiers et positions de Cap Family.
-- Cette migration est additive et peut être rejouée sans supprimer de données.

create table if not exists public.financial_accounts (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.family_members(id) on delete cascade,
  name text not null,
  account_type text not null check (account_type in ('bitcoin', 'crypto_exchange', 'bank', 'pea', 'securities', 'savings', 'other')),
  institution text,
  currency text not null default 'EUR',
  account_number_last4 text,
  iban_last4 text,
  wallet_address text,
  network text,
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.holdings (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.financial_accounts(id) on delete cascade,
  asset_type text not null check (asset_type in ('stock', 'etf', 'fund', 'bond', 'crypto', 'cash', 'other')),
  symbol text,
  isin text,
  name text not null,
  quantity numeric(24,8) not null default 0,
  average_cost numeric(20,6),
  currency text not null default 'EUR',
  exchange text,
  market_provider text,
  last_price numeric(20,6),
  last_price_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists financial_accounts_member_idx on public.financial_accounts(member_id, is_active);
create index if not exists holdings_account_idx on public.holdings(account_id);
create index if not exists holdings_symbol_idx on public.holdings(symbol);

alter table public.financial_accounts enable row level security;
alter table public.holdings enable row level security;

drop policy if exists "family member reads own financial accounts" on public.financial_accounts;
create policy "family member reads own financial accounts"
on public.financial_accounts for select to authenticated
using (member_id = public.current_family_member_id() or public.is_cap_family_admin());

drop policy if exists "family member reads own holdings" on public.holdings;
create policy "family member reads own holdings"
on public.holdings for select to authenticated
using (
  exists (
    select 1 from public.financial_accounts account
    where account.id = holdings.account_id
      and (account.member_id = public.current_family_member_id() or public.is_cap_family_admin())
  )
);

-- Les écritures passent par les routes serveur, protégées par requireAdmin().
-- La clé secrète Supabase reste exclusivement dans les variables serveur.
