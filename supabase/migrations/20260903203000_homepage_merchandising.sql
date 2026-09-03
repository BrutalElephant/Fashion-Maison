-- Homepage merchandising, non-destructive and admin-controlled.
create table if not exists homepage_merchandising (id uuid primary key default gen_random_uuid(), store_id uuid references stores(id) on delete cascade, section_key text not null, enabled boolean not null default true, title text, subtitle text, primary_cta text, secondary_cta text, hero_product_id uuid references products(id) on delete set null, hero_image_path text, sort_order int not null default 0, product_ids uuid[] not null default '{}', updated_by uuid references profiles(id), updated_at timestamptz not null default now(), unique(store_id,section_key));
alter table homepage_merchandising enable row level security;
create policy "public can read enabled merchandising" on homepage_merchandising for select using (enabled=true);
create policy "admins manage merchandising" on homepage_merchandising for all using (public.is_admin()) with check (public.is_admin());
create index if not exists merchandising_section_order on homepage_merchandising(section_key,sort_order);
