-- Non-destructive Fashion Maison hardening migration.
-- Run in Supabase after supabase-schema.sql and checkout-migration.sql.
alter table products add column if not exists product_type text not null default 'ready_made';
alter table products add column if not exists brand text;
alter table products add column if not exists sku text;
alter table products add column if not exists attributes jsonb not null default '{}';
alter table products add column if not exists customizable boolean not null default false;
alter table products add column if not exists pre_order_price numeric(12,2);
alter table products add column if not exists pre_order_closes_at timestamptz;
alter table product_variants add column if not exists active boolean not null default true;
alter table inventory add column if not exists sold int not null default 0 check(sold>=0);
alter table inventory add column if not exists low_stock_threshold int not null default 2 check(low_stock_threshold>=0);
alter table orders add column if not exists tailoring_snapshot jsonb;
alter table orders add column if not exists idempotency_key text;

create table if not exists measurement_profiles (id uuid primary key default gen_random_uuid(), customer_id uuid not null references profiles(id) on delete cascade, name text not null, unit text not null check(unit in ('CM','INCHES')), measurements jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table if not exists custom_order_options (id uuid primary key default gen_random_uuid(), order_id uuid not null references orders(id) on delete cascade, measurement_profile_id uuid references measurement_profiles(id) on delete set null, unit text check(unit in ('CM','INCHES')), options jsonb not null default '{}', reference_image_paths jsonb not null default '[]', snapshot jsonb not null default '{}', created_at timestamptz not null default now());
create table if not exists audit_logs (id uuid primary key default gen_random_uuid(), actor_id uuid references profiles(id) on delete set null, action text not null, entity_type text not null, entity_id uuid, metadata jsonb not null default '{}', created_at timestamptz not null default now());
create index if not exists measurement_profiles_customer on measurement_profiles(customer_id);
create index if not exists audit_logs_entity on audit_logs(entity_type,entity_id,created_at desc);

alter table measurement_profiles enable row level security; alter table custom_order_options enable row level security; alter table audit_logs enable row level security;
create policy "customers own measurements" on measurement_profiles for all using (customer_id=auth.uid()) with check (customer_id=auth.uid());
create policy "customers own custom options" on custom_order_options for all using (exists(select 1 from orders o where o.id=order_id and o.customer_id=auth.uid()));
-- Audit logs are server-written only; no client policy is intentional.

-- Private bucket for customer tailoring references. Create bucket in Storage UI/API:
-- insert into storage.buckets(id,name,public) values ('private-tailoring','private-tailoring',false) on conflict do nothing;
-- Add Storage policies restricting object owner/path to auth.uid(); product images may use a separate public bucket.
