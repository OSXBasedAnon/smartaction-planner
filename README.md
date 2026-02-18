# SupplyFlare MVP

SupplyFlare is a Vercel-deployable procurement quote MVP built with:
- Next.js App Router (frontend + orchestration routes)
- Vercel Rust Functions (parallel scrape engine)
- Supabase (auth + DB + RLS)
- GitHub Actions (CI + scraper health checks)

## Features
- Input modes: free text, single SKU, CSV upload (`query,qty`)
- Pipeline: input -> AI parse/category routing -> site plan -> Rust parallel scrape -> partial streaming UI updates
- Resilience: per-site timeout, blocked/not-found/error reporting, partial returns
- Auth: Supabase email/password
- Persistence: quote runs + per-site results + optional short TTL cache

## Repo Layout
- `app/` Next.js App Router pages/routes
- `components/` UI components
- `lib/` parser, site routing, Supabase helpers
- `api/quote.rs` Rust JSON quote endpoint
- `api/quote_stream.rs` Rust SSE-style event endpoint
- `api/shared.rs` Rust scraping/shared logic
- `config/site-plans.json` category -> site plans
- `supabase/migrations/` SQL schema + RLS
- `.github/workflows/` CI and scheduled health checks

## Environment Variables (Vercel)
Set all in Vercel Project Settings -> Environment Variables:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (or `NEXT_PUBLIC_SUPABASE_ANON_KEY`)
- `SUPABASE_SECRET_KEY` (or `SUPABASE_SERVICE_ROLE_KEY`, server only)
- `GEMINI_API_KEY`
- `CACHE_TTL_SECONDS` (default `0`)
- `CRON_SECRET`
- `APP_BASE_URL` (e.g. `https://supplyflare.vercel.app`)

## Supabase Setup
1. Create a Supabase project.
2. In SQL Editor, run migration file:
   - `supabase/migrations/202602180001_init.sql`
3. In Authentication -> Providers, keep Email enabled.
4. Copy URL, anon key, and service role key into Vercel env vars.

## Local Dev
1. Install dependencies:
```bash
pnpm install
```
2. Create `.env.local`:
```bash
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=...
SUPABASE_SECRET_KEY=...
GEMINI_API_KEY=...
CACHE_TTL_SECONDS=0
CRON_SECRET=...
APP_BASE_URL=http://localhost:3000
```
3. Run app:
```bash
pnpm dev
```
4. Run checks:
```bash
pnpm lint
pnpm test
pnpm typecheck
cargo check --bins
```

## Vercel Deploy (Git Integration)
1. Push repo to GitHub (`supplyflare-com`).
2. In Vercel, import the GitHub repo.
3. Add all env vars listed above.
4. Deploy.
5. Verify:
- `/` loads and can run quote stream
- `/signup` and `/login` work
- `/app/history` shows user-specific runs
- `/api/health?secret=...` returns `{ ok: true, ... }`

## GitHub Actions
- `ci.yml`: lint/test/typecheck/build + cargo check/test
- `scraper-health.yml`: every 6 hours calls `/api/health` with `CRON_SECRET`

## Notes
- Scraping is best-effort and may be blocked by anti-bot systems.
- UI always states that pricing may exclude shipping/tax.
- `CACHE_TTL_SECONDS=0` means no cache reads/writes by design.
