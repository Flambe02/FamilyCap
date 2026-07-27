-- Réparation Sanofi préparée mais à NE PAS exécuter automatiquement.
--
-- Portée volontairement limitée :
--   * aucune écriture dans account_operations ;
--   * aucune quantité, aucun montant et aucun mouvement de trésorerie modifié ;
--   * aucune fusion ni suppression ;
--   * arrêt complet si la cotation SAN.PA/XPAR/EUR n'est pas unique.
--
-- Cette migration est idempotente. Elle doit être relue avec le résultat des
-- requêtes de prévisualisation ci-dessous avant toute exécution en production.

do $$
declare
  v_listing_id uuid;
  v_asset_id uuid;
  v_listing_count integer;
  v_conflicting_asset_count integer;
  v_bad_holding_count integer;
begin
  select count(*)
    into v_listing_count
  from public.asset_listings l
  join public.assets a on a.id = l.asset_id
  where upper(coalesce(l.ticker, '')) = 'SAN'
    and upper(coalesce(l.mic_code, '')) = 'XPAR'
    and upper(l.currency) = 'EUR'
    and upper(coalesce(l.eodhd_symbol, '')) = 'SAN.PA'
    and upper(coalesce(l.yahoo_symbol, '')) = 'SAN.PA'
    and lower(trim(a.name)) = 'sanofi';

  if v_listing_count <> 1 then
    raise exception
      'Sanofi repair refused: expected exactly one SAN.PA/XPAR/EUR listing, found %',
      v_listing_count;
  end if;

  select l.id, l.asset_id
    into strict v_listing_id, v_asset_id
  from public.asset_listings l
  join public.assets a on a.id = l.asset_id
  where upper(coalesce(l.ticker, '')) = 'SAN'
    and upper(coalesce(l.mic_code, '')) = 'XPAR'
    and upper(l.currency) = 'EUR'
    and upper(coalesce(l.eodhd_symbol, '')) = 'SAN.PA'
    and upper(coalesce(l.yahoo_symbol, '')) = 'SAN.PA'
    and lower(trim(a.name)) = 'sanofi';

  select count(*) into v_conflicting_asset_count
  from public.assets
  where upper(isin) = 'FR0000120578'
    and id <> v_asset_id;

  if v_conflicting_asset_count <> 0 then
    raise exception
      'Sanofi repair refused: FR0000120578 already belongs to another canonical asset';
  end if;

  if exists (
    select 1 from public.assets
    where id = v_asset_id
      and isin is not null
      and upper(isin) <> 'FR0000120578'
  ) then
    raise exception
      'Sanofi repair refused: the selected canonical asset already has another ISIN';
  end if;

  -- Actif canonique de la position active : le tuple de cotation strict constitue
  -- la précondition. La cotation et les opérations existantes ne sont pas réécrites.
  update public.assets
  set isin = 'FR0000120578',
      classification_status = 'verified',
      updated_at = now()
  where id = v_asset_id
    and isin is null;

  -- Les références de prix déjà reliées à l'unique cotation Sanofi reçoivent
  -- seulement l'ISIN manquant. Quantité et prix historiques restent inchangés.
  update public.holdings
  set isin = 'FR0000120578',
      updated_at = now()
  where listing_id = v_listing_id
    and isin is null
    and upper(coalesce(symbol, '')) in ('SAN', 'SAN.PA')
    and upper(currency) = 'EUR';

  -- Ancienne ligne isolée : correction autorisée uniquement si elle est unique et
  -- correspond exactement à Sanofi. Plusieurs candidates provoquent un refus.
  select count(*) into v_bad_holding_count
  from public.holdings
  where upper(isin) = 'FR0001200578'
    and lower(trim(name)) = 'sanofi'
    and upper(currency) = 'EUR'
    and upper(coalesce(symbol, '')) in ('', 'SAN', 'SAN.PA')
    and listing_id is null;

  if v_bad_holding_count > 1 then
    raise exception
      'Sanofi repair refused: multiple historical holdings use FR0001200578';
  end if;

  if v_bad_holding_count = 1 then
    update public.holdings
    set isin = 'FR0000120578',
        updated_at = now()
    where upper(isin) = 'FR0001200578'
      and lower(trim(name)) = 'sanofi'
      and upper(currency) = 'EUR'
      and upper(coalesce(symbol, '')) in ('', 'SAN', 'SAN.PA')
      and listing_id is null;
  end if;
end
$$;

-- Prévisualisation à exécuter manuellement AVANT la migration :
-- select a.id as asset_id, a.name, a.isin, l.id as listing_id, l.ticker,
--        l.mic_code, l.currency, l.eodhd_symbol, l.yahoo_symbol
-- from public.assets a
-- join public.asset_listings l on l.asset_id = a.id
-- where upper(coalesce(l.eodhd_symbol, '')) = 'SAN.PA'
--    or upper(coalesce(l.yahoo_symbol, '')) = 'SAN.PA';
--
-- select id, account_id, name, symbol, isin, currency, listing_id
-- from public.holdings
-- where upper(coalesce(isin, '')) in ('FR0000120578', 'FR0001200578')
--    or upper(coalesce(symbol, '')) in ('SAN', 'SAN.PA');
