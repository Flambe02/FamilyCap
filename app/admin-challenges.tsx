"use client";

// Back-office « Défis & animation » (Phase 2). Deux vues : Défis (liste + création + gestion du
// cycle de vie) et Participants (suivi avec montants, réservé à l'admin). Toutes les mutations
// passent par /api/admin/challenges* (requireAdmin). Les points ne sont jamais saisis ici : ils
// sont attribués automatiquement par la réconciliation serveur.

import { useCallback, useEffect, useState } from "react";
import { authHeader } from "../lib/supabase-session";
import "./admin-challenges.css";

type ChallengeDto = {
  id: string; title: string; description: string | null; status: string;
  startsOn: string | null; endsOn: string | null; // null = défi permanent (sans échéance)
  pointsReward: number; eligibleAccountTypes: string[]; eligibleInstrumentTypes: string[];
  availabilityMode: string; requiresChallengeId: string | null; showInOnboarding: boolean;
  participants: number; completed: number; completionRate: number; pointsAttributed: number;
};
type ParticipantDto = { memberId: string; name: string; photoUrl: string | null; status: string; pct: number; invested: number; targetAmount: number; pointsEarned: number; lastEligibleDate: string | null };
type OnboardingMissionDto = { id: string; slug: string; title: string; description: string; points: number; cta: string; successMessage: string; active: boolean; displayOrder: number; completedCount: number };
type MemberRowDto = {
  memberId: string; name: string; photoUrl: string | null;
  status: "completed" | "in_progress" | "not_started";
  pointsEarned: number; completedAt: string | null;
  pct: number | null; invested: number | null; targetAmount: number | null;
  unlocked: boolean | null;
};

const STATUS_LABEL: Record<string, string> = { draft: "Brouillon", scheduled: "Programmé", active: "Actif", completed: "Terminé", archived: "Archivé" };
const AVAILABILITY_LABEL: Record<string, string> = { always: "Toujours", sequential: "Séquentiel", special: "Spécial" };
const ACCOUNT_OPTIONS: [string, string][] = [["pea", "PEA"], ["securities", "Compte-titres"]];
const INSTRUMENT_OPTIONS: [string, string][] = [["etf", "ETF"], ["stock", "Action"], ["fund", "Fonds"], ["bond", "Obligation"]];
const euro0 = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const intFmt = new Intl.NumberFormat("fr-FR");

async function headers() { return { ...(await authHeader()), "content-type": "application/json" }; }
function fmtDate(iso: string) { const [y, m, d] = iso.split("-"); return `${d}/${m}/${y.slice(2)}`; }
/** Période affichable : « Permanent » quand le défi n'a pas de dates (challenges.starts_on NULL). */
function fmtPeriod(startsOn: string | null, endsOn: string | null) {
  if (!startsOn || !endsOn) return "Permanent";
  return `${fmtDate(startsOn)} – ${fmtDate(endsOn)}`;
}
function initials(name: string) { return name.trim().slice(0, 2).toUpperCase(); }

