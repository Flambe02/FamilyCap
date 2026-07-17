-- Conserver une trace d’un cadeau Binance retiré du suivi, sans permettre qu’il
-- réapparaisse depuis l’historique local. Les cadeaux Ledger restent verrouillés
-- par l’API ; cette colonne sert uniquement aux cadeaux non-Ledger.
alter table public.gift_records
  add column if not exists is_deleted boolean not null default false;

create index if not exists gift_records_active_member_date_idx
  on public.gift_records (member_name, gift_date desc)
  where is_deleted = false;