"use client";

// Assistant d'IMPORT d'opérations (CSV, XLSX et scan IA sur le même parcours).
// ADMIN uniquement (le composant n'est rendu que si canManage). Parcours en 6 étapes :
//   fichier : 1) compte  2) téléversement  3) colonnes  4) vérification  5) confirmation  6) résultat
//   scan IA : 1) compte  2) document    3) ANALYSE  4) résultats    5) validation    6) terminé
// L'étape 3 du scan est un écran d'analyse à part entière : le document reste visible, les phases
// de traitement défilent, et une erreur s'y corrige sans repartir du début.
// AUCUNE opération n'est écrite avant l'étape 5 : la prévisualisation appelle /preview (lecture
// seule), la confirmation appelle /commit (revalidation serveur complète). Le fichier n'est jamais
// conservé : il est renvoyé à chaque prévisualisation et oublié côté serveur.

import { useEffect, useMemo, useRef, useState } from "react";
import { useDialogA11y } from "./use-dialog-a11y";
import { authenticatedFetch, OP_LABEL } from "./investment-account";
import {
  amountCoherenceWarning, buildTemplateCsv, toOperationInput, IMPORT_FIELDS,
  type ImportField, type NormalizedOp, type PreviewRow, type PreviewSummary, type RowStatus,
} from "../lib/investment-import";
import { validateOperation } from "../lib/account-operation";
import type { SnapshotPosition, SnapshotRowMeta } from "../lib/portfolio-snapshot-import";

type TargetAccount = { id: string; name: string; kind: "PEA" | "CTO"; currency: string; memberName: string | null };
type KnownHolding = { id: string; isin: string | null; symbol: string | null; name: string | null };

type NumberFormatChoice = "fr" | "us";

// Contre-vérification arithmétique renvoyée par le scan : somme des lignes retranscrites vs
// totaux imprimés sur le relevé. C'est la garantie qu'aucune ligne n'a été oubliée.
type TotalCheck = { expected: number; actual: number; ok: boolean } | null;
type TotalsCheck = { valuation: TotalCheck; gain: TotalCheck };

type ScanDocument = {
  institution: string | null; accountType: string | null; currency: string | null;
  holder: string | null; period: string | null;
  asOfDate?: string | null; totalValuation?: number | null; totalGain?: number | null; cashBalance?: number | null;
};

type PreviewResponse = {
  account: TargetAccount;
  mode?: "operations" | "snapshot";
  snapshot?: { asOfDate: string; positions: SnapshotPosition[] };
  document?: ScanDocument;
  totals?: TotalsCheck;
  /** Qualité de lecture mesurée : relectures effectuées et accord entre elles. */
  reading?: { passes: number; unanimousRows: number; disputedCells: number };
  provider?: string;
  columns: string[];
  mapping: Record<ImportField, number>;
  dateFormat: "iso" | "fr" | "us";
  numberFormat?: NumberFormatChoice;
  allowAdvanced: boolean;
  knownHoldings: KnownHolding[];
  summary: PreviewSummary;
  rows: Array<PreviewRow & { snapshot?: SnapshotRowMeta }>;
};

// Ligne éditable côté client (copie corrigeable de la prévisualisation serveur). Les champs ai*
// ne sont présents que pour un scan IA (confiance / texte source / page).
type EditableRow = PreviewRow & { snapshot?: SnapshotRowMeta; include: boolean; createInstrument: boolean; aiBand?: "high" | "medium" | "low"; aiConfidence?: number; aiSourceText?: string | null; aiPage?: number | null };
type ImportMode = "file" | "ai";

const FIELD_LABEL: Record<ImportField, string> = {
  date: "Date", type: "Type d'opération", isin: "ISIN", ticker: "Ticker", instrumentName: "Nom de l'instrument",
  quantity: "Quantité", unitPrice: "Prix unitaire", amount: "Montant", fees: "Frais", taxes: "Taxes",
  currency: "Devise", exchangeRate: "Taux de change", externalReference: "Référence externe", note: "Note",
};

// Phases affichées pendant l'analyse. Elles DÉCRIVENT le traitement réel côté serveur (lecture,
// identification du type de relevé, retranscription, contrôles déterministes) ; leur défilement
// est indicatif — l'appel réseau est unique et sa durée n'est pas connue à l'avance.
const SCAN_PHASES = [
  { icon: "📤", label: "Transmission du document", detail: "Le fichier est envoyé au moteur d’analyse, puis oublié — il n’est jamais conservé." },
  { icon: "🔍", label: "Identification du relevé", detail: "Positions détenues ou opérations datées : le type de document est reconnu." },
  { icon: "✍️", label: "Relectures croisées", detail: "Le tableau est relu plusieurs fois, indépendamment. Les chiffres lus différemment d’une relecture à l’autre sont signalés." },
  { icon: "🧮", label: "Contrôles de cohérence", detail: "Cours × quantité, totaux du relevé, clé de contrôle ISIN : vérifiés par le code." },
];

