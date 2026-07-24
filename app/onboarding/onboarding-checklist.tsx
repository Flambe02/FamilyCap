"use client";

import { useEffect, useMemo, useState } from "react";
import type { Viewer } from "../../lib/auth-types";
import type { View } from "../../lib/navigation";
import { onboardingCopy } from "../../lib/onboarding/onboarding-copy";
import { loadOnboardingContext, loadOnboardingState, type OnboardingContext } from "../../lib/onboarding/onboarding-client";
import type { OnboardingModule, OnboardingState } from "../../lib/onboarding/onboarding-types";
import "./onboarding.css";

const c = onboardingCopy.checklist;

function dismissKey(id: string) { return `labajo-checklist-dismissed:${id}`; }
function taskKey(key: string, id: string) { return `labajo-task:${key}:${id}`; }

// Réaffiche la carte « Bien démarrer » (utilisé par Paramètres › Reprendre ma configuration).
export function reopenChecklist(memberId: string) {
  if (typeof window === "undefined") return;
  try { window.localStorage.removeItem(dismissKey(memberId)); } catch { /* ignore */ }
}

type Task = { key: string; label: string; done: boolean; view: View; track: boolean };

// Carte compacte de progression sur le tableau de bord. Adapte les tâches aux modules choisis,
// n'invente jamais d'action indisponible, se masque quand tout est fait, et peut être masquée
// puis rouverte depuis Paramètres. Le report affiche un rappel « Reprendre ».
export function OnboardingChecklist({ viewer, navigate, onResume }: {
  viewer: Viewer; navigate: (view: View) => void; onResume: () => void;
}) {
  const [state, setState] = useState<OnboardingState | null>(null);
  const [context, setContext] = useState<OnboardingContext | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [flags, setFlags] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      try { setDismissed(window.localStorage.getItem(dismissKey(viewer.id)) === "1"); } catch { /* ignore */ }
    }, 0);
    void loadOnboardingState(viewer.id).then(({ state: loaded }) => { if (!cancelled) setState(loaded); });
    void loadOnboardingContext().then((ctx) => { if (!cancelled) setContext(ctx); });
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [viewer.id]);

  const readFlag = (key: string) => {
    if (flags[key] !== undefined) return flags[key];
    try { return window.localStorage.getItem(taskKey(key, viewer.id)) === "1"; } catch { return false; }
  };

  const tasks = useMemo<Task[]>(() => {
    if (!state) return [];
    const done = new Set(state.completedSteps);
    const completed = state.status === "completed";
    const modules: OnboardingModule[] = state.selectedModules.length
      ? state.selectedModules
      : [
          ...((context?.giftCount ?? 0) > 0 ? (["gifts"] as OnboardingModule[]) : []),
          ...((context?.btcAttributed ?? 0) > 0 ? (["bitcoin"] as OnboardingModule[]) : []),
          ...(context?.hasPea ? (["pea"] as OnboardingModule[]) : []),
          ...(context?.hasCto ? (["cto"] as OnboardingModule[]) : []),
        ];

    const list: Task[] = [
      { key: "profile", label: c.tasks.profile, done: completed || done.has("profile"), view: "parametres", track: false },
      { key: "privacy", label: c.tasks.privacy, done: completed || done.has("privacy"), view: "parametres", track: false },
    ];
    if (modules.includes("gifts") || (context?.giftCount ?? 0) > 0) list.push({ key: "gifts", label: c.tasks.gifts, done: readFlag("gifts"), view: "cadeaux-amatxi", track: true });
    if (modules.includes("bitcoin") || (context?.btcAttributed ?? 0) > 0) list.push({ key: "bitcoin", label: c.tasks.bitcoin, done: readFlag("bitcoin"), view: "bitcoin", track: true });
    if (modules.includes("pea") || modules.includes("cto")) list.push({ key: "pea", label: c.tasks.pea, done: readFlag("pea"), view: "investissements-pea", track: true });
    list.push({ key: "videos", label: c.tasks.videos, done: readFlag("videos"), view: "videos", track: true });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, context, flags]);

  if (!state || dismissed) return null;

  const doneCount = tasks.filter((task) => task.done).length;
  const allDone = tasks.length > 0 && doneCount === tasks.length;
  const completed = state.status === "completed";

  // Carte terminée + parcours abouti → disparition automatique.
  if (allDone && completed) return null;

  function openTask(task: Task) {
    if (task.track) {
      try { window.localStorage.setItem(taskKey(task.key, viewer.id), "1"); } catch { /* ignore */ }
      setFlags((current) => ({ ...current, [task.key]: true }));
    }
    navigate(task.view);
  }

  function dismiss() {
    try { window.localStorage.setItem(dismissKey(viewer.id), "1"); } catch { /* ignore */ }
    setDismissed(true);
  }

  return (
    <section className="panel home-card ob-checklist" aria-label={c.title}>
      <div className="ob-checklist-head">
        <div>
          <h3 className="home-card-kicker">{c.title}</h3>
          <p className="ob-checklist-progress">{c.progress(doneCount, tasks.length)}</p>
        </div>
        <button type="button" className="ob-checklist-dismiss" onClick={dismiss}>{onboardingCopy.checklist.dismiss}</button>
      </div>

      {!completed && (
        <button type="button" className="ob-checklist-resume" onClick={onResume}>
          <span><strong>{c.resumeTitle}</strong><small>{c.resumeText}</small></span>
          <span aria-hidden="true">{c.resumeCta} →</span>
        </button>
      )}

      <ul className="ob-checklist-tasks">
        {tasks.map((task) => (
          <li key={task.key}>
            <button type="button" className={task.done ? "ob-checklist-task done" : "ob-checklist-task"} onClick={() => openTask(task)} aria-label={task.label}>
              <span className="ob-checklist-mark" aria-hidden="true">{task.done ? "✓" : ""}</span>
              <span className="ob-checklist-label">{task.label}</span>
              {!task.done && <span className="ob-checklist-chevron" aria-hidden="true">›</span>}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
