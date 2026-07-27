-- Empêche un rafraîchissement sur un compte de déplacer la ligne market_quotes
-- d'un autre compte qui détient la même cotation.
--
-- Migration préparée, NON exécutée par cette livraison. Elle ne touche ni aux
-- opérations, ni aux quantités, ni aux montants et ne supprime aucun cours.

begin;

alter table public.market_quotes
  drop constraint if exists market_quotes_provider_symbol_key;

create unique index if not exists market_quotes_asset_provider_symbol_key
  on public.market_quotes (asset_id, provider, provider_symbol);

comment on index public.market_quotes_asset_provider_symbol_key is
  'Un cours automatique par référence holdings et symbole fournisseur ; évite le déplacement entre comptes.';

commit;