const euro = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 2 });

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
  // Séparateur décimal du fichier. « 81,023 » vaut 81,023 € en format FR et 81 023 € en format
  // US : l'ambiguïté est une propriété du DOCUMENT, pas de la cellule. Détecté côté serveur,
  // toujours affiché et corrigeable ici avant le moindre enregistrement.
  const [numberFormat, setNumberFormat] = useState<NumberFormatChoice>("fr");
  const [snapshotDate, setSnapshotDate] = useState("");
  // Mode d'écriture : ajouter aux opérations existantes (défaut) ou REMPLACER le portefeuille.
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [replaceConfirm, setReplaceConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<"all" | "anomalies">("all");
  const [result, setResult] = useState<{ imported: number; duplicates: number; newInstruments: number; replaced?: number; tracking?: "complete" | "limited" } | null>(null);
  // Aperçu du document scanné (image) : il reste sous les yeux pendant l'analyse et la
  // vérification, pour comparer ligne à ligne sans rouvrir le fichier.
  const [scanPhase, setScanPhase] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filePreview = useMemo(() => (file && file.type.startsWith("image/") ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => { if (filePreview) URL.revokeObjectURL(filePreview); }, [filePreview]);

  // Définition de l'image téléversée. Ce n'est pas un détail : sur une capture de 620 px de large
  // contenant un tableau de huit colonnes chiffrées, un chiffre ne fait que quelques pixels et se
  // lit mal (« 1 000 » lu « 100 », « 87,83 » lu « 83,78 » — constaté). Mieux vaut le dire AVANT
  // l'analyse que de faire corriger vingt cellules après.
  const [imageWidth, setImageWidth] = useState<number | null>(null);
  useEffect(() => {
    if (!filePreview) return;
    const probe = new Image();
    probe.onload = () => setImageWidth(probe.naturalWidth);
    probe.src = filePreview;
    return () => { probe.onload = null; };
  }, [filePreview]);
  const lowResolution = imageWidth !== null && imageWidth < 1100;

  // Défilement des phases pendant l'analyse. On s'arrête sur la dernière et on y reste : mieux
  // vaut une progression qui patiente qu'une barre qui prétend être terminée avant la réponse.
  useEffect(() => {
    if (!busy || mode !== "ai" || step !== 3) return;
    const timer = setInterval(() => setScanPhase((current) => Math.min(current + 1, SCAN_PHASES.length - 1)), 1700);
    return () => clearInterval(timer);
  }, [busy, mode, step]);

  async function runPreview(nextMapping?: Record<ImportField, number>, nextDateFormat?: "iso" | "fr" | "us", nextNumberFormat?: NumberFormatChoice) {
    if (!file) return;
    setBusy(true); setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("accountId", account.id);
      if (nextMapping) form.append("mapping", JSON.stringify(nextMapping));
      if (nextDateFormat) form.append("dateFormat", nextDateFormat);
      if (nextNumberFormat) form.append("numberFormat", nextNumberFormat);
      if (snapshotDate) form.append("snapshotDate", snapshotDate);
      const response = await authenticatedFetch("/api/investment-imports/preview", { method: "POST", body: form });
      const data = (await response.json().catch(() => ({}))) as PreviewResponse & { error?: string };
      if (!response.ok) { setError(data.error ?? "Analyse impossible."); setBusy(false); return; }
      setPreview(data);
      setMapping(data.mapping);
      setDateFormat(data.dateFormat);
      if (data.numberFormat) setNumberFormat(data.numberFormat);
      setRows(data.rows.map((row) => ({
        ...row,
        include: row.status !== "error" && row.status !== "duplicate_certain",
        createInstrument: data.mode === "snapshot" && !row.instrumentHoldingId,
      })));
      setStep(data.mode === "snapshot" ? 4 : 3);
    } catch {
      setError("Réseau indisponible.");
    }
    setBusy(false);
  }

  async function runScan() {
    if (!file) return;
    setBusy(true); setError(""); setScanPhase(0);
    setStep(3); // écran d'analyse : le document reste affiché pendant tout le traitement
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("accountId", account.id);
      if (snapshotDate) form.append("snapshotDate", snapshotDate);
      const response = await authenticatedFetch("/api/investment-imports/scan", { method: "POST", body: form });
      const data = (await response.json().catch(() => ({}))) as (PreviewResponse & { error?: string; code?: string });
      if (!response.ok) {
        const documentHint = data.document?.institution ? ` Document reconnu : ${data.document.institution}${data.document.period ? ` · période ${data.document.period}` : ""}.` : "";
        setError(`${data.error ?? "Analyse IA impossible."}${documentHint}`);
        setBusy(false); return; // on reste sur l'écran d'analyse : réessai ou changement de fichier
      }
      setPreview(data);
      if (data.snapshot?.asOfDate) setSnapshotDate(data.snapshot.asOfDate);
      setRows(data.rows.map((row) => {
        const editable = row as EditableRow;
        return {
          ...editable,
          // Une ligne à faible confiance reste décochée : c'est un choix explicite de l'admin.
          include: editable.aiBand !== "low" && row.status !== "error" && row.status !== "duplicate_certain",
          // Un relevé de positions décrit un portefeuille : les instruments inconnus doivent être
          // créés, sinon la position importée n'aurait aucun référentiel où s'accrocher.
          createInstrument: data.mode === "snapshot" && !row.instrumentHoldingId,
        };
      }));
      setStep(4); // le scan IA saute l'étape de mapping (colonnes déjà structurées)
    } catch {
      setError("Réseau indisponible.");
    }
    setBusy(false);
  }

  /** Date d'arrêté d'un relevé de positions scanné : modifiable sans relancer l'analyse. */
  function updateSnapshotDate(next: string) {
    setSnapshotDate(next);
    if (!next) return;
    setPreview((current) => (current?.snapshot ? { ...current, snapshot: { ...current.snapshot, asOfDate: next } } : current));
    setRows((current) => current.map((row) => (
      row.snapshot ? { ...row, op: { ...row.op, date: next }, snapshot: { ...row.snapshot, asOfDate: next } } : row
    )));
  }

  // Une ligne corrigée à la main doit voir son statut recalculé IMMÉDIATEMENT, sinon une erreur
  // que l'administrateur vient de résoudre continuerait de bloquer l'import. On rejoue ici les
  // mêmes fonctions pures que le serveur (validateOperation / amountCoherenceWarning) : la
  // revalidation complète reste faite au commit, celle-ci n'est qu'un miroir immédiat.
  function revalidateRow(row: EditableRow): EditableRow {
    const op = row.op;
    const errors: string[] = [];
    // Erreurs que le client ne peut pas rejouer (garde PEA, migration manquante, ligne vide).
    const kept = row.errors.filter((message) => /vente de |migration|ligne vide/i.test(message));
    if (!op.type) errors.push("Type d'opération non reconnu.");
    if (!op.date) errors.push("Date illisible ou absente.");
    if (op.type && op.date) {
      const validation = validateOperation(toOperationInput(op));
      if (!validation.ok) errors.push(validation.error);
    }
    const needsInstrument = op.type === "achat" || op.type === "vente" || op.type === "dividende" || op.type === "transfer_in" || op.type === "transfer_out";
    if (needsInstrument && !row.instrumentHoldingId && !op.isin && !op.ticker && !op.instrumentName) {
      errors.push("Instrument manquant pour cette opération.");
    }
    const warnings = row.warnings.filter((message) => !message.startsWith("Incohérence :"));
    const coherence = amountCoherenceWarning(op);
    if (coherence) warnings.push(coherence);
    const allErrors = [...new Set([...kept, ...errors])];
    const status: RowStatus = allErrors.length > 0
      ? "error"
      : row.status === "duplicate_certain" || row.status === "duplicate_possible"
        ? row.status
        : warnings.length > 0 ? "warning" : "valid";
    return { ...row, errors: allErrors, warnings, status };
  }

  function updateRow(index: number, patch: Partial<NormalizedOp>) {
    setRows((current) => current.map((row) => (row.index === index ? revalidateRow({ ...row, op: { ...row.op, ...patch } }) : row)));
  }
  // Correction d'un cours de relevé (mode « portefeuille instantané »). C'est cette valeur qui
  // sera écrite dans holdings.last_price au commit — elle doit donc rester éditable ici.
  function updateSnapshot(index: number, patch: Partial<SnapshotRowMeta>) {
    setRows((current) => current.map((row) => (row.index === index && row.snapshot ? { ...row, snapshot: { ...row.snapshot, ...patch } } : row)));
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
  // Lignes dont le cours contredit la valorisation du relevé (cours × quantité ≠ valorisation).
  const mismatchCount = useMemo(() => rows.filter((row) => row.snapshot?.priceMismatch && row.snapshot.derivedPrice !== null).length, [rows]);

  /** Remplace les cours contredits par le cours RECALCULÉ (valorisation ÷ quantité du relevé). */
  function applyDerivedPrices() {
    setRows((current) => current.map((row) => (
      row.snapshot?.priceMismatch && row.snapshot.derivedPrice !== null
        ? { ...row, snapshot: { ...row.snapshot, lastPrice: row.snapshot.derivedPrice, priceMismatch: false } }
        : row
    )));
  }

  async function commit() {
    if (!preview) return;
    setBusy(true); setError("");
    // Instruments à créer (uniquement ceux cochés, non reconnus, avec au moins un identifiant).
    const newInstruments = included
      .filter((row) => row.createInstrument && !row.instrumentHoldingId)
      .map((row) => ({
        isin: row.op.isin,
        ticker: row.op.ticker,
        name: row.op.instrumentName ?? row.op.ticker ?? row.op.isin,
        assetType: "other",
        currency: row.op.currency,
        lastPrice: row.snapshot?.lastPrice ?? null,
        lastPriceAt: row.snapshot?.asOfDate ?? null,
      }))
      .filter((instrument) => instrument.name);
    const portfolioSnapshot = preview.mode === "snapshot" && preview.snapshot
      ? {
          asOfDate: preview.snapshot.asOfDate,
          positions: included.map((row) => ({
            isin: row.op.isin,
            ticker: row.op.ticker,
            name: row.op.instrumentName,
            currency: row.op.currency,
            lastPrice: row.snapshot?.lastPrice ?? null,
            lastPriceAt: row.snapshot?.asOfDate ?? preview.snapshot?.asOfDate ?? null,
          })),
        }
      : undefined;
    try {
      const response = await authenticatedFetch("/api/investment-imports/commit", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId: account.id, filename: file?.name, sourceKind: mode === "ai" ? "ai_scan" : "file",
          fileType: mode === "ai" ? (file?.type.includes("pdf") ? "pdf" : "image") : (file?.name.toLowerCase().endsWith(".xls") ? "xls" : file?.name.toLowerCase().endsWith(".xlsx") ? "xlsx" : "csv"),
          mapping: mode === "ai" ? null : mapping,
          operations: included.map((row) => row.op),
          newInstruments,
          portfolioSnapshot,
          replaceExisting,
          replaceConfirm: replaceExisting ? replaceConfirm.trim() : undefined,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as { imported?: number; duplicates?: number; newInstruments?: number; replaced?: number; tracking?: "complete" | "limited"; error?: string; invalidLines?: Array<{ line: number; error: string }> };
      if (!response.ok) {
        setError(data.error ?? "Import impossible." + (data.invalidLines?.length ? ` (${data.invalidLines.length} ligne(s) invalide(s))` : ""));
        setBusy(false); return;
      }
      setResult({ imported: data.imported ?? 0, duplicates: data.duplicates ?? 0, newInstruments: data.newInstruments ?? 0, replaced: data.replaced ?? 0, tracking: data.tracking });
      setStep(6);
      onDone();
    } catch {
      setError("Réseau indisponible.");
    }
    setBusy(false);
  }

  const summary = preview?.summary;
  const isSnapshot = preview?.mode === "snapshot";
  const stepLabels = mode === "ai"
    ? ["Compte", "Document", "Analyse", "Résultats", "Validation", "Terminé"]
    : ["Compte", "Fichier", "Colonnes", "Vérification", "Confirmation", "Résultat"];

  // Totaux des lignes affichées — c'est ce que l'administrateur s'apprête réellement à importer,
  // et non ce que l'IA a annoncé. Recalculés à chaque correction.
  const includedValuation = included.reduce((total, row) => total + (row.snapshot?.currentValue ?? 0), 0);
  const includedGain = included.reduce((total, row) => total + (row.snapshot?.gainEur ?? 0), 0);

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
          {/* L'écran d'analyse présente lui-même ses erreurs, en contexte : pas de doublon ici. */}
          {error && !(step === 3 && mode === "ai") && <p className="pea-form-error" role="alert">{error}</p>}

          {/* Étape 1 — compte */}
          {step === 1 && (
            <div className="imp-panel">
              <p>Vous allez importer l’historique d’opérations du compte&nbsp;:</p>
              <div className="imp-account-card"><strong>{account.name}</strong><small>{account.kind} · {account.currency}{account.memberName ? ` · ${account.memberName}` : ""}</small></div>
              <p className="imp-hint">Importez l’historique fourni par votre banque ou votre courtier. Le fichier n’est pas conservé ; il sert uniquement à préparer les opérations que vous validerez.</p>

              <fieldset className="imp-mode-choice">
                <legend>Que faire des opérations déjà enregistrées&nbsp;?</legend>
                <label className={replaceExisting ? "" : "active"}>
                  <input type="radio" name="import-write-mode" checked={!replaceExisting} onChange={() => setReplaceExisting(false)} />
                  <span><strong>Ajouter</strong><small>Les opérations du fichier s’ajoutent à l’existant. Les doublons certains sont écartés.</small></span>
                </label>
                <label className={replaceExisting ? "active imp-danger" : "imp-danger"}>
                  <input type="radio" name="import-write-mode" checked={replaceExisting} onChange={() => setReplaceExisting(true)} />
                  <span><strong>Remplacer tout le portefeuille</strong><small>Toutes les opérations actuelles de ce compte sont supprimées et remplacées par celles du fichier. Irréversible — une confirmation sera demandée.</small></span>
                </label>
              </fieldset>

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
                  accept={mode === "ai" ? ".pdf,image/png,image/jpeg,image/webp,application/pdf" : ".csv,.txt,.xls,.xlsx,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}
                  hidden onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
                {filePreview
                  // eslint-disable-next-line @next/next/no-img-element -- aperçu local (blob:), jamais téléversé ni optimisable
                  ? <img className="imp-thumb" src={filePreview} alt={`Aperçu de ${file?.name ?? "votre document"}`} />
                  : <span className="imp-drop-icon" aria-hidden="true">{mode === "ai" ? "🧾" : "📄"}</span>}
                <strong>{file ? file.name : mode === "ai" ? "Glissez un PDF ou une image de relevé, ou cliquez" : "Glissez un fichier CSV ou Excel ici, ou cliquez pour choisir"}</strong>
                <small>{mode === "ai" ? "PDF, PNG, JPG ou WEBP. Relevés numériques nets de préférence." : "Formats acceptés : CSV, XLS ou XLSX. Taille max 2 Mo."}</small>
              </div>
              {mode === "ai" && lowResolution && (
                <p className="imp-ai-banner imp-check-ko" role="note">
                  ⚠ Cette image ne fait que <b>{imageWidth} px</b> de large. Sur un tableau de bourse, chaque chiffre
                  n’occupe alors que quelques pixels et se lit mal — un «&nbsp;1&nbsp;000&nbsp;» devient «&nbsp;100&nbsp;».
                  Refaites la capture en <b>pleine résolution</b> (fenêtre agrandie, ou capture d’écran non redimensionnée),
                  ou utilisez l’export CSV du relevé. L’analyse reste possible, mais vérifiez chaque ligne.
                </p>
              )}
              {mode === "ai" && (
                <div className="imp-scan-kinds">
                  <span><b>Deux types de relevés</b> sont reconnus, sans réglage&nbsp;:</span>
                  <span>🧾 <b>Vos positions</b> — le tableau «&nbsp;Valeur / Quantité / PRU / Cours / Montant&nbsp;». Il décrit le portefeuille à une date&nbsp;: les positions sont enregistrées comme solde initial.</span>
                  <span>📈 <b>Vos mouvements</b> — une ligne par opération datée (achat, vente, versement, dividende). Elles s’ajoutent à l’historique.</span>
                  <label className="imp-inline">Date du relevé (si absente du document)
                    <input type="date" value={snapshotDate} onChange={(event) => setSnapshotDate(event.target.value)} />
                  </label>
                </div>
              )}
              {mode === "file" ? (
                <div className="imp-templates">
                  <button type="button" className="btc-link" onClick={() => download(`modele-import-${account.kind.toLowerCase()}.csv`, buildTemplateCsv())}>⬇ Télécharger le modèle CSV</button>
                  <span className="imp-hint">Le modèle contient des opérations. Un relevé avec Libellé, Qté, PRU, Cours et ISIN sera reconnu comme portefeuille instantané.</span>
                  <label className="imp-inline">Date du relevé (si absente du fichier)
                    <input type="date" value={snapshotDate} onChange={(event) => setSnapshotDate(event.target.value)} />
                  </label>
                </div>
              ) : (
                <p className="imp-hint">L’IA lit le document et propose des opérations à vérifier. Aucune donnée n’est enregistrée automatiquement. Le fichier n’est pas conservé. L’écriture manuscrite, les photos floues ou les relevés protégés ne sont pas garantis — préférez alors le CSV ou la saisie manuelle.</p>
              )}
              <div className="pea-form-actions">
                <button type="button" className="secondary-button" onClick={() => setStep(1)}>Retour</button>
                <button type="button" className="primary-button" disabled={!file || busy} onClick={() => (mode === "ai" ? runScan() : runPreview())}>{busy ? "Analyse…" : mode === "ai" ? "Analyser le relevé" : "Analyser le fichier"}</button>
              </div>
            </div>
          )}

          {/* Étape 3 (scan IA) — écran d'analyse */}
          {step === 3 && mode === "ai" && (
            <div className="imp-panel imp-scan">
              <div className="imp-scan-stage">
                <figure className={`imp-scan-doc${busy ? " is-scanning" : ""}`}>
                  {filePreview
                    // eslint-disable-next-line @next/next/no-img-element -- aperçu local (blob:), jamais téléversé
                    ? <img src={filePreview} alt={`Document analysé : ${file?.name ?? ""}`} />
                    : <span className="imp-scan-doc-icon" aria-hidden="true">📄</span>}
                  {busy && <span className="imp-scan-beam" aria-hidden="true" />}
                  <figcaption>{file?.name}</figcaption>
                </figure>

                <ol className="imp-scan-phases" aria-live="polite">
                  {SCAN_PHASES.map((phase, index) => {
                    const state = error ? (index < scanPhase ? "done" : index === scanPhase ? "failed" : "todo")
                      : !busy ? "done"
                        : index < scanPhase ? "done" : index === scanPhase ? "active" : "todo";
                    return (
                      <li key={phase.label} className={`imp-scan-phase is-${state}`}>
                        <span className="imp-scan-phase-icon" aria-hidden="true">{state === "done" ? "✓" : state === "failed" ? "!" : phase.icon}</span>
                        <span className="imp-scan-phase-copy">
                          <strong>{phase.label}</strong>
                          <small>{phase.detail}</small>
                        </span>
                      </li>
                    );
                  })}
                </ol>
              </div>

              {busy && (
                <>
                  <div className="imp-scan-bar" role="progressbar" aria-label="Analyse du relevé en cours"><span /></div>
                  <p className="imp-hint">L’analyse d’un relevé prend généralement de 10 à 40 secondes. Rien n’est enregistré : vous vérifierez chaque ligne à l’étape suivante.</p>
                </>
              )}

              {!busy && error && (
                <div className="imp-danger-box">
                  <strong>⚠ L’analyse n’a rien pu retranscrire</strong>
                  <p>{error}</p>
                  <p>Ce qui aide le plus&nbsp;: une capture <b>nette</b> et <b>entière</b> du tableau (colonnes et en-têtes visibles), sans recadrage partiel. Un export CSV du même relevé reste la voie la plus fiable.</p>
                </div>
              )}

              <div className="pea-form-actions">
                <button type="button" className="secondary-button" disabled={busy} onClick={() => { setError(""); setStep(2); }}>Changer de document</button>
                {!busy && error && <button type="button" className="primary-button" onClick={() => void runScan()}>Relancer l’analyse</button>}
              </div>
            </div>
          )}

          {/* Étape 3 (fichier) — correspondance des colonnes */}
          {step === 3 && mode !== "ai" && preview && mapping && (
            <div className="imp-panel">
              <p className="imp-hint">Vérifiez la correspondance entre les colonnes de votre fichier et les champs attendus. Les colonnes ont été détectées automatiquement ; corrigez si nécessaire.</p>
              <label className="imp-inline">Format de date&nbsp;
                <select value={dateFormat} onChange={(event) => setDateFormat(event.target.value as "iso" | "fr" | "us")}>
                  <option value="fr">Jour/Mois/Année (FR)</option>
                  <option value="us">Mois/Jour/Année (US)</option>
                  <option value="iso">Année-Mois-Jour (ISO)</option>
                </select>
              </label>
              <label className="imp-inline">Format des nombres&nbsp;
                <select value={numberFormat} onChange={(event) => setNumberFormat(event.target.value as NumberFormatChoice)}>
                  <option value="fr">1 234,56 — virgule décimale (FR)</option>
                  <option value="us">1,234.56 — point décimal (US)</option>
                </select>
              </label>
              <p className="imp-hint">Vérifiez ce réglage&nbsp;: dans un fichier français, «&nbsp;81,023&nbsp;» vaut <b>81,023&nbsp;€</b>&nbsp;; lu en format américain, il vaudrait <b>81&nbsp;023&nbsp;€</b> — soit une valeur de portefeuille multipliée par mille. La prévisualisation signale les lignes dont le montant ne correspond pas à quantité&nbsp;× prix.</p>
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
                <button type="button" className="primary-button" disabled={busy} onClick={() => runPreview(mapping, dateFormat, numberFormat).then(() => setStep(4))}>{busy ? "Analyse…" : "Prévisualiser"}</button>
              </div>
            </div>
          )}

          {/* Étape 4 — prévisualisation + correction */}
          {step === 4 && preview && summary && (
            <div className="imp-panel">
              {mode === "ai" && (
                <>
                  <p className="imp-ai-banner" role="note">
                    ✨ {isSnapshot ? "Relevé de POSITIONS retranscrit" : "Relevé de MOUVEMENTS retranscrit"}{preview.provider ? ` (${preview.provider})` : ""} — {summary.total} ligne(s).
                    Rien n’est encore enregistré : corrigez ce qui doit l’être, décochez le reste.
                  </p>

                  {/* Qualité de LECTURE, mesurée. Une IA annonce volontiers 98 % de confiance sur
                      un « 1 000 » lu « 100 » : on affiche donc l'accord entre relectures, pas la
                      confiance que le modèle s'attribue. */}
                  {preview.reading && preview.reading.passes > 1 && (
                    <p className={`imp-ai-banner ${preview.reading.disputedCells === 0 ? "imp-check-ok" : "imp-check-ko"}`} role="note">
                      {preview.reading.disputedCells === 0
                        ? `✓ Le document a été relu ${preview.reading.passes} fois de façon indépendante : les ${preview.reading.passes} relectures donnent exactement les mêmes chiffres sur les ${preview.reading.unanimousRows} ligne(s).`
                        : `⚠ Le document a été relu ${preview.reading.passes} fois : ${preview.reading.disputedCells} valeur(s) ont été lues DIFFÉREMMENT d’une relecture à l’autre, sur ${summary.total - preview.reading.unanimousRows} ligne(s). Ces cellules sont signalées ci-dessous et leur ligne est décochée — vérifiez-les sur le relevé avant de les inclure.`}
                    </p>
                  )}
                  {preview.reading && preview.reading.passes === 1 && (
                    <p className="imp-ai-banner" role="note">
                      ⚠ Une seule relecture a abouti : impossible de recouper les chiffres. Vérifiez chaque ligne avec le document d’origine.
                    </p>
                  )}

                  {/* Carte d'identité du document : ce que le relevé dit de lui-même. */}
                  {preview.document && (
                    <dl className="imp-doc-card">
                      <div><dt>Établissement</dt><dd>{preview.document.institution ?? "—"}</dd></div>
                      <div><dt>Titulaire</dt><dd>{preview.document.holder ?? "—"}</dd></div>
                      <div><dt>Type</dt><dd>{preview.document.accountType === "pea" ? "PEA" : preview.document.accountType === "securities" ? "Compte-titres" : "—"}</dd></div>
                      <div><dt>Devise</dt><dd>{preview.document.currency ?? preview.account.currency}</dd></div>
                      <div><dt>{isSnapshot ? "Espèces au relevé" : "Période"}</dt><dd>{isSnapshot ? (preview.document.cashBalance != null ? euro.format(preview.document.cashBalance) : "—") : (preview.document.period ?? "—")}</dd></div>
                      {isSnapshot && (
                        <div>
                          <dt>Date du relevé</dt>
                          <dd>
                            <input type="date" className="imp-cell" value={snapshotDate} max={new Date().toISOString().slice(0, 10)}
                              aria-label="Date d’arrêté du relevé" onChange={(event) => updateSnapshotDate(event.target.value)} />
                            {!preview.document.asOfDate && <small className="imp-msg imp-warn">Non lue sur le document : vérifiez-la.</small>}
                          </dd>
                        </div>
                      )}
                    </dl>
                  )}

                  {/* Contre-vérification : somme des lignes retranscrites vs totaux imprimés. */}
                  {preview.totals?.valuation && (
                    <p className={`imp-ai-banner ${preview.totals.valuation.ok ? "imp-check-ok" : "imp-check-ko"}`} role="note">
                      {preview.totals.valuation.ok
                        ? `✓ Contrôle arithmétique : la somme des ${summary.total} lignes retranscrites (${euro.format(preview.totals.valuation.actual)}) correspond au total imprimé sur le relevé (${euro.format(preview.totals.valuation.expected)}). Aucune ligne ne manque.`
                        : `⚠ La somme des lignes retranscrites (${euro.format(preview.totals.valuation.actual)}) ne correspond PAS au total imprimé sur le relevé (${euro.format(preview.totals.valuation.expected)}) : écart de ${euro.format(preview.totals.valuation.actual - preview.totals.valuation.expected)}. Une ligne est probablement manquante ou mal lue — vérifiez avant de valider.`}
                    </p>
                  )}

                  {isSnapshot && (
                    <div className="imp-kpis">
                      <div><span>Positions retenues</span><strong>{included.length}<small> / {summary.total}</small></strong></div>
                      <div><span>Valorisation importée</span><strong>{euro.format(includedValuation)}</strong></div>
                      <div><span>+/- values latentes</span><strong className={includedGain >= 0 ? "imp-ok" : "imp-err"}>{includedGain >= 0 ? "+" : ""}{euro.format(includedGain)}</strong></div>
                      <div><span>Confiance basse</span><strong>{rows.filter((row) => row.aiBand === "low").length}</strong></div>
                    </div>
                  )}
                </>
              )}
              {preview.mode === "snapshot" && <p className="imp-ai-banner" role="note">📊 Relevé de portefeuille — arrêté au {preview.snapshot?.asOfDate ?? "—"}. Les positions seront enregistrées comme solde initial, puis valorisées avec le cours du relevé. Le flux est identique pour le PEA et le compte-titres.</p>}
              <div className="imp-summary">
                <span><b>{summary.total}</b> lignes</span>
                <span className="imp-ok"><b>{included.filter((r) => r.errors.length === 0).length}</b> à importer</span>
                <span className="imp-warn"><b>{summary.toCheck}</b> à vérifier</span>
                <span className="imp-err"><b>{summary.errors}</b> en erreur</span>
                <span className="imp-dup"><b>{summary.duplicatesCertain + summary.duplicatesPossible}</b> doublons</span>
                <span><b>{summary.unknownInstruments}</b> instruments non reconnus</span>
              </div>
              {mode !== "ai" && (
                <div className="imp-recheck">
                  <label className="imp-inline">Format des nombres&nbsp;
                    <select value={numberFormat} disabled={busy}
                      onChange={(event) => { const next = event.target.value as NumberFormatChoice; setNumberFormat(next); runPreview(mapping ?? undefined, dateFormat, next); }}>
                      <option value="fr">1 234,56 — virgule décimale (FR)</option>
                      <option value="us">1,234.56 — point décimal (US)</option>
                    </select>
                  </label>
                  <small className="imp-hint">Changer ce réglage relit le fichier immédiatement. Toute ligne dont le montant ne correspond pas à quantité × prix est signalée «&nbsp;à vérifier&nbsp;».</small>
                </div>
              )}
              {mismatchCount > 0 && (
                <p className="imp-ai-banner imp-warn" role="note">
                  ⚠ {mismatchCount} cours ne correspond{mismatchCount > 1 ? "ent" : ""} pas à la valorisation du relevé (valorisation ÷ quantité).
                  <button type="button" className="btc-link" onClick={applyDerivedPrices}>Utiliser les cours recalculés depuis le relevé</button>
                </p>
              )}
              <label className="imp-inline"><input type="checkbox" checked={filter === "anomalies"} onChange={(event) => setFilter(event.target.checked ? "anomalies" : "all")} /> N’afficher que les anomalies</label>
              <div className="responsive-table imp-table-wrap">
                <table className="btc-table imp-table">
                  <thead><tr><th>#</th><th>Statut</th><th>Date</th><th>Type</th><th>Instrument</th><th>Qté</th><th>{preview.mode === "snapshot" ? "PRU" : "Prix"}</th>{preview.mode === "snapshot" && <th>Cours</th>}{preview.mode === "snapshot" && <th>Var./veille</th>}<th>{preview.mode === "snapshot" ? "Valorisation" : "Montant"}</th>{preview.mode === "snapshot" && <th>+/- value</th>}<th>Devise</th>{mode === "ai" && <th title="Accord entre les relectures indépendantes du document">Relectures</th>}<th>Importer</th></tr></thead>
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
                            {row.op.isin && <small className="imp-msg imp-isin">{row.op.isin}</small>}
                            {row.instrumentHoldingId ? <small className="imp-msg imp-ok">reconnu ({row.matchedBy})</small>
                              // Une position de relevé porte le type « correction » : elle a besoin du même
                              // choix « créer l'instrument » qu'un achat, sinon elle n'a aucun référentiel.
                              : (unknownInstrument || row.snapshot) ? <label className="imp-msg"><input type="checkbox" checked={row.createInstrument} onChange={(event) => toggleCreate(row.index, event.target.checked)} /> créer l’instrument</label> : null}
                          </td>
                          <td className="num">
                            <input className="imp-cell num" type="number" step="any" value={row.op.quantity ?? ""}
                              aria-label={`Quantité ligne ${row.index}`}
                              onChange={(event) => updateRow(row.index, { quantity: event.target.value === "" ? null : Number(event.target.value) })} />
                          </td>
                          <td className="num">
                            <input className="imp-cell num" type="number" step="any" value={row.op.unitPrice ?? ""}
                              aria-label={`${preview.mode === "snapshot" ? "Prix de revient" : "Prix unitaire"} ligne ${row.index}`}
                              onChange={(event) => updateRow(row.index, { unitPrice: event.target.value === "" ? null : Number(event.target.value) })} />
                          </td>
                          {preview.mode === "snapshot" && (
                            <td className="num">
                              <input className={`imp-cell num${row.snapshot?.priceMismatch ? " imp-cell-warn" : ""}`} type="number" step="any" value={row.snapshot?.lastPrice ?? ""}
                                aria-label={`Cours ligne ${row.index}`}
                                onChange={(event) => updateSnapshot(row.index, { lastPrice: event.target.value === "" ? null : Number(event.target.value), priceMismatch: false })} />
                              {row.snapshot?.priceMismatch && row.snapshot.derivedPrice !== null && (
                                <button type="button" className="imp-msg imp-warn imp-fix" title="Cours recalculé : valorisation ÷ quantité, d'après le relevé lui-même"
                                  onClick={() => updateSnapshot(row.index, { lastPrice: row.snapshot!.derivedPrice, priceMismatch: false })}>
                                  → {row.snapshot.derivedPrice}
                                </button>
                              )}
                            </td>
                          )}
                          {preview.mode === "snapshot" && <td className="num">{row.snapshot?.dayChangePct === null || row.snapshot?.dayChangePct === undefined ? "—" : `${row.snapshot.dayChangePct} %`}</td>}
                          <td className="num">{preview.mode === "snapshot" ? (row.snapshot?.currentValue ?? "—") : (
                            <input className="imp-cell num" type="number" step="any" value={row.op.amount ?? ""}
                              aria-label={`Montant ligne ${row.index}`}
                              onChange={(event) => updateRow(row.index, { amount: event.target.value === "" ? null : Number(event.target.value) })} />
                          )}</td>
                          {preview.mode === "snapshot" && <td className="num">{row.snapshot?.gainEur ?? "—"}{row.snapshot?.gainPct === null || row.snapshot?.gainPct === undefined ? "" : ` (${row.snapshot.gainPct} %)`}</td>}
                          <td>{row.op.currency}</td>
                          {mode === "ai" && (
                            <td>
                              {row.aiBand
                                ? <span className={`imp-badge imp-conf-${row.aiBand}`} title={row.aiSourceText ? `« ${row.aiSourceText} »${row.aiPage ? ` (p.${row.aiPage})` : ""}` : undefined}>
                                    {row.aiBand === "high" ? "Concordante" : row.aiBand === "medium" ? "Écarts mineurs" : "Divergente"}
                                  </span>
                                : "—"}
                            </td>
                          )}
                          <td><input type="checkbox" checked={row.include} onChange={(event) => toggleInclude(row.index, event.target.checked)} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {mode === "ai" && filePreview && (
                <details className="imp-doc-compare">
                  <summary>Comparer avec le document d’origine</summary>
                  {/* eslint-disable-next-line @next/next/no-img-element -- aperçu local (blob:), jamais téléversé */}
                  <img src={filePreview} alt={`Document d’origine : ${file?.name ?? ""}`} />
                </details>
              )}
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
                <p><b>{included.length}</b> {isSnapshot ? "position(s)" : "opération(s)"} seront importées{isSnapshot ? ` pour une valorisation de ${euro.format(includedValuation)}` : ""}.</p>
                <p>{rows.length - included.length} ligne(s) seront ignorées.</p>
                <p>{summary.duplicatesCertain} doublon(s) certain(s) exclus.</p>
                <p>{included.filter((r) => r.createInstrument && !r.instrumentHoldingId).length} nouvel(s) instrument(s) seront créés{isSnapshot ? " avec le cours du relevé" : " sans cours de marché"}.</p>
                {isSnapshot && <p>Les positions sont enregistrées comme <b>solde initial au {snapshotDate || preview?.snapshot?.asOfDate}</b>, pas comme des achats : la performance ne sera calculée qu’à partir de cette date.</p>}
              </div>
              {replaceExisting && (
                <div className="imp-danger-box" role="group" aria-labelledby="imp-replace-title">
                  <strong id="imp-replace-title">⚠ Remplacement du portefeuille</strong>
                  <p>Toutes les opérations actuellement enregistrées sur <b>{account.name}</b> seront <b>définitivement supprimées</b> et remplacées par celles de ce fichier. Cette action est irréversible.</p>
                  <label className="pea-field pea-field-wide">
                    <span>Saisissez le nom exact du compte pour confirmer</span>
                    <input value={replaceConfirm} onChange={(event) => setReplaceConfirm(event.target.value)} placeholder={account.name} autoComplete="off" />
                  </label>
                </div>
              )}
              <p className="imp-hint">L’enregistrement est revalidé côté serveur. En cas d’erreur, aucun import partiel n’est créé{replaceExisting ? " — et les opérations existantes ne sont supprimées qu’après une insertion réussie" : ""}.</p>
              <div className="pea-form-actions">
                <button type="button" className="secondary-button" onClick={() => setStep(4)}>Retour</button>
                <button type="button" className={replaceExisting ? "danger-button" : "primary-button"} disabled={busy || (replaceExisting && replaceConfirm.trim() !== account.name.trim())} onClick={commit}>
                  {busy ? "Import…" : replaceExisting ? "Remplacer le portefeuille" : "Confirmer l'import"}
                </button>
              </div>
            </div>
          )}

          {/* Étape 6 — résultat */}
          {step === 6 && result && (
            <div className="imp-panel imp-result">
              <span className="imp-result-icon" aria-hidden="true">✓</span>
              <h3>Import terminé</h3>
              <p><b>{result.imported}</b> opération(s) importée(s){result.replaced ? `, ${result.replaced} ancienne(s) opération(s) remplacée(s)` : ""}{result.duplicates ? `, ${result.duplicates} doublon(s) exclus` : ""}{result.newInstruments ? `, ${result.newInstruments} instrument(s) créé(s)` : ""}.</p>
              <p className="imp-hint">Les cours issus d’un fichier peuvent être périmés&nbsp;: depuis l’onglet «&nbsp;Mes positions&nbsp;», utilisez <b>Actualiser les cours</b> pour les relire auprès d’un fournisseur de marché.</p>
              {result.tracking === "limited" && <p className="imp-hint">Import enregistré. La migration de traçabilité des imports n&apos;est pas encore appliquée : le portefeuille fonctionne, mais l&apos;historique détaillé et le dédoublonnage inter-imports seront complets après application de la migration Supabase.</p>}
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
