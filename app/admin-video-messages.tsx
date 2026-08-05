"use client";

// Sous-onglet Administration « Messages vidéo » : gère TOUTE vidéo ciblée (`selected_members`),
// quelle que soit son origine — publiée ici, liée à un cadeau (gift-portfolio.tsx /
// transactions.tsx), ou ajoutée depuis la bibliothèque Souvenirs (souvenirs.tsx). Une seule liste,
// une seule source de vérité (/api/videos), pour que rien ne semble « manquant » selon l'écran
// d'où la vidéo a été créée. `notifyOnLogin: true` déclenche le pop-up de bienvenue
// (lib/videos/video-visibility::findWelcomePopupVideo) ; `publishAt` (facultatif) reporte la
// visibilité réelle à une date future sans rien exposer avant.

import { FormEvent, useCallback, useEffect, useState } from "react";
import { FAMILY_MEMBERS } from "../lib/family-roster";
import { archiveVideo, fetchVideos, saveVideo, setVideoPublished } from "../lib/videos/videos-client";
import { extractYouTubeVideoId } from "../lib/videos/youtube";
import type { OccasionType, VideoRecord, VisibilityScope } from "../lib/videos/video-visibility";
import "./admin-video-messages.css";

const dateFormatter = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric" });

// Les 3 choix affichés ici correspondent EXACTEMENT aux 3 onglets de l'écran Souvenirs
// (souvenirs.tsx::OCCASION_TABS) : « other » n'est jamais produit par ce formulaire, seul
// « general » couvre le troisième onglet (« Autres occasions »), pour que la segmentation
// corresponde toujours à ce que l'admin a choisi ici.
const OCCASION_CHOICES: Array<{ id: OccasionType; label: string; icon: string }> = [
  { id: "birthday", label: "Anniversaire", icon: "🎂" },
  { id: "christmas", label: "Noël", icon: "🎄" },
  { id: "general", label: "Autres occasions", icon: "💬" },
];

function namesOf(video: VideoRecord, kind: "isLibrary" | "isNotify"): string[] {
  return video.recipients.filter((recipient) => recipient[kind]).map((recipient) => recipient.name).filter((name): name is string => Boolean(name));
}

function fieldsOf(video: VideoRecord) {
  return {
    title: video.title,
    description: video.description,
    youtubeUrl: video.youtubeUrl,
    thumbnailUrl: video.thumbnailUrl,
    durationSeconds: video.durationSeconds,
    occasionType: video.occasionType,
    occasionDate: video.occasionDate,
    visibilityScope: video.visibilityScope,
    recipientNames: namesOf(video, "isLibrary"),
    notifyRecipientNames: namesOf(video, "isNotify"),
    giftId: video.giftId,
    publishAt: video.publishAt,
    notifyOnLogin: video.notifyOnLogin,
    notifyAll: video.notifyAll,
  };
}

