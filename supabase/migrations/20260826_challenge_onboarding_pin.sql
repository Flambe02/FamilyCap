-- Défis : possibilité d'épingler un défi mensuel existant dans le bloc « Bien démarrer », en
-- plus des 4 missions permanentes préconfigurées. Un défi épinglé garde son mécanisme normal
-- (inscription, objectif figé, achats, points) — seul son EMPLACEMENT d'affichage change : il
-- disparaît du hero/« Autres défis disponibles » pour apparaître dans « Bien démarrer ».
--
-- Additive et rejouable. À exécuter MANUELLEMENT dans le SQL Editor Supabase, APRÈS
-- 20260825_challenge_availability.sql.

alter table public.challenges add column if not exists show_in_onboarding boolean not null default false;

comment on column public.challenges.show_in_onboarding is
  'Défi mensuel épinglé, affiché aussi dans le bloc « Bien démarrer » en plus des 4 missions permanentes. Sans effet sur challenge_type=''onboarding_mission'' (déjà dans ce bloc par nature).';
