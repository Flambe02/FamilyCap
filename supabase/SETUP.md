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

## Migrations additionnelles (à jouer dans l’ordre chronologique)

Les migrations suivantes sont additives et rejouables. Les exécuter dans le **SQL Editor** après les précédentes :

- `migrations/20260721_gift_source.sql`, `migrations/20260721_notification_preferences.sql`
- `migrations/20260820_invitation_login_truth.sql` : corrige le statut et la « dernière connexion » des invitations ; une invitation reste en attente tant que le membre ne s'est pas réellement connecté.
- `migrations/20260722_account_operations.sql`
- `migrations/20260723_user_onboarding.sql`
- `migrations/20260724_family_videos.sql` : espace **Souvenirs**. Crée `family_videos`, `family_video_recipients`, `family_video_views`, la RLS et la fonction `public.can_view_video()`. **Aucune vidéo n’est stockée** : seules les métadonnées YouTube et les droits d’accès le sont. **Aucune variable d’environnement supplémentaire n’est nécessaire** (pas de clé YouTube Data API : l’identifiant vidéo et la miniature sont dérivés de l’URL ; la durée est facultative et saisie à la main).
- `migrations/20260821_family_video_publish_schedule.sql` (**après** `20260724_family_videos.sql`) : ajoute `publish_at` (publication programmée — la vidéo reste invisible à tout non-administrateur tant que la date n’est pas atteinte) et `notify_on_login` (déclenche le pop-up de bienvenue à la prochaine connexion des destinataires) sur `family_videos`, et met à jour `public.can_view_video()` en conséquence. Sans elle, le sous-onglet Administration « Messages vidéo » renvoie une erreur claire (409) plutôt que d’écrire des colonnes inexistantes.
- `migrations/20260822_wallet_last_verified.sql` : ajoute `last_verified_balance_btc` / `last_verified_at` sur `wallets`, écrits automatiquement par `GET /api/ledger` (mode complet, jamais `priceOnly`/`cachedOnly`) à chaque vérification blockchain réelle réussie. Permet à l’écran Bitcoin (Résumé, aperçu admin d’un membre) d’afficher le dernier solde Ledger constaté sans relancer Blockstream à chaque chargement — seule l’actualisation manuelle interroge la blockchain. Sans cette migration, `/api/ledger` continue de fonctionner (repli automatique, aucune erreur) mais rien n’est mis en cache : l’écran affiche alors « Non vérifié » tant qu’aucune actualisation manuelle n’a eu lieu dans la session en cours.

La clé secrète reste uniquement dans `.env.local`. Elle ne doit jamais être ajoutée au SQL, au navigateur, à Git ou à un message.

## Activation PEA / Compte-titres (opérations + import)

> Les noms `20260725` / `20260726` sont des **numéros d’ordre** (convention de séquençage), pas des dates calendaires : ils indiquent simplement l’ordre d’exécution. Elles sont additives et rejouables. **Exécuter dans cet ordre exact** dans le SQL Editor, après les migrations ci-dessus :

1. `migrations/20260722_account_operations.sql` — registre `account_operations` (source de vérité des portefeuilles PEA/CTO). Sans elle, les écrans PEA/CTO affichent « aucune opération » (état vide propre, pas d’erreur).
2. `migrations/20260725_investment_multicurrency.sql` — colonnes multi-devises / transferts de titres / taxes (`exchange_rate`, `taxes` sur `account_operations`, types `transfer_in`/`transfer_out`) + `monthly_target` / `opened_at` sur `financial_accounts` (objectif mensuel, date d’ouverture). Facultative pour le PEA de base ; **requise** pour les opérations « avancées » du compte-titres et pour la date d’ouverture / l’objectif.
3. `migrations/20260726_investment_imports.sql` — imports d’opérations : table `investment_import_batches` (traçabilité + annulation) et colonnes `import_batch_id` / `external_reference` / `import_fingerprint` sur `account_operations`. **Requise** pour l’import CSV et l’annulation d’un lot. Sans elle, l’import renvoie une erreur `setupRequired` claire et le reste continue de fonctionner.

