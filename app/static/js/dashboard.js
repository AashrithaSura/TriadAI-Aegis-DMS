(function () {
  const state = { page: 1, perPage: 10, filters: {}, sort: "created_at:-1" };
  let user = null;
  let fields = [];
  let divisions = [];
  let uploadModal = null;
  const docsById = {};

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    try {
      const me = await api("/api/auth/me");
      user = me.user;
      Api.setUser(user);
      document.getElementById("divisionChip").textContent = user.division;
      document.getElementById("uploadDivisionBadge").textContent = `Division · ${user.division}`;
      bindEvents();
      uploadModal = new bootstrap.Modal(document.getElementById("uploadModal"));
      wireUpload();
      await loadFields();
      loadStats();
      await loadDocs();
    } catch (err) {
      renderError(err.message);
    }
  }

  function bindEvents() {
    document.getElementById("uploadBtn").addEventListener("click", () => uploadModal.show());
    document.getElementById("quickSearch").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        const value = event.target.value.trim();
        location.href = value ? `/search?q=${encodeURIComponent(value)}` : "/search";
      }
    });
    document.getElementById("applyFilters").addEventListener("click", () => {
      collectFilters();
      state.page = 1;
      loadDocs();
    });
    document.getElementById("resetFilters").addEventListener("click", () => {
      document.querySelectorAll("[data-filter-key]").forEach((input) => {
        input.value = "";
      });
      document.getElementById("includeArchived").checked = false;
      state.filters = {};
      state.page = 1;
      loadDocs();
    });
    document.getElementById("sortSelect").addEventListener("change", (event) => {
      state.sort = event.target.value;
      state.page = 1;
      loadDocs();
    });
    document.getElementById("includeArchived").addEventListener("change", () => {
      state.page = 1;
      loadDocs();
    });
    document.getElementById("docsList").addEventListener("click", async (event) => {
      const previewBtn = event.target.closest("[data-preview-id]");
      if (previewBtn) {
        event.preventDefault();
        const target = docsById[previewBtn.dataset.previewId];
        if (target) openDocumentPreview(target);
        return;
      }

      const archiveBtn = event.target.closest("[data-archive-id]");
      if (archiveBtn) {
        event.preventDefault();
        const archived = archiveBtn.dataset.archived === "1";
        archiveBtn.disabled = true;
        try {
          await api(`/api/documents/${archiveBtn.dataset.archiveId}/archive`, {
            method: "POST",
            json: { archived },
          });
          toast(archived ? "Document archived." : "Document restored.", "success");
          await loadDocs();
          loadStats();
        } catch (err) {
          toast(err.message, "danger");
        } finally {
          archiveBtn.disabled = false;
        }
        return;
      }

      const deleteBtn = event.target.closest("[data-delete-id]");
      if (deleteBtn) {
        event.preventDefault();
        if (!window.confirm("Delete this document permanently? This cannot be undone.")) return;
        deleteBtn.disabled = true;
        try {
          await api(`/api/documents/${deleteBtn.dataset.deleteId}`, { method: "DELETE" });
          toast("Document deleted.", "success");
          await loadDocs();
          loadStats();
        } catch (err) {
          toast(err.message, "danger");
          deleteBtn.disabled = false;
        }
        return;
      }

      const button = event.target.closest("[data-download-id]");
      if (!button) return;
      event.preventDefault();
      button.disabled = true;
      try {
        await downloadDocument(button.dataset.downloadId, button.dataset.downloadName);
      } catch (err) {
        toast(err.message, "danger");
      } finally {
        button.disabled = false;
      }
    });
    document.getElementById("pagination").addEventListener("click", (event) => {
      const button = event.target.closest("[data-page]");
      if (!button || button.disabled) return;
      state.page = Number(button.dataset.page);
      loadDocs();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  async function loadFields() {
    const [fieldData, divisionData] = await Promise.all([
      api("/api/metadata-fields"),
      api("/api/divisions"),
    ]);
    fields = fieldData.fields || [];
    divisions = divisionData.divisions || [];
    populateDivisionFilter();
    renderFilterFields();
    renderUploadFields();
  }

  function populateDivisionFilter() {
    const select = document.getElementById("divisionFilter");
    divisions.forEach((division) => {
      const option = el("option", "", division.name);
      option.value = division.name;
      select.appendChild(option);
    });
  }

  function renderFilterFields() {
    const container = document.getElementById("filterFields");
    container.textContent = "";
    fields.forEach((field) => {
      const col = el("div", "col-12 col-sm-6 col-xl-4");
      const label = el("label", "form-label small fw-semibold", field.label);
      label.setAttribute("for", `filter-${field.id}`);
      let control;
      if (field.type === "select") {
        control = el("select", "form-select form-select-sm");
        control.appendChild(el("option", "", `All ${field.label.toLowerCase()}`));
        control.firstChild.value = "";
        field.options.forEach((option) => {
          const opt = el("option", "", option);
          opt.value = option;
          control.appendChild(opt);
        });
      } else {
        control = el("input", "form-control form-control-sm");
        control.type = field.type === "date" ? "date" : "text";
        control.placeholder = `Filter by ${field.label.toLowerCase()}`;
      }
      control.id = `filter-${field.id}`;
      control.dataset.filterKey = field.key;
      col.append(label, control);
      container.appendChild(col);
    });
  }

  function renderUploadFields() {
    const container = document.getElementById("uploadFields");
    container.textContent = "";
    fields.forEach((field) => {
      const col = el("div", "col-md-6");
      const label = el("label", "form-label", field.label);
      if (field.required) label.appendChild(el("span", "text-danger ms-1", "*"));
      let control;
      if (field.type === "select") {
        control = el("select", "form-select");
        control.appendChild(el("option", "", "Select…")).value = "";
        field.options.forEach((option) => {
          const opt = el("option", "", option);
          opt.value = option;
          control.appendChild(opt);
        });
      } else if (field.type === "textarea") {
        control = el("textarea", "form-control");
        control.rows = 2;
      } else {
        control = el("input", "form-control");
        const types = { number: "number", date: "date", email: "email" };
        control.type = types[field.type] || "text";
      }
      control.dataset.metaKey = field.key;
      if (field.required) control.required = true;
      col.append(label, control);
      container.appendChild(col);
    });
  }

  function collectFilters() {
    state.filters = {};
    document.querySelectorAll("[data-filter-key]").forEach((input) => {
      const value = input.value.trim();
      if (value) state.filters[input.dataset.filterKey] = value;
    });
  }

  async function loadDocs() {
    const list = document.getElementById("docsList");
    list.textContent = "";
    for (const node of skeletonRows(4)) list.appendChild(node);

    const params = new URLSearchParams();
    params.set("page", state.page);
    params.set("per_page", state.perPage);
    const [sort, order] = state.sort.split(":");
    params.set("sort", sort);
    params.set("order", order === "1" ? "asc" : "desc");
    Object.entries(state.filters).forEach(([key, value]) => params.set(key, value));
    if (document.getElementById("includeArchived").checked) params.set("include_archived", "1");

    try {
      const data = await api(`/api/documents?${params.toString()}`);
      renderDocs(data);
    } catch (err) {
      renderError(err.message);
    }
  }

  function skeletonRows(count) {
    const nodes = [];
    for (let i = 0; i < count; i += 1) {
      const card = el("div", "card doc-row mb-2");
      const body = el("div", "card-body d-flex align-items-center gap-3");
      body.appendChild(el("div", "skeleton skeleton-tile"));
      const main = el("div", "flex-grow-1");
      main.appendChild(el("div", "skeleton skeleton-line mb-2"));
      main.appendChild(el("div", "skeleton skeleton-line w-50"));
      body.appendChild(main);
      card.appendChild(body);
      nodes.push(card);
    }
    return nodes;
  }

  async function loadStats() {
    try {
      const data = await api("/api/stats");
      const stats = data.stats || {};
      document.getElementById("statDocs").textContent = stats.documents ?? "—";
      document.getElementById("statMine").textContent = stats.my_documents ?? "—";
      document.getElementById("statPending").textContent = stats.pending_incoming ?? "—";
      document.getElementById("statOcr").textContent = stats.ocr_coverage ? `${stats.ocr_coverage}%` : "0%";
    } catch (err) {
      /* stats are best-effort */
    }
  }

  function renderDocs(data) {
    const list = document.getElementById("docsList");
    list.textContent = "";
    document.getElementById("docCount").textContent =
      `${data.total} document${data.total === 1 ? "" : "s"}`;

    if (!data.documents.length) {
      const hasFilters = Object.keys(state.filters).length > 0;
      list.appendChild(
        emptyState(
          hasFilters ? "bi-funnel" : "bi-folder2-open",
          hasFilters ? "No matching documents" : "No documents yet",
          hasFilters
            ? "Try clearing your filters or adjusting the metadata values."
            : "Upload the first PDF or image for your division — it will be OCR-indexed automatically.",
          hasFilters ? "Clear filters" : "Upload document",
          () => {
            if (hasFilters) {
              document.getElementById("resetFilters").click();
            } else {
              uploadModal.show();
            }
          }
        )
      );
      document.getElementById("pagination").textContent = "";
      return;
    }

    data.documents.forEach((doc) => {
      docsById[doc.id] = doc;
      list.appendChild(documentRow(doc));
    });
    renderPagination(data);
  }

  function documentRow(doc) {
    const row = el("div", "card doc-row mb-2");
    const body = el("div", "card-body d-flex align-items-center gap-3 flex-wrap flex-sm-nowrap");

    const iconInfo = fileIconInfo(doc.filename, doc.content_type);
    const tile = el("div", `file-tile ${iconInfo.cls}`);
    if (doc.thumbnail) {
      tile.classList.add("thumb");
      const image = document.createElement("img");
      image.src = doc.thumbnail;
      image.alt = "";
      image.loading = "lazy";
      tile.appendChild(image);
    } else {
      tile.appendChild(el("i", `bi ${iconInfo.icon}`));
    }

    const main = el("div", "flex-grow-1 min-w-0");
    const title = el("a", "doc-title", doc.title || doc.filename);
    title.href = `/documents/${doc.id}`;
    main.appendChild(title);

    const meta = el("div", "doc-meta");
    meta.appendChild(el("span", "badge-soft", doc.division));
    if (doc.division !== user.division) meta.appendChild(statusBadge("shared"));
    if (doc.archived) meta.appendChild(statusBadge("archived"));
    Object.entries(doc.metadata || {})
      .filter(([key, value]) => key !== "Division" && !(key === "Title" && value === doc.title))
      .slice(0, 3)
      .forEach(([key, value]) => {
        const chip = el("span", "badge-soft", `${key}: ${value}`);
        chip.title = `${key}: ${value}`;
        meta.appendChild(chip);
      });
    if (doc.request_status === "pending") meta.appendChild(statusBadge("pending"));
    main.appendChild(meta);

    const details = el("div", "doc-filename");
    details.appendChild(el("i", "bi bi-paperclip"));
    details.appendChild(
      document.createTextNode(`${doc.filename} · ${fmtBytes(doc.size)} · ${fmtDate(doc.created_at)}`)
    );
    main.appendChild(details);

    const actions = el("div", "d-flex align-items-center gap-2");
    const view = el("a", "btn btn-sm btn-outline-primary", "View");
    view.href = `/documents/${doc.id}`;
    actions.appendChild(view);
    if (doc.has_download_access) {
      const preview = el("button", "btn btn-sm btn-outline-secondary");
      preview.type = "button";
      preview.title = "Preview";
      preview.dataset.previewId = doc.id;
      preview.appendChild(el("i", "bi bi-eye"));
      actions.appendChild(preview);

      const download = el("button", "btn btn-sm btn-primary");
      download.type = "button";
      download.title = "Download";
      download.dataset.downloadId = doc.id;
      download.dataset.downloadName = doc.filename;
      download.appendChild(el("i", "bi bi-download"));
      actions.appendChild(download);
    }
    if (doc.can_manage) actions.appendChild(manageMenu(doc));

    body.append(tile, main, actions);
    row.appendChild(body);
    return row;
  }

  function manageMenu(doc) {
    const wrap = el("div", "dropdown");
    const toggle = el("button", "btn btn-sm btn-light");
    toggle.type = "button";
    toggle.dataset.bsToggle = "dropdown";
    toggle.setAttribute("aria-expanded", "false");
    toggle.title = "More actions";
    toggle.appendChild(el("i", "bi bi-three-dots"));

    const menu = el("ul", "dropdown-menu dropdown-menu-end shadow-sm");
    const archive = el("button", "dropdown-item", doc.archived ? "Restore" : "Archive");
    archive.type = "button";
    archive.dataset.archiveId = doc.id;
    archive.dataset.archived = doc.archived ? "0" : "1";
    archive.prepend(el("i", `bi ${doc.archived ? "bi-arrow-counterclockwise" : "bi-archive"} me-1`));

    const del = el("button", "dropdown-item text-danger", "Delete");
    del.type = "button";
    del.dataset.deleteId = doc.id;
    del.prepend(el("i", "bi-trash me-1"));

    [archive, del].forEach((button) => {
      const item = el("li");
      item.appendChild(button);
      menu.appendChild(item);
    });
    wrap.append(toggle, menu);
    return wrap;
  }

  function renderPagination(data) {
    const nav = document.getElementById("pagination");
    nav.textContent = "";
    if (data.pages <= 1) return;

    const makeButton = (label, page, disabled, active) => {
      const item = el("li", `page-item${disabled ? " disabled" : ""}${active ? " active" : ""}`);
      const button = el("button", "page-link", label);
      button.type = "button";
      button.dataset.page = page;
      if (disabled) button.disabled = true;
      item.appendChild(button);
      return item;
    };

    const list = el("ul", "pagination mb-0");
    list.appendChild(makeButton("Previous", data.page - 1, data.page <= 1, false));
    const start = Math.max(1, data.page - 2);
    const end = Math.min(data.pages, data.page + 2);
    for (let page = start; page <= end; page += 1) {
      list.appendChild(makeButton(String(page), page, false, page === data.page));
    }
    list.appendChild(makeButton("Next", data.page + 1, data.page >= data.pages, false));
    nav.appendChild(list);
  }

  function emptyState(icon, title, text, actionLabel, action) {
    const wrap = el("div", "empty-state");
    wrap.appendChild(el("i", `bi ${icon}`));
    wrap.appendChild(el("h5", "fw-semibold text-dark", title));
    wrap.appendChild(el("p", "mb-3", text));
    const button = el("button", "btn btn-primary", actionLabel);
    button.type = "button";
    button.addEventListener("click", action);
    wrap.appendChild(button);
    return wrap;
  }

  function renderError(message) {
    const list = document.getElementById("docsList");
    list.textContent = "";
    const alert = el("div", "alert alert-danger", message);
    list.appendChild(alert);
  }

  function wireUpload() {
    const zone = document.getElementById("dropZone");
    const fileInput = document.getElementById("fileInput");
    const fileName = document.getElementById("fileName");
    const form = document.getElementById("uploadForm");
    const submit = document.getElementById("uploadSubmit");
    const errorBox = document.getElementById("uploadError");

    const describeSelection = () => {
      const count = fileInput.files.length;
      fileName.textContent = count
        ? count === 1
          ? fileInput.files[0].name
          : `${count} files selected`
        : "No file selected";
      document.getElementById("uploadCount").classList.toggle("d-none", count < 2);
      document.getElementById("uploadCount").textContent = count > 1 ? `${count} files` : "";
    };

    zone.addEventListener("click", () => fileInput.click());
    zone.addEventListener("dragover", (event) => {
      event.preventDefault();
      zone.classList.add("dragover");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
    zone.addEventListener("drop", (event) => {
      event.preventDefault();
      zone.classList.remove("dragover");
      if (event.dataTransfer.files.length) {
        fileInput.files = event.dataTransfer.files;
        describeSelection();
      }
    });
    fileInput.addEventListener("change", describeSelection);

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      errorBox.classList.add("d-none");
      const files = Array.from(fileInput.files);
      if (!files.length) {
        errorBox.textContent = "Choose at least one file to upload.";
        errorBox.classList.remove("d-none");
        return;
      }
      const tooLarge = files.find((file) => file.size > 25 * 1024 * 1024);
      if (tooLarge) {
        errorBox.textContent = `${tooLarge.name} is larger than 25 MB.`;
        errorBox.classList.remove("d-none");
        return;
      }

      const metadata = {};
      document.querySelectorAll("[data-meta-key]").forEach((input) => {
        const value = input.value.trim();
        if (value) metadata[input.dataset.metaKey] = value;
      });
      if (files.length === 1) {
        const titleValue = document.getElementById("uploadTitle").value.trim();
        if (titleValue) metadata.Title = titleValue;
      }

      const original = submit.innerHTML;
      submit.disabled = true;
      let uploaded = 0;
      let ocrUnavailable = 0;
      const failures = [];
      try {
        for (let index = 0; index < files.length; index += 1) {
          submit.innerHTML = `<span class="spinner-border spinner-border-sm me-2"></span>Uploading ${index + 1} of ${files.length}…`;
          const formData = new FormData();
          formData.append("file", files[index]);
          formData.append("metadata", JSON.stringify(metadata));
          try {
            const result = await api("/api/documents/upload", { method: "POST", formData });
            uploaded += 1;
            if (result.document && result.document.ocr_status === "unavailable") ocrUnavailable += 1;
          } catch (err) {
            failures.push(`${files[index].name}: ${err.message}`);
          }
        }

        if (uploaded) {
          uploadModal.hide();
          form.reset();
          describeSelection();
        }
        if (failures.length) {
          toast(
            `${uploaded} uploaded, ${failures.length} failed — ${failures[0]}`,
            "warning"
          );
        } else if (ocrUnavailable) {
          toast(
            "Uploaded. OCR isn't installed on this server, so scanned text isn't indexed.",
            "warning"
          );
        } else {
          toast(
            uploaded === 1 ? "Document uploaded and indexed." : `${uploaded} documents uploaded and indexed.`,
            "success"
          );
        }
        state.page = 1;
        await loadDocs();
        loadStats();
      } finally {
        submit.disabled = false;
        submit.innerHTML = original;
      }
    });
  }
})();
