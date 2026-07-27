"use client";

// Écran membre « Défis » (MVP Phase 2). Données RÉELLES uniquement, via les API /api/challenges/*.
// N'affiche jamais l'objectif ni le montant investi d'un autre membre : le hero montre la propre
// progression du membre connecté ; le classement n'expose que rang/points (aucun montant).
// Réutilise le shell, les tokens, les polices et les icônes (NavIcon) existants ; aucun nouveau
// design system. Correction UX/UI fidèle à la maquette de référence (desktop + mobile PWA) :
// hero compact même sans défi actif, KPI premium, classement et « Mes défis » composés, historique.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { View } from "../lib/navigation";
import { NavIcon } from "./dashboard-ui";
import { authenticatedFetch } from "./investment-shared";
import "./challenges.css";

type MemberState = "no_plan" | "no_account" | "ready_to_join" | "in_progress" | "completed" | "challenge_ended";
// startsOn / endsOn / daysRemaining à null = défi PERMANENT (sans échéance) : on affiche « Sans
// échéance », jamais une date ou un décompte inventé.
type CurrentResp = {
  available: boolean; state: MemberState; hasPlan: boolean; hasTargetAccount: boolean; isParticipant: boolean;
  challenge: { id: string; title: string; description: string | null; startsOn: string | null; endsOn: string | null; pointsReward: number; daysRemaining: number | null } | null;
  progress: { invested: number; targetAmount: number; pct: number; completed: boolean; status: string } | null;
};
type PointsResp = {
  available?: boolean; monthPoints: number; totalPoints: number; yearPoints: number; challengesCompleted: number;
  rank: number | null; participantCount: number; level: string; nextLevel: string | null;
  nextLevelAt: number | null; levelProgressPct: number; monthlyStreak: number;
};
type LeaderRow = { rank: number; memberId: string; name: string; photoUrl: string | null; points: number; challengesCompleted: number; isCurrentMember?: boolean };
type HistoryItem = { id: string; title: string; startsOn: string | null; endsOn: string | null; status: string; pointsReward: number; joined: boolean; participantStatus: string | null; pointsEarned: number };
type OnboardingMissionDto = { slug: string; title: string; description: string; points: number; cta: string; view: View; status: "todo" | "done"; successMessage: string };
type OnboardingResp = { available: boolean; missions: OnboardingMissionDto[]; completedCount: number; totalCount: number; earnedPoints: number; totalPoints: number; justCompleted: string[] };

/** Contrat unique pour la section dashboard et la pastille de points du header. */
export type ChallengesDashboardSummary = {
  available: boolean;
  current: CurrentResp | null;
  onboarding: OnboardingResp | null;
  points: PointsResp | null;
  leaderboard: LeaderRow[];
  leaderboardOptIn: boolean;
};

const euro0 = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const intFmt = new Intl.NumberFormat("fr-FR");
const monthLong = new Intl.DateTimeFormat("fr-FR", { month: "long" });
const dayMonthShort = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" });
const monthYear = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric" });

function initials(name: string): string {
  return name.trim().slice(0, 2).toUpperCase();
}
function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
function parseISODate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y || 1970, (m || 1) - 1, d || 1);
}
const NO_DEADLINE = "Sans échéance";
function formatPeriod(startsOn: string | null, endsOn: string | null): string {
  if (!startsOn || !endsOn) return NO_DEADLINE;
  const start = parseISODate(startsOn);
  const end = parseISODate(endsOn);
  if (start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth()) {
    return `${start.getDate()} – ${end.getDate()} ${monthLong.format(end)}`;
  }
  return `${dayMonthShort.format(start)} – ${dayMonthShort.format(end)}`;
}
function formatMonthYear(iso: string | null): string {
  if (!iso) return "En continu";
  return capitalize(monthYear.format(parseISODate(iso)));
}
/**
 * Clé de tri par date de début. Un défi PERMANENT (startsOn null) n'a pas de date : on le trie
 * comme le plus récent, en miroir du `nullsfirst` côté serveur, pour qu'il reste en tête de liste.
 */
function startSortKey(item: { startsOn: string | null }): string {
  return item.startsOn ?? "9999-12-31";
}
/** Compte à rebours lisible ; « Sans échéance » pour un défi permanent (daysRemaining null). */
function formatDeadline(daysRemaining: number | null): string {
  if (daysRemaining === null) return NO_DEADLINE;
  return `${daysRemaining} jour${daysRemaining > 1 ? "s" : ""} restant${daysRemaining > 1 ? "s" : ""}`;
}

const STATE_META: Record<MemberState, { badge: string; badgeCls: string }> = {
  no_plan: { badge: "À configurer", badgeCls: "cha-badge-muted" },
  no_account: { badge: "À configurer", badgeCls: "cha-badge-muted" },
  ready_to_join: { badge: "Prêt à commencer", badgeCls: "cha-badge-ready" },
  in_progress: { badge: "En cours", badgeCls: "cha-badge-progress" },
  completed: { badge: "Objectif atteint", badgeCls: "cha-badge-done" },
  challenge_ended: { badge: "Défi terminé", badgeCls: "cha-badge-muted" },
};

