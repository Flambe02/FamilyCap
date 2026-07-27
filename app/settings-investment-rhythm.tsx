"use client";

// Écran « Mon rythme d'investissement » (Paramètres › Investissements › Mon rythme).
// Self-service membre : le member_id est forcé côté serveur. Réutilise les primitives Paramètres
// (SettingsSection / SettingsSwitch / SettingsMessage) et les classes CSS existantes.
// En aperçu administrateur d'un membre : lecture seule (readOnly) — cohérent avec l'esprit
// « réglage personnel du membre ».
//
// L'objectif mensuel enregistré ici est DISTINCT de financial_accounts.monthly_target :
// c'est l'engagement personnel du membre, utilisé par la progression mensuelle et, plus tard,
// par les Défis. Aucun point ni classement n'existe encore.

import { useEffect, useState } from "react";
import type { Viewer } from "../lib/auth-types";
import { SettingsSection, SettingsSwitch, SettingsMessage } from "./settings-ui";
import {
  fetchInvestmentPlan, saveInvestmentPlan, fetchInvestmentAccounts,
  type InstrumentPreference, type InvestmentAccountLite,
} from "../lib/account-settings-client";

type Message = { text: string; tone: "success" | "error" | "info" };
const INSTRUMENT_LABELS: Record<InstrumentPreference, string> = { etf: "ETF", stocks: "Actions", both: "Les deux" };