export function AdminChallenges() {
  const [challenges, setChallenges] = useState<ChallengeDto[]>([]);
  const [onboarding, setOnboarding] = useState<OnboardingMissionDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"challenges" | "participants">("challenges");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [participants, setParticipants] = useState<ParticipantDto[]>([]);
  const [formModal, setFormModal] = useState<"create" | ChallengeDto | null>(null);
  const [onboardingModal, setOnboardingModal] = useState<OnboardingMissionDto | null>(null);
  const [membersModal, setMembersModal] = useState<{ id: string; title: string; defaultPoints: number; availabilityMode: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const load = useCallback(async () => {
    const response = await fetch("/api/admin/challenges", { headers: await headers() });
    const body = await response.json() as { challenges?: ChallengeDto[]; onboarding?: OnboardingMissionDto[]; error?: string };
    if (!response.ok) throw new Error(body.error ?? "Chargement impossible.");
    return { challenges: body.challenges ?? [], onboarding: body.onboarding ?? [] };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError("");
      try {
        const { challenges: list, onboarding: missions } = await load();
        if (cancelled) return;
        setChallenges(list);
        setOnboarding(missions);
        setSelectedId((current) => current ?? list.find((challenge) => challenge.status === "active")?.id ?? list[0]?.id ?? null);
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Chargement impossible.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [load, reloadToken]);

  useEffect(() => {
    if (tab !== "participants" || !selectedId) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/admin/challenges/participants?challengeId=${encodeURIComponent(selectedId)}`, { headers: await headers() });
        const body = await response.json() as { participants?: ParticipantDto[] };
        if (!cancelled) setParticipants(body.participants ?? []);
      } catch {
        if (!cancelled) setParticipants([]);
      }
    })();
    return () => { cancelled = true; };
  }, [tab, selectedId, reloadToken]);

  async function transition(id: string, patch: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/admin/challenges", { method: "PATCH", headers: await headers(), body: JSON.stringify({ id, ...patch }) });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Action impossible.");
      setReloadToken((token) => token + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Action impossible.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(challenge: ChallengeDto) {
    if (!window.confirm(`Supprimer définitivement le défi « ${challenge.title} » ? Cette action est irréversible.`)) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/admin/challenges?id=${encodeURIComponent(challenge.id)}`, { method: "DELETE", headers: await headers() });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Suppression impossible.");
      if (selectedId === challenge.id) setSelectedId(null);
      setReloadToken((token) => token + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Suppression impossible.");
    } finally {
      setBusy(false);
    }
  }

  const activeCount = challenges.filter((challenge) => challenge.status === "active").length;
  const totalParticipants = challenges.reduce((sum, challenge) => sum + challenge.participants, 0);
  const totalCompleted = challenges.reduce((sum, challenge) => sum + challenge.completed, 0);
  const totalPoints = challenges.reduce((sum, challenge) => sum + challenge.pointsAttributed, 0);
  const successRate = totalParticipants > 0 ? Math.round((totalCompleted / totalParticipants) * 100) : 0;
  const selected = challenges.find((challenge) => challenge.id === selectedId) ?? null;
  const pinnedChallenges = challenges.filter((challenge) => challenge.showInOnboarding);

  return (
    <div className="page-stack ach-page">
      <header className="ach-head">
        <div>
          <h1>Gestion des défis</h1>
          <p>Animez les objectifs familiaux avec simplicité.</p>
        </div>
        <button type="button" className="ach-create-btn" onClick={() => setFormModal("create")}>+ Créer un défi</button>
      </header>

      <nav className="ach-tabs" aria-label="Sections défis">
        <button type="button" className={tab === "challenges" ? "active" : ""} onClick={() => setTab("challenges")}>Défis</button>
        <button type="button" className={tab === "participants" ? "active" : ""} onClick={() => setTab("participants")}>Participants</button>
      </nav>

      {error && <p className="ach-error" role="alert">{error}</p>}

      <div className="ach-stats">
        <Stat icon="⭐" value={String(activeCount)} label="Défi(s) actif(s)" />
        <Stat icon="👪" value={intFmt.format(totalParticipants)} label="Participants" />
        <Stat icon="🎯" value={`${successRate} %`} label="Taux de réussite" />
        <Stat icon="🏆" value={intFmt.format(totalPoints)} label="Points attribués" />
      </div>

      {!loading && (onboarding.length > 0 || pinnedChallenges.length > 0) && (
        <section className="panel ach-onboard-card">
          <div className="ach-onboard-head">
            <h3 className="ach-card-title">Bien démarrer</h3>
            <span className="ach-onboard-badge">Onboarding · Permanent · configurable</span>
          </div>
          <p className="ach-muted">Parcours individuel automatique, distinct du défi du mois. Les identifiants et les points déjà attribués restent historiques.</p>
          <ul className="ach-onboard-list">
            {onboarding.map((mission) => (
              <li key={mission.slug} className="ach-onboard-row">
                <span className="ach-onboard-title">{mission.title}</span>
                <span className="ach-onboard-points">{mission.points} pts</span>
                <span className="ach-onboard-count">{mission.completedCount} membre{mission.completedCount > 1 ? "s" : ""} terminé{mission.completedCount > 1 ? "s" : ""}</span>
                <span className={`ach-status ach-status-${mission.active ? "active" : "archived"}`}>{mission.active ? "Actif" : "Inactif"}</span>
                <button type="button" className="quiet" onClick={() => setMembersModal({ id: mission.id, title: mission.title, defaultPoints: mission.points, availabilityMode: "always" })}>Membres</button>
                <button type="button" className="quiet" onClick={() => setOnboardingModal(mission)}>Modifier</button>
              </li>
            ))}
          </ul>
          {pinnedChallenges.length > 0 && (
            <ul className="ach-onboard-list ach-onboard-pinned">
              {pinnedChallenges.map((challenge) => (
                <li key={challenge.id} className="ach-onboard-row">
                  <span className="ach-onboard-title">{challenge.title} <small className="ach-muted">· défi épinglé</small></span>
                  <span className="ach-onboard-points">{challenge.pointsReward} pts</span>
                  <span className="ach-onboard-count">{challenge.completed} membre{challenge.completed > 1 ? "s" : ""} terminé{challenge.completed > 1 ? "s" : ""}</span>
                  <span className={`ach-status ach-status-${challenge.status}`}>{STATUS_LABEL[challenge.status] ?? challenge.status}</span>
                  <button type="button" className="quiet" onClick={() => setMembersModal({ id: challenge.id, title: challenge.title, defaultPoints: challenge.pointsReward, availabilityMode: challenge.availabilityMode })}>Membres</button>
                  <button type="button" className="quiet" onClick={() => setFormModal(challenge)}>Modifier</button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {loading ? (
        <section className="panel"><p className="ach-muted">Chargement…</p></section>
      ) : tab === "challenges" ? (
        <section className="panel ach-table-card">
          <h3 className="ach-card-title">Tous les défis</h3>
          {challenges.length === 0 ? (
            <p className="ach-muted">Aucun défi pour le moment. Créez le premier défi mensuel d’investissement.</p>
          ) : (
            <div className="responsive-table">
              <table className="ach-table">
                <thead><tr><th>Défi</th><th>Période</th><th>Disponibilité</th><th>Statut</th><th>Part.</th><th>Complétion</th><th>Points</th><th>Actions</th></tr></thead>
                <tbody>
                  {challenges.map((challenge) => (
                    <tr key={challenge.id}>
                      <td data-label="Défi"><strong>{challenge.title}</strong></td>
                      <td data-label="Période">{fmtPeriod(challenge.startsOn, challenge.endsOn)}</td>
                      <td data-label="Disponibilité">{AVAILABILITY_LABEL[challenge.availabilityMode] ?? challenge.availabilityMode}{challenge.availabilityMode === "sequential" && challenge.requiresChallengeId && <small className="ach-muted"><br />après « {challenges.find((item) => item.id === challenge.requiresChallengeId)?.title ?? "défi supprimé"} »</small>}</td>
                      <td data-label="Statut"><span className={`ach-status ach-status-${challenge.status}`}>{STATUS_LABEL[challenge.status] ?? challenge.status}</span></td>
                      <td data-label="Participants" className="num">{challenge.participants}</td>
                      <td data-label="Complétion">
                        <div className="ach-bar"><div className="ach-bar-fill" style={{ width: `${Math.min(100, challenge.completionRate)}%` }} /></div>
                        <small>{challenge.completionRate} %</small>
                      </td>
                      <td data-label="Points" className="num">{challenge.pointsReward}</td>
                      <td data-label="Actions">
                        <div className="ach-actions">
                          {(challenge.status === "draft" || challenge.status === "scheduled") && <button type="button" disabled={busy} onClick={() => transition(challenge.id, { status: "active" })}>Activer</button>}
                          {challenge.status === "draft" && <button type="button" disabled={busy} onClick={() => transition(challenge.id, { status: "scheduled" })}>Programmer</button>}
                          {challenge.status === "active" && <button type="button" disabled={busy} onClick={() => transition(challenge.id, { status: "completed" })}>Terminer</button>}
                          {/* Réactivation d'un défi rangé/terminé : le défi reprend son identité, ses
                              participants et ses points. « Remettre en brouillon » rouvre l'édition
                              du contenu (non modifiable une fois activé). */}
                          {(challenge.status === "archived" || challenge.status === "completed") && <button type="button" disabled={busy} onClick={() => transition(challenge.id, { status: "active" })}>Réactiver</button>}
                          {challenge.status === "archived" && <button type="button" className="quiet" disabled={busy} onClick={() => transition(challenge.id, { status: "draft" })}>Remettre en brouillon</button>}
                          {challenge.status !== "archived" && <button type="button" className="quiet" disabled={busy} onClick={() => transition(challenge.id, { status: "archived" })}>Archiver</button>}
                          <button type="button" className="quiet" disabled={busy} onClick={() => setFormModal(challenge)}>Modifier</button>
                          <button type="button" className="quiet" onClick={() => { setSelectedId(challenge.id); setTab("participants"); }}>Participants ›</button>
                          <button type="button" className="quiet" onClick={() => setMembersModal({ id: challenge.id, title: challenge.title, defaultPoints: challenge.pointsReward, availabilityMode: challenge.availabilityMode })}>Membres</button>
                          <button type="button" className="quiet ach-danger" disabled={busy} onClick={() => void remove(challenge)}>Supprimer</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : (
        <section className="panel ach-table-card">
          <div className="ach-part-head">
            <h3 className="ach-card-title">Progression des participants</h3>
            {challenges.length > 0 && (
              <label className="ach-select"><span className="sr-only">Choisir le défi</span>
                <select value={selectedId ?? ""} onChange={(event) => setSelectedId(event.target.value)}>
                  {challenges.map((challenge) => <option key={challenge.id} value={challenge.id}>{challenge.title}</option>)}
                </select>
              </label>
            )}
          </div>
          {!selected ? (
            <p className="ach-muted">Sélectionnez un défi.</p>
          ) : participants.length === 0 ? (
            <p className="ach-muted">Aucun participant inscrit pour l’instant.</p>
          ) : (
            <ul className="ach-part-list">
              {participants.map((participant) => (
                <li key={participant.memberId} className="ach-part-row">
                  {/* eslint-disable-next-line @next/next/no-img-element -- avatar Supabase Storage ; le projet n'utilise pas next/image (aucune config remotePatterns). */}
                  {participant.photoUrl ? <img className="ach-avatar" src={participant.photoUrl} alt="" aria-hidden="true" /> : <span className="ach-avatar" aria-hidden="true">{initials(participant.name)}</span>}
                  <span className="ach-part-name">{participant.name}</span>
                  <span className="ach-part-pct">{participant.pct} %</span>
                  <div className="ach-bar"><div className="ach-bar-fill" style={{ width: `${Math.min(100, participant.pct)}%` }} /></div>
                  <span className={`ach-status ach-status-${participant.status === "completed" ? "active" : "scheduled"}`}>{participant.status === "completed" ? "Objectif atteint" : "En cours"}</span>
                  <span className="ach-part-invest">{euro0.format(participant.invested)} / {euro0.format(participant.targetAmount)}</span>
                  <span className="ach-part-points">{participant.pointsEarned > 0 ? `${intFmt.format(participant.pointsEarned)} pt` : "0 pt"}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="ach-muted ach-note">Les montants (objectif et investi) sont visibles ici pour le suivi familial. Ils ne transitent jamais par le classement des membres.</p>
        </section>
      )}

      {formModal && <ChallengeFormModal challenge={formModal === "create" ? null : formModal} allChallenges={challenges} onClose={() => setFormModal(null)} onSaved={() => { setFormModal(null); setReloadToken((token) => token + 1); }} />}
      {onboardingModal && <OnboardingMissionModal mission={onboardingModal} onClose={() => setOnboardingModal(null)} onSaved={() => { setOnboardingModal(null); setReloadToken((token) => token + 1); }} />}
      {membersModal && <ChallengeMembersModal challengeId={membersModal.id} title={membersModal.title} defaultPoints={membersModal.defaultPoints} availabilityMode={membersModal.availabilityMode} onClose={() => setMembersModal(null)} onChanged={() => setReloadToken((token) => token + 1)} />}
    </div>
  );
}

// Vue admin unifiée « qui a fait ce défi, ou pas » (défi mensuel ET missions « Bien démarrer »).
// Le journal des points est immuable côté serveur : « Enregistrer » écrit une compensation qui
// ramène le solde du membre à la valeur saisie — jamais une réécriture de l'historique existant.
function ChallengeMembersModal({ challengeId, title, defaultPoints, availabilityMode, onClose, onChanged }: { challengeId: string; title: string; defaultPoints: number; availabilityMode: string; onClose: () => void; onChanged: () => void }) {
  const [members, setMembers] = useState<MemberRowDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const response = await fetch(`/api/admin/challenges/members?challengeId=${encodeURIComponent(challengeId)}`, { headers: await headers() });
    const body = (await response.json()) as { members?: MemberRowDto[]; error?: string };
    if (!response.ok) throw new Error(body.error ?? "Chargement impossible.");
    return body.members ?? [];
  }, [challengeId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError("");
      try {
        const list = await load();
        if (!cancelled) setMembers(list);
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Chargement impossible.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [load]);

  async function save(memberId: string, points: number) {
    setSavingId(memberId);
    setError("");
    try {
      const response = await fetch("/api/admin/challenges/members", { method: "POST", headers: await headers(), body: JSON.stringify({ challengeId, memberId, points }) });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Action impossible.");
      setMembers(await load());
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Action impossible.");
    } finally {
      setSavingId(null);
    }
  }

  async function unlock(memberId: string) {
    setSavingId(memberId);
    setError("");
    try {
      const response = await fetch("/api/admin/challenges/members", { method: "POST", headers: await headers(), body: JSON.stringify({ challengeId, memberId, action: "unlock" }) });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Déblocage impossible.");
      setMembers(await load());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Déblocage impossible.");
    } finally {
      setSavingId(null);
    }
  }

  const statusLabel: Record<MemberRowDto["status"], string> = { completed: "Terminé", in_progress: "En cours", not_started: "Non commencé" };
  const statusClass: Record<MemberRowDto["status"], string> = { completed: "active", in_progress: "scheduled", not_started: "archived" };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal ach-modal ach-members-modal" role="dialog" aria-modal="true" aria-label={`Membres — ${title}`}>
        <header className="ach-modal-head"><h2>{title}</h2><button type="button" onClick={onClose} aria-label="Fermer">×</button></header>
        {error && <p className="ach-error" role="alert">{error}</p>}
        {loading ? (
          <p className="ach-muted">Chargement…</p>
        ) : members.length === 0 ? (
          <p className="ach-muted">Aucun membre actif.</p>
        ) : (
          <ul className="ach-members-list">
            {members.map((member) => {
              const draft = drafts[member.memberId] ?? String(member.pointsEarned);
              const dirty = draft.trim() !== "" && Number(draft) !== member.pointsEarned;
              return (
                <li key={member.memberId} className="ach-members-row">
                  {/* eslint-disable-next-line @next/next/no-img-element -- avatar Supabase Storage ; le projet n'utilise pas next/image. */}
                  {member.photoUrl ? <img className="ach-avatar" src={member.photoUrl} alt="" aria-hidden="true" /> : <span className="ach-avatar" aria-hidden="true">{initials(member.name)}</span>}
                  <span className="ach-members-name">{member.name}</span>
                  <span className={`ach-status ach-status-${statusClass[member.status]}`}>{statusLabel[member.status]}</span>
                  {member.targetAmount !== null ? (
                    <span className="ach-members-progress">{euro0.format(member.invested ?? 0)} / {euro0.format(member.targetAmount)} · {member.pct ?? 0} %</span>
                  ) : availabilityMode === "special" ? (
                    <span className="ach-members-progress">{member.unlocked ? "Débloqué" : "Non débloqué"}</span>
                  ) : <span className="ach-members-progress" />}
                  <span className="ach-members-date">{member.completedAt ? fmtDate(member.completedAt.slice(0, 10)) : "—"}</span>
                  <div className="ach-members-actions">
                    {availabilityMode === "special" && !member.unlocked && (
                      <button type="button" className="quiet" disabled={savingId !== null} onClick={() => void unlock(member.memberId)}>
                        {savingId === member.memberId ? "…" : "Débloquer"}
                      </button>
                    )}
                    {member.status === "completed" ? (
                      <button type="button" className="quiet ach-danger" disabled={savingId !== null} onClick={() => void save(member.memberId, 0)}>
                        {savingId === member.memberId ? "…" : "Retirer les points"}
                      </button>
                    ) : (
                      <button type="button" className="quiet" disabled={savingId !== null} onClick={() => void save(member.memberId, defaultPoints)}>
                        {savingId === member.memberId ? "…" : `Valider (+${defaultPoints} pts)`}
                      </button>
                    )}
                  </div>
                  <div className="ach-members-points">
                    <input
                      type="number" min={0} max={10000} value={draft} disabled={savingId === member.memberId}
                      onChange={(event) => setDrafts((current) => ({ ...current, [member.memberId]: event.target.value }))}
                      aria-label={`Points de ${member.name} pour ce défi`}
                    />
                    <button type="button" className="quiet" disabled={savingId !== null || !dirty} onClick={() => void save(member.memberId, Number(draft))}>
                      {savingId === member.memberId ? "…" : "Enregistrer"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <p className="ach-muted ach-note">Le journal des points est immuable : « Enregistrer » ajoute une écriture de compensation qui ramène le solde du membre à la valeur saisie (0 pour retirer les points, valeur par défaut du défi pour valider manuellement). L’historique complet reste conservé.</p>
      </section>
    </div>
  );
}

function OnboardingMissionModal({ mission, onClose, onSaved }: { mission: OnboardingMissionDto; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(mission.title);
  const [description, setDescription] = useState(mission.description);
  const [points, setPoints] = useState(String(mission.points));
  const [cta, setCta] = useState(mission.cta);
  const [successMessage, setSuccessMessage] = useState(mission.successMessage);
  const [active, setActive] = useState(mission.active);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function submit() {
    if (saving) return;
    setSaving(true); setError("");
    try {
      const response = await fetch("/api/admin/challenges", { method: "PATCH", headers: await headers(), body: JSON.stringify({ id: mission.id, onboarding: true, title, description, points: Number(points), cta, successMessage, active, displayOrder: mission.displayOrder }) });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Modification impossible.");
      onSaved();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Modification impossible."); }
    finally { setSaving(false); }
  }
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
    <section className="modal ach-modal" role="dialog" aria-modal="true" aria-label="Modifier la mission">
      <header className="ach-modal-head"><h2>Modifier la mission</h2><button type="button" onClick={onClose} aria-label="Fermer">×</button></header>
      <div className="ach-form">
        <label className="ach-field ach-field-wide"><span>Titre</span><input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} /></label>
        <label className="ach-field ach-field-wide"><span>Description</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={600} /></label>
        <label className="ach-field"><span>Points</span><input type="number" min="0" max="10000" value={points} onChange={(event) => setPoints(event.target.value)} /></label>
        <label className="ach-field"><span>Bouton</span><input value={cta} onChange={(event) => setCta(event.target.value)} maxLength={80} /></label>
        <label className="ach-field ach-field-wide"><span>Message de réussite</span><input value={successMessage} onChange={(event) => setSuccessMessage(event.target.value)} maxLength={200} /></label>
        <label className="ach-check"><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} /> Mission active</label>
        {error && <p className="ach-error" role="alert">{error}</p>}
      </div>
      <footer className="ach-modal-foot"><button type="button" className="quiet" disabled={saving} onClick={onClose}>Annuler</button><button type="button" className="ach-create-btn" disabled={saving} onClick={() => void submit()}>{saving ? "Enregistrement…" : "Enregistrer"}</button></footer>
    </section>
  </div>;
}

function Stat({ icon, value, label }: { icon: string; value: string; label: string }) {
  return <article className="ach-stat"><span className="ach-stat-icon" aria-hidden="true">{icon}</span><div><strong>{value}</strong><small>{label}</small></div></article>;
}

function firstOfMonthISO() { return `${new Date().toISOString().slice(0, 7)}-01`; }
function lastOfMonthISO() {
  const now = new Date();
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  return last.toISOString().slice(0, 10);
}

// Modale unique pour créer OU modifier un défi mensuel (le contenu ne se modifie qu'en
// brouillon/programmé, garde déjà appliquée côté serveur par updateChallenge). `challenge` NULL
// = création (POST) ; renseigné = édition pré-remplie (PATCH sur cet id).
function ChallengeFormModal({ challenge, allChallenges, onClose, onSaved }: { challenge: ChallengeDto | null; allChallenges: ChallengeDto[]; onClose: () => void; onSaved: () => void }) {
  const isEdit = challenge !== null;
  const [title, setTitle] = useState(challenge?.title ?? "");
  const [description, setDescription] = useState(challenge?.description ?? "");
  // Défi permanent = les deux dates vides. Un défi existant sans dates ouvre le formulaire dans ce
  // mode ; les champs conservent une valeur par défaut pour qu'un retour en mode daté reste simple.
  const [permanent, setPermanent] = useState(isEdit ? !challenge.startsOn || !challenge.endsOn : false);
  const [startsOn, setStartsOn] = useState(challenge?.startsOn ?? firstOfMonthISO());
  const [endsOn, setEndsOn] = useState(challenge?.endsOn ?? lastOfMonthISO());
  const [pointsReward, setPointsReward] = useState(String(challenge?.pointsReward ?? 300));
  const [accountTypes, setAccountTypes] = useState<string[]>(challenge?.eligibleAccountTypes ?? ["pea", "securities"]);
  const [instrumentTypes, setInstrumentTypes] = useState<string[]>(challenge?.eligibleInstrumentTypes ?? ["etf", "stock"]);
  const [availabilityMode, setAvailabilityMode] = useState(challenge?.availabilityMode ?? "always");
  const [requiresChallengeId, setRequiresChallengeId] = useState(challenge?.requiresChallengeId ?? "");
  const [showInOnboarding, setShowInOnboarding] = useState(challenge?.showInOnboarding ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const prerequisiteOptions = allChallenges.filter((item) => item.id !== challenge?.id);
  // Le contenu (titre, dates, points, types éligibles) se fige une fois le défi activé — pour ne
  // jamais changer rétroactivement les règles d'un défi que des membres ont déjà rejoint. La
  // disponibilité (mode, prérequis, épinglage) reste modifiable à tout moment, même actif/archivé.
  const contentEditable = !isEdit || challenge.status === "draft" || challenge.status === "scheduled";

  function toggle(list: string[], setList: (next: string[]) => void, value: string) {
    setList(list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);
  }

  async function submit() {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      // Défi permanent : on envoie explicitement null pour les deux dates (le serveur exige les
      // deux ou aucune) — jamais une seule, qui rendrait la période ambiguë. Une fois le défi
      // actif/archivé/terminé, on n'envoie QUE la disponibilité : le contenu est verrouillé
      // côté serveur, l'envoyer quand même (même inchangé) déclencherait un refus 409.
      const availabilityFields = { availabilityMode, requiresChallengeId: availabilityMode === "sequential" ? requiresChallengeId : null, showInOnboarding };
      const fields = contentEditable
        ? {
          title, description,
          startsOn: permanent ? null : startsOn,
          endsOn: permanent ? null : endsOn,
          pointsReward: Number(pointsReward), eligibleAccountTypes: accountTypes, eligibleInstrumentTypes: instrumentTypes,
          ...availabilityFields,
        }
        : availabilityFields;
      const response = await fetch("/api/admin/challenges", {
        method: isEdit ? "PATCH" : "POST", headers: await headers(),
        body: JSON.stringify(isEdit ? { id: challenge.id, ...fields } : fields),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? (isEdit ? "Modification impossible." : "Création impossible."));
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : (isEdit ? "Modification impossible." : "Création impossible."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
      <section className="modal ach-modal" role="dialog" aria-modal="true" aria-label={isEdit ? "Modifier le défi" : "Créer un défi"}>
        <header className="ach-modal-head"><h2>{isEdit ? "Modifier le défi" : "Créer un défi mensuel"}</h2><button type="button" onClick={onClose} aria-label="Fermer">×</button></header>
        {!contentEditable && (
          <p className="ach-muted ach-field-wide">Ce défi est {STATUS_LABEL[challenge!.status]?.toLowerCase() ?? challenge!.status} : son contenu (titre, dates, points, types éligibles) est verrouillé pour ne jamais changer rétroactivement les règles d’un défi déjà rejoint. Seule sa disponibilité reste modifiable ci-dessous.</p>
        )}
        <div className="ach-form">
          <label className="ach-field ach-field-wide"><span>Titre</span><input value={title} disabled={!contentEditable} onChange={(event) => setTitle(event.target.value)} placeholder="Mon cap du mois" /></label>
          <label className="ach-field ach-field-wide"><span>Description (facultatif)</span><input value={description} disabled={!contentEditable} onChange={(event) => setDescription(event.target.value)} placeholder="Investir régulièrement, à son rythme." /></label>
          <label className="ach-field ach-field-wide ach-field-check">
            <input type="checkbox" checked={permanent} disabled={!contentEditable} onChange={(event) => setPermanent(event.target.checked)} />
            <span>Défi permanent (sans date de début ni de fin)</span>
          </label>
          <label className="ach-field"><span>Date de début</span><input type="date" value={permanent ? "" : startsOn} disabled={permanent || !contentEditable} onChange={(event) => setStartsOn(event.target.value)} /></label>
          <label className="ach-field"><span>Date de fin</span><input type="date" value={permanent ? "" : endsOn} disabled={permanent || !contentEditable} onChange={(event) => setEndsOn(event.target.value)} /></label>
          <label className="ach-field"><span>Points (1–1000)</span><input type="number" min={1} max={1000} value={pointsReward} disabled={!contentEditable} onChange={(event) => setPointsReward(event.target.value)} /></label>
          <fieldset className="ach-field ach-field-wide">
            <span>Comptes éligibles</span>
            <div className="ach-checks">{ACCOUNT_OPTIONS.map(([value, label]) => (
              <label key={value}><input type="checkbox" checked={accountTypes.includes(value)} disabled={!contentEditable} onChange={() => toggle(accountTypes, setAccountTypes, value)} /> {label}</label>
            ))}</div>
          </fieldset>
          <fieldset className="ach-field ach-field-wide">
            <span>Instruments éligibles</span>
            <div className="ach-checks">{INSTRUMENT_OPTIONS.map(([value, label]) => (
              <label key={value}><input type="checkbox" checked={instrumentTypes.includes(value)} disabled={!contentEditable} onChange={() => toggle(instrumentTypes, setInstrumentTypes, value)} /> {label}</label>
            ))}</div>
          </fieldset>
          <fieldset className="ach-field ach-field-wide">
            <span>Disponibilité (modifiable à tout moment)</span>
            <div className="ach-checks">
              <label><input type="radio" name="availabilityMode" checked={availabilityMode === "always"} onChange={() => setAvailabilityMode("always")} /> Toujours (dès que le défi est actif)</label>
              <label><input type="radio" name="availabilityMode" checked={availabilityMode === "sequential"} onChange={() => setAvailabilityMode("sequential")} /> Séquentiel (après un autre défi terminé)</label>
              <label><input type="radio" name="availabilityMode" checked={availabilityMode === "special"} onChange={() => setAvailabilityMode("special")} /> Spécial (débloqué manuellement, par membre)</label>
            </div>
          </fieldset>
          {availabilityMode === "sequential" && (
            <label className="ach-field ach-field-wide">
              <span>Défi prérequis</span>
              <select value={requiresChallengeId} onChange={(event) => setRequiresChallengeId(event.target.value)}>
                <option value="">Choisir un défi…</option>
                {prerequisiteOptions.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
              </select>
            </label>
          )}
          {availabilityMode === "special" && (
            <p className="ach-muted ach-field-wide">Ce défi restera invisible pour tous les membres tant qu’il n’aura pas été débloqué individuellement, depuis « Membres » une fois le défi créé.</p>
          )}
          <label className="ach-field ach-field-wide ach-field-check">
            <input type="checkbox" checked={showInOnboarding} onChange={(event) => setShowInOnboarding(event.target.checked)} />
            <span>Afficher aussi dans « Bien démarrer », en plus des 4 missions permanentes</span>
          </label>
          <p className="ach-muted ach-field-wide">{contentEditable ? (isEdit ? "Le contenu reste modifiable tant que le défi n'est pas activé (brouillon ou programmé)." : "Type de défi : investissement mensuel régulier. Le défi est créé en brouillon ; activez-le ensuite depuis la liste.") : "Le mécanisme du défi (inscription, achats, points) reste inchangé — seul l'endroit où il s'affiche peut changer."}</p>
          {permanent && <p className="ach-muted ach-field-wide">Défi permanent : il reste courant tant qu&apos;il est actif. Pour chaque membre, les achats comptent à partir du jour où il rejoint le défi.</p>}
          {error && <p className="ach-error ach-field-wide" role="alert">{error}</p>}
        </div>
        <footer className="ach-modal-actions">
          <button type="button" className="quiet" onClick={onClose} disabled={saving}>Annuler</button>
          <button type="button" className="ach-create-btn" onClick={() => void submit()} disabled={saving}>{saving ? "Enregistrement…" : isEdit ? "Enregistrer" : "Créer le défi"}</button>
        </footer>
      </section>
    </div>
  );
}
