/*!
 * RunHQ Widget v2.0.0
 * Embeddable feedback widget — vanilla JS, no dependencies.
 * Usage: <script src="/widget.js"></script>
 *        <script>RunHQWidget.init({ token: "rw_..." })</script>
 */
(function () {
  "use strict";

  // ===========================================================================
  // Config & state
  // ===========================================================================

  var config = {};
  var consoleLogs = [];
  var capturedErrors = [];
  var MAX_LOG_BUFFER = 50;

  var shadowHostEl = null;
  var shadowRoot = null;
  var stageEl = null;
  var tabEl = null;
  var widgetEl = null;
  var scrollEl = null;
  var headerTitleEl = null;
  var themeToggleBtn = null;
  var footerEl = null;
  var modalMountEl = null;

  var isOpen = false;
  var activeTab = "hot"; // "updates" | "hot" | "mine"  (default lands on Hot per dashboard design)
  var theme = "light";

  var topTicketsCache = null;   // /api/widget/tickets        — drives "Hot" tab + recent-others list
  var updatesCache = null;      // /api/widget/tickets/updates — drives "Updates" tab + tab-label badge
  var myTicketsCache = null;    // /api/widget/tickets/mine    — drives "My Tickets" tab
  var activeModal = null;       // for the image lightbox only (inline composer + detail replace the old new-ticket / detail modals)

  // Modal-shell view state. The shell is a centered card with two faces:
  //   "list"   — split layout: composer + recent on the left, tabbed activity on the right.
  //   "detail" — full-width ticket detail with a "Back to activity" button.
  // Switching between the two re-renders the card body in place; the launcher
  // tab and outer modal chrome stay mounted so we don't pay a remount cost.
  var view = "list";
  var currentDetailTicket = null;

  // ===========================================================================
  // Console & error capture
  // ===========================================================================

  function hookConsole() {
    ["log", "warn", "error", "info"].forEach(function (level) {
      var orig = console[level].bind(console);
      console[level] = function () {
        orig.apply(console, arguments);
        var entry = {
          level: level,
          message: Array.prototype.slice.call(arguments).map(function (a) {
            try { return typeof a === "object" ? JSON.stringify(a) : String(a); }
            catch (_) { return String(a); }
          }).join(" "),
          ts: new Date().toISOString(),
        };
        consoleLogs.push(entry);
        if (consoleLogs.length > MAX_LOG_BUFFER) consoleLogs.shift();
      };
    });

    var origOnError = window.onerror;
    window.onerror = function (msg, src, line, col, err) {
      capturedErrors.push({
        type: "onerror", message: String(msg), source: src,
        line: line, col: col,
        stack: err && err.stack ? err.stack : null,
        ts: new Date().toISOString(),
      });
      if (capturedErrors.length > MAX_LOG_BUFFER) capturedErrors.shift();
      if (typeof origOnError === "function") return origOnError.apply(this, arguments);
    };

    window.addEventListener("unhandledrejection", function (e) {
      capturedErrors.push({
        type: "unhandledrejection",
        message: e.reason ? String(e.reason) : "Unhandled promise rejection",
        stack: e.reason && e.reason.stack ? e.reason.stack : null,
        ts: new Date().toISOString(),
      });
      if (capturedErrors.length > MAX_LOG_BUFFER) capturedErrors.shift();
    });
  }

  // ===========================================================================
  // API
  // ===========================================================================

  var RUNHQ_API = (function () {
    try {
      var scripts = document.querySelectorAll('script[src*="widget.js"]');
      var src = scripts[scripts.length - 1].src;
      return src.substring(0, src.lastIndexOf('/'));
    } catch (_) {}
    return "https://www.runhq.io";
  })();

  function authHeaders(extra) {
    var headers = extra || {};
    if (config.token) headers["Authorization"] = "Bearer " + config.token;
    else if (config.project) headers["X-RW-Project"] = config.project;
    return headers;
  }

  function api(path, opts) {
    var headers = authHeaders({ "Content-Type": "application/json" });
    return fetch(RUNHQ_API + path, {
      method: (opts && opts.method) || "GET",
      headers: headers,
      body: (opts && opts.body) ? JSON.stringify(opts.body) : undefined,
    }).then(function (r) {
      if (!r.ok) {
        return r.json().catch(function () { return {}; }).then(function (data) {
          var err = new Error((data && data.error) || ("API error: " + r.status));
          err.status = r.status;
          throw err;
        });
      }
      return r.json();
    });
  }

  function loadTopTickets()       { return api("/api/widget/tickets"); }
  function loadUpdates()          { return api("/api/widget/tickets/updates"); }
  function loadMyTickets()        { return api("/api/widget/tickets/mine"); }
  function loadTicketDetail(id)   { return api("/api/widget/tickets/" + encodeURIComponent(id)); }
  function createTicket(data)     { return api("/api/widget/tickets", { method: "POST", body: data }); }
  function castUpvote(ticketId)   { return api("/api/widget/tickets/" + encodeURIComponent(ticketId) + "/vote", { method: "POST", body: { value: true } }); }
  function retractVote(ticketId)  { return api("/api/widget/tickets/" + encodeURIComponent(ticketId) + "/vote", { method: "DELETE" }); }
  function postComment(ticketId, content) {
    return api("/api/widget/tickets/" + encodeURIComponent(ticketId) + "/comments", {
      method: "POST", body: { content: content },
    });
  }

  function uploadTicketAttachment(ticketId, file) {
    var fd = new FormData();
    fd.append("file", file, file.name || "upload");
    return fetch(RUNHQ_API + "/api/widget/tickets/" + encodeURIComponent(ticketId) + "/attachments", {
      method: "POST",
      headers: authHeaders(),
      body: fd,
    }).then(readJsonOrThrow);
  }

  function uploadCommentAttachment(ticketId, commentId, file) {
    var fd = new FormData();
    fd.append("file", file, file.name || "upload");
    return fetch(RUNHQ_API + "/api/widget/tickets/" + encodeURIComponent(ticketId)
      + "/comments/" + encodeURIComponent(commentId) + "/attachments", {
      method: "POST",
      headers: authHeaders(),
      body: fd,
    }).then(readJsonOrThrow);
  }

  function readJsonOrThrow(r) {
    return r.json().catch(function () { return {}; }).then(function (data) {
      if (!r.ok) {
        var err = new Error((data && data.error) || ("Request failed: " + r.status));
        err.status = r.status;
        throw err;
      }
      return data;
    });
  }

  // ===========================================================================
  // DOM helper
  // ===========================================================================

  var SVG_NS = "http://www.w3.org/2000/svg";
  var SVG_TAGS = { svg: 1, path: 1, circle: 1, rect: 1, line: 1, polyline: 1, polygon: 1, g: 1 };

  function h(tag, attrs, children) {
    var el = SVG_TAGS[tag] ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === "className") {
          el.setAttribute("class", v);
        } else if (k === "style" && typeof v === "object") {
          Object.keys(v).forEach(function (sk) { el.style[sk] = v[sk]; });
        } else if (k.slice(0, 2) === "on") {
          el.addEventListener(k.slice(2).toLowerCase(), v);
        } else {
          el.setAttribute(k, v === true ? "" : v);
        }
      });
    }
    if (children != null) {
      if (typeof children === "string" || typeof children === "number") {
        el.textContent = String(children);
      } else if (Array.isArray(children)) {
        children.forEach(function (c) {
          if (c == null || c === false) return;
          if (typeof c === "string" || typeof c === "number") {
            el.appendChild(document.createTextNode(String(c)));
          } else {
            el.appendChild(c);
          }
        });
      } else {
        el.appendChild(children);
      }
    }
    return el;
  }

  function clearChildren(el) { while (el && el.firstChild) el.removeChild(el.firstChild); }

  function icon(paths, size, stroke) {
    size = size || 16;
    stroke = stroke || 1.6;
    var svg = h("svg", {
      width: size, height: size, viewBox: "0 0 24 24",
      fill: "none", stroke: "currentColor",
      "stroke-width": stroke, "stroke-linecap": "round", "stroke-linejoin": "round",
      "aria-hidden": "true",
    });
    paths.forEach(function (p) {
      if (p.tag === "circle") svg.appendChild(h("circle", { cx: p.cx, cy: p.cy, r: p.r }));
      else if (p.tag === "rect") svg.appendChild(h("rect", { x: p.x, y: p.y, width: p.width, height: p.height, rx: p.rx || 0 }));
      else svg.appendChild(h("path", { d: p.d }));
    });
    return svg;
  }

  var Icons = {
    close:     function (s) { return icon([{ d: "M6 6l12 12M18 6L6 18" }], s); },
    plus:      function (s) { return icon([{ d: "M12 5v14M5 12h14" }], s, 2.2); },
    arrowUp:   function (s) { return icon([{ d: "M12 19V5M5 12l7-7 7 7" }], s, 2); },
    arrowLeft: function (s) { return icon([{ d: "M19 12H5M12 19l-7-7 7-7" }], s, 2); },
    paperclip: function (s) { return icon([{ d: "M21 11.5l-8.5 8.5a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8" }], s); },
    lock:      function (s) { return icon([{ tag: "rect", x: 4, y: 11, width: 16, height: 10, rx: 2 }, { d: "M8 11V7a4 4 0 0 1 8 0v4" }], s); },
    send:      function (s) { return icon([{ d: "M22 2L11 13" }, { d: "M22 2l-7 20-4-9-9-4 20-7z" }], s); },
    sun:       function (s) { return icon([{ tag: "circle", cx: 12, cy: 12, r: 4 }, { d: "M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" }], s); },
    moon:      function (s) { return icon([{ d: "M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z" }], s); },
    link:      function (s) { return icon([{ d: "M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" }, { d: "M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" }], s); },
    image:     function (s) { return icon([{ tag: "rect", x: 3, y: 4, width: 18, height: 16, rx: 2 }, { tag: "circle", cx: 9, cy: 10, r: 1.5 }, { d: "M21 16l-5-5-8 8" }], s); },
  };

  // ===========================================================================
  // Status palette — sourced from window.__RW_CONSTANTS__.status, which is
  // injected by the /widget.js route handler from the protocol's canonical
  // TODO_STATUS_DISPLAY registry. The widget MUST NOT carry its own table
  // here; doing so reintroduces drift (the 'deployed' regression that
  // rendered as 'Open').
  // ===========================================================================

  function getStatusRegistry() {
    var c = (typeof window !== "undefined" && window.__RW_CONSTANTS__) || null;
    return (c && c.status) || null;
  }
  // Last-resort visual when the registry is unavailable (cached pre-injection
  // bundle, mounted via an unexpected path, etc.). Surfaces the raw status
  // value so divergence is visible rather than silently mislabeled.
  var STATUS_FALLBACK = { label: "", dot: "#8a857d", bg: "rgba(85,80,74,0.08)", fg: "#55504a" };
  function statusMeta(s) {
    var R = getStatusRegistry();
    if (R && R[s]) return R[s];
    return { label: String(s == null ? "unknown" : s), dot: STATUS_FALLBACK.dot, bg: STATUS_FALLBACK.bg, fg: STATUS_FALLBACK.fg };
  }
  // Returns the display label for a status, or null if no registry entry
  // exists. Used by activity-row formatting where we want to omit the
  // label rather than render a synthesized one.
  function statusLabel(s) {
    var R = getStatusRegistry();
    return R && R[s] ? R[s].label : null;
  }
  function renderStatusChip(status) {
    var s = statusMeta(status);
    return h("span", { className: "rw-chip", style: { background: s.bg, color: s.fg } }, [
      h("span", { className: "rw-chip-dot", style: { background: s.dot } }),
      document.createTextNode(s.label),
    ]);
  }

  // ===========================================================================
  // Theme
  // ===========================================================================

  function themeStorageKey() {
    return "rw-theme:" + (config.projectId || config.project || "default");
  }

  // ===========================================================================
  // Unread-updates tracking for the side tab label
  // ===========================================================================

  var WEEK_MS = 7 * 24 * 60 * 60 * 1000;

  function lastOpenedKey() {
    return "rw-last-opened:" + (config.projectId || config.project || "default");
  }
  function getLastOpenedAt() {
    try {
      var raw = localStorage.getItem(lastOpenedKey());
      var n = raw ? parseInt(raw, 10) : 0;
      return isNaN(n) ? 0 : n;
    } catch (_) { return 0; }
  }
  function markPanelOpened() {
    try { localStorage.setItem(lastOpenedKey(), String(Date.now())); } catch (_) {}
    refreshTabLabel();
  }

  function unreadUpdatesCount() {
    var rows = updatesCache || [];
    if (rows.length === 0) return 0;
    var lastOpened = getLastOpenedAt();
    var weekAgo = Date.now() - WEEK_MS;
    var threshold = Math.max(lastOpened, weekAgo);
    var n = 0;
    for (var i = 0; i < rows.length; i++) {
      var t = rows[i];
      var when = new Date(t.completedAt || t.createdAt || 0).getTime();
      if (when > threshold) n++;
    }
    return n;
  }

  function buildTabIcon() {
    // A small CSS-driven mark: glowing core + three concentric orbits with
    // different radii / periods / directions. The orbital periods (2.4s,
    // 3.6s, 4.7s) are mutually almost-coprime, so the dots only line up
    // every ~40 minutes — the visual pattern never quite repeats, which is
    // what reads as "alive." Pure CSS, no rAF, no SVG.
    return h("span", { className: "rw-tab-icon", "aria-hidden": "true" }, [
      h("span", { className: "rw-tab-icon-orbit rw-tab-icon-orbit-1" }),
      h("span", { className: "rw-tab-icon-orbit rw-tab-icon-orbit-2" }),
      h("span", { className: "rw-tab-icon-orbit rw-tab-icon-orbit-3" }),
      h("span", { className: "rw-tab-icon-core" }),
    ]);
  }

  function buildTabContent() {
    var n = unreadUpdatesCount();
    var nodes = [
      buildTabIcon(),
      h("span", { className: "rw-tab-label" }, "HQ"),
    ];
    if (n > 0) {
      nodes.push(h("span", { className: "rw-tab-count" }, n > 99 ? "99+" : String(n)));
    }
    return nodes;
  }

  function refreshTabLabel() {
    if (!tabEl) return;
    clearChildren(tabEl);
    buildTabContent().forEach(function (c) { tabEl.appendChild(c); });
  }
  function resolveInitialTheme(opt) {
    if (opt === "dark" || opt === "light") return opt;
    try {
      var stored = localStorage.getItem(themeStorageKey());
      if (stored === "dark" || stored === "light") return stored;
    } catch (_) {}
    if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
    return "light";
  }
  function applyTheme(next) {
    theme = next;
    if (stageEl) stageEl.setAttribute("data-theme", theme);
    if (widgetEl) {
      // widgetEl is the outer scrim; the inner .rw-shell also needs the
      // attribute because dark-mode shadows are scoped to it.
      widgetEl.setAttribute("data-theme", theme);
      var innerShell = widgetEl.querySelector ? widgetEl.querySelector(".rw-shell") : null;
      if (innerShell) innerShell.setAttribute("data-theme", theme);
    }
    if (modalMountEl) modalMountEl.setAttribute("data-theme", theme);
    if (themeToggleBtn) {
      clearChildren(themeToggleBtn);
      themeToggleBtn.appendChild(theme === "light" ? Icons.moon(15) : Icons.sun(15));
      themeToggleBtn.setAttribute("aria-label", theme === "light" ? "Switch to dark mode" : "Switch to light mode");
      themeToggleBtn.setAttribute("title", theme === "light" ? "Dark mode" : "Light mode");
    }
    try { localStorage.setItem(themeStorageKey(), theme); } catch (_) {}
  }
  function toggleTheme() { applyTheme(theme === "light" ? "dark" : "light"); }

  // ===========================================================================
  // Styles
  // ===========================================================================

  // Fonts are loaded into document.head, NOT the shadow root. @font-face
  // declarations are registered on the document and apply across all shadow
  // trees, so a single load benefits both the host page and the widget.
  function ensureFonts() {
    if (document.getElementById("rw-fonts")) return;
    var preconnect1 = document.createElement("link");
    preconnect1.rel = "preconnect"; preconnect1.href = "https://fonts.googleapis.com";
    var preconnect2 = document.createElement("link");
    preconnect2.rel = "preconnect"; preconnect2.href = "https://fonts.gstatic.com"; preconnect2.crossOrigin = "anonymous";
    var fontLink = document.createElement("link");
    fontLink.id = "rw-fonts";
    fontLink.rel = "stylesheet";
    fontLink.href = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&display=swap";
    document.head.appendChild(preconnect1);
    document.head.appendChild(preconnect2);
    document.head.appendChild(fontLink);
  }

  function injectStyles(position, target) {
    var isRight = position === "right";

    var css = [
      /* Direction A · Warm paper (default) */
      '.rw-stage[data-theme="light"], .rw-modal-mount[data-theme="light"] {',
      '  --rw-bg: #faf7f1; --rw-panel: #ffffff; --rw-panel-2: #f3efe6; --rw-panel-3: #ede7d9;',
      '  --rw-line: rgba(42,37,32,0.09); --rw-line-2: rgba(42,37,32,0.16);',
      '  --rw-fg: #2a2520; --rw-fg-2: #55504a; --rw-muted: #8a857d; --rw-muted-2: #b0aa9f;',
      '  --rw-accent: #6b8a6a; --rw-accent-ink: #ffffff;',
      '  --rw-serif: "Fraunces", Georgia, "Times New Roman", serif;',
      '}',
      /* Direction D · Warm charcoal dark */
      '.rw-stage[data-theme="dark"], .rw-modal-mount[data-theme="dark"] {',
      '  --rw-bg: #1c1f26; --rw-panel: #252932; --rw-panel-2: #21252d; --rw-panel-3: #2c313c;',
      '  --rw-line: rgba(255,255,255,0.07); --rw-line-2: rgba(255,255,255,0.14);',
      '  --rw-fg: #ecebe6; --rw-fg-2: #c0bdb5; --rw-muted: #8a877f; --rw-muted-2: #5e5d58;',
      '  --rw-accent: #9bb99a; --rw-accent-ink: #1c1f26;',
      '  --rw-serif: "Fraunces", Georgia, "Times New Roman", serif;',
      '}',

      '.rw-stage, .rw-modal-mount {',
      '  font-family: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;',
      '  font-feature-settings: "ss01", "cv11";',
      '  -webkit-font-smoothing: antialiased;',
      '  color: var(--rw-fg); font-size: 13px; line-height: 1.45;',
      '}',
      '.rw-stage *, .rw-stage *::before, .rw-stage *::after,',
      '.rw-modal-mount *, .rw-modal-mount *::before, .rw-modal-mount *::after { box-sizing: border-box; }',

      /* side opener */
      '.rw-tab {',
      '  position: fixed; top: 50%;',
      '  ' + (isRight ? "right" : "left") + ': 0;',
      '  transform: translateY(-50%);',
      '  width: 36px; height: 120px;',
      '  background: var(--rw-accent); color: var(--rw-accent-ink);',
      '  cursor: pointer;',
      '  display: flex; align-items: center; justify-content: center;',
      '  writing-mode: vertical-rl; text-orientation: mixed;',
      '  font: inherit; font-size: 11.5px; font-weight: 600; letter-spacing: 0.08em;',
      '  text-transform: uppercase; border: none;',
      '  border-radius: ' + (isRight ? "10px 0 0 10px" : "0 10px 10px 0") + ';',
      '  z-index: 2147483646;',
      '  transition: width .2s ease, box-shadow .2s ease, filter .15s ease;',
      '  box-shadow: 0 8px 24px -6px rgba(249,115,22,0.45), 0 1px 0 rgba(255,255,255,0.2) inset;',
      '  user-select: none; -webkit-user-select: none;',
      '}',
      '.rw-tab:hover { width: 42px; filter: brightness(1.06); }',
      /* Tab inner gap so icon / label / count don't crowd. The flex axis is
         vertical-rl in the default tab orientation and horizontal in the
         bottom-position variant; flex-gap respects the main axis in both. */
      '.rw-tab { gap: 6px; }',
      '.rw-tab-label { writing-mode: inherit; text-orientation: inherit; }',

      /* ------------------------------------------------------------------
         Animated tab mark — abstract entity in mathematical motion.
         Three orbital satellites at different radii / periods / directions
         + a pulsing core. Sized to fit beside the "HQ" label.
         The icon escapes the tab's vertical writing-mode so absolute
         positions inside it (top/left/right/bottom) read naturally. */
      '.rw-tab-icon {',
      '  position: relative;',
      '  width: 18px; height: 18px;',
      '  flex: 0 0 auto;',
      '  writing-mode: horizontal-tb; text-orientation: initial;',
      '  display: inline-block;',
      '  /* very subtle outer halo for depth */',
      '  filter: drop-shadow(0 0 2px color-mix(in oklab, currentColor 50%, transparent));',
      '}',

      '.rw-tab-icon-core {',
      '  position: absolute; top: 50%; left: 50%;',
      '  width: 4px; height: 4px;',
      '  margin: -2px 0 0 -2px;',
      '  border-radius: 50%;',
      '  background: currentColor;',
      '  box-shadow: 0 0 6px currentColor, 0 0 2px currentColor;',
      '  animation: rw-tab-core-pulse 1.6s cubic-bezier(0.4,0,0.6,1) infinite;',
      '}',

      /* Each orbit is an invisible square pinned to the icon box; rotating
         it sweeps the ::before satellite around the center on a circle. */
      '.rw-tab-icon-orbit {',
      '  position: absolute;',
      '  border-radius: 50%;',
      '  pointer-events: none;',
      '}',
      '.rw-tab-icon-orbit::before {',
      '  content: "";',
      '  position: absolute;',
      '  border-radius: 50%;',
      '  background: currentColor;',
      '}',
      /* Outer satellite: full-radius orbit, clockwise, brightest. */
      '.rw-tab-icon-orbit-1 {',
      '  inset: 0;',
      '  animation: rw-tab-orbit-cw 2.4s linear infinite;',
      '}',
      '.rw-tab-icon-orbit-1::before {',
      '  top: 0; left: 50%;',
      '  width: 3px; height: 3px;',
      '  margin: -1.5px 0 0 -1.5px;',
      '  box-shadow: 0 0 5px currentColor, 0 0 1.5px currentColor;',
      '}',
      /* Middle satellite: smaller radius, counter-clockwise, slower. */
      '.rw-tab-icon-orbit-2 {',
      '  inset: 4px;',
      '  animation: rw-tab-orbit-ccw 3.6s linear infinite;',
      '}',
      '.rw-tab-icon-orbit-2::before {',
      '  top: 50%; left: 100%;',
      '  width: 2px; height: 2px;',
      '  margin: -1px 0 0 -2px;',
      '  opacity: 0.85;',
      '  box-shadow: 0 0 3px currentColor;',
      '}',
      /* Inner satellite: tiny, longer period, off-axis starting position. */
      '.rw-tab-icon-orbit-3 {',
      '  inset: 2px;',
      '  animation: rw-tab-orbit-cw 4.7s linear infinite;',
      '  animation-delay: -1.6s;',
      '}',
      '.rw-tab-icon-orbit-3::before {',
      '  top: 82%; left: 18%;',
      '  width: 1.5px; height: 1.5px;',
      '  margin: -0.75px 0 0 -0.75px;',
      '  opacity: 0.65;',
      '  box-shadow: 0 0 2px currentColor;',
      '}',

      '@keyframes rw-tab-orbit-cw  { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }',
      '@keyframes rw-tab-orbit-ccw { from { transform: rotate(0deg); } to { transform: rotate(-360deg); } }',
      '@keyframes rw-tab-core-pulse {',
      '  0%, 100% { transform: scale(1);   opacity: 1; }',
      '  50%      { transform: scale(1.6); opacity: 0.55; }',
      '}',
      /* Respect reduced-motion: keep the structure visible, drop the spin. */
      '@media (prefers-reduced-motion: reduce) {',
      '  .rw-tab-icon-orbit-1, .rw-tab-icon-orbit-2, .rw-tab-icon-orbit-3, .rw-tab-icon-core { animation: none; }',
      '  .rw-tab-icon-core { transform: scale(1); opacity: 1; }',
      '}',

      '.rw-tab-count {',
      '  display: inline-flex; align-items: center; justify-content: center;',
      '  min-width: 18px; height: 18px; padding: 0 5px;',
      '  margin-inline-start: 8px;', /* logical: margin-top in vertical, margin-left in horizontal */
      '  vertical-align: middle;',
      '  border-radius: 999px;',
      '  background: var(--rw-accent-ink);',
      '  color: var(--rw-accent);',
      '  font-size: 11px; font-weight: 700;',
      '  font-variant-numeric: tabular-nums; letter-spacing: 0;',
      '  writing-mode: horizontal-tb; text-orientation: mixed;',
      '  box-shadow: 0 1px 2px rgba(0,0,0,0.18);',
      '  flex: 0 0 auto;',
      '}',
      /* Horizontal (bottom-position) tab: lay out as a flex row */
      '.rw-tab.rw-tab--horizontal {',
      '  display: inline-flex; align-items: center; justify-content: center;',
      '}',
      /* Open state hides the launcher; declared last so it wins over all variants */
      '.rw-tab.rw-open { display: none; }',

      /* widget shell — centered modal scrim. Pinned to the top of the stage; the
         launcher tab still sits at the screen edge as before. */
      '.rw-shell-scrim {',
      '  position: fixed; inset: 0;',
      '  display: flex; align-items: center; justify-content: center;',
      '  padding: 28px;',
      '  background: rgba(20,16,12,0.55);',
      '  -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);',
      '  z-index: 2147483645;',
      '  opacity: 0; pointer-events: none;',
      '  transition: opacity .18s ease;',
      '}',
      '.rw-shell-scrim.rw-open { opacity: 1; pointer-events: auto; }',
      '.rw-shell-scrim[data-theme="dark"] { background: rgba(6,5,4,0.66); }',
      '@media (max-width: 640px) { .rw-shell-scrim { padding: 0; } }',

      /* the centered card itself */
      '.rw-shell {',
      '  position: relative;',
      '  width: min(1080px, 100%);',
      '  height: min(680px, calc(100vh - 56px));',
      '  min-height: 540px;',
      '  display: flex; flex-direction: column;',
      '  transform: translateY(8px) scale(0.99);',
      '  transition: transform .22s cubic-bezier(0.16,1,0.3,1);',
      '}',
      '.rw-shell-scrim.rw-open .rw-shell { transform: none; }',
      '@media (max-width: 640px) {',
      '  .rw-shell { width: 100%; height: 100vh; min-height: 0; }',
      '}',

      '.rw-card-modal {',
      '  position: relative;',
      '  flex: 1 1 auto; min-height: 0;',
      '  display: flex; flex-direction: column;',
      '  background: var(--rw-bg);',
      '  border: 1px solid var(--rw-line-2);',
      '  border-radius: 16px;',
      '  overflow: hidden;',
      '  color: var(--rw-fg);',
      '  box-shadow:',
      '    0 1px 0 rgba(255,255,255,0.6) inset,',
      '    0 30px 80px -30px rgba(42,37,32,0.35),',
      '    0 8px 24px -16px rgba(42,37,32,0.20);',
      '}',
      '.rw-shell[data-theme="dark"] .rw-card-modal {',
      '  box-shadow:',
      '    0 1px 0 rgba(255,255,255,0.04) inset,',
      '    0 30px 80px -30px rgba(0,0,0,0.65),',
      '    0 8px 24px -16px rgba(0,0,0,0.5);',
      '}',
      '@media (max-width: 640px) { .rw-card-modal { border-radius: 0; border: none; } }',

      /* shell-level controls (close + theme), pinned top-right of the modal card */
      '.rw-shell-actions {',
      '  position: absolute; top: 12px; right: 12px;',
      '  display: inline-flex; align-items: center; gap: 4px;',
      '  z-index: 5;',
      '}',

      /* split (list view): asymmetric — composer left, tabs/list right */
      '.rw-split {',
      '  display: grid;',
      '  grid-template-columns: 0.85fr 1fr;',
      '  flex: 1 1 auto;',
      '  min-height: 0;',
      '}',
      '.rw-pane { display: flex; flex-direction: column; min-height: 0; min-width: 0; }',
      '.rw-pane-left {',
      '  padding: 26px 28px 22px;',
      '  background: var(--rw-panel);',
      '  background-image: radial-gradient(420px 320px at 70% 100%, color-mix(in oklab, var(--rw-accent) 6%, transparent), transparent 70%);',
      '  border-right: 1px solid var(--rw-line);',
      '}',
      '.rw-shell[data-theme="dark"] .rw-pane-left {',
      '  background-image: radial-gradient(420px 320px at 70% 100%, color-mix(in oklab, var(--rw-accent) 14%, transparent), transparent 70%);',
      '}',
      '.rw-pane-right { padding: 22px 4px 0; }',
      '@media (max-width: 880px) {',
      '  .rw-split { grid-template-columns: 1fr; }',
      '  .rw-pane-left { border-right: 0; border-bottom: 1px solid var(--rw-line); }',
      '}',

      /* eyebrow + headline + sub */
      '.rw-eyebrow {',
      '  display: inline-flex; align-items: center; gap: 8px;',
      '  font-size: 10.5px; letter-spacing: 0.22em; text-transform: uppercase;',
      '  color: var(--rw-muted); font-weight: 500; margin-bottom: 14px;',
      '}',
      '.rw-eyebrow-dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; background: var(--rw-accent); }',
      '.rw-prompt {',
      '  font-family: var(--rw-serif);',
      '  font-size: 28px; line-height: 1.12; letter-spacing: -0.018em; font-weight: 500;',
      '  color: var(--rw-fg); margin: 0 0 8px;',
      '}',
      '.rw-prompt em { font-style: italic; font-weight: 400; color: var(--rw-fg-2); }',
      '.rw-prompt-sub { margin: 0 0 18px; font-size: 13px; line-height: 1.45; color: var(--rw-muted); }',

      /* inline composer (left pane) */
      '.rw-inline-composer { display: flex; flex-direction: column; flex: 0 0 auto; min-height: 0; }',
      '.rw-inline-composer-ta {',
      '  width: 100%; border: 0; outline: none; resize: none; background: transparent;',
      '  color: var(--rw-fg);',
      '  font-family: var(--rw-serif); font-size: 19px; line-height: 1.5; letter-spacing: -0.005em;',
      '  padding: 4px 0; min-height: 120px;',
      '}',
      '.rw-inline-composer-ta::placeholder {',
      '  color: var(--rw-muted);',
      '  font-family: var(--rw-serif); font-style: italic; font-size: 18px; letter-spacing: -0.008em;',
      '}',
      '.rw-inline-composer-bar {',
      '  display: flex; align-items: center; justify-content: space-between; gap: 10px;',
      '  margin-top: 12px; padding-top: 12px;',
      '  border-top: 1px solid var(--rw-line);',
      '}',
      '.rw-inline-tools { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }',
      '.rw-inline-submit {',
      '  display: inline-flex; align-items: center; gap: 6px;',
      '  padding: 8px 18px; border: 1px solid var(--rw-accent);',
      '  background: var(--rw-accent); color: var(--rw-accent-ink);',
      '  border-radius: 999px;',
      '  font: inherit; font-size: 13px; font-weight: 500; letter-spacing: 0.005em;',
      '  cursor: pointer; white-space: nowrap; flex-shrink: 0;',
      '  transition: transform .12s ease, box-shadow .16s ease, opacity .12s ease, filter .12s ease;',
      '}',
      '.rw-inline-submit:not(:disabled):hover { transform: translateY(-1px); filter: brightness(1.04); box-shadow: 0 8px 18px -10px color-mix(in oklab, var(--rw-accent) 60%, transparent); }',
      '.rw-inline-submit:disabled { background: transparent; color: var(--rw-muted); border-color: var(--rw-line-2); cursor: not-allowed; opacity: 0.85; }',
      '.rw-inline-notice { margin-top: 10px; }',

      /* recent-tickets-submitted strip (left pane bottom) */
      '.rw-others {',
      '  display: flex; flex-direction: column;',
      '  flex: 1 1 auto; min-height: 0;',
      '  margin-top: 18px; padding-top: 14px;',
      '  border-top: 1px solid var(--rw-line);',
      '  transition: opacity 200ms ease;',
      '}',
      '.rw-pane-left:focus-within .rw-others { opacity: 0.32; }',
      '.rw-others-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }',
      '.rw-others-label {',
      '  font-size: 10.5px; font-weight: 600; letter-spacing: 0.12em;',
      '  text-transform: uppercase; color: var(--rw-muted);',
      '}',
      '.rw-others-count {',
      '  font-size: 10.5px; font-variant-numeric: tabular-nums;',
      '  color: var(--rw-muted-2); background: var(--rw-panel-2);',
      '  border: 1px solid var(--rw-line);',
      '  border-radius: 999px; padding: 1px 7px; line-height: 1.6;',
      '}',
      '.rw-others-list { flex: 1; min-height: 0; overflow-y: auto; margin: 0 -6px; padding: 0 6px; scrollbar-width: thin; }',
      '.rw-others-row {',
      '  display: grid; grid-template-columns: 8px 1fr auto;',
      '  align-items: center; gap: 10px; width: 100%;',
      '  text-align: left; background: transparent; border: 0;',
      '  border-radius: 8px; padding: 8px;',
      '  cursor: pointer; color: var(--rw-fg); font: inherit;',
      '  transition: background 100ms;',
      '}',
      '.rw-others-row + .rw-others-row {',
      '  border-top: 1px dashed var(--rw-line);',
      '  border-radius: 0; padding-top: 9px; margin-top: 1px;',
      '}',
      '.rw-others-row:hover { background: var(--rw-panel-2); border-top-color: transparent; }',
      '.rw-others-row:hover + .rw-others-row { border-top-color: transparent; }',
      '.rw-others-status { width: 7px; height: 7px; border-radius: 50%; background: var(--rw-muted); flex-shrink: 0; }',
      '.rw-others-title {',
      '  font-size: 13px; line-height: 1.35; color: var(--rw-fg);',
      '  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;',
      '  letter-spacing: -0.005em;',
      '}',
      '.rw-others-meta {',
      '  display: inline-flex; align-items: center; gap: 3px;',
      '  font-size: 11px; font-variant-numeric: tabular-nums; color: var(--rw-muted);',
      '}',

      /* dashboard tab row (right pane) — underline-active, no background pill */
      '.rw-dash-tabs {',
      '  display: flex; align-items: center; gap: 0;',
      '  padding: 0 22px 10px;',
      '  border-bottom: 1px solid var(--rw-line);',
      '}',
      '.rw-dash-tab {',
      '  position: relative; display: inline-flex; align-items: center; gap: 7px;',
      '  padding: 8px 14px 10px; margin-right: 4px;',
      '  background: transparent; border: 0; cursor: pointer;',
      '  font-family: inherit; font-size: 13.5px; font-weight: 500;',
      '  color: var(--rw-muted); letter-spacing: -0.005em;',
      '  transition: color .12s ease;',
      '}',
      '.rw-dash-tab:hover { color: var(--rw-fg-2); }',
      '.rw-dash-tab.rw-on { color: var(--rw-fg); }',
      '.rw-dash-tab.rw-on::after {',
      '  content: ""; position: absolute;',
      '  left: 14px; right: 14px; bottom: -11px; height: 2px;',
      '  background: var(--rw-accent); border-radius: 1px;',
      '}',
      '.rw-dash-tab-count {',
      '  font-size: 11px; font-feature-settings: "lnum","tnum";',
      '  color: var(--rw-muted); background: var(--rw-panel-2);',
      '  border-radius: 999px; min-width: 20px; padding: 1px 6px;',
      '  height: 18px; display: inline-flex; align-items: center; justify-content: center;',
      '}',
      '.rw-dash-tab.rw-on .rw-dash-tab-count {',
      '  background: color-mix(in oklab, var(--rw-accent) 14%, var(--rw-panel-2));',
      '  color: var(--rw-accent);',
      '}',

      /* dashboard list (right pane) */
      '.rw-dash-list {',
      '  flex: 1; min-height: 0; overflow-y: auto;',
      '  padding: 6px 18px 14px 22px;',
      '  display: flex; flex-direction: column; gap: 2px;',
      '}',
      '.rw-dash-list::-webkit-scrollbar { width: 6px; }',
      '.rw-dash-list::-webkit-scrollbar-thumb { background: var(--rw-line-2); border-radius: 999px; }',

      /* dashboard row (replaces .rw-card visually for the new layout) */
      '.rw-dash-row {',
      '  display: flex; align-items: flex-start; justify-content: space-between; gap: 14px;',
      '  width: 100%; text-align: left;',
      '  background: transparent; border: 0;',
      '  border-bottom: 1px solid var(--rw-line);',
      '  padding: 14px 4px;',
      '  cursor: pointer; font-family: inherit; color: var(--rw-fg);',
      '  transition: background 120ms;',
      '}',
      '.rw-dash-row:hover { background: color-mix(in oklab, var(--rw-accent) 5%, transparent); }',
      '.rw-dash-row:last-child { border-bottom: 0; }',
      '.rw-dash-row-main { flex: 1; min-width: 0; }',
      '.rw-dash-row-title {',
      '  font-size: 13.5px; font-weight: 500; line-height: 1.32;',
      '  color: var(--rw-fg); letter-spacing: -0.005em; margin-bottom: 3px;',
      '  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;',
      '}',
      '.rw-dash-row-body {',
      '  font-size: 12px; line-height: 1.45; color: var(--rw-fg-2);',
      '  margin-bottom: 7px;',
      '  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;',
      '}',
      '.rw-dash-row-meta {',
      '  display: flex; align-items: center; gap: 6px;',
      '  font-size: 11px; color: var(--rw-muted); flex-wrap: wrap;',
      '}',

      /* vote pill (right side of row) — replaces the old vertical .rw-vote */
      '.rw-dash-vote {',
      '  display: inline-flex; align-items: center; gap: 4px;',
      '  padding: 4px 9px 4px 7px;',
      '  background: var(--rw-panel-2); border: 1px solid var(--rw-line);',
      '  border-radius: 999px;',
      '  font-size: 11.5px; font-feature-settings: "lnum","tnum"; font-weight: 500;',
      '  color: var(--rw-fg-2); flex-shrink: 0; cursor: pointer; margin-top: 1px;',
      '  transition: background .12s ease, color .12s ease, border-color .12s ease;',
      '  font-family: inherit;',
      '}',
      '.rw-dash-vote:hover:not(:disabled) {',
      '  background: color-mix(in oklab, var(--rw-accent) 12%, var(--rw-panel));',
      '  color: var(--rw-accent);',
      '  border-color: color-mix(in oklab, var(--rw-accent) 35%, var(--rw-line));',
      '}',
      '.rw-dash-vote.rw-voted {',
      '  background: color-mix(in oklab, var(--rw-accent) 12%, transparent);',
      '  border-color: color-mix(in oklab, var(--rw-accent) 55%, transparent);',
      '  color: var(--rw-accent);',
      '}',
      '.rw-dash-vote:disabled { cursor: not-allowed; opacity: 0.55; }',

      /* full-width detail view (replaces split layout when a ticket is selected) */
      '.rw-detail-full {',
      '  flex: 1 1 auto; min-height: 0;',
      '  display: flex; flex-direction: column;',
      '  padding: 22px 4px 0;',
      '}',
      '.rw-detail-topbar {',
      '  display: flex; align-items: center; justify-content: space-between;',
      '  padding: 0 22px 10px;',
      '  border-bottom: 1px solid var(--rw-line);',
      '  flex: 0 0 auto;',
      '}',
      '.rw-back-btn {',
      '  display: inline-flex; align-items: center; gap: 6px;',
      '  padding: 6px 10px 6px 8px;',
      '  background: transparent; border: 1px solid var(--rw-line);',
      '  border-radius: 999px;',
      '  color: var(--rw-fg-2); font: inherit; font-size: 12px; cursor: pointer;',
      '  transition: background .12s, color .12s, border-color .12s;',
      '}',
      '.rw-back-btn:hover { background: var(--rw-panel-2); color: var(--rw-fg); border-color: var(--rw-line-2); }',

      /* dashboard footer */
      '.rw-dash-ftr {',
      '  flex: 0 0 auto;',
      '  display: flex; align-items: center; justify-content: center; gap: 6px;',
      '  padding: 8px 14px 12px;',
      '  font-size: 11px; color: var(--rw-muted);',
      '  border-top: 1px solid var(--rw-line);',
      '  background: transparent;',
      '}',
      '.rw-dash-ftr b { color: var(--rw-fg-2); font-weight: 600; letter-spacing: 0.01em; }',
      '.rw-dash-ftr-dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; background: var(--rw-accent); }',

      /* header */
      '.rw-hdr {',
      '  display: flex; align-items: center; justify-content: space-between;',
      '  padding: 16px 14px 12px 18px;',
      '  border-bottom: 1px solid var(--rw-line);',
      '  background: transparent;',
      '  flex: 0 0 auto;',
      '}',
      '.rw-hdr-title {',
      '  font-family: var(--rw-serif);',
      '  font-size: 18px; font-weight: 500; letter-spacing: -0.01em;',
      '  color: var(--rw-fg);',
      '}',
      '.rw-hdr-actions { display: inline-flex; align-items: center; gap: 2px; }',
      '.rw-icon-btn {',
      '  width: 28px; height: 28px;',
      '  display: inline-flex; align-items: center; justify-content: center;',
      '  border-radius: 8px; border: 1px solid transparent;',
      '  background: transparent; color: var(--rw-muted);',
      '  cursor: pointer; transition: all .15s ease;',
      '  font: inherit; padding: 0;',
      '}',
      '.rw-icon-btn:hover { background: rgba(255,255,255,0.04); color: var(--rw-fg); border-color: var(--rw-line); }',
      '.rw-widget[data-theme="light"] .rw-icon-btn:hover,',
      '.rw-modal-mount[data-theme="light"] .rw-icon-btn:hover { background: rgba(15,20,35,0.05); }',

      /* scroll */
      '.rw-scroll {',
      '  flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden;',
      '  padding: 14px 14px 6px;',
      '  display: flex; flex-direction: column; gap: 12px;',
      '}',
      '.rw-scroll::-webkit-scrollbar { width: 10px; }',
      '.rw-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.06); border-radius: 10px; border: 3px solid transparent; background-clip: padding-box; }',
      '.rw-widget[data-theme="light"] .rw-scroll::-webkit-scrollbar-thumb { background: rgba(15,20,35,0.15); background-clip: padding-box; }',

      /* tabs row */
      '.rw-tabs-bar { display: flex; align-items: center; gap: 8px; min-width: 0; }',
      '.rw-tabs {',
      '  display: inline-flex;',
      '  background: var(--rw-panel-2);',
      '  border: 1px solid var(--rw-line);',
      '  padding: 3px; border-radius: 10px; gap: 2px;',
      '  flex: 0 1 auto; min-width: 0; overflow: hidden;',
      '}',
      '.rw-tab-btn {',
      '  display: inline-flex; align-items: center; gap: 6px;',
      '  height: 26px; padding: 0 9px;',
      '  background: transparent; border: none; border-radius: 7px;',
      '  color: var(--rw-muted);',
      '  cursor: pointer;',
      '  font: inherit; font-size: 11.5px; font-weight: 500;',
      '  white-space: nowrap;',
      '  transition: color .15s ease, background .15s ease, box-shadow .15s ease;',
      '}',
      '.rw-tab-btn:hover { color: var(--rw-fg-2); }',
      '.rw-tab-btn.rw-on {',
      '  background: var(--rw-panel-3); color: var(--rw-fg);',
      '  box-shadow: 0 1px 0 rgba(255,255,255,0.05) inset, 0 1px 2px rgba(0,0,0,0.4);',
      '}',
      '.rw-widget[data-theme="light"] .rw-tab-btn.rw-on {',
      '  background: #ffffff;',
      '  box-shadow: 0 1px 0 rgba(255,255,255,1) inset, 0 1px 2px rgba(15,20,35,0.08), 0 0 0 1px rgba(15,20,35,0.06);',
      '}',
      '.rw-tab-badge {',
      '  min-width: 16px; height: 16px; padding: 0 4px;',
      '  border-radius: 999px; background: var(--rw-accent); color: var(--rw-accent-ink);',
      '  font-size: 10px; font-weight: 700;',
      '  display: inline-flex; align-items: center; justify-content: center;',
      '  font-variant-numeric: tabular-nums;',
      '}',

      /* new ticket button */
      '.rw-new-ticket-btn {',
      '  margin-left: auto; flex: 0 0 auto;',
      '  display: inline-flex; align-items: center; gap: 5px;',
      '  height: 30px; padding: 0 11px 0 9px;',
      '  border-radius: 9px; border: none;',
      '  background: var(--rw-accent); color: var(--rw-accent-ink);',
      '  font: inherit; font-size: 12px; font-weight: 600;',
      '  cursor: pointer; white-space: nowrap;',
      '  transition: filter .12s ease, transform .1s ease;',
      '  box-shadow: 0 1px 0 rgba(255,255,255,0.15) inset, 0 6px 14px -6px color-mix(in oklab, var(--rw-accent) 50%, transparent);',
      '}',
      '.rw-new-ticket-btn:hover { filter: brightness(1.06); }',
      '.rw-new-ticket-btn:active { transform: translateY(1px); }',

      /* list */
      '.rw-list { display: flex; flex-direction: column; gap: 6px; margin-top: 2px; }',

      /* card */
      '.rw-card {',
      '  display: flex; gap: 10px; padding: 12px;',
      '  background: var(--rw-panel-2);',
      '  border: 1px solid var(--rw-line);',
      '  border-radius: 10px;',
      '  transition: border-color .15s ease, transform .15s ease, background-color .15s ease, box-shadow .15s ease;',
      '  cursor: pointer; text-align: left;',
      '  font: inherit; color: inherit;',
      '}',
      '.rw-card:hover { border-color: var(--rw-line-2); background: var(--rw-panel-3); transform: translateY(-1px); }',
      '.rw-widget[data-theme="light"] .rw-card { background: #ffffff; box-shadow: 0 1px 2px rgba(15,20,35,0.04); }',
      '.rw-widget[data-theme="light"] .rw-card:hover { background: #ffffff; border-color: var(--rw-line-2); box-shadow: 0 2px 8px rgba(15,20,35,0.06); }',
      '.rw-card:focus-visible { outline: none; border-color: var(--rw-accent); box-shadow: 0 0 0 3px color-mix(in oklab, var(--rw-accent) 18%, transparent); }',
      '.rw-card-body { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 4px; }',
      '.rw-card-title { font-size: 13px; font-weight: 600; color: var(--rw-fg); line-height: 1.35; }',
      '.rw-card-sub {',
      '  font-size: 12px; color: var(--rw-fg-2); line-height: 1.45;',
      '  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;',
      '}',
      '.rw-card-meta {',
      '  display: flex; align-items: center; gap: 8px; margin-top: 4px;',
      '  font-size: 11.5px; color: var(--rw-muted); flex-wrap: wrap;',
      '}',
      '.rw-meta-author { color: var(--rw-fg-2); font-weight: 500; }',
      '.rw-meta-when { color: var(--rw-muted); }',
      '.rw-meta-dot { color: var(--rw-muted-2); }',

      /* vote */
      '.rw-vote {',
      '  flex: 0 0 auto; align-self: flex-start;',
      '  display: inline-flex; flex-direction: column; align-items: center; justify-content: center;',
      '  gap: 1px; width: 32px; padding: 6px 0;',
      '  background: var(--rw-panel);',
      '  border: 1px solid var(--rw-line);',
      '  border-radius: 8px; color: var(--rw-fg-2);',
      '  font: inherit; font-size: 11px; font-weight: 600;',
      '  cursor: pointer; transition: all .15s ease;',
      '  font-variant-numeric: tabular-nums;',
      '}',
      '.rw-vote:hover:not(:disabled) { background: var(--rw-panel-2); color: var(--rw-fg); border-color: var(--rw-line-2); }',
      '.rw-vote.rw-voted {',
      '  background: color-mix(in oklab, var(--rw-accent) 12%, transparent);',
      '  border-color: color-mix(in oklab, var(--rw-accent) 55%, transparent);',
      '  color: var(--rw-accent);',
      '}',
      '.rw-vote:disabled { cursor: not-allowed; opacity: 0.55; }',

      /* chip */
      '.rw-chip {',
      '  display: inline-flex; align-items: center; gap: 5px;',
      '  height: 18px; padding: 0 7px 0 6px;',
      '  border-radius: 999px; font-size: 10.5px; font-weight: 600;',
      '  letter-spacing: 0.01em; white-space: nowrap; flex: 0 0 auto;',
      '}',
      '.rw-chip-dot { width: 5px; height: 5px; border-radius: 50%; display: inline-block; }',

      /* empty / loading */
      '.rw-empty {',
      '  display: flex; flex-direction: column; align-items: center;',
      '  text-align: center; padding: 36px 16px; color: var(--rw-muted); gap: 4px;',
      '}',
      '.rw-empty-title { color: var(--rw-fg-2); font-weight: 600; font-size: 12.5px; }',
      '.rw-empty-sub { font-size: 11.5px; }',

      '.rw-loading { display: flex; align-items: center; justify-content: center; padding: 32px 16px; }',
      '@keyframes rw-spin { to { transform: rotate(360deg); } }',
      '.rw-spinner {',
      '  width: 22px; height: 22px;',
      '  border: 2px solid var(--rw-line);',
      '  border-top-color: var(--rw-accent);',
      '  border-radius: 50%; animation: rw-spin 0.7s linear infinite;',
      '}',

      '.rw-notice { padding: 10px 12px; border-radius: 8px; font-size: 12px; line-height: 1.4; }',
      '.rw-notice-error { background: rgba(220,38,38,0.1); color: #fca5a5; border: 1px solid rgba(220,38,38,0.25); }',
      '.rw-modal-mount[data-theme="light"] .rw-notice-error { color: #b91c1c; }',

      '.rw-login-prompt {',
      '  padding: 10px 12px; border-radius: 8px;',
      '  background: var(--rw-panel-2); border: 1px solid var(--rw-line);',
      '  text-align: center; font-size: 12px; color: var(--rw-muted);',
      '}',

      /* footer */
      '.rw-ftr {',
      '  display: flex; align-items: center; justify-content: flex-start;',
      '  padding: 9px 14px;',
      '  border-top: 1px solid var(--rw-line);',
      '  background: rgba(255,255,255,0.015);',
      '  font-size: 11px; color: var(--rw-muted);',
      '  flex: 0 0 auto;',
      '}',
      '.rw-ftr-mark { display: inline-flex; align-items: center; gap: 6px; }',
      '.rw-ftr-mark b { color: var(--rw-fg-2); font-weight: 600; letter-spacing: 0.01em; }',
      '.rw-ftr-dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; background: var(--rw-accent); box-shadow: 0 0 10px var(--rw-accent); }',
      '.rw-widget[data-theme="light"] .rw-ftr-dot { box-shadow: none; }',

      /* modal */
      '.rw-modal-scrim {',
      '  position: fixed; inset: 0;',
      '  background: rgba(4,6,11,0.68);',
      '  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);',
      '  display: flex; align-items: center; justify-content: center;',
      '  padding: 24px; z-index: 2147483647;',
      '  animation: rw-scrim-in .15s ease;',
      '}',
      '.rw-modal-mount[data-theme="light"] .rw-modal-scrim { background: rgba(15,20,34,0.58); }',
      '@keyframes rw-scrim-in { from { opacity: 0; } to { opacity: 1; } }',

      '.rw-modal {',
      '  width: min(560px, 100%);',
      '  display: flex; flex-direction: column; gap: 10px;',
      '  animation: rw-modal-in .2s cubic-bezier(0.16, 1, 0.3, 1);',
      '  color: var(--rw-fg);',
      '  max-height: calc(100vh - 48px);',
      '}',
      '.rw-modal--detail { width: min(720px, 100%); }',
      '@keyframes rw-modal-in {',
      '  from { opacity: 0; transform: translateY(6px) scale(0.99); }',
      '  to { opacity: 1; transform: none; }',
      '}',

      '.rw-modal-topbar { display: flex; align-items: center; justify-content: space-between; padding: 0 4px; }',
      '.rw-modal-kicker {',
      '  font-size: 10.5px; font-weight: 600;',
      '  letter-spacing: 0.12em; text-transform: uppercase;',
      '  color: rgba(255,255,255,0.78);',
      '}',
      '.rw-modal-mount .rw-modal-topbar .rw-icon-btn { color: rgba(255,255,255,0.7); }',
      '.rw-modal-mount .rw-modal-topbar .rw-icon-btn:hover { color: #fff; background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.16); }',

      '.rw-modal-card {',
      '  background: linear-gradient(180deg, #141a26 0%, #11161f 100%);',
      '  border: none;',
      '  border-radius: 14px; overflow: hidden;',
      '  box-shadow: 0 30px 80px -20px rgba(0,0,0,0.7), 0 10px 30px -10px rgba(0,0,0,0.5);',
      '  display: flex; flex-direction: column; min-height: 0;',
      '}',
      '.rw-modal-mount[data-theme="light"] .rw-modal-card {',
      '  background: linear-gradient(180deg, #ffffff 0%, #fafbfc 100%);',
      '  box-shadow: 0 30px 80px -20px rgba(15,20,35,0.25), 0 10px 30px -10px rgba(15,20,35,0.15);',
      '}',

      '.rw-modal-url {',
      '  display: flex; align-items: center; gap: 6px;',
      '  padding: 10px 14px 8px;',
      '  font-size: 11.5px; color: var(--rw-muted-2);',
      '  border: none;',
      '  white-space: nowrap; overflow: hidden;',
      '}',
      '.rw-modal-url-label { color: var(--rw-muted); font-weight: 500; flex: 0 0 auto; }',
      '.rw-modal-url-value {',
      '  color: var(--rw-muted-2);',
      '  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;',
      '  font-size: 11px; overflow: hidden; text-overflow: ellipsis; min-width: 0;',
      '}',

      '.rw-modal-ta {',
      '  width: 100%; display: block;',
      '  background: transparent; border: none; outline: none;',
      '  color: var(--rw-fg);',
      '  font: inherit; font-size: 13.5px; line-height: 1.55;',
      '  padding: 14px 14px 12px;',
      '  resize: none; min-height: 160px; max-height: 300px;',
      '}',
      '.rw-modal-ta::placeholder { color: var(--rw-muted); }',

      '.rw-modal-card-bar {',
      '  display: flex; align-items: center; justify-content: space-between;',
      '  padding: 8px 8px 8px 10px;',
      '  border: none;',
      '  background: transparent; gap: 10px;',
      '}',
      '.rw-modal-bar-l { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }',
      '.rw-modal-bar-r { display: inline-flex; align-items: center; gap: 8px; }',

      /* chips */
      '.rw-chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 14px 6px; }',
      '.rw-chip-attach {',
      '  display: inline-flex; align-items: center; gap: 5px;',
      '  padding: 3px 6px 3px 8px; border-radius: 6px;',
      '  background: rgba(255,255,255,0.04); border: 1px solid var(--rw-line-2);',
      '  font-size: 11px; color: var(--rw-fg-2);',
      '  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;',
      '  max-width: 100%;',
      '}',
      '.rw-chip-attach > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.rw-modal-mount[data-theme="light"] .rw-chip-attach { background: rgba(15,20,35,0.04); }',
      '.rw-chip-attach.rw-uploading { opacity: 0.75; }',
      '.rw-chip-attach.rw-failed { border-color: rgba(220,38,38,0.55); color: #fca5a5; }',
      '.rw-chip-mini-spinner {',
      '  width: 10px; height: 10px;',
      '  border: 1.5px solid var(--rw-line-2);',
      '  border-top-color: var(--rw-accent);',
      '  border-radius: 50%; animation: rw-spin 0.7s linear infinite;',
      '  display: inline-block;',
      '}',
      '.rw-chip-x {',
      '  width: 16px; height: 16px;',
      '  display: inline-flex; align-items: center; justify-content: center;',
      '  background: transparent; border: none;',
      '  color: var(--rw-muted); cursor: pointer;',
      '  font-size: 14px; line-height: 1; padding: 0; border-radius: 4px;',
      '}',
      '.rw-chip-x:hover { color: var(--rw-fg); background: rgba(255,255,255,0.06); }',

      /* pills + submit */
      '.rw-pill-btn {',
      '  height: 26px;',
      '  display: inline-flex; align-items: center; gap: 6px;',
      '  padding: 0 10px;',
      '  background: transparent; border: 1px solid var(--rw-line);',
      '  border-radius: 999px; color: var(--rw-fg-2);',
      '  cursor: pointer; font: inherit; font-size: 11.5px;',
      '  transition: all .15s ease;',
      '}',
      '.rw-pill-btn:hover:not(:disabled) { background: rgba(255,255,255,0.04); color: var(--rw-fg); border-color: var(--rw-line-2); }',
      '.rw-modal-mount[data-theme="light"] .rw-pill-btn:hover:not(:disabled) { background: rgba(15,20,35,0.04); }',
      '.rw-pill-btn.rw-on { color: var(--rw-fg); border-color: color-mix(in oklab, var(--rw-accent) 55%, transparent); background: color-mix(in oklab, var(--rw-accent) 12%, transparent); }',
      '.rw-pill-btn:disabled { cursor: not-allowed; opacity: 0.55; }',

      '.rw-submit-btn {',
      '  height: 28px;',
      '  display: inline-flex; align-items: center; gap: 6px;',
      '  padding: 0 12px;',
      '  border-radius: 999px;',
      '  border: 1px solid var(--rw-accent);',
      '  background: var(--rw-accent); color: var(--rw-accent-ink);',
      '  font: inherit; font-size: 12px; font-weight: 600;',
      '  cursor: pointer;',
      '  transition: transform .12s ease, filter .12s ease, opacity .12s ease;',
      '}',
      '.rw-submit-btn:hover:not(:disabled) { filter: brightness(1.06); }',
      '.rw-submit-btn:active:not(:disabled) { transform: translateY(1px); }',
      '.rw-submit-btn:disabled { cursor: not-allowed; opacity: 0.75; background: transparent; color: var(--rw-muted); border-color: var(--rw-line); }',
      '.rw-modal-mount[data-theme="light"] .rw-submit-btn:disabled { color: var(--rw-muted-2); }',

      /* detail modal head */
      '.rw-td-head { padding: 16px 18px 14px; border-bottom: 1px solid var(--rw-line); background: rgba(255,255,255,0.015); flex: 0 0 auto; }',
      '.rw-td-head-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 8px; }',
      '.rw-td-head-ref { display: inline-flex; align-items: center; gap: 8px; }',
      '.rw-td-ref { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 11px; color: var(--rw-muted); letter-spacing: 0.04em; }',
      '.rw-td-title { margin: 0 0 8px; font-family: var(--rw-serif); font-size: 18px; font-weight: 500; color: var(--rw-fg); line-height: 1.3; letter-spacing: -0.01em; }',
      '.rw-td-head-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 12px; color: var(--rw-muted); }',
      '.rw-td-meta-author { color: var(--rw-fg-2); font-weight: 500; }',

      '.rw-td-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 18px 18px 8px; }',
      '.rw-td-body::-webkit-scrollbar { width: 10px; }',
      '.rw-td-body::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.06); border-radius: 10px; border: 3px solid transparent; background-clip: padding-box; }',
      '.rw-modal-mount[data-theme="light"] .rw-td-body::-webkit-scrollbar-thumb { background: rgba(15,20,35,0.15); background-clip: padding-box; }',

      /* original post */
      '.rw-td-post { margin-bottom: 14px; }',
      '.rw-td-post-hdr { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }',
      '.rw-td-post-hdr-text { display: flex; flex-direction: column; line-height: 1.25; }',
      '.rw-td-post-author { font-size: 13px; font-weight: 600; color: var(--rw-fg); }',
      '.rw-td-post-when { font-size: 11px; color: var(--rw-muted); }',
      '.rw-td-post-body { color: var(--rw-fg-2); font-size: 13px; line-height: 1.6; white-space: pre-wrap; word-wrap: break-word; }',
      '.rw-td-post-body p { margin: 0 0 10px; }',
      '.rw-td-post-body p:last-child { margin-bottom: 0; }',

      /* thread */
      '.rw-td-thread { display: flex; flex-direction: column; gap: 14px; padding-top: 12px; border-top: 1px dashed var(--rw-line); margin-top: 6px; }',
      '.rw-td-thread-title { font-size: 10.5px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: var(--rw-muted); }',
      '.rw-td-comment { display: flex; gap: 10px; }',
      '.rw-td-comment-body { flex: 1 1 auto; min-width: 0; }',
      '.rw-td-comment-hdr { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; flex-wrap: wrap; }',
      '.rw-td-comment-author { font-size: 13px; font-weight: 600; color: var(--rw-fg); }',
      '.rw-td-comment-when { font-size: 11px; color: var(--rw-muted); margin-left: auto; }',
      '.rw-td-comment-text { color: var(--rw-fg-2); font-size: 13px; line-height: 1.55; white-space: pre-wrap; word-wrap: break-word; }',

      /* events */
      '.rw-event {',
      '  display: flex; align-items: center; gap: 8px;',
      '  padding: 2px 0 2px 4px;',
      '  font-size: 11.5px; color: var(--rw-muted);',
      '}',
      '.rw-event-dot { width: 6px; height: 6px; border-radius: 999px; background: var(--rw-line-2); flex: 0 0 auto; }',
      '.rw-event-text { flex: 1 1 auto; }',
      '.rw-event-text b { color: var(--rw-fg-2); font-weight: 600; }',
      '.rw-event-when { color: var(--rw-muted-2); font-size: 11px; flex: 0 0 auto; }',

      /* avatar */
      '.rw-avatar {',
      '  display: inline-flex; align-items: center; justify-content: center;',
      '  border-radius: 999px; font-weight: 600; letter-spacing: 0.01em;',
      '  flex: 0 0 auto; line-height: 1; user-select: none; overflow: hidden;',
      '}',
      '.rw-avatar img { width: 100%; height: 100%; object-fit: cover; }',

      /* attachment thumbs */
      '.rw-shots { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px; margin-top: 10px; }',
      '.rw-shots--tight { margin-top: 8px; }',
      '.rw-shot {',
      '  position: relative; display: block;',
      '  width: 100%; max-width: 280px;',
      '  border-radius: 8px; border: 1px solid var(--rw-line-2);',
      '  overflow: hidden; background: var(--rw-panel);',
      '  padding: 0; text-align: left; cursor: zoom-in;',
      '  font: inherit; color: inherit;',
      '  transition: transform .15s ease, border-color .15s ease;',
      '}',
      '.rw-shot:focus-visible { outline: 2px solid var(--rw-accent); outline-offset: 2px; }',
      '.rw-shot:hover { transform: translateY(-1px); border-color: color-mix(in oklab, var(--rw-accent) 45%, transparent); }',
      '.rw-shot-img { display: block; width: 100%; height: auto; }',
      '.rw-shot-name {',
      '  position: absolute; left: 8px; bottom: 8px;',
      '  display: inline-flex; align-items: center; gap: 5px;',
      '  padding: 3px 7px; border-radius: 5px;',
      '  background: rgba(8,10,15,0.72);',
      '  -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);',
      '  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;',
      '  font-size: 10.5px; color: rgba(255,255,255,0.78);',
      '  max-width: calc(100% - 16px);',
      '  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;',
      '}',

      /* image lightbox */
      '.rw-lightbox-scrim {',
      '  position: fixed; inset: 0; z-index: 2147483647;',
      '  background: rgba(4,6,11,0.88);',
      '  -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);',
      '  display: flex; align-items: center; justify-content: center;',
      '  padding: 32px; cursor: zoom-out;',
      '  animation: rw-scrim-in .15s ease;',
      '}',
      '.rw-lightbox-img {',
      '  display: block;',
      '  max-width: 100%; max-height: 100%;',
      '  object-fit: contain;',
      '  border-radius: 6px;',
      '  box-shadow: 0 24px 80px rgba(0,0,0,0.55);',
      '  cursor: default;',
      '  animation: rw-modal-in .2s cubic-bezier(0.16, 1, 0.3, 1);',
      '}',
      '.rw-lightbox-close {',
      '  position: absolute; top: 16px; right: 16px;',
      '  width: 36px; height: 36px;',
      '  display: inline-flex; align-items: center; justify-content: center;',
      '  border-radius: 999px; border: 1px solid rgba(255,255,255,0.14);',
      '  background: rgba(0,0,0,0.4); color: rgba(255,255,255,0.92);',
      '  cursor: pointer; padding: 0;',
      '  transition: background .15s ease, border-color .15s ease;',
      '}',
      '.rw-lightbox-close:hover { background: rgba(0,0,0,0.7); border-color: rgba(255,255,255,0.28); }',

      /* composer */
      '.rw-td-composer { border-top: 1px solid var(--rw-line); padding: 10px 12px; background: rgba(255,255,255,0.015); flex: 0 0 auto; }',
      '.rw-td-composer-row { display: flex; gap: 10px; align-items: flex-start; }',
      '.rw-td-composer-card {',
      '  flex: 1 1 auto; min-width: 0;',
      '  background: var(--rw-panel);',
      '  border: 1px solid var(--rw-line-2);',
      '  border-radius: 10px; overflow: hidden;',
      '}',
      '.rw-td-composer-ta {',
      '  width: 100%; display: block;',
      '  background: transparent; border: none; outline: none;',
      '  color: var(--rw-fg); font: inherit; font-size: 13px; line-height: 1.5;',
      '  padding: 10px 12px 4px; resize: none; min-height: 56px; max-height: 200px;',
      '}',
      '.rw-td-composer-ta::placeholder { color: var(--rw-muted); }',
      '.rw-td-composer-ta:disabled { opacity: 0.7; cursor: not-allowed; }',
      '.rw-td-composer-bar {',
      '  display: flex; align-items: center; justify-content: space-between;',
      '  padding: 6px 6px 6px 8px; border-top: 1px solid var(--rw-line); gap: 8px;',
      '}',
      '.rw-td-composer-bar-l { display: inline-flex; align-items: center; gap: 6px; min-width: 0; flex-wrap: wrap; }',
      '.rw-td-composer-hint { font-size: 10.5px; color: var(--rw-muted-2); letter-spacing: 0.01em; }',

      '.rw-stage button:focus-visible, .rw-stage textarea:focus-visible, .rw-stage input:focus-visible,',
      '.rw-modal-mount button:focus-visible, .rw-modal-mount textarea:focus-visible, .rw-modal-mount input:focus-visible { outline: none; }',
    ].join("\n");

    var style = document.createElement("style");
    style.id = "rw-styles";
    style.textContent = css;
    target.appendChild(style);
  }

  // ===========================================================================
  // Shadow DOM host
  //
  // The widget is mounted inside a shadow root so host-page CSS (Tailwind
  // focus rings, body { box-sizing }, generic input styles, etc.) cannot
  // bleed in. This is what production embeddable widgets do (Intercom, Drift,
  // Crisp, HubSpot) — anything less leaks visually the moment a host page
  // adds a generic `:focus-visible`, `*`, or `textarea` rule.
  // ===========================================================================

  function createShadowHost() {
    // <runhq-widget-host> is an unknown element so the host page's element
    // selectors don't accidentally target it. The host itself takes no space;
    // children inside the shadow root use position: fixed and own their layout.
    var host = document.createElement("runhq-widget-host");
    host.style.cssText = [
      "all: initial",
      "position: fixed",
      "top: 0",
      "left: 0",
      "width: 0",
      "height: 0",
      // Max int z-index on the host stacking context so the widget is reliably
      // above host content even if the host page uses high z-indexes.
      "z-index: 2147483647",
    ].join(";");
    var root = host.attachShadow({ mode: "open" });
    return { host: host, root: root };
  }

  // ===========================================================================
  // Time + identity helpers
  // ===========================================================================

  function timeAgo(dateStr) {
    if (!dateStr) return "";
    var diff = Date.now() - new Date(dateStr).getTime();
    if (diff < 0) return "just now";
    var secs = Math.floor(diff / 1000);
    if (secs < 45) return "just now";
    var mins = Math.floor(secs / 60);
    if (mins < 60) return mins + "m ago";
    var hours = Math.floor(mins / 60);
    if (hours < 24) return hours + "h ago";
    var days = Math.floor(hours / 24);
    if (days < 30) return days + "d ago";
    var months = Math.floor(days / 30);
    if (months < 12) return months + "mo ago";
    return Math.floor(months / 12) + "y ago";
  }

  function displayNameFromTicket(t) { return t.authorName || "Anonymous"; }
  function displayNameFromComment(c) { return c.authorName || "Anonymous"; }

  function avatarColor(name) {
    var hash = 0;
    for (var i = 0; i < (name || "").length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    var hue = hash % 360;
    return { bg: "oklch(0.38 0.08 " + hue + ")", fg: "oklch(0.85 0.12 " + hue + ")" };
  }
  function renderAvatar(name, size) {
    size = size || 28;
    var style = { width: size + "px", height: size + "px", fontSize: Math.round(size * 0.42) + "px" };
    var c = avatarColor(name || "");
    style.background = c.bg; style.color = c.fg;
    return h("span", { className: "rw-avatar", style: style }, (name || "?").slice(0, 1).toUpperCase());
  }

  // ===========================================================================
  // Generic render helpers
  // ===========================================================================

  function renderLoading() { return h("div", { className: "rw-loading" }, h("div", { className: "rw-spinner" })); }
  function renderEmpty(title, sub) {
    return h("div", { className: "rw-empty" }, [
      h("div", { className: "rw-empty-title" }, title || "No tickets yet"),
      sub ? h("div", { className: "rw-empty-sub" }, sub) : null,
    ]);
  }
  function renderNotice(type, msg) {
    return h("div", { className: "rw-notice rw-notice-" + type }, msg);
  }

  function openImageLightbox(url, name) {
    var img = h("img", { className: "rw-lightbox-img", src: url, alt: name || "" });
    img.addEventListener("mousedown", function (e) { e.stopPropagation(); });

    var closeBtn = h("button", {
      className: "rw-lightbox-close",
      type: "button",
      "aria-label": "Close image",
    }, Icons.close(18));

    var scrim = h("div", {
      className: "rw-lightbox-scrim",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": name || "Image preview",
    }, [img, closeBtn]);

    function close() {
      document.removeEventListener("keydown", onKey, true);
      if (scrim.parentNode) scrim.parentNode.removeChild(scrim);
    }
    var onKey = function (e) {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        e.preventDefault();
        close();
      }
    };

    closeBtn.addEventListener("click", function (e) { e.stopPropagation(); close(); });
    scrim.addEventListener("mousedown", function (e) {
      if (e.target === scrim) close();
    });

    document.addEventListener("keydown", onKey, true);
    modalMountEl.appendChild(scrim);
  }

  function renderShotThumb(att) {
    // Attachment shape from be/: { id, filename, originalName, mimeType, url, ... }
    var aspect = att.width && att.height ? (att.width + " / " + att.height) : "16 / 10";
    var name = att.originalName || att.filename || "image";
    var isImage = (att.mimeType || att.mime || "").indexOf("image/") === 0;
    var img = h("img", {
      className: "rw-shot-img",
      src: att.url,
      alt: name, loading: "lazy",
      style: { aspectRatio: aspect, objectFit: "cover" },
    });
    if (!isImage) {
      // Non-image — render a tile with filename only
      return h("a", {
        className: "rw-shot",
        href: att.url, target: "_blank", rel: "noopener noreferrer",
        title: name,
        style: { minHeight: "120px", display: "flex", alignItems: "center", justifyContent: "center", padding: "18px" },
      }, h("span", { className: "rw-shot-name", style: { position: "static", background: "transparent" } }, name));
    }
    var thumb = h("button", {
      className: "rw-shot",
      type: "button",
      title: name,
    }, [img, h("span", { className: "rw-shot-name" }, name)]);
    thumb.addEventListener("click", function () { openImageLightbox(att.url, name); });
    return thumb;
  }
  function renderShotGrid(attachments, tight) {
    if (!attachments || attachments.length === 0) return null;
    var grid = h("div", { className: "rw-shots" + (tight ? " rw-shots--tight" : "") });
    attachments.forEach(function (a) { grid.appendChild(renderShotThumb(a)); });
    return grid;
  }

  // ===========================================================================
  // Vote
  // ===========================================================================

  function handleVoteClick(ticket, voteBtn, countSpan, e) {
    e.preventDefault(); e.stopPropagation();
    if (!config.isIdentified) return;
    var wasVoted = ticket.userVote === true;
    var optimistic = (ticket.yesVotes || 0) + (wasVoted ? -1 : 1);
    countSpan.textContent = String(optimistic);
    voteBtn.classList.toggle("rw-voted", !wasVoted);
    voteBtn.disabled = true;
    var p = wasVoted ? retractVote(ticket.id) : castUpvote(ticket.id);
    p.then(function () {
      ticket.yesVotes = optimistic;
      ticket.userVote = wasVoted ? null : true;
    }).catch(function () {
      countSpan.textContent = String(ticket.yesVotes || 0);
      voteBtn.classList.toggle("rw-voted", wasVoted);
    }).then(function () { voteBtn.disabled = false; });
  }

  // ===========================================================================
  // Ticket card
  // ===========================================================================

  function renderTicketCard(ticket) {
    var voted = ticket.userVote === true;
    var countSpan = h("span", null, String(ticket.yesVotes || 0));
    var voteBtn = h("button", {
      className: "rw-dash-vote" + (voted ? " rw-voted" : ""),
      type: "button",
      "aria-label": "Upvote ticket",
      disabled: !config.isIdentified,
      title: config.isIdentified ? "Upvote" : "Sign in to vote",
    }, [Icons.arrowUp(11), countSpan]);
    voteBtn.addEventListener("click", function (e) {
      // Stop the row's click handler from also firing (which would open detail).
      e.stopPropagation();
      handleVoteClick(ticket, voteBtn, countSpan, e);
    });

    var authorName = displayNameFromTicket(ticket);
    var metaChildren = [renderStatusChip(ticket.status)];
    if (authorName) {
      metaChildren.push(h("span", { className: "rw-meta-dot" }, "·"));
      metaChildren.push(h("span", { className: "rw-meta-author" }, authorName));
    }
    metaChildren.push(h("span", { className: "rw-meta-dot" }, "·"));
    metaChildren.push(h("span", { className: "rw-meta-when" }, timeAgo(ticket.completedAt || ticket.createdAt)));

    var mainChildren = [h("div", { className: "rw-dash-row-title" }, ticket.title)];
    if (ticket.description) {
      mainChildren.push(h("div", { className: "rw-dash-row-body" }, ticket.description));
    }
    mainChildren.push(h("div", { className: "rw-dash-row-meta" }, metaChildren));

    var row = h("button", {
      className: "rw-dash-row", type: "button",
      "aria-label": "Open ticket: " + ticket.title,
    }, [
      h("div", { className: "rw-dash-row-main" }, mainChildren),
      voteBtn,
    ]);

    row.addEventListener("click", function () { openDetailModal(ticket); });
    return row;
  }

  function renderFooter() {
    return h("div", { className: "rw-ftr" }, [
      h("span", { className: "rw-ftr-mark" }, [
        h("span", { className: "rw-ftr-dot" }),
        h("span", null, [document.createTextNode("Powered by "), h("b", null, "RunHQ")]),
      ]),
    ]);
  }

  // ===========================================================================
  // Tabs + list
  // ===========================================================================

  function renderTabsBar() {
    // "top" was renamed "hot" in the dashboard design but the cache/API keys
    // stayed the same. activeTab values can be "hot" or legacy "top" — coerce
    // here so old persisted state still routes to the same list.
    var pendingTab = activeTab === "top" ? "hot" : activeTab;
    var counts = {
      updates: (updatesCache || []).length,
      hot:     (topTicketsCache || []).length,
      mine:    (myTicketsCache || []).length,
    };

    var defs = [
      { id: "updates", label: "Updates" },
      { id: "hot",     label: "Hot" },
      { id: "mine",    label: "My Tickets" },
    ];

    var tabButtons = defs.map(function (t) {
      var btn = h("button", {
        className: "rw-dash-tab" + (pendingTab === t.id ? " rw-on" : ""),
        type: "button",
        role: "tab",
        "aria-selected": pendingTab === t.id ? "true" : "false",
      }, [
        h("span", { className: "rw-dash-tab-label" }, t.label),
        h("span", { className: "rw-dash-tab-count" }, String(counts[t.id] || 0)),
      ]);
      btn.addEventListener("click", function () {
        if (pendingTab !== t.id) { activeTab = t.id; renderPanelBody(); }
      });
      return btn;
    });

    return h("div", { className: "rw-dash-tabs", role: "tablist" }, tabButtons);
  }

  function renderList() {
    // "top" stayed as the cache name even though the tab is now "Hot" — accept either.
    var tab = activeTab === "top" ? "hot" : activeTab;
    var items =
      tab === "updates" ? (updatesCache || []) :
      tab === "hot"     ? (topTicketsCache || []) :
                          (myTicketsCache || []);

    if (items.length === 0) {
      if (tab === "mine" && !config.isIdentified) {
        return renderEmpty("Sign in to see your tickets", "Your submissions appear here once you're identified.");
      }
      if (tab === "mine") {
        return renderEmpty("You haven't submitted any tickets yet", "Use the composer on the left to file one.");
      }
      if (tab === "updates") {
        return renderEmpty("Nothing shipped recently", "Updates will show up here as tickets are resolved.");
      }
      return renderEmpty("No tickets yet", "Be the first to share feedback.");
    }

    var list = h("div", { className: "rw-dash-list" });
    items.forEach(function (t) { list.appendChild(renderTicketCard(t)); });
    return list;
  }

  // -----------------------------------------------------------------------
  // Inline composer (left pane)
  //
  // Replaces the old "+ New ticket" button → modal flow. Always visible at the
  // top of the dashboard so writing feedback is one click rather than two.
  // Reuses the same createTicket + uploadTicketAttachment APIs and the same
  // staged-files semantics as the old modal composer (the file-staging pattern
  // — append before submit, upload after — is identical, only the chrome
  // changed).
  // -----------------------------------------------------------------------

  function renderInlineComposer() {
    var noticeSlot = h("div", { className: "rw-inline-notice" });
    var ta = h("textarea", {
      className: "rw-inline-composer-ta",
      placeholder: "Start typing…",
      maxlength: "5000",
      rows: "4",
    });

    var entries = []; // { file }
    var chipsEl = h("div", { className: "rw-chips", style: "padding: 0 0 6px 0; margin-top: 8px;" });
    chipsEl.style.display = "none";
    var fileInput = h("input", { type: "file", accept: "image/*", multiple: "true", style: "display:none" });

    function renderChips() {
      clearChildren(chipsEl);
      if (entries.length === 0) { chipsEl.style.display = "none"; return; }
      chipsEl.style.display = "flex";
      entries.forEach(function (entry) {
        var removeBtn = h("button", { className: "rw-chip-x", type: "button", "aria-label": "Remove attachment" }, "×");
        removeBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          var i = entries.indexOf(entry);
          if (i >= 0) entries.splice(i, 1);
          renderChips(); updateSubmitEnabled();
        });
        chipsEl.appendChild(h("span", { className: "rw-chip-attach", title: entry.file.name }, [
          Icons.image(11),
          h("span", null, entry.file.name || "Pasted image"),
          removeBtn,
        ]));
      });
    }
    function addFiles(files) {
      Array.prototype.forEach.call(files, function (file) {
        if (!file.type || file.type.indexOf("image/") !== 0) return;
        if (entries.length >= 5) return;
        entries.push({ file: file });
      });
      renderChips(); updateSubmitEnabled();
    }
    fileInput.addEventListener("change", function () { addFiles(fileInput.files); fileInput.value = ""; });
    ta.addEventListener("paste", function (e) {
      if (e.clipboardData && e.clipboardData.files && e.clipboardData.files.length > 0) {
        e.preventDefault(); addFiles(e.clipboardData.files);
      }
    });

    var submitBtn = h("button", { className: "rw-inline-submit", type: "button", disabled: true }, [
      h("span", null, "Submit"),
    ]);
    function updateSubmitEnabled() {
      submitBtn.disabled = !config.isIdentified || ta.value.trim().length === 0;
    }
    ta.addEventListener("input", updateSubmitEnabled);

    var isPrivate = false;
    var attachBtn = h("button", { className: "rw-pill-btn", type: "button", title: "Attach image" }, [
      Icons.paperclip(13), h("span", null, "Attach"),
    ]);
    attachBtn.addEventListener("click", function () { fileInput.click(); });
    var privateBtn = h("button", { className: "rw-pill-btn", type: "button", title: "Only visible to the team" }, [
      Icons.lock(12), h("span", null, "Private"),
    ]);
    privateBtn.addEventListener("click", function () {
      isPrivate = !isPrivate;
      privateBtn.classList.toggle("rw-on", isPrivate);
    });

    submitBtn.addEventListener("click", function () {
      if (!config.isIdentified) {
        clearChildren(noticeSlot);
        noticeSlot.appendChild(renderNotice("error", "You must be signed in to submit a ticket."));
        return;
      }
      var description = ta.value.trim();
      if (!description) return;
      submitBtn.disabled = true;
      submitBtn.firstChild.textContent = "Posting…";
      clearChildren(noticeSlot);

      createTicket({
        description: description,
        isPrivate: isPrivate,
        context: collectContext(),
      }).then(function (data) {
        var ticketId = data && data.ticket && data.ticket.id;
        if (!ticketId || entries.length === 0) return null;
        submitBtn.firstChild.textContent = "Uploading…";
        return Promise.all(entries.map(function (e) {
          return uploadTicketAttachment(ticketId, e.file).catch(function (err) {
            console.warn("Attachment failed:", err && err.message);
            return null;
          });
        }));
      }).then(function () {
        ta.value = "";
        entries.length = 0;
        renderChips();
        isPrivate = false;
        privateBtn.classList.remove("rw-on");
        submitBtn.firstChild.textContent = "Submit";
        topTicketsCache = null; updatesCache = null; myTicketsCache = null;
        // Refresh data + the panel body. The composer instance is replaced
        // along with the rest of the left pane on re-render, so we don't
        // need to reset state on the same DOM node.
        return refreshAll();
      }).catch(function (err) {
        submitBtn.disabled = false;
        submitBtn.firstChild.textContent = "Submit";
        clearChildren(noticeSlot);
        noticeSlot.appendChild(renderNotice("error", "Failed to submit: " + (err.message || "Unknown error")));
      });
    });

    return h("div", { className: "rw-inline-composer" }, [
      ta,
      chipsEl,
      h("div", { className: "rw-inline-composer-bar" }, [
        h("div", { className: "rw-inline-tools" }, [attachBtn, privateBtn]),
        submitBtn,
      ]),
      noticeSlot,
      fileInput,
    ]);
  }

  // -----------------------------------------------------------------------
  // Recent tickets submitted (left pane bottom)
  // -----------------------------------------------------------------------

  function renderOthersList() {
    var items = (topTicketsCache || []).slice(0, 5);
    var head = h("div", { className: "rw-others-head" }, [
      h("span", { className: "rw-others-label" }, "Recent tickets submitted"),
      h("span", { className: "rw-others-count" }, String(items.length)),
    ]);
    var list = h("div", { className: "rw-others-list" });
    if (items.length === 0) {
      list.appendChild(h("div", { className: "rw-empty-sub", style: { padding: "10px 0", fontSize: "11.5px" } }, "No tickets yet."));
    } else {
      items.forEach(function (t) {
        var row = h("button", {
          className: "rw-others-row", type: "button",
          "aria-label": "Open ticket: " + t.title,
        }, [
          h("span", { className: "rw-others-status", "data-status": t.status, style: { background: statusMeta(t.status).dot } }),
          h("span", { className: "rw-others-title" }, t.title),
          h("span", { className: "rw-others-meta" }, [Icons.arrowUp(9), String(t.yesVotes || 0)]),
        ]);
        row.addEventListener("click", function () { openDetailModal(t); });
        list.appendChild(row);
      });
    }
    return h("div", { className: "rw-others" }, [head, list]);
  }

  // -----------------------------------------------------------------------
  // Top-level body renderer — builds either the split (list) view or the
  // full-width detail view, depending on `view` state.
  // -----------------------------------------------------------------------

  function renderPanelBody() {
    if (!scrollEl) return;
    clearChildren(scrollEl);

    if (view === "detail" && currentDetailTicket) {
      var detailFull = h("div", { className: "rw-detail-full" });

      // Topbar with Back button + ticket ref. The reference id mirrors the
      // old detail-modal head: short uppercase prefix of the ticket id.
      var refId = String(currentDetailTicket.id || "").slice(0, 8).toUpperCase();
      var backBtn = h("button", { className: "rw-back-btn", type: "button" }, [
        Icons.arrowLeft(13),
        h("span", null, "Back to activity"),
      ]);
      backBtn.addEventListener("click", function () {
        view = "list";
        currentDetailTicket = null;
        renderPanelBody();
      });
      detailFull.appendChild(h("div", { className: "rw-detail-topbar" }, [
        backBtn,
        h("span", { className: "rw-td-ref" }, "#" + refId),
      ]));

      // Body uses the same renderDetailInto pipeline as the legacy modal,
      // just rendered inline. Loads detail data on demand.
      var card = h("div", { style: { flex: "1 1 auto", display: "flex", flexDirection: "column", minHeight: 0 } });
      detailFull.appendChild(card);
      scrollEl.appendChild(detailFull);

      // Initial loading frame uses the summary; replaced when fetch resolves.
      renderDetailInto(card, { ticket: currentDetailTicket, comments: [], activity: [], isOwner: false, isEditable: false }, true);
      var ticketAtFetch = currentDetailTicket;
      loadTicketDetail(ticketAtFetch.id).then(function (data) {
        // Bail if the user navigated back / picked a different ticket.
        if (view !== "detail" || currentDetailTicket !== ticketAtFetch) return;
        renderDetailInto(card, data, false);
      }).catch(function (err) {
        if (view !== "detail" || currentDetailTicket !== ticketAtFetch) return;
        clearChildren(card);
        card.appendChild(h("div", { style: { padding: "16px" } },
          renderNotice("error", "Could not load ticket: " + (err.message || "Unknown error"))));
      });
    } else {
      // Split layout: composer + others on the left, tabbed activity on the right.
      var split = h("div", { className: "rw-split" });

      var leftPane = h("div", { className: "rw-pane rw-pane-left" }, [
        h("div", { className: "rw-eyebrow" }, [
          h("span", { className: "rw-eyebrow-dot" }),
          h("span", null, ((config.projectName || "") + " Feedback").trim()),
        ]),
        h("h1", { className: "rw-prompt" }, [
          document.createTextNode("Help us improve "),
          h("em", null, config.projectName || "this product"),
        ]),
        h("p", { className: "rw-prompt-sub" },
          "Bugs, ideas, or small annoyances — drop them here. We read everything."),
        renderInlineComposer(),
        renderOthersList(),
      ]);

      var rightPane = h("div", { className: "rw-pane rw-pane-right" }, [
        renderTabsBar(),
        renderList(),
      ]);

      split.appendChild(leftPane);
      split.appendChild(rightPane);
      scrollEl.appendChild(split);
    }
  }

  // ===========================================================================
  // Refresh
  // ===========================================================================

  function refreshAll() {
    clearChildren(scrollEl);
    scrollEl.appendChild(renderLoading());

    var topP = loadTopTickets().then(function (data) {
      topTicketsCache = data.tickets || [];
      if (data.projectName) {
        config.projectName = data.projectName;
        if (headerTitleEl) headerTitleEl.textContent = config.projectName + " Feedback";
      }
      config.isIdentified = !!data.isIdentified;
    });
    var updP = loadUpdates().then(function (data) {
      updatesCache = data.tickets || [];
    }).catch(function () { updatesCache = []; });
    var mineP = config.token
      ? loadMyTickets().then(function (d) { myTicketsCache = d.tickets || []; }).catch(function () { myTicketsCache = []; })
      : Promise.resolve().then(function () { myTicketsCache = []; });

    return Promise.all([topP, updP, mineP]).then(function () {
      renderPanelBody();
      refreshTabLabel();
    }).catch(function (err) {
      clearChildren(scrollEl);
      scrollEl.appendChild(renderNotice("error", "Could not load tickets: " + err.message));
    });
  }

  // ===========================================================================
  // Modal infra
  // ===========================================================================

  function closeActiveModal() {
    if (!activeModal) return;
    activeModal.close();
    activeModal = null;
  }
  function mountModal(modalEl) {
    closeActiveModal();
    var scrim = h("div", { className: "rw-modal-scrim", role: "dialog", "aria-modal": "true" });
    scrim.appendChild(modalEl);
    scrim.addEventListener("mousedown", function (e) {
      if (e.target === scrim) closeActiveModal();
    });
    modalMountEl.appendChild(scrim);
    var onKey = function (e) { if (e.key === "Escape") closeActiveModal(); };
    document.addEventListener("keydown", onKey);
    activeModal = {
      el: scrim,
      close: function () {
        document.removeEventListener("keydown", onKey);
        if (scrim.parentNode) scrim.parentNode.removeChild(scrim);
      },
    };
    return activeModal;
  }

  // ===========================================================================
  // New-ticket modal — stages files locally, uploads after ticket is created
  // ===========================================================================

  function openNewTicketModal() {
    var currentUrl = typeof window !== "undefined" ? window.location.href : "";
    var noticeSlot = h("div", null);

    var ta = h("textarea", {
      className: "rw-modal-ta",
      placeholder: "Write feedback, a proposal, or a bug report…",
      maxlength: "5000",
    });

    var entries = []; // { file, state: 'staged' }
    var chipsEl = h("div", { className: "rw-chips" });
    chipsEl.style.display = "none";
    var fileInput = h("input", { type: "file", accept: "image/*", multiple: "true", style: "display:none" });

    function renderChips() {
      clearChildren(chipsEl);
      if (entries.length === 0) { chipsEl.style.display = "none"; return; }
      chipsEl.style.display = "flex";
      entries.forEach(function (entry) {
        var removeBtn = h("button", { className: "rw-chip-x", type: "button", "aria-label": "Remove attachment" }, "×");
        removeBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          var i = entries.indexOf(entry);
          if (i >= 0) entries.splice(i, 1);
          renderChips(); updateSubmitEnabled();
        });
        chipsEl.appendChild(h("span", { className: "rw-chip-attach", title: entry.file.name }, [
          Icons.image(11),
          h("span", null, entry.file.name || "Pasted image"),
          removeBtn,
        ]));
      });
    }
    function addFiles(files) {
      Array.prototype.forEach.call(files, function (file) {
        if (!file.type || file.type.indexOf("image/") !== 0) return;
        if (entries.length >= 5) return;
        entries.push({ file: file, state: "staged" });
      });
      renderChips();
      updateSubmitEnabled();
    }
    fileInput.addEventListener("change", function () { addFiles(fileInput.files); fileInput.value = ""; });
    ta.addEventListener("paste", function (e) {
      if (e.clipboardData && e.clipboardData.files && e.clipboardData.files.length > 0) {
        e.preventDefault(); addFiles(e.clipboardData.files);
      }
    });

    var submitBtn = h("button", { className: "rw-submit-btn", type: "button", disabled: true }, [
      h("span", null, "Submit"), Icons.send(12),
    ]);
    function updateSubmitEnabled() {
      submitBtn.disabled = !config.isIdentified || ta.value.trim().length === 0;
    }
    ta.addEventListener("input", function () {
      ta.style.height = "auto";
      ta.style.height = Math.min(300, Math.max(160, ta.scrollHeight)) + "px";
      updateSubmitEnabled();
    });

    var isPrivate = false;
    var attachBtn = h("button", { className: "rw-pill-btn", type: "button", title: "Attach image" }, [
      Icons.paperclip(14), h("span", null, "Attach"),
    ]);
    attachBtn.addEventListener("click", function () { fileInput.click(); });
    var privateBtn = h("button", { className: "rw-pill-btn", type: "button", title: "Only visible to the team" }, [
      Icons.lock(12), h("span", null, "Private"),
    ]);
    privateBtn.addEventListener("click", function () {
      isPrivate = !isPrivate;
      privateBtn.classList.toggle("rw-on", isPrivate);
    });

    submitBtn.addEventListener("click", function () {
      if (!config.isIdentified) {
        clearChildren(noticeSlot);
        noticeSlot.appendChild(renderNotice("error", "You must be signed in to submit a ticket."));
        return;
      }
      var description = ta.value.trim();
      if (!description) return;
      submitBtn.disabled = true;
      submitBtn.firstChild.textContent = "Posting…";
      clearChildren(noticeSlot);

      createTicket({
        description: description,
        isPrivate: isPrivate,
        context: collectContext(),
      }).then(function (data) {
        var ticketId = data && data.ticket && data.ticket.id;
        if (!ticketId || entries.length === 0) return null;
        submitBtn.firstChild.textContent = "Uploading…";
        return Promise.all(entries.map(function (e) {
          return uploadTicketAttachment(ticketId, e.file).catch(function (err) {
            console.warn("Attachment failed:", err && err.message);
            return null;
          });
        }));
      }).then(function () {
        topTicketsCache = null; updatesCache = null; myTicketsCache = null;
        closeActiveModal();
        return refreshAll();
      }).catch(function (err) {
        submitBtn.disabled = false;
        submitBtn.firstChild.textContent = "Submit";
        clearChildren(noticeSlot);
        noticeSlot.appendChild(renderNotice("error", "Failed to submit: " + (err.message || "Unknown error")));
      });
    });

    var card = h("div", { className: "rw-modal-card" }, [
      h("div", { className: "rw-modal-url", title: currentUrl }, [
        h("span", { className: "rw-modal-url-label" }, "Current URL:"),
        h("span", { className: "rw-modal-url-value" }, currentUrl),
      ]),
      ta,
      chipsEl,
      h("div", { className: "rw-modal-card-bar" }, [
        h("div", { className: "rw-modal-bar-l" }, [attachBtn, privateBtn]),
        h("div", { className: "rw-modal-bar-r" }, [submitBtn]),
      ]),
    ]);

    var closeBtn = h("button", { className: "rw-icon-btn", type: "button", "aria-label": "Close" }, Icons.close(16));
    closeBtn.addEventListener("click", closeActiveModal);

    var modal = h("div", { className: "rw-modal" }, [
      h("div", { className: "rw-modal-topbar" }, [
        h("span", { className: "rw-modal-kicker" }, "New ticket"),
        closeBtn,
      ]),
      noticeSlot,
      card,
      fileInput,
    ]);

    mountModal(modal);
    setTimeout(function () { try { ta.focus(); } catch (_) {} }, 30);
  }

  function collectContext() {
    return {
      url: window.location.href,
      referrer: document.referrer,
      userAgent: navigator.userAgent,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      screenSize: { width: screen.width, height: screen.height },
      consoleLogs: consoleLogs.slice(),
      errors: capturedErrors.slice(),
      timestamp: new Date().toISOString(),
      locale: navigator.language,
    };
  }

  // ===========================================================================
  // Detail modal
  // ===========================================================================

  // Switches the dashboard to the inline detail view (full-width). Replaces
  // the old modal-on-modal pattern — instead of stacking a second modal on
  // top, we swap the same card body. The "Back to activity" button (rendered
  // in renderPanelBody when view === "detail") returns to the split layout.
  function openDetailModal(ticketSummary) {
    view = "detail";
    currentDetailTicket = ticketSummary;
    renderPanelBody();
    if (scrollEl) scrollEl.scrollTop = 0;
  }

  function renderDetailInto(card, data, loading) {
    clearChildren(card);

    var ticket = data.ticket;
    var comments = data.comments || [];
    var activity = data.activity || [];

    // head
    var voted = ticket.userVote === true;
    var countSpan = h("span", null, String(ticket.yesVotes || 0));
    var voteBtn = h("button", {
      className: "rw-vote" + (voted ? " rw-voted" : ""),
      type: "button",
      "aria-label": "Upvote ticket",
      disabled: !config.isIdentified,
    }, [Icons.arrowUp(12), countSpan]);
    voteBtn.addEventListener("click", function (e) { handleVoteClick(ticket, voteBtn, countSpan, e); });

    var refId = String(ticket.id || "").slice(0, 8).toUpperCase();
    var head = h("div", { className: "rw-td-head" }, [
      h("div", { className: "rw-td-head-top" }, [
        h("div", { className: "rw-td-head-ref" }, [
          h("span", { className: "rw-td-ref" }, "#" + refId),
          renderStatusChip(ticket.status),
        ]),
        voteBtn,
      ]),
      h("h2", { className: "rw-td-title" }, ticket.title),
      renderHeadMeta(ticket),
    ]);
    card.appendChild(head);

    // body
    var body = h("div", { className: "rw-td-body" });

    var authorName = displayNameFromTicket(ticket);
    var postChildren = [
      h("div", { className: "rw-td-post-hdr" }, [
        renderAvatar(authorName, 28),
        h("div", { className: "rw-td-post-hdr-text" }, [
          h("div", { className: "rw-td-post-author" }, authorName),
          h("div", { className: "rw-td-post-when" }, timeAgo(ticket.createdAt) + " · Original report"),
        ]),
      ]),
    ];
    if (ticket.description) {
      var postBody = h("div", { className: "rw-td-post-body" });
      ticket.description.split(/\n\n+/).forEach(function (para) { postBody.appendChild(h("p", null, para)); });
      postChildren.push(postBody);
    }
    var ticketShots = renderShotGrid(ticket.attachments);
    if (ticketShots) postChildren.push(ticketShots);
    body.appendChild(h("div", { className: "rw-td-post" }, postChildren));

    // thread
    var thread = h("div", { className: "rw-td-thread" });
    if (loading) {
      thread.appendChild(renderLoading());
    } else {
      var merged = mergeThread(comments, activity);
      thread.appendChild(h("div", { className: "rw-td-thread-title" },
        comments.length > 0 ? ("Activity · " + comments.length + " " + (comments.length === 1 ? "comment" : "comments")) : "Activity"));
      if (merged.length === 0) {
        thread.appendChild(h("div", { className: "rw-empty-sub", style: { padding: "4px 0" } }, "No activity yet."));
      } else {
        merged.forEach(function (node) {
          if (node.kind === "event") thread.appendChild(renderEventNode(node.event));
          else thread.appendChild(renderCommentNode(node.comment));
        });
      }
    }
    body.appendChild(thread);
    card.appendChild(body);

    // composer
    card.appendChild(renderComposer(ticket, function (newComment) {
      comments.push(newComment);
      renderDetailInto(card, { ticket: ticket, comments: comments, activity: activity, isOwner: data.isOwner, isEditable: data.isEditable }, false);
    }));
  }

  function renderHeadMeta(ticket) {
    var authorName = displayNameFromTicket(ticket);
    var metaChildren = [];
    if (authorName) {
      metaChildren.push(renderAvatar(authorName, 20));
      metaChildren.push(h("span", { className: "rw-td-meta-author" }, authorName));
      metaChildren.push(h("span", { className: "rw-meta-dot" }, "·"));
    }
    metaChildren.push(h("span", null, timeAgo(ticket.createdAt)));
    if (ticket.completedAt && ticket.status === "done") {
      metaChildren.push(h("span", { className: "rw-meta-dot" }, "·"));
      metaChildren.push(h("span", null, "shipped " + timeAgo(ticket.completedAt)));
    }
    return h("div", { className: "rw-td-head-meta" }, metaChildren);
  }

  function mergeThread(comments, activity) {
    var nodes = [];
    for (var i = 0; i < comments.length; i++) {
      nodes.push({ kind: "comment", comment: comments[i], at: new Date(comments[i].createdAt).getTime() });
    }
    for (var j = 0; j < activity.length; j++) {
      // Skip event types that duplicate things we render elsewhere
      var e = activity[j];
      if (e.type === "comment_added" || e.type === "comment_edited" || e.type === "comment_deleted") continue;
      if (e.type === "attachment_added") continue;
      nodes.push({ kind: "event", event: e, at: new Date(e.createdAt).getTime() });
    }
    nodes.sort(function (a, b) { return a.at - b.at; });
    return nodes;
  }

  function describeEvent(e) {
    var m = e.metadata || {};
    if (e.type === "status_change") {
      var fromLabel = m.from ? statusLabel(m.from) : null;
      var toLabel = m.to ? statusLabel(m.to) : null;
      if (fromLabel && toLabel) return "status change [" + fromLabel + "] → [" + toLabel + "]";
      if (toLabel) return "status change → [" + toLabel + "]";
      return "changed status";
    }
    if (e.type === "moderation_changed") {
      return "changed moderation to " + (m.to || "unknown");
    }
    if (e.type === "assigned")       return "assigned the ticket" + (m.assignee ? " to " + m.assignee : "");
    if (e.type === "unassigned")     return "unassigned the ticket";
    if (e.type === "ticket_created") return "opened the ticket";
    if (e.type === "ticket_edited")  return "edited the ticket";
    if (e.type === "ticket_deleted") return "deleted the ticket";
    return e.content || e.type;
  }

  function renderEventNode(e) {
    var actorName = e.createdByName || "Team";
    return h("div", { className: "rw-event" }, [
      h("span", { className: "rw-event-dot" }),
      h("span", { className: "rw-event-text" }, [
        h("b", null, actorName),
        document.createTextNode(" " + describeEvent(e)),
      ]),
      h("span", { className: "rw-event-when" }, timeAgo(e.createdAt)),
    ]);
  }

  function renderCommentNode(c) {
    var authorName = displayNameFromComment(c);
    var bodyChildren = [
      h("div", { className: "rw-td-comment-hdr" }, [
        h("span", { className: "rw-td-comment-author" }, authorName),
        h("span", { className: "rw-td-comment-when" }, timeAgo(c.createdAt)),
      ]),
      h("div", { className: "rw-td-comment-text" }, c.body || ""),
    ];
    var shots = renderShotGrid(c.attachments, /* tight */ true);
    if (shots) bodyChildren.push(shots);
    var bodyEl = h("div", { className: "rw-td-comment-body" }, bodyChildren);
    return h("article", { className: "rw-td-comment" }, [renderAvatar(authorName, 28), bodyEl]);
  }

  function renderComposer(ticket, onPosted) {
    var noticeSlot = h("div", null);
    var entries = [];
    var chipsEl = h("div", { className: "rw-chips" });
    chipsEl.style.display = "none";
    var fileInput = h("input", { type: "file", accept: "image/*", multiple: "true", style: "display:none" });

    var disabled = !config.isIdentified || !!ticket.commentsDisabled;
    var placeholder = !config.isIdentified ? "Sign in to reply"
                    : ticket.commentsDisabled ? "Comments are disabled"
                    : "Write a comment…  (⌘V to paste a screenshot)";

    var ta = h("textarea", { className: "rw-td-composer-ta", placeholder: placeholder, disabled: disabled });

    var submitBtn = h("button", { className: "rw-submit-btn", type: "button", disabled: true }, [
      h("span", null, "Comment"), Icons.send(12),
    ]);
    var attachBtn = h("button", { className: "rw-pill-btn", type: "button", disabled: disabled }, [
      Icons.paperclip(14), h("span", null, "Attach"),
    ]);
    attachBtn.addEventListener("click", function () { fileInput.click(); });

    function updateSubmitEnabled() {
      if (disabled) { submitBtn.disabled = true; return; }
      var hasText = ta.value.trim().length > 0;
      var hasStaged = entries.length > 0;
      submitBtn.disabled = !hasText && !hasStaged;
    }
    function renderChips() {
      clearChildren(chipsEl);
      if (entries.length === 0) { chipsEl.style.display = "none"; return; }
      chipsEl.style.display = "flex";
      entries.forEach(function (entry) {
        var removeBtn = h("button", { className: "rw-chip-x", type: "button", "aria-label": "Remove" }, "×");
        removeBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          var i = entries.indexOf(entry);
          if (i >= 0) entries.splice(i, 1);
          renderChips(); updateSubmitEnabled();
        });
        chipsEl.appendChild(h("span", { className: "rw-chip-attach", title: entry.file.name }, [
          Icons.image(11),
          h("span", null, entry.file.name || "Pasted image"),
          removeBtn,
        ]));
      });
    }
    function addFiles(files) {
      Array.prototype.forEach.call(files, function (file) {
        if (!file.type || file.type.indexOf("image/") !== 0) return;
        if (entries.length >= 5) return;
        entries.push({ file: file });
      });
      renderChips(); updateSubmitEnabled();
    }
    fileInput.addEventListener("change", function () { addFiles(fileInput.files); fileInput.value = ""; });
    ta.addEventListener("paste", function (e) {
      if (e.clipboardData && e.clipboardData.files && e.clipboardData.files.length > 0) {
        e.preventDefault(); addFiles(e.clipboardData.files);
      }
    });
    ta.addEventListener("input", function () {
      ta.style.height = "auto";
      ta.style.height = Math.min(200, Math.max(56, ta.scrollHeight)) + "px";
      updateSubmitEnabled();
    });

    submitBtn.addEventListener("click", function () {
      if (disabled) return;
      var text = ta.value.trim();
      if (!text && entries.length === 0) return;
      submitBtn.disabled = true;
      submitBtn.firstChild.textContent = "Posting…";
      clearChildren(noticeSlot);
      postComment(ticket.id, text || "").then(function (data) {
        var newComment = data && data.comment;
        if (!newComment) throw new Error("Malformed response");
        if (entries.length === 0) return newComment;
        submitBtn.firstChild.textContent = "Uploading…";
        return Promise.all(entries.map(function (e) {
          return uploadCommentAttachment(ticket.id, newComment.id, e.file)
            .then(function (r) { return r && r.attachment; })
            .catch(function (err) { console.warn("Comment attach failed:", err && err.message); return null; });
        })).then(function (attachments) {
          var real = attachments.filter(function (a) { return !!a; });
          newComment.attachments = (newComment.attachments || []).concat(real);
          return newComment;
        });
      }).then(function (newComment) {
        ta.value = "";
        ta.style.height = "auto";
        entries.length = 0;
        renderChips();
        submitBtn.firstChild.textContent = "Comment";
        updateSubmitEnabled();
        if (onPosted) onPosted(newComment);
      }).catch(function (err) {
        submitBtn.firstChild.textContent = "Comment";
        updateSubmitEnabled();
        noticeSlot.appendChild(renderNotice("error", "Failed to post: " + (err.message || "Unknown error")));
      });
    });

    var composerCard = h("div", { className: "rw-td-composer-card" }, [
      ta,
      chipsEl,
      h("div", { className: "rw-td-composer-bar" }, [
        h("div", { className: "rw-td-composer-bar-l" }, [
          attachBtn,
          h("span", { className: "rw-td-composer-hint" }, "Paste screenshots with ⌘V"),
        ]),
        submitBtn,
      ]),
    ]);

    var composer = h("div", { className: "rw-td-composer" });
    if (!config.isIdentified) {
      composer.appendChild(h("div", { className: "rw-login-prompt", style: { marginBottom: "8px" } }, "Sign in to post a comment."));
    } else if (ticket.commentsDisabled) {
      composer.appendChild(h("div", { className: "rw-login-prompt", style: { marginBottom: "8px" } }, "Comments are disabled on this ticket."));
    }
    composer.appendChild(noticeSlot);
    composer.appendChild(h("div", { className: "rw-td-composer-row" }, [
      renderAvatar("You", 26),
      composerCard,
      fileInput,
    ]));
    return composer;
  }

  // ===========================================================================
  // Panel open/close
  // ===========================================================================

  function openPanel() {
    if (isOpen) return;
    isOpen = true;
    widgetEl.classList.add("rw-open");
    tabEl.classList.add("rw-open");
    markPanelOpened();
    refreshAll();
  }
  function closePanel() {
    if (!isOpen) return;
    isOpen = false;
    widgetEl.classList.remove("rw-open");
    tabEl.classList.remove("rw-open");
    closeActiveModal();
    // Reset the detail-view state so re-opening the dashboard lands back on
    // the split (list) view rather than the last ticket the user was reading.
    view = "list";
    currentDetailTicket = null;
  }

  // ===========================================================================
  // Mount DOM
  // ===========================================================================

  function mountDOM() {
    var isRight = config.position === "right";

    var hostInfo = createShadowHost();
    shadowHostEl = hostInfo.host;
    shadowRoot = hostInfo.root;

    ensureFonts();
    injectStyles(config.position, shadowRoot);

    stageEl = h("div", { className: "rw-stage", "data-theme": theme });

    // Launcher tab (unchanged from the side-panel design — the user still
    // discovers feedback through the same edge pill). The expanded form is
    // what changed: clicking opens a centered modal instead of a slide-out.
    tabEl = h("button", {
      className: "rw-tab", type: "button",
      "aria-label": "Open feedback panel",
    }, buildTabContent());
    if (config.offset === "auto") {
      tabEl.classList.add("rw-tab--horizontal");
      tabEl.style.top = "auto";
      tabEl.style.bottom = "0";
      tabEl.style.left = isRight ? "auto" : "24px";
      tabEl.style.right = isRight ? "24px" : "auto";
      tabEl.style.transform = "none";
      tabEl.style.writingMode = "horizontal-tb";
      tabEl.style.textOrientation = "initial";
      tabEl.style.width = "auto";
      tabEl.style.height = "36px";
      tabEl.style.paddingLeft = "16px";
      tabEl.style.paddingRight = "16px";
      tabEl.style.borderRadius = "10px 10px 0 0";
    } else if (config.offset != null) {
      tabEl.style.top = config.offset;
      tabEl.style.transform = "none";
    }
    tabEl.addEventListener("click", function () { isOpen ? closePanel() : openPanel(); });

    // Shell controls (theme + close), pinned top-right of the modal card.
    themeToggleBtn = h("button", { className: "rw-icon-btn", type: "button" });
    themeToggleBtn.addEventListener("click", toggleTheme);

    var closeShellBtn = h("button", { className: "rw-icon-btn", type: "button", "aria-label": "Close" }, Icons.close(16));
    closeShellBtn.addEventListener("click", closePanel);

    // The card body (`scrollEl` keeps its name for compatibility with
    // refreshAll's loading-state insert + renderPanelBody clears) holds
    // either the split layout or the full-width detail view.
    scrollEl = h("div", {
      style: { flex: "1 1 auto", display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden" },
    });

    footerEl = h("div", { className: "rw-dash-ftr" }, [
      h("span", { className: "rw-dash-ftr-dot" }),
      h("span", null, [document.createTextNode("Powered by "), h("b", null, "RunHQ")]),
    ]);

    var cardModal = h("div", {
      className: "rw-card-modal", role: "dialog",
      "aria-label": "Feedback panel", "aria-modal": "true",
    }, [
      h("div", { className: "rw-shell-actions" }, [themeToggleBtn, closeShellBtn]),
      scrollEl,
      footerEl,
    ]);

    // `widgetEl` aliases the outer scrim so existing open/close code that
    // toggles `widgetEl.classList` ("rw-open") keeps working.
    widgetEl = h("div", {
      className: "rw-shell-scrim", "data-theme": theme,
    }, [
      h("div", { className: "rw-shell", "data-theme": theme }, [cardModal]),
    ]);

    // Click-outside-the-card to close.
    widgetEl.addEventListener("mousedown", function (e) {
      if (e.target === widgetEl) closePanel();
    });

    modalMountEl = h("div", { className: "rw-modal-mount", "data-theme": theme });

    stageEl.appendChild(tabEl);
    stageEl.appendChild(widgetEl);
    stageEl.appendChild(modalMountEl);
    shadowRoot.appendChild(stageEl);
    document.body.appendChild(shadowHostEl);

    applyTheme(theme);

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        if (activeModal) { closeActiveModal(); return; }
        if (isOpen) closePanel();
      }
    });
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  window.RunHQWidget = {
    init: function (opts) {
      if (!opts || (!opts.token && !opts.project)) {
        console.warn("RunHQWidget.init: token or project is required.");
        return;
      }
      if (opts.server) {
        RUNHQ_API = opts.server.replace(/\/+$/, "");
      } else {
        var scripts = document.querySelectorAll('script[src*="widget.js"]');
        var src = scripts.length ? scripts[scripts.length - 1].getAttribute("src") : "";
        if (src && !src.startsWith("http")) {
          RUNHQ_API = window.location.origin;
        }
      }

      config = {
        token: opts.token || null,
        project: opts.project || null,
      };

      hookConsole();

      loadTopTickets().then(function (data) {
        topTicketsCache = data.tickets || [];
        config.projectId = data.projectSlug || config.project;
        config.projectName = data.projectName || config.project;
        config.isIdentified = !!data.isIdentified;

        var pos = (data.position || "middle-right").split("-");
        var vPos = pos[0] || "middle";
        var hPos = pos[1] || "right";
        config.position = hPos;
        config.offset = vPos === "bottom" ? "auto" : vPos === "top" ? "80px" : null;

        theme = resolveInitialTheme(opts.theme);

        mountDOM();

        if (config.token) {
          loadMyTickets().then(function (d) { myTicketsCache = d.tickets || []; }).catch(function () {});
          loadUpdates().then(function (d) { updatesCache = d.tickets || []; refreshTabLabel(); }).catch(function () {});
        } else {
          myTicketsCache = [];
          loadUpdates().then(function (d) { updatesCache = d.tickets || []; refreshTabLabel(); }).catch(function () { updatesCache = []; });
        }
      }).catch(function (err) {
        console.error("RunHQWidget: failed to initialize", err);
      });
    },
  };

})();
