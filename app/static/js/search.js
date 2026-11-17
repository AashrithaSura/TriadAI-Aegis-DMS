(function () {
  let fields = [];
  const results = () => document.getElementById("searchResults");

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    try {
      const data = await api("/api/metadata-fields");
      fields = data.fields || [];
      renderFilters();
    } catch (err) {
      /* filters are optional */
    }

    document.getElementById("searchForm").addEventListener("submit", (event) => {
      event.preventDefault();
      run();
    });
    results().addEventListener("click", async (event) => {
      const button = event.target.closest("[data-download-id]");
      if (!button) return;
      button.disabled = true;
      try {
        await downloadDocument(button.dataset.downloadId, button.dataset.downloadName);
      } catch (err) {
        toast(err.message, "danger");
      } finally {
        button.disabled = false;
      }
    });

    const initial = new URLSearchParams(location.search).get("q") || "";
    document.getElementById("searchInput").value = initial;
    if (initial.trim()) {
      run();
    } else {
      renderHint();
    }
  }

  function renderFilters() {
    const container = document.getElementById("searchFilters");
    container.textContent = "";
    fields.slice(0, 6).forEach((field) => {
      const col = el("div", "col-6 col-md-4 col-lg-3");
      const label = el("label", "form-label small text-white-50 mb-1", field.label);
      let control;
      if (field.type === "select") {
        control = el("select", "form-select form-select-sm");
        const all = el("option", "", `Any ${field.label.toLowerCase()}`);
        all.value = "";
        control.appendChild(all);
        field.options.forEach((option) => {
          const opt = el("option", "", option);
          opt.value = option;
          control.appendChild(opt);
        });
      } else {
        control = el("input", "form-control form-control-sm");
        control.placeholder = `Any ${field.label.toLowerCase()}`;
      }
      control.dataset.searchKey = field.key;
      col.append(label, control);
      container.appendChild(col);
    });
  }

  async function run() {
    const term = document.getElementById("searchInput").value.trim();
    const params = new URLSearchParams();
    if (term) params.set("q", term);
    document.querySelectorAll("[data-search-key]").forEach((input) => {
      const value = input.value.trim();
      if (value) params.set(input.dataset.searchKey, value);
    });

    history.replaceState(null, "", term ? `/search?q=${encodeURIComponent(term)}` : "/search");

    const heading = document.getElementById("resultsHeading");
    heading.textContent = term ? `Results for “${term}”` : "Search results";
    document.getElementById("resultsMeta").textContent = "";

    results().textContent = "";
    const spinner = el("div", "text-center text-muted py-5");
    spinner.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Searching the OCR index…';
    results().appendChild(spinner);
    document.getElementById("searchError").classList.add("d-none");

    if (!term) {
      renderHint();
      return;
    }

    try {
      const data = await api(`/api/search?${params.toString()}`);
      renderResults(data, term);
    } catch (err) {
      results().textContent = "";
      const box = document.getElementById("searchError");
      box.textContent = err.message;
      box.classList.remove("d-none");
    }
  }

  function renderResults(data, term) {
    const list = results();
    list.textContent = "";
    document.getElementById("resultsMeta").textContent =
      `${data.total} match${data.total === 1 ? "" : "es"}`;

    if (!data.results.length) {
      const wrap = el("div", "empty-state");
      wrap.appendChild(el("i", "bi-search"));
      wrap.appendChild(el("h5", "fw-semibold text-dark", "No matches found"));
      wrap.appendChild(
        el("p", "mb-0", "Try a different phrase, or clear the metadata filters. OCR text becomes searchable after upload.")
      );
      list.appendChild(wrap);
      return;
    }

    data.results.forEach((doc) => {
      const card = el("div", "card search-result mb-3");
      const body = el("div", "card-body d-flex gap-3 flex-wrap flex-sm-nowrap");

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
      const titleRow = el("div", "d-flex justify-content-between align-items-start gap-2 flex-wrap");
      const title = el("a", "doc-title h6 mb-0", doc.title || doc.filename);
      title.href = `/documents/${doc.id}`;
      titleRow.appendChild(title);

      const actions = el("div", "d-flex gap-2");
      const view = el("a", "btn btn-sm btn-outline-primary", "View");
      view.href = `/documents/${doc.id}`;
      actions.appendChild(view);
      if (doc.has_download_access) {
        const preview = el("button", "btn btn-sm btn-outline-secondary");
        preview.type = "button";
        preview.title = "Preview";
        preview.appendChild(el("i", "bi bi-eye"));
        preview.addEventListener("click", () => openDocumentPreview(doc));
        actions.appendChild(preview);

        const download = el("button", "btn btn-sm btn-primary");
        download.type = "button";
        download.title = "Download";
        download.dataset.downloadId = doc.id;
        download.dataset.downloadName = doc.filename;
        download.appendChild(el("i", "bi bi-download"));
        actions.appendChild(download);
      }
      titleRow.appendChild(actions);
      main.appendChild(titleRow);

      const meta = el("div", "doc-meta");
      meta.appendChild(el("span", "badge-soft", doc.division));
      Object.entries(doc.metadata || {})
        .filter(([key]) => key !== "Division")
        .slice(0, 3)
        .forEach(([key, value]) => meta.appendChild(el("span", "badge-soft", `${key}: ${value}`)));
      main.appendChild(meta);

      const snippet = el("div", "snippet");
      appendHighlighted(snippet, doc.snippet || doc.ocr_excerpt || "No preview available.", term);
      main.appendChild(snippet);

      const footer = el(
        "div",
        "small text-muted mt-2",
        `${doc.filename} · ${fmtBytes(doc.size)} · ${fmtDate(doc.created_at)}`
      );
      main.appendChild(footer);

      body.append(tile, main);
      card.appendChild(body);
      list.appendChild(card);
    });
  }

  function appendHighlighted(container, text, term) {
    const lower = text.toLowerCase();
    const needle = term.toLowerCase();
    let index = 0;
    let found = lower.indexOf(needle);
    if (found === -1) {
      container.textContent = text;
      return;
    }
    while (found !== -1) {
      if (found > index) container.appendChild(document.createTextNode(text.slice(index, found)));
      container.appendChild(el("mark", "", text.slice(found, found + term.length)));
      index = found + term.length;
      found = lower.indexOf(needle, index);
    }
    if (index < text.length) container.appendChild(document.createTextNode(text.slice(index)));
  }

  function renderHint() {
    document.getElementById("resultsHeading").textContent = "Search results";
    document.getElementById("resultsMeta").textContent = "";
    const list = results();
    list.textContent = "";
    const wrap = el("div", "empty-state");
    wrap.appendChild(el("i", "bi-stars"));
    wrap.appendChild(el("h5", "fw-semibold text-dark", "Search across every page and scan"));
    wrap.appendChild(
      el("p", "mb-3", "Enter a word or phrase above. Titles, metadata values and OCR text are all indexed.")
    );
    ["Financial", "Invoice", "Budget", "Board minutes"].forEach((suggestion) => {
      const chip = el("button", "btn btn-sm btn-outline-primary me-2 mb-2", suggestion);
      chip.type = "button";
      chip.addEventListener("click", () => {
        document.getElementById("searchInput").value = suggestion;
        run();
      });
      wrap.appendChild(chip);
    });
    list.appendChild(wrap);
  }
})();
