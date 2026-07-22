"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Viewer } from "../lib/auth-types";
import { FAMILY_MEMBERS } from "../lib/family-roster";
import { useDialogA11y } from "./use-dialog-a11y";
import { requestGiftsApi } from "../lib/gifts-client";
import {
  archiveVideo,
  fetchVideos,
  markVideoViewed,
  saveVideo,
  setVideoPublished,
  type VideoSavePayload,
} from "../lib/videos/videos-client";
import {
  availableYears,
  canMemberViewVideo,
  countByTab,
  filterVideos,
  OCCASION_LABEL,
  OCCASION_TABS,
  sortVideos,
  type OccasionTabKey,
  type OccasionType,
  type SortKey,
  type VideoFilters,
  type VideoRecord,
  type ViewerContext,
  type VisibilityScope,
} from "../lib/videos/video-visibility";
import { buildEmbedUrl, formatDuration, getYouTubeThumbnail, parseYouTube } from "../lib/videos/youtube";
import "./souvenirs.css";

const euro = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });
const cardDate = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const longDate = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

const OCCASION_BADGE: Record<OccasionType, { label: string; className: string; icon: string }> = {
  birthday: { label: "Anniversaire", className: "birthday", icon: "🎂" },
  christmas: { label: "Noël", className: "christmas", icon: "🎄" },
  general: { label: "Message général", className: "general", icon: "💬" },
  other: { label: "Autre", className: "other", icon: "✨" },
};

function formatDate(value: string | null, formatter: Intl.DateTimeFormat): string | null {
  if (!value) return null;
  const date = new Date(value.length <= 10 ? value + "T00:00:00Z" : value);
  return Number.isFinite(date.getTime()) ? formatter.format(date) : null;
}

function recipientLabel(video: VideoRecord): string {
  if (video.visibilityScope === "family") return "Toute la famille";
  const names = video.recipients.map((recipient) => recipient.name).filter((name): name is string => Boolean(name));
  return names.length > 0 ? names.join(", ") : "Message général";
}

function giftLabel(gift: NonNullable<VideoRecord["gift"]>): string {
  return `${euro.format(gift.amountEur)} · ${gift.btcAmount.toFixed(8)} BTC`;
}

