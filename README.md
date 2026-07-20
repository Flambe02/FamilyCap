# LaBaJo & Co (Cap Family) — Documentation technique et fonctionnelle

> Document de référence destiné à toute personne (développeur, prestataire, IA) qui reprend le projet sans contexte préalable. Rédigé après lecture exhaustive du code (`app/`, `lib/`, `db/`, `supabase/`, configs, tests, docs internes) en juillet 2026.

**Nom produit** : LaBaJo & Co — « l'école financière de la famille »
**Nom de dossier / repo** : `Cryptos Kids` (contenu réel du dossier `CapFamily`)
**Pitch en une phrase** : application privée, réservée à une famille, pour suivre les cadeaux Bitcoin offerts aux enfants (anniversaires + Noël), leur conservation (Ledger personnel vs compte Binance commun), leur rapprochement avec la blockchain, et — en germe — l'ensemble de leur patrimoine (PEA, comptes-titres, comptes bancaires).

---

## 1. Structure technique actuelle

### 1.1 Stack

| Domaine | Choix | Détail |
|---|---|---|
| Framework | **Next.js 16** (App Router) | `next dev` / `next build` / `next start` — c'est le *vrai* pipeline utilisé (voir 1.9) |
| UI | **React 19** + **TypeScript 5.9** | Tous les écrans sont des composants `"use client"` |
| Style | **Tailwind CSS 4** (via `@tailwindcss/postcss`) + CSS classique par écran (`family.css`, `gift-portfolio.css`, etc.) | Pas de librairie de composants (pas de shadcn/MUI) : tout est écrit à la main |
| Backend applicatif | Route Handlers Next.js (`app/api/**/route.ts`) | Aucun serveur séparé |
| Base de données | **Supabase** (Postgres managé + Auth) | Voir 1.5 |
| ORM | **Drizzle** déclaré (`db/schema.ts`, `drizzle-orm`) mais **non utilisé** — `db/index.ts` lève une erreur volontaire (« La persistance principale de LaBaJo & Co est configurée dans Supabase. ») | Résidu du template de départ, à ignorer |
| Déploiement | **Vercel** | `next.config.ts` lit `VERCEL_GIT_COMMIT_SHA` pour le numéro de version affiché |
| PWA | `manifest.webmanifest` + `public/sw.js` | Service worker enregistré uniquement en production |
| Emails transactionnels | **Resend** (optionnel) | Alerte à l'admin quand un enfant demande un transfert |
| Cours Bitcoin | **CoinGecko** puis **Kraken** en repli | Cache HTTP `max-age=30, s-maxage=60` |
| Lecture blockchain | **Blockstream Esplora API** (publique, lecture seule) | Soldes, historique de transactions, vérification de virement |
| Cours actions/ETF | **Alpha Vantage** (optionnel, clé serveur) | Alimente l'onglet Administration → Comptes & positions |

### 1.2 Organisation des dossiers

