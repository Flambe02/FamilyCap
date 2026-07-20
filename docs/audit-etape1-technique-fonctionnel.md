# Étape 1 — Audit technique, fonctionnel et architectural de LaBaJo & Co

> Audit **exclusivement de lecture** (aucun fichier applicatif modifié, aucune migration exécutée). Réalisé par lecture exhaustive du code (`app/`, `lib/`, `supabase/`, configs, tests) via 6 passes de recherche parallèles + exécution de `tsc --noEmit`, `eslint`, `next build`. Chaque affirmation ci-dessous cite un `fichier:ligne` vérifié dans le code au 2026-07-20. Le document `web/README.md` (rédigé lors d'une session antérieure) a été traité comme une **hypothèse à vérifier**, pas comme une vérité acquise — les divergences trouvées sont signalées explicitement avec le préfixe **⚠ Écart README**.

---

## 1. Résumé exécutif

LaBaJo & Co est une SPA React/TypeScript sous coquille Next.js 16 App Router, avec une **seule route réelle** (`app/page.tsx`), toute la navigation se faisant en state React. Le backend est Supabase (Postgres + Auth), toutes les écritures passant par des Route Handlers Next.js utilisant la clé service-role (RLS bypassée pour le trafic applicatif réel). `next build`, `tsc --noEmit` et `next dev` fonctionnent ; `eslint` remonte 6 erreurs réelles et 4 avertissements.

Le cœur métier (cycle de vie d'un cadeau Bitcoin : achat → garde Binance → transfert Ledger → vérification blockchain → verrouillage) est **fonctionnel et globalement bien conçu** (allocation au prorata en satoshis, vérification TxID stricte, suppression douce). Mais l'audit a confirmé plusieurs **divergences réelles entre l'intention produit et le code exécuté**, dont certaines constituent de vrais bugs utilisateur ou des angles morts de confidentialité :

- **Bug utilisateur confirmé et croisé par deux agents indépendants** : l'anniversaire d'Aurore vaut « 17 août » dans `family-dashboard.tsx:40` mais « 27 août » partout ailleurs (4 autres fichiers + `lib/gift-history.ts`) — le compte à rebours affiché sur l'Accueil est donc faux.
- **Le mode « Aperçu admin / vue membre » n'est qu'une façade côté client** : le jeton Supabase réel de l'admin est toujours utilisé pour les appels API ; le caractère « lecture seule » n'est garanti que par l'UI (boutons masqués), jamais par le serveur.
- **Le réglage « Partage familial » (`investment_access_scope`/`investment_access_grants`) est prêt en base (RLS incluse) mais n'est consulté par aucune route API** — toutes les lectures utilisent la clé service-role qui contourne RLS ; le réglage est aujourd'hui cosmétique.
- **Deux chemins d'écriture distincts pour les opérations** (confirmé au caractère près) : la modale `InvestmentModal` (Transactions/Accueil) n'écrit que dans un `useState` local, jamais dans Supabase, avec un message de succès identique à celui d'un vrai enregistrement.
- **`supabase/SETUP.md` est obsolète** : 3 des 12 migrations existantes (`investment_access`, `birth_year`, `wallets_member_unique`) n'y sont pas documentées ; une nouvelle instance Supabase configurée en suivant ce guide serait cassée sur plusieurs fonctionnalités.
- **Une partie non négligeable du code applicatif n'est pas encore versionnée** : `app/settings.tsx` et `app/settings.css` (l'écran Paramètres entier, 7 sous-onglets) sont des fichiers *untracked* dans `git status` — perte de code possible en cas d'incident disque.
- Le verrouillage d'une ligne de cadeau (« non modifiable après transfert Ledger ») se déclenche sur la seule valeur `custody === "Ledger"`, **pas** sur la présence d'un TxID vérifié — contrairement au texte affiché à l'utilisateur.

**Verdict global** : le socle Bitcoin est solide et mérite d'être conservé sans réécriture ; la dette technique est réelle mais cartographiée et gérable ; deux ou trois angles morts de confidentialité/auth méritent correction **avant** d'exposer de nouvelles données sensibles (PEA/CTO) aux membres. Voir §35 pour le détail du GO/NO-GO.

---

## 2. État du dépôt

- Dépôt Git local dans `Cryptos Kids/web/.git`, branche `main`, à jour avec `origin/main`. 20 commits récents visibles (`git log`), les 5 derniers concernent une refonte de l'écran de connexion et des corrections mobiles (contraste dark-mode, centrage de la nav).
- **Modifications non commitées** au moment de l'audit :
  - `README.md`, `app/family-dashboard.tsx`, `app/family.css`, `public/Labajo logo.png` — modifiés, non stagés.
  - **`app/settings.tsx` et `app/settings.css` sont entièrement *untracked*** — c'est l'écran Paramètres complet (7 onglets : Mon compte, Sécurité, Mes investissements, Partage familial, Utilisateurs & accès, Règles des cadeaux, Données), activement importé et utilisé par `family-dashboard.tsx`, mais absent de l'historique Git. Risque réel de perte si le poste de travail est perdu avant un premier commit.
  - Autres fichiers untracked : `_tmp_prodcheck.cjs` (script de diagnostic ponctuel, à ne pas committer), plusieurs images (`public/*.png/gif`) liées au rebranding en cours.
- Deux copies du projet ont existé historiquement sur ce poste ; celle auditée (`CapFamily/Cryptos Kids/web`) est la copie canonique confirmée (mémoire de session, non re-vérifiée ici car hors périmètre du code).
- Aucun `.github/` (pas de CI configurée dans ce dépôt).

---

## 3. Stack réellement utilisée

Vérifiée dans `package.json`, confirmée par `next build` (Turbopack) :

| Domaine | Choix confirmé | Remarque |
|---|---|---|
| Framework | Next.js 16.2.6, App Router | Turbopack activé en build |
| UI | React 19.2.6 + TypeScript 5.9.3 | tous les écrans `"use client"` |
| Style | Tailwind CSS 4 (`@tailwindcss/postcss`) + CSS par écran | pas de librairie de composants |
| Backend | Route Handlers Next.js (`app/api/**/route.ts`) | 14 routes confirmées par `next build` |
| DB | Supabase Postgres + Auth | accès exclusivement via REST + clé service-role côté serveur |
| ORM déclaré mais mort | Drizzle (`db/`, `drizzle-orm`, `drizzle-kit`) | `db/index.ts` lève une erreur volontaire ; schéma SQLite/D1 sans rapport avec Supabase |
| Déploiement | Vercel | `next.config.ts` lit `VERCEL_GIT_COMMIT_SHA` |
| PWA | `manifest.webmanifest` + `public/sw.js` | SW enregistré uniquement si `NODE_ENV==="production"` (`register-service-worker.tsx:7`) |
| Cours BTC | CoinGecko puis Kraken (repli) | aucun prix fictif en repli — retourne `null` proprement si les deux échouent |
| Blockchain | Blockstream Esplora (lecture seule) | |
| Actions/ETF | Alpha Vantage (optionnel) | dégrade proprement si clé absente |
| Emails | Resend (optionnel) | dégrade silencieusement si clés absentes |
| Scaffolding mort | Vite, Wrangler, Cloudflare Workers, `.openai/`, `examples/` | issus du template `site-creator-vinext-starter` (voir `package.json:"name"`), aucun script npm ne les invoque |

`npx tsc --noEmit` → **0 erreur**. `npm run build` → **succès** (Turbopack, 5.2s compile + 7.0s typecheck), génère `/`, `/_not-found`, `/robots.txt` et les 14 routes API en mode dynamique (`ƒ`). `npm run lint` → **6 erreurs, 4 avertissements** (détail §25).

---

## 4. Architecture actuelle

```
app/page.tsx (SEULE route Next.js réelle)
  └─ AuthShell (auth-shell.tsx)          — session Supabase, setupMode, ?preview=dashboard
       └─ FamilyDashboard (family-dashboard.tsx)  — coquille de nav + state `view`
            ├─ Dashboard (Accueil, view="famille")
            ├─ GiftPortfolio (Portefeuilles)
            ├─ TransactionsView (Mouvements)
            ├─ Indicators (Indicateurs)
            ├─ Administration (admin only, 5 sous-onglets)
            ├─ AmatxiReport (admin only malgré son nom)
            ├─ Learn (Apprendre, statique)
            ├─ Settings (Paramètres, onglets variables selon rôle)
            └─ MemberOnboarding (visite guidée, 1re connexion non-admin)
```

Aucune URL profonde n'existe : `view` est un simple `useState<View>("famille")` (`family-dashboard.tsx:97`), sans synchronisation URL ni `localStorage`. Un rafraîchissement navigateur ramène toujours à l'Accueil. Le menu desktop (`<aside className="sidebar">`) et la barre mobile (`<nav className="mobile-nav">`) sont deux blocs JSX **toujours montés simultanément**, la bascule étant purement CSS (`family.css:18,20`) — pas un split conditionnel en JS.

Le rendu client s'appuie systématiquement sur la fusion de 3 sources par écran métier : historique figé (`lib/gift-history.ts` → `GIFT_HISTORY`), données Supabase vivantes (`/api/gifts`), et pour certains écrans les transactions blockchain vivantes (`/api/ledger`). Ce pattern de fusion est répété indépendamment dans `family-dashboard.tsx`, `gift-portfolio.tsx`, `transactions.tsx`, `administration.tsx`, `amatxi-report.tsx`, `indicators.tsx`.

---

## 5. Cartographie des écrans

### Table A — Écrans

| Écran | Fichier | Rôle | API | Tables | Mobile | Dette | Risque |
|---|---|---|---|---|---|---|---|
| Connexion | `auth-shell.tsx` (`AuthShell`, `LoginScreen`) | tous (pré-auth) | `GET /api/supabase/status`, `GET /api/auth/me` + Supabase Auth SDK | `family_members` (indirect) | breakpoints propres 767/768-1199/1200px (≠ 780px du reste de l'app) | version fallback `"1.6.1"` divergente de `package.json` `1.7.1` | faible |
| Accueil / Vue famille | `family-dashboard.tsx` (`Dashboard`) | tous, écran identique pour tous rôles | `GET /api/transfer-requests`, `GET /api/gifts`, `GET /api/ledger?priceOnly=1` | `gift_records`, `transfer_requests` | sidebar↔mobile-nav en CSS pur | date du jour codée en dur (« JEUDI 16 JUILLET 2026 »), `missing`/progress-bar fictifs, anniversaire Aurore divergent | **élevé** (données trompeuses visibles par tous) |
| Portefeuilles | `gift-portfolio.tsx` (`GiftPortfolio`, `MemberPortfolioMobile`, `TransferWorkbench`, `GiftEditor`) | admin (complet) / membre (verrouillé sur soi) | `GET/DELETE/PATCH /api/gifts`, `GET/priceOnly /api/ledger`, `POST /api/transfer-requests`, `POST /api/ledger-transfers`, `POST /api/blockchain/verify` | `gift_records`, `transfer_requests`, `wallets` | `MemberPortfolioMobile` = composant séparé, CSS-masqué desktop | onglets PEA/CTO désactivés (« Bientôt », volontaire) ; roster membres dupliqué | moyen |
| Transactions / Mouvements | `transactions.tsx` (`TransactionsView`, `InvestmentModal`, `MemberMovementsMobile`, `AdminMovementsMobile`) | admin (table complète) / membre (verrouillé) | `GET /api/gifts`, `GET/priceOnly /api/ledger`, `DELETE /api/gifts` | `gift_records` | 2 générations de cartes mobiles coexistent (CSS `data-label` legacy + composants JSX récents) | **`InvestmentModal` n'écrit jamais en base** (voir §20) ; fusion 3-sources par clé fragile `member\|kind\|year` | **élevé** |
| Indicateurs | `indicators.tsx` (`Indicators`, `PriceChart`, `ValueCell`) | tous, non admin-gated | aucun appel direct (données reçues du parent) | `gift_records` (indirect) | scroll horizontal sur graphique/tableau < 780px | expose l'historique de **tous** les enfants à **tous** les rôles via `GIFT_HISTORY` bundlé | moyen (confidentialité) |
| Administration (5 sous-onglets) | `administration.tsx` | admin uniquement | `GET/POST/PATCH/DELETE /api/gifts`, `/api/ledger`, `/api/admin/users(+actions)`, `/api/admin/accounts`, `/api/admin/holdings`, `/api/admin/market`, `/api/supabase/status` | `gift_records`, `family_members`, `financial_accounts`, `holdings`, `investment_access_grants` | breakpoints 720/900/1180px (≠ 780px) | **doublon** avec `AdminUsers` (voir §22) ; édition de compte financier sans UI (route existe, jamais appelée) | moyen |
| Vue Amatxi | `amatxi-report.tsx` (`AmatxiReport`) | **admin uniquement** (malgré le nom) | aucun direct (props du parent) | `gift_records` (indirect) | breakpoints 850/580px | champ commentaire (`comment`) jamais persisté ; rôle `viewer` réel ne mène jamais à cet écran | moyen |
| Apprendre | `family-dashboard.tsx` (`Learn`) | tous | aucun | aucune | — | contenu 100% statique, boutons « Commencer la leçon » sans `onClick` | faible |
| Paramètres | `settings.tsx` (7 onglets, dont `GiftSettings`, `DataSettings`) | tabs variables selon rôle | `GET/PATCH /api/investment-access`, `GET /api/admin/users` (lecture wallets) + Supabase Auth (email/mdp) | `family_members`, `investment_access_grants` | breakpoint 780px, tab bar en scroll horizontal | **`GiftSettings` et `DataSettings` sont des placeholders inertes** (voir §20) ; fichiers non versionnés (§2) | moyen |
| Onboarding | `member-onboarding.tsx` (`MemberOnboarding`) | non-admin uniquement | `PATCH /api/investment-access` (étape finale, réelle) | `family_members`, `investment_access_grants` | breakpoint 560px | persistance uniquement `localStorage`, pas de flag serveur « onboarding terminé » | faible |
| Installation PWA | `install-app.tsx` (`InstallAppCard`, intégré dans Paramètres) | tous | aucun | aucune | Android natif + instructions iOS manuelles | — | faible |

### Composants transverses
- `use-dialog-a11y.ts` — focus trap, `inert`, Échap, restauration du focus ; utilisé par `LoginScreen`, `mobile-menu-drawer`, `InvestmentModal`, `TransferWorkbench`, `GiftEditor`, `MemberOnboarding`. **Non utilisé** par les popups « quick switch » et « profil » du topbar (`family-dashboard.tsx:312-318,338-344`), pourtant équivalentes à des modales légères — incohérence mineure.
- `InvestmentAccessSettings` (`investment-access-settings.tsx`) — réutilisé 3 fois (Paramètres, Onboarding, potentiellement Administration→Members).
- `AdminUsers` (`admin-users.tsx`) — réutilisé dans Administration (« Membres & accès » y est en fait un composant *différent*, voir §22) et dans Paramètres → « Utilisateurs & accès ».

---

## 6. Cartographie des composants

### Table D — Composants

| Composant | Utilisé par | À conserver | À refactorer | À remplacer |
|---|---|---|---|---|
| `GiftEditor` (gift-portfolio.tsx) | Portefeuilles, Administration→Cadeaux BTC | ✅ | unifier avec InvestmentModal | — |
| `InvestmentModal` (transactions.tsx) | Accueil (×2), Transactions | — | — | ✅ rebrancher sur `/api/gifts` ou fusionner avec GiftEditor |
| `TransferWorkbench` (gift-portfolio.tsx) | Portefeuilles admin | ✅ | tolérance d'écart à harmoniser avec `blockchain/verify` | — |
| `use-dialog-a11y.ts` | 6 modales | ✅ | étendre aux 2 popups non couverts | — |
| `Members` (administration.tsx, inline) | Administration→Membres & accès | — | fusionner | ✅ avec `AdminUsers` |
| `AdminUsers` (admin-users.tsx) | Paramètres→Utilisateurs, Administration | — | absorber les capacités de `Members` (rôle `child`, détails auth) | — |
| `GiftSettings` (settings.tsx, inline) | Paramètres→Règles des cadeaux | — | — | ✅ implémenter ou retirer (aucun handler) |
| `DataSettings` (settings.tsx, inline) | Paramètres→Données | — | — | ✅ implémenter export réel ou retirer le bouton actif-mais-inerte |
| `Learn` (family-dashboard.tsx, inline) | Accueil→Apprendre | — | ajouter un vrai suivi de progression | — |
| Types `GiftRecord`/`FamilyGiftRecord` (×4 définitions locales) | back-office.tsx, gift-portfolio.tsx, amatxi-report.tsx, family-dashboard.tsx | — | ✅ unifier dans `lib/types.ts` | — |
| `BackOffice`, `LedgerLive` | personne (composants) | — | — | ✅ supprimer (après extraction du type `TransferRequest`) |
| `ChatGPTAuth` helpers | personne | — | — | ✅ supprimer |
| Rosters membres (×5-6 fichiers) | tous les écrans métier | — | ✅ centraliser (source unique déjà disponible : table `family_members` ou `lib/gift-history.ts`) | — |
| Badges de statut (11 implémentations indépendantes) | quasi tous les écrans | — | ✅ extraire en `<StatusBadge>` partagé | — |

---

## 7. Cartographie des API

### Table B — API

| Route | Méthode | Rôle | Tables | Service externe | Risque |
|---|---|---|---|---|---|
| `/api/auth/me` | GET | membre | `family_members`, `wallets` | Supabase Auth | — |
| `/api/gifts` | GET | membre (filtré si non-admin) | `gift_records` | — | redaction de champs privés par liste codée en dur ; ne filtre pas `is_deleted` côté serveur |
| `/api/gifts` | POST | admin | `family_members`, `gift_records` | Blockstream | pas de borne haute sur les montants |
| `/api/gifts` | PATCH | admin | `family_members`, `gift_records` | Blockstream | verrouillage sur `custody` seul, pas sur TxID vérifié |
| `/api/gifts` | DELETE | admin | `gift_records` | — | message d'erreur cite un nom de fichier de migration interne |
| `/api/ledger` | GET | admin (ou public si `?priceOnly=1`) | `wallets` | Blockstream, CoinGecko/Kraken | pagination jusqu'à 20 pages/wallet sans backoff |
| `/api/ledger-transfers` | POST | admin | `gift_records` | Blockstream | pas de verrou anti-concurrence sur un même TxID |
| `/api/blockchain/verify` | POST | admin | — | Blockstream | tolérance stricte (exact sats) par défaut, différente de la tolérance flottante utilisée ailleurs |
| `/api/transfer-requests` | GET | membre (filtré) / public si Supabase non configuré | `transfer_requests` | — | — |
| `/api/transfer-requests` | **POST** | membre **si configuré**, **sinon aucune auth** | `transfer_requests` (si configuré) | **Resend — envoyé même sans auth ni persistance** | **confirmé exploitable en cas de mauvaise configuration partielle des variables d'env** |
| `/api/transfer-requests` | PATCH | admin | `transfer_requests` | — | — |
| `/api/investment-access` | GET/PATCH | membre (self-scope) | `family_members`, `investment_access_grants` | — | **non consulté par aucune autre route de lecture** (voir §14/§23) |
| `/api/admin/users` | GET/POST/PATCH/DELETE | admin | `family_members`, `wallets`, `investment_access_grants` | Supabase Auth Admin | rôle `child` non assignable via cette route |
| `/api/admin/users/actions` | POST | admin | `family_members` | Supabase Auth Admin | — |
| `/api/admin/accounts` | GET/POST/PATCH/DELETE | admin | `financial_accounts`, `wallets` (import) | — | PATCH (édition) existe côté serveur mais aucune UI ne l'appelle |
| `/api/admin/holdings` | POST/PATCH/DELETE | admin | `holdings` | — | pas de vérification applicative que `accountId` existe |
| `/api/admin/market` | GET | admin | — | Alpha Vantage | pas de cache/throttle applicatif du quota gratuit (25 req/j) |
| `/api/supabase/status` | GET | **aucun (public)** | `family_members` (ping) | — | expose l'URL du projet + `error.message` brut à un appelant non authentifié |

---

## 8. Cartographie Supabase

7 tables effectives, reconstruites à partir des 12 migrations (par ordre chronologique) :

| Table | Objectif | Colonnes clés | RLS | Écart code/schéma détecté |
|---|---|---|---|---|
| `family_members` | identité, rôle, statut, anniversaire | `role CHECK(admin/adult/child/viewer)`, `access_status` (texte libre, non contraint), `investment_access_scope CHECK(family/selected)` | SELECT only | rôle `child` autorisé en base mais **jamais assignable via l'API admin** (`admin/users/route.ts` limite à admin/adult/viewer) |
| `wallets` | adresse Bitcoin publique par membre | `custody CHECK(Ledger/Binance commun/Autre)`, `UNIQUE(member_id)` | SELECT only (via `can_view_member_investments`) | seule la valeur `'Ledger'` est jamais écrite — `'Binance commun'`/`'Autre'` sont des valeurs d'enum mortes |
| `gift_records` | cycle de vie complet d'un cadeau BTC | `custody CHECK(Ledger/Binance commun/À rapprocher)`, `is_deleted`, `ledger_value_forced`, `ledger_force_reason`, `blockchain_status` (texte libre non contraint) | SELECT only | `occasion` et `blockchain_status` n'ont **aucune contrainte CHECK** en base, seulement une validation applicative ; deux index quasi-redondants (`gift_records_member_date_idx` et sa variante partielle `WHERE is_deleted=false`) |
| `transfer_requests` | demande enfant → admin | `id text` (pas uuid — accepté du client), `status CHECK(Nouvelle/En traitement/Transférée)` | SELECT only, **jamais mise à jour** par la migration `investment_access` (contrairement à wallets/gift_records) | `id` client-fourni sans validation de format, combiné à `resolution=ignore-duplicates` → une requête légitime avec un id en collision est silencieusement ignorée |
| `investment_access_grants` | partage granulaire « qui voit mes investissements » | `PK(owner_member_id, viewer_member_id)`, `CHECK(owner≠viewer)` | **seule table avec policies d'écriture** | RLS prête mais jamais exploitée applicativement (voir §14) |
| `financial_accounts` | comptes multi-actifs (PEA/CTO/banque/crypto) | `account_type CHECK(bitcoin/crypto_exchange/bank/pea/securities/savings/other)` | SELECT only (via `can_view_member_investments`) | route d'édition (`PATCH`) existe côté serveur, inatteignable côté UI |
| `holdings` | positions (actions/ETF/fonds…) | `asset_type CHECK(stock/etf/fund/bond/crypto/cash/other)` | SELECT only | aucune colonne pour un plan d'investissement mensuel ou une « suggestion » — table prête pour stocker une position ETF réelle, pas pour une recommandation |

**Migrations** : 12 fichiers, additifs uniquement (aucune n'est réellement obsolète), sauf `is_cap_family_admin()` dont le corps est totalement réécrit une fois (la version « hardcode l'email de Florent » de `20260716_cap_family.sql` est remplacée par une version générique dans `20260718_investment_access.sql` — seule la seconde est active).

**⚠ Écart README** : `supabase/SETUP.md` ne documente que 6 des 12 migrations à appliquer manuellement — `20260718_investment_access.sql`, `20260719_birth_year.sql` et `20260719_wallets_member_unique.sql` en sont absents. Une instance Supabase neuve montée strictement selon ce guide n'aurait pas la colonne `investment_access_scope`, pas la table `investment_access_grants`, pas `birthday_year`, et pas la contrainte unique sur `wallets.member_id` (dont dépend l'upsert `on_conflict=member_id` de `saveWallet()`).

**Divergence de données en direct** : `supabase/checks/2026-07-19_gift_history_vs_supabase.sql` attend `0.00102021` BTC pour le cadeau de Noël 2024 d'Uhaina, mais la migration de seed (`20260717_seed_historical_binance_gifts.sql:28`) a inséré `0.00053083` BTC pour cette même ligne — écart non résolu, détecté par l'outil de contrôle de l'application elle-même.

**Accès direct navigateur** : confirmé absent — `grep` sur `supabaseBrowser.from(` dans tout le repo ne retourne aucun résultat ; le client navigateur ne sert qu'à l'authentification.

---

## 9. Flux d'authentification

- **Méthodes** : email/mot de passe, lien magique (OTP), Google OAuth — les trois confirmées dans `auth-shell.tsx`.
- **Blocage de l'inscription libre** : hook Postgres `hook_allow_cap_family_member()` (`20260716_cap_family.sql:110-136`), correctement scopé (`revoke ... from authenticated, anon, public`). **Mais son activation est une étape manuelle dans la console Supabase** (Authentication → Hooks), non vérifiable ni testée par le code — rien ne garantit qu'elle reste branchée après une réinitialisation de projet.
- **Autorisation applicative** : `requireFamilyMember`/`requireAdmin` (`lib/auth-server.ts:23-50`) **revérifient le Bearer token auprès de Supabase Auth ET relisent le rôle en base à chaque appel**, sans cache ni raccourci — confirmé ligne par ligne, aucune divergence avec le README.
- **Aperçu admin « vue membre »** : implémenté uniquement côté client (`family-dashboard.tsx:111,118`, objet `effectiveViewer` recomposé). Le vrai jeton Supabase de l'admin continue d'être envoyé à chaque appel API (`authenticatedFetch`, `family-dashboard.tsx:85-93`) — **aucune notion de « aperçu » n'existe côté serveur**. Le caractère lecture-seule n'est garanti que par les boutons masqués/désactivés en UI, jamais par une vérification API. ⚠ Écart README : le README présente cet aperçu comme sûr par construction (« sans changer de session réelle ») ; c'est vrai littéralement mais insuffisant — un `fetch` direct pendant l'aperçu agirait avec les pleins droits admin.
- **`setupMode`** (Supabase non configuré) : active un faux admin local. Reste sans danger réel en pratique car chaque route de données se gate elle-même sur `isSupabaseConfigured()` — **sauf** `POST /api/transfer-requests` (voir §23).
- **`?preview=dashboard`** : gate `process.env.NODE_ENV === "development"`, constante figée au build par Next.js — élidée du bundle de production, donc robuste (pas un simple check runtime contournable).
- **Rôle réel de RLS** : toutes les écritures/lectures serveur utilisent la clé service-role (`lib/supabase-rest.ts:39`), qui contourne RLS intégralement. RLS n'existe aujourd'hui **que pour un accès hypothétique futur via la clé anon** — et même dans ce cas, **aucune policy INSERT/UPDATE/DELETE n'existe** sur `family_members`/`wallets`/`gift_records`/`transfer_requests` (seul SELECT est couvert), donc RLS bloquerait totalement les écritures dans ce scénario, pas seulement les lecture non autorisées — nuance absente du README.
- **Rôle `viewer` (Amatxi)** : recherche exhaustive de `role === "viewer"` dans `family-dashboard.tsx`, `gift-portfolio.tsx`, `transactions.tsx`, `app/api/transfer-requests/route.ts` → **zéro occurrence**. ⚠ Écart README : le README présente `viewer` comme menant à un rapport lecture-seule dédié pensé pour la grand-mère ; en réalité, l'écran « Vue Amatxi » est gated `role === "admin"` (`family-dashboard.tsx:379`) — un compte réellement `viewer` obtiendrait l'interface membre ordinaire (Accueil/Portefeuille/Mouvements), sans restriction de lecture-seule particulière au niveau API.

---

## 10. Matrice des rôles

| Fonctionnalité | Admin | Adult | Child | Viewer | Preview admin |
|---|---|---|---|---|---|
| voir le tableau de bord | ✅ | ✅ | ✅ | ✅ | ✅ (données admin réelles, UI relabellisée) |
| voir ses cadeaux | ✅ (tout) | ✅ (filtré API) | ✅ (filtré API) | ✅ (filtré API) | ✅ |
| voir les cadeaux des autres | ✅ | ❌ API-bloqué, ⚠ mais historique `GIFT_HISTORY` visible par tous via bundle JS, non authentifié | idem | idem | ✅ |
| créer un cadeau | ✅ `requireAdmin` | ❌ 403 | ❌ | ❌ | UI masquée uniquement — le jeton réel autoriserait |
| modifier un cadeau | ✅ | ❌ | ❌ | ❌ | UI masquée uniquement |
| supprimer un cadeau | ✅ (sauf Ledger verrouillé) | ❌ | ❌ | ❌ | UI masquée uniquement |
| demander un transfert | ✅ (pour soi) | ✅ | ✅ | ⚠ **techniquement permis**, aucun contrôle de rôle dédié | UI masquée uniquement |
| valider un transfert | ✅ `requireAdmin` | ❌ | ❌ | ❌ | UI masquée uniquement |
| voir les Ledger | ✅ `requireAdmin` | ❌ | ❌ | ❌ | UI masquée uniquement |
| gérer les membres | ✅ | ❌ | ❌ | ❌ | ❌ (server-enforced) |
| gérer les comptes financiers | ✅ | ❌ | ❌ | ❌ | ❌ |
| voir les PEA / CTO | ✅ (Administration) | ❌ (aucune route non-admin) | ❌ | ❌ | ❌ |
| gérer les positions | ✅ | ❌ | ❌ | ❌ | ❌ |
| modifier les paramètres | ✅ | ✅ (partiel — wallet en lecture seule même pour soi) | idem adult | idem adult | ✅ (UI en lecture seule) |
| gérer le partage familial | ✅ (soi + override admin sur les autres) | ✅ (soi uniquement) | ✅ (soi) | ✅ (soi) | ✅ (comme admin) |

`GET /api/ledger?priceOnly=1` et `GET /api/supabase/status` sont **entièrement publics** (aucune authentification), absents du cadrage par rôle du README.

---

## 11. Flux métier Bitcoin (12 étapes)

| # | Étape | Composant UI | API | Table | Risque identifié |
|---|---|---|---|---|---|
| 1 | Cadeau attendu | matrice `GiftSynthesis` (calcul client) | — | — | purement dérivé, pas de risque de donnée |
| 2 | Cadeau saisi | `GiftEditor` | POST/PATCH `/api/gifts` | `gift_records` | validation montant sans borne haute |
| 3 | Achat Binance | `GiftEditor` | idem | `gift_records` | — |
| 4 | Attribution membre | sélecteur `GiftEditor` | POST `/api/gifts` | `gift_records`/`wallets` | — |
| 5 | Garde Binance | toggle custody | PATCH `/api/gifts` | `gift_records` | — |
| 6 | Demande de transfert | bouton membre | POST `/api/transfer-requests` | `transfer_requests` | **non authentifié si Supabase mal configuré** (§23) |
| 7 | Transfert Ledger | `TransferWorkbench` | POST `/api/ledger-transfers` | `gift_records` | pas de verrou anti-double-appel concurrent sur le même TxID |
| 8 | Vérification blockchain | bouton « Vérifier » `GiftEditor` | POST `/api/blockchain/verify` | — | tolérance exacte (sats) — cohérent en isolation, mais différente de la tolérance flottante utilisée dans `validateLedgerAllocation` |
| 9 | Rapprochement TxID | `TransferWorkbench` / association manuelle | POST `/api/ledger-transfers` | `gift_records` | — |
| 10 | Verrouillage de la ligne | badge « verrouillé » `GiftSynthesis` | — (lecture de `custody`) | — | **se déclenche sur `custody==="Ledger"` seul, sans exiger de TxID vérifié** — contredit le texte UI (« verrouillé après confirmation blockchain ») |
| 11 | Valeur actuelle | calcul client (`bitcoinEur × btc`) | GET `/api/ledger?priceOnly=1` | — | — |
| 12 | Performance | calculs répétés indépendamment dans 4 écrans | — | — | logique de calcul dupliquée, pas partagée |

**Allocation au prorata** (`app/api/ledger-transfers/route.ts:107-122`) : division entière en satoshis, `floor(totalAllocatedSats × giftSats ÷ totalPurchasedSats)` pour chaque cadeau sauf le dernier qui absorbe le reliquat d'arrondi — formule saine, pas de perte de précision flottante.

**Écarts de frais** : deux règles de validation incohérentes coexistent — `POST /api/gifts` exige un `forceReason` non vide (sans longueur minimale), `POST /api/ledger-transfers` exige **5 caractères minimum**. À harmoniser.

**Suppression douce** : `is_deleted` correctement posé sur PATCH ou tombstone-INSERT ; **irréversible** dans le code actuel (aucun endpoint ne repasse `is_deleted` à `false`) ; **filtrage incohérent** — `GET /api/gifts` ne filtre pas `is_deleted` côté serveur (fait porter la responsabilité aux composants clients, dont certains le font et d'autres non), alors que `POST /api/ledger-transfers` rejette bien ces lignes côté serveur.

---

## 12. Flux Ledger

Le rapprochement Ledger (`TransferWorkbench` → `POST /api/ledger-transfers`) est la logique la plus sophistiquée de l'app : lecture du solde reçu sur une adresse via Blockstream, allocation au prorata entre plusieurs cadeaux du même enfant, exigence de justification si écart. Point de vigilance confirmé : le **verrouillage** d'une ligne (non modifiable/non supprimable) dépend uniquement de la valeur stockée `custody`, pas d'un état de vérification — un admin peut, via `GiftEditor`, positionner `custody="Ledger"` manuellement sans jamais appeler `/api/blockchain/verify` ni renseigner de TxID, verrouillant ainsi une ligne sans preuve on-chain. Les adresses Ledger elles-mêmes (`wallets.public_address`) sont par nature publiques (adresses Bitcoin) : aucun risque de sécurité intrinsèque à leur stockage, le vrai périmètre à protéger est le graphe *nom d'enfant ↔ adresse ↔ montants*, correctement restreint aux admins côté API (`GET /api/ledger` requireAdmin).

## 13. Flux Binance

La « garde Binance » est un état (`custody="Binance commun"`) plutôt qu'une intégration API réelle — aucune connexion à un compte Binance n'existe dans le code ; toutes les données Binance sont saisies manuellement par l'admin via `GiftEditor`. Les demandes de transfert enfant → admin (`transfer_requests`) sont le seul mécanisme actif reliant la garde Binance à une action utilisateur, avec envoi d'email (Resend) optionnel et silencieux si les clés sont absentes — confirmé non bloquant.

## 14. Flux PEA / compte-titres

Le back-office est **complet et fonctionnel côté admin** : CRUD comptes (sauf édition, voir ci-dessous) et positions, recherche Alpha Vantage, actualisation manuelle de cours, import automatique des wallets Ledger existants dans `financial_accounts`. **Nuance vs README** : la route `PATCH /api/admin/accounts` (édition d'un compte) existe et fonctionne côté serveur, mais **aucune UI ne l'appelle** — impossible de renommer/désactiver un compte existant depuis l'écran Administration aujourd'hui.

**Lacune principale pour exposer ces données aux membres** : il n'existe **aucune route de lecture non-admin** pour `financial_accounts`/`holdings` (contrairement à `/api/gifts` qui a déjà une branche « filtré si non-admin »). Le mécanisme de confidentialité `investment_access_scope`/`investment_access_grants` — déjà câblé en base avec RLS dédiée pour exactement ces tables — **n'est consulté par aucune route API existante**, y compris `/api/gifts` lui-même (qui ne distingue qu'admin-vs-soi, ignorant le choix « partagé en famille » / « partagé avec certains »). Exposer le PEA/CTO aux membres nécessite donc soit (a) une nouvelle route utilisant la clé anon + JWT pour laisser RLS s'appliquer (jamais fait dans ce code à ce jour), soit (b) réimplémenter la logique `can_view_member_investments` en JS — dans les deux cas, du travail neuf, pas juste « brancher une UI sur une logique existante ». Aucune fonctionnalité de versement mensuel, de suggestion ETF ou de DCA n'existe nulle part dans le code (recherche exhaustive infructueuse) — vision cible entièrement à construire.

---

## 15. Navigation et routage

- Type `View` (`family-dashboard.tsx:17`) : union de 8 valeurs (`famille`, `portefeuilles`, `transactions`, `indicateurs`, `backoffice`, `amatxi`, `apprendre`, `parametres`).
- État détenu exclusivement par `FamilyDashboard` (`useState<View>("famille")`), aucune synchronisation URL.
- Deux mécanismes de mutation coexistent : `navigate()` (avec garde d'effacement de filtre) et des appels directs à `setView()` dispersés — incohérence mineure à nettoyer avant une migration vers de vraies routes.
- Raccourcis contextuels Portefeuille→Transactions (8 points d'entrée recensés, tous via un objet `TransactionShortcut` en mémoire, jamais en query string) et Transactions/Accueil→Portefeuille.
- Modales : pattern d'accessibilité partagé (`use-dialog-a11y.ts`) sauf 2 popups légers (quick-switch, menu profil) qui n'ont ni piège de focus ni fermeture Échap.
- **Changements nécessaires pour de vraies routes Next.js** (liste, non implémenté) : convertir `View` en segments de route ; remplacer `setView`/`navigate` par `useRouter`/`<Link>` ; faire de `TransactionShortcut` des query params partageables ; déplacer l'état `previewMember` vers un cookie/paramètre transverse (pas une page) ; définir une stratégie de survie des modales entre transitions de route ; déplacer les gates de rôle (`backoffice`, `amatxi`) vers un middleware/layout plutôt que du JSX conditionnel.

---

## 16. Responsive mobile

**⚠ Écart README majeur** : le README affirme que toute évolution mobile doit rester dans `@media (max-width: 780px)`. Vérification sur les 14 fichiers CSS : **6 dévient** de cette convention — `administration.css` (720px), `admin-users.css`/`investment-access-settings.css` (700px), `amatxi-report.css` (850px/580px), `auth.css` (767/768-1199/1200px), `member-onboarding.css` (560px), et `gift-portfolio.css` qui mélange **680px (legacy)** et **780px (nouveau bloc `.member-portfolio-mobile`)** *dans le même fichier*. La règle 780px décrit une intention pour les nouveaux développements, pas l'état réel du CSS existant.

Aucun risque de débordement horizontal non maîtrisé détecté (tous les tableaux larges sont soit encapsulés `overflow-x:auto`, soit dotés d'un point de rupture explicite) — à confirmer visuellement, l'analyse étant statique. La barre de navigation mobile (4 items : Accueil/Portefeuille/Mouvements/Apprendre) est un **sous-ensemble volontaire** de la sidebar desktop (8 items), pas un miroir — Indicateurs/Paramètres/Administration/Amatxi ne sont accessibles sur mobile que via le tiroir de menu. `env(safe-area-inset-*)` utilisé seulement dans `family.css`/`auth.css`, absent de toutes les modales. `100vh` legacy encore utilisé sur `.app-shell` (`family.css:3`) alors que l'écran de connexion, plus récent, utilise correctement `100dvh` — incohérence exploitable en cas de bug de chrome navigateur mobile.

**Documentation UX déjà partiellement obsolète** : `docs/mobile-ux-redesign/accueil-mobile.md` décrit encore une fonctionnalité « Mission du mois » **supprimée depuis** (commit `6612794`, postérieur à la rédaction du doc) — les classes CSS correspondantes (`.mission-panel` et ~15 sélecteurs liés) restent en code mort dans `family.css`. `mouvements-mobile.md` décrit le pattern de cartes CSS `data-label` comme la solution mobile actuelle des Mouvements ; en réalité un second système de cartes JSX plus récent (`.mmv-mobile`/`.amv-mobile`) l'a déjà remplacé pour ce même écran, dans le même commit que la rédaction du document. Ces deux docs doivent être relus avant d'être réutilisés comme base de refonte.

## 17. PWA

`manifest.webmanifest` complet (icônes 192/512 + variante maskable, `display:standalone`, couleurs cohérentes). Service worker (`public/sw.js`) : stratégie **network-first pour les navigations HTML** (fallback cache puis fallback `/`), **cache-first pour les assets statiques hashés** (`/_next/static/*`), routes `/api/*` et services externes explicitement exclus du cache — bon choix pour ne jamais servir de données financières périmées. `skipWaiting()`/`clients.claim()` présents → cycle de mise à jour robuste. Point d'attention réel : `CACHE_VERSION = "labajo-co-v1"` est une **chaîne littérale figée**, non liée au hash de build ni à `NEXT_PUBLIC_APP_VERSION` — un changement de fichier non hashé (favicon, manifest) sans bump manuel de cette constante pourrait rester servi en cache-first jusqu'au prochain cycle d'activation. Recommandation (non implémentée) : lier `CACHE_VERSION` à la version applicative déjà calculée dans `next.config.ts`.

---

## 18. Design system actuel

Deux couches de tokens CSS coexistent dans `family.css` (un jeu de variables historique + un second jeu « LaBaJo & Co 2026 » ajouté par-dessus), plus un troisième jeu isolé propre à `auth.css`. L'adoption des tokens est partielle : `var(--teal)` est utilisé 121 fois, mais `gift-portfolio.css` (et par ricochet `back-office.css`/`ledger-live.css`) réutilise une teinte proche mais distincte (`#128c7e`) codée en dur 36 fois — dérive de couleur non intentionnelle probable. Les tokens `--radius`/`--shadow-sm`/`--shadow-lg` existent mais ne sont référencés que 8 fois au total malgré des dizaines de déclarations équivalentes en dur.

**Duplication la plus nette** : les badges de statut (Ledger/Binance/en attente/confirmé) sont réimplémentés **indépendamment au moins 11 fois** à travers `transactions.css`, `administration.css`, `admin-users.css`, `settings.css`, `amatxi-report.css`, `ledger-live.css`, avec des teintes légèrement différentes à chaque fois — le candidat n°1 à l'extraction en composant partagé. Boutons primaires (~5 déclarations quasi-identiques), cartes/stat-cards (~6 déclarations), et chrome de modale (6 implémentations indépendantes pour un seul pattern visuel) suivent le même schéma. Le tableau « matrice » de `GiftSynthesis` (Administration) et le tableau d'`Indicateurs` n'ont **jamais reçu** le traitement « cartes sur mobile » appliqué aux Transactions — ils imposent un défilement horizontal pur sur téléphone, écart UX réel non documenté ailleurs. Trois systèmes d'icônes coexistent sans cohérence (emoji 🎂🎄, glyphes Unicode ⌂◫⇄, SVG inline — ce dernier utilisé uniquement dans l'écran de connexion, le plus récent).

**Composants UI partagés à créer plus tard** (liste, non implémentée) : `<StatusBadge tone="…">`, `<Button variant="…">`, `<Card>`/`<StatCard>`, `<Modal>` (chrome commun), `<ResponsiveTable>` (généraliser le pattern cartes-sur-mobile à `GiftSynthesis`/`Indicateurs`), tokens de couleur/rayon/ombre réellement appliqués (pas seulement déclarés), système d'icônes unique.

---

## 19. Données codées en dur

### Table C — Données codées en dur

| Donnée | Fichier(s) | Impact | Source cible | Priorité |
|---|---|---|---|---|
| Liste des 5 prénoms + couleurs | `family-dashboard.tsx`, `administration.tsx`, `indicators.tsx`, `transactions.tsx`, `back-office.tsx` (5-6 copies indépendantes) | duplication, risque de dérive | `lib/gift-history.ts` ou table `family_members` | Haute |
| **Anniversaire d'Aurore** | `family-dashboard.tsx:40` (17 août) vs 4 autres fichiers (27 août) | **bug utilisateur confirmé** — countdown Accueil faux | source unique | **Critique** |
| Montant standard « 55 € » | 9+ fichiers | coûteux à faire évoluer si la règle change | constante `STANDARD_GIFT_AMOUNT_EUR` partagée | Moyenne |
| Compteur « achats à compléter » (`missing`) | `family-dashboard.tsx:37-41,191` | présenté comme réel, jamais recalculé (deps `[]` vides) | calcul dérivé de `familyRecords` réels | **Haute** |
| Barre de progression « cadeaux documentés » | `family-dashboard.tsx:485,490` | formule arbitraire (`100 - missing×12`, plancher 18) sur un chiffre déjà figé, `aria-valuenow` trompeur | calcul réel saisis/attendus | **Haute** |
| Date du jour affichée sur l'Accueil | `family-dashboard.tsx:328` | texte littéral « JEUDI 16 JUILLET 2026 », jamais recalculé | `Intl.DateTimeFormat` dynamique | **Haute** |
| Journal d'activité récente | `family-dashboard.tsx:101-103,216,500` | perdu au rechargement, aucune API dédiée | table Supabase `activity_log` ou dérivation de `gift_records`/`transfer_requests` | Moyenne |
| Bouton « Exporter en Excel » | `settings.tsx:221` | actif visuellement mais sans `onClick` — trompeur | implémenter ou désactiver comme le bouton voisin | Moyenne |
| Types `GiftRecord`/`FamilyGiftRecord` (×4) | `back-office.tsx`, `gift-portfolio.tsx`, `amatxi-report.tsx`, `family-dashboard.tsx` | dérive de schéma silencieuse possible | type partagé (`lib/types.ts`) | Moyenne |
| Historique complet de tous les enfants | `lib/gift-history.ts` (`GIFT_HISTORY`) | expédié dans le bundle JS public, visible même sans authentification, contourne le filtrage par membre de l'API live | migrer vers données Supabase filtrées par API, retirer du bundle client | **Haute (confidentialité)** |
| Cours BTC fictif | — | **hypothèse infirmée** — l'app gère proprement le cas `null` | — | — |
| Valeurs PEA/CTO simulées | — | **hypothèse infirmée** — toujours « Bientôt »/0%, jamais de faux montant | — | — |

---

## 20. États non persistés

- **`InvestmentModal` → `saveInvestment()`** (`family-dashboard.tsx:214-223`) : confirmé au caractère près — appelle uniquement `setTransactions`/`setActivity` (state local), **zéro appel réseau**, tout en affichant le toast « Opération enregistrée et visible dans Transactions » — message identique à un vrai succès. 4 points d'entrée mènent à cette modale (topbar, hero Accueil, panneau activité Accueil, bouton Transactions) — le README n'en comptait que 3 et les situait tous sur l'Accueil ; en réalité ils sont répartis sur 2 écrans, et seuls 2 des 4 respectent le mode aperçu-admin lecture-seule (les 2 boutons de l'Accueil ne le respectent pas).
- **Journal d'activité récente** — même composant, jamais synchronisé serveur.
- **`GiftSettings` (Paramètres→Règles des cadeaux)** — formulaire à 3 champs (montant, occasion, date), **aucun `onChange`, aucun bouton de sauvegarde** — décoratif à 100%.
- **`comment` dans `AmatxiReport`** (`amatxi-report.tsx:76`) — champ de commentaire libre capturé en state local, jamais envoyé à une API, perdu à la fermeture de la modale.
- **Onboarding « terminé »** — persisté uniquement en `localStorage` (`cap-family-onboarding-v1:${viewer.id}`), pas de flag serveur ; changer de navigateur/appareil relance la visite guidée.

---

## 21. Code mort

- **`app/back-office.tsx`** — le composant `BackOffice` n'est effectivement jamais rendu, **mais** son type exporté `TransferRequest` est activement importé par `family-dashboard.tsx`, `administration.tsx` et `gift-portfolio.tsx`. **Suppression brute impossible sans casser la compilation** — extraire le type d'abord.
- **`app/ledger-live.tsx`** — orphelin complet, confirmé par recherche exhaustive d'imports. Suppression sûre.
- **`app/chatgpt-auth.ts`** — orphelin complet, routes référencées inexistantes dans le repo. Suppression sûre.
- **`db/`, `drizzle/`, `drizzle.config.ts`** — schéma SQLite/D1 du template de départ, importé seulement par `examples/d1/` (lui-même mort et hors `tsconfig`). `tsconfig.json` inclut toujours `db/**/*.ts` dans son `include` — à retirer en même temps que la suppression.
- **`worker/`, `vite.config.ts`, `.openai/`, `examples/`, `build/sites-vite-plugin.ts`, `dist/`** — scaffolding Cloudflare/Vite du template, aucun script npm ne l'invoque, aucune référence dans `next.config.ts`. `dist/` contient un ancien build Vite/Wrangler complet et daté, sans rapport avec `.next/`.
- **`.wrangler/`, `.vinext/`** — artefacts de build déjà gitignorés, aucune action requise.
- **CSS mort** : ~15 sélecteurs liés à la fonctionnalité « Missions » (`family.css`), supprimée du JSX par le commit `6612794` mais jamais nettoyée du CSS.

Aucun autre fichier `.ts`/`.tsx` orphelin détecté au-delà de ces trois candidats connus (graphe d'imports tracé exhaustivement depuis `page.tsx`).

---

## 22. Dette technique

1. **Deux chemins d'écriture pour les opérations** — confirmé exact, voir §11/§20. Duplique aussi le modèle de champs (draft shapes différents) et le picker de membre (deux tableaux sources différents).
2. **Deux interfaces de gestion des membres non alignées** — `Members` (inline dans `administration.tsx`) permet d'assigner le rôle `child` et affiche les détails d'auth, mais n'a pas de champ wallet/partage ; `AdminUsers` (`admin-users.tsx`, réutilisé dans Paramètres) a le wallet et le partage mais ne propose pas `child` comme rôle assignable. Les deux appellent la même API `/api/admin/users` avec des capacités non superposables — risque de divergence croissante.
3. **Rosters de membres et types de données dupliqués** (voir §6/§19).
4. **Deux tolérances de rapprochement incohérentes** (exact-sats vs epsilon flottant) et **deux seuils de justification d'écart** (non-vide vs 5 caractères minimum).
5. **`supabase/SETUP.md` obsolète** (3 migrations manquantes) — risque opérationnel réel pour un futur environnement.
6. **Clé Supabase publique codée en dur** dans `lib/supabase-browser.ts` plutôt que via variable d'environnement `NEXT_PUBLIC_*` — bloque un environnement de staging distinct sans toucher au code (non sensible en soi, la clé est publique par nature).
7. **Deux définitions légèrement différentes de « Supabase configuré »** (`isSupabaseConfigured()` vs le check interne de `requireFamilyMember`) — fragile mais non exploitable en l'état (fail-safe en 503).
8. **Documentation UX partiellement obsolète** (voir §16) à relire avant réutilisation.
9. **Écran Paramètres non versionné** (voir §2) — dette de process, pas de code.

---

## 23. Risques de sécurité

### Table E — Sécurité

| Zone | Protection actuelle | Limite | Risque | Recommandation |
|---|---|---|---|---|
| Auth applicative | `requireFamilyMember`/`requireAdmin`, revérifiés à chaque appel | dépend d'un hook Postgres activé manuellement en dehors du code versionné | inscription libre possible si le hook est débranché sans que rien ne le détecte | ajouter un test/contrôle de configuration qui vérifie la présence du hook |
| `POST /api/transfer-requests` | `requireFamilyMember` si Supabase configuré | **aucune auth si `SUPABASE_URL`/`SUPABASE_SECRET_KEY` absents ou mal nommés**, email Resend envoyé quand même | envoi d'email non authentifié avec contenu contrôlé par l'appelant (spam/notification forgée, pas XSS — échappé) | gater l'envoi d'email sur la même condition que la persistance, ou exiger l'auth indépendamment de `isSupabaseConfigured()` |
| Aperçu admin (preview) | masquage UI des actions d'écriture | **aucune garde côté serveur** — le jeton réel admin est toujours utilisé | pas d'escalade de privilège (c'est déjà l'admin), mais la garantie « lecture seule » n'est que visuelle | documenter clairement la limite ; envisager un header `X-Preview-Mode` vérifié côté serveur si un vrai read-only est requis |
| Partage familial (`investment_access_*`) | RLS + policies dédiées en base | **jamais consultée par une route API** (service-role bypass RLS partout) | réglage utilisateur cosmétique aujourd'hui | implémenter la logique `can_view_member_investments` côté application avant d'exposer de nouvelles données (PEA/CTO) au nom de ce réglage |
| `GIFT_HISTORY` bundlé | aucune | données historiques de tous les enfants expédiées au navigateur de **tout visiteur**, authentifié ou non | fuite de données familiales à un visiteur non connecté ayant accès à l'URL de l'app | migrer l'historique en base filtrée par API plutôt qu'en constante bundlée |
| `GET /api/supabase/status` | aucune (public par conception) | expose l'URL du projet Supabase + `error.message` brut | fuite mineure d'informations internes | ne pas renvoyer `error.message` brut à un appelant non authentifié |
| RLS | policies SELECT sur les 7 tables | aucune policy INSERT/UPDATE/DELETE définie | bloquerait totalement un accès direct anon-key en écriture (protection par défaut, pas une lacune) | documenter explicitement que RLS n'est pas le rempart réel pour `/api/*` (déjà su en interne, à écrire noir sur blanc pour un futur contributeur) |
| Rôle `viewer` | aucune restriction API dédiée | traité identiquement à `adult`/`child` par l'API | l'attente produit « lecture seule pour Amatxi » n'est pas appliquée techniquement | soit restreindre `viewer` explicitement côté API, soit clarifier que ce rôle n'est pas encore utilisé en pratique |

## 24. Risques de régression

- Toute modification du roster de membres doit être répercutée dans 5-6 fichiers (voir §19) — risque de divergence silencieuse (déjà matérialisé une fois avec Aurore).
- `use-dialog-a11y.ts` non appliqué uniformément (2 popups hors pattern) — un changement de comportement clavier/focus ailleurs pourrait masquer cette incohérence.
- La fusion 3-sources par clé `member|kind|year` (Transactions) est fragile à toute collision de date/occasion dans une même année.
- Les 2 UI de gestion de membres (`Members`/`AdminUsers`) peuvent diverger encore plus si l'une évolue sans l'autre.
- Le CSS mort de « Missions » pourrait être réactivé par erreur si un futur commit touche `family.css` sans savoir que la fonctionnalité JSX correspondante a été retirée.
- `back-office.tsx` ne peut pas être supprimé sans casser 3 fichiers tant que `TransferRequest` n'est pas extrait.

## 25. Tests existants

- **1 seul fichier de test** : `tests/rendered-html.test.mjs` (`node --test`, exécuté après `next build` via `npm test`) — vérifie uniquement que la coquille LaBaJo & Co a remplacé l'écran de démonstration du template de départ (assertions sur des chaînes de caractères présentes/absentes dans le HTML rendu). **Aucun test de logique métier.**
- `npx tsc --noEmit` → 0 erreur.
- `npm run lint` → **6 erreurs réelles** : violations React « pureté »/« setState synchrone dans un effet » dans `admin-users.tsx:36`, `install-app.tsx:28`, `investment-access-settings.tsx:27`, et appels à `Date.now()` pendant le rendu dans `family-dashboard.tsx:461` et `gift-portfolio.tsx:157` — plus **4 avertissements** `<img>` non optimisées (`auth-shell.tsx` ×3, `family-dashboard.tsx` ×1).
- `npm run build` → succès complet (Turbopack, 5.2s + 7.0s typecheck), génère les 14 routes API + `/` en mode dynamique.

## 26. Tests manquants

Stratégie proposée (non implémentée) :
- **Unitaires** : allocation au prorata en satoshis, calcul d'écart/justification obligatoire, transitions d'état `custody`, soft-delete et son irréversibilité, fusion 3-sources par clé.
- **Intégration** : chaque route API avec les 4 rôles + le cas non-authentifié, en particulier `POST /api/transfer-requests` sous Supabase non configuré.
- **Permissions** : matrice complète du §10 rejouée automatiquement (y compris le mode preview, pour vérifier qu'aucune route de mutation n'est jamais appelée pendant ce mode dans les parcours UI).
- **Supabase/RLS** : test contre une base réelle avec la clé anon, pour vérifier que les policies SELECT-only se comportent comme attendu si jamais un accès direct navigateur était introduit.
- **Blockchain** : mock des réponses Blockstream pour couvrir les cas confirmé/non confirmé/montant partiel/tolérance stricte vs groupée.
- **Responsive/PWA** : tests visuels de régression (Playwright) sur les points de rupture réellement utilisés (780/720/700/680/560/850px — pas un seul breakpoint) ; test du cycle de mise à jour du service worker.

## 27. Composants à conserver

`GiftEditor`, `TransferWorkbench`, `use-dialog-a11y.ts`, le moteur de fusion historique+live (à généraliser plutôt qu'à dupliquer), `InstallAppCard`, `MemberOnboarding`, la logique d'allocation au prorata et de vérification blockchain (`/api/ledger-transfers`, `/api/blockchain/verify`).

## 28. Composants à refactorer

`InvestmentModal` (rebrancher sur `/api/gifts`), `Members`/`AdminUsers` (fusionner), les rosters de membres dupliqués (centraliser), les types `GiftRecord` (unifier), les badges de statut et boutons primaires (extraire en composants partagés), `family.css`/`gift-portfolio.css` (nettoyer le CSS mort « Missions », harmoniser les breakpoints).

## 29. Composants à remplacer

`back-office.tsx` (après extraction du type), `ledger-live.tsx`, `chatgpt-auth.ts`, `GiftSettings`/le bouton « Exporter en Excel » (implémenter réellement ou retirer), le scaffolding Vite/Wrangler/Drizzle/`.openai`/`examples`/`dist`/`build` complet.

## 30. Migrations futures probables

- Ajout de colonnes/tables pour vidéos souvenirs Amatxi (aucune trace existante — table neuve probable, ex. `gift_memories` avec `gift_record_id`, `video_url`, `caption`).
- Ajout d'un mécanisme de suggestion/allocation cible (ETF Monde) — table neuve, `holdings`/`financial_accounts` actuels ne portent aucune notion de recommandation ou de récurrence.
- Ajout d'une colonne/mécanisme de versement mensuel programmé.
- Correction de la contrainte `family_members.role` pour retirer `child` de l'enum si le produit confirme qu'il ne sera jamais assignable, ou au contraire l'autoriser dans l'API admin si c'est un oubli.
- Ajout de policies RLS INSERT/UPDATE/DELETE si un accès direct navigateur est un jour introduit.

## 31. Architecture cible recommandée

Conserver Next.js/React/TypeScript/Supabase. Faire évoluer progressivement : (a) vraies routes Next.js pour les écrans principaux (permet le lien profond et le partage), en gardant le state React pour les sur-couches transverses (aperçu admin, modales) ; (b) une seule route de lecture par domaine de données avec filtrage de rôle centralisé (pattern déjà correct sur `/api/gifts`, à répliquer pour `financial_accounts`/`holdings`) ; (c) extraction d'un design system minimal (Button/Card/Badge/Modal/ResponsiveTable) avant d'ajouter de nouveaux écrans desktop+mobile ; (d) un module `lib/family-roster.ts` unique consommé partout au lieu des 5-6 copies.

## 32. Découpage proposé en lots

### Table F — Refactor

| Lot | Objectif | Fichiers concernés | Dépendances | Risque | Validation |
|---|---|---|---|---|---|
| 1 | Corriger le bug anniversaire Aurore + centraliser le roster membres | `family-dashboard.tsx`, `gift-portfolio.tsx`, `transactions.tsx`, `administration.tsx`, `indicators.tsx`, `back-office.tsx` | aucune | faible | vérifier le countdown Accueil pour les 5 enfants |
| 2 | Unifier les deux chemins d'écriture (InvestmentModal → `/api/gifts`) | `transactions.tsx`, `family-dashboard.tsx`, `gift-portfolio.tsx` | Lot 1 (roster partagé) | moyen | tester les 4 points d'entrée, vérifier persistance après reload |
| 3 | Fusionner `Members`/`AdminUsers` | `administration.tsx`, `admin-users.tsx` | aucune | moyen | tester assignation de rôle `child`, wallet, partage depuis un seul endroit |
| 4 | Extraire types partagés + supprimer code mort (`back-office.tsx`, `ledger-live.tsx`, `chatgpt-auth.ts`, scaffolding Vite) | tous les fichiers listés §21 | aucune | faible | `next build` + `tsc --noEmit` toujours verts |
| 5 | Mettre à jour `supabase/SETUP.md`, résoudre la divergence Uhaina/Noël 2024 | `supabase/SETUP.md`, base Supabase | aucune | faible (doc) / moyen (donnée live) | rejouer le check SQL |
| 6 | Corriger `POST /api/transfer-requests` (auth inconditionnelle) | `app/api/transfer-requests/route.ts` | aucune | faible | tester avec/sans variables Supabase |
| 7 | Extraire composants UI partagés (Badge/Button/Card/Modal/ResponsiveTable) | tous les `.css`/`.tsx` d'écran | Lots 1-4 recommandés avant | moyen | comparaison visuelle desktop+mobile avant/après |
| 8 | Câbler `investment_access_scope` dans une vraie route de lecture, préparer l'exposition PEA/CTO aux membres | nouvelle route API, `gift-portfolio.tsx` (activer les onglets) | Lot 7 recommandé | élevé (nouvelle surface de données sensibles) | audit de sécurité dédié avant mise en prod |
| 9 | Vraies routes Next.js (lien profond) | `app/page.tsx` et toute la nav | Lots 1-8 | élevé (refonte structurelle) | tests e2e de navigation complets |

## 33. Ordre recommandé d'implémentation

1 → 4 → 5 → 6 (corrections/dette à faible risque, aucune dépendance) → 2 → 3 (unification des flux de données) → 7 (design system, préparation visuelle) → 8 (PEA/CTO, seulement après audit sécurité dédié) → 9 (routage réel, en dernier car le plus structurant).

## 34. Questions nécessitant une décision produit

1. Le rôle `viewer` (Amatxi) doit-il devenir un vrai rôle restreint côté API, ou est-il un vestige à retirer du modèle de données tant qu'aucun compte réel ne l'utilise ?
2. La « Vue Amatxi » doit-elle rester admin-only (rapport que Florent consulte *pour* elle) ou doit-elle un jour être un écran que la grand-mère consulte elle-même avec son propre compte ?
3. Le mode « Aperçu admin » doit-il obtenir une garantie serveur de lecture-seule, ou la garantie purement UI actuelle est-elle jugée suffisante compte tenu du contexte familial de confiance ?
4. Faut-il exposer le PEA/CTO aux membres avant ou après avoir réellement branché `investment_access_scope` sur toutes les routes de lecture concernées (y compris `/api/gifts`, qui l'ignore aussi aujourd'hui) ?
5. Le montant standard de 55 € et la liste des 5 enfants doivent-ils rester des constantes de code, ou passer entièrement en configuration base de données (ce qui simplifierait l'ajout d'un 6e enfant à l'avenir) ?
6. Quelle donnée doit porter les futures vidéos souvenirs Amatxi — une nouvelle table liée à `gift_records`, ou un champ générique réutilisable pour d'autres médias familiaux ?
7. Le rôle `child` de l'enum `family_members.role` doit-il redevenir assignable via l'admin, ou `adult`/`child` doivent-ils être fusionnés dans le modèle de données puisqu'ils sont déjà traités identiquement partout ?
8. Priorité produit : terminer la refonte mobile (Indicateurs/Administration/Paramètres/Amatxi restent à auditer UX en détail) avant ou après le chantier PEA/CTO ?

## 35. Conclusion et GO / NO-GO pour démarrer la refonte

**GO conditionnel.** Le socle technique (Next.js/Supabase, auth, cycle de vie Bitcoin) est sain, `build`/`typecheck` passent, l'architecture est comprise dans son intégralité et documentée ci-dessus. Rien n'empêche de démarrer les lots 1, 4, 5, 6 immédiatement (faible risque, gains de fiabilité immédiats).

**Conditions avant d'attaquer les lots à plus fort impact** :
- Committer `app/settings.tsx`/`app/settings.css` sans délai (risque de perte de code, indépendant de toute décision de refonte).
- Corriger le bug Aurore et le point d'authentification de `POST /api/transfer-requests` avant toute mise en production visible par la famille.
- Trancher les 8 questions produit du §34 avant de lancer le lot 8 (PEA/CTO) ou le lot 9 (routage réel), qui sont les deux chantiers structurants les plus coûteux à défaire en cas de mauvaise direction.
- Ne pas construire de nouvelle UI membre sur `investment_access_scope` tant que ce réglage n'est pas réellement appliqué côté serveur — le construire aujourd'hui créerait une fausse impression de confidentialité.

Aucun élément trouvé ne remet en cause la faisabilité de la refonte desktop + mobile/PWA visée ; le travail restant est de nettoyage, d'unification et de câblage de sécurité plutôt que de réécriture.
