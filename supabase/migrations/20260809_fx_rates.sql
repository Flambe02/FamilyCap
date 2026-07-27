-- TAUX DE CHANGE DE RÉFÉRENCE (Banque centrale européenne).
--
-- Migration ADDITIVE et IDEMPOTENTE. À exécuter MANUELLEMENT dans le SQL Editor Supabase.
-- Ne JAMAIS l'exécuter automatiquement en production.
--
-- Problème résolu : les positions cotées hors euro (actions américaines) avaient bien un cours,
-- mais aucun taux de change n'était enregistré. `/api/portfolio` renvoyait donc
-- `fxRateToReference = null`, `computeAccountModel` laissait `currentValueEur` à null, et
-- l'interface affichait « Conversion indisponible » : ces lignes n'avaient ni valeur, ni
-- plus-value, ni poids, et sortaient du total du portefeuille.
--
-- Ce que cette table N'EST PAS :
--   • ni une table de positions (les positions restent dérivées de account_operations) ;
--   • ni un taux par utilisateur (un taux de change est un fait public, partagé par tous) ;
--   • ni un taux stocké dans chaque position (il serait figé et se périmerait en silence).
--
-- CONVENTION, unique et non négociable : la BCE publie avec l'EURO EN BASE.
--     base_currency = 'EUR', quote_currency = 'USD', rate = 1.1377   ⟹   1 EUR = 1,1377 USD
--     montant_eur = montant_usd / rate
-- Le sens inverse n'est jamais stocké : une seule convention, donc aucune double inversion
-- possible. La conversion elle-même vit dans lib/fx-rates.ts, et nulle part ailleurs.

create table if not exists public.fx_rates (
  base_currency  text        not null default 'EUR',
  quote_currency text        not null,
  rate           numeric(20, 10) not null,
  rate_date      date        not null,
  source         text        not null default 'ECB',
  fetched_at     timestamptz not null default now(),
  constraint fx_rates_pkey primary key (base_currency, quote_currency, rate_date)
);

-- Colonnes ajoutées si la table préexistait dans une forme réduite (rejouabilité).
alter table public.fx_rates add column if not exists source     text        not null default 'ECB';
alter table public.fx_rates add column if not exists fetched_at timestamptz not null default now();

-- Un taux nul ou négatif n'existe pas : le laisser entrer produirait une division par zéro ou
-- une valorisation négative, l'une et l'autre invisibles à l'écran.
alter table public.fx_rates drop constraint if exists fx_rates_rate_positive_check;
alter table public.fx_rates add constraint fx_rates_rate_positive_check check (rate > 0);

-- Codes ISO 4217 en majuscules : sans cette contrainte, « usd » et « USD » cohabiteraient et la
-- recherche de paire (qui compare en majuscules) manquerait silencieusement le taux.
alter table public.fx_rates drop constraint if exists fx_rates_currency_format_check;
alter table public.fx_rates add constraint fx_rates_currency_format_check
  check (base_currency ~ '^[A-Z]{3}$' and quote_currency ~ '^[A-Z]{3}$');

-- Une paire base = cotation vaut 1 par définition : la stocker ouvrirait la porte à un
-- « EUR→EUR = 0,98 » impossible à rattraper.
alter table public.fx_rates drop constraint if exists fx_rates_distinct_pair_check;
alter table public.fx_rates add constraint fx_rates_distinct_pair_check
  check (base_currency <> quote_currency);

comment on table public.fx_rates is
  'Taux de référence quotidiens de la BCE. 1 base_currency = rate quote_currency (base EUR). Écrits uniquement côté serveur (Edge Function sync-fx-rates ou route admin) ; jamais par le navigateur.';
comment on column public.fx_rates.rate is
  '1 base_currency = rate quote_currency. Convertir vers l''euro est donc une DIVISION : montant_eur = montant_usd / rate.';
comment on column public.fx_rates.rate_date is
  'Date de référence publiée par la BCE (jour ouvré), jamais la date d''exécution de la synchronisation.';

-- La seule lecture faite en production est « dernier taux d'une devise à une date donnée ».
-- C'est exactement ce que sert cet index ; la clé primaire, ordonnée base/quote/date, ne le
-- couvre pas efficacement pour un filtre `rate_date <= …` sur une devise seule.
create index if not exists fx_rates_lookup_idx
  on public.fx_rates (quote_currency, rate_date desc)
  include (rate);

-- ------------------------------------------------------------------------------------------
-- RLS : lecture pour tout membre authentifié, écriture réservée au serveur
-- ------------------------------------------------------------------------------------------
-- Un taux de change est une donnée publique : le lire ne révèle aucune position. En revanche,
-- pouvoir l'ÉCRIRE reviendrait à pouvoir falsifier la valeur de tous les portefeuilles — d'où
-- l'absence totale de politique d'écriture. La clé de service (serveur uniquement) contourne
-- RLS ; le navigateur, lui, n'a aucun chemin d'écriture.
alter table public.fx_rates enable row level security;

drop policy if exists "authenticated reads fx rates" on public.fx_rates;
create policy "authenticated reads fx rates" on public.fx_rates
  for select to authenticated using (true);

-- Aucune policy insert/update/delete n'est créée : RLS étant active, toute écriture depuis
-- `anon` ou `authenticated` est refusée par défaut. On révoque en plus les droits de table,
-- pour que le refus ne dépende pas de la seule absence de policy.
revoke insert, update, delete on public.fx_rates from anon, authenticated;
grant select on public.fx_rates to anon, authenticated;

-- ------------------------------------------------------------------------------------------
-- PLANIFICATION QUOTIDIENNE (à exécuter séparément, une seule fois)
-- ------------------------------------------------------------------------------------------
-- La BCE publie vers 16 h CET les jours ouvrés. Une exécution à 18 h UTC du lundi au vendredi
-- laisse une marge confortable. Le bloc ci-dessous est VOLONTAIREMENT COMMENTÉ : il référence
-- l'URL du projet et une clé de service, qui n'ont rien à faire dans un fichier versionné.
--
-- 1) Activer les extensions (Database › Extensions, ou ici) :
--      create extension if not exists pg_cron;
--      create extension if not exists pg_net;
--
-- 2) Enregistrer la clé de service dans Vault (Project Settings › Vault), puis :
--
--      select cron.schedule(
--        'sync-fx-rates-daily',
--        '0 18 * * 1-5',            -- 18 h UTC, du lundi au vendredi
--        $$
--        select net.http_post(
--          url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/sync-fx-rates',
--          headers := jsonb_build_object(
--                       'Content-Type', 'application/json',
--                       'Authorization', 'Bearer ' || (select decrypted_secret
--                                                        from vault.decrypted_secrets
--                                                       where name = 'service_role_key')
--                     ),
--          body    := '{"trigger":"cron"}'::jsonb
--        );
--        $$
--      );
--
-- 3) Vérifier : select * from cron.job;   /   select * from cron.job_run_details order by start_time desc limit 10;
-- 4) Retirer :  select cron.unschedule('sync-fx-rates-daily');
--
-- Une exécution manquée n'a aucune conséquence : la règle de repli utilise le dernier taux
-- connu, et la synchronisation suivante rattrape la date manquante sans doublon (upsert).