```
web/
├── app/                     # Écrans (.tsx à plat, PAS de sous-dossiers par route) + API
│   ├── page.tsx             # UNIQUE route Next.js réellement utilisée : <AuthShell />
│   ├── layout.tsx           # <html lang="fr">, métadonnées, service worker
│   ├── auth-shell.tsx       # Connexion Supabase + routeur applicatif (voir 1.3)
│   ├── family-dashboard.tsx # Coquille de nav (sidebar/mobile-nav) + écran "Vue famille"
│   ├── gift-portfolio.tsx   # Écran "Portefeuilles"
│   ├── transactions.tsx     # Écran "Transactions" (alias affiché : "Mouvements")
│   ├── indicators.tsx       # Écran "Indicateurs"
│   ├── administration.tsx   # Écran "Administration" (5 sous-onglets, admin uniquement)
│   ├── amatxi-report.tsx    # Écran "Vue Amatxi" (rapport grand-mère, admin uniquement)
│   ├── settings.tsx         # Écran "Paramètres" (onglets horizontaux)
│   ├── admin-users.tsx      # Gestion des membres/invitations (réutilisé 2x)
│   ├── investment-access-settings.tsx  # Partage de la confidentialité des investissements
│   ├── member-onboarding.tsx           # Visite guidée 1re connexion (non-admin)
│   ├── install-app.tsx      # Carte d'installation PWA
│   ├── register-service-worker.tsx
│   ├── use-dialog-a11y.ts   # Hook focus-trap partagé par toutes les modales
│   ├── back-office.tsx      # ⚠️ INUTILISÉ (voir 1.9)
│   ├── ledger-live.tsx      # ⚠️ INUTILISÉ (voir 1.9)
│   ├── chatgpt-auth.ts      # ⚠️ INUTILISÉ (voir 1.9)
│   ├── robots.ts
│   └── api/                 # Route Handlers (voir 1.6)
├── lib/
│   ├── auth-server.ts       # requireFamilyMember() / requireAdmin() — LA barrière d'autorisation
│   ├── auth-types.ts        # type Viewer
│   ├── supabase-browser.ts  # client Supabase navigateur (Auth uniquement)
│   ├── supabase-rest.ts     # client REST serveur (clé secrète, bypass RLS)
│   └── gift-history.ts      # historique de cadeaux figé en dur (voir 4.6)
├── db/                      # Vestige Drizzle/D1, non utilisé (voir 1.1)
├── supabase/
│   ├── SETUP.md
│   ├── migrations/*.sql     # 10 fichiers, à appliquer manuellement (voir 4.2)
│   └── checks/*.sql         # requêtes de contrôle ponctuelles
├── docs/mobile-ux-redesign/ # Audit UX déjà réalisé sur 3 écrans (voir 5.7 — très utile)
├── tests/rendered-html.test.mjs  # 1 seul test, anti-régression "starter template"
├── worker/, .wrangler/, .vinext/, .openai/, vite.config.ts  # Scaffolding Cloudflare/vinext non utilisé (voir 1.9)
└── next.config.ts, package.json, tsconfig.json
```

### 1.3 Modèle de routage : une seule route Next.js, navigation interne en state

Contrairement à un site Next.js classique, **il n'y a qu'une seule route applicative** : `app/page.tsx` rend `<AuthShell />`. Toute la navigation entre écrans (Accueil, Portefeuilles, Transactions…) se fait **en state React** (`view: "famille" | "portefeuilles" | ...` dans `family-dashboard.tsx`), pas via le routeur Next.js. C'est donc, sous une coquille Next.js/App Router, une **SPA classique** :

```
app/page.tsx
  → AuthShell (auth-shell.tsx)       — Supabase Auth : login / magic link / Google
    → FamilyDashboard (family-dashboard.tsx)  — sidebar + top bar + switch de vues
      → Dashboard | GiftPortfolio | TransactionsView | Indicators
      → Administration | AmatxiReport | Learn | Settings
```

Aucune URL profonde (`/portefeuilles`, `/transactions`…) n'existe : un lien direct ou un rafraîchissement retombe toujours sur l'accueil. C'est une limite connue (voir §6).

### 1.4 Authentification & autorisation

- **Identité** : Supabase Auth (email + mot de passe, lien magique OTP, Google OAuth). **Pas d'inscription libre** : un hook Postgres (`hook_allow_cap_family_member`, à activer dans Supabase → Authentication → Hooks → "Before User Created") rejette toute création de compte dont l'e-mail n'est pas déjà présent et actif dans `family_members`.
- **Autorisation applicative** : la table `family_members` (colonne `role` : `admin` / `adult` / `child` / `viewer`) est la source de vérité, pas les claims Supabase. Chaque route API rappelle `requireFamilyMember(request)` ou `requireAdmin(request)` (`lib/auth-server.ts`), qui revérifie le token Bearer auprès de Supabase Auth puis relit le rôle en base à chaque appel.
- **Écriture** : toutes les routes API utilisent la **clé secrète Supabase (service role)** côté serveur (`lib/supabase-rest.ts`), qui **contourne totalement les policies RLS**. Les policies RLS existent bien dans les migrations (voir 4.2) mais ne sont, dans les faits, **jamais le rempart réel** pour les écritures/lectures passant par `/api/*` — le vrai périmètre de sécurité est `lib/auth-server.ts`. Important à savoir pour ne pas se croire protégé par RLS seule.
- **Bascule spéciale « Amatxi »** (`viewer`) : rôle lecture seule pour la grand-mère.
- **Aperçu admin** : Florent (unique admin) peut visualiser l'app *comme* n'importe quel enfant (lecture seule, sans changer de session réelle) — sélecteur en haut de l'app.
- **Mode dev sans Supabase configuré** (`setupMode`) : si `/api/supabase/status` répond « non connecté », l'app affiche directement le dashboard avec un faux admin local — pratique pour prévisualiser l'UI sans base, mais jamais actif en production dès que les clés sont renseignées.
- **Aperçu de design** (`?preview=dashboard`) : bypass strictement gated sur `NODE_ENV === "development"`, aucun effet en prod — sert à screenshot/tester visuellement sans compte.

