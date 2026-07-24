"use client";

// Écran membre « Défis » (MVP Phase 2). Données RÉELLES uniquement, via les API /api/challenges/*.
// N'affiche jamais l'objectif ni le montant investi d'un autre membre : le hero montre la propre
// progression du membre connecté ; le classement n'expose que rang/points (aucun montant).
// Réutilise le shell, les tokens et les polices existants ; aucun nouveau design system.

import { useCallback, useEffect, useState } from "react";
import type { View } from "../lib/navigation";
import { authenticatedFetch } from "./investment-shared";
import "./challenges.css";

type MemberState = "no_plan" | "no_account" | "ready_to_join" | "in_progress" | "completed" | "challenge_ended";
type CurrentResp = {
  available: boolean; state: MemberState; hasPlan: boolean; hasTargetAccount: boolean; isParticipant: boolean;
  challenge: { id: string; title: string; description: string | null; startsOn: string; endsOn: string; pointsReward: number; daysRemaining: number } | null;
  progress: { invested: number; targetAmount: number; pct: number; completed: boolean; status: string } | null;
};
type PointsResp = { available?: boolean; totalPoints: number; yearPoints: number; challengesCompleted: number; rank: number | null };
type LeaderRow = { rank: number; memberId: string; name: string; photoUrl: string | null; points: number; challengesCompleted: number; isCurrentMember?: boolean };
type HistoryItem = { id: string; title: string; startsOn: string; endsOn: string; status: string; pointsReward: number; joined: boolean; participantStatus: string | null; pointsEarned: number };

const euro0 = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const intFmt = new Intl.NumberFormat("fr-FR");
function initials(name: string): string {
  return name.trim().slice(0, 2).toUpperCase();
}

const STATE_META: Record<MemberState, { badge: string; badgeCls: string }> = {
  no_plan: { badge: "À configurer", badgeCls: "cha-badge-muted" },
  no_account: { badge: "À configurer", badgeCls: "cha-badge-muted" },
  ready_to_join: { badge: "Prêt à commencer", badgeCls: "cha-badge-ready" },
  in_progress: { badge: "En cours", badgeCls: "cha-badge-progress" },
  completed: { badge: "Objectif atteint", badgeCls: "cha-badge-done" },
  challenge_ended: { badge: "Défi terminé", badgeCls: "cha-badge-muted" },
};

function ProgressRing({ pct }: { pct: number }) {
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, pct));
  const offset = circumference * (1 - clamped / 100);
  return (
    <svg className="cha-ring" viewBox="0 0 128 128" role="img" aria-label={`Progression ${Math.round(clamped)} %`}>
      <circle className="cha-ring-track" cx="64" cy="64" r={radius} fill="none" strokeWidth="10" />
      <circle className="cha-ring-value" cx="64" cy="64" r={radius} fill="none" strokeWidth="10" strokeLinecap="round"
        strokeDasharray={circumference} strokeDashoffset={offset} transform="rotate(-90 64 64)" />
      <text className="cha-ring-pct" x="64" y="64" textAnchor="middle" dominantBaseline="central">{Math.round(clamped)} %</text>
    </svg>
  );
}

