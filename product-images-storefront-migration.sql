-- Fashion Maison — storefront product image access (non-destructive).
--
-- Why this exists:
--   public.product_images has RLS enabled in supabase-schema.sql, but no SELECT
--   policy for anon/authenticated. Nested storefront reads
--   `products?select=*,product_images(*)` therefore return published products
--   with an empty product_images array — name/price render, photos do not.
--   The product-images bucket was also documented as private; public object
--   URLs 403 even when a storage_path exists.
--
-- This migration does not alter product rows, storage_path values, or other
-- business tables. Safe to re-run.

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
$$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated, anon;

grant select on table public.product_images to anon, authenticated;
grant insert, update, delete on table public.product_images to authenticated;

drop policy if exists "public can read published product images" on public.product_images;
create policy "public can read published product images" on public.product_images
  for select to anon, authenticated
  using (
    exists (
      select 1 from public.products p
      where p.id = product_images.product_id
        and p.published = true
    )
  );

drop policy if exists "admins manage product images" on public.product_images;
create policy "admins manage product images" on public.product_images
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'product-images',
  'product-images',
  true,
  8388608,
  array['image/jpeg','image/png','image/webp']
)
on conflict (id) do update
  set public = true,
      file_size_limit = coalesce(storage.buckets.file_size_limit, 8388608),
      allowed_mime_types = coalesce(storage.buckets.allowed_mime_types, excluded.allowed_mime_types);

drop policy if exists "published catalog images readable" on storage.objects;
drop policy if exists "product images public read" on storage.objects;
create policy "published catalog images readable" on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'product-images');

drop policy if exists "admin upload catalog images" on storage.objects;
drop policy if exists "admin upload product images" on storage.objects;
create policy "admin upload catalog images" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'product-images' and public.is_admin());

drop policy if exists "admin update catalog images" on storage.objects;
drop policy if exists "admin update product images" on storage.objects;
create policy "admin update catalog images" on storage.objects
  for update to authenticated
  using (bucket_id = 'product-images' and public.is_admin())
  with check (bucket_id = 'product-images' and public.is_admin());

drop policy if exists "admin delete catalog images" on storage.objects;
drop policy if exists "admin delete product images" on storage.objects;
create policy "admin delete catalog images" on storage.objects
  for delete to authenticated
  using (bucket_id = 'product-images' and public.is_admin());
