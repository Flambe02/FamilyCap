-- DividLand : source secondaire personnelle, associée explicitement à un ISIN français.
-- Aucune résolution par nom n'est autorisée : un slug ne peut être saisi/seedé qu'après contrôle.

alter table public.asset_listings add column if not exists dividland_company_id text;
alter table public.asset_listings add column if not exists dividland_slug text;

comment on column public.asset_listings.dividland_company_id is
  'Identifiant stable de la fiche DividLand, renseigné uniquement après validation manuelle de l’ISIN.';
comment on column public.asset_listings.dividland_slug is
  'Chemin individuel DividLand (<id>-<nom>), jamais dérivé du nom de l’instrument.';

-- Correspondances contrôlées : les ETF/fonds ne figurent volontairement pas dans cette liste.
with mapping(isin, company_id, slug) as (
  values
    ('FR0000120073', '4', '4-AIR%20LIQUIDE'),
    ('FR0000120271', '109', '109-TOTALENERGIES'),
    ('FR0000131104', '19', '19-BNP%20PARIBAS'),
    ('FR0000121014', '68', '68-LVMH'),
    ('FR0000130809', '96', '96-SOCIETE%20GENERALE'),
    ('FR0000133308', '77', '77-ORANGE'),
    ('FR0000121220', '97', '97-SODEXO')
)
update public.asset_listings listing
set dividland_company_id = mapping.company_id,
    dividland_slug = mapping.slug
from public.assets asset
join mapping on upper(asset.isin) = mapping.isin
where listing.asset_id = asset.id
  and asset.asset_type not in ('etf', 'fund');

create index if not exists asset_listings_dividland_slug_idx
  on public.asset_listings (dividland_slug) where dividland_slug is not null;
