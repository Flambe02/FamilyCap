-- Annee de naissance optionnelle : les anniversaires jour/mois existants sont conserves.
alter table public.family_members add column if not exists birthday_year integer;

do $birthday_year_check$
begin
  if not exists (select 1 from pg_constraint where conname = 'family_members_birthday_year_check') then
    alter table public.family_members
      add constraint family_members_birthday_year_check
      check (birthday_year is null or birthday_year between 1900 and 2100);
  end if;
end;
$birthday_year_check$;
