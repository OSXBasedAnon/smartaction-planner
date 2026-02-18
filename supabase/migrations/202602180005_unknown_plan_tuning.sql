update public.site_plans
set sites = '["amazon","target","ebay"]'::jsonb,
    updated_at = now()
where category = 'unknown';
