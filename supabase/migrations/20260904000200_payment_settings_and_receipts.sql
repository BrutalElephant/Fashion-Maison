-- Additive company bank-transfer settings and private receipt storage contract.
create table if not exists public.payment_settings (id uuid primary key default gen_random_uuid(), bank_name text not null, account_name text not null, account_number text not null, payment_instructions text, is_active boolean not null default false, updated_at timestamptz not null default now(), updated_by uuid references profiles(id));
alter table public.payment_settings enable row level security;
create policy "public reads active payment settings" on payment_settings for select using (is_active=true);
create policy "admins manage payment settings" on payment_settings for all using (public.is_admin()) with check (public.is_admin());
-- Create a private bucket named payment-receipts in Storage (public=false).
-- Run in the Storage SQL editor after bucket creation:
-- insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values ('payment-receipts','payment-receipts',false,10485760,array['image/jpeg','image/png','image/webp','application/pdf']) on conflict (id) do nothing;
-- create policy "owners upload receipts" on storage.objects for insert to authenticated with check (bucket_id='payment-receipts' and (storage.foldername(name))[1]=auth.uid()::text);
-- create policy "owners read receipts" on storage.objects for select to authenticated using (bucket_id='payment-receipts' and ((storage.foldername(name))[1]=auth.uid()::text or public.is_admin()));
-- create policy "owners replace receipts" on storage.objects for update to authenticated using (bucket_id='payment-receipts' and ((storage.foldername(name))[1]=auth.uid()::text or public.is_admin()));
-- create policy "admins delete receipts" on storage.objects for delete to authenticated using (bucket_id='payment-receipts' and public.is_admin());
-- Admin receipt review should use createSignedUrl from a trusted/admin-authorized request.
create index if not exists payments_manual_queue on payments(payment_method,status,submitted_at desc);
