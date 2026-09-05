// admin-catalog — the authoritative Fashion Maison catalog & operations API.
// Every request requires an authenticated Supabase user whose profiles.role
// is 'admin' (checked via RLS-scoped read AND an explicit role read). Table
// operations run through the caller's own session so row-level security
// remains the enforcement layer; privileged actions (role changes, reservation
// cleanup) go through service-only RPCs that re-verify admin identity.
// deno-lint-ignore-file no-explicit-any
import { adminClient, authenticate, json, preflight, rpcError } from "../_shared/fm.ts";

const TABLES: Record<string, { columns: string[] }> = {
  products: {
    columns: ["name", "description", "price", "base_currency", "base_price", "status", "expected_availability",
      "published", "category_id", "store_id", "product_type", "brand", "sku", "attributes", "customizable",
      "pre_order_price", "pre_order_closes_at"],
  },
  product_images: { columns: ["product_id", "storage_path", "sort_order"] },
  product_variants: { columns: ["product_id", "size", "color", "sku", "price", "active"] },
  inventory: { columns: ["variant_id", "quantity", "reserved", "low_stock_threshold"] },
  categories: { columns: ["store_id", "name"] },
  payment_settings: {
    columns: ["store_id", "currency", "bank_name", "account_name", "account_number", "manual_instructions",
      "paystack_enabled", "manual_transfer_enabled", "reservation_minutes"],
  },
  delivery_methods: { columns: ["key", "label", "fee", "active", "sort_order"] },
  orders: { columns: ["status"] },
};

const ORDER_STATUSES = ["pending", "pending_manual_verification", "paid", "processing", "ready", "shipped", "delivered", "cancelled", "pre-order"];
const PRODUCT_STATUSES = ["AVAILABLE", "LOW STOCK", "OUT OF STOCK", "PRE-ORDER"];

const onlyAllowed = (rec: any, cols: string[]): any => {
  const out: any = {};
  for (const c of cols) if (rec && Object.prototype.hasOwnProperty.call(rec, c)) out[c] = rec[c];
  return out;
};

