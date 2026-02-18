# SupplyFlare AGENTS Guide

## Build Objective
Ship a production-grade MVP that prioritizes speed and resilience over perfect scrape coverage.

## Non-Negotiables
- Keep `CACHE_TTL_SECONDS` defaulted to `0` (off).
- Always return per-site status (`ok`, `blocked`, `not_found`, `error`, `unsupported_js`, `cached`).
- Never hide blocked/failure sites; partial results are expected.
- Keep shipping/tax disclaimer visible in result UI.
- Avoid headless browser tooling in v1.

## Architecture
- Next.js App Router handles UI, auth pages, and orchestration.
- Rust Vercel Functions in `api/*.rs` perform high-parallel quote scraping.
- Supabase stores quote runs, per-site results, and optional cache.

## Deployment Constraints
- Vercel-compatible Rust only (`vercel_runtime = "2"`, bins in root `Cargo.toml`).
- Ensure env vars are documented and mirrored in Vercel project settings.
- CI must run both Next.js checks and Rust checks.

## Safety
- Treat all scrape outputs as best-effort signals.
- Be explicit in UI that results may be incomplete or outdated.