export function SouvenirsPage({ viewer, isPreview, onOpenGiftMember }: { viewer: Viewer; isPreview: boolean; onOpenGiftMember?: (member: string) => void }) {
  const isAdmin = viewer.role === "admin";
  const canManage = isAdmin && !isPreview;
  const viewerCtx: ViewerContext = useMemo(
    () => ({ memberId: isPreview ? null : viewer.id, name: viewer.name, isAdmin: isAdmin && !isPreview }),
    [isAdmin, isPreview, viewer.id, viewer.name],
  );

  const [videos, setVideos] = useState<VideoRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [feedback, setFeedback] = useState("");

  const [recipient, setRecipient] = useState("Tous");
  const [occasion, setOccasion] = useState("Toutes");
  const [year, setYear] = useState("Toutes");
  const [tab, setTab] = useState<OccasionTabKey>("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("default");

  // Taille de page figée au montage (9 desktop / 6 mobile) — lue une seule fois, pas un ref en rendu.
  const [pageSize] = useState(() => (typeof window !== "undefined" && window.matchMedia("(max-width: 780px)").matches ? 6 : 9));
  const [visibleCount, setVisibleCount] = useState(pageSize);
  const resetPage = useCallback(() => setVisibleCount(pageSize), [pageSize]);

  const [detail, setDetail] = useState<VideoRecord | null>(null);
  const [adminModal, setAdminModal] = useState<"create" | VideoRecord | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    const result = await fetchVideos(signal);
    setAvailable(result.available);
    setVideos(result.videos);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void load(controller.signal)
        .then(() => { if (!controller.signal.aborted) setLoadError(""); })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          setLoadError(error instanceof Error ? error.message : "Impossible de charger les vidéos.");
        })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [load]);

  // Recherche debouncée (250 ms) ; la galerie repart en tête à chaque nouveau terme.
  useEffect(() => {
    const timer = window.setTimeout(() => { setSearch(searchInput); resetPage(); }, 250);
    return () => window.clearTimeout(timer);
  }, [searchInput, resetPage]);

  async function reload() {
    try { await load(); } catch (error) { setLoadError(error instanceof Error ? error.message : "Impossible de charger les vidéos."); }
  }

  // Périmètre autorisé pour l'observateur (sécurité serveur déjà appliquée ; ici on scope aussi
  // l'aperçu admin au membre simulé, par prénom).
  const scoped = useMemo(() => videos.filter((video) => canMemberViewVideo(video, viewerCtx)), [videos, viewerCtx]);
  const counts = useMemo(() => countByTab(scoped), [scoped]);
  const years = useMemo(() => availableYears(scoped), [scoped]);
  const recipientOptions = useMemo(() => {
    if (!isAdmin) return ["Tous", "Moi", "Toute la famille"];
    const names = [...new Set(scoped.flatMap((video) => video.recipients.map((r) => r.name).filter((n): n is string => Boolean(n))))].sort();
    return ["Tous", "Toute la famille", ...names];
  }, [isAdmin, scoped]);

  const filtered = useMemo(() => {
    const filters: VideoFilters = { recipient, occasion, year, tab, search };
    return sortVideos(filterVideos(scoped, filters, viewerCtx), sort);
  }, [scoped, recipient, occasion, year, tab, search, sort, viewerCtx]);
  const paged = filtered.slice(0, visibleCount);

  function resetFilters() {
    setRecipient("Tous"); setOccasion("Toutes"); setYear("Toutes"); setTab("all"); setSearchInput(""); setSearch(""); resetPage();
  }

  function openDetail(video: VideoRecord) {
    setDetail(video);
    if (!isPreview && !video.viewed) {
      setVideos((current) => current.map((item) => (item.id === video.id ? { ...item, viewed: true } : item)));
      void markVideoViewed(video.id);
    }
  }

  async function handleSaved(message: string) {
    setAdminModal(null);
    setFeedback(message);
    window.setTimeout(() => setFeedback(""), 3200);
    await reload();
  }

  async function togglePublish(video: VideoRecord) {
    try {
      await setVideoPublished(video.id, !video.isPublished);
      setFeedback(video.isPublished ? "Vidéo dépubliée." : "Vidéo publiée.");
      window.setTimeout(() => setFeedback(""), 3200);
      await reload();
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Action impossible.");
      window.setTimeout(() => setFeedback(""), 3200);
    }
  }

  async function handleArchive(video: VideoRecord) {
    try {
      await archiveVideo(video.id);
      setDetail(null);
      setFeedback("Vidéo archivée.");
      window.setTimeout(() => setFeedback(""), 3200);
      await reload();
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Archivage impossible.");
      window.setTimeout(() => setFeedback(""), 3200);
    }
  }

  const title = isAdmin ? "Vidéos d’Amatxi" : "Mes souvenirs";

  return (
    <div className="page-stack souvenirs-page">
      <section className="panel souvenirs-head">
        <div className="souvenirs-head-main">
          <span className="soft-pill">SOUVENIRS</span>
          <h2>{title}</h2>
          <p>Retrouvez les messages vidéo pour les anniversaires, Noël et les autres moments de la famille.</p>
        </div>
        {canManage && (
          <button type="button" className="primary-button souvenirs-add" onClick={() => setAdminModal("create")}>
            <span aria-hidden="true">＋</span> Ajouter une vidéo
          </button>
        )}
      </section>

      {!available ? (
        <section className="panel souvenirs-empty">
          <h3>Espace vidéo à activer</h3>
          <p>La migration Supabase <code>20260724_family_videos.sql</code> doit être exécutée pour afficher les souvenirs.</p>
        </section>
      ) : (
        <>
          <section className="panel souvenirs-controls" aria-label="Filtres des vidéos">
            <div className="souvenirs-filters">
              <label className="souvenirs-field">
                <span>Destinataire</span>
                <select value={recipient} onChange={(event) => { setRecipient(event.target.value); resetPage(); }}>
                  {recipientOptions.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
              </label>
              <label className="souvenirs-field">
                <span>Occasion</span>
                <select value={occasion} onChange={(event) => { setOccasion(event.target.value); resetPage(); }}>
                  <option value="Toutes">Toutes</option>
                  <option value="birthday">Anniversaire</option>
                  <option value="christmas">Noël</option>
                  <option value="general">Message général</option>
                  <option value="other">Autre</option>
                </select>
              </label>
              <label className="souvenirs-field">
                <span>Année</span>
                <select value={year} onChange={(event) => { setYear(event.target.value); resetPage(); }}>
                  <option value="Toutes">Toutes</option>
                  {years.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              <label className="souvenirs-field souvenirs-field-search">
                <span>Recherche</span>
                <input type="search" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="Rechercher une vidéo…" aria-label="Rechercher une vidéo" />
              </label>
              <label className="souvenirs-field souvenirs-field-sort">
                <span>Tri</span>
                <select value={sort} onChange={(event) => { setSort(event.target.value as SortKey); resetPage(); }}>
                  <option value="default">Non vues d’abord</option>
                  <option value="recent">Plus récentes</option>
                  <option value="oldest">Plus anciennes</option>
                  <option value="birthday">Anniversaires</option>
                  <option value="christmas">Noël</option>
                </select>
              </label>
            </div>

            <div className="souvenirs-tabs" role="tablist" aria-label="Filtrer par occasion">
              {OCCASION_TABS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  role="tab"
                  aria-selected={tab === item.key}
                  className={tab === item.key ? "active" : ""}
                  onClick={() => { setTab(item.key); resetPage(); }}
                >
                  {item.label} <em>{counts[item.key]}</em>
                </button>
              ))}
            </div>
          </section>

          <section className="panel souvenirs-gallery-panel" aria-label="Galerie de souvenirs">
            {loading ? (
              <div className="souvenirs-grid" aria-hidden="true">
                {Array.from({ length: pageSize }).map((_, index) => <div className="souvenirs-skeleton" key={index} />)}
              </div>
            ) : loadError ? (
              <div className="souvenirs-state">
                <p>Impossible de charger les vidéos.</p>
                <button type="button" className="primary-button" onClick={() => void reload()}>Réessayer</button>
              </div>
            ) : scoped.length === 0 ? (
              <EmptyState isAdmin={isAdmin} onAdd={canManage ? () => setAdminModal("create") : undefined} />
            ) : filtered.length === 0 ? (
              <div className="souvenirs-state">
                <p>Aucune vidéo ne correspond à ces filtres.</p>
                <button type="button" className="souvenirs-ghost-button" onClick={resetFilters}>Réinitialiser les filtres</button>
              </div>
            ) : (
              <>
                <div className="souvenirs-grid">
                  {paged.map((video) => (
                    <VideoCard key={video.id} video={video} canManage={canManage} onOpen={() => openDetail(video)} onTogglePublish={() => void togglePublish(video)} onEdit={() => setAdminModal(video)} />
                  ))}
                </div>
                {filtered.length > paged.length && (
                  <div className="souvenirs-more">
                    <button type="button" className="souvenirs-ghost-button" onClick={() => setVisibleCount((count) => count + pageSize)}>
                      Afficher plus ({filtered.length - paged.length})
                    </button>
                  </div>
                )}
              </>
            )}
          </section>
        </>
      )}

      {detail && (
        <VideoPlayerModal
          video={detail}
          isAdmin={isAdmin}
          canManage={canManage}
          onClose={() => setDetail(null)}
          onEdit={() => { setAdminModal(detail); setDetail(null); }}
          onArchive={() => void handleArchive(detail)}
          onOpenGiftMember={onOpenGiftMember}
        />
      )}

      {adminModal && canManage && (
        <VideoAdminModal
          editing={adminModal === "create" ? null : adminModal}
          onClose={() => setAdminModal(null)}
          onSaved={handleSaved}
        />
      )}

      {feedback && <div className="toast" role="status">✓ {feedback}</div>}
    </div>
  );
}

