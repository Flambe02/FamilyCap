// Analyse IA du portefeuille — l'IA RÉSUME, elle ne calcule pas et n'invente pas.
//
// Le principe qui structure ce fichier : le modèle ne reçoit JAMAIS d'opérations brutes avec la
// consigne « analyse ». Il reçoit un objet déterministe, calculé côté serveur, dont chaque nombre
// a déjà été vérifié par les moteurs existants. Sa seule liberté est la formulation.
//
// Et cette liberté est vérifiée après coup : `validateObservations` refuse toute observation qui
// cite un chiffre absent de l'objet source, qui nomme un actif absent du portefeuille, ou qui
// formule un ordre d'achat/vente ou une promesse de performance. Une observation refusée n'est
// pas corrigée : elle est jetée. Il vaut mieux deux observations justes que trois dont une inventée.
//
// Module PUR, testé dans tests/portfolio-insights.test.mjs.

export type InsightTone = "positive" | "risk" | "action";

export type PortfolioFacts = {
  generatedAt: string;
  accountType: "PEA" | "CTO";
  accountLabel: string;
  referenceCurrency: string;
  totalValueEur: number | null;
  positionsValueEur: number | null;
  cashEur: number;
  netInvestedEur: number;
  positionsCount: number;
  performance: {
    unrealizedGainEur: number | null;
    unrealizedGainPct: number | null;
    realizedGainEur: number;
    dividendsNetEur: number;
    feesEur: number;
    totalReturnEur: number | null;
    totalReturnPct: number | null;
    annualizedPct: number | null;
    twrPct: number | null;
    xirrPct: number | null;
    isReliable: boolean;
    unreliableReason: string | null;
  };
  coverage: {
    pricedPositions: number;
    totalPositions: number;
    pricePercent: number;
    geographyPercent: number;
    sectorPercent: number;
    dividendPercent: number;
    costBasisPercent: number;
    sufficient: boolean;
  };
  concentration: { top1Pct: number | null; top3Pct: number | null; top5Pct: number | null };
  best: Array<{ name: string; gainPct: number | null; gainEur: number | null; valueEur: number | null }>;
  worst: Array<{ name: string; gainPct: number | null; gainEur: number | null; valueEur: number | null }>;
  geography: Array<{ label: string; pct: number; isEstimated: boolean }>;
  sectors: Array<{ label: string; pct: number; isEstimated: boolean }>;
  dividends: {
    receivedThisYearEur: number;
    expected12mEur: number;
    portfolioYieldPct: number | null;
    topContributorName: string | null;
    topContributorPct: number | null;
    monthsWithoutIncome: number;
    hasRealOperations: boolean;
  };
  benchmark: { label: string; portfolioPct: number | null; benchmarkPct: number | null; gapPct: number | null } | null;
  anomalies: string[];
};

export type Observation = {
  tone: InsightTone;
  title: string;
  body: string;
  /** Le chiffre qui justifie l'observation, tel qu'il doit apparaître dans le texte. */
  metric: string;
};

export type PortfolioAnalysis = {
  observations: Observation[];
  generatedAt: string;
  factsHash: string;
  coverageLabel: string;
  disclaimer: string;
};

export const DISCLAIMER = "Information pédagogique, pas un conseil financier.";
/** En deçà, l'analyse doit annoncer sa propre incomplétude au lieu de conclure. */
export const MINIMUM_COVERAGE_PERCENT = 80;

