"use client";

import { useEffect, useMemo, useState } from "react";
import { birthdayEntries, formatCivilBirthday, localToday, normalizeBirthdaySearch, type BirthdayEntry, type BirthdayMember } from "../lib/birthdays";
import { getAccessToken } from "../lib/supabase-session";
import { NavIcon } from "./dashboard-ui";
import "./birthdays.css";

function Avatar({ member, large = false }: { member: BirthdayMember; large?: boolean }) {
  const initials = member.name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
  return member.photoUrl ? <img className={`birthday-avatar${large ? " large" : ""}`} src={member.photoUrl} alt="" /> : <span className={`birthday-avatar${large ? " large" : ""}`} aria-hidden="true">{initials}</span>;
}

function BirthdayLine({ entry }: { entry: BirthdayEntry }) {
  return <article className="birthday-line">
    <Avatar member={entry} />
    <div className="birthday-line-name"><strong>{entry.name}</strong><span>{formatCivilBirthday(entry.birthDate)}</span></div>
    <div className="birthday-line-meta">{entry.age !== null && <span>{entry.age} ans</span>}<b>{entry.label}</b></div>
  </article>;
}

export function BirthdaysPage({ canManage, onOpenFamilyAccess }: { canManage: boolean; onOpenFamilyAccess: () => void }) {
  const [members, setMembers] = useState<BirthdayMember[] | null>(null);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState("");
  const today = useMemo(() => localToday(), []);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const token = await getAccessToken();
      const response = await fetch("/api/family/birthdays", { headers: token ? { authorization: `Bearer ${token}` } : {} });
      if (!response.ok) throw new Error("Impossible de charger les anniversaires");
      return response.json() as Promise<{ members?: BirthdayMember[] }>;
    })().then((result) => { if (!cancelled) setMembers(result.members ?? []); }).catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, []);
  const result = useMemo(() => birthdayEntries(members ?? [], today), [members, today]);
  const visible = useMemo(() => {
    const needle = normalizeBirthdaySearch(query);
    return needle ? result.complete.filter((member) => normalizeBirthdaySearch(member.name).includes(needle)) : result.complete;
  }, [query, result.complete]);
  const groups = useMemo(() => {
    const output = new Map<string, BirthdayEntry[]>();
    for (const entry of visible) {
      const key = `${entry.nextBirthday.year}-${entry.nextBirthday.month}`;
      output.set(key, [...(output.get(key) ?? []), entry]);
    }
    return [...output.entries()];
  }, [visible]);
  const next = result.complete[0];
  const nextMembers = next ? result.complete.filter((entry) => entry.sortKey === next.sortKey) : [];

  return <div className="page-stack birthdays-page">
    <section className="birthdays-heading">
      <span className="birthdays-heading-icon"><NavIcon id="calendar" /></span>
      <div><p>ESPACE FAMILLE</p><h2>Anniversaires</h2><span>Les prochaines dates à célébrer en famille</span></div>
    </section>
    {members === null && !error && <section className="panel birthdays-state">Chargement des anniversaires…</section>}
    {error && <section className="panel birthdays-state">Les anniversaires sont indisponibles pour le moment.</section>}
    {members !== null && !error && <>
      {next ? <section className="birthday-featured panel">
        <div className="birthday-featured-kicker"><span><NavIcon id="gift" /></span>PROCHAIN ANNIVERSAIRE</div>
        <div className="birthday-featured-content">
          <div className="birthday-featured-avatars">{nextMembers.map((member) => <Avatar key={member.id} member={member} large />)}</div>
          <div><h3>{nextMembers.map((entry) => entry.name).join(" · ")}</h3><p>{formatCivilBirthday(next.nextBirthday)}</p>{nextMembers.some((member) => member.age !== null) && <strong>{nextMembers.map((member) => member.age === null ? null : `${member.age} ans`).filter(Boolean).join(" · ")}</strong>}</div>
          <b className="birthday-countdown">{next.label}</b>
        </div>
      </section> : <section className="panel birthdays-state">Aucune date d’anniversaire n’est encore renseignée.</section>}
      <section className="birthdays-list-section">
        <div className="birthdays-list-head"><div><h3>Toute la famille</h3><p>Les anniversaires sont classés par prochaine date.</p></div><label className="birthday-search"><NavIcon id="calendar" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Rechercher un membre" aria-label="Rechercher un membre" /></label></div>
        {groups.length ? groups.map(([key, entries]) => {
          const [year, month] = key.split("-").map(Number);
          const title = new Intl.DateTimeFormat("fr-FR", { month: "long" }).format(new Date(year, month - 1, 1, 12)).toUpperCase() + (year !== today.year ? ` ${year}` : "");
          return <section className="birthday-month" key={key}><h4>{title}</h4><div className="birthday-lines">{entries.map((entry) => <BirthdayLine key={entry.id} entry={entry} />)}</div></section>;
        }) : <div className="birthdays-empty">Aucun membre ne correspond à cette recherche.</div>}
      </section>
      {result.incomplete.length > 0 && <section className="birthday-missing panel"><div><h3>Date à compléter</h3><p>Ces profils familiaux restent visibles, même sans date renseignée.</p></div>{result.incomplete.map((member) => <article key={member.id} className="birthday-missing-line"><Avatar member={member} /><span><strong>{member.name}</strong><small>Date d’anniversaire non renseignée</small></span></article>)}{canManage && <button type="button" onClick={onOpenFamilyAccess}>Compléter dans Famille & accès →</button>}</section>}
    </>}
  </div>;
}
