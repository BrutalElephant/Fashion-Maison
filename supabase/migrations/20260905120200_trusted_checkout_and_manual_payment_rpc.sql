-- Fashion Maison — trusted checkout, payment finalization and manual-transfer review.
-- SECURITY DEFINER RPCs executed only from Edge Functions holding the service
-- role (grants revoked from anon/authenticated). All monetary values, stock,
-- FX snapshots and status transitions are computed server-side; browser
-- prices, quantities, totals and payment statuses are never trusted.

-- Scratch staging for validated lines between the item loop and the order
-- insert (single-transaction RPC; always cleared before use).
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

-- ============================================================================
-- create_order_atomically — atomic cart → order with inventory reservation.
-- Locks inventory rows (deterministic order to avoid deadlocks), re-reads
-- authoritative NGN prices, rejects price/stock drift, applies configured
-- delivery fees, snapshots the server FX rate, reserves ready-made stock,
-- records pre-order lines without reservation, and is idempotent per
-- (customer, idempotency key).
-- ============================================================================
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
  v_unit numeric; v_subtotal numeric := 0; v_fee numeric := 0; v_total numeric;
  v_line numeric;
  v_address jsonb;
  v_fx_rate numeric; v_fx_source text; v_fx_at timestamptz;
  v_order public.orders;
  v_number_src text;
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

  -- Idempotent replay: return the previously created order untouched.
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

  -- Lock and validate items in deterministic order.
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
      select coalesce(v.price, v_prod.base_price, v_prod.price) into v_unit from product_variants v where v.id = v_vid;
    else
      if exists (select 1 from product_variants v where v.product_id = v_pid and v.active) then
        raise exception 'NEED_VARIANT: product % has variants; choose a size/colour first', v_pid;
      end if;
      v_unit := coalesce(v_prod.base_price, v_prod.price);
    end if;
    if v_expect is not null and abs(v_expect - v_unit) > 0.005 then
      raise exception 'PRICE_CHANGED: % expects % but authoritative price is %', v_pid, v_expect, v_unit;
    end if;

    v_is_preorder := v_prod.status = 'PRE-ORDER' or v_prod.product_type in ('pre_order','made_to_order');
    if v_prod.status = 'OUT OF STOCK' and not v_is_preorder then
      raise exception 'PRODUCT_UNAVAILABLE: out of stock';
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

  select r.rate, r.source, r.effective_at into v_fx_rate, v_fx_source, v_fx_at
    from current_usd_ngn_rate r limit 1;

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
        -- concurrent duplicate submission for the same key: surface the winner
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

