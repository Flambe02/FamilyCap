// Moteur de PROJECTION (lib/dividend-projection.ts) — déterministe, sans réseau ni base.
//
// Ce qui est vérifié ici est ce qui distingue une projection honnête d'une invention : un mois et
// jamais un jour, un montant prudent qui n'extrapole aucune croissance, l'exclusion des dividendes
// exceptionnels, l'effacement d'une projection dès qu'une annonce officielle couvre l'échéance, et
// le refus de projeter un dividende suspendu ou un historique irrégulier.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ANNOUNCEMENT_WINDOW_DAYS, confidenceLabel, detectFrequency, flagSpecialDividends,
  frequencyLabel, groupIntoSlots, projectDividends, prudentAmount, slotConfidence,
} from "../lib/dividend-projection.ts";

const TODAY = "2026-07-28";

const point = (exDate, amountPerShare, over = {}) => ({
  exDate, amountPerShare, currency: "EUR", dividendType: "ordinary", isSpecial: false, ...over,
});

/** Historique annuel réel : Sanofi détache en mai, tous les ans. */
const annualHistory = [
  point("2022-05-06", 3.33), point("2023-05-05", 3.56),
  point("2024-05-06", 3.76), point("2025-05-16", 3.92),
];

/** Historique trimestriel : quatre versements par an, montants proches. */
const quarterlyHistory = [
  point("2025-03-05", 0.5), point("2025-06-05", 0.5), point("2025-09-05", 0.5), point("2025-12-05", 0.5),
  point("2026-03-05", 0.52), point("2026-06-05", 0.52),
];

// ==========================================================================================
// Fréquence
// ==========================================================================================
test("la fréquence est déduite de l'écart MÉDIAN, insensible à un décalage isolé", () => {
  assert.equal(detectFrequency(annualHistory), "annual");
  assert.equal(detectFrequency(quarterlyHistory), "quarterly");
  assert.equal(detectFrequency([point("2025-01-15", 1), point("2025-07-15", 1), point("2026-01-15", 1)]), "semiannual");
  assert.equal(detectFrequency([point("2026-01-15", 1), point("2026-02-15", 1), point("2026-03-15", 1)]), "monthly");
  assert.equal(detectFrequency([point("2020-01-15", 1)]), "irregular");
  assert.equal(frequencyLabel("quarterly"), "trimestriel");
});

test("les créneaux regroupent les échéances récurrentes, une par rendez-vous annuel", () => {
  assert.equal(groupIntoSlots(annualHistory, "annual").length, 1, "quatre années, une seule échéance de mai");
  assert.equal(groupIntoSlots(quarterlyHistory, "quarterly").length, 4, "quatre rendez-vous trimestriels distincts");
});

// ==========================================================================================
// Montant prudent — aucune croissance extrapolée
// ==========================================================================================
test("le montant retenu est le plus faible entre le dernier versement et la médiane des trois derniers", () => {
  // Historique croissant : 3,56 / 3,76 / 3,92 → médiane 3,76, dernier 3,92 ⇒ on retient 3,76.
  assert.equal(prudentAmount(annualHistory), 3.76);
  // Historique décroissant : la baisse récente est bien prise en compte.
  assert.equal(prudentAmount([point("2024-05-06", 4), point("2025-05-06", 3), point("2026-05-06", 2)]), 2);
});

test("une projection ne promet jamais la hausse observée", () => {
  const result = projectDividends(annualHistory, [], { today: TODAY });
  assert.equal(result.projections.length, 1);
  assert.ok(result.projections[0].amountPerShare <= 3.92, "jamais au-dessus du dernier versement connu");
  assert.match(result.projections[0].method, /aucune croissance n’est extrapolée/i);
});

// ==========================================================================================
// 5. Une annonce officielle remplace la projection
// ==========================================================================================
test("5 — une échéance officiellement annoncée n'est jamais doublée d'une projection", () => {
  const withoutAnnouncement = projectDividends(annualHistory, [], { today: TODAY });
  assert.equal(withoutAnnouncement.projections.length, 1);
  assert.equal(withoutAnnouncement.projections[0].estimatedMonth, "2027-05");

  const withAnnouncement = projectDividends(
    annualHistory,
    [{ exDate: "2027-05-10", paymentDate: "2027-05-14", dividendType: "ordinary" }],
    { today: TODAY },
  );
  assert.equal(withAnnouncement.projections.length, 0, "l'annonce prime sur la supposition");
  assert.equal(withAnnouncement.skippedReason, "fully_announced");
});

test("5 bis — une annonce du mois adjacent couvre aussi l'échéance (fenêtre de 45 jours)", () => {
  const result = projectDividends(
    annualHistory,
    [{ exDate: null, paymentDate: "2027-06-02", dividendType: "ordinary" }],
    { today: TODAY },
  );
  assert.equal(result.projections.length, 0);
  assert.equal(ANNOUNCEMENT_WINDOW_DAYS, 45);
});

// ==========================================================================================
// 7. Dividendes exceptionnels
// ==========================================================================================
test("7 — un dividende exceptionnel étiqueté est exclu de la base de calcul", () => {
  const history = [...annualHistory, point("2025-11-20", 12, { dividendType: "special", isSpecial: true })];
  const result = projectDividends(history, [], { today: TODAY });
  assert.match(result.notes.join(" "), /exceptionnel/i);
  assert.equal(result.projections.length, 1, "aucune échéance de novembre n'est projetée");
  assert.equal(result.projections[0].estimatedMonth, "2027-05");
});