export function ChallengesPage({ canAct, onNavigate }: { canAct: boolean; onNavigate: (view: View) => void }) {
  const [current, setCurrent] = useState<CurrentResp | null>(null);
  const [points, setPoints] = useState<PointsResp | null>(null);
  const [period, setPeriod] = useState<"month" | "year">("month");
  const [leaderboard, setLeaderboard] = useState<LeaderRow[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [joining, setJoining] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const load = useCallback(async () => {
    const [currentRes, pointsRes, listRes] = await Promise.all([
      authenticatedFetch("/api/challenges/current"),
      authenticatedFetch("/api/challenges/points"),
      authenticatedFetch("/api/challenges"),
    ]);
    const [currentBody, pointsBody, listBody] = await Promise.all([currentRes.json(), pointsRes.json(), listRes.json()]);
    setCurrent(currentBody as CurrentResp);
    setPoints(pointsBody as PointsResp);
    setHistory((listBody.history ?? []) as HistoryItem[]);
  }, []);

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
        const response = await authenticatedFetch(`/api/challenges/leaderboard?period=${period}`);
        const body = await response.json() as { leaderboard?: LeaderRow[] };
        if (!cancelled) setLeaderboard(body.leaderboard ?? []);
      } catch {
        if (!cancelled) setLeaderboard([]);
      }
    })();
    return () => { cancelled = true; };
  }, [period, reloadToken]);

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

  if (loading) {
    return <div className="page-stack cha-page"><header className="cha-head"><h1>Défis</h1></header><div className="cha-skeleton-hero" aria-hidden="true" /></div>;
  }

  const available = current?.available !== false;
  const challenge = current?.challenge ?? null;
  const state = current?.state ?? "challenge_ended";
  const progress = current?.progress ?? null;
  const meta = STATE_META[state];

  return (
    <div className="page-stack cha-page">
      <header className="cha-head">
        <h1>Défis</h1>
        <p>Investir régulièrement, à son rythme — et progresser en famille.</p>
      </header>

      {!available && (
        <section className="panel cha-empty">
          <p>L’espace Défis sera actif dès que la migration <code>20260804_challenges_mvp.sql</code> aura été appliquée dans Supabase.</p>
        </section>
      )}

      {available && !challenge && (
        <section className="panel cha-empty">
          <span className="cha-empty-icon" aria-hidden="true">🎯</span>
          <h2>Aucun défi en cours</h2>
          <p>Il n’y a pas de défi actif pour le moment. Reviens bientôt : un nouveau défi familial arrive chaque mois.</p>
        </section>
      )}

      {available && challenge && (
        <section className="cha-hero">
          <div className="cha-hero-copy">
            <span className="cha-hero-kicker">DÉFI DU MOIS</span>
            <h2>{challenge.title}</h2>
            {challenge.description && <p className="cha-hero-desc">{challenge.description}</p>}
            <div className="cha-hero-facts">
              <span>📅 {challenge.daysRemaining} jour{challenge.daysRemaining > 1 ? "s" : ""} restant{challenge.daysRemaining > 1 ? "s" : ""}</span>
              <span aria-hidden="true">·</span>
              <span>⭐ {challenge.pointsReward} points</span>
            </div>
            <div className="cha-hero-cta">
              {renderCta({ state, canAct, joining, onNavigate, onJoin: join })}
              <span className={`cha-badge ${meta.badgeCls}`}>{meta.badge}</span>
            </div>
          </div>
          <div className="cha-hero-ring">
            <ProgressRing pct={progress?.pct ?? 0} />
            <p className="cha-hero-amount">
              {progress ? `${euro0.format(progress.invested)} sur ${euro0.format(progress.targetAmount)}` : "Rejoins le défi pour suivre ta progression"}
            </p>
          </div>
        </section>
      )}

      {error && <p className="cha-error" role="alert">{error}</p>}
      {notice && <div className="toast" role="status">✓ {notice}</div>}

      {/* Mes indicateurs */}
      <div className="cha-stats">
        <StatCard icon="⭐" value={intFmt.format(points?.totalPoints ?? 0)} label="Points" />
        <StatCard icon="🌱" value={intFmt.format(points?.yearPoints ?? 0)} label="Cette année" />
        <StatCard icon="✓" value={intFmt.format(points?.challengesCompleted ?? 0)} label="Défis terminés" />
        <StatCard icon="👪" value={points?.rank ? `#${points.rank}` : "—"} label="Rang familial" />
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
            <p className="cha-board-empty">Le classement s’affichera dès que des points auront été gagnés ce {period === "month" ? "mois" : "année"}.</p>
          ) : (
            <ul className="cha-board-list">
              {leaderboard.map((row) => (
                <li key={row.memberId} className={row.isCurrentMember ? "cha-board-row is-me" : "cha-board-row"}>
                  <span className="cha-board-rank">{row.rank}</span>
                  {/* eslint-disable-next-line @next/next/no-img-element -- avatar Supabase Storage ; le projet n'utilise pas next/image (aucune config remotePatterns). */}
                  {row.photoUrl ? <img className="cha-avatar" src={row.photoUrl} alt="" aria-hidden="true" /> : <span className="cha-avatar" aria-hidden="true">{initials(row.name)}</span>}
                  <span className="cha-board-name">{row.name}</span>
                  <span className="cha-board-points">{intFmt.format(row.points)} pts</span>
                </li>
              ))}
            </ul>
          )}
          <p className="cha-board-note"><span aria-hidden="true">🛡️</span> Le classement récompense la régularité, jamais le montant investi.</p>
        </section>

        {/* Mes défis (historique) */}
        <section className="panel cha-history">
          <header className="cha-board-head"><h3>Mes défis</h3></header>
          {history.filter((item) => item.joined).length === 0 ? (
            <p className="cha-board-empty">Tu n’as pas encore rejoint de défi. Rejoins le défi du mois pour commencer à gagner des points.</p>
          ) : (
            <ul className="cha-history-list">
              {history.filter((item) => item.joined).map((item) => (
                <li key={item.id} className="cha-history-row">
                  <span className="cha-history-icon" aria-hidden="true">{item.participantStatus === "completed" ? "🏁" : "📅"}</span>
                  <div className="cha-history-main">
                    <strong>{item.title}</strong>
                    <small>{item.participantStatus === "completed" ? "Objectif atteint" : item.status === "completed" || item.status === "archived" ? "Terminé" : "En cours"}</small>
                  </div>
                  <span className={item.pointsEarned > 0 ? "cha-history-points up" : "cha-history-points"}>{item.pointsEarned > 0 ? `+${intFmt.format(item.pointsEarned)} pts` : "—"}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function StatCard({ icon, value, label }: { icon: string; value: string; label: string }) {
  return (
    <article className="cha-stat">
      <span className="cha-stat-icon" aria-hidden="true">{icon}</span>
      <div><strong>{value}</strong><small>{label}</small></div>
    </article>
  );
}

function renderCta({ state, canAct, joining, onNavigate, onJoin }: { state: MemberState; canAct: boolean; joining: boolean; onNavigate: (view: View) => void; onJoin: () => void }) {
  if (state === "no_plan") return <button type="button" className="cha-cta" onClick={() => onNavigate("parametres")}>Configurer mon rythme</button>;
  if (state === "no_account") return <button type="button" className="cha-cta" onClick={() => onNavigate("parametres")}>Choisir un compte</button>;
  if (state === "ready_to_join") return <button type="button" className="cha-cta" disabled={!canAct || joining} onClick={onJoin}>{joining ? "Inscription…" : "Rejoindre le défi"}</button>;
  if (state === "in_progress") return canAct
    ? <button type="button" className="cha-cta" onClick={() => onNavigate("investissements-pea")}>Enregistrer mon achat</button>
    : <button type="button" className="cha-cta" onClick={() => onNavigate("investissements-pea")}>Voir mon investissement</button>;
  if (state === "completed") return <button type="button" className="cha-cta" onClick={() => onNavigate("investissements-pea")}>Voir mon investissement</button>;
  return null;
}
