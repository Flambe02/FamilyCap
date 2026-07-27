"use client";

// Assistant d'IMPORT d'opérations (CSV, XLSX et scan IA sur le même parcours).
// ADMIN uniquement (le composant n'est rendu que si canManage). Parcours en 6 étapes :
//   fichier : 1) compte  2) téléversement  3) colonnes  4) vérification  5) confirmation  6) résultat
//   scan IA : 1) compte  2) document    3) ANALYSE  4) validation   5) confirmation  6) terminé
// L'étape 3 du scan est un écran d'analyse à part entière : le document reste visible, les phases
// de traitement défilent, et une erreur s'y corrige sans repartir du début.
// AUCUNE opération n'est écrite avant l'étape 5 : la prévisualisation appelle /preview ou /scan
// (lecture seule), la confirmation appelle /commit (revalidation serveur complète). Le fichier
// n'est jamais conservé : il est renvoyé à chaque analyse et oublié côté serveur.
//
// UNE SEULE ENTRÉE DE FICHIER (`selectFile`) sert au clic, au glisser-déposer ET au collage
// Ctrl+V / Cmd+V : une capture collée suit exactement le même chemin qu'un fichier téléversé.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDialogA11y } from "./use-dialog-a11y";
import { authenticatedFetch, OP_LABEL } from "./investment-account";
import {
  amountCoherenceWarning, buildTemplateCsv, toOperationInput, IMPORT_FIELDS,
  type ImportField, type NormalizedOp, type PreviewRow, type PreviewSummary, type RowStatus,
} from "../lib/investment-import";
import { validateOperation } from "../lib/account-operation";
import { imageFileFromClipboard, localFileKey, shouldIgnorePaste } from "../lib/clipboard-image";
import {
  buildStatementOperations, costBasisOf, runAccountingChecks, summarizeChecks,
  type AccountingCheck, type BrokerStatement, type StatementHeader, type StatementPosition,
} from "../lib/document-extraction/statement";
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

/** Position renvoyée par /scan : le relevé, enrichi du rapprochement avec le portefeuille. */
type ScannedPosition = StatementPosition & {
  holdingId: string | null;
  matchedBy: "isin" | "ticker" | "name" | null;
  heldQuantity: number;
  alreadyImported: boolean;
};

type CaptureInfo = {
  filename: string; bytes: number; hash: string; mediaType: string;
  width: number | null; height: number | null; preprocessing: string[]; preprocessed: boolean;
  targetedPass?: boolean; passes?: number;
};

type DuplicateInfo = { batchId: string; importedAt: string | null; filename: string | null; importedRows: number };

type PreviewResponse = {
  account: TargetAccount;
  mode?: "operations" | "snapshot" | "statement";
  snapshot?: { asOfDate: string; positions: SnapshotPosition[] };
  document?: ScanDocument;
  totals?: TotalsCheck;
  /** Qualité de lecture mesurée : relectures effectuées et accord entre elles. */
  reading?: { passes: number; unanimousRows: number; disputedCells: number; disputedHeaderFields?: string[] };
  provider?: string;
  columns: string[];
  mapping: Record<ImportField, number>;
  dateFormat: "iso" | "fr" | "us";
  numberFormat?: NumberFormatChoice;
  allowAdvanced: boolean;
  knownHoldings: KnownHolding[];
  summary: PreviewSummary;
  rows: Array<PreviewRow & { snapshot?: SnapshotRowMeta }>;
  // Mode « statement » (capture de portefeuille reconnue).
  statement?: { header: StatementHeader; positions: ScannedPosition[]; warnings: string[] };
  broker?: { id: string; label: string | null; recognised: boolean };
  schema?: { strict: boolean; issues: string[] };
  checks?: AccountingCheck[];
  checksSummary?: { total: number; passed: number; failed: number; blockingFailures: number; importable: boolean };
  operationsPreview?: { count: number; totalCostBasis: number; cashRecorded: number | null; notImported: Array<{ label: string; value: number | null; reason: string }> };
  reconciliation?: { newPositions: number; existingPositions: number; possibleDuplicates: number; heldPositions: number; accountHasOperations: boolean };
  capture?: CaptureInfo;
  captureHash?: string;
  duplicate?: DuplicateInfo | null;
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

// Phases affichées pendant l'analyse. Elles DÉCRIVENT le traitement réel côté serveur ; leur
// défilement est indicatif — l'appel réseau est unique et sa durée n'est pas connue à l'avance.
const SCAN_PHASES = [
  { icon: "📤", label: "Transmission du document", detail: "Le fichier est envoyé au moteur d’analyse, puis oublié — il n’est jamais conservé." },
  { icon: "🔎", label: "Reconnaissance du courtier", detail: "Les intitulés lus sur la capture (« Px. Revient », « +/- Latentes »…) identifient le relevé." },
  { icon: "✍️", label: "Relectures croisées", detail: "Le tableau est relu plusieurs fois, indépendamment. Les chiffres lus différemment d’une relecture à l’autre sont signalés." },
  { icon: "🧮", label: "Contrôles comptables", detail: "Titres + espèces, somme des lignes, quantité × cours, clé ISIN : tout est revérifié par le code." },
];

const euro = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 2 });
const decimal = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 });

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

function money(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : euro.format(value);
}

