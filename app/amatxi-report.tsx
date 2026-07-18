"use client";

import { useMemo, useState } from "react";
import "./amatxi-report.css";

type GiftRecord = { member_name: string; occasion: string; gift_date: string; amount_eur: number; btc_amount: number; custody?: string; ledger_amount?: number | null; is_deleted?: boolean };
type GiftLine = GiftRecord & { ownedBtc: number; location: "Ledger" | "Binance" | "À classer"; currentValue: number | null; result: number | null };
type ChildSummary = { name: string; gifts: number; invested: number; currentValue: number | null; result: number | null };
const euro = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });
const dateFormat = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
const monthFormat = new Intl.DateTimeFormat("fr-FR", { month: "long", timeZone: "UTC" });


function locationOf(r: GiftRecord): GiftLine["location"] { if (r.custody === "Ledger") return "Ledger"; if (r.custody?.toLowerCase().includes("binance")) return "Binance"; return "À classer"; }
function btcOf(r: GiftRecord) { return r.custody === "Ledger" && Number(r.ledger_amount) > 0 ? Number(r.ledger_amount) : Math.max(0, Number(r.btc_amount) || 0); }
function resultClass(n: number | null) { return n === null ? "result-neutral" : n >= 0 ? "result-positive" : "result-negative"; }
function percentResult(result: number | null, invested: number) { return result === null || invested <= 0 ? null : result / invested * 100; }
const PROJECT_START_DATE = "2022-12-25";
function annualizedPercent(current: number | null, invested: number) {
  if (current === null || invested <= 0 || current <= 0) return null;
  const days = Math.max(1, (Date.now() - new Date(PROJECT_START_DATE + "T00:00:00Z").getTime()) / 86400000);
  return (Math.pow(current / invested, 365.25 / days) - 1) * 100;
}

