-- Non-destructive admin catalog security and Storage policies.
create or replace function public.is_admin() returns boolean language sql stable security definer set search_path=public as $$ select exists(select 1 from profiles where id=auth.uid() and role='admin') $$;
revoke all on function public.is_admin() from public; grant execute on function public.is_admin() to authenticated;
create policy "admins manage catalog" on products for all using (public.is_admin()) with check (public.is_admin());
create policy "admins manage product images" on product_images for all using (public.is_admin()) with check (public.is_admin());
create policy "admins manage variants" on product_variants for all using (public.is_admin()) with check (public.is_admin());
create policy "admins manage inventory" on inventory for all using (public.is_admin()) with check (public.is_admin());
create policy "admins manage categories" on categories for all using (public.is_admin()) with check (public.is_admin());
create policy "admins read audit" on audit_logs for select using (public.is_admin());
-- Ensure customers cannot write catalog data: only admin policies above permit writes.
-- Storage setup (run after creating a private/public product-images bucket):
-- create policy "admin upload catalog images" on storage.objects for insert to authenticated with check (bucket_id='product-images' and public.is_admin());
-- create policy "admin update catalog images" on storage.objects for update to authenticated using (bucket_id='product-images' and public.is_admin());
-- create policy "admin delete catalog images" on storage.objects for delete to authenticated using (bucket_id='product-images' and public.is_admin());
-- create policy "published catalog images readable" on storage.objects for select to public using (bucket_id='product-images');
