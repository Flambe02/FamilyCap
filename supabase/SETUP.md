# Activation Supabase — LaBaJo & Co

1. Ouvrir le projet **LaBaJo & Co** dans Supabase.
2. Aller dans **SQL Editor** → **New query**.
   > Exécuter les 10 migrations **dans l’ordre chronologique ci-dessous**. Elles sont toutes additives et peuvent être rejouées sans perte de données.
3. Copier tout le contenu de `migrations/20260716_cap_family.sql`, puis cliquer sur **Run**.
4. Exécuter `migrations/20260716_admin_portfolios.sql` : crée les tables `financial_accounts` et positions (PEA, compte-titres, banque, crypto…) utilisées par l’espace multi-actifs de l’admin.
5. Exécuter `migrations/20260716_gift_reconciliation.sql` : cette mise à jour permet de désassocier un cadeau d’un virement Ledger sans toucher à la transaction blockchain.
6. Exécuter `migrations/20260717_force_ledger_value.sql`, puis `migrations/20260717_force_ledger_reason.sql` : ces mises à jour mémorisent explicitement les écarts entre un achat et la réception Ledger, avec leur motif.
7. Exécuter `migrations/20260717_seed_historical_binance_gifts.sql` : elle importe les cadeaux historiques confirmés qui restent sur Binance commun et rend le suivi de transfert opérationnel.
8. Exécuter `migrations/20260717_soft_delete_gift_records.sql` : elle permet de retirer un cadeau Binance du suivi sans effacer son historique et sans jamais autoriser une suppression Ledger.
9. Exécuter `migrations/20260718_investment_access.sql` (**après** les migrations `20260716_*`) : ajoute le partage contrôlé des investissements (`investment_access_scope` / `investment_access_grants`) et synchronise le lien compte Supabase Auth ↔ membre famille.
10. Exécuter `migrations/20260719_birth_year.sql` : ajoute l’année de naissance optionnelle (`birthday_year`) en conservant les anniversaires jour/mois existants.
11. Exécuter `migrations/20260719_wallets_member_unique.sql` : contrainte d’unicité `member_id` sur `wallets` pour permettre l’upsert propre du portefeuille Bitcoin depuis l’admin (au lieu des adresses codées en dur).
12. Aller dans **Authentication** → **Hooks**.
13. Activer **Before User Created** avec la fonction Postgres `public.hook_allow_cap_family_member`.
14. Dans **Authentication** → **URL Configuration** :
   - Site URL locale : `http://localhost:3003`
   - Redirect URL locale : `http://localhost:3003/**`
   - ajouter ensuite l’URL publique de production lorsqu’elle sera connue.
15. Dans **Authentication** → **Providers** → **Google**, activer Google et renseigner le Client ID et le Client Secret Google.
16. Dans **Authentication** → **Email**, laisser e-mail/mot de passe et Magic Link activés.

La clé secrète reste uniquement dans `.env.local`. Elle ne doit jamais être ajoutée au SQL, au navigateur, à Git ou à un message.