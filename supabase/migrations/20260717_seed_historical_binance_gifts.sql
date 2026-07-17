-- Importe les cadeaux historiques confirmés qui sont encore conservés sur Binance commun.
-- Idempotent : les cadeaux déjà présents (notamment ceux associés à un Ledger) ne sont pas recréés.

with historical_gifts (member_name, occasion, gift_date, purchase_date, amount_eur, btc_amount, note) as (
  values
    ('Paul', 'Anniversaire', date '2022-11-18', date '2022-11-18', 55.00::numeric, 0.00155968::numeric, 'Valeur confirmée par le tableau familial.'),
    ('Thomas', 'Anniversaire', date '2022-12-29', date '2022-12-29', 55.00::numeric, 0.00137058::numeric, 'Valeur confirmée par le tableau familial.'),
    ('Thibault', 'Anniversaire', date '2023-03-15', date '2023-03-15', 55.00::numeric, 0.00217000::numeric, 'Valeur confirmée par le tableau familial.'),
    ('Uhaina', 'Anniversaire', date '2023-08-16', date '2023-08-16', 55.42::numeric, 0.00207000::numeric, 'Compensation du solde réduit reçu à Noël 2022, frais Binance inclus.'),
    ('Paul', 'Anniversaire', date '2023-11-18', date '2023-11-18', 55.00::numeric, 0.00155968::numeric, 'Valeur confirmée par le tableau familial.'),
    ('Aurore', 'Anniversaire', date '2023-08-27', date '2023-08-27', 55.00::numeric, 0.00208000::numeric, 'Valeur confirmée par le tableau familial.'),
    ('Aurore', 'Anniversaire', date '2024-08-27', date '2024-08-27', 55.00::numeric, 0.00147000::numeric, 'Valeur confirmée par le tableau familial.'),
    ('Thomas', 'Anniversaire', date '2024-12-29', date '2024-12-29', 55.00::numeric, 0.00059000::numeric, 'Valeur confirmée par le tableau familial.'),
    ('Thibault', 'Anniversaire', date '2025-03-15', date '2025-03-15', 55.00::numeric, 0.00067890::numeric, 'Valeur confirmée par le tableau familial.'),
    ('Uhaina', 'Anniversaire', date '2025-08-16', date '2025-08-16', 55.00::numeric, 0.00053622::numeric, 'Valeur confirmée par le tableau familial.'),
    ('Paul', 'Anniversaire', date '2025-11-18', date '2025-11-18', 55.00::numeric, 0.00065951::numeric, 'Valeur confirmée par le tableau familial.'),
    ('Aurore', 'Anniversaire', date '2025-08-27', date '2025-08-27', 55.00::numeric, 0.00054322::numeric, 'Valeur confirmée par le tableau familial.'),
    ('Thibault', 'Noël', date '2022-12-27', date '2022-12-27', 55.00::numeric, 0.00309400::numeric, 'Cadeau de Noël acheté le 27/12/2022 · valeur confirmée par le tableau familial.'),
    ('Uhaina', 'Noël', date '2022-12-27', date '2022-12-27', 45.76::numeric, 0.00289400::numeric, 'Montant net reçu réduit par les frais ; compensation appliquée à l’anniversaire 2023.'),
    ('Paul', 'Noël', date '2022-12-27', date '2022-12-27', 48.97::numeric, 0.00309400::numeric, 'Cadeau de Noël acheté le 27/12/2022 · valeur confirmée par le tableau familial.'),
    ('Aurore', 'Noël', date '2022-12-27', date '2022-12-27', 48.93::numeric, 0.00309400::numeric, 'Cadeau de Noël acheté le 27/12/2022 · valeur confirmée par le tableau familial.'),
    ('Thomas', 'Noël', date '2022-12-27', date '2022-12-27', 48.93::numeric, 0.00309400::numeric, 'Cadeau de Noël acheté le 27/12/2022 · valeur confirmée par le tableau familial.'),
    ('Thibault', 'Noël', date '2023-12-25', date '2023-12-25', 55.00::numeric, 0.00136200::numeric, 'Cadeau de Noël acheté le 25/12/2023 · valeur confirmée par le tableau familial.'),
    ('Uhaina', 'Noël', date '2023-12-25', date '2023-12-25', 55.00::numeric, 0.00136200::numeric, 'Cadeau de Noël acheté le 25/12/2023 · valeur confirmée par le tableau familial.'),
    ('Paul', 'Noël', date '2023-12-25', date '2023-12-25', 55.00::numeric, 0.00136200::numeric, 'Cadeau de Noël acheté le 25/12/2023 · valeur confirmée par le tableau familial.'),
    ('Aurore', 'Noël', date '2023-12-25', date '2023-12-25', 55.00::numeric, 0.00136200::numeric, 'Cadeau de Noël acheté le 25/12/2023 · valeur confirmée par le tableau familial.'),
    ('Thomas', 'Noël', date '2023-12-25', date '2023-12-25', 55.00::numeric, 0.00136200::numeric, 'Cadeau de Noël acheté le 25/12/2023 · valeur confirmée par le tableau familial.'),
    ('Thibault', 'Noël', date '2024-12-25', date '2024-12-25', 55.00::numeric, 0.00053083::numeric, 'Cadeau de Noël acheté le 25/12/2024 · valeur confirmée par le tableau familial.'),
    ('Uhaina', 'Noël', date '2024-12-25', date '2024-12-25', 55.00::numeric, 0.00053083::numeric, 'Cadeau de Noël acheté le 25/12/2024 · valeur confirmée par le tableau familial.'),
    ('Paul', 'Noël', date '2024-12-25', date '2024-12-25', 55.00::numeric, 0.00053083::numeric, 'Cadeau de Noël acheté le 25/12/2024 · valeur confirmée par le tableau familial.'),
    ('Aurore', 'Noël', date '2024-12-25', date '2024-12-25', 55.00::numeric, 0.00053083::numeric, 'Cadeau de Noël acheté le 25/12/2024 · valeur confirmée par le tableau familial.'),
    ('Thomas', 'Noël', date '2024-12-25', date '2024-12-25', 55.00::numeric, 0.00053083::numeric, 'Cadeau de Noël acheté le 25/12/2024 · valeur confirmée par le tableau familial.'),
    ('Thibault', 'Noël', date '2025-12-25', date '2025-12-25', 55.00::numeric, 0.00071399::numeric, 'Cadeau de Noël acheté le 25/12/2025 · valeur confirmée par le tableau familial.'),
    ('Uhaina', 'Noël', date '2025-12-25', date '2025-12-25', 55.00::numeric, 0.00071399::numeric, 'Cadeau de Noël acheté le 25/12/2025 · valeur confirmée par le tableau familial.'),
    ('Paul', 'Noël', date '2025-12-25', date '2025-12-25', 55.00::numeric, 0.00071399::numeric, 'Cadeau de Noël acheté le 25/12/2025 · valeur confirmée par le tableau familial.'),
    ('Aurore', 'Noël', date '2025-12-25', date '2025-12-25', 55.00::numeric, 0.00071399::numeric, 'Cadeau de Noël acheté le 25/12/2025 · valeur confirmée par le tableau familial.'),
    ('Thomas', 'Noël', date '2025-12-25', date '2025-12-25', 55.00::numeric, 0.00071399::numeric, 'Cadeau de Noël acheté le 25/12/2025 · valeur confirmée par le tableau familial.')
), reclassified as (
  update public.gift_records gift
  set custody = 'Binance commun',
      blockchain_status = 'Stocké sur Binance commun'
  from historical_gifts history
  where gift.member_name = history.member_name
    and gift.occasion = history.occasion
    and gift.gift_date = history.gift_date
    and gift.custody = 'À rapprocher'
    and gift.txid is null
    and gift.ledger_amount is null
  returning gift.id
)
insert into public.gift_records (
  member_id, member_name, occasion, gift_date, purchase_date,
  amount_eur, btc_amount, custody, blockchain_status, confirmations, note
)
select
  member.id, history.member_name, history.occasion, history.gift_date, history.purchase_date,
  history.amount_eur, history.btc_amount, 'Binance commun', 'Stocké sur Binance commun', 0, history.note
from historical_gifts history
join public.family_members member on member.name = history.member_name
where not exists (
  select 1
  from public.gift_records existing
  where existing.member_name = history.member_name
    and existing.occasion = history.occasion
    and existing.gift_date = history.gift_date
);