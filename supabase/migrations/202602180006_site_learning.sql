alter table public.site_catalog
  add column if not exists reliability_score numeric not null default 0.62,
  add column if not exists block_rate numeric not null default 0.35,
  add column if not exists avg_latency_ms integer not null default 2200,
  add column if not exists runs_count integer not null default 0,
  add column if not exists success_count integer not null default 0,
  add column if not exists blocked_count integer not null default 0,
  add column if not exists unsupported_count integer not null default 0,
  add column if not exists error_count integer not null default 0,
  add column if not exists not_found_count integer not null default 0,
  add column if not exists click_count integer not null default 0,
  add column if not exists open_result_count integer not null default 0,
  add column if not exists open_listing_count integer not null default 0,
  add column if not exists last_seen_at timestamptz;

create table if not exists public.quote_interactions (
  id uuid primary key default gen_random_uuid(),
  run_id uuid,
  user_id uuid references auth.users(id) on delete set null,
  action text not null check (action in ('open_result', 'open_listing')),
  site text not null,
  query text,
  target_url text,
  created_at timestamptz not null default now()
);

alter table public.quote_interactions enable row level security;

create policy "quote_interactions_select_own"
  on public.quote_interactions for select
  using (auth.uid() = user_id);

create policy "quote_interactions_insert_own"
  on public.quote_interactions for insert
  with check (auth.uid() = user_id);
