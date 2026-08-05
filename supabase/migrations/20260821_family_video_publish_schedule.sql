-- Publication programmée + pop-up de bienvenue pour les vidéos « Souvenirs », indépendamment
-- d'un cadeau (family_videos.gift_id reste un lien optionnel, pas un prérequis). Additive et
-- rejouable sans perte de données. Dépend de 20260724_family_videos.sql.
--
-- publish_at   : date/heure à partir de laquelle la vidéo devient visible pour un non-admin.
--                NULL = comportement historique (visible dès is_published = true). Une date
--                future la garde invisible même publiée — permet à l'administrateur de préparer
--                un message à l'avance sans qu'il fuite avant le jour dit.
-- notify_on_login : la vidéo doit déclencher le pop-up automatique à la prochaine connexion de
--                ses destinataires (en plus de rester listée dans Souvenirs). Découplé de
--                gift_id : un message vidéo publié directement (sans cadeau associé) peut aussi
--                surprendre au login, tout comme une vidéo simplement ajoutée à la bibliothèque
--                (gift_id NULL, notify_on_login false par défaut) ne le fera jamais toute seule.

alter table public.family_videos
  add column if not exists publish_at timestamptz,
  add column if not exists notify_on_login boolean not null default false;

comment on column public.family_videos.publish_at is 'Visible pour un non-admin seulement si NULL ou <= now(). NULL = visible dès is_published=true.';
comment on column public.family_videos.notify_on_login is 'Déclenche le pop-up de bienvenue à la prochaine connexion des destinataires.';

create index if not exists family_videos_publish_at_idx on public.family_videos(publish_at);

-- Le prédicat de visibilité doit désormais respecter la programmation : une vidéo publiée mais
-- dont publish_at est dans le futur reste invisible à tout non-administrateur.
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
          )
        )
    );
$$;

grant execute on function public.can_view_video(uuid) to authenticated;
