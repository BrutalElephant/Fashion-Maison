-- Run after supabase-schema.sql. Trusted checkout primitives.
alter table orders add column if not exists idempotency_key text;
create unique index if not exists orders_customer_idempotency on orders(customer_id,idempotency_key) where idempotency_key is not null;
alter table orders add column if not exists fx_rate_snapshot numeric(20,8);
alter table orders add column if not exists usd_equivalent_snapshot numeric(12,2);
alter table orders add column if not exists fx_source_snapshot text;
alter table orders add column if not exists fx_timestamp_snapshot timestamptz;
alter table order_items add column if not exists product_name_snapshot text;
alter table order_items add column if not exists variant_snapshot jsonb;
alter table order_items add column if not exists subtotal_ngn numeric(12,2);
alter table order_items add column if not exists fx_rate_snapshot numeric(20,8);
alter table order_items add column if not exists usd_equivalent_snapshot numeric(12,2);
-- Production implementation note: deploy create_order_atomically as a SECURITY DEFINER function
-- that locks inventory rows with SELECT ... FOR UPDATE, validates product/base_price/status,
-- calculates configured delivery fees, reads current_usd_ngn_rate, inserts immutable snapshots,
-- reserves stock, and raises PRICE_CHANGED/STOCK_CHANGED/PRODUCT_UNAVAILABLE on mismatch.
-- It must be granted only to the authenticated Edge Function role, never directly to anon.
-- finalize_successful_payment must atomically change payment pending->successful, order pending->paid,
-- and convert reservations to sold stock; a release_expired_reservations job handles abandoned payments.
