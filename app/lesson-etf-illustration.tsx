"use client";

// Illustration principale de la leçon « Comprendre un ETF en 5 minutes ».
//
// Contrairement à SavingsIllustration (mood « premium » bleu nuit, sur demande explicite de ce
// prompt-là), celle-ci reste dans le registre CLAIR de l'application — la brief demande une page
// « élégante, lumineuse et rassurante ». Même choix technique : SVG dessiné dans l'application
// (pas d'image générée, pas de next/image), recadrable par `preserveAspectRatio="xMidYMid slice"`.
//
// Concept : un panier reçoit cinq jetons de couleur représentant des secteurs génériques
// (Technologie, Santé, Industrie, Finance, Consommation) — jamais un vrai logo d'entreprise, pour
// rester pédagogique et sans risque de droits. Les couleurs reprennent des tokens déjà utilisés
// ailleurs dans l'app (donut de répartition du patrimoine, palette family.css), pas une palette
// inventée pour l'occasion.

import { useId } from "react";
import "./lesson-etf-illustration.css";

const SECTORS = [
  { color: "#1d706b", angle: -46 }, // teal — Technologie
  { color: "#ef8b72", angle: -21 }, // coral — Santé
  { color: "#f3b649", angle: 0 }, // amber — Industrie
  { color: "#5a9bd4", angle: 21 }, // bleu — Finance
  { color: "#3aa17e", angle: 46 }, // vert — Consommation
] as const;

export function EtfIllustration({ variant, label }: { variant: "hero" | "card"; label: string }) {
  const raw = useId().replace(/:/g, "");
  const id = (suffix: string) => `${raw}-${suffix}`;
  const center = { x: 820, y: 360 };
  const radius = 210;

  return (
    <div className={`etf-illu etf-illu-${variant}`}>
      <svg
        className="etf-illu-svg"
        viewBox="0 0 1600 900"
        preserveAspectRatio="xMidYMid slice"
        role="img"
        aria-labelledby={id("title")}
        aria-describedby={id("desc")}
      >
        <title id={id("title")}>{label}</title>
        <desc id={id("desc")}>
          Sur un fond clair et lumineux, cinq jetons de couleur représentant des secteurs
          d’activité génériques convergent vers un panier, symbolisant un investissement unique
          réparti entre plusieurs entreprises.
        </desc>

        <defs>
          <linearGradient id={id("bg")} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#FBFAF6" />
            <stop offset="100%" stopColor="#F1F4F1" />
          </linearGradient>
          <radialGradient id={id("glow")} cx="0.5" cy="0.5" r="0.5">
            <stop offset="0%" stopColor="#1d706b" stopOpacity="0.1" />
            <stop offset="100%" stopColor="#1d706b" stopOpacity="0" />
          </radialGradient>
        </defs>

        <rect width="1600" height="900" fill={`url(#${id("bg")})`} />
        <circle cx={center.x} cy={center.y} r="360" fill={`url(#${id("glow")})`} />

        {/* Anneau discret évoquant un indice boursier */}
        <circle cx={center.x} cy={center.y} r={radius + 74} fill="none" stroke="#1d706b" strokeOpacity="0.12" strokeWidth="1.4" strokeDasharray="2 10" />

        {/* Cinq jetons de secteur, convergeant vers le panier */}
        {SECTORS.map((sector) => {
          const rad = (sector.angle * Math.PI) / 180;
          const x = center.x + radius * Math.sin(rad);
          const y = center.y - radius * Math.cos(rad) * 0.72 - 40;
          return (
            <g key={sector.color}>
              <line x1={x} y1={y + 26} x2={center.x} y2={center.y + 90} stroke={sector.color} strokeOpacity="0.22" strokeWidth="2" strokeDasharray="1 8" strokeLinecap="round" />
              <circle cx={x} cy={y} r="26" fill={sector.color} fillOpacity="0.85" />
            </g>
          );
        })}

        {/* Panier : anse + corps, ligne épurée */}
        <g fill="none" stroke="#17324d" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round">
          <path d={`M${center.x - 70} ${center.y + 90} a70 60 0 0 1 140 0`} />
          <path d={`M${center.x - 128} ${center.y + 90} L${center.x - 104} ${center.y + 210} a24 24 0 0 0 24 22 h${216} a24 24 0 0 0 24-22 L${center.x + 128} ${center.y + 90} Z`} fill="#F4F6F2" fillOpacity="0.9" />
        </g>
        <g stroke="#17324d" strokeOpacity="0.25" strokeWidth="3" strokeLinecap="round">
          <line x1={center.x - 90} y1={center.y + 118} x2={center.x - 78} y2={center.y + 208} />
          <line x1={center.x} y1={center.y + 118} x2={center.x} y2={center.y + 210} />
          <line x1={center.x + 90} y1={center.y + 118} x2={center.x + 78} y2={center.y + 208} />
        </g>
      </svg>
    </div>
  );
}
