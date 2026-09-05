-- Fashion Maison — manual bank transfer payments, receipt pipeline and Storage buckets.
-- Non-destructive and idempotent. Extends payments/orders, adds real Storage
-- bucket configuration (product-images public read, payment-receipts and
-- private-tailoring private) and the corresponding storage.objects RLS.

-- ============================================================================
-- 1) Order status for the verification queue.
-- ============================================================================
alter type public.order_status add value if not exists 'pending_manual_verification';

alter table public.orders add column if not exists reservation_expires_at timestamptz;

-- ============================================================================
-- 2) Payments: manual transfer review fields.
-- ============================================================================
alter table public.payments add column if not exists receipt_path text;
alter table public.payments add column if not exists submitted_at timestamptz;
alter table public.payments add column if not exists reviewed_by uuid references public.profiles(id) on delete set null;
alter table public.payments add column if not exists reviewed_at timestamptz;
alter table public.payments add column if not exists bank_transaction_reference text;
alter table public.payments add column if not exists admin_notes text;
alter table public.payments add column if not exists rejection_reason text;
alter table public.payments add column if not exists sender_account_name text;
alter table public.payments add column if not exists sender_account_number text;

do $$ begin
  if not exists (select 1 from pg_constraint where conrelid='public.payments'::regclass and conname='payments_status_check') then
    execute $c$alter table public.payments add constraint payments_status_check check (status in ('pending','awaiting_verification','successful','failed','rejected','refunded'))$c$;
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.payments'::regclass and conname='payments_provider_check') then
    execute $c$alter table public.payments add constraint payments_provider_check check (provider in ('paystack','manual_transfer'))$c$;
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.payments'::regclass and conname='payments_receipt_path_shape') then
    execute $c$alter table public.payments add constraint payments_receipt_path_shape check (receipt_path is null or (receipt_path ~ '^receipts/[0-9a-f-]{36}/[0-9a-f-]{36}/[^/]+$' and receipt_path ~ '\.(jpg|jpeg|png|webp|pdf)$'))$c$;
  end if;
end $$;
create index if not exists payments_review_queue on public.payments (status, submitted_at desc);

-- ============================================================================
-- 3) Storage buckets — created for real, not left as comments.
--    product-images  : public read (storefront), admin-only writes
--    payment-receipts: private, 10MB, JPEG/PNG/WebP/PDF, owner+admin read
--    private-tailoring: private, 10MB, owner+admin read
-- ============================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-images', 'product-images', true, 8388608, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update
  set public = true,
      file_size_limit = coalesce(storage.buckets.file_size_limit, 8388608),
      allowed_mime_types = coalesce(storage.buckets.allowed_mime_types, excluded.allowed_mime_types);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('payment-receipts', 'payment-receipts', false, 10485760, array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do update
  set public = false,
      file_size_limit = 10485760,
      allowed_mime_types = array['image/jpeg','image/png','image/webp','application/pdf'];

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('private-tailoring', 'private-tailoring', false, 10485760, array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do update
  set public = false,
      allowed_mime_types = coalesce(storage.buckets.allowed_mime_types, excluded.allowed_mime_types);

-- product-images: anonymous/signed-in read for rendering; admin uploads only.
drop policy if exists "product images public read" on storage.objects;
create policy "product images public read" on storage.objects for select to anon, authenticated
  using (bucket_id = 'product-images' and split_part(name, '/', 1) = 'products');
drop policy if exists "admin upload product images" on storage.objects;
create policy "admin upload product images" on storage.objects for insert to authenticated
  with check (bucket_id = 'product-images' and split_part(name, '/', 1) = 'products' and public.is_admin());
drop policy if exists "admin update product images" on storage.objects;
create policy "admin update product images" on storage.objects for update to authenticated
  using (bucket_id = 'product-images' and public.is_admin());
drop policy if exists "admin delete product images" on storage.objects;
create policy "admin delete product images" on storage.objects for delete to authenticated
  using (bucket_id = 'product-images' and public.is_admin());

-- payment-receipts: customers write under their own prefix, may read/delete
-- their own; admins may read for review. Never public.
drop policy if exists "receipts owner insert" on storage.objects;
create policy "receipts owner insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'payment-receipts'
    and split_part(name, '/', 1) = 'receipts'
    and split_part(name, '/', 2) = auth.uid()::text);
drop policy if exists "receipts owner or admin read" on storage.objects;
create policy "receipts owner or admin read" on storage.objects for select to authenticated
  using (bucket_id = 'payment-receipts'
    and (split_part(name, '/', 2) = auth.uid()::text or public.is_admin()));
drop policy if exists "receipts owner delete" on storage.objects;
create policy "receipts owner delete" on storage.objects for delete to authenticated
  using (bucket_id = 'payment-receipts' and split_part(name, '/', 2) = auth.uid()::text);

-- private-tailoring: customer owns {uid}/... objects; admin can review.
drop policy if exists "tailoring owner insert" on storage.objects;
create policy "tailoring owner insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'private-tailoring' and split_part(name, '/', 1) = auth.uid()::text);
drop policy if exists "tailoring owner or admin read" on storage.objects;
create policy "tailoring owner or admin read" on storage.objects for select to authenticated
  using (bucket_id = 'private-tailoring'
    and (split_part(name, '/', 1) = auth.uid()::text or public.is_admin()));
drop policy if exists "tailoring owner delete" on storage.objects;
create policy "tailoring owner delete" on storage.objects for delete to authenticated
  using (bucket_id = 'private-tailoring' and split_part(name, '/', 1) = auth.uid()::text);
drop policy if exists "tailoring owner update" on storage.objects;
create policy "tailoring owner update" on storage.objects for update to authenticated
  using (bucket_id = 'private-tailoring' and split_part(name, '/', 1) = auth.uid()::text);

-- ============================================================================
-- 4) Measurement profile reference images ride on the profile row itself.
-- ============================================================================
alter table public.measurement_profiles add column if not exists reference_paths jsonb not null default '[]';
