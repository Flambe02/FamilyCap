-- Atomise le rapprochement d'un virement Ledger : deux requêtes concurrentes ne
-- peuvent pas attribuer deux fois les mêmes cadeaux.
drop function if exists public.apply_ledger_transfer(jsonb);

create or replace function public.apply_ledger_transfer(p_updates jsonb, p_txid text, p_received_sats bigint)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  expected_count integer;
  updated_count integer;
begin
  -- Sérialise les rapprochements concurrents du même virement Bitcoin, y compris
  -- lorsqu'ils portent sur des cadeaux différents.
  perform pg_advisory_xact_lock(hashtextextended(p_txid, 0));

  if jsonb_typeof(p_updates) <> 'array' then
    raise exception 'Les mises à jour Ledger doivent être un tableau JSON';
  end if;

  select count(*) into expected_count from jsonb_array_elements(p_updates);
  if expected_count = 0 then
    raise exception 'Aucun cadeau à mettre à jour';
  end if;

  if exists (
    select 1
    from public.gift_records gift
    join jsonb_array_elements(p_updates) update_row
      on gift.id = (update_row->>'id')::uuid
    where coalesce(gift.is_deleted, false) or gift.custody = 'Ledger'
  ) then
    raise exception 'Un cadeau a déjà été transféré ou supprimé';
  end if;

  update public.gift_records gift
  set custody = update_row->>'custody',
      transfer_date = nullif(update_row->>'transfer_date', '')::date,
      ledger_amount = nullif(update_row->>'ledger_amount', '')::numeric,
      ledger_value_forced = coalesce((update_row->>'ledger_value_forced')::boolean, false),
      ledger_force_reason = nullif(update_row->>'ledger_force_reason', ''),
      public_address = nullif(update_row->>'public_address', ''),
      txid = nullif(update_row->>'txid', ''),
      blockchain_status = update_row->>'blockchain_status',
      confirmations = coalesce((update_row->>'confirmations')::integer, 0)
  from jsonb_array_elements(p_updates) update_row
  where gift.id = (update_row->>'id')::uuid
    and coalesce(gift.is_deleted, false) = false
    and gift.custody <> 'Ledger';

  get diagnostics updated_count = row_count;
  if updated_count <> expected_count then
    raise exception 'Le registre a changé pendant le rapprochement Ledger';
  end if;
  if (
    select coalesce(sum(round(gift.ledger_amount * 100000000)), 0)
    from public.gift_records gift
    where gift.txid = p_txid and coalesce(gift.is_deleted, false) = false
  ) > p_received_sats then
    raise exception 'Le virement Ledger serait attribué au-delà du montant reçu';
  end if;
  return updated_count;
end;
$$;

revoke all on function public.apply_ledger_transfer(jsonb, text, bigint) from public;
grant execute on function public.apply_ledger_transfer(jsonb, text, bigint) to service_role;