4. `migrations/20260811_asset_catalog.sql` — **catalogue d’actifs cotés** : tables `assets` (actif canonique, unique par ISIN) et `asset_listings` (cotation : place, MIC, devise, symboles fournisseurs), plus les colonnes **nullables** `asset_id` / `listing_id` sur `account_operations` et `listing_id` sur `holdings`. C’est elle qui remplace la saisie libre Nom/Ticker/ISIN/Devise par une **recherche puis sélection d’une cotation**, et qui rend impossible un couple ticker/ISIN incohérent.
   - **Additive, idempotente, non destructive** : aucune table ni colonne supprimée, aucune opération réécrite. Rejouable sans risque.
   - **Sans elle, rien ne casse** : la recherche continue de fonctionner via le fournisseur, et les opérations s’enregistrent simplement sans identifiant stable (les routes détectent l’absence des tables et dégradent silencieusement).
   - **Amorçage** : insère Air Liquide (`FR0000120073` / `AI` / Euronext Paris / EUR) et reprend depuis `holdings` **uniquement** les lignes déjà confirmées à la main (`classification_status = 'verified'`) — jamais une supposition.
   - Après exécution, contrôler avec `checks/2026-08-11_asset_catalog.sql`.

Vérifier que 1 puis 2 sont bien passées **avant** 3 (3 dépend de `account_operations`). La 4 dépend de `account_operations` et de `holdings`. Les routes serveur détectent une migration manquante et renvoient un message explicite plutôt qu’une erreur brute.

### Mettre en service un compte PEA / compte-titres

1. **Administration → Comptes & positions → Ajouter un compte** : choisir le propriétaire, le type (`PEA` ou `Compte-titres`), le nom, l’établissement, la devise, la date d’ouverture et (facultatif) l’objectif mensuel.
2. (Optionnel mais recommandé) **Ajouter les positions** (`holdings`) par ISIN/ticker pour valoriser : sans cours, la position s’affiche honnêtement « cours non disponible » — aucun cours n’est inventé.
3. **Saisir les opérations** via l’écran PEA/CTO (bouton « Enregistrer une opération ») **ou les importer** (voir ci-dessous). Valeur, prix de revient, performance et espèces se calculent automatiquement à partir des opérations.
4. **Archivage** : un compte se met en pause via « Archiver » (l’historique est conservé, aucune nouvelle opération acceptée) et se relance via « Réactiver ». La suppression d’un compte portant des opérations exige une confirmation explicite — préférer l’archivage.

### Import d’un historique (CSV)

- **Accès** : admin uniquement (bouton « Importer un fichier » dans l’en-tête PEA/CTO, dans l’onglet Historique, et dans l’état vide). Les membres n’y ont jamais accès.
- **Modèle CSV** : colonnes `date, type, isin, ticker, instrument_name, quantity, unit_price, amount, fees, taxes, currency, exchange_rate, external_reference, note`. Le bouton « Télécharger le modèle CSV » fournit un fichier d’exemple (versement, achat, dividende, frais, vente) — **à remplacer par vos données** (les lignes d’exemple ne sont pas importées telles quelles).
- **Parcours** : compte → fichier → correspondance des colonnes (auto-détectée FR/EN, corrigeable) → prévisualisation (statuts valide / à vérifier / erreur / doublon, corrections en ligne) → confirmation → résultat. Rien n’est écrit avant la confirmation ; le fichier n’est pas conservé.
- **Doublons** : exclus automatiquement si la `external_reference` existe déjà ; signalés « possible » (empreinte identique) et laissés au choix de l’admin.
- **Annulation** : un lot d’import peut être annulé — seules les opérations de ce lot sont supprimées (jamais les saisies manuelles), puis les positions sont recalculées.

### Scan IA d'un relevé (optionnel)

- **Activation** : définir `ANTHROPIC_API_KEY` (ou `OPENAI_API_KEY`) côté serveur. Réglages facultatifs : `DOCUMENT_AI_PROVIDER`, `DOCUMENT_AI_MODEL`, `DOCUMENT_AI_MAX_PAGES`, `DOCUMENT_AI_MAX_FILE_SIZE_MB`, `DOCUMENT_AI_HIGH_CONFIDENCE`, `DOCUMENT_AI_LOW_CONFIDENCE`. **Jamais** de préfixe `NEXT_PUBLIC_` : la clé reste strictement serveur.
- **Sans clé** : le bouton « Scanner un relevé (IA) » renvoie une erreur claire (503) ; l'import CSV/XLSX et la saisie manuelle restent disponibles.
- **Fonctionnement** : l'admin dépose un PDF/image, l'IA extrait des champs **bruts** avec un niveau de confiance ; le serveur revalide tout de façon déterministe (dates, nombres, cohérence quantité×prix et brut/frais/taxes/net, ISIN, devise, doublons) et réutilise la **même prévisualisation** que le CSV. Rien n'est enregistré avant validation humaine ; le fichier n'est **pas conservé**. Aucun calcul de portefeuille/PMP/performance n'est fait par l'IA — uniquement par `computeAccountModel`.
- **Limites** : privilégier les relevés numériques nets (FR/EN/PT). Écriture manuscrite, photos floues, documents coupés ou protégés par mot de passe non garantis → l'app propose alors le CSV/XLSX ou la saisie manuelle.

