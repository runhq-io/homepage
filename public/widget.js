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
  var activeTab = "updates"; // "updates" | "hot" | "mine"  — every open lands here (see closePanel reset)
  var theme = "light";

  var topTicketsCache = null;   // /api/widget/tickets        — drives "Hot" tab + recent-others list
  var updatesCache = null;      // /api/widget/tickets/updates — drives "Updates" tab + tab-label badge
  var myTicketsCache = null;    // /api/widget/tickets/mine    — drives "My Tickets" tab
  var activeModal = null;       // for the image lightbox only (inline composer + detail replace the old new-ticket / detail modals)

  // Current authenticated user info, populated after auth via /api/widget/me.
  // Always present as an object so reads never throw — defaults to anonymous.
  var currentUser = { permissions: [], matchedRoles: [], isTriager: false };

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

  function loadMe()               { return api("/api/widget/me"); }
  function loadTopTickets()       { return api("/api/widget/tickets"); }
  function loadUpdates()          { return api("/api/widget/tickets/updates"); }
  function loadMyTickets()        { return api("/api/widget/tickets/mine"); }
  function loadTicketDetail(id)   { return api("/api/widget/tickets/" + encodeURIComponent(id)); }
  function createTicket(data)     { return api("/api/widget/tickets", { method: "POST", body: data }); }
  function updateTicket(ticketId, data) { return api("/api/widget/tickets/" + encodeURIComponent(ticketId), { method: "PATCH", body: data }); }
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

  // Fetch the current authenticated user's profile from /api/widget/me and
  // update currentUser. Safe for anonymous callers — 401/404 resolve to empty.
  // After updating state, re-renders the panel body so the triager badge
  // appears/disappears without requiring a full widget reload.
  function fetchAndApplyMe() {
    if (!config.token) {
      currentUser.permissions = [];
      currentUser.matchedRoles = [];
      currentUser.isTriager = false;
      return;
    }
    loadMe().then(function (me) {
      currentUser.permissions = (me && me.permissions) || [];
      currentUser.matchedRoles = (me && me.matchedRoles) || [];
      currentUser.isTriager = !!(me && me.isTriager);
      // Re-render so the badge appears/disappears in the eyebrow row.
      if (scrollEl) renderPanelBody();
    }).catch(function () {
      currentUser.permissions = [];
      currentUser.matchedRoles = [];
      currentUser.isTriager = false;
      // No re-render needed on failure — badge defaults to hidden.
    });
  }

  // ===========================================================================
  // DOM helper
  // ===========================================================================

  var SVG_NS = "http://www.w3.org/2000/svg";
  var SVG_TAGS = {
    svg: 1, path: 1, circle: 1, rect: 1, line: 1, polyline: 1, polygon: 1, g: 1,
    defs: 1, filter: 1,
    feTurbulence: 1, feDisplacementMap: 1, feGaussianBlur: 1, feColorMatrix: 1,
    animate: 1, animateTransform: 1,
    radialGradient: 1, stop: 1, clipPath: 1,
  };

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
    globe:     function (s) { return icon([{ tag: "circle", cx: 12, cy: 12, r: 10 }, { d: "M2 12h20" }, { d: "M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" }], s); },
  };

  // ===========================================================================
  // i18n
  //
  // The active locale is set from the bootstrap response (config.language,
  // populated from widget_projects.widget_language on the server). The
  // status registry (window.__RW_CONSTANTS__.status) supplies its own
  // `label` strings — those aren't translated here; widget settings can
  // override them per project independently.
  //
  // Adding a new locale = one new key in LOCALES. Missing keys fall back
  // to en. Strings can interpolate {placeholders} via the second arg to t().
  // ===========================================================================

  var LOCALES = {
    en: {
      aria: {
        openPanel: "Open feedback panel",
        close: "Close",
        upvote: "Upvote",
        upvoteSignedOut: "Sign in to vote",
        openTicket: "Open ticket: {title}",
        removeAttach: "Remove attachment",
        remove: "Remove",
      },
      header: {
        feedback: "{name} Feedback",
        // Headline is just the project name. The eyebrow renders it
        // alongside the brand-locked "powered by RunHQ" link.
        headline: "{name}",
        // Sub-text is rendered as: [subBefore]<em>{subEm}</em>[subAfter].
        // Explains the WHY of the widget — that the team treats user
        // feedback as direct input into the roadmap. Reads as a brief
        // value statement, not a checklist.
        subBefore: "We use feedback like yours to rapidly improve {name}.",
        subEm: "",
        subAfter: "",
        thisProduct: "this product",
      },
      composer: {
        // Placeholder picks up the prompt that used to live above the
        // textarea — moves the call-to-action onto the input itself,
        // freeing the sub-text above for the product-value pitch.
        placeholder: "Bugs, ideas, suggestions — please write them here.",
        attach: "Attach",
        // Visibility toggle uses two distinct labels (Private / Public)
        // rather than a single "Private" pill that lights up — the label
        // swap reads as a state change at a glance.
        private: "Private",
        public: "Public",
        privateOn: "Only you will see this.",
        privateOff: "Others can see and upvote this.",
        submit: "Submit",
        posting: "Posting…",
        uploading: "Uploading…",
        needSignIn: "You must be signed in to submit a ticket.",
        failed: "Failed to submit: {msg}",
        pastedImage: "Pasted image",
      },
      others: { label: "Recent Submissions", empty: "No tickets yet." },
      tabs: { updates: "Latest Updates", hot: "Hot", mine: "My Submissions" },
      // Mirrors the canonical TodoStatus vocabulary in @runhq/server-protocol.
      // Colors come from the registry (window.__RW_CONSTANTS__.status); only
      // labels are locale-overridable here.
      status: {
        pending: "Pending",
        planned: "Planned",
        in_progress: "In progress",
        needs_review: "Needs review",
        done: "Done",
        deployed: "Deployed",
        cancelled: "Cancelled",
      },
      visibility: {
        private: "Private",
        public: "Public",
        privateTooltip: "Only you can see this. Click to make it public.",
        publicTooltip: "Anyone can see this. Click to make it private.",
        failed: "Couldn't update visibility — try again.",
      },
      empty: {
        noTickets: "No tickets yet",
        beFirst: "Be the first to share feedback.",
        signInToSeeMine: "Sign in to see your tickets",
        signedInPlaceholder: "Your submissions appear here once you're identified.",
        noMineYet: "You haven't submitted any tickets yet",
        useComposer: "Use the composer on the left to file one.",
        nothingShipped: "Nothing shipped recently",
        updatesWillShow: "Updates will show up here as tickets are resolved.",
      },
      list: { loadFailed: "Could not load tickets: {msg}" },
      detail: {
        loadFailed: "Could not load ticket: {msg}",
        back: "Back to activity",
        original: "Original report",
        shipped: "shipped {when}",
        activity: "Activity",
        activityCount: "Activity · {n} {plural}",
        commentSingular: "comment",
        commentPlural: "comments",
        noActivity: "No activity yet.",
      },
      reply: {
        signInPlaceholder: "Sign in to reply",
        disabledPlaceholder: "Comments are disabled",
        placeholder: "Write a comment…  (⌘V to paste a screenshot)",
        hint: "Paste screenshots with ⌘V",
        submit: "Comment",
        posting: "Posting…",
        uploading: "Uploading…",
        failed: "Failed to post: {msg}",
        signInPrompt: "Sign in to post a comment.",
        disabledPrompt: "Comments are disabled on this ticket.",
      },
      theme: {
        dark: "Dark mode",
        light: "Light mode",
        switchToDark: "Switch to dark mode",
        switchToLight: "Switch to light mode",
      },
      timeAgo: { now: "just now", s: "{n}s ago", m: "{n}m ago", h: "{n}h ago", d: "{n}d ago", mo: "{n}mo ago" },
      events: {
        statusChangeBoth: "status change [{from}] → [{to}]",
        statusChangeTo: "status change → [{to}]",
        changedStatus: "changed status",
        moderationChanged: "changed moderation to {to}",
        assigned: "assigned the ticket",
        assignedTo: "assigned the ticket to {to}",
        unassigned: "unassigned the ticket",
        ticketCreated: "opened the ticket",
        ticketEdited: "edited the ticket",
        ticketDeleted: "deleted the ticket",
      },
    },
    ko: {
      aria: {
        openPanel: "피드백 패널 열기",
        close: "닫기",
        upvote: "추천",
        upvoteSignedOut: "추천하려면 로그인하세요",
        openTicket: "티켓 열기: {title}",
        removeAttach: "첨부 제거",
        remove: "제거",
      },
      header: {
        feedback: "{name} 피드백",
        // Headline is just the project name. The eyebrow renders it
        // alongside the brand-locked "powered by RunHQ" link, which
        // stays in English regardless of locale.
        headline: "{name}",
        // Korean drops the {name} interpolation — the eyebrow already
        // shows the product name, and Korean particle agreement (을/를,
        // 은/는) on a runtime-injected name reads as machine-translated.
        subBefore: "사용자 피드백을 반영해 제품을 빠르게 개선하고 있어요.",
        subEm: "",
        subAfter: "",
        thisProduct: "이 제품",
      },
      composer: {
        placeholder: "버그, 아이디어, 제안 — 여기에 자유롭게 적어주세요.",
        attach: "첨부",
        private: "비공개",
        public: "공개",
        privateOn: "본인에게만 표시됩니다.",
        privateOff: "다른 사용자가 보고 추천할 수 있습니다.",
        submit: "제출",
        posting: "게시 중…",
        uploading: "업로드 중…",
        needSignIn: "티켓을 제출하려면 로그인해야 합니다.",
        failed: "제출 실패: {msg}",
        pastedImage: "붙여넣은 이미지",
      },
      others: { label: "최근 제출 내역", empty: "아직 티켓이 없습니다." },
      tabs: { updates: "최신 업데이트", hot: "인기", mine: "내 제출 내역" },
      status: {
        pending: "대기 중",
        planned: "계획됨",
        in_progress: "진행 중",
        needs_review: "검토 필요",
        done: "완료",
        deployed: "배포됨",
        cancelled: "취소됨",
      },
      visibility: {
        private: "비공개",
        public: "공개",
        privateTooltip: "본인만 볼 수 있습니다. 클릭하면 공개로 전환됩니다.",
        publicTooltip: "누구나 볼 수 있습니다. 클릭하면 비공개로 전환됩니다.",
        failed: "공개 설정을 변경하지 못했습니다. 다시 시도해 주세요.",
      },
      empty: {
        noTickets: "아직 티켓이 없습니다",
        beFirst: "가장 먼저 피드백을 남겨보세요.",
        signInToSeeMine: "내 티켓을 보려면 로그인하세요",
        signedInPlaceholder: "로그인하시면 제출한 티켓이 여기에 표시됩니다.",
        noMineYet: "아직 제출한 티켓이 없습니다",
        useComposer: "왼쪽 입력창에서 새 티켓을 작성하세요.",
        nothingShipped: "최근 배포된 항목이 없습니다",
        updatesWillShow: "티켓이 해결되면 이곳에 표시됩니다.",
      },
      list: { loadFailed: "티켓을 불러올 수 없습니다: {msg}" },
      detail: {
        loadFailed: "티켓을 불러올 수 없습니다: {msg}",
        back: "활동으로 돌아가기",
        original: "최초 보고",
        shipped: "{when} 배포됨",
        activity: "활동",
        activityCount: "활동 · 댓글 {n}개",
        commentSingular: "댓글",
        commentPlural: "댓글",
        noActivity: "아직 활동이 없습니다.",
      },
      reply: {
        signInPlaceholder: "답글을 달려면 로그인하세요",
        disabledPlaceholder: "댓글이 비활성화되었습니다",
        placeholder: "댓글을 작성하세요…  (⌘V로 스크린샷 붙여넣기)",
        hint: "⌘V로 스크린샷 붙여넣기",
        submit: "댓글",
        posting: "게시 중…",
        uploading: "업로드 중…",
        failed: "게시 실패: {msg}",
        signInPrompt: "댓글을 작성하려면 로그인하세요.",
        disabledPrompt: "이 티켓의 댓글이 비활성화되었습니다.",
      },
      theme: {
        dark: "다크 모드",
        light: "라이트 모드",
        switchToDark: "다크 모드로 전환",
        switchToLight: "라이트 모드로 전환",
      },
      timeAgo: { now: "방금 전", s: "{n}초 전", m: "{n}분 전", h: "{n}시간 전", d: "{n}일 전", mo: "{n}개월 전" },
      events: {
        statusChangeBoth: "상태 변경 [{from}] → [{to}]",
        statusChangeTo: "상태 변경 → [{to}]",
        changedStatus: "상태를 변경했습니다",
        moderationChanged: "검토 상태를 {to}로 변경했습니다",
        assigned: "티켓을 할당했습니다",
        assignedTo: "티켓을 {to}에게 할당했습니다",
        unassigned: "티켓 할당을 해제했습니다",
        ticketCreated: "티켓을 열었습니다",
        ticketEdited: "티켓을 수정했습니다",
        ticketDeleted: "티켓을 삭제했습니다",
      },
    },
  };

  function t(path, vars) {
    var locale = LOCALES[config.language] || LOCALES.en;
    var resolve = function (root) {
      var node = root;
      var parts = path.split(".");
      for (var i = 0; i < parts.length; i++) {
        if (node == null) return null;
        node = node[parts[i]];
      }
      return node;
    };
    var s = resolve(locale);
    if (s == null && locale !== LOCALES.en) s = resolve(LOCALES.en);
    if (s == null) return path;
    if (vars && typeof s === "string") {
      s = s.replace(/\{(\w+)\}/g, function (m, k) {
        return vars[k] != null ? String(vars[k]) : m;
      });
    }
    return s;
  }

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
  // Locale-aware label resolver. The registry (window.__RW_CONSTANTS__.status)
  // owns the canonical vocabulary + colors; per-locale labels live in
  // LOCALES.{lang}.status. We use the locale label when it exists for the
  // active language, otherwise fall back to the registry's English label.
  function localizedStatusLabel(s) {
    var path = "status." + s;
    var localized = t(path);
    if (localized && localized !== path) return localized;
    var R = getStatusRegistry();
    return (R && R[s] && R[s].label) || null;
  }
  function statusMeta(s) {
    var R = getStatusRegistry();
    var entry = R && R[s];
    var localized = localizedStatusLabel(s);
    if (entry) {
      return { label: localized || entry.label, dot: entry.dot, bg: entry.bg, fg: entry.fg };
    }
    return {
      label: localized || String(s == null ? "unknown" : s),
      dot: STATUS_FALLBACK.dot, bg: STATUS_FALLBACK.bg, fg: STATUS_FALLBACK.fg,
    };
  }
  // Returns the display label for a status, or null if neither the locale
  // nor the registry has one. Used by activity-row formatting where we want
  // to omit the label rather than render a synthesized one.
  function statusLabel(s) {
    return localizedStatusLabel(s);
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
    // Mercury — gooey liquid-metal organism. A base circle plus six
    // perimeter-orbiting bulges share one SVG goo filter (Gaussian
    // blur + alpha-threshold matrix), so bulges that pass near the
    // edge stretch the silhouette outward like real liquid mercury.
    // Layered on top: an iridescent oil-slick rim (cyan + violet
    // radial glows orbiting at offset phases, screen-blended), an
    // inner roaming specular highlight, and a CSS-driven outer halo
    // that breathes in sync. All motion is CSS-keyframe driven so
    // prefers-reduced-motion can freeze it.
    return h("span", { className: "rw-tab-icon", "aria-hidden": "true" },
      h("span", { className: "rw-merc-blob" }, [
        h("span", { className: "rw-merc-halo" }),
        h("svg", { viewBox: "0 0 80 80", focusable: "false", overflow: "visible" }, [
          h("defs", null, [
            h("filter", { id: "rw-merc-goo", x: "-40%", y: "-40%", width: "180%", height: "180%" }, [
              h("feGaussianBlur", { in: "SourceGraphic", stdDeviation: "3.4" }),
              h("feColorMatrix", {
                values: "1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 24 -11",
              }),
            ]),
            h("radialGradient", { id: "rw-merc-fill", cx: "38%", cy: "28%", r: "80%" }, [
              h("stop", { offset: "0%",   "stop-color": "#ffffff" }),
              h("stop", { offset: "30%",  "stop-color": "#f4f0ff" }),
              h("stop", { offset: "58%",  "stop-color": "#cfd8ff" }),
              h("stop", { offset: "82%",  "stop-color": "#b9aaf0" }),
              h("stop", { offset: "100%", "stop-color": "#7d6dc8" }),
            ]),
            h("radialGradient", { id: "rw-merc-spec-grad", cx: "50%", cy: "50%", r: "50%" }, [
              h("stop", { offset: "0%",   "stop-color": "rgba(255,255,255,1)" }),
              h("stop", { offset: "60%",  "stop-color": "rgba(255,255,255,0.45)" }),
              h("stop", { offset: "100%", "stop-color": "rgba(255,255,255,0)" }),
            ]),
            h("radialGradient", { id: "rw-merc-cyan-grad", cx: "50%", cy: "50%", r: "50%" }, [
              h("stop", { offset: "0%",   "stop-color": "rgba(150,210,255,0.55)" }),
              h("stop", { offset: "100%", "stop-color": "rgba(150,210,255,0)" }),
            ]),
            h("radialGradient", { id: "rw-merc-violet-grad", cx: "50%", cy: "50%", r: "50%" }, [
              h("stop", { offset: "0%",   "stop-color": "rgba(180,130,255,0.45)" }),
              h("stop", { offset: "100%", "stop-color": "rgba(180,130,255,0)" }),
            ]),
            h("clipPath", { id: "rw-merc-inner-clip", clipPathUnits: "userSpaceOnUse" },
              h("circle", { cx: "40", cy: "40", r: "22" })
            ),
          ]),
          // Base + 6 bulges merge into a rippling liquid silhouette.
          h("g", { filter: "url(#rw-merc-goo)" }, [
            h("circle", { className: "rw-merc-base",         cx: "40", cy: "40", r: "18",  fill: "url(#rw-merc-fill)" }),
            h("circle", { className: "rw-merc-bulge rw-mb1", cx: "40", cy: "40", r: "9",   fill: "url(#rw-merc-fill)" }),
            h("circle", { className: "rw-merc-bulge rw-mb2", cx: "40", cy: "40", r: "8",   fill: "url(#rw-merc-fill)" }),
            h("circle", { className: "rw-merc-bulge rw-mb3", cx: "40", cy: "40", r: "9.5", fill: "url(#rw-merc-fill)" }),
            h("circle", { className: "rw-merc-bulge rw-mb4", cx: "40", cy: "40", r: "7.5", fill: "url(#rw-merc-fill)" }),
            h("circle", { className: "rw-merc-bulge rw-mb5", cx: "40", cy: "40", r: "6.5", fill: "url(#rw-merc-fill)" }),
            h("circle", { className: "rw-merc-bulge rw-mb6", cx: "40", cy: "40", r: "7",   fill: "url(#rw-merc-fill)" }),
          ]),
          // Iridescent rim — cyan + violet glows orbit at offset phases.
          h("g", { "clip-path": "url(#rw-merc-inner-clip)", style: { mixBlendMode: "screen" } }, [
            h("circle", { className: "rw-merc-tint rw-merc-cyan",   cx: "40", cy: "40", r: "14", fill: "url(#rw-merc-cyan-grad)" }),
            h("circle", { className: "rw-merc-tint rw-merc-violet", cx: "40", cy: "40", r: "14", fill: "url(#rw-merc-violet-grad)" }),
          ]),
          // Inner roaming specular highlight.
          h("g", { "clip-path": "url(#rw-merc-inner-clip)" },
            h("circle", { className: "rw-merc-spec", cx: "40", cy: "40", r: "5", fill: "url(#rw-merc-spec-grad)" })
          ),
        ]),
      ])
    );
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
      themeToggleBtn.setAttribute("aria-label", theme === "light" ? t("theme.switchToDark") : t("theme.switchToLight"));
      themeToggleBtn.setAttribute("title", theme === "light" ? t("theme.dark") : t("theme.light"));
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
    fontLink.href = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap";
    document.head.appendChild(preconnect1);
    document.head.appendChild(preconnect2);
    document.head.appendChild(fontLink);
  }

  function injectStyles(position, target) {
    var isRight = position === "right";

    var css = [
      /* Modern SaaS palette (Linear/zinc-style). Display & body are both
         Inter; --rw-serif is kept as a token name for compatibility but it
         points at the same Inter stack — there are no serif faces left. */
      '.rw-stage[data-theme="light"], .rw-modal-mount[data-theme="light"] {',
      '  --rw-bg: #ffffff; --rw-panel: #fafafa; --rw-panel-2: #f4f4f5; --rw-panel-3: #e4e4e7;',
      '  --rw-line: rgba(0,0,0,0.07); --rw-line-2: rgba(0,0,0,0.13);',
      '  --rw-fg: #0a0a0a; --rw-fg-2: #3f3f46; --rw-muted: #71717a; --rw-muted-2: #a1a1aa;',
      '  --rw-accent: #6366f1; --rw-accent-ink: #ffffff;',
      '  --rw-serif: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;',
      '}',
      /* Warm charcoal dark — matches dashboard.css. */
      '.rw-stage[data-theme="dark"], .rw-modal-mount[data-theme="dark"] {',
      '  --rw-bg: #1f1a14; --rw-panel: #2a231b; --rw-panel-2: #251f17; --rw-panel-3: #2f2820;',
      '  --rw-line: rgba(255,243,219,0.08); --rw-line-2: rgba(255,243,219,0.14);',
      '  --rw-fg: #f0e9d9; --rw-fg-2: #c8c0ad; --rw-muted: #8e8676; --rw-muted-2: #6e6759;',
      '  --rw-accent: #818cf8; --rw-accent-ink: #1f1a14;',
      '  --rw-serif: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;',
      '}',

      '.rw-stage, .rw-modal-mount {',
      '  font-family: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;',
      '  font-feature-settings: "ss01", "cv11";',
      '  -webkit-font-smoothing: antialiased;',
      '  color: var(--rw-fg); font-size: 13px; line-height: 1.45;',
      '}',
      '.rw-stage *, .rw-stage *::before, .rw-stage *::after,',
      '.rw-modal-mount *, .rw-modal-mount *::before, .rw-modal-mount *::after { box-sizing: border-box; }',

      /* Side launcher — a violet pill that protrudes from the screen edge.
         The pill is brand-fixed (always violet) so it reads consistently
         across customer sites and across the widget's own light/dark
         themes; only the inner tab text/badge inherit theme tokens.
         Layered chrome: outer violet gradient → thin inner radial highlight
         (top-left bloom) → 1px white border via inset box-shadow. Together
         they give the pill an embossed, slightly liquid feel that pairs
         with the Mercury blob inside it. */
      '.rw-tab {',
      '  position: fixed; top: 50%;',
      '  ' + (isRight ? "right" : "left") + ': 0;',
      '  transform: translateY(-50%);',
      '  height: 48px; min-width: 72px;',
      '  padding: ' + (isRight ? "0 6px 0 12px" : "0 12px 0 6px") + ';',
      '  background:',
      '    radial-gradient(120% 180% at 30% -30%, rgba(255,255,255,0.18), rgba(255,255,255,0) 60%),',
      '    linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0)),',
      '    linear-gradient(180deg, #7c6dff 0%, #5e4cef 100%);',
      '  color: #ffffff;',
      '  cursor: pointer;',
      '  display: inline-flex; align-items: center; justify-content: center; gap: 6px;',
      '  font: inherit; font-size: 14px; font-weight: 600; letter-spacing: 0.02em;',
      '  border: none;',
      /* Round only the protruding edge so the pill reads as a tab anchored
         to the screen border. */
      '  border-radius: ' + (isRight ? "24px 0 0 24px" : "0 24px 24px 0") + ';',
      '  z-index: 2147483646;',
      '  transition: padding .15s ease, box-shadow .2s ease, filter .15s ease, transform .15s ease;',
      '  box-shadow: 0 14px 28px -10px rgba(108,89,255,0.55), inset 0 0 0 1px rgba(255,255,255,0.08);',
      '  user-select: none; -webkit-user-select: none;',
      '  white-space: nowrap;',
      '}',
      /* Hover slides the pill out a few pixels for affordance — direction
         depends on which edge we're attached to. The vertical anchor
         (translateY) is preserved so middle-anchored tabs stay centered. */
      '.rw-tab:hover { filter: brightness(1.06); padding-' + (isRight ? "left" : "right") + ': 16px; }',
      /* Top / bottom anchored variants override the default centered transform. */
      '.rw-tab--top    { top: 24px;    bottom: auto; transform: none; }',
      '.rw-tab--bottom { top: auto;    bottom: 24px; transform: none; }',

      /* ------------------------------------------------------------------
         Mercury launcher mark — see buildTabIcon() for the SVG composition.
         The icon container is just a positioning shell; .rw-merc-blob
         holds the violet drop-shadow + the absolutely-positioned halo
         layer behind the SVG. The SVG renders 80×80 viewBox into a 26×26
         box (scale ≈0.325), so all design-space pixel offsets in the
         keyframes below shrink proportionally on screen. */
      '.rw-tab-icon {',
      '  width: 26px; height: 26px;',
      '  flex: 0 0 auto;',
      '  display: inline-flex; align-items: center; justify-content: center;',
      '  position: relative;',
      '}',
      '.rw-merc-blob {',
      '  width: 26px; height: 26px;',
      '  position: relative;',
      '  border-radius: 50%;',
      '  filter: drop-shadow(0 2px 5px rgba(80,60,200,0.45));',
      '}',
      '.rw-merc-blob > svg {',
      '  display: block; width: 100%; height: 100%;',
      '  overflow: visible;',
      '  position: relative; z-index: 1;',
      '}',
      /* Outer breathing halo — soft violet bloom expanding outside the
         silhouette, gives the widget gravity in the surrounding UI. */
      '.rw-merc-halo {',
      '  position: absolute; inset: -45%;',
      '  border-radius: 50%;',
      '  background: radial-gradient(circle, rgba(180,165,255,0.45) 0%, rgba(180,165,255,0.12) 40%, transparent 65%);',
      '  animation: rw-merc-halo 4.8s ease-in-out infinite;',
      '  pointer-events: none;',
      '  z-index: 0;',
      '}',
      '@keyframes rw-merc-halo {',
      '  0%, 100% { opacity: 0.65; transform: scale(0.95); }',
      '  50%      { opacity: 1;    transform: scale(1.15); }',
      '}',
      /* Base circle subtly breathes so the silhouette is never static. */
      '.rw-merc-base {',
      '  transform-origin: 40px 40px;',
      '  animation: rw-merc-base 5.4s ease-in-out infinite;',
      '}',
      '@keyframes rw-merc-base {',
      '  0%, 100% { transform: scale(1); }',
      '  50%      { transform: scale(1.05); }',
      '}',
      /* Six bulges orbit at radii larger than the base circle, so each
         pass physically stretches the silhouette outward through the goo
         filter. Each gets its own keyframe + duration to keep the motion
         non-repeating to the eye. */
      '.rw-merc-bulge { transform-origin: 40px 40px; }',
      '.rw-mb1 { animation: rw-mb-a 3.6s ease-in-out infinite; }',
      '.rw-mb2 { animation: rw-mb-b 4.4s ease-in-out infinite; }',
      '.rw-mb3 { animation: rw-mb-c 3.2s ease-in-out infinite; }',
      '.rw-mb4 { animation: rw-mb-d 4.0s ease-in-out infinite; }',
      '.rw-mb5 { animation: rw-mb-e 3.8s ease-in-out infinite; }',
      '.rw-mb6 { animation: rw-mb-f 4.6s ease-in-out infinite; }',
      '@keyframes rw-mb-a {',
      '  0%   { transform: translate(20px, -2px)   scale(1.15); }',
      '  25%  { transform: translate(14px, 15px)   scale(0.95); }',
      '  50%  { transform: translate(-17px, 11px)  scale(1.2); }',
      '  75%  { transform: translate(-13px, -16px) scale(0.9); }',
      '  100% { transform: translate(20px, -2px)   scale(1.15); }',
      '}',
      '@keyframes rw-mb-b {',
      '  0%   { transform: translate(-18px, 10px) scale(1.0); }',
      '  33%  { transform: translate(10px, -18px) scale(1.25); }',
      '  66%  { transform: translate(17px, 14px)  scale(0.85); }',
      '  100% { transform: translate(-18px, 10px) scale(1.0); }',
      '}',
      '@keyframes rw-mb-c {',
      '  0%   { transform: translate(2px, -20px)  scale(1.1); }',
      '  25%  { transform: translate(18px, -9px)  scale(0.9); }',
      '  50%  { transform: translate(11px, 18px)  scale(1.2); }',
      '  75%  { transform: translate(-19px, 6px)  scale(1.0); }',
      '  100% { transform: translate(2px, -20px)  scale(1.1); }',
      '}',
      '@keyframes rw-mb-d {',
      '  0%   { transform: translate(15px, -11px)  scale(1.05); }',
      '  33%  { transform: translate(-15px, -10px) scale(1.15); }',
      '  66%  { transform: translate(3px, 19px)    scale(0.95); }',
      '  100% { transform: translate(15px, -11px)  scale(1.05); }',
      '}',
      '@keyframes rw-mb-e {',
      '  0%   { transform: translate(-9px, -17px) scale(1.0); }',
      '  50%  { transform: translate(9px, 17px)   scale(1.15); }',
      '  100% { transform: translate(-9px, -17px) scale(1.0); }',
      '}',
      '@keyframes rw-mb-f {',
      '  0%   { transform: translate(17px, 9px)   scale(0.95); }',
      '  50%  { transform: translate(-17px, -9px) scale(1.2); }',
      '  100% { transform: translate(17px, 9px)   scale(0.95); }',
      '}',
      /* Iridescent oil-slick rim — cyan + violet glows orbit at opposing
         phases inside the silhouette, screen-blended so colors shift
         subtly as they pass each other. */
      '.rw-merc-tint { transform-origin: 40px 40px; }',
      '.rw-merc-cyan   { animation: rw-merc-cyan   7.2s ease-in-out infinite; }',
      '.rw-merc-violet { animation: rw-merc-violet 7.2s ease-in-out infinite; }',
      '@keyframes rw-merc-cyan {',
      '  0%   { transform: translate(-8px, -6px); }',
      '  50%  { transform: translate(8px, 6px); }',
      '  100% { transform: translate(-8px, -6px); }',
      '}',
      '@keyframes rw-merc-violet {',
      '  0%   { transform: translate(8px, 6px); }',
      '  50%  { transform: translate(-8px, -6px); }',
      '  100% { transform: translate(8px, 6px); }',
      '}',
      /* Inner roaming specular — the catch-light, drifts inside the
         silhouette with a slight scale + opacity wobble for life. */
      '.rw-merc-spec {',
      '  transform-origin: 40px 40px;',
      '  animation: rw-merc-spec 6.4s ease-in-out infinite;',
      '  filter: blur(0.4px);',
      '}',
      '@keyframes rw-merc-spec {',
      '  0%   { transform: translate(-7px, -8px) scale(1);   opacity: 0.95; }',
      '  25%  { transform: translate(8px, -6px)  scale(1.2); opacity: 0.7; }',
      '  50%  { transform: translate(7px, 7px)   scale(0.9); opacity: 0.95; }',
      '  75%  { transform: translate(-8px, 6px)  scale(1.1); opacity: 0.7; }',
      '  100% { transform: translate(-7px, -8px) scale(1);   opacity: 0.95; }',
      '}',
      /* Reduced motion — freeze the organism. The static silhouette
         (base + violet rim) still reads as a brand mark. */
      '@media (prefers-reduced-motion: reduce) {',
      '  .rw-merc-halo, .rw-merc-base, .rw-merc-bulge, .rw-merc-tint, .rw-merc-spec {',
      '    animation: none !important;',
      '  }',
      '}',

      '.rw-tab-count {',
      '  display: inline-flex; align-items: center; justify-content: center;',
      '  min-width: 18px; height: 18px; padding: 0 5px;',
      '  border-radius: 999px;',
      '  background: var(--rw-accent-ink);',
      '  color: var(--rw-accent);',
      '  font-size: 11px; font-weight: 700;',
      '  font-variant-numeric: tabular-nums; letter-spacing: 0;',
      '  box-shadow: 0 1px 2px rgba(0,0,0,0.18);',
      '  flex: 0 0 auto;',
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
      /* 100dvh excludes the iOS/Android dynamic toolbar so the top
         (shell-actions) and bottom (composer) aren't clipped behind
         browser chrome. The 100vh line is the fallback for older
         browsers that don't parse dvh. */
      '@media (max-width: 640px) {',
      '  .rw-shell { width: 100%; height: 100vh; height: 100dvh; min-height: 0; }',
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

      /* Shell-level controls (theme + close), pinned top-right of the
         modal card. Buttons are 28×28 to match the design's compact close. */
      '.rw-shell-actions {',
      '  position: absolute; top: 18px; right: 18px;',
      '  display: inline-flex; align-items: center; gap: 4px;',
      '  z-index: 5;',
      '}',
      '.rw-shell-actions .rw-icon-btn { width: 28px; height: 28px; }',

      /* split (list view): asymmetric — composer left, tabs/list right */
      '.rw-split {',
      '  display: grid;',
      '  grid-template-columns: 0.85fr 1fr;',
      '  flex: 1 1 auto;',
      '  min-height: 0;',
      '}',
      '.rw-pane { display: flex; flex-direction: column; min-height: 0; min-width: 0; }',
      '.rw-pane-left {',
      /* Top padding pushes the eyebrow row down so its text center
         lands on the same horizontal line as the tab text in the right
         pane. (left.pad-top 30 + eyebrow text center 7 = 37) matches
         (right.pad-top 22 + tab.pad-top 6 + tab text center 9 = 37). */
      '  padding: 30px 28px 22px;',
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
      /* Eyebrow row: project name + "powered by RunHQ" packed left so the
         line reads as a single phrase ("[name] powered by RunHQ"). They
         share the same baseline; the small inline gap is one space-width
         at this font size. Originally split to opposite ends of the row,
         but on narrow widths the powered-by landed under the
         absolutely-positioned close X. */
      '.rw-eyebrow-row {',
      '  display: flex; align-items: baseline; flex-wrap: wrap;',
      '  gap: 6px; margin-bottom: 14px;',
      '}',
      /* Project name text — styled to match the adjacent "powered by RunHQ"
         tag so the whole eyebrow reads as one phrase. The previous
         uppercase + 0.22em-spaced kicker treatment broke that flow. */
      '.rw-eyebrow {',
      '  display: inline-flex; align-items: center; gap: 8px;',
      '  font-size: 10.5px; letter-spacing: 0.02em;',
      '  color: var(--rw-muted); font-weight: 600;',
      '  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;',
      '}',
      '.rw-eyebrow-dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; background: var(--rw-accent); flex: 0 0 auto; }',
      '.rw-powered-by {',
      '  font-size: 10.5px; color: var(--rw-muted);',
      '  white-space: nowrap; flex: 0 0 auto;',
      '  letter-spacing: 0.02em;',
      '}',
      '.rw-powered-by a {',
      '  color: var(--rw-fg-2); text-decoration: none; font-weight: 600;',
      '  transition: color .15s ease;',
      '}',
      '.rw-powered-by a:hover { color: var(--rw-fg); text-decoration: underline; }',

      '.rw-prompt {',
      '  font-family: inherit;',
      '  font-size: 22px; line-height: 1.18; letter-spacing: -0.018em; font-weight: 600;',
      '  color: var(--rw-fg); margin: 0 0 6px;',
      '}',
      /* <em> in the headline + sub is now bold-not-italic — used to highlight
         the project name or "My Submissions" without breaking line rhythm. */
      '.rw-prompt em { font-style: normal; font-weight: 600; color: var(--rw-fg); }',
      '.rw-prompt-sub { margin: 0 0 18px; font-size: 13px; line-height: 1.45; color: var(--rw-muted); }',
      '.rw-prompt-sub em { font-style: normal; font-weight: 600; color: var(--rw-fg-2); }',

      /* inline composer (left pane) */
      /* Inline composer card — textarea + tool bar live inside one bordered
         surface so they read as a single input, the way GitHub/Linear/Notion
         render their comment boxes. focus-within lights up the border to
         match the textarea's focused state. */
      '.rw-inline-composer {',
      '  display: flex; flex-direction: column;',
      '  flex: 0 0 auto; min-height: 0;',
      '  background: var(--rw-bg);',
      '  border: 1px solid var(--rw-line-2);',
      '  border-radius: 12px;',
      '  padding: 12px 14px 10px;',
      '  transition: border-color .15s ease, box-shadow .15s ease;',
      '}',
      '.rw-inline-composer:focus-within {',
      '  border-color: color-mix(in oklab, var(--rw-accent) 50%, var(--rw-line-2));',
      '  box-shadow: 0 0 0 3px color-mix(in oklab, var(--rw-accent) 14%, transparent);',
      '}',
      '.rw-inline-composer-ta {',
      '  width: 100%; border: 0; outline: none; resize: none; background: transparent;',
      '  color: var(--rw-fg);',
      '  font-family: inherit; font-size: 14.5px; line-height: 1.55; letter-spacing: -0.005em;',
      '  padding: 0; min-height: 96px;',
      '}',
      '.rw-inline-composer-ta::placeholder {',
      '  color: var(--rw-muted);',
      '  font-size: 14.5px; letter-spacing: -0.005em;',
      '}',
      '.rw-inline-composer-bar {',
      '  display: flex; align-items: center; justify-content: space-between; gap: 10px;',
      '  margin-top: 10px; padding-top: 10px;',
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
      /* Disabled state keeps the accent color but fades the whole button —
         hint that submit is real, just not yet armed (vs. swapping to a
         transparent ghost button which felt like a different control). */
      '.rw-inline-submit:disabled { cursor: not-allowed; opacity: 0.45; }',
      '.rw-inline-notice { margin-top: 10px; }',
      /* Privacy hint sits next to the Private toggle and explains the
         consequence of the toggle to first-time users. */
      '.rw-priv-hint { font-size: 10.5px; color: var(--rw-muted); margin-left: 8px; letter-spacing: 0; }',

      /* recent-tickets-submitted strip (left pane bottom) */
      '.rw-others {',
      '  display: flex; flex-direction: column;',
      '  flex: 1 1 auto; min-height: 0;',
      '  margin-top: 18px; padding-top: 14px;',
      '  border-top: 1px solid var(--rw-line);',
      '  transition: opacity 200ms ease;',
      '}',
      '.rw-pane-left:focus-within .rw-others { opacity: 0.32; }',
      /* Hidden on mobile — base .rw-others sets display:flex, so this
         override has to live AFTER that rule to win on source order. */
      '@media (max-width: 640px) { .rw-others { display: none; } }',
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
      '.rw-others-list {',
      '  flex: 1; min-height: 0; overflow-y: auto;',
      '  margin: 0 -6px; padding: 0 6px;',
      /* Match the right-pane list scrollbar — narrow track, muted thumb,
         no track background. WebKit + Firefox both covered. */
      '  scrollbar-width: thin;',
      '  scrollbar-color: var(--rw-line-2) transparent;',
      '}',
      '.rw-others-list::-webkit-scrollbar { width: 6px; }',
      '.rw-others-list::-webkit-scrollbar-track { background: transparent; }',
      '.rw-others-list::-webkit-scrollbar-thumb { background: var(--rw-line-2); border-radius: 999px; }',
      '.rw-others-list::-webkit-scrollbar-thumb:hover { background: var(--rw-muted-2); }',
      '.rw-others-row {',
      '  display: grid; grid-template-columns: 8px 1fr auto;',
      '  align-items: center; gap: 10px; width: 100%;',
      '  text-align: left; background: transparent; border: 0;',
      '  border-radius: 8px; padding: 9px 8px;',
      '  cursor: pointer; color: var(--rw-fg); font: inherit;',
      '  transition: background 100ms;',
      '}',
      /* Two-line layout: title above, "{author} · {when}" below. Both clip
         on overflow to keep the row a single physical line. */
      '.rw-others-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }',
      '.rw-others-sub {',
      '  font-size: 10.5px; color: var(--rw-muted);',
      '  letter-spacing: 0;',
      '  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;',
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
      /* Top/bottom padding tuned so the tab text center is at y = 37
         from the card top, matching the left-pane eyebrow center. */
      '  padding: 6px 14px 10px; margin-right: 4px;',
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
      /* Right padding leaves room for the absolute-positioned shell
         actions (theme + close) so the #refId never overlaps the X. */
      '  padding: 0 80px 10px 22px;',
      '  border-bottom: 1px solid var(--rw-line);',
      '  flex: 0 0 auto;',
      '}',
      /* "Back to activity" is a primary navigation action — accent-filled
         to match the rest of the action buttons in the dashboard. */
      '.rw-back-btn {',
      '  display: inline-flex; align-items: center; gap: 6px;',
      '  padding: 6px 12px 6px 10px;',
      '  background: var(--rw-accent); border: 1px solid var(--rw-accent);',
      '  border-radius: 999px;',
      '  color: var(--rw-accent-ink); font: inherit; font-size: 12px; font-weight: 500;',
      '  cursor: pointer;',
      '  transition: filter .12s, transform .12s;',
      '}',
      '.rw-back-btn:hover { filter: brightness(1.06); }',
      '.rw-back-btn:active { transform: translateY(1px); }',

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
      /* Toggled-on pill: solid accent fill so the state change is
         unmistakable. Earlier we used a 12% accent tint, which
         rendered as a barely-visible pale blue and looked broken. */
      '.rw-pill-btn.rw-on {',
      '  background: var(--rw-accent); color: var(--rw-accent-ink);',
      '  border-color: var(--rw-accent);',
      '}',
      '.rw-pill-btn.rw-on:hover:not(:disabled) {',
      '  background: var(--rw-accent); color: var(--rw-accent-ink);',
      '  border-color: var(--rw-accent); filter: brightness(1.05);',
      '}',
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
      /* Disabled state keeps the accent fill — just fades it. Matches
         the inline-submit treatment in the new-ticket composer so the
         two submits read as the same control in different states. */
      '.rw-submit-btn:disabled { cursor: not-allowed; opacity: 0.45; }',

      /* detail modal head — head + body share one scroll area
         (.rw-td-scroll), so the head is no longer flex-pinned. */
      '.rw-td-head { padding: 16px 18px 14px; border-bottom: 1px solid var(--rw-line); background: rgba(255,255,255,0.015); }',
      '.rw-td-head-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 8px; }',
      '.rw-td-head-ref { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }',

      /* Visibility toggle chip — only rendered for the ticket owner.
         Sits next to the status chip in the head. Active (rw-on) state
         = ticket is private. */
      '.rw-vis-chip {',
      '  display: inline-flex; align-items: center; gap: 5px;',
      '  padding: 2px 8px 2px 6px;',
      '  background: var(--rw-panel-2);',
      '  border: 1px solid var(--rw-line);',
      '  border-radius: 999px;',
      '  font-size: 10.5px; font-weight: 500; letter-spacing: 0.01em;',
      '  color: var(--rw-fg-2); font-family: inherit;',
      '  cursor: pointer; white-space: nowrap;',
      '  transition: background .12s ease, color .12s ease, border-color .12s ease, opacity .12s ease;',
      '}',
      '.rw-vis-chip:hover:not(:disabled) {',
      '  background: var(--rw-panel-3); color: var(--rw-fg);',
      '  border-color: var(--rw-line-2);',
      '}',
      '.rw-vis-chip.rw-on {',
      '  background: color-mix(in oklab, var(--rw-accent) 12%, transparent);',
      '  color: var(--rw-accent);',
      '  border-color: color-mix(in oklab, var(--rw-accent) 38%, var(--rw-line));',
      '}',
      '.rw-vis-chip:disabled { cursor: wait; opacity: 0.55; }',
      '.rw-td-ref { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 11px; color: var(--rw-muted); letter-spacing: 0.04em; }',
      /* Title row: vote pill on the left, title text to its right. Items
         align to the top so the vote sits on the title\'s first line for
         multi-line titles. The pill\'s self-margin (4px) tunes the
         baseline-with-text alignment. */
      '.rw-td-title-row {',
      '  display: flex; align-items: flex-start; gap: 12px;',
      '  margin: 6px 0 12px;',
      '}',
      '.rw-td-title-row .rw-vote { margin-top: 2px; }',
      '.rw-td-title { margin: 0; flex: 1 1 auto; min-width: 0; font-family: inherit; font-size: 20px; font-weight: 600; color: var(--rw-fg); line-height: 1.22; letter-spacing: -0.018em; }',
      '.rw-td-head-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 12px; color: var(--rw-muted); }',
      '.rw-td-meta-author { color: var(--rw-fg-2); font-weight: 500; }',

      /* The single scroll container for the detail view. Title, description,
         attachments, and activity thread all scroll together — the composer
         sits OUTSIDE this element (pinned at the bottom of the card). */
      '.rw-td-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; }',
      '.rw-td-scroll::-webkit-scrollbar { width: 6px; }',
      '.rw-td-scroll::-webkit-scrollbar-track { background: transparent; }',
      '.rw-td-scroll::-webkit-scrollbar-thumb { background: var(--rw-line-2); border-radius: 999px; }',
      '.rw-td-scroll::-webkit-scrollbar-thumb:hover { background: var(--rw-muted-2); }',

      '.rw-td-body { padding: 18px 18px 8px; }',

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
      '.rw-event-text {',
      '  flex: 1 1 auto;',
      '  display: inline-flex; align-items: center; gap: 5px; flex-wrap: wrap;',
      '}',
      '.rw-event-text b { color: var(--rw-fg-2); font-weight: 600; }',
      '.rw-event-arrow { color: var(--rw-muted-2); padding: 0 2px; }',
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

      /* Triager badge — shown in the eyebrow row when the authenticated user has
         the assign_agent permission. Intentionally subdued (small, blue pill) so
         it doesn't compete with the composer. */
      '.rw-triager-badge {',
      '  display: inline-block;',
      '  padding: 1px 6px;',
      '  border-radius: 8px;',
      '  background: #2d6cdf;',
      '  color: #fff;',
      '  font-size: 10px;',
      '  font-weight: 600;',
      '  margin-left: 6px;',
      '  vertical-align: middle;',
      '  letter-spacing: 0.04em;',
      '  flex: 0 0 auto;',
      '}',

      /* Assign-agent button — appears in the ticket detail head when the
         triager is viewing an unassigned, actionable ticket. */
      '.rw-assign-btn {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  gap: 4px;',
      '  padding: 4px 10px;',
      '  border-radius: 6px;',
      '  background: #2d6cdf;',
      '  color: #fff;',
      '  font-size: 12px;',
      '  font-weight: 600;',
      '  border: none;',
      '  cursor: pointer;',
      '  letter-spacing: 0.02em;',
      '  margin-top: 8px;',
      '}',
      '.rw-assign-btn:hover { background: #1e55c0; }',
      '.rw-assign-btn:disabled { opacity: 0.5; cursor: default; }',

      /* Agent attribution line — shown below the title when an agent is
         assigned and the assignment was initiated by an external triager. */
      '.rw-agent-attribution {',
      '  font-size: 11px;',
      '  color: var(--rw-muted, #8a857d);',
      '  margin-top: 6px;',
      '  display: flex;',
      '  align-items: center;',
      '  gap: 4px;',
      '  flex-wrap: wrap;',
      '}',
      '.rw-agent-attribution strong { color: var(--rw-fg, #1a1a1a); font-weight: 600; }',

      /* Assign-agent modal overlay — rendered inside modalMountEl (shadow DOM) */
      '.rw-assign-modal-overlay {',
      '  position: fixed; inset: 0;',
      '  background: rgba(0,0,0,0.4);',
      '  display: flex; align-items: center; justify-content: center;',
      '  z-index: 1000000;',
      '}',
      '.rw-assign-modal {',
      '  background: #fff; border-radius: 8px; padding: 20px; width: 420px;',
      '  max-width: calc(100% - 32px); box-shadow: 0 10px 40px rgba(0,0,0,0.2);',
      '  font-family: inherit; color: #1a1a1a;',
      '}',
      '.rw-assign-modal h3 { margin: 0 0 12px; font-size: 16px; font-weight: 600; }',
      '.rw-assign-modal .rw-suggested-row {',
      '  font-size: 12px; color: #666; margin: 0 0 8px;',
      '  display: flex; align-items: center; gap: 6px;',
      '}',
      '.rw-assign-modal ul.rw-agent-list {',
      '  list-style: none; padding: 0; margin: 0 0 12px;',
      '  max-height: 220px; overflow-y: auto;',
      '}',
      '.rw-assign-modal ul.rw-agent-list li {',
      '  padding: 8px; border-radius: 4px; cursor: pointer;',
      '  display: flex; align-items: center; gap: 8px;',
      '}',
      '.rw-assign-modal ul.rw-agent-list li:hover { background: #f4f6f8; }',
      '.rw-assign-modal ul.rw-agent-list li input { margin: 0; }',
      '.rw-assign-modal textarea {',
      '  width: 100%; box-sizing: border-box; min-height: 60px;',
      '  border: 1px solid #ddd; border-radius: 4px; padding: 8px; font-family: inherit;',
      '  font-size: 13px; resize: vertical;',
      '}',
      '.rw-assign-modal .rw-modal-actions {',
      '  display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px;',
      '}',
      '.rw-assign-modal .rw-modal-error {',
      '  background: #fef0f0; color: #b00020; padding: 8px; border-radius: 4px;',
      '  margin-top: 8px; font-size: 12px;',
      '}',
      '.rw-assign-modal .rw-recommended {',
      '  color: #2d6cdf; font-size: 11px; font-weight: 600;',
      '}',
      '.rw-assign-modal .rw-assign-inline-spinner {',
      '  width: 12px; height: 12px;',
      '  border: 1.5px solid #ddd; border-top-color: #2d6cdf;',
      '  border-radius: 50%; animation: rw-spin 0.7s linear infinite;',
      '  display: inline-block; flex: 0 0 auto;',
      '}',
      '.rw-assign-modal-btn {',
      '  padding: 6px 14px; border-radius: 6px; font-size: 13px; font-weight: 600;',
      '  cursor: pointer; border: 1px solid transparent; font-family: inherit;',
      '}',
      '.rw-assign-modal-btn--cancel {',
      '  background: transparent; border-color: #ddd; color: #444;',
      '}',
      '.rw-assign-modal-btn--cancel:hover { background: #f4f6f8; }',
      '.rw-assign-modal-btn--confirm {',
      '  background: #2d6cdf; color: #fff; border-color: #2d6cdf;',
      '}',
      '.rw-assign-modal-btn--confirm:hover:not(:disabled) { background: #1e55c0; border-color: #1e55c0; }',
      '.rw-assign-modal-btn--confirm:disabled { opacity: 0.5; cursor: default; }',
      '.rw-assign-modal .rw-cmd-label {',
      '  font-size: 12px; font-weight: 600; color: #444; margin: 0 0 4px; display: block;',
      '}',
      '.rw-assign-modal .rw-empty-agents {',
      '  font-size: 13px; color: #666; padding: 12px 0; line-height: 1.5;',
      '}',
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
    if (diff < 0) return t("timeAgo.now");
    var secs = Math.floor(diff / 1000);
    if (secs < 45) return t("timeAgo.now");
    var mins = Math.floor(secs / 60);
    if (mins < 60) return t("timeAgo.m", { n: mins });
    var hours = Math.floor(mins / 60);
    if (hours < 24) return t("timeAgo.h", { n: hours });
    var days = Math.floor(hours / 24);
    if (days < 30) return t("timeAgo.d", { n: days });
    var months = Math.floor(days / 30);
    if (months < 12) return t("timeAgo.mo", { n: months });
    // year-scale fallback uses a static suffix; rare for ticket timestamps
    return Math.floor(months / 12) + "y";
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
      h("div", { className: "rw-empty-title" }, title || t("empty.noTickets")),
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
      "aria-label": t("aria.upvote"),
      disabled: !config.isIdentified,
      title: config.isIdentified ? t("aria.upvote") : t("aria.upvoteSignedOut"),
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
      "aria-label": t("aria.openTicket", { title: ticket.title }),
    }, [
      h("div", { className: "rw-dash-row-main" }, mainChildren),
      voteBtn,
    ]);

    row.addEventListener("click", function () { openDetailModal(ticket); });
    return row;
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
      { id: "updates", label: t("tabs.updates") },
      { id: "hot",     label: t("tabs.hot") },
      { id: "mine",    label: t("tabs.mine") },
    ];

    // Use `def` (not `t`) for the loop variable — `t` is the i18n function.
    var tabButtons = defs.map(function (def) {
      var btn = h("button", {
        className: "rw-dash-tab" + (pendingTab === def.id ? " rw-on" : ""),
        type: "button",
        role: "tab",
        "aria-selected": pendingTab === def.id ? "true" : "false",
      }, [
        h("span", { className: "rw-dash-tab-label" }, def.label),
        h("span", { className: "rw-dash-tab-count" }, String(counts[def.id] || 0)),
      ]);
      btn.addEventListener("click", function () {
        if (pendingTab !== def.id) { activeTab = def.id; renderPanelBody(); }
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
        return renderEmpty(t("empty.signInToSeeMine"), t("empty.signedInPlaceholder"));
      }
      if (tab === "mine") {
        return renderEmpty(t("empty.noMineYet"), t("empty.useComposer"));
      }
      if (tab === "updates") {
        return renderEmpty(t("empty.nothingShipped"), t("empty.updatesWillShow"));
      }
      return renderEmpty(t("empty.noTickets"), t("empty.beFirst"));
    }

    var list = h("div", { className: "rw-dash-list" });
    // Use `tk` for the loop variable — `t` is the i18n function.
    items.forEach(function (tk) { list.appendChild(renderTicketCard(tk)); });
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
      placeholder: t("composer.placeholder"),
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
        var removeBtn = h("button", { className: "rw-chip-x", type: "button", "aria-label": t("aria.removeAttach") }, "×");
        removeBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          var i = entries.indexOf(entry);
          if (i >= 0) entries.splice(i, 1);
          renderChips(); updateSubmitEnabled();
        });
        chipsEl.appendChild(h("span", { className: "rw-chip-attach", title: entry.file.name }, [
          Icons.image(11),
          h("span", null, entry.file.name || t("composer.pastedImage")),
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
      h("span", null, t("composer.submit")),
    ]);
    function updateSubmitEnabled() {
      submitBtn.disabled = !config.isIdentified || ta.value.trim().length === 0;
    }
    ta.addEventListener("input", updateSubmitEnabled);

    var isPrivate = false;
    var attachBtn = h("button", { className: "rw-pill-btn", type: "button" }, [
      Icons.paperclip(13), h("span", null, t("composer.attach")),
    ]);
    attachBtn.addEventListener("click", function () { fileInput.click(); });
    // Visibility toggle: label flips between "Public" and "Private"
    // (with matching globe / lock icon) instead of a single "Private"
    // pill lighting up. Reads as a clear state change at a glance.
    var privateBtn = h("button", { className: "rw-pill-btn", type: "button" }, [
      Icons.globe(12),
      h("span", null, t("composer.public")),
    ]);
    var privHint = h("span", { className: "rw-priv-hint" }, t("composer.privateOff"));
    function refreshPrivateBtn() {
      clearChildren(privateBtn);
      privateBtn.appendChild(isPrivate ? Icons.lock(12) : Icons.globe(12));
      privateBtn.appendChild(h("span", null, isPrivate ? t("composer.private") : t("composer.public")));
    }
    privateBtn.addEventListener("click", function () {
      isPrivate = !isPrivate;
      refreshPrivateBtn();
      privHint.textContent = isPrivate ? t("composer.privateOn") : t("composer.privateOff");
    });

    submitBtn.addEventListener("click", function () {
      if (!config.isIdentified) {
        clearChildren(noticeSlot);
        noticeSlot.appendChild(renderNotice("error", t("composer.needSignIn")));
        return;
      }
      var description = ta.value.trim();
      if (!description) return;
      submitBtn.disabled = true;
      submitBtn.firstChild.textContent = t("composer.posting");
      clearChildren(noticeSlot);

      createTicket({
        description: description,
        isPrivate: isPrivate,
        context: collectContext(),
      }).then(function (data) {
        var ticketId = data && data.ticket && data.ticket.id;
        if (!ticketId || entries.length === 0) return null;
        submitBtn.firstChild.textContent = t("composer.uploading");
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
        refreshPrivateBtn();
        privHint.textContent = t("composer.privateOff");
        submitBtn.firstChild.textContent = t("composer.submit");
        topTicketsCache = null; updatesCache = null; myTicketsCache = null;
        // Refresh data + the panel body. The composer instance is replaced
        // along with the rest of the left pane on re-render, so we don't
        // need to reset state on the same DOM node.
        return refreshAll();
      }).catch(function (err) {
        submitBtn.disabled = false;
        submitBtn.firstChild.textContent = t("composer.submit");
        clearChildren(noticeSlot);
        noticeSlot.appendChild(renderNotice("error", t("composer.failed", { msg: err.message || "" })));
      });
    });

    return h("div", { className: "rw-inline-composer" }, [
      ta,
      chipsEl,
      h("div", { className: "rw-inline-composer-bar" }, [
        h("div", { className: "rw-inline-tools" }, [attachBtn, privateBtn, privHint]),
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
      h("span", { className: "rw-others-label" }, t("others.label")),
      h("span", { className: "rw-others-count" }, String(items.length)),
    ]);
    var list = h("div", { className: "rw-others-list" });
    if (items.length === 0) {
      list.appendChild(h("div", { className: "rw-empty-sub", style: { padding: "10px 0", fontSize: "11.5px" } }, t("others.empty")));
    } else {
      // Use `tk` for ticket — `t` is the i18n function.
      items.forEach(function (tk) {
        var author = displayNameFromTicket(tk);
        var when = timeAgo(tk.completedAt || tk.createdAt);
        var sub = author + " · " + when;
        var row = h("button", {
          className: "rw-others-row", type: "button",
          "aria-label": t("aria.openTicket", { title: tk.title }),
        }, [
          h("span", { className: "rw-others-status", "data-status": tk.status, style: { background: statusMeta(tk.status).dot } }),
          // Two-line content cell: title above, author/when below.
          h("span", { className: "rw-others-main" }, [
            h("span", { className: "rw-others-title" }, tk.title),
            h("span", { className: "rw-others-sub" }, sub),
          ]),
          h("span", { className: "rw-others-meta" }, [Icons.arrowUp(9), String(tk.yesVotes || 0)]),
        ]);
        row.addEventListener("click", function () { openDetailModal(tk); });
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

      // Topbar with just the Back button. The ticket ref id used to live
      // here too but it duplicated the #refId chip in the head below and
      // collided with the absolute-positioned shell actions on narrow
      // viewports — gone.
      var backBtn = h("button", { className: "rw-back-btn", type: "button" }, [
        Icons.arrowLeft(13),
        h("span", null, t("detail.back")),
      ]);
      backBtn.addEventListener("click", function () {
        view = "list";
        currentDetailTicket = null;
        renderPanelBody();
      });
      detailFull.appendChild(h("div", { className: "rw-detail-topbar" }, [backBtn]));

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
          renderNotice("error", t("detail.loadFailed", { msg: err.message || "" }))));
      });
    } else {
      // Split layout: composer + others on the left, tabbed activity on the right.
      var split = h("div", { className: "rw-split" });

      var projectName = config.projectName || t("header.thisProduct");

      // "powered by RunHQ" tag — brand-locked, always English regardless
      // of locale. Sits next to the project name in the eyebrow row so
      // the line reads as a single phrase: "[project name] powered by RunHQ".
      var poweredLink = h("a", {
        href: "https://www.runhq.io", target: "_blank",
        rel: "noopener noreferrer",
        "aria-label": "Visit RunHQ",
      }, "RunHQ");
      var poweredBy = h("div", { className: "rw-powered-by" }, [
        document.createTextNode("powered by "),
        poweredLink,
      ]);

      var leftPane = h("div", { className: "rw-pane rw-pane-left" }, [
        // Eyebrow row: project name + brand-locked "powered by RunHQ" tag,
        // packed left so the line reads as one phrase. Both sit on the
        // left so they stay clear of the absolutely-positioned
        // shell-actions (theme + close). The big H1 headline was removed
        // — at small sizes it competed for visual weight with the
        // composer placeholder, which is the actual hero.
        h("div", { className: "rw-eyebrow-row" }, [
          h("div", { className: "rw-eyebrow" }, (function () {
            var eyebrowNodes = [
              h("span", { className: "rw-eyebrow-dot" }),
              h("span", null, t("header.headline", { name: projectName })),
            ];
            if (currentUser.isTriager) {
              var badge = h("span", {
                className: "rw-triager-badge",
                title: "You can assign agents to tickets from this widget.",
              }, "Triager");
              eyebrowNodes.push(badge);
            }
            return eyebrowNodes;
          })()),
          poweredBy,
        ]),
        // Sub-text is the product-value pitch: explains WHY the widget
        // exists. Prose composes as [subBefore]<em>{subEm}</em>[subAfter];
        // empty em / after segments yield a plain sentence. The {name}
        // placeholder in subBefore interpolates the project name.
        h("p", { className: "rw-prompt-sub" }, [
          document.createTextNode(t("header.subBefore", { name: projectName })),
          h("em", null, t("header.subEm")),
          document.createTextNode(t("header.subAfter")),
        ]),
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
        if (headerTitleEl) headerTitleEl.textContent = t("header.feedback", { name: config.projectName });
      }
      // Refresh language on every panel open so settings changes pick up
      // without requiring the embedding page to reload.
      if (data.language) config.language = data.language;
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
      scrollEl.appendChild(renderNotice("error", t("list.loadFailed", { msg: err.message || "" })));
    });
  }

  // ===========================================================================
  // Assign-agent modal
  // ===========================================================================

  function submitAssign(ticketId, agentId, command, callback) {
    fetch(RUNHQ_API + '/api/widget/tickets/' + encodeURIComponent(ticketId) + '/assign', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ agentId: agentId, command: command }),
    }).then(function (res) {
      return res.json().then(function (body) {
        return { status: res.status, retryAfter: res.headers.get('Retry-After'), body: body };
      }, function () {
        return { status: res.status, retryAfter: res.headers.get('Retry-After'), body: null };
      });
    }).then(function (r) {
      if (r.status === 200) return callback(null, r.body);
      if (r.status === 429) {
        var seconds = parseInt(r.retryAfter || '0', 10);
        var minutes = Math.max(1, Math.ceil(seconds / 60));
        return callback("You've assigned the max number of agents this hour. Try again in " + minutes + ' minutes.');
      }
      if (r.status === 403) return callback('That agent is no longer available — please pick another.');
      if (r.status === 503) return callback('Workspace is starting up — try again in a moment.');
      if (r.status === 409) return callback('This ticket was just assigned by someone else. Refreshing.');
      callback((r.body && r.body.error) || 'Could not assign agent.');
    }).catch(function () {
      callback('Network error — try again.');
    });
  }

  function onAssignSuccess(ticketId, data) {
    loadTicketDetail(ticketId).then(function (detail) {
      var ticket = detail && detail.ticket;
      if (ticket) {
        openDetailModal(ticket);
      }
      var agentName = ticket && ticket.assignedAgentName;
      showAssignToast(agentName ? agentName + ' started.' : 'Agent started.');
    }).catch(function () {
      showAssignToast('Agent started.');
    });
  }

  // Show a temporary toast inside the shadow root.
  function showAssignToast(msg) {
    var toast = h('div', {
      style: {
        position: 'fixed',
        bottom: '20px',
        left: '50%',
        transform: 'translateX(-50%)',
        background: '#1a1a1a',
        color: '#fff',
        padding: '8px 16px',
        borderRadius: '6px',
        fontSize: '13px',
        zIndex: '2000000',
        whiteSpace: 'nowrap',
        boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
      },
    }, msg);
    modalMountEl.appendChild(toast);
    setTimeout(function () { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 3000);
  }

  function openAssignModal(ticketId) {
    // Tear down any existing assign modal.
    var existing = modalMountEl.querySelector('.rw-assign-modal-overlay');
    if (existing) existing.parentNode.removeChild(existing);

    // --- Build modal skeleton ---

    var suggestedLabel = h('span', null, '');
    var suggestedSpinner = h('span', { className: 'rw-assign-inline-spinner' });
    var suggestedRow = h('div', { className: 'rw-suggested-row' }, [
      h('strong', null, 'Suggested:'),
      suggestedSpinner,
      suggestedLabel,
    ]);

    var listEl = h('ul', { className: 'rw-agent-list' });

    var cmdLabel = h('label', { className: 'rw-cmd-label' }, 'Command');
    var cmdEl = h('textarea', { placeholder: 'What should the agent do?' });

    var errEl = h('div', { className: 'rw-modal-error', style: { display: 'none' } });

    var cancelBtn = h('button', {
      className: 'rw-assign-modal-btn rw-assign-modal-btn--cancel',
      type: 'button',
    }, 'Cancel');

    var confirmBtn = h('button', {
      className: 'rw-assign-modal-btn rw-assign-modal-btn--confirm',
      type: 'button',
      disabled: true,
    }, 'Start agent');

    var actionsRow = h('div', { className: 'rw-modal-actions' }, [cancelBtn, confirmBtn]);

    var modal = h('div', { className: 'rw-assign-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Hand to agent' }, [
      h('h3', null, 'Hand to agent'),
      suggestedRow,
      listEl,
      cmdLabel,
      cmdEl,
      errEl,
      actionsRow,
    ]);

    var overlay = h('div', { className: 'rw-assign-modal-overlay' }, modal);

    modalMountEl.appendChild(overlay);

    // --- State ---
    var selectedAgentId = null;

    function setError(msg) {
      if (msg) {
        errEl.textContent = msg;
        errEl.style.display = 'block';
      } else {
        errEl.textContent = '';
        errEl.style.display = 'none';
      }
    }

    function pickAgent(id) {
      selectedAgentId = id;
      confirmBtn.disabled = false;
      // Sync all radio inputs.
      var radios = listEl.querySelectorAll('input[type="radio"]');
      for (var i = 0; i < radios.length; i++) {
        radios[i].checked = (radios[i].value === String(id));
      }
    }

    function buildAgentList(agents, suggestedAgentId) {
      clearChildren(listEl);
      agents.forEach(function (agent) {
        var isRecommended = suggestedAgentId && String(agent.id) === String(suggestedAgentId);
        var radio = h('input', { type: 'radio', name: 'rw-agent-pick', value: String(agent.id) });
        var nameSpan = h('span', null, agent.name || agent.id);
        var children = [radio, nameSpan];
        if (isRecommended) {
          children.push(h('span', { className: 'rw-recommended' }, 'Recommended'));
        }
        var li = h('li', null, children);
        li.addEventListener('click', function () { pickAgent(agent.id); });
        listEl.appendChild(li);
      });
    }

    // --- Load agents + suggestion in parallel ---
    Promise.all([
      api('/api/widget/agents'),
      api(
        '/api/widget/tickets/' + encodeURIComponent(ticketId) + '/suggest-assignment',
        { method: 'POST', body: {} }
      ).catch(function () { return null; }),
    ]).then(function (results) {
      var agentsRes = results[0];
      var suggestion = results[1];
      var agents = (agentsRes && agentsRes.agents) || [];

      // Remove spinner; update suggested label.
      if (suggestedSpinner.parentNode) suggestedSpinner.parentNode.removeChild(suggestedSpinner);
      var suggestedAgentId = suggestion && suggestion.agentId ? suggestion.agentId : null;
      var suggestedName = null;
      if (suggestedAgentId) {
        // Find name from agent list.
        for (var i = 0; i < agents.length; i++) {
          if (String(agents[i].id) === String(suggestedAgentId)) {
            suggestedName = agents[i].name || agents[i].id;
            break;
          }
        }
      }
      suggestedLabel.textContent = suggestedName || '(none)';

      if (agents.length === 0) {
        // Empty state: replace list + actions.
        clearChildren(listEl);
        listEl.appendChild(
          h('li', { style: { padding: '0' } },
            h('p', { className: 'rw-empty-agents' },
              'No agents are available — ask a workspace admin to expose one.'
            )
          )
        );
        clearChildren(actionsRow);
        var closeOnlyBtn = h('button', {
          className: 'rw-assign-modal-btn rw-assign-modal-btn--cancel',
          type: 'button',
        }, 'Close');
        closeOnlyBtn.addEventListener('click', function () {
          if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        });
        actionsRow.appendChild(closeOnlyBtn);
        return;
      }

      buildAgentList(agents, suggestedAgentId);

      if (suggestedAgentId) {
        pickAgent(suggestedAgentId);
        cmdEl.value = (suggestion && suggestion.command) || '';
      }
    }).catch(function () {
      if (suggestedSpinner.parentNode) suggestedSpinner.parentNode.removeChild(suggestedSpinner);
      suggestedLabel.textContent = '(none)';
      setError('Failed to load agents. Try again.');
    });

    // --- Close handlers ---
    function closeModal() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }

    cancelBtn.addEventListener('click', closeModal);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeModal();
    });

    var onKey = function (e) {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        closeModal();
        document.removeEventListener('keydown', onKey, true);
      }
    };
    document.addEventListener('keydown', onKey, true);
    // Clean up key listener when overlay is removed via any path.
    var observer = new MutationObserver(function () {
      if (!overlay.parentNode) {
        document.removeEventListener('keydown', onKey, true);
        observer.disconnect();
      }
    });
    observer.observe(modalMountEl, { childList: true });

    // --- Confirm ---
    confirmBtn.addEventListener('click', function () {
      if (!selectedAgentId) return;
      setError('');
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Starting…';
      submitAssign(ticketId, selectedAgentId, cmdEl.value, function (err, assignData) {
        if (err) {
          confirmBtn.disabled = false;
          confirmBtn.textContent = 'Start agent';
          setError(err);
          return;
        }
        overlay.remove();
        onAssignSuccess(ticketId, assignData);
      });
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
      "aria-label": t("aria.upvote"),
      disabled: !config.isIdentified,
    }, [Icons.arrowUp(12), countSpan]);
    voteBtn.addEventListener("click", function (e) { handleVoteClick(ticket, voteBtn, countSpan, e); });

    var refId = String(ticket.id || "").slice(0, 8).toUpperCase();

    // Visibility toggle chip — only rendered for the ticket owner. The
    // backend (WidgetService.updateTicket) lets owners flip private/public
    // at any time regardless of triage state; title/description still
    // require an untouched ticket.
    var visChip = null;
    if (data.isOwner) {
      var visBtn = h("button", {
        className: "rw-vis-chip" + (ticket.isPrivate ? " rw-on" : ""),
        type: "button",
        title: ticket.isPrivate ? t("visibility.privateTooltip") : t("visibility.publicTooltip"),
      }, [Icons.lock(11), h("span", null, ticket.isPrivate ? t("visibility.private") : t("visibility.public"))]);
      visBtn.addEventListener("click", function () {
        var next = ticket.isPrivate ? "public" : "private";
        visBtn.disabled = true;
        updateTicket(ticket.id, { visibility: next })
          .then(function () {
            ticket.isPrivate = (next === "private");
            visBtn.classList.toggle("rw-on", ticket.isPrivate);
            visBtn.title = ticket.isPrivate ? t("visibility.privateTooltip") : t("visibility.publicTooltip");
            // Update the label span (second child).
            visBtn.lastChild.textContent = ticket.isPrivate ? t("visibility.private") : t("visibility.public");
          })
          .catch(function (err) {
            console.warn("[Widget] updateTicket(visibility) failed:", err && err.message);
          })
          .then(function () { visBtn.disabled = false; });
      });
      visChip = visBtn;
    }

    // The #refId chip used to live here too — it was visual noise (most
    // users never reference it). Status chip + visibility chip stay.
    var headRefChildren = [renderStatusChip(ticket.status)];
    if (visChip) headRefChildren.push(visChip);

    // "Assign agent" button — visible only to triagers on tickets that are
    // actionable (not yet in progress / done / deployed) and not yet assigned.
    var TERMINAL_STATUSES = { in_progress: true, done: true, deployed: true };
    var canAssign = currentUser.isTriager
      && !TERMINAL_STATUSES[ticket.status]
      && !ticket.assignedAgentName;
    var assignBtn = null;
    if (canAssign) {
      assignBtn = h("button", {
        className: "rw-assign-btn",
        type: "button",
        title: "Assign an AI agent to work on this ticket",
      }, "Assign agent");
      assignBtn.addEventListener("click", function () {
        openAssignModal(ticket.id);
      });
    }

    // Attribution line — visible when an agent is assigned and the assignment
    // was triggered by an external user (lastTriager is non-null).
    var attributionEl = null;
    if (ticket.assignedAgentName && ticket.lastTriager) {
      attributionEl = h("div", { className: "rw-agent-attribution" }, [
        document.createTextNode("🤖 "),
        h("strong", null, ticket.assignedAgentName),
        document.createTextNode(
          "  — started by " + (ticket.lastTriager.name || "someone") +
          ", " + timeAgo(ticket.lastTriager.at)
        ),
      ]);
    }

    // Title row: vote pill on the left, title to its right. Vote aligns
    // to the title's first text line (flex-start + small padding on the
    // vote so it visually sits on the same baseline as the headline).
    var titleRow = h("div", { className: "rw-td-title-row" }, [
      voteBtn,
      h("h2", { className: "rw-td-title" }, ticket.title),
    ]);

    var headChildren = [
      h("div", { className: "rw-td-head-top" }, [
        h("div", { className: "rw-td-head-ref" }, headRefChildren),
      ]),
      titleRow,
    ];
    if (attributionEl) headChildren.push(attributionEl);
    if (assignBtn) headChildren.push(assignBtn);

    var head = h("div", { className: "rw-td-head" }, headChildren);
    // Head + body share one scroll area so the entire ticket content
    // (title, description, attachments, activity thread) scrolls
    // together. The composer below stays pinned at the bottom of the
    // card via flex layout. Earlier the body alone scrolled, which made
    // long descriptions invisible on the way down to comments.
    var scrollArea = h("div", { className: "rw-td-scroll" });
    scrollArea.appendChild(head);

    // body
    var body = h("div", { className: "rw-td-body" });

    var authorName = displayNameFromTicket(ticket);
    var postChildren = [
      h("div", { className: "rw-td-post-hdr" }, [
        renderAvatar(authorName, 28),
        h("div", { className: "rw-td-post-hdr-text" }, [
          h("div", { className: "rw-td-post-author" }, authorName),
          h("div", { className: "rw-td-post-when" }, timeAgo(ticket.createdAt) + " · " + t("detail.original")),
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
      var threadTitle = comments.length > 0
        ? t("detail.activityCount", {
            n: comments.length,
            plural: comments.length === 1 ? t("detail.commentSingular") : t("detail.commentPlural"),
          })
        : t("detail.activity");
      thread.appendChild(h("div", { className: "rw-td-thread-title" }, threadTitle));
      if (merged.length === 0) {
        thread.appendChild(h("div", { className: "rw-empty-sub", style: { padding: "4px 0" } }, t("detail.noActivity")));
      } else {
        merged.forEach(function (node) {
          if (node.kind === "event") thread.appendChild(renderEventNode(node.event));
          else thread.appendChild(renderCommentNode(node.comment));
        });
      }
    }
    body.appendChild(thread);
    scrollArea.appendChild(body);
    card.appendChild(scrollArea);

    // composer (outside the scroll area, pinned to the bottom of the card)
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
      metaChildren.push(h("span", null, t("detail.shipped", { when: timeAgo(ticket.completedAt) })));
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
      if (fromLabel && toLabel) return t("events.statusChangeBoth", { from: fromLabel, to: toLabel });
      if (toLabel) return t("events.statusChangeTo", { to: toLabel });
      return t("events.changedStatus");
    }
    if (e.type === "moderation_changed") {
      return t("events.moderationChanged", { to: m.to || "unknown" });
    }
    if (e.type === "assigned")       return m.assignee ? t("events.assignedTo", { to: m.assignee }) : t("events.assigned");
    if (e.type === "unassigned")     return t("events.unassigned");
    if (e.type === "ticket_created") return t("events.ticketCreated");
    if (e.type === "ticket_edited")  return t("events.ticketEdited");
    if (e.type === "ticket_deleted") return t("events.ticketDeleted");
    return e.content || e.type;
  }

  function renderEventNode(e) {
    var actorName = e.createdByName || "Team";
    var textChildren = [h("b", null, actorName)];
    var m = e.metadata || {};

    if (e.type === "status_change" && (m.from || m.to)) {
      // Render status changes as actor + chip → chip rather than the
      // older "[Pending] → [In progress]" bracketed text. Status chips
      // are localized + colorized via the registry, so the row reads
      // identically to chips elsewhere in the widget.
      textChildren.push(document.createTextNode(" "));
      if (m.from) textChildren.push(renderStatusChip(m.from));
      textChildren.push(h("span", { className: "rw-event-arrow" }, " → "));
      if (m.to) textChildren.push(renderStatusChip(m.to));
    } else {
      textChildren.push(document.createTextNode(" " + describeEvent(e)));
    }

    return h("div", { className: "rw-event" }, [
      h("span", { className: "rw-event-dot" }),
      h("span", { className: "rw-event-text" }, textChildren),
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
    var placeholder = !config.isIdentified ? t("reply.signInPlaceholder")
                    : ticket.commentsDisabled ? t("reply.disabledPlaceholder")
                    : t("reply.placeholder");

    var ta = h("textarea", { className: "rw-td-composer-ta", placeholder: placeholder, disabled: disabled });

    var submitBtn = h("button", { className: "rw-submit-btn", type: "button", disabled: true }, [
      h("span", null, t("reply.submit")), Icons.send(12),
    ]);
    var attachBtn = h("button", { className: "rw-pill-btn", type: "button", disabled: disabled }, [
      Icons.paperclip(14), h("span", null, t("composer.attach")),
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
        var removeBtn = h("button", { className: "rw-chip-x", type: "button", "aria-label": t("aria.remove") }, "×");
        removeBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          var i = entries.indexOf(entry);
          if (i >= 0) entries.splice(i, 1);
          renderChips(); updateSubmitEnabled();
        });
        chipsEl.appendChild(h("span", { className: "rw-chip-attach", title: entry.file.name }, [
          Icons.image(11),
          h("span", null, entry.file.name || t("composer.pastedImage")),
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
      submitBtn.firstChild.textContent = t("reply.posting");
      clearChildren(noticeSlot);
      postComment(ticket.id, text || "").then(function (data) {
        var newComment = data && data.comment;
        if (!newComment) throw new Error("Malformed response");
        if (entries.length === 0) return newComment;
        submitBtn.firstChild.textContent = t("reply.uploading");
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
        submitBtn.firstChild.textContent = t("reply.submit");
        updateSubmitEnabled();
        if (onPosted) onPosted(newComment);
      }).catch(function (err) {
        submitBtn.firstChild.textContent = t("reply.submit");
        updateSubmitEnabled();
        noticeSlot.appendChild(renderNotice("error", t("reply.failed", { msg: err.message || "" })));
      });
    });

    var composerCard = h("div", { className: "rw-td-composer-card" }, [
      ta,
      chipsEl,
      h("div", { className: "rw-td-composer-bar" }, [
        h("div", { className: "rw-td-composer-bar-l" }, [
          attachBtn,
          h("span", { className: "rw-td-composer-hint" }, t("reply.hint")),
        ]),
        submitBtn,
      ]),
    ]);

    var composer = h("div", { className: "rw-td-composer" });
    if (!config.isIdentified) {
      composer.appendChild(h("div", { className: "rw-login-prompt", style: { marginBottom: "8px" } }, t("reply.signInPrompt")));
    } else if (ticket.commentsDisabled) {
      composer.appendChild(h("div", { className: "rw-login-prompt", style: { marginBottom: "8px" } }, t("reply.disabledPrompt")));
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
    // Reset the dashboard so re-opening lands on a fresh state rather
    // than wherever the user last left it (detail view, Hot tab, etc.).
    view = "list";
    currentDetailTicket = null;
    activeTab = "updates";
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
      "aria-label": t("aria.openPanel"),
    }, buildTabContent());
    // Vertical anchor: top / middle (default) / bottom. The protrusion
    // direction is always horizontal (out from the screen edge); only
    // where the pill sits along the vertical axis changes.
    if (config.offset === "top")    tabEl.classList.add("rw-tab--top");
    if (config.offset === "bottom") tabEl.classList.add("rw-tab--bottom");
    tabEl.addEventListener("click", function () { isOpen ? closePanel() : openPanel(); });

    // Shell controls (theme + close), pinned top-right of the modal card.
    themeToggleBtn = h("button", { className: "rw-icon-btn", type: "button" });
    themeToggleBtn.addEventListener("click", toggleTheme);

    var closeShellBtn = h("button", { className: "rw-icon-btn", type: "button", "aria-label": t("aria.close") }, Icons.close(16));
    closeShellBtn.addEventListener("click", closePanel);

    // The card body (`scrollEl` keeps its name for compatibility with
    // refreshAll's loading-state insert + renderPanelBody clears) holds
    // either the split layout or the full-width detail view.
    scrollEl = h("div", {
      style: { flex: "1 1 auto", display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden" },
    });

    // The "Powered by RunHQ" line moved to the left-pane eyebrow row
    // (see renderPanelBody) — there is no bottom footer anymore.
    footerEl = null;

    var cardModal = h("div", {
      className: "rw-card-modal", role: "dialog",
      "aria-label": t("aria.openPanel"), "aria-modal": "true",
    }, [
      h("div", { className: "rw-shell-actions" }, [themeToggleBtn, closeShellBtn]),
      scrollEl,
    ]);

    // `widgetEl` aliases the outer scrim so existing open/close code that
    // toggles `widgetEl.classList` ("rw-open") keeps working.
    widgetEl = h("div", {
      className: "rw-shell-scrim", "data-theme": theme,
    }, [
      h("div", { className: "rw-shell", "data-theme": theme }, [cardModal]),
    ]);

    // Deliberately NO click-outside-to-close handler — accidental clicks
    // on the scrim shouldn't drop a half-typed feedback ticket. The user
    // closes via the explicit × button or Escape.

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
        // language must be set BEFORE mountDOM — the launcher tab's aria-label
        // and any first-render strings read t() at construction time.
        config.language = data.language || opts.language || "en";

        var pos = (data.position || "middle-right").split("-");
        var vPos = pos[0] || "middle";
        var hPos = pos[1] || "right";
        config.position = hPos;
        // null = vertically centered; "top" / "bottom" anchor near the
        // matching edge. The launcher always protrudes horizontally from
        // left or right (never from the bottom edge).
        config.offset = vPos === "top" ? "top" : vPos === "bottom" ? "bottom" : null;

        theme = resolveInitialTheme(opts.theme);

        mountDOM();

        // Fetch the authenticated user's profile (permissions, isTriager) so the
        // Triager badge can be shown in the eyebrow row. Fire-and-forget; failures
        // leave currentUser at its default safe-empty state.
        fetchAndApplyMe();

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
