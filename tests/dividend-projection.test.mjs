// Dividendes annoncés (lib/dividend-projection.ts) — projection « Estimé » et calcul brut/net.

import { test } from "node:test";
import assert from "node:assert/strict";
import { FLAT_TAX_RATE, dividendToReceive, heldQuantityFor, withEstimatedDividends } from "../lib/dividend-projection.ts";

const TODAY = "2026-07-27";
const asset = (over = {}) => ({ isin: "FR0000120172", symbol: "SW", name: "SODEXO", ...over });
const event = (over = {}) => ({ id: "e1", ex_date: "2025-12-19", payment_date: "2025-12-23", amount_per_share: 2.7, currency: "EUR", asset: asset(), ...over });

test("un instrument annoncé seulement l'an dernier reçoit une projection « Estimé » un an plus tard", () => {
  const result = withEstimatedDividends([event()], TODAY);
  assert.equal(result.length, 2);
  const real = result.find((row) => row.id === "e1");
  const projected = result.find((row) => row.id !== "e1");
  assert.equal(real.estimated, false);
  assert.equal(projected.estimated, true);
  assert.equal(projected.ex_date, "2026-12-19");
  assert.equal(projected.payment_date, "2026-12-23");
  assert.equal(projected.amount_per_share, 2.7); // même valeur, comme demandé
  assert.notEqual(projected.id, real.id);
});

test("une annonce réelle déjà présente pour la période équivalente supprime la projection", () => {
  const result = withEstimatedDividends(
    [event(), event({ id: "e2", ex_date: "2026-12-10", payment_date: "2026-12-14", amount_per_share: 2.75 })],
    TODAY,
  );
  assert.equal(result.length, 2); // aucune 3e ligne ajoutée
  assert.ok(result.every((row) => row.estimated === false));
});

test("aucune projection au-delà de l'horizon (~6 mois) ou dans le passé lointain", () => {
  const tooOld = withEstimatedDividends([event({ ex_date: "2023-01-05", payment_date: null })], TODAY);
  assert.equal(tooOld.length, 1); // 2024-01-05 est bien avant aujourd'hui : pas de projection
  assert.equal(tooOld[0].estimated, false);
});

test("un instrument dont l'annonce vient de tomber ne reçoit PAS de projection « dans un an »", () => {
  // L'horizon est délibérément court (~6 mois) : une annonce fraîche n'a besoin d'aucune
  // supposition, la vraie annonce suivante arrivera par le fournisseur bien avant l'anniversaire.
  // Un horizon large aurait produit une projection « + 1 an » pour CHAQUE annonce récente, qui
  // aurait alors noyé les vrais dividendes proches dans le tri chronologique décroissant.
  const result = withEstimatedDividends([event({ ex_date: "2026-06-18", payment_date: "2026-06-22" })], TODAY);
  assert.equal(result.length, 1);
  assert.equal(result[0].estimated, false);
});

test("montant par part inconnu : rien à projeter", () => {
  const result = withEstimatedDividends([event({ amount_per_share: null })], TODAY);
  assert.equal(result.length, 1);
});

test("un instrument sans identité (asset null) traverse sans grouping ni projection", () => {
  const result = withEstimatedDividends([event({ id: "orphan", asset: null })], TODAY);
  assert.deepEqual(result, [{ ...event({ id: "orphan", asset: null }), estimated: false }]);
});