function EmptyState({ isAdmin, onAdd }: { isAdmin: boolean; onAdd?: () => void }) {
  return (
    <div className="souvenirs-state souvenirs-empty-state">
      <span className="souvenirs-empty-icon" aria-hidden="true">🎬</span>
      {isAdmin ? (
        <>
          <h3>Aucune vidéo publiée</h3>
          <p>Ajoutez le premier message vidéo de la famille.</p>
          {onAdd && <button type="button" className="primary-button" onClick={onAdd}>Ajouter une vidéo</button>}
        </>
      ) : (
        <>
          <h3>Aucun souvenir vidéo pour le moment</h3>
          <p>Les prochains messages d’Amatxi apparaîtront ici.</p>
        </>
      )}
    </div>
  );
}

function Thumbnail({ video, className }: { video: VideoRecord; className?: string }) {
  const [failed, setFailed] = useState(false);
  const src = getYouTubeThumbnail(video.youtubeVideoId, video.thumbnailUrl);
  if (failed) {
    return <div className={`souvenirs-thumb-fallback ${className ?? ""}`.trim()} role="img" aria-label="Vidéo indisponible"><span>Cette vidéo n’est plus disponible sur YouTube.</span></div>;
  }
  return <img className={className} src={src} alt={`Miniature de la vidéo : ${video.title}`} loading="lazy" onError={() => setFailed(true)} />;
}

