-- Espace « Souvenirs » : vidéos familiales hébergées sur YouTube. Supabase ne stocke que les
-- métadonnées, les destinataires, les droits d'accès, l'occasion et l'état de publication —
-- jamais le fichier vidéo. Additive et rejouable sans perte de données. À exécuter après les
-- migrations 20260716_* / 20260718_investment_access.sql (dépend de public.family_members,
-- public.gift_records, public.current_family_member_id(), public.is_cap_family_admin()).
--
-- Aucune donnée de cadeau n'est dupliquée : le montant € / la quantité BTC / l'occasion du
-- cadeau associé sont lus par la relation family_videos.gift_id -> gift_records.

-- 1) Métadonnées vidéo. Application mono-famille : la frontière « autre famille » se réduit à
--    « membre actif authentifié » ; il n'existe pas de table families / family_id dans ce schéma.
create table if not exists public.family_videos (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  youtube_url text not null,
  youtube_video_id text not null,
  thumbnail_url text,
  duration_seconds integer check (duration_seconds is null or duration_seconds >= 0),
  occasion_type text not null default 'general' check (occasion_type in ('birthday', 'christmas', 'general', 'other')),
  occasion_date date,
  visibility_scope text not null default 'family' check (visibility_scope in ('private', 'selected_members', 'family')),
  gift_id uuid references public.gift_records(id) on delete set null,
  created_by uuid references public.family_members(id) on delete set null,
  is_published boolean not null default false,
  published_at timestamptz,
  is_archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 2) Destinataires (une vidéo peut viser une ou plusieurs personnes). Une vidéo `family`
--    n'a pas besoin d'une ligne par membre : la portée `family` suffit à l'autoriser à tous.
create table if not exists public.family_video_recipients (
  video_id uuid not null references public.family_videos(id) on delete cascade,
  member_id uuid not null references public.family_members(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (video_id, member_id)
);

-- 3) Suivi de lecture : une ligne par vidéo et par membre (badge « Nouveau », tri des non-vues).
--    Le compteur est incrémenté à l'ouverture réelle, jamais à chaque rendu React.
create table if not exists public.family_video_views (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references public.family_videos(id) on delete cascade,
  viewer_member_id uuid not null references public.family_members(id) on delete cascade,
  first_viewed_at timestamptz not null default now(),
  last_viewed_at timestamptz not null default now(),
  view_count integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (video_id, viewer_member_id)
);

-- Index sur les colonnes filtrées / jointes.
create index if not exists family_videos_published_idx on public.family_videos(is_published, is_archived, occasion_date desc, published_at desc);
create index if not exists family_videos_occasion_idx on public.family_videos(occasion_type);
create index if not exists family_videos_video_id_idx on public.family_videos(youtube_video_id);
create index if not exists family_videos_gift_idx on public.family_videos(gift_id);
create index if not exists family_video_recipients_member_idx on public.family_video_recipients(member_id);
create index if not exists family_video_views_viewer_idx on public.family_video_views(viewer_member_id);

alter table public.family_videos enable row level security;
alter table public.family_video_recipients enable row level security;
alter table public.family_video_views enable row level security;

-- Prédicat de visibilité d'une vidéo pour l'appelant, aligné sur la règle applicative :
--   - administrateur      -> toutes les vidéos, brouillons compris ;
--   - membre / lecteur     -> vidéo publiée non archivée ET (portée `family`
--                             OU l'appelant figure parmi les destinataires).
-- Les brouillons et les vidéos dépubliées ne sont donc jamais visibles hors administrateur.
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

-- family_videos : lecture selon can_view_video ; gestion réservée à l'administrateur.
drop policy if exists "member reads visible videos" on public.family_videos;
create policy "member reads visible videos"
on public.family_videos for select to authenticated
using (public.can_view_video(id));

drop policy if exists "admin manages videos" on public.family_videos;
create policy "admin manages videos"
on public.family_videos for all to authenticated
using (public.is_cap_family_admin())
with check (public.is_cap_family_admin());

-- family_video_recipients : un membre ne lit les destinataires que d'une vidéo qu'il peut voir ;
-- l'administrateur gère l'ensemble.
drop policy if exists "member reads recipients of visible videos" on public.family_video_recipients;
create policy "member reads recipients of visible videos"
on public.family_video_recipients for select to authenticated
using (public.can_view_video(video_id));

drop policy if exists "admin manages video recipients" on public.family_video_recipients;
create policy "admin manages video recipients"
on public.family_video_recipients for all to authenticated
using (public.is_cap_family_admin())
with check (public.is_cap_family_admin());

-- family_video_views : chacun ne lit et n'écrit QUE ses propres événements de lecture
-- (l'administrateur peut lire à des fins de statistiques, mais n'écrit pas au nom d'autrui).
drop policy if exists "member reads own video views" on public.family_video_views;
create policy "member reads own video views"
on public.family_video_views for select to authenticated
using (viewer_member_id = public.current_family_member_id() or public.is_cap_family_admin());

drop policy if exists "member writes own video views" on public.family_video_views;
create policy "member writes own video views"
on public.family_video_views for all to authenticated
using (viewer_member_id = public.current_family_member_id())
with check (viewer_member_id = public.current_family_member_id());
