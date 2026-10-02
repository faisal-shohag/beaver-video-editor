// Runs before first paint (kept external: the app CSP blocks inline scripts).
(function () {
  var theme = "dark";
  try {
    var pref = localStorage.getItem("beaver.theme") || "system";
    var dark = pref === "dark" || (pref !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
    theme = dark ? "dark" : "light";
  } catch (e) {
    /* storage unavailable: keep dark */
  }
  document.documentElement.dataset.theme = theme;
})();
