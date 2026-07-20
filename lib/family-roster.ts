// Single source of truth for the 5 family members' identity (name, initials,
// color, birthday). Previously duplicated independently across 6 files, which
// let Aurore's birthday drift to a wrong value in one of them.

export type MemberName = "Thibault" | "Uhaina" | "Paul" | "Aurore" | "Thomas";

export type MemberColor = "mint" | "coral" | "blue" | "yellow" | "purple";

export type FamilyMember = {
  name: MemberName;
  initials: string;
  color: MemberColor;
  birthdayDay: number;
  birthdayMonth: number;
};

export const FAMILY_MEMBERS: FamilyMember[] = [
  { name: "Thibault", initials: "TH", color: "mint", birthdayDay: 15, birthdayMonth: 3 },
  { name: "Uhaina", initials: "UH", color: "coral", birthdayDay: 16, birthdayMonth: 8 },
  { name: "Paul", initials: "PA", color: "blue", birthdayDay: 18, birthdayMonth: 11 },
  { name: "Aurore", initials: "AU", color: "yellow", birthdayDay: 27, birthdayMonth: 8 },
  { name: "Thomas", initials: "TO", color: "purple", birthdayDay: 29, birthdayMonth: 12 },
];

export const MEMBER_NAMES: MemberName[] = FAMILY_MEMBERS.map((member) => member.name);

const MONTHS_LONG = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const MONTHS_SHORT = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

export function formatBirthday(day: number, month: number, style: "short" | "long" = "long"): string {
  const months = style === "short" ? MONTHS_SHORT : MONTHS_LONG;
  return `${day} ${months[month - 1]}`;
}

export function birthdayMonthDay(day: number, month: number): string {
  return `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function recordByMember(pick: (member: FamilyMember) => string): Record<MemberName, string> {
  return Object.fromEntries(FAMILY_MEMBERS.map((member) => [member.name, pick(member)])) as Record<MemberName, string>;
}

export const BIRTHDAY_LABEL_LONG: Record<MemberName, string> = recordByMember((member) => formatBirthday(member.birthdayDay, member.birthdayMonth, "long"));
export const BIRTHDAY_LABEL_SHORT: Record<MemberName, string> = recordByMember((member) => formatBirthday(member.birthdayDay, member.birthdayMonth, "short"));
export const BIRTHDAY_MONTH_DAY: Record<MemberName, string> = recordByMember((member) => birthdayMonthDay(member.birthdayDay, member.birthdayMonth));
