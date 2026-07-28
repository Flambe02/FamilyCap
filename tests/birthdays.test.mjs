import { test } from "node:test";
import assert from "node:assert/strict";
import { birthdayEntries, birthdayInfo, normalizeBirthdaySearch } from "../lib/birthdays.ts";

const today = (year, month, day) => ({ year, month, day });

test("un anniversaire aujourd’hui et demain reçoivent le bon libellé", () => {
  assert.equal(birthdayInfo({ year: 2000, month: 7, day: 28 }, today(2026, 7, 28))?.label, "C’est aujourd’hui !");
  assert.equal(birthdayInfo({ year: 2000, month: 7, day: 29 }, today(2026, 7, 28))?.label, "Demain");
});

test("une date passée est reportée à l’année suivante", () => {
  const info = birthdayInfo({ year: 2000, month: 1, day: 3 }, today(2026, 12, 31));
  assert.deepEqual(info?.nextBirthday, { year: 2027, month: 1, day: 3 });
  assert.equal(info?.age, 27);
});

test("le 29 février est célébré le 28 février hors année bissextile", () => {
  const info = birthdayInfo({ year: 2000, month: 2, day: 29 }, today(2027, 2, 1));
  assert.deepEqual(info?.nextBirthday, { year: 2027, month: 2, day: 28 });
  assert.equal(info?.age, 27);
});

test("le classement garde ensemble les anniversaires du même jour et isole les dates invalides", () => {
  const members = [
    { id: "b", name: "Béatrice", birthdayDay: 17, birthdayMonth: 8, birthdayYear: 1998, photoUrl: null },
    { id: "a", name: "Aurore", birthdayDay: 17, birthdayMonth: 8, birthdayYear: 1999, photoUrl: null },
    { id: "x", name: "Incomplet", birthdayDay: 31, birthdayMonth: 4, birthdayYear: 2000, photoUrl: null },
    { id: "y", name: "Année absente", birthdayDay: 17, birthdayMonth: 8, birthdayYear: null, photoUrl: null },
  ];
  const result = birthdayEntries(members, today(2026, 7, 28));
  assert.deepEqual(result.complete.map((member) => member.name), ["Année absente", "Aurore", "Béatrice"]);
  assert.equal(result.complete[0]?.age, null);
  assert.deepEqual(result.incomplete.map((member) => member.name), ["Incomplet"]);
});

test("la recherche ignore les accents et la casse", () => {
  assert.equal(normalizeBirthdaySearch("Élodie LABAJO"), "elodie labajo");
});