export function AmatxiReport({ records, bitcoinEur, loading }: { records: GiftRecord[]; bitcoinEur: number | null; loading: boolean }) {
  const [childFilter, setChildFilter] = useState("Tous");
  const [occasionFilter, setOccasionFilter] = useState("Toutes");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [explanationOpen, setExplanationOpen] = useState(false);
  const [comment, setComment] = useState("");

  const allLines = useMemo<GiftLine[]>(() => records.filter(r => !r.is_deleted).map(r => {
    const ownedBtc = btcOf(r);
    const currentValue = bitcoinEur && ownedBtc > 0 ? ownedBtc * bitcoinEur : null;
    return { ...r, ownedBtc, location: locationOf(r), currentValue, result: currentValue === null ? null : currentValue - Number(r.amount_eur) };
  }).sort((a, b) => b.gift_date.localeCompare(a.gift_date)), [bitcoinEur, records]);

  const children = useMemo(() => [...new Set(allLines.map(line => line.member_name))].sort(), [allLines]);
  const occasions = useMemo(() => [...new Set(allLines.map(line => line.occasion))].sort(), [allLines]);
  const lines = useMemo(() => allLines.filter(line => (childFilter === "Tous" || line.member_name === childFilter) && (occasionFilter === "Toutes" || line.occasion === occasionFilter) && (!dateFrom || line.gift_date >= dateFrom) && (!dateTo || line.gift_date <= dateTo)), [allLines, childFilter, occasionFilter, dateFrom, dateTo]);

  const summary = useMemo(() => {
    const invested = lines.reduce((s, r) => s + Number(r.amount_eur), 0);
    const totalBtc = lines.reduce((s, r) => s + r.ownedBtc, 0);
    const ledgerBtc = lines.filter(r => r.location === "Ledger").reduce((s, r) => s + r.ownedBtc, 0);
    const binanceBtc = lines.filter(r => r.location === "Binance").reduce((s, r) => s + r.ownedBtc, 0);
    const unclassifiedBtc = lines.filter(r => r.location === "À classer").reduce((s, r) => s + r.ownedBtc, 0);
    const currentValue = bitcoinEur && totalBtc > 0 ? totalBtc * bitcoinEur : null;
    const result = currentValue === null ? null : currentValue - invested;
    return { invested, totalBtc, ledgerBtc, binanceBtc, unclassifiedBtc, currentValue, result, resultPct: percentResult(result, invested), annualPct: annualizedPercent(currentValue, invested) };
  }, [bitcoinEur, lines]);

  const byChild = useMemo<ChildSummary[]>(() => {
    const map = new Map<string, GiftLine[]>();
    lines.forEach(line => map.set(line.member_name, [...(map.get(line.member_name) ?? []), line]));
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, childLines]) => {
      const invested = childLines.reduce((s, line) => s + Number(line.amount_eur), 0);
      const currentValue = childLines.every(line => line.currentValue !== null) ? childLines.reduce((s, line) => s + Number(line.currentValue), 0) : null;
      return { name, gifts: childLines.length, invested, currentValue, result: currentValue === null ? null : currentValue - invested };
    });
  }, [lines]);

  const pct = (n: number) => summary.totalBtc ? Math.round(n / summary.totalBtc * 100) : 0;
  const formattedPct = (n: number | null) => n === null ? "—" : (n >= 0 ? "+" : "") + n.toFixed(1) + "%";

  return <div className="page-stack amatxi-page">
    <section className="amatxi-hero"><div><span className="soft-pill">VUE ADMINISTRATEUR · POUR AMATXI</span><h2>Les cadeaux de la famille,<br /><em>en un coup d’œil.</em></h2><p>Un résumé simple : quel enfant, quelle occasion, combien offert et où se trouve le Bitcoin.</p></div><div className="amatxi-greeting"><span>♥</span><strong>Amatxi</strong><small>la famille grandit</small></div></section>
    <section className="amatxi-stats" aria-label="Résumé des cadeaux"><article><b className="amt-icon mint">€</b><div><small>Total offert</small><strong>{euro.format(summary.invested)}</strong><p>{lines.length} cadeaux affichés</p></div></article><article><b className="amt-icon gold">₿</b><div><small>Bitcoin reçu</small><strong>{summary.totalBtc.toFixed(8)} BTC</strong><p>{bitcoinEur ? "Cours : " + euro.format(bitcoinEur) + " / BTC" : "Cours indisponible"}</p></div></article><article><b className="amt-icon blue">↗</b><div><small>Valeur aujourd’hui</small><strong>{summary.currentValue === null ? "—" : euro.format(summary.currentValue)} <em className={resultClass(summary.result)}>{formattedPct(summary.resultPct)}</em></strong><p className={resultClass(summary.result)}>{summary.result === null ? "En attente du cours" : (summary.result >= 0 ? "+" : "") + euro.format(summary.result)} · {summary.annualPct === null ? "Rendement annuel —" : "Rendement moyen annuel depuis le 25/12/2022 : " + formattedPct(summary.annualPct)}</p></div></article></section>
    <section className="amatxi-location panel"><header><div><span className="section-label">OÙ EST LE BITCOIN ?</span><h3>Ledger ou Binance, simplement</h3></div><b className="amt-badge">{pct(summary.ledgerBtc)}% Ledger · {pct(summary.binanceBtc)}% Binance</b></header><div className="location-bar"><i style={{ width: pct(summary.ledgerBtc) + "%" }} /><i style={{ width: pct(summary.binanceBtc) + "%" }} /><i style={{ width: pct(summary.unclassifiedBtc) + "%" }} /></div><div className="location-legend"><div><b className="dot ledger" /><strong>Ledger</strong><span>{summary.ledgerBtc.toFixed(8)} BTC · {pct(summary.ledgerBtc)}%</span><small>Le coffre familial</small></div><div><b className="dot binance" /><strong>Binance</strong><span>{summary.binanceBtc.toFixed(8)} BTC · {pct(summary.binanceBtc)}%</span><small>Le compte d’achat</small></div>{summary.unclassifiedBtc > 0 && <div><b className="dot unknown" /><strong>À classer</strong><span>{summary.unclassifiedBtc.toFixed(8)} BTC</span><small>À rapprocher</small></div>}</div></section>
    <section className="amatxi-table-panel panel"><header className="amt-heading"><div><span className="section-label">LE CARNET DES CADEAUX</span><h3>Un cadeau après l’autre</h3></div><p>Les totaux ci-dessous suivent les filtres.</p><button type="button" className="explain-button" onClick={() => setExplanationOpen(true)}>Comprendre les écarts</button></header>
      <div className="amatxi-filters"><label>Enfant<select value={childFilter} onChange={e => setChildFilter(e.target.value)}><option>Tous</option>{children.map(child => <option key={child}>{child}</option>)}</select></label><label>Occasion<select value={occasionFilter} onChange={e => setOccasionFilter(e.target.value)}><option>Toutes</option>{occasions.map(occasion => <option key={occasion}>{occasion}</option>)}</select></label><label>Du<input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} /></label><label>Au<input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} /></label><button type="button" onClick={() => { setChildFilter("Tous"); setOccasionFilter("Toutes"); setDateFrom(""); setDateTo(""); }}>Réinitialiser</button></div>
      {byChild.length > 0 && <div className="child-summary">{byChild.map(child => { const birthdayMonths = [...new Set(lines.filter(line => line.member_name === child.name && line.occasion === "Anniversaire" && line.gift_date >= "2022-01-01").map(line => monthFormat.format(new Date(line.gift_date + "T00:00:00Z"))))].join(", "); return <article key={child.name}><strong className="child-name-row">{child.name}<span className="child-birthday-label"><span aria-hidden="true">&#127874;</span>{birthdayMonths || "Mois non renseigné"}</span></strong><span>{child.gifts} cadeau{child.gifts > 1 ? "x" : ""} · {euro.format(child.invested)} offert</span><b className={resultClass(child.result)}>{child.currentValue === null ? "Valeur —" : euro.format(child.currentValue) + " · " + formattedPct(percentResult(child.result, child.invested))}</b></article>; })}</div>}
      {loading ? <div className="amt-empty">Lecture des cadeaux en cours…</div> : <div className="amt-scroll"><table><thead><tr><th>Enfant</th><th>Date</th><th>Occasion</th><th>Cadeau</th><th>Bitcoin</th><th>Valeur actuelle</th><th>Plus / moins-value</th></tr></thead><tbody>{lines.map(line => <tr key={line.member_name + line.gift_date + line.occasion}><td><strong>{line.member_name}</strong></td><td>{dateFormat.format(new Date(line.gift_date + "T00:00:00Z"))}</td><td><span className={"occasion " + (line.occasion === "Noël" ? "noel" : "anniv")}>{line.occasion === "Noël" ? "🎄" : "🎂"} {line.occasion}</span></td><td><strong>{euro.format(Number(line.amount_eur))}</strong><small>valeur offerte</small></td><td><strong>{line.ownedBtc.toFixed(8)} BTC</strong><small className={"where " + (line.location === "À classer" ? "unknown" : line.location.toLowerCase())}>{line.location}</small></td><td>{line.currentValue === null ? "—" : euro.format(line.currentValue)}</td><td><strong className={resultClass(line.result)}>{line.result === null ? "—" : (line.result >= 0 ? "+" : "") + euro.format(line.result) + " · " + formattedPct(percentResult(line.result, Number(line.amount_eur)))}</strong></td></tr>)}</tbody></table></div>}
    </section>
    {explanationOpen && <div className="amatxi-modal-backdrop" role="presentation" onMouseDown={event => event.target === event.currentTarget && setExplanationOpen(false)}><section className="amatxi-explanation-modal" role="dialog" aria-modal="true" aria-labelledby="amatxi-explanation-title"><header><div><span className="section-label">EXPLICATION SIMPLE</span><h3 id="amatxi-explanation-title">Les cadeaux faits et les &eacute;carts</h3></div><button type="button" onClick={() => setExplanationOpen(false)} aria-label="Fermer">&times;</button></header><div className="amatxi-explanation-list">{byChild.map(child => { const childLines = lines.filter(line => line.member_name === child.name); const birthdayLines = childLines.filter(line => line.occasion === "Anniversaire" && line.gift_date >= "2022-01-01"); const christmasLines = childLines.filter(line => line.occasion === "No\u00ebl" && line.gift_date >= "2022-01-01"); const birthdays = birthdayLines.length; const christmas = christmasLines.length; const birthdayMonths = [...new Set(birthdayLines.map(line => monthFormat.format(new Date(line.gift_date + "T00:00:00Z"))))].join(", "); const birthdayYears = birthdayLines.map(line => line.gift_date.slice(0, 4)).join(", "); const christmasYears = christmasLines.map(line => line.gift_date.slice(0, 4)).join(", "); const differentAmounts = childLines.filter(line => Math.abs(Number(line.amount_eur) - 55) > 0.01); const difference = childLines.reduce((sum, line) => sum + Number(line.amount_eur) - 55, 0); const childPct = percentResult(child.result, child.invested); return <article key={child.name}><h4>{child.name}<span className="birthday-month"><span aria-hidden="true">&#127874;</span>{birthdayMonths || "Mois non renseigné"}</span></h4><p><strong>{child.gifts} cadeau{child.gifts > 1 ? "x" : ""}</strong> au total : {birthdays} anniversaire{birthdays > 1 ? "s" : ""} ({birthdayYears || "aucune année"}) et {christmas} No&euml;l ({christmasYears || "aucune année"}).</p><p>Total offert : <strong>{euro.format(child.invested)}</strong>. {differentAmounts.length > 0 ? "\u00c9cart de montant sur " + differentAmounts.length + " cadeau" + (differentAmounts.length > 1 ? "x" : "") + " : " + (difference >= 0 ? "+" : "") + euro.format(difference) + " au total, par exemple des frais suppl\u00e9mentaires." : "Les cadeaux enregistr\u00e9s sont \u00e0 la valeur habituelle de 55 \u20ac."}</p><p>{child.result === null ? "La valeur actuelle sera calcul\u00e9e quand le cours sera disponible." : "Valeur actuelle : " + euro.format(child.currentValue ?? 0) + " \u00b7 r\u00e9sultat : " + (child.result >= 0 ? "+" : "") + euro.format(child.result) + " (" + (childPct === null ? "—" : (childPct >= 0 ? "+" : "") + childPct.toFixed(1) + "%") + ")."}</p></article>; })}</div><label className="amatxi-comment-label">Commentaire sur les cadeaux et les &eacute;carts<textarea value={comment} onChange={event => setComment(event.target.value)} placeholder={"Ex. Anniversaire Thomas 2022 non r\u00e9alis\u00e9 ; Uhaina 2022 : frais suppl\u00e9mentaires \u00e0 expliquer\u2026"} /></label><button type="button" className="primary-button" onClick={() => setExplanationOpen(false)}>Fermer</button></section></div>}
    <section className="amatxi-note"><span>♥</span><div><strong>À retenir</strong><p>Les cadeaux sont comptés en Bitcoin. Leur valeur en euros peut monter ou descendre : c’est normal. Le rendement annuel est une estimation depuis le premier cadeau affiché.</p></div></section>
  </div>;
}
