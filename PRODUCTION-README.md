# Fashion Maison — production repository

Premium storefront + Supabase backend for Fashion Maison: real auth, admin-owned catalog with public product images, server-authoritative cart/checkout, Paystack **and** manual bank transfer with a private receipt verification queue, pre-orders, bespoke tailoring, FX display, and a PWA shell. The UI design is the production design — this file documents what is implemented and what deployment requires.

## Layout
- `index.html`, `app.js`, `style.css`, `cinematic-engine.js`, `supabase-client.js` — static storefront (no build step). `config.js` (gitignored, see `runtime-config.example.js`) supplies `window.FASHION_MAISON_CONFIG = { url, publishableKey }` at deploy time.
- `supabase/migrations/` — the database is defined **only** by these timestamped files (oldest → newest). The old standalone root `*-migration.sql` files were folded in and removed.
- `supabase/functions/` — Edge Functions (TypeScript/Deno): `create-order`, `initialize-paystack`, `verify-paystack`, `submit-manual-payment`, `verify-manual-payment`, `payment-receipt-url`, `admin-catalog`, `update-fx-rate`, plus `_shared/fm.ts`.
- `supabase-schema.sql` — original reference schema; kept for reading, superseded by migrations.
- `tools/make_icons.py` — regenerates the PWA icons in `assets/icons/`.

## Deploy order
1. `supabase link` then `supabase db push` (or run each migration file in the SQL Editor in order).
2. Migrations create the Storage buckets for real: `product-images` (public read, admin write, 8MB, JPEG/PNG/WebP), `payment-receipts` (private, 10MB, JPEG/PNG/WebP/PDF, owner+admin read), `private-tailoring` (private, per-customer prefixes). Nothing else to click.
3. Secrets (Edge Functions): `supabase secrets set SUPABASE_URL=… SUPABASE_ANON_KEY=…(or SUPABASE_PUBLISHABLE_KEY) SUPABASE_SERVICE_ROLE_KEY=… CURRENCYAPI_KEY=… PAYSTACK_SECRET_KEY=… FX_SCHEDULER_SECRET=… FX_FALLBACK_WINDOW_HOURS=24`.
4. Deploy functions: `supabase functions deploy` (all nine).
5. Promote the first admin **server-side** (SQL Editor or migration): `update profiles set role='admin' where id='<uuid>';` — the REST layer can no longer write `profiles.role` at all (column grants revoked for `anon`/`authenticated`, trigger `protect_profile_role` blocks role writes, `admin_set_user_role` RPC is service-role-only and audited). Afterwards the dashboard's Customers tab can change roles.
6. Admin dashboard → Payment settings: enter the real bank coordinates; enable/disable Paystack vs manual transfer; reservation window.

## Security model (implemented, not aspirational)
- **Prices/totals/stock/payment status are never taken from the browser.** `create-order` validates the session, then calls the `SECURITY DEFINER` RPC `create_order_atomically` (service-role-only grant): it re-reads `products.base_price/variant.price`, `SELECT … FOR UPDATE` on inventory in deterministic order, refuses drift (`PRICE_CHANGED`, `STOCK_CHANGED`, `PRODUCT_UNAVAILABLE`), applies `delivery_methods` fees, snapshots `current_usd_ngn_rate` onto order and line items, reserves stock with an expiry (`reservation_expires_at`, `release_expired_reservations` janitor), records pre-order lines without reservation, and is idempotent per `(customer_id, idempotency_key)`.
- **Payments.** Paystack is charged in NGN from `orders.total` server-side; `verify-paystack` re-verifies reference/status/currency/amount against the provider API before `finalize_successful_payment` flips payment→successful, order→paid (or pre-order), converts reservations to sold, and recomputes product stock status. Missing `PAYSTACK_SECRET_KEY` returns a truthful 503 `PAYMENT_CONFIG_MISSING` — success is never simulated.
- **Manual bank transfer (complete flow).** Checkout → platform `payment_settings` (real bank coordinates, admin-maintained) → customer transfers → uploads receipt to the **private** `payment-receipts` bucket under `receipts/<user_id>/<order_id>/` → `submit-manual-payment` verifies the object exists and the path belongs to the caller, records the authoritative `orders.total`, moves the order to `pending_manual_verification` and notifies admins → **admin queue** (dashboard → Manual payments) shows reference, order, customer, amount and a 60-second signed receipt view (`payment-receipt-url`, owner-or-admin only) → **Approve** requires a bank transaction reference (reuses the authoritative finalization path → `paid`, stock sold) / **Reject** requires a reason (order back to `pending`, reservation released, customer notified). All decisions are written to `audit_logs`.
- **RLS.** Customers see only their own profile/cart/orders/addresses/notifications/measurements/receipts; storefront reads are limited to published products (+ their images/variants/categories, approved stores); admins manage catalog, orders, payments, settings, users; `is_admin()` is the SECURITY DEFINER gate; service-role key exists only in Edge Function secrets. Product images of published products are readable through `product_images` RLS *and* the public bucket.
- **Carts.** `carts`/`cart_items` are the real persistence layer when signed in (variant-aware, `unique (cart_id, product_id, variant_id) nulls not distinct`); localStorage is a fallback for anonymous/abandoned sessions and is merged into the server cart on sign-in.
- **FX.** CurrencyAPI is called only by `update-fx-rate`, which requires the scheduler secret header or an admin session, rejects >35% unforced drift, and inserts immutable `exchange_rates` rows. The browser reads the `current_usd_ngn_rate` view for display only; the trusted RPC snapshots it per order. No key reaches the client.
- **Tailoring.** `measurement_profiles` + `custom_order_options` exist per the hardening migration; reference photos go to `private-tailoring/<user_id>/…` (owner + admin only). Checkout attaches a measurement profile into `orders.tailoring_snapshot` and `custom_order_options`; one customer can never read another's files.

