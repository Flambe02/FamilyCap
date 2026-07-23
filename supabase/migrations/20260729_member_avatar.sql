-- Photo de profil par membre : affichee a cote du nom (remplace l'initiale) et modifiable
-- depuis Parametres > Mon compte. Stockage dans le bucket Supabase Storage "avatars" (public
-- en lecture -- le chemin objet est l'id du membre, non enumerable ; l'ecriture ne passe QUE
-- par /api/profile/photo cote serveur, avec la cle service-role -- comme le reste de
-- l'application, cf. lib/auth-server.ts).
--
-- A executer apres 20260728_investment_share_classes.sql dans le SQL Editor Supabase.

alter table public.family_members
  add column if not exists photo_url text;

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do update set public = true;

-- Lecture publique explicite (le bucket est deja public, cette policy est un filet de securite
-- en parite avec le reste des tables). Aucune policy d'ecriture : les uploads/suppressions
-- passent exclusivement par /api/profile/photo, qui contourne la RLS via la cle service-role.
drop policy if exists "avatars public read" on storage.objects;
create policy "avatars public read"
on storage.objects for select
using (bucket_id = 'avatars');
