// verify-manual-payment — admin approve/reject for the manual transfer queue.
// Approve requires a bank transaction reference; reject requires a reason.
// The actual paid/rejected transition happens in the review RPC, which also
// re-checks that the caller profile is an admin, converts reservations to
// sold stock via the shared finalization path, and releases stock on reject.
// deno-lint-ignore-file no-explicit-any
import { adminClient, authenticate, json, preflight, rpcError } from "../_shared/fm.ts";

Deno.serve(async (req) => {
  const p = preflight(req); if (p) return p;
  if (req.method !== "POST") return json({ code: "METHOD_NOT_ALLOWED" }, 405);
  try {
    const caller = await authenticate(req, true);
    if (caller instanceof Response) return caller;
    if (caller.profile?.role !== "admin") return json({ code: "FORBIDDEN" }, 403);

    const body = await req.json().catch(() => null);
    const paymentId = String(body?.payment_id ?? "");
    const decision = String(body?.decision ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(paymentId)) return json({ code: "PAYMENT_NOT_FOUND" }, 404);
    if (!["approve", "reject"].includes(decision)) return json({ code: "REVIEW_INPUT_REQUIRED", message: "decision must be approve or reject" }, 400);

    const bankRef = typeof body?.bank_transaction_reference === "string" ? body.bank_transaction_reference.trim().slice(0, 120) : "";
    const notes = typeof body?.admin_notes === "string" ? body.admin_notes.trim().slice(0, 1000) : null;
    const reason = typeof body?.rejection_reason === "string" ? body.rejection_reason.trim().slice(0, 500) : "";
    if (decision === "approve" && !bankRef) return json({ code: "REVIEW_INPUT_REQUIRED", message: "A bank transaction reference is required to approve." }, 400);
    if (decision === "reject" && !reason) return json({ code: "REVIEW_INPUT_REQUIRED", message: "A rejection reason is required." }, 400);

    const db = adminClient();
    const { data, error } = await db.rpc("review_manual_payment", {
      p_actor_id: caller.user.id,
      p_payment_id: paymentId,
      p_approve: decision === "approve",
      p_bank_transaction_reference: bankRef || null,
      p_admin_notes: notes,
      p_rejection_reason: reason || null,
    });
    if (error) {
      const mapped = rpcError(error.message);
      return json({ code: mapped.code, message: error.message }, mapped.status);
    }
    console.log("manual payment reviewed", paymentId, decision);
    return json({ ok: true, decision, result: data });
  } catch (e) {
    console.error("verify-manual-payment", e);
    return json({ code: "REVIEW_FAILED", message: "Could not review the payment." }, 500);
  }
});