export function InvestmentImportWizard({ account, onClose, onDone }: { account: TargetAccount; onClose: () => void; onDone: () => void }) {
  const dialogRef = useDialogA11y(true, onClose);
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5 | 6>(1);
  const [mode, setMode] = useState<ImportMode>("ai");
  const [file, setFile] = useState<File | null>(null);
  /** Provenance du fichier : elle change le libellé affiché (« Image collée » vs nom du fichier). */
  const [fileOrigin, setFileOrigin] = useState<"picked" | "dropped" | "pasted">("picked");
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
  const [result, setResult] = useState<{ imported: number; duplicates: number; newInstruments: number; replaced?: number; tracking?: "complete" | "limited"; atomic?: boolean } | null>(null);
  const [scanPhase, setScanPhase] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // ---- Mode « capture de portefeuille » : relevé éditable + contrôles rejoués en direct ------
  const [header, setHeader] = useState<StatementHeader | null>(null);
  const [positions, setPositions] = useState<ScannedPosition[]>([]);
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [includeCash, setIncludeCash] = useState(true);
  const [acknowledgeChecks, setAcknowledgeChecks] = useState(false);
  const [duplicate, setDuplicate] = useState<DuplicateInfo | null>(null);
  const [forceReanalyse, setForceReanalyse] = useState(false);

  const filePreview = useMemo(() => (file && file.type.startsWith("image/") ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => { if (filePreview) URL.revokeObjectURL(filePreview); }, [filePreview]);

  // Définition de l'image. Ce n'est pas un détail : sur une capture de 620 px de large contenant
  // un tableau de huit colonnes chiffrées, un chiffre ne fait que quelques pixels et se lit mal
  // (« 1 000 » lu « 100 » — constaté). Le serveur agrandit désormais l'image avant l'analyse,
  // mais mieux vaut le dire AVANT que de faire corriger vingt cellules après.
  // La mesure est conservée AVEC l'URL mesurée : changer de document rend donc immédiatement la
  // largeur inconnue, sans avoir à la remettre à zéro dans l'effet (ce qui provoquerait un rendu
  // en cascade et afficherait brièvement la taille du document précédent).
  const [probed, setProbed] = useState<{ src: string; width: number } | null>(null);
  useEffect(() => {
    if (!filePreview) return;
    const probe = new Image();
    probe.onload = () => setProbed({ src: filePreview, width: probe.naturalWidth });
    probe.src = filePreview;
    return () => { probe.onload = null; };
  }, [filePreview]);
  const imageWidth = probed && probed.src === filePreview ? probed.width : null;
  const lowResolution = imageWidth !== null && imageWidth < 1100;

  // ---- ENTRÉE UNIQUE DE FICHIER -------------------------------------------------------------
  // Clic, glisser-déposer et collage aboutissent tous ici. `lastKey` empêche le DOUBLE
  // traitement : certains navigateurs notifient un même contenu deux fois (paste + drop), et
  // deux analyses simultanées de la même capture consommeraient deux fois le service d'IA.
  const lastKey = useRef<string | null>(null);
  const selectFile = useCallback((next: File | null, origin: "picked" | "dropped" | "pasted") => {
    if (!next) return;
    const key = localFileKey(next);
    if (key && key === lastKey.current) return;
    lastKey.current = key;
    setFile(next);
    setFileOrigin(origin);
    setError("");
    setPreview(null); setHeader(null); setPositions([]); setDuplicate(null); setForceReanalyse(false);
  }, []);

  function clearFile() {
    lastKey.current = null;
    setFile(null);
    setPreview(null); setHeader(null); setPositions([]); setDuplicate(null); setError("");
    if (inputRef.current) inputRef.current.value = "";
  }

  // ---- COLLAGE Ctrl+V / Cmd+V ---------------------------------------------------------------
  // L'écouteur n'existe QUE tant que la modale est ouverte et qu'un document peut encore être
  // choisi (étapes 2 et 3), et il est retiré à la fermeture. Il ignore les collages faits dans
  // un champ de saisie : coller une date ne doit pas déclencher l'analyse d'une image restée
  // dans le presse-papiers.
  useEffect(() => {
    if (step > 3 || busy) return;
    function onPaste(event: ClipboardEvent) {
      if (shouldIgnorePaste(event.target)) return;
      const image = imageFileFromClipboard(event.clipboardData);
      if (!image) return;
      event.preventDefault();
      // Une image collée est forcément une capture : on bascule sur le scan IA si nécessaire.
      setMode("ai");
      selectFile(image, "pasted");
      setStep(2);
    }
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [step, busy, selectFile]);

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
      if (forceReanalyse) form.append("force", "true");
      const response = await authenticatedFetch("/api/investment-imports/scan", { method: "POST", body: form });
      const data = (await response.json().catch(() => ({}))) as (PreviewResponse & { error?: string; code?: string });
      if (!response.ok) {
        if (data.code === "duplicate_capture" && data.duplicate) {
          setDuplicate(data.duplicate);
          setError("");
          setBusy(false); return;
        }
        const documentHint = data.document?.institution ? ` Document reconnu : ${data.document.institution}${data.document.period ? ` · période ${data.document.period}` : ""}.` : "";
        setError(`${data.error ?? "Analyse IA impossible."}${documentHint}`);
        setBusy(false); return; // on reste sur l'écran d'analyse : réessai ou changement de fichier
      }
      setPreview(data);
      setDuplicate(data.duplicate ?? null);
      if (data.mode === "statement" && data.statement) {
        setHeader(data.statement.header);
        setPositions(data.statement.positions);
        // Une ligne dont la lecture diverge d'une relecture à l'autre reste décochée : c'est un
        // choix explicite de l'administrateur, jamais une inclusion par défaut.
        setExcluded(new Set(data.statement.positions.filter((position) => position.band === "low").map((position) => position.index)));
        setIncludeCash((data.statement.header.availableCash ?? 0) > 0);
        setSnapshotDate(data.statement.header.snapshotDate ?? "");
        setAcknowledgeChecks(false);
      } else {
        if (data.snapshot?.asOfDate) setSnapshotDate(data.snapshot.asOfDate);
        setRows(data.rows.map((row) => {
          const editable = row as EditableRow;
          return {
            ...editable,
            include: editable.aiBand !== "low" && row.status !== "error" && row.status !== "duplicate_certain",
            createInstrument: data.mode === "snapshot" && !row.instrumentHoldingId,
          };
        }));
      }
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
    setHeader((current) => (current ? { ...current, snapshotDate: next } : current));
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
  function updateSnapshot(index: number, patch: Partial<SnapshotRowMeta>) {
    setRows((current) => current.map((row) => (row.index === index && row.snapshot ? { ...row, snapshot: { ...row.snapshot, ...patch } } : row)));
  }
  function toggleInclude(index: number, include: boolean) {
    setRows((current) => current.map((row) => (row.index === index ? { ...row, include } : row)));
  }
  function toggleCreate(index: number, createInstrument: boolean) {
    setRows((current) => current.map((row) => (row.index === index ? { ...row, createInstrument } : row)));
  }

  // ---- Corrections dans l'écran de validation d'une capture ---------------------------------
  // Le coût historique est RECALCULÉ à chaque correction (valorisation − plus-value), jamais
  // saisi : c'est lui qui deviendra le prix de revient de la position.
  function updatePosition(index: number, patch: Partial<ScannedPosition>) {
    setPositions((current) => current.map((position) => {
      if (position.index !== index) return position;
      const merged = { ...position, ...patch };
      const { costBasis, source } = costBasisOf(merged);
      return { ...merged, costBasis, costBasisSource: source };
    }));
  }
  function updateHeader(patch: Partial<StatementHeader>) {
    setHeader((current) => (current ? { ...current, ...patch } : current));
  }
  function togglePosition(index: number, include: boolean) {
    setExcluded((current) => {
      const next = new Set(current);
      if (include) next.delete(index); else next.add(index);
      return next;
    });
  }

  const isStatement = preview?.mode === "statement" && header !== null;

  /** Relevé courant (corrections comprises) — la même structure que celle envoyée au serveur. */
  const editedStatement: BrokerStatement | null = useMemo(() => (
    header ? { header, positions, warnings: preview?.statement?.warnings ?? [] } : null
  ), [header, positions, preview]);

  /** Contrôles comptables rejoués EN DIRECT avec les mêmes fonctions que le serveur. */
  const liveChecks = useMemo(() => (editedStatement ? runAccountingChecks(editedStatement) : []), [editedStatement]);
  const liveSummary = useMemo(() => summarizeChecks(liveChecks), [liveChecks]);
  const liveOperations = useMemo(() => (
    editedStatement ? buildStatementOperations(editedStatement, { includeCash, excludeIndexes: [...excluded] }) : null
  ), [editedStatement, includeCash, excluded]);
  const failedChecks = liveChecks.filter((entry) => !entry.ok);
  const checksByPosition = useMemo(() => {
    const map = new Map<number, AccountingCheck[]>();
    for (const entry of failedChecks) {
      if (entry.positionIndex === undefined) continue;
      map.set(entry.positionIndex, [...(map.get(entry.positionIndex) ?? []), entry]);
    }
    return map;
  }, [failedChecks]);

  const includedPositions = positions.filter((position) => !excluded.has(position.index));

  const included = useMemo(() => rows.filter((row) => row.include), [rows]);
  const blocking = useMemo(() => included.filter((row) => row.errors.length > 0), [included]);
  const visibleRows = filter === "anomalies" ? rows.filter((row) => row.status !== "valid") : rows;
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

    // ---- Capture de portefeuille : le serveur reconstruit lui-même les opérations ------------
    if (isStatement && editedStatement) {
      try {
        const response = await authenticatedFetch("/api/investment-imports/commit", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({
            accountId: account.id,
            filename: file?.name,
            fileType: file?.type.includes("pdf") ? "pdf" : "image",
            fileFingerprint: preview.capture?.hash ?? preview.captureHash,
            sourceKind: "ai_scan",
            statement: {
              header: editedStatement.header,
              positions: editedStatement.positions.map((position) => ({
                index: position.index, name: position.name, isin: position.isin, ticker: position.ticker,
                quantity: position.quantity, averageCostDisplayed: position.averageCostDisplayed,
                currentPrice: position.currentPrice, dailyChangePercent: position.dailyChangePercent,
                marketValue: position.marketValue, unrealizedGain: position.unrealizedGain,
                unrealizedGainPercent: position.unrealizedGainPercent,
                lastMovementDate: position.lastMovementDate, currency: position.currency,
              })),
            },
            includeCash,
            excludedIndexes: [...excluded],
            acknowledgeChecks: !liveSummary.importable && acknowledgeChecks,
            force: forceReanalyse || Boolean(duplicate),
            replaceExisting,
            replaceConfirm: replaceExisting ? replaceConfirm.trim() : undefined,
          }),
        });
        const data = (await response.json().catch(() => ({}))) as { imported?: number; duplicates?: number; newInstruments?: number; replaced?: number; tracking?: "complete" | "limited"; atomic?: boolean; error?: string; checks?: AccountingCheck[] };
        if (!response.ok) {
          setError(data.error ?? "Import impossible.");
          setBusy(false); return;
        }
        setResult({ imported: data.imported ?? 0, duplicates: data.duplicates ?? 0, newInstruments: data.newInstruments ?? 0, replaced: data.replaced ?? 0, tracking: data.tracking, atomic: data.atomic });
        setStep(6);
        onDone();
      } catch {
        setError("Réseau indisponible.");
      }
      setBusy(false);
      return;
    }

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
      const data = (await response.json().catch(() => ({}))) as { imported?: number; duplicates?: number; newInstruments?: number; replaced?: number; tracking?: "complete" | "limited"; atomic?: boolean; error?: string; invalidLines?: Array<{ line: number; error: string }> };
      if (!response.ok) {
        setError(data.error ?? "Import impossible." + (data.invalidLines?.length ? ` (${data.invalidLines.length} ligne(s) invalide(s))` : ""));
        setBusy(false); return;
      }
      setResult({ imported: data.imported ?? 0, duplicates: data.duplicates ?? 0, newInstruments: data.newInstruments ?? 0, replaced: data.replaced ?? 0, tracking: data.tracking, atomic: data.atomic });
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
    ? ["Compte", "Document", "Analyse", "Validation", "Confirmation", "Terminé"]
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
              <p className="imp-hint">Importez le relevé fourni par votre banque ou votre courtier — capture d’écran, PDF ou export CSV. Le fichier n’est pas conservé&nbsp;; il sert uniquement à préparer ce que vous validerez.</p>

              <fieldset className="imp-mode-choice">
                <legend>Que faire des opérations déjà enregistrées&nbsp;?</legend>
                <label className={replaceExisting ? "" : "active"}>
                  <input type="radio" name="import-write-mode" checked={!replaceExisting} onChange={() => setReplaceExisting(false)} />
                  <span><strong>Ajouter</strong><small>Les opérations du relevé s’ajoutent à l’existant. Les doublons certains sont écartés.</small></span>
                </label>
                <label className={replaceExisting ? "active imp-danger" : "imp-danger"}>
                  <input type="radio" name="import-write-mode" checked={replaceExisting} onChange={() => setReplaceExisting(true)} />
                  <span><strong>Remplacer tout le portefeuille</strong><small>Toutes les opérations actuelles de ce compte sont supprimées et remplacées. Irréversible — une confirmation sera demandée.</small></span>
                </label>
              </fieldset>

              <div className="pea-form-actions">
                <button type="button" className="secondary-button" onClick={onClose}>Annuler</button>
                <button type="button" className="primary-button" onClick={() => setStep(2)}>Continuer</button>
              </div>
            </div>
          )}

          {/* Étape 2 — document (clic, glisser-déposer OU collage) */}
          {step === 2 && (
            <div className="imp-panel">
              <div className="imp-modes" role="tablist" aria-label="Type d'import">
                <button type="button" role="tab" aria-selected={mode === "ai"} className={mode === "ai" ? "active" : ""} onClick={() => { setMode("ai"); clearFile(); }}>✨ Capture ou PDF de relevé</button>
                <button type="button" role="tab" aria-selected={mode === "file"} className={mode === "file" ? "active" : ""} onClick={() => { setMode("file"); clearFile(); }}>📄 Fichier CSV / XLSX</button>
              </div>

              {file ? (
                // Aperçu immédiat : l'administrateur voit CE QU'IL A DÉPOSÉ avant toute analyse.
                <div className="imp-picked">
                  {filePreview
                    // eslint-disable-next-line @next/next/no-img-element -- aperçu local (blob:), jamais téléversé ni optimisable
                    ? <img className="imp-thumb" src={filePreview} alt={`Aperçu de ${file.name}`} />
                    : <span className="imp-drop-icon" aria-hidden="true">📄</span>}
                  <div className="imp-picked-info">
                    <strong>{fileOrigin === "pasted" ? "Image collée" : file.name}</strong>
                    <small>{Math.max(1, Math.round(file.size / 1024))} Ko{imageWidth ? ` · ${imageWidth} px de large` : ""}{fileOrigin === "pasted" ? ` · ${file.name}` : ""}</small>
                    <span className="imp-picked-state">{busy ? "Analyse en cours…" : "Prêt à être analysé"}</span>
                  </div>
                  <div className="imp-picked-actions">
                    <button type="button" className="secondary-button" onClick={() => inputRef.current?.click()}>Remplacer</button>
                    <button type="button" className="btc-link" onClick={clearFile}>Supprimer</button>
                  </div>
                </div>
              ) : (
                <div
                  className="imp-drop"
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => { event.preventDefault(); selectFile(event.dataTransfer.files?.[0] ?? null, "dropped"); }}
                  onClick={() => inputRef.current?.click()}
                  role="button" tabIndex={0}
                  onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") inputRef.current?.click(); }}
                >
                  <span className="imp-drop-icon" aria-hidden="true">{mode === "ai" ? "🧾" : "📄"}</span>
                  <strong>{mode === "ai" ? "Déposez, sélectionnez ou collez une capture avec Ctrl+V" : "Glissez un fichier CSV ou Excel ici, ou cliquez pour choisir"}</strong>
                  <small>{mode === "ai" ? "PNG, JPG, JPEG, WEBP ou PDF. Sur Mac : Cmd+V. Une capture d’écran copiée fonctionne directement." : "Formats acceptés : CSV, XLS ou XLSX. Taille max 2 Mo."}</small>
                </div>
              )}
              <input ref={inputRef} type="file"
                accept={mode === "ai" ? ".pdf,.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp,application/pdf" : ".csv,.txt,.xls,.xlsx,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}
                hidden onChange={(event) => selectFile(event.target.files?.[0] ?? null, "picked")} />

              {duplicate && (
                <div className="imp-danger-box" role="alert">
                  <strong>⚠ Cette capture semble déjà avoir été intégrée</strong>
                  <p>
                    Un import du même fichier a été enregistré{duplicate.importedAt ? ` le ${new Date(duplicate.importedAt).toLocaleDateString("fr-FR")}` : ""}
                    {duplicate.filename ? ` (« ${duplicate.filename} »)` : ""} : {duplicate.importedRows} opération(s). Le réimporter dupliquerait les positions.
                  </p>
                  <div className="imp-picked-actions">
                    <button type="button" className="secondary-button" onClick={clearFile}>Choisir un autre document</button>
                    <button type="button" className="btc-link" onClick={() => { setForceReanalyse(true); setDuplicate(null); }}>Analyser quand même</button>
                  </div>
                </div>
              )}

              {mode === "ai" && lowResolution && (
                <p className="imp-ai-banner imp-check-ko" role="note">
                  ⚠ Cette image ne fait que <b>{imageWidth} px</b> de large. Sur un tableau de bourse, chaque chiffre
                  n’occupe alors que quelques pixels et se lit mal — un «&nbsp;1&nbsp;000&nbsp;» devient «&nbsp;100&nbsp;».
                  Elle sera agrandie avant l’analyse, mais une capture en <b>pleine résolution</b> reste bien plus sûre.
                  Vérifiez chaque ligne à l’écran de validation.
                </p>
              )}
              {mode === "ai" && (
                <div className="imp-scan-kinds">
                  <span><b>Deux types de relevés</b> sont reconnus, sans réglage&nbsp;:</span>
                  <span>🧾 <b>Vos positions</b> — le tableau «&nbsp;Valeur / Quantité / Px. Revient / Cours / Montant&nbsp;». Il décrit le portefeuille à une date&nbsp;: les positions sont reprises comme solde initial.</span>
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
                <p className="imp-hint">La lecture est faite côté serveur, puis <b>revérifiée par le code</b> (totaux, quantité × cours, clé ISIN). Rien n’est enregistré sans votre validation. Le fichier n’est pas conservé. L’écriture manuscrite, les photos floues ou les relevés protégés ne sont pas garantis — préférez alors le CSV ou la saisie manuelle.</p>
              )}
              <div className="pea-form-actions">
                <button type="button" className="secondary-button" onClick={() => setStep(1)}>Retour</button>
                <button type="button" className="primary-button" disabled={!file || busy || Boolean(duplicate)} onClick={() => (mode === "ai" ? runScan() : runPreview())}>{busy ? "Analyse…" : mode === "ai" ? "Analyser le relevé" : "Analyser le fichier"}</button>
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
                  <figcaption>{fileOrigin === "pasted" ? "Image collée" : file?.name}</figcaption>
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

              {!busy && duplicate && (
                <div className="imp-danger-box" role="alert">
                  <strong>⚠ Cette capture semble déjà avoir été intégrée</strong>
                  <p>Un import du même fichier existe déjà{duplicate.importedAt ? ` (${new Date(duplicate.importedAt).toLocaleDateString("fr-FR")})` : ""} : {duplicate.importedRows} opération(s).</p>
                  <div className="imp-picked-actions">
                    <button type="button" className="secondary-button" onClick={() => { setDuplicate(null); clearFile(); setStep(2); }}>Choisir un autre document</button>
                    <button type="button" className="primary-button" onClick={() => { setForceReanalyse(true); setDuplicate(null); void runScan(); }}>Forcer une nouvelle analyse</button>
                  </div>
                </div>
              )}

              {!busy && error && (
                <div className="imp-danger-box">
                  <strong>⚠ L’analyse n’a rien pu retranscrire</strong>
                  <p>{error}</p>
                  <p>Ce qui aide le plus&nbsp;: une capture <b>nette</b> et <b>entière</b> du tableau (colonnes et en-têtes visibles), sans recadrage partiel. Un export CSV du même relevé reste la voie la plus fiable.</p>
                </div>
              )}

              <div className="pea-form-actions">
                <button type="button" className="secondary-button" disabled={busy} onClick={() => { setError(""); setDuplicate(null); setStep(2); }}>Changer de document</button>
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

          {/* Étape 4 (capture reconnue) — écran de VALIDATION en deux parties */}
          {step === 4 && isStatement && header && (
            <div className="imp-panel imp-verify">
              <header className="imp-verify-head">
                <h3>
                  {preview?.broker?.recognised ? `✓ Capture ${preview.broker.label} reconnue` : "Capture de relevé analysée"}
                </h3>
                <p className="imp-verify-identity">
                  <strong>{header.accountName ?? account.name}</strong>
                  {header.accountNumberMasked ? <span> · {header.accountNumberMasked}</span> : null}
                  {header.managementMode ? <span> · {header.managementMode}</span> : null}
                  {header.snapshotDate ? <span> · arrêté au {header.snapshotDate}</span> : null}
                </p>
                <p className="imp-verify-counts">
                  <span>{positions.length} position{positions.length > 1 ? "s" : ""} détectée{positions.length > 1 ? "s" : ""}</span>
                  <span className={liveSummary.importable ? "imp-check-ok" : "imp-check-ko"}>
                    {liveSummary.importable
                      ? `Contrôles comptables réussis (${liveSummary.passed}/${liveSummary.total})`
                      : `${liveSummary.failed} contrôle(s) comptable(s) en échec`}
                  </span>
                </p>
                {!preview?.broker?.recognised && (
                  <p className="imp-ai-banner" role="note">
                    Le courtier n’a pas été identifié à partir des intitulés lus. La lecture reste utilisable, mais les
                    contrôles propres à un relevé connu ne s’appliquent pas : vérifiez chaque ligne.
                  </p>
                )}
              </header>

              <div className="imp-verify-split">
                {/* Partie gauche : la capture, sous les yeux pendant la vérification. */}
                <figure className="imp-verify-doc">
                  {filePreview
                    // eslint-disable-next-line @next/next/no-img-element -- aperçu local (blob:), jamais téléversé
                    ? <img src={filePreview} alt="Capture d’origine" />
                    : <span aria-hidden="true">📄</span>}
                  <figcaption>
                    {fileOrigin === "pasted" ? "Image collée" : file?.name}
                    {preview?.capture?.preprocessed && (
                      <small>Préparée avant lecture : {preview.capture.preprocessing.join(" · ")}.</small>
                    )}
                    {preview?.reading && preview.reading.passes > 1 && (
                      <small>
                        {preview.reading.disputedCells === 0
                          ? `${preview.reading.passes} relectures indépendantes, chiffres identiques.`
                          : `${preview.reading.passes} relectures : ${preview.reading.disputedCells} valeur(s) lues différemment (signalées ci-contre).`}
                        {preview.capture?.targetedPass ? " Une relecture ciblée sur le tableau a été ajoutée." : ""}
                      </small>
                    )}
                    {preview?.schema && !preview.schema.strict && (
                      <small className="imp-warn">Le modèle n’a pas respecté strictement le format demandé ({preview.schema.issues[0] ?? "clé inattendue"}). Les valeurs ont été récupérées, vérifiez-les.</small>
                    )}
                  </figcaption>
                </figure>

                {/* Partie droite : les données reconnues, modifiables. */}
                <div className="imp-verify-data">
                  {failedChecks.length > 0 && (
                    <div className="imp-danger-box" role="alert">
                      <strong>⚠ {failedChecks.length} contrôle(s) comptable(s) en échec</strong>
                      <ul className="imp-check-list">
                        {failedChecks.slice(0, 6).map((entry) => (
                          <li key={entry.id} className={entry.severity === "blocking" ? "imp-err" : "imp-warn"}>
                            <b>{entry.label}</b> — {entry.message}
                            {entry.delta !== null && <> Écart&nbsp;: {decimal.format(entry.delta)}.</>}
                          </li>
                        ))}
                      </ul>
                      <p className="imp-hint">Corrigez la valeur signalée ci-dessous : les contrôles sont recalculés immédiatement.</p>
                    </div>
                  )}
                  {(preview?.statement?.warnings ?? []).length > 0 && (
                    <ul className="imp-check-list imp-warn">
                      {(preview?.statement?.warnings ?? []).map((warning) => <li key={warning}>{warning}</li>)}
                    </ul>
                  )}

                  {/* Données globales du compte, corrigeables. */}
                  <div className="imp-verify-grid">
                    <label><span>Date du relevé</span>
                      <input type="date" value={snapshotDate} max={new Date().toISOString().slice(0, 10)} onChange={(event) => updateSnapshotDate(event.target.value)} />
                    </label>
                    <label><span>Total portefeuille</span>
                      <input type="number" step="0.01" value={header.totalPortfolio ?? ""} onChange={(event) => updateHeader({ totalPortfolio: event.target.value === "" ? null : Number(event.target.value) })} />
                    </label>
                    <label><span>Évaluation titres</span>
                      <input type="number" step="0.01" value={header.securitiesValue ?? ""} onChange={(event) => updateHeader({ securitiesValue: event.target.value === "" ? null : Number(event.target.value) })} />
                    </label>
                    <label><span>Solde espèces</span>
                      <input type="number" step="0.01" value={header.availableCash ?? ""} onChange={(event) => updateHeader({ availableCash: event.target.value === "" ? null : Number(event.target.value) })} />
                    </label>
                    <label><span>+/- values latentes</span>
                      <input type="number" step="0.01" value={header.unrealizedGain ?? ""} onChange={(event) => updateHeader({ unrealizedGain: event.target.value === "" ? null : Number(event.target.value) })} />
                    </label>
                    <label><span>+/- values (%)</span>
                      <input type="number" step="0.01" value={header.unrealizedGainPercent ?? ""} onChange={(event) => updateHeader({ unrealizedGainPercent: event.target.value === "" ? null : Number(event.target.value) })} />
                    </label>
                    <label><span>Cumul des versements</span>
                      <input type="number" step="0.01" value={header.cumulativeDeposits ?? ""} onChange={(event) => updateHeader({ cumulativeDeposits: event.target.value === "" ? null : Number(event.target.value) })} />
                    </label>
                    <label><span>Date d’ouverture</span>
                      <input type="date" value={header.openingDate ?? ""} onChange={(event) => updateHeader({ openingDate: event.target.value || null })} />
                    </label>
                  </div>

                  {/* Rapprochement avec ce qui est déjà enregistré. */}
                  {preview?.reconciliation && (
                    <div className="imp-summary">
                      <span><b>{preview.reconciliation.newPositions}</b> position(s) nouvelle(s)</span>
                      <span><b>{preview.reconciliation.existingPositions}</b> déjà connue(s)</span>
                      <span className={preview.reconciliation.possibleDuplicates > 0 ? "imp-dup" : ""}>
                        <b>{preview.reconciliation.possibleDuplicates}</b> doublon(s) possible(s)
                      </span>
                      {preview.reconciliation.accountHasOperations && <span className="imp-warn">Ce compte contient déjà des opérations</span>}
                    </div>
                  )}

                  <div className="responsive-table imp-table-wrap">
                    <table className="btc-table imp-table">
                      <thead>
                        <tr>
                          <th>Valeur</th><th>Qté</th><th>Px. revient</th><th>Cours</th><th>Valorisation</th>
                          <th>+/- latentes</th><th>+/- %</th><th>Coût historique</th><th>Dernier mvt</th><th>Reprendre</th>
                        </tr>
                      </thead>
                      <tbody>
                        {positions.map((position) => {
                          const issues = checksByPosition.get(position.index) ?? [];
                          const bad = (field: string) => issues.some((entry) => entry.field === field);
                          // Indicateur de confiance affiché SEULEMENT s'il apporte quelque chose :
                          // une lecture unanime et un contrôle qui tombe juste ne méritent aucun badge.
                          const showBand = position.band !== "high" || issues.length > 0 || position.warnings.length > 0;
                          return (
                            <tr key={position.index} className={excluded.has(position.index) ? "imp-excluded" : ""}>
                              <td>
                                <input className="imp-cell" value={position.name ?? ""} aria-label={`Nom ligne ${position.index}`}
                                  onChange={(event) => updatePosition(position.index, { name: event.target.value || null })} />
                                <input className={`imp-cell imp-isin${bad("isin") ? " imp-cell-warn" : ""}`} value={position.isin ?? ""} aria-label={`ISIN ligne ${position.index}`}
                                  onChange={(event) => updatePosition(position.index, { isin: event.target.value.toUpperCase() || null })} />
                                {position.holdingId
                                  ? <small className="imp-msg imp-ok">reconnu ({position.matchedBy})</small>
                                  : <small className="imp-msg">nouvel instrument — il sera créé</small>}
                                {position.heldQuantity > 0 && <small className="imp-msg imp-warn">déjà {decimal.format(position.heldQuantity)} en portefeuille</small>}
                                {position.alreadyImported && <small className="imp-msg imp-dup">déjà importée à cette date</small>}
                                {showBand && (
                                  <small className={`imp-badge imp-conf-${position.band}`} title={position.sourceText ?? undefined}>
                                    {position.band === "high" ? "Lecture concordante" : position.band === "medium" ? "Écarts mineurs" : "Lecture divergente"}
                                  </small>
                                )}
                                {position.warnings.map((warning) => <small key={warning} className="imp-msg imp-warn">{warning}</small>)}
                                {issues.map((entry) => <small key={entry.id} className={`imp-msg ${entry.severity === "blocking" ? "imp-err" : "imp-warn"}`}>{entry.message}</small>)}
                              </td>
                              <td className="num">
                                <input className={`imp-cell num${bad("quantity") ? " imp-cell-warn" : ""}`} type="number" step="any" value={position.quantity ?? ""}
                                  aria-label={`Quantité ligne ${position.index}`}
                                  onChange={(event) => updatePosition(position.index, { quantity: event.target.value === "" ? null : Number(event.target.value) })} />
                              </td>
                              <td className="num">
                                <input className="imp-cell num" type="number" step="any" value={position.averageCostDisplayed ?? ""}
                                  aria-label={`Prix de revient affiché ligne ${position.index}`}
                                  onChange={(event) => updatePosition(position.index, { averageCostDisplayed: event.target.value === "" ? null : Number(event.target.value) })} />
                              </td>
                              <td className="num">
                                <input className="imp-cell num" type="number" step="any" value={position.currentPrice ?? ""}
                                  aria-label={`Cours ligne ${position.index}`}
                                  onChange={(event) => updatePosition(position.index, { currentPrice: event.target.value === "" ? null : Number(event.target.value) })} />
                                <small className="imp-msg">{position.dailyChangePercent === null ? "" : `veille ${position.dailyChangePercent} %`}</small>
                              </td>
                              <td className="num">
                                <input className={`imp-cell num${bad("marketValue") ? " imp-cell-warn" : ""}`} type="number" step="any" value={position.marketValue ?? ""}
                                  aria-label={`Valorisation ligne ${position.index}`}
                                  onChange={(event) => updatePosition(position.index, { marketValue: event.target.value === "" ? null : Number(event.target.value) })} />
                              </td>
                              <td className="num">
                                <input className={`imp-cell num${bad("unrealizedGain") ? " imp-cell-warn" : ""}`} type="number" step="any" value={position.unrealizedGain ?? ""}
                                  aria-label={`Plus ou moins-value ligne ${position.index}`}
                                  onChange={(event) => updatePosition(position.index, { unrealizedGain: event.target.value === "" ? null : Number(event.target.value) })} />
                              </td>
                              <td className="num">
                                <input className={`imp-cell num${bad("unrealizedGainPercent") ? " imp-cell-warn" : ""}`} type="number" step="any" value={position.unrealizedGainPercent ?? ""}
                                  aria-label={`Performance latente ligne ${position.index}`}
                                  onChange={(event) => updatePosition(position.index, { unrealizedGainPercent: event.target.value === "" ? null : Number(event.target.value) })} />
                              </td>
                              {/* Coût historique : CALCULÉ (valorisation − plus-value), jamais saisi. */}
                              <td className="num imp-cost">
                                <b>{money(position.costBasis)}</b>
                                <small className="imp-msg">{position.costBasisSource === "gain" ? "valorisation − +/- value" : position.costBasisSource === "average_cost" ? "qté × px de revient affiché" : "non calculable"}</small>
                              </td>
                              <td>
                                <input className="imp-cell" type="date" value={position.lastMovementDate ?? ""}
                                  aria-label={`Dernier mouvement ligne ${position.index}`}
                                  onChange={(event) => updatePosition(position.index, { lastMovementDate: event.target.value || null })} />
                              </td>
                              <td>
                                <input type="checkbox" checked={!excluded.has(position.index)}
                                  aria-label={`Reprendre la ligne ${position.index}`}
                                  onChange={(event) => togglePosition(position.index, event.target.checked)} />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  <div className="imp-kpis">
                    <div><span>Positions reprises</span><strong>{includedPositions.length}<small> / {positions.length}</small></strong></div>
                    <div><span>Coût historique total</span><strong>{money(liveOperations?.totalCostBasis ?? null)}</strong></div>
                    <div><span>Valorisation du relevé</span><strong>{money(includedPositions.reduce((total, position) => total + (position.marketValue ?? 0), 0))}</strong></div>
                    <div><span>Espèces reprises</span><strong>{money(liveOperations?.cashRecorded ?? null)}</strong></div>
                  </div>

                  <label className="imp-inline">
                    <input type="checkbox" checked={includeCash} onChange={(event) => setIncludeCash(event.target.checked)} />
                    Reprendre le solde espèces du relevé ({money(header.availableCash)}) comme versement de reprise
                  </label>
                  {(liveOperations?.notImported ?? []).length > 0 && (
                    <details className="imp-doc-compare">
                      <summary>Informations du relevé conservées mais NON importées ({liveOperations?.notImported.length})</summary>
                      <ul className="imp-check-list">
                        {liveOperations?.notImported.map((entry) => (
                          <li key={entry.label}><b>{entry.label}</b> : {money(entry.value)} — {entry.reason}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              </div>

              <div className="pea-form-actions">
                <button type="button" className="secondary-button" onClick={() => setStep(2)}>Changer de document</button>
                <button type="button" className="primary-button" disabled={includedPositions.length === 0} onClick={() => setStep(5)}>
                  Continuer ({includedPositions.length})
                </button>
              </div>
            </div>
          )}

          {/* Étape 4 — prévisualisation + correction (CSV / XLSX / relevé de mouvements) */}
          {step === 4 && !isStatement && preview && summary && (
            <div className="imp-panel">
              {mode === "ai" && (
                <>
                  <p className="imp-ai-banner" role="note">
                    ✨ {isSnapshot ? "Relevé de POSITIONS retranscrit" : "Relevé de MOUVEMENTS retranscrit"}{preview.provider ? ` (${preview.provider})` : ""} — {summary.total} ligne(s).
                    Rien n’est encore enregistré : corrigez ce qui doit l’être, décochez le reste.
                  </p>

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
          {step === 5 && (isStatement ? header !== null : Boolean(summary)) && (
            <div className="imp-panel">
              {isStatement && header ? (
                <div className="imp-confirm">
                  <p><b>{includedPositions.length}</b> position(s) seront reprises pour un coût historique total de <b>{money(liveOperations?.totalCostBasis ?? null)}</b>.</p>
                  <p>{positions.length - includedPositions.length} ligne(s) seront ignorées.</p>
                  {/* Ce que le moteur va réellement écrire : dit explicitement, sans euphémisme. */}
                  <p>
                    Chaque position devient une <b>opération de reprise</b> (type «&nbsp;correction&nbsp;») datée du
                    {" "}<b>{header.snapshotDate}</b>, portant sa quantité et son coût historique — <b>pas un achat</b>.
                    La date «&nbsp;Dernier Mvt&nbsp;» est conservée en note, elle ne sert pas de date d’opération.
                  </p>
                  {liveOperations?.cashRecorded !== null && liveOperations?.cashRecorded !== undefined && (
                    <p>Le solde espèces de <b>{money(liveOperations.cashRecorded)}</b> est repris comme versement de reprise à la même date.</p>
                  )}
                  <p className="imp-hint">
                    Le portefeuille (positions, prix de revient, performance) reste <b>calculé</b> à partir des opérations :
                    aucune position n’est stockée telle quelle.
                  </p>
                  {!liveSummary.importable && (
                    <div className="imp-danger-box">
                      <strong>⚠ {liveSummary.blockingFailures} contrôle(s) comptable(s) bloquant(s) en échec</strong>
                      <p>L’arithmétique du relevé ne tombe pas juste : une valeur a probablement été mal lue. Revenez la corriger, ou assumez explicitement l’import.</p>
                      <label className="imp-inline">
                        <input type="checkbox" checked={acknowledgeChecks} onChange={(event) => setAcknowledgeChecks(event.target.checked)} />
                        J’ai vérifié le relevé et je confirme l’import malgré les contrôles en échec
                      </label>
                    </div>
                  )}
                </div>
              ) : (
                <div className="imp-confirm">
                  <p><b>{included.length}</b> {isSnapshot ? "position(s)" : "opération(s)"} seront importées{isSnapshot ? ` pour une valorisation de ${euro.format(includedValuation)}` : ""}.</p>
                  <p>{rows.length - included.length} ligne(s) seront ignorées.</p>
                  <p>{summary?.duplicatesCertain ?? 0} doublon(s) certain(s) exclus.</p>
                  <p>{included.filter((r) => r.createInstrument && !r.instrumentHoldingId).length} nouvel(s) instrument(s) seront créés{isSnapshot ? " avec le cours du relevé" : " sans cours de marché"}.</p>
                  {isSnapshot && <p>Les positions sont enregistrées comme <b>solde initial au {snapshotDate || preview?.snapshot?.asOfDate}</b>, pas comme des achats : la performance ne sera calculée qu’à partir de cette date.</p>}
                </div>
              )}
              {replaceExisting && (
                <div className="imp-danger-box" role="group" aria-labelledby="imp-replace-title">
                  <strong id="imp-replace-title">⚠ Remplacement du portefeuille</strong>
                  <p>Toutes les opérations actuellement enregistrées sur <b>{account.name}</b> seront <b>définitivement supprimées</b> et remplacées par celles de ce relevé. Cette action est irréversible.</p>
                  <label className="pea-field pea-field-wide">
                    <span>Saisissez le nom exact du compte pour confirmer</span>
                    <input value={replaceConfirm} onChange={(event) => setReplaceConfirm(event.target.value)} placeholder={account.name} autoComplete="off" />
                  </label>
                </div>
              )}
              <p className="imp-hint">L’enregistrement est revalidé côté serveur (contrôles comptables compris) et écrit d’un seul bloc. En cas d’erreur, aucun import partiel n’est créé{replaceExisting ? " — et les opérations existantes ne sont supprimées qu’après une insertion réussie" : ""}.</p>
              <div className="pea-form-actions">
                <button type="button" className="secondary-button" onClick={() => setStep(4)}>Retour</button>
                <button type="button" className={replaceExisting ? "danger-button" : "primary-button"}
                  disabled={busy
                    || (replaceExisting && replaceConfirm.trim() !== account.name.trim())
                    || (isStatement && !liveSummary.importable && !acknowledgeChecks)}
                  onClick={commit}>
                  {busy ? "Import…" : replaceExisting ? "Remplacer le portefeuille" : isStatement ? "Valider et intégrer le portefeuille" : "Confirmer l'import"}
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
              <p className="imp-hint">Les cours issus d’un relevé peuvent être périmés&nbsp;: depuis l’onglet «&nbsp;Mes positions&nbsp;», utilisez <b>Actualiser les cours</b> pour les relire auprès d’un fournisseur de marché.</p>
              {result.atomic === false && <p className="imp-hint">Écriture séquentielle&nbsp;: la migration <code>20260808_import_capture_commit.sql</code> n’est pas encore appliquée. L’import a réussi, mais il n’a pas bénéficié de l’écriture transactionnelle.</p>}
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
