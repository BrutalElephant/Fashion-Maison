// create-order — authenticated entry point for atomic order creation.
// The browser sends only identifiers (product/variant ids), quantities, a
// delivery method key, an idempotency key and contact fields. Prices, totals,
// stock, FX snapshots and pre-order flags are recomputed by the trusted SQL
// RPC; nothing monetary is taken from the client.
// deno-lint-ignore-file no-explicit-any
import { adminClient, authenticate, json, preflight, rpcError } from "../_shared/fm.ts";

Deno.serve(async (req) => {
  const p = preflight(req); if (p) return p;
  if (req.method !== "POST") return json({ code: "METHOD_NOT_ALLOWED" }, 405);
  try {
    const caller = await authenticate(req);
    if (caller instanceof Response) return caller;

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ code: "INVALID_REQUEST", message: "JSON body required" }, 400);

    const { items, address, address_id, delivery_method, payment_method, idempotency_key, measurement_profile_id } = body;
    if (!Array.isArray(items) || !items.length) return json({ code: "INVALID_REQUEST", message: "Cart items are required." }, 400);
    if (items.length > 50) return json({ code: "CART_TOO_LARGE" }, 400);
    if (items.some((x: any) => typeof x?.product_id !== "string" || !/^[0-9a-f-]{36}$/i.test(x.product_id)))
      return json({ code: "INVALID_REQUEST", message: "Every item needs a product_id." }, 400);
    if (items.some((x: any) => !Number.isInteger(x.quantity) || x.quantity < 1 || x.quantity > 99))
      return json({ code: "INVALID_QUANTITY", message: "Every quantity must be a whole number between 1 and 99." }, 400);
    if (typeof idempotency_key !== "string" || idempotency_key.length < 8)
      return json({ code: "INVALID_IDEMPOTENCY", message: "A unique idempotency key is required." }, 400);
    if (payment_method && !["paystack", "manual_transfer"].includes(payment_method))
      return json({ code: "PAYMENT_METHOD_INVALID" }, 400);

    // Normalize expected prices — advisory only; the RPC still decides.
    const cleanItems = items.map((x: any) => ({
      product_id: x.product_id,
      variant_id: typeof x.variant_id === "string" && /^[0-9a-f-]{36}$/i.test(x.variant_id) ? x.variant_id : null,
      quantity: x.quantity,
      expected_unit_price: Number.isFinite(Number(x.expected_unit_price)) ? Number(x.expected_unit_price) : null,
    }));

    const cleanAddress = address && typeof address === "object" ? {
      name: String(address.name ?? "").slice(0, 120),
      email: String(address.email ?? "").slice(0, 160),
      phone: String(address.phone ?? "").slice(0, 32),
      line1: String(address.line1 ?? "").slice(0, 240),
      city: String(address.city ?? "").slice(0, 120),
      state: String(address.state ?? "").slice(0, 120),
    } : null;

    const db = adminClient();
    const { data, error } = await db.rpc("create_order_atomically", {
      p_customer_id: caller.user.id,
      p_items: cleanItems,
      p_delivery_method: typeof delivery_method === "string" ? delivery_method : "store_pickup",
      p_idempotency_key: idempotency_key,
      p_payment_method: payment_method || "paystack",
      p_address: cleanAddress,
      p_address_id: typeof address_id === "string" && /^[0-9a-f-]{36}$/i.test(address_id) ? address_id : null,
      p_measurement_profile_id: typeof measurement_profile_id === "string" && /^[0-9a-f-]{36}$/i.test(measurement_profile_id) ? measurement_profile_id : null,
    });
    if (error) {
      console.error("create-order failed", error.message);
      const mapped = rpcError(error.message);
      return json({ code: mapped.code, message: (mapped as any).message || "Unable to create order.", detail: error.message }, mapped.status);
    }
    console.log("order created", data?.order_number);
    return json({ ok: true, order: data });
  } catch (e) {
    console.error("create-order error", e);
    return json({ code: "ORDER_FAILED", message: "Unable to create order." }, 500);
  }
});
