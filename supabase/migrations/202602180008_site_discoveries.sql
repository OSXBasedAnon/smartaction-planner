create table if not exists public.site_discoveries (
  id uuid primary key default gen_random_uuid(),
  run_id uuid,
  user_id uuid references auth.users(id) on delete set null,
  query text not null,
  source text not null default 'google_shopping',
  merchant_domain text not null,
  created_at timestamptz not null default now()
);

create index if not exists site_discoveries_query_idx
  on public.site_discoveries (query);

create index if not exists site_discoveries_domain_idx
  on public.site_discoveries (merchant_domain);

alter table public.site_discoveries enable row level security;

create policy "site_discoveries_select_own"
  on public.site_discoveries for select
  using (auth.uid() = user_id);

create policy "site_discoveries_insert_own"
  on public.site_discoveries for insert
  with check (auth.uid() = user_id);
