// Fashion Maison — thin Supabase client (no build step, browser-safe key only).
// Real auth: session persistence, token refresh, sign out. Storage helpers for
// product images (public), payment receipts and private tailoring references.
// The service-role key NEVER appears here; privileged operations live in the
// Edge Functions under supabase/functions/.
(function () {
  "use strict";

  const config = window.FASHION_MAISON_CONFIG || {};

  const url = String(config.url || "https://utvavxwbsutxuxhausaw.supabase.co").replace(/\/+$/, "");
  const key = config.publishableKey || config.anonKey || "";

  const ACCESS = "fm-access-token";
  const REFRESH = "fm-refresh-token";

  const ls = {
    get(k) { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
    set(k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch {} },
  };

  const accessToken = () => ls.get(ACCESS);
  const refreshToken = () => ls.get(REFRESH);

  function setSession(s) {
    if (!s) return;
    if (s.access_token) ls.set(ACCESS, s.access_token);
    if (s.refresh_token) ls.set(REFRESH, s.refresh_token);
  }

  function clearSession() {
    ls.set(ACCESS, "");
    ls.set(REFRESH, "");
  }

  function jwtClaims(token) {
    try {
      const part = String(token || accessToken()).split(".")[1];
      if (!part) return {};
      const pad = part.replace(/-/g, "+").replace(/_/g, "/");
      return JSON.parse(atob(pad + "=".repeat((4 - (pad.length % 4)) % 4)));
    } catch {
      return {};
    }
  }

  function tokenExpiryMs() {
    const c = jwtClaims();
    return c && c.exp ? c.exp * 1000 : 0;
  }

  let refreshing = null;
  async function refreshNow() {
    const rt = refreshToken();
    if (!rt) return false;
    if (!refreshing) {
      refreshing = (async () => {
        try {
          const res = await fetch(url + "/auth/v1/token?grant_type=refresh_token", {
            method: "POST",
            headers: { apikey: key, "Content-Type": "application/json" },
            body: JSON.stringify({ refresh_token: rt }),
          });
          if (!res.ok) { clearSession(); return false; }
          const data = await res.json();
          setSession(data);
          return true;
        } catch {
          return false;
        } finally {
          refreshing = null;
        }
      })();
    }
    return refreshing;
  }

  async function ensureFresh() {
    if (!accessToken()) return;
    const exp = tokenExpiryMs();
    // Refresh proactively a minute before expiry (or if already stale).
    if (!exp || exp - Date.now() > 60000) return;
    if (refreshToken()) await refreshNow();
  }

  function headers(extra) {
    const h = { apikey: key, "Content-Type": "application/json" };
    const t = accessToken();
    if (t) h.Authorization = "Bearer " + t;
    return { ...h, ...(extra || {}) };
  }

  async function rawFetch(path, options) {
    return fetch(url + path, { ...options, headers: headers(options && options.headers) });
  }

  async function request(path, options = {}) {
    if (!key) throw new Error("Supabase publishable key is not configured.");
    await ensureFresh();
    let response = await rawFetch(path, options);
    // One refresh-and-retry on 401 keeps long-lived tabs signed in.
    if (response.status === 401 && refreshToken()) {
      if (await refreshNow()) response = await rawFetch(path, options);
    }
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!response.ok) {
      const message =
        (data && (data.error_description || data.msg || data.message || data.error)) ||
        `Supabase request failed (${response.status})`;
      const err = new Error(message);
      err.status = response.status;
      err.payload = data;
      throw err;
    }
    return data;
  }

  async function signUp(email, password, fullName) {
    const result = await request("/auth/v1/signup", {
      method: "POST",
      body: JSON.stringify({
        email,
        password,
        data: { full_name: fullName || "" },
        options: { data: { full_name: fullName || "" } },
      }),
    });
    if (result && (result.access_token || result.refresh_token)) setSession(result);
    return result;
  }

  async function signIn(email, password) {
    const result = await request("/auth/v1/token?grant_type=password", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    setSession(result);
    return result;
  }

  async function signOut() {
    try {
      if (accessToken()) await fetch(url + "/auth/v1/logout", { method: "POST", headers: headers() });
    } catch { /* best-effort server-side sign out */ }
    clearSession();
  }

  async function getUser() {
    if (!accessToken()) return null;
    await ensureFresh();
    try {
      const user = await request("/auth/v1/user");
      return user && user.id ? user : null;
    } catch {
      clearSession();
      return null;
    }
  }

  async function getProfile(userId) {
    const rows = await request(
      `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=*`
    );
    return Array.isArray(rows) ? rows[0] || null : null;
  }

  /** HEAD-style count via Range + Prefer headers. */
  async function count(path) {
    await ensureFresh();
    const res = await rawFetch(path + (path.includes("?") ? "&" : "?") + "select=id", {
      method: "GET",
      headers: { Prefer: "count=exact", Range: "0-0", RangeUnit: "items" },
    });
    const range = res.headers.get("content-range");
    if (!range || !res.ok) return null;
    const total = range.split("/")[1];
    return total === "*" ? null : parseInt(total, 10);
  }

  /** Direct storage upload (up to 10 MB receipts / 8 MB images — bucket limits apply). */
  async function upload(bucket, path, file) {
    if (!key) throw new Error("Supabase publishable key is not configured.");
    await ensureFresh();
    const res = await fetch(
      `${url}/storage/v1/object/${bucket}/${path.split("/").map(encodeURIComponent).join("/")}`,
      {
        method: "PUT",
        headers: {
          apikey: key,
          Authorization: accessToken() ? "Bearer " + accessToken() : undefined,
          "Content-Type": (file && file.type) || "application/octet-stream",
          "x-upsert": "false",
        },
        body: file,
      }
    );
    if (!res.ok) {
      let msg = `Upload failed (${res.status})`;
      try { const j = await res.json(); msg = j.message || j.error || msg; } catch {}
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return { bucket, path };
  }

  function storagePublicPath(bucket, path) {
    let p = String(path || "").trim();
    if (!p) return "";
    if (/^https?:\/\//i.test(p)) return p;
    p = p.replace(/^\/+/, "");
    if (p.startsWith(bucket + "/")) p = p.slice(bucket.length + 1);
    if (p.startsWith("public/")) p = p.slice(7);
    return `${url}/storage/v1/object/public/${bucket}/${p.split("/").map(encodeURIComponent).join("/")}`;
  }

  const productImageUrl = (path) => storagePublicPath("product-images", path);

  async function callFunction(name, body) {
    if (!key) throw new Error("Supabase publishable key is not configured.");
    await ensureFresh();
    const res = await fetch(`${url}/functions/v1/${name}`, {
      method: "POST",
      headers: {
        apikey: key,
        "Content-Type": "application/json",
        ...(accessToken() ? { Authorization: "Bearer " + accessToken() } : {}),
      },
      body: JSON.stringify(body || {}),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!res.ok) {
      const err = new Error((data && (data.message || data.error)) || `Function ${name} failed (${res.status})`);
      err.status = res.status;
      err.code = (data && data.code) || "FUNCTION_FAILED";
      err.payload = data;
      throw err;
    }
    if (!data) throw new Error(`Function ${name} returned no data.`);
    return data;
  }

  window.FashionMaisonSupabase = {
    url,
    key,
    configured: Boolean(key),
    request,
    rest: (path, options) => request(path, options),
    count,
    signUp,
    signIn,
    signOut,
    getUser,
    getProfile,
    setSession,
    clearSession,
    accessToken: () => { ensureFresh(); return accessToken(); },
    upload,
    storagePublicPath,
    productImageUrl,
    callFunction,
  };

  // Cross-tab session sync: if one tab signs out, others stop using stale tokens.
  window.addEventListener("storage", (e) => {
    if (e.key === ACCESS && !e.newValue) window.dispatchEvent(new CustomEvent("fm:signed-out"));
  });
})();
