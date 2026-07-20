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

### Two write paths (known issue)
`InvestmentModal` (Add transaction flow) writes to **local React state only** — not persisted to the DB. The Portfolio editor writes to `/api/gifts`. Do not confuse the two.

### Hard-coded member lists
5 children are hard-coded in multiple files (`family-dashboard.tsx`, `gift-portfolio.tsx`, `transactions.tsx`, `administration.tsx`, `amatxi-report.tsx`). These have already diverged (e.g., Aurore's birthday). Fix the source table, not the UI constants.

### Frozen historical data merge
`lib/gift-history.ts` holds gifts since Dec 2022. Multiple screens merge this with live Supabase data (Supabase takes precedence for same member|occasion|year). This merge logic is duplicated across screens.

## Known Security Gaps (Step 1 audit)

- **`POST /api/transfer-requests` fail-open**: currently has a fail-open path when Supabase environment variables are missing or misnamed. In that case, it may accept an unauthenticated request and still send a real Resend email. Fix this before further production releases.
- **Admin preview is UI-only**: the admin member preview is UI-only. API calls still use the real admin Supabase token and retain admin permissions. Hidden buttons are not a server-side read-only guarantee.
- **Partage familial not enforced**: `investment_access_scope` and `investment_access_grants` exist in Supabase but are not enforced by current API read routes. Server-side API calls use the service-role key and bypass RLS. Do not expose PEA/CTO data to members until access rules are enforced in application code or through a JWT/RLS-based route.
- **`viewer` role**: not currently enforced as a dedicated read-only role by the API, and the Amatxi screen remains admin-only.

Details: `docs/audit-etape1-technique-fonctionnel.md` §9, §10, §14, §23.

## Environment Variables

See `.env.example`. Required:
- `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`

Optional:
- `RESEND_API_KEY`, `ALERT_EMAIL_FROM`, `ALERT_EMAIL_TO` — email alerts
- `ALPHA_VANTAGE_API_KEY` — market data

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
- `/api/admin/users` — member management
- `/api/admin/accounts` / `/api/admin/holdings` — multi-asset portfolio (admin)
- `/api/admin/market` — Alpha Vantage symbol search
- `/api/supabase/status` — config ping / setup mode trigger

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
