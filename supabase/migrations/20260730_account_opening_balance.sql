-- Solde de départ (facultatif) d'un compte financier (PEA, compte-titres, …).
-- C'est le solde DÉCLARÉ à l'ouverture du suivi : une information de contexte saisie par
-- l'administrateur, PAS un total injecté dans le moteur. Le portefeuille reste dérivé des
-- opérations (lib/portfolio-account.ts) ; ce champ documente simplement le point de départ.
--
-- Additive et rejouable sans perte de données. À exécuter MANUELLEMENT dans le SQL Editor
-- Supabase, APRÈS 20260716_admin_portfolios.sql. Ne JAMAIS l'exécuter automatiquement sur la
-- production. Tant qu'elle n'est pas jouée, l'application reste fonctionnelle : la lecture des
-- comptes retombe sur les colonnes de base et l'écriture n'ajoute la colonne que si elle existe.
alter table public.financial_accounts add column if not exists opening_balance numeric(20, 2);
