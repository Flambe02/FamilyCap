-- Mémorise le dernier solde blockchain réel constaté pour chaque portefeuille Ledger, pour que
-- l'écran Bitcoin (résumé, aperçu admin d'un membre) puisse afficher « dernière vérification »
-- sans redemander Blockstream à chaque chargement de page — seule une actualisation manuelle
-- (bouton « Actualiser ») déclenche un nouvel appel réel et met ces colonnes à jour. Additive et
-- rejouable sans perte de données. Dépend de 20260716_cap_family.sql (table wallets).

alter table public.wallets
  add column if not exists last_verified_balance_btc numeric,
  add column if not exists last_verified_at timestamptz;

comment on column public.wallets.last_verified_balance_btc is 'Dernier solde blockchain réel constaté (Blockstream), écrit à chaque vérification /api/ledger réussie (mode complet, pas priceOnly/cachedOnly).';
comment on column public.wallets.last_verified_at is 'Date de la dernière vérification blockchain réelle pour ce portefeuille.';
