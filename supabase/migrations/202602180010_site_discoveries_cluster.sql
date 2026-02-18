alter table public.site_discoveries
  add column if not exists cluster_key text;

create index if not exists site_discoveries_cluster_idx
  on public.site_discoveries (cluster_key);
