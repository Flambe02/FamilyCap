-- Compte-titres (CTO) : champs multi-devises, transferts de titres et objectif mensuel.
-- Additive et rejouable sans perte de données. À exécuter MANUELLEMENT dans le SQL Editor
-- Supabase, APRÈS 20260722_account_operations.sql. Ne JAMAIS l'exécuter automatiquement
-- sur la production.
--
-- Le moteur reste générique (PEA / compte-titres) : ces colonnes sont OPTIONNELLES. Le PEA
-- continue de fonctionner à l'identique (il n'écrit ni transfert, ni taux de change, ni taxes).
-- Tant que cette migration n'est pas jouée, l'application reste fonctionnelle : seules les
-- opérations CTO « avancées » (transfert de titres, taux de change, taxes) l'exigent.

-- 1) Colonnes multi-devises / transferts sur le registre d'opérations.
--    - exchange_rate : taux de change vers la devise du compte au moment de l'opération
--      (jamais inventé : renseigné uniquement si l'utilisateur le fournit) ;
--    - taxes         : retenue à la source / prélèvements isolés (ex. dividende étranger) ;
--    Aucune conversion n'est calculée par le moteur au lot 1 : ces champs sont STOCKÉS pour
--    l'impact du change à venir, et la devise d'origine (colonne currency existante) est
--    toujours conservée.
alter table public.account_operations add column if not exists exchange_rate numeric(18, 8);
alter table public.account_operations add column if not exists taxes numeric(20, 2);

-- 2) Étendre les types d'opération avec les transferts de titres (entrants / sortants).
--    Un transfert déplace une position sans mouvement d'espèces ; le prix unitaire porte le
--    prix de revient repris. On reconstruit la contrainte CHECK de façon idempotente.
alter table public.account_operations drop constraint if exists account_operations_type_check;
alter table public.account_operations add constraint account_operations_type_check
  check (type in ('achat', 'vente', 'versement', 'retrait', 'dividende', 'frais', 'correction', 'transfer_in', 'transfer_out'));

-- 3) Compte : objectif mensuel facultatif et date d'ouverture (pour l'écran Résumé CTO).
--    Le statut actif/archivé est déjà porté par financial_accounts.is_active.
alter table public.financial_accounts add column if not exists monthly_target numeric(20, 2);
alter table public.financial_accounts add column if not exists opened_at date;

-- Aucune nouvelle policy : la lecture reste régie par les policies existantes de
-- account_operations / financial_accounts, et les écritures passent par les routes serveur
-- protégées par requireAdmin(). La clé service-role demeure strictement serveur.