## Storefront routes
`#/` home · `#/shop` catalog · `#/product/<id>` · `#/cart` · `#/checkout` (sign-in required when connected) · `#/checkout/return?reference=…` (Paystack verification) · `#/pay/<order_id>` resume payment · `#/account` orders/profile/measurements · `#/admin` dashboard (admin role required) · `#/merchant` store program info.

## Image pipeline (blank-image fixes)
Admin uploads via dashboard → storage object `product-images/products/<product_id>/<file>` (admin-only insert policy) → `product_images.storage_path` row (path validated by `admin-catalog`) → storefront renders `…/storage/v1/object/public/product-images/products/…` through `hydrateImages()`, which probes the URL first and paints an on-brand placeholder on miss (never a broken/blank tile). Legacy absolute URLs stored in `storage_path` keep working. To re-verify on the live project: load the White Louis Vuitton Sneakers product page and confirm the hero/storage image renders from the public URL.

## Scheduler
Hourly FX refresh and reservation cleanup (from pg_cron or any scheduler that can send headers):
`curl -X POST $URL/functions/v1/update-fx-rate -H "x-fx-secret: $FX_SCHEDULER_SECRET"` and, periodically, admin dashboard → “Release expired reservations” (or a scheduled `admin-catalog {"operation":"release_reservations"}` call).

## Validation performed (2026-09-05)
`node --check` passes for `app.js`, `supabase-client.js`, `cinematic-engine.js`; every Edge Function passes `node --check` and a `tsc --noEmit` pass against real `@supabase/supabase-js@2` types; a scripted DOM harness exercised login → variant cart → create-order → manual receipt → review queue → Paystack redirect/return against a mocked backend. Migrations target PostgreSQL 15+/17 Supabase projects and are written to be non-destructive and idempotent; they were authored for a live project whose API was not reachable from this workspace, so run `supabase db push` against it and then the checks in “Deploy order”.

## Status
- Frontend / storefront: IMPLEMENTED (design unchanged).
- Auth & sessions: IMPLEMENTED (email/password via GoTrue REST, refresh-token handling, route guards for account + admin).
- Product images: IMPLEMENTED (RLS read for published products, public bucket, path→URL rendering, admin upload path, placeholder fallback).
- Cart: IMPLEMENTED (Supabase `carts`/`cart_items` authoritative when signed in, local fallback + merge).
- Checkout / inventory: IMPLEMENTED in code (`create_order_atomically`, reservations, idempotency, oversell-safe locks) — pending deployment.
- Paystack: IMPLEMENTED; live payments require `PAYSTACK_SECRET_KEY` (never faked when absent).
- Manual bank transfer + admin review queue + private receipts: IMPLEMENTED end-to-end in code; payment settings values must be entered by the admin (no placeholder bank data on purpose).
- Pre-orders: IMPLEMENTED (pre-order lines skip reservation, `preorders` row with expected availability, order status `pre-order` on payment).
- Catalog authority: IMPLEMENTED (`products.store_id` nullable = house selection; no synthetic merchants; admin CRUD via `admin-catalog`).
- Tailoring: IMPLEMENTED (profiles, reference upload, private storage, order snapshot).
- FX: IMPLEMENTED + hardened (secret server-side, gated updater, snapshots).
- RLS/Storage: IMPLEMENTED via migrations (no policy left as a comment for the payment/tailoring/catalog paths).
- PWA: IMPLEMENTED (v3 service worker: shell precache, network-first navigation, Supabase traffic never cached; generated 192/512/maskable icons).
- Deployment (push migrations, deploy functions, set secrets, promote first admin, enter bank settings): REQUIRES project credentials + network access to the live Supabase project — the one genuinely environment-dependent step.
