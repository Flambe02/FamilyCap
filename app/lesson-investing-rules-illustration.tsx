"use client";

// Illustration principale de la leçon « Les 7 règles essentielles pour bien investir ».
//
// Même choix technique et même palette que SavingsIllustration (lesson-savings-illustration.tsx) :
// SVG dessiné dans l'application, pas une image générée — le projet ne contient aucune illustration
// matricielle d'article et n'utilise pas next/image. Reprendre la palette « leçon premium » (fond
// bleu nuit, vert sauge, bleu pâle, blanc cassé, touche orange) donne aux deux leçons les plus
// développées du catalogue une même identité visuelle, sans redessiner les autres cartes.
//
// Concept, distinct de SavingsIllustration : un escalier de SEPT marches régulières (une par
// règle), gravi par petits pas constants plutôt qu'un bond — la discipline et la régularité, pas
// la précipitation — surmonté d'un repère en forme de boussole (rappel de la règle « regardez
// l'avenir, pas uniquement le passé »).

import { useId } from "react";
import "./lesson-savings-illustration.css";

const STEP_WIDTHS = [46, 58, 70, 82, 94, 106, 118];
const STEP_HEIGHT = 30;
const STEP_GAP = 6;
const BASE_X = 300;
const BASE_Y = 742;

export function InvestingRulesIllustration({ variant, label }: { variant: "hero" | "card"; label: string }) {
  const raw = useId().replace(/:/g, "");
  const id = (suffix: string) => `${raw}-${suffix}`;

  const steps = STEP_WIDTHS.map((width, index) => {
    const x = BASE_X + index * 132;
    const y = BASE_Y - index * (STEP_HEIGHT + STEP_GAP);
    return { x, y, width };
  });
  const last = steps[steps.length - 1];
  const markerX = last.x + last.width / 2;
  const markerY = last.y - 26;

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
          Sur un fond bleu nuit, un escalier de sept marches régulières monte vers la droite, gravi
          par petits pas constants. Un repère en forme de boussole surplombe la dernière marche.
        </desc>

        <defs>
          <linearGradient id={id("sky")} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#0A1720" />
            <stop offset="58%" stopColor="#0D2029" />
            <stop offset="100%" stopColor="#102A31" />
          </linearGradient>
          <radialGradient id={id("glow")} cx="0.5" cy="0.5" r="0.5">
            <stop offset="0%" stopColor="#67B88A" stopOpacity="0.24" />
            <stop offset="55%" stopColor="#67B88A" stopOpacity="0.06" />
            <stop offset="100%" stopColor="#67B88A" stopOpacity="0" />
          </radialGradient>
          <linearGradient id={id("frost")} x1="0" y1="0" x2="0.3" y2="1">
            <stop offset="0%" stopColor="#A9D9BD" stopOpacity="0.62" />
            <stop offset="100%" stopColor="#8EB9D6" stopOpacity="0.22" />
          </linearGradient>
          <linearGradient id={id("frostStrong")} x1="0" y1="0" x2="0.3" y2="1">
            <stop offset="0%" stopColor="#F4F6F2" stopOpacity="0.85" />
            <stop offset="100%" stopColor="#67B88A" stopOpacity="0.45" />
          </linearGradient>
        </defs>

        <rect width="1600" height="900" fill={`url(#${id("sky")})`} />
        <circle cx="1120" cy="420" r="540" fill={`url(#${id("glow")})`} />

        {/* Boussole : repère de direction, au-dessus de la dernière marche */}
        <g transform={`translate(${markerX} ${markerY - 96})`} stroke="#A9D9BD" strokeOpacity="0.4" fill="none">
          <circle r="46" strokeWidth="1.6" />
          <circle r="46" strokeWidth="1" strokeDasharray="2 9" strokeOpacity="0.6" />
          <path d="M0 -30 L9 -6 L0 4 L-9 -6 Z" fill="#E5A45A" fillOpacity="0.85" stroke="none" />
        </g>

        {/* Escalier de sept marches, régulières */}
        {steps.map((step, index) => (
          <rect
            key={index}
            x={step.x}
            y={step.y}
            width={step.width}
            height={STEP_HEIGHT}
            rx="10"
            fill={index === steps.length - 1 ? `url(#${id("frostStrong")})` : `url(#${id("frost")})`}
            fillOpacity={0.55 + index * 0.06}
          />
        ))}

        {/* Petits pas constants au sol, sous l'escalier — régularité plutôt que précipitation */}
        <g fill="#8EB9D6" fillOpacity="0.3">
          {[0, 1, 2, 3].map((step) => (
            <circle key={step} cx={BASE_X - 90 + step * 40} cy={BASE_Y + 24} r="5" />
          ))}
        </g>

        {/* Marqueur au sommet de la dernière marche */}
        <circle cx={markerX} cy={markerY} r="15" fill="#E5A45A" fillOpacity="0.12" />
        <circle cx={markerX} cy={markerY} r="7" fill="#E5A45A" />
      </svg>
    </div>
  );
}
