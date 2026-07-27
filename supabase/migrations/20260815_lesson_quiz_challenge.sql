-- Défi « leçon + quiz » : premier type de défi hors onboarding/investissement mensuel.
-- Réutilise le modèle existant des Défis (Phase 2 + missions onboarding) sans dupliquer le
-- moteur de points :
--   * challenges.challenge_type distingue déjà 'monthly_investment' et 'onboarding_mission' —
--     on y ajoute 'lesson_quiz' plutôt que d'inventer une nouvelle table.
--   * Ce défi est PERMANENT : status='active' en continu, sans starts_on/ends_on (déjà nullable
--     depuis 20260805_onboarding_missions.sql).
--   * Pas de challenge_participants (pas d'objectif en euros à figer) : les points sont
--     attribués directement via la RPC transactionnelle EXISTANTE apply_challenge_points, avec
--     participant_id = NULL (déjà nullable, colonne inchangée).
--   * Aucun montant financier n'est modifié ; aucun défi existant n'est supprimé ; aucun point
--     déjà attribué n'est touché.
--
-- La correction du quiz reste SERVEUR UNIQUEMENT (lib/lesson-quiz-etf.ts, jamais exposé au
-- client) : cette migration ne stocke ni questions ni corrigé, seulement la ligne de défi qui
-- porte les points et l'idempotence.
--
-- Additive et rejouable (seed idempotent via la clé métier `slug`, pas le titre).
-- À exécuter MANUELLEMENT dans le SQL Editor Supabase, APRÈS 20260805_onboarding_missions.sql.
-- Ne JAMAIS l'exécuter automatiquement sur la production.

-- 1) Nouveau type de défi : 'lesson_quiz', à côté de 'monthly_investment' et 'onboarding_mission'.
alter table public.challenges drop constraint if exists challenges_challenge_type_check;
alter table public.challenges add constraint challenges_challenge_type_check
  check (challenge_type in ('monthly_investment', 'onboarding_mission', 'lesson_quiz'));

-- 2) Seed idempotent du défi (ON CONFLICT sur la clé métier `slug`, jamais le titre). DO NOTHING :
--    ne jamais écraser une édition ultérieure (ex. points_reward ajusté à la main) si le seed est
--    rejoué. created_by NULL (préconfiguré par le système, pas par un administrateur).
insert into public.challenges
  (slug, title, description, challenge_type, status, starts_on, ends_on, points_reward, created_by)
values
  ('lesson_etf_5min', 'Comprendre un ETF en 5 minutes',
   'Termine la leçon et réponds correctement au mini-quiz pour valider tes connaissances.',
   'lesson_quiz', 'active', null, null, 20, null)
on conflict (slug) where slug is not null do nothing;

-- Aucune modification RLS : la policy existante "member reads visible challenges"
-- (status <> 'draft' or admin) couvre déjà la lecture de cette ligne status='active'.
-- Aucune modification de apply_challenge_points : participant_id NULL est déjà accepté par la
-- colonne points_ledger.participant_id (nullable) ; le verrou/l'update sur challenge_participants
-- portent alors sur 0 ligne (no-op), sans erreur — même comportement que les missions onboarding.
