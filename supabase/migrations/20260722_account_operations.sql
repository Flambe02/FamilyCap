-- Registre des opérations des comptes financiers (PEA, compte-titres, …).
-- Le portefeuille est DÉRIVÉ de ces opérations : on ne stocke jamais une quantité
-- « totale » modifiable directement — chaque position résulte des achats/ventes/corrections.
--
-- Additive et rejouable sans perte de données. À exécuter MANUELLEMENT dans le SQL Editor
-- Supabase, APRÈS 20260716_admin_portfolios.sql (dépend de public.financial_accounts,
-- public.family_members, public.current_family_member_id, public.is_cap_family_admin).
-- Ne JAMAIS l'exécuter automatiquement sur la production.

create table if not exists public.account_operations (
  id uuid primary key default gen_random_uuid(),
  -- Compte porteur (financial_accounts) : son account_type ('pea' / 'securities' / …)
  -- détermine si l'opération relève du PEA ou du compte-titres. Le moteur reste générique.
  account_id uuid not null references public.financial_accounts(id) on delete cascade,
  -- member_id dénormalisé (= financial_accounts.member_id) : indispensable au filtrage RLS
  -- et au partage familial sans jointure. Forcé côté serveur à l'identité du compte.
  member_id uuid not null references public.family_members(id) on delete cascade,
  type text not null check (type in ('achat', 'vente', 'versement', 'retrait', 'dividende', 'frais', 'correction')),
  operation_date date not null,
  -- Actif concerné (facultatif : un versement/retrait n'a pas d'actif).
  asset_name text,
  ticker text,
  isin text,
  -- Quantité signée pour les corrections ; positive pour achats/ventes (le sens vient du type).
  quantity numeric(24, 8),
  unit_price numeric(20, 6),
  -- Montant brut (avant frais), frais, montant net (mouvement de trésorerie réel).
  gross_amount numeric(20, 2),
  fees numeric(20, 2) not null default 0,
  net_amount numeric(20, 2),
  currency text not null default 'EUR',
  source text,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists account_operations_account_idx on public.account_operations(account_id, operation_date);
create index if not exists account_operations_member_idx on public.account_operations(member_id, operation_date);
create index if not exists account_operations_isin_idx on public.account_operations(isin);

alter table public.account_operations enable row level security;

-- Lecture : un membre voit ses propres opérations ; l'administrateur voit tout.
-- (Le partage familial « scope famille / autorisations » est appliqué EN CODE dans les routes
--  /api/*, comme pour holdings — cf. lib/auth-server.ts::viewableMemberIds. La policy ci-dessous
--  reste le filet de sécurité pour un éventuel accès direct via la clé publishable.)
drop policy if exists "member reads own account operations" on public.account_operations;
create policy "member reads own account operations"
on public.account_operations for select to authenticated
using (member_id = public.current_family_member_id() or public.is_cap_family_admin());

-- Les écritures passent par la route serveur /api/pea/operations, protégée par requireAdmin() ;
-- la clé service-role reste exclusivement serveur et le member_id est forcé sur celui du compte.