function VideoCard({ video, canManage, onOpen, onTogglePublish, onEdit }: {
  video: VideoRecord;
  canManage: boolean;
  onOpen: () => void;
  onTogglePublish: () => void;
  onEdit: () => void;
}) {
  const badge = OCCASION_BADGE[video.occasionType];
  const duration = formatDuration(video.durationSeconds);
  const date = formatDate(video.occasionDate, cardDate);
  const isNew = !video.viewed;
  return (
    <article className={`souvenirs-card${video.isPublished ? "" : " draft"}`}>
      <button type="button" className="souvenirs-card-media" onClick={onOpen} aria-label={`Lire la vidéo : ${video.title}`}>
        <Thumbnail video={video} className="souvenirs-card-thumb" />
        <span className={`souvenirs-badge ${badge.className}`}><span aria-hidden="true">{badge.icon}</span> {badge.label}</span>
        {isNew && <span className="souvenirs-new" aria-label="Nouvelle vidéo, jamais vue">Nouveau</span>}
        <span className="souvenirs-play" aria-hidden="true">▶</span>
        {duration && <span className="souvenirs-duration" aria-hidden="true">{duration}</span>}
        {!video.isPublished && <span className="souvenirs-draft-flag">Brouillon</span>}
      </button>
      <div className="souvenirs-card-body">
        <button type="button" className="souvenirs-card-title" onClick={onOpen}>{video.title}</button>
        <p className="souvenirs-card-recipient">{recipientLabel(video)}</p>
        {video.gift && <p className="souvenirs-card-gift">{giftLabel(video.gift)}</p>}
        <div className="souvenirs-card-foot">
          {date && <time>{date}</time>}
          {video.visibilityScope !== "family" && <span className="souvenirs-scope-chip">Privé</span>}
        </div>
        {canManage && (
          <div className="souvenirs-card-admin">
            <button type="button" onClick={onEdit}>Modifier</button>
            <button type="button" onClick={onTogglePublish}>{video.isPublished ? "Dépublier" : "Publier"}</button>
          </div>
        )}
      </div>
    </article>
  );
}

