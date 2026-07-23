// Lecteur XLSX MINIMAL et SANS DÉPENDANCE (serveur / Node uniquement). Un .xlsx est une archive
// ZIP de fichiers XML ; on lit le répertoire central, on décompresse (zlib natif : deflate brut ou
// « stored »), puis on extrait la première feuille en `string[][]`. Choix délibéré : aucune
// librairie tierce (SheetJS/exceljs) — cohérent avec la philosophie « projet minimal » et sans
// exposition aux CVE de ces paquets. On NE fait qu' extraire un tableau de chaînes ; toute la
// logique métier reste dans le moteur d'import commun (même pipeline que le CSV).
//
// Portée : feuille 1, chaînes partagées (sharedStrings) + chaînes inline + nombres. Suffisant pour
// un relevé bancaire/courtier standard. En cas de format inattendu, on lève une erreur claire
// (l'appelant proposera l'export CSV).

import { inflateRawSync } from "node:zlib";

type ZipEntry = { name: string; method: number; compressedSize: number; localHeaderOffset: number };

function readUInt16(buf: Buffer, offset: number): number { return buf.readUInt16LE(offset); }
function readUInt32(buf: Buffer, offset: number): number { return buf.readUInt32LE(offset); }

// Localise et lit le répertoire central du ZIP (sizes/offsets fiables, contrairement aux en-têtes
// locaux qui peuvent utiliser un data descriptor).
function readCentralDirectory(buf: Buffer): ZipEntry[] {
  // End Of Central Directory : signature 0x06054b50, cherchée depuis la fin.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65536; i--) {
    if (readUInt32(buf, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("XLSX invalide (EOCD introuvable).");
  const count = readUInt16(buf, eocd + 10);
  let ptr = readUInt32(buf, eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (readUInt32(buf, ptr) !== 0x02014b50) break; // signature entrée CD
    const method = readUInt16(buf, ptr + 10);
    const compressedSize = readUInt32(buf, ptr + 20);
    const nameLen = readUInt16(buf, ptr + 28);
    const extraLen = readUInt16(buf, ptr + 30);
    const commentLen = readUInt16(buf, ptr + 32);
    const localHeaderOffset = readUInt32(buf, ptr + 42);
    const name = buf.toString("utf8", ptr + 46, ptr + 46 + nameLen);
    entries.push({ name, method, compressedSize, localHeaderOffset });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function extractEntry(buf: Buffer, entry: ZipEntry): string {
  // En-tête local : recalcul du début des données (nom + extra peuvent différer du CD).
  const base = entry.localHeaderOffset;
  if (readUInt32(buf, base) !== 0x04034b50) throw new Error("XLSX invalide (en-tête local).");
  const nameLen = readUInt16(buf, base + 26);
  const extraLen = readUInt16(buf, base + 28);
  const start = base + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data.toString("utf8"); // stored
  if (entry.method === 8) return inflateRawSync(data).toString("utf8"); // deflate brut
  throw new Error(`XLSX : compression non supportée (${entry.method}).`);
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, "&"); // en dernier
}

// sharedStrings.xml : concatène les <t> à l'intérieur de chaque <si> (gère le texte enrichi).
function parseSharedStrings(xml: string): string[] {
  const strings: string[] = [];
  const siRegex = /<si>([\s\S]*?)<\/si>/g;
  let match: RegExpExecArray | null;
  while ((match = siRegex.exec(xml))) {
    const inner = match[1];
    let text = "";
    const tRegex = /<t[^>]*>([\s\S]*?)<\/t>/g;
    let t: RegExpExecArray | null;
    while ((t = tRegex.exec(inner))) text += t[1];
    strings.push(decodeXmlEntities(text));
  }
  return strings;
}

function colIndex(ref: string): number {
  const letters = ref.replace(/[0-9]/g, "");
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseSheet(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  const rowRegex = /<row[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRegex.exec(xml))) {
    const cells: string[] = [];
    const cellRegex = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRegex.exec(rowMatch[1]))) {
      const attrs = cellMatch[1] ?? cellMatch[3] ?? "";
      const body = cellMatch[2] ?? "";
      const refMatch = /r="([A-Z]+)\d+"/.exec(attrs);
      const idx = refMatch ? colIndex(refMatch[1]) : cells.length;
      const typeMatch = /t="([^"]+)"/.exec(attrs);
      const type = typeMatch?.[1];
      let value = "";
      if (type === "inlineStr") {
        const inline = /<t[^>]*>([\s\S]*?)<\/t>/.exec(body);
        value = inline ? decodeXmlEntities(inline[1]) : "";
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body);
        const raw = v ? v[1] : "";
        if (type === "s") value = shared[Number(raw)] ?? "";
        else value = decodeXmlEntities(raw);
      }
      while (cells.length < idx) cells.push("");
      cells[idx] = value;
    }
    rows.push(cells);
  }
  return rows;
}

/**
 * Convertit un .xlsx (Buffer) en tableau de lignes/cellules (première feuille). Lève une erreur
 * explicite si le fichier n'est pas un XLSX lisible (l'appelant proposera l'import CSV).
 */
export function parseXlsx(buffer: Buffer): string[][] {
  if (buffer.length < 4 || readUInt32(buffer, 0) !== 0x04034b50) throw new Error("Fichier XLSX invalide (ce n'est pas une archive ZIP).");
  const entries = readCentralDirectory(buffer);
  const byName = new Map(entries.map((e) => [e.name.replace(/\\/g, "/"), e]));

  // Chaînes partagées (facultatif).
  const sharedEntry = byName.get("xl/sharedStrings.xml");
  const shared = sharedEntry ? parseSharedStrings(extractEntry(buffer, sharedEntry)) : [];

  // Première feuille : sheet1.xml, sinon la première worksheets/*.xml trouvée.
  let sheetEntry = byName.get("xl/worksheets/sheet1.xml");
  if (!sheetEntry) {
    const first = entries.find((e) => /^xl\/worksheets\/[^/]+\.xml$/.test(e.name.replace(/\\/g, "/")));
    if (first) sheetEntry = first;
  }
  if (!sheetEntry) throw new Error("XLSX : aucune feuille de calcul trouvée.");
  return parseSheet(extractEntry(buffer, sheetEntry), shared);
}

/** Découpe un tableau brut (XLSX/CSV) en en-tête + lignes de données (ignore les lignes vides). */
export function tableToHeaderRows(matrix: string[][]): { header: string[]; rows: string[][] } {
  const nonEmpty = matrix.filter((r) => r.some((c) => String(c ?? "").trim() !== ""));
  const header = (nonEmpty[0] ?? []).map((c) => String(c ?? "").trim());
  return { header, rows: nonEmpty.slice(1) };
}