test("7 bis — un versement isolé et démesuré est étiqueté exceptionnel automatiquement", () => {
  const flagged = flagSpecialDividends([...annualHistory, point("2025-11-20", 15)]);
  const outlier = flagged.find((item) => item.exDate === "2025-11-20");
  assert.equal(outlier.isSpecial, true);
  assert.equal(outlier.dividendType, "special");
  // Les versements récurrents de mai restent ordinaires.
  assert.equal(flagged.filter((item) => item.isSpecial).length, 1);
});

test("7 ter — un solde annuel bien plus gros qu'un acompte récurrent n'est PAS exceptionnel", () => {
  // Acompte de décembre (0,50) + solde de mai (2,00) : rapport 4×, mais les deux se répètent
  // chaque année. Les classer « exceptionnels » amputerait durablement la projection.
  const history = [
    point("2024-12-10", 0.5), point("2025-05-20", 2),
    point("2025-12-10", 0.5), point("2026-05-20", 2),
  ];
  const flagged = flagSpecialDividends(history);
  assert.equal(flagged.filter((item) => item.isSpecial).length, 0);
});

test("7 quater — en dessous de quatre versements, aucune classification automatique", () => {
  const flagged = flagSpecialDividends([point("2025-05-06", 1), point("2026-05-06", 9)]);
  assert.equal(flagged.filter((item) => item.isSpecial).length, 0);
});

// ==========================================================================================
// Confiance
// ==========================================================================================
test("la confiance reflète la régularité du calendrier ET la stabilité du montant", () => {
  const stable = [point("2024-05-06", 1), point("2025-05-06", 1.02), point("2026-05-06", 1.03)];
  const variable = [point("2024-05-06", 1), point("2025-05-06", 2), point("2026-05-06", 0.6)];
  const short = [point("2025-05-06", 1), point("2026-05-06", 1)];
  assert.equal(slotConfidence(stable, "annual"), "high");
  assert.equal(slotConfidence(variable, "annual"), "medium");
  assert.equal(slotConfidence(short, "annual"), "medium");
  assert.equal(slotConfidence([point("2026-05-06", 1)], "annual"), "low");
  assert.equal(confidenceLabel("high"), "Confiance élevée");
});

// ==========================================================================================
// Cas particuliers
// ==========================================================================================
test("un dividende suspendu n'est PAS projeté, et la suspension est expliquée", () => {
  const stale = [point("2021-05-06", 3), point("2022-05-06", 3), point("2023-05-06", 3)];
  const result = projectDividends(stale, [], { today: TODAY });
  assert.equal(result.projections.length, 0);
  assert.equal(result.skippedReason, "suspended");
  assert.match(result.notes.join(" "), /suspendu/i);
});

test("un historique irrégulier ne produit aucune projection", () => {
  const erratic = [point("2021-02-03", 1), point("2023-11-19", 2), point("2026-01-07", 0.4)];
  const result = projectDividends(erratic, [], { today: TODAY });
  assert.equal(result.skippedReason, "irregular");
  assert.equal(result.projections.length, 0);
});

test("un changement de fréquence est signalé et la projection suit le rythme récent", () => {
  // 2025 : deux versements. 2026 : trois. Le passage de semestriel à trimestriel doit être dit,
  // parce qu'il rend la projection moins sûre qu'un calendrier stable.
  const history = [
    point("2025-01-10", 0.5), point("2025-07-10", 0.5),
    point("2026-01-10", 0.5), point("2026-04-10", 0.5), point("2026-07-10", 0.5),
  ];
  const result = projectDividends(history, [], { today: TODAY });
  assert.match(result.notes.join(" "), /Nombre de versements passé de 2 à 3 par an/i);
});

test("un changement de devise est signalé, la plus récente est retenue", () => {
  const history = [
    point("2024-05-06", 1, { currency: "USD" }), point("2025-05-06", 1, { currency: "EUR" }),
    point("2026-05-06", 1, { currency: "EUR" }),
  ];
  const result = projectDividends(history, [], { today: TODAY });
  assert.match(result.notes.join(" "), /Devise de versement modifiée/i);
  assert.equal(result.projections[0].currency, "EUR");
});

test("aucun historique exploitable ⇒ aucune projection, et la raison est explicite", () => {
  const result = projectDividends([], [], { today: TODAY });
  assert.equal(result.skippedReason, "no_history");
  assert.equal(result.projections.length, 0);
});

test("une projection ne porte QUE le mois, sur un horizon de 12 mois", () => {
  const result = projectDividends(quarterlyHistory, [], { today: TODAY });
  assert.ok(result.projections.length >= 3);
  for (const projection of result.projections) {
    assert.match(projection.estimatedMonth, /^\d{4}-(0[1-9]|1[0-2])$/);
    assert.ok(projection.estimatedMonth >= "2026-07" && projection.estimatedMonth <= "2027-06");
    assert.ok(!("exDate" in projection) && !("paymentDate" in projection), "aucune date exacte n'est produite");
  }
  // Un seul versement projeté par mois : deux créneaux qui convergent ne se cumulent pas.
  const months = result.projections.map((projection) => projection.estimatedMonth);
  assert.equal(new Set(months).size, months.length);
});
