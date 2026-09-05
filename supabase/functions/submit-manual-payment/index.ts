// submit-manual-payment — customer reports a bank transfer with proof.
// The receipt must already exist in the private payment-receipts bucket,
// under the caller's own object prefix, and be an image/PDF ≤10MB (bucket
// limits). Amounts are never accepted from the browser: the trusted RPC
// reads orders.total. Status becomes pending_manual_verification for the
// admin review queue.
// deno-lint-ignore-file no-explicit-any
import { adminClient, authenticate, json, preflight, rpcError } from "../_shared/fm.ts";

const RECEIPT_NAME = /\.(jpg|jpeg|png|webp|pdf)$/i;

Deno.serve(async (req) => {
  const p = preflight(req); if (p) return p;
  if (req.method !== "POST") return json({ code: "METHOD_NOT_ALLOWED" }, 405);
  try {
    const caller = await authenticate(req);
    if (caller instanceof Response) return caller;

    const body = await req.json().catch(() => null);
    const orderId = String(body?.order_id ?? "");
    const receiptPath = String(body?.receipt_path ?? "").trim();
    const expectedPrefix = `receipts/${caller.user.id}/${orderId}/`;
    if (!/^[0-9a-f-]{36}$/i.test(orderId)) return json({ code: "ORDER_NOT_FOUND" }, 404);
    if (!receiptPath.startsWith(expectedPrefix) || receiptPath.length > 400 || !RECEIPT_NAME.test(receiptPath))
      return json({ code: "RECEIPT_PATH_INVALID", message: "Receipt must be uploaded to your own private receipts folder as JPEG/PNG/WebP/PDF." }, 400);

    // Fail fast if the object is missing (listing the customer's own folder is authoritative and cheap).
    const db = adminClient();
    try {
      const folder = `receipts/${caller.user.id}/${orderId}`;
      const { data: rows, error: listError } = await db.storage.from("payment-receipts").list(folder, { limit: 200 });
      const present = Array.isArray(rows) && rows.some((r: any) => `${folder}/${r.name}` === receiptPath);
      if (listError || !present) return json({ code: "RECEIPT_MISSING", message: "Uploaded receipt could not be found." }, 400);
    } catch {
      return json({ code: "RECEIPT_MISSING", message: "Uploaded receipt could not be found." }, 400);
    }

    const { data, error } = await db.rpc("submit_manual_payment", {
      p_customer_id: caller.user.id,
      p_order_id: orderId,
      p_receipt_path: receiptPath,
      p_sender_account_name: typeof body?.sender_account_name === "string" ? body.sender_account_name.slice(0, 120) : null,
      p_sender_account_number: typeof body?.sender_account_number === "string" ? body.sender_account_number.slice(0, 64) : null,
    });
    if (error) {
      const mapped = rpcError(error.message);
      return json({ code: mapped.code, message: error.message }, mapped.status);
    }
    return json({ ok: true, result: data });
  } catch (e) {
    console.error("submit-manual-payment", e);
    return json({ code: "SUBMIT_FAILED", message: "Could not submit the transfer receipt." }, 500);
  }
});
