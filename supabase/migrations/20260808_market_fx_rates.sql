-- Taux de change : rendre la table utilisable seule.
--
-- Constat à l'origine de cette migration : `market_fx_rates` était vide, donc
-- `/api/portfolio` renvoyait `fxRateToReference = null` pour toute position cotée hors de la
-- devise du compte, donc `computeAccountModel` laissait `currentValueEur` à null — les lignes
-- en USD n'avaient ni valeur, ni performance, ni poids, et sortaient du total du portefeuille.
--
-- La table est désormais alimentée par une passe AUTONOME (lib/market-fx.ts + syncFxRates),
-- indépendante du cache des cours et du quota du fournisseur de cotations. Elle s'appuie sur
-- deux sources gratuites et sans clé : les taux de référence de la BCE (Frankfurter) puis
-- Yahoo Finance. Aucune conversion n'est estimée quand les deux échouent.
--
-- Migration additive et rejouable. À exécuter manuellement dans Supabase APRÈS
-- 20260807_market_data_eodhd.sql (qui crée déjà la table ; ce fichier la crée aussi si elle
-- manque, puis ajoute ce qui lui faisait défaut).

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

-- Codes ISO 4217 en majuscules : sans cette contrainte, « usd » et « USD » cohabiteraient et la
-- recherche de paire côté serveur (qui compare en majuscules) manquerait silencieusement le taux.
alter table public.market_fx_rates drop constraint if exists market_fx_rates_currency_format_check;
alter table public.market_fx_rates add constraint market_fx_rates_currency_format_check
  check (base_currency ~ '^[A-Z]{3}$' and quote_currency ~ '^[A-Z]{3}$');

-- Une paire base = cotation n'a pas à être stockée : elle vaut 1 par identité, et la stocker
-- ouvrirait la porte à un « EUR→EUR = 0,98 » ingérable.
alter table public.market_fx_rates drop constraint if exists market_fx_rates_distinct_pair_check;
alter table public.market_fx_rates add constraint market_fx_rates_distinct_pair_check
  check (base_currency <> quote_currency);

comment on table public.market_fx_rates is
  'Taux de change relevés auprès de sources publiques (BCE via Frankfurter, puis Yahoo Finance). Écrits uniquement par la route serveur ; jamais saisis par le navigateur. 1 base_currency = rate quote_currency.';
comment on column public.market_fx_rates.quoted_at is
  'Horodatage DU FOURNISSEUR (date de référence BCE ou heure de cotation Yahoo), jamais l''heure d''écriture — c''est lui qui détermine la fraîcheur.';

-- La lecture se fait toujours « dernier taux connu pour une paire » : c'est cet index qui la sert.
create index if not exists market_fx_rates_lookup_idx
  on public.market_fx_rates(base_currency, quote_currency, quoted_at desc);

alter table public.market_fx_rates enable row level security;

-- Lecture pour tout membre authentifié (un taux de change n'est pas une donnée personnelle et
-- ne révèle aucune position). Écriture réservée au serveur via la clé de service.
drop policy if exists "authenticated reads fx rates" on public.market_fx_rates;
create policy "authenticated reads fx rates" on public.market_fx_rates
  for select to authenticated using (true);
