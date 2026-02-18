create table if not exists public.query_intent_site_stats (
  cluster_key text not null,
  site text not null,
  runs_count integer not null default 0,
  success_count integer not null default 0,
  blocked_count integer not null default 0,
  unsupported_count integer not null default 0,
  error_count integer not null default 0,
  not_found_count integer not null default 0,
  avg_latency_ms integer not null default 2200,
  last_seen_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (cluster_key, site)
);

create index if not exists query_intent_site_stats_cluster_idx
  on public.query_intent_site_stats (cluster_key);

alter table public.query_intent_site_stats enable row level security;

create policy "query_intent_site_stats_read_all"
  on public.query_intent_site_stats for select
  using (true);
