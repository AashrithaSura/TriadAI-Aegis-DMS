(function () {
  const state = { type: "incoming" };
  const container = () => document.getElementById("requestsList");

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    document.querySelectorAll("#requestTabs .nav-link").forEach((tab) => {
      tab.addEventListener("click", () => {
        document.querySelectorAll("#requestTabs .nav-link").forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        state.type = tab.dataset.type;
        load();
      });
    });
    container().addEventListener("click", handleAction);
    load();
  }

  async function load() {
    document.getElementById("requestsError").classList.add("d-none");
    container().textContent = "";
    const spinner = el("div", "text-center text-muted py-5");
    spinner.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Loading requests…';
    container().appendChild(spinner);

    try {
      const data = await api(`/api/access/requests?type=${state.type}&per_page=100`);
      document.getElementById("incomingCount").textContent = data.pending_incoming;
      document.getElementById("outgoingCount").textContent = data.pending_outgoing;
      render(data.requests);
    } catch (err) {
      const box = document.getElementById("requestsError");
      box.textContent = err.message;
      box.classList.remove("d-none");
      container().textContent = "";
    }
  }

  function render(requests) {
    container().textContent = "";
    if (!requests.length) {
      const wrap = el("div", "empty-state");
      wrap.appendChild(el("i", "bi-inbox"));
      wrap.appendChild(el("h5", "fw-semibold text-dark", "No requests here"));
      wrap.appendChild(
        el(
          "p",
          "mb-0",
          state.type === "incoming"
            ? "When another division requests one of your documents, it will appear here for approval."
            : "You haven't requested cross-division access yet. Open a document from another division to request it."
        )
      );
      container().appendChild(wrap);
      return;
    }
    requests.forEach((request) => container().appendChild(requestCard(request)));
  }

  function requestCard(request) {
    const card = el("div", "card mb-3");
    const body = el("div", "card-body");
    const header = el("div", "d-flex flex-wrap justify-content-between align-items-start gap-2");
    const left = el("div", "min-w-0");

    const title = el("a", "doc-title h6 mb-1 d-inline-block", request.doc_title || "Untitled document");
    title.href = `/documents/${request.doc_id}`;
    left.appendChild(title);

    const meta = el("div", "doc-meta");
    meta.appendChild(el("span", "badge-soft", request.requester_division));
    meta.appendChild(el("i", "bi bi-arrow-right text-muted small align-self-center"));
    meta.appendChild(el("span", "badge-soft", request.owner_division));
    left.appendChild(meta);

    const sub = el(
      "div",
      "small text-muted",
      `${request.requester_name || request.requester_email} · requested ${fmtDate(request.created_at)}`
    );
    left.appendChild(sub);

    const right = el("div", "d-flex align-items-center gap-2");
    right.appendChild(statusBadge(request.status));
    if (request.can_decide) {
      const approve = el("button", "btn btn-sm btn-success", "Approve");
      approve.type = "button";
      approve.dataset.requestId = request.id;
      approve.dataset.action = "approve";
      const reject = el("button", "btn btn-sm btn-outline-danger", "Reject");
      reject.type = "button";
      reject.dataset.requestId = request.id;
      reject.dataset.action = "reject";
      right.append(approve, reject);
    }
    header.append(left, right);
    body.appendChild(header);

    if (request.note) {
      const note = el("div", "request-note mt-2");
      note.appendChild(el("i", "bi bi-chat-left-text me-1"));
      note.appendChild(document.createTextNode(request.note));
      body.appendChild(note);
    }

    if (request.status !== "pending" && request.decided_by_name) {
      const decided = el(
        "div",
        "small text-muted mt-2",
        `${request.status === "approved" ? "Approved" : "Rejected"} by ${request.decided_by_name} · ${fmtDate(request.decided_at)}`
      );
      body.appendChild(decided);
    }

    card.appendChild(body);
    return card;
  }

  async function handleAction(event) {
    const button = event.target.closest("[data-request-id]");
    if (!button) return;
    const action = button.dataset.action;
    const verb = action === "approve" ? "Approve" : "Reject";
    if (!window.confirm(`${verb} this access request?`)) return;

    const original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';
    try {
      const data = await api("/api/access/approve", {
        method: "POST",
        json: { request_id: button.dataset.requestId, action },
      });
      toast(`Request ${data.status || (action === "approve" ? "approved" : "rejected")}.`, "success");
      await load();
      if (window.refreshBadge) window.refreshBadge();
    } catch (err) {
      toast(err.message, "danger");
      button.disabled = false;
      button.innerHTML = original;
    }
  }
})();