export function AdminVideoMessages() {
  // Lu une seule fois au montage (pas un appel impur en rendu) — cohérent avec le même besoin
  // dans gift-portfolio.tsx.
  const [nowTimestamp] = useState(() => Date.now());
  // Deux réglages INDÉPENDANTS, jamais par défaut élargis sans le vouloir — et chacun avec sa
  // PROPRE liste de destinataires (deux niveaux distincts, pas un seul partagé) :
  //  - `notifyAll` + `notifyRecipients` : qui reçoit le pop-up à la connexion (destinataires
  //    choisis, ou tout le monde) ;
  //  - `scope` + `libraryRecipients` : qui peut ensuite retrouver la vidéo dans l'onglet
  //    Souvenirs (destinataires choisis — pas forcément les mêmes que ceux du pop-up — ou toute
  //    la famille).
  // Un message peut par exemple surprendre seulement Thibault en pop-up tout en restant visible
  // par toute la famille dans Souvenirs ensuite, ou surprendre toute la famille en pop-up tout en
  // ne laissant la vidéo, ensuite, que dans la bibliothèque de Paul.
  const [notifyAll, setNotifyAll] = useState(false);
  const [notifyRecipients, setNotifyRecipients] = useState<string[]>([]);
  const [scope, setScope] = useState<VisibilityScope>("selected_members");
  const [libraryRecipients, setLibraryRecipients] = useState<string[]>([]);
  const showNotifyRecipients = !notifyAll;
  const showLibraryRecipients = scope === "selected_members";
  const [occasionType, setOccasionType] = useState<OccasionType>("general");
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [message, setMessage] = useState("");
  const [publishDate, setPublishDate] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingOriginal, setEditingOriginal] = useState<VideoRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [rowBusyId, setRowBusyId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const [sent, setSent] = useState<VideoRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const { videos } = await fetchVideos();
    // Toute vidéo ciblée OU toute la famille, quelle que soit son origine (cadeau, bibliothèque,
    // ce formulaire) — sinon une vidéo créée ailleurs semble manquante ici alors qu'elle existe
    // bel et bien. `private` (jamais produit par cette UI) reste exclu.
    setSent(
      videos
        .filter((video) => video.visibilityScope === "selected_members" || video.visibilityScope === "family")
        .sort((a, b) => (b.publishAt ?? b.publishedAt ?? "").localeCompare(a.publishAt ?? a.publishedAt ?? "")),
    );
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load().catch(() => undefined).finally(() => setLoading(false));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  function toggleNotifyRecipient(name: string) {
    setNotifyRecipients((current) => (current.includes(name) ? current.filter((item) => item !== name) : [...current, name]));
  }
  function toggleLibraryRecipient(name: string) {
    setLibraryRecipients((current) => (current.includes(name) ? current.filter((item) => item !== name) : [...current, name]));
  }

  function startEdit(video: VideoRecord) {
    setEditingId(video.id);
    setEditingOriginal(video);
    setNotifyAll(video.notifyAll);
    setNotifyRecipients(namesOf(video, "isNotify"));
    setScope(video.visibilityScope === "family" ? "family" : "selected_members");
    setLibraryRecipients(namesOf(video, "isLibrary"));
    // « other » n'est pas un choix proposé ici (voir OCCASION_CHOICES) — équivalent au troisième
    // onglet (« Autres occasions »), donc ramené à « general » sans perte de segmentation réelle.
    setOccasionType(video.occasionType === "other" ? "general" : video.occasionType);
    setYoutubeUrl(video.youtubeUrl);
    setMessage(video.description ?? "");
    setPublishDate(video.publishAt ? video.publishAt.slice(0, 10) : "");
    setError("");
    setFeedback("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function cancelEdit() {
    setEditingId(null);
    setEditingOriginal(null);
    setNotifyAll(false);
    setNotifyRecipients([]);
    setScope("selected_members");
    setLibraryRecipients([]);
    setOccasionType("general");
    setYoutubeUrl("");
    setMessage("");
    setPublishDate("");
    setError("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setFeedback("");
    if (showNotifyRecipients && notifyRecipients.length === 0) { setError("Sélectionnez au moins un destinataire pour le pop-up, ou choisissez « Tout le monde »."); return; }
    if (showLibraryRecipients && libraryRecipients.length === 0) { setError("Sélectionnez au moins un destinataire pour Souvenirs, ou choisissez « Tout le monde »."); return; }
    if (!extractYouTubeVideoId(youtubeUrl)) { setError("L’URL YouTube est invalide."); return; }
    if (!message.trim()) { setError("Le message est obligatoire."); return; }
    setBusy(true);
    try {
      // Deux publics, deux listes INDÉPENDANTES : celle du pop-up (notifyAll/notifyRecipients) et
      // celle de la bibliothèque Souvenirs (scope/libraryRecipients) — chacune n'est envoyée que
      // si son propre réglage en a encore besoin, sinon un reliquat de sélection resterait stocké
      // sans plus jamais rien piloter.
      const recipientNames = showLibraryRecipients ? libraryRecipients : [];
      const notifyRecipientNames = showNotifyRecipients ? notifyRecipients : [];
      const popupAudience = notifyAll ? "tout le monde" : notifyRecipients.join(", ");
      const libraryAudience = scope === "family" ? "toute la famille" : libraryRecipients.join(", ");
      if (editingId && editingOriginal) {
        // Édition : contenu (portée, destinataires, lien, message, type, date) modifiable — l'état
        // publié/brouillon et l'activation du pop-up restent pilotés depuis les actions de la
        // liste (Publier/Dépublier, Activer/Désactiver le pop-up), pas depuis ce formulaire.
        await saveVideo({
          id: editingId,
          title: editingOriginal.title,
          description: message.trim(),
          youtubeUrl: youtubeUrl.trim(),
          occasionType,
          occasionDate: publishDate || null,
          visibilityScope: scope,
          recipientNames,
          notifyRecipientNames,
          giftId: editingOriginal.giftId,
          publishAt: publishDate || null,
          notifyOnLogin: editingOriginal.notifyOnLogin,
          notifyAll,
          publish: editingOriginal.isPublished,
        });
        setFeedback("Message vidéo mis à jour.");
        cancelEdit();
      } else {
        await saveVideo({
          title: notifyAll ? "Message vidéo pour toute la famille" : `Message vidéo pour ${popupAudience}`,
          description: message.trim(),
          youtubeUrl: youtubeUrl.trim(),
          occasionType,
          // La date de publication tient aussi lieu de date d'occasion pour un message direct
          // (il n'y en a pas d'autre) : c'est elle qui alimente le filtre « Année » et le tri de
          // Souvenirs, exactement comme pour une vidéo liée à un cadeau.
          occasionDate: publishDate || null,
          visibilityScope: scope,
          recipientNames,
          notifyRecipientNames,
          giftId: null,
          publishAt: publishDate || null,
          notifyOnLogin: true,
          notifyAll,
          publish: true,
        });
        setFeedback(
          (publishDate
            ? `Vidéo programmée : elle apparaîtra pour ${popupAudience} à partir du ${dateFormatter.format(new Date(publishDate))}, dès leur prochaine connexion à partir de cette date.`
            : `Vidéo publiée : elle apparaîtra pour ${popupAudience} dès leur prochaine connexion.`)
            + ` Visible ensuite dans Souvenirs par ${libraryAudience}.`,
        );
        setNotifyAll(false);
        setNotifyRecipients([]);
        setScope("selected_members");
        setLibraryRecipients([]);
        setOccasionType("general");
        setYoutubeUrl("");
        setMessage("");
        setPublishDate("");
      }
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Publication impossible.");
    } finally {
      setBusy(false);
    }
  }

  async function togglePublish(video: VideoRecord) {
    setError(""); setFeedback(""); setRowBusyId(video.id);
    try {
      await setVideoPublished(video.id, !video.isPublished);
      setFeedback(video.isPublished ? "Vidéo dépubliée." : "Vidéo publiée.");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Action impossible.");
    } finally {
      setRowBusyId(null);
    }
  }

  async function toggleNotify(video: VideoRecord) {
    setError(""); setFeedback(""); setRowBusyId(video.id);
    try {
      await saveVideo({ id: video.id, ...fieldsOf(video), notifyOnLogin: !video.notifyOnLogin, publish: video.isPublished });
      setFeedback(video.notifyOnLogin ? "Ne se lancera plus en pop-up à la connexion." : "Se lancera en pop-up à la prochaine connexion.");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Action impossible.");
    } finally {
      setRowBusyId(null);
    }
  }

  async function archive(video: VideoRecord) {
    if (!window.confirm(`Archiver « ${video.title} » ? Elle disparaîtra de l’onglet Souvenirs.`)) return;
    setError(""); setFeedback(""); setRowBusyId(video.id);
    try {
      await archiveVideo(video.id);
      setFeedback("Vidéo archivée.");
      if (editingId === video.id) cancelEdit();
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Archivage impossible.");
    } finally {
      setRowBusyId(null);
    }
  }

  return (
    <div className="admin-section">
      <section className="panel admin-panel-new">
        <header>
          <div>
            <span>SOUVENIRS</span>
            <h2>{editingId ? "Modifier le message vidéo" : "Publier un message vidéo"}</h2>
            <p>
              La vidéo se lance automatiquement en pop-up, une fois, à la prochaine connexion des destinataires choisis (ou de toute la famille) ci-dessous. Elle reste ensuite disponible dans l’onglet Souvenirs — visible par les mêmes destinataires ou par toute la famille, au choix, indépendamment du réglage du pop-up.
            </p>
          </div>
        </header>
        <form className="video-broadcast-form" onSubmit={submit}>
          <p className="video-toggle-label">Destinataires du pop-up (à la connexion)</p>
          <div className="video-scope-chips" role="radiogroup" aria-label="Destinataires du pop-up">
            <button type="button" role="radio" aria-checked={!notifyAll} className={!notifyAll ? "active" : ""} onClick={() => setNotifyAll(false)}>
              🎯 Destinataires sélectionnés
            </button>
            <button type="button" role="radio" aria-checked={notifyAll} className={notifyAll ? "active" : ""} onClick={() => setNotifyAll(true)}>
              👨‍👩‍👧‍👦 Tout le monde
            </button>
          </div>
          {showNotifyRecipients && (
            <div className="video-recipients" role="group" aria-label="Destinataires du pop-up">
              {FAMILY_MEMBERS.map((member) => (
                <label key={member.name} className={notifyRecipients.includes(member.name) ? "active" : ""}>
                  <input type="checkbox" checked={notifyRecipients.includes(member.name)} onChange={() => toggleNotifyRecipient(member.name)} />
                  {member.name}
                </label>
              ))}
            </div>
          )}
          <p className="video-toggle-label">Visible ensuite dans l’onglet Souvenirs</p>
          <div className="video-scope-chips" role="radiogroup" aria-label="Visibilité dans Souvenirs">
            <button type="button" role="radio" aria-checked={scope === "family"} className={scope === "family" ? "active" : ""} onClick={() => setScope("family")}>
              👨‍👩‍👧‍👦 Tout le monde
            </button>
            <button type="button" role="radio" aria-checked={scope === "selected_members"} className={scope === "selected_members" ? "active" : ""} onClick={() => setScope("selected_members")}>
              🎯 Destinataires sélectionnés uniquement
            </button>
          </div>
          {showLibraryRecipients && (
            <div className="video-recipients" role="group" aria-label="Destinataires Souvenirs">
              {FAMILY_MEMBERS.map((member) => (
                <label key={member.name} className={libraryRecipients.includes(member.name) ? "active" : ""}>
                  <input type="checkbox" checked={libraryRecipients.includes(member.name)} onChange={() => toggleLibraryRecipient(member.name)} />
                  {member.name}
                </label>
              ))}
            </div>
          )}
          <div className="video-occasion-chips" role="radiogroup" aria-label="Type de vidéo">
            {OCCASION_CHOICES.map((choice) => (
              <button
                key={choice.id}
                type="button"
                role="radio"
                aria-checked={occasionType === choice.id}
                className={occasionType === choice.id ? "active" : ""}
                onClick={() => setOccasionType(choice.id)}
              >
                <span aria-hidden="true">{choice.icon}</span> {choice.label}
              </button>
            ))}
          </div>
          <div className="admin-form">
            <label className="span-2">Lien YouTube<input value={youtubeUrl} onChange={(event) => setYoutubeUrl(event.target.value)} placeholder="https://www.youtube.com/watch?v=… ou /shorts/…" /></label>
            <label>Date de publication (optionnel)<input type="date" value={publishDate} onChange={(event) => setPublishDate(event.target.value)} /></label>
            <label className="span-4">Message<textarea value={message} onChange={(event) => setMessage(event.target.value)} rows={3} placeholder="Le message qui accompagne la vidéo" /></label>
            <div className="video-form-actions">
              <button type="submit" disabled={busy}>{busy ? "Enregistrement…" : editingId ? "Enregistrer les modifications" : "Publier la vidéo"}</button>
              {editingId && <button type="button" className="quiet" onClick={cancelEdit} disabled={busy}>Annuler la modification</button>}
            </div>
          </div>
        </form>
        {error && <p className="admin-feedback error">{error}</p>}
        {feedback && <p className="admin-feedback">{feedback}</p>}
      </section>

      <section className="panel admin-panel-new">
        <header>
          <div>
            <span>HISTORIQUE</span>
            <h2>Messages vidéo</h2>
            <p>Toutes les vidéos ciblées à un ou plusieurs membres ou à toute la famille — publiées ici, liées à un cadeau, ou ajoutées depuis Souvenirs — de la plus récente à la plus ancienne.</p>
          </div>
        </header>
        {loading ? (
          <p className="empty">Chargement…</p>
        ) : sent.length === 0 ? (
          <p className="empty">Aucun message vidéo pour l’instant.</p>
        ) : (
          <div className="video-sent-list">
            {sent.map((video) => {
              const scheduled = Boolean(video.publishAt && new Date(video.publishAt).getTime() > nowTimestamp);
              const isFamily = video.visibilityScope === "family";
              // Deux publics indépendants, chacun avec sa propre liste de destinataires : celui
              // de la bibliothèque Souvenirs (`libraryNames`, dérivé de visibilityScope) et celui
              // du pop-up (`notifyNames`, dérivé de notifyOnLogin + notifyAll) — une vidéo
              // « famille » peut très bien avoir un pop-up ciblé à d'autres personnes, et
              // inversement.
              const libraryNames = isFamily ? "Toute la famille" : namesOf(video, "isLibrary").join(", ") || "—";
              const notifyNames = namesOf(video, "isNotify").join(", ");
              const notifyLabel = !video.notifyOnLogin ? "Pop-up : non" : video.notifyAll ? "Pop-up : tout le monde" : `Pop-up : ${notifyNames || "—"}`;
              const rowBusy = rowBusyId === video.id;
              return (
                <article key={video.id} className={editingId === video.id ? "is-editing" : ""}>
                  <div className="video-sent-info">
                    <strong>{video.title}</strong>
                    <small>Souvenirs : {libraryNames}</small>
                    <div className="video-sent-badges">
                      <span className={"admin-status " + (!video.isPublished ? "pending" : scheduled ? "pending" : "ok")}>
                        <i />{!video.isPublished ? "Brouillon" : scheduled ? `Programmée · ${dateFormatter.format(new Date(video.publishAt!))}` : "Publiée"}
                      </span>
                      <span className={"admin-status " + (video.notifyOnLogin ? "ok" : "muted")}>
                        <i />{notifyLabel}
                      </span>
                      {video.giftId && <span className="admin-status muted"><i />Liée à un cadeau</span>}
                    </div>
                  </div>
                  <div className="video-sent-actions">
                    <button type="button" onClick={() => startEdit(video)} disabled={rowBusy}>Modifier</button>
                    <button type="button" onClick={() => void togglePublish(video)} disabled={rowBusy}>{video.isPublished ? "Dépublier" : "Publier"}</button>
                    <button type="button" onClick={() => void toggleNotify(video)} disabled={rowBusy}>{video.notifyOnLogin ? "Désactiver le pop-up" : "Activer le pop-up"}</button>
                    <button type="button" className="danger" onClick={() => void archive(video)} disabled={rowBusy}>Archiver</button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
