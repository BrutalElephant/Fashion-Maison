// initialize-paystack — creates a real Paystack session for an order.
// The charged amount is read from orders.total (server-side); the client's
// total is ignored. When PAYSTACK_SECRET_KEY is not configured the function
// truthfully reports PAYMENT_CONFIG_MISSING — it never simulates success.
// deno-lint-ignore-file no-explicit-any
import { adminClient, authenticate, env, json, preflight } from "../_shared/fm.ts";

Deno.serve(async (req) => {
  const p = preflight(req); if (p) return p;
  if (req.method !== "POST") return json({ code: "METHOD_NOT_ALLOWED" }, 405);
  try {
    const key = env("PAYSTACK_SECRET_KEY");
    if (!key) return json({ code: "PAYMENT_CONFIG_MISSING", message: "Paystack is not configured on this deployment. Choose manual bank transfer or contact the store." }, 503);

    const caller = await authenticate(req);
    if (caller instanceof Response) return caller;

    const body = await req.json().catch(() => ({} as any));
    const orderId = String(body?.order_id ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(orderId)) return json({ code: "ORDER_NOT_FOUND" }, 404);

    const db = adminClient();

    const { data: settings } = await db.from("payment_settings").select("paystack_enabled,currency")
      .is("store_id", null).limit(1).maybeSingle();
    if (settings && settings.paystack_enabled === false)
      return json({ code: "PAYMENT_METHOD_UNAVAILABLE", message: "Card payment via Paystack is currently disabled by the store." }, 409);

    const { data: o } = await db.from("orders")
      .select("id,order_number,total,currency,customer_id,status,payments:payments(id,status,provider)")
      .eq("id", orderId).eq("customer_id", caller.user.id).maybeSingle();
    if (!o || o.status !== "pending") return json({ code: "ORDER_NOT_FOUND_OR_PAYABLE" }, 404);

    const amount = Math.round(Number(o.total) * 100);
    if (!Number.isFinite(amount) || amount <= 0) return json({ code: "INVALID_TOTAL" }, 400);

    const email = String(body?.email || caller.user.email || "").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
      return json({ code: "INVALID_REQUEST", message: "A valid email is required for Paystack checkout." }, 400);

    let redirect = typeof body?.redirect_url === "string" ? body.redirect_url : "";
    if (redirect && !/^https?:\/\//i.test(redirect)) redirect = "";

    const reference = `FM-${o.order_number}-${crypto.randomUUID()}`;
    const r = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        email, amount, currency: "NGN", reference,
        ...(redirect ? { callback_url: redirect } : {}),
        metadata: { order_id: o.id, order_number: o.order_number },
      }),
    });
    const paystack = await r.json().catch(() => null);
    if (!r.ok || !paystack?.status || !paystack?.data?.authorization_url) {
      console.error("paystack init failed", r.status, paystack?.message);
      return json({ code: "PAYMENT_INIT_FAILED", message: paystack?.message || "Paystack could not start the session." }, 502);
    }

    await db.from("payments").upsert(
      { order_id: o.id, provider: "paystack", reference, status: "pending", amount: o.total },
      { onConflict: "order_id" },
    );
    console.log("payment initialized", o.order_number);
    return json({
      ok: true,
      authorization_url: paystack.data.authorization_url,
      access_code: paystack.data.access_code ?? null,
      reference,
      amount_ngn_kobo: amount,
      order_id: o.id,
      currency: "NGN",
    });
  } catch (e) {
    console.error("initialize-paystack", e);
    return json({ code: "PAYMENT_INIT_FAILED" }, 500);
  }
});