### 1.5 Persistance des données (Supabase)

Deux clients distincts, jamais mélangés :

- **Navigateur** (`lib/supabase-browser.ts`) : `@supabase/supabase-js`, URL et clé publishable (anon) **codées en dur dans le fichier** (pas de variable d'env `NEXT_PUBLIC_*`). Utilisé **uniquement pour l'Auth** (login, session, changement de mot de passe/e-mail) — jamais pour lire/écrire des données métier directement.
- **Serveur** (`lib/supabase-rest.ts`) : appels REST bruts à PostgREST (`/rest/v1/...`) avec la clé secrète (`SUPABASE_SECRET_KEY`), depuis les Route Handlers uniquement.

Tables principales (voir détail complet en §5.2) : `family_members`, `wallets`, `gift_records`, `transfer_requests`, `investment_access_grants`, `financial_accounts`, `holdings`.

### 1.6 API internes (`app/api/**/route.ts`)

| Route | Rôle requis | Fonction |
|---|---|---|
| `GET /api/auth/me` | membre | Retourne le `Viewer` courant |
| `GET/POST/PATCH/DELETE /api/gifts` | membre (lecture, filtrée) / admin (écriture) | CRUD des cadeaux BTC, suppression douce (`is_deleted`), verrouillage des lignes déjà associées à un virement Ledger |
| `GET /api/ledger` | admin (ou `priceOnly=1` public) | Lit les soldes/transactions publiques Bitcoin (Blockstream) de chaque Ledger + cours BTC/EUR |
| `POST /api/ledger-transfers` | admin | Rapproche un virement Ledger réel (TxID) avec un ou plusieurs cadeaux Binance, répartit le montant au prorata, gère les écarts de frais avec justification obligatoire |
| `POST /api/blockchain/verify` | admin | Vérifie unitairement qu'un TxID a bien crédité une adresse d'un montant donné |
| `GET/POST/PATCH /api/transfer-requests` | membre (créer sa propre demande) / admin (changer le statut) | Demandes de transfert Binance → Ledger émises par les enfants, envoie un e-mail (Resend) à l'admin |
| `GET/PATCH /api/investment-access` | membre | Chaque membre choisit qui peut voir ses investissements (famille entière ou personnes choisies) |
| `GET/POST/PATCH/DELETE /api/admin/users` | admin | Invitations, rôles, anniversaires, adresse wallet, portée de partage — pilote aussi Supabase Auth Admin (invite/reset/delete) |
| `POST /api/admin/users/actions` | admin | Renvoi d'invitation / réinitialisation de mot de passe |
| `GET/POST/PATCH/DELETE /api/admin/accounts` | admin | Comptes financiers multi-actifs (PEA, compte-titres, banque, crypto…), import automatique des wallets Ledger existants |
| `GET/POST/PATCH/DELETE /api/admin/holdings` | admin | Positions (actions/ETF/fonds…) rattachées à un compte |
| `GET /api/admin/market` | admin | Recherche de valeurs et cours de clôture via Alpha Vantage (optionnel) |
| `GET /api/supabase/status` | public | Ping de configuration Supabase (déclenche le `setupMode` si absent) |

### 1.7 Intégrations externes

- **Blockstream Esplora** (`blockstream.info/api`) — lecture publique uniquement, jamais de clé privée manipulée par l'app.
- **CoinGecko** puis **Kraken** — cours BTC/EUR, avec repli automatique si le premier échoue.
- **Resend** — email d'alerte optionnel (variables absentes = fonctionnalité silencieusement désactivée, pas d'erreur).
- **Alpha Vantage** — recherche/cours actions-ETF, optionnel, 25 requêtes/jour en gratuit (affiché à l'admin).

### 1.8 PWA

`manifest.webmanifest` + `public/sw.js`, service worker enregistré uniquement si `NODE_ENV === "production"`. Carte d'installation (`install-app.tsx`) gère Chrome/Android (`beforeinstallprompt`) et donne les instructions manuelles pour iOS Safari (pas d'API d'installation native sur iOS).

### 1.9 Zones mortes / à connaître avant de "s'y perdre"

Trois fichiers sont **complets, fonctionnels, mais non importés nulle part dans le flux actif** :
- `app/back-office.tsx` (`BackOffice`) — ancienne version de l'écran Administration, remplacée par `administration.tsx`.
- `app/ledger-live.tsx` (`LedgerLive`) — ancienne vue blockchain, dont les fonctions ont été absorbées dans `gift-portfolio.tsx` et `administration.tsx`.
- `app/chatgpt-auth.ts` — helpers "Sign in with ChatGPT" issus du template de départ (OpenAI Sites/Dispatch), sans rapport avec Supabase Auth réellement utilisé.

De même, **le scaffolding Cloudflare/vinext** (`vite.config.ts`, `worker/index.ts`, `.wrangler/`, `.vinext/`, `.openai/hosting.json`, `drizzle-kit`, `db/schema.ts`) provient du template de départ (`site-creator-vinext-starter`, voir `package.json` → `name`) mais **n'est pas le chemin de build/déploiement réel** : les scripts utilisés sont `next dev` / `next build` / `next start`, et le déploiement cible est **Vercel** (cf. `VERCEL_GIT_COMMIT_SHA` dans `next.config.ts`, et les messages d'erreur "Supabase est requis sur Vercel" dans le code). Un futur nettoyage peut supprimer ces éléments sans risque (voir §6).

