-- Origine d'un lot Bitcoin : cadeau d'Amatxi (défaut), investissement personnel, ou achat
-- groupé / autre. Migration additive et idempotente : tout l'historique existant reste
-- « cadeau_amatxi » (ce qui est exact — 100 % des cadeaux enregistrés jusqu'ici).
--
-- La colonne est OPTIONNELLE côté application : la route /api/gifts sait écrire sans elle
-- (fallback) tant que cette migration n'a pas été jouée. Exécuter dans le SQL Editor Supabase.

alter table public.gift_records
  add column if not exists source text not null default 'cadeau_amatxi';

do $$
begin
  if not exists (
    select 1 from information_schema.constraint_column_usage
    where table_name = 'gift_records' and constraint_name = 'gift_records_source_check'
  ) then
    alter table public.gift_records
      add constraint gift_records_source_check
      check (source in ('cadeau_amatxi', 'investissement_personnel', 'achat_groupe'));
  end if;
end $$;

create index if not exists gift_records_source_idx on public.gift_records(source);
