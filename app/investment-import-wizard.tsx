"use client";

// Assistant d'IMPORT d'opérations (CSV — XLSX/scan IA se branchent sur le même parcours).
// ADMIN uniquement (le composant n'est rendu que si canManage). Parcours en 6 étapes :
//   1) compte (pré-sélectionné)  2) téléversement  3) correspondance des colonnes
//   4) prévisualisation + correction  5) confirmation  6) résultat.
// AUCUNE opération n'est écrite avant l'étape 5 : la prévisualisation appelle /preview (lecture
// seule), la confirmation appelle /commit (revalidation serveur complète). Le fichier n'est jamais
// conservé : il est renvoyé à chaque prévisualisation et oublié côté serveur.

import { useMemo, useRef, useState } from "react";
import { useDialogA11y } from "./use-dialog-a11y";
import { authenticatedFetch, OP_LABEL } from "./investment-account";
import {
  buildTemplateCsv, IMPORT_FIELDS,
  type ImportField, type NormalizedOp, type PreviewRow, type PreviewSummary, type RowStatus,
} from "../lib/investment-import";

type TargetAccount = { id: string; name: string; kind: "PEA" | "CTO"; currency: string; memberName: string | null };
type KnownHolding = { id: string; isin: string | null; symbol: string | null; name: string | null };

type PreviewResponse = {
  account: TargetAccount;
  columns: string[];
  mapping: Record<ImportField, number>;
  dateFormat: "iso" | "fr" | "us";
  allowAdvanced: boolean;
  knownHoldings: KnownHolding[];
  summary: PreviewSummary;
  rows: PreviewRow[];
};

// Ligne éditable côté client (copie corrigeable de la prévisualisation serveur). Les champs ai*
// ne sont présents que pour un scan IA (confiance / texte source / page).
type EditableRow = PreviewRow & { include: boolean; createInstrument: boolean; aiBand?: "high" | "medium" | "low"; aiConfidence?: number; aiSourceText?: string | null; aiPage?: number | null };
type ImportMode = "file" | "ai";

const FIELD_LABEL: Record<ImportField, string> = {
  date: "Date", type: "Type d'opération", isin: "ISIN", ticker: "Ticker", instrumentName: "Nom de l'instrument",
  quantity: "Quantité", unitPrice: "Prix unitaire", amount: "Montant", fees: "Frais", taxes: "Taxes",
  currency: "Devise", exchangeRate: "Taux de change", externalReference: "Référence externe", note: "Note",
};

const STATUS_META: Record<RowStatus, { label: string; cls: string }> = {
  valid: { label: "Valide", cls: "imp-ok" },
  warning: { label: "À vérifier", cls: "imp-warn" },
  error: { label: "Erreur", cls: "imp-err" },
  duplicate_certain: { label: "Doublon", cls: "imp-dup" },
  duplicate_possible: { label: "Doublon possible", cls: "imp-dup" },
};

