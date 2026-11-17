(function () {
  const page = document.querySelector("[data-doc-id]");
  const docId = page ? page.dataset.docId : null;
  let user = null;
  let doc = null;
  let requestModal = null;

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    if (!docId) return;
    requestModal = new bootstrap.Modal(document.getElementById("requestModal"));
    document.getElementById("sendRequestBtn").addEventListener("click", sendRequest);
    document.getElementById("requestModal").addEventListener("show.bs.modal", () => {
      document.getElementById("requestError").classList.add("d-none");
      document.getElementById("requestNote").value = "";
      document.getElementById("requestDivision").textContent = doc ? doc.division : "";
    });
    load();
  }

  async function load() {
    document.getElementById("docLoading").classList.remove("d-none");
    document.getElementById("docError").classList.add("d-none");
    try {
      const [docData, meData] = await Promise.all([
        api(`/api/documents/${docId}`),
        api("/api/auth/me"),
      ]);
      user = meData.user;
      doc = docData.document;
      render();
      document.getElementById("docLoading").classList.add("d-none");
      document.getElementById("docContent").classList.remove("d-none");
    } catch (err) {
      document.getElementById("docLoading").classList.add("d-none");
      const box = document.getElementById("docError");
      box.textContent = err.status === 404 ? "This document could not be found." : err.message;
      box.classList.remove("d-none");
    }
  }

  function render() {
    const iconInfo = fileIconInfo(doc.filename, doc.content_type);
    const icon = document.getElementById("docIcon");
    icon.className = `file-tile file-tile-lg ${iconInfo.cls}`;
    icon.textContent = "";
    if (doc.thumbnail) {
      icon.classList.add("thumb");
      const image = document.createElement("img");
      image.src = doc.thumbnail;
      image.alt = "";
      icon.appendChild(image);
    } else {
      icon.appendChild(el("i", `bi ${iconInfo.icon}`));
    }

    document.getElementById("docTitle").textContent = doc.title || doc.filename;
    document.getElementById("docSubtitle").textContent =
      `${doc.filename} · ${fmtBytes(doc.size)} · uploaded ${fmtDate(doc.created_at)}`;

    const chips = document.getElementById("docChips");
    chips.textContent = "";
    chips.appendChild(el("span", "badge-soft", doc.division));
    if (doc.division !== (user && user.division) && doc.can_download) {
      chips.appendChild(statusBadge("shared"));
    }
    if (doc.archived) chips.appendChild(statusBadge("archived"));
    Object.entries(doc.metadata || {})
      .filter(([key, value]) => key !== "Division" && !(key === "Title" && value === doc.title))
      .slice(0, 4)
      .forEach(([key, value]) => chips.appendChild(el("span", "badge-soft", `${key}: ${value}`)));
    if (doc.request_status) chips.appendChild(statusBadge(doc.request_status));

    renderActions();
    renderMetadata();
    renderOcr();
    renderFileDetails();
    renderAccessCard();
    renderActivity();
  }

  function isPreviewable() {
    const type = doc.content_type || "";
    return type === "application/pdf" || type.startsWith("image/") || type.startsWith("text/");
  }

  function renderActions() {
    const container = document.getElementById("docActions");
    container.textContent = "";
    if (doc.can_download) {
      if (isPreviewable()) {
        const preview = el("button", "btn btn-outline-primary px-4");
        preview.type = "button";
        preview.appendChild(el("i", "bi bi-eye me-1"));
        preview.appendChild(document.createTextNode("Preview"));
        preview.addEventListener("click", () => openDocumentPreview(doc));
        container.appendChild(preview);
      }
      const download = el("button", "btn btn-primary px-4");
      download.type = "button";
      download.appendChild(el("i", "bi bi-download me-1"));
      download.appendChild(document.createTextNode("Download"));
      download.addEventListener("click", handleDownload);
      container.appendChild(download);
    } else if (doc.request_status === "pending") {
      const pending = el("button", "btn btn-outline-secondary px-4", "Request pending");
      pending.type = "button";
      pending.disabled = true;
      container.appendChild(pending);
    } else {
      const request = el(
        "button",
        "btn btn-primary px-4",
        doc.request_status === "rejected" ? "Request access again" : "Request access"
      );
      request.type = "button";
      request.appendChild(el("i", "bi bi-send me-1"));
      request.addEventListener("click", () => requestModal.show());
      container.appendChild(request);
    }

    if (doc.can_manage) {
      const manage = el("div", "dropdown w-100");
      const toggle = el("button", "btn btn-light w-100 dropdown-toggle");
      toggle.type = "button";
      toggle.dataset.bsToggle = "dropdown";
      toggle.setAttribute("aria-expanded", "false");
      toggle.textContent = "Manage";
      const menu = el("ul", "dropdown-menu w-100 shadow-sm");
      const archive = el("button", "dropdown-item", doc.archived ? "Restore document" : "Archive document");
      archive.type = "button";
      archive.addEventListener("click", () => toggleArchive(!doc.archived));
      const del = el("button", "dropdown-item text-danger", "Delete permanently");
      del.type = "button";
      del.addEventListener("click", deleteDocument);
      [archive, del].forEach((button) => {
        const item = el("li");
        item.appendChild(button);
        menu.appendChild(item);
      });
      manage.append(toggle, menu);
      container.appendChild(manage);
    }
  }

  async function toggleArchive(archived) {
    try {
      await api(`/api/documents/${doc.id}/archive`, {
        method: "POST",
        json: { archived },
      });
      toast(archived ? "Document archived." : "Document restored.", "success");
      await load();
    } catch (err) {
      toast(err.message, "danger");
    }
  }

  async function deleteDocument() {
    if (!window.confirm("Delete this document permanently? This cannot be undone.")) return;
    try {
      await api(`/api/documents/${doc.id}`, { method: "DELETE" });
      toast("Document deleted.", "success");
      location.href = "/";
    } catch (err) {
      toast(err.message, "danger");
    }
  }

  async function handleDownload() {
    try {
      await downloadDocument(doc.id, doc.filename);
      toast("Download started.", "success");
    } catch (err) {
      toast(err.message, "danger");
    }
  }

  function renderMetadata() {
    const body = document.getElementById("metaBody");
    body.textContent = "";
    const entries = Object.entries(doc.metadata || {}).filter(([key]) => key !== "Division");

    const addRow = (key, value, isBadge) => {
      const row = document.createElement("tr");
      row.appendChild(el("td", "", key));
      const cell = document.createElement("td");
      if (isBadge) {
        cell.appendChild(el("span", "badge-soft", value));
      } else {
        cell.textContent = value || "—";
      }
      row.appendChild(cell);
      body.appendChild(row);
    };

    addRow("Division", doc.division, true);
    entries.forEach(([key, value]) => addRow(key, value, false));
    if (!entries.length) {
      const row = document.createElement("tr");
      row.appendChild(el("td", "text-muted", "Custom metadata"));
      row.appendChild(el("td", "text-muted", "No custom fields were provided for this upload."));
      body.appendChild(row);
    }
    document.getElementById("metadataCount").textContent =
      `${entries.length} custom field${entries.length === 1 ? "" : "s"}`;
  }

  function renderOcr() {
    const badge = document.getElementById("ocrBadge");
    const notice = document.getElementById("ocrNotice");
    const pre = document.getElementById("ocrText");
    const status = doc.ocr_status || "skipped";
    const labels = {
      extracted: "Text layer extracted",
      ocr: "OCR complete",
      empty: "No text found",
      unavailable: "OCR engine unavailable",
      failed: "Extraction failed",
      skipped: "Not processed",
    };
    const styles = {
      extracted: "approved",
      ocr: "approved",
      empty: "pending",
      unavailable: "pending",
      failed: "rejected",
      skipped: "shared",
    };
    badge.textContent = "";
    badge.appendChild(el("span", `badge-status ${styles[status] || "shared"}`, labels[status] || status));

    notice.textContent = "";
    pre.textContent = "";

    if (!doc.can_download) {
      notice.textContent = "Extracted text is hidden until you have download access.";
      pre.classList.add("d-none");
      return;
    }
    pre.classList.toggle("d-none", !doc.ocr_text);

    if (status === "unavailable") {
      notice.textContent =
        "The Tesseract OCR binary is not installed on this server. Use the Docker setup (docker compose up) for full OCR; digital PDFs are still searchable via their text layer.";
    } else if (status === "failed") {
      notice.textContent = "Text could not be extracted from this file. Metadata search still works.";
    } else if (status === "empty" || !doc.ocr_text) {
      notice.textContent = "No text was found in this file.";
    } else {
      notice.textContent = `${doc.ocr_text.length.toLocaleString()} characters indexed and searchable.`;
    }
    pre.textContent = doc.ocr_text || "";
  }

  function renderFileDetails() {
    const set = (id, text) => {
      document.getElementById(id).textContent = text;
    };
    set("fileName", doc.filename);
    set("fileType", doc.content_type || "—");
    set("fileSize", fmtBytes(doc.size));
    set("fileUploader", doc.uploader_name || "—");
    set("fileDate", fmtDate(doc.created_at));
    set("fileDivision", doc.division);
  }

  function renderAccessCard() {
    const body = document.getElementById("accessBody");
    body.textContent = "";

    let icon = "bi-shield-check";
    let color = "text-success bg-success-subtle";
    let title = "You have access";
    let text = "This document belongs to your division, so downloading is always allowed.";

    if (doc.division !== (user && user.division)) {
      if (doc.can_download) {
        icon = "bi-people";
        color = "text-primary bg-primary-subtle";
        title = "Shared with you";
        text = `Your access was approved by ${doc.division}.`;
      } else if (doc.request_status === "pending") {
        icon = "bi-hourglass-split";
        color = "text-warning bg-warning-subtle";
        title = "Awaiting approval";
        text = `${doc.division} has been asked for permission. You'll be able to download once approved.`;
      } else if (doc.request_status === "rejected") {
        icon = "bi-x-octagon";
        color = "text-danger bg-danger-subtle";
        title = "Request rejected";
        text = `${doc.division} declined the last request. You can send a new request with more context.`;
      } else {
        icon = "bi-lock";
        color = "text-secondary bg-secondary-subtle";
        title = "Restricted document";
        text = `This document belongs to ${doc.division}. Request access to download it.`;
      }
    }

    const iconWrap = el("div", `access-icon ${color}`);
    iconWrap.appendChild(el("i", `bi ${icon}`));
    body.appendChild(iconWrap);
    body.appendChild(el("h6", "fw-bold mt-3 mb-1", title));
    body.appendChild(el("p", "small text-muted mb-0", text));
  }

  function renderActivity() {
    const list = document.getElementById("activityList");
    if (!list) return;
    list.textContent = "";
    const events = (doc.activity || []).slice().reverse();
    if (!events.length) {
      list.appendChild(el("li", "text-muted small", "No activity recorded yet."));
      return;
    }
    const meta = {
      uploaded: { icon: "bi-cloud-arrow-up", cls: "uploaded", label: "uploaded" },
      access_requested: { icon: "bi-send", cls: "requested", label: "requested access" },
      access_approved: { icon: "bi-check-circle", cls: "approved", label: "approved access for" },
      access_rejected: { icon: "bi-x-circle", cls: "rejected", label: "rejected access for" },
      downloaded: { icon: "bi-download", cls: "downloaded", label: "downloaded" },
      archived: { icon: "bi-archive", cls: "archived", label: "archived" },
      restored: { icon: "bi-arrow-counterclockwise", cls: "restored", label: "restored" },
    };
    events.forEach((event) => {
      const info = meta[event.type] || { icon: "bi-dot", cls: "", label: event.type };
      const item = el("li", "activity-item");
      const marker = el("span", `activity-marker ${info.cls}`);
      marker.appendChild(el("i", `bi ${info.icon}`));
      const content = el("div", "min-w-0");
      const line = el("div", "small fw-semibold", `${event.actor_name || "Someone"} ${info.label}`);
      content.appendChild(line);
      if (event.detail) content.appendChild(el("div", "small text-muted text-break", event.detail));
      content.appendChild(el("div", "activity-time", fmtDate(event.at)));
      item.append(marker, content);
      list.appendChild(item);
    });
  }

  async function sendRequest() {
    const button = document.getElementById("sendRequestBtn");
    const errorBox = document.getElementById("requestError");
    errorBox.classList.add("d-none");
    const note = document.getElementById("requestNote").value.trim();

    const original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Sending…';
    try {
      await api("/api/access/request", {
        method: "POST",
        json: { doc_id: doc.id, note },
      });
      requestModal.hide();
      toast(`Access request sent to ${doc.division}.`, "success");
      await load();
      refreshBadge?.();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.classList.remove("d-none");
    } finally {
      button.disabled = false;
      button.innerHTML = original;
    }
  }
})();
