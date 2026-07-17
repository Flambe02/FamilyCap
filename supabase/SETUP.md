# Activation Supabase — Cap Family

1. Ouvrir le projet **Cap Family** dans Supabase.
2. Aller dans **SQL Editor** → **New query**.
3. Copier tout le contenu de `migrations/20260716_cap_family.sql`, puis cliquer sur **Run**.
4. Puis exécuter `migrations/20260716_gift_reconciliation.sql` : cette mise à jour permet de désassocier un cadeau d’un virement Ledger sans toucher à la transaction blockchain.
4. Aller dans **Authentication** → **Hooks**.
5. Activer **Before User Created** avec la fonction Postgres `public.hook_allow_cap_family_member`.
6. Dans **Authentication** → **URL Configuration** :
   - Site URL locale : `http://localhost:3003`
   - Redirect URL locale : `http://localhost:3003/**`
   - ajouter ensuite l’URL publique de production lorsqu’elle sera connue.
7. Dans **Authentication** → **Providers** → **Google**, activer Google et renseigner le Client ID et le Client Secret Google.
8. Dans **Authentication** → **Email**, laisser e-mail/mot de passe et Magic Link activés.

La clé secrète reste uniquement dans `.env.local`. Elle ne doit jamais être ajoutée au SQL, au navigateur, à Git ou à un message.

5. Ex�cuter `migrations/20260717_force_ledger_value.sql` : cette mise � jour m�morise explicitement toute correction manuelle o� le montant d�un virement Ledger remplace la quantit� BTC d�un cadeau.
