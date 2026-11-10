(function initLegacyCssVars(window, document) {
  "use strict";

  // Chromium 47 (Tizen 3.0) has no CSS custom properties (Chrome 49), so
  // css-vars-ponyfill rewrites every var() rule with literal values. The
  // ponyfill no-ops on browsers with native support (onlyLegacy default),
  // so this file is safe to load everywhere.
  //
  // The ponyfill's own transform (parseCss + transformCss + stringifyCss over
  // the 1 MB bundle) costs ~58 s on the TV's 2017 SoC. Its onSuccess hook
  // receives each sheet's text before any parsing happens, so this file
  // substitutes var() itself with a linear text pipeline (~50 ms, verified
  // byte-equivalent to the ponyfill's output) and hands the ponyfill text with
  // no var() left: regex.cssVars then fails, no parse runs, and the ponyfill
  // skips its transform for that node while still driving the surrounding
  // bookkeeping (job store, out-node groups, re-runs). The substituted text is
  // written to a data-cssvars="out" <style> right after the source node --
  // exactly where the ponyfill would have put its own output.
  //
  // Parity notes (all verified against css-vars-ponyfill 2.4.9 dist):
  //   * variableStore.job = dom (parseVars: top-level :root only, last wins)
  //     then user (settings.variables) overridden on top -- so lookup order
  //     is themeVariables first, then rootValues.
  //   * An unresolvable var() with no fallback stays in the text; the
  //     statement filter then drops that declaration, which is what Chrome 47
  //     does with the ponyfill's output anyway (var() is unknown there).
  //   * The source sheet is never disabled, so @import rules keep working
  //     natively and fixKeyframes never runs (no sheet swap, animations safe).
  if (typeof window.cssVars !== "function") {
    return;
  }

  var themeVariables = {};
  var rootValues = {};
  var rerunTimer = null;
  var transformRuns = 0;
  var hookMs = 0;
  // Out groups start high so they can never collide with the ponyfill's own
  // counters.group (small integers) if it ever falls back to transforming a
  // node natively -- both sides must then agree on the group to update the
  // same out node.
  var nextOutGroup = 1000;
  var outNodeByGroup = {};

  function markProgress(tag) {
    // Out-of-band progress marker (see markBootStage in js/app.js): readable
    // over HTTP via the Web Inspector /json listing while the thread is busy.
    // Also appended to window.__B_MARKS__, a persistent millisecond log that
    // survives title overwrites and can be read over CDP afterwards.
    try {
      console.log("[B] " + tag);
      document.title = "B:" + tag;
      var marks = window.__B_MARKS__ || (window.__B_MARKS__ = []);
      marks.push({ t: Math.round(nowMs()), s: tag });
    } catch (ignored) {}
  }

  function nowMs() {
    return window.performance && window.performance.now
      ? window.performance.now()
      : new Date().getTime();
  }

  // ---------------------------------------------------------------------
  // Fast substitution pipeline. This is the shipped algorithm; the offline
  // verifier (_q_offlinediff.mjs) runs the same steps over the packaged
  // bundle and diffs them against the ponyfill's live output captured from
  // the TV -- keep both in sync.
  // ---------------------------------------------------------------------

  // Mirrors the ponyfill's resolveValue(): a variable is only substituted
  // when its value is a non-empty string (an empty value is treated as
  // undefined, exactly like `match || fallback`), and an unresolvable var()
  // with no fallback is LEFT INTACT instead of being blanked, so the
  // statement filter can drop the whole declaration afterwards.
  function isUsableValue(value) {
    return Boolean(value) && value !== "undefined" && value.length > 0;
  }

  function substituteCssVars(text, themeVars, rootVars) {
    var re = /var\(\s*(--[\w-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*))?\)/g;
    var out = text;
    for (var pass = 0; pass < 6; pass++) {
      var changed = false;
      out = out.replace(re, function (match, name, fallback) {
        var theme = Object.prototype.hasOwnProperty.call(themeVars, name)
          ? themeVars[name]
          : undefined;
        var root = Object.prototype.hasOwnProperty.call(rootVars, name)
          ? rootVars[name]
          : undefined;
        if (isUsableValue(theme)) {
          changed = true;
          return theme;
        }
        if (isUsableValue(root)) {
          changed = true;
          return root;
        }
        if (fallback !== undefined && fallback !== "") {
          changed = true;
          return fallback;
        }
        return match; // unresolvable, no fallback -> keep var(...) for the dropper
      });
      if (!changed || out.indexOf("var(") < 0) break;
    }
    return out;
  }

  // Stock's fixNestedCalc(): collapses calc(calc(X)...) into calc((X)...)
  // after a substitution produced nested calc().
  function fixNestedCalc(text) {
    var reCalcVal = /calc\(([^)]+)\)/g;
    var matches = text.match(reCalcVal) || [];
    var out = text;
    for (var i = 0; i < matches.length; i++) {
      out = out.replace(matches[i], "calc" + matches[i].split("calc").join(""));
    }
    return out;
  }

  function stripImportRules(text) {
    return text.replace(
      /(?:@import\s*)(?:url\(\s*)?(?:['"])([^'"]*)(?:['"])(?:\s*\))?(?:[^;]*;)/g,
      ""
    );
  }

  function fixCssUrls(text, base) {
    var re = /url\((?!['"]?(?:data|http|\/\/):)['"]?([^'")]*)['"]?\)/g;
    var matches = text.match(re) || [];
    var out = text;
    for (var i = 0; i < matches.length; i++) {
      var cssUrl = matches[i];
      var oldUrl = cssUrl.replace(re, "$1");
      var newUrl;
      try {
        newUrl = new window.URL(oldUrl, base).href;
      } catch (ignored) {
        continue;
      }
      out = out.replace(cssUrl, cssUrl.replace(oldUrl, newUrl));
    }
    return out;
  }

  // Statement-level filter over rule bodies; quote-safe; drops selected
  // statements without corrupting neighbours. Also drops plain rules that end
  // up with an empty body (matching the ponyfill's stringifier, which omits
  // rules with no declarations) while keeping empty at-rule shells
  // (@media/@supports/... are rendered regardless).
  function filterStatements(css, shouldDrop) {
    var out = [];
    var stack = [];
    var stmt = "";
    var quote = "";
    var i = 0;
    var n = css.length;

    function keepStmt() {
      var s = stmt;
      stmt = "";
      if (shouldDrop(s)) return false;
      out.push(s);
      if (stack.length) stack[stack.length - 1].kept += 1;
      return true;
    }

    while (i < n) {
      var c = css.charAt(i);
      if (quote) {
        stmt += c;
        if (c === "\\" && i + 1 < n) {
          stmt += css.charAt(i + 1);
          i += 2;
          continue;
        }
        if (c === quote) quote = "";
        i++;
        continue;
      }
      if (c === '"' || c === "'") {
        quote = c;
        stmt += c;
        i++;
        continue;
      }
      if (c === "{") {
        var prelude = stmt;
        var start = out.length;
        out.push(prelude);
        stmt = "";
        out.push(c);
        stack.push({
          start: start,
          isAt: /^\s*@/.test(prelude),
          kept: 0
        });
        i++;
        continue;
      }
      if (c === "}") {
        if (stack.length) {
          if (stmt) keepStmt(); // flush the pending last declaration
          var frame = stack.pop();
          if (frame.kept === 0 && !frame.isAt) {
            out.length = frame.start; // rule became empty -> remove it entirely
          } else {
            out.push("");
            out.push(c);
          }
        } else {
          if (stmt) {
            out.push(stmt);
            stmt = "";
          }
          out.push(c);
        }
        i++;
        continue;
      }
      if (c === ";") {
        if (stmt) {
          var kept = keepStmt();
          if (!kept) continue; // suppress the separator of a dropped statement
        }
        out.push(c);
        i++;
        continue;
      }
      stmt += c;
      i++;
    }
    out.push(stmt);
    return out.join("");
  }

  function isCustomPropStmt(stmt) {
    return /^\s*--[\w-]+\s*:/.test(stmt);
  }

  function hasVarFuncStmt(stmt) {
    return /var\(\s*--/.test(stmt);
  }

  function isEmptyValueStmt(stmt) {
    return /^[a-zA-Z-]+\s*:\s*$/.test(stmt.replace(/\s+$/, ""));
  }

  function isDroppableStatement(stmt) {
    return (
      isCustomPropStmt(stmt) || hasVarFuncStmt(stmt) || isEmptyValueStmt(stmt)
    );
  }

  // The ponyfill's own regex.cssVars (dist line 997): if this tests true on
  // our output, the ponyfill would still parse the whole sheet (the 58 s
  // cost), so a match means the fast path did not finish the job.
  var PONYFILL_REGEX_VARS = /(?:(?::(?:root|host)(?![.:#(])[\s,]*[^{]*{\s*[^;]*;*\s*)|(?:var\(\s*))(--[^:)]+)(?:\s*[:)])/;
  // The ponyfill's regex.cssVarFunc (dist line 996).
  var CSS_VAR_FUNC = /var\(\s*--[\w-]/;

  // The shipped pipeline: substitute, drop @import (the source sheet keeps
  // its own @import and Chrome 47 fetches it natively), absolutize urls,
  // collapse nested calc, then drop -- declarations, leftover var()
  // declarations and empty values.
  function transformSheetText(text, base) {
    var out = substituteCssVars(text, themeVariables, rootValues);
    out = stripImportRules(out);
    out = fixCssUrls(out, base);
    out = fixNestedCalc(out);
    out = filterStatements(out, isDroppableStatement);
    return out;
  }

  // ---------------------------------------------------------------------
  // Scoped custom-property collection.
  //
  // css-vars-ponyfill only knows variables declared on top-level :root
  // (parseVars: stylesheet.rules only, selector ends with ":root", last wins)
  // plus whatever this file passes as `variables`. The Home layout declares
  // its poster metrics on scoped selectors
  //
  // (.home-screen-shell.home-layout-modern), so every var() use of them was
  // reported "undefined" and left as var(...) -- which Chrome 47 then drops as
  // invalid, collapsing poster frames to zero height. Chrome 47's CSSOM also
  // strips -- declarations and var() uses from cssRules, so the declarations
  // are read from the raw stylesheet text (link fetched with a synchronous
  // XHR; inline styles via textContent) and handed to the ponyfill as extra
  // variables. Definitions whose selector matches a live element win over
  // ones from inactive scopes (classic/landscape layouts), so the active
  // layout's values are used. Names already declared on :root are left to
  // the ponyfill's own root handling, and keys already present in
  // themeVariables (for example theme values pushed by ThemeManager through
  // the setProperty hook below) are never overwritten.
  // ---------------------------------------------------------------------

  function readStyleSheetText(sheet) {
    if (!sheet.href) {
      var node = sheet.ownerNode;
      return (node && node.textContent) || "";
    }
    try {
      var xhr = new XMLHttpRequest();
      xhr.open("GET", sheet.href, false);
      xhr.send(null);
      if (xhr.status === 200 || xhr.status === 0) {
        return xhr.responseText;
      }
    } catch (ignored) {}
    return "";
  }

  function splitTopLevel(text) {
    var parts = [];
    var depth = 0;
    var current = "";
    for (var i = 0; i < text.length; i++) {
      var c = text.charAt(i);
      if (c === "(") depth++;
      else if (c === ")") depth--;
      if (c === "," && depth === 0) {
        parts.push(current);
        current = "";
      } else {
        current += c;
      }
    }
    parts.push(current);
    return parts;
  }

  function normalizeSelector(selector) {
    return selector
      .replace(/::[a-zA-Z0-9_-]+(\([^)]*\))?/g, "")
      .replace(/^\s+|\s+$/g, "");
  }

  function selectorMatches(selectorText) {
    var parts = splitTopLevel(selectorText);
    for (var i = 0; i < parts.length; i++) {
      var sel = normalizeSelector(parts[i]);
      if (!sel) continue;
      try {
        if (document.querySelector(sel)) return true;
      } catch (ignored) {}
    }
    return false;
  }

  function selectorIsRoot(selectorText) {
    var parts = splitTopLevel(selectorText);
    for (var i = 0; i < parts.length; i++) {
      var sel = normalizeSelector(parts[i]);
      if (!sel) continue;
      if (sel === ":root" || sel === ":host") return true;
      try {
        var el = document.querySelector(sel);
        if (el && el === document.documentElement) return true;
      } catch (ignored) {}
    }
    return false;
  }

  // Stock's parseVars rule: a top-level rule whose selector (comma split,
  // trimmed) ENDS with ":root". Kept raw (no pseudo-element stripping) to
  // match postcss's selector test exactly.
  function isStockRootPrelude(prelude) {
    var parts = splitTopLevel(prelude);
    for (var i = 0; i < parts.length; i++) {
      if (/:root$/.test(parts[i].replace(/^\s+|\s+$/g, ""))) return true;
    }
    return false;
  }

  function skipString(css, i) {
    var quote = css.charAt(i);
    i++;
    while (i < css.length && css.charAt(i) !== quote) {
      if (css.charAt(i) === "\\") i++;
      i++;
    }
    return i + 1;
  }

  // Walk "prelude { body }" blocks (recursing into @media/@supports when the
  // query matches) and record every style rule with its nesting depth.
  // Records are cached per sheet so re-runs never re-walk or re-fetch.
  function parseSheetRules(css, out, depth) {
    var i = 0;
    var len = css.length;
    while (i < len) {
      var ch = css.charAt(i);
      if (ch === "/" && css.charAt(i + 1) === "*") {
        var ce = css.indexOf("*/", i + 2);
        i = ce < 0 ? len : ce + 2;
        continue;
      }
      if (ch === '"' || ch === "'") {
        i = skipString(css, i);
        continue;
      }
      if (/\s/.test(ch)) {
        i++;
        continue;
      }
      var preludeStart = i;
      var level = 0;
      var end = -1;
      var isBlock = false;
      while (i < len) {
        var c = css.charAt(i);
        if (c === "/" && css.charAt(i + 1) === "*") {
          var ce2 = css.indexOf("*/", i + 2);
          i = ce2 < 0 ? len : ce2 + 2;
          continue;
        }
        if (c === '"' || c === "'") {
          i = skipString(css, i);
          continue;
        }
        if (c === "(") level++;
        else if (c === ")") level--;
        else if (c === "{" && level === 0) {
          end = i;
          isBlock = true;
          break;
        } else if ((c === ";" || c === "}") && level === 0) {
          end = i;
          break;
        }
        i++;
      }
      if (end < 0) return out;
      var prelude = css.slice(preludeStart, end).replace(/^\s+|\s+$/g, "");
      if (!isBlock) {
        i = end + 1;
        continue;
      }
      var bodyStart = end + 1;
      var braces = 0;
      var j = bodyStart;
      var close = -1;
      while (j < len) {
        var c2 = css.charAt(j);
        if (c2 === "/" && css.charAt(j + 1) === "*") {
          var ce3 = css.indexOf("*/", j + 2);
          j = ce3 < 0 ? len : ce3 + 2;
          continue;
        }
        if (c2 === '"' || c2 === "'") {
          j = skipString(css, j);
          continue;
        }
        if (c2 === "{") braces++;
        else if (c2 === "}") {
          if (braces === 0) {
            close = j;
            break;
          }
          braces--;
        }
        j++;
      }
      if (close < 0) return out;
      var body = css.slice(bodyStart, close);
      if (prelude.charAt(0) === "@") {
        var mediaMatch = /^@(media|supports|document)\b([\s\S]*)$/.exec(prelude);
        if (mediaMatch && !/keyframes/i.test(prelude)) {
          var queries = mediaMatch[2].replace(/^\s+|\s+$/g, "");
          var applies = true;
          if (mediaMatch[1] === "media" && queries && window.matchMedia) {
            try {
              applies = window.matchMedia(queries).matches;
            } catch (ignoredMedia) {
              applies = true;
            }
          }
          if (applies) parseSheetRules(body, out, depth + 1);
        }
        // Other at-rules (@font-face, @keyframes, @import...) carry no
        // scoped custom properties that the Home layout depends on.
      } else {
        out.push({ prelude: prelude, body: body, depth: depth });
      }
      i = close + 1;
    }
    return out;
  }

  // Extract -- declarations from cached rules: stock-root declarations fill
  // rootValues (top-level :root, last wins, document order), everything else
  // feeds the live-priority scoped map exactly as before.
  function collectFromRules(rules, picked, rootNames) {
    for (var r = 0; r < rules.length; r++) {
      var rule = rules[r];
      var decls = rule.body.match(/--[\w-]+\s*:\s*[^;{}]+/g);
      if (!decls) continue;
      var matches = selectorMatches(rule.prelude);
      var isRoot = selectorIsRoot(rule.prelude);
      var isStockRoot = rule.depth === 0 && isStockRootPrelude(rule.prelude);
      for (var i = 0; i < decls.length; i++) {
        var m = /^(--[\w-]+)\s*:\s*([^;{}]+)$/.exec(
          decls[i].replace(/\s+$/, "")
        );
        if (!m) continue;
        var name = m[1];
        var value = m[2].replace(/^\s+|\s+$/g, "");
        if (!value) continue;
        if (isStockRoot) {
          rootValues[name] = value;
        }
        if (isRoot) {
          rootNames[name] = true;
          continue;
        }
        var prev = picked[name];
        // Live-selector definitions win over inactive-scope ones; among
        // equal matches the later declaration wins (document order).
        if (!prev || matches || !prev.matched) {
          picked[name] = { value: value, matched: matches };
        }
      }
    }
  }

  // Rule records per sheet: links are fetched once (their text cannot change
  // at runtime), inline styles are re-read cheaply and re-parsed only when
  // their text actually changed.
  function getSheetRules(sheet) {
    var node = sheet.ownerNode;
    if (!node) return null;
    var cached = node.__nuvioCssRules;
    if (cached && node.nodeName.toLowerCase() !== "style") {
      return cached;
    }
    var text = readStyleSheetText(sheet);
    if (!text) return null;
    if (cached && cached.__nuvioText === text) {
      return cached;
    }
    var rules = parseSheetRules(text, [], 0);
    rules.__nuvioText = text;
    node.__nuvioCssRules = rules;
    return rules;
  }

  function refreshScopedVariables() {
    try {
      var picked = {};
      var rootNames = {};
      rootValues = {};
      var sheets = document.styleSheets;
      for (var i = 0; i < sheets.length; i++) {
        var node = sheets[i].ownerNode;
        if (node && node.getAttribute("data-cssvars") === "out") continue;
        var rules = getSheetRules(sheets[i]);
        if (rules) collectFromRules(rules, picked, rootNames);
      }
      for (var name in picked) {
        if (!Object.prototype.hasOwnProperty.call(picked, name)) continue;
        if (rootNames[name]) continue;
        if (Object.prototype.hasOwnProperty.call(themeVariables, name)) continue;
        if (picked[name] && picked[name].value) {
          themeVariables[name] = picked[name].value;
        }
      }
    } catch (ignored) {
      // Collection must never break theming.
    }
  }

  // ---------------------------------------------------------------------
  // The fast onSuccess hook: called by the ponyfill for every sheet BEFORE
  // it parses anything. Returns the substituted text (so regex.cssVars fails
  // and the expensive parse never runs) after publishing it as the sheet's
  // out node; returns undefined to let the ponyfill handle a node natively
  // (its output is ground truth -- slow but correct).
  // ---------------------------------------------------------------------

  function ensureOutNode(srcNode, outText) {
    var group = srcNode.getAttribute("data-cssvars-group");
    if (!group) {
      group = String(nextOutGroup);
      nextOutGroup += 1;
      srcNode.setAttribute("data-cssvars-group", group);
    }
    var outNode = outNodeByGroup[group];
    if (!outNode) {
      outNode = document.querySelector(
        'style[data-cssvars="out"][data-cssvars-group="' + group + '"]'
      );
      if (!outNode) {
        outNode = document.createElement("style");
        outNode.setAttribute("data-cssvars", "out");
        outNode.setAttribute("data-cssvars-group", group);
      }
      outNodeByGroup[group] = outNode;
    }
    if (outNode.textContent !== outText) {
      outNode.textContent = outText;
    }
    if (!outNode.parentNode) {
      srcNode.parentNode.insertBefore(outNode, srcNode.nextSibling);
    }
    if (srcNode.getAttribute("data-cssvars") !== "src") {
      srcNode.setAttribute("data-cssvars", "src");
    }
  }

  function fastOnSuccess(cssText, node, sourceUrl) {
    if (!CSS_VAR_FUNC.test(cssText)) {
      // Nothing to substitute; the ponyfill treats the node as-is.
      return undefined;
    }
    var startedAt = nowMs();
    try {
      var out = transformSheetText(
        cssText,
        sourceUrl || window.location.href
      );
      if (PONYFILL_REGEX_VARS.test(out)) {
        // Residual var() the ponyfill would still parse: take the native
        // (slow) path for this node instead of shipping a partial result.
        markProgress("cssvars-hook-slowpath");
        return undefined;
      }
      ensureOutNode(node, out);
      hookMs += nowMs() - startedAt;
      return out;
    } catch (error) {
      hookMs += nowMs() - startedAt;
      markProgress("cssvars-hook-error");
      return undefined;
    }
  }

  function scheduleTransform() {
    if (rerunTimer !== null) {
      window.clearTimeout(rerunTimer);
    }
    rerunTimer = window.setTimeout(function () {
      rerunTimer = null;
      transformRuns += 1;
      markProgress("cssvars-rerun#" + transformRuns + "-begin");
      refreshScopedVariables();
      hookMs = 0;
      try {
        window.cssVars({
          watch: true,
          variables: themeVariables,
          onSuccess: fastOnSuccess,
          onComplete: function (cssText, outNodes, job, ms) {
            markProgress(
              "cssvars-rerun#" +
                transformRuns +
                "-done in " +
                Math.round(ms) +
                "ms hook " +
                Math.round(hookMs) +
                "ms"
            );
          }
        });
      } catch (error) {
        // Theming must never break the UI.
        markProgress("cssvars-rerun#" + transformRuns + "-error");
      }
    }, 150);
  }

  refreshScopedVariables();
  transformRuns += 1;
  markProgress("cssvars#1-begin");
  hookMs = 0;
  try {
    window.cssVars({
      watch: true,
      variables: themeVariables,
      onSuccess: fastOnSuccess,
      onComplete: function (cssText, outNodes, job, ms) {
        markProgress(
          "cssvars#1-done in " +
            Math.round(ms) +
            "ms hook " +
            Math.round(hookMs) +
            "ms"
        );
      }
    });
  } catch (error) {
    markProgress("cssvars#1-error");
    return;
  }

  // ThemeManager pushes palette values through setProperty("--x", ...) on the
  // root element, but the ponyfill only watches <style>/<link> mutations --
  // not inline style attributes. Mirror root-level custom property writes
  // into the ponyfill's variables store and re-run the transform (debounced,
  // so the ~50 writes of one theme application produce a single pass).
  var stylePrototype =
    window.CSSStyleDeclaration && window.CSSStyleDeclaration.prototype;
  if (stylePrototype && typeof stylePrototype.setProperty === "function") {
    var originalSetProperty = stylePrototype.setProperty;
    stylePrototype.setProperty = function (name, value, priority) {
      var result = originalSetProperty.call(this, name, value, priority);
      try {
        if (
          typeof name === "string" &&
          name.slice(0, 2) === "--" &&
          this === document.documentElement &&
          themeVariables[name] !== value
        ) {
          themeVariables[name] = value;
          scheduleTransform();
        }
      } catch (error) {
        // Styling must never break navigation.
      }
      return result;
    };
  }
})(window, document);