### Répartition géographique / sectorielle, revenus et performance (migration 20260816)

Exécuter `migrations/20260816_portfolio_exposures_insights.sql` dans le **SQL Editor**. Elle est
**additive et rejouable** : aucune table ni colonne existante n'est supprimée, `account_operations`
n'est pas touchée, et aucune quantité ni montant n'est modifié.

Ce qu'elle apporte :

- `instrument_exposures` — exposition géographique et sectorielle d'un instrument, avec `source`,
  `source_as_of`, `confidence` et `is_estimated`. **Un ETF n'est jamais rattaché à son pays de
  cotation** : seule la composition de son indice fait foi. Amorçage inclus pour les instruments
  réellement détenus (expositions définitionnelles marquées `is_estimated = false` ; répartitions
  régionales indicatives marquées `true` et datées).
- `benchmark_series` — historique d'un indice de référence. **Créée vide** : tant qu'elle n'est pas
  alimentée, l'écran Performance affiche « comparaison indisponible » plutôt qu'une courbe
  reconstituée. Alimentation par `POST /api/market-data/benchmarks` (admin).
- `portfolio_analyses` — cache de l'analyse pédagogique, indexé par empreinte des données. L'analyse
  n'est régénérée que si les chiffres changent, ou sur action explicite.
- `financial_accounts.dividend_tax_rate` — colonne historique, reprise automatiquement dans
  `account_tax_profiles` par la migration 20260817 (voir ci-dessous).

RLS : expositions et benchmarks sont des métadonnées de marché, lisibles par tout membre
authentifié (aucune donnée financière personnelle) ; `portfolio_analyses` suit le périmètre du
compte (titulaire ou administrateur). L'écriture reste réservée aux services serveur.

## 20260817_dividend_engine.sql — moteur de dividendes

Additive et rejouable. À exécuter **après** `20260816_portfolio_exposures_insights.sql`.

- `dividend_events` — événements de dividende rattachés à l'**instrument canonique** (`assets`),
  pas au compte. C'est la correction structurante : `corporate_actions` pointait vers `holdings`,
  table dupliquée par compte, si bien qu'une synchronisation du compte-titres laissait le PEA sans
  aucun dividende pour le même titre. Aucune quantité n'y est stockée : elle reste dérivée des
  opérations à chaque lecture.
- `account_tax_profiles` — résidence fiscale, retenue à la source, taux d'imposition, abattement.
  **Sans profil, seul le brut est affiché** : aucun taux par défaut, aucune fiscalité française
  présumée. La migration reprend `financial_accounts.dividend_tax_rate` quand il existe.
- `dividend_sync_state` — file de synchronisation (priorité aux instruments jamais synchronisés).
- `assets.distribution_policy` (`distributing` / `accumulating` / `unknown`) et
  `asset_listings.alpha_vantage_symbol` / `resolution_status` / `last_resolved_at`.

RLS : un événement d'instrument ne contient aucune donnée personnelle et reste lisible par tout
membre authentifié ; un événement rattaché à un compte suit `can_view_member_investments()` ; le
profil fiscal n'est lisible que par son titulaire ou l'administrateur ; l'état de synchronisation
est réservé à l'administrateur. Aucune écriture n'est accordée au navigateur.

**Après la migration**, pour peupler les dividendes :

1. obtenir une clé Alpha Vantage gratuite sur <https://www.alphavantage.co/support/#api-key>
   (e-mail + type d'usage, la clé s'affiche immédiatement) ;
2. la placer dans `.env.local` sous `ALPHA_VANTAGE_API_KEY=` puis redémarrer le serveur ;
3. ouvrir un compte PEA/CTO → onglet **Dividendes** → bouton **Actualiser** (administrateur).

La synchronisation respecte le quota (~25 appels/jour) et s'étale sur plusieurs jours si le
portefeuille compte plus d'instruments que le budget quotidien : elle reprend là où elle s'était
arrêtée. Elle ignore les ETF capitalisants, n'écrit jamais dans `account_operations` — un dividende
détaché n'est pas un dividende encaissé — et ne supprime que ses propres projections.

### Vérifications après déploiement

- `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` présentes côté serveur (jamais exposées au navigateur ni préfixées `NEXT_PUBLIC_`).
- Un compte PEA/CTO de test se crée, une opération manuelle s’enregistre, un CSV modèle s’importe puis s’annule sans laisser de résidu.
- Le partage familial est respecté : un membre ne voit que ses comptes + ceux réellement partagés ; l’aperçu admin reste en lecture seule côté écriture.
