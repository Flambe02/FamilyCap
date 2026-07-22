"use client";

import { useEffect, useState } from "react";
import { NavIcon } from "./dashboard-ui";
import type { NavIconId } from "../lib/navigation";
import { SettingsSection, SettingsSwitch, SettingsMessage } from "./settings-ui";
import { fetchNotificationPreferences, saveNotificationPreferences, type NotificationPreferences } from "../lib/account-settings-client";

// Écran « Notifications » : préférences persistées dans Supabase (aucune campagne d'e-mail n'est
// envoyée par ce lot). Chaque interrupteur est enregistré immédiatement ; en cas d'échec, l'état
// est restauré et un message d'erreur est affiché.

type Item = { key: keyof NotificationPreferences; icon: NavIconId; title: string; desc: string };

const IN_APP: Item[] = [
  { key: "gifts", icon: "gift", title: "Cadeaux d’Amatxi", desc: "Nouveaux cadeaux et messages" },
  { key: "events", icon: "calendar", title: "Anniversaires et événements", desc: "Rappels d’anniversaires et d’événements familiaux" },
  { key: "investments", icon: "trending-up", title: "Investissements mensuels", desc: "Résumés et rappels liés à vos investissements" },
  { key: "security", icon: "shield-check", title: "Sécurité du compte", desc: "Alertes importantes liées à la sécurité" },
];
const BY_EMAIL: Item[] = [
  { key: "emailWeekly", icon: "bell", title: "Résumé hebdomadaire", desc: "Recevez un récapitulatif par e-mail chaque semaine" },
];

export function NotificationsSettings({ memberId }: { memberId?: string } = {}) {
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [available, setAvailable] = useState(true);
  const [message, setMessage] = useState<{ text: string; tone: "success" | "error" | "info" } | null>(null);
  const [busyKey, setBusyKey] = useState<keyof NotificationPreferences | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchNotificationPreferences(memberId)
      .then((result) => { if (cancelled) return; setPrefs(result.preferences); setAvailable(result.available); if (!result.available) setMessage({ text: "Les préférences ne sont pas encore enregistrables : la migration Supabase des notifications n’est pas appliquée.", tone: "info" }); })
      .catch((error: unknown) => { if (!cancelled) { setPrefs({ gifts: true, events: true, investments: true, security: true, emailWeekly: true }); setAvailable(false); setMessage({ text: error instanceof Error ? error.message : "Chargement impossible.", tone: "error" }); } });
    return () => { cancelled = true; };
  }, [memberId]);

  async function toggle(key: keyof NotificationPreferences, next: boolean) {
    if (!prefs || !available || busyKey) return;
    const previous = prefs;
    const updated = { ...prefs, [key]: next };
    setPrefs(updated); setBusyKey(key); setMessage(null);
    try {
      await saveNotificationPreferences(updated, memberId);
      setMessage({ text: "Préférence enregistrée.", tone: "success" });
    } catch (error) {
      setPrefs(previous);
      setMessage({ text: error instanceof Error ? error.message : "Enregistrement impossible.", tone: "error" });
    } finally {
      setBusyKey(null);
    }
  }

  function renderGroup(title: string, items: Item[]) {
    return (
      <div className="set-notif-group">
        <p className="set-notif-kicker">{title}</p>
        <ul className="set-rows">
          {items.map((item) => (
            <li key={item.key} className="set-row">
              <div className="set-row-main set-row-icon-main">
                <span className="set-icon" aria-hidden="true"><NavIcon id={item.icon} /></span>
                <span><strong>{item.title}</strong><p>{item.desc}</p></span>
              </div>
              <div className="set-row-side">
                <SettingsSwitch
                  checked={prefs ? prefs[item.key] : false}
                  onChange={(next) => void toggle(item.key, next)}
                  label={item.title}
                  disabled={!prefs || !available || busyKey !== null}
                />
              </div>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <SettingsSection title="Préférences de notifications" subtitle="Choisissez les notifications que vous souhaitez recevoir.">
      {renderGroup("Dans l’application", IN_APP)}
      {renderGroup("Par e-mail", BY_EMAIL)}
      <SettingsMessage message={message} />
    </SettingsSection>
  );
}
