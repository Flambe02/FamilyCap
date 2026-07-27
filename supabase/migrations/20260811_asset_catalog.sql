-- Catalogue d'actifs cotés : identité canonique (assets) + cotation (asset_listings).
--
-- POURQUOI UNE NOUVELLE TABLE PLUTÔT QU'ÉTENDRE `holdings` :
-- `holdings.account_id` est NOT NULL — la table est donc DUPLIQUÉE par compte. Elle ne peut pas
-- porter une identité canonique : deux membres détenant Air Liquide produisent deux lignes, donc
-- deux `asset_id` — alors que `market_quotes` a une clé unique GLOBALE (provider, provider_symbol).
-- C'est exactement la contradiction qui fait qu'un compte perd ses cours au profit de l'autre.
-- `holdings` reste ce qu'elle est (référentiel de prix par compte, quantity toujours 0) ; on lui
-- ajoute seulement un pont `listing_id`.
--
-- CE QUE CETTE MIGRATION NE FAIT PAS :
--   - aucune écriture dans `account_operations` (les lignes historiques ne sont pas touchées) ;
--   - aucune colonne rendue obligatoire (`asset_id` / `listing_id` sont NULLABLES par conception,
--     l'historique antérieur reste valide et calculable par computeAccountModel) ;
--   - aucune suppression, aucun renommage, aucune contrainte durcie sur l'existant.
-- Additive et idempotente : rejouable sans effet de bord.

-- ==========================================================================================
-- A. ACTIF CANONIQUE
-- ==========================================================================================
create table if not exists public.assets (
  id uuid primary key default gen_random_uuid(),
  isin text,
  name text not null,
  asset_type text not null default 'other',
  issuer text,
  -- verified = correction administrateur (jamais écrasée) ; inferred = ISIN/référentiel fiable ;
  -- needs_review = ambigu. Un ÉCHEC FOURNISSEUR NE DÉGRADE JAMAIS ce statut (cf. §10 du cahier).
  classification_status text not null default 'needs_review',
  source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.assets drop constraint if exists assets_asset_type_check;
alter table public.assets add constraint assets_asset_type_check
  check (asset_type in ('stock', 'etf', 'fund', 'bond', 'reit', 'gold', 'crypto', 'cash', 'other'));

alter table public.assets drop constraint if exists assets_classification_status_check;
alter table public.assets add constraint assets_classification_status_check
  check (classification_status in ('verified', 'inferred', 'needs_review'));

alter table public.assets drop constraint if exists assets_isin_format_check;
alter table public.assets add constraint assets_isin_format_check
  check (isin is null or isin ~ '^[A-Z]{2}[A-Z0-9]{9}[0-9]$');

-- Un ISIN identifie UN actif canonique : c'est cette contrainte qui rend le doublon impossible
-- (§9.6 du cahier). Partielle car un actif non coté n'a pas toujours d'ISIN.
create unique index if not exists assets_isin_key on public.assets (upper(isin)) where isin is not null;
create index if not exists assets_name_idx on public.assets (lower(name));
create index if not exists assets_review_idx on public.assets (classification_status)
  where classification_status = 'needs_review';

comment on table public.assets is
  'Actif canonique (identité stable). Une ligne par instrument, JAMAIS par compte — contrairement à holdings.';
comment on column public.assets.classification_status is
  'verified = correction admin (immuable) ; inferred = ISIN/import fiable ; needs_review = ambigu. Jamais dégradé par une panne de cours.';

-- ==========================================================================================
-- B. COTATION (place + devise + symboles fournisseurs)
-- ==========================================================================================
-- Un même actif peut être coté sur plusieurs places, dans plusieurs devises. C'est la cotation,
-- pas l'actif, qui porte le symbole fournisseur et à laquelle un cours se rattache.
create table if not exists public.asset_listings (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.assets(id) on delete cascade,
  ticker text,
  exchange text,
  mic_code text,
  currency text not null,
  country text,
  eodhd_symbol text,
  yahoo_symbol text,
  is_primary boolean not null default false,
  validation_status text not null default 'inferred',
  source text,
  -- Dernier cours connu POUR CETTE COTATION (et non pour un compte). Alimenté par le pipeline
  -- existant ; sa fraîcheur n'a aucune influence sur la classification de l'actif.
  last_price numeric(20, 6),
  last_price_at timestamptz,
  last_price_provider text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.asset_listings drop constraint if exists asset_listings_currency_check;
alter table public.asset_listings add constraint asset_listings_currency_check
  check (currency ~ '^[A-Z]{3}$');

alter table public.asset_listings drop constraint if exists asset_listings_validation_status_check;
alter table public.asset_listings add constraint asset_listings_validation_status_check
  check (validation_status in ('verified', 'inferred', 'needs_review'));

alter table public.asset_listings drop constraint if exists asset_listings_mic_check;
alter table public.asset_listings add constraint asset_listings_mic_check
  check (mic_code is null or mic_code ~ '^[A-Z0-9]{4}$');

-- Identité d'une cotation = actif + place + devise (+ ticker en dernier recours quand la place
-- n'est pas connue). coalesce() car MIC et ticker peuvent manquer chez le fournisseur : sans lui,
-- deux NULL seraient considérés distincts et le doublon repasserait.
create unique index if not exists asset_listings_identity_key on public.asset_listings (
  asset_id,
  coalesce(upper(mic_code), ''),
  upper(currency),
  coalesce(upper(ticker), '')
);
-- Un symbole Yahoo désigne UNE cotation et une seule : c'est la clé de rapprochement du secours.
create unique index if not exists asset_listings_yahoo_key on public.asset_listings (upper(yahoo_symbol))
  where yahoo_symbol is not null;
create unique index if not exists asset_listings_eodhd_key on public.asset_listings (upper(eodhd_symbol))
  where eodhd_symbol is not null;
create index if not exists asset_listings_asset_idx on public.asset_listings (asset_id);
create index if not exists asset_listings_ticker_idx on public.asset_listings (upper(ticker))
  where ticker is not null;

comment on table public.asset_listings is
  'Cotation d''un actif canonique : place, devise, symboles fournisseurs. Un cours se rattache ICI.';
comment on column public.asset_listings.validation_status is
  'verified = cotation confirmée par un administrateur ; inferred = déduite d''un ISIN ou du service de résolution.';

-- ==========================================================================================
-- C. RATTACHEMENT DE L'OPÉRATION À L'IDENTITÉ STABLE
-- ==========================================================================================
-- NULLABLES à dessein : les opérations antérieures n'ont pas d'identité stable et doivent rester
-- lisibles et calculables telles quelles. La compatibilité est PROGRESSIVE (§8 du cahier) — on ne
-- rend jamais ces colonnes obligatoires, et aucune reprise automatique n'est faite ici.
alter table public.account_operations
  add column if not exists asset_id uuid references public.assets(id) on delete set null;
alter table public.account_operations
  add column if not exists listing_id uuid references public.asset_listings(id) on delete set null;

create index if not exists account_operations_asset_idx on public.account_operations (asset_id)
  where asset_id is not null;
create index if not exists account_operations_listing_idx on public.account_operations (listing_id)
  where listing_id is not null;

comment on column public.account_operations.asset_id is
  'Actif canonique sélectionné à la saisie. NULL = opération historique antérieure au catalogue (jamais réécrite silencieusement).';
comment on column public.account_operations.listing_id is
  'Cotation sélectionnée : c''est elle qui détermine la devise, la place et le symbole de synchronisation du cours.';

-- ==========================================================================================
-- D. PONT VERS LE RÉFÉRENTIEL DE PRIX EXISTANT
-- ==========================================================================================
-- `holdings` continue d'exister et de servir de référentiel de prix par compte ; on lui ajoute le
-- lien vers la cotation pour que le pipeline puisse lire un symbole fiable au lieu de le déduire.
alter table public.holdings
  add column if not exists listing_id uuid references public.asset_listings(id) on delete set null;
create index if not exists holdings_listing_idx on public.holdings (listing_id) where listing_id is not null;

comment on column public.holdings.listing_id is
  'Cotation de référence. Renseignée, elle prime sur provider_symbol/yahoo_symbol pour synchroniser le cours.';

-- ==========================================================================================
-- E. RLS — métadonnées communes en lecture, écriture serveur uniquement
-- ==========================================================================================
-- Le catalogue ne contient AUCUNE donnée financière d'un membre (ni quantité, ni montant, ni
-- compte) : il est lisible par tout membre authentifié, ce qui est nécessaire pour que la
-- recherche fonctionne. L'écriture reste réservée aux services serveur (clé de service).
alter table public.assets enable row level security;
alter table public.asset_listings enable row level security;

drop policy if exists "authenticated reads assets" on public.assets;
create policy "authenticated reads assets" on public.assets
  for select to authenticated using (true);

drop policy if exists "authenticated reads asset listings" on public.asset_listings;
create policy "authenticated reads asset listings" on public.asset_listings
  for select to authenticated using (true);

revoke insert, update, delete on public.assets from anon, authenticated;
revoke insert, update, delete on public.asset_listings from anon, authenticated;
grant select on public.assets to authenticated;
grant select on public.asset_listings to authenticated;

-- ==========================================================================================
-- F. AMORÇAGE — uniquement des identités VÉRIFIABLES, aucune donnée inventée
-- ==========================================================================================
-- Air Liquide : le cas de référence du cahier des charges. Repris de VERIFIED_ISIN
-- (lib/market-identity.ts) et de la migration 20260810, sans rien ajouter d'autre.
insert into public.assets (isin, name, asset_type, issuer, classification_status, source)
values ('FR0000120073', 'Air Liquide', 'stock', 'L''Air Liquide S.A.', 'verified', 'seed')
on conflict do nothing;

insert into public.asset_listings (asset_id, ticker, exchange, mic_code, currency, country, eodhd_symbol, yahoo_symbol, is_primary, validation_status, source)
select a.id, 'AI', 'Euronext Paris', 'XPAR', 'EUR', 'France', 'AI.PA', 'AI.PA', true, 'verified', 'seed'
from public.assets a
where upper(a.isin) = 'FR0000120073'
on conflict do nothing;

-- Reprise NON destructive des cotations déjà confirmées à la main par l'administrateur dans
-- `holdings` (classification_status = 'verified'). On ne reprend QUE celles-là : une ligne
-- « needs_review » ou « inferred » resterait une supposition, et le cahier interdit de rattacher
-- l'historique par correspondance approximative non contrôlée (§13).
insert into public.assets (isin, name, asset_type, classification_status, source)
select distinct on (upper(h.isin))
  upper(h.isin), h.name, h.asset_type, 'verified', 'holdings'
from public.holdings h
where h.classification_status = 'verified'
  and h.isin is not null
  and upper(h.isin) ~ '^[A-Z]{2}[A-Z0-9]{9}[0-9]$'
order by upper(h.isin), h.updated_at desc
on conflict do nothing;
