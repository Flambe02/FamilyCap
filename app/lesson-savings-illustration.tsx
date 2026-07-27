"use client";

// Illustration principale de la leçon « Épargne et temps ».
//
// Choix assumé : SVG dessiné dans l'application plutôt qu'une image générée.
//  - le projet ne contient aucune illustration matricielle d'article et n'utilise pas next/image
//    (aucun `remotePatterns` configuré) : un fichier WebP aurait introduit un cas isolé ;
//  - un SVG reste net sur tous les écrans, pèse quelques kilo-octets, se recadre sans second
//    export et reprend exactement les tokens de couleur de l'application ;
//  - il est entièrement statique : rien à animer, donc `prefers-reduced-motion` est respecté par
//    construction, et aucun filtre SVG coûteux n'est utilisé (uniquement des dégradés).
//
// Une seule composition, recadrée par `preserveAspectRatio="xMidYMid slice"` : le sujet est centré
// autour de x ≈ 65 %, à l'intérieur de la zone conservée aussi bien en 16:9 qu'en 3:2 ou en 4:5.
// L'espace négatif est laissé à gauche, où l'en-tête pose son titre sur desktop.

import { useId } from "react";
import "./lesson-savings-illustration.css";

export function SavingsIllustration({ variant, label }: { variant: "hero" | "card"; label: string }) {
  const raw = useId().replace(/:/g, "");
  const id = (suffix: string) => `${raw}-${suffix}`;

  return (
    <div className={`savings-illu savings-illu-${variant}`}>
      <svg
        className="savings-illu-svg"
        viewBox="0 0 1600 900"
        preserveAspectRatio="xMidYMid slice"
        role="img"
        aria-labelledby={id("title")}
        aria-describedby={id("desc")}
      >
        <title id={id("title")}>{label}</title>
        <desc id={id("desc")}>
          Sur un fond bleu nuit, une petite forme lumineuse suit une courbe ascendante et devient
          progressivement un ensemble de volumes translucides de plus en plus grands. Des anneaux
          translucides évoquent le passage du temps.
        </desc>

        <defs>
          <linearGradient id={id("sky")} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#0A1720" />
            <stop offset="58%" stopColor="#0D2029" />
            <stop offset="100%" stopColor="#102A31" />
          </linearGradient>
          <radialGradient id={id("glow")} cx="0.5" cy="0.5" r="0.5">
            <stop offset="0%" stopColor="#67B88A" stopOpacity="0.26" />
            <stop offset="55%" stopColor="#67B88A" stopOpacity="0.07" />
            <stop offset="100%" stopColor="#67B88A" stopOpacity="0" />
          </radialGradient>
          <linearGradient id={id("path")} x1="0" y1="1" x2="1" y2="0">
            <stop offset="0%" stopColor="#8EB9D6" stopOpacity="0.18" />
            <stop offset="45%" stopColor="#A9D9BD" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#67B88A" stopOpacity="0.95" />
          </linearGradient>
          <linearGradient id={id("satin")} x1="0" y1="0" x2="0.4" y2="1">
            <stop offset="0%" stopColor="#F4F6F2" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#67B88A" stopOpacity="0.28" />
          </linearGradient>
          <linearGradient id={id("frost")} x1="0" y1="0" x2="0.3" y2="1">
            <stop offset="0%" stopColor="#A9D9BD" stopOpacity="0.62" />
            <stop offset="100%" stopColor="#8EB9D6" stopOpacity="0.22" />
          </linearGradient>
        </defs>

        <rect width="1600" height="900" fill={`url(#${id("sky")})`} />
        <circle cx="1070" cy="452" r="560" fill={`url(#${id("glow")})`} />

        {/* Anneaux du temps */}
        <g fill="none" stroke="#A9D9BD" strokeOpacity="0.13">
          <circle cx="1070" cy="452" r="208" strokeWidth="1.4" />
          <circle cx="1070" cy="452" r="304" strokeWidth="1.4" />
          <circle cx="1070" cy="452" r="404" strokeWidth="1.2" strokeDasharray="3 11" />
        </g>
        <path d="M1070 148a304 304 0 0 1 263 152" fill="none" stroke="#A9D9BD" strokeOpacity="0.34" strokeWidth="2" strokeLinecap="round" />

        {/* Trajectoire ascendante */}
        <path
          d="M232 742C462 742 636 700 806 604S1128 358 1414 246"
          fill="none"
          stroke={`url(#${id("path")})`}
          strokeWidth="3.2"
          strokeLinecap="round"
        />

        {/* La graine, puis quatre étapes de croissance le long de la trajectoire */}
        <circle cx="286" cy="740" r="30" fill="#E5A45A" fillOpacity="0.1" />
        <circle cx="286" cy="740" r="9" fill="#E5A45A" fillOpacity="0.85" />

        <circle cx="556" cy="718" r="17" fill="#8EB9D6" fillOpacity="0.42" />

        <rect x="774" y="588" width="52" height="52" rx="17" transform="rotate(-8 800 614)" fill={`url(#${id("frost")})`} />

        <g fill={`url(#${id("frost")})`}>
          <rect x="972" y="452" width="94" height="26" rx="13" />
          <rect x="984" y="414" width="70" height="26" rx="13" fillOpacity="0.8" />
        </g>

        <g>
          <rect x="1272" y="292" width="150" height="34" rx="17" fill={`url(#${id("frost")})`} />
          <rect x="1288" y="246" width="118" height="34" rx="17" fill={`url(#${id("satin")})`} />
          <rect x="1304" y="200" width="86" height="34" rx="17" fill="#A9D9BD" fillOpacity="0.72" />
          <rect x="1320" y="158" width="54" height="30" rx="15" fill="#F4F6F2" fillOpacity="0.86" />
        </g>
      </svg>
    </div>
  );
}
