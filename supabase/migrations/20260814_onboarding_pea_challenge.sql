-- Parcours « Bien démarrer » : le premier défi porte explicitement sur le PEA.
-- À appliquer MANUELLEMENT après 20260805_onboarding_missions.sql et
-- 20260809_challenges_rewards_v2.sql. Ne pas exécuter automatiquement en production.
--
-- Les écritures historiques de points sont immuables. Le complément de 200 points est ajouté
-- une seule fois par la RPC idempotente existante pour les membres déjà récompensés à 100 points.

update public.challenges
set title = 'Configure ton PEA',
    description = 'Ajoute ton PEA pour commencer à suivre tes investissements.',
    points_reward = 300,
    updated_at = now()
where slug = 'onboarding_account_setup'
  and challenge_type = 'onboarding_mission';

do $$
declare
  adjustment record;
begin
  for adjustment in
    select ledger.member_id, challenge.id as challenge_id,
           300 - sum(ledger.points) as delta
    from public.points_ledger ledger
    join public.challenges challenge on challenge.id = ledger.challenge_id
    where challenge.slug = 'onboarding_account_setup'
      and ledger.reason in ('onboarding_completion', 'onboarding_reward_adjustment_v2', 'onboarding_reward_adjustment_pea_v1')
    group by ledger.member_id, challenge.id
    having sum(ledger.points) > 0 and sum(ledger.points) < 300
  loop
    perform public.apply_challenge_points(
      null, adjustment.challenge_id, adjustment.member_id, adjustment.delta,
      'onboarding_reward_adjustment_pea_v1',
      'onboarding_reward_adjustment_pea_v1:' || adjustment.member_id::text,
      jsonb_build_object('slug', 'onboarding_account_setup', 'target_reward', 300),
      'completed', true
    );
  end loop;
end $$;
