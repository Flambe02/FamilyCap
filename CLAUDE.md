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
| Alpha Vantage | Stock/ETF symbol search & prices | Yes |

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
- `ANTHROPIC_API_KEY` **or** `OPENAI_API_KEY` — enables the AI statement scan (`/api/investment-imports/scan`). Server-only, never `NEXT_PUBLIC_*`. Optional tuning: `DOCUMENT_AI_PROVIDER` (`anthropic`|`openai`|`none`), `DOCUMENT_AI_MODEL`, `DOCUMENT_AI_MAX_PAGES`, `DOCUMENT_AI_MAX_FILE_SIZE_MB`, `DOCUMENT_AI_HIGH_CONFIDENCE`, `DOCUMENT_AI_LOW_CONFIDENCE`. Without a key the scan is disabled (503) and CSV/XLSX import + manual entry still work. The AI only extracts raw fields with confidence; every number is re-validated deterministically server-side (`lib/document-extraction/`), and the portfolio is still computed only by `computeAccountModel`. Files are processed transiently and never stored. `lib/document-extraction/provider.ts` is a provider abstraction — swap providers without touching the import flow.

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
- `/api/investment-imports` (GET list) · `/preview` (POST, dry-run) · `/commit` (POST, write) · `/[id]` (DELETE cancel) — CSV import of operations (admin only). Preview writes nothing; commit re-validates everything server-side and inserts atomically; cancel deletes only that batch's operations (never manual ones).
- `/api/admin/users` — member management
- `/api/admin/accounts` / `/api/admin/holdings` — multi-asset portfolio (admin); accounts support archive (`isActive`), `openedAt`, `monthlyTarget`; delete of an account holding operations requires `?force=true`
- `/api/admin/market` — Alpha Vantage symbol search
- `/api/supabase/status` — config ping / setup mode trigger

### Investment operations, imports & shared calculation engine

- **Single source of truth for the portfolio** is `lib/portfolio-account.ts` (`computeAccountModel`). Quantities, average cost (PMP), invested amount, income and performance are always **derived from `account_operations`** — never stored as editable totals. PEA and CTO are two `EnvelopeConfig` on one shared shell (`app/investment-account.tsx`).
- **Single source of truth for operation validation** is `lib/account-operation.ts` (`validateOperation` / `buildOperationRecord`), reused by the manual write route AND the import commit — never reimplement the per-type rules elsewhere.
- **Import engine** `lib/investment-import.ts` is pure and format-agnostic (input is always `string[][]`): CSV parsing (delimiter/quote/BOM), FR/EN header auto-mapping, comma/point decimals, FR/US/ISO dates, ISIN Luhn check, instrument matching against `holdings`, FNV-1a fingerprint dedup, and CSV-formula-injection sanitization. XLSX and the AI scan plug into the same `buildPreview` pipeline. Server context (existing fingerprints, opening quantities, advanced-migration detection) lives in `lib/investment-import-server.ts`.
- **Import batches** (`investment_import_batches`, migration 20260726) make every import traceable and **cancellable**: cancelling deletes only the operations carrying that `import_batch_id` (manual operations have it null) and marks the batch `cancelled`, then the engine recomputes positions.

### Access model (family sharing) — ENFORCED

`investment_access_scope` (`family` | `selected`) on `family_members` + `investment_access_grants` (owner→viewer) define who may see whose investments. The SQL function `can_view_member_investments()` is the RLS-level rule; **the real boundary is in application code**: `lib/auth-server.ts::viewableMemberIds()` replicates it because server routes use the service-role key and bypass RLS. Admin → all family; member → self + members shared `family` + explicit grants; **fail-closed** (self only) if the sharing tables are missing. `/api/portfolio` already applies this filter, and the PEA/CTO shell further restricts a member's view to their own accounts.

### Roles for accounts & operations (this version)

- **Admin**: create / edit / archive accounts; add / edit / delete / import operations; cancel an import. Enforced in UI **and** in every write route (`requireAdmin`).
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
