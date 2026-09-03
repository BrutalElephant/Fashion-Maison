(function () {
  "use strict";

  const config = window.FASHION_MAISON_CONFIG || {};

  const url = config.url || "https://utvavxwbsutxuxhausaw.supabase.co";
  const key = config.publishableKey || "";

  const headers = () => {
    const token = localStorage.getItem("fm-access-token");
    const h = {
      "apikey": key,
      "Content-Type": "application/json"
    };

    if (token) {
      h.Authorization = "Bearer " + token;
    }

    return h;
  };

  async function request(path, options = {}) {
    if (!key) {
      throw new Error("Supabase publishable key is not configured.");
    }

    const response = await fetch(url + path, {
      ...options,
      headers: {
        ...headers(),
        ...(options.headers || {})
      }
    });

    const text = await response.text();

    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    if (!response.ok) {
      const message =
        data?.message ||
        data?.msg ||
        data?.error_description ||
        data?.error ||
        `Supabase request failed (${response.status})`;

      throw new Error(message);
    }

    return data;
  }

  async function signUp(email, password, metadata = {}) {
    const result = await request("/auth/v1/signup", {
      method: "POST",
      body: JSON.stringify({
        email,
        password,
        data: metadata
      })
    });

    if (result?.access_token) {
      localStorage.setItem("fm-access-token", result.access_token);
    }

    if (result?.refresh_token) {
      localStorage.setItem("fm-refresh-token", result.refresh_token);
    }

    return result;
  }

  async function signIn(email, password) {
    const result = await request(
      "/auth/v1/token?grant_type=password",
      {
        method: "POST",
        body: JSON.stringify({
          email,
          password
        })
      }
    );

    if (result?.access_token) {
      localStorage.setItem("fm-access-token", result.access_token);
    }

    if (result?.refresh_token) {
      localStorage.setItem("fm-refresh-token", result.refresh_token);
    }

    return result;
  }

  function signOut() {
    localStorage.removeItem("fm-access-token");
    localStorage.removeItem("fm-refresh-token");
  }

  async function getUser() {
    const token = localStorage.getItem("fm-access-token");

    if (!token) return null;

    try {
      return await request("/auth/v1/user");
    } catch {
      signOut();
      return null;
    }
  }

  async function getProfile(userId) {
    const rows = await request(
      `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=*`
    );

    return Array.isArray(rows) ? rows[0] || null : null;
  }

  window.FashionMaisonSupabase = {
    url,
    key,
    configured: Boolean(key),
    request,
    signUp,
    signIn,
    signOut,
    getUser,
    getProfile
  };
})();
