# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**LaBaJo & Co** ("l'école financière de la famille") — private Bitcoin portfolio tracker for a family. Admin manages gifts; children view their own portfolios.

**Tech stack:** Next.js 16 (App Router), React 19, TypeScript 5.9, Tailwind CSS 4, Supabase (PostgreSQL + Auth).

## Commands

```bash
# All commands run from Cryptos Kids/web/
npm run dev        # Dev server on port 3000
npm run build      # Production build
npm start          # Production server
npm test           # Anti-regression test (run after build)
npm run lint       # ESLint
npx tsc --noEmit   # Type-check without building
```

**Dev workflow:** Use `?preview=dashboard` in URL to bypass auth on localhost. OneDrive sync can cause stale HMR — restart `npm run dev` if CSS changes don't appear.

## Architecture

### Single-Route SPA inside Next.js
The app navigates entirely via React state, **not URL routes**:
- `app/page.tsx` → `<AuthShell />` → `<FamilyDashboard />`
- Screen switching: `view` state in `family-dashboard.tsx`
- No deep linking — refresh always returns to home

### Roles & Authorization
- `admin` (Florent, unique) — full access
- `adult` / `child` — view own portfolio, request transfers
- `viewer` (Amatxi/grandmother) — intended as read-only; **not currently enforced as a dedicated read-only role by the API** (see Known Security Gaps below)

**All API routes call `lib/auth-server.ts`** → `requireFamilyMember()` or `requireAdmin()`. This reads the bearer token, verifies with Supabase Auth, then re-reads role from `family_members` on every call. Row Level Security exists in Supabase but is **bypassed** — `lib/auth-server.ts` is the real security boundary.

### Key files
| File | Role |
|------|------|
| `app/family-dashboard.tsx` | Main shell, sidebar nav, screen routing |
| `app/gift-portfolio.tsx` | Portfolio view (admin full / member mobile) |
| `app/transactions.tsx` | Gift + blockchain history |
| `app/administration.tsx` | Admin panel (5 sub-tabs) |
| `app/settings.tsx` | User & security settings |
| `lib/auth-server.ts` | Authorization entry point for all API routes |
| `lib/gift-history.ts` | Frozen historical gift data (pre-Supabase fallback) |
| `supabase/migrations/` | 12 manual SQL migrations (applied via Supabase SQL Editor) |

### Gift lifecycle
1. **"À rapprocher"** — not yet classified
2. **"Binance commun"** — purchase identified, awaiting Ledger transfer
3. **"Ledger"** — locks the gift (cannot be edited/deleted). Ledger is currently a custody state: the application locks a gift when `custody === "Ledger"`, even if no verified TxID is present. Do not treat this state alone as proof of blockchain confirmation.

### External integrations
| Service | Purpose | Optional? |
|---------|---------|-----------|
| Blockstream Esplora | Bitcoin balance/TX verification | No |
| CoinGecko → Kraken fallback | BTC/EUR price | No |
| Resend | Email alerts on transfer requests | Yes |
| Yahoo Finance → Stooq fallback | Stock/ETF quotes (`lib/market-quotes.ts`) — **free, no API key** | No |
| Alpha Vantage | Legacy symbol search in `/api/admin/market` only | Yes |

## Critical Constraints

### Mobile-only responsive work
**Never modify desktop layout** when doing mobile/responsive work. Breakpoint is `max-width: 780px`. All mobile-specific changes must be scoped to that breakpoint.

### Gift write paths
`InvestmentModal` (quick-add flow) and the Portfolio's `GiftEditor` both persist for real: both call `saveGift()` (`lib/gifts-client.ts`), which POSTs/PATCHes `/api/gifts` (Supabase `gift_records`). Neither is local-state-only — verified against current code 2026-07-21. Only the "Activité récente"/"Dernières opérations" activity feed in `family-dashboard.tsx` is session-local (seeded with one hardcoded row, never fetched from an API); don't mistake that for the gift write path itself.

