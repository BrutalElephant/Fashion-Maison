-- Fashion Maison — write house bank-transfer coordinates onto the existing
-- platform payment_settings row used by checkout and #/pay.
--
-- Intended values:
--   bank_name      = Opay
--   account_name   = VICTOR NGOZI ANYANWU
--   account_number = 9162708852
--
-- Updates ONLY those three columns on exactly one identified row.
-- Does not change paystack_enabled, manual_transfer_enabled (existing value
-- is kept; NULL is coalesced to true only on INSERT of a new empty row),
-- payment_instructions, currency, reservation_minutes, store_id, or is_active.
-- Does not DROP/DELETE, does not touch orders/payments/products/images/RLS.
--
-- Targeting — refuses to guess if more than one candidate exists:
--   1. store_id IS NULL (platform row), when store_id exists
--   2. is_active IS TRUE, when is_active exists and store_id does not
--   3. the sole row in the table, when count = 1
--   4. INSERT a platform row when none of the above exist
-- Safe to re-run (idempotent values).

alter table public.payment_settings add column if not exists bank_name text;
alter table public.payment_settings add column if not exists account_name text;
alter table public.payment_settings add column if not exists account_number text;

do $$
declare
  has_store boolean;
  has_active boolean;
  has_id boolean;
  has_manual boolean;
  has_currency boolean;
  has_paystack boolean;
  has_instructions boolean;
  n bigint;
  target uuid;
  target_ctid tid;
  sql text;
  updated int;
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
    where table_schema='public' and table_name='payment_settings' and column_name='id'
  ) into has_id;
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
    if n > 1 then
      raise exception 'payment_settings has % platform rows (store_id is null); refusing to overwrite more than one', n;
    elsif n = 1 then
      if has_id then
        execute 'select id from public.payment_settings where store_id is null' into target;
      else
        execute 'select ctid from public.payment_settings where store_id is null' into target_ctid;
      end if;
    end if;
  elsif has_active then
    execute 'select count(*) from public.payment_settings where is_active is true' into n;
    if n > 1 then
      raise exception 'payment_settings has % is_active rows; refusing to overwrite more than one', n;
    elsif n = 1 then
      if has_id then
        execute 'select id from public.payment_settings where is_active is true' into target;
      else
        execute 'select ctid from public.payment_settings where is_active is true' into target_ctid;
      end if;
    else
      execute 'select count(*) from public.payment_settings' into n;
      if n > 1 then
        raise exception 'no is_active payment_settings row and % other rows; refusing to guess', n;
      elsif n = 1 then
        if has_id then
          execute 'select id from public.payment_settings' into target;
        else
          execute 'select ctid from public.payment_settings' into target_ctid;
        end if;
      end if;
    end if;
  else
    execute 'select count(*) from public.payment_settings' into n;
    if n > 1 then
      raise exception 'payment_settings has % rows and no store_id/is_active discriminator; refusing to guess', n;
    elsif n = 1 then
      if has_id then
        execute 'select id from public.payment_settings' into target;
      else
        execute 'select ctid from public.payment_settings' into target_ctid;
      end if;
    end if;
  end if;

  if target is not null then
    execute
      'update public.payment_settings set bank_name = $1, account_name = $2, account_number = $3 where id = $4'
      using 'Opay', 'VICTOR NGOZI ANYANWU', '9162708852', target;
    get diagnostics updated = row_count;
    if updated <> 1 then
      raise exception 'expected to update 1 payment_settings row by id, updated %', updated;
    end if;
  elsif target_ctid is not null then
    execute
      'update public.payment_settings set bank_name = $1, account_name = $2, account_number = $3 where ctid = $4'
      using 'Opay', 'VICTOR NGOZI ANYANWU', '9162708852', target_ctid;
    get diagnostics updated = row_count;
    if updated <> 1 then
      raise exception 'expected to update 1 payment_settings row by ctid, updated %', updated;
    end if;
  else
    sql := 'insert into public.payment_settings (bank_name, account_name, account_number';
    if has_store then sql := sql || ', store_id'; end if;
    if has_currency then sql := sql || ', currency'; end if;
    if has_manual then sql := sql || ', manual_transfer_enabled'; end if;
    if has_paystack then sql := sql || ', paystack_enabled'; end if;
    if has_active then sql := sql || ', is_active'; end if;
    sql := sql || ') values ('
      || quote_literal('Opay') || ', '
      || quote_literal('VICTOR NGOZI ANYANWU') || ', '
      || quote_literal('9162708852');
    if has_store then sql := sql || ', null'; end if;
    if has_currency then sql := sql || ', ' || quote_literal('NGN'); end if;
    if has_manual then sql := sql || ', true'; end if;
    if has_paystack then sql := sql || ', true'; end if;
    if has_active then sql := sql || ', true'; end if;
    sql := sql || ')';
    execute sql;
  end if;
end $$;
