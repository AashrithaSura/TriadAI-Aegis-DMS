(function () {
  if (!Api.getToken()) {
    const next = encodeURIComponent(location.pathname + location.search);
    location.replace(`/login?next=${next}`);
    return;
  }

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    const logoutBtn = document.getElementById("logoutBtn");
    if (logoutBtn) {
      logoutBtn.addEventListener("click", () => {
        Api.clearSession();
        location.href = "/login";
      });
    }
    try {
      const data = await api("/api/auth/me");
      Api.setUser(data.user);
      renderUser(data.user);
    } catch (err) {
      return;
    }
    refreshBadge();
    setInterval(refreshBadge, 60000);
  }

  function initials(name) {
    const parts = (name || "?").trim().split(/\s+/);
    return ((parts[0] || "?")[0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
  }

  function renderUser(user) {
    const set = (id, text) => {
      const node = document.getElementById(id);
      if (node) node.textContent = text;
    };
    set("userName", user.name || user.email);
    set("userDivision", user.division ? `${user.division}${user.role === "admin" ? " · Admin" : ""}` : "");
    set("userEmail", user.email);
    set("userAvatar", initials(user.name));

    const adminNav = document.getElementById("adminNav");
    if (adminNav && user.role === "admin") adminNav.classList.remove("d-none");
  }

  async function refreshBadge() {
    try {
      const data = await api("/api/access/requests?type=incoming&per_page=1");
      const badge = document.getElementById("requestBadge");
      if (!badge) return;
      if (data.pending_incoming > 0) {
        badge.textContent = data.pending_incoming;
        badge.classList.remove("d-none");
      } else {
        badge.classList.add("d-none");
      }
    } catch (err) {
      /* badge is best-effort */
    }
  }

  window.refreshBadge = refreshBadge;

  window.fmtDate = function (iso) {
    if (!iso) return "—";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  };

  window.fmtBytes = function (bytes) {
    if (!bytes && bytes !== 0) return "—";
    const units = ["B", "KB", "MB", "GB"];
    let value = Number(bytes);
    let idx = 0;
    while (value >= 1024 && idx < units.length - 1) {
      value /= 1024;
      idx += 1;
    }
    return `${value.toFixed(value >= 10 || idx === 0 ? 0 : 1)} ${units[idx]}`;
  };

  window.el = function (tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  };

  window.statusBadge = function (status) {
    const labels = {
      pending: "Pending",
      approved: "Approved",
      rejected: "Rejected",
      shared: "Shared",
      archived: "Archived",
    };
    return el("span", `badge-status ${status}`, labels[status] || status);
  };

  window.fileIconInfo = function (filename, contentType) {
    const ext = (filename || "").split(".").pop().toLowerCase();
    if (ext === "pdf" || (contentType || "").includes("pdf")) {
      return { cls: "pdf", icon: "bi-file-earmark-pdf" };
    }
    if (["png", "jpg", "jpeg", "tif", "tiff", "bmp", "webp"].includes(ext) || (contentType || "").startsWith("image/")) {
      return { cls: "image", icon: "bi-file-earmark-image" };
    }
    if (ext === "txt" || (contentType || "").startsWith("text/")) {
      return { cls: "text", icon: "bi-file-earmark-text" };
    }
    return { cls: "", icon: "bi-file-earmark" };
  };

  window.toast = function (message, type = "success") {
    const container = document.getElementById("toastContainer");
    if (!container) return;
    const icons = {
      success: "bi-check-circle-fill",
      danger: "bi-x-circle-fill",
      warning: "bi-exclamation-triangle-fill",
      info: "bi-info-circle-fill",
    };
    const wrap = el("div", `toast align-items-center text-bg-${type} border-0`);
    wrap.setAttribute("role", "alert");
    const flex = el("div", "d-flex");
    const body = el("div", "toast-body d-flex align-items-center gap-2");
    body.appendChild(el("i", `bi ${icons[type] || icons.info}`));
    body.appendChild(el("span", "", message));
    const close = el("button", "btn-close btn-close-white me-2 m-auto");
    close.setAttribute("data-bs-dismiss", "toast");
    close.setAttribute("aria-label", "Close");
    flex.append(body, close);
    wrap.appendChild(flex);
    container.appendChild(wrap);
    const instance = new bootstrap.Toast(wrap, { delay: 4200 });
    wrap.addEventListener("hidden.bs.toast", () => wrap.remove());
    instance.show();
  };

  let previewUrl = null;
  const previewEl = () => document.getElementById("previewModal");

  function releasePreview() {
    const image = document.getElementById("previewImage");
    const frame = document.getElementById("previewFrame");
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = null;
    }
    if (image) {
      image.src = "";
      image.classList.add("d-none");
    }
    if (frame) {
      frame.src = "about:blank";
      frame.classList.add("d-none");
    }
  }

  window.openDocumentPreview = async function (doc) {
    const modalEl = previewEl();
    if (!modalEl) return;
    const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
    const loading = document.getElementById("previewLoading");
    const image = document.getElementById("previewImage");
    const frame = document.getElementById("previewFrame");
    const title = document.getElementById("previewTitle");
    const meta = document.getElementById("previewMeta");
    const download = document.getElementById("previewDownload");

    releasePreview();
    loading.classList.remove("d-none");
    title.textContent = doc.title || doc.filename || "Preview";
    meta.textContent = `${doc.filename || ""} · ${fmtBytes(doc.size)}`;
    download.classList.add("d-none");
    download.onclick = null;
    modal.show();

    try {
      const preview = await previewDocument(doc.id);
      previewUrl = preview.url;
      if (preview.type.startsWith("image/")) {
        image.src = preview.url;
        image.classList.remove("d-none");
      } else if (preview.type === "application/pdf" || preview.type.startsWith("text/")) {
        frame.src = preview.url;
        frame.classList.remove("d-none");
      } else {
        throw new Error("Preview isn't available for this file type.");
      }
      download.classList.remove("d-none");
      download.onclick = () => downloadDocument(doc.id, doc.filename);
    } catch (err) {
      toast(err.message, "danger");
      modal.hide();
    } finally {
      loading.classList.add("d-none");
    }
  };

  document.addEventListener("DOMContentLoaded", () => {
    const modalEl = previewEl();
    if (modalEl) modalEl.addEventListener("hidden.bs.modal", releasePreview);
  });
})();
