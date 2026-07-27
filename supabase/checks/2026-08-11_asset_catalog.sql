-- Contrôle APRÈS exécution de migrations/20260811_asset_catalog.sql.
-- À exécuter dans le SQL Editor Supabase. Chaque ligne dit OK ou ce qui manque :
-- coller le résultat pour vérification. Aucune écriture, lecture seule.

-- 1. Les deux tables du catalogue existent.
select 'tables' as controle,
       case when count(*) = 2 then 'OK — assets + asset_listings présentes'
            else 'MANQUE : ' || coalesce(string_agg(table_name, ', '), 'les deux tables') end as resultat
from information_schema.tables
where table_schema = 'public' and table_name in ('assets', 'asset_listings')

union all

-- 2. Les colonnes d'identité stable sont posées ET NULLABLES (l'historique doit rester valide).
select 'colonnes account_operations',
       case
         when count(*) filter (where column_name in ('asset_id', 'listing_id')) <> 2
           then 'MANQUE : asset_id / listing_id sur account_operations'
         when bool_or(is_nullable = 'NO') filter (where column_name in ('asset_id', 'listing_id'))
           then 'ANOMALIE : une colonne est NOT NULL — les opérations antérieures seraient rejetées'
         else 'OK — asset_id + listing_id présentes et nullables'
       end
from information_schema.columns
where table_schema = 'public' and table_name = 'account_operations'

union all

select 'colonne holdings.listing_id',
       case when count(*) = 1 then 'OK' else 'MANQUE : holdings.listing_id' end
from information_schema.columns
where table_schema = 'public' and table_name = 'holdings' and column_name = 'listing_id'

union all

-- 3. L'unicité qui empêche les doublons doit vivre EN BASE, pas seulement dans le code :
--    deux écritures concurrentes ne doivent pas pouvoir créer deux fois le même actif.
select 'index d''unicité',
       case when count(*) >= 3 then 'OK — ' || string_agg(indexname, ', ')
            else 'MANQUE (attendus : assets_isin_key, asset_listings_identity_key, asset_listings_yahoo_key) — trouvés : '
                 || coalesce(string_agg(indexname, ', '), 'aucun') end
from pg_indexes
where schemaname = 'public'
  and indexname in ('assets_isin_key', 'asset_listings_identity_key', 'asset_listings_yahoo_key', 'asset_listings_eodhd_key')

union all

-- 4. RLS : lecture ouverte aux membres authentifiés, écriture réservée au serveur.
select 'RLS lecture',
       case when count(*) = 2 then 'OK — les deux tables sont lisibles par authenticated'
            else 'MANQUE une policy de lecture (trouvées : ' || count(*)::text || '/2)' end
from pg_policies
where schemaname = 'public' and tablename in ('assets', 'asset_listings') and cmd = 'SELECT'

union all

select 'RLS écriture',
       case when count(*) = 0 then 'OK — aucune écriture possible depuis le navigateur'
            else 'ANOMALIE : ' || count(*)::text || ' privilège(s) d''écriture accordé(s) à anon/authenticated' end
from information_schema.role_table_grants
where table_schema = 'public' and table_name in ('assets', 'asset_listings')
  and grantee in ('anon', 'authenticated') and privilege_type in ('INSERT', 'UPDATE', 'DELETE')

union all

-- 5. Amorçage : Air Liquide doit être identifiable par ses quatre références, issues de la MÊME
--    cotation. C'est le cas de référence du cahier des charges.
select 'amorçage Air Liquide',
       coalesce(
         (select 'OK — ' || a.name || ' · ' || l.ticker || ' · ' || l.exchange || ' · ' || l.currency
                 || ' · ISIN ' || a.isin || ' · yahoo ' || l.yahoo_symbol
          from public.assets a
          join public.asset_listings l on l.asset_id = a.id
          where upper(a.isin) = 'FR0000120073'
          limit 1),
         'MANQUE : Air Liquide absent du catalogue')

union all

-- 6. Aucun doublon d'ISIN (l'index le garantit, on le vérifie tout de même sur les données).
select 'doublons d''ISIN',
       case when count(*) = 0 then 'OK — aucun ISIN en double'
            else 'ANOMALIE : ' || count(*)::text || ' ISIN présent(s) plusieurs fois' end
from (select upper(isin) from public.assets where isin is not null group by 1 having count(*) > 1) doublons

union all

-- 7. État de l'historique : combien d'opérations portent déjà une identité stable.
--    Un grand nombre de « sans identité » est NORMAL juste après la migration — aucune reprise
--    automatique n'est faite, par choix (on ne réécrit pas une ligne financière en silence).
select 'opérations rattachées',
       count(*) filter (where listing_id is not null)::text || ' sur '
       || count(*) filter (where type in ('achat', 'vente', 'dividende', 'correction', 'transfer_in', 'transfer_out'))::text
       || ' opérations portant un actif'
from public.account_operations

union all

-- 8. Actifs à revoir : ce que l'écran d'administration « Actifs à vérifier » affichera.
select 'actifs à vérifier',
       case when count(*) = 0 then 'OK — aucun actif en attente de vérification'
            else count(*)::text || ' actif(s) à confirmer' end
from public.assets
where classification_status = 'needs_review';
