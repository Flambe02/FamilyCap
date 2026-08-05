-- Deux publics de destinataires, VRAIMENT indépendants, pour une même vidéo « Souvenirs » :
-- jusqu'ici family_video_recipients ne portait qu'UNE liste, réutilisée à la fois pour le pop-up
-- de connexion (notify_on_login/notify_all, migrations 20260821/20260823) et pour l'accès à la
-- bibliothèque Souvenirs (visibility_scope='selected_members') — impossible de choisir Thibault
-- pour le pop-up ET Paul pour la bibliothèque : un seul niveau de destinataires existait.
--
-- is_notify  : cette ligne fait partie du public du pop-up (quand notify_on_login=true et
--              notify_all=false).
-- is_library : cette ligne fait partie du public autorisé à consulter la vidéo dans Souvenirs
--              (quand visibility_scope='selected_members').
-- Par défaut TRUE sur les deux : chaque ligne déjà en base représentait jusqu'ici les deux publics
-- à la fois, ce défaut préserve exactement le comportement existant sans réécrire de données.
-- Additive et rejouable. Dépend de 20260724_family_videos.sql.

alter table public.family_video_recipients
  add column if not exists is_notify boolean not null default true,
  add column if not exists is_library boolean not null default true;

comment on column public.family_video_recipients.is_notify is 'Fait partie du public du pop-up de connexion (family_videos.notify_on_login=true, notify_all=false).';
comment on column public.family_video_recipients.is_library is 'Peut consulter la vidéo dans Souvenirs (family_videos.visibility_scope=''selected_members'').';

-- La bibliothèque Souvenirs ne doit compter que les destinataires marqués is_library : un membre
-- ajouté uniquement pour le pop-up (is_notify=true, is_library=false) ne doit pas pouvoir la
-- retrouver ensuite dans Souvenirs via ce chemin RLS.
create or replace function public.can_view_video(target_video_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    public.is_cap_family_admin()
    or exists (
      select 1
      from public.family_videos video
      where video.id = target_video_id
        and video.is_published = true
        and video.is_archived = false
        and (video.publish_at is null or video.publish_at <= now())
        and (
          video.visibility_scope = 'family'
          or exists (
            select 1
            from public.family_video_recipients recipient
            where recipient.video_id = video.id
              and recipient.member_id = public.current_family_member_id()
              and recipient.is_library = true
          )
        )
    );
$$;

grant execute on function public.can_view_video(uuid) to authenticated;
