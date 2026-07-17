alter table public.gift_records
  add column if not exists ledger_force_reason text;
