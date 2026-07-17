# Activation Supabase — Cap Family

1. Ouvrir le projet **Cap Family** dans Supabase.
2. Aller dans **SQL Editor** → **New query**.
3. Copier tout le contenu de `migrations/20260716_cap_family.sql`, puis cliquer sur **Run**.
4. Exécuter `migrations/20260716_gift_reconciliation.sql` : cette mise à jour permet de désassocier un cadeau d’un virement Ledger sans toucher à la transaction blockchain.
5. Exécuter `migrations/20260717_force_ledger_value.sql`, puis `migrations/20260717_force_ledger_reason.sql` : ces mises à jour mémorisent explicitement les écarts entre un achat et la réception Ledger, avec leur motif.
6. Exécuter `migrations/20260717_seed_historical_binance_gifts.sql` : elle importe les cadeaux historiques confirmés qui restent sur Binance commun et rend le suivi de transfert opérationnel.
7. Exécuter `migrations/20260717_soft_delete_gift_records.sql` : elle permet de retirer un cadeau Binance du suivi sans effacer son historique et sans jamais autoriser une suppression Ledger.
8. Aller dans **Authentication** → **Hooks**.
9. Activer **Before User Created** avec la fonction Postgres `public.hook_allow_cap_family_member`.
10. Dans **Authentication** → **URL Configuration** :
   - Site URL locale : `http://localhost:3003`
   - Redirect URL locale : `http://localhost:3003/**`
   - ajouter ensuite l’URL publique de production lorsqu’elle sera connue.
11. Dans **Authentication** → **Providers** → **Google**, activer Google et renseigner le Client ID et le Client Secret Google.
12. Dans **Authentication** → **Email**, laisser e-mail/mot de passe et Magic Link activés.

La clé secrète reste uniquement dans `.env.local`. Elle ne doit jamais être ajoutée au SQL, au navigateur, à Git ou à un message.