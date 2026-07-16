-- Le statut « À rapprocher » sert uniquement au registre administrateur.
-- Il conserve le cadeau tout en libérant une association Ledger erronée,
-- sans modifier le mouvement public présent sur la blockchain.
alter table public.gift_records drop constraint if exists gift_records_custody_check;
alter table public.gift_records
  add constraint gift_records_custody_check
  check (custody in ('Ledger', 'Binance commun', 'À rapprocher'));