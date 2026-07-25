-- Parcours permanent « Bien démarrer » (4 missions onboarding), distinct du défi mensuel.
-- Réutilise le modèle existant des Défis (Phase 2) sans dupliquer le moteur de points :
--   * challenges.challenge_type distingue déjà 'monthly_investment' — on y ajoute
--     'onboarding_mission' plutôt que d'inventer une nouvelle table.
--   * Les missions sont PERMANENTES : status='active' en continu, sans starts_on/ends_on
--     (colonnes rendues nullable). L'index unique « un seul défi actif » est donc restreint
--     au type mensuel, pour que les 4 missions restent actives simultanément.
--   * Les missions n'ont PAS de challenge_participants (pas d'objectif en euros à figer) :
--     les points sont attribués directement via la RPC transactionnelle EXISTANTE
--     apply_challenge_points, avec participant_id = NULL (déjà nullable, colonne inchangée).
--   * Aucun montant financier n'est modifié ; aucun défi existant n'est supprimé ; aucun point
--     déjà attribué n'est touché.
--
-- Additive et rejouable (seed idempotent via clé métier `slug`, pas le titre français).
-- À exécuter MANUELLEMENT dans le SQL Editor Supabase, APRÈS 20260804_challenges_mvp.sql.
-- Ne JAMAIS l'exécuter automatiquement sur la production.

-- 1) Clé métier stable pour l'idempotence du seed (indépendante de l'UUID généré et du titre).
--    Nullable : les défis mensuels existants n'ont pas de slug. Unicité limitée aux valeurs non
--    nulles (un défi mensuel peut ne jamais en avoir).
alter table public.challenges add column if not exists slug text;
create unique index if not exists challenges_slug_key on public.challenges(slug) where slug is not null;

-- 2) Nouveau type de défi : 'onboarding_mission', à côté du 'monthly_investment' existant.
alter table public.challenges drop constraint if exists challenges_challenge_type_check;
alter table public.challenges add constraint challenges_challenge_type_check
  check (challenge_type in ('monthly_investment', 'onboarding_mission'));

-- 3) Les missions onboarding n'ont ni date de début ni date de fin (parcours permanent).
--    Le défi mensuel continue d'exiger ces deux dates : la contrainte applicative
--    (validateChallengeInput) les rend toujours obligatoires pour 'monthly_investment'.
--    Note : un CHECK dont l'expression évalue à NULL est considéré satisfait par Postgres,
--    donc challenges_period_chk (ends_on >= starts_on) reste inchangée et continue de
--    protéger les défis mensuels sans bloquer les lignes onboarding à dates NULL.
alter table public.challenges alter column starts_on drop not null;
alter table public.challenges alter column ends_on drop not null;

-- 4) L'unicité « un seul défi actif » ne s'applique plus qu'aux défis MENSUELS : les 4
--    missions onboarding, elles aussi status='active', doivent pouvoir coexister.
drop index if exists public.challenges_single_active_idx;
create unique index if not exists challenges_single_active_idx
  on public.challenges(status) where status = 'active' and challenge_type = 'monthly_investment';

-- 5) Seed idempotent des 4 missions permanentes (ON CONFLICT sur la clé métier `slug`, jamais
--    le titre). DO NOTHING : ne jamais écraser une édition ultérieure ni un doublon si le seed
--    est rejoué. created_by NULL (préconfiguré par le système, pas par un administrateur).
insert into public.challenges
  (slug, title, description, challenge_type, status, starts_on, ends_on, points_reward, created_by)
values
  ('onboarding_account_setup', 'Configure ton compte',
   'Ajoute les informations essentielles de ton PEA ou de ton compte-titres.',
   'onboarding_mission', 'active', null, null, 50, null),
  ('onboarding_existing_portfolio', 'Ajoute ton portefeuille',
   'Enregistre les placements que tu possèdes déjà pour obtenir une vue complète.',
   'onboarding_mission', 'active', null, null, 100, null),
  ('onboarding_monthly_plan', 'Définis ton rythme',
   'Choisis le montant que tu souhaites investir chaque mois. Tu pourras le modifier à tout moment.',
   'onboarding_mission', 'active', null, null, 100, null),
  ('onboarding_first_purchase', 'Enregistre ton premier investissement',
   'Ajoute ton premier achat pour commencer à suivre réellement ta progression.',
   'onboarding_mission', 'active', null, null, 150, null)
on conflict (slug) where slug is not null do nothing;

-- Aucune modification RLS : la policy existante "member reads visible challenges"
-- (status <> 'draft' or admin) couvre déjà la lecture de ces lignes status='active'.
-- Aucune modification de apply_challenge_points : participant_id NULL est déjà accepté par la
-- colonne points_ledger.participant_id (nullable) ; le verrou/l'update sur challenge_participants
-- portent alors sur 0 ligne (no-op), sans erreur.
