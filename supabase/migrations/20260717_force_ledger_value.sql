alter table public.gift_records
  add column if not exists ledger_value_forced boolean not null default false;