-- Fashion Maison — store the house bank-transfer coordinates in the existing
-- public.payment_settings row used by checkout and the #/pay proof page.
--
-- Updates ONLY bank_name, account_name, account_number (and enables
-- manual_transfer_enabled when that column exists so Bank Transfer remains
-- selectable). Does not drop/recreate tables, does not touch orders, payments,
-- products, images, statuses, Paystack flags, payment_instructions, RLS, or
-- unrelated rows (merchant store_id rows are left alone).
--
-- Safe to re-run.

alter table public.payment_settings add column if not exists bank_name text;
alter table public.payment_settings add column if not exists account_name text;
alter table public.payment_settings add column if not exists account_number text;

do $$
declare
  has_store boolean;
  has_active boolean;
  has_manual boolean;
  has_currency boolean;
  has_paystack boolean;
  has_instructions boolean;
  n bigint;
  where_sql text := '';
  upd text;
  sql text;
begin
  if to_regclass('public.payment_settings') is null then
    raise exception 'payment_settings is missing';
  end if;

  select exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='payment_settings' and column_name='store_id'
  ) into has_store;
  select exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='payment_settings' and column_name='is_active'
  ) into has_active;
  select exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='payment_settings' and column_name='manual_transfer_enabled'
  ) into has_manual;
  select exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='payment_settings' and column_name='currency'
  ) into has_currency;
  select exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='payment_settings' and column_name='paystack_enabled'
  ) into has_paystack;
  select exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='payment_settings' and column_name='payment_instructions'
  ) into has_instructions;

  if has_store then
    execute 'select count(*) from public.payment_settings where store_id is null' into n;
    where_sql := ' where store_id is null';
  elsif has_active then
    execute 'select count(*) from public.payment_settings where is_active is true' into n;
    where_sql := ' where is_active is true';
    if n = 0 then
      execute 'select count(*) from public.payment_settings' into n;
      where_sql := '';
    end if;
  else
    execute 'select count(*) from public.payment_settings' into n;
    where_sql := '';
  end if;

  if n > 0 then
    upd := 'update public.payment_settings set bank_name = $1, account_name = $2, account_number = $3';
    if has_manual then
      upd := upd || ', manual_transfer_enabled = true';
    end if;
    upd := upd || where_sql;
    execute upd using 'Opay', 'VICTOR NGOZI ANYANWU', '9162708852';
  else
    sql := 'insert into public.payment_settings (bank_name, account_name, account_number';
    if has_store then sql := sql || ', store_id'; end if;
    if has_currency then sql := sql || ', currency'; end if;
    if has_manual then sql := sql || ', manual_transfer_enabled'; end if;
    if has_paystack then sql := sql || ', paystack_enabled'; end if;
    if has_active then sql := sql || ', is_active'; end if;
    if has_instructions then sql := sql || ', payment_instructions'; end if;
    sql := sql || ') values ('
      || quote_literal('Opay') || ', '
      || quote_literal('VICTOR NGOZI ANYANWU') || ', '
      || quote_literal('9162708852');
    if has_store then sql := sql || ', null'; end if;
    if has_currency then sql := sql || ', ' || quote_literal('NGN'); end if;
    if has_manual then sql := sql || ', true'; end if;
    if has_paystack then sql := sql || ', true'; end if;
    if has_active then sql := sql || ', true'; end if;
    if has_instructions then
      sql := sql || ', ' || quote_literal('Transfer the exact order total, then upload proof of payment. Approval is never automatic.');
    end if;
    sql := sql || ')';
    execute sql;
  end if;
end $$;
