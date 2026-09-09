-- Fashion Maison — order / pre-order admin flags and trusted checkout honouring them.
-- Non-destructive: ADD COLUMN IF NOT EXISTS, backfill from existing status, CREATE OR REPLACE RPC.
-- Does not drop tables, rows, statuses, or image/storage objects.
-- Safe to re-run after a partial apply.

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
$$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated, anon;

-- ===========================================================================
-- 0) Columns the checkout RPC reads. ADD IF NOT EXISTS only; never drop/rename.
-- ===========================================================================
alter table public.products add column if not exists product_type text not null default 'ready_made';
alter table public.products add column if not exists brand text;
alter table public.products add column if not exists attributes jsonb not null default '{}';
alter table public.products add column if not exists pre_order_price numeric(12,2);
alter table public.products add column if not exists pre_order_closes_at timestamptz;
alter table public.products add column if not exists base_price numeric(12,2);
alter table public.products add column if not exists order_enabled boolean not null default true;
alter table public.products add column if not exists pre_order_enabled boolean not null default false;
alter table public.products add column if not exists pre_order_notes text;
alter table public.products add column if not exists pre_order_max_qty int;
do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.products'::regclass and conname = 'products_pre_order_max_qty_check'
  ) then
    alter table public.products add constraint products_pre_order_max_qty_check
      check (pre_order_max_qty is null or pre_order_max_qty > 0);
  end if;
end $$;

alter table public.product_variants add column if not exists active boolean not null default true;

alter table public.orders add column if not exists idempotency_key text;
alter table public.orders add column if not exists fx_rate_snapshot numeric(20,8);
alter table public.orders add column if not exists usd_equivalent_snapshot numeric(12,2);
alter table public.orders add column if not exists fx_source_snapshot text;
alter table public.orders add column if not exists fx_timestamp_snapshot timestamptz;
alter table public.orders add column if not exists tailoring_snapshot jsonb;
alter table public.orders add column if not exists reservation_expires_at timestamptz;
alter table public.orders add column if not exists delivery_method text;
alter table public.orders add column if not exists delivery_address jsonb;
do $$ begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders' and column_name = 'store_id' and is_nullable = 'NO'
  ) then
    alter table public.orders alter column store_id drop not null;
  end if;
end $$;
create unique index if not exists orders_customer_idempotency
  on public.orders (customer_id, idempotency_key) where idempotency_key is not null;

alter table public.order_items add column if not exists is_preorder boolean not null default false;
alter table public.order_items add column if not exists product_name_snapshot text;
alter table public.order_items add column if not exists variant_snapshot jsonb;
alter table public.order_items add column if not exists subtotal_ngn numeric(12,2);
alter table public.order_items add column if not exists fx_rate_snapshot numeric(20,8);
alter table public.order_items add column if not exists usd_equivalent_snapshot numeric(12,2);

-- Honour existing catalog: PRE-ORDER / made-to-order pieces become pre-order-only;
-- OUT OF STOCK pieces cannot be ordered unless already flagged as pre-order.
update public.products
  set pre_order_enabled = true,
      order_enabled = false
  where status = 'PRE-ORDER'
    and pre_order_enabled = false;
update public.products
  set pre_order_enabled = true,
      order_enabled = false
  where product_type in ('pre_order','made_to_order')
    and pre_order_enabled = false;
update public.products
  set order_enabled = false
  where status = 'OUT OF STOCK' and pre_order_enabled = false and order_enabled = true;

-- ===========================================================================
-- 1) payment_settings — use the live instruction column (payment_instructions).
--    Do NOT add or require manual_instructions. Do not recreate the table.
-- ===========================================================================
alter table public.payment_settings add column if not exists store_id uuid;
alter table public.payment_settings add column if not exists currency char(3) default 'NGN';
alter table public.payment_settings add column if not exists bank_name text;
alter table public.payment_settings add column if not exists account_name text;
alter table public.payment_settings add column if not exists account_number text;
alter table public.payment_settings add column if not exists payment_instructions text;
alter table public.payment_settings add column if not exists paystack_enabled boolean not null default true;
alter table public.payment_settings add column if not exists manual_transfer_enabled boolean not null default true;
alter table public.payment_settings add column if not exists reservation_minutes int not null default 45;

-- If a legacy instruction column happens to exist, copy into payment_instructions
-- without adding any new instruction column.
do $$
declare
  src text;
