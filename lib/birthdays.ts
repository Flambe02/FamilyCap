export type CivilDate = { year: number; month: number; day: number };

export type BirthdayMember = {
  id: string;
  name: string;
  birthdayDay: number | null;
  birthdayMonth: number | null;
  birthdayYear: number | null;
  photoUrl: string | null;
};

export type BirthdayEntry = BirthdayMember & {
  birthDate: CivilDate;
  nextBirthday: CivilDate;
  daysUntil: number;
  age: number | null;
  label: string;
  sortKey: number;
};

const DAY_MS = 86_400_000;

export function isLeapYear(year: number) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function daysInMonth(year: number, month: number) {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function isValidCivilDate(date: CivilDate) {
  return Number.isInteger(date.year) && Number.isInteger(date.month) && Number.isInteger(date.day)
    && date.year >= 1900 && date.year <= 2100 && date.month >= 1 && date.month <= 12
    && date.day >= 1 && date.day <= daysInMonth(date.year, date.month);
}

export function localToday(now = new Date()): CivilDate {
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}

function dayNumber(date: CivilDate) {
  return Math.floor(Date.UTC(date.year, date.month - 1, date.day) / DAY_MS);
}

function occurrenceForYear(birthDate: CivilDate, year: number): CivilDate {
  // Convention familiale : une naissance le 29 février est célébrée le 28 février hors année bissextile.
  return birthDate.month === 2 && birthDate.day === 29 && !isLeapYear(year)
    ? { year, month: 2, day: 28 }
    : { year, month: birthDate.month, day: birthDate.day };
}

export function birthdayInfo(birthDate: CivilDate, today: CivilDate = localToday()) {
  if (!isValidCivilDate(birthDate) || !isValidCivilDate(today)) return null;
  let nextBirthday = occurrenceForYear(birthDate, today.year);
  if (dayNumber(nextBirthday) < dayNumber(today)) nextBirthday = occurrenceForYear(birthDate, today.year + 1);
  const daysUntil = dayNumber(nextBirthday) - dayNumber(today);
  const age = nextBirthday.year - birthDate.year;
  const label = daysUntil === 0 ? "C’est aujourd’hui !" : daysUntil === 1 ? "Demain" : `Dans ${daysUntil} jours`;
  return { nextBirthday, daysUntil, age, label, sortKey: dayNumber(nextBirthday) };
}

export function birthdayEntries(members: BirthdayMember[], today: CivilDate = localToday()) {
  const complete: BirthdayEntry[] = [];
  const incomplete: BirthdayMember[] = [];
  for (const member of members) {
    // Jour/mois sont déjà la source de vérité historique. Une année inconnue ne doit jamais
    // effacer un anniversaire : 2000 sert uniquement de support bissextile pour le calcul civil.
    const birthDate = { year: member.birthdayYear ?? 2000, month: member.birthdayMonth ?? 0, day: member.birthdayDay ?? 0 };
    const info = birthdayInfo(birthDate, today);
    if (!info) { incomplete.push(member); continue; }
    complete.push({ ...member, birthDate, ...info, age: member.birthdayYear === null ? null : info.age });
  }
  complete.sort((a, b) => a.sortKey - b.sortKey || normalizeBirthdaySearch(a.name).localeCompare(normalizeBirthdaySearch(b.name), "fr"));
  incomplete.sort((a, b) => normalizeBirthdaySearch(a.name).localeCompare(normalizeBirthdaySearch(b.name), "fr"));
  return { complete, incomplete };
}

export function normalizeBirthdaySearch(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr-FR").trim();
}

export function formatCivilBirthday(date: Pick<CivilDate, "month" | "day">, withYear?: number) {
  const display = new Date(2000, date.month - 1, date.day, 12);
  const label = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long" }).format(display);
  return withYear ? `${label} ${withYear}` : label;
}