function heroHint(state: MemberState): string {
  if (state === "no_plan") return "Configure ton objectif mensuel dans « Mon rythme » pour rejoindre ce défi.";
  if (state === "no_account") return "Choisis un compte PEA ou compte-titres dans « Mon rythme » pour rejoindre ce défi.";
  if (state === "ready_to_join") return "Rejoins le défi pour figer ton objectif et suivre ta progression, à ton rythme.";
  return "";
}

// Icônes locales à l'écran Défis (même trait que NavIcon). Illustrations, jamais d'emoji système.
const STROKE = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, className: "nav-icon-svg" };
function TrophyIcon() {
  return <svg {...STROKE}><path d="M8 21h8" /><path d="M12 17v4" /><path d="M7 4h10v4a5 5 0 0 1-10 0Z" /><path d="M17 5h2.5a1 1 0 0 1 1 1 4 4 0 0 1-3.5 4" /><path d="M7 5H4.5a1 1 0 0 0-1 1 4 4 0 0 0 3.5 4" /></svg>;
}
function CheckIcon() {
  return <svg {...STROKE}><path d="M20 6 9 17l-5-5" /></svg>;
}

// Cible abstraite (anneaux dorés + trajectoire) — décor du hero et de l'état vide. Sans personne.
function TargetGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 240 200" fill="none" aria-hidden="true">
      <circle cx="162" cy="96" r="86" stroke="rgba(217,173,92,0.12)" strokeWidth="1.4" />
      <circle cx="162" cy="96" r="64" stroke="rgba(217,173,92,0.22)" strokeWidth="1.4" />
      <circle cx="162" cy="96" r="42" stroke="rgba(217,173,92,0.34)" strokeWidth="1.4" />
      <circle cx="162" cy="96" r="21" stroke="rgba(217,173,92,0.5)" strokeWidth="1.6" />
      <path d="M4 176c46-4 62-24 84-44 20-18 44-30 74-36" stroke="#d9ad5c" strokeWidth="2" strokeLinecap="round" strokeDasharray="0.5 9" opacity="0.75" />
      <circle cx="162" cy="96" r="6.5" fill="#d9ad5c" />
    </svg>
  );
}

// Podium abstrait pour l'état vide du classement. Trois marches sobres, sans visage ni chiffre.
function PodiumGlyph() {
  return (
    <svg className="cha-podium-glyph" viewBox="0 0 168 96" fill="none" aria-hidden="true">
      <circle cx="30" cy="40" r="10" stroke="currentColor" strokeWidth="1.6" opacity="0.5" />
      <circle cx="84" cy="26" r="11" stroke="currentColor" strokeWidth="1.6" opacity="0.7" />
      <circle cx="138" cy="46" r="10" stroke="currentColor" strokeWidth="1.6" opacity="0.4" />
      <rect x="16" y="58" width="28" height="34" rx="5" fill="currentColor" opacity="0.14" />
      <rect x="70" y="46" width="28" height="46" rx="5" fill="currentColor" opacity="0.22" />
      <rect x="124" y="66" width="28" height="26" rx="5" fill="currentColor" opacity="0.1" />
    </svg>
  );
}

// Aperçu admin (lecture seule) : ?asMember=<id> fait lire à chaque route le contexte du membre
// prévisualisé plutôt que celui de l'admin — jamais utilisé pour les actions d'écriture (rejoindre
// un défi reste bloqué par `canAct`, déjà faux en aperçu).
function withAsMember(url: string, asMemberId?: string): string {
  if (!asMemberId) return url;
  return `${url}${url.includes("?") ? "&" : "?"}asMember=${encodeURIComponent(asMemberId)}`;
}