function VideoPlayerModal({ video, isAdmin, canManage, onClose, onEdit, onArchive, onOpenGiftMember }: {
  video: VideoRecord;
  isAdmin: boolean;
  canManage: boolean;
  onClose: () => void;
  onEdit: () => void;
  onArchive: () => void;
  onOpenGiftMember?: (member: string) => void;
}) {
  const dialogRef = useDialogA11y(true, onClose);
  // L'iframe n'est montée qu'après un clic explicite sur « Lire » (autoplay alors autorisé).
  const [playing, setPlaying] = useState(false);
  const badge = OCCASION_BADGE[video.occasionType];
  const date = formatDate(video.occasionDate, longDate);
  const duration = formatDuration(video.durationSeconds);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className="modal souvenirs-player-modal" role="dialog" aria-modal="true" aria-labelledby="souvenirs-player-title" tabIndex={-1}>
        <header className="souvenirs-player-head">
          <span className={`souvenirs-badge ${badge.className}`}><span aria-hidden="true">{badge.icon}</span> {badge.label}</span>
          <button type="button" onClick={onClose} aria-label="Fermer la vidéo">×</button>
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
            <button type="button" className="souvenirs-player-poster" onClick={() => setPlaying(true)} aria-label={`Lancer la lecture : ${video.title}`}>
              <Thumbnail video={video} className="souvenirs-player-thumb" />
              <span className="souvenirs-play big" aria-hidden="true">▶</span>
              {duration && <span className="souvenirs-duration" aria-hidden="true">{duration}</span>}
            </button>
          )}
        </div>

        <div className="souvenirs-player-details">
          <h2 id="souvenirs-player-title">{video.title}</h2>
          <dl className="souvenirs-detail-grid">
            <div><dt>Occasion</dt><dd>{OCCASION_LABEL[video.occasionType]}</dd></div>
            <div><dt>Destinataire</dt><dd>{recipientLabel(video)}</dd></div>
            {date && <div><dt>Date</dt><dd>{date}</dd></div>}
            {duration && <div><dt>Durée</dt><dd>{duration}</dd></div>}
            {video.gift && (
              <div className="span-2">
                <dt>Cadeau associé</dt>
                <dd>
                  {giftLabel(video.gift)}
                  {video.gift.memberName && <> — {video.gift.memberName}{video.gift.occasion ? ` · ${video.gift.occasion}` : ""}</>}
                  {onOpenGiftMember && video.gift.memberName && (
                    <button type="button" className="souvenirs-gift-link" onClick={() => onOpenGiftMember(video.gift!.memberName!)}>Voir le cadeau →</button>
                  )}
                </dd>
              </div>
            )}
            {video.description && <div className="span-2"><dt>Message</dt><dd>{video.description}</dd></div>}
          </dl>

          {isAdmin && (
            <p className="souvenirs-admin-note">Une vidéo YouTube non répertoriée reste accessible à toute personne disposant du lien.</p>
          )}
          {canManage && (
            <div className="souvenirs-player-actions">
              <button type="button" className="souvenirs-ghost-button" onClick={onEdit}>Modifier</button>
              <button type="button" className="souvenirs-danger-button" onClick={onArchive}>Archiver</button>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

type GiftOption = { id: string; label: string; memberName: string };

function VideoAdminModal({ editing, onClose, onSaved }: { editing: VideoRecord | null; onClose: () => void; onSaved: (message: string) => Promise<void> }) {
  const dialogRef = useDialogA11y(true, onClose);
  const [title, setTitle] = useState(editing?.title ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [youtubeUrl, setYoutubeUrl] = useState(editing?.youtubeUrl ?? "");
  const [thumbnailUrl, setThumbnailUrl] = useState(editing?.thumbnailUrl ?? "");
  const [duration, setDuration] = useState(editing?.durationSeconds ? String(editing.durationSeconds) : "");
  const [occasionType, setOccasionType] = useState<OccasionType>(editing?.occasionType ?? "birthday");
  const [occasionDate, setOccasionDate] = useState(editing?.occasionDate ?? "");
  const [scope, setScope] = useState<VisibilityScope>(editing?.visibilityScope ?? "family");
  const [recipients, setRecipients] = useState<string[]>(editing?.recipients.map((r) => r.name).filter((n): n is string => Boolean(n)) ?? []);
  const [giftId, setGiftId] = useState(editing?.giftId ?? "");
  const [publish, setPublish] = useState(editing?.isPublished ?? false);
  const [giftOptions, setGiftOptions] = useState<GiftOption[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const parsed = parseYouTube(youtubeUrl);
  const urlTouched = youtubeUrl.trim() !== "";

  useEffect(() => {
    let active = true;
    void requestGiftsApi<{ records?: Array<{ id: string; member_name: string; occasion: string; gift_date: string; amount_eur: number | string }> }>("/api/gifts")
      .then((result) => {
        if (!active) return;
        const options = (result.records ?? []).map((record) => ({
          id: record.id,
          memberName: record.member_name,
          label: `${record.member_name} · ${record.occasion} ${record.gift_date.slice(0, 4)} · ${euro.format(Number(record.amount_eur))}`,
        }));
        setGiftOptions(options);
      })
      .catch(() => setGiftOptions([]));
    return () => { active = false; };
  }, []);

  function toggleRecipient(name: string) {
    setRecipients((current) => (current.includes(name) ? current.filter((item) => item !== name) : [...current, name]));
  }

  const selectedGift = giftOptions.find((option) => option.id === giftId);
  const giftMismatch = selectedGift && scope !== "family" && recipients.length > 0 && !recipients.includes(selectedGift.memberName);

  async function submit(asPublished: boolean) {
    setError("");
    if (!title.trim()) { setError("Le titre est obligatoire."); return; }
    if (!parsed) { setError("L’URL YouTube est invalide."); return; }
    if (scope !== "family" && recipients.length === 0) { setError("Sélectionnez au moins un destinataire, ou choisissez « toute la famille »."); return; }
    const payload: VideoSavePayload = {
      id: editing?.id,
      title: title.trim(),
      description: description.trim() || null,
      youtubeUrl: youtubeUrl.trim(),
      thumbnailUrl: thumbnailUrl.trim() || null,
      durationSeconds: duration.trim() ? Number(duration) : null,
      occasionType,
      occasionDate: occasionDate || null,
      visibilityScope: scope,
      recipientNames: scope === "family" ? [] : recipients,
      giftId: giftId || null,
      publish: asPublished,
    };
    setSaving(true);
    try {
      await saveVideo(payload);
      await onSaved(editing ? "Vidéo mise à jour." : asPublished ? "Vidéo publiée." : "Brouillon enregistré.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Enregistrement impossible.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className="modal souvenirs-admin-modal" role="dialog" aria-modal="true" aria-labelledby="souvenirs-admin-title" tabIndex={-1}>
        <header className="souvenirs-admin-head">
          <h2 id="souvenirs-admin-title">{editing ? "Modifier la vidéo" : "Ajouter une vidéo"}</h2>
          <button type="button" onClick={onClose} aria-label="Fermer">×</button>
        </header>

        <form className="souvenirs-admin-form" onSubmit={(event) => { event.preventDefault(); void submit(publish); }}>
          <fieldset>
            <legend>Informations</legend>
            <label>Titre<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={140} required /></label>
            <label>Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} /></label>
            <label>URL YouTube<input value={youtubeUrl} onChange={(event) => setYoutubeUrl(event.target.value)} placeholder="https://www.youtube.com/watch?v=…" /></label>
            {urlTouched && !parsed && <p className="souvenirs-admin-warn" role="alert">URL YouTube non reconnue.</p>}
            {parsed && (
              <div className="souvenirs-admin-preview">
                <img src={getYouTubeThumbnail(parsed.videoId, thumbnailUrl)} alt="Aperçu de la miniature" loading="lazy" />
                <span>Miniature calculée automatiquement.</span>
              </div>
            )}
            <div className="souvenirs-admin-row">
              <label>Durée (secondes, facultatif)<input type="number" min={0} value={duration} onChange={(event) => setDuration(event.target.value)} /></label>
              <label>Miniature personnalisée (facultatif)<input value={thumbnailUrl} onChange={(event) => setThumbnailUrl(event.target.value)} placeholder="https://…" /></label>
            </div>
          </fieldset>

          <fieldset>
            <legend>Occasion</legend>
            <div className="souvenirs-admin-chips" role="radiogroup" aria-label="Occasion">
              {(["birthday", "christmas", "general", "other"] as OccasionType[]).map((type) => (
                <button key={type} type="button" role="radio" aria-checked={occasionType === type} className={occasionType === type ? "active" : ""} onClick={() => setOccasionType(type)}>
                  {OCCASION_BADGE[type].icon} {OCCASION_LABEL[type]}
                </button>
              ))}
            </div>
            <label>Date de l’occasion (facultatif)<input type="date" value={occasionDate} onChange={(event) => setOccasionDate(event.target.value)} /></label>
          </fieldset>

          <fieldset>
            <legend>Destinataires</legend>
            <div className="souvenirs-admin-chips" role="radiogroup" aria-label="Portée">
              <button type="button" role="radio" aria-checked={scope === "family"} className={scope === "family" ? "active" : ""} onClick={() => setScope("family")}>👨‍👩‍👧‍👦 Toute la famille</button>
              <button type="button" role="radio" aria-checked={scope === "selected_members"} className={scope === "selected_members" ? "active" : ""} onClick={() => setScope("selected_members")}>🎯 Certaines personnes</button>
            </div>
            {scope !== "family" && (
              <div className="souvenirs-admin-recipients">
                {FAMILY_MEMBERS.map((member) => (
                  <label key={member.name} className={recipients.includes(member.name) ? "active" : ""}>
                    <input type="checkbox" checked={recipients.includes(member.name)} onChange={() => toggleRecipient(member.name)} />
                    {member.name}
                  </label>
                ))}
              </div>
            )}
          </fieldset>

          <fieldset>
            <legend>Association facultative</legend>
            <label>Cadeau lié
              <select value={giftId} onChange={(event) => setGiftId(event.target.value)}>
                <option value="">Aucun cadeau</option>
                {giftOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
            </label>
            {giftMismatch && <p className="souvenirs-admin-warn" role="alert">Attention : ce cadeau appartient à {selectedGift?.memberName}, absent des destinataires sélectionnés.</p>}
          </fieldset>

          <fieldset>
            <legend>Publication</legend>
            <div className="souvenirs-admin-chips" role="radiogroup" aria-label="Publication">
              <button type="button" role="radio" aria-checked={!publish} className={!publish ? "active" : ""} onClick={() => setPublish(false)}>Brouillon</button>
              <button type="button" role="radio" aria-checked={publish} className={publish ? "active" : ""} onClick={() => setPublish(true)}>Publiée</button>
            </div>
            <p className="souvenirs-admin-note">Une vidéo YouTube non répertoriée reste accessible à toute personne disposant du lien.</p>
          </fieldset>

          {error && <p className="souvenirs-admin-error" role="alert">{error}</p>}

          <footer className="souvenirs-admin-actions">
            <button type="button" className="souvenirs-ghost-button" onClick={onClose} disabled={saving}>Annuler</button>
            <button type="submit" className="primary-button" disabled={saving}>
              {saving ? "Enregistrement…" : publish ? "Publier la vidéo" : "Enregistrer le brouillon"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