---

## 2. Fonctionnalités générales

- **Objet du produit** : suivre, pour 5 enfants (Thibault, Uhaina, Paul, Aurore, Thomas), les cadeaux Bitcoin offerts à chaque anniversaire et à Noël (55 € par occasion, frais inclus), depuis l'achat jusqu'au transfert vers le portefeuille matériel (Ledger) personnel de l'enfant, en passant par une période de détention sur un compte Binance commun.
- **Rôles** :
  - **admin** (Florent, unique) : gère tout — membres, invitations, cadeaux, rapprochements blockchain, comptes multi-actifs.
  - **adult / child** (« Utilisateur » dans l'UI) : consulte son propre portefeuille, son historique, peut demander un transfert Binance → Ledger.
  - **viewer** (« Amatxi ») : rapport de lecture seule pensé pour la grand-mère, sans jargon technique.
- **Cycle de vie d'un cadeau** : `À rapprocher` (non classé) → `Binance commun` (achat identifié, en attente de transfert) → `Ledger` (transféré, verrouillé — non modifiable/supprimable une fois associé à un TxID vérifié sur la blockchain).
- **Vérification blockchain réelle** : un virement peut être vérifié (adresse + TxID + montant attendu) contre l'API Blockstream avant validation ; un même virement peut être réparti au prorata entre plusieurs cadeaux d'un même enfant ; un écart (frais réseau/plateforme) doit être justifié par un texte obligatoire.
- **Authentification sans inscription libre** : accès uniquement sur invitation, contrôlé à la fois côté application et côté base (hook Postgres).
- **Confidentialité paramétrable** : chaque membre choisit si ses investissements sont visibles par toute la famille active ou seulement par des personnes choisies.
- **Aperçu en lecture seule** : l'admin peut visualiser l'app comme n'importe quel enfant sans quitter sa session.
- **Progressive Web App** installable sur mobile (Android/iOS), avec service worker.
- **Éducation financière** : section « Apprendre » (contenu statique aujourd'hui), visite guidée à la première connexion pour les non-admins.
- **Extension multi-actifs déjà câblée côté admin** : au-delà du Bitcoin, l'admin peut déjà déclarer des comptes PEA/compte-titres/bancaires et des positions (actions, ETF, fonds…) avec recherche de cours via Alpha Vantage — fonctionnalité opérationnelle côté Administration, mais **pas encore exposée** dans les écrans « famille » (les onglets PEA/Compte-titres du Portefeuille sont volontairement désactivés, « Bientôt »).
- **Responsive mobile en cours** : refonte mobile progressive, avec consigne explicite (mémoire de session) de ne jamais toucher au rendu desktop existant.

---

## 3. Fonctionnalités par écran

### 3.1 Connexion (`auth-shell.tsx` → `LoginScreen`)
- Connexion par e-mail/mot de passe, lien magique (OTP), ou Google OAuth.
- Traduction des erreurs Supabase en messages français compréhensibles (ex. compte non autorisé → renvoie vers Florent).
- Modale « Comment rejoindre l'espace famille ? » pour orienter un visiteur (invitation existante vs demande d'accès).
- Détection des erreurs de lien magique expiré dans le hash d'URL.

### 3.2 Vue famille / Accueil (`family-dashboard.tsx` → `Dashboard`)
- **Seul écran sans branche admin/membre** : contenu strictement identique pour tous (transparence familiale totale).
- Bandeau d'accueil, prochain événement familial (anniversaire ou Noël, calculé et regroupé si plusieurs le même mois), 3 cartes indicateurs, grille des 5 membres (valeur BTC actuelle, cadeaux à saisir), journal d'activité récente.
- ⚠️ Plusieurs chiffres affichés sont **codés en dur** et non calculés (nombre « d'achats à compléter », barres de progression par membre) — cf. audit `docs/mobile-ux-redesign/accueil-mobile.md`.
- Le journal d'activité est **un état React local, perdu au rechargement** (pas persisté en base).

### 3.3 Portefeuilles (`gift-portfolio.tsx` → `GiftPortfolio`)
- **Admin** : sélecteur des 5 enfants, vue complète du portefeuille sélectionné (valeur actuelle, PRU pondéré, plus/moins-value), répartition Ledger/Binance/à rapprocher, historique chronologique par année, atelier de rapprochement (`TransferWorkbench` : associer un virement Ledger réel à un ou plusieurs cadeaux, avec justification d'écart), liste des transactions blockchain en lecture seule, demandes de transfert des enfants.
- **Membre** : version mobile dédiée (`MemberPortfolioMobile`) verrouillée sur son propre portefeuille — total, gains, anneau de répartition, historique, bouton « Demander le transfert » pour les cadeaux encore sur Binance.
- Onglets d'enveloppe patrimoniale : Bitcoin (actif) / PEA / Compte-titres (désactivés, « Bientôt »).
- Navigation contextuelle : presque tous les chiffres renvoient vers Transactions avec un filtre pré-appliqué.

### 3.4 Transactions / Mouvements (`transactions.tsx` → `TransactionsView`)
- Fusionne **3 sources** : historique figé (`GIFT_HISTORY`), cadeaux vivants (`/api/gifts`), transactions blockchain vivantes (`/api/ledger`) — plus des lignes synthétiques « attendues mais non saisies » pour les occasions déjà passées.
- **Admin** : tableau complet filtrable (enfant, localisation), suppression (sauf lignes Ledger verrouillées), actions de rapprochement.
- **Membre** : verrouillé sur ses propres lignes, filtres rapides (Ledger/Binance/en attente/Noël), vue carte mobile avec ses propres totaux.
- Modale de saisie guidée en 3 étapes (`InvestmentModal`) — ⚠️ alimente un **état local séparé**, pas directement `/api/gifts` (deux chemins d'écriture distincts, voir §6).

### 3.5 Indicateurs (`indicators.tsx` → `Indicators`)
- Analyse du **prix d'achat du BTC** par enfant dans le temps : graphique en ligne (comparé au cours actuel et à la moyenne pondérée familiale), vue mensuelle par année, tableau détaillé avec infobulles (plus/moins-value par achat).

### 3.6 Administration (admin uniquement) (`administration.tsx` → `Administration`, 5 sous-onglets)
- **Synthèse BTC** (`GiftSynthesis`) : matrice année × enfant × occasion éditable en ligne, plan de transfert (ce qu'il reste à envoyer sur chaque Ledger), tableau de valorisation, récapitulatif « cadeau dû livré ou non », contrôle des réceptions Ledger avec allocation par TxID.
- **Cadeaux BTC** : réutilise directement `GiftPortfolio` (vue admin).
- **Membres & accès** (`Members`) : liste des comptes Supabase (statut e-mail confirmé, dernière connexion), invitation, réinitialisation de mot de passe, suspension/suppression.
- **Comptes & positions** (`Accounts`) : **fonctionnalité multi-actifs complète et opérationnelle** — création de comptes (PEA, compte-titres, banque, crypto), import automatique des wallets Ledger existants, ajout de positions avec recherche de valeurs (Alpha Vantage) ou saisie manuelle, actualisation de cours.
- **Réglages admin** (`Settings` interne) : état de connexion Supabase, état de la clé Alpha Vantage, rappel des règles de sécurité (jamais de clé privée/PIN/IBAN complet).

### 3.7 Vue Amatxi (admin uniquement) (`amatxi-report.tsx` → `AmatxiReport`)
- Rapport simplifié pensé pour la grand-mère : filtres enfant/occasion/période, répartition Ledger/Binance, rendement annualisé estimé depuis le 25/12/2022, modale « comprendre les écarts » avec commentaire libre.

### 3.8 Apprendre (`family-dashboard.tsx` → `Learn`)
- 4 fiches pédagogiques statiques (investir tôt, Ledger vs Binance, ETF, sécurité des 24 mots) — **contenu fixe, pas de suivi de progression réel**.

### 3.9 Paramètres (`settings.tsx` → `Settings`, onglets horizontaux)
- **Mon compte** : identité en lecture seule, changement d'e-mail/mot de passe (Supabase Auth), carte d'installation PWA, rejouer la visite guidée.
- **Sécurité** : cartes informatives statiques (rôles, données interdites).
- **Mes investissements** : adresse wallet personnelle (membre) ou liste de tous les wallets (admin).
- **Partage familial** : `InvestmentAccessSettings` — qui peut voir mes investissements.
- **Utilisateurs & accès** (admin) : réutilise `AdminUsers` (même composant que dans Administration).
- **Règles des cadeaux** (admin) : affichage du montant (55 €) et de la règle — ⚠️ **formulaire non connecté**, purement visuel aujourd'hui.
- **Données** (admin) : export Excel et sauvegarde familiale — ⚠️ **boutons non fonctionnels / désactivés**, placeholders visuels.

### 3.10 Visite guidée (`member-onboarding.tsx`)
- 4 étapes à la première connexion d'un non-admin : présentation, Binance vs Ledger, portefeuille, confirmation des informations + choix de partage. Rejouable depuis Paramètres.

---

## 4. Autres données fondamentales

### 4.1 Variables d'environnement (`.env.example`)

| Variable | Obligatoire | Rôle |
|---|---|---|
| `SUPABASE_URL` | oui | URL du projet Supabase |
| `SUPABASE_PUBLISHABLE_KEY` | oui | Clé publique (anon) côté serveur (vérif. de session) |
| `SUPABASE_SECRET_KEY` | oui | Clé service-role — **tout-puissante, jamais exposée au navigateur** |
| `RESEND_API_KEY` / `ALERT_EMAIL_FROM` / `ALERT_EMAIL_TO` | non | Emails d'alerte sur demande de transfert |
| `ALPHA_VANTAGE_API_KEY` | non | Recherche/cours actions-ETF (Administration → Comptes & positions) |

⚠️ Le client **navigateur** (`lib/supabase-browser.ts`) n'utilise **aucune de ces variables** : l'URL et la clé publishable y sont codées en dur. À corriger si un environnement de staging distinct est un jour nécessaire.

### 4.2 Modèle de données (Supabase Postgres)

Migrations sous `supabase/migrations/*.sql`, **appliquées manuellement** (copier-coller dans le SQL Editor Supabase — aucun pipeline de migration automatisé) :

- `family_members` — identité + rôle + statut d'accès + anniversaire + lien vers `auth.users`.
- `wallets` — adresses Bitcoin publiques (Ledger) par membre.
- `gift_records` — chaque cadeau, avec `custody` (`À rapprocher`/`Binance commun`/`Ledger`), `is_deleted` (suppression douce), colonnes d'audit de forçage (`ledger_value_forced`, `ledger_force_reason`).
- `transfer_requests` — demandes de transfert Binance → Ledger émises par les enfants.
- `investment_access_grants` — droits de partage granulaires entre membres.
- `financial_accounts` / `holdings` — comptes et positions multi-actifs (PEA, compte-titres, banque…).

RLS (Row Level Security) activée sur toutes ces tables avec des policies basées sur `current_family_member_id()` / `is_cap_family_admin()` — **mais rappel du §1.4** : les routes API passent par la clé service-role et contournent ces policies ; elles ne protègent que d'éventuels accès directs futurs via la clé publishable.

### 4.3 Sécurité — règles produit explicites

Répétées à plusieurs endroits de l'UI (Paramètres, Administration) : **jamais** de phrase de récupération (24 mots), clé privée, code PIN, identifiant bancaire complet ou code 2FA saisis dans l'application. Seuls des identifiants publics (adresse Bitcoin, 4 derniers chiffres d'IBAN) sont stockés.

### 4.4 Internationalisation

Application **entièrement en français**, sans couche i18n : tous les formats (`Intl.NumberFormat`, `Intl.DateTimeFormat`) sont câblés en dur sur `fr-FR`.

### 4.5 Accessibilité

Investissement notable et non trivial : hook partagé `use-dialog-a11y.ts` implémentant piège de focus, `inert` sur le reste de la page, fermeture à `Échap`, restauration du focus à la fermeture — utilisé par **toutes** les modales de l'app (saisie, onboarding, aperçu de rapprochement…).

### 4.6 Données historiques figées

`lib/gift-history.ts` code en dur l'historique réel des cadeaux depuis décembre 2022 (montants, quantités BTC, notes) comme **socle de repli** : ce socle est fusionné avec les lignes vivantes Supabase (une ligne Supabase avec la même clé « membre|occasion|année » écrase la ligne figée). Ce pattern « historique en dur + live Supabase » est répété à l'identique dans `family-dashboard.tsx`, `gift-portfolio.tsx`, `transactions.tsx`, `administration.tsx`, `amatxi-report.tsx` et `indicators.tsx`.

### 4.7 Tests

Un seul fichier, `tests/rendered-html.test.mjs` (`node --test`, lancé par `npm test` après un `next build`) : vérifie que l'app affiche bien la coquille LaBaJo & Co et non un ancien écran de démonstration du template de départ. **Aucun test de logique métier** (calculs de rapprochement, répartition au prorata, transitions de garde, RLS).

### 4.8 Dette UX déjà documentée

`docs/mobile-ux-redesign/*.md` contient un audit détaillé (réalisé lors d'une session Claude Code précédente, ~18 juillet 2026) des écrans Accueil, Portefeuille et Mouvements, avec une liste concrète d'incohérences observées dans le code (voir §6, largement repris ici). Base de travail précieuse pour quiconque reprend la refonte mobile.

### 4.9 Contexte de dépôt / environnement (mémoire de session, hors code)

- Deux copies du projet ont existé sur le disque ; la copie canonique est `CapFamily/Cryptos Kids/web` (celle documentée ici) ; un doublon obsolète a été neutralisé (`.bak`).
- Un renommage approuvé `Cryptos Kids` → `CryptoKids` reste en attente (bloqué par des poignées de fichiers ouvertes par VS Code/OneDrive) — sans urgence, l'espace dans le nom de dossier ne casse rien.
- Le projet est stocké sous **OneDrive**, dont la synchronisation lente peut servir du **CSS obsolète** en développement (HMR non fiable) : en cas de doute, redémarrer le serveur `next dev` plutôt que de faire confiance au rechargement à chaud.
- Consigne produit active : toute évolution « responsive mobile » doit rester strictement dans le breakpoint mobile existant (`@media (max-width: 780px)`) et ne jamais modifier le rendu desktop.

---

## 5. Pistes d'amélioration proposées

### A. Dette technique / nettoyage (faible risque, gain de lisibilité immédiat)
1. **Supprimer ou isoler clairement le code mort** : `app/back-office.tsx`, `app/ledger-live.tsx`, `app/chatgpt-auth.ts`, et le scaffolding Cloudflare/vinext non utilisé (`vite.config.ts`, `worker/`, `.wrangler/`, `.vinext/`, `.openai/`, `drizzle-kit`, `db/`). Un nouveau contributeur perd sinon un temps réel à comprendre quelle stack est « la vraie ».
2. **Unifier les deux chemins d'écriture des transactions** : la modale `InvestmentModal` (Transactions/Accueil) alimente un état React local séparé de `/api/gifts`, alors que l'éditeur du Portefeuille écrit réellement en base — source de confusion et de données qui semblent enregistrées sans l'être.
3. **Fusionner les listes de membres dupliquées** : la liste des 5 enfants + leurs anniversaires est recopiée indépendamment dans `family-dashboard.tsx`, `gift-portfolio.tsx`, `transactions.tsx`, `administration.tsx` et `amatxi-report.tsx` — elles ont déjà divergé dans les faits (date d'anniversaire d'Aurore différente selon le fichier). Un seul module partagé éviterait la récidive.
4. **Remplacer la clé Supabase codée en dur** dans `lib/supabase-browser.ts` par des variables `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`, pour permettre un environnement de staging distinct sans toucher au code.
5. **Retirer ou implémenter les boutons non câblés** (« Exporter en Excel », formulaire « Règles des cadeaux », « Sauvegarde familiale ») pour ne pas laisser croire à une capacité qui n'existe pas.
6. **Réconcilier les deux numéros de version** : `package.json` (`1.7.1`) vs. la valeur de repli codée en dur dans `auth-shell.tsx` (`NEXT_PUBLIC_APP_SEMVER ?? "1.6.1"`), qui peuvent diverger silencieusement.

### B. Fiabilité des données / logique métier
7. **Brancher les chiffres statiques de l'Accueil sur de vrais calculs** : le nombre « d'achats à compléter » et les barres de progression par membre sont codés en dur, alors que le Portefeuille sait déjà calculer un vrai `missing` par enfant — risque de confusion utilisateur entre donnée réelle et gabarit.
8. **Persister le journal d'activité récente** (aujourd'hui perdu au rechargement) — par exemple en le dérivant des horodatages de `gift_records`/`transfer_requests`, ou via une table d'activité dédiée.
9. **Automatiser les migrations Supabase** (actuellement copier-coller manuel dans le SQL Editor) via la CLI Supabase en CI, pour éviter que schéma et code applicatif ne divergent silencieusement en production.
10. **Ajouter des tests automatisés sur la logique métier à plus haut risque** : répartition d'un virement Ledger entre plusieurs cadeaux, calcul des écarts forcés, suppression douce/tombstones. C'est la logique la plus complexe de l'app et elle n'a aujourd'hui aucune couverture de test.

### C. Sécurité / robustesse
11. **Documenter explicitement que RLS n'est pas le rempart réel** pour les accès serveur (clé service-role) — pour qu'un futur contributeur ne suppose pas à tort qu'ajouter une policy RLS suffit à protéger une nouvelle table exposée via l'API.
12. **Revoir le chemin `POST /api/transfer-requests` sans Supabase configuré** (accepte un membre non authentifié en repli) : confirmer qu'il est bien inatteignable en production dès que les clés sont renseignées, ou le retirer si c'est un vestige de développement local.
13. **Ajouter une troisième source de cours BTC/EUR ou un cache serveur de dernier cours connu**, pour survivre à une panne simultanée de CoinGecko et Kraken.

### D. Produit / UX
14. **Simplifier les 3 points d'entrée identiques vers la modale d'ajout d'opération** (bandeau d'accueil, bouton flottant, journal d'activité) — aucune différence de contexte entre eux aujourd'hui.
15. **Corriger le tap sur la carte d'un autre membre côté enfant** : il devrait ouvrir un aperçu en lecture seule du portefeuille de ce membre, mais rouvre aujourd'hui toujours le portefeuille de l'utilisateur connecté (affordance trompeuse).
16. **Décider du sort du multi-actifs PEA/Compte-titres** : la fonctionnalité est déjà complète côté Administration (comptes, positions, cours Alpha Vantage) mais invisible dans les écrans familiaux (onglets désactivés « Bientôt ») — soit la relier au Portefeuille familial, soit retirer les onglets désactivés pour ne pas créer d'attente.
17. **Enrichir ou requalifier la section « Apprendre »** : contenu aujourd'hui statique sans suivi de progression réel.
18. **Poursuivre la refonte mobile en s'appuyant sur `docs/mobile-ux-redesign/`**, qui contient déjà un audit priorisé et concret pour 3 des écrans (Accueil, Portefeuille, Mouvements) — reste à couvrir Indicateurs, Administration, Paramètres et Vue Amatxi de la même manière.
19. **Ajouter un vrai routage d'URL** (au moins un paramètre de requête ou un sous-chemin par écran) pour permettre un lien direct/rafraîchissement sans perdre la navigation — actuellement tout retombe sur l'Accueil.

### E. Observabilité
20. **Ajouter un suivi d'erreurs serveur** (type Sentry) : les routes API convertissent aujourd'hui toute erreur en message français pour l'utilisateur, sans aucune trace exploitable côté équipe en cas de panne (lecture blockchain, écriture Supabase…).
21. **Ajouter un minimum d'analytics produit** pour arbitrer objectivement les priorités (ex. la section Apprendre ou le multi-actifs valent-ils la peine d'être terminés ?).

---

*Document généré à partir d'une lecture complète du code source ; à mettre à jour après toute évolution structurante (nouvel écran, changement d'hébergeur, migration de schéma).*
