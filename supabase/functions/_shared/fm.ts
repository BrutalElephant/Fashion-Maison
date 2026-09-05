// Fashion Maison Edge Functions — shared server-side helpers.
// Browser code never sees service-role credentials; everything here runs
// inside Deno with secrets supplied by `supabase secrets set`.
// deno-lint-ignore-file no-explicit-any
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,GET,OPTIONS",
  "Access-Control-Allow-Headers": "authorization,apikey,content-type,x-fx-secret",
  "Content-Type": "application/json",
};

export const preflight = (req: Request): Response | null =>
  req.method === "OPTIONS" ? new Response("ok", { headers: cors }) : null;

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: cors });

export const env = (k: string): string | null => Deno.env.get(k) ?? null;

export function requiredEnv(...keys: string[]): { [k: string]: string } | null {
  const out: { [k: string]: string } = {};
  for (const k of keys) {
    const v = Deno.env.get(k);
    if (!v) return null;
    out[k] = v;
  }
  return out;
}

export const anonKey = (): string | null =>
  Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? null;

/** Client scoped to the caller's JWT — RLS and role policies apply. */
export function userClient(req: Request): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = anonKey();
  if (!url || !anon) throw new Error("SUPABASE_URL/SUPABASE_ANON_KEY not configured");
  return createClient(url, anon, {
    global: { headers: { Authorization: req.headers.get("Authorization") || "" } },
  });
}

/** Trusted client with the service role. Never exposed to browsers. */
export function adminClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !service) throw new Error("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not configured");
  return createClient(url, service);
}

export type Caller = { user: { id: string; email?: string }; profile: any };

/** Resolve the authenticated caller and their database profile. */
export async function authenticate(req: Request, requireAdmin = false): Promise<Caller | Response> {
  const auth = req.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return json({ code: "UNAUTHORIZED" }, 401);
  const supabase = userClient(req);
  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user) return json({ code: "UNAUTHORIZED" }, 401);
  const user = data.user;
  const { data: profile } = await supabase.from("profiles").select("id,role,full_name,phone").eq("id", user.id).single();
  if (!profile) return json({ code: "PROFILE_MISSING" }, 403);
  if (requireAdmin && profile.role !== "admin") return json({ code: "FORBIDDEN" }, 403);
  return { user: { id: user.id, email: user.email }, profile };
}

export const isAdminCaller = (c: Caller | Response): c is Caller =>
  !(c instanceof Response) && c.profile?.role === "admin";

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const badRequest = (message: string, code = "INVALID_REQUEST"): Response => json({ code, message }, 400);

/** Map the raised names from the trusted SQL RPCs onto stable API codes. */
export function rpcError(message: string | undefined | null): { code: string; status: number } {
  const m = String(message || "");
  const table: [RegExp, string, number][] = [
    [/PRICE_CHANGED/, "PRICE_CHANGED", 409],
    [/STOCK_CHANGED|VARIANT_UNAVAILABLE|no inventory/, "STOCK_CHANGED", 409],
    [/PRODUCT_UNAVAILABLE|NEED_VARIANT/, "PRODUCT_UNAVAILABLE", 409],
    [/DELIVERY_UNAVAILABLE/, "DELIVERY_UNAVAILABLE", 400],
    [/PAYMENT_METHOD_UNAVAILABLE/, "PAYMENT_METHOD_UNAVAILABLE", 409],
    [/PAYMENT_METHOD_INVALID|INVALID_QUANTITY|CART_TOO_LARGE|EMPTY_CART|INVALID_IDEMPOTENCY|ADDRESS_REQUIRED|ADDRESS_NOT_FOUND|INVALID_INPUT/, "INVALID_REQUEST", 400],
    [/RECEIPT_PATH_INVALID/, "RECEIPT_PATH_INVALID", 400],
    [/PAYMENT_ALREADY_IN_FLIGHT|PAYMENT_NOT_AWAITING_REVIEW|NOT_A_MANUAL_PAYMENT|PAYMENT_NOT_PAYABLE|PAYMENT_NOT_FOUND/, "PAYMENT_STATE_CONFLICT", 409],
    [/ORDER_NOT_FOUND|PROFILE_NOT_FOUND|MEASUREMENT_PROFILE_NOT_FOUND/, "NOT_FOUND", 404],
    [/ORDER_NOT_PAYABLE|ORDER_CANCELLED|INVALID_TOTAL/, "ORDER_NOT_PAYABLE", 409],
    [/BANK_REFERENCE_REQUIRED|REJECTION_REASON_REQUIRED/, "REVIEW_INPUT_REQUIRED", 400],
    [/FORBIDDEN|ROLE_CHANGE_FORBIDDEN/, "FORBIDDEN", 403],
  ];
  for (const [re, code, status] of table) if (re.test(m)) return { code, status, ...(code === "STOCK_CHANGED" || code === "PRICE_CHANGED" ? { message: m } : {}) } as any;
  return { code: "OPERATION_FAILED", status: 500 };
}
