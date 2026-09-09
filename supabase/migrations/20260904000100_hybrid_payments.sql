-- Additive hybrid payments migration. Run after existing checkout migrations.
alter table payments add column if not exists payment_method text not null default 'paystack' check(payment_method in ('paystack','manual_bank_transfer'));
alter table payments add column if not exists receipt_path text;
alter table payments add column if not exists submitted_at timestamptz;
alter table payments add column if not exists verified_at timestamptz;
alter table payments add column if not exists verified_by uuid references profiles(id);
alter table payments add column if not exists rejection_reason text;
alter table payments add column if not exists bank_transaction_reference text;
alter table payments add column if not exists admin_notes text;
alter table payments add column if not exists updated_at timestamptz not null default now();
alter table payments drop constraint if exists payments_status_check;
alter table payments add constraint payments_status_check check(status in ('pending','pending_manual_verification','successful','paid','rejected','failed','cancelled','refunded'));
create unique index if not exists payments_reference_unique on payments(reference) where reference is not null;
alter table payments enable row level security;
create policy "customers read own payments" on payments for select using (exists(select 1 from orders o where o.id=payments.order_id and o.customer_id=auth.uid()));
create policy "admins manage payments" on payments for all using (public.is_admin()) with check (public.is_admin());
-- Create private payment-receipts bucket, then add owner/admin Storage policies in Supabase Storage.
-- insert into storage.buckets(id,name,public) values ('payment-receipts','payment-receipts',false) on conflict do nothing;
