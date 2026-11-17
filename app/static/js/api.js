(function () {
  const TOKEN_KEY = "triad_dms_token";
  const USER_KEY = "triad_dms_user";

  function getToken() {
    return localStorage.getItem(TOKEN_KEY);
  }

  function getUser() {
    try {
      return JSON.parse(localStorage.getItem(USER_KEY) || "null");
    } catch (err) {
      return null;
    }
  }

  function setSession(token, user) {
    localStorage.setItem(TOKEN_KEY, token);
    setUser(user);
  }

  function setUser(user) {
    localStorage.setItem(USER_KEY, JSON.stringify(user || null));
  }

  function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }

  async function api(path, options = {}) {
    const { method = "GET", json, formData, auth = true, headers = {} } = options;
    const opts = { method, headers: { ...headers } };
    const token = getToken();
    if (auth && token) opts.headers.Authorization = `Bearer ${token}`;
    if (json !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(json);
    } else if (formData) {
      opts.body = formData;
    }

    const res = await fetch(path, opts);
    let data = null;
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      data = await res.json().catch(() => null);
    }

    if (res.status === 401 && auth) {
      const isCredentialCall =
        path.includes("/api/auth/login") || path.includes("/api/auth/register");
      if (!isCredentialCall) {
        clearSession();
        if (!location.pathname.startsWith("/login")) {
          const next = encodeURIComponent(location.pathname + location.search);
          location.replace(`/login?next=${next}`);
        }
      }
    }

    if (!res.ok) {
      const message =
        (data && (data.error || data.message)) || `Request failed (${res.status})`;
      const err = new Error(message);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function filenameFromDisposition(header, fallback) {
    if (!header) return fallback;
    const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header);
    if (utf8) {
      try {
        return decodeURIComponent(utf8[1].trim().replace(/^"|"$/g, ""));
      } catch (err) {
        /* fall through */
      }
    }
    const plain = /filename="?([^";]+)"?/i.exec(header);
    return plain ? plain[1] : fallback;
  }

  async function downloadDocument(docId, fallbackName) {
    const res = await fetch(`/api/documents/${docId}/download`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    if (!res.ok) {
      let message = `Download failed (${res.status})`;
      try {
        const data = await res.json();
        message = data.error || message;
      } catch (err) {
        /* keep default */
      }
      throw new Error(message);
    }
    const blob = await res.blob();
    const name = filenameFromDisposition(
      res.headers.get("content-disposition"),
      fallbackName || "document"
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function previewDocument(docId) {
    const res = await fetch(`/api/documents/${docId}/download`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    if (!res.ok) {
      let message = `Preview failed (${res.status})`;
      try {
        const data = await res.json();
        message = data.error || message;
      } catch (err) {
        /* keep default */
      }
      throw new Error(message);
    }
    const blob = await res.blob();
    return {
      url: URL.createObjectURL(blob),
      type: res.headers.get("content-type") || blob.type || "",
    };
  }

  window.Api = { getToken, getUser, setSession, setUser, clearSession };
  window.api = api;
  window.downloadDocument = downloadDocument;
  window.previewDocument = previewDocument;
})();
