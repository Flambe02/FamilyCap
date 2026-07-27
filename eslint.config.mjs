import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Fonctions Edge Supabase : code DENO, hors du projet Next. Les règles Next (et la
    // résolution des types) n'y ont pas de sens — `Deno.serve` y est un global légitime.
    "supabase/functions/**",
  ]),
]);

export default eslintConfig;