export function InvestmentRhythmSettings({ viewer, memberId, readOnly = false, onCreateAccount }: { viewer: Viewer; memberId?: string; readOnly?: boolean; onCreateAccount?: () => void }) {
  const [loading, setLoading] = useState<boolean>(true);
  const [available, setAvailable] = useState(true);
  const [accounts, setAccounts] = useState<InvestmentAccountLite[]>([]);
  const [monthlyTarget, setMonthlyTarget] = useState("");
  const [targetAccountId, setTargetAccountId] = useState("");
  const [targetDay, setTargetDay] = useState("");
  const [instrumentPreference, setInstrumentPreference] = useState<InstrumentPreference>("etf");
  const [remindersEnabled, setRemindersEnabled] = useState(true);
  const [leaderboardOptIn, setLeaderboardOptIn] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const [planResult, accountList] = await Promise.all([
          fetchInvestmentPlan(memberId),
          fetchInvestmentAccounts(memberId).catch(() => [] as InvestmentAccountLite[]),
        ]);
        if (cancelled) return;
        // Uniquement les PEA / comptes-titres du membre (jamais les comptes partagés d'autrui).
        setAccounts(accountList.filter((account) => (account.accountType === "pea" || account.accountType === "securities") && account.memberName === viewer.name));
        setAvailable(planResult.available);
        if (planResult.plan) {
          setMonthlyTarget(planResult.plan.monthlyTarget !== null && planResult.plan.monthlyTarget !== undefined ? String(planResult.plan.monthlyTarget) : "");
          setTargetAccountId(planResult.plan.targetAccountId ?? "");
          setTargetDay(planResult.plan.targetDay !== null && planResult.plan.targetDay !== undefined ? String(planResult.plan.targetDay) : "");
          setInstrumentPreference(planResult.plan.instrumentPreference);
          setRemindersEnabled(planResult.plan.remindersEnabled);
          setLeaderboardOptIn(planResult.plan.leaderboardOptIn);
        }
        if (!planResult.available) {
          setMessage({ text: "L'enregistrement du rythme n'est pas encore disponible : la migration Supabase du plan d'investissement (20260803) n'est pas appliquée.", tone: "info" });
        }
      } catch (error) {
        if (!cancelled) { setAvailable(false); setMessage({ text: error instanceof Error ? error.message : "Chargement impossible.", tone: "error" }); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [memberId, viewer.name]);

  const disabled = readOnly || !available || saving;

  async function save() {
    const target = Number(monthlyTarget.replace(",", "."));
    if (!Number.isFinite(target) || target <= 0) { setMessage({ text: "Choisis un montant mensuel supérieur à 0.", tone: "error" }); return; }
    const day = targetDay.trim() ? Number(targetDay) : null;
    if (day !== null && (!Number.isInteger(day) || day < 1 || day > 28)) { setMessage({ text: "Le jour cible doit être compris entre 1 et 28.", tone: "error" }); return; }
    setSaving(true); setMessage(null);
    try {
      await saveInvestmentPlan({
        monthlyTarget: Math.round(target * 100) / 100,
        targetAccountId: targetAccountId || null,
        targetDay: day,
        instrumentPreference,
        remindersEnabled,
        leaderboardOptIn,
      }, memberId);
      setMessage({ text: "Ton rythme d'investissement est enregistré.", tone: "success" });
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : "Enregistrement impossible.", tone: "error" });
    } finally { setSaving(false); }
  }

  return (
    <SettingsSection title="Mon rythme d'investissement" subtitle="Choisis un montant réaliste à investir régulièrement. Tu pourras le modifier pour les prochains mois.">
      {readOnly && <p className="set-hint">Lecture seule : réglage personnel du membre (aperçu administrateur).</p>}
      {loading ? (
        <p className="set-hint">Chargement…</p>
      ) : (
        <>
          <div className="set-fields">
            <label className="set-field">
              <span>Montant mensuel cible (€)</span>
              <input inputMode="decimal" value={monthlyTarget} onChange={(event) => setMonthlyTarget(event.target.value.replace(/[^\d.,]/g, ""))} placeholder="ex. 50" disabled={disabled} />
            </label>
            {accounts.length > 0 && (
              <label className="set-field">
                <span>Compte utilisé</span>
                <select value={targetAccountId} onChange={(event) => setTargetAccountId(event.target.value)} disabled={disabled}>
                  <option value="">Aucun compte précis</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>{account.accountType === "pea" ? "PEA" : "Compte-titres"} · {account.name}{account.institution ? ` · ${account.institution}` : ""}</option>
                  ))}
                </select>
              </label>
            )}
            <label className="set-field">
              <span>Jour habituel (1–28)</span>
              <input inputMode="numeric" value={targetDay} onChange={(event) => setTargetDay(event.target.value.replace(/\D/g, ""))} placeholder="ex. 5" disabled={disabled} />
            </label>
            <label className="set-field">
              <span>Préférence</span>
              <select value={instrumentPreference} onChange={(event) => setInstrumentPreference(event.target.value as InstrumentPreference)} disabled={disabled}>
                {(Object.keys(INSTRUMENT_LABELS) as InstrumentPreference[]).map((key) => <option key={key} value={key}>{INSTRUMENT_LABELS[key]}</option>)}
              </select>
            </label>
          </div>

          {accounts.length === 0 && (
            // Cul-de-sac corrigé : sans compte, cet écran renvoyait vers l'administrateur alors
            // que le membre peut désormais enregistrer le sien (route self-service).
            !readOnly && onCreateAccount
              ? <div className="set-empty">
                  <p>Aucun PEA ou compte-titres n’est encore enregistré à ton nom.</p>
                  <span>Enregistre-le pour rattacher ton rythme d’investissement à un compte précis.</span>
                  <div className="set-actions"><button type="button" className="set-btn-primary" onClick={onCreateAccount}>Enregistrer mon compte</button></div>
                </div>
              : <p className="set-hint">Aucun PEA ou compte-titres n’est encore configuré à ce nom.</p>
          )}

          <ul className="set-rows">
            <li className="set-row">
              <div className="set-row-main"><strong>Rappels d’investissement</strong><p>Un rappel à l’approche de ton jour cible (via tes préférences de notification).</p></div>
              <div className="set-row-side"><SettingsSwitch checked={remindersEnabled} onChange={setRemindersEnabled} label="Rappels d’investissement" disabled={disabled} /></div>
            </li>
            <li className="set-row">
              <div className="set-row-main"><strong>Participer au classement familial</strong><p>Le classement familial arrivera plus tard. Ton montant reste privé : il n’est jamais comparé à celui des autres.</p></div>
              <div className="set-row-side"><SettingsSwitch checked={leaderboardOptIn} onChange={setLeaderboardOptIn} label="Participer au classement familial" disabled={disabled} /></div>
            </li>
          </ul>

          {!readOnly && (
            <div className="set-actions">
              <button type="button" className="set-btn-primary" onClick={() => void save()} disabled={disabled}>{saving ? "Enregistrement…" : "Enregistrer"}</button>
            </div>
          )}
          <SettingsMessage message={message} />
        </>
      )}
    </SettingsSection>
  );
}
