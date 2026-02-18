insert into public.site_catalog (site, category, domain, search_url_template, enabled, priority)
values ('google_shopping', 'unknown', 'google.com', 'https://www.google.com/search?tbm=shop&q={q}', true, 25)
on conflict (site) do update
set category = excluded.category,
    domain = excluded.domain,
    search_url_template = excluded.search_url_template,
    enabled = excluded.enabled,
    priority = least(public.site_catalog.priority, excluded.priority),
    updated_at = now();

update public.site_plans
set sites = (
  select to_jsonb(array(
    select distinct value
    from (
      select jsonb_array_elements_text(public.site_plans.sites) as value
      union all
      select 'google_shopping'
    ) s
  ))
), updated_at = now()
where category in ('electronics', 'unknown');
