-- Préférences de notifications par membre. Additive et rejouable sans perte de données.
-- À exécuter après les migrations 20260716_*/20260718_investment_access.sql
-- (dépend de public.family_members, public.current_family_member_id, public.is_cap_family_admin).

create table if not exists public.notification_preferences (
  member_id uuid primary key references public.family_members(id) on delete cascade,
  -- Dans l'application
  gifts boolean not null default true,        -- Cadeaux d'Amatxi (nouveaux cadeaux et messages)
  events boolean not null default true,       -- Anniversaires et événements
  investments boolean not null default true,  -- Investissements mensuels
  security boolean not null default true,     -- Sécurité du compte
  -- Par e-mail
  email_weekly boolean not null default true, -- Résumé hebdomadaire
  updated_at timestamptz not null default now()
);

alter table public.notification_preferences enable row level security;

-- Un membre lit et gère uniquement ses propres préférences ; l'administrateur peut tout voir.
drop policy if exists "member reads own notification preferences" on public.notification_preferences;
create policy "member reads own notification preferences"
on public.notification_preferences for select to authenticated
using (member_id = public.current_family_member_id() or public.is_cap_family_admin());

drop policy if exists "member manages own notification preferences" on public.notification_preferences;
create policy "member manages own notification preferences"
on public.notification_preferences for all to authenticated
using (member_id = public.current_family_member_id() or public.is_cap_family_admin())
with check (member_id = public.current_family_member_id() or public.is_cap_family_admin());

-- Note : les écritures applicatives passent par la route serveur /api/notification-preferences,
-- protégée par requireFamilyMember() ; le member_id est forcé sur l'identité de l'appelant.
-- Aucune campagne d'e-mail n'est envoyée par ce lot : seules les préférences sont persistées.