function download(filename: string, text: string, mime = "text/csv;charset=utf-8") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = filename;
  document.body.appendChild(link); link.click(); document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function InvestmentImportWizard({ account, onClose, onDone }: { account: TargetAccount; onClose: () => void; onDone: () => void }) {
  const dialogRef = useDialogA11y(true, onClose);
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5 | 6>(1);
  const [mode, setMode] = useState<ImportMode>("file");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [rows, setRows] = useState<EditableRow[]>([]);
  const [mapping, setMapping] = useState<Record<ImportField, number> | null>(null);
  const [dateFormat, setDateFormat] = useState<"iso" | "fr" | "us">("fr");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<"all" | "anomalies">("all");
  const [result, setResult] = useState<{ imported: number; duplicates: number; newInstruments: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function runPreview(nextMapping?: Record<ImportField, number>, nextDateFormat?: "iso" | "fr" | "us") {
    if (!file) return;
    setBusy(true); setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("accountId", account.id);
      if (nextMapping) form.append("mapping", JSON.stringify(nextMapping));
      if (nextDateFormat) form.append("dateFormat", nextDateFormat);
      const response = await authenticatedFetch("/api/investment-imports/preview", { method: "POST", body: form });
      const data = (await response.json().catch(() => ({}))) as PreviewResponse & { error?: string };
      if (!response.ok) { setError(data.error ?? "Analyse impossible."); setBusy(false); return; }
      setPreview(data);
      setMapping(data.mapping);
      setDateFormat(data.dateFormat);
      setRows(data.rows.map((row) => ({
        ...row,
        include: row.status !== "error" && row.status !== "duplicate_certain",
        createInstrument: false,
      })));
      setStep(3);
    } catch {
      setError("Réseau indisponible.");
    }
    setBusy(false);
  }

  async function runScan() {
    if (!file) return;
    setBusy(true); setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("accountId", account.id);
      const response = await authenticatedFetch("/api/investment-imports/scan", { method: "POST", body: form });
      const data = (await response.json().catch(() => ({}))) as (PreviewResponse & { error?: string });
      if (!response.ok) { setError(data.error ?? "Analyse IA impossible."); setBusy(false); return; }
      setPreview(data);
      setRows(data.rows.map((row) => {
        const editable = row as EditableRow;
        return { ...editable, include: editable.aiBand !== "low" && row.status !== "error" && row.status !== "duplicate_certain", createInstrument: false };
      }));
      setStep(4); // le scan IA saute l'étape de mapping (colonnes déjà structurées)
    } catch {
      setError("Réseau indisponible.");
    }
    setBusy(false);
  }

  function updateRow(index: number, patch: Partial<NormalizedOp>) {
    setRows((current) => current.map((row) => (row.index === index ? { ...row, op: { ...row.op, ...patch } } : row)));
  }
  function toggleInclude(index: number, include: boolean) {
    setRows((current) => current.map((row) => (row.index === index ? { ...row, include } : row)));
  }
  function toggleCreate(index: number, createInstrument: boolean) {
    setRows((current) => current.map((row) => (row.index === index ? { ...row, createInstrument } : row)));
  }

  const included = useMemo(() => rows.filter((row) => row.include), [rows]);
  const blocking = useMemo(() => included.filter((row) => row.errors.length > 0), [included]);
  const visibleRows = filter === "anomalies" ? rows.filter((row) => row.status !== "valid") : rows;

  async function commit() {
    if (!preview) return;
    setBusy(true); setError("");
    // Instruments à créer (uniquement ceux cochés, non reconnus, avec au moins un identifiant).
    const newInstruments = included
      .filter((row) => row.createInstrument && !row.instrumentHoldingId)
      .map((row) => ({ isin: row.op.isin, ticker: row.op.ticker, name: row.op.instrumentName ?? row.op.ticker ?? row.op.isin, assetType: "other", currency: row.op.currency }))
      .filter((instrument) => instrument.name);
    try {
      const response = await authenticatedFetch("/api/investment-imports/commit", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId: account.id, filename: file?.name, sourceKind: mode === "ai" ? "ai_scan" : "file",
          fileType: mode === "ai" ? (file?.type.includes("pdf") ? "pdf" : "image") : (file?.name.toLowerCase().endsWith(".xlsx") ? "xlsx" : "csv"),
          mapping: mode === "ai" ? null : mapping,
          operations: included.map((row) => row.op),
          newInstruments,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as { imported?: number; duplicates?: number; newInstruments?: number; error?: string; invalidLines?: Array<{ line: number; error: string }> };
      if (!response.ok) {
        setError(data.error ?? "Import impossible." + (data.invalidLines?.length ? ` (${data.invalidLines.length} ligne(s) invalide(s))` : ""));
        setBusy(false); return;
      }
      setResult({ imported: data.imported ?? 0, duplicates: data.duplicates ?? 0, newInstruments: data.newInstruments ?? 0 });
      setStep(6);
      onDone();
    } catch {
      setError("Réseau indisponible.");
    }
    setBusy(false);
  }

  const summary = preview?.summary;
  const stepLabels = ["Compte", "Fichier", "Colonnes", "Vérification", "Confirmation", "Résultat"];

  return (
    <div className="modal-backdrop" onMouseDown={(event) => !busy && event.target === event.currentTarget && onClose()}>
      <section className="modal pea-modal imp-modal" ref={dialogRef} role="dialog" aria-modal="true" aria-label="Importer des opérations" tabIndex={-1}>
        <header className="pea-modal-head">
          <div>
            <span className="soft-pill">{account.kind} · {account.memberName ?? account.name}</span>
            <h2>Importer des opérations</h2>
          </div>
          <button type="button" className="pea-modal-close" onClick={onClose} aria-label="Fermer">×</button>
        </header>

        <ol className="imp-steps" aria-label="Étapes de l'import">
          {stepLabels.map((label, i) => (
            <li key={label} className={step === i + 1 ? "active" : step > i + 1 ? "done" : ""}>{i + 1}. {label}</li>
          ))}
        </ol>

        <div className="imp-body">
          {error && <p className="pea-form-error" role="alert">{error}</p>}

          {/* Étape 1 — compte */}
          {step === 1 && (
            <div className="imp-panel">
              <p>Vous allez importer l’historique d’opérations du compte&nbsp;:</p>
              <div className="imp-account-card"><strong>{account.name}</strong><small>{account.kind} · {account.currency}{account.memberName ? ` · ${account.memberName}` : ""}</small></div>
              <p className="imp-hint">Importez l’historique fourni par votre banque ou votre courtier. Le fichier n’est pas conservé ; il sert uniquement à préparer les opérations que vous validerez.</p>
              <div className="pea-form-actions">
                <button type="button" className="secondary-button" onClick={onClose}>Annuler</button>
                <button type="button" className="primary-button" onClick={() => setStep(2)}>Continuer</button>
              </div>
            </div>
          )}

          {/* Étape 2 — téléversement */}
          {step === 2 && (
            <div className="imp-panel">
              <div className="imp-modes" role="tablist" aria-label="Type d'import">
                <button type="button" role="tab" aria-selected={mode === "file"} className={mode === "file" ? "active" : ""} onClick={() => { setMode("file"); setFile(null); }}>📄 Fichier CSV / XLSX</button>
                <button type="button" role="tab" aria-selected={mode === "ai"} className={mode === "ai" ? "active" : ""} onClick={() => { setMode("ai"); setFile(null); }}>✨ Scanner un relevé (IA)</button>
              </div>
              <div
                className="imp-drop"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => { event.preventDefault(); const dropped = event.dataTransfer.files?.[0]; if (dropped) setFile(dropped); }}
                onClick={() => inputRef.current?.click()}
                role="button" tabIndex={0}
                onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") inputRef.current?.click(); }}
              >
                <input ref={inputRef} type="file"
                  accept={mode === "ai" ? ".pdf,image/png,image/jpeg,image/webp,application/pdf" : ".csv,.txt,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}
                  hidden onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
                <span className="imp-drop-icon" aria-hidden="true">{mode === "ai" ? "🧾" : "📄"}</span>
                <strong>{file ? file.name : mode === "ai" ? "Glissez un PDF ou une image de relevé, ou cliquez" : "Glissez un fichier CSV ou XLSX ici, ou cliquez pour choisir"}</strong>
                <small>{mode === "ai" ? "PDF, PNG, JPG ou WEBP. Relevés numériques nets de préférence." : "Formats acceptés : CSV ou XLSX. Taille max 2 Mo."}</small>
              </div>
              {mode === "file" ? (
                <div className="imp-templates">
                  <button type="button" className="btc-link" onClick={() => download(`modele-import-${account.kind.toLowerCase()}.csv`, buildTemplateCsv())}>⬇ Télécharger le modèle CSV</button>
                  <span className="imp-hint">Le modèle contient des lignes d’exemple (versement, achat, dividende, frais, vente) — à remplacer par vos données.</span>
                </div>
              ) : (
                <p className="imp-hint">L’IA lit le document et propose des opérations à vérifier. Aucune donnée n’est enregistrée automatiquement. Le fichier n’est pas conservé. L’écriture manuscrite, les photos floues ou les relevés protégés ne sont pas garantis — préférez alors le CSV ou la saisie manuelle.</p>
              )}
              <div className="pea-form-actions">
                <button type="button" className="secondary-button" onClick={() => setStep(1)}>Retour</button>
                <button type="button" className="primary-button" disabled={!file || busy} onClick={() => (mode === "ai" ? runScan() : runPreview())}>{busy ? (mode === "ai" ? "Analyse IA…" : "Analyse…") : mode === "ai" ? "Analyser avec l'IA" : "Analyser le fichier"}</button>
              </div>
            </div>
          )}

          {/* Étape 3 — correspondance des colonnes */}
          {step === 3 && preview && mapping && (
            <div className="imp-panel">
              <p className="imp-hint">Vérifiez la correspondance entre les colonnes de votre fichier et les champs attendus. Les colonnes ont été détectées automatiquement ; corrigez si nécessaire.</p>
              <label className="imp-inline">Format de date&nbsp;
                <select value={dateFormat} onChange={(event) => setDateFormat(event.target.value as "iso" | "fr" | "us")}>
                  <option value="fr">Jour/Mois/Année (FR)</option>
                  <option value="us">Mois/Jour/Année (US)</option>
                  <option value="iso">Année-Mois-Jour (ISO)</option>
                </select>
              </label>
              <div className="imp-mapping-grid">
                {IMPORT_FIELDS.map((field) => (
                  <label key={field} className="imp-map-row">
                    <span>{FIELD_LABEL[field]}</span>
                    <select value={mapping[field]} onChange={(event) => setMapping({ ...mapping, [field]: Number(event.target.value) })}>
                      <option value={-1}>— non associé —</option>
                      {preview.columns.map((col, i) => <option key={i} value={i}>{col || `Colonne ${i + 1}`}</option>)}
                    </select>
                  </label>
                ))}
              </div>
              <div className="pea-form-actions">
                <button type="button" className="secondary-button" onClick={() => setStep(2)}>Retour</button>
                <button type="button" className="primary-button" disabled={busy} onClick={() => runPreview(mapping, dateFormat).then(() => setStep(4))}>{busy ? "Analyse…" : "Prévisualiser"}</button>
              </div>
            </div>
          )}

          {/* Étape 4 — prévisualisation + correction */}
          {step === 4 && preview && summary && (
            <div className="imp-panel">
              {mode === "ai" && <p className="imp-ai-banner" role="note">✨ Les données ont été extraites automatiquement. Vérifiez-les avant de confirmer. Les lignes à faible confiance sont décochées par défaut.</p>}
              <div className="imp-summary">
                <span><b>{summary.total}</b> lignes</span>
                <span className="imp-ok"><b>{included.filter((r) => r.errors.length === 0).length}</b> à importer</span>
                <span className="imp-warn"><b>{summary.toCheck}</b> à vérifier</span>
                <span className="imp-err"><b>{summary.errors}</b> en erreur</span>
                <span className="imp-dup"><b>{summary.duplicatesCertain + summary.duplicatesPossible}</b> doublons</span>
                <span><b>{summary.unknownInstruments}</b> instruments non reconnus</span>
              </div>
              <label className="imp-inline"><input type="checkbox" checked={filter === "anomalies"} onChange={(event) => setFilter(event.target.checked ? "anomalies" : "all")} /> N’afficher que les anomalies</label>
              <div className="responsive-table imp-table-wrap">
                <table className="btc-table imp-table">
                  <thead><tr><th>#</th><th>Statut</th><th>Date</th><th>Type</th><th>Instrument</th><th>Qté</th><th>Prix</th><th>Montant</th><th>Devise</th>{mode === "ai" && <th>Confiance IA</th>}<th>Importer</th></tr></thead>
                  <tbody>
                    {visibleRows.map((row) => {
                      const unknownInstrument = !row.instrumentHoldingId && (row.op.type === "achat" || row.op.type === "vente" || row.op.type === "dividende" || row.op.type === "transfer_in" || row.op.type === "transfer_out");
                      return (
                        <tr key={row.index} className={row.include ? "" : "imp-excluded"}>
                          <td>{row.index}</td>
                          <td><span className={`imp-badge ${STATUS_META[row.status].cls}`}>{STATUS_META[row.status].label}</span>
                            {row.errors.length > 0 && <small className="imp-msg imp-err">{row.errors.join(" ")}</small>}
                            {row.warnings.length > 0 && row.errors.length === 0 && <small className="imp-msg imp-warn">{row.warnings.join(" ")}</small>}
                          </td>
                          <td><input className="imp-cell" type="date" value={row.op.date ?? ""} onChange={(event) => updateRow(row.index, { date: event.target.value })} /></td>
                          <td>
                            <select className="imp-cell" value={row.op.type ?? ""} onChange={(event) => updateRow(row.index, { type: (event.target.value || null) as NormalizedOp["type"] })}>
                              <option value="">—</option>
                              {(Object.entries(OP_LABEL) as Array<[NonNullable<NormalizedOp["type"]>, string]>).map(([t, label]) => <option key={t} value={t}>{label}</option>)}
                            </select>
                          </td>
                          <td>
                            <span className="imp-instrument">{row.op.instrumentName ?? row.op.ticker ?? row.op.isin ?? "—"}</span>
                            {row.instrumentHoldingId ? <small className="imp-msg imp-ok">reconnu ({row.matchedBy})</small>
                              : unknownInstrument ? <label className="imp-msg"><input type="checkbox" checked={row.createInstrument} onChange={(event) => toggleCreate(row.index, event.target.checked)} /> créer l’instrument</label> : null}
                          </td>
                          <td className="num">{row.op.quantity ?? "—"}</td>
                          <td className="num">{row.op.unitPrice ?? "—"}</td>
                          <td className="num">{row.op.amount ?? "—"}</td>
                          <td>{row.op.currency}</td>
                          {mode === "ai" && (
                            <td>
                              {row.aiBand ? <span className={`imp-badge imp-conf-${row.aiBand}`} title={row.aiSourceText ? `« ${row.aiSourceText} »${row.aiPage ? ` (p.${row.aiPage})` : ""}` : undefined}>{row.aiBand === "high" ? "Élevée" : row.aiBand === "medium" ? "Moyenne" : "Faible"}{typeof row.aiConfidence === "number" ? ` ${Math.round(row.aiConfidence * 100)}%` : ""}</span> : "—"}
                            </td>
                          )}
                          <td><input type="checkbox" checked={row.include} onChange={(event) => toggleInclude(row.index, event.target.checked)} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {blocking.length > 0 && <p className="pea-form-error">{blocking.length} ligne(s) cochée(s) restent en erreur : corrigez-les ou décochez-les avant de continuer.</p>}
              <div className="pea-form-actions">
                <button type="button" className="secondary-button" onClick={() => setStep(mode === "ai" ? 2 : 3)}>Retour</button>
                <button type="button" className="primary-button" disabled={included.length === 0 || blocking.length > 0} onClick={() => setStep(5)}>Continuer ({included.filter((r) => r.errors.length === 0).length})</button>
              </div>
            </div>
          )}

          {/* Étape 5 — confirmation */}
          {step === 5 && summary && (
            <div className="imp-panel">
              <div className="imp-confirm">
                <p><b>{included.length}</b> opération(s) seront importées.</p>
                <p>{rows.length - included.length} ligne(s) seront ignorées.</p>
                <p>{summary.duplicatesCertain} doublon(s) certain(s) exclus.</p>
                <p>{included.filter((r) => r.createInstrument && !r.instrumentHoldingId).length} nouvel(s) instrument(s) seront créés sans cours de marché.</p>
              </div>
              <p className="imp-hint">L’enregistrement est revalidé côté serveur. En cas d’erreur, aucun import partiel n’est créé.</p>
              <div className="pea-form-actions">
                <button type="button" className="secondary-button" onClick={() => setStep(4)}>Retour</button>
                <button type="button" className="primary-button" disabled={busy} onClick={commit}>{busy ? "Import…" : "Confirmer l'import"}</button>
              </div>
            </div>
          )}

          {/* Étape 6 — résultat */}
          {step === 6 && result && (
            <div className="imp-panel imp-result">
              <span className="imp-result-icon" aria-hidden="true">✓</span>
              <h3>Import terminé</h3>
              <p><b>{result.imported}</b> opération(s) importée(s){result.duplicates ? `, ${result.duplicates} doublon(s) exclus` : ""}{result.newInstruments ? `, ${result.newInstruments} instrument(s) créé(s)` : ""}.</p>
              <p className="imp-hint">Le portefeuille (valeur, positions, prix de revient) a été recalculé à partir des opérations.</p>
              <div className="pea-form-actions">
                <button type="button" className="primary-button" onClick={onClose}>Terminer</button>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
