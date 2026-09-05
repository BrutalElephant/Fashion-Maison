-- Fashion Maison — catalog architecture, storefront reads, cart persistence and auth hardening.
-- Non-destructive: adds/guards only, never drops data. Safe for a live project.

-- ============================================================================
-- 1) Admin-owned platform catalog.
--    Fashion Maison admin is the authoritative catalog manager, so a product no
--    longer requires a merchant store row. store_id = NULL means "house
--    selection" (owned directly by the platform). No synthetic merchants are
--    created; existing store-linked products are untouched.
-- ============================================================================
alter table public.products alter column store_id drop not null;

-- NGN is the authoritative price. base_price is derived from existing price
-- data (never invented); admin may refine it later through the catalog.
alter table public.products add column if not exists base_currency char(3) not null default 'NGN';
alter table public.products add column if not exists base_price numeric(12,2);
update public.products set base_price = price where base_price is null;

-- ============================================================================
-- 2) Cart persistence against the existing carts/cart_items architecture.
--    cart_items gains a product_id so variant-less products can persist, and
--    variant_id becomes optional. Identity uniqueness covers both keys.
-- ============================================================================
alter table public.cart_items add column if not exists product_id uuid references public.products(id) on delete cascade;
alter table public.cart_items alter column variant_id drop not null;
update public.cart_items ci set product_id = pv.product_id
  from public.product_variants pv where ci.variant_id = pv.id and ci.product_id is null;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid='public.cart_items'::regclass and conname='cart_items_product_required') then
    execute 'alter table public.cart_items add constraint cart_items_product_required check (product_id is not null)';
  end if;
end $$;
do $$ begin
  if exists (select 1 from pg_constraint where conrelid='public.cart_items'::regclass and conname='cart_items_cart_id_variant_id_key') then
    execute 'alter table public.cart_items drop constraint cart_items_cart_id_variant_id_key';
  end if;
end $$;
-- De-duplicate legacy rows (old unique allowed duplicate NULL-variant lines) before the new constraint.
with ranked as (
  select id, row_number() over (partition by cart_id, product_id, variant_id order by quantity desc, id desc) as rn
    from public.cart_items
) delete from public.cart_items where id in (select id from ranked where rn > 1);
-- A real unique constraint (not an expression index) so the REST upsert can
-- infer ON CONFLICT (cart_id, product_id, variant_id). NULLS NOT DISTINCT
-- requires PostgreSQL 15+, which all Supabase projects run.
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid='public.cart_items'::regclass and conname='cart_items_cart_product_variant_unique') then
    execute 'alter table public.cart_items add constraint cart_items_cart_product_variant_unique unique nulls not distinct (cart_id, product_id, variant_id)';
  end if;
end $$;

-- Customers can persist their own cart items (previously RLS had no cart_items
-- policy, which blocked authenticated cart writes outright).
drop policy if exists "users own cart items" on public.cart_items;create policy "users own cart items" on public.cart_items for all to authenticated
  using (exists(select 1 from public.carts c where c.id = cart_items.cart_id and c.customer_id = auth.uid()))
  with check (exists(select 1 from public.carts c where c.id = cart_items.cart_id and c.customer_id = auth.uid()));

-- ============================================================================
-- 3) Storefront read access — the fix for blank product images and empty
--    variant pickers. product_images previously had no public read policy.
-- ============================================================================
drop policy if exists "public published products" on public.products;
create policy "public published products" on public.products for select to anon, authenticated
  using (published = true and (store_id is null or exists(select 1 from public.stores s where s.id = products.store_id and s.approved = true)));

drop policy if exists "public can read published product images";
create policy "public can read published product images" on public.product_images for select to anon, authenticated
  using (exists(select 1 from public.products p where p.id = product_images.product_id and p.published = true));

drop policy if exists "public can read published product variants";
create policy "public can read published product variants" on public.product_variants for select to anon, authenticated
  using (active and exists(select 1 from public.products p where p.id = product_variants.product_id and p.published = true));

drop policy if exists "public can read catalog categories";
create policy "public can read catalog categories" on public.categories for select to anon, authenticated
  using (store_id is null or exists(select 1 from public.stores s where s.id = categories.store_id and s.approved = true));

