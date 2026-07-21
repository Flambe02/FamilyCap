"use client";

import type { ReactElement } from "react";
import type { NavIconId } from "../lib/navigation";

const NAV_ICON_COMMON = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, className: "nav-icon-svg" };

const NAV_ICONS: Record<NavIconId, ReactElement> = {
  house: <svg {...NAV_ICON_COMMON}><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5" /></svg>,
  gift: <svg {...NAV_ICON_COMMON}><rect x="3" y="8" width="18" height="4" rx="1" /><path d="M12 8v13" /><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7" /><path d="M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5" /></svg>,
  wallet: <svg {...NAV_ICON_COMMON}><path d="M3 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><path d="M3 10h16.5a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1-1.5 1.5H17a2 2 0 0 1 0-4h3.5" /></svg>,
  bitcoin: <svg {...NAV_ICON_COMMON}><path d="M11.8 19.1c4.9.9 6.1-6 1.2-6.9m-1.2 6.9L5.9 18m5.9 1.1-.3 2m1.6-8.9c4.9.9 6.1-6 1.2-6.9m-1.2 6.9-3.9-.7m5.1-6.2L8.3 4.3m5.9 1-.3-2M7.5 20.4l3.1-17.7" /></svg>,
  "trending-up": <svg {...NAV_ICON_COMMON}><polyline points="22 7 13.5 15.5 8.5 10.5 2 17" /><polyline points="16 7 22 7 22 13" /></svg>,
  landmark: <svg {...NAV_ICON_COMMON}><line x1="3" y1="22" x2="21" y2="22" /><line x1="6" y1="18" x2="6" y2="11" /><line x1="10" y1="18" x2="10" y2="11" /><line x1="14" y1="18" x2="14" y2="11" /><line x1="18" y1="18" x2="18" y2="11" /><polygon points="12 2 20 7 4 7" /></svg>,
  "square-play": <svg {...NAV_ICON_COMMON}><rect x="3" y="3" width="18" height="18" rx="2" /><path d="m10 8 6 4-6 4Z" /></svg>,
  users: <svg {...NAV_ICON_COMMON}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>,
  "book-open": <svg {...NAV_ICON_COMMON}><path d="M12 7v14" /><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" /></svg>,
  settings: <svg {...NAV_ICON_COMMON}><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" /></svg>,
  "list-checks": <svg {...NAV_ICON_COMMON}><path d="m3 17 2 2 4-4" /><path d="m3 7 2 2 4-4" /><path d="M13 6h8" /><path d="M13 12h8" /><path d="M13 18h8" /></svg>,
  star: <svg {...NAV_ICON_COMMON}><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>,
  "shield-check": <svg {...NAV_ICON_COMMON}><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /><path d="m9 12 2 2 4-4" /></svg>,
  calendar: <svg {...NAV_ICON_COMMON}><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4" /><path d="M8 2v4" /><path d="M3 10h18" /></svg>,
};

export function NavIcon({ id }: { id: NavIconId }) {
  return NAV_ICONS[id];
}

export function Stat({ label, value, note, tone, icon, action, onAction }: { label: string; value: string; note: string; tone: string; icon: NavIconId; action?: string; onAction?: () => void }) {
  return <article className="stat-card"><span className={`stat-icon ${tone}`}><NavIcon id={icon} /></span><div><p>{label}</p><strong>{value}</strong><small>{note}</small>{action && <button type="button" className="stat-card-link" onClick={onAction}>{action} →</button>}</div></article>;
}

export function PanelTitle({ eyebrow, title, action, onAction }: { eyebrow?: string; title: string; action?: string; onAction?: () => void }) {
  return <header className="panel-title"><div>{eyebrow && <span>{eyebrow}</span>}<h2>{title}</h2></div>{action && <button onClick={onAction}>{action} →</button>}</header>;
}
