-- Ajoute dans public.gift_records les deux anniversaires 2024 confirmés
-- (Thibault 15/03/2024, Uhaina 16/08/2024) qui n'existaient jusqu'ici que
-- dans le fichier local lib/gift-history.ts.
insert into public.gift_records (member_id, member_name, occasion, gift_date, purchase_date, amount_eur, btc_amount, custody, blockchain_status, confirmations, is_deleted)
select id, 'Thibault', 'Anniversaire', '2024-03-15'::date, '2024-03-15'::date, 55.00::numeric, 0.00083::numeric, 'Binance commun', 'Stocké sur Binance commun', 0, false
from public.family_members where name = 'Thibault'
union all
select id, 'Uhaina', 'Anniversaire', '2024-08-16'::date, '2024-08-16'::date, 55.00::numeric, 0.00102021::numeric, 'Binance commun', 'Stocké sur Binance commun', 0, false
from public.family_members where name = 'Uhaina';
