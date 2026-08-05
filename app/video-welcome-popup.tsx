"use client";

// Pop-up « message vidéo qui t'attend », montée une fois par session juste après la connexion
// (family-dashboard.tsx). Réutilise la même donnée que l'onglet Souvenirs (/api/videos, déjà
// filtrée côté serveur) : aucune route dédiée, aucune duplication de la règle de visibilité.
// Ne s'affiche jamais pour l'administrateur ni pour l'aperçu — voir findWelcomePopupVideo().

import { useEffect, useState } from "react";
import type { Viewer } from "../lib/auth-types";
import { useDialogA11y } from "./use-dialog-a11y";
import { fetchVideos, markVideoViewed } from "../lib/videos/videos-client";
import { findWelcomePopupVideo, type VideoRecord, type ViewerContext } from "../lib/videos/video-visibility";
import { buildEmbedUrl, formatDuration, getYouTubeThumbnail } from "../lib/videos/youtube";
import "./souvenirs.css";

export function VideoWelcomePopup({ viewer, isPreview }: { viewer: Viewer; isPreview: boolean }) {
  const [video, setVideo] = useState<VideoRecord | null>(null);

  useEffect(() => {
    if (isPreview || viewer.role === "admin") return;
    let active = true;
    const viewerCtx: ViewerContext = { memberId: viewer.id, name: viewer.name, isAdmin: false };
    void fetchVideos()
      .then(({ videos }) => { if (active) setVideo(findWelcomePopupVideo(videos, viewerCtx)); })
      .catch(() => undefined);
    return () => { active = false; };
    // Un seul contrôle par montage du tableau de bord (donc par connexion) — pas de re-poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!video) return null;
  return <WelcomePlayerModal video={video} onClose={() => setVideo(null)} onPlayed={() => setVideo(null)} />;
}

function WelcomePlayerModal({ video, onClose, onPlayed }: { video: VideoRecord; onClose: () => void; onPlayed: () => void }) {
  const dialogRef = useDialogA11y(true, onClose);
  const [playing, setPlaying] = useState(false);
  const duration = formatDuration(video.durationSeconds);

  function play() {
    setPlaying(true);
    void markVideoViewed(video.id);
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className="modal souvenirs-player-modal souvenirs-welcome-modal" role="dialog" aria-modal="true" aria-labelledby="souvenirs-welcome-title" tabIndex={-1}>
        <header className="souvenirs-player-head">
          <span className="souvenirs-welcome-badge">🎬 Un message vidéo t’attend</span>
          <button type="button" onClick={playing ? onPlayed : onClose} aria-label="Fermer">×</button>
        </header>

        <div className="souvenirs-player-stage">
          {playing ? (
            <iframe
              className="souvenirs-player-frame"
              src={buildEmbedUrl(video.youtubeVideoId, { autoplay: true })}
              title={video.title}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              allowFullScreen
              referrerPolicy="strict-origin-when-cross-origin"
            />
          ) : (
            <button type="button" className="souvenirs-player-poster" onClick={play} aria-label={`Lancer la lecture : ${video.title}`}>
              <img className="souvenirs-player-thumb" src={getYouTubeThumbnail(video.youtubeVideoId, video.thumbnailUrl)} alt="" loading="lazy" />
              <span className="souvenirs-play big" aria-hidden="true">▶</span>
              {duration && <span className="souvenirs-duration" aria-hidden="true">{duration}</span>}
            </button>
          )}
        </div>

        <div className="souvenirs-player-details">
          <h2 id="souvenirs-welcome-title">{video.title}</h2>
          {video.description && <p>{video.description}</p>}
          <p className="souvenirs-welcome-note">Cette vidéo reste disponible dans l’onglet « Souvenirs ».</p>
          {playing && (
            <footer className="souvenirs-player-actions">
              <button type="button" className="primary-button" onClick={onPlayed}>Fermer</button>
            </footer>
          )}
        </div>
      </section>
    </div>
  );
}
