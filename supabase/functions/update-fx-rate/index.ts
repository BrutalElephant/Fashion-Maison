// update-fx-rate — hardened, server-only FX updater.
// Authorization (any one of):
//   1. header `x-fx-secret` matching the FX_SCHEDULER_SECRET secret (scheduler), or
//   2. a Bearer JWT whose profile role is `admin` (manual refresh from the dashboard).
// Unauthenticated callers are rejected — arbitrary FX updates are impossible.
// The CurrencyAPI key never leaves the server. Rates are inserted as
// immutable audit rows; a >35% jump is rejected unless an admin forces it.
// deno-lint-ignore-file no-explicit-any
import { adminClient, authenticate, env, json, preflight, timingSafeEqual } from "../_shared/fm.ts";

Deno.serve(async (req) => {
  const p = preflight(req); if (p) return p;
  if (req.method !== "POST" && req.method !== "GET") return json({ code: "METHOD_NOT_ALLOWED" }, 405);
  try {
    const schedulerSecret = env("FX_SCHEDULER_SECRET");
    const providedSecret = req.headers.get("x-fx-secret") || "";
    const viaSecret = Boolean(schedulerSecret && providedSecret && timingSafeEqual(schedulerSecret, providedSecret));

    let caller: any = null;
    const authHeader = req.headers.get("Authorization");
    if (!viaSecret) {
      if (!authHeader) return json({ code: "UNAUTHORIZED", message: "Provide the scheduler secret header or an admin session." }, 401);
      const c = await authenticate(req);
      if (c instanceof Response) return c;
      if (c.profile?.role !== "admin") return json({ code: "FORBIDDEN" }, 403);
      caller = c;
    } else if (authHeader) {
      const c = await authenticate(req);
      if (!(c instanceof Response)) caller = c;
    }
    const isAdmin = caller?.profile?.role === "admin";

    const key = env("CURRENCYAPI_KEY");
    if (!key) return json({ code: "FX_PROVIDER_UNAVAILABLE", message: "CURRENCYAPI_KEY is not configured on this deployment." }, 503);

    const provider = await fetch(`https://api.currencyapi.com/v3/latest?apikey=${encodeURIComponent(key)}&base_currency=USD&currencies=NGN`);
    if (!provider.ok) return json({ error: `currencyapi HTTP ${provider.status}` }, 502);
    const payload = await provider.json();
    const item = payload?.data?.NGN;
    const rate = Number(item?.value);
    if (!Number.isFinite(rate) || rate <= 0) return json({ error: "currencyapi returned an invalid NGN rate" }, 502);

    const effective = item?.last_updated_at || payload?.meta?.last_updated_at || new Date().toISOString();
    const effectiveAt = new Date(effective);
    if (Number.isNaN(effectiveAt.getTime())) return json({ error: "currencyapi returned an invalid last_updated_at" }, 502);

    const db = adminClient();

    // Sanity guard: refuse implausible swings unless an admin forces the update.
    const { data: last } = await db.from("exchange_rates")
      .select("rate").eq("base_currency", "USD").eq("quote_currency", "NGN")
      .order("effective_at", { ascending: false }).limit(1).maybeSingle();
    if (last?.rate && !isAdmin) {
      const drift = Math.abs(rate - Number(last.rate)) / Number(last.rate);
      if (drift > 0.35) return json({ code: "FX_RATE_OUT_OF_RANGE", message: "Rate deviates more than 35% from the last recorded rate; admin force required." }, 409);
    }

    const fallbackHours = Number(env("FX_FALLBACK_WINDOW_HOURS") || "24");
    const expiresAt = new Date(Date.now() + (Number.isFinite(fallbackHours) && fallbackHours > 0 ? fallbackHours : 24) * 3600000);
    const { data, error } = await db.from("exchange_rates").insert({
      base_currency: "USD", quote_currency: "NGN", rate, source: "currencyapi",
      rate_type: "market", effective_at: effectiveAt.toISOString(), expires_at: expiresAt.toISOString(),
    }).select("id,base_currency,quote_currency,rate,source,effective_at,created_at").single();
    if (error) return json({ error: error.message }, 500);

    if (isAdmin && viaSecret) {
      await db.from("audit_logs").insert({ actor_id: caller?.user?.id ?? null, action: "fx.rate_updated", entity_type: "exchange_rates", entity_id: data?.id, metadata: { rate: String(rate) } });
    }
    return json({ ok: true, rate: data });
  } catch (e) {
    console.error("update-fx-rate", e);
    return json({ error: e instanceof Error ? e.message : "Unexpected error" }, 500);
  }
});
