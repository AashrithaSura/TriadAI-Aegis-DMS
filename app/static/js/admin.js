(function () {
  let fields = [];
  let modal = null;

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    let me = null;
    try {
      const data = await api("/api/auth/me");
      me = data.user;
    } catch (err) {
      return;
    }
    if (me.role !== "admin") {
      renderGuard(me);
      return;
    }
    document.getElementById("adminContent").classList.remove("d-none");
    modal = new bootstrap.Modal(document.getElementById("fieldModal"));
    bindEvents();
    await Promise.all([loadFields(), loadDivisions()]);
  }

  function renderGuard(me) {
    const guard = document.getElementById("adminGuard");
    guard.textContent = "";
    guard.classList.remove("d-none");
    const alert = el("div", "alert alert-warning d-flex gap-3 align-items-start");
    alert.appendChild(el("i", "bi bi-shield-lock fs-4"));
    const body = el("div");
    body.appendChild(el("h5", "alert-heading fw-semibold", "Administrator access required"));
    body.appendChild(
      el(
        "p",
        "mb-2",
        `You're signed in as ${me.name || me.email} (${me.division}). Only workspace administrators can edit metadata fields and divisions.`
      )
    );
    const link = el("a", "btn btn-sm btn-dark", "Back to dashboard");
    link.href = "/";
    body.appendChild(link);
    alert.appendChild(body);
    guard.appendChild(alert);
  }

  function bindEvents() {
    document.getElementById("addFieldBtn").addEventListener("click", () => openFieldModal(null));
    document.getElementById("fieldType").addEventListener("change", toggleOptions);
    document.getElementById("fieldForm").addEventListener("submit", saveField);
    document.getElementById("fieldsBody").addEventListener("click", (event) => {
      const button = event.target.closest("[data-field-id]");
      if (!button) return;
      if (button.dataset.action === "edit") {
        openFieldModal(fields.find((f) => f.id === button.dataset.fieldId));
      } else if (button.dataset.action === "delete") {
        deleteField(button.dataset.fieldId);
      }
    });
    document.getElementById("addDivisionForm").addEventListener("submit", addDivision);
  }

  async function loadFields() {
    const data = await api("/api/metadata-fields");
    fields = data.fields || [];
    renderFields();
  }

  function renderFields() {
    const body = document.getElementById("fieldsBody");
    body.textContent = "";
    if (!fields.length) {
      const row = document.createElement("tr");
      const cell = el("td", "text-muted text-center py-4", "No metadata fields yet. Add your first field.");
      cell.colSpan = 7;
      row.appendChild(cell);
      body.appendChild(row);
      return;
    }
    fields
      .slice()
      .sort((a, b) => a.order - b.order)
      .forEach((field) => {
        const row = document.createElement("tr");
        row.appendChild(el("td", "text-muted", String(field.order)));

        const keyCell = document.createElement("td");
        keyCell.appendChild(el("code", "", field.key));
        row.appendChild(keyCell);

        row.appendChild(el("td", "fw-semibold", field.label));
        row.appendChild(el("td", "", field.type));
        row.appendChild(el("td", "small text-muted", field.options.length ? field.options.join(", ") : "—"));

        const requiredCell = document.createElement("td");
        requiredCell.appendChild(
          field.required
            ? el("span", "badge text-bg-dark", "Required")
            : el("span", "badge text-bg-light border", "Optional")
        );
        row.appendChild(requiredCell);

        const actions = el("td", "text-end");
        const edit = el("button", "btn btn-sm btn-outline-primary me-1", "Edit");
        edit.type = "button";
        edit.dataset.fieldId = field.id;
        edit.dataset.action = "edit";
        const remove = el("button", "btn btn-sm btn-outline-danger", "Delete");
        remove.type = "button";
        remove.dataset.fieldId = field.id;
        remove.dataset.action = "delete";
        actions.append(edit, remove);
        row.appendChild(actions);
        body.appendChild(row);
      });
  }

  function toggleOptions() {
    const isSelect = document.getElementById("fieldType").value === "select";
    document.getElementById("optionsWrap").classList.toggle("d-none", !isSelect);
  }

  function openFieldModal(field) {
    const form = document.getElementById("fieldForm");
    form.reset();
    document.getElementById("fieldError").classList.add("d-none");
    const isEdit = Boolean(field);
    document.getElementById("fieldModalTitle").textContent = isEdit
      ? "Edit metadata field"
      : "Add metadata field";
    document.getElementById("fieldId").value = isEdit ? field.id : "";
    document.getElementById("fieldKey").value = isEdit ? field.key : "";
    document.getElementById("fieldKey").disabled = isEdit;
    document.getElementById("fieldLabel").value = isEdit ? field.label : "";
    document.getElementById("fieldType").value = isEdit ? field.type : "text";
    document.getElementById("fieldOptions").value = isEdit ? field.options.join(", ") : "";
    document.getElementById("fieldOrder").value = isEdit ? field.order : fields.length + 1;
    document.getElementById("fieldRequired").checked = isEdit ? field.required : false;
    toggleOptions();
    modal.show();
  }

  async function saveField(event) {
    event.preventDefault();
    const errorBox = document.getElementById("fieldError");
    errorBox.classList.add("d-none");
    const id = document.getElementById("fieldId").value;
    const payload = {
      key: document.getElementById("fieldKey").value.trim(),
      label: document.getElementById("fieldLabel").value.trim(),
      type: document.getElementById("fieldType").value,
      options: document
        .getElementById("fieldOptions")
        .value.split(",")
        .map((option) => option.trim())
        .filter(Boolean),
      order: Number(document.getElementById("fieldOrder").value || 0),
      required: document.getElementById("fieldRequired").checked,
    };
    if (!payload.key) {
      errorBox.textContent = "Key is required.";
      errorBox.classList.remove("d-none");
      return;
    }
    if (payload.type === "select" && !payload.options.length) {
      errorBox.textContent = "Dropdown fields need at least one option.";
      errorBox.classList.remove("d-none");
      return;
    }

    const button = document.getElementById("saveFieldBtn");
    const original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Saving…';
    try {
      if (id) {
        payload.label = payload.label || payload.key;
        await api(`/api/metadata-fields/${id}`, { method: "PUT", json: payload });
        toast("Field updated.", "success");
      } else {
        await api("/api/metadata-fields", { method: "POST", json: payload });
        toast("Field created — it's live in uploads, filters and search.", "success");
      }
      modal.hide();
      await loadFields();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.classList.remove("d-none");
    } finally {
      button.disabled = false;
      button.innerHTML = original;
    }
  }

  async function deleteField(id) {
    if (!window.confirm("Delete this metadata field? Existing documents keep their stored values.")) return;
    try {
      await api(`/api/metadata-fields/${id}`, { method: "DELETE" });
      toast("Field deleted.", "success");
      await loadFields();
    } catch (err) {
      toast(err.message, "danger");
    }
  }

  async function loadDivisions() {
    const data = await api("/api/divisions");
    const list = document.getElementById("divisionsList");
    list.textContent = "";
    (data.divisions || []).forEach((division) => {
      const item = el("div", "list-group-item d-flex align-items-center justify-content-between");
      const left = el("span", "d-flex align-items-center gap-2");
      left.appendChild(el("i", "bi bi-diagram-3 text-primary"));
      left.appendChild(el("span", "fw-semibold", division.name));
      item.append(left, el("span", "badge text-bg-light border", "Active"));
      list.appendChild(item);
    });
  }

  async function addDivision(event) {
    event.preventDefault();
    const input = document.getElementById("divisionName");
    const errorBox = document.getElementById("divisionError");
    errorBox.classList.add("d-none");
    const name = input.value.trim();
    if (!name) return;
    try {
      await api("/api/divisions", { method: "POST", json: { name } });
      input.value = "";
      toast(`Division “${name}” added.`, "success");
      await loadDivisions();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.classList.remove("d-none");
    }
  }
})();
