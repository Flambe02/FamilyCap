// Lecture des nombres et des dates IMPRIMÉS sur un relevé de courtier.
// Ces tests portent sur le maillon le plus bas de la chaîne d'import : c'est ici que se perdent
// un millier (« 5 000 » lu 5) ou un signe (« - 4 247,89 » lu positif), et une erreur à ce niveau
// traverse ensuite tout le pipeline sans que rien ne l'arrête.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseStatementDate, parseStatementNumber, statementNumber, statementPercent,
} from "../lib/document-extraction/statement-number.ts";

const NBSP = " ";      // espace insécable
const NNBSP = " ";     // espace fine insécable (typographie française moderne)
const THIN = " ";      // espace fine
const MINUS = "−";     // signe moins Unicode
const ENDASH = "–";    // tiret demi-cadratin

test("virgule décimale française", () => {
  assert.equal(statementNumber("21,09"), 21.09);
  assert.equal(statementNumber("199,50"), 199.5);
  assert.equal(statementNumber("4,94"), 4.94);
  assert.equal(statementNumber("0,63"), 0.63);
});

test("espaces de milliers : ASCII, insécable, fine, fine insécable", () => {
  // Le piège n° 7 du cahier des charges : une quantité de 5 000 ne doit JAMAIS devenir 5.
  assert.equal(statementNumber("5 000"), 5000);
  assert.equal(statementNumber(`5${NBSP}000`), 5000);
  assert.equal(statementNumber(`5${NNBSP}000`), 5000);
  assert.equal(statementNumber(`5${THIN}000`), 5000);
  assert.equal(statementNumber("1 000"), 1000);
  assert.equal(statementNumber(`177${NBSP}418,34`), 177418.34);
  assert.equal(statementNumber(`149${NNBSP}500,00`), 149500);
});

test("symboles monétaires et pourcentages ignorés : la devise n'est jamais dans le montant", () => {
  assert.equal(statementNumber(`177${NBSP}418,34${NBSP}€`), 177418.34);
  assert.equal(statementNumber("34 580,00 EUR"), 34580);
  assert.equal(statementNumber("$1,234.56"), 1234.56);
  assert.equal(statementPercent("22,63 %"), 22.63);
  assert.equal(statementPercent("+11,45 %"), 11.45);
});

test("montants négatifs : signe détaché, moins Unicode, parenthèses, signe final", () => {
  // Le piège n° 10 : une valeur affichée en rouge conserve son signe parce qu'il est ÉCRIT.
  assert.equal(statementNumber(`- 4${NBSP}247,89 €`), -4247.89);
  assert.equal(statementNumber("- 13,42 %"), -13.42);
  assert.equal(statementNumber(`${MINUS} 4 247,89`), -4247.89);
  assert.equal(statementNumber(`${ENDASH}1,21 %`), -1.21);
  assert.equal(statementNumber("(1 234,56)"), -1234.56);
  assert.equal(statementNumber("4247,89-"), -4247.89);
});

test("un zéro n'est jamais négatif", () => {
  assert.equal(statementNumber("- 0,00 €"), 0);
  assert.ok(!Object.is(statementNumber("- 0,00 €"), -0));
});

test("le signe + ne rend pas la valeur négative (règle n° 11 : le texte fait foi)", () => {
  assert.equal(statementNumber("+ 7 980,00 €"), 7980);
  assert.equal(statementNumber("+30,00 %"), 30);
});

test("format anglo-saxon recopié tel quel : le dernier séparateur est le décimal", () => {
  assert.equal(statementNumber("1,234,567.89"), 1234567.89);
  assert.equal(statementNumber("1.234.567,89"), 1234567.89);
  assert.equal(statementNumber("1,234,567"), 1234567);
});

test("point unique suivi de trois chiffres : tranché en milliers, mais SIGNALÉ", () => {
  // Sur un relevé français la virgule est décimale : « 1.000 » ne peut donc être que mille.
  // La décision est prise, mais elle remonte comme ambiguë pour être vérifiable à l'écran.
  const parsed = parseStatementNumber("1.000");
  assert.equal(parsed.value, 1000);
  assert.equal(parsed.issue, "ambiguous_thousands");
  // Un point suivi d'un nombre de chiffres différent de 3 est décimal sans ambiguïté.
  assert.equal(parseStatementNumber("6.86").issue, null);
  assert.equal(statementNumber("6.86"), 6.86);
});

test("un nombre JSON traverse sans modification", () => {
  assert.equal(statementNumber(3567.4), 3567.4);
  assert.equal(statementNumber(-4247.89), -4247.89);
  assert.equal(statementNumber(0), 0);
});

test("valeur illisible : null, jamais une valeur par défaut", () => {
  assert.equal(statementNumber(""), null);
  assert.equal(statementNumber("   "), null);
  assert.equal(statementNumber(null), null);
  assert.equal(statementNumber(undefined), null);
  assert.equal(statementNumber("—"), null);
  assert.equal(statementNumber("n/a"), null);
  assert.equal(parseStatementNumber("").issue, "empty");
  assert.equal(parseStatementNumber("abc").issue, "not_a_number");
});

test("le texte d'origine est conservé pour expliquer une correction", () => {
  const parsed = parseStatementNumber(`- 4${NBSP}247,89 €`);
  assert.equal(parsed.raw, `- 4${NBSP}247,89 €`);
  assert.equal(parsed.value, -4247.89);
});

test("dates françaises → ISO, jour toujours en premier", () => {
  assert.equal(parseStatementDate("25/07/2026"), "2026-07-25");
  assert.equal(parseStatementDate("09/12/2025"), "2025-12-09"); // 09 = jour, pas septembre
  assert.equal(parseStatementDate("22/11/2023"), "2023-11-22");
  assert.equal(parseStatementDate("05/04/2024"), "2024-04-05");
  assert.equal(parseStatementDate("22.11.2023"), "2023-11-22");
  assert.equal(parseStatementDate("22-11-2023"), "2023-11-22");
  assert.equal(parseStatementDate("2026-05-11"), "2026-05-11");
  assert.equal(parseStatementDate("25 juillet 2026"), "2026-07-25");
  assert.equal(parseStatementDate("1er"), null);
  assert.equal(parseStatementDate("32/01/2026"), null); // date impossible
  assert.equal(parseStatementDate(""), null);
});
