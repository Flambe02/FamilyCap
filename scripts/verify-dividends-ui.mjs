// Vérification des dividendes sur les DONNÉES RÉELLES du projet Supabase.
//
// Les tests unitaires prouvent que le moteur est juste sur des cas construits. Ce script prouve
// qu'il l'est sur le portefeuille réel : il rejoue exactement la chaîne serveur
// (loadDividendContext → computeDividendModel) pour chaque compte PEA / compte-titres, puis vérifie
// les critères d'acceptation qui ne se voient que sur de vraies données — instruments rattachés,
// dates de paiement réellement publiées, cohérence total / moyenne, capitalisants muets.
//
// LECTURE SEULE : aucune écriture, aucun appel fournisseur.
//
// Usage : node --env-file=.env.local scripts/verify-dividends-ui.mjs

import { loadDividendContext } from "../lib/dividend-server.ts";
import { computeDividendModel, next12mWindow } from "../lib/dividend-engine.ts";

const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) {
  console.error("Supabase n’est pas configuré : lancez avec --env-file=.env.local");
  process.exit(1);
}

const TODAY = new Date().toISOString().slice(0, 10);
const euro = (value, currency = "EUR") =>
  new Intl.NumberFormat("fr-FR", { style: "currency", currency, maximumFractionDigits: 0 }).format(value);

const failures = [];
const check = (label, condition, detail = "") => {
  if (condition) console.log(`  ✔ ${label}`);
  else {
    console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ""}`);
    failures.push(label);
  }
};

async function rest(path) {
  const response = await fetch(`${url}/rest/v1/${path}`, { headers: { apikey: key, accept: "application/json" } });
  if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 200)}`);
  const body = await response.text();
  return body ? JSON.parse(body) : null;
}

const accounts = await rest("financial_accounts?select=id,name,account_type&account_type=in.(pea,securities)&is_active=eq.true&order=account_type.asc");
if (!accounts?.length) {
  console.error("Aucun compte PEA ou compte-titres actif : rien à vérifier.");
  process.exit(1);
}

