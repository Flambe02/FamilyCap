-- Une invitation Supabase crée un utilisateur Auth avant que le membre ne choisisse son mot
-- de passe. Cette création ne doit ni activer le compte familial, ni servir de « connexion ».
-- La seule preuve d'une connexion est auth.users.last_sign_in_at.

create or replace function public.link_auth_user_to_family_member()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  linked_member_id uuid;
  linked_role text;
  linked_relationship text;
begin
  select id, role, relationship into linked_member_id, linked_role, linked_relationship
  from public.family_members
  where lower(email) = lower(new.email)
  limit 1;

  if linked_member_id is null then return new; end if;

  update public.family_members as member
  set auth_user_id = new.id,
      access_status = case
        when member.is_active = false then member.access_status
        when new.last_sign_in_at is not null then 'active'
        when exists (select 1 from public.invitations invitation where invitation.member_id = member.id and invitation.status in ('pending', 'sent')) then 'invited'
        else member.access_status
      end,
      last_sign_in_at = case
        when new.last_sign_in_at is not null then new.last_sign_in_at
        else member.last_sign_in_at
      end
  where member.id = linked_member_id;

  insert into public.profiles as profile(user_id, member_id, relationship)
  values (new.id, linked_member_id, linked_relationship)
  on conflict (user_id) do update set member_id = excluded.member_id, relationship = coalesce(excluded.relationship, profile.relationship);

  insert into public.user_roles(user_id, member_id, role)
  values (new.id, linked_member_id, case when lower(new.email) = 'florent.lambert@gmail.com' then 'super_admin' when linked_role = 'admin' then 'admin' when linked_role = 'viewer' then 'viewer' else 'member' end)
  on conflict (user_id) do update set member_id = excluded.member_id, role = excluded.role;

  -- Une confirmation d'e-mail seule ne suffit pas : elle peut être réalisée durant le parcours
  -- d'invitation, sans qu'une connexion à l'application ait encore eu lieu.
  if new.last_sign_in_at is not null then
    update public.invitations
    set status = 'accepted', accepted_at = coalesce(accepted_at, new.last_sign_in_at), updated_at = now()
    where member_id = linked_member_id and status in ('pending', 'sent');
  end if;
  return new;
end;
$$;

-- Répare les valeurs écrites par l'ancien déclencheur (coalesce(last_sign_in_at, now())).
-- Les comptes ayant réellement ouvert une session conservent leur date exacte depuis Auth ; les
-- autres redeviennent « invitation envoyée » tant qu'ils n'ont pas créé leur accès et connecté.
update public.family_members as member
set access_status = case
      when member.is_active = false then member.access_status
      when auth_user.last_sign_in_at is not null then 'active'
      when exists (select 1 from public.invitations invitation where invitation.member_id = member.id and invitation.status in ('pending', 'sent', 'accepted')) then 'invited'
      else 'allowed'
    end,
    last_sign_in_at = auth_user.last_sign_in_at
from auth.users as auth_user
where member.auth_user_id = auth_user.id
  and member.is_active is distinct from false;

-- Les invitations marquées « accepted » par l'ancien déclencheur sans connexion réelle sont
-- restaurées dans l'état attendu. Elles restent expirées si leur durée de validité est dépassée.
update public.invitations as invitation
set status = case when invitation.expires_at is not null and invitation.expires_at <= now() then 'expired' else 'sent' end,
    accepted_at = null,
    updated_at = now()
from public.family_members as member
join auth.users as auth_user on auth_user.id = member.auth_user_id
where invitation.member_id = member.id
  and invitation.status = 'accepted'
  and auth_user.last_sign_in_at is null
  and member.is_active is distinct from false;
