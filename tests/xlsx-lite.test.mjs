// Test du lecteur XLSX sans dépendance (lib/xlsx-lite.ts). On fabrique un .xlsx minimal en
// mémoire (entrées ZIP « stored », non compressées) pour prouver l'extraction en string[][]
// sans committer de binaire ni dépendre d'une librairie tierce.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseXlsx, tableToHeaderRows } from "../lib/xlsx-lite.ts";

// Mini-écrivain ZIP (entrées non compressées, CRC ignoré par le lecteur).
function makeZip(files) {
  const enc = (s) => Buffer.from(s, "utf8");
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = enc(f.name);
    const data = enc(f.content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8); // method stored
    local.writeUInt32LE(0, 14); // crc
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const localBuf = Buffer.concat([local, name, data]);
    locals.push(localBuf);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 10); // method stored
    central.writeUInt32LE(0, 16); // crc
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));
    offset += localBuf.length;
  }
  const localAll = Buffer.concat(locals);
  const centralAll = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralAll.length, 12);
  eocd.writeUInt32LE(localAll.length, 16);
  return Buffer.concat([localAll, centralAll, eocd]);
}

const SHARED = '<?xml version="1.0"?><sst><si><t>date</t></si><si><t>montant</t></si><si><t>2026-01-05</t></si></sst>';
const SHEET = '<?xml version="1.0"?><worksheet><sheetData>'
  + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'
  + '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>410.5</v></c></row>'
  + '</sheetData></worksheet>';

test("parseXlsx : extrait la grille (chaînes partagées + nombre)", () => {
  const zip = makeZip([
    { name: "xl/sharedStrings.xml", content: SHARED },
    { name: "xl/worksheets/sheet1.xml", content: SHEET },
  ]);
  const matrix = parseXlsx(zip);
  assert.deepEqual(matrix, [["date", "montant"], ["2026-01-05", "410.5"]]);
});

test("tableToHeaderRows : sépare en-tête / lignes", () => {
  const zip = makeZip([
    { name: "xl/sharedStrings.xml", content: SHARED },
    { name: "xl/worksheets/sheet1.xml", content: SHEET },
  ]);
  const { header, rows } = tableToHeaderRows(parseXlsx(zip));
  assert.deepEqual(header, ["date", "montant"]);
  assert.deepEqual(rows, [["2026-01-05", "410.5"]]);
});

test("parseXlsx : rejette un non-ZIP", () => {
  assert.throws(() => parseXlsx(Buffer.from("pas un xlsx")), /ZIP|XLSX/);
});

test("parseXlsx : cellule inline string", () => {
  const sheet = '<?xml version="1.0"?><worksheet><sheetData>'
    + '<row r="1"><c r="A1" t="inlineStr"><is><t>Air Liquide</t></is></c></row>'
    + '</sheetData></worksheet>';
  const zip = makeZip([{ name: "xl/worksheets/sheet1.xml", content: sheet }]);
  assert.deepEqual(parseXlsx(zip), [["Air Liquide"]]);
});
