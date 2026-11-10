(function detectLegacyFeatureSupport(window, document) {
  "use strict";

  var root = document.documentElement;

  // Node.isConnected arrived in Chrome 51; Tizen 3.0 (Chromium 47) does not
  // have it. Without it every truthiness check reads `undefined`, so the Home
  // lazy-image sweep treats all rows as detached and never loads a poster.
  if (!("isConnected" in Node.prototype)) {
    Object.defineProperty(Node.prototype, "isConnected", {
      configurable: true,
      get: function () {
        return this === document || this === root || root.contains(this);
      }
    });
  }

  // NOTE: a queueMicrotask polyfill was tried here and REVERTED: with a pure
  // microtask shim, a boot-time scheduler that dies with
  // "ReferenceError: queueMicrotask is not defined" on stock Chromium 47
  // instead starts a self-repeating microtask loop that starves the event
  // loop (title freezes, Web Inspector stops responding). That error is
  // non-critical: boot and UI complete without it.

  function removeClass(name) {
    root.className = (" " + root.className + " ")
      .replace(new RegExp(" " + name + " ", "g"), " ")
      .replace(/^\s+|\s+$/g, "");
  }

  function supports(prop, value) {
    var css = window.CSS;
    return Boolean(css && typeof css.supports === "function" && css.supports(prop, value));
  }

  try {
    var test = document.createElement("div");
    var child = document.createElement("div");
    test.style.position = "absolute";
    test.style.left = "-9999px";
    test.style.top = "-9999px";
    test.style.display = "flex";
    test.style.flexDirection = "column";
    test.style.rowGap = "1px";
    child.style.height = "1px";
    test.appendChild(child.cloneNode());
    test.appendChild(child.cloneNode());
    root.appendChild(test);
    if (test.scrollHeight === 3) {
      removeClass("no-flex-gap");
    }
    root.removeChild(test);
  } catch (error) {
    removeClass("no-flex-gap");
  }

  if (supports("display", "grid")) removeClass("no-css-grid");
  if (supports("font-size", "clamp(1px, 2px, 3px)")) removeClass("no-css-math");
  if (supports("aspect-ratio", "1 / 1")) removeClass("no-aspect-ratio");
  if (
    supports("backdrop-filter", "blur(1px)") ||
    supports("-webkit-backdrop-filter", "blur(1px)")
  ) {
    removeClass("no-backdrop-filter");
  }
})(window, document);
