-- Découple le PUBLIC du pop-up de connexion (notify_on_login) de la portée de la bibliothèque
-- Souvenirs (visibility_scope) : jusqu'ici une vidéo « family » ne pouvait jamais déclencher de
-- pop-up (findWelcomePopupVideo l'excluait par construction), ce qui empêchait d'annoncer un
-- message à toute la famille en pop-up tout en gardant, indépendamment, la bibliothèque Souvenirs
-- ouverte à tous ou restreinte aux destinataires choisis. Additive et rejouable. Dépend de
-- 20260821_family_video_publish_schedule.sql (notify_on_login).
--
-- notify_all : quand notify_on_login = true, précise QUI reçoit le pop-up —
--   false (défaut) = seulement les destinataires de family_video_recipients (comportement
--                    historique, inchangé) ;
--   true            = chaque membre actif de la famille, une fois, à sa prochaine connexion —
--                    indépendamment de visibility_scope, qui continue de ne régir QUE l'accès à
--                    la bibliothèque Souvenirs après coup (un membre notifié en pop-up peut donc
--                    perdre l'accès à la vidéo dans Souvenirs si visibility_scope reste
--                    'selected_members' et qu'il n'est pas destinataire — c'est voulu : les deux
--                    réglages sont indépendants).

alter table public.family_videos
  add column if not exists notify_all boolean not null default false;

comment on column public.family_videos.notify_all is 'Avec notify_on_login=true : pop-up pour tous les membres actifs (true) ou seulement les destinataires (false, défaut). Indépendant de visibility_scope.';
