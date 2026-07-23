-- Imports d'opérations (CSV / XLSX / scan IA) pour les comptes PEA & compte-titres.
-- Additive et rejouable sans perte de données. À exécuter MANUELLEMENT dans le SQL Editor
-- Supabase, APRÈS 20260722_account_operations.sql PUIS 20260725_investment_multicurrency.sql.
-- Ne JAMAIS l'exécuter automatiquement sur la production.
--
-- Objectif : tracer chaque import d'opérations sous un « lot » (batch) rejouable et ANNULABLE,
-- sans dupliquer le registre financier. Les opérations restent dans account_operations
-- (source de vérité unique, dérivée par computeAccountModel) ; on ajoute simplement le lien
-- vers leur lot d'origine + une référence externe + une empreinte de dédoublonnage.

-- 1) Lot d'import : traçabilité, statistiques et annulation. Un import groupe N opérations
--    sous un même id. On conserve la ligne du lot même après annulation (audit).
create table if not exists public.investment_import_batches (
  id uuid primary key default gen_random_uuid(),
  -- Compte cible (financial_accounts) : son type détermine PEA vs compte-titres.
  account_id uuid not null references public.financial_accounts(id) on delete cascade,
  -- member_id dénormalisé (= financial_accounts.member_id) : filtrage RLS / requêtes sans jointure.
  -- Forcé côté serveur à l'identité du compte, jamais fourni librement par le client.
  member_id uuid not null references public.family_members(id) on delete cascade,
  -- Administrateur ayant lancé l'import (traçabilité). set null si le membre est supprimé.
  imported_by uuid references public.family_members(id) on delete set null,
  original_filename text,
  file_type text,                 -- 'csv' | 'xlsx' | 'pdf' | 'image'
  file_fingerprint text,          -- empreinte du fichier (repère un même fichier réimporté)
  source_kind text not null default 'file' check (source_kind in ('file', 'ai_scan')),
  status text not null default 'pending' check (status in ('pending', 'completed', 'failed', 'cancelled')),
  total_rows integer not null default 0,
  imported_rows integer not null default 0,
  ignored_rows integer not null default 0,
  duplicate_rows integer not null default 0,
  error_rows integer not null default 0,
  -- Correspondance colonnes → champs retenue (rejouabilité / audit). Aucune donnée brute du
  -- fichier n'est conservée : uniquement le mapping technique.
  mapping jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  cancelled_at timestamptz
);

create index if not exists investment_import_batches_account_idx on public.investment_import_batches(account_id, created_at desc);
create index if not exists investment_import_batches_member_idx on public.investment_import_batches(member_id);

alter table public.investment_import_batches enable row level security;

-- Lecture : un membre voit ses propres lots ; l'administrateur voit tout. (Le partage familial
-- « scope famille / autorisations » est appliqué EN CODE dans les routes /api/*, comme pour
-- account_operations ; cette policy reste le filet de sécurité pour un accès direct.)
-- Écriture exclusivement serveur via la clé service-role (routes protégées par requireAdmin()).
drop policy if exists "member reads own import batches" on public.investment_import_batches;
create policy "member reads own import batches"
on public.investment_import_batches for select to authenticated
using (member_id = public.current_family_member_id() or public.is_cap_family_admin());

-- 2) Rattachement des opérations à leur lot + traçabilité d'import (dédup, référence externe).
--    La colonne `source` existe déjà (20260722) : on la réutilise avec 'manual' / 'import' /
--    'ai_scan' — aucune nouvelle colonne de source n'est créée.
--    import_batch_id : on delete SET NULL — supprimer un lot ne cascade JAMAIS une suppression
--    d'opérations financières (l'annulation supprime explicitement les opérations, puis marque
--    le lot 'cancelled' en conservant sa ligne d'audit).
alter table public.account_operations add column if not exists import_batch_id uuid references public.investment_import_batches(id) on delete set null;
alter table public.account_operations add column if not exists external_reference text;
alter table public.account_operations add column if not exists import_fingerprint text;

create index if not exists account_operations_import_batch_idx on public.account_operations(import_batch_id);
create index if not exists account_operations_fingerprint_idx on public.account_operations(account_id, import_fingerprint);
create index if not exists account_operations_extref_idx on public.account_operations(account_id, external_reference);

-- Aucune nouvelle policy sur account_operations : les policies de 20260722 restent en vigueur.
-- Les écritures (import, commit, annulation) passent par les routes serveur protégées par
-- requireAdmin() ; la clé service-role demeure strictement serveur et le member_id est TOUJOURS
-- dérivé du compte porteur (jamais fourni par le navigateur).