### Hard-coded member lists
5 children are hard-coded in multiple files (`family-dashboard.tsx`, `gift-portfolio.tsx`, `transactions.tsx`, `administration.tsx`, `amatxi-report.tsx`). These have already diverged (e.g., Aurore's birthday). Fix the source table, not the UI constants.

### Frozen historical data merge
`lib/gift-history.ts` holds gifts since Dec 2022. Multiple screens merge this with live Supabase data (Supabase takes precedence for same member|occasion|year). This merge logic is duplicated across screens.

## Known Security Gaps (Step 1 audit)

- ~~**`POST /api/transfer-requests` fail-open**~~: **Fixed** — the route is now fail-closed. When Supabase is not configured it returns `503` before any side effect (no DB write, no Resend email); every accepted request is authenticated via `requireFamilyMember()`.
- **Admin preview is UI-only**: the admin member preview is UI-only. API calls still use the real admin Supabase token and retain admin permissions. Hidden buttons are not a server-side read-only guarantee.
- ~~**Partage familial not enforced**~~: **Fixed** — `investment_access_scope` / `investment_access_grants` are now enforced in application code via `lib/auth-server.ts::viewableMemberIds()`, applied by `/api/portfolio` (and mirrored by the SQL `can_view_member_investments()` for direct access). The filter is fail-closed (self only) when the sharing tables are absent. See "Access model (family sharing) — ENFORCED" above. PEA/CTO data can be exposed to members within this shared scope.
- **`viewer` role**: not currently enforced as a dedicated read-only role by the API, and the Amatxi screen remains admin-only.

Details: `docs/audit-etape1-technique-fonctionnel.md` §9, §10, §14, §23.

## Environment Variables

See `.env.example`. Required:
- `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`

Optional:
- `RESEND_API_KEY`, `ALERT_EMAIL_FROM`, `ALERT_EMAIL_TO` — email alerts
- `ALPHA_VANTAGE_API_KEY` — market data
- `ANTHROPIC_API_KEY` **or** `OPENAI_API_KEY` — enables the AI statement scan (`/api/investment-imports/scan`), including the Boursobank screenshot import. Server-only, never `NEXT_PUBLIC_*`. Optional tuning: `DOCUMENT_AI_PROVIDER` (`anthropic`|`openai`|`none`), `DOCUMENT_AI_MODEL`, `DOCUMENT_AI_MAX_PAGES`, `DOCUMENT_AI_MAX_FILE_SIZE_MB`, `DOCUMENT_AI_HIGH_CONFIDENCE`, `DOCUMENT_AI_LOW_CONFIDENCE`. Without a key the scan is disabled (503) and CSV/XLSX import + manual entry still work. The AI only extracts raw fields with confidence; every number is re-validated deterministically server-side (`lib/document-extraction/`), and the portfolio is still computed only by `computeAccountModel`. Files are processed transiently and never stored. `lib/document-extraction/provider.ts` is a provider abstraction — swap providers without touching the import flow.

**Note:** The Supabase URL and anon/publishable key are currently hard-coded in `lib/supabase-browser.ts` (no `NEXT_PUBLIC_*` vars). These values are public by nature, but this remains technical debt because it prevents clean environment separation between development, staging, and production.

## API Routes Summary

All routes under `app/api/`:
- `/api/auth/me` — current viewer from JWT
- `/api/gifts` — gift CRUD (admin write, member read-own)
- `/api/ledger` — Bitcoin wallet balances (Blockstream)
- `/api/ledger-transfers` — reconcile TxID with gifts, pro-rata split
- `/api/blockchain/verify` — verify TxID credited amount
- `/api/transfer-requests` — child→admin requests + email
- `/api/investment-access` — sharing preferences
- `/api/portfolio` — read accounts + holdings + operations for the viewer (filtered by `viewableMemberIds`)
- `/api/pea/operations` — **generic** operation write for PEA **and** compte-titres (admin write). Name is historical; do not rename without updating callers. Server guards: account exists / type is `pea`\|`securities` / not archived / (PEA) no sell beyond held quantity. `member_id` is derived from the account, never trusted from the client.
  - `POST` create · `PATCH` **edit an existing operation** (account and `member_id` are immutable; the PEA sell guard is replayed *excluding* the edited row; `import_fingerprint` is nulled since it no longer describes the content) · `DELETE` with `?id=`, `?ids=a,b,c` (a whole position), or `?accountId=…&scope=all&confirm=<exact account name>` (empty the account — the confirmation string is enforced **server-side**, not just in the UI).
- `/api/investment-imports` (GET list) · `/preview` (POST, dry-run) · `/commit` (POST, write) · `/[id]` (DELETE cancel) — CSV import of operations (admin only). Preview writes nothing; commit re-validates everything server-side and inserts atomically; cancel deletes only that batch's operations (never manual ones).
  - `/commit` accepts `replaceExisting` + `replaceConfirm` (exact account name) to **replace the whole portfolio**. Write order is deliberately *insert new, then delete the previously-captured ids*: a failure leaves recoverable duplicates, never data loss.
- `/api/admin/market/refresh` — POST `{accountId}` (admin). Re-reads each **derived** position's price from a free provider and writes only `last_price` / `last_price_at` / `market_provider` (never a quantity or cost basis). Creates the missing `holdings` reference row for a held position that has none — that is what unblocks "Cours indispo.". Reports `not_found` / `currency_mismatch` per instrument instead of writing a doubtful price.
- `/api/admin/users` — member management
- `/api/admin/accounts` / `/api/admin/holdings` — multi-asset portfolio (admin); accounts support archive (`isActive`), `openedAt`, `monthlyTarget`; delete of an account holding operations requires `?force=true`
- `/api/admin/market` — Alpha Vantage symbol search
- `/api/supabase/status` — config ping / setup mode trigger

### Investment operations, imports & shared calculation engine

- **Single source of truth for the portfolio** is `lib/portfolio-account.ts` (`computeAccountModel`). Quantities, average cost (PMP), invested amount, income and performance are always **derived from `account_operations`** — never stored as editable totals. PEA and CTO are two `EnvelopeConfig` on one shared shell (`app/investment-account.tsx`).
- **Single source of truth for operation validation** is `lib/account-operation.ts` (`validateOperation` / `buildOperationRecord`), reused by the manual write route AND the import commit — never reimplement the per-type rules elsewhere.
- **An asset's identity is SELECTED, never composed field by field** (migration 20260811). The modal's four free-text inputs (Nom / Ticker / ISIN / Devise) are gone: `app/asset-search-field.tsx` searches, the user picks **one cotation**, and that choice locks name, type, ticker, venue, MIC, currency and ISIN together. This is what makes the old failure mode (`ticker CW8` + an unrelated ISIN) unrepresentable — previously identity was *inferred after the fact* by `instrumentKey()` (ISIN → else ticker → else name, `lib/portfolio-account.ts:179`), so two contradictory references produced a plausible-looking key that nothing downstream could untangle.
  - Catalog: `assets` (canonical instrument, unique on ISIN) + `asset_listings` (cotation: venue, MIC, currency, `eodhd_symbol`, `yahoo_symbol`, unique on `asset_id+MIC+currency+ticker`). `holdings` **cannot** play this role — it is `account_id NOT NULL`, hence duplicated per account, while `market_quotes` is keyed globally.
  - `account_operations.asset_id` / `.listing_id` are **nullable by design**: historical and imported operations keep working untouched, and no automatic back-matching is performed (§13 — never silently rewrite a financial row).
  - Pure logic in `lib/asset-catalog.ts` (normalisation, dedup by identity, ranking, `mergeClassification`); Supabase + provider access in `lib/asset-catalog-server.ts`; venue table in `lib/market-venues.ts` (**explicit** — outside it, no currency is assumed).
  - Search order: catalog → held in this account → recently used → provider. The provider is only called when local results are insufficient. `searchInstruments()` returns **three states**: hits, `[]` (provider answered, nothing matches → "Aucun actif coté trouvé"), `null` (provider silent → "recherche indisponible"). Conflating the last two sends users to correct a query that was already right.
  - **Classification never depends on quote availability.** `mergeClassification` refuses to downgrade a known type to `other`, and an admin `verified` correction is immutable.
  - Server routes rewrite `assetName`/`ticker`/`isin`/`currency` from the resolved cotation (`applySelection`), so a forged request body cannot reintroduce a mismatched pair. A client can never self-declare `verified`.
  - Quote sync prefers the selected listing's symbols over anything deduced from the name (`/api/market-data/refresh`), but never over an existing admin `verified` row.
  - Verification: `node --env-file=.env.local scripts/verify-operation-modal.mjs` drives the real modal with **real** provider results (only auth is stubbed) and asserts 26 checks. Tests: `tests/asset-catalog.test.mjs`, `tests/asset-selection-guards.test.mjs`.
  - Known limit: the provider does not return ISIN on a name/ticker search, so those results display "ISIN non communiqué" until the instrument enters the catalog. Searching by ISIN always yields it. **No "Éligible PEA" badge is shown** — no source publishes it reliably, and deducing it from country is wrong for synthetic ETFs.
- **Import engine** `lib/investment-import.ts` is pure and format-agnostic (input is always `string[][]`): CSV parsing (delimiter/quote/BOM), FR/EN header auto-mapping, comma/point decimals, FR/US/ISO dates, ISIN Luhn check, instrument matching against `holdings`, FNV-1a fingerprint dedup, and CSV-formula-injection sanitization. XLSX and the AI scan plug into the same `buildPreview` pipeline. Server context (existing fingerprints, opening quantities, advanced-migration detection) lives in `lib/investment-import-server.ts`.
- **Decimal separator is a property of the FILE, never of a cell.** `81,023` means 81.023 in an FR file and 81023 in a US one. Resolving that per-cell is what once multiplied every 3-decimal price by 1000 (a €58k position displayed as €58M). `detectNumberFormat()` decides per file from *unambiguous* evidence only, `parseDecimal(value, format)` takes the decision as a parameter, and the wizard always shows the choice for correction before anything is written. Two arithmetic cross-checks back it up: `amountCoherenceWarning()` (amount ≈ quantity × price) and, for a positions statement, `derivedPrice` = valuation ÷ quantity — a contradicted price is flagged and the recomputed one offered, never applied silently. Regression tests: `tests/investment-import.test.mjs`, `tests/portfolio-snapshot-import.test.mjs`.
- **Currency conversion is ECB-only and lives in exactly one file.** `lib/fx-rates.ts` owns the formula; nothing else may compute a conversion. The ECB quotes **EUR as the base** (`1 EUR = 1.1377 USD`), so converting *into* euros is a **division**: `amount_eur = amount_usd / rate`. Multiplying instead inflates a portfolio by ~29 % with nothing visibly broken — hence the test file dedicated to direction. Table `fx_rates` (migration 20260809, PK `base_currency, quote_currency, rate_date`, read-only for `authenticated`), fed by the Edge Function `supabase/functions/sync-fx-rates` (cron 18:00 UTC Mon–Fri) or by `POST /api/admin/fx` (admin, same rows, idempotent upsert). Fallback rule: most recent rate with `rate_date <= asOf` — a Saturday uses Friday's, a holiday uses the previous business day; past 7 days the rate is still applied but flagged "Taux du JJ/MM"; only a table that has *never* been fed shows "Conversion indisponible". `computeAccountModel` takes an optional `fxRateAt(currency, date)` resolver used **only** when the operation carries no `exchange_rate` — a recorded rate is historical data and always wins. Purchases predating the first collected rate are converted at the oldest known rate and labelled as an approximation under the table (`fallbackToEarliest`). The legacy `market_fx_rates` table (native→reference, opposite convention) is still read as a fallback and re-expressed in EUR base by `loadLegacyFxRates()`.
- **Quotes are not file data.** A price coming from an imported statement is stale by construction. `lib/market-quotes.ts` re-reads it from a free, keyless provider (Yahoo Finance, Stooq fallback), resolving ISIN → symbol. Two hard rules: a quote whose **currency differs from the position's** is reported, never written (there is no FX engine — `fxImpactEur` is still null); and a cross-listing found by probing venues is accepted only if `sameInstrument()` passes **both** a name-overlap and a price-ratio check — probing `AMZN` on European venues otherwise returns "LS 1x Amazon Tracker ETP" at €6.27 instead of Amazon at $232.
- **Création d'un compte depuis l'écran PEA/CTO** : `app/investment-account-setup.tsx` est l'assistant ouvert par « Configurer un PEA / un compte-titres » (état vide + en-tête). Il écrit via `/api/admin/accounts` (`requireAdmin`) — pas de route parallèle — puis enchaîne sur la première opération ou l'assistant d'import. N° de compte et IBAN sont **tronqués aux 4 derniers caractères dans le navigateur** : la saisie complète n'est jamais transmise ni stockée.
- **Import batches** (`investment_import_batches`, migration 20260726) make every import traceable and **cancellable**: cancelling deletes only the operations carrying that `import_batch_id` (manual operations have it null) and marks the batch `cancelled`, then the engine recomputes positions.
- **Broker screenshot import** (`lib/document-extraction/`, mode `statement`) — a copy/pasted or uploaded capture of a broker's *Positions* screen. Pipeline, in order: SHA-256 of the file (duplicate capture detection) → `preprocess.ts` (EXIF rotate, upscale to ≥1600 px, light sharpen, **lossless** re-encode; `sharp` is optional and degrades to the original) → N parallel re-reads by the vision model with broker-aware prompts → **strict Zod contract** (`StatementExtractionSchema`; an invented key is reported, never absorbed) → `toStatement()` canonical statement → cell-by-cell consensus (`consensus.ts`, reused) → **deterministic accounting checks** (`runAccountingChecks`) → human validation screen → `/commit`, which **replays the checks and rebuilds the operations server-side**.
  - Broker recognition is **textual only** (`brokers.ts`): the model copies the on-screen labels verbatim into `document.detected_markers`, and weighted scoring decides in code. Never colour, never logo. Generic labels (`Cours`, `Montant`…) weigh 0.5 and can't reach the threshold alone.
  - **Cost basis is `market_value − unrealized_gain`, never `quantity × displayed average cost`** — the broker rounds the displayed cost (360 × 87,83 = 31 618,80 ≠ 31 618,69). It travels as the operation's `gross_amount` (`operationAmountFields`), which `computeAccountModel` reads as-is.
  - A capture becomes **`correction` operations** (quantity + cost, cash-neutral) dated at the *snapshot date* — never fake buys, and never dated at "Dernier Mvt" (kept in the note). The cash balance becomes one `versement`; **"Cumul des versements" is deliberately NOT imported** (it would double-count against existing deposits and inflate cash) — it is kept as statement metadata for reconciliation.
  - `holdings` stays a **price reference**: an import writes `quantity: 0` and only ever updates `last_price` / `last_price_at` / `market_provider`. There is no second positions table. Regression-tested in `tests/statement-to-operations.test.mjs`.
  - Migration 20260808 adds `commit_investment_import()`, a **transactional RPC** (batch + instruments + operations in one transaction). Without it the route falls back to the historical sequential write and reports `atomic: false`.

### Access model (family sharing) — ENFORCED

`investment_access_scope` (`family` | `selected`) on `family_members` + `investment_access_grants` (owner→viewer) define who may see whose investments. The SQL function `can_view_member_investments()` is the RLS-level rule; **the real boundary is in application code**: `lib/auth-server.ts::viewableMemberIds()` replicates it because server routes use the service-role key and bypass RLS. Admin → all family; member → self + members shared `family` + explicit grants; **fail-closed** (self only) if the sharing tables are missing. `/api/portfolio` already applies this filter, and the PEA/CTO shell further restricts a member's view to their own accounts.

### Roles for accounts & operations (this version)

- **Admin**: create / edit / archive accounts; add / edit / delete / import operations; cancel an import; empty a portfolio; refresh quotes. Enforced in UI **and** in every write route (`requireAdmin`).
  - A **position is never edited directly** — it is derived. "Modify a position" means editing its operations (Positions tab › *Lignes*, or Historique › ✏️); "delete a position" deletes the operations that produced it. Destructive actions (delete a position, empty an account, replace a portfolio) require a confirmation the server re-checks.
- **Non-admin member**: read-only on the accounts they may see. Cannot create an account, record an operation, import a file, or cancel an import — enforced in the UI, the API routes, the server validations, and (as a safety net) the RLS policies. Accounts are **not** member-editable in this version.

## Known Dead Code

These exist but are unused — don't extend them:
- `app/back-office.tsx`, `app/ledger-live.tsx`, `app/chatgpt-auth.ts`
- `worker/`, `.wrangler/`, `.vinext/`, `db/`, `vite.config.ts` (Cloudflare/D1 scaffolding)

## Reference Docs

- `README.md` — full architecture + screen-by-screen functional spec (read before re-exploring)
- `docs/audit-etape1-technique-fonctionnel.md` — 35-section technical audit for the planned refonte
- `supabase/SETUP.md` — manual steps to activate a new Supabase project
- `docs/mobile-ux-redesign/` — UX audit with concrete fixes for Home/Portfolio/Transactions screens

**If anything in this file conflicts with `docs/audit-etape1-technique-fonctionnel.md`, the audit prevails** — it was produced through exhaustive code verification with file:line citations; this file is only a summary and may drift as the app evolves.
