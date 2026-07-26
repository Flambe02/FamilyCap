-- Symbole de marché résolu (Yahoo Finance : « AI.PA », « VHYL.AS », « MSFT »…), mémorisé pour
-- éviter de re-résoudre l'ISIN à chaque rafraîchissement des cours.
--
-- FACULTATIVE : /api/admin/market/refresh fonctionne SANS cette colonne (il ré-interroge alors
-- la recherche par ISIN à chaque appel). L'appliquer économise simplement des requêtes.
--
-- Volontairement DISTINCTE de `holdings.symbol` : `symbol` est le ticker du relevé, utilisé pour
-- rapprocher les instruments d'un import (« AI »). Y écrire « AI.PA » casserait ce rapprochement.
--
-- Additive, rejouable, sans effet sur les données existantes.
-- À exécuter MANUELLEMENT dans le SQL Editor Supabase.

alter table public.holdings add column if not exists market_symbol text;

comment on column public.holdings.market_symbol is
  'Symbole du fournisseur de cours (Yahoo Finance). Rempli par /api/admin/market/refresh. Ne pas confondre avec symbol (ticker du relevé, sert au rapprochement des imports).';
