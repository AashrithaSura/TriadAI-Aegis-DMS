(function () {
  const KEY = "aegis_theme";
  const root = document.documentElement;

  function isDark() {
    return root.getAttribute("data-bs-theme") === "dark";
  }

  function apply(theme) {
    if (theme === "dark") root.setAttribute("data-bs-theme", "dark");
    else root.removeAttribute("data-bs-theme");

    document.querySelectorAll("[data-theme-icon]").forEach((icon) => {
      icon.className = theme === "dark" ? "bi bi-sun" : "bi bi-moon-stars";
    });
    document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
      const label = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
      button.setAttribute("aria-label", label);
      button.title = label;
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    apply(isDark() ? "dark" : "light");
    document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
      button.addEventListener("click", () => {
        const next = isDark() ? "light" : "dark";
        try {
          localStorage.setItem(KEY, next);
        } catch (err) {
          /* storage blocked */
        }
        apply(next);
      });
    });
  });
})();
