-- Visibilite par CLASSE d'actif du partage familial.
-- Jusqu'ici le partage etait "tout ou rien" : scope 'family'/'selected' + investment_access_grants
-- decidaient QUI voit mes investissements, mais pas QUOI. Un membre peut desormais choisir,
-- independamment, s'il expose son BTC, son PEA et/ou son compte-titres (CTO) aux personnes
-- avec qui il partage. Le "qui" (scope + grants) est inchange ; on ajoute le "quoi".
--
-- Defaut = tout visible (true) pour ne rien casser : le comportement historique restait
-- global. La frontiere de securite reelle est le code applicatif (service-role contourne la
-- RLS) via lib/auth-server.ts::viewableInvestmentScope ; les policies ci-dessous sont le
-- filet de securite en parite.
--
-- A executer apres 20260718_investment_access.sql dans le SQL Editor Supabase.

alter table public.family_members
  add column if not exists share_btc boolean not null default true,
  add column if not exists share_pea boolean not null default true,
  add column if not exists share_cto boolean not null default true;

-- Regle d'acces PAR CLASSE : admin, ou soi, ou (partage avec moi ET la classe est exposee).
-- asset_class : 'btc' | 'pea' | 'cto'. Toute autre valeur => faux (seuls admin/soi passent).
create or replace function public.can_view_member_asset(target_member_id uuid, asset_class text)
returns boolean
language sql
stable
security definer
set search_path = public
as $capfamily_asset$
  select
    public.is_cap_family_admin()
    or target_member_id = public.current_family_member_id()
    or exists (
      select 1
      from public.family_members owner
      where owner.id = target_member_id
        and owner.is_active = true
        and (
          owner.investment_access_scope = 'family'
          or exists (
            select 1
            from public.investment_access_grants access_grant
            where access_grant.owner_member_id = owner.id
              and access_grant.viewer_member_id = public.current_family_member_id()
          )
        )
        and case asset_class
          when 'btc' then owner.share_btc
          when 'pea' then owner.share_pea
          when 'cto' then owner.share_cto
          else false
        end
    );
$capfamily_asset$;

grant execute on function public.can_view_member_asset(uuid, text) to authenticated;

-- BTC : cadeaux + wallets suivent la classe 'btc'.
drop policy if exists "family member reads shared gifts" on public.gift_records;
create policy "family member reads shared gifts"
on public.gift_records for select to authenticated
using (public.can_view_member_asset(member_id, 'btc'));

drop policy if exists "family member reads shared wallets" on public.wallets;
create policy "family member reads shared wallets"
on public.wallets for select to authenticated
using (public.can_view_member_asset(member_id, 'btc'));

-- PEA / CTO : la meme table financial_accounts porte les deux (account_type 'pea' | 'securities').
-- On mappe securities -> 'cto', pea -> 'pea', bitcoin -> 'btc' ; les autres types restent
-- reserves a l'admin/proprietaire (classe inconnue => faux).
do $investment_policy$
begin
  if to_regclass('public.financial_accounts') is not null then
    execute 'drop policy if exists "family member reads shared financial accounts" on public.financial_accounts';
    execute $q$create policy "family member reads shared financial accounts" on public.financial_accounts for select to authenticated using (public.can_view_member_asset(member_id, case account_type when 'securities' then 'cto' when 'pea' then 'pea' when 'bitcoin' then 'btc' else 'none' end))$q$;
  end if;

  if to_regclass('public.holdings') is not null then
    execute 'drop policy if exists "family member reads shared holdings" on public.holdings';
    execute $q$create policy "family member reads shared holdings" on public.holdings for select to authenticated using (exists (select 1 from public.financial_accounts account where account.id = holdings.account_id and public.can_view_member_asset(account.member_id, case account.account_type when 'securities' then 'cto' when 'pea' then 'pea' when 'bitcoin' then 'btc' else 'none' end)))$q$;
  end if;
end;
$investment_policy$;
