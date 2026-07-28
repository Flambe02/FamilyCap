-- Défis v3 : contenu administrable des missions permanentes et nettoyage sûr du doublon
-- sémantique « Création PEA ». À appliquer manuellement après les migrations Défis existantes.
-- Additive et rejouable ; aucune ligne de points ni opération n'est supprimée.

alter table public.challenges add column if not exists cta_label text;
alter table public.challenges add column if not exists success_message text;
alter table public.challenges add column if not exists display_order integer;

alter table public.challenges drop constraint if exists challenges_display_order_nonnegative;
alter table public.challenges add constraint challenges_display_order_nonnegative check (display_order is null or display_order >= 0);

update public.challenges
set cta_label = case slug
  when 'onboarding_account_setup' then 'Configurer mon PEA'
  when 'onboarding_existing_portfolio' then 'Ajouter mes placements'
  when 'onboarding_monthly_plan' then 'Définir mon objectif'
  when 'onboarding_first_purchase' then 'Ajouter un achat'
end,
success_message = case slug
  when 'onboarding_account_setup' then 'Ton PEA est configuré !'
  when 'onboarding_existing_portfolio' then 'Ton portefeuille prend forme !'
  when 'onboarding_monthly_plan' then 'Ton rythme mensuel est défini !'
  when 'onboarding_first_purchase' then 'Premier investissement enregistré !'
end,
display_order = case slug
  when 'onboarding_account_setup' then 10
  when 'onboarding_existing_portfolio' then 20
  when 'onboarding_monthly_plan' then 30
  when 'onboarding_first_purchase' then 40
end
where challenge_type = 'onboarding_mission' and slug in (
  'onboarding_account_setup', 'onboarding_existing_portfolio',
  'onboarding_monthly_plan', 'onboarding_first_purchase'
) and (cta_label is null or success_message is null or display_order is null);

-- « Création PEA » est une ancienne variante mensuelle de la première mission permanente.
-- L'archivage conserve participants, complétions et points ; aucune suppression historique.
update public.challenges
set status = 'archived', updated_at = now()
where challenge_type = 'monthly_investment'
  and status in ('draft', 'scheduled', 'active', 'completed')
  and lower(title) in ('creation pea', 'création pea');

comment on column public.challenges.cta_label is 'Libellé d’action administrable. Les slugs onboarding restent stables.';
comment on column public.challenges.success_message is 'Texte de réussite affiché uniquement après une transition réelle vers terminé.';
comment on column public.challenges.display_order is 'Ordre d’affichage des missions permanentes.';