// ==========================================================================================
// EMPREINTE — évite de rappeler le modèle quand rien n'a changé
// ==========================================================================================
/** FNV-1a 32 bits, la même famille de hachage que l'empreinte d'import (lib/investment-import). */
export function factsHash(facts: PortfolioFacts): string {
  // `generatedAt` est retiré : sinon l'empreinte changerait à chaque seconde et le cache ne
  // servirait à rien. Seul le CONTENU financier décide d'une régénération.
  const payload = JSON.stringify(facts, (key, value) => (key === "generatedAt" ? undefined : value));
  let hash = 0x811c9dc5;
  for (let index = 0; index < payload.length; index += 1) {
    hash ^= payload.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// ==========================================================================================
// GARDE-FOU — l'IA ne peut citer que ce qu'on lui a donné
// ==========================================================================================
const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\b(achet\w*|vend\w*|revend\w*|arbitr\w*|allég\w*|renforc\w*|souscri\w*|cède\w*|céder)\b/i, reason: "ordre d'achat ou de vente" },
  { pattern: /\b(devrait (monter|baisser|progresser)|va (monter|baisser|progresser)|rendement garanti|performance garantie|assuré de)\b/i, reason: "promesse de performance" },
  { pattern: /\b(je recommande|nous recommandons|conseil(lons|le)?\s+d[e'])\b/i, reason: "conseil personnalisé" },
];

/** Nombres extraits d'un texte français (« 58 % », « 219 573 € », « +29,6 % », « 1,02 »). */
// L'alternance compte : un separateur de milliers n'est reconnu QUE devant un groupe de trois
// chiffres. Une expression plus permissive avalait l'espace entre deux nombres voisins — « Point 1 »
// suivi de « 58 % » donnait 158, un nombre absent des donnees, et l'observation etait rejetee pour
// un motif entierement fabrique par l'analyseur lui-meme.
const NUMBER_PATTERN = /-?\d{1,3}(?:[\s  ]\d{3})+(?:[.,]\d+)?|-?\d+(?:[.,]\d+)?/g;

export function extractNumbers(text: string): number[] {
  const matches = text.match(NUMBER_PATTERN) ?? [];
  return matches
    .map((raw) => Number(raw.replace(/[\s  ]/g, "").replace(",", ".")))
    .filter((value) => Number.isFinite(value));
}

function collectNumbers(value: unknown, into: Set<number>) {
  if (typeof value === "number" && Number.isFinite(value)) {
    into.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectNumbers(item, into);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) collectNumbers(item, into);
  }
}

/**
 * Tous les nombres que le modèle a le droit de citer : ceux de l'objet source, plus leurs
 * arrondis usuels (0, 1 et 2 décimales) et leur valeur absolue — parce qu'écrire « −12,4 % » ou
 * « une baisse de 12,4 % » désigne le même chiffre.
 */
export function allowedNumbers(facts: PortfolioFacts): Set<number> {
  const raw = new Set<number>();
  collectNumbers(facts, raw);
  const allowed = new Set<number>();
  for (const value of raw) {
    for (const candidate of [value, Math.abs(value)]) {
      allowed.add(candidate);
      allowed.add(Number(candidate.toFixed(0)));
      allowed.add(Number(candidate.toFixed(1)));
      allowed.add(Number(candidate.toFixed(2)));
      allowed.add(Math.round(candidate));
    }
  }
  // Les petits entiers servent d'énumération (« 3 positions », « les 3 premières lignes ») et non
  // de mesure : les interdire produirait des refus absurdes.
  for (let small = 0; small <= 12; small += 1) allowed.add(small);
  return allowed;
}

function isAllowed(value: number, allowed: Set<number>): boolean {
  if (allowed.has(value)) return true;
  // Tolérance d'arrondi : 0,05 en absolu ou 0,5 % en relatif, pour accepter « 29,6 % » quand la
  // valeur exacte est 29,58 — sans laisser passer un chiffre franchement différent.
  for (const candidate of allowed) {
    if (Math.abs(candidate - value) <= 0.05) return true;
    if (candidate !== 0 && Math.abs((candidate - value) / candidate) <= 0.005) return true;
  }
  return false;
}

export type ValidationResult = {
  accepted: Observation[];
  rejected: Array<{ observation: Observation; reason: string }>;
};

/**
 * Filtre les observations produites par le modèle. Trois refus possibles :
 *   - un chiffre absent de l'objet source (le motif le plus important : c'est la définition même
 *     d'une hallucination chiffrée) ;
 *   - un nom d'actif absent du portefeuille ;
 *   - une formulation interdite (ordre, promesse, conseil personnalisé).
 */
export function validateObservations(observations: Observation[], facts: PortfolioFacts): ValidationResult {
  const allowed = allowedNumbers(facts);
  const knownNames = new Set(
    [...facts.best, ...facts.worst]
      .map((item) => item.name.toLowerCase())
      .concat(facts.geography.map((item) => item.label.toLowerCase()))
      .concat(facts.sectors.map((item) => item.label.toLowerCase()))
      .concat(facts.dividends.topContributorName ? [facts.dividends.topContributorName.toLowerCase()] : []),
  );
  const accepted: Observation[] = [];
  const rejected: ValidationResult["rejected"] = [];

  for (const observation of observations) {
    const text = `${observation.title} ${observation.body}`;
    const forbidden = FORBIDDEN_PATTERNS.find((rule) => rule.pattern.test(text));
    if (forbidden) {
      rejected.push({ observation, reason: forbidden.reason });
      continue;
    }
    const numbers = extractNumbers(text);
    const invalid = numbers.find((value) => !isAllowed(value, allowed));
    if (invalid !== undefined) {
      rejected.push({ observation, reason: `chiffre absent des données source (${invalid})` });
      continue;
    }
    if (numbers.length === 0) {
      rejected.push({ observation, reason: "aucun chiffre cité" });
      continue;
    }
    // Un nom d'actif inventé : on repère les mots capitalisés qui ressemblent à un titre et qui ne
    // figurent nulle part dans l'objet source. Volontairement limité aux séquences en majuscules
    // ou capitalisées de 3 caractères et plus, pour ne pas rejeter la ponctuation d'une phrase.
    const quoted = observation.body.match(/\b[A-ZÉÈÀÂÎÔÛ][\wÉÈÀÂÎÔÛéèàâîôûç'’-]{2,}(?:\s+[A-ZÉÈÀÂÎÔÛ][\wÉÈÀÂÎÔÛéèàâîôûç'’-]{2,})?/g) ?? [];
    const invented = quoted.find((candidate) => {
      const lower = candidate.toLowerCase();
      if (STOP_WORDS.has(lower)) return false;
      // Un code devise n'est pas un actif. Sans cette exception, « 28 416 EUR de plus-value »
      // était rejeté comme un titre inventé — un refus produit par l'analyseur, pas par le modèle.
      if (CURRENCY_CODES.has(candidate.toUpperCase())) return false;
      if (knownNames.has(lower)) return false;
      return [...knownNames].every((name) => !name.includes(lower) && !lower.includes(name));
    });
    if (invented) {
      rejected.push({ observation, reason: `actif ou zone non présent dans les données source (${invented})` });
      continue;
    }
    accepted.push(observation);
  }
  return { accepted: accepted.slice(0, 3), rejected };
}

/** Codes devise pouvant apparaître dans un montant. Ce ne sont pas des noms d'actifs. */
const CURRENCY_CODES = new Set(["EUR", "USD", "GBP", "CHF", "JPY", "SEK", "DKK", "NOK", "CAD", "AUD"]);

// Mots capitalisés courants en début de phrase : ils ne désignent aucun actif.
const STOP_WORDS = new Set([
  "le", "la", "les", "un", "une", "des", "ce", "cette", "ces", "votre", "vos", "votre compte", "cela",
  "cette concentration", "cette part", "les dividendes", "la performance", "le portefeuille", "le compte",
  "aucune", "aucun", "sur", "avec", "dans", "pour", "depuis", "plus", "moins", "chaque", "toutes", "tous",
  "vérifiez", "attention", "note", "remarque", "couverture", "analyse", "partielle", "positions", "position",
  "dividendes", "performance", "portefeuille", "compte", "actifs", "actif", "valeur", "total", "part",
]);

/**
 * Repli entièrement déterministe, utilisé quand aucun fournisseur d'IA n'est configuré ou quand
 * toutes les propositions ont été rejetées. Il ne fabrique rien : il met en phrase les chiffres
 * déjà calculés. Un écran sans analyse vaut mieux qu'un écran avec une analyse fausse, mais un
 * écran avec les faits mis en phrase vaut mieux que les deux.
 */
export function deterministicObservations(facts: PortfolioFacts): Observation[] {
  const observations: Observation[] = [];
  const pct = (value: number) => `${value.toFixed(1).replace(".", ",")} %`;

  if (!facts.coverage.sufficient) {
    observations.push({
      tone: "risk",
      title: "Analyse partielle",
      body: `${facts.coverage.pricedPositions} position(s) sur ${facts.coverage.totalPositions} sont valorisées. Tant que la couverture reste incomplète, la répartition et la performance affichées ne portent que sur ce périmètre.`,
      metric: `${facts.coverage.pricedPositions}/${facts.coverage.totalPositions}`,
    });
  }
  const topGeography = facts.geography.find((zone) => zone.label !== "Non renseigné");
  if (topGeography && topGeography.pct >= 30) {
    observations.push({
      tone: "risk",
      title: "Concentration géographique",
      body: `${pct(topGeography.pct)} du portefeuille est exposé à ${topGeography.label}. Cette concentration rend le compte plus sensible à ce marché.`,
      metric: pct(topGeography.pct),
    });
  }
  const best = facts.best[0];
  if (best && best.gainPct !== null && best.gainPct > 0) {
    observations.push({
      tone: "positive",
      title: "Meilleure ligne",
      body: `${best.name} affiche ${pct(best.gainPct)} depuis son acquisition${best.gainEur !== null ? `, soit ${Math.round(best.gainEur)} ${facts.referenceCurrency} de plus-value latente` : ""}.`,
      metric: pct(best.gainPct),
    });
  }
  if (!facts.performance.isReliable) {
    observations.push({
      tone: "action",
      title: "Flux historiques à rapprocher",
      body: `Le montant net investi est de ${Math.round(facts.netInvestedEur)} ${facts.referenceCurrency} et la trésorerie de ${Math.round(facts.cashEur)} ${facts.referenceCurrency}. Vérifiez que les versements historiques ont bien été enregistrés avant de lire la performance.`,
      metric: `${Math.round(facts.netInvestedEur)} ${facts.referenceCurrency}`,
    });
  } else if (facts.concentration.top3Pct !== null) {
    observations.push({
      tone: "action",
      title: "À vérifier",
      body: `Les 3 premières lignes représentent ${pct(facts.concentration.top3Pct)} du compte. Vérifiez que ce niveau correspond bien au risque que vous acceptez.`,
      metric: pct(facts.concentration.top3Pct),
    });
  }
  return observations.slice(0, 3);
}

/** Libellé de couverture affiché à côté de la date d'analyse. */
export function coverageLabel(facts: PortfolioFacts): string {
  return facts.coverage.sufficient
    ? `Couverture des données : ${facts.coverage.pricePercent.toFixed(0)} %`
    : `Couverture partielle : ${facts.coverage.pricedPositions}/${facts.coverage.totalPositions} positions valorisées`;
}

/** Consigne envoyée au modèle. Elle ne contient QUE l'objet déterministe, jamais des opérations. */
export function buildAnalysisPrompt(facts: PortfolioFacts): string {
  return [
    "Tu résumes un portefeuille pour une application d'éducation financière familiale, en français.",
    "",
    "RÈGLES ABSOLUES :",
    "- Tu ne peux citer QUE des chiffres présents dans l'objet JSON ci-dessous. Aucun autre nombre.",
    "- Tu ne peux nommer QUE des actifs, zones ou secteurs présents dans cet objet.",
    "- Aucun ordre d'achat ou de vente, aucune recommandation personnalisée, aucune promesse de performance.",
    "- Maximum 3 observations : une positive, un risque ou point de vigilance, une action pédagogique à vérifier.",
    "- Chaque observation cite le chiffre qui la justifie, dans son corps de texte.",
    "- Si `coverage.sufficient` vaut false, dis-le explicitement au lieu de conclure.",
    "- Deux phrases maximum par observation. Ton factuel et pédagogique, jamais commercial.",
    "",
    "Réponds UNIQUEMENT par un JSON de la forme :",
    '{"observations":[{"tone":"positive|risk|action","title":"…","body":"…","metric":"…"}]}',
    "",
    "DONNÉES :",
    JSON.stringify(facts, null, 1),
  ].join("\n");
}
