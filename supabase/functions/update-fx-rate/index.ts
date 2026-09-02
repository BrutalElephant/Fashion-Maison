import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const key = Deno.env.get("CURRENCYAPI_KEY");
    const url = Deno.env.get("SUPABASE_URL");
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!key || !url || !service) return json({ error: "Missing server configuration" }, 500);

    const provider = await fetch(`https://api.currencyapi.com/v3/latest?apikey=${encodeURIComponent(key)}&base_currency=USD&currencies=NGN`);
    if (!provider.ok) return json({ error: `currencyapi HTTP ${provider.status}` }, 502);
    const payload = await provider.json();
    const item = payload?.data?.NGN;
    const rate = Number(item?.value);
    if (!Number.isFinite(rate) || rate <= 0) return json({ error: "currencyapi returned an invalid NGN rate" }, 502);

    const effective = item?.last_updated_at || payload?.meta?.last_updated_at || new Date().toISOString();
    const effectiveAt = new Date(effective);
    if (Number.isNaN(effectiveAt.getTime())) return json({ error: "currencyapi returned an invalid last_updated_at" }, 502);
    const fallbackHours = Number(Deno.env.get("FX_FALLBACK_WINDOW_HOURS") || "24");
    const expiresAt = new Date(Date.now() + (Number.isFinite(fallbackHours) && fallbackHours > 0 ? fallbackHours : 24) * 3600000);
    const db = createClient(url, service);
    const { data, error } = await db.from("exchange_rates").insert({
      base_currency: "USD", quote_currency: "NGN", rate, source: "currencyapi",
      rate_type: "market", effective_at: effectiveAt.toISOString(), expires_at: expiresAt.toISOString()
    }).select("id,base_currency,quote_currency,rate,source,effective_at,created_at").single();
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, rate: data });
  } catch (e) { return json({ error: e instanceof Error ? e.message : "Unexpected error" }, 500); }
});
