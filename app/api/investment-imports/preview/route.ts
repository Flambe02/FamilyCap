import { authErrorResponse, requireAdmin } from "../../../../lib/auth-server";
import {
  parseCsv, autoMapHeaders, buildPreview, detectDateFormat, IMPORT_FIELDS,
  type ImportField, type DateFormat,
} from "../../../../lib/investment-import";
import { parseSpreadsheet, tableToHeaderRows } from "../../../../lib/xlsx-lite";
import {
  autoMapSnapshotHeaders, buildSnapshotPreview, extractSnapshotDate, isPortfolioSnapshotHeader,
} from "../../../../lib/portfolio-snapshot-import";
import {
  loadImportAccount, loadImportContext, isOperationAccount, MAX_FILE_BYTES, MAX_ROWS,
} from "../../../../lib/investment-import-server";

// PRÉVISUALISATION d'un import (CSV pour l'instant ; XLSX/scan IA se branchent sur le même
// pipeline `string[][]`). Admin uniquement. AUCUNE écriture : on parse, on valide, on renvoie
// le mapping proposé, les lignes normalisées et le rapport d'anomalies. Le fichier n'est pas
// conservé — il est analysé de façon transitoire puis oublié.

export const runtime = "nodejs";

function fileKind(name: string, type: string): "csv" | "xlsx" | "other" {
  const lower = name.toLowerCase();
  if (lower.endsWith(".csv") || lower.endsWith(".txt") || type.includes("csv") || type.startsWith("text/")) return "csv";
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls") || type.includes("spreadsheet") || type.includes("excel")) return "xlsx";
  return "other";
}

function parseMapping(raw: string | null): Record<ImportField, number> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Record<ImportField, number>>;
    const mapping = {} as Record<ImportField, number>;
    for (const field of IMPORT_FIELDS) mapping[field] = Number.isInteger(parsed[field]) ? Number(parsed[field]) : -1;
    return mapping;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  try {
    await requireAdmin(request);

    const form = await request.formData().catch(() => null);
    if (!form) return Response.json({ error: "Fichier manquant (envoi multipart attendu)." }, { status: 400 });
    const file = form.get("file");
    const accountId = String(form.get("accountId") ?? "").trim();
    const dateFormatRaw = String(form.get("dateFormat") ?? "").trim();
    const snapshotDateRaw = String(form.get("snapshotDate") ?? "").trim();
    const mappingOverride = parseMapping(form.get("mapping") ? String(form.get("mapping")) : null);

    if (!accountId) return Response.json({ error: "Le compte est obligatoire." }, { status: 400 });
    if (!(file instanceof File)) return Response.json({ error: "Fichier manquant." }, { status: 400 });
    if (file.size === 0) return Response.json({ error: "Le fichier est vide." }, { status: 400 });
    if (file.size > MAX_FILE_BYTES) return Response.json({ error: `Fichier trop volumineux (max ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} Mo).` }, { status: 413 });

    const account = await loadImportAccount(accountId);
    if (!account) return Response.json({ error: "Compte introuvable." }, { status: 404 });
    if (!isOperationAccount(account.accountType)) return Response.json({ error: "Ce type de compte n'accepte pas d'opérations (PEA ou compte-titres uniquement)." }, { status: 400 });
    if (!account.isActive) return Response.json({ error: "Ce compte est archivé : réactivez-le avant d'importer des opérations." }, { status: 409 });

    const kind = fileKind(file.name, file.type);
    if (kind === "other") return Response.json({ error: "Format non pris en charge. Formats acceptés : CSV et XLSX." }, { status: 415 });

    let header: string[];
    let rows: string[][];
    let preamble: string[][] = [];
    if (kind === "xlsx") {
      try {
        const matrix = parseSpreadsheet(Buffer.from(await file.arrayBuffer()));
        ({ header, rows, preamble } = tableToHeaderRows(matrix));
      } catch (parseError) {
        const message = parseError instanceof Error ? parseError.message : "XLSX illisible.";
        return Response.json({ error: `${message} Vous pouvez exporter le relevé en CSV puis réessayer.` }, { status: 422 });
      }
    } else {
      const parsed = parseCsv(await file.text());
      ({ header, rows, preamble } = tableToHeaderRows([parsed.header, ...parsed.rows]));
    }
    if (header.length === 0 || rows.length === 0) return Response.json({ error: "Aucune ligne de données détectée (vérifiez l'en-tête et le séparateur)." }, { status: 422 });
    if (rows.length > MAX_ROWS) return Response.json({ error: `Trop de lignes (${rows.length} > ${MAX_ROWS}). Fractionnez le fichier.` }, { status: 413 });

    const context = await loadImportContext(account);
    if (isPortfolioSnapshotHeader(header)) {
      const asOfDate = extractSnapshotDate(preamble, snapshotDateRaw);
      if (!asOfDate) {
        return Response.json({
          error: "Ce fichier ressemble à un relevé de portefeuille. La date du relevé est obligatoire (format JJ/MM/AAAA).",
          code: "snapshot_date_required",
          mode: "snapshot",
          columns: header,
        }, { status: 422 });
      }
      const snapshot = buildSnapshotPreview({
        rows,
        mapping: autoMapSnapshotHeaders(header),
        asOfDate,
        accountCurrency: account.currency,
        holdings: context.holdings,
      });
      return Response.json({
        mode: "snapshot",
        snapshot: { asOfDate, positions: snapshot.positions },
        account: { id: account.id, name: account.name, kind: context.kind, currency: account.currency, memberName: account.memberName },
        columns: header,
        mapping: autoMapHeaders(header),
        dateFormat: "fr",
        allowAdvanced: context.allowAdvanced,
        knownHoldings: context.holdings,
        summary: snapshot.summary,
        rows: snapshot.rows,
      });
    }

    const mapping = mappingOverride ?? autoMapHeaders(header);
    const dateFormat: DateFormat = (dateFormatRaw === "fr" || dateFormatRaw === "us" || dateFormatRaw === "iso")
      ? dateFormatRaw
      : detectDateFormat(rows.map((r) => (mapping.date >= 0 ? r[mapping.date] ?? "" : "")));

    const { rows: previewRows, summary } = buildPreview({
      rows, mapping, accountId: account.id, accountCurrency: account.currency, accountType: context.kind,
      holdings: context.holdings, existingFingerprints: context.existingFingerprints, existingExternalRefs: context.existingExternalRefs,
      openingQuantities: context.openingQuantities, dateFormat, allowAdvanced: context.allowAdvanced,
    });

    return Response.json({
      account: { id: account.id, name: account.name, kind: context.kind, currency: account.currency, memberName: account.memberName },
      columns: header,
      mapping,
      dateFormat,
      allowAdvanced: context.allowAdvanced,
      knownHoldings: context.holdings,
      summary,
      rows: previewRows,
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}