begin
  select c.column_name into src
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'payment_settings'
      and c.column_name in ('instructions','bank_instructions','transfer_instructions','manual_instructions')
    order by case c.column_name
      when 'instructions' then 1
      when 'bank_instructions' then 2
      when 'transfer_instructions' then 3
      when 'manual_instructions' then 4
    end
    limit 1;
  if src is not null then
    execute format(
      'update public.payment_settings set payment_instructions = coalesce(payment_instructions, %I) where payment_instructions is null and %I is not null',
      src, src
    );
  end if;
end $$;

-- ===========================================================================
-- Supporting objects the RPC touches (create if missing; never drop).
-- ===========================================================================
create table if not exists public.order_items_tmp (
  order_key text not null,
  product_id uuid not null,
  variant_id uuid,
  product_name text not null,
  quantity int not null,
  unit_price numeric(12,2) not null,
  line_total numeric(14,2) not null,
  is_preorder boolean not null default false
);
alter table public.order_items_tmp enable row level security;
revoke all on table public.order_items_tmp from anon, authenticated;

create table if not exists public.delivery_methods (
  key text primary key,
  label text not null,
  fee numeric(12,2) not null default 0 check (fee >= 0),
  active boolean not null default true,
  sort_order int not null default 0,
  updated_at timestamptz not null default now()
);
insert into public.delivery_methods (key, label, fee, sort_order) values
  ('store_pickup', 'Store pickup', 0, 1),
  ('local_delivery', 'Lagos local delivery', 3000, 2),
  ('nationwide_delivery', 'Nationwide delivery', 7000, 3)
on conflict (key) do nothing;
alter table public.delivery_methods enable row level security;
drop policy if exists "public can read delivery methods" on public.delivery_methods;
create policy "public can read delivery methods" on public.delivery_methods
  for select to anon, authenticated using (active);
drop policy if exists "admins manage delivery methods" on public.delivery_methods;
create policy "admins manage delivery methods" on public.delivery_methods
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
grant select on public.delivery_methods to anon, authenticated;

create table if not exists public.measurement_profiles (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  unit text not null check (unit in ('CM','INCHES')),
  measurements jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.measurement_profiles enable row level security;

create table if not exists public.custom_order_options (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  measurement_profile_id uuid references public.measurement_profiles(id) on delete set null,
  unit text check (unit in ('CM','INCHES')),
  options jsonb not null default '{}',
  reference_image_paths jsonb not null default '[]',
  snapshot jsonb not null default '{}',
  created_at timestamptz not null default now()
);
alter table public.custom_order_options enable row level security;

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);
alter table public.audit_logs enable row level security;

create table if not exists public.preorders (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.orders(id) on delete cascade,
  expected_availability date,
  status text not null default 'placed',
  created_at timestamptz not null default now()
);

