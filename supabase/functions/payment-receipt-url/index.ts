// payment-receipt-url — secure receipt viewing.
// Returns a short-lived (60s) signed URL for the private payment-receipts
// object. Only the owning customer or an admin receives one; the object is
// never made public. Also supports tailoring references in private-tailoring.
// deno-lint-ignore-file no-explicit-any
import { adminClient, authenticate, json, preflight } from "../_shared/fm.ts";

Deno.serve(async (req) => {
  const p = preflight(req); if (p) return p;
  if (req.method !== "POST") return json({ code: "METHOD_NOT_ALLOWED" }, 405);
  try {
    const caller = await authenticate(req);
    if (caller instanceof Response) return caller;

    const body = await req.json().catch(() => ({} as any));
    const paymentId = String(body?.payment_id ?? "");
    const isAdmin = caller.profile?.role === "admin";
    if (!isAdmin && !/^[0-9a-f-]{36}$/i.test(paymentId)) return json({ code: "FORBIDDEN" }, 403);

    const db = adminClient();
    let path: string | null = null;
    let bucket = "payment-receipts";

    if (/^[0-9a-f-]{36}$/i.test(paymentId)) {
      const { data: pay } = await db.from("payments")
        .select("id,receipt_path,orders:orders(id,customer_id)")
        .eq("id", paymentId).maybeSingle();
      if (!pay || !pay.receipt_path) return json({ code: "RECEIPT_MISSING" }, 404);
      const order = Array.isArray(pay.orders) ? pay.orders[0] : pay.orders;
      if (order?.customer_id !== caller.user.id && !isAdmin) return json({ code: "FORBIDDEN" }, 403);
      path = pay.receipt_path;
    } else if (typeof body?.tailoring_path === "string") {
      // Tailoring references: owner prefix or admin.
      path = String(body.tailoring_path);
      bucket = "private-tailoring";
      if (!path.startsWith(`${caller.user.id}/`) && !isAdmin) return json({ code: "FORBIDDEN" }, 403);
    }

    if (!path) return json({ code: "RECEIPT_MISSING" }, 404);
    const { data, error } = await db.storage.from(bucket).createSignedUrl(path, 60);
    if (error || !data?.signedUrl) return json({ code: "RECEIPT_SIGN_FAILED", message: error?.message }, 500);
    return json({ ok: true, url: data.signedUrl, expires_in: 60 });
  } catch (e) {
    console.error("payment-receipt-url", e);
    return json({ code: "RECEIPT_SIGN_FAILED" }, 500);
  }
});
