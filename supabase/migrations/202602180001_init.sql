-- SupplyFlare initial schema
create extension if not exists pgcrypto;

create table if not exists public.quote_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  input_type text not null check (input_type in ('text', 'sku', 'csv')),
  raw_input text not null,
  category text not null,
  site_plan jsonb not null,
  status text not null check (status in ('running', 'done', 'error')),
  duration_ms integer,
  created_at timestamptz not null default now()
);

create table if not exists public.quote_results (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.quote_runs(id) on delete cascade,
  item_index integer not null,
  site text not null,
  title text,
  price numeric,
  currency text,
  url text,
  status text not null,
  message text,
  latency_ms integer,
  created_at timestamptz not null default now()
);

create table if not exists public.price_cache (
  key text primary key,
  site text not null,
  query_hash text not null,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

create index if not exists quote_runs_user_created_idx on public.quote_runs(user_id, created_at desc);
create index if not exists quote_results_run_idx on public.quote_results(run_id, item_index);
create index if not exists price_cache_site_hash_idx on public.price_cache(site, query_hash);

alter table public.quote_runs enable row level security;
alter table public.quote_results enable row level security;

create policy "quote_runs_select_own"
  on public.quote_runs for select
  using (auth.uid() = user_id);

create policy "quote_runs_insert_own"
  on public.quote_runs for insert
  with check (auth.uid() = user_id);

create policy "quote_runs_update_own"
  on public.quote_runs for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "quote_results_select_own"
  on public.quote_results for select
  using (
    exists (
      select 1
      from public.quote_runs
      where quote_runs.id = quote_results.run_id
        and quote_runs.user_id = auth.uid()
    )
  );

create policy "quote_results_insert_own"
  on public.quote_results for insert
  with check (
    exists (
      select 1
      from public.quote_runs
      where quote_runs.id = quote_results.run_id
        and quote_runs.user_id = auth.uid()
    )
  );
