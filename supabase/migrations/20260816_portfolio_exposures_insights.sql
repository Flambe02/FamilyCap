-- Exposition géographique / sectorielle, séries de référence (benchmark), cache d'analyse et
-- taux d'imposition paramétrable du compte-titres.
--
-- ADDITIVE ET IDEMPOTENTE. Ce que cette migration NE FAIT PAS :
--   * aucune écriture, aucune suppression, aucune modification dans `account_operations` ;
--   * aucune quantité, aucun montant, aucun mouvement de trésorerie touché ;
--   * aucune colonne existante rendue obligatoire, renommée ou supprimée ;
--   * aucune table parallèle de positions — les positions restent DÉRIVÉES des opérations.
--
-- À exécuter manuellement dans l'éditeur SQL Supabase, après 20260811_asset_catalog.sql.

-- ==========================================================================================
-- A. EXPOSITION D'UN INSTRUMENT (géographie / secteur)
-- ==========================================================================================
-- Rattachement par ISIN EN PRIORITÉ, et non par `assets.id` : le catalogue canonique ne couvre
-- aujourd'hui qu'une poignée d'instruments, alors que l'ISIN est présent sur la quasi-totalité
-- des lignes réellement détenues. `asset_id` reste disponible pour les instruments catalogués et
-- pour ceux qui n'ont pas d'ISIN. Au moins l'un des deux est exigé.
create table if not exists public.instrument_exposures (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid references public.assets(id) on delete cascade,
  instrument_isin text,
  dimension text not null,
  exposure_code text not null,
  exposure_label text not null,
  weight_percent numeric(9, 4) not null,
  -- D'où vient cette ligne : composition d'indice, classification sectorielle, domiciliation…
  source text not null,
  source_as_of date,
  confidence text not null default 'medium',
  -- `true` = approximation assumée (composition indicative, pays de domiciliation). L'interface
  -- doit l'afficher comme telle : c'est ce qui distingue une donnée d'une supposition.
  is_estimated boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.instrument_exposures drop constraint if exists instrument_exposures_dimension_check;
alter table public.instrument_exposures add constraint instrument_exposures_dimension_check
  check (dimension in ('geography', 'sector'));

alter table public.instrument_exposures drop constraint if exists instrument_exposures_weight_check;
alter table public.instrument_exposures add constraint instrument_exposures_weight_check
  check (weight_percent > 0 and weight_percent <= 100);

alter table public.instrument_exposures drop constraint if exists instrument_exposures_confidence_check;
alter table public.instrument_exposures add constraint instrument_exposures_confidence_check
  check (confidence in ('high', 'medium', 'low'));

alter table public.instrument_exposures drop constraint if exists instrument_exposures_isin_check;
alter table public.instrument_exposures add constraint instrument_exposures_isin_check
  check (instrument_isin is null or instrument_isin ~ '^[A-Z]{2}[A-Z0-9]{9}[0-9]$');

alter table public.instrument_exposures drop constraint if exists instrument_exposures_identity_check;
alter table public.instrument_exposures add constraint instrument_exposures_identity_check
  check (asset_id is not null or instrument_isin is not null);

-- Une zone ne peut être déclarée qu'une fois par instrument et par dimension. coalesce() car
-- l'identité repose tantôt sur l'ISIN, tantôt sur l'actif canonique.
create unique index if not exists instrument_exposures_identity_key on public.instrument_exposures (
  coalesce(instrument_isin, ''),
  coalesce(asset_id::text, ''),
  dimension,
  exposure_code
);
create index if not exists instrument_exposures_isin_idx on public.instrument_exposures (instrument_isin)
  where instrument_isin is not null;

comment on table public.instrument_exposures is
  'Exposition géographique/sectorielle d''un instrument. Un ETF n''est JAMAIS rattaché à son pays de cotation : seule la composition de son indice fait foi, et elle est datée et sourcée.';
comment on column public.instrument_exposures.is_estimated is
  'true = approximation assumée (composition indicative, pays de domiciliation). Affichée comme telle, jamais comme une donnée certaine.';

-- ==========================================================================================
-- B. SÉRIES DE RÉFÉRENCE (benchmark)
-- ==========================================================================================
-- Table vide à la création. Elle est alimentée par POST /api/market-data/benchmarks (admin), qui
-- lit un fournisseur gratuit. Tant qu'elle est vide, l'écran Performance affiche « comparaison
-- indisponible » — il n'invente aucune courbe de référence.
create table if not exists public.benchmark_series (
  id uuid primary key default gen_random_uuid(),
  benchmark_code text not null,
  series_date date not null,
  close numeric(20, 6) not null check (close > 0),
  currency text not null default 'EUR',
  source text not null,
  fetched_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint benchmark_series_identity_key unique (benchmark_code, series_date)
);
create index if not exists benchmark_series_lookup_idx on public.benchmark_series (benchmark_code, series_date desc);

comment on table public.benchmark_series is
  'Historique d''un indice de référence, normalisé à l''affichage. Vide = aucune comparaison affichée (jamais une courbe inventée).';

-- ==========================================================================================
-- C. CACHE D'ANALYSE IA
-- ==========================================================================================
-- L'analyse est régénérée UNIQUEMENT quand l'empreinte des données change, ou sur demande
-- explicite. `facts` conserve l'objet déterministe envoyé au modèle : une analyse doit rester
-- vérifiable a posteriori contre les chiffres qui l'ont produite.
create table if not exists public.portfolio_analyses (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.financial_accounts(id) on delete cascade,
  facts_hash text not null,
  facts jsonb not null default '{}'::jsonb,
  observations jsonb not null default '[]'::jsonb,
  coverage_label text,
  provider text not null default 'deterministic',
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint portfolio_analyses_identity_key unique (account_id, facts_hash)
);
create index if not exists portfolio_analyses_account_idx on public.portfolio_analyses (account_id, generated_at desc);

-- ==========================================================================================
-- D. FISCALITÉ PARAMÉTRABLE DU COMPTE-TITRES
-- ==========================================================================================
-- NULL = non paramétré. L'interface applique alors l'hypothèse PFU 30 % en l'ANNONÇANT comme une
-- hypothèse. Le PEA ignore complètement ce champ : aucun prélèvement n'y est appliqué par dividende.
alter table public.financial_accounts add column if not exists dividend_tax_rate numeric(6, 4);
alter table public.financial_accounts drop constraint if exists financial_accounts_dividend_tax_rate_check;
alter table public.financial_accounts add constraint financial_accounts_dividend_tax_rate_check
  check (dividend_tax_rate is null or (dividend_tax_rate >= 0 and dividend_tax_rate <= 1));
comment on column public.financial_accounts.dividend_tax_rate is
  'Taux d''imposition des dividendes du compte-titres (0 à 1). NULL = non paramétré → hypothèse PFU 30 % annoncée comme telle. Ignoré pour un PEA.';

-- ==========================================================================================
-- E. RLS
-- ==========================================================================================
-- Expositions et benchmarks : métadonnées de marché, aucune donnée financière d'un membre
-- (ni quantité, ni montant, ni compte). Lecture par tout membre authentifié, écriture réservée
-- aux services serveur (clé de service) — même modèle que `assets` / `asset_listings`.
alter table public.instrument_exposures enable row level security;
alter table public.benchmark_series enable row level security;
alter table public.portfolio_analyses enable row level security;

drop policy if exists "authenticated reads instrument exposures" on public.instrument_exposures;
create policy "authenticated reads instrument exposures" on public.instrument_exposures
  for select to authenticated using (true);

drop policy if exists "authenticated reads benchmark series" on public.benchmark_series;
create policy "authenticated reads benchmark series" on public.benchmark_series
  for select to authenticated using (true);

-- L'analyse, elle, PARLE d'un compte : elle suit exactement la règle de partage familial des
-- investissements, comme market_quotes et corporate_actions.
drop policy if exists "member reads portfolio analysis for visible account" on public.portfolio_analyses;
create policy "member reads portfolio analysis for visible account" on public.portfolio_analyses
  for select to authenticated using (
    exists (
      select 1 from public.financial_accounts a
      where a.id = portfolio_analyses.account_id
        and (a.member_id = public.current_family_member_id() or public.is_cap_family_admin())
    )
  );

revoke insert, update, delete on public.instrument_exposures from anon, authenticated;
revoke insert, update, delete on public.benchmark_series from anon, authenticated;
revoke insert, update, delete on public.portfolio_analyses from anon, authenticated;
grant select on public.instrument_exposures to authenticated;
grant select on public.benchmark_series to authenticated;
grant select on public.portfolio_analyses to authenticated;

-- ==========================================================================================
-- F. AMORÇAGE
-- ==========================================================================================
-- Deux niveaux de fiabilité, explicitement distincts :
--
--   is_estimated = false — l'exposition découle de la DÉFINITION de l'instrument : un ETF CAC 40
--     est intégralement exposé à la France, un ETF S&P 500 aux États-Unis, un ETF « zone euro » à
--     la zone euro, un ETF matières premières aux matières premières. Ce ne sont pas des mesures,
--     ce sont des constructions d'indice.
--
--   is_estimated = true — répartition INDICATIVE, à granularité RÉGIONALE volontairement grossière.
--     Les poids pays précis d'un indice mondial bougent en continu et ne peuvent pas être figés
--     dans une migration sans devenir faux ; une répartition régionale reste juste bien plus
--     longtemps, et elle est marquée comme approximation.
--
-- Aucun ETF ne reçoit son pays de cotation. Les ACTIONS EN DIRECT ne sont pas amorcées ici du
-- tout : leur pays est déduit du préfixe ISIN par le code, et affiché comme « approximation
-- (pays de domiciliation) » — ce qui est plus honnête qu'un chiffre d'affaires par pays inventé.

insert into public.instrument_exposures (instrument_isin, dimension, exposure_code, exposure_label, weight_percent, source, source_as_of, confidence, is_estimated)
values
  -- --- Expositions DÉFINITIONNELLES (construction de l'indice) -----------------------------
  ('FR0007052782', 'geography', 'FR',   'France',                                  100, 'Construction de l''indice CAC 40', null, 'high', false),
  ('FR0011550185', 'geography', 'US',   'États-Unis',                              100, 'Construction de l''indice S&P 500', null, 'high', false),
  ('IE00B53L3W79', 'geography', 'EMU',  'Zone euro',                               100, 'Construction de l''indice EURO STOXX 50', null, 'high', false),
  ('IE00B0M62S72', 'geography', 'EMU',  'Zone euro',                               100, 'Construction de l''indice EURO STOXX Select Dividend 30', null, 'high', false),
  ('FR0013412020', 'geography', 'EM',   'Marchés émergents',                       100, 'Construction de l''indice MSCI Emerging Markets', null, 'high', false),
  ('DE000A0H0728', 'geography', 'COMMODITY', 'Matières premières / exposition mondiale', 100, 'Nature de l''ETF (panier diversifié de matières premières)', null, 'high', false),
  ('FR0013416716', 'geography', 'COMMODITY', 'Matières premières / exposition mondiale', 100, 'Nature de l''ETC (or physique)', null, 'high', false),

  -- --- Répartitions INDICATIVES, granularité régionale (approximations assumées) -----------
  ('IE000BI8OT95', 'geography', 'NA',   'Amérique du Nord',                         74, 'Répartition régionale indicative de l''indice MSCI World', '2026-01-01', 'medium', true),
  ('IE000BI8OT95', 'geography', 'EUDEV','Europe développée',                        15, 'Répartition régionale indicative de l''indice MSCI World', '2026-01-01', 'medium', true),
  ('IE000BI8OT95', 'geography', 'JP',   'Japon',                                     6, 'Répartition régionale indicative de l''indice MSCI World', '2026-01-01', 'medium', true),
  ('IE000BI8OT95', 'geography', 'APAC', 'Asie-Pacifique développée (hors Japon)',    5, 'Répartition régionale indicative de l''indice MSCI World', '2026-01-01', 'medium', true),

  ('IE0002XZSHO1', 'geography', 'NA',   'Amérique du Nord',                         74, 'Répartition régionale indicative de l''indice MSCI World', '2026-01-01', 'medium', true),
  ('IE0002XZSHO1', 'geography', 'EUDEV','Europe développée',                        15, 'Répartition régionale indicative de l''indice MSCI World', '2026-01-01', 'medium', true),
  ('IE0002XZSHO1', 'geography', 'JP',   'Japon',                                     6, 'Répartition régionale indicative de l''indice MSCI World', '2026-01-01', 'medium', true),
  ('IE0002XZSHO1', 'geography', 'APAC', 'Asie-Pacifique développée (hors Japon)',    5, 'Répartition régionale indicative de l''indice MSCI World', '2026-01-01', 'medium', true),

  ('IE00B8GKDB10', 'geography', 'NA',   'Amérique du Nord',                         42, 'Répartition régionale indicative de l''indice FTSE All-World High Dividend Yield', '2026-01-01', 'medium', true),
  ('IE00B8GKDB10', 'geography', 'EUDEV','Europe développée',                        24, 'Répartition régionale indicative de l''indice FTSE All-World High Dividend Yield', '2026-01-01', 'medium', true),
  ('IE00B8GKDB10', 'geography', 'EM',   'Marchés émergents',                        21, 'Répartition régionale indicative de l''indice FTSE All-World High Dividend Yield', '2026-01-01', 'medium', true),
  ('IE00B8GKDB10', 'geography', 'APAC', 'Asie-Pacifique développée (hors Japon)',   13, 'Répartition régionale indicative de l''indice FTSE All-World High Dividend Yield', '2026-01-01', 'medium', true)
on conflict do nothing;

-- Secteur des ACTIONS EN DIRECT : le secteur d'activité principal d'une société cotée est une
-- classification stable et publique, pas une mesure — d'où is_estimated = false. Aucun secteur
-- n'est amorcé pour les ETF diversifiés : leur ventilation sectorielle n'est pas définitionnelle
-- et resterait « Non renseigné » plutôt qu'approximative.
insert into public.instrument_exposures (instrument_isin, dimension, exposure_code, exposure_label, weight_percent, source, source_as_of, confidence, is_estimated)
values
  ('FR0000120073', 'sector', 'MATERIALS',  'Matériaux de base',            100, 'Secteur d''activité principal (classification ICB)', null, 'high', false),
  ('FR0014010OO5', 'sector', 'MATERIALS',  'Matériaux de base',            100, 'Secteur d''activité principal (classification ICB)', null, 'high', false),
  ('FR0000120578', 'sector', 'HEALTH',     'Santé',                        100, 'Secteur d''activité principal (classification ICB)', null, 'high', false),
  ('FR0000120271', 'sector', 'ENERGY',     'Énergie',                      100, 'Secteur d''activité principal (classification ICB)', null, 'high', false),
  ('FR0000121014', 'sector', 'CONSUMER',   'Consommation discrétionnaire', 100, 'Secteur d''activité principal (classification ICB)', null, 'high', false),
  ('FR0000121220', 'sector', 'CONSUMER',   'Consommation discrétionnaire', 100, 'Secteur d''activité principal (classification ICB)', null, 'high', false),
  ('FR0013451333', 'sector', 'CONSUMER',   'Consommation discrétionnaire', 100, 'Secteur d''activité principal (classification ICB)', null, 'high', false),
  ('US0231351067', 'sector', 'CONSUMER',   'Consommation discrétionnaire', 100, 'Secteur d''activité principal (classification ICB)', null, 'high', false),
  ('FR0000130809', 'sector', 'FINANCIALS', 'Services financiers',          100, 'Secteur d''activité principal (classification ICB)', null, 'high', false),
  ('FR0000131104', 'sector', 'FINANCIALS', 'Services financiers',          100, 'Secteur d''activité principal (classification ICB)', null, 'high', false),
  ('FR0004125920', 'sector', 'FINANCIALS', 'Services financiers',          100, 'Secteur d''activité principal (classification ICB)', null, 'high', false),
  ('FR0010667147', 'sector', 'FINANCIALS', 'Services financiers',          100, 'Secteur d''activité principal (classification ICB)', null, 'high', false),
  ('US19260Q1076', 'sector', 'FINANCIALS', 'Services financiers',          100, 'Secteur d''activité principal (classification ICB)', null, 'high', false),
  ('US96208T1043', 'sector', 'FINANCIALS', 'Services financiers',          100, 'Secteur d''activité principal (classification ICB)', null, 'high', false),
  ('FR0000133308', 'sector', 'TELECOM',    'Télécommunications',           100, 'Secteur d''activité principal (classification ICB)', null, 'high', false),
  ('NL0010273215', 'sector', 'TECH',       'Technologie',                  100, 'Secteur d''activité principal (classification ICB)', null, 'high', false),
  ('US02079K1079', 'sector', 'TECH',       'Technologie',                  100, 'Secteur d''activité principal (classification ICB)', null, 'high', false),
  ('US0378331005', 'sector', 'TECH',       'Technologie',                  100, 'Secteur d''activité principal (classification ICB)', null, 'high', false),
  ('US5949181045', 'sector', 'TECH',       'Technologie',                  100, 'Secteur d''activité principal (classification ICB)', null, 'high', false),
  ('FR0010908533', 'sector', 'SERVICES',   'Services aux entreprises',     100, 'Secteur d''activité principal (classification ICB)', null, 'high', false),
  ('US90353T1007', 'sector', 'INDUSTRY',   'Industrie et transport',       100, 'Secteur d''activité principal (classification ICB)', null, 'high', false),
  ('FR0000121964', 'sector', 'REALESTATE', 'Immobilier',                   100, 'Secteur d''activité principal (classification ICB)', null, 'high', false),
  ('DE000A0H0728', 'sector', 'COMMODITY',  'Matières premières',           100, 'Nature de l''ETF (panier diversifié de matières premières)', null, 'high', false),
  ('FR0013416716', 'sector', 'COMMODITY',  'Matières premières',           100, 'Nature de l''ETC (or physique)', null, 'high', false)
on conflict do nothing;
