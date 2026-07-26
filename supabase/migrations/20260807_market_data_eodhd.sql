-- Données de marché pour les comptes PEA / compte-titres.
--
-- Migration additive et rejouable : `holdings` reste un REFERENTIEL d'actifs et de métadonnées
-- (sa colonne quantity ne participe jamais au portefeuille). Les quantités, PRU, mouvements,
-- dividendes encaissés et frais restent exclusivement dans `account_operations`.
--
-- À exécuter manuellement dans Supabase APRÈS 20260806_holdings_market_symbol.sql.

alter table public.holdings add column if not exists provider_symbol text;
alter table public.holdings add column if not exists mic_code text;
alter table public.holdings add column if not exists data_provider text;
alter table public.holdings add column if not exists quote_mode text;
alter table public.holdings add column if not exists country text;

alter table public.holdings drop constraint if exists holdings_asset_type_check;
alter table public.holdings add constraint holdings_asset_type_check
  check (asset_type in ('stock', 'etf', 'fund', 'bond', 'reit', 'gold', 'crypto', 'cash', 'other'));
alter table public.holdings drop constraint if exists holdings_quote_mode_check;
alter table public.holdings add constraint holdings_quote_mode_check
  check (quote_mode is null or quote_mode in ('eod', 'delayed', 'realtime', 'manual'));

comment on column public.holdings.quantity is
  'Champ historique non utilisé comme source de vérité. Toute quantité détenue est calculée depuis public.account_operations.';
comment on column public.holdings.provider_symbol is
  'Symbole validé auprès du fournisseur de marché (ex. AIR.PA). Ne jamais le déduire uniquement du nom.';

-- Classification des référentiels déjà présents : appariement exclusivement par ISIN (jamais
-- par le libellé). Les provider_symbol restent volontairement vides : leur association EODHD
-- doit être confirmée dans l'interface administrateur avec une place de cotation explicite.
update public.holdings set asset_type = case isin
  when 'FR0007052782' then 'etf'
  when 'IE000BI8OT95' then 'etf'
  when 'FR0011550185' then 'etf'
  when 'DE000A0H0728' then 'etf'
  when 'IE00B0M62S72' then 'etf'
  when 'IE00B8GKDB10' then 'etf'
  when 'FR0013416716' then 'gold'
  when 'FR0000121964' then 'reit'
  when 'FR0000120073' then 'stock'
  when 'FR0014010OO5' then 'stock'
  when 'US02079K1079' then 'stock'
  when 'US0231351067' then 'stock'
  when 'FR0004125920' then 'stock'
  when 'US0378331005' then 'stock'
  when 'NL0010273215' then 'stock'
  when 'FR0000131104' then 'stock'
  when 'FR0010667147' then 'stock'
  when 'US19260Q1076' then 'stock'
  when 'FR0010908533' then 'stock'
  when 'FR0013451333' then 'stock'
  when 'FR0000121014' then 'stock'
  when 'US5949181045' then 'stock'
  when 'FR0000133308' then 'stock'
  when 'FR0000130809' then 'stock'
  when 'FR0000121220' then 'stock'
  when 'FR0000120271' then 'stock'
  when 'US90353T1007' then 'stock'
  when 'US96208T1043' then 'stock'
  else asset_type
end
where isin in (
  'FR0007052782','IE000BI8OT95','FR0011550185','DE000A0H0728','IE00B0M62S72','IE00B8GKDB10','FR0013416716','FR0000121964',
  'FR0000120073','FR0014010OO5','US02079K1079','US0231351067','FR0004125920','US0378331005','NL0010273215','FR0000131104',
  'FR0010667147','US19260Q1076','FR0010908533','FR0013451333','FR0000121014','US5949181045','FR0000133308','FR0000130809',
  'FR0000121220','FR0000120271','US90353T1007','US96208T1043'
);

create index if not exists holdings_provider_symbol_idx on public.holdings(data_provider, provider_symbol)
  where provider_symbol is not null;

create table if not exists public.market_quotes (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.holdings(id) on delete cascade,
  provider text not null,
  provider_symbol text not null,
  price numeric(24, 8) not null check (price > 0),
  currency text not null,
  quoted_at timestamptz not null,
  market_status text not null default 'unknown',
  data_delay_minutes integer check (data_delay_minutes is null or data_delay_minutes >= 0),
  fetched_at timestamptz not null default now(),
  raw_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint market_quotes_provider_symbol_key unique(provider, provider_symbol)
);
create index if not exists market_quotes_asset_idx on public.market_quotes(asset_id, quoted_at desc);

