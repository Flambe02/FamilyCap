-- Barème v2 du parcours « Bien démarrer ».
-- Migration additive, idempotente et à appliquer MANUELLEMENT dans Supabase.
-- Les anciennes lignes points_ledger sont immuables : un complément est créé via la RPC
-- transactionnelle existante, jamais par INSERT ou UPDATE direct dans le journal.

with target_rewards(slug, points_reward) as (
  values
    ('onboarding_account_setup', 100),
    ('onboarding_existing_portfolio', 200),
    ('onboarding_monthly_plan', 100),
    ('onboarding_first_purchase', 250)
)
update public.challenges as challenge
set points_reward = target_rewards.points_reward,
    updated_at = now()
from target_rewards
where challenge.slug = target_rewards.slug
  and challenge.challenge_type = 'onboarding_mission'
  and challenge.points_reward is distinct from target_rewards.points_reward;

do $$
declare
  adjustment record;
begin
  /*
   * On ne complète que les membres qui avaient effectivement reçu l'ancienne récompense.
   * Au rejouage, la somme completion + adjustment_v2 atteint déjà le nouveau barème : delta = 0.
   * apply_challenge_points garde de plus l'unicité de la clé d'idempotence comme dernier verrou.
   */
  for adjustment in
    with target_rewards(slug, points_reward) as (
      values
        ('onboarding_account_setup', 100),
        ('onboarding_existing_portfolio', 200),
        ('onboarding_monthly_plan', 100),
        ('onboarding_first_purchase', 250)
    ), awarded as (
      select ledger.member_id, challenge.id as challenge_id, challenge.slug,
             sum(ledger.points) filter (where ledger.reason in ('onboarding_completion', 'onboarding_reward_adjustment_v2')) as awarded_points
      from public.points_ledger as ledger
      join public.challenges as challenge on challenge.id = ledger.challenge_id
      where challenge.challenge_type = 'onboarding_mission'
      group by ledger.member_id, challenge.id, challenge.slug
    )
    select awarded.member_id, awarded.challenge_id, awarded.slug,
           target_rewards.points_reward - awarded.awarded_points as delta
    from awarded
    join target_rewards on target_rewards.slug = awarded.slug
    where awarded.awarded_points > 0
      and target_rewards.points_reward > awarded.awarded_points
  loop
    perform public.apply_challenge_points(
      null,
      adjustment.challenge_id,
      adjustment.member_id,
      adjustment.delta,
      'onboarding_reward_adjustment_v2',
      'onboarding_reward_adjustment_v2:' || adjustment.slug || ':' || adjustment.member_id::text,
      jsonb_build_object('slug', adjustment.slug, 'target_reward', adjustment.delta),
      'completed',
      true
    );
  end loop;
end $$;
