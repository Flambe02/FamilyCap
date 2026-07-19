-- Compare ce que l'app affiche (fichier local lib/gift-history.ts) à ce qui est
-- réellement enregistré dans public.gift_records. À exécuter dans le SQL Editor
-- Supabase. Coller le résultat pour vérification.
with expected(member_name, occasion, gift_date, amount_eur, btc_amount) as (
  values
    ('Paul','Anniversaire','2022-11-18'::date,55.00,0.00155968),
    ('Thibault','Anniversaire','2023-03-15'::date,55.00,0.00217),
    ('Uhaina','Anniversaire','2023-08-16'::date,55.42,0.00207),
    ('Paul','Anniversaire','2023-11-18'::date,55.00,0.00155968),
    ('Aurore','Anniversaire','2023-08-27'::date,55.00,0.00208),
    ('Thibault','Anniversaire','2024-03-15'::date,55.00,0.00083),
    ('Aurore','Anniversaire','2024-08-27'::date,55.00,0.00147),
    ('Paul','Anniversaire','2024-11-18'::date,55.00,0.00061163),
    ('Thomas','Anniversaire','2024-12-29'::date,55.00,0.00059),
    ('Thibault','Anniversaire','2025-03-15'::date,55.00,0.0006789),
    ('Uhaina','Anniversaire','2025-08-16'::date,55.00,0.00053622),
    ('Paul','Anniversaire','2025-11-18'::date,55.00,0.00065951),
    ('Aurore','Anniversaire','2025-08-27'::date,55.00,0.00054322),
    ('Thibault','Noël','2022-12-27'::date,55.00,0.003094),
    ('Uhaina','Noël','2022-12-27'::date,45.76,0.002894),
    ('Paul','Noël','2022-12-27'::date,48.97,0.003094),
    ('Aurore','Noël','2022-12-27'::date,48.93,0.003094),
    ('Thomas','Noël','2022-12-27'::date,48.93,0.003094),
    ('Thibault','Noël','2023-12-25'::date,55.00,0.001362),
    ('Uhaina','Noël','2023-12-25'::date,55.00,0.001362),
    ('Paul','Noël','2023-12-25'::date,55.00,0.001362),
    ('Aurore','Noël','2023-12-25'::date,55.00,0.001362),
    ('Thomas','Noël','2023-12-25'::date,55.00,0.001362),
    ('Thibault','Noël','2024-12-25'::date,55.00,0.00053083),
    ('Uhaina','Noël','2024-12-25'::date,55.00,0.00102021),
    ('Paul','Noël','2024-12-25'::date,55.00,0.00053083),
    ('Aurore','Noël','2024-12-25'::date,55.00,0.00053083),
    ('Thomas','Noël','2024-12-25'::date,55.00,0.00053083),
    ('Thibault','Noël','2025-12-25'::date,55.00,0.00071399),
    ('Uhaina','Noël','2025-12-25'::date,55.00,0.00071399),
    ('Paul','Noël','2025-12-25'::date,55.00,0.00071399),
    ('Aurore','Noël','2025-12-25'::date,55.00,0.00071399),
    ('Thomas','Noël','2025-12-25'::date,55.00,0.00071399)
),
live as (
  select member_name, occasion, gift_date, amount_eur, btc_amount, custody, is_deleted
  from public.gift_records
  where is_deleted = false
)
select
  coalesce(e.member_name, l.member_name) as membre,
  coalesce(e.occasion, l.occasion) as occasion,
  coalesce(e.gift_date, l.gift_date) as date_cadeau,
  e.amount_eur as attendu_eur,
  l.amount_eur as supabase_eur,
  e.btc_amount as attendu_btc,
  l.btc_amount as supabase_btc,
  l.custody,
  case
    when l.member_name is null then 'MANQUANT DANS SUPABASE (l’app utilise la valeur du fichier local)'
    when e.member_name is null then 'EXTRA DANS SUPABASE (absent du fichier local, normal si ajouté récemment)'
    when e.amount_eur <> l.amount_eur or e.btc_amount <> l.btc_amount then 'ECART DE MONTANT'
    else 'OK'
  end as statut
from expected e
full outer join live l
  on e.member_name = l.member_name and e.occasion = l.occasion and e.gift_date = l.gift_date
order by 3, 1;