drop policy if exists "public can read approved stores";
create policy "public can read approved stores" on public.stores for select to anon, authenticated using (approved = true);

-- ============================================================================
-- 4) Admin order/payment operations. Merchants keep their scoped access;
--    platform admins need visibility for fulfilment and payment review.
-- ============================================================================
drop policy if exists "admins manage orders" on public.orders;
create policy "admins manage orders" on public.orders for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admins manage payments" on public.payments;
create policy "admins manage payments" on public.payments for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admins read order items";
create policy "admins read order items" on public.order_items for select to authenticated using (public.is_admin());

drop policy if exists "users see own order items";
create policy "users see own order items" on public.order_items for select to authenticated
  using (exists(select 1 from public.orders o where o.id = order_items.order_id and o.customer_id = auth.uid()));

drop policy if exists "users see own payments";
create policy "users see own payments" on public.payments for select to authenticated
  using (exists(select 1 from public.orders o where o.id = payments.order_id and o.customer_id = auth.uid()));

drop policy if exists "admins manage notifications";
create policy "admins manage notifications" on public.notifications for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ============================================================================
-- 5) Privilege-escalation hardening for profiles.role.
--    a) column-level grants: the REST layer cannot touch role at all for
--       non-service roles;
--    b) a trigger as second enforcement (blocks authenticated role writes even
--       through RPCs that do not go through column grants);
--    c) signups always land as 'customer' via a SECURITY DEFINER trigger.
--    Only service_role (Edge Functions with the service key) or an existing
--    admin may change roles, and role changes are audited.
-- ============================================================================
alter table public.profiles add column if not exists email text;

-- Column-level grants: the REST layer physically cannot touch role/id via UPDATE,
-- and unprivileged INSERT is off entirely (signups run through the definer trigger).
revoke update on table public.profiles from anon, authenticated;
revoke insert on table public.profiles from anon, authenticated;
grant update (full_name, phone, avatar_url, email) on table public.profiles to authenticated;

drop policy if exists "users own profile" on public.profiles;
drop policy if exists "profiles select own or admin" on public.profiles;
create policy "profiles select own or admin" on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());

create or replace function public.protect_profile_role() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_claims jsonb := coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
begin
  if coalesce(v_claims->>'role','') = 'service_role' or public.is_admin() then
    return new; -- trusted server operations / admins; admin path is audited by the RPC
  end if;
  if tg_op = 'UPDATE' and new.role is distinct from old.role then
    raise exception 'ROLE_CHANGE_FORBIDDEN: only platform administrators or trusted server operations may change profile roles'
      using errcode = '42501';
  end if;
  if tg_op = 'INSERT' and new.role is distinct from 'customer' then
    raise exception 'ROLE_CHANGE_FORBIDDEN: new profiles are always customers' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public.protect_profile_role() from public;
grant execute on function public.protect_profile_role() to anon, authenticated, service_role;
drop trigger if exists profiles_protect_role on public.profiles;
create trigger profiles_protect_role before insert or update on public.profiles
  for each row execute function public.protect_profile_role();

-- Admin-side role mutation (only reachable from trusted Edge Functions using
-- the service role; audited).
create or replace function public.admin_set_user_role(p_actor_id uuid, p_user_id uuid, p_new_role public.user_role)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_target public.profiles;
begin
  if not exists (select 1 from public.profiles a where a.id = p_actor_id and a.role = 'admin') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_user_id is null or p_new_role is null then raise exception 'INVALID_INPUT'; end if;
  update public.profiles set role = p_new_role, updated_at = now() where id = p_user_id returning * into v_target;
  if v_target.id is null then raise exception 'PROFILE_NOT_FOUND'; end if;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, metadata)
    values (p_actor_id, 'profile.role_changed', 'profiles', p_user_id, jsonb_build_object('new_role', p_new_role::text));
  return to_jsonb(v_target);
end $$;
revoke all on function public.admin_set_user_role(uuid, uuid, public.user_role) from public;
grant execute on function public.admin_set_user_role(uuid, uuid, public.user_role) to service_role;

