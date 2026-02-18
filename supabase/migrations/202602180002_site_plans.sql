create table if not exists public.site_plans (
  category text primary key,
  sites jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.site_plans enable row level security;

create policy "site_plans_read_all"
  on public.site_plans for select
  using (true);

insert into public.site_plans (category, sites)
values
  ('office', '["staples","officedepot","quill","amazon_business","walmart_business","uline","target"]'::jsonb),
  ('electronics', '["amazon","bestbuy","newegg","bhphotovideo","walmart","adorama","microcenter","ebay"]'::jsonb),
  ('restaurant', '["webstaurantstore","katom","centralrestaurant","therestaurantstore","restaurantdepot","ace_mart"]'::jsonb),
  ('electrical', '["grainger","zoro","homedepot","platt","cityelectricsupply","lowes","mcmaster"]'::jsonb),
  ('unknown', '["amazon","walmart","bestbuy","target","ebay","newegg"]'::jsonb)
on conflict (category) do update
set sites = excluded.sites,
    updated_at = now();