-- ============================================================================
-- finalize_successful_payment — paystack OR approved manual transfer.
-- pending/awaiting_verification → successful; order → paid (or pre-order for
-- all-preorder carts); reservations convert to sold stock atomically.
-- Idempotent: replay returns ok.
-- ============================================================================
create or replace function public.finalize_successful_payment(p_payment_id uuid, p_provider_payload jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_pay public.payments;
  v_order public.orders;
  v_all_preorder boolean;
  v_new_status public.order_status;
  rec record;
  v_prod record;
  v_avail bigint; v_low boolean;
begin
  select * into v_pay from payments where id = p_payment_id for update;
  if not found then raise exception 'PAYMENT_NOT_FOUND'; end if;
  if v_pay.status = 'successful' then
    return jsonb_build_object('ok', true, 'already_finalized', true, 'order_id', v_pay.order_id);
  end if;
  if v_pay.status not in ('pending','awaiting_verification') then raise exception 'PAYMENT_NOT_PAYABLE'; end if;

  select * into v_order from orders where id = v_pay.order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if v_order.status = 'cancelled' then raise exception 'ORDER_CANCELLED'; end if;
  if v_order.status in ('paid','pre-order','processing','ready','shipped','delivered') then
    update payments set status = 'successful', paid_at = coalesce(paid_at, now()),
      provider_payload = coalesce(p_provider_payload, provider_payload)
      where id = p_payment_id and status <> 'successful';
    return jsonb_build_object('ok', true, 'already_finalized', true, 'order_id', v_order.id);
  end if;

  update payments set status = 'successful', paid_at = now(),
    provider_payload = coalesce(p_provider_payload, provider_payload)
    where id = p_payment_id;

  select bool_and(i.is_preorder) into v_all_preorder from order_items i where i.order_id = v_order.id;
  v_new_status := case when coalesce(v_all_preorder, false) then 'pre-order'::public.order_status
                       else 'paid'::public.order_status end;
  update orders set status = v_new_status where id = v_order.id;

  for rec in select oi.variant_id, sum(oi.quantity)::int as qty
               from order_items oi
               where oi.order_id = v_order.id and not oi.is_preorder and oi.variant_id is not null
               group by oi.variant_id
  loop
    update inventory set quantity = greatest(quantity - rec.qty, 0),
                           reserved = greatest(reserved - rec.qty, 0),
                           sold = sold + rec.qty, updated_at = now()
      where variant_id = rec.variant_id;
  end loop;

  for v_prod in select distinct p.id, p.product_type, p.status from products p join order_items oi on oi.product_id = p.id
                where oi.order_id = v_order.id and p.product_type = 'ready_made' and p.status <> 'PRE-ORDER'
  loop
    select coalesce(sum(i.quantity - i.reserved), 0)::bigint,
           bool_or(i.quantity - i.reserved <= i.low_stock_threshold)
      into v_avail, v_low
      from inventory i join product_variants v on v.id = i.variant_id and v.active
      where v.product_id = v_prod.id;
    if v_avail is not null then
      update products set status = case
          when v_avail <= 0 then 'OUT OF STOCK'::public.product_status
          when coalesce(v_low, false) then 'LOW STOCK'::public.product_status
          else 'AVAILABLE'::public.product_status end
        where id = v_prod.id;
    else
      update products set status = 'AVAILABLE'::public.product_status where id = v_prod.id;
    end if;
  end loop;

  insert into notifications (user_id, type, title, body)
    values (v_order.customer_id, 'payment', 'Payment confirmed — ' || v_order.order_number,
            'We received your payment of ₦' || to_char(v_order.total, 'FM999999999990.00') || '. Thank you for shopping with Fashion Maison.');
  insert into audit_logs (actor_id, action, entity_type, entity_id, metadata)
    values (v_order.customer_id, 'payment.finalized', 'payments', p_payment_id,
            jsonb_build_object('provider', v_pay.provider, 'amount', v_pay.amount));
  return jsonb_build_object('ok', true, 'order_id', v_order.id, 'status', v_new_status::text);
end $$;

-- ============================================================================
-- release_expired_reservations — abandoned-checkout janitor (scheduler-driven).
-- ============================================================================
create or replace function public.release_expired_reservations(p_max_age interval default interval '45 minutes')
returns integer language plpgsql security definer set search_path = public as $$
declare v_count int := 0; rec record;
begin
  for rec in select o.id, o.order_number, o.customer_id from orders o
               where o.status = 'pending'
                 and ((o.reservation_expires_at is null and o.created_at < now() - p_max_age)
                      or o.reservation_expires_at < now())
                 and not exists (select 1 from payments p where p.order_id = o.id
                                  and p.status in ('awaiting_verification','successful'))
               for update of o skip locked
  loop
    update inventory i set reserved = greatest(i.reserved - oi.quantity, 0), updated_at = now()
      from order_items oi where oi.order_id = rec.id and oi.variant_id = i.variant_id and not oi.is_preorder;
    update orders set status = 'cancelled' where id = rec.id;
    insert into notifications (user_id, type, title, body)
      values (rec.customer_id, 'order', 'Reservation released — ' || rec.order_number,
              'Your unpaid reservation expired and stock was released. You can place a new order anytime.');
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

-- ============================================================================
-- submit_manual_payment — customer hands over proof of transfer.
-- The amount is authoritative from orders.total; the receipt must live under
-- the caller's own prefix in the private payment-receipts bucket.
-- ============================================================================
create or replace function public.submit_manual_payment(
  p_customer_id uuid, p_order_id uuid, p_receipt_path text,
  p_sender_account_name text default null, p_sender_account_number text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_order public.orders;
  v_pay public.payments;
  v_reference text; v_attempt int := 0;
  v_enabled boolean;
begin
  select manual_transfer_enabled into v_enabled from payment_settings where store_id is null limit 1;
  if coalesce(v_enabled, true) = false then raise exception 'PAYMENT_METHOD_UNAVAILABLE'; end if;

  select * into v_order from orders where id = p_order_id and customer_id = p_customer_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if v_order.status not in ('pending','pending_manual_verification') then raise exception 'ORDER_NOT_PAYABLE'; end if;
  if v_order.total is null or v_order.total <= 0 then raise exception 'INVALID_TOTAL'; end if;

  if p_receipt_path is null or p_receipt_path !~ ('^receipts/' || p_customer_id::text || '/' || p_order_id::text || '/[^/]+\.(jpg|jpeg|png|webp|pdf)$') then
    raise exception 'RECEIPT_PATH_INVALID';
  end if;

  select * into v_pay from payments where order_id = p_order_id for update;
  if v_pay.id is not null and v_pay.status in ('awaiting_verification','successful') then
    raise exception 'PAYMENT_ALREADY_IN_FLIGHT';
  end if;

  loop
    begin
      v_reference := 'MANUAL-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 12));
      if v_pay.id is null then
        insert into payments (order_id, provider, reference, status, amount, receipt_path, submitted_at,
                              sender_account_name, sender_account_number)
          values (p_order_id, 'manual_transfer', v_reference, 'awaiting_verification', v_order.total,
                  p_receipt_path, now(), nullif(trim(coalesce(p_sender_account_name,'')),''),
                  nullif(trim(coalesce(p_sender_account_number,'')),''))
          returning * into v_pay;
      else
        update payments set provider = 'manual_transfer', reference = v_reference,
          status = 'awaiting_verification', amount = v_order.total, receipt_path = p_receipt_path,
          submitted_at = now(), sender_account_name = nullif(trim(coalesce(p_sender_account_name,'')),''),
          sender_account_number = nullif(trim(coalesce(p_sender_account_number,'')),''),
          rejection_reason = null, bank_transaction_reference = null, admin_notes = null,
          reviewed_by = null, reviewed_at = null
          where id = v_pay.id returning * into v_pay;
      end if;
      exit;
    exception when unique_violation then
      v_attempt := v_attempt + 1;
      if v_attempt > 5 then raise exception 'REFERENCE_EXHAUSTED'; end if;
    end;
  end loop;

  update orders set status = 'pending_manual_verification' where id = p_order_id;

  insert into notifications (user_id, type, title, body)
    values (p_customer_id, 'payment', 'Transfer receipt received — ' || v_order.order_number,
            'Our team is verifying your transfer. You will be notified as soon as it is confirmed.');
  insert into notifications (user_id, type, title, body)
    select p.id, 'admin', 'Manual payment awaiting review',
           v_order.order_number || ' · ₦' || to_char(v_order.total, 'FM999999999990.00') || ' · ref ' || v_pay.reference
      from profiles p where p.role = 'admin';
  insert into audit_logs (actor_id, action, entity_type, entity_id, metadata)
    values (p_customer_id, 'payment.manual_submitted', 'payments', v_pay.id,
            jsonb_build_object('amount', v_order.total, 'receipt', p_receipt_path));

  return jsonb_build_object('ok', true, 'payment_id', v_pay.id, 'reference', v_pay.reference,
    'order_id', p_order_id, 'order_number', v_order.order_number, 'amount', v_order.total,
    'currency', 'NGN', 'status', 'pending_manual_verification');
end $$;

-- ============================================================================
-- review_manual_payment — admin approve/reject queue decision.
-- Approve requires a bank transaction reference and reuses the authoritative
-- finalization path; reject requires a reason, returns the order to pending
-- and releases reserved stock.
-- ============================================================================
create or replace function public.review_manual_payment(
  p_actor_id uuid, p_payment_id uuid, p_approve boolean,
  p_bank_transaction_reference text default null, p_admin_notes text default null,
  p_rejection_reason text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_pay public.payments;
  v_order public.orders;
  v_result jsonb;
begin
  if not exists (select 1 from profiles where id = p_actor_id and role = 'admin') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select * into v_pay from payments where id = p_payment_id for update;
  if not found then raise exception 'PAYMENT_NOT_FOUND'; end if;
  if v_pay.provider <> 'manual_transfer' then raise exception 'NOT_A_MANUAL_PAYMENT'; end if;
  if v_pay.status <> 'awaiting_verification' then raise exception 'PAYMENT_NOT_AWAITING_REVIEW'; end if;
  select * into v_order from orders where id = v_pay.order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;

  if p_approve then
    if nullif(trim(coalesce(p_bank_transaction_reference,'')),'') is null then
      raise exception 'BANK_REFERENCE_REQUIRED';
    end if;
    update payments set reviewed_by = p_actor_id, reviewed_at = now(),
      bank_transaction_reference = trim(p_bank_transaction_reference),
      admin_notes = nullif(trim(coalesce(p_admin_notes,'')),''),
      rejection_reason = null
      where id = p_payment_id;
    select finalize_successful_payment(p_payment_id, jsonb_build_object(
      'reviewed_by', p_actor_id,
      'bank_transaction_reference', trim(p_bank_transaction_reference),
      'admin_notes', nullif(trim(coalesce(p_admin_notes,'')),'')
    )) into v_result;
    insert into audit_logs (actor_id, action, entity_type, entity_id, metadata)
      values (p_actor_id, 'payment.manual_approved', 'payments', p_payment_id,
              jsonb_build_object('bank_reference', trim(p_bank_transaction_reference), 'order', v_order.order_number));
    return coalesce(v_result, jsonb_build_object('ok', true, 'payment_id', p_payment_id));
  else
    if nullif(trim(coalesce(p_rejection_reason,'')),'') is null then
      raise exception 'REJECTION_REASON_REQUIRED';
    end if;
    update payments set status = 'rejected', reviewed_by = p_actor_id, reviewed_at = now(),
      rejection_reason = trim(p_rejection_reason), admin_notes = nullif(trim(coalesce(p_admin_notes,'')),'')
      where id = p_payment_id;
    if v_order.status = 'pending_manual_verification' then
      update orders set status = 'pending' where id = v_order.id;
    end if;
    update inventory i set reserved = greatest(i.reserved - oi.quantity, 0), updated_at = now()
      from order_items oi where oi.order_id = v_order.id and oi.variant_id = i.variant_id and not oi.is_preorder;
    insert into notifications (user_id, type, title, body)
      values (v_order.customer_id, 'payment', 'Transfer not accepted — ' || v_order.order_number,
              trim(p_rejection_reason) || ' You can retry payment from your account.');
    insert into audit_logs (actor_id, action, entity_type, entity_id, metadata)
      values (p_actor_id, 'payment.manual_rejected', 'payments', p_payment_id,
              jsonb_build_object('reason', trim(p_rejection_reason), 'order', v_order.order_number));
    return jsonb_build_object('ok', true, 'payment_id', p_payment_id, 'status', 'rejected',
      'order_status', 'pending');
  end if;
end $$;

-- ============================================================================
-- Grants: service role only. Browsers cannot call these RPCs.
-- ============================================================================
revoke all on function public.create_order_atomically(uuid, jsonb, text, text, text, jsonb, uuid, uuid) from public, anon, authenticated;
revoke all on function public.finalize_successful_payment(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.release_expired_reservations(interval) from public, anon, authenticated;
revoke all on function public.submit_manual_payment(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.review_manual_payment(uuid, uuid, boolean, text, text, text) from public, anon, authenticated;
grant execute on function public.create_order_atomically(uuid, jsonb, text, text, text, jsonb, uuid, uuid) to service_role;
grant execute on function public.finalize_successful_payment(uuid, jsonb) to service_role;
grant execute on function public.release_expired_reservations(interval) to service_role;
grant execute on function public.submit_manual_payment(uuid, uuid, text, text, text) to service_role;
grant execute on function public.review_manual_payment(uuid, uuid, boolean, text, text, text) to service_role;
