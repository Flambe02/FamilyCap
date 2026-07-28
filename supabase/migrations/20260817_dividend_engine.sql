-- Moteur de dividendes PEA / compte-titres — référentiel d'ÉVÉNEMENTS + profil fiscal du compte.
--
-- POURQUOI CETTE MIGRATION EXISTE (constaté en base le 2026-07-28) :
--
--   `corporate_actions.asset_id` référence `holdings(id)`. Or `holdings.account_id` est NOT NULL :
--   la table est DUPLIQUÉE PAR COMPTE (63 lignes pour 2 comptes). Un dividende est un fait qui
--   appartient à l'INSTRUMENT, pas au compte. Conséquence mesurée : les 19 événements EODHD sont
--   rattachés aux lignes `holdings` du compte-titres, et la ligne Air Liquide du PEA — même ISIN,
--   même société, même détachement — n'en a aucun. Le PEA affichait donc un écran vide pendant que
--   le compte-titres affichait des dividendes.
--
--   `dividend_events` corrige la clé : elle pointe vers `assets(id)`, l'identité CANONIQUE
--   (migration 20260811, unique sur l'ISIN). Deux comptes détenant Air Liquide lisent le même
--   événement, et la synchronisation n'est faite qu'une fois.
--
-- CE QUE CETTE MIGRATION NE FAIT PAS :
--   - aucune écriture, aucune modification, aucune suppression dans `account_operations` : un
--     dividende REÇU reste une opération réelle, et rien ici ne peut l'altérer ni la remplacer ;
--   - aucune suppression de `corporate_actions` : la table reste en place avec ses données (elle
--     porte aussi les splits). Le moteur de dividendes ne la lit plus, mais rien n'est perdu ;
--   - aucune seconde table de positions : les quantités restent DÉRIVÉES des opérations.
--     `dividend_events.eligible_quantity` / `gross_amount` ne sont JAMAIS écrits par la
--     synchronisation — ils sont réservés à un événement saisi manuellement pour un compte précis
--     (`account_id` non nul), et le calcul d'affichage les recalcule toujours depuis les opérations.
--
-- Additive et idempotente : rejouable sans effet de bord.
-- À exécuter MANUELLEMENT dans le SQL Editor Supabase, APRÈS 20260816_portfolio_exposures_insights.sql.

-- ==========================================================================================
-- A. IDENTITÉ FOURNISSEUR ET POLITIQUE DE DISTRIBUTION
-- ==========================================================================================
-- Un ticker nu (« AI », « SAN ») ne suffit à aucun fournisseur : chacun exige son propre suffixe
-- de place (AI.PA chez EODHD/Yahoo, une variante chez Alpha Vantage). Le symbole appartient donc à
-- la COTATION, pas à l'actif.

alter table public.asset_listings add column if not exists alpha_vantage_symbol text;
alter table public.asset_listings add column if not exists resolution_status text not null default 'unresolved';
alter table public.asset_listings add column if not exists last_resolved_at timestamptz;
alter table public.asset_listings add column if not exists resolution_note text;

alter table public.asset_listings drop constraint if exists asset_listings_resolution_status_check;
alter table public.asset_listings add constraint asset_listings_resolution_status_check
  check (resolution_status in ('resolved', 'needs_review', 'unresolved'));

-- Un symbole Alpha Vantage désigne UNE cotation. Si deux cotations le revendiquaient, l'une des
-- deux recevrait les dividendes de l'autre — c'est précisément l'erreur que l'unicité interdit.
create unique index if not exists asset_listings_alpha_vantage_key
  on public.asset_listings (upper(alpha_vantage_symbol)) where alpha_vantage_symbol is not null;

comment on column public.asset_listings.alpha_vantage_symbol is
  'Symbole Alpha Vantage validé (suffixe de place inclus). Jamais déduit du seul ticker.';
comment on column public.asset_listings.resolution_status is
  'resolved = symbole confirmé par une réponse fournisseur ; needs_review = plusieurs candidats possibles, aucun choisi ; unresolved = aucun symbole.';

-- La politique de distribution appartient à l'INSTRUMENT (un ETF capitalisant l'est sur toutes ses
-- places). « unknown » est une valeur de plein droit : mieux vaut « Donnée indisponible » qu'une
-- projection de revenus pour un fonds qui ne verse rien.
alter table public.assets add column if not exists distribution_policy text not null default 'unknown';
alter table public.assets add column if not exists distribution_policy_source text;

alter table public.assets drop constraint if exists assets_distribution_policy_check;
alter table public.assets add constraint assets_distribution_policy_check
  check (distribution_policy in ('distributing', 'accumulating', 'unknown'));

