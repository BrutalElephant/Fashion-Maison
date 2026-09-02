# Fashion Maison — production backend

The existing premium storefront remains intact. `supabase-schema.sql` is the production PostgreSQL/Supabase schema with RLS, indexes, relationships, variant inventory and order/payment records.

## Configure
1. Create a Supabase project and run `supabase-schema.sql` in SQL Editor.
2. Create a private `product-images` Storage bucket. Add Storage policies scoped to the merchant's store.
3. Configure Auth email/phone providers and set the first admin's `profiles.role` to `admin` using a server-side migration.
4. Deploy server-side Supabase Edge Functions (never browser code) for `create-order`, `initialize-paystack`, `verify-paystack`, and `update-order-status`. These functions must re-read prices/stock, use a transaction/row locks for inventory, and only mark paid after Paystack server verification.
5. Set secrets in Supabase Edge Functions: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PAYSTACK_SECRET_KEY`. The Paystack public key may be exposed only in a client environment variable.

## Current audit
- Frontend: WORKING — existing responsive storefront, detail, search, cart and checkout interaction.
- Backend: PARTIALLY IMPLEMENTED — schema and RLS are supplied; this static preview has no project URL or credentials.
- Database: IMPLEMENTED — normalized tables, constraints, indexes, timestamps and RLS SQL.
- Auth: MISSING IN PREVIEW — wire Supabase Auth UI to the profiles role model.
- Product management/uploads: PARTIALLY IMPLEMENTED — database/storage contract is defined; needs authenticated merchant screens and Storage client.
- Inventory/cart/orders: PARTIALLY IMPLEMENTED — schema is ready; trusted Edge Functions are required for atomic checkout.
- Paystack: ARCHITECTURE READY — requires provider credentials and Edge Functions; no simulated payment is claimed.
- Pre-orders: IMPLEMENTED IN MODEL — `product_status`, expected date, order status and `preorders` table.
- Merchant dashboard: PARTIALLY IMPLEMENTED — overview is present; CRUD/API wiring remains credential-dependent.
- Customer account: PARTIALLY IMPLEMENTED — route placeholder remains; auth/order-history wiring required.
- Security/RLS: IMPLEMENTED BASELINE — policies included; Storage policies and admin policies should be added before launch.
- PWA: WORKING — manifest and service-worker shell caching.
- Deployment: READY FOR CONFIGURATION — serve over HTTPS, configure Supabase secrets, Storage policies, email templates and Edge Functions.

## Dual-currency pricing

NGN remains the authoritative product price. The storefront now renders a secondary USD equivalent through the shared `fx()` engine when a server-provided rate is available (`window.FM_FX_RATE` or the temporary `fm-fx-rate` cache). Without a validated rate it correctly shows `USD price temporarily unavailable` and never invents a value. Add an authenticated Supabase read for the latest `exchange_rates` row in the production client, and have an hourly Edge Function populate that table from the approved provider. Add `base_currency`, `base_price`, and order-item FX snapshot columns in the next migration before checkout is enabled:

```sql
alter table products add column if not exists base_currency char(3) not null default 'NGN';
alter table products add column if not exists base_price numeric(12,2);
alter table order_items add column if not exists unit_price_ngn numeric(12,2);
alter table order_items add column if not exists fx_rate_snapshot numeric(20,8);
alter table order_items add column if not exists usd_equivalent_snapshot numeric(12,2);
```

FX audit: **FX database READY**, **USD conversion READY**, **product/cart display READY**, **provider and automatic refresh BLOCKED until provider credentials and Edge Function are deployed**, **order snapshot BLOCKED until migration and trusted checkout function are deployed**, **security READY at schema baseline**. No FX rate is hard-coded as a live value.

## currencyapi FX deployment

`supabase/functions/update-fx-rate/index.ts` is the server-only updater. It calls currencyapi for USD to NGN, validates the response, inserts an immutable audit row, and never deletes historical rates. The browser never receives `CURRENCYAPI_KEY`.

Setup:

```bash
supabase secrets set CURRENCYAPI_KEY=your_currencyapi_key
supabase functions deploy update-fx-rate
curl -X POST https://YOUR_PROJECT.supabase.co/functions/v1/update-fx-rate
```

Configure Supabase Cron/pg_cron to invoke the function hourly (or use an external scheduler):

```sql
select cron.schedule('fashion-maison-fx-hourly','0 * * * *', $$
  select net.http_post(url := 'https://YOUR_PROJECT.supabase.co/functions/v1/update-fx-rate', headers := jsonb_build_object('Authorization','Bearer YOUR_FUNCTION_SECRET'));
$$);
```

Use `current_usd_ngn_rate` for storefront reads. The checkout Edge Function must independently query that view/table, calculate the USD snapshot from authoritative NGN totals, and charge Paystack in NGN; browser `window.FM_FX_RATE` is display-only. Configure `FX_FALLBACK_WINDOW_HOURS` for stale-rate policy and show the last successful `effective_at` timestamp when inside that window.

Final FX audit: **FX provider READY**, **Edge Function READY**, **exchange_rates READY**, **hourly refresh BLOCKED until scheduler is configured**, **currencyapi connection BLOCKED until CURRENCYAPI_KEY is set and a successful invocation inserts a row**, **stale handling READY at data-model level**, **trusted checkout FX BLOCKED until the checkout Edge Function is deployed**, **historical snapshot BLOCKED until checkout migration/function is deployed**, **Paystack NGN authority READY by design**.

## Trusted checkout and Paystack

Added Edge Functions:
- `supabase/functions/create-order/index.ts` — authenticated input validation and server-side RPC boundary.
- `supabase/functions/initialize-paystack/index.ts` — reads `orders.total` from the database and initializes Paystack in NGN only.
- `supabase/functions/verify-paystack/index.ts` — server-verifies reference, status, currency and amount before calling the finalization RPC.

Run `checkout-migration.sql` in Supabase. The atomic SQL functions `create_order_atomically` and `finalize_successful_payment` must be deployed as `SECURITY DEFINER` functions with row locks, idempotency, reservation release and immutable snapshots as documented in that migration. This preview cannot execute them without a connected Supabase project.

Checkout audit: **Edge Function boundaries READY**, **browser manipulation protection READY**, **Paystack NGN authority READY**, **atomic inventory BLOCKED until the SQL RPCs are deployed**, **trusted checkout FX BLOCKED until the RPC reads `current_usd_ngn_rate`**, **historical snapshots BLOCKED until migration/RPC deployment**, **live payments BLOCKED until `PAYSTACK_SECRET_KEY`, Supabase secrets and webhook/verification deployment are configured**.

## Production hardening and catalog model

Added `production-hardening-migration.sql` non-destructively. It extends the shared product model with product types, brands, SKUs, extensible JSON attributes, customization and pre-order controls; adds inventory sold/low-stock tracking; adds private customer `measurement_profiles`, immutable custom-order option snapshots, and server-only `audit_logs`. It also adds RLS for measurement ownership and a private tailoring Storage bucket contract. No separate clothing/shoe/watch tables are introduced.

The existing static preview remains a visual/demo client. The full admin catalog CRUD, authenticated routes, Storage upload UI, measurement UI and production checkout require wiring to deployed Supabase Auth, RLS, Storage and Edge Functions. Do not expose service-role credentials in the browser.

## Honest master audit

FRONTEND: CODE READY. ADMIN AUTH/CATALOG: BLOCKED — no connected Supabase Auth session or admin Edge Function in this static workspace. CLOTHING/NATIVE WEAR/SHOES/WATCHES/ACCESSORIES: SCHEMA READY — use shared products.attributes and product_type; requires migration deployment and admin CRUD. PRODUCT IMAGES/VARIANTS/INVENTORY: SCHEMA/EDGE BOUNDARY READY, DEPLOYMENT REQUIRED. READY-MADE PRE-ORDERS: MODEL READY, checkout RPC deployment required. CUSTOM TAILORING/MEASUREMENT PROFILES/REFERENCE UPLOADS/CUSTOM PRICING: MODEL READY, private Storage policies and trusted custom-order RPC/UI required. CART: DEMO FUNCTIONAL, Supabase persistence pending. TRUSTED CHECKOUT/FX SNAPSHOTS/PAYSTACK: Edge Function code and schema contracts exist, but RPCs/secrets/deployment are required. CUSTOMER ACCOUNT: BLOCKED pending Auth UI. ADMIN DASHBOARD: DEMO OVERVIEW ONLY. RLS: BASELINE READY, must be applied and integration-tested in the project. MOBILE: READY. PERFORMANCE/TESTING: BLOCKED — no npm project or connected integration environment. DEPLOYMENT: BLOCKED until migrations, secrets, Auth, Storage, scheduler and functions are deployed. GITHUB SAFETY: READY.

Required production configuration: `SUPABASE_URL`, `SUPABASE_ANON_KEY`/publishable key, `SUPABASE_SERVICE_ROLE_KEY` (Edge Functions only), `CURRENCYAPI_KEY`, `PAYSTACK_SECRET_KEY`, Storage policies, Auth settings and scheduler. Never commit these values.

## Admin catalog hardening

Added `admin-catalog-migration.sql` with a protected `is_admin()` helper and admin-only policies for products, images, variants, inventory, categories and audit reads. Added `supabase/functions/admin-catalog/index.ts`, which requires an authenticated Supabase user whose database role is `admin`, then delegates catalog operations through RLS. Product image Storage policies are included as deployment SQL comments because bucket creation/policy application is project configuration.

Master audit: ADMIN AUTH **BLOCKED pending deployed Supabase Auth/project verification**; ADMIN ROUTES **CODE BLOCKED in this static client**; PRODUCT CRUD **Edge Function READY, deployment required**; PRODUCT IMAGES/STORAGE **POLICY READY, bucket deployment required**; VARIANTS/INVENTORY **SCHEMA/POLICY READY, deployment required**; WATCHES/SHOES/CLOTHING/NATIVE WEAR **shared model READY**; PRE-ORDERS/CUSTOM PRODUCTS/CUSTOM PRICING **model/architecture READY, trusted UI/RPC required**; NGN/USD **READY in existing engine**; PUBLISH WORKFLOW **function boundary READY, validation RPC required**; SKU VALIDATION **database migration required**; RLS/AUDIT **baseline READY, must be applied and tested**; STOREFRONT DATABASE CONNECTION **BLOCKED by network/project verification**.

This preview deliberately does not pretend that payment or persistence is live without project credentials.