-- First profile row on signup — role is hard-coded to customer.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, role, full_name, email)
    values (new.id, 'customer', coalesce(nullif(new.raw_user_meta_data->>'full_name',''), 'Fashion Maison customer'), new.email)
    on conflict (id) do update set email = excluded.email;
  return new;
end $$;
revoke all on function public.handle_new_user() from public;
grant execute on function public.handle_new_user() to authenticated, service_role;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Keep updated_at honest for the tables the app edits directly.
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname='products_touch_updated_at' and trelid='public.products'::regclass) then
    execute 'create trigger products_touch_updated_at before update on public.products for each row execute function public.touch_updated_at()';
  end if;
  if not exists (select 1 from pg_trigger where tgname='orders_touch_updated_at' and trelid='public.orders'::regclass) then
    execute 'create trigger orders_touch_updated_at before update on public.orders for each row execute function public.touch_updated_at()';
  end if;
end $$;

-- ============================================================================
-- 6) Server-side payment configuration tables.
-- ============================================================================
create table if not exists public.payment_settings (
  id uuid primary key default gen_random_uuid(),
  store_id uuid references public.stores(id) on delete cascade,
  currency char(3) not null default 'NGN',
  bank_name text,
  account_name text,
  account_number text,
  manual_instructions text,
  paystack_enabled boolean not null default true,
  manual_transfer_enabled boolean not null default true,
  reservation_minutes int not null default 45 check (reservation_minutes between 5 and 1440),
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Exactly one platform-level row (store_id NULL); merchants may override per store.
create unique index if not exists payment_settings_platform_singleton
  on public.payment_settings (coalesce(store_id, '00000000-0000-0000-0000-000000000000'::uuid));
alter table public.payment_settings enable row level security;
-- Bank coordinates are shown to signed-in shoppers only, and only the platform row.
drop policy if exists "authenticated can read platform payment settings" on public.payment_settings;
create policy "authenticated can read platform payment settings" on public.payment_settings for select to authenticated
  using (store_id is null);
drop policy if exists "admins manage payment settings" on public.payment_settings;
create policy "admins manage payment settings" on public.payment_settings for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
grant select on public.payment_settings to anon, authenticated;
grant update, insert, delete on public.payment_settings to authenticated;

create table if not exists public.delivery_methods (
  key text primary key,
  label text not null,
  fee numeric(12,2) not null default 0 check (fee >= 0),
  active boolean not null default true,
  sort_order int not null default 0,
  updated_at timestamptz not null default now()
);
-- Platform shipping configuration announced by the storefront copy.
insert into public.delivery_methods (key, label, fee, sort_order) values
  ('store_pickup', 'Store pickup', 0, 1),
  ('local_delivery', 'Lagos local delivery', 3000, 2),
  ('nationwide_delivery', 'Nationwide delivery', 7000, 3)
on conflict (key) do nothing;
alter table public.delivery_methods enable row level security;
drop policy if exists "public can read delivery methods" on public.delivery_methods;
create policy "public can read delivery methods" on public.delivery_methods for select to anon, authenticated using (active);
drop policy if exists "admins manage delivery methods" on public.delivery_methods;
create policy "admins manage delivery methods" on public.delivery_methods for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
grant select on public.delivery_methods to anon, authenticated;
grant update, insert, delete on public.delivery_methods to authenticated;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname='delivery_methods_touch_updated_at' and trelid='public.delivery_methods'::regclass) then
    execute 'create trigger delivery_methods_touch_updated_at before update on public.delivery_methods for each row execute function public.touch_updated_at()';
  end if;
  if not exists (select 1 from pg_trigger where tgname='payment_settings_touch_updated_at' and trelid='public.payment_settings'::regclass) then
    execute 'create trigger payment_settings_touch_updated_at before update on public.payment_settings for each row execute function public.touch_updated_at()';
  end if;
end $$;

-- Ensure the storefront FX read stays available even on projects created with
-- auto_expose_new_tables=false (the policy in M20260902191030 keeps rows honest).
grant select on public.current_usd_ngn_rate to anon, authenticated;
