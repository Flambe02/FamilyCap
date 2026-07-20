-- Un seul portefeuille Bitcoin géré par membre pour l'instant : contrainte
-- d'unicité sur member_id pour permettre un upsert propre depuis l'admin
-- (on_conflict=member_id), au lieu des adresses codées en dur dans le code.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'wallets_member_id_unique'
  ) then
    alter table public.wallets
      add constraint wallets_member_id_unique unique (member_id);
  end if;
end $$;