test("un acompte de décembre reçoit sa projection même si l'instrument a DÉJÀ des annonces 2026 à d'autres dates (bug réel repéré avant livraison)", () => {
  // Rejoue le cas exact qui a fait échouer une première version de cette fonction : TotalEnergies
  // annonce un acompte fin décembre puis deux échéances (mars, juin) l'année suivante. Une
  // heuristique « je ne projette que depuis la dernière année connue de l'instrument » aurait
  // ignoré le créneau de décembre 2026, puisque 2025 n'est pas « la dernière année » de
  // TotalEnergies (2026 l'est, à cause de mars/juin) — alors que c'est précisément le créneau
  // pour lequel 2026 manque encore. Seul l'acompte de décembre est assez ancien (~5 mois) pour
  // entrer dans l'horizon de projection ; mars et juin viennent de tomber et n'en ont pas besoin.
  const asset = { isin: "FR0000120271", symbol: "TTE", name: "TOTALENERGIES" };
  const events = [
    { id: "tte-dec25", ex_date: "2025-12-31", payment_date: "2026-01-05", amount_per_share: 0.85, currency: "EUR", asset },
    { id: "tte-mar26", ex_date: "2026-03-31", payment_date: "2026-04-02", amount_per_share: 0.85, currency: "EUR", asset },
    { id: "tte-jun26", ex_date: "2026-06-30", payment_date: "2026-07-02", amount_per_share: 0.85, currency: "EUR", asset },
  ];
  const result = withEstimatedDividends(events, "2026-07-27");
  const estimatedDates = result.filter((row) => row.estimated).map((row) => row.ex_date).sort();
  assert.deepEqual(estimatedDates, ["2026-12-31"]);
  assert.equal(result.length, 4); // 3 annonces réelles + la seule projection utile
});

test("un versement resté sans confirmation depuis près d'un an reçoit bien une projection", () => {
  // Symétrique du test précédent : un instrument à rythme rapproché dont la DERNIÈRE annonce
  // connue date déjà de plusieurs mois profite lui aussi d'une estimation, dès que l'anniversaire
  // de cette dernière annonce entre dans l'horizon de ~6 mois.
  const result = withEstimatedDividends([event({ ex_date: "2026-01-15", payment_date: "2026-01-19", amount_per_share: 0.42 })], TODAY);
  assert.equal(result.length, 2);
  const projected = result.find((row) => row.estimated);
  assert.equal(projected.ex_date, "2027-01-15");
});

test("le résultat reste trié par date de détachement décroissante", () => {
  const result = withEstimatedDividends([event()], TODAY);
  const dates = result.map((row) => row.ex_date);
  assert.deepEqual([...dates].sort().reverse(), dates);
});

test("heldQuantityFor retrouve la position par ISIN, puis par ticker, puis par nom, sinon 0", () => {
  const positions = [
    { key: "isin:FR0000120172", quantity: 12 },
    { key: "tkr:GLE", quantity: 5 },
    { key: "name:orange", quantity: 30 },
  ];
  assert.equal(heldQuantityFor(positions, { isin: "FR0000120172", symbol: null, name: null }), 12);
  assert.equal(heldQuantityFor(positions, { isin: null, symbol: "GLE", name: null }), 5);
  assert.equal(heldQuantityFor(positions, { isin: null, symbol: null, name: "Orange" }), 30);
  assert.equal(heldQuantityFor(positions, { isin: "US0000000000", symbol: null, name: null }), 0);
  assert.equal(heldQuantityFor(positions, null), 0);
});

test("dividendToReceive : montant inconnu → gross et net tous deux null", () => {
  assert.deepEqual(dividendToReceive({ amountPerShare: null, quantityHeld: 10, accountType: "CTO" }), { gross: null, net: null });
});

test("dividendToReceive : compte-titres retire bien 30 % (flat tax)", () => {
  const result = dividendToReceive({ amountPerShare: 2, quantityHeld: 50, accountType: "CTO" });
  assert.equal(result.gross, 100);
  assert.equal(result.net, 70);
  assert.equal(FLAT_TAX_RATE, 0.3);
});

test("dividendToReceive : PEA n'est jamais netté (net = null, pas 0)", () => {
  const result = dividendToReceive({ amountPerShare: 2, quantityHeld: 50, accountType: "PEA" });
  assert.equal(result.gross, 100);
  assert.equal(result.net, null);
});

test("dividendToReceive : position non détenue (0 titre) → gross = 0, jamais négatif", () => {
  const result = dividendToReceive({ amountPerShare: 2, quantityHeld: 0, accountType: "CTO" });
  assert.equal(result.gross, 0);
  assert.equal(result.net, 0);
  // quantité négative ne peut pas survenir dans le modèle, mais la garde ne doit pas produire de
  // montant négatif si jamais un appelant transmettait une valeur aberrante.
  const guarded = dividendToReceive({ amountPerShare: 2, quantityHeld: -5, accountType: "CTO" });
  assert.equal(guarded.gross, 0);
});
