create table if not exists public.site_catalog (
  site text primary key,
  category text not null,
  domain text not null,
  search_url_template text not null,
  enabled boolean not null default true,
  priority integer not null default 100,
  updated_at timestamptz not null default now()
);

alter table public.site_catalog enable row level security;

create policy "site_catalog_read_all"
  on public.site_catalog for select
  using (true);

insert into public.site_catalog (site, category, domain, search_url_template, enabled, priority)
values
  ('amazon', 'electronics', 'amazon.com', 'https://www.amazon.com/s?k={q}', true, 10),
  ('bestbuy', 'electronics', 'bestbuy.com', 'https://www.bestbuy.com/site/searchpage.jsp?st={q}', true, 20),
  ('newegg', 'electronics', 'newegg.com', 'https://www.newegg.com/p/pl?d={q}', true, 30),
  ('bhphotovideo', 'electronics', 'bhphotovideo.com', 'https://www.bhphotovideo.com/c/search?q={q}', true, 40),
  ('walmart', 'electronics', 'walmart.com', 'https://www.walmart.com/search?q={q}', true, 50),
  ('adorama', 'electronics', 'adorama.com', 'https://www.adorama.com/l/?searchinfo={q}', true, 60),
  ('microcenter', 'electronics', 'microcenter.com', 'https://www.microcenter.com/search/search_results.aspx?Ntt={q}', true, 70),
  ('ebay', 'electronics', 'ebay.com', 'https://www.ebay.com/sch/i.html?_nkw={q}', true, 80),
  ('staples', 'office', 'staples.com', 'https://www.staples.com/{q}/directory_{q}', true, 10),
  ('officedepot', 'office', 'officedepot.com', 'https://www.officedepot.com/a/search/?q={q}', true, 20),
  ('quill', 'office', 'quill.com', 'https://www.quill.com/search?keywords={q}', true, 30),
  ('uline', 'office', 'uline.com', 'https://www.uline.com/BL_35/Search?keywords={q}', true, 40),
  ('grainger', 'electrical', 'grainger.com', 'https://www.grainger.com/search?searchQuery={q}', true, 10),
  ('zoro', 'electrical', 'zoro.com', 'https://www.zoro.com/search?q={q}', true, 20),
  ('homedepot', 'electrical', 'homedepot.com', 'https://www.homedepot.com/s/{q}', true, 30),
  ('platt', 'electrical', 'platt.com', 'https://www.platt.com/search.aspx?q={q}', true, 40),
  ('cityelectricsupply', 'electrical', 'cityelectricsupply.com', 'https://www.cityelectricsupply.com/search?text={q}', true, 50),
  ('lowes', 'electrical', 'lowes.com', 'https://www.lowes.com/search?searchTerm={q}', true, 60),
  ('mcmaster', 'electrical', 'mcmaster.com', 'https://www.mcmaster.com/products/{q}/', true, 70)
on conflict (site) do update
set category = excluded.category,
    domain = excluded.domain,
    search_url_template = excluded.search_url_template,
    enabled = excluded.enabled,
    priority = excluded.priority,
    updated_at = now();