-- ===========================================================================
-- 2) create_order_atomically — same signature, extra purchase-flag checks,
--    pre_order_price, pre_order_max_qty, client is_preorder when both modes exist.
-- ===========================================================================
create or replace function public.create_order_atomically(
  p_customer_id uuid,
  p_items jsonb,
  p_delivery_method text default 'store_pickup',
  p_idempotency_key text default null,
  p_payment_method text default 'paystack',
  p_address jsonb default null,
  p_address_id uuid default null,
  p_measurement_profile_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_existing jsonb;
  v_paystack_enabled boolean;
  v_manual_enabled boolean;
  v_reservation_minutes int;
  v_rec record;
  v_item jsonb;
  v_pid uuid; v_vid uuid; v_qty int; v_expect numeric;
  v_prod record;
  v_avail int; v_reserved int; v_is_preorder boolean;
  v_order_on boolean; v_pre_on boolean; v_want_pre boolean;
  v_unit numeric; v_subtotal numeric := 0; v_fee numeric := 0; v_total numeric;
  v_line numeric;
  v_address jsonb;
  v_fx_rate numeric; v_fx_source text; v_fx_at timestamptz;
  v_order public.orders;
  v_store_id uuid;
  v_attempt int := 0;
  v_has_preorder boolean := false;
  v_max_expected date;
  v_tailoring jsonb;
begin
  if p_customer_id is null or not exists (select 1 from profiles where id = p_customer_id) then
    raise exception 'CUSTOMER_NOT_FOUND';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'EMPTY_CART';
  end if;
  if jsonb_array_length(p_items) > 50 then raise exception 'CART_TOO_LARGE'; end if;
  if p_payment_method is null or p_payment_method not in ('paystack','manual_transfer') then
    raise exception 'PAYMENT_METHOD_INVALID';
  end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key)) < 8 then
    raise exception 'INVALID_IDEMPOTENCY';
  end if;

  select to_jsonb(o) into v_existing from orders o
    where o.customer_id = p_customer_id and o.idempotency_key = p_idempotency_key limit 1;
  if v_existing is not null then
    return jsonb_build_object('order_id', v_existing->>'id', 'order_number', v_existing->>'order_number',
      'status', v_existing->>'status', 'subtotal', (v_existing->>'subtotal')::numeric,
      'delivery_fee', (v_existing->>'delivery_fee')::numeric, 'total', (v_existing->>'total')::numeric,
      'currency', 'NGN', 'payment_method', p_payment_method, 'replayed', true);
  end if;

  select paystack_enabled, manual_transfer_enabled, reservation_minutes
    into v_paystack_enabled, v_manual_enabled, v_reservation_minutes
    from payment_settings where store_id is null limit 1;
  v_paystack_enabled := coalesce(v_paystack_enabled, true);
  v_manual_enabled := coalesce(v_manual_enabled, true);
  v_reservation_minutes := coalesce(v_reservation_minutes, 45);
  if (p_payment_method = 'paystack' and not v_paystack_enabled)
     or (p_payment_method = 'manual_transfer' and not v_manual_enabled) then
    raise exception 'PAYMENT_METHOD_UNAVAILABLE';
  end if;

  if p_address_id is not null then
    select jsonb_build_object('label', a.label, 'line1', a.line1, 'city', a.city, 'state', a.state, 'phone', a.phone)
      into v_address from addresses a where a.id = p_address_id and a.customer_id = p_customer_id;
    if v_address is null then raise exception 'ADDRESS_NOT_FOUND'; end if;
  else
    v_address := jsonb_build_object(
      'name', left(nullif(trim(coalesce(p_address->>'name','')),''), 120),
      'email', left(lower(nullif(trim(coalesce(p_address->>'email','')),'')), 160),
      'phone', left(nullif(trim(coalesce(p_address->>'phone','')),''), 32),
      'line1', left(nullif(trim(coalesce(p_address->>'line1','')),''), 240),
      'city', left(nullif(trim(coalesce(p_address->>'city','')),''), 120),
      'state', left(nullif(trim(coalesce(p_address->>'state','')),''), 120));
  end if;
  if v_address->>'name' is null or v_address->>'phone' is null or v_address->>'line1' is null or v_address->>'city' is null then
    raise exception 'ADDRESS_REQUIRED';
  end if;

  if p_measurement_profile_id is not null then
    select to_jsonb(mp) into v_tailoring from measurement_profiles mp
      where mp.id = p_measurement_profile_id and mp.customer_id = p_customer_id;
    if v_tailoring is null then raise exception 'MEASUREMENT_PROFILE_NOT_FOUND'; end if;
  end if;

  select fee into v_fee from delivery_methods where key = p_delivery_method and active limit 1;
  if v_fee is null then raise exception 'DELIVERY_UNAVAILABLE'; end if;

  delete from order_items_tmp where order_key = p_idempotency_key;

  for v_rec in
    select x, coalesce(nullif(x->>'variant_id',''), '00000000-0000-0000-0000-000000000000') || '/' ||
           coalesce(nullif(x->>'product_id',''), '00000000-0000-0000-0000-000000000000') as lock_key
      from jsonb_array_elements(p_items) as x order by lock_key
  loop
    v_item := v_rec.x;
    if v_item->>'product_id' is null or (v_item->>'product_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'INVALID_INPUT: product_id must be a uuid';
    end if;
    v_pid := (v_item->>'product_id')::uuid;
    v_vid := nullif(v_item->>'variant_id','')::uuid;
    v_qty := coalesce((v_item->>'quantity')::int, 0);
    if v_qty < 1 or v_qty > 99 then raise exception 'INVALID_QUANTITY'; end if;
    v_expect := nullif(v_item->>'expected_unit_price','')::numeric;

    select p.* into v_prod from products p where p.id = v_pid and p.published = true;
    if not found then raise exception 'PRODUCT_UNAVAILABLE: %', v_pid; end if;
    if v_prod.store_id is not null and not exists (select 1 from stores s where s.id = v_prod.store_id and s.approved) then
      raise exception 'PRODUCT_UNAVAILABLE: store not approved';
    end if;
    v_store_id := coalesce(v_store_id, v_prod.store_id);

    if v_vid is not null then
      if not exists (select 1 from product_variants v where v.id = v_vid and v.product_id = v_pid and v.active) then
        raise exception 'VARIANT_UNAVAILABLE: %', v_vid;
      end if;
    else
      if exists (select 1 from product_variants v where v.product_id = v_pid and v.active) then
        raise exception 'NEED_VARIANT: product % has variants; choose a size/colour first', v_pid;
      end if;
    end if;

    v_order_on := coalesce(v_prod.order_enabled, true);
    v_pre_on := coalesce(v_prod.pre_order_enabled, (v_prod.status = 'PRE-ORDER' or v_prod.product_type in ('pre_order','made_to_order')));
    if v_prod.status = 'OUT OF STOCK' then v_order_on := false; end if;
    if v_prod.pre_order_closes_at is not null and v_prod.pre_order_closes_at < now() then v_pre_on := false; end if;
    v_want_pre := coalesce((v_item->>'is_preorder')::boolean, false);
    if v_want_pre then
      if not v_pre_on then raise exception 'PRODUCT_UNAVAILABLE: pre-order is not enabled'; end if;
      v_is_preorder := true;
    elsif v_order_on then
      v_is_preorder := false;
    elsif v_pre_on then
      v_is_preorder := true;
    else
      raise exception 'PRODUCT_UNAVAILABLE: not available for purchase';
    end if;

    if v_vid is not null then
      select coalesce(v.price, v_prod.base_price, v_prod.price) into v_unit from product_variants v where v.id = v_vid;
    else
      v_unit := coalesce(v_prod.base_price, v_prod.price);
    end if;
    if v_is_preorder then
      v_unit := coalesce(v_prod.pre_order_price, v_unit);
      if v_prod.pre_order_max_qty is not null and v_qty > v_prod.pre_order_max_qty then
        raise exception 'INVALID_QUANTITY: pre-order limit is %', v_prod.pre_order_max_qty;
      end if;
    end if;
    if v_expect is not null and abs(v_expect - v_unit) > 0.005 then
      raise exception 'PRICE_CHANGED: % expects % but authoritative price is %', v_pid, v_expect, v_unit;
    end if;

    if not v_is_preorder and v_vid is not null then
      select i.quantity, i.reserved into v_avail, v_reserved
        from inventory i where i.variant_id = v_vid for update;
      if not found then raise exception 'STOCK_CHANGED: no inventory record for %', v_vid; end if;
      if (v_avail - v_reserved) < v_qty then raise exception 'STOCK_CHANGED: insufficient stock for %', v_vid; end if;
      update inventory set reserved = reserved + v_qty, updated_at = now() where variant_id = v_vid;
    end if;

    v_line := round(v_unit * v_qty, 2);
    v_subtotal := v_subtotal + v_line;
    if v_is_preorder then
      v_has_preorder := true;
      v_max_expected := greatest(v_max_expected, v_prod.expected_availability,
                                 (current_date + interval '14 days')::date);
    end if;
    insert into order_items_tmp (order_key, product_id, variant_id, product_name, quantity, unit_price, line_total, is_preorder)
      values (p_idempotency_key, v_pid, v_vid, left(v_prod.name, 200), v_qty, v_unit, v_line, v_is_preorder);
  end loop;

  v_total := round(v_subtotal + v_fee, 2);
  if v_total <= 0 then raise exception 'INVALID_TOTAL'; end if;

  if to_regclass('public.current_usd_ngn_rate') is not null then
    execute 'select rate, source, effective_at from public.current_usd_ngn_rate limit 1'
      into v_fx_rate, v_fx_source, v_fx_at;
  end if;

  loop
    begin
      insert into orders (order_number, customer_id, store_id, status, subtotal, delivery_fee, total,
                          delivery_method, delivery_address, idempotency_key,
                          fx_rate_snapshot, usd_equivalent_snapshot, fx_source_snapshot, fx_timestamp_snapshot,
                          tailoring_snapshot, reservation_expires_at)
      values (
        'FM-' || to_char(now(), 'YYMMDD') || '-' || upper(substr(md5(random()::text), 1, 6)),
        p_customer_id, v_store_id, 'pending', round(v_subtotal, 2), v_fee, v_total,
        p_delivery_method, v_address, p_idempotency_key,
        v_fx_rate, case when v_fx_rate is not null then round(v_total / v_fx_rate, 2) else null end,
        v_fx_source, v_fx_at, v_tailoring,
        now() + make_interval(mins => v_reservation_minutes)
      ) returning * into v_order;
      exit;
    exception when unique_violation then
      if SQLERRM like '%orders_customer_idempotency%' then
        select to_jsonb(o) into v_existing from orders o
          where o.customer_id = p_customer_id and o.idempotency_key = p_idempotency_key limit 1;
        if v_existing is not null then
          return jsonb_build_object('order_id', v_existing->>'id', 'order_number', v_existing->>'order_number',
            'status', v_existing->>'status', 'subtotal', (v_existing->>'subtotal')::numeric,
            'delivery_fee', (v_existing->>'delivery_fee')::numeric, 'total', (v_existing->>'total')::numeric,
            'currency', 'NGN', 'payment_method', p_payment_method, 'replayed', true);
        end if;
      end if;
      v_attempt := v_attempt + 1;
      if v_attempt > 8 then raise exception 'ORDER_NUMBER_EXHAUSTED'; end if;
    end;
  end loop;

  insert into order_items (order_id, product_id, variant_id, product_name, quantity, unit_price, is_preorder,
                            product_name_snapshot, variant_snapshot, subtotal_ngn, fx_rate_snapshot, usd_equivalent_snapshot)
    select v_order.id, t.product_id, t.variant_id, t.product_name, t.quantity, t.unit_price, t.is_preorder,
           t.product_name,
           case when t.variant_id is not null then
             (select jsonb_build_object('size', v.size, 'color', v.color, 'sku', v.sku) from product_variants v where v.id = t.variant_id)
           else '{}'::jsonb end,
           t.line_total, v_fx_rate,
           case when v_fx_rate is not null then round(t.line_total / v_fx_rate, 2) else null end
    from order_items_tmp t where t.order_key = p_idempotency_key;
  delete from order_items_tmp where order_key = p_idempotency_key;

  if v_has_preorder then
    insert into preorders (order_id, expected_availability, status)
      values (v_order.id, v_max_expected, 'placed') on conflict (order_id) do nothing;
  end if;

  if v_tailoring is not null then
    insert into custom_order_options (order_id, measurement_profile_id, unit, options, reference_image_paths, snapshot)
      values (v_order.id, p_measurement_profile_id, v_tailoring->>'unit', '{}'::jsonb,
              coalesce(v_tailoring->'reference_paths', '[]'::jsonb), v_tailoring);
  end if;

  insert into notifications (user_id, type, title, body)
    values (p_customer_id, 'order', 'Order ' || v_order.order_number || ' placed',
            'Your order is reserved for ' || v_reservation_minutes || ' minutes while payment completes.');
  insert into audit_logs (actor_id, action, entity_type, entity_id, metadata)
    values (p_customer_id, 'order.created', 'orders', v_order.id,
            jsonb_build_object('total', v_total, 'payment_method', p_payment_method, 'items', jsonb_array_length(p_items)));

  return jsonb_build_object('order_id', v_order.id, 'order_number', v_order.order_number,
    'status', v_order.status, 'currency', 'NGN', 'subtotal', round(v_subtotal, 2), 'delivery_fee', v_fee,
    'total', v_total, 'usd_equivalent', case when v_fx_rate is not null then round(v_total / v_fx_rate, 2) else null end,
    'fx_rate', v_fx_rate, 'fx_effective_at', v_fx_at, 'payment_method', p_payment_method,
    'pre_order', v_has_preorder, 'expected_availability', v_max_expected,
    'reservation_expires_at', v_order.reservation_expires_at);
end $$;

revoke all on function public.create_order_atomically(uuid, jsonb, text, text, text, jsonb, uuid, uuid) from public, anon, authenticated;
grant execute on function public.create_order_atomically(uuid, jsonb, text, text, text, jsonb, uuid, uuid) to service_role;

-- ===========================================================================
-- 3) preorders: customers read their own (via parent order); admins manage.
--    Enabling RLS does not drop data.
-- ===========================================================================
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
$$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated, anon;

alter table public.preorders enable row level security;
drop policy if exists "users see own preorders" on public.preorders;
create policy "users see own preorders" on public.preorders for select to authenticated
  using (exists (select 1 from public.orders o where o.id = preorders.order_id and o.customer_id = auth.uid()));
drop policy if exists "admins manage preorders" on public.preorders;
create policy "admins manage preorders" on public.preorders for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
grant select on public.preorders to authenticated;
