update public.site_plans
set sites = '["amazon","newegg","bestbuy","ebay","target","microcenter"]'::jsonb,
    updated_at = now()
where category = 'electronics';

update public.site_plans
set sites = '["grainger","zoro","homedepot","platt","lowes","mcmaster"]'::jsonb,
    updated_at = now()
where category = 'electrical';

update public.site_plans
set sites = '["webstaurantstore","katom","centralrestaurant","amazon","ebay"]'::jsonb,
    updated_at = now()
where category = 'restaurant';

update public.site_catalog
set enabled = false,
    updated_at = now()
where site in ('bhphotovideo', 'adorama', 'walmart', 'walmart_business', 'restaurantdepot', 'therestaurantstore', 'cityelectricsupply');
