(function () {
  document.addEventListener("DOMContentLoaded", init);

  function init() {
    if (Api.getToken()) {
      location.replace("/");
      return;
    }
    const loginForm = document.getElementById("loginForm");
    if (loginForm) loginForm.addEventListener("submit", handleLogin);
    const registerForm = document.getElementById("registerForm");
    if (registerForm) {
      registerForm.addEventListener("submit", handleRegister);
      loadDivisions();
    }
  }

  function showError(id, message) {
    const box = document.getElementById(id);
    if (!box) return;
    box.textContent = message;
    box.classList.remove("d-none");
  }

  function busy(button, isBusy, label) {
    if (!button) return;
    if (isBusy) {
      button.dataset.label = button.innerHTML;
      button.disabled = true;
      button.innerHTML = `<span class="spinner-border spinner-border-sm me-2"></span>${label}`;
    } else {
      button.disabled = false;
      if (button.dataset.label) button.innerHTML = button.dataset.label;
    }
  }

  function nextUrl() {
    const next = new URLSearchParams(location.search).get("next");
    return next && next.startsWith("/") ? next : "/";
  }

  async function handleLogin(event) {
    event.preventDefault();
    const email = document.getElementById("email").value.trim();
    const password = document.getElementById("password").value;
    const button = document.getElementById("loginBtn");
    if (!email || !password) {
      showError("loginError", "Enter your email and password.");
      return;
    }
    busy(button, true, "Signing in…");
    try {
      const data = await api("/api/auth/login", {
        method: "POST",
        json: { email, password },
        auth: false,
      });
      Api.setSession(data.token, data.user);
      location.replace(nextUrl());
    } catch (err) {
      showError("loginError", err.message);
      busy(button, false);
    }
  }

  async function loadDivisions() {
    const select = document.getElementById("division");
    if (!select) return;
    try {
      const data = await api("/api/divisions", { auth: false });
      data.divisions.forEach((division) => {
        const option = document.createElement("option");
        option.value = division.name;
        option.textContent = division.name;
        select.appendChild(option);
      });
    } catch (err) {
      showError("registerError", "Could not load divisions. Is the server running?");
    }
  }

  async function handleRegister(event) {
    event.preventDefault();
    const name = document.getElementById("name").value.trim();
    const email = document.getElementById("email").value.trim();
    const password = document.getElementById("password").value;
    const division = document.getElementById("division").value;
    const button = document.getElementById("registerBtn");

    if (!name || !email || !password || !division) {
      showError("registerError", "All fields are required.");
      return;
    }
    if (password.length < 6) {
      showError("registerError", "Password must be at least 6 characters.");
      return;
    }
    busy(button, true, "Creating account…");
    try {
      const data = await api("/api/auth/register", {
        method: "POST",
        json: { name, email, password, division },
        auth: false,
      });
      Api.setSession(data.token, data.user);
      location.replace("/");
    } catch (err) {
      showError("registerError", err.message);
      busy(button, false);
    }
  }
})();
