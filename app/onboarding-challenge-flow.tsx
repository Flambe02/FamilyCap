"use client";

// Parcours guidé des défis « Bien démarrer ». Il est volontairement séparé des
// Paramètres : le défi reste un enchaînement d'actions, pas un deep-link fragile
// vers une rubrique générale dont l'état peut dépendre de la vue précédente.

import { useEffect, useState, type FormEvent } from "react";
import type { Viewer } from "../lib/auth-types";
import { authenticatedFetch } from "./investment-shared";
import { useDialogA11y } from "./use-dialog-a11y";
import type { OnboardingMissionDto } from "./challenges-page";

type MissionSlug = OnboardingMissionDto["slug"];
type MissionProgress = { missions: OnboardingMissionDto[]; completedCount: number; totalCount: number; earnedPoints: number; totalPoints: number };
type Points = { totalPoints: number; rank: number | null };
type Account = { id: string; name: string; accountType: string; memberName: string | null };

function destinationForMission(slug: MissionSlug): "portfolio" | "purchase" | null {
  if (slug === "onboarding_existing_portfolio") return "portfolio";
  if (slug === "onboarding_first_purchase") return "purchase";
  return null;
}

export function OnboardingChallengeFlow({
  viewer,
  initialMission,
  readOnly,
  onClose,
  onOpenMissionArea,
  onRefresh,
}: {
  viewer: Viewer;
  initialMission: OnboardingMissionDto;
  readOnly: boolean;
  onClose: () => void;
  onOpenMissionArea: (mission: OnboardingMissionDto) => void;
  onRefresh: () => void;
}) {
  const [mission, setMission] = useState(initialMission);
  const [phase, setPhase] = useState<"intro" | "form" | "success">("intro");
  const [institution, setInstitution] = useState("");
  const [accountName, setAccountName] = useState("Mon PEA");
  const [openedAt, setOpenedAt] = useState("");
  const [monthlyTarget, setMonthlyTarget] = useState("");
  const [targetAccountId, setTargetAccountId] = useState("");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [progress, setProgress] = useState<MissionProgress | null>(null);
  const [points, setPoints] = useState<Points | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useDialogA11y(true, () => { if (!saving) onClose(); });

  const isAccountMission = mission.slug === "onboarding_account_setup";
  const isPlanMission = mission.slug === "onboarding_monthly_plan";
  const area = destinationForMission(mission.slug);

  useEffect(() => {
    if (!isPlanMission || readOnly) return;
    let cancelled = false;
    setLoadingAccounts(true);
    void authenticatedFetch("/api/portfolio")
      .then(async (response) => {
        const body = await response.json() as { accounts?: Account[]; error?: string };
        if (!response.ok) throw new Error(body.error ?? "Comptes indisponibles.");
        return (body.accounts ?? []).filter((account) => account.accountType === "pea" && account.memberName === viewer.name);
      })
      .then((available) => {
        if (cancelled) return;
        setAccounts(available);
        setTargetAccountId((current) => current || available[0]?.id || "");
      })
      .catch((caught) => { if (!cancelled) setError(caught instanceof Error ? caught.message : "Comptes indisponibles."); })
      .finally(() => { if (!cancelled) setLoadingAccounts(false); });
    return () => { cancelled = true; };
  }, [isPlanMission, readOnly, viewer.name]);

  async function refreshReward(): Promise<MissionProgress> {
    const [onboardingResponse, pointsResponse] = await Promise.all([
      authenticatedFetch("/api/challenges/onboarding"),
      authenticatedFetch("/api/challenges/points"),
    ]);
    const onboardingBody = await onboardingResponse.json() as MissionProgress & { available?: boolean; error?: string };
    const pointsBody = pointsResponse.ok ? await pointsResponse.json() as Points : null;
    if (!onboardingResponse.ok || onboardingBody.available === false) throw new Error(onboardingBody.error ?? "Le défi est enregistré, mais sa validation est indisponible.");
    const completed = onboardingBody.missions.find((candidate) => candidate.slug === mission.slug);
    if (completed?.status !== "done") throw new Error("Les informations sont enregistrées, mais le défi n’a pas pu être validé. Réessaie dans un instant.");
    setProgress(onboardingBody);
    setPoints(pointsBody);
    onRefresh();
    return onboardingBody;
  }

  async function submitAccount(event: FormEvent) {
    event.preventDefault();
    if (readOnly || saving) return;
    if (!institution.trim()) { setError("Indique ton établissement financier."); return; }
    setSaving(true);
    setError("");
    try {
      const response = await authenticatedFetch("/api/investment-accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: accountName.trim() || "Mon PEA", accountType: "pea", institution: institution.trim(), openedAt: openedAt || undefined }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Enregistrement impossible.");
      await refreshReward();
      setPhase("success");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Enregistrement impossible.");
    } finally {
      setSaving(false);
    }
  }

  async function submitPlan(event: FormEvent) {
    event.preventDefault();
    if (readOnly || saving) return;
    const target = Number(monthlyTarget.replace(",", "."));
    if (!(target > 0)) { setError("Choisis un montant mensuel supérieur à 0."); return; }
    if (!targetAccountId) { setError("Choisis le PEA auquel rattacher ton objectif."); return; }
    setSaving(true);
    setError("");
    try {
      const response = await authenticatedFetch("/api/investment-plan", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ monthlyTarget: target, targetAccountId, targetDay: null, instrumentPreference: "etf", remindersEnabled: true, leaderboardOptIn: true }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Enregistrement impossible.");
      await refreshReward();
      setPhase("success");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Enregistrement impossible.");
    } finally {
      setSaving(false);
    }
  }

  function continueJourney() {
    const next = progress?.missions.find((candidate) => candidate.status === "todo") ?? null;
    if (!next) { onClose(); return; }
    if (destinationForMission(next.slug)) { onOpenMissionArea(next); return; }
    setMission(next);
    setPhase("intro");
    setError("");
    setProgress(null);
    setPoints(null);
  }

  const steps = progress?.totalCount ?? 4;
  const completedBefore = progress ? Math.max(0, progress.completedCount - 1) : 0;

  return (
    <div className="onboarding-backdrop cha-journey-backdrop" onMouseDown={(event) => !saving && event.target === event.currentTarget && onClose()}>
      <section className="cha-journey" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="cha-journey-title" tabIndex={-1}>
        <header className="cha-journey-head">
          <div><span>Parcours « Bien démarrer »</span><strong>{completedBefore + 1} / {steps}</strong></div>
          <button type="button" onClick={onClose} disabled={saving} aria-label="Fermer le parcours">×</button>
        </header>
        <div className="cha-journey-progress" aria-label={`Étape ${completedBefore + 1} sur ${steps}`}><span style={{ width: `${((completedBefore + 1) / steps) * 100}%` }} /></div>

        {phase === "intro" && (
          <div className="cha-journey-body">
            <span className="cha-journey-icon" aria-hidden="true">✦</span>
            <p className="cha-journey-kicker">+{mission.points} points</p>
            <h2 id="cha-journey-title">{mission.title}</h2>
            <p>{mission.description}</p>
            {readOnly ? <p className="cha-journey-readonly">Aperçu administrateur : ce parcours est visible, mais seul {viewer.name} peut enregistrer ses informations et gagner les points.</p> : (
              <div className="cha-journey-actions"><button type="button" className="cha-journey-primary" onClick={() => area ? onOpenMissionArea(mission) : setPhase("form")}>{area ? mission.cta : "Commencer"}</button><button type="button" className="cha-journey-secondary" onClick={onClose}>Plus tard</button></div>
            )}
          </div>
        )}

        {phase === "form" && isAccountMission && (
          <form className="cha-journey-body cha-journey-form" onSubmit={submitAccount}>
            <p className="cha-journey-kicker">Étape {completedBefore + 1} · +{mission.points} points</p>
            <h2 id="cha-journey-title">Configure ton PEA</h2>
            <p>Indique les informations de ton compte. Elles restent modifiables plus tard.</p>
            <label>Établissement financier<input value={institution} onChange={(event) => setInstitution(event.target.value)} placeholder="ex. Boursorama Banque" disabled={saving} required autoFocus /></label>
            <label>Nom du compte<input value={accountName} onChange={(event) => setAccountName(event.target.value)} disabled={saving} /></label>
            <label>Date d’ouverture <small>(facultative)</small><input type="date" value={openedAt} max={new Date().toISOString().slice(0, 10)} onChange={(event) => setOpenedAt(event.target.value)} disabled={saving} /></label>
            {error && <p className="cha-journey-error" role="alert">{error}</p>}
            <div className="cha-journey-actions"><button type="button" className="cha-journey-secondary" onClick={() => setPhase("intro")} disabled={saving}>Retour</button><button type="submit" className="cha-journey-primary" disabled={saving}>{saving ? "Validation…" : "Valider et gagner mes points"}</button></div>
          </form>
        )}

        {phase === "form" && isPlanMission && (
          <form className="cha-journey-body cha-journey-form" onSubmit={submitPlan}>
            <p className="cha-journey-kicker">Étape {completedBefore + 1} · +{mission.points} points</p>
            <h2 id="cha-journey-title">Définis ton rythme</h2>
            <p>Un objectif réaliste suffit : tu pourras le modifier à tout moment.</p>
            <label>Montant mensuel cible (€)<input inputMode="decimal" value={monthlyTarget} onChange={(event) => setMonthlyTarget(event.target.value.replace(/[^\d.,]/g, ""))} placeholder="ex. 50" disabled={saving} required autoFocus /></label>
            <label>PEA utilisé<select value={targetAccountId} onChange={(event) => setTargetAccountId(event.target.value)} disabled={saving || loadingAccounts} required><option value="">{loadingAccounts ? "Chargement…" : "Choisir un PEA"}</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
            {error && <p className="cha-journey-error" role="alert">{error}</p>}
            <div className="cha-journey-actions"><button type="button" className="cha-journey-secondary" onClick={() => setPhase("intro")} disabled={saving}>Retour</button><button type="submit" className="cha-journey-primary" disabled={saving || loadingAccounts}>{saving ? "Validation…" : "Valider et gagner mes points"}</button></div>
          </form>
        )}

        {phase === "success" && (
          <div className="cha-journey-body cha-journey-success" aria-live="polite">
            <span aria-hidden="true">🎉</span>
            <p className="cha-journey-kicker">Défi validé</p>
            <h2 id="cha-journey-title">{mission.successMessage}</h2>
            <strong>+{mission.points} points</strong>
            {points && <p>Tu as maintenant {points.totalPoints} points{points.rank ? ` · ${points.rank}e au classement familial` : ""}.</p>}
            {progress && <p>{progress.completedCount} étape{progress.completedCount > 1 ? "s" : ""} sur {progress.totalCount} terminée{progress.completedCount > 1 ? "s" : ""}.</p>}
            <div className="cha-journey-actions"><button type="button" className="cha-journey-primary" onClick={continueJourney}>Continuer avec le défi suivant</button><button type="button" className="cha-journey-secondary" onClick={onClose}>Voir plus tard</button></div>
          </div>
        )}
      </section>
    </div>
  );
}