comment on column public.assets.distribution_policy is
  'distributing = verse en espèces ; accumulating = réinvestit (aucun versement attendu) ; unknown = non déterminé, affiché « Donnée indisponible ».';
comment on column public.assets.distribution_policy_source is
  'Origine de la politique : « admin », « name_marker », « provider ». Une valeur « admin » ne doit jamais être écrasée automatiquement.';

-- ==========================================================================================
-- B. ÉVÉNEMENTS DE DIVIDENDE
-- ==========================================================================================
create table if not exists public.dividend_events (
  id uuid primary key default gen_random_uuid(),
  -- Identité canonique : une ligne par (instrument, événement), partagée par tous les comptes.
  asset_id uuid not null references public.assets(id) on delete cascade,
  listing_id uuid references public.asset_listings(id) on delete set null,
  -- NULL = fait d'instrument issu d'un fournisseur ou d'une projection (le cas normal).
  -- Non nul = événement saisi pour UN compte précis (cas manuel), jamais écrit par la synchro.
  account_id uuid references public.financial_accounts(id) on delete cascade,
  isin text,
  provider_symbol text,
  status text not null default 'announced',
  dividend_type text not null default 'ordinary',
  declaration_date date,
  ex_date date,
  record_date date,
  payment_date date,
  -- Une projection ne connaît PAS de date exacte : elle ne connaît qu'un mois probable.
  -- Format 'YYYY-MM'. Inventer un jour précis serait présenter une supposition comme une annonce.
  estimated_month text,
  amount_per_share numeric(24, 8),
  currency text,
  -- Réservés à un événement de compte (account_id non nul). La synchronisation les laisse NULL :
  -- la quantité éligible est TOUJOURS reconstruite depuis `account_operations` à l'affichage.
  eligible_quantity numeric(24, 8),
  gross_amount numeric(24, 8),
  estimated_net_amount numeric(24, 8),
  -- Traçabilité du change : le montant natif n'est jamais écrasé par sa conversion.
  fx_rate numeric(24, 12),
  fx_rate_date date,
  converted_amount numeric(24, 8),
  converted_currency text,
  source_provider text not null,
  source_event_id text,
  source_url text,
  confidence text not null default 'medium',
  is_special boolean not null default false,
  is_forecast boolean not null default false,
  -- Rapprochement avec l'encaissement réel. Jamais une fusion : l'opération reste la vérité
  -- comptable, l'événement ne fait que la désigner.
  matched_operation_id uuid references public.account_operations(id) on delete set null,
  reconciliation_status text not null default 'unmatched',
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.dividend_events drop constraint if exists dividend_events_status_check;
alter table public.dividend_events add constraint dividend_events_status_check
  check (status in ('received', 'announced', 'estimated', 'unavailable'));

alter table public.dividend_events drop constraint if exists dividend_events_type_check;
alter table public.dividend_events add constraint dividend_events_type_check
  check (dividend_type in ('ordinary', 'special', 'interim', 'final', 'other'));

alter table public.dividend_events drop constraint if exists dividend_events_confidence_check;
alter table public.dividend_events add constraint dividend_events_confidence_check
  check (confidence in ('high', 'medium', 'low'));

alter table public.dividend_events drop constraint if exists dividend_events_reconciliation_check;
alter table public.dividend_events add constraint dividend_events_reconciliation_check
  check (reconciliation_status in ('unmatched', 'matched', 'ambiguous', 'manual'));

alter table public.dividend_events drop constraint if exists dividend_events_month_check;
alter table public.dividend_events add constraint dividend_events_month_check
  check (estimated_month is null or estimated_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

alter table public.dividend_events drop constraint if exists dividend_events_currency_check;
alter table public.dividend_events add constraint dividend_events_currency_check
  check (currency is null or currency ~ '^[A-Z]{3}$');

-- Un événement sans AUCUNE date ni mois n'est pas plaçable dans un calendrier : le refuser à
-- l'écriture évite une ligne fantôme qu'aucun écran ne saurait afficher.
alter table public.dividend_events drop constraint if exists dividend_events_needs_period_check;
alter table public.dividend_events add constraint dividend_events_needs_period_check
  check (ex_date is not null or payment_date is not null or estimated_month is not null);

-- `is_forecast` et `status = 'estimated'` disent la même chose : les désynchroniser ferait
-- apparaître une projection avec le badge « Annoncé ».
alter table public.dividend_events drop constraint if exists dividend_events_forecast_check;
alter table public.dividend_events add constraint dividend_events_forecast_check
  check (is_forecast = (status = 'estimated'));

-- ---- Unicité : c'est ce qui empêche la synchronisation de recréer un événement existant -------
-- 1) Événement fournisseur porteur d'un identifiant : (instrument, fournisseur, id fournisseur).
create unique index if not exists dividend_events_provider_key
  on public.dividend_events (asset_id, source_provider, source_event_id)
  where account_id is null and source_event_id is not null;
-- 2) Événement fournisseur sans identifiant : (instrument, fournisseur, détachement).
create unique index if not exists dividend_events_provider_exdate_key
  on public.dividend_events (asset_id, source_provider, ex_date)
  where account_id is null and source_event_id is null and ex_date is not null;