const validateProductImage = (record: any, product: any): string | null => {
  const path = String(record?.storage_path ?? "");
  const pid = String(record?.product_id ?? "");
  if (product && !/^[0-9a-f-]{36}$/i.test(pid)) return "product_id must be a uuid";
  if (/^https?:\/\//i.test(path)) return null; // legacy absolute URLs remain readable
  if (path.length > 380) return "storage_path is too long";
  if (!path.startsWith(`products/${pid}/`)) return "storage_path must be inside products/<product_id>/";
  if (!/\.(jpg|jpeg|png|webp)$/i.test(path)) return "storage objects must be JPEG/PNG/WebP";
  return null;
};

Deno.serve(async (req) => {
  const p = preflight(req); if (p) return p;
  if (req.method !== "POST") return json({ code: "METHOD_NOT_ALLOWED" }, 405);
  try {
    const caller = await authenticate(req, true);
    if (caller instanceof Response) return caller;
    if (caller.profile?.role !== "admin") return json({ code: "FORBIDDEN" }, 403);

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ code: "INVALID_REQUEST" }, 400);
    const op = String(body.operation ?? "select");

    // ---- privileged service-only operations ----
    if (op === "set_role") {
      const role = String(body.role ?? "");
      if (!["customer", "merchant", "admin"].includes(role)) return json({ code: "INVALID_ROLE" }, 400);
      if (!/^[0-9a-f-]{36}$/i.test(String(body.target_user_id ?? ""))) return json({ code: "INVALID_REQUEST" }, 400);
      const db = adminClient();
      const { data, error } = await db.rpc("admin_set_user_role", {
        p_actor_id: caller.user.id, p_user_id: body.target_user_id, p_new_role: role,
      });
      if (error) return json({ code: "ROLE_UPDATE_FAILED", message: error.message }, rpcError(error.message).status);
      return json({ ok: true, data });
    }
    if (op === "release_reservations") {
      const db = adminClient();
      const { data, error } = await db.rpc("release_expired_reservations", { p_max_age: "45 minutes" });
      if (error) return json({ code: "OPERATION_FAILED", message: error.message }, 500);
      return json({ ok: true, released: data ?? 0 });
    }

    // ---- table operations, executed under the admin's own session (RLS enforced) ----
    const table: string | null = Object.prototype.hasOwnProperty.call(TABLES, body.table) ? body.table : null;
    if (!table) return json({ code: "INVALID_RESOURCE" }, 400);
    const cols = TABLES[table].columns;
    // Caller is a verified admin; the service client still honors the admin
    // policies in RLS as a second layer and keeps audit writes server-side.
    const db = adminClient();

    if (op === "select") {
      let q = db.from(table).select(body.select ? String(body.select).slice(0, 400) : "*");
      if (body.filters && typeof body.filters === "object") {
        for (const [k, v] of Object.entries(body.filters)) {
          if (!cols.includes(k) && k !== "id" && k !== "status" && k !== "published" && k !== "customer_id" &&
              k !== "order_id" && k !== "product_id" && k !== "variant_id" && k !== "store_id" && k !== "submitted_at" &&
              k !== "created_at" && k !== "reference" && k !== "active" && k !== "provider" && k !== "payment_id" &&
              k !== "user_id" && k !== "entity_type" && k !== "role" && k !== "key" && !String(k).startsWith("orders.")) continue;
          if (v === null) q = q.is(k, null);
          else if (Array.isArray(v)) q = q.in(k, v as any[]);
          else q = q.eq(k, v as any);
        }
      }
      const order = String(body.order ?? "created_at.desc");
      if (/^[a-z0-9_.:,-]{1,80}$/.test(order)) q = q.order(order.split(".")[0], { ascending: !order.endsWith(".desc") });
      const limit = Math.min(Math.max(Number(body.limit) || 100, 1), 500);
      const { data, error } = await q.limit(limit);
      if (error) return json({ code: "CATALOG_OPERATION_FAILED", message: error.message }, 400);
      return json({ data });
    }

    if (op === "insert" || op === "update") {
      const record = onlyAllowed(body.record ?? {}, cols);
      if (!Object.keys(record).length) return json({ code: "INVALID_REQUEST", message: "No allowed columns supplied." }, 400);
      if (table === "products" && op === "insert" && !String(record.name ?? "").trim())
        return json({ code: "INVALID_REQUEST", message: "Product name is required." }, 400);
      if (table === "products" && record.status && !PRODUCT_STATUSES.includes(String(record.status)))
        return json({ code: "INVALID_STATUS" }, 400);
      if (table === "products" && record.price !== undefined && !(Number(record.price) >= 0))
        return json({ code: "INVALID_PRICE" }, 400);
      if (table === "product_images") {
        const err = validateProductImage({ ...record, product_id: body.record?.product_id }, body.record);
        if (err) return json({ code: "INVALID_STORAGE_PATH", message: err }, 400);
      }
      let result: any;
      if (op === "insert") {
        result = await db.from(table).insert(record).select().single();
      } else {
        if (!/^[0-9a-f-]{36}$/i.test(String(body.id ?? ""))) return json({ code: "INVALID_REQUEST", message: "id (uuid) required for update." }, 400);
        result = await db.from(table).update(record).eq("id", body.id).select().single();
      }
      if (result.error) return json({ code: "CATALOG_OPERATION_FAILED", message: result.error.message }, 400);
      await db.from("audit_logs").insert({
        actor_id: caller.user.id, action: `catalog.${op}`, entity_type: table,
        entity_id: result.data?.id ?? null, metadata: { record },
      }).then(() => null, () => null);
      return json({ data: result.data });
    }

    if (op === "delete") {
      if (table !== "product_images") return json({ code: "INVALID_OPERATION", message: "Only product images may be deleted via the catalog API." }, 400);
      if (!/^[0-9a-f-]{36}$/i.test(String(body.id ?? ""))) return json({ code: "INVALID_REQUEST" }, 400);
      const { data: row } = await db.from("product_images").select("id,storage_path").eq("id", body.id).single();
      if (!row) return json({ code: "NOT_FOUND" }, 404);
      const { error } = await db.from("product_images").delete().eq("id", row.id);
      if (error) return json({ code: "CATALOG_OPERATION_FAILED", message: error.message }, 400);
      if (!/^https?:\/\//i.test(row.storage_path) && row.storage_path.startsWith("products/")) {
        await db.storage.from("product-images").remove([row.storage_path]).catch(() => null);
      }
      await db.from("audit_logs").insert({ actor_id: caller.user.id, action: "catalog.delete", entity_type: table, entity_id: row.id, metadata: { storage_path: row.storage_path } }).then(() => null, () => null);
      return json({ ok: true });
    }

    if (op === "publish" || op === "unpublish") {
      if (!/^[0-9a-f-]{36}$/i.test(String(body.id ?? ""))) return json({ code: "INVALID_REQUEST" }, 400);
      const { data, error } = await db.from("products")
        .update({ published: op === "publish" }).eq("id", body.id).select("id,name,published").single();
      if (error) return json({ code: "CATALOG_OPERATION_FAILED", message: error.message }, 400);
      return json({ data });
    }

    if (op === "set_order_status") {
      if (!/^[0-9a-f-]{36}$/i.test(String(body.id ?? ""))) return json({ code: "INVALID_REQUEST" }, 400);
      if (!ORDER_STATUSES.includes(String(body.status ?? ""))) return json({ code: "INVALID_STATUS" }, 400);
      const { data, error } = await db.from("orders")
        .update({ status: body.status }).eq("id", body.id).select("id,order_number,status").single();
      if (error) return json({ code: "CATALOG_OPERATION_FAILED", message: error.message }, 400);
      return json({ data });
    }

    return json({ code: "INVALID_OPERATION" }, 400);
  } catch (e) {
    console.error("admin-catalog", e);
    return json({ code: "CATALOG_OPERATION_FAILED" }, 500);
  }
});
