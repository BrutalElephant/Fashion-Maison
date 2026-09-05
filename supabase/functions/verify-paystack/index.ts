// verify-paystack — authoritative server verification.
// Re-queries the Paystack API with the secret key and only finalizes the
// order after status/currency/amount all match the database-side payment.
// Requires the order's owner (or an admin) to be the authenticated caller,
// and it is idempotent for already-verified references.
// deno-lint-ignore-file no-explicit-any
import { adminClient, authenticate, env, json, preflight } from "../_shared/fm.ts";

Deno.serve(async (req) => {
  const p = preflight(req); if (p) return p;
  if (req.method !== "POST") return json({ code: "METHOD_NOT_ALLOWED" }, 405);
  try {
    const key = env("PAYSTACK_SECRET_KEY");
    if (!key) return json({ code: "PAYMENT_CONFIG_MISSING", message: "Paystack verification is unavailable: provider secret not configured." }, 503);

    const caller = await authenticate(req);
    if (caller instanceof Response) return caller;

    const body = await req.json().catch(() => ({} as any));
    const reference = String(body?.reference ?? "");
    if (!reference || reference.length > 200) return json({ code: "PAYMENT_FAILED", message: "Payment reference is required." }, 400);

    const db = adminClient();
    const { data: pay } = await db.from("payments")
      .select("id,order_id,amount,reference,status,orders:orders(id,customer_id,status)")
      .eq("reference", reference).maybeSingle();
    if (!pay) return json({ code: "PAYMENT_FAILED", message: "Unknown payment reference." }, 402);

    const order = Array.isArray(pay.orders) ? pay.orders[0] : pay.orders;
    if (order?.customer_id !== caller.user.id && caller.profile?.role !== "admin")
      return json({ code: "FORBIDDEN" }, 403);

    // Already finalized — replay success without re-verifying.
    if (pay.status === "successful")
      return json({ ok: true, order_id: order?.id, already_finalized: true });

    const r = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    const pstat = await r.json().catch(() => null);
    if (!r.ok || pstat?.data?.status !== "success")
      return json({ code: "PAYMENT_NOT_COMPLETE", message: "Paystack has not confirmed this payment yet.", paystack_status: pstat?.data?.status ?? null }, 402);
    if (pstat.data.currency !== "NGN") return json({ code: "PAYMENT_FAILED", message: "Currency mismatch." }, 402);
    if (Number(pstat.data.amount) !== Math.round(Number(pay.amount) * 100))
      return json({ code: "PAYMENT_FAILED", message: "Amount mismatch between Paystack and the order." }, 402);

    const { error } = await db.rpc("finalize_successful_payment", {
      p_payment_id: pay.id,
      p_provider_payload: { provider: "paystack", verified_at: new Date().toISOString(), transaction: pstat.data },
    });
    if (error) {
      console.error("finalize failed", error.message);
      return json({ code: "PAYMENT_FAILED", message: "Payment verified but could not be applied to the order." }, 409);
    }
    console.log("payment verified", reference);
    return json({ ok: true, order_id: order?.id });
  } catch (e) {
    console.error("verify-paystack", e);
    return json({ code: "PAYMENT_FAILED" }, 500);
  }
});