export function ChallengesPage({ canAct, onNavigate, asMemberId }: { canAct: boolean; onNavigate: (view: View) => void; asMemberId?: string }) {
  const [current, setCurrent] = useState<CurrentResp | null>(null);
  const [points, setPoints] = useState<PointsResp | null>(null);
  const [onboarding, setOnboarding] = useState<OnboardingResp | null>(null);
  const [period, setPeriod] = useState<"month" | "year">("month");
  const [leaderboard, setLeaderboard] = useState<LeaderRow[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [joining, setJoining] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const historyRef = useRef<HTMLElement | null>(null);

  const load = useCallback(async () => {
    const [currentRes, pointsRes, listRes, onboardingRes] = await Promise.all([
      authenticatedFetch(withAsMember("/api/challenges/current", asMemberId)),
      authenticatedFetch(withAsMember("/api/challenges/points", asMemberId)),
      authenticatedFetch(withAsMember("/api/challenges", asMemberId)),
      authenticatedFetch(withAsMember("/api/challenges/onboarding", asMemberId)),
    ]);
    const [currentBody, pointsBody, listBody, onboardingBody] = await Promise.all([currentRes.json(), pointsRes.json(), listRes.json(), onboardingRes.json()]);
    setCurrent(currentBody as CurrentResp);
    setPoints(pointsBody as PointsResp);
    setHistory((listBody.history ?? []) as HistoryItem[]);
    const onboardingData = onboardingBody as OnboardingResp;
    setOnboarding(onboardingData);
    // Message de réussite ciblé pour les missions « Bien démarrer » venant d'être reconnues
    // (y compris rétroactivement) — au chargement de l'écran, comme filet de sécurité.
    if (onboardingData.available && onboardingData.justCompleted?.length) {
      const messages = onboardingData.justCompleted
        .map((slug) => onboardingData.missions.find((mission) => mission.slug === slug)?.successMessage)
        .filter((message): message is string => Boolean(message));
      if (messages.length) setNotice(messages.join(" · "));
    }
  }, [asMemberId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError("");
      try {
        await load();
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Chargement impossible.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [load, reloadToken]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await authenticatedFetch(withAsMember(`/api/challenges/leaderboard?period=${period}`, asMemberId));
        const body = await response.json() as { leaderboard?: LeaderRow[] };
        if (!cancelled) setLeaderboard(body.leaderboard ?? []);
      } catch {
        if (!cancelled) setLeaderboard([]);
      }
    })();
    return () => { cancelled = true; };
  }, [period, reloadToken, asMemberId]);

  async function join() {
    if (!canAct || joining) return;
    setJoining(true);
    setError("");
    try {
      const response = await authenticatedFetch("/api/challenges/current/join", { method: "POST" });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Inscription impossible.");
      setNotice("Tu participes au défi.");
      setReloadToken((token) => token + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Inscription impossible.");
    } finally {
      setJoining(false);
    }
  }

  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(""), 3200); return () => window.clearTimeout(timer); }, [notice]);

  function scrollToHistory() {
    historyRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  if (loading) {
    return (
      <div className="page-stack cha-page">
        <header className="cha-head"><h1>Défis</h1><p>Investir régulièrement, à son rythme — et progresser en famille.</p></header>
        <div className="cha-skeleton-hero" aria-hidden="true" />
        <div className="cha-stats">{[0, 1, 2, 3].map((i) => <div key={i} className="cha-skeleton-stat" aria-hidden="true" />)}</div>
      </div>
    );
  }

  const available = current?.available !== false;
  const challenge = current?.challenge ?? null;
  const state = current?.state ?? "challenge_ended";
  const progress = current?.progress ?? null;
  const meta = STATE_META[state];

  // « Mes défis » : les défis rejoints, l'actif d'abord, puis les plus récents.
  const joined = history.filter((item) => item.joined);
  const myChallenges = [...joined].sort((a, b) => {
    const aActive = challenge && a.id === challenge.id ? 1 : 0;
    const bActive = challenge && b.id === challenge.id ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;
    return startSortKey(b).localeCompare(startSortKey(a));
  });
  // « Historique récent » : uniquement les défis terminés (le membre a participé).
  const recentHistory = joined
    .filter((item) => item.participantStatus === "completed" || item.status === "completed" || item.status === "archived")
    .sort((a, b) => startSortKey(b).localeCompare(startSortKey(a)))
    .slice(0, 6);

  const rulesPanel = showRules ? (
    <section className="panel cha-rules" aria-label="Comment fonctionnent les défis">
      <header className="cha-rules-head">
        <h3>Comment fonctionnent les défis</h3>
        <button type="button" onClick={() => setShowRules(false)}>Fermer</button>
      </header>
      <ol className="cha-rules-steps">
        <li><span aria-hidden="true">1</span><div><strong>Je rejoins le défi</strong><small>Ton objectif mensuel est figé au moment où tu rejoins.</small></div></li>
        <li><span aria-hidden="true">2</span><div><strong>J’investis à mon rythme</strong><small>Chaque achat éligible sur ton compte compte automatiquement.</small></div></li>
        <li><span aria-hidden="true">3</span><div><strong>Je gagne des points</strong><small>Ton objectif atteint, tu remportes les points du défi.</small></div></li>
      </ol>
      <p className="cha-rules-note"><span aria-hidden="true"><NavIcon id="shield-check" /></span> Le classement récompense la régularité, jamais le montant investi. Ton objectif et tes montants restent privés.</p>
    </section>
  ) : null;

  return (
    <div className="page-stack cha-page">
      <header className="cha-head">
        <h1>Défis</h1>
        <p>Investir régulièrement, à son rythme — et progresser en famille.</p>
      </header>

      {!available && (
        <section className="panel cha-notice">
          <p>L’espace Défis sera actif dès que la migration <code>20260804_challenges_mvp.sql</code> aura été appliquée dans Supabase.</p>
        </section>
      )}

      {available && !challenge && (
        <section className="cha-hero cha-hero-empty">
          <TargetGlyph className="cha-hero-art" />
          <div className="cha-hero-body">
            <span className="cha-hero-kicker">Défis familiaux</span>
            <h2 className="cha-hero-title">Le prochain défi arrive bientôt</h2>
            <p className="cha-hero-desc">Chaque mois, un nouveau défi t’invite à investir à ton rythme et à progresser avec toute la famille.</p>
            <ol className="cha-mini-steps">
              <li><span aria-hidden="true">1</span>Je rejoins le défi</li>
              <li><span aria-hidden="true">2</span>J’investis à mon rythme</li>
              <li><span aria-hidden="true">3</span>Je gagne des points</li>
            </ol>
          </div>
          <aside className="cha-hero-aside">
            <span className="cha-hero-recurrence"><NavIcon id="calendar" /> Nouveau défi chaque mois</span>
            <button type="button" className="cha-hero-rules" onClick={() => setShowRules((value) => !value)}>Comprendre les défis</button>
          </aside>
        </section>
      )}

      {available && challenge && (
        <section className="cha-hero">
          <TargetGlyph className="cha-hero-art" />
          <div className="cha-hero-body">
            <span className="cha-hero-kicker">Défi du mois</span>
            <h2 className="cha-hero-title">{challenge.title}</h2>
            {challenge.description && <p className="cha-hero-desc">{challenge.description}</p>}
            <p className="cha-hero-facts">
              <span className="cha-hero-fact"><NavIcon id="calendar" /> {formatPeriod(challenge.startsOn, challenge.endsOn)}</span>
              {challenge.daysRemaining !== null && <>
                <span aria-hidden="true" className="cha-hero-dot">·</span>
                <span className="cha-hero-fact">{formatDeadline(challenge.daysRemaining)}</span>
              </>}
              <span className={`cha-badge ${meta.badgeCls}`}>{meta.badge}</span>
            </p>

            {progress ? (
              <div className="cha-hero-progress">
                <div className="cha-hero-progress-head">
                  <span>Ma progression</span>
                  <span className="cha-hero-pct">{Math.round(progress.pct)} %</span>
                </div>
                <strong className="cha-hero-amount">{euro0.format(progress.invested)} <em>sur {euro0.format(progress.targetAmount)}</em></strong>
                <div className="cha-bar"><span style={{ width: `${Math.max(0, Math.min(100, progress.pct))}%` }} /></div>
                <p className="cha-hero-note">Chaque achat éligible te rapproche de ton objectif.</p>
              </div>
            ) : (
              <p className="cha-hero-note cha-hero-note-lead">{heroHint(state)}</p>
            )}
          </div>
          <aside className="cha-hero-aside">
            <div className="cha-reward">
              <span className="cha-reward-icon" aria-hidden="true"><NavIcon id="star" /></span>
              <strong>+{challenge.pointsReward}</strong>
              <small>points</small>
            </div>
            <div className="cha-hero-actions">
              {renderCta({ state, canAct, joining, onNavigate, onJoin: join })}
              <button type="button" className="cha-hero-rules" onClick={() => setShowRules((value) => !value)}>Voir les règles</button>
            </div>
          </aside>
        </section>
      )}

      {error && <p className="cha-error" role="alert">{error}</p>}
      {notice && <div className="toast" role="status">✓ {notice}</div>}
      {rulesPanel}

      {/* Parcours individuel « Bien démarrer » — permanent, distinct du défi du mois. */}
      {onboarding?.available && (
        <section className="panel cha-onboard" aria-label="Bien démarrer">
          <header className="cha-onboard-head">
            <div>
              <h3>Bien démarrer</h3>
              <p>Complète ces étapes pour prendre en main ton espace d’investissement.</p>
            </div>
            {onboarding.completedCount < onboarding.totalCount ? (
              <span className="cha-onboard-step-label">{onboarding.completedCount} étape{onboarding.completedCount > 1 ? "s" : ""} sur {onboarding.totalCount}</span>
            ) : (
              <span className="cha-badge cha-badge-done">Parcours terminé</span>
            )}
          </header>

          {onboarding.completedCount < onboarding.totalCount && (
            <>
              <div className="cha-bar cha-onboard-bar"><span style={{ width: `${Math.round((onboarding.completedCount / onboarding.totalCount) * 100)}%` }} /></div>
              <p className="cha-onboard-points">{intFmt.format(onboarding.earnedPoints)} / {intFmt.format(onboarding.totalPoints)} points</p>
            </>
          )}

          {onboarding.completedCount === onboarding.totalCount ? (
            <p className="cha-onboard-success">Bravo, tu as terminé les 4 premières étapes — {intFmt.format(onboarding.totalPoints)} points gagnés !</p>
          ) : (
            <ul className="cha-onboard-grid">
              {onboarding.missions.map((mission) => (
                <li key={mission.slug} className={mission.status === "done" ? "cha-onboard-item is-done" : "cha-onboard-item"}>
                  <span className="cha-onboard-item-icon" aria-hidden="true">{mission.status === "done" ? <CheckIcon /> : <NavIcon id="star" />}</span>
                  <div className="cha-onboard-item-body">
                    <span className={mission.status === "done" ? "cha-chip cha-chip-done" : "cha-chip cha-chip-todo"}>{mission.status === "done" ? "Terminé" : "À faire"}</span>
                    <strong>{mission.title}</strong>
                    <small>{mission.description}</small>
                  </div>
                  <div className="cha-onboard-item-side">
                    <span className="cha-onboard-item-points">{mission.status === "done" ? `+${mission.points} pts` : `${mission.points} pts`}</span>
                    {mission.status === "done"
                      ? <span className="cha-onboard-done-mark" aria-hidden="true"><CheckIcon /></span>
                      : <button type="button" className="cha-onboard-cta" onClick={() => onNavigate(mission.view)}>{mission.cta}</button>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* Mes indicateurs */}
      <div className="cha-stats">
        <StatCard icon={<NavIcon id="star" />} value={intFmt.format(points?.totalPoints ?? 0)} label="Points totaux" />
        <StatCard icon={<NavIcon id="calendar" />} value={intFmt.format(points?.yearPoints ?? 0)} label="Cette année" />
        <StatCard icon={<TrophyIcon />} value={intFmt.format(points?.challengesCompleted ?? 0)} label="Défis terminés" />
        <StatCard icon={<NavIcon id="users" />} value={points?.rank ? `#${points.rank}` : "—"} label="Rang familial" />
      </div>

      <div className="cha-lower">
        {/* Classement familial */}
        <section className="panel cha-board">
          <header className="cha-board-head">
            <h3>Classement familial</h3>
            <div className="cha-period" role="tablist" aria-label="Période du classement">
              <button type="button" role="tab" aria-selected={period === "month"} className={period === "month" ? "active" : ""} onClick={() => setPeriod("month")}>Ce mois-ci</button>
              <button type="button" role="tab" aria-selected={period === "year"} className={period === "year" ? "active" : ""} onClick={() => setPeriod("year")}>Cette année</button>
            </div>
          </header>
          {leaderboard.length === 0 ? (
            <div className="cha-board-empty">
              <PodiumGlyph />
              <p>Le classement apparaîtra dès les premiers points gagnés {period === "month" ? "ce mois-ci" : "cette année"}.</p>
            </div>
          ) : (
            <ol className="cha-board-list">
              {leaderboard.map((row) => (
                <li key={row.memberId} className={row.isCurrentMember ? "cha-board-row is-me" : "cha-board-row"}>
                  <span className={`cha-board-rank${row.rank <= 3 ? ` rank-${row.rank}` : ""}`}>{row.rank}</span>
                  {/* eslint-disable-next-line @next/next/no-img-element -- avatar Supabase Storage ; le projet n'utilise pas next/image (aucune config remotePatterns). */}
                  {row.photoUrl ? <img className="cha-avatar" src={row.photoUrl} alt="" aria-hidden="true" /> : <span className="cha-avatar" aria-hidden="true">{initials(row.name)}</span>}
                  <span className="cha-board-name">{row.name}</span>
                  <span className="cha-board-points">{intFmt.format(row.points)} pts</span>
                </li>
              ))}
            </ol>
          )}
          <p className="cha-board-note"><span aria-hidden="true"><NavIcon id="shield-check" /></span> Le classement récompense la régularité, jamais le montant investi.</p>
        </section>

        {/* Mes défis */}
        <section className="panel cha-mine">
          <header className="cha-board-head"><h3>Mes défis</h3></header>
          {myChallenges.length === 0 ? (
            <div className="cha-mine-empty">
              <TargetGlyph className="cha-mine-art" />
              <strong>Ton premier défi t’attend</strong>
              <p>Rejoins le défi du mois pour commencer à gagner des points.</p>
              <button type="button" className="cha-cta cha-cta-soft" onClick={() => setShowRules((value) => !value)}>Découvrir le fonctionnement</button>
            </div>
          ) : (
            <>
              <ul className="cha-mine-list">
                {myChallenges.slice(0, 3).map((item) => {
                  const isActive = Boolean(challenge && item.id === challenge.id) && item.participantStatus === "in_progress";
                  const won = item.participantStatus === "completed";
                  const iconCls = isActive ? "is-active" : won ? "is-done" : "is-muted";
                  const chipCls = isActive ? "cha-chip-progress" : won ? "cha-chip-done" : "cha-chip-muted";
                  const pct = isActive && progress ? Math.round(progress.pct) : 0;
                  return (
                    <li key={item.id} className="cha-mine-row">
                      <span className={`cha-mine-icon ${iconCls}`} aria-hidden="true">{isActive ? <NavIcon id="star" /> : <CheckIcon />}</span>
                      <div className="cha-mine-main">
                        <span className={`cha-chip ${chipCls}`}>{isActive ? "En cours" : "Terminé"}</span>
                        <strong>{item.title}</strong>
                        {isActive ? (
                          <>
                            <div className="cha-bar cha-bar-sm"><span style={{ width: `${pct}%` }} /></div>
                            <small className="cha-mine-reward">+{intFmt.format(item.pointsReward)} pts à gagner</small>
                          </>
                        ) : (
                          <small className={item.pointsEarned > 0 ? "cha-mine-reward up" : "cha-mine-reward"}>{item.pointsEarned > 0 ? `+${intFmt.format(item.pointsEarned)} pts` : "Objectif non atteint"}</small>
                        )}
                      </div>
                      {isActive && <span className="cha-mine-pct">{pct} %</span>}
                    </li>
                  );
                })}
              </ul>
              <button type="button" className="cha-link" onClick={scrollToHistory}>Voir tout l’historique →</button>
            </>
          )}
        </section>
      </div>

      {/* Historique récent */}
      <section className="panel cha-history" ref={historyRef}>
        <header className="cha-board-head"><h3>Historique récent</h3></header>
        {recentHistory.length === 0 ? (
          <p className="cha-history-empty">Aucun défi terminé pour l’instant — ton historique s’affichera ici.</p>
        ) : (
          <div className="cha-history-table" role="table">
            <div className="cha-history-row cha-history-head" role="row">
              <span role="columnheader">Défi</span>
              <span role="columnheader">Période</span>
              <span role="columnheader">Résultat</span>
              <span role="columnheader" className="cha-history-num">Points</span>
            </div>
            {recentHistory.map((item) => {
              const won = item.participantStatus === "completed";
              return (
                <div key={item.id} className="cha-history-row" role="row">
                  <span role="cell" className="cha-history-defi">
                    <span className={`cha-history-mark ${won ? "is-done" : ""}`} aria-hidden="true"><CheckIcon /></span>
                    {item.title}
                  </span>
                  <span role="cell" className="cha-history-muted">{formatMonthYear(item.startsOn)}</span>
                  <span role="cell" className={won ? "cha-history-result up" : "cha-history-result"}>{won ? "Objectif atteint" : "Terminé"}</span>
                  <span role="cell" className={item.pointsEarned > 0 ? "cha-history-num up" : "cha-history-num"}>{item.pointsEarned > 0 ? `+${intFmt.format(item.pointsEarned)}` : "—"}</span>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function StatCard({ icon, value, label }: { icon: ReactNode; value: string; label: string }) {
  return (
    <article className="cha-stat">
      <span className="cha-stat-icon" aria-hidden="true">{icon}</span>
      <span className="cha-stat-body"><strong>{value}</strong><small>{label}</small></span>
    </article>
  );
}

function renderCta({ state, canAct, joining, onNavigate, onJoin }: { state: MemberState; canAct: boolean; joining: boolean; onNavigate: (view: View) => void; onJoin: () => void }) {
  if (state === "no_plan") return <button type="button" className="cha-cta" onClick={() => onNavigate("parametres")}>Configurer mon rythme</button>;
  if (state === "no_account") return <button type="button" className="cha-cta" onClick={() => onNavigate("parametres")}>Choisir un compte</button>;
  if (state === "ready_to_join") return <button type="button" className="cha-cta" disabled={!canAct || joining} onClick={onJoin}>{joining ? "Inscription…" : "Rejoindre le défi"}</button>;
  if (state === "in_progress") return canAct
    ? <button type="button" className="cha-cta" onClick={() => onNavigate("investissements-pea")}>Continuer le défi</button>
    : <button type="button" className="cha-cta" onClick={() => onNavigate("investissements-pea")}>Voir mon investissement</button>;
  if (state === "completed") return <button type="button" className="cha-cta" onClick={() => onNavigate("investissements-pea")}>Voir mon investissement</button>;
  return null;
}

/**
 * Le CTA du tableau de bord NAVIGUE, il ne mute jamais : rejoindre un défi reste une action de
 * l'écran Défis (une seule implémentation de `join`, avec ses états d'erreur). On envoie donc le
 * membre là où l'action est réellement possible, selon ce qui lui manque.
 */
function dashboardCta(state: MemberState): { label: string; view: View } | null {
  if (state === "no_plan") return { label: "Configurer mon rythme →", view: "parametres" };
  if (state === "no_account") return { label: "Choisir un compte →", view: "parametres" };
  if (state === "ready_to_join") return { label: "Rejoindre le défi →", view: "investissements-suggestions" };
  if (state === "in_progress") return { label: "Voir ma progression →", view: "investissements-suggestions" };
  if (state === "completed") return { label: "Voir mes points →", view: "investissements-suggestions" };
  return null;
}

/**
 * Carte « Mes défis » du tableau de bord — point d'entrée unique de la gamification sur l'accueil.
 *
 * Priorité descendante, un seul point focal : (1) le défi COURANT s'il existe, avec sa progression
 * réelle et l'action qui débloque la suite ; (2) le parcours permanent « Bien démarrer » tant qu'il
 * n'est pas terminé ; (3) points et rang, uniquement s'ils existent vraiment.
 *
 * Si le membre n'a ni défi courant ni parcours en cours, la carte ne s'affiche PAS : jamais de
 * bloc vide ni de chiffre fabriqué sur l'accueil (cf. règle « aucune donnée fictive »). Chaque
 * valeur vient des routes /api/challenges/* — aucun calcul dupliqué ici.
 */
export function ChallengesDashboardCard({ navigate, asMemberId }: { navigate: (view: View) => void; asMemberId?: string }) {
  const [current, setCurrent] = useState<CurrentResp | null>(null);
  const [onboarding, setOnboarding] = useState<OnboardingResp | null>(null);
  const [points, setPoints] = useState<PointsResp | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Chaque bloc dégrade indépendamment : une route indisponible masque SA section, jamais la carte.
    const read = async <T,>(url: string): Promise<T | null> => {
      try {
        const response = await authenticatedFetch(withAsMember(url, asMemberId));
        if (!response.ok) return null;
        return await response.json() as T;
      } catch {
        return null;
      }
    };
    void (async () => {
      const [currentBody, onboardingBody, pointsBody] = await Promise.all([
        read<CurrentResp>("/api/challenges/current"),
        read<OnboardingResp>("/api/challenges/onboarding"),
        read<PointsResp>("/api/challenges/points"),
      ]);
      if (cancelled) return;
      setCurrent(currentBody);
      setOnboarding(onboardingBody);
      setPoints(pointsBody);
    })();
    return () => { cancelled = true; };
  }, [asMemberId]);

  const challenge = current?.available === true ? current.challenge : null;
  const state = current?.state ?? "challenge_ended";
  const progress = current?.progress ?? null;
  const showOnboarding = Boolean(onboarding?.available && onboarding.totalCount > 0 && onboarding.completedCount < onboarding.totalCount);
  const showPoints = Boolean(points && points.available !== false && (points.totalPoints > 0 || points.rank !== null));

  if (!challenge && !showOnboarding) return null;

  const meta = STATE_META[state];
  const cta = challenge ? dashboardCta(state) : null;
  const nextMission = onboarding?.missions.find((mission) => mission.status === "todo") ?? null;
  const onboardingPct = onboarding && onboarding.totalCount > 0
    ? Math.round((onboarding.completedCount / onboarding.totalCount) * 100)
    : 0;

  return (
    <section className="panel home-card cha-dash" aria-label="Mes défis">
      <header className="cha-dash-head">
        <h3 className="home-card-kicker">MES DÉFIS</h3>
        <button type="button" className="home-card-link" onClick={() => navigate("investissements-suggestions")}>Voir les défis →</button>
      </header>

      {challenge && (
        <div className="cha-dash-focus">
          <div className="cha-dash-focus-top">
            <span className="cha-dash-kicker"><span aria-hidden="true"><NavIcon id="star" /></span> Défi du mois</span>
            <span className={`cha-badge ${meta.badgeCls}`}>{meta.badge}</span>
          </div>
          <strong className="cha-dash-title">{challenge.title}</strong>
          <p className="cha-dash-facts">
            <span>{formatPeriod(challenge.startsOn, challenge.endsOn)}</span>
            {challenge.daysRemaining !== null && <><span aria-hidden="true">·</span><span>{formatDeadline(challenge.daysRemaining)}</span></>}
            <span aria-hidden="true">·</span>
            <span className="cha-dash-reward">+{intFmt.format(challenge.pointsReward)} pts</span>
          </p>

          {progress ? (
            <>
              <p className="cha-dash-amount">
                <strong>{euro0.format(progress.invested)}</strong>
                <em>sur {euro0.format(progress.targetAmount)}</em>
                <span className="cha-dash-pct">{Math.round(progress.pct)} %</span>
              </p>
              <div className="cha-bar"><span style={{ width: `${Math.max(0, Math.min(100, progress.pct))}%` }} /></div>
            </>
          ) : (
            <p className="cha-dash-hint">{heroHint(state)}</p>
          )}

          {cta && <button type="button" className="cha-dash-cta" onClick={() => navigate(cta.view)}>{cta.label}</button>}
        </div>
      )}

      {challenge && showOnboarding && <div className="cha-dash-sep" role="presentation" />}

      {showOnboarding && onboarding && (
        <div className="cha-dash-onboard">
          <div className="cha-dash-focus-top">
            <span className="cha-dash-kicker">Bien démarrer</span>
            <span className="cha-dash-steps">{onboarding.completedCount} / {onboarding.totalCount} étapes · {intFmt.format(onboarding.earnedPoints)} / {intFmt.format(onboarding.totalPoints)} pts</span>
          </div>
          <div className="cha-bar cha-bar-sm"><span style={{ width: `${onboardingPct}%` }} /></div>
          {nextMission && (
            <button type="button" className="cha-dash-next" onClick={() => navigate(nextMission.view)}>
              <span className="cha-dash-next-label">Prochaine étape · {nextMission.title}</span>
              <em>+{intFmt.format(nextMission.points)} pts</em>
              <span aria-hidden="true">→</span>
            </button>
          )}
        </div>
      )}

      {showPoints && points && (
        <p className="cha-dash-foot">
          <span aria-hidden="true"><NavIcon id="star" /></span>
          {intFmt.format(points.totalPoints)} point{points.totalPoints > 1 ? "s" : ""} au total
          {points.rank !== null && <> · <strong>#{points.rank}</strong> en famille</>}
        </p>
      )}
    </section>
  );
}

/**
 * Entrée dashboard unique de la gamification. Cette vue ne réconcilie ni ne calcule : elle
 * reçoit le contrat agrégé par /api/challenges/summary et ne présente que des données réelles.
 */
export function ChallengesDashboardSection({ summary, navigate }: { summary: ChallengesDashboardSummary; navigate: (view: View) => void }) {
  const challenge = summary.current?.available ? summary.current.challenge : null;
  const state = summary.current?.state ?? "challenge_ended";
  const progress = summary.current?.progress ?? null;
  const onboarding = summary.onboarding?.available ? summary.onboarding : null;
  const nextMission = onboarding?.missions.find((mission) => mission.status === "todo") ?? null;
  const points = summary.points?.available === false ? null : summary.points;
  const currentMember = summary.leaderboard.find((entry) => entry.isCurrentMember) ?? null;
  const topThree = summary.leaderboard.slice(0, 3);
  const inTopThree = Boolean(currentMember && topThree.some((entry) => entry.memberId === currentMember.memberId));
  const cta = challenge ? dashboardCta(state) : null;
  const onboardingPct = onboarding && onboarding.totalCount > 0 ? Math.round((onboarding.completedCount / onboarding.totalCount) * 100) : 0;
  const actions = Number(Boolean(challenge)) + Number(Boolean(nextMission));

  if (!summary.available) return null;

  return (
    <section className="cha-dashboard-section" aria-label="Défis et classement familial">
      <section className="panel home-card cha-dashboard-missions" aria-labelledby="dashboard-challenges-title">
        <header className="cha-dashboard-head">
          <div>
            <h3 id="dashboard-challenges-title">Mes défis</h3>
            <p>{actions > 0 ? `${actions} action${actions > 1 ? "s" : ""} prioritaire${actions > 1 ? "s" : ""}` : "Suivi de mes progrès"}</p>
          </div>
          <button type="button" className="home-card-link" onClick={() => navigate("investissements-suggestions")}>Voir tous mes défis →</button>
        </header>

        {challenge && (
          <article className="cha-dashboard-action">
            <span className="cha-dashboard-action-icon" aria-hidden="true"><NavIcon id="trending-up" /></span>
            <div className="cha-dashboard-action-main">
              <div className="cha-dashboard-action-meta"><span>Défi du mois</span><span className={`cha-badge ${STATE_META[state].badgeCls}`}>{STATE_META[state].badge}</span></div>
              <strong>{challenge.title}</strong>
              <small>{formatPeriod(challenge.startsOn, challenge.endsOn)}</small>
              {progress ? <>
                <div className="cha-dashboard-progress-label"><span>{euro0.format(progress.invested)} sur {euro0.format(progress.targetAmount)}</span><b>{Math.round(progress.pct)} %</b></div>
                <div className="cha-bar cha-dashboard-bar"><span style={{ width: `${Math.max(0, Math.min(100, progress.pct))}%` }} /></div>
              </> : <small className="cha-dashboard-hint">{heroHint(state)}</small>}
            </div>
            <div className="cha-dashboard-action-side"><span>+{intFmt.format(challenge.pointsReward)} pts</span>{cta && <button type="button" onClick={() => navigate(cta.view)}>{cta.label}</button>}</div>
          </article>
        )}

        {nextMission && onboarding && (
          <article className="cha-dashboard-action cha-dashboard-onboarding">
            <span className="cha-dashboard-action-icon" aria-hidden="true"><NavIcon id="users" /></span>
            <div className="cha-dashboard-action-main">
              <div className="cha-dashboard-action-meta"><span>Bien démarrer</span><span>{onboarding.completedCount}/{onboarding.totalCount} étapes</span></div>
              <strong>{nextMission.title}</strong>
              <div className="cha-dashboard-progress-label"><span>{intFmt.format(onboarding.earnedPoints)} / {intFmt.format(onboarding.totalPoints)} pts</span><b>{onboardingPct} %</b></div>
              <div className="cha-bar cha-dashboard-bar"><span style={{ width: `${onboardingPct}%` }} /></div>
            </div>
            <div className="cha-dashboard-action-side"><span>+{intFmt.format(nextMission.points)} pts</span><button type="button" onClick={() => navigate(nextMission.view)}>{nextMission.cta} →</button></div>
          </article>
        )}

        {!challenge && !nextMission && <p className="cha-dashboard-empty">Aucun défi actif pour le moment. Tes prochains défis apparaîtront ici.</p>}
      </section>

      <section className="panel home-card cha-dashboard-leaderboard" aria-labelledby="dashboard-leaderboard-title">
        <header className="cha-dashboard-head"><div><h3 id="dashboard-leaderboard-title">Classement familial</h3><p>Ce mois-ci</p></div></header>
        {!summary.leaderboardOptIn ? (
          <div className="cha-dashboard-optout">
            {points && <strong>{intFmt.format(points.monthPoints)} pts ce mois-ci</strong>}
            <p>Participation au classement désactivée.</p>
            <button type="button" className="home-card-link" onClick={() => navigate("parametres")}>Régler mon rythme →</button>
          </div>
        ) : summary.leaderboard.length === 0 ? (
          <div className="cha-dashboard-board-empty"><TrophyIcon /><p>Le classement apparaîtra dès que des membres participeront.</p></div>
        ) : <>
          <div className="cha-dashboard-personal"><span className="cha-dashboard-rank">{points?.rank ? `${points.rank}e` : "—"}</span><div><strong>{points?.rank ? `${points.rank}e sur ${points.participantCount}` : "Classement en cours"}</strong><small>{intFmt.format(points?.monthPoints ?? 0)} pts gagnés ce mois</small></div></div>
          {points && <div className="cha-dashboard-level"><span>{points.level}</span>{points.monthlyStreak > 0 && <span>{points.monthlyStreak} mois de régularité</span>}</div>}
          <ol className="cha-dashboard-board-list">
            {topThree.map((entry) => <DashboardLeaderboardRow key={entry.memberId} entry={entry} />)}
            {!inTopThree && currentMember && <><li className="cha-dashboard-board-divider" aria-hidden="true" /><DashboardLeaderboardRow entry={currentMember} /></>}
          </ol>
          <button type="button" className="home-card-link cha-dashboard-board-link" onClick={() => navigate("investissements-suggestions")}>Voir le classement →</button>
        </>}
      </section>
    </section>
  );
}

function DashboardLeaderboardRow({ entry }: { entry: LeaderRow }) {
  return <li className={entry.isCurrentMember ? "cha-dashboard-board-row is-me" : "cha-dashboard-board-row"}>
    <span className="cha-dashboard-board-rank">{entry.rank}</span>
    {entry.photoUrl
      // eslint-disable-next-line @next/next/no-img-element -- avatars Supabase Storage, sans remotePatterns Next.
      ? <img className="cha-avatar" src={entry.photoUrl} alt="" aria-hidden="true" />
      : <span className="cha-avatar" aria-hidden="true">{initials(entry.name)}</span>}
    <span className="cha-dashboard-board-name">{entry.name}</span>
    <strong>{intFmt.format(entry.points)} pts</strong>
  </li>;
}