for (const account of accounts) {
  const label = `${account.name} (${account.account_type === "pea" ? "PEA" : "compte-titres"})`;
  console.log(`\n########## ${label}`);

  const context = await loadDividendContext([account.id], TODAY);
  if (!context) {
    check("contexte chargé", false, "loadDividendContext a renvoyé null");
    continue;
  }
  const model = computeDividendModel({
    operations: context.operations,
    positions: context.model.positions,
    events: context.events,
    instruments: context.instruments,
    accountType: context.accountType,
    today: TODAY,
    referenceCurrency: context.referenceCurrency,
    fxRateAt: context.fxRateAt,
    taxProfile: context.taxProfile,
    window: next12mWindow(TODAY),
    positionsValueReference: context.model.positionsValueEur,
    investedReference: context.model.investedInAssetsEur,
  });

  console.log(
    `  ${context.model.positions.length} positions · ${context.instruments.length} instruments rattachés · `
    + `${context.unresolvedPositions.length} non rattachés · ${context.events.length} événements en base`,
  );
  console.log(
    `  Attendus 12 mois : ${euro(model.expectedReference, context.referenceCurrency)} `
    + `(${euro(model.expectedReceivedReference, context.referenceCurrency)} reçus · `
    + `${euro(model.expectedAnnouncedReference, context.referenceCurrency)} annoncés · `
    + `${euro(model.expectedEstimatedReference, context.referenceCurrency)} estimés) · `
    + `moyenne ${euro(model.monthlyAverageReference, context.referenceCurrency)}/mois`,
  );
  console.log(
    `  Couverture : ${model.coverage.documented} documentés · ${model.coverage.accumulating} capitalisants · `
    + `${model.coverage.unknown} politique inconnue · ${model.coverage.unresolved} à identifier`,
  );

  // ---- Cohérence arithmétique -------------------------------------------------------------
  const parts = model.expectedReceivedReference + model.expectedAnnouncedReference + model.expectedEstimatedReference;
  check("le total est la somme exacte de ses trois composantes", Math.abs(parts - model.expectedReference) < 0.01);
  check(
    "la moyenne mensuelle × 12 redonne le total",
    Math.abs(model.monthlyAverageReference * model.window.months - model.expectedReference) < 0.01,
  );
  const monthlyTotal = model.monthly.reduce((sum, point) => sum + point.totalReference, 0);
  check("la ventilation mensuelle redonne le total", Math.abs(monthlyTotal - model.expectedReference) < 0.01);

  // ---- Dates : jamais de détachement présenté comme un paiement ---------------------------
  const fakePayment = model.entries.filter((entry) => entry.paymentDate !== null && entry.paymentDate === entry.exDate);
  check("aucune date de paiement copiée depuis le détachement", fakePayment.length === 0, `${fakePayment.length} ligne(s)`);
  const datedForecast = model.entries.filter((entry) => entry.status === "estimated" && (entry.exDate || entry.paymentDate));
  check("aucune projection ne porte de date exacte", datedForecast.length === 0, `${datedForecast.length} ligne(s)`);
  const derivedMonth = model.entries.filter((entry) => entry.scheduleBasis === "ex_date");
  if (derivedMonth.length > 0) {
    console.log(`  ℹ ${derivedMonth.length} échéance(s) sans date de paiement publiée : le mois est déduit du détachement et l’écran l’indique.`);
  }

  // ---- Capitalisants ------------------------------------------------------------------------
  const accumulatingKeys = new Set(model.positions.filter((position) => position.distributionPolicy === "accumulating").map((position) => position.key));
  const leaking = model.entries.filter((entry) => entry.instrumentKey && accumulatingKeys.has(entry.instrumentKey) && entry.status !== "received");
  check("aucun ETF capitalisant ne produit de versement attendu", leaking.length === 0, `${leaking.length} ligne(s)`);

  // ---- Reçus : uniquement des opérations réelles --------------------------------------------
  const realDividendOperations = context.operations.filter((operation) => operation.type === "dividende").length;
  const receivedEntries = model.entries.filter((entry) => entry.status === "received").length;
  check(
    "chaque « reçu » correspond à une opération réelle",
    receivedEntries === realDividendOperations,
    `${receivedEntries} affichés pour ${realDividendOperations} opérations`,
  );

  // ---- Fiscalité ---------------------------------------------------------------------------
  if (context.accountType === "PEA") {
    const taxed = model.entries.filter((entry) => entry.status !== "received" && entry.netReference !== null && entry.grossReference !== null && entry.netReference < entry.grossReference);
    check("PEA : aucun prélèvement appliqué par dividende", taxed.length === 0 || model.tax.netAvailable, `${taxed.length} ligne(s) amputée(s)`);
  } else {
    check(
      "compte-titres : un net n’est affiché que si un profil fiscal le définit",
      model.tax.netAvailable === (context.taxProfile !== null && context.taxProfile.showEstimatedNet
        && (context.taxProfile.withholdingTaxRate !== null || context.taxProfile.estimatedTaxRate !== null)),
    );
  }

  // ---- Instruments non rattachés -------------------------------------------------------------
  if (context.unresolvedPositions.length > 0) {
    console.log("  ℹ Positions sans instrument canonique (à identifier avant tout calcul) :");
    for (const position of context.unresolvedPositions.slice(0, 10)) {
      console.log(`      · ${position.name} ${position.isin ?? position.ticker ?? ""}`);
    }
  }
  const noSymbol = context.instruments.filter((item) => item.resolutionStatus !== "resolved");
  if (noSymbol.length > 0) {
    console.log(`  ℹ ${noSymbol.length} instrument(s) sans symbole fournisseur validé : ${noSymbol.slice(0, 6).map((item) => item.name).join(", ")}`);
  }

  // ---- Prochaines échéances lisibles ---------------------------------------------------------
  if (model.upcoming.length > 0) {
    console.log("  Prochains versements :");
    for (const entry of model.upcoming.slice(0, 5)) {
      const when = entry.status === "estimated"
        ? `${entry.scheduleMonth} estimé (date non annoncée)`
        : entry.paymentDate
          ? `paiement ${entry.paymentDate}`
          : `détachement ${entry.exDate} — paiement non publié`;
      const amount = entry.grossReference === null ? "donnée indisponible" : euro(entry.grossReference, context.referenceCurrency);
      console.log(`      · ${entry.name.padEnd(42).slice(0, 42)} ${amount.padStart(12)}  ${when}  [${entry.status}]`);
    }
  } else {
    console.log("  Aucune échéance à venir connue pour ce compte.");
  }
}

console.log(`\n${failures.length === 0 ? "✔ Toutes les vérifications passent." : `✖ ${failures.length} vérification(s) en échec : ${failures.join(" · ")}`}`);
process.exit(failures.length === 0 ? 0 : 1);