-- 3) Projection : une seule par (instrument, mois, type). Sans cela, chaque synchronisation
--    ajouterait une projection de plus pour la même échéance.
create unique index if not exists dividend_events_forecast_key
  on public.dividend_events (asset_id, estimated_month, dividend_type)
  where is_forecast and account_id is null;

create index if not exists dividend_events_asset_idx on public.dividend_events (asset_id, ex_date desc);
create index if not exists dividend_events_payment_idx on public.dividend_events (payment_date) where payment_date is not null;
create index if not exists dividend_events_status_idx on public.dividend_events (status);
create index if not exists dividend_events_account_idx on public.dividend_events (account_id) where account_id is not null;
create index if not exists dividend_events_isin_idx on public.dividend_events (upper(isin)) where isin is not null;

comment on table public.dividend_events is
  'Événements de dividende par INSTRUMENT (assets), pas par compte. La quantité éligible et le montant brut sont recalculés depuis account_operations à chaque lecture : cette table ne contient aucune position.';
comment on column public.dividend_events.estimated_month is
  'Mois probable d''une projection (YYYY-MM). Une projection n''a jamais de date exacte : ex_date et payment_date restent NULL.';
comment on column public.dividend_events.eligible_quantity is
  'Réservé aux événements de compte saisis à la main. La synchronisation ne l''écrit jamais — la quantité est dérivée des opérations à la date de détachement.';

