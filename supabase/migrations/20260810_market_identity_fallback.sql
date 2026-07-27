-- Identité stable des actifs et secours Yahoo (serveur uniquement).
-- Additive et idempotente : ne touche ni account_operations ni les quantités de holdings.

alter table public.holdings add column if not exists yahoo_symbol text;
alter table public.holdings add column if not exists classification_status text not null default 'needs_review';

alter table public.holdings drop constraint if exists holdings_classification_status_check;
alter table public.holdings add constraint holdings_classification_status_check
  check (classification_status in ('verified', 'inferred', 'needs_review'));

comment on column public.holdings.yahoo_symbol is
  'Symbole Yahoo validé ou inféré depuis un ISIN, distinct du provider_symbol EODHD.';
comment on column public.holdings.classification_status is
  'verified = correction administrateur; inferred = ISIN/import fiable; needs_review = ambigu.';

create index if not exists holdings_yahoo_symbol_idx on public.holdings(yahoo_symbol)
  where yahoo_symbol is not null;

-- Air Liquide : identité ISIN et place principale vérifiées. La clause préserve toute
-- correction manuelle antérieure (classification_status = verified).
update public.holdings
set asset_type = 'stock',
    currency = coalesce(nullif(currency, ''), 'EUR'),
    exchange = coalesce(nullif(exchange, ''), 'Euronext Paris'),
    mic_code = coalesce(nullif(mic_code, ''), 'XPAR'),
    provider_symbol = coalesce(nullif(provider_symbol, ''), 'AI.PA'),
    yahoo_symbol = coalesce(nullif(yahoo_symbol, ''), 'AI.PA'),
    data_provider = case when coalesce(nullif(provider_symbol, ''), 'AI.PA') = 'AI.PA' then 'eodhd' else data_provider end,
    quote_mode = case when coalesce(nullif(provider_symbol, ''), 'AI.PA') = 'AI.PA' then 'eod' else quote_mode end,
    classification_status = 'inferred'
where upper(coalesce(isin, '')) = 'FR0000120073'
  and classification_status <> 'verified';

-- Les catégories déjà importées et non génériques restent une classification fiable ;
-- aucune valeur n'est déduite d'un échec de fournisseur.
update public.holdings
set classification_status = 'inferred'
where classification_status = 'needs_review'
  and asset_type in ('stock', 'etf', 'fund', 'bond', 'reit', 'gold', 'crypto', 'cash');