create table if not exists public.market_fx_rates (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  base_currency text not null,
  quote_currency text not null,
  rate numeric(24, 12) not null check (rate > 0),
  quoted_at timestamptz not null,
  fetched_at timestamptz not null default now(),
  raw_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint market_fx_rates_pair_date_key unique(provider, base_currency, quote_currency, quoted_at)
);
create index if not exists market_fx_rates_lookup_idx on public.market_fx_rates(base_currency, quote_currency, quoted_at desc);

create table if not exists public.corporate_actions (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.holdings(id) on delete cascade,
  provider text not null,
  provider_event_id text,
  action_type text not null check (action_type in ('dividend', 'split')),
  ex_date date not null,
  declaration_date date,
  record_date date,
  payment_date date,
  amount_per_share numeric(24, 8),
  currency text,
  split_from numeric(24, 8),
  split_to numeric(24, 8),
  status text not null default 'announced',
  fetched_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint corporate_actions_identity_key unique nulls not distinct
    (asset_id, provider, provider_event_id, action_type, ex_date, amount_per_share, split_from, split_to)
);
create index if not exists corporate_actions_asset_date_idx on public.corporate_actions(asset_id, ex_date desc);

-- Journal minimal des appels externes : permet de faire respecter le plafond quotidien EODHD,
-- y compris quand une réponse est en erreur et donc qu'aucun cours n'est mis en cache.
create table if not exists public.market_data_requests (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  request_key text not null,
  request_date date not null default current_date,
  created_at timestamptz not null default now(),
  constraint market_data_requests_daily_key unique(provider, request_key, request_date)
);
create index if not exists market_data_requests_quota_idx on public.market_data_requests(provider, request_date);

-- Verrou persistant de courte durée : évite que deux clics / deux onglets consomment deux fois
-- le quota quotidien du fournisseur. Les fonctions SECURITY DEFINER ne sont appelables que par
-- le serveur (la route vérifie requireAdmin avant l'appel).
create table if not exists public.market_refresh_locks (
  account_id uuid primary key references public.financial_accounts(id) on delete cascade,
  locked_until timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.try_acquire_market_refresh_lock(p_account_id uuid, p_seconds integer default 120)
returns boolean language plpgsql security definer set search_path = public as $$
declare acquired boolean := false;
begin
  insert into public.market_refresh_locks(account_id, locked_until, updated_at)
  values (p_account_id, now() + make_interval(secs => greatest(15, least(p_seconds, 600))), now())
  on conflict (account_id) do update
    set locked_until = excluded.locked_until, updated_at = now()
    where market_refresh_locks.locked_until < now()
  returning true into acquired;
  return coalesce(acquired, false);
end;
$$;

create or replace function public.release_market_refresh_lock(p_account_id uuid)
returns void language sql security definer set search_path = public as $$
  delete from public.market_refresh_locks where account_id = p_account_id;
$$;

alter table public.market_quotes enable row level security;
alter table public.market_fx_rates enable row level security;
alter table public.corporate_actions enable row level security;
alter table public.market_refresh_locks enable row level security;
alter table public.market_data_requests enable row level security;

-- Lecture restreinte au détenteur du compte associé (ou administrateur). Écriture : route
-- serveur utilisant la clé de service, jamais navigateur / clé fournisseur.
drop policy if exists "member reads market quotes for visible account" on public.market_quotes;
create policy "member reads market quotes for visible account" on public.market_quotes for select to authenticated using (
  exists (select 1 from public.holdings h join public.financial_accounts a on a.id = h.account_id
    where h.id = market_quotes.asset_id and (a.member_id = public.current_family_member_id() or public.is_cap_family_admin()))
);
drop policy if exists "member reads corporate actions for visible account" on public.corporate_actions;
create policy "member reads corporate actions for visible account" on public.corporate_actions for select to authenticated using (
  exists (select 1 from public.holdings h join public.financial_accounts a on a.id = h.account_id
    where h.id = corporate_actions.asset_id and (a.member_id = public.current_family_member_id() or public.is_cap_family_admin()))
);
drop policy if exists "authenticated reads fx rates" on public.market_fx_rates;
create policy "authenticated reads fx rates" on public.market_fx_rates for select to authenticated using (true);

revoke all on function public.try_acquire_market_refresh_lock(uuid, integer) from public;
revoke all on function public.release_market_refresh_lock(uuid) from public;
grant execute on function public.try_acquire_market_refresh_lock(uuid, integer) to service_role;
grant execute on function public.release_market_refresh_lock(uuid) to service_role;