-- ==========================================================================================
-- C. PROFIL FISCAL DU COMPTE
-- ==========================================================================================
-- Le BRUT reste la valeur de référence. Le net n'est calculé que si ce profil dit explicitement
-- comment le calculer : un titulaire peut résider hors de France, et supposer un PFU 30 % pour
-- tout le monde est une désinformation fiscale, pas un défaut raisonnable.
create table if not exists public.account_tax_profiles (
  account_id uuid primary key references public.financial_accounts(id) on delete cascade,
  account_type text not null,
  -- ISO 3166-1 alpha-2. NULL = non renseigné → aucun net n'est présenté.
  tax_residency_country text,
  -- Retenue à la source appliquée par le pays de l'émetteur (0 → 1).
  withholding_tax_rate numeric(6, 5),
  -- Imposition estimée dans le pays de résidence (0 → 1).
  estimated_tax_rate numeric(6, 5),
  -- Abattement éventuel appliqué avant impôt (0 → 1).
  allowance_rate numeric(6, 5),
  show_estimated_net boolean not null default false,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.account_tax_profiles drop constraint if exists account_tax_profiles_country_check;
alter table public.account_tax_profiles add constraint account_tax_profiles_country_check
  check (tax_residency_country is null or tax_residency_country ~ '^[A-Z]{2}$');

alter table public.account_tax_profiles drop constraint if exists account_tax_profiles_rates_check;
alter table public.account_tax_profiles add constraint account_tax_profiles_rates_check
  check (
    (withholding_tax_rate is null or (withholding_tax_rate >= 0 and withholding_tax_rate <= 1))
    and (estimated_tax_rate is null or (estimated_tax_rate >= 0 and estimated_tax_rate <= 1))
    and (allowance_rate is null or (allowance_rate >= 0 and allowance_rate <= 1))
  );

comment on table public.account_tax_profiles is
  'Paramètres fiscaux du compte. Aucun taux par défaut : sans profil, seul le brut est affiché. La fiscalité française n''est jamais présumée.';

-- Reprise NON destructive du seul taux déjà saisi dans l'application (financial_accounts.dividend_tax_rate).
-- Il n'est repris que s'il existe réellement : aucune ligne n'est créée avec une hypothèse.
insert into public.account_tax_profiles (account_id, account_type, estimated_tax_rate, show_estimated_net, note)
select a.id, a.account_type, a.dividend_tax_rate, true, 'Repris de financial_accounts.dividend_tax_rate (migration 20260817).'
from public.financial_accounts a
where a.account_type in ('pea', 'securities')
  and a.dividend_tax_rate is not null
on conflict (account_id) do nothing;

-- ==========================================================================================
-- D. ÉTAT DE SYNCHRONISATION PAR INSTRUMENT
-- ==========================================================================================
-- Permet la file de synchronisation progressive : on sert d'abord les instruments jamais
-- synchronisés, puis les plus anciens. C'est ce qui rend supportable un quota de 25 appels/jour
-- face à 26 positions — l'amorçage s'étale sur deux jours, sans jamais repartir de zéro.
create table if not exists public.dividend_sync_state (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.assets(id) on delete cascade,
  provider text not null,
  status text not null default 'pending',
  message text,
  events_written integer not null default 0,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dividend_sync_state_key unique (asset_id, provider)
);

alter table public.dividend_sync_state drop constraint if exists dividend_sync_state_status_check;
alter table public.dividend_sync_state add constraint dividend_sync_state_status_check
  check (status in ('pending', 'ok', 'no_data', 'unresolved', 'provider_error', 'quota_deferred', 'unsupported', 'accumulating'));

create index if not exists dividend_sync_state_queue_idx
  on public.dividend_sync_state (provider, last_success_at nulls first, last_attempt_at nulls first);

comment on table public.dividend_sync_state is
  'File de synchronisation : priorité aux instruments jamais synchronisés, puis aux données les plus anciennes. Un échec fournisseur n''efface aucun événement déjà enregistré.';

-- ==========================================================================================
-- E. RLS
-- ==========================================================================================
alter table public.dividend_events enable row level security;
alter table public.account_tax_profiles enable row level security;
alter table public.dividend_sync_state enable row level security;

-- `dividend_events` d'instrument (account_id NULL) ne contient AUCUNE donnée d'un membre : ni
-- compte, ni quantité, ni montant détenu — seulement « tel instrument détache tel montant par
-- action à telle date ». C'est une métadonnée de marché, au même titre que `assets`, et elle doit
-- être lisible pour que l'écran fonctionne. Un événement rattaché à un compte, lui, suit
-- exactement la règle de partage familial déjà en vigueur.
drop policy if exists "authenticated reads instrument dividend events" on public.dividend_events;
create policy "authenticated reads instrument dividend events" on public.dividend_events
  for select to authenticated using (
    account_id is null
    or exists (
      select 1 from public.financial_accounts a
      where a.id = dividend_events.account_id
        and public.can_view_member_investments(a.member_id)
    )
  );

drop policy if exists "member reads own account tax profile" on public.account_tax_profiles;
create policy "member reads own account tax profile" on public.account_tax_profiles
  for select to authenticated using (
    exists (
      select 1 from public.financial_accounts a
      where a.id = account_tax_profiles.account_id
        and (a.member_id = public.current_family_member_id() or public.is_cap_family_admin())
    )
  );

-- L'état de synchronisation est un journal d'exploitation : lecture administrateur uniquement.
drop policy if exists "admin reads dividend sync state" on public.dividend_sync_state;
create policy "admin reads dividend sync state" on public.dividend_sync_state
  for select to authenticated using (public.is_cap_family_admin());

-- Écriture : exclusivement par les routes serveur (clé de service). Aucune politique permissive
-- générale n'est créée sur ces tables financières.
revoke insert, update, delete on public.dividend_events from anon, authenticated;
revoke insert, update, delete on public.account_tax_profiles from anon, authenticated;
revoke insert, update, delete on public.dividend_sync_state from anon, authenticated;
grant select on public.dividend_events to authenticated;
grant select on public.account_tax_profiles to authenticated;
grant select on public.dividend_sync_state to authenticated;

-- ==========================================================================================
-- F. AMORÇAGE DE LA POLITIQUE DE DISTRIBUTION — uniquement ce qui est VÉRIFIABLE
-- ==========================================================================================
-- Seuls les instruments dont le nom porte un marqueur NON AMBIGU sont classés. Tout le reste
-- demeure « unknown » et sera affiché « Donnée indisponible » : deviner qu'un ETF capitalise
-- priverait l'utilisateur d'un revenu réel, deviner l'inverse lui promettrait un versement qui
-- n'arrivera jamais.
update public.assets set distribution_policy = 'accumulating', distribution_policy_source = 'name_marker'
where distribution_policy = 'unknown'
  and asset_type in ('etf', 'fund')
  and (upper(name) ~ '(^|[[:space:](-])(ACC|ACCUMULATING|CAPITALISANT|CAPITALISATION)([[:space:])-]|$)'
       or upper(name) ~ '\(C\)[[:space:]]*$');

update public.assets set distribution_policy = 'distributing', distribution_policy_source = 'name_marker'
where distribution_policy = 'unknown'
  and asset_type in ('etf', 'fund')
  and upper(name) ~ '(^|[[:space:](-])(DIS|DIST|DISTRIBUTING|DISTRIBUANT)([[:space:])-]|$)';
