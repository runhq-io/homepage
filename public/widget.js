/*!
 * RunHQ Widget v1.0.0
 * Embeddable voting widget — vanilla JS, no dependencies
 * Usage: <script src="/widget.js"></script>
 *        <script>RunHQWidget.init({ token: "rw_..." })</script>
 */
(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Config & state
  // ---------------------------------------------------------------------------

  var config = {};
  var consoleLogs = [];
  var capturedErrors = [];
  var MAX_LOG_BUFFER = 50;

  // DOM references
  var tabEl = null;
  var panelEl = null;
  var overlayEl = null;
  var panelBodyEl = null;
  var headerTitleEl = null;
  var isOpen = false;
  var activeTab = "updates"; // "updates" | "all" | "mine"
  var statsCache = null;
  var updatesCache = null;

  // ---------------------------------------------------------------------------
  // Console & error capture
  // ---------------------------------------------------------------------------

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
        type: "onerror",
        message: String(msg),
        source: src,
        line: line,
        col: col,
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

  // ---------------------------------------------------------------------------
  // API
  // ---------------------------------------------------------------------------

  var RUNHQ_API = (function () {
    try {
      var scripts = document.querySelectorAll('script[src*="widget.js"]');
      var src = scripts[scripts.length - 1].src;
      return src.substring(0, src.lastIndexOf('/'));
    } catch (_) {}
    return "https://console.runhq.io";
  })();

  function api(path, opts) {
    var headers = { "Content-Type": "application/json" };
    if (config.token) {
      headers["Authorization"] = "Bearer " + config.token;
    } else if (config.project) {
      headers["X-RW-Project"] = config.project;
    }
    return fetch(RUNHQ_API + path, {
      method: (opts && opts.method) || "GET",
      headers: headers,
      body: (opts && opts.body) ? JSON.stringify(opts.body) : undefined,
    }).then(function (r) {
      if (!r.ok) throw new Error("API error: " + r.status);
      return r.json();
    });
  }

  function loadTickets() {
    return api("/api/widget/tickets");
  }

  function submitSuggestion(data) {
    return api("/api/widget/tickets", { method: "POST", body: data });
  }

  function loadMySubmissions() {
    return api("/api/widget/tickets/mine");
  }

  function loadStats() {
    return api("/api/widget/tickets/stats");
  }

  function castVote(proposalId, value) {
    return api("/api/widget/tickets/" + proposalId + "/vote", {
      method: "POST",
      body: { value: value },
    });
  }

  function retractVote(proposalId) {
    return api("/api/widget/tickets/" + proposalId + "/vote", {
      method: "DELETE",
    });
  }

  function loadTicketDetail(ticketId) {
    return api("/api/widget/tickets/" + ticketId);
  }

  function updateTicket(ticketId, data) {
    return api("/api/widget/tickets/" + ticketId, { method: "PATCH", body: data });
  }

  function deleteTicket(ticketId) {
    return api("/api/widget/tickets/" + ticketId, { method: "DELETE" });
  }

  function uploadAttachment(ticketId, file) {
    var formData = new FormData();
    formData.append("file", file);
    var headers = {};
    if (config.token) {
      headers["Authorization"] = "Bearer " + config.token;
    } else if (config.project) {
      headers["X-RW-Project"] = config.project;
    }
    return fetch(RUNHQ_API + "/api/widget/tickets/" + ticketId + "/attachments", {
      method: "POST",
      headers: headers,
      body: formData,
    }).then(function (r) {
      if (!r.ok) throw new Error("Upload failed: " + r.status);
      return r.json();
    });
  }

  function deleteAttachmentApi(ticketId, attachmentId) {
    return api("/api/widget/tickets/" + ticketId + "/attachments/" + attachmentId, { method: "DELETE" });
  }

  function loadUpdates() { return api("/api/widget/tickets/updates"); }
  function postComment(ticketId, content) {
    return api("/api/widget/tickets/" + ticketId + "/comments", { method: "POST", body: { content: content } });
  }
  function editComment(ticketId, commentId, content) {
    return api("/api/widget/tickets/" + ticketId + "/comments/" + commentId, { method: "PATCH", body: { content: content } });
  }
  function removeComment(ticketId, commentId) {
    return api("/api/widget/tickets/" + ticketId + "/comments/" + commentId, { method: "DELETE" });
  }
  function uploadCommentAttachment(ticketId, commentId, file) {
    var formData = new FormData();
    formData.append("file", file);
    return fetch(RUNHQ_API + "/api/widget/tickets/" + ticketId + "/comments/" + commentId + "/attachments", {
      method: "POST",
      headers: { Authorization: "Bearer " + config.token },
      body: formData,
    }).then(function (r) { return r.json(); });
  }

  // ---------------------------------------------------------------------------
  // DOM helper
  // ---------------------------------------------------------------------------

  var SVG_NS = "http://www.w3.org/2000/svg";
  var SVG_TAGS = { svg: 1, path: 1, circle: 1, rect: 1, line: 1, polyline: 1, polygon: 1, g: 1 };

  function h(tag, attrs, children) {
    var el = SVG_TAGS[tag]
      ? document.createElementNS(SVG_NS, tag)
      : document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === "className") {
          el.setAttribute("class", attrs[k]);
        } else if (k.slice(0, 2) === "on") {
          el.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
        } else if (attrs[k] != null) {
          el.setAttribute(k, attrs[k]);
        }
      });
    }
    if (children != null) {
      if (typeof children === "string") {
        el.textContent = children;
      } else if (Array.isArray(children)) {
        children.forEach(function (c) { if (c) el.appendChild(c); });
      } else {
        el.appendChild(children);
      }
    }
    return el;
  }

  // ---------------------------------------------------------------------------
  // Theme detection
  // ---------------------------------------------------------------------------

  function resolveTheme(theme) {
    if (theme === "dark") return "dark";
    if (theme === "light") return "light";
    // auto
    return (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches)
      ? "dark"
      : "light";
  }

  // ---------------------------------------------------------------------------
  // CSS injection
  // ---------------------------------------------------------------------------

  function injectStyles(theme, position) {
    var isDark = theme === "dark";

    var bg = isDark ? "#1a1a1a" : "#ffffff";
    var bgAlt = isDark ? "#2a2a2a" : "#fafaf9";
    var text = isDark ? "#e5e5e5" : "#1a1a1a";
    var textMuted = isDark ? "#a3a3a3" : "#525252";
    var textFaint = isDark ? "#737373" : "#a3a3a3";
    var border = isDark ? "#333333" : "#e5e5e5";
    var accent = "#f97316";
    var yesColor = "#16a34a";
    var noColor = "#dc2626";
    var shadow = "none";

    var isRight = position === "right";

    var css = [
      /* Tab */
      ".rw-tab {",
      "  position: fixed;",
      "  top: 50%;",
      "  " + (isRight ? "right" : "left") + ": 0;",
      "  transform: translateY(-50%);",
      "  width: 36px;",
      "  height: 120px;",
      "  background: " + accent + ";",
      "  color: #fff;",
      "  cursor: pointer;",
      "  display: flex;",
      "  align-items: center;",
      "  justify-content: center;",
      "  writing-mode: vertical-rl;",
      "  text-orientation: mixed;",
      "  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;",
      "  font-size: 13px;",
      "  font-weight: 600;",
      "  letter-spacing: 0.05em;",
      "  border-radius: " + (isRight ? "8px 0 0 8px" : "0 8px 8px 0") + ";",
      "  z-index: 2147483646;",
      "  transition: width 0.2s ease, box-shadow 0.2s ease;",
      "  box-shadow: 2px 2px 8px rgba(249,115,22,0.4);",
      "  user-select: none;",
      "  -webkit-user-select: none;",
      "}",
      ".rw-tab:hover {",
      "  width: 44px;",
      "  box-shadow: 3px 3px 12px rgba(249,115,22,0.5);",
      "}",
      ".rw-tab.rw-open {",
      "  display: none;",
      "}",

      /* Overlay */
      ".rw-overlay {",
      "  position: fixed;",
      "  inset: 0;",
      "  background: rgba(0,0,0,0.35);",
      "  z-index: 2147483644;",
      "  opacity: 0;",
      "  pointer-events: none;",
      "  transition: opacity 0.25s ease;",
      "}",
      ".rw-overlay.rw-visible {",
      "  opacity: 1;",
      "  pointer-events: auto;",
      "}",

      /* Panel */
      ".rw-panel {",
      "  position: fixed;",
      "  top: 0;",
      "  " + (isRight ? "right" : "left") + ": 0;",
      "  width: 360px;",
      "  max-width: 90vw;",
      "  height: 100vh;",
      "  background: " + bg + ";",
      "  color: " + text + ";",
      "  z-index: 2147483645;",
      "  display: flex;",
      "  flex-direction: column;",
      "  transform: translateX(" + (isRight ? "100%" : "-100%") + ");",
      "  transition: transform 0.3s cubic-bezier(0.4,0,0.2,1);",
      "  box-shadow: " + shadow + ";",
      "  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;",
      "  font-size: 14px;",
      "  line-height: 1.5;",
      "}",
      ".rw-panel.rw-open {",
      "  transform: translateX(0);",
      "}",

      /* Panel header */
      ".rw-header {",
      "  display: flex;",
      "  align-items: center;",
      "  justify-content: space-between;",
      "  padding: 16px 16px 14px;",
      "  border-bottom: 1px solid " + border + ";",
      "  flex-shrink: 0;",
      "}",
      ".rw-header-title {",
      "  display: flex;",
      "  flex-direction: column;",
      "  gap: 1px;",
      "}",
      ".rw-header-title strong {",
      "  font-size: 15px;",
      "  font-weight: 700;",
      "  color: " + accent + ";",
      "}",
      ".rw-header-subtitle {",
      "  font-size: 11px;",
      "  color: " + textFaint + ";",
      "}",
      ".rw-close-btn {",
      "  background: none;",
      "  border: none;",
      "  cursor: pointer;",
      "  color: " + textMuted + ";",
      "  padding: 4px;",
      "  border-radius: 4px;",
      "  display: flex;",
      "  align-items: center;",
      "  justify-content: center;",
      "  transition: background 0.15s, color 0.15s;",
      "}",
      ".rw-close-btn:hover {",
      "  background: " + bgAlt + ";",
      "  color: " + text + ";",
      "}",

      /* Panel body */
      ".rw-body {",
      "  flex: 1;",
      "  overflow-y: auto;",
      "  overflow-x: hidden;",
      "  padding: 12px 0;",
      "}",
      ".rw-body::-webkit-scrollbar { width: 4px; }",
      ".rw-body::-webkit-scrollbar-track { background: transparent; }",
      ".rw-body::-webkit-scrollbar-thumb { background: " + border + "; border-radius: 2px; }",

      /* New suggestion button */
      ".rw-new-btn {",
      "  display: flex;",
      "  align-items: center;",
      "  gap: 6px;",
      "  width: calc(100% - 24px);",
      "  margin: 0 12px 16px;",
      "  padding: 10px 14px;",
      "  background: none;",
      "  border: 2px dashed " + border + ";",
      "  border-radius: 8px;",
      "  color: " + textMuted + ";",
      "  font-size: 13px;",
      "  font-weight: 500;",
      "  cursor: pointer;",
      "  transition: border-color 0.15s, color 0.15s, background 0.15s;",
      "  font-family: inherit;",
      "}",
      ".rw-new-btn:hover {",
      "  border-color: " + accent + ";",
      "  color: " + accent + ";",
      "  background: rgba(249,115,22,0.05);",
      "}",

      /* Section labels */
      ".rw-section-label {",
      "  padding: 0 16px 6px;",
      "  font-size: 10px;",
      "  font-weight: 700;",
      "  letter-spacing: 0.1em;",
      "  text-transform: uppercase;",
      "  color: " + textFaint + ";",
      "}",

      /* Proposal card */
      ".rw-proposal {",
      "  margin: 0 8px 6px;",
      "  display: flex;",
      "  align-items: stretch;",
      "  background: " + bgAlt + ";",
      "  border: 1px solid " + border + ";",
      "  border-radius: 6px;",
      "  overflow: hidden;",
      "  text-decoration: none;",
      "  color: inherit;",
      "  cursor: pointer;",
      "  transition: border-color 0.15s;",
      "}",
      ".rw-proposal:hover {",
      "  border-color: " + accent + ";",
      "}",
      ".rw-vote-col {",
      "  display: flex;",
      "  flex-direction: column;",
      "  align-items: center;",
      "  justify-content: center;",
      "  gap: 2px;",
      "  padding: 6px 10px;",
      "  border-right: 1px solid " + border + ";",
      "  min-width: 38px;",
      "}",
      ".rw-vote-arrow {",
      "  display: flex;",
      "  align-items: center;",
      "  justify-content: center;",
      "  width: 16px;",
      "  height: 16px;",
      "  border-radius: 3px;",
      "  border: none;",
      "  background: none;",
      "  color: " + textFaint + ";",
      "  cursor: pointer;",
      "  transition: all 0.15s;",
      "  padding: 0;",
      "}",
      ".rw-vote-arrow:hover { color: " + yesColor + "; background: " + yesColor + "14; }",
      ".rw-vote-arrow.rw-down:hover { color: " + noColor + "; background: " + noColor + "14; }",
      ".rw-vote-arrow.rw-voted { color: " + yesColor + "; }",
      ".rw-vote-arrow.rw-down.rw-voted { color: " + noColor + "; }",
      ".rw-vote-arrow.rw-disabled { opacity: 0.45; cursor: default; pointer-events: none; }",
      ".rw-vote-count {",
      "  font-size: 13px;",
      "  font-weight: 700;",
      "  color: " + text + ";",
      "  line-height: 1;",
      "  font-variant-numeric: tabular-nums;",
      "}",
      ".rw-proposal-content {",
      "  flex: 1;",
      "  min-width: 0;",
      "  padding: 6px 10px;",
      "  display: flex;",
      "  flex-direction: column;",
      "  justify-content: center;",
      "}",
      ".rw-proposal-title {",
      "  font-size: 13px;",
      "  font-weight: 600;",
      "  color: " + text + ";",
      "  line-height: 1.3;",
      "}",
      ".rw-proposal-meta {",
      "  display: flex;",
      "  align-items: center;",
      "  gap: 8px;",
      "  font-size: 11px;",
      "  color: " + textFaint + ";",
      "  flex-wrap: wrap;",
      "  margin-top: 3px;",
      "}",

      /* Status badges */
      ".rw-badge {",
      "  display: inline-flex;",
      "  align-items: center;",
      "  padding: 2px 7px;",
      "  border-radius: 999px;",
      "  font-size: 10px;",
      "  font-weight: 600;",
      "  letter-spacing: 0.03em;",
      "  text-transform: uppercase;",
      "}",
      ".rw-badge-open { background: rgba(22,163,74,0.15); color: #16a34a; }",
      ".rw-badge-closed { background: " + border + "; color: " + textFaint + "; }",
      ".rw-badge-pending { background: rgba(249,115,22,0.15); color: " + accent + "; }",

      /* Empty state */
      ".rw-empty {",
      "  text-align: center;",
      "  padding: 32px 16px;",
      "  color: " + textFaint + ";",
      "  font-size: 13px;",
      "}",

      /* Loading spinner */
      ".rw-loading {",
      "  display: flex;",
      "  align-items: center;",
      "  justify-content: center;",
      "  padding: 32px 16px;",
      "}",
      "@keyframes rw-spin { to { transform: rotate(360deg); } }",
      ".rw-spinner {",
      "  width: 24px;",
      "  height: 24px;",
      "  border: 2px solid " + border + ";",
      "  border-top-color: " + accent + ";",
      "  border-radius: 50%;",
      "  animation: rw-spin 0.7s linear infinite;",
      "}",

      /* Suggestion form */
      ".rw-form {",
      "  padding: 0 12px;",
      "}",
      ".rw-back-btn {",
      "  display: flex;",
      "  align-items: center;",
      "  gap: 6px;",
      "  background: none;",
      "  border: none;",
      "  color: " + textMuted + ";",
      "  font-size: 13px;",
      "  cursor: pointer;",
      "  padding: 4px 0 12px;",
      "  font-family: inherit;",
      "  transition: color 0.15s;",
      "}",
      ".rw-back-btn:hover { color: " + text + "; }",
      ".rw-form-label {",
      "  display: block;",
      "  font-size: 11px;",
      "  font-weight: 600;",
      "  text-transform: uppercase;",
      "  letter-spacing: 0.06em;",
      "  color: " + textFaint + ";",
      "  margin-bottom: 6px;",
      "}",
      ".rw-form-group {",
      "  margin-bottom: 14px;",
      "}",
      ".rw-type-row {",
      "  display: flex;",
      "  gap: 8px;",
      "}",
      ".rw-type-btn {",
      "  flex: 1;",
      "  padding: 8px 12px;",
      "  border: 1px solid " + border + ";",
      "  border-radius: 6px;",
      "  background: none;",
      "  color: " + textMuted + ";",
      "  font-size: 13px;",
      "  font-weight: 500;",
      "  cursor: pointer;",
      "  transition: all 0.15s;",
      "  font-family: inherit;",
      "}",
      ".rw-type-btn.rw-active {",
      "  border-color: " + accent + ";",
      "  background: rgba(249,115,22,0.1);",
      "  color: " + accent + ";",
      "}",
      ".rw-input {",
      "  width: 100%;",
      "  padding: 9px 11px;",
      "  border: 1px solid " + border + ";",
      "  border-radius: 6px;",
      "  background: " + bgAlt + ";",
      "  color: " + text + ";",
      "  font-size: 13px;",
      "  font-family: inherit;",
      "  outline: none;",
      "  transition: border-color 0.15s;",
      "  box-sizing: border-box;",
      "}",
      ".rw-input:focus { border-color: " + accent + "; }",
      ".rw-textarea {",
      "  resize: vertical;",
      "  min-height: 80px;",
      "}",
      ".rw-submit-btn {",
      "  width: 100%;",
      "  padding: 10px 16px;",
      "  background: " + accent + ";",
      "  color: #fff;",
      "  border: none;",
      "  border-radius: 6px;",
      "  font-size: 14px;",
      "  font-weight: 600;",
      "  cursor: pointer;",
      "  font-family: inherit;",
      "  transition: opacity 0.15s, transform 0.1s;",
      "}",
      ".rw-submit-btn:hover { opacity: 0.9; }",
      ".rw-submit-btn:active { transform: scale(0.98); }",
      ".rw-submit-btn:disabled { opacity: 0.5; cursor: not-allowed; }",

      /* Success / error notices */
      ".rw-notice {",
      "  margin: 0 0 12px;",
      "  padding: 10px 12px;",
      "  border-radius: 6px;",
      "  font-size: 12px;",
      "  line-height: 1.4;",
      "}",
      ".rw-notice-success { background: rgba(22,163,74,0.12); color: #16a34a; border: 1px solid rgba(22,163,74,0.3); }",
      ".rw-notice-error { background: rgba(220,38,38,0.1); color: #dc2626; border: 1px solid rgba(220,38,38,0.25); }",

      /* Source line */
      ".rw-source { font-size: 11px; color: " + textFaint + "; margin: 8px 0 12px; }",
      ".rw-source a { color: " + accent + "; text-decoration: none; }",
      ".rw-source a:hover { text-decoration: underline; }",

      /* Divider */
      ".rw-divider { border: none; border-top: 1px solid " + border + "; margin: 16px 0; }",
      ".rw-show-more { display: block; text-align: center; padding: 12px; margin-top: 8px; font-size: 13px; color: " + accent + "; text-decoration: none; border: 1px solid " + border + "; border-radius: 10px; }",
      ".rw-show-more:hover { background: " + accent + "11; border-color: " + accent + "; }",

      /* File attach area */
      ".rw-attach-area { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; background: " + bgAlt + "; border: 2px dashed " + border + "; border-radius: 8px; padding: 16px 12px; color: " + textMuted + "; cursor: pointer; font-size: 12px; width: 100%; margin-bottom: 8px; font-family: inherit; box-sizing: border-box; transition: border-color 0.15s, color 0.15s; min-height: 60px; text-align: center; }",
      ".rw-attach-area:hover, .rw-attach-area.rw-dragover { border-color: " + accent + "; color: " + accent + "; }",
      ".rw-attach-area input[type=file] { display: none; }",
      ".rw-attach-preview { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; width: 100%; }",
      ".rw-attach-thumb { position: relative; width: 48px; height: 48px; border-radius: 4px; overflow: hidden; border: 1px solid " + border + "; }",
      ".rw-attach-thumb img { width: 100%; height: 100%; object-fit: cover; }",
      ".rw-attach-remove { position: absolute; top: -4px; right: -4px; width: 16px; height: 16px; background: " + noColor + "; color: #fff; border: none; border-radius: 50%; font-size: 10px; cursor: pointer; display: flex; align-items: center; justify-content: center; line-height: 1; }",

      /* Powered-by link */
      ".rw-powered { font-size: 11px; color: " + textFaint + "; }",
      ".rw-powered a { color: " + accent + "; text-decoration: none; font-weight: 600; }",
      ".rw-powered a:hover { text-decoration: underline; }",

      /* Inline feedback form */
      ".rw-inline-form { padding: 0 12px 8px; }",
      ".rw-inline-title { display: none; }",
      ".rw-inline-textarea { min-height: 64px; resize: none; }",
      ".rw-inline-bottom { display: flex; align-items: center; gap: 8px; margin-top: 6px; }",
      ".rw-inline-bottom-right { display: flex; align-items: center; gap: 8px; margin-left: auto; }",
      ".rw-attach-btn { background: none; border: none; cursor: pointer; font-size: 16px; padding: 4px 6px; border-radius: 4px; color: " + textMuted + "; transition: color 0.15s; }",
      ".rw-attach-btn:hover { color: " + text + "; }",
      ".rw-inline-submit { padding: 5px 14px; background: " + accent + "; color: #fff; border: none; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer; font-family: inherit; transition: opacity 0.15s; }",
      ".rw-inline-submit:hover { opacity: 0.9; }",
      ".rw-inline-submit:disabled { opacity: 0.5; cursor: not-allowed; }",
      ".rw-private-label { display: flex; align-items: center; gap: 5px; font-size: 11px; color: " + textMuted + "; cursor: pointer; user-select: none; }",
      ".rw-private-label input { width: 13px; height: 13px; margin: 0; cursor: pointer; accent-color: " + accent + "; }",


      /* Stats banner */
      ".rw-stats-banner{display:flex;align-items:center;gap:6px;padding:8px 12px;margin-bottom:8px;background:rgba(16,185,129,0.08);border-radius:8px;font-size:12px;color:#6ee7b7}",
      ".rw-stats-sep{color:#374151}",

      /* Tabs */
      ".rw-tabs{display:flex;gap:4px;margin:0 12px 8px}",
      ".rw-tab-btn{flex:1;padding:6px 0;border:none;border-radius:6px;font-size:12px;font-weight:500;cursor:pointer;background:transparent;color:" + textMuted + ";transition:all .15s}",
      ".rw-tab-btn:hover{color:" + text + ";background:" + bgAlt + "}",
      ".rw-tab-active{color:" + text + ";background:" + border + "}",
      ".rw-tab-badge{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:" + accent + ";color:#fff;font-size:11px;font-weight:600;margin-left:4px}",
      ".rw-tab-btn:disabled{opacity:.5;cursor:not-allowed}",

      /* Login prompt */
      ".rw-login-prompt{padding:10px 12px;border-radius:8px;background:" + bgAlt + ";text-align:center;font-size:12px;color:" + textMuted + ";margin-bottom:8px}",
      ".rw-submitting-as{font-size:11px;color:" + textMuted + ";margin-top:8px}",

      /* My Submissions cards */
      ".rw-submission-card{display:block;padding:10px 12px;border-radius:8px;background:" + bgAlt + ";margin:0 12px 6px;border:1px solid " + border + ";cursor:pointer;text-decoration:none;color:inherit;transition:border-color .15s}",
      ".rw-submission-card:hover{border-color:" + textMuted + "}",
      ".rw-submission-title{font-size:13px;font-weight:500;color:" + text + ";margin-bottom:2px}",
      ".rw-submission-desc{font-size:11px;color:" + textMuted + ";margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".rw-submission-meta{display:flex;align-items:center;gap:8px;font-size:11px}",
      ".rw-submission-date{color:" + textFaint + ";font-size:10px}",
      ".rw-status-badge{padding:2px 8px;border-radius:99px;font-size:10px;font-weight:600}",
      ".rw-vote-counts{color:" + textMuted + "}",

      /* Detail view */
      ".rw-detail { padding: 0 12px; }",
      ".rw-detail-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 12px; }",
      ".rw-detail-title { font-size: 16px; font-weight: 700; color: " + text + "; line-height: 1.3; word-break: break-word; }",
      ".rw-detail-desc { font-size: 13px; color: " + textMuted + "; line-height: 1.5; white-space: pre-wrap; word-break: break-word; margin-bottom: 12px; }",
      ".rw-detail-meta { display: flex; align-items: center; gap: 8px; font-size: 11px; color: " + textFaint + "; margin-bottom: 16px; flex-wrap: wrap; }",
      ".rw-detail-actions { display: flex; gap: 6px; margin-bottom: 16px; }",
      ".rw-edit-btn { padding: 5px 12px; border-radius: 6px; font-size: 12px; font-weight: 500; cursor: pointer; border: 1px solid " + border + "; background: " + bgAlt + "; color: " + text + "; font-family: inherit; transition: all 0.15s; }",
      ".rw-edit-btn:hover { border-color: " + accent + "; color: " + accent + "; }",
      ".rw-delete-btn { padding: 5px 12px; border-radius: 6px; font-size: 12px; font-weight: 500; cursor: pointer; border: 1px solid " + border + "; background: " + bgAlt + "; color: " + noColor + "; font-family: inherit; transition: all 0.15s; }",
      ".rw-delete-btn:hover { border-color: " + noColor + "; background: " + noColor + "14; }",
      ".rw-delete-confirm { padding: 10px 12px; border-radius: 8px; background: " + noColor + "14; border: 1px solid " + noColor + "40; margin-bottom: 12px; }",
      ".rw-delete-confirm p { font-size: 12px; color: " + noColor + "; margin: 0 0 8px; }",
      ".rw-delete-confirm-actions { display: flex; gap: 6px; }",
      ".rw-delete-yes { padding: 4px 12px; border-radius: 5px; font-size: 11px; font-weight: 600; cursor: pointer; border: none; background: " + noColor + "; color: #fff; font-family: inherit; }",
      ".rw-delete-yes:hover { opacity: 0.9; }",
      ".rw-delete-cancel { padding: 4px 12px; border-radius: 5px; font-size: 11px; font-weight: 500; cursor: pointer; border: 1px solid " + border + "; background: " + bgAlt + "; color: " + textMuted + "; font-family: inherit; }",

      /* Timeline */
      ".rw-timeline-label { font-size: 10px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: " + textFaint + "; margin-bottom: 10px; }",
      ".rw-timeline { position: relative; }",
      ".rw-timeline-item { position: relative; padding-left: 28px; padding-bottom: 16px; }",
      ".rw-timeline-item:last-child { padding-bottom: 0; }",
      ".rw-timeline-line { position: absolute; left: 9px; top: 24px; bottom: 0; width: 1px; background: " + border + "; }",
      ".rw-timeline-item:last-child .rw-timeline-line { display: none; }",
      ".rw-timeline-dot { position: absolute; left: 3px; top: 4px; width: 14px; height: 14px; border-radius: 50%; border: 1.5px solid " + border + "; background: " + bg + "; display: flex; align-items: center; justify-content: center; font-size: 8px; }",
      ".rw-timeline-dot-comment { border-color: " + accent + "; }",
      ".rw-timeline-card { background: " + bgAlt + "; border: 1px solid " + border + "; border-radius: 8px; padding: 8px 10px; }",
      ".rw-timeline-card-header { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-bottom: 4px; }",
      ".rw-timeline-author { font-size: 12px; font-weight: 600; color: " + text + "; }",
      ".rw-timeline-date { font-size: 10px; color: " + textFaint + "; }",
      ".rw-timeline-body { font-size: 12px; color: " + textMuted + "; line-height: 1.4; white-space: pre-wrap; word-break: break-word; }",
      ".rw-timeline-activity { font-size: 11px; color: " + textFaint + "; font-style: italic; }",

      /* Edit form within detail */
      ".rw-edit-form { margin-bottom: 12px; }",
      ".rw-edit-form .rw-input { margin-bottom: 8px; }",
      ".rw-edit-form-actions { display: flex; gap: 6px; }",
      ".rw-save-btn { padding: 6px 14px; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer; border: none; background: " + accent + "; color: #fff; font-family: inherit; transition: opacity 0.15s; }",
      ".rw-save-btn:hover { opacity: 0.9; }",
      ".rw-save-btn:disabled { opacity: 0.5; cursor: not-allowed; }",
      ".rw-cancel-btn { padding: 6px 14px; border-radius: 6px; font-size: 12px; font-weight: 500; cursor: pointer; border: 1px solid " + border + "; background: " + bgAlt + "; color: " + textMuted + "; font-family: inherit; }",

      /* Open full page link */
      ".rw-open-full { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: " + accent + "; text-decoration: none; margin-bottom: 12px; }",
      ".rw-open-full:hover { text-decoration: underline; }",

      /* Detail attachments */
      ".rw-detail-attachments { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }",
      ".rw-detail-attach-img { width: 64px; height: 64px; object-fit: cover; border-radius: 6px; border: 1px solid " + border + "; cursor: pointer; transition: border-color 0.15s; }",
      ".rw-detail-attach-img:hover { border-color: " + accent + "; }",

      /* Edit attachments */
      ".rw-edit-attachments { margin-bottom: 10px; }",
      ".rw-edit-attach-item { display: inline-flex; position: relative; margin: 0 6px 6px 0; }",
      ".rw-edit-attach-img { width: 52px; height: 52px; object-fit: cover; border-radius: 5px; border: 1px solid " + border + "; }",
      ".rw-edit-attach-remove { position: absolute; top: -5px; right: -5px; width: 18px; height: 18px; background: " + noColor + "; color: #fff; border: none; border-radius: 50%; font-size: 11px; cursor: pointer; display: flex; align-items: center; justify-content: center; line-height: 1; }",
    ].join("\n");

    var style = document.createElement("style");
    style.id = "rw-styles";
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------------------
  // Time helpers
  // ---------------------------------------------------------------------------

  function timeLeft(endsAt) {
    if (!endsAt) return null;
    var diff = new Date(endsAt).getTime() - Date.now();
    if (diff <= 0) return "ended";
    var days = Math.floor(diff / 86400000);
    var hours = Math.floor((diff % 86400000) / 3600000);
    if (days > 0) return days + "d " + hours + "h left";
    var mins = Math.floor((diff % 3600000) / 60000);
    if (hours > 0) return hours + "h " + mins + "m left";
    return mins + "m left";
  }

  function formatDate(dateStr) {
    var d = new Date(dateStr);
    return d.toLocaleDateString(navigator.language || "en", { month: "short", day: "numeric", year: "numeric" });
  }

  function timeAgo(dateStr) {
    var diff = Date.now() - new Date(dateStr).getTime();
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + "m ago";
    var hours = Math.floor(mins / 60);
    if (hours < 24) return hours + "h ago";
    var days = Math.floor(hours / 24);
    if (days < 30) return days + "d ago";
    var months = Math.floor(days / 30);
    return months + "mo ago";
  }

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  function renderLoading() {
    return h("div", { className: "rw-loading" }, h("div", { className: "rw-spinner" }));
  }

  function renderEmpty(msg) {
    return h("div", { className: "rw-empty" }, msg || "No tickets yet.");
  }

  function renderNotice(type, msg) {
    return h("div", { className: "rw-notice rw-notice-" + type }, msg);
  }

  // ---------------------------------------------------------------------------
  // Proposal card
  // ---------------------------------------------------------------------------

  function renderTicket(proposal) {
    var isClosed = proposal.status === "done" || proposal.status === "cancelled";
    var isActive = !isClosed;
    var canVote = proposal.canVote !== false && config.isIdentified && isActive;

    var yes = parseInt(proposal.yesVotes, 10) || 0;
    var no = parseInt(proposal.noVotes, 10) || 0;
    var net = yes - no;

    var upVoted = proposal.userVote === true;
    var downVoted = proposal.userVote === false;

    function handleVote(value, e) {
      e.preventDefault();
      e.stopPropagation();
      if (!canVote) return;
      var alreadyVoted = (value === true && upVoted) || (value === false && downVoted);
      var action = alreadyVoted
        ? retractVote(proposal.id)
        : castVote(proposal.id, value);
      action.then(function () {
        return loadTickets();
      }).then(function (data) {
        ticketsCache = data.tickets || [];
        renderCurrentTab(!!config.isIdentified);
      }).catch(function () {});
    }

    // Vote column: ▲ count ▼ in a row
    var upArrow = h("button", {
      className: "rw-vote-arrow" + (upVoted ? " rw-voted" : "") + (!canVote ? " rw-disabled" : ""),
      onClick: function (e) { handleVote(true, e); },
      disabled: canVote ? undefined : true,
      "aria-disabled": canVote ? undefined : "true",
    },
      h("svg", { width: "8", height: "6", viewBox: "0 0 14 10", fill: "currentColor" },
        h("path", { d: "M7 0L13.9282 9.75H0.0717969L7 0Z" })
      )
    );
    var downArrow = h("button", {
      className: "rw-vote-arrow rw-down" + (downVoted ? " rw-voted" : "") + (!canVote ? " rw-disabled" : ""),
      onClick: function (e) { handleVote(false, e); },
      disabled: canVote ? undefined : true,
      "aria-disabled": canVote ? undefined : "true",
    },
      h("svg", { width: "8", height: "6", viewBox: "0 0 14 10", fill: "currentColor" },
        h("path", { d: "M7 10L0.0717969 0.25H13.9282L7 10Z" })
      )
    );
    var voteCol = h("div", {
      className: "rw-vote-col",
      onClick: function (e) { e.preventDefault(); e.stopPropagation(); },
    }, [
      upArrow,
      h("span", { className: "rw-vote-count" }, String(net)),
      downArrow,
    ]);

    // Meta row
    var metaItems = [];
    if (isClosed) {
      metaItems.push(h("span", { className: "rw-badge rw-badge-closed" }, "Closed"));
    }
    if (proposal.authorName) {
      metaItems.push(h("span", null, "by " + proposal.authorName));
    }
    metaItems.push(h("span", null, timeAgo(proposal.createdAt)));

    // Content column
    var contentChildren = [
      h("div", { className: "rw-proposal-title" }, proposal.title),
      h("div", { className: "rw-proposal-meta" }, metaItems),
    ];
    var contentCol = h("div", { className: "rw-proposal-content" }, contentChildren);

    return h("div", {
      className: "rw-proposal",
      onClick: function (e) {
        if (e.defaultPrevented) return;
        showTicketDetail(proposal.id);
      },
    }, [voteCol, contentCol]);
  }

  // ---------------------------------------------------------------------------
  // Ticket detail view
  // ---------------------------------------------------------------------------

  function showTicketDetail(ticketId) {
    setBodyContent(renderLoading());
    loadTicketDetail(ticketId).then(function (data) {
      setBodyContent(renderTicketDetail(data));
    }).catch(function (err) {
      setBodyContent(renderNotice("error", "Could not load ticket: " + err.message));
    });
  }

  function renderActivityLabel(entry) {
    var actor = entry.createdByName || "Someone";
    switch (entry.type) {
      case "task_created": return actor + " created this task";
      case "status_change":
        return actor + " changed status" + (entry.metadata && entry.metadata.to ? " to " + String(entry.metadata.to).replace(/_/g, " ") : "");
      case "agent_assigned":
        return actor + " assigned " + (entry.metadata && entry.metadata.agentName ? String(entry.metadata.agentName) : "an agent");
      case "task_archived": return actor + " archived this task";
      case "task_unarchived": return actor + " unarchived this task";
      case "task_deleted": return actor + " deleted this task";
      default: return entry.content || (actor + " updated this task");
    }
  }

  function renderTicketDetail(data) {
    var ticket = data.ticket;
    var isOwner = data.isOwner;
    var isEditable = data.isEditable;
    var comments = data.comments || [];
    var activity = data.activity || [];

    var container = h("div", { className: "rw-detail" });

    // Back button
    var backBtn = h("button", {
      className: "rw-back-btn",
      onClick: function () {
        ticketsCache = null;
        mySubmissionsCountCache = null;
        showPanelView();
      },
    }, [
      h("svg", { width: "14", height: "14", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round" }, [
        h("path", { d: "M19 12H5" }),
        h("path", { d: "M12 19l-7-7 7-7" }),
      ]),
      h("span", null, "Back"),
    ]);
    container.appendChild(backBtn);

    // Open full page link
    var slug = config.projectId || config.project;
    var fullPageUrl = (config.homepageUrl || RUNHQ_API) + "/project/" + slug + "/proposals/" + ticket.id;
    container.appendChild(h("a", {
      className: "rw-open-full",
      href: fullPageUrl,
      target: "_blank",
      rel: "noopener noreferrer",
    }, [
      h("span", null, "Open full page"),
      h("svg", { width: "10", height: "10", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2.5", "stroke-linecap": "round" }, [
        h("path", { d: "M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" }),
        h("path", { d: "M15 3h6v6" }),
        h("path", { d: "M10 14L21 3" }),
      ]),
    ]));

    // Title + status
    var statusText = ticket.status.replace(/_/g, " ");
    statusText = statusText.charAt(0).toUpperCase() + statusText.slice(1);
    var statusColor;
    switch (ticket.status) {
      case "pending": statusColor = "#f59e0b"; break;
      case "planned": statusColor = "#3b82f6"; break;
      case "in_progress": statusColor = "#8b5cf6"; break;
      case "needs_review": statusColor = "#f59e0b"; break;
      case "done": statusColor = "#10b981"; break;
      case "cancelled": statusColor = "#6b7280"; break;
      default: statusColor = "#6b7280";
    }
    if (ticket.moderationStatus === "pending") {
      statusText = "Awaiting review";
      statusColor = "#f59e0b";
    }
    var badge = h("span", {
      className: "rw-status-badge",
      style: "color:" + statusColor + ";background:" + statusColor + "1a",
    }, statusText);

    var headerRow = h("div", { className: "rw-detail-header" }, [
      h("div", { className: "rw-detail-title" }, ticket.title),
      badge,
    ]);
    container.appendChild(headerRow);

    // Description
    if (ticket.description) {
      container.appendChild(h("div", { className: "rw-detail-desc" }, ticket.description));
    }

    // Attachments
    if (ticket.attachments && ticket.attachments.length > 0) {
      var attachContainer = h("div", { className: "rw-detail-attachments" });
      ticket.attachments.forEach(function (att) {
        if (att.url && att.mimeType && att.mimeType.indexOf("image/") === 0) {
          var img = h("img", {
            className: "rw-detail-attach-img",
            src: att.url,
            alt: att.originalName || "attachment",
            onClick: function () { window.open(att.url, "_blank"); },
          });
          attachContainer.appendChild(img);
        }
      });
      if (attachContainer.childNodes.length > 0) {
        container.appendChild(attachContainer);
      }
    }

    // Meta
    var metaItems = [];
    var yes = parseInt(ticket.yesVotes, 10) || 0;
    var no = parseInt(ticket.noVotes, 10) || 0;
    metaItems.push(h("span", null, yes + " upvotes"));
    if (no > 0) metaItems.push(h("span", null, no + " downvotes"));
    if (ticket.source) {
      metaItems.push(h("span", null, ticket.source === "workspace" ? "Workspace" : "Widget"));
    }
    metaItems.push(h("span", null, formatDate(ticket.createdAt)));
    container.appendChild(h("div", { className: "rw-detail-meta" }, metaItems));

    // Edit/delete actions (only for owner of editable tickets)
    if (isOwner && isEditable) {
      var noticeArea = h("div", null);
      container.appendChild(noticeArea);

      var editBtn = h("button", {
        className: "rw-edit-btn",
        onClick: function () {
          setBodyContent(renderTicketEdit(data));
        },
      }, "Edit");

      var deleteBtn = h("button", {
        className: "rw-delete-btn",
        onClick: function () {
          // Show confirmation inline
          noticeArea.innerHTML = "";
          var confirmBox = h("div", { className: "rw-delete-confirm" }, [
            h("p", null, "Delete this ticket? This cannot be undone."),
            h("div", { className: "rw-delete-confirm-actions" }, [
              h("button", {
                className: "rw-delete-yes",
                onClick: function () {
                  deleteTicket(ticket.id).then(function () {
                    ticketsCache = null;
                    mySubmissionsCountCache = null;
                    showPanelView();
                  }).catch(function (err) {
                    noticeArea.innerHTML = "";
                    noticeArea.appendChild(renderNotice("error", "Failed to delete: " + err.message));
                  });
                },
              }, "Delete"),
              h("button", {
                className: "rw-delete-cancel",
                onClick: function () { noticeArea.innerHTML = ""; },
              }, "Cancel"),
            ]),
          ]);
          noticeArea.appendChild(confirmBox);
        },
      }, "Delete");

      container.appendChild(h("div", { className: "rw-detail-actions" }, [editBtn, deleteBtn]));
    }

    // Divider
    container.appendChild(h("hr", { className: "rw-divider" }));

    // Timeline
    var timeline = [];
    comments.forEach(function (c) {
      timeline.push({ kind: "comment", id: c.id, authorName: c.authorName, body: c.body, createdAt: c.createdAt });
    });
    activity.forEach(function (a) {
      timeline.push({ kind: "activity", id: a.id, type: a.type, content: a.content, createdByName: a.createdByName, createdAt: a.createdAt, metadata: a.metadata });
    });
    timeline.sort(function (a, b) { return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(); });

    container.appendChild(h("div", { className: "rw-timeline-label" }, "Timeline (" + timeline.length + ")"));

    if (timeline.length === 0) {
      container.appendChild(h("div", { className: "rw-empty", style: "padding: 12px 0;" }, "No activity yet."));
    } else {
      var timelineEl = h("div", { className: "rw-timeline" });
      timeline.forEach(function (item) {
        var dotClass = "rw-timeline-dot" + (item.kind === "comment" ? " rw-timeline-dot-comment" : "");
        var cardHeader = h("div", { className: "rw-timeline-card-header" }, [
          h("span", { className: "rw-timeline-author" },
            item.kind === "comment" ? (item.authorName || "Anonymous") : (item.createdByName || "System")),
          h("span", { className: "rw-timeline-date" }, formatDate(item.createdAt)),
        ]);
        var cardBody;
        if (item.kind === "comment") {
          cardBody = h("div", { className: "rw-timeline-body" }, item.body);
        } else {
          cardBody = h("div", { className: "rw-timeline-activity" }, renderActivityLabel(item));
        }
        var card = h("div", { className: "rw-timeline-card" }, [cardHeader, cardBody]);
        var timelineItem = h("div", { className: "rw-timeline-item" }, [
          h("div", { className: "rw-timeline-line" }),
          h("div", { className: dotClass }),
          card,
        ]);
        timelineEl.appendChild(timelineItem);
      });
      container.appendChild(timelineEl);
    }

    return container;
  }

  function renderTicketEdit(data) {
    var ticket = data.ticket;
    var container = h("div", { className: "rw-detail" });
    var pendingDeletes = []; // attachment IDs to delete on save
    var pendingUploads = []; // File objects to upload on save

    // Back button (goes back to detail, not list)
    var backBtn = h("button", {
      className: "rw-back-btn",
      onClick: function () { showTicketDetail(ticket.id); },
    }, [
      h("svg", { width: "14", height: "14", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round" }, [
        h("path", { d: "M19 12H5" }),
        h("path", { d: "M12 19l-7-7 7-7" }),
      ]),
      h("span", null, "Cancel editing"),
    ]);
    container.appendChild(backBtn);

    container.appendChild(h("div", { className: "rw-section-label", style: "padding-left: 0;" }, "Edit Ticket"));

    var noticeArea = h("div", null);
    container.appendChild(noticeArea);

    // Title input
    var titleInput = h("input", {
      className: "rw-input",
      type: "text",
      value: ticket.title || "",
      placeholder: "Title",
      maxlength: "200",
    });

    // Description textarea
    var descInput = h("textarea", {
      className: "rw-input rw-textarea",
      placeholder: "Description",
      maxlength: "2000",
    });
    descInput.value = ticket.description || "";

    // Existing attachments with remove buttons
    var existingAttachEl = h("div", { className: "rw-edit-attachments" });
    var existingAttachments = (ticket.attachments || []).slice();
    function renderExistingAttachments() {
      existingAttachEl.innerHTML = "";
      existingAttachments.forEach(function (att) {
        if (pendingDeletes.indexOf(att.id) !== -1) return;
        if (!att.url || !att.mimeType || att.mimeType.indexOf("image/") !== 0) return;
        var item = h("div", { className: "rw-edit-attach-item" }, [
          h("img", { className: "rw-edit-attach-img", src: att.url, alt: att.originalName || "attachment" }),
          h("button", {
            className: "rw-edit-attach-remove",
            onClick: function () {
              pendingDeletes.push(att.id);
              renderExistingAttachments();
            },
          }, "\u00d7"),
        ]);
        existingAttachEl.appendChild(item);
      });
    }
    renderExistingAttachments();

    // New file upload area
    var newFileInput = h("input", { type: "file", accept: "image/*", multiple: "true", style: "display:none" });
    var newPreview = h("div", { className: "rw-attach-preview" });

    function addNewFiles(files) {
      var currentCount = existingAttachments.length - pendingDeletes.length + pendingUploads.length;
      Array.prototype.forEach.call(files, function (file) {
        if (!file.type.startsWith("image/")) return;
        if (currentCount >= 5) return;
        pendingUploads.push(file);
        currentCount++;
        var reader = new FileReader();
        reader.onload = function (e) {
          var thumb = h("div", { className: "rw-edit-attach-item" }, [
            h("img", { className: "rw-edit-attach-img", src: e.target.result }),
            h("button", {
              className: "rw-edit-attach-remove",
              onClick: function () {
                var idx = pendingUploads.indexOf(file);
                if (idx > -1) pendingUploads.splice(idx, 1);
                thumb.remove();
              },
            }, "\u00d7"),
          ]);
          newPreview.appendChild(thumb);
        };
        reader.readAsDataURL(file);
      });
    }

    var addBtn = h("button", {
      className: "rw-edit-btn",
      style: "margin-bottom: 10px;",
      onClick: function () { newFileInput.click(); },
    }, "+ Add images");
    newFileInput.addEventListener("change", function () { addNewFiles(newFileInput.files); newFileInput.value = ""; });

    var saveBtn = h("button", { className: "rw-save-btn" }, "Save changes");
    var cancelBtn = h("button", {
      className: "rw-cancel-btn",
      onClick: function () { showTicketDetail(ticket.id); },
    }, "Cancel");

    saveBtn.addEventListener("click", function () {
      var newTitle = titleInput.value.trim();
      var newDesc = descInput.value.trim();
      if (!newTitle && !newDesc) {
        noticeArea.innerHTML = "";
        noticeArea.appendChild(renderNotice("error", "Title or description is required."));
        return;
      }
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving\u2026";
      noticeArea.innerHTML = "";

      // 1. Update title/description
      var chain = updateTicket(ticket.id, {
        title: newTitle || undefined,
        description: newDesc,
      });

      // 2. Delete removed attachments
      pendingDeletes.forEach(function (attId) {
        chain = chain.then(function () { return deleteAttachmentApi(ticket.id, attId); });
      });

      // 3. Upload new attachments
      if (pendingUploads.length > 0) {
        saveBtn.textContent = "Uploading\u2026";
        pendingUploads.forEach(function (file) {
          chain = chain.then(function () { return uploadAttachment(ticket.id, file); });
        });
      }

      chain.then(function () {
        ticketsCache = null;
        mySubmissionsCountCache = null;
        showTicketDetail(ticket.id);
      }).catch(function (err) {
        noticeArea.innerHTML = "";
        noticeArea.appendChild(renderNotice("error", "Failed to save: " + err.message));
        saveBtn.disabled = false;
        saveBtn.textContent = "Save changes";
      });
    });

    var form = h("div", { className: "rw-edit-form" }, [
      titleInput,
      descInput,
      existingAttachEl,
      newPreview,
      addBtn,
      newFileInput,
      h("div", { className: "rw-edit-form-actions" }, [saveBtn, cancelBtn]),
    ]);
    container.appendChild(form);

    return container;
  }

  // ---------------------------------------------------------------------------
  // Unified panel body: form at top + proposals below
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Inline feedback form
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Duration, stats, tabs, my-submissions renderers
  // ---------------------------------------------------------------------------

  function handleTabChange(tab) {
    activeTab = tab;
    var isIdentified = !!config.isIdentified;
    if (tab === "updates") showUpdatesView(isIdentified);
    else if (tab === "mine") showMySubmissionsView(isIdentified);
    else renderCurrentTab(isIdentified);
  }

  function formatDuration(ms) {
    if (!ms || ms <= 0) return "";
    var hours = Math.floor(ms / 3600000);
    var days = Math.floor(hours / 24);
    var remainHours = hours % 24;
    if (days > 0) return days + "d " + remainHours + "h";
    if (hours > 0) return hours + "h";
    return "<1h";
  }

  function renderStats(stats) {
    if (!stats || !stats.avgResolutionMs) return null;
    return h("div", { className: "rw-stats-banner" }, [
      h("span", null, "Avg resolution: " + formatDuration(stats.avgResolutionMs)),
      h("span", { className: "rw-stats-sep" }, "\u00b7"),
      h("span", null, stats.totalResolved + " resolved"),
    ]);
  }

  function renderTabs(onTabChange, myCount, isIdentified) {
    var updatesBtn = h("button", {
      className: "rw-tab-btn" + (activeTab === "updates" ? " rw-tab-active" : ""),
      onClick: function () { onTabChange("updates"); },
    }, "Updates");
    var allBtn = h("button", {
      className: "rw-tab-btn" + (activeTab === "all" ? " rw-tab-active" : ""),
      onClick: function () { onTabChange("all"); },
    }, "Recent Tickets");
    var mineChildren = [h("span", null, "My Tickets")];
    if (myCount != null && myCount > 0) {
      mineChildren.push(h("span", { className: "rw-tab-badge" }, String(myCount)));
    }
    var mineBtnAttrs = {
      className: "rw-tab-btn" + (activeTab === "mine" ? " rw-tab-active" : ""),
      onClick: function () { if (isIdentified) onTabChange("mine"); },
    };
    if (!isIdentified) {
      mineBtnAttrs.disabled = true;
      mineBtnAttrs.title = "Log in to view your tickets";
    }
    var mineBtn = h("button", mineBtnAttrs, mineChildren);
    return h("div", { className: "rw-tabs" }, [updatesBtn, allBtn, mineBtn]);
  }

  function renderMySubmissions(tickets) {
    if (!tickets || tickets.length === 0) {
      return renderEmpty("You haven't submitted any tickets yet.");
    }
    var container = h("div", null);
    tickets.forEach(function (p) {
      var statusText, statusColor;
      if (p.moderationStatus === "pending") {
        statusText = "Awaiting review"; statusColor = "#f59e0b";
      } else if (p.status === "pending") {
        statusText = "Pending"; statusColor = "#f59e0b";
      } else if (p.status === "planned") {
        statusText = "Planned"; statusColor = "#3b82f6";
      } else if (p.status === "in_progress") {
        statusText = "In Progress"; statusColor = "#8b5cf6";
      } else if (p.status === "needs_review") {
        statusText = "Needs Review"; statusColor = "#f59e0b";
      } else if (p.status === "done") {
        statusText = "Done"; statusColor = "#10b981";
      } else if (p.status === "cancelled") {
        statusText = "Cancelled"; statusColor = "#6b7280";
      } else {
        statusText = p.status; statusColor = "#6b7280";
      }
      var badge = h("span", {
        className: "rw-status-badge",
        style: "color:" + statusColor + ";background:" + statusColor + "1a",
      }, statusText);
      var dateStr = p.createdAt ? new Date(p.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";
      var metaItems = [badge];
      if (p.moderationStatus !== "pending") {
        metaItems.push(h("span", { className: "rw-vote-counts" }, p.yesVotes + " yes / " + p.noVotes + " no"));
      }
      if (dateStr) {
        metaItems.push(h("span", { className: "rw-submission-date" }, dateStr));
      }
      var meta = h("div", { className: "rw-submission-meta" }, metaItems);
      var cardChildren = [
        h("div", { className: "rw-submission-title" }, p.title),
      ];
      if (p.description) {
        cardChildren.push(h("div", { className: "rw-submission-desc" }, p.description));
      }
      cardChildren.push(meta);
      var card = h("div", {
        className: "rw-submission-card",
        onClick: (function (ticketId) {
          return function () { showTicketDetail(ticketId); };
        })(p.id),
      }, cardChildren);
      container.appendChild(card);
    });
    return container;
  }

  // ---------------------------------------------------------------------------
  // Unified panel body: action buttons + proposals
  // ---------------------------------------------------------------------------

  function renderLoginPrompt() {
    return h("div", { className: "rw-login-prompt" }, [
      h("span", null, "Log in to submit tickets and vote"),
    ]);
  }

  function renderTicketList(proposals) {
    var container = h("div", null);

    if (!proposals || proposals.length === 0) {
      container.appendChild(renderEmpty("No tickets yet."));
    } else {
      var open = proposals.filter(function (p) {
        return p.status !== "done" && p.status !== "cancelled";
      });

      if (open.length > 0) {
        open.forEach(function (p) {
          container.appendChild(renderTicket(p));
        });
      } else {
        container.appendChild(renderEmpty("No active tickets."));
      }
    }

    // --- Show more link ---
    var showMoreLink = h("a", {
      className: "rw-show-more",
      href: (config.homepageUrl || RUNHQ_API) + "/project/" + (config.projectId || config.project),
      target: "_blank",
      rel: "noopener noreferrer",
    }, "Show more \u2192");
    container.appendChild(showMoreLink);

    return container;
  }

  function renderInlineForm(onSubmit) {
    var noticeContainer = h("div", null);

    var descInput = h("textarea", {
      className: "rw-input rw-textarea rw-inline-textarea",
      placeholder: "Write your feedback, proposal, or bug report here\u2026",
      maxlength: "2000",
    });

    // --- File attach ---
    var attachedFiles = [];
    var fileInput = h("input", { type: "file", accept: "image/*", multiple: "true", style: "display:none" });
    var previewContainer = h("div", { className: "rw-attach-preview" });

    function addFiles(files) {
      Array.prototype.forEach.call(files, function (file) {
        if (!file.type.startsWith("image/")) return;
        if (attachedFiles.length >= 5) return;
        attachedFiles.push(file);
        var reader = new FileReader();
        reader.onload = function (e) {
          var thumb = h("div", { className: "rw-attach-thumb" }, [
            h("img", { src: e.target.result }),
          ]);
          var removeBtn = h("button", { className: "rw-attach-remove" }, "\u00d7");
          removeBtn.addEventListener("click", function (ev) {
            ev.stopPropagation();
            var i = attachedFiles.indexOf(file);
            if (i > -1) attachedFiles.splice(i, 1);
            thumb.remove();
          });
          thumb.appendChild(removeBtn);
          previewContainer.appendChild(thumb);
        };
        reader.readAsDataURL(file);
      });
    }

    var attachSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    attachSvg.setAttribute("width", "18");
    attachSvg.setAttribute("height", "18");
    attachSvg.setAttribute("viewBox", "0 0 24 24");
    attachSvg.setAttribute("fill", "none");
    attachSvg.setAttribute("stroke", "currentColor");
    attachSvg.setAttribute("stroke-width", "2");
    attachSvg.setAttribute("stroke-linecap", "round");
    attachSvg.setAttribute("stroke-linejoin", "round");
    var attachPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    attachPath.setAttribute("d", "M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48");
    attachSvg.appendChild(attachPath);
    var attachBtn = h("button", { className: "rw-attach-btn", type: "button" }, attachSvg);
    attachBtn.addEventListener("click", function () { fileInput.click(); });
    fileInput.addEventListener("change", function () { addFiles(fileInput.files); fileInput.value = ""; });

    // Paste support on textarea
    descInput.addEventListener("paste", function (e) {
      if (e.clipboardData && e.clipboardData.files && e.clipboardData.files.length > 0) {
        addFiles(e.clipboardData.files);
      }
    });

    // Ctrl+Enter / Cmd+Enter to submit
    descInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        submitBtn.click();
      }
    });

    // --- Submit button ---
    var submitBtn = h("button", { className: "rw-inline-submit", type: "button" }, "Submit");
    submitBtn.addEventListener("click", function () {
      var description = descInput.value.trim();
      if (!description) {
        noticeContainer.innerHTML = "";
        noticeContainer.appendChild(renderNotice("error", "Please describe your feedback."));
        descInput.focus();
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = "Posting\u2026";
      noticeContainer.innerHTML = "";

      var context = {
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

      onSubmit({
        description: description,
        type: "feedback",
        context: context,
        isPrivate: privateCheckbox.checked,
      }).then(function (result) {
        var ticketId = result && result.ticket && result.ticket.id;
        if (!ticketId || attachedFiles.length === 0) return result;
        // Upload attachments sequentially
        submitBtn.textContent = "Uploading files\u2026";
        var chain = Promise.resolve();
        attachedFiles.forEach(function (file) {
          chain = chain.then(function () { return uploadAttachment(ticketId, file); });
        });
        return chain;
      }).then(function () {
        descInput.value = "";
        privateCheckbox.checked = false;
        attachedFiles.length = 0;
        previewContainer.innerHTML = "";
        noticeContainer.innerHTML = "";
        noticeContainer.appendChild(renderNotice("success", "Thanks for your feedback!"));
        submitBtn.disabled = false;
        submitBtn.textContent = "Submit";
        // Refresh proposals
        ticketsCache = null;
        showPanelView();
      }).catch(function (err) {
        noticeContainer.innerHTML = "";
        noticeContainer.appendChild(renderNotice("error", "Failed to submit: " + err.message));
        submitBtn.disabled = false;
        submitBtn.textContent = "Submit";
      });
    });

    var privateCheckbox = h("input", { type: "checkbox", id: "rw-private-cb" });
    var privateLabel = h("label", { className: "rw-private-label", htmlFor: "rw-private-cb" }, [
      privateCheckbox,
      h("span", null, "private"),
    ]);

    var bottomRight = h("div", { className: "rw-inline-bottom-right" }, [
      privateLabel,
      submitBtn,
    ]);

    var bottomRow = h("div", { className: "rw-inline-bottom" }, [
      attachBtn,
      bottomRight,
    ]);

    var formChildren = [noticeContainer, descInput, previewContainer, bottomRow, fileInput];

    var form = h("div", { className: "rw-inline-form" }, formChildren);

    // Drag-and-drop on the whole form
    form.addEventListener("dragover", function (e) { e.preventDefault(); form.classList.add("rw-dragover"); });
    form.addEventListener("dragleave", function () { form.classList.remove("rw-dragover"); });
    form.addEventListener("drop", function (e) { e.preventDefault(); form.classList.remove("rw-dragover"); addFiles(e.dataTransfer.files); });

    return form;
  }

  // ---------------------------------------------------------------------------
  // Panel body: load & render
  // ---------------------------------------------------------------------------

  var ticketsCache = null;
  var mySubmissionsCountCache = null;

  function setBodyContent(el) {
    panelBodyEl.innerHTML = "";
    panelBodyEl.appendChild(el);
    panelBodyEl.scrollTop = 0;
  }

  function showPanelView() {
    var isIdentified = !!config.isIdentified;

    function loadMyCount() {
      if (isIdentified && mySubmissionsCountCache == null) {
        loadMySubmissions().then(function (mineData) {
          mySubmissionsCountCache = (mineData.tickets || []).length;
          if (activeTab === "all") renderCurrentTab(isIdentified);
        }).catch(function () {});
      }
    }

    if (ticketsCache) {
      headerTitleEl.textContent = "Help us improve " + (config.projectName || config.projectId);
      renderCurrentTab(isIdentified);
      loadMyCount();
      return;
    }
    setBodyContent(renderLoading());
    loadTickets().then(function (data) {
      ticketsCache = data.tickets || [];
      if (data.projectName) {
        config.projectName = data.projectName;
        headerTitleEl.textContent = "Help us improve " + data.projectName;
      }
      renderCurrentTab(isIdentified);
      loadMyCount();
    }).catch(function (err) {
      setBodyContent(renderNotice("error", "Could not load proposals: " + err.message));
    });
  }

  function renderCurrentTab(isIdentified) {
    var container = h("div", null);
    var statsBanner = renderStats(statsCache);
    if (statsBanner) container.appendChild(statsBanner);

    // --- Action buttons or login prompt ---
    if (isIdentified) {
      container.appendChild(renderInlineForm(submitSuggestion));
    } else {
      container.appendChild(renderLoginPrompt());
    }

    // --- Divider ---
    container.appendChild(h("hr", { className: "rw-divider" }));

    // --- Tabs (below action buttons) ---
    if (isIdentified) {
      container.appendChild(renderTabs(function (tab) {
        activeTab = tab;
        if (tab === "mine") {
          showMySubmissionsView(isIdentified);
        } else {
          renderCurrentTab(isIdentified);
        }
      }, mySubmissionsCountCache));
    }

    if (activeTab === "all") {
      var panelContent = renderTicketList(ticketsCache);
      while (panelContent.firstChild) {
        container.appendChild(panelContent.firstChild);
      }
    }
    setBodyContent(container);
  }

  function showMySubmissionsView(isIdentified) {
    setBodyContent(renderLoading());
    loadMySubmissions().then(function (data) {
      var myTickets = data.tickets || [];
      mySubmissionsCountCache = myTickets.length;

      var wrap = h("div", null);
      var statsBanner = renderStats(statsCache);
      if (statsBanner) wrap.appendChild(statsBanner);

      // --- Inline form ---
      if (isIdentified) {
        wrap.appendChild(renderInlineForm(submitSuggestion));
      }

      // --- Divider ---
      wrap.appendChild(h("hr", { className: "rw-divider" }));

      // --- Tabs ---
      wrap.appendChild(renderTabs(function (tab) {
        activeTab = tab;
        if (tab === "all") {
          renderCurrentTab(isIdentified);
        } else {
          showMySubmissionsView(isIdentified);
        }
      }, mySubmissionsCountCache));

      wrap.appendChild(renderMySubmissions(myTickets));
      setBodyContent(wrap);
    }).catch(function (err) {
      setBodyContent(renderNotice("error", "Could not load submissions: " + err.message));
    });
  }

  // ---------------------------------------------------------------------------
  // Panel open/close
  // ---------------------------------------------------------------------------

  function openPanel() {
    if (isOpen) return;
    isOpen = true;
    panelEl.classList.add("rw-open");
    overlayEl.classList.add("rw-visible");
    tabEl.classList.add("rw-open");
    showPanelView();
  }

  function closePanel() {
    if (!isOpen) return;
    isOpen = false;
    panelEl.classList.remove("rw-open");
    overlayEl.classList.remove("rw-visible");
    tabEl.classList.remove("rw-open");
  }

  // ---------------------------------------------------------------------------
  // Mount DOM
  // ---------------------------------------------------------------------------

  function mountDOM() {
    var isRight = config.position === "right";

    // Tab
    tabEl = h("div", {
      className: "rw-tab",
      role: "button",
      tabindex: "0",
      "aria-label": "Open RunHQ Widget panel",
      onClick: function () { isOpen ? closePanel() : openPanel(); },
      onKeydown: function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); isOpen ? closePanel() : openPanel(); } },
    }, "SUBMIT A TICKET");

    // Apply offset (vertical position)
    if (config.offset === "auto") {
      // Bottom position — horizontal tab along the bottom edge
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
      tabEl.style.borderRadius = "8px 8px 0 0";
    } else if (config.offset != null) {
      tabEl.style.top = config.offset;
      tabEl.style.transform = "none";
    }

    // Overlay
    overlayEl = h("div", { className: "rw-overlay", onClick: closePanel });

    // Header (title gets updated when project name loads)
    headerTitleEl = h("strong", null, "Help us improve " + (config.projectName || config.projectId || ""));
    var poweredByEl = h("span", { className: "rw-powered" }, [
      document.createTextNode("powered by "),
      h("a", { href: (config.homepageUrl || RUNHQ_API) + "/project/" + (config.projectId || config.project), target: "_blank", rel: "noopener noreferrer" }, "RunHQWidget"),
    ]);
    var header = h("div", { className: "rw-header" }, [
      h("div", { className: "rw-header-title" }, [
        headerTitleEl,
        poweredByEl,
      ]),
      h("button", {
        className: "rw-close-btn",
        "aria-label": "Close panel",
        onClick: closePanel,
      }, [
        // ✕ icon via SVG
        (function () {
          var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
          svg.setAttribute("width", "18");
          svg.setAttribute("height", "18");
          svg.setAttribute("viewBox", "0 0 24 24");
          svg.setAttribute("fill", "none");
          svg.setAttribute("stroke", "currentColor");
          svg.setAttribute("stroke-width", "2");
          svg.setAttribute("stroke-linecap", "round");
          var l1 = document.createElementNS("http://www.w3.org/2000/svg", "line");
          l1.setAttribute("x1", "18"); l1.setAttribute("y1", "6"); l1.setAttribute("x2", "6"); l1.setAttribute("y2", "18");
          var l2 = document.createElementNS("http://www.w3.org/2000/svg", "line");
          l2.setAttribute("x1", "6"); l2.setAttribute("y1", "6"); l2.setAttribute("x2", "18"); l2.setAttribute("y2", "18");
          svg.appendChild(l1);
          svg.appendChild(l2);
          return svg;
        })(),
      ]),
    ]);

    // Body
    panelBodyEl = h("div", { className: "rw-body" });

    // Panel
    panelEl = h("div", { className: "rw-panel", role: "dialog", "aria-modal": "true", "aria-label": "RunHQWidget" }, [
      header,
      panelBodyEl,
    ]);

    document.body.appendChild(overlayEl);
    document.body.appendChild(panelEl);
    document.body.appendChild(tabEl);

    // Close on Escape
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && isOpen) closePanel();
    });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

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

      // Load config from API (position, project name), then mount
      loadTickets().then(function (data) {
        ticketsCache = data.tickets || [];
        config.projectId = data.projectSlug || config.project;
        config.homepageUrl = data.homepageUrl || RUNHQ_API;
        config.projectName = data.projectName || config.project;
        // Parse compound position like "middle-right", "bottom-right", "top-left"
        var pos = (data.position || "middle-right").split("-");
        var vPos = pos[0] || "middle"; // top, middle, bottom
        var hPos = pos[1] || "right";  // left, right
        config.position = hPos;
        config.offset = vPos === "bottom" ? "auto" : vPos === "top" ? "80px" : null;
        config.isIdentified = data.isIdentified || false;
        config.theme = resolveTheme(opts.theme || "auto");
        if (data.stats) statsCache = data.stats;
        injectStyles(config.theme, config.position);
        mountDOM();
      }).catch(function (err) {
        console.error("RunHQWidget: failed to initialize", err);
      });
    },
  };

})();
