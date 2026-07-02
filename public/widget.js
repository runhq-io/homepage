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
  // Header notifications bell (ticket-update alerts) + its dropdown.
  var notifBellBtn = null;
  var notifWrap = null;
  var notifDropdownEl = null;
  var notifOpen = false;
  var notifOutsideHandler = null;

  var isOpen = false;
  var activeTab = "hot"; // "hot" | "updates" | "mine"  — every open lands on the discussion (Hot) tab (see closePanel reset)
  var mineUnreadOnly = false; // My Submissions "Unread only" filter toggle
  var theme = "light";

  var topTicketsCache = null;   // /api/widget/tickets        — drives "Hot" tab + recent-others list
  var updatesCache = null;      // /api/widget/tickets/updates — drives "Updates" tab + tab-label badge
  var myTicketsCache = null;    // /api/widget/tickets/mine    — drives "My Tickets" tab
  var assignedTicketsCache = null; // /api/widget/tickets/assigned — live sessions the viewer assigned
  // Community coin: the viewer's running total + per-post earnings, from
  // /api/widget/me/community. Drives the header coin badge, the per-card "+N 🪙"
  // chip, and its hover "why" tooltip. Refreshed on every panel open/refresh.
  var communityStats = { identified: false, balance: 0, coinByTicket: {} };
  var activeModal = null;       // for the image lightbox only (inline composer + detail replace the old new-ticket / detail modals)

  // Current authenticated user info, populated after auth via /api/widget/me.
  // Always present as an object so reads never throw — defaults to anonymous.
  var currentUser = { permissions: [], matchedRoles: [], isTriager: false };

  // Modal-shell view state. The shell is a centered card with these faces:
  //   "list"   — the landing view: the discussion board (Hot / Updates / My
  //              Submissions tabs + [+ New post], which opens chat). Every
  //              open lands here on the Hot tab (see closePanel reset).
  //   "chat"   — the agent conversation (opened from [+ New post]).
  //   "detail" — full-width ticket detail with a "Back to activity" button.
  //   "home"   — legacy Intercom-style menu (greeting + navigation cards).
  //              Retired from the flow but kept for possible re-use; no
  //              navigation path lands here anymore.
  // Switching between faces re-renders the card body in place; the launcher
  // tab and outer modal chrome stay mounted so we don't pay a remount cost.
  var view = "list";
  var currentDetailTicket = null;

  // Polling interval handle for the ticket detail view.
  // Started when a detail is opened, cleared when the detail closes.
  // Only one interval is active at a time; stored here to guarantee cleanup
  // on back-navigation, view switches, and panel close.
  var detailPollIntervalId = null;
  var DETAIL_POLL_INTERVAL_MS = 5000;
  // Background refresh of the launcher/bell unread counts while the panel is
  // open, so a team reply or a coder/teammate live-session message bumps the
  // badge without the user reopening the widget. Only the badge caches are
  // reloaded + the label/bell re-rendered (never the list body) so it never
  // disrupts scroll or an in-progress interaction.
  var badgePollTimerId = null;
  var BADGE_POLL_INTERVAL_MS = 20000;
  // Real-time unread: one per-user SSE stream drives the launcher/bell badge.
  // Runs for the page lifetime (open or closed). The poll above is its fallback.
  var notifEventSourceRef = null;
  var notifReconnectTimerId = null;
  var notifStreamConnected = false;
  var NOTIF_RECONNECT_MS = 30000;
  // Live ticket-status stream (SSE). Preferred over polling; at most one of
  // detailEventSourceRef / detailPollIntervalId is armed at a time.
  var detailEventSourceRef = null;

  // ===========================================================================
  // Chat state (agent conversation view)
  // ===========================================================================

  // Active conversation: {id, status: 'active'|'closed', createdTaskId, userTurnCount}.
  var chatConversation = null;
  // Message rows in arrival order: {id, role, content, payload, createdAt}.
  // Optimistic local echoes use ids prefixed "local-" and are replaced by
  // the server's authoritative rows on arrival (see chatReplaceLocalEcho).
  var chatMessages = [];
  // True between a user action (send / create / dismiss / force-proposal)
  // and the agent's next visible reply — drives the typing indicator and
  // the fast polling cadence.
  var chatTurnPending = false;
  // Transport handles. At most one of EventSource / poll timer is live.
  var chatEventSourceRef = null;
  var chatPollTimerId = null;
  // Started once a ticket has been created from this conversation; watches
  // GET /conversations/active until the BE closes the conversation.
  var chatClosedWatchTimerId = null;
  // True while the agentless [Submit Ticket] POST is in flight — keeps the
  // button disabled across the full list re-renders that incoming SSE rows
  // trigger (the slot is rebuilt on every render).
  var chatSubmitInFlight = false;
  // Guards the discard-and-start-fresh flow against a double-trigger while the
  // POST is outstanding.
  var chatFreshInFlight = false;
  // Element refs for the mounted chat view ({listEl, footerEl, hatchSlot,
  // inputEl}); null whenever view !== "chat".
  var chatUi = null;
  // When "chat", the detail view's back button returns to the chat instead
  // of the list (set when navigating chat → ticket detail).
  var detailReturnView = null;
  // When "compose", the compose view's back control returns to the view it
  // was opened from (Home's message card vs the list's [+ New post]) — the
  // same pattern as detailReturnView above.
  var composeReturnView = "home";

  var CHAT_POLL_FAST_MS = 1500;    // while a turn is pending
  var CHAT_POLL_IDLE_MS = 5000;    // idle (matches DETAIL_POLL_INTERVAL_MS)
  var CHAT_CLOSED_WATCH_MS = 5000;
  var CHAT_INPUT_MAX = 4000;
  var CHAT_ESCAPE_HATCH_MIN_TURNS = 4;
  var CHAT_IMAGE_MAX = 3; // max images per message
  // True when the chat view is a Live session (staff → running job), rather
  // than the ordinary user → agent intake conversation. Set by openLiveSession;
  // cleared when the chat view exits. Controls: send route (liveCoderSend vs
  // chatSendMessage), topbar label, back destination, and hatch-slot visibility.
  var chatIsLiveSession = false;
  // Pending image uploads for the chat composer. Each entry:
  //   { id: null|string, dataUrl: string, name: string, mimeType: string, uploading: bool, failed: bool }
  // id is null while the upload is in flight; set to the server-returned opaque
  // id on success. Cleared when the chat shell is rebuilt and on successful send.
  var pendingChatImages = [];
  // When chatIsLiveSession is true: the ticket the live session was opened from
  // (used to restore the detail view on back-navigation).
  var liveSessionTicket = null;

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

  // Build auth headers. Identity precedence runs server-side; the widget
  // only knows which channel to use after /api/widget/identity resolves
  // (config.identitySource). Until then, fall back to the historic
  // token-or-slug heuristic so the very first identity probe still authenticates.
  //
  //   identitySource === 'runhq' → cookie path. Send X-RW-Project (so the
  //                                server can resolve the project) and the
  //                                CSRF token on writes. Authorization is
  //                                explicitly omitted — server reads cookie.
  //   identitySource === 'app'   → token bearer (existing behavior).
  //   null / unresolved          → fall back to bearer-or-slug heuristic.
  function authHeaders(extra, opts) {
    var headers = extra || {};
    var method = (opts && opts.method) ? String(opts.method).toUpperCase() : "GET";
    if (config.identitySource === "runhq") {
      if (config.project) headers["X-RW-Project"] = config.project;
      if (config.csrfToken && method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
        headers["X-RunHQ-CSRF"] = config.csrfToken;
      }
      return headers;
    }
    if (config.identitySource === "app" && config.token) {
      headers["Authorization"] = "Bearer " + config.token;
      if (config.project) headers["X-RW-Project"] = config.project;
      return headers;
    }
    // Pre-bootstrap or unresolved identity. Cookie-auth embeds must include
    // both signals so the server can prefer RunHQ cookie identity while still
    // falling back to the app token when no qualifying cookie is present.
    if (wantsCookieAuth() && config.project) headers["X-RW-Project"] = config.project;
    if (config.token) headers["Authorization"] = "Bearer " + config.token;
    else if (config.project) headers["X-RW-Project"] = config.project;
    return headers;
  }

  // Whether this widget instance is opted into the cookie (RunHQ-member)
  // auth path. EXPLICIT opt-in via init({ useCookieAuth: true }) — gating
  // on config.project would silently enable credentialed CORS for every
  // embed that supplies a slug (public-anon embeds, pure-bearer embeds
  // that also pass `project` for any reason). When the host origin is
  // NOT in the project's allowed_origins, the server returns
  // `Access-Control-Allow-Origin: *`, which the browser refuses to pair
  // with `credentials: "include"` — the entire response is blocked.
  //
  // Explicit opt-in means: cookie auth is only attempted by embeds that
  // have explicitly enrolled (auto-recognize ON + allowlisted origin).
  // Everyone else gets the wide-open legacy CORS envelope and works
  // exactly as before.
  function wantsCookieAuth() {
    return !!config.useCookieAuth;
  }

  function api(path, opts) {
    var method = (opts && opts.method) || "GET";
    var headers = authHeaders({ "Content-Type": "application/json" }, { method: method });
    var init = {
      method: method,
      headers: headers,
      body: (opts && opts.body) ? JSON.stringify(opts.body) : undefined,
    };
    if (wantsCookieAuth()) init.credentials = "include";
    return fetch(RUNHQ_API + path, init).then(function (r) {
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

  function loadIdentity()         { return api("/api/widget/identity"); }
  function loadMe()               { return api("/api/widget/me"); }
  function loadTopTickets()       { return api("/api/widget/tickets"); }
  function loadUpdates()          { return api("/api/widget/tickets/updates"); }
  function loadMyTickets()        { return api("/api/widget/tickets/mine"); }
  function loadAssignedTickets()  { return api("/api/widget/tickets/assigned"); }
  function loadCommunityStats()   { return api("/api/widget/me/community"); }
  function loadTicketDetail(id)   { return api("/api/widget/tickets/" + encodeURIComponent(id)).then(function (data) {
    // Capture the project's deploy-env map from any detail load so status chips
    // resolve "deployed:<envId>" → "Deployed → <name>" even on the public page
    // (which may open a detail without going through the panel bootstrap).
    if (data && data.environments) setDeployEnvironments(data.environments);
    return data;
  }); }
  function assignTicketAgent(id)  { return api("/api/widget/tickets/" + encodeURIComponent(id) + "/assign", { method: "POST" }); }
  function ensureTicketLiveSession(id) { return api("/api/widget/tickets/" + encodeURIComponent(id) + "/live-session", { method: "POST" }); }
  function createTicket(data)     { return api("/api/widget/tickets", { method: "POST", body: data }); }
  function createTicketWithAttachments(data, files) {
    var fd = new FormData();
    if (data.title) fd.append("title", data.title);
    if (data.description) fd.append("description", data.description);
    fd.append("isPrivate", data.isPrivate ? "true" : "false");
    if (data.context) {
      try { fd.append("context", JSON.stringify(data.context)); } catch (_) {}
    }
    Array.prototype.forEach.call(files || [], function (file) {
      fd.append("files", file, file.name || "upload");
    });
    var init = {
      method: "POST",
      headers: authHeaders({}, { method: "POST" }),
      body: fd,
    };
    if (wantsCookieAuth()) init.credentials = "include";
    return fetch(RUNHQ_API + "/api/widget/tickets", init).then(readJsonOrThrow);
  }
  function updateTicket(ticketId, data) { return api("/api/widget/tickets/" + encodeURIComponent(ticketId), { method: "PATCH", body: data }); }
  function castUpvote(ticketId)   { return api("/api/widget/tickets/" + encodeURIComponent(ticketId) + "/vote", { method: "POST", body: { value: true } }); }
  function retractVote(ticketId)  { return api("/api/widget/tickets/" + encodeURIComponent(ticketId) + "/vote", { method: "DELETE" }); }
  function postComment(ticketId, content) {
    return api("/api/widget/tickets/" + encodeURIComponent(ticketId) + "/comments", {
      method: "POST", body: { content: content },
    });
  }
  function postClarifyAnswer(ticketId, clarificationId, answers) {
    return api("/api/widget/tickets/" + encodeURIComponent(ticketId) + "/clarify-answer", {
      method: "POST", body: { clarificationId: clarificationId, answers: answers },
    });
  }

  function postClarifyProceed(ticketId, clarificationId) {
    return api("/api/widget/tickets/" + encodeURIComponent(ticketId) + "/clarify-proceed", {
      method: "POST", body: { clarificationId: clarificationId },
    });
  }

  function startTicketPreview(ticketId) {
    return api("/api/widget/tickets/" + encodeURIComponent(ticketId) + "/preview", { method: "POST" });
  }

  function chatOpenConversation() {
    return api("/api/widget/chat/conversations", { method: "POST", body: {} });
  }
  // Clear the current intake conversation and open a fresh one in a single
  // round trip (the BE closes any active intake conversation, then creates a
  // new one). Returns the same shape as chatOpenConversation.
  function chatStartFreshConversation() {
    return api("/api/widget/chat/conversations", { method: "POST", body: { fresh: true } });
  }
  function chatLoadActive() {
    return api("/api/widget/chat/conversations/active");
  }
  // Authoritative close-state for a SPECIFIC conversation by id. Unlike
  // /conversations/active (intake-only — hides ticket-linked threads), this
  // answers "is THIS conversation still open?" even after it produced a ticket.
  function chatLoadStatus(conversationId) {
    return api("/api/widget/chat/conversations/" + encodeURIComponent(conversationId) + "/status");
  }
  function chatLoadMessages(conversationId, afterCursor) {
    var qs = afterCursor ? "?after=" + encodeURIComponent(afterCursor) : "";
    return api("/api/widget/chat/conversations/" + encodeURIComponent(conversationId) + "/messages" + qs);
  }
  function chatSendMessage(conversationId, content, imageIds) {
    var body = { content: content };
    if (imageIds && imageIds.length) body.imageIds = imageIds;
    return api("/api/widget/chat/conversations/" + encodeURIComponent(conversationId) + "/messages", {
      method: "POST", body: body,
    });
  }

  function chatUploadImage(conversationId, file) {
    var fd = new FormData();
    fd.append("file", file, file.name || "upload");
    var init = {
      method: "POST",
      headers: authHeaders({}, { method: "POST" }),
      body: fd,
    };
    if (wantsCookieAuth()) init.credentials = "include";
    return fetch(RUNHQ_API + "/api/widget/chat/conversations/" + encodeURIComponent(conversationId) + "/images", init).then(readJsonOrThrow);
  }

  function chatGetImageUrl(conversationId, imageId) {
    return api("/api/widget/chat/conversations/" + encodeURIComponent(conversationId) + "/images/" + encodeURIComponent(imageId));
  }
  // Staff-only: send a message into the running job via the front-door agent.
  // Requires the `live_coder` permission (enforced server-side; 403 otherwise).
  // Replies arrive on the SAME /events SSE stream as the ordinary chat transport.
  function liveCoderSend(conversationId, content) {
    return api("/api/widget/chat/conversations/" + encodeURIComponent(conversationId) + "/live-message", {
      method: "POST", body: { content: content },
    });
  }
  function chatForceProposal(conversationId) {
    return api("/api/widget/chat/conversations/" + encodeURIComponent(conversationId) + "/force-proposal", {
      method: "POST", body: {},
    });
  }
  function chatCreateTicket(conversationId, title, description, isPrivate) {
    return api("/api/widget/chat/conversations/" + encodeURIComponent(conversationId) + "/create-ticket", {
      method: "POST", body: { title: title, description: description, isPrivate: !!isPrivate },
    });
  }
  function chatDismissProposal(conversationId) {
    return api("/api/widget/chat/conversations/" + encodeURIComponent(conversationId) + "/dismiss-proposal", {
      method: "POST", body: {},
    });
  }
  // Agentless intake: the BE derives the ticket draft server-side from the
  // stored user messages (no body), creates it born-ready, and closes the
  // conversation. 409 codes: agent_turns_present / conversation_closed /
  // ticket_already_created / no_user_messages.
  function chatSubmitTicket(conversationId) {
    return api("/api/widget/chat/conversations/" + encodeURIComponent(conversationId) + "/submit-ticket", {
      method: "POST", body: {},
    });
  }

  function uploadTicketAttachment(ticketId, file) {
    var fd = new FormData();
    fd.append("file", file, file.name || "upload");
    var init = {
      method: "POST",
      headers: authHeaders({}, { method: "POST" }),
      body: fd,
    };
    if (wantsCookieAuth()) init.credentials = "include";
    return fetch(RUNHQ_API + "/api/widget/tickets/" + encodeURIComponent(ticketId) + "/attachments", init).then(readJsonOrThrow);
  }

  function uploadCommentAttachment(ticketId, commentId, file) {
    var fd = new FormData();
    fd.append("file", file, file.name || "upload");
    var init = {
      method: "POST",
      headers: authHeaders({}, { method: "POST" }),
      body: fd,
    };
    if (wantsCookieAuth()) init.credentials = "include";
    return fetch(RUNHQ_API + "/api/widget/tickets/" + encodeURIComponent(ticketId)
      + "/comments/" + encodeURIComponent(commentId) + "/attachments", init).then(readJsonOrThrow);
  }

  // Map the BE's attachment error codes (thrown by readJsonOrThrow as err.message)
  // to a localized, human sentence. Falls back to the raw code so an unmapped
  // failure is still surfaced rather than silently swallowed.
  function friendlyAttachError(err) {
    var code = (err && err.message) || "";
    switch (code) {
      case "attachment_storage_unconfigured": return t("attachErr.unconfigured");
      case "attachment_too_large":            return t("attachErr.tooLarge");
      case "attachment_unsupported_type":     return t("attachErr.unsupported");
      case "attachment_count_exceeded":       return t("attachErr.tooMany");
      case "attachment_rejected":             return t("attachErr.rejected");
      case "attachment_review_unavailable":   return t("attachErr.reviewUnavailable");
      case "attachments_disabled":            return t("attachErr.disabled");
      default:                                return code;
    }
  }

  function friendlySubmitError(err) {
    var code = (err && err.message) || "";
    switch (code) {
      case "ticket_rejected":                 return t("composer.reviewRejected");
      case "ticket_review_unavailable":       return t("composer.reviewUnavailable");
      default:                                return code;
    }
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
  // Anon write gate (public widget, read-only-until-login flow)
  //
  // When a project is "public" (isPublic) but the current viewer is anonymous
  // (no token / no widgetUserId), every write affordance — submit ticket,
  // upvote, comment — must redirect the user to the project's configured
  // login URL instead of hitting the API. The composer state (description,
  // queued image files) is captured into sessionStorage as a base64 JSON
  // intent so the user's draft survives the redirect, and is reapplied when
  // the widget bootstraps next under an authenticated identity. Files are
  // never uploaded to the server while the viewer is anonymous.
  // ===========================================================================

  // Holds an intent read from sessionStorage at init time. Applied after
  // the panel is mounted and the first data load finishes so the composer
  // / detail view exists to receive the prefilled state.
  var pendingIntent = null;

  // Sized just under the lowest common sessionStorage quota (~5MB). Leaves
  // headroom for other storage on the host page. Drafts that would exceed
  // this drop queued images (oldest first) until they fit.
  var INTENT_MAX_BYTES = 4 * 1024 * 1024;

  function isAnonViewer() {
    return !!(config.isPublic && !config.isIdentified);
  }

  // True if an anonymous viewer can usefully click a write affordance —
  // public + a configured login URL. Without a URL the gate has nowhere
  // to send them, so the affordance stays disabled (matching the
  // pre-feature behavior of "anon can't write").
  function canAnonInteract() {
    return isAnonViewer() && !!config.loginUrl;
  }

  function intentStorageKey() {
    var slug = config.projectId || config.project || "default";
    return "runhq:widget:draft:" + slug;
  }

  function buildLoginUrl(base) {
    try {
      var url = new URL(base, window.location.href);
      // If the owner already supplied a return_to (custom flow), respect
      // it. Otherwise inject the current page so they land back here.
      if (!url.searchParams.has("return_to")) {
        url.searchParams.set("return_to", window.location.href);
      }
      return url.toString();
    } catch (_) {
      return base;
    }
  }

  // Read a File as a base64 data URL so it can be persisted in
  // sessionStorage across the login redirect.
  function fileToDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        resolve({
          name: file.name || "image",
          mime: file.type || "application/octet-stream",
          dataUrl: String(reader.result || ""),
        });
      };
      reader.onerror = function () { reject(reader.error || new Error("File read failed")); };
      reader.readAsDataURL(file);
    });
  }

  // Inverse of fileToDataUrl. Resolves to a real File so the composer's
  // existing addFiles flow accepts it without modification.
  function dataUrlToFile(serialized) {
    return fetch(serialized.dataUrl)
      .then(function (r) { return r.blob(); })
      .then(function (blob) { return new File([blob], serialized.name, { type: serialized.mime }); });
  }

  function trySaveIntent(intent) {
    var serialized = JSON.stringify(intent);
    var droppedFiles = false;
    while (
      serialized.length > INTENT_MAX_BYTES &&
      intent.draft && Array.isArray(intent.draft.files) && intent.draft.files.length > 0
    ) {
      intent.draft.files.shift();
      droppedFiles = true;
      serialized = JSON.stringify(intent);
    }
    try {
      sessionStorage.setItem(intentStorageKey(), serialized);
      return { ok: true, droppedFiles: droppedFiles };
    } catch (_) {
      return { ok: false, droppedFiles: droppedFiles };
    }
  }

  function readIntent() {
    try {
      var raw = sessionStorage.getItem(intentStorageKey());
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  function clearIntent() {
    try { sessionStorage.removeItem(intentStorageKey()); } catch (_) {}
  }

  // Single entry point for write affordances. If the viewer is anonymous on
  // a public widget with a configured login URL, capture the intent and
  // redirect. Otherwise the action proceeds via `intent.proceed`.
  function gateWriteAction(intent) {
    if (!isAnonViewer()) {
      if (intent.proceed) intent.proceed();
      return;
    }
    if (!config.loginUrl) {
      if (intent.onMisconfigured) intent.onMisconfigured();
      return;
    }
    // Strip non-serializable fields before persisting.
    var persisted = {
      type: intent.type,
      projectSlug: config.projectId || config.project || null,
      ticketId: intent.ticketId || null,
      direction: intent.direction || null,
      draft: intent.draft || null,
    };
    trySaveIntent(persisted);
    window.location.href = buildLoginUrl(config.loginUrl);
  }

  // Fetch the current authenticated user's profile from /api/widget/me and
  // update currentUser. Safe for anonymous callers — 401/404 resolve to empty.
  // After updating state, re-renders the panel body so the triager badge
  // appears/disappears without requiring a full widget reload.
  function fetchAndApplyMe() {
    // Skip if no auth source resolved at all — both app (token) and runhq
    // (cookie) paths return permissions on /api/widget/me, so we hit it
    // for either. Pure-anon callers fall through to the empty-state branch.
    if (!config.token && config.identitySource !== "runhq") {
      currentUser.permissions = [];
      currentUser.matchedRoles = [];
      currentUser.isTriager = false;
      return;
    }
    loadMe().then(function (me) {
      currentUser.permissions = (me && me.permissions) || [];
      currentUser.matchedRoles = (me && me.matchedRoles) || [];
      currentUser.isTriager = !!(me && me.isTriager);
      if (config.isIdentified && viewerCanLiveCoder()) {
        loadAssignedTickets()
          .then(function (d) { assignedTicketsCache = d.tickets || []; refreshTabLabel(); })
          .catch(function () {});
      }
      // Idempotent: ensures the real-time stream is up once identity is
      // confirmed (covers identity resolving after the initial bootstrap).
      if (config.isIdentified) startNotificationsStream();
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

  function markdownSafeUrl(raw) {
    var url = String(raw || "").trim();
    if (!url) return null;
    if (/^(https?:|mailto:|tel:)/i.test(url)) return url;
    if (url.charAt(0) === "/" && url.charAt(1) !== "/") return url;
    return null;
  }

  function findMarkdownClose(text, delimiter, start) {
    for (var i = start; i < text.length; i++) {
      if (text.charAt(i) === "\\") {
        i++;
        continue;
      }
      if (text.slice(i, i + delimiter.length) === delimiter) return i;
    }
    return -1;
  }

  function isWordChar(ch) {
    return !!ch && /[A-Za-z0-9]/.test(ch);
  }

  function appendMarkdownInline(parent, text, depth) {
    text = String(text || "");
    depth = depth || 0;
    if (depth > 8) {
      parent.appendChild(document.createTextNode(text));
      return;
    }

    var i = 0;
    var plainStart = 0;
    function flushPlain(until) {
      if (until > plainStart) parent.appendChild(document.createTextNode(text.slice(plainStart, until)));
    }
    function appendWrapped(tag, className, delimiter, closeAt) {
      flushPlain(i);
      var el = h(tag, className ? { className: className } : null);
      appendMarkdownInline(el, text.slice(i + delimiter.length, closeAt), depth + 1);
      parent.appendChild(el);
      i = closeAt + delimiter.length;
      plainStart = i;
    }

    while (i < text.length) {
      var ch = text.charAt(i);

      if (ch === "\\" && i + 1 < text.length && "\\`*_~[]()".indexOf(text.charAt(i + 1)) !== -1) {
        flushPlain(i);
        parent.appendChild(document.createTextNode(text.charAt(i + 1)));
        i += 2;
        plainStart = i;
        continue;
      }

      if (ch === "`") {
        var codeClose = findMarkdownClose(text, "`", i + 1);
        if (codeClose !== -1) {
          flushPlain(i);
          parent.appendChild(h("code", null, text.slice(i + 1, codeClose)));
          i = codeClose + 1;
          plainStart = i;
          continue;
        }
      }

      if (ch === "[") {
        var labelClose = text.indexOf("](", i + 1);
        var urlClose = labelClose === -1 ? -1 : text.indexOf(")", labelClose + 2);
        if (labelClose !== -1 && urlClose !== -1) {
          var href = markdownSafeUrl(text.slice(labelClose + 2, urlClose));
          if (href) {
            flushPlain(i);
            var a = h("a", { href: href, target: "_blank", rel: "noopener noreferrer" });
            appendMarkdownInline(a, text.slice(i + 1, labelClose), depth + 1);
            parent.appendChild(a);
            i = urlClose + 1;
            plainStart = i;
            continue;
          }
        }
      }

      var close = -1;
      if (text.slice(i, i + 2) === "**") {
        close = findMarkdownClose(text, "**", i + 2);
        if (close !== -1) {
          appendWrapped("strong", null, "**", close);
          continue;
        }
      }
      if (text.slice(i, i + 2) === "__") {
        close = findMarkdownClose(text, "__", i + 2);
        if (close !== -1) {
          appendWrapped("strong", null, "__", close);
          continue;
        }
      }
      if (text.slice(i, i + 2) === "~~") {
        close = findMarkdownClose(text, "~~", i + 2);
        if (close !== -1) {
          appendWrapped("s", null, "~~", close);
          continue;
        }
      }

      if (ch === "*" && text.charAt(i + 1) !== "*") {
        close = findMarkdownClose(text, "*", i + 1);
        if (close !== -1 && text.charAt(close - 1) !== "*") {
          appendWrapped("em", null, "*", close);
          continue;
        }
      }
      if (ch === "_" && text.charAt(i + 1) !== "_" && !isWordChar(text.charAt(i - 1))) {
        close = findMarkdownClose(text, "_", i + 1);
        if (close !== -1 && !isWordChar(text.charAt(close + 1))) {
          appendWrapped("em", null, "_", close);
          continue;
        }
      }

      i++;
    }
    flushPlain(text.length);
  }

  function renderMarkdownText(content, className) {
    var root = h("span", { className: className ? "rw-chat-markdown " + className : "rw-chat-markdown" });
    appendMarkdownInline(root, content || "");
    return root;
  }

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
    // Compose / "new conversation" glyph (document + pencil) — the conventional
    // new-message affordance, kept distinct from the paperclip attach icon.
    compose:   function (s) { return icon([{ d: "M12 20h9" }, { d: "M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" }], s); },
    lock:      function (s) { return icon([{ tag: "rect", x: 4, y: 11, width: 16, height: 10, rx: 2 }, { d: "M8 11V7a4 4 0 0 1 8 0v4" }], s); },
    send:      function (s) { return icon([{ d: "M22 2L11 13" }, { d: "M22 2l-7 20-4-9-9-4 20-7z" }], s); },
    sun:       function (s) { return icon([{ tag: "circle", cx: 12, cy: 12, r: 4 }, { d: "M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" }], s); },
    moon:      function (s) { return icon([{ d: "M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z" }], s); },
    bell:      function (s) { return icon([{ d: "M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" }, { d: "M13.73 21a2 2 0 0 1-3.46 0" }], s); },
    link:      function (s) { return icon([{ d: "M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" }, { d: "M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" }], s); },
    image:     function (s) { return icon([{ tag: "rect", x: 3, y: 4, width: 18, height: 16, rx: 2 }, { tag: "circle", cx: 9, cy: 10, r: 1.5 }, { d: "M21 16l-5-5-8 8" }], s); },
    globe:     function (s) { return icon([{ tag: "circle", cx: 12, cy: 12, r: 10 }, { d: "M2 12h20" }, { d: "M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" }], s); },
    chevRight: function (s) { return icon([{ d: "M9 6l6 6-6 6" }], s, 2); },
    chevLeft:  function (s) { return icon([{ d: "M15 6l-6 6 6 6" }], s, 2); },
    home:      function (s) { return icon([{ d: "M3 11l9-8 9 8" }, { d: "M5 9.5V21h14V9.5" }], s, 2); },
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
        hideLauncher: "Hide launcher",
        collapsedLauncher: "Show feedback launcher",
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
        loggedInAs: "Logged in as {name}",
        loggedIn: "Logged in",
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
        savingDraft: "Redirecting to log in…",
        needSignIn: "You must be signed in to submit a ticket.",
        loginNotConfigured: "This project owner hasn't set up a login URL — submitting isn't available right now.",
        disabledEmpty: "Write something before you submit.",
        disabledLocked: "You're not signed in to this feedback board, so the widget can't submit on your behalf. Sign in on this site and reload — if you already are, the site isn't passing your identity to the widget.",
        failed: "Failed to submit: {msg}",
        reviewRejected: "We couldn't submit this because it appears to contain unsafe instructions.",
        reviewUnavailable: "We couldn't review this right now. Try again shortly.",
        attachFailed: "Your report was posted, but {n} image(s) couldn't be attached. {msg}",
        pastedImage: "Pasted image",
      },
      // Intercom-style home screen (landing view). The chat strings only
      // surface when the bootstrap payload carries `chat: { enabled, … }`
      // — see renderHomeView.
      home: {
        greeting: "Hi 👋 How can we help?",
        chatTitle: "Chat with Agent",
        chatSub: "{name} is ready to help",
        chatSubGeneric: "Tell us what's going on",
        chatComingSoon: "Chat is coming soon.",
        messageTitle: "Send us a message",
        messageSub: "Questions, feedback, ideas — we read everything",
        discussTitle: "Join Open Discussion",
        discussSub: "Vote and weigh in on what gets built next",
        updatesTitle: "View Latest Updates",
        updatesSub: "See what shipped recently",
        back: "Home",
      },
      compose: {
        newPost: "New post",
        title: "Send us a message",
        back: "Back",
      },
      tabs: { updates: "Latest Updates", hot: "Hot", mine: "My Submissions" },
      filters: { unreadOnly: "Unread only", allCaughtUp: "You're all caught up", noUnread: "None of your tickets have new activity right now." },
      notif: { title: "Updates on your tickets", titleN: "{n} ticket update(s)", markAllRead: "Mark all read" },
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
        privateHint: "Only you can see this.",
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
        useComposer: "Tap “New post” to file one.",
        nothingShipped: "No updates yet",
        updatesWillShow: "Updates will show up here once an admin publishes them.",
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
        placeholderNoAttach: "Write a comment…",
        hint: "Paste screenshots with ⌘V",
        submit: "Comment",
        posting: "Posting…",
        uploading: "Uploading…",
        savingDraft: "Redirecting to log in…",
        failed: "Failed to post: {msg}",
        attachFailed: "Your comment was posted, but {n} image(s) couldn't be attached. {msg}",
        signInPrompt: "Sign in to post a comment.",
        disabledPrompt: "Comments are disabled on this ticket.",
      },
      attachErr: {
        unconfigured: "Image storage isn't configured on the server yet.",
        disabled: "Image uploads are currently turned off.",
        tooLarge: "The image is too large (max 5 MB).",
        unsupported: "That image type isn't supported (use PNG, JPG, GIF, or WebP).",
        tooMany: "You've reached the attachment limit for this item.",
        rejected: "That image couldn't be attached because it appears to contain unsafe instructions.",
        reviewUnavailable: "We couldn't review the image right now. Try again shortly.",
      },
      restore: {
        welcomeBack: "Welcome back — your draft is ready to submit.",
        voteWelcomeBack: "Welcome back — click vote again to confirm.",
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
        agentAssigned: "assigned an agent",
        agentAssignedTo: "assigned {to}",
        agentUnassigned: "unassigned the agent",
        prLinked: "started a review",
        prMerged: "merged the changes",
        prClosed: "closed the review",
        ticketCreated: "opened the ticket",
        ticketEdited: "edited the ticket",
        ticketDeleted: "deleted the ticket",
        ticketArchived: "archived the ticket",
        ticketUnarchived: "restored the ticket",
        agentDefault: "Agent",
        agentUpdate: "posted an update",
      },
      chat: {
        back: "Back",
        backToChat: "Back to chat",
        title: "Chat with {name}",
        agentDefault: "Support",
        empty: "Start the conversation — describe your issue or idea and {name} will help you file it.",
        emptyAgentless: "Send us a message — tell us about your issue or idea and we'll get back to you.",
        liveSessionStatus: "{name} is working in the background",
        liveSessionIntro: "Updates show up here as they happen — message anytime to ask a question or steer the work.",
        agentlessIntro: "Our support agent is currently offline. You can still submit a ticket directly — describe your issue or request with as much detail as possible (what happened, steps to reproduce, what you expected), then tap Submit Ticket below.",
        collectPrompt: "Anything more you'd like to add? When you're ready, tap Submit Ticket below — the more detail, the faster we can help.",
        submitTicket: "Submit Ticket",
        submitFailed: "Could not submit the ticket: {msg}",
        submitAgentActive: "An agent has joined this conversation — continue chatting to create the ticket.",
        submitEmpty: "Write a message first — the ticket is created from what you've sent.",
        alreadyTicketed: "A ticket was already created from this conversation.",
        teamDefault: "Team",
        inputPlaceholder: "Type your message…",
        send: "Send",
        typing: "{name} is typing…",
        loadFailed: "Could not load the conversation: {msg}",
        signInPrompt: "Sign in to chat with our support agent.",
        sendFailed: "Could not send: {msg}",
        rateLimited: "You're sending messages too quickly — please wait a moment and try again.",
        uploadFailed: "That image couldn't be uploaded. Please try again.",
        turnCap: "This conversation has reached its message limit. Create a ticket from it or start a new conversation.",
        unavailable: "The agent is unavailable right now — try Open Discussion instead.",
        proposalTitle: "Ready to create this ticket?",
        proposalTitleLabel: "Title",
        proposalDescLabel: "Description",
        proposalIncomplete: "Title and description are both required.",
        proposalPrivate: "Private",
        proposalPublic: "Public",
        proposalPrivateOn: "Only you will see this.",
        proposalPrivateOff: "Others can see and upvote this.",
        createTicket: "Create Ticket",
        creating: "Creating…",
        createFailed: "Could not create the ticket: {msg}",
        dismiss: "Dismiss",
        dismissFailed: "Could not dismiss: {msg}",
        proposalDismissed: "Ticket draft dismissed — the conversation continues.",
        ticketCreated: "Ticket created",
        viewTicket: "View ticket",
        assignAgent: "Assign agent",
        assignedTo: "Assigned to {name}",
        escapeHatch: "Create ticket from this conversation",
        forceRequested: "Preparing a ticket draft from this conversation…",
        closed: "This conversation has ended.",
        startNew: "Start new conversation",
        clearAria: "Start a new conversation",
        clearTitle: "New conversation",
        clearConfirmTitle: "Start a new conversation?",
        clearConfirmBody: "This clears the current chat and starts fresh. Your messages here won't be sent as a ticket.",
        clearConfirm: "Start new",
        clearCancel: "Keep editing",
        clearFailed: "Could not start a new conversation: {msg}",
        transcriptTitle: "Created from a conversation",
        transcriptShow: "Show transcript",
        transcriptHide: "Hide transcript",
        transcriptEmpty: "No messages in this conversation.",
        transcriptYou: "You",
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
        hideLauncher: "런처 숨기기",
        collapsedLauncher: "피드백 런처 표시",
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
        loggedInAs: "{name} 님으로 로그인됨",
        loggedIn: "로그인됨",
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
        savingDraft: "로그인 페이지로 이동 중…",
        needSignIn: "티켓을 제출하려면 로그인해야 합니다.",
        loginNotConfigured: "프로젝트 소유자가 로그인 URL을 설정하지 않아 지금은 제출할 수 없습니다.",
        disabledEmpty: "제출하기 전에 내용을 입력해 주세요.",
        disabledLocked: "이 피드백 보드에 로그인되어 있지 않아 위젯이 대신 제출할 수 없습니다. 이 사이트에서 로그인한 뒤 새로고침하세요 — 이미 로그인했다면 사이트가 위젯에 사용자 인증을 전달하지 않고 있는 것입니다.",
        failed: "제출 실패: {msg}",
        reviewRejected: "안전하지 않은 지시가 포함된 것으로 보여 제출할 수 없습니다.",
        reviewUnavailable: "지금 내용을 검토할 수 없습니다. 잠시 후 다시 시도해 주세요.",
        attachFailed: "신고는 등록되었지만 이미지 {n}개를 첨부하지 못했습니다. {msg}",
        pastedImage: "붙여넣은 이미지",
      },
      home: {
        greeting: "안녕하세요 👋 무엇을 도와드릴까요?",
        chatTitle: "상담원과 채팅",
        chatSub: "{name} 님이 도와드릴 준비가 되어 있어요",
        chatSubGeneric: "어떤 일인지 알려주세요",
        chatComingSoon: "채팅 기능이 곧 제공될 예정입니다.",
        messageTitle: "메시지 보내기",
        messageSub: "질문, 피드백, 아이디어 — 무엇이든 환영해요",
        discussTitle: "공개 토론 참여",
        discussSub: "투표와 의견으로 개발 방향에 참여하세요",
        updatesTitle: "최신 업데이트 보기",
        updatesSub: "최근 배포된 내용을 확인하세요",
        back: "홈",
      },
      compose: {
        newPost: "새 글 쓰기",
        title: "메시지 보내기",
        back: "뒤로",
      },
      tabs: { updates: "최신 업데이트", hot: "인기", mine: "내 제출 내역" },
      filters: { unreadOnly: "읽지 않음만", allCaughtUp: "모두 확인했습니다", noUnread: "현재 새로운 활동이 있는 티켓이 없습니다." },
      notif: { title: "내 티켓 업데이트", titleN: "티켓 업데이트 {n}건", markAllRead: "모두 읽음 처리" },
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
        privateHint: "본인만 볼 수 있습니다.",
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
        useComposer: "“새 글 쓰기” 버튼으로 첫 티켓을 작성해 보세요.",
        nothingShipped: "아직 업데이트가 없습니다",
        updatesWillShow: "관리자가 게시하면 여기에 표시됩니다.",
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
        placeholderNoAttach: "댓글을 작성하세요…",
        hint: "⌘V로 스크린샷 붙여넣기",
        submit: "댓글",
        posting: "게시 중…",
        uploading: "업로드 중…",
        savingDraft: "로그인 페이지로 이동 중…",
        failed: "게시 실패: {msg}",
        attachFailed: "댓글은 등록되었지만 이미지 {n}개를 첨부하지 못했습니다. {msg}",
        signInPrompt: "댓글을 작성하려면 로그인하세요.",
        disabledPrompt: "이 티켓의 댓글이 비활성화되었습니다.",
      },
      attachErr: {
        unconfigured: "서버에 이미지 저장소가 아직 설정되지 않았습니다.",
        disabled: "이미지 업로드가 현재 비활성화되어 있습니다.",
        tooLarge: "이미지가 너무 큽니다 (최대 5MB).",
        unsupported: "지원하지 않는 이미지 형식입니다 (PNG, JPG, GIF, WebP 사용).",
        tooMany: "이 항목의 첨부 한도에 도달했습니다.",
        rejected: "안전하지 않은 지시가 포함된 것으로 보여 이미지를 첨부할 수 없습니다.",
        reviewUnavailable: "지금 이미지를 검토할 수 없습니다. 잠시 후 다시 시도해 주세요.",
      },
      restore: {
        welcomeBack: "다시 오셨네요 — 작성 중이던 내용을 그대로 제출할 수 있어요.",
        voteWelcomeBack: "다시 오셨네요 — 추천 버튼을 다시 눌러 확정해 주세요.",
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
        agentAssigned: "에이전트를 배정했습니다",
        agentAssignedTo: "{to}을(를) 배정했습니다",
        agentUnassigned: "에이전트 배정을 해제했습니다",
        prLinked: "검토를 시작했습니다",
        prMerged: "변경 사항을 병합했습니다",
        prClosed: "검토를 종료했습니다",
        ticketCreated: "티켓을 열었습니다",
        ticketEdited: "티켓을 수정했습니다",
        ticketDeleted: "티켓을 삭제했습니다",
        ticketArchived: "티켓을 보관했습니다",
        ticketUnarchived: "티켓을 복원했습니다",
        agentDefault: "에이전트",
        agentUpdate: "업데이트를 게시했습니다",
      },
      chat: {
        back: "뒤로",
        backToChat: "채팅으로 돌아가기",
        title: "{name}와의 대화",
        agentDefault: "지원 담당",
        empty: "대화를 시작하세요 — 문제나 아이디어를 설명하면 {name}이(가) 티켓 작성을 도와드립니다.",
        emptyAgentless: "메시지를 보내 주세요 — 문제나 아이디어를 알려 주시면 답변드릴게요.",
        liveSessionStatus: "{name}이(가) 백그라운드에서 작업 중이에요",
        liveSessionIntro: "진행 상황이 여기에 표시돼요 — 궁금한 점이나 방향이 있으면 언제든 메시지를 보내 주세요.",
        agentlessIntro: "지금은 상담원이 오프라인 상태예요. 그래도 바로 티켓을 제출하실 수 있어요 — 무슨 일이 있었는지, 재현 방법, 기대했던 동작 등 가능한 한 자세히 알려주신 뒤 아래 '티켓 제출'을 눌러주세요.",
        collectPrompt: "더 추가하실 내용이 있나요? 준비되셨으면 아래 '티켓 제출'을 눌러주세요 — 자세할수록 빠르게 도와드릴 수 있어요.",
        submitTicket: "티켓 제출",
        submitFailed: "티켓을 제출하지 못했습니다: {msg}",
        submitAgentActive: "상담원이 대화에 참여했습니다 — 대화를 이어가며 티켓을 만들어 주세요.",
        submitEmpty: "먼저 메시지를 작성해 주세요 — 보내신 내용으로 티켓이 생성됩니다.",
        alreadyTicketed: "이 대화에서 이미 티켓이 생성되었습니다.",
        teamDefault: "팀",
        inputPlaceholder: "메시지를 입력하세요…",
        send: "보내기",
        typing: "{name} 입력 중…",
        loadFailed: "대화를 불러올 수 없습니다: {msg}",
        signInPrompt: "상담을 시작하려면 로그인하세요.",
        sendFailed: "전송 실패: {msg}",
        rateLimited: "메시지를 너무 빠르게 보내고 있습니다 — 잠시 후 다시 시도해 주세요.",
        uploadFailed: "이미지를 업로드하지 못했습니다. 다시 시도해 주세요.",
        turnCap: "이 대화는 메시지 한도에 도달했습니다. 대화 내용으로 티켓을 만들거나 새 대화를 시작하세요.",
        unavailable: "지금은 에이전트를 이용할 수 없습니다 — 공개 토론을 이용해 보세요.",
        proposalTitle: "이 티켓을 생성할까요?",
        proposalTitleLabel: "제목",
        proposalDescLabel: "설명",
        proposalIncomplete: "제목과 설명을 모두 입력해 주세요.",
        proposalPrivate: "비공개",
        proposalPublic: "공개",
        proposalPrivateOn: "본인에게만 표시됩니다.",
        proposalPrivateOff: "다른 사용자가 보고 추천할 수 있습니다.",
        createTicket: "티켓 생성",
        creating: "생성 중…",
        createFailed: "티켓을 생성하지 못했습니다: {msg}",
        dismiss: "닫기",
        dismissFailed: "초안을 닫지 못했습니다: {msg}",
        proposalDismissed: "티켓 초안을 닫았습니다 — 대화를 계속할 수 있어요.",
        ticketCreated: "티켓이 생성되었습니다",
        viewTicket: "티켓 보기",
        assignAgent: "에이전트 배정",
        assignedTo: "{name}에게 할당됨",
        escapeHatch: "이 대화로 티켓 만들기",
        forceRequested: "대화 내용으로 티켓 초안을 준비하고 있습니다…",
        closed: "대화가 종료되었습니다.",
        startNew: "새 대화 시작",
        clearAria: "새 대화 시작",
        clearTitle: "새 대화",
        clearConfirmTitle: "새 대화를 시작할까요?",
        clearConfirmBody: "현재 대화를 지우고 새로 시작합니다. 여기에 입력한 메시지는 티켓으로 전송되지 않습니다.",
        clearConfirm: "새로 시작",
        clearCancel: "계속 작성",
        clearFailed: "새 대화를 시작하지 못했습니다: {msg}",
        transcriptTitle: "대화에서 생성됨",
        transcriptShow: "대화 내용 보기",
        transcriptHide: "대화 내용 숨기기",
        transcriptEmpty: "대화 메시지가 없습니다.",
        transcriptYou: "나",
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
  // Deploy-environment id→name map for this project, captured from the bootstrap
  // (GET /api/widget/tickets) and ticket-detail responses. Lets us resolve a
  // `deployed:<envId>` status to a human label ("Deployed → Production") instead
  // of leaking the raw env id. Empty until a response carries it.
  var deployEnvironments = [];
  function setDeployEnvironments(list) {
    if (Array.isArray(list)) deployEnvironments = list;
  }
  function isDeployedStatus(s) {
    return s === "deployed" || (typeof s === "string" && s.indexOf("deployed:") === 0);
  }
  // Resolve a `deployed:<envId>` status to its environment name, or null when
  // it's the bare `deployed`, has no env id, or the id isn't in the synced map.
  function deployedEnvName(s) {
    if (typeof s !== "string") return null;
    var i = s.indexOf(":");
    var envId = i >= 0 ? s.slice(i + 1) : "";
    if (!envId) return null;
    for (var k = 0; k < deployEnvironments.length; k++) {
      if (deployEnvironments[k] && deployEnvironments[k].id === envId) {
        return deployEnvironments[k].name || null;
      }
    }
    return null;
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
    // Compound deploy statuses (`deployed:<envId>`) aren't registry keys; label
    // them off the base `deployed` vocabulary + the resolved environment name.
    // Guarded to the compound form (has ':') so the bare `deployed` recurses
    // into the normal registry/locale path below instead of looping.
    if (typeof s === "string" && s.indexOf("deployed:") === 0) {
      var base = localizedStatusLabel("deployed") || "Deployed";
      var envName = deployedEnvName(s);
      return envName ? base + " → " + envName : base;
    }
    var path = "status." + s;
    var localized = t(path);
    if (localized && localized !== path) return localized;
    var R = getStatusRegistry();
    return (R && R[s] && R[s].label) || null;
  }
  function statusMeta(s) {
    var R = getStatusRegistry();
    // A `deployed:<envId>` status carries the base `deployed` colors; only its
    // label changes (resolved to "Deployed → <env name>").
    var entry = R && (isDeployedStatus(s) ? R["deployed"] : R[s]);
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

  // Per-ticket "seen" marks for the viewer's OWN submitted tickets. A ticket is
  // marked seen (with the freshest activity timestamp we know) whenever its
  // detail view renders — opening it, or a live SSE/poll update while it's open.
  // Stored per project so the launcher badge can light up for a team reply that
  // arrived while the panel was closed, then clear once the user reads it.
  function ticketSeenKey() {
    return "rw-ticket-seen:" + (config.projectId || config.project || "default");
  }
  function getTicketSeen() {
    try { return JSON.parse(localStorage.getItem(ticketSeenKey()) || "{}") || {}; }
    catch (_) { return {}; }
  }
  function markTicketSeen(id, whenMs) {
    if (!id) return;
    try {
      var m = getTicketSeen();
      var v = whenMs && !isNaN(whenMs) ? whenMs : Date.now();
      if (!(m[id] >= v)) {
        m[id] = v;
        localStorage.setItem(ticketSeenKey(), JSON.stringify(m));
      }
    } catch (_) {}
  }

  // Live-session unread is tracked on its OWN axis, separate from ticketSeen
  // above. The detail view marks a ticket seen up to its general activity
  // (updatedAt/comments/activity), which can be NEWER than an unread coder
  // reply — so sharing one mark would let merely opening the detail silently
  // clear a live-session reply the assigner never read. This per-ticket mark is
  // advanced ONLY when the live session itself is opened (renderChatMessageList).
  function liveSessionSeenKey() {
    return "rw-livesession-seen:" + (config.projectId || config.project || "default");
  }
  function getLiveSessionSeen() {
    try { return JSON.parse(localStorage.getItem(liveSessionSeenKey()) || "{}") || {}; }
    catch (_) { return {}; }
  }
  function markLiveSessionSeen(id, whenMs) {
    if (!id) return;
    try {
      var m = getLiveSessionSeen();
      var v = whenMs && !isNaN(whenMs) ? whenMs : Date.now();
      if (!(m[id] >= v)) {
        m[id] = v;
        localStorage.setItem(liveSessionSeenKey(), JSON.stringify(m));
      }
    } catch (_) {}
  }

  // True when a ticket's linked live session has a coder/teammate reply
  // (liveSessionLastMessageAt, populated only on assigned-ticket DTOs) that the
  // assigner hasn't read. Baseline = when they last OPENED the session, or — if
  // never opened — the ticket's creation time. Independent of ticketSeen, so
  // viewing the ticket detail does not clear it; only opening the session does.
  function hasUnreadLiveSession(ticket) {
    if (!config.isIdentified || !ticket || !ticket.liveSessionLastMessageAt) return false;
    var msg = new Date(ticket.liveSessionLastMessageAt).getTime();
    if (isNaN(msg)) return false;
    var seen = getLiveSessionSeen();
    var base = seen[ticket.id] != null ? seen[ticket.id] : new Date(ticket.createdAt || 0).getTime();
    return msg > base;
  }

  // True when one of the viewer's OWN tickets has activity/comments they
  // haven't viewed yet (a team reply or status change). The single source of
  // truth for both the launcher count and the per-row "needs attention" dot.
  //
  // GATED ON lastActivityAt: only the viewer's own tickets (from
  // listMyTickets) carry it. Community Hot/Updates rows do NOT, so they can
  // never flag — this is what keeps the marker off tickets the user didn't
  // create. (Do NOT fall back to updatedAt here: community tickets routinely
  // have updatedAt > createdAt and would all light up.)
  //
  // Baseline = when they last viewed it, or — if never opened — its creation
  // time, so a ticket only flags once something happens AFTER it was filed.
  // Anon viewers never flag.
  function ticketHasUnseenActivity(ticket) {
    if (!config.isIdentified || !ticket || !ticket.lastActivityAt) return false;
    var updated = new Date(ticket.lastActivityAt).getTime();
    var seen = getTicketSeen();
    var base = seen[ticket.id] != null ? seen[ticket.id] : new Date(ticket.createdAt || 0).getTime();
    return updated > base;
  }

  // Gate the assigned-session unread signal on live_coder ONLY — the same
  // permission that gates the "Live session" button (the only surface that
  // clears live-session unread). An assign_agent-only viewer can assign a coder
  // but cannot open the session, so giving them the badge would strand it
  // unclearable. Lighting it only for live_coder holders keeps it clearable.
  function viewerCanLiveCoder() {
    var p = currentUser.permissions || [];
    return p.indexOf("live_coder") !== -1;
  }

  // Deduped list of the viewer's tickets that warrant attention, by TWO distinct
  // signals kept on their own axes:
  //   - reported tickets (myTicketsCache) → general activity unread
  //     (ticketHasUnseenActivity: a team reply / status change since last view)
  //   - assigned live sessions (assignedTicketsCache) → an unread coder/teammate
  //     REPLY (hasUnreadLiveSession), cleared only by opening the session
  // A ticket the viewer both reported AND assigned is counted once (either
  // signal qualifies it). Deliberately NOT unioned with the community "Updates"
  // feed — that count lives on the "View Latest Updates" home card.
  function unreadTickets() {
    if (!config.isIdentified) return [];
    var byId = {};
    var out = [];
    var consider = function (tk, isUnread) {
      if (!tk || !tk.id || byId[tk.id]) return;
      if (!isUnread(tk)) return;
      byId[tk.id] = true; out.push(tk);
    };
    (myTicketsCache || []).forEach(function (tk) { consider(tk, ticketHasUnseenActivity); });
    (assignedTicketsCache || []).forEach(function (tk) { consider(tk, hasUnreadLiveSession); });
    return out;
  }

  // Launcher badge = how many of the viewer's submitted-or-assigned tickets need
  // attention (see unreadTickets).
  function launcherBadgeCount() {
    return unreadTickets().length;
  }

  // Community "Updates" newer than the last panel-open (bounded to a week) —
  // shown as the count on the "View Latest Updates" home card. This is the
  // community-recency signal that previously rode on the launcher badge.
  function newUpdatesCount() {
    var rows = updatesCache || [];
    if (rows.length === 0) return 0;
    var threshold = Math.max(getLastOpenedAt(), Date.now() - WEEK_MS);
    var n = 0;
    for (var i = 0; i < rows.length; i++) {
      var when = new Date(rows[i].completedAt || rows[i].createdAt || 0).getTime();
      if (when > threshold) n++;
    }
    return n;
  }

  // ===========================================================================
  // Launcher collapse preference
  //
  // Users can hide the launcher pill via a chevron that appears on hover; the
  // pill then tucks against the screen edge with only a few pixels showing.
  // The flag is sticky (project-scoped localStorage) and is suppressed when
  // there are unread updates so an actionable badge can never be hidden away.
  //
  // The stored value is tri-state: "1" = explicitly collapsed, "0" = explicitly
  // expanded, absent = no preference yet (use the per-device default). On mobile
  // viewports the no-preference default is *collapsed* so the pill doesn't eat
  // scarce screen real estate before the visitor has engaged with it; on desktop
  // it defaults to expanded. An explicit choice (either direction) always wins
  // and stays sticky across devices.
  // ===========================================================================

  // Matches the widget's own mobile CSS breakpoint (@media max-width: 640px).
  function isMobileViewport() {
    try {
      return !!(window.matchMedia && window.matchMedia("(max-width: 640px)").matches);
    } catch (_) {
      return false;
    }
  }
  function collapsedStorageKey() {
    return "rw-collapsed:" + (config.projectId || config.project || "default");
  }
  // Explicit, user-set preference only: true = explicitly collapsed,
  // false = explicitly expanded, null = no preference yet (fall back to the
  // per-device default in shouldRenderCollapsed).
  function getCollapsedPref() {
    try {
      var stored = localStorage.getItem(collapsedStorageKey());
      if (stored === "1") return true;
      if (stored === "0") return false;
      return null;
    } catch (_) {
      return null;
    }
  }
  function setCollapsed(val) {
    try {
      localStorage.setItem(collapsedStorageKey(), val ? "1" : "0");
    } catch (_) {}
  }
  function shouldRenderCollapsed() {
    var pref = getCollapsedPref();
    if (pref === null) {
      // No explicit choice yet → per-device default. On mobile the pill
      // stays collapsed unconditionally so it never eats scarce screen
      // space; an unread badge does NOT pop it open here. (Tapping the
      // pill records an explicit "expanded" pref, so a visitor who wants
      // it open still gets a sticky result — see the tab click handler.)
      return isMobileViewport();
    }
    // Explicit preference. An explicit *collapse* is still suppressed while
    // there are unread updates so an actionable badge is never hidden away
    // (original desktop hover-to-hide behavior). An explicit *expand* wins
    // outright.
    return pref && launcherBadgeCount() === 0;
  }
  function applyCollapsedState() {
    if (!tabEl) return;
    var collapsed = shouldRenderCollapsed();
    tabEl.classList.toggle("rw-tab--collapsed", collapsed);
    tabEl.setAttribute(
      "aria-label",
      collapsed ? t("aria.collapsedLauncher") : t("aria.openPanel")
    );
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

  // Inline chevron that toggles the launcher between expanded and collapsed.
  // The arrow always points in the direction the pill will *move* when
  // clicked, which is how every IDE sidebar handles collapse affordances:
  //   - expanded:  arrow points TOWARD the anchored edge (motion = tuck)
  //   - collapsed: arrow points AWAY from the edge       (motion = come back)
  // Visible only when the pill is hovered; in the peeked (collapsed+hover)
  // state the chevron becomes the "permanently un-hide" affordance —
  // clicking the pill body still opens the panel as before, but the
  // chevron lets the user pin it visible without opening anything.
  function buildHideBtn() {
    var isRight = config.position === "right";
    var collapsed = shouldRenderCollapsed();
    // XOR: expanded+right or collapsed+left → point right (>); otherwise left (<).
    var pointRight = isRight !== collapsed;
    var label = collapsed ? t("aria.collapsedLauncher") : t("aria.hideLauncher");
    var btn = h("span", {
      className: "rw-tab-hide-btn",
      role: "button",
      tabindex: "-1",
      "aria-label": label,
      title: label,
    });
    var path = pointRight ? "M10 6l6 6-6 6" : "M14 6l-6 6 6 6";
    var svg = h("svg", {
      width: 9, height: 9, viewBox: "0 0 24 24",
      fill: "none", stroke: "currentColor",
      "stroke-width": 2.4, "stroke-linecap": "round", "stroke-linejoin": "round",
      "aria-hidden": "true",
    });
    svg.appendChild(h("path", { d: path }));
    btn.appendChild(svg);
    btn.addEventListener("click", function (e) {
      // Stop the click bubbling to tabEl which would otherwise open the panel.
      e.stopPropagation();
      // Toggle the rendered state. If a badge is forcing the pill open we
      // still flip the underlying preference; the next render that lacks
      // a badge will honor it.
      var nowCollapsed = !shouldRenderCollapsed();
      setCollapsed(nowCollapsed);
      refreshTabLabel();
      if (!tabEl) return;
      if (nowCollapsed) {
        // The pointer is still over the pill right after this click, so the
        // `.rw-tab--collapsed:hover` peek rule would immediately un-tuck it
        // and the collapse would appear to do nothing. Suppress the peek
        // until the pointer leaves the pill once, so the tuck is visible
        // right away; afterwards hovering peeks the sliver back as usual.
        tabEl.classList.add("rw-tab--peek-suppressed");
        tabEl.addEventListener("mouseleave", function onLeave() {
          tabEl.classList.remove("rw-tab--peek-suppressed");
          tabEl.removeEventListener("mouseleave", onLeave);
        });
      } else {
        tabEl.classList.remove("rw-tab--peek-suppressed");
      }
    });
    return btn;
  }

  function buildTabContent() {
    var n = launcherBadgeCount();
    var isRight = config.position === "right";
    var nodes = [];
    // Hide chevron lives on the protruding side: left of the pill for a
    // right-anchored launcher, right for a left-anchored one. Order in the
    // flex container is the only thing that places it.
    if (isRight) nodes.push(buildHideBtn());
    nodes.push(buildTabIcon());
    nodes.push(h("span", { className: "rw-tab-label" }, "HQ"));
    if (n > 0) {
      nodes.push(h("span", { className: "rw-tab-count" }, n > 99 ? "99+" : String(n)));
    }
    if (!isRight) nodes.push(buildHideBtn());
    return nodes;
  }

  function refreshTabLabel() {
    if (!tabEl) return;
    clearChildren(tabEl);
    buildTabContent().forEach(function (c) { tabEl.appendChild(c); });
    // Unread count may have changed (e.g. updates fetched, panel opened),
    // and the collapsed state is suppressed when a badge is showing — so
    // re-evaluate every time the label rebuilds.
    applyCollapsedState();
    // The in-panel notifications bell mirrors the same unseen-ticket count.
    refreshNotifBell();
  }

  // ===========================================================================
  // Header notifications bell — ticket-update alerts for the viewer's own
  // tickets. Shows the unseen count as a badge; clicking opens a dropdown that
  // lists exactly which tickets have new activity, each opening its detail.
  // ===========================================================================

  function refreshNotifBell() {
    if (!notifBellBtn) return;
    // Only identified viewers have "my tickets" to be notified about.
    if (notifWrap) notifWrap.style.display = config.isIdentified ? "" : "none";
    var n = launcherBadgeCount();
    clearChildren(notifBellBtn);
    notifBellBtn.appendChild(Icons.bell(16));
    if (n > 0) {
      notifBellBtn.appendChild(h("span", { className: "rw-notif-badge" }, n > 99 ? "99+" : String(n)));
    }
    notifBellBtn.setAttribute("aria-label", n > 0 ? t("notif.titleN", { n: n }) : t("notif.title"));
    if (notifOpen) renderNotifDropdown(); // keep an open dropdown in sync
  }

  function closeNotifDropdown() {
    notifOpen = false;
    if (notifDropdownEl && notifDropdownEl.parentNode) notifDropdownEl.parentNode.removeChild(notifDropdownEl);
    notifDropdownEl = null;
    if (notifOutsideHandler && shadowRoot) {
      shadowRoot.removeEventListener("mousedown", notifOutsideHandler);
      notifOutsideHandler = null;
    }
  }

  // Mark every cached ticket read across BOTH unread axes (general activity +
  // live-session replies), up to the latest known timestamp for each. Clears
  // the launcher/bell counts and the per-row dots. localStorage-backed, so this
  // is per-browser-profile (there is no server-side read state).
  function markAllTicketsRead() {
    var all = (myTicketsCache || []).concat(assignedTicketsCache || []);
    for (var i = 0; i < all.length; i++) {
      var tk = all[i];
      if (!tk || !tk.id) continue;
      if (tk.lastActivityAt) markTicketSeen(tk.id, new Date(tk.lastActivityAt).getTime());
      if (tk.liveSessionLastMessageAt) markLiveSessionSeen(tk.id, new Date(tk.liveSessionLastMessageAt).getTime());
    }
    refreshTabLabel();
  }

  function renderNotifDropdown() {
    if (notifDropdownEl && notifDropdownEl.parentNode) notifDropdownEl.parentNode.removeChild(notifDropdownEl);
    var items = unreadTickets();
    var listEl = h("div", { className: "rw-notif-list" });
    if (items.length === 0) {
      listEl.appendChild(h("div", { className: "rw-notif-empty" }, t("filters.noUnread")));
    } else {
      items.forEach(function (tk) {
        var row = h("button", { className: "rw-notif-item", type: "button" }, [
          h("span", { className: "rw-unseen-dot" }),
          h("div", { className: "rw-notif-item-text" }, [
            h("div", { className: "rw-notif-item-title" }, tk.title),
            h("div", { className: "rw-notif-item-when" }, timeAgo(tk.lastActivityAt || tk.updatedAt || tk.createdAt)),
          ]),
        ]);
        row.addEventListener("click", function () {
          closeNotifDropdown();
          if (!isOpen) openPanel();
          openDetailModal(tk);
        });
        listEl.appendChild(row);
      });
    }
    var headChildren = [h("span", { className: "rw-notif-head-title" }, t("notif.title"))];
    if (items.length > 0) {
      var markAllBtn = h("button", { className: "rw-notif-markread", type: "button" }, t("notif.markAllRead"));
      markAllBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        markAllTicketsRead();
        renderNotifDropdown(); // re-render → empty state, count cleared
      });
      headChildren.push(markAllBtn);
    }
    notifDropdownEl = h("div", { className: "rw-notif-dropdown", role: "menu" }, [
      h("div", { className: "rw-notif-head" }, headChildren),
      listEl,
    ]);
    notifWrap.appendChild(notifDropdownEl);
  }

  function toggleNotifDropdown() {
    if (notifOpen) { closeNotifDropdown(); return; }
    notifOpen = true;
    renderNotifDropdown();
    // Close on any click outside the bell/dropdown (composedPath crosses the
    // shadow boundary, so this works from inside the widget's shadow root).
    notifOutsideHandler = function (e) {
      var path = e.composedPath ? e.composedPath() : [];
      if (notifWrap && path.indexOf(notifWrap) === -1) closeNotifDropdown();
    };
    if (shadowRoot) shadowRoot.addEventListener("mousedown", notifOutsideHandler);
  }
  function resolveInitialTheme(opt) {
    if (opt === "dark" || opt === "light") return opt;
    try {
      var stored = localStorage.getItem(themeStorageKey());
      if (stored === "dark" || stored === "light") return stored;
    } catch (_) {}
    // Default to light regardless of the visitor's OS dark-mode preference;
    // dark only takes hold via explicit config or a saved user toggle.
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
      '  --rw-warn: #b45309; --rw-warn-line: #f59e0b;',
      '  --rw-serif: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;',
      '}',
      /* Warm charcoal dark — matches dashboard.css. */
      '.rw-stage[data-theme="dark"], .rw-modal-mount[data-theme="dark"] {',
      '  --rw-bg: #1f1a14; --rw-panel: #2a231b; --rw-panel-2: #251f17; --rw-panel-3: #2f2820;',
      '  --rw-line: rgba(255,243,219,0.08); --rw-line-2: rgba(255,243,219,0.14);',
      '  --rw-fg: #f0e9d9; --rw-fg-2: #c8c0ad; --rw-muted: #8e8676; --rw-muted-2: #6e6759;',
      '  --rw-accent: #818cf8; --rw-accent-ink: #1f1a14;',
      '  --rw-warn: #fbbf24; --rw-warn-line: #d97706;',
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
      '  height: 38px; min-width: 72px;',
      /* Asymmetric padding: more on the interior side (where icon + label
         live), tight on the protruding side so the chevron handle sits
         close to the screen edge with minimal visual breathing room. */
      '  padding: ' + (isRight ? "0 4px 0 12px" : "0 12px 0 4px") + ';',
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
      '  border-radius: ' + (isRight ? "10px 0 0 10px" : "0 10px 10px 0") + ';',
      '  z-index: 2147483646;',
      '  transition: padding .15s ease, box-shadow .2s ease, filter .15s ease, transform .15s ease;',
      '  box-shadow: 0 6px 16px -8px rgba(0,0,0,0.35), inset 0 0 0 1px rgba(255,255,255,0.08);',
      '  user-select: none; -webkit-user-select: none;',
      '  white-space: nowrap;',
      '}',
      /* Hover slides the pill out a few pixels for affordance — direction
         depends on which edge we're attached to. The vertical anchor
         (translateY) is preserved so middle-anchored tabs stay centered.
         Suppressed during the collapsed peek so the only motion at that
         point is the pill un-tucking from the edge. */
      '.rw-tab:not(.rw-tab--collapsed):hover { filter: brightness(1.06); padding-' + (isRight ? "left" : "right") + ': 16px; }',
      '.rw-tab--collapsed:hover { filter: brightness(1.06); }',
      /* Top / bottom anchored variants override the default centered transform. */
      '.rw-tab--top    { top: 24px;    bottom: auto; transform: none; }',
      '.rw-tab--bottom { top: auto;    bottom: 24px; transform: none; }',

      /* Toggle chevron — slim handle on the protruding edge of the pill.
         Width animates from 0 to 9px on parent hover so the pill visibly
         grows to reveal the affordance; collapses back when the pointer
         leaves. Visible on hover in BOTH the expanded and peeked states:
         in the expanded state it collapses; in the peeked state it pins
         the pill open. Box-sizing is overridden to content-box so the
         animated `width` applies to the icon only — the static padding
         and 1px hairline divider that visually separates it from the
         HQ/badge cluster sit on top. The divider only materializes on
         hover so the resting pill stays clean; the parent's `gap: 6px`
         keeps it from butting against the badge. */
      '.rw-tab-hide-btn {',
      '  display: inline-flex; align-items: center; justify-content: center;',
      '  flex: 0 0 auto;',
      '  box-sizing: content-box;',
      '  width: 0; height: 22px;',
      '  color: rgba(255,255,255,0.78);',
      '  padding: 0;',
      '  border-' + (isRight ? "right" : "left") + ': 0 solid rgba(255,255,255,0);',
      '  overflow: hidden;',
      '  opacity: 0; pointer-events: none;',
      '  cursor: pointer;',
      '  transition: width .15s ease, opacity .12s ease 0s, color .12s ease, padding .15s ease, border-color .15s ease;',
      '}',
      '.rw-tab:hover .rw-tab-hide-btn {',
      '  width: 9px;',
      '  opacity: 1; pointer-events: auto;',
      '  padding-' + (isRight ? "right" : "left") + ': 5px;',
      '  border-' + (isRight ? "right" : "left") + '-width: 1px;',
      '  border-' + (isRight ? "right" : "left") + '-color: rgba(255,255,255,0.20);',
      '}',
      '.rw-tab-hide-btn:hover { color: #ffffff; }',
      '.rw-tab-hide-btn > svg { display: block; flex: 0 0 auto; }',

      /* Collapsed state — pill slides toward the screen edge, leaving only
         a 5px sliver visible. The transform composes with the existing
         vertical anchor (translateY for middle, none for top/bottom).
         Hovering the pill (or its enlarged hit zone) cancels the X shift
         so the pill peeks back to its rest position; the existing 0.15s
         transform transition keeps the slide smooth. */
      '.rw-tab--collapsed {',
      '  transform: translate(' + (isRight ? "calc(100% - 5px)" : "calc(-100% + 5px)") + ', -50%);',
      /* Subtle inner shadow on the visible sliver hints at the tucked edge. */
      '  box-shadow: 0 6px 16px -8px rgba(0,0,0,0.35), inset 0 0 0 1px rgba(255,255,255,0.08), inset ' + (isRight ? "6px" : "-6px") + ' 0 12px -8px rgba(0,0,0,0.25);',
      '}',
      '.rw-tab--top.rw-tab--collapsed,',
      '.rw-tab--bottom.rw-tab--collapsed {',
      '  transform: translateX(' + (isRight ? "calc(100% - 5px)" : "calc(-100% + 5px)") + ');',
      '}',
      '.rw-tab--collapsed:hover { transform: translateY(-50%); }',
      '.rw-tab--top.rw-tab--collapsed:hover,',
      '.rw-tab--bottom.rw-tab--collapsed:hover { transform: none; }',
      /* Immediately after an explicit collapse (chevron click) the pointer is
         still over the pill, which would trigger the peek rules above and
         leave it un-tucked. This transient class — set on the collapse click,
         cleared on the next pointer-leave — re-asserts the tucked transform so
         the collapse is visible right away. Higher specificity than the
         :hover peek rules, so it wins while present. */
      '.rw-tab--collapsed.rw-tab--peek-suppressed:hover {',
      '  transform: translate(' + (isRight ? "calc(100% - 5px)" : "calc(-100% + 5px)") + ', -50%);',
      '}',
      '.rw-tab--top.rw-tab--collapsed.rw-tab--peek-suppressed:hover,',
      '.rw-tab--bottom.rw-tab--collapsed.rw-tab--peek-suppressed:hover {',
      '  transform: translateX(' + (isRight ? "calc(100% - 5px)" : "calc(-100% + 5px)") + ');',
      '}',
      /* Enlarged invisible hit zone — extends ~22px into the screen
         interior so users can find and hover the 5px sliver without
         pixel-perfect aim. Only active in the collapsed state; in normal
         state the pill itself is the hit target. */
      '.rw-tab--collapsed::before {',
      '  content: ""; position: absolute; top: 0; bottom: 0;',
      '  ' + (isRight ? "right: 100%" : "left: 100%") + '; width: 22px;',
      '  pointer-events: auto;',
      '}',

      /* ------------------------------------------------------------------
         Mercury launcher mark — see buildTabIcon() for the SVG composition.
         The icon container is just a positioning shell. The SVG renders an
         80×80 viewBox into a 26×26 box (scale ≈0.325), so all design-space
         pixel offsets in the keyframes below shrink proportionally on
         screen. No glow/halo — the mark sits flat with only a faint neutral
         contrast shadow so it stays legible on light backgrounds. */
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
      '  filter: drop-shadow(0 1px 2px rgba(0,0,0,0.28));',
      '}',
      '.rw-merc-blob > svg {',
      '  display: block; width: 100%; height: 100%;',
      '  overflow: visible;',
      '  position: relative; z-index: 1;',
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
      '  .rw-merc-base, .rw-merc-bulge, .rw-merc-tint, .rw-merc-spec {',
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

      /* widget shell — fixed full-viewport scrim layer. Pinned to the top of
         the stage; the launcher tab still sits at the screen edge as before.
         The card inside is absolutely positioned (not flex-centered) so every
         geometry property is a transitionable length — that is what lets
         in-panel navigation (home ↔ list ↔ chat) morph smoothly. */
      '.rw-shell-scrim {',
      '  position: fixed; inset: 0;',
      '  background: rgba(20,16,12,0.55);',
      '  -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);',
      '  z-index: 2147483645;',
      '  opacity: 0; pointer-events: none;',
      '  transition: opacity .18s ease;',
      '}',
      /* While open, background/blur also transition so the compact↔expanded
         mode flip (home ↔ list) cross-fades the scrim in step with the
         geometry morph. Closed keeps the plain opacity fade. */
      '.rw-shell-scrim.rw-open {',
      '  opacity: 1; pointer-events: auto;',
      '  transition: opacity .18s ease, background-color .25s ease, -webkit-backdrop-filter .25s ease, backdrop-filter .25s ease;',
      '}',
      '.rw-shell-scrim[data-theme="dark"] { background: rgba(6,5,4,0.66); }',

      /* the card itself — centered via top/left 50% + translate(-50%,-50%),
         the absolute-positioning equivalent of the old flex centering. Width
         used to resolve against the scrim\'s 28px-padded content box; the
         explicit calc(100% - 56px) reproduces the same result. */
      '.rw-shell {',
      '  position: absolute;',
      '  top: 50%; left: 50%;',
      '  transform: translate(-50%, -50%);',
      '  width: min(720px, calc(100% - 56px));',
      '  height: min(680px, calc(100vh - 56px));',
      '  min-height: 540px;',
      '  display: flex; flex-direction: column;',
      '}',
      /* Geometry morph is gated on .rw-open: mode flips while the panel is
         CLOSED (openPanel pre-sets the mode, then flushes styles, then adds
         rw-open) snap instantly — so deep-link opens paint expanded from the
         first frame, and every open lands directly at its final geometry.
         In-panel navigation (home ↔ list ↔ chat) morphs at .25s. */
      '.rw-shell-scrim.rw-open .rw-shell {',
      '  pointer-events: auto;',
      '  transition: top .25s ease, left .25s ease, width .25s ease, height .25s ease, transform .25s ease;',
      '}',

      '@media (prefers-reduced-motion: reduce) {',
      '  .rw-shell-scrim.rw-open { transition: opacity .18s ease; }',
      '  .rw-shell-scrim.rw-open .rw-shell { transition: none; }',
      '}',
      /* 100dvh excludes the iOS/Android dynamic toolbar so the top
         (shell-actions) and bottom (composer) aren't clipped behind
         browser chrome. The 100vh line is the fallback for older
         browsers that don't parse dvh. Mobile keeps one near-full-screen
         layout for every view. */
      '@media (max-width: 640px) {',
      '  .rw-shell {',
      '    top: 0; left: 0; transform: none;',
      '    width: 100%; height: 100vh; height: 100dvh; min-height: 0;',
      '  }',
      '}',

      /* The open "pop" (translateY + scale → none) used to live on .rw-shell,
         but the shell\'s transform is now positional (centering / corner
         anchoring), so the entrance animation moved one level down. */
      '.rw-card-modal {',
      '  position: relative;',
      '  transform: translateY(8px) scale(0.99);',
      '  transition: transform .22s cubic-bezier(0.16,1,0.3,1);',
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
      '.rw-shell-scrim.rw-open .rw-card-modal { transform: none; }',
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

      /* list view: single full-width panel (tab bar + list) */
      '.rw-list-panel {',
      '  display: flex; flex-direction: column;',
      '  flex: 1 1 auto; min-height: 0; min-width: 0;',
      '  padding: 22px 4px 0;',
      '}',

      /* brand tag — used by the Home footer */
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

      /* inline composer (compose face) */
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
      '.rw-inline-submit:not(:disabled):not([aria-disabled="true"]):hover { transform: translateY(-1px); filter: brightness(1.04); box-shadow: 0 8px 18px -10px color-mix(in oklab, var(--rw-accent) 60%, transparent); }',
      /* Disabled state keeps the accent color but fades the whole button —
         hint that submit is real, just not yet armed (vs. swapping to a
         transparent ghost button which felt like a different control).
         `:disabled` = transient in-flight (posting); `[aria-disabled]` =
         soft-locked (empty / no permission) and still hoverable so its
         `title` reason shows. */
      '.rw-inline-submit:disabled, .rw-inline-submit[aria-disabled="true"] { cursor: not-allowed; opacity: 0.45; }',
      /* Instant reason tooltip for the soft-locked submit buttons. Driven by
         data-rw-reason (set in setSubmitReason) so it appears the moment the
         pointer/focus lands — no transition, no delay, unlike the native
         `title` attribute. Shared by both composer submit buttons. */
      '.rw-inline-submit[data-rw-reason], .rw-submit-btn[data-rw-reason] { position: relative; }',
      '.rw-inline-submit[data-rw-reason]:hover::after, .rw-inline-submit[data-rw-reason]:focus-visible::after,',
      '.rw-submit-btn[data-rw-reason]:hover::after, .rw-submit-btn[data-rw-reason]:focus-visible::after {',
      '  content: attr(data-rw-reason);',
      '  position: absolute; bottom: calc(100% + 8px); right: 0;',
      '  width: max-content; max-width: 240px;',
      '  padding: 7px 10px; border-radius: 8px;',
      '  background: var(--rw-fg); color: var(--rw-bg);',
      '  font: inherit; font-size: 11.5px; font-weight: 500; line-height: 1.4;',
      '  letter-spacing: 0; white-space: normal; text-align: left;',
      '  box-shadow: 0 6px 20px -8px rgba(0,0,0,0.45);',
      '  opacity: 1; pointer-events: none; z-index: 60;',
      '}',
      '.rw-inline-notice { margin-top: 10px; }',
      /* Privacy hint sits next to the Private toggle and explains the
         consequence of the toggle to first-time users. */
      '.rw-priv-hint { font-size: 10.5px; color: var(--rw-muted); margin-left: 8px; letter-spacing: 0; }',

      /* dashboard tab row — underline-active tabs left, [+ New post] right */
      '.rw-dash-tabs {',
      '  display: flex; align-items: center; gap: 0;',
      '  padding: 0 22px 10px;',
      '  border-bottom: 1px solid var(--rw-line);',
      '}',
      '.rw-dash-tabs-row { display: flex; align-items: center; gap: 0; }',
      '.rw-new-post-btn {',
      '  margin-left: auto; display: inline-flex; align-items: center; gap: 6px;',
      '  padding: 6px 12px 6px 10px;',
      '  background: var(--rw-accent); border: 1px solid var(--rw-accent);',
      '  border-radius: 999px;',
      '  color: var(--rw-accent-ink); font: inherit; font-size: 12px; font-weight: 500;',
      '  cursor: pointer; flex: 0 0 auto;',
      '  transition: filter .12s, transform .12s;',
      '}',
      '.rw-new-post-btn:hover { filter: brightness(1.06); }',
      '.rw-new-post-btn:active { transform: translateY(1px); }',
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
      '  padding: 14px 10px;',
      '  cursor: pointer; font-family: inherit; color: var(--rw-fg);',
      '  transition: background 120ms;',
      '}',
      '.rw-dash-row:hover { background: color-mix(in oklab, var(--rw-accent) 5%, transparent); }',
      '.rw-dash-row:last-child { border-bottom: 0; }',
      /* "needs attention": a clean leading dot + slightly bolder title. No
         heavy wash or left bar — that read as a rendering glitch. The dot is
         inline so the title keeps its 2-line clamp. */
      '.rw-dash-row--unseen .rw-dash-row-title { font-weight: 650; }',
      '.rw-unseen-dot { display: inline-block; width: 7px; height: 7px; border-radius: 999px; background: var(--rw-accent, #2563eb); margin-right: 7px; vertical-align: middle; flex: 0 0 auto; }',
      // On the accent-filled "Live session" button the default accent dot blends
      // into the button background — give it an alert red + white ring so it
      // reads as an unread indicator regardless of theme.
      '.rw-staff-btn--primary .rw-unseen-dot { background: #ef4444; box-shadow: 0 0 0 1.5px rgba(255,255,255,0.85); }',
      /* "Unread only" filter toggle (My Submissions) */
      '.rw-unread-filter-row { display: flex; padding: 2px 10px 10px; }',
      '.rw-unread-filter { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--rw-line-2); background: transparent; color: var(--rw-fg-2); font-size: 12px; font-weight: 500; font-family: inherit; cursor: pointer; transition: background 120ms, border-color 120ms, color 120ms; }',
      '.rw-unread-filter:hover { border-color: var(--rw-accent); color: var(--rw-fg); }',
      '.rw-unread-filter.rw-on { background: color-mix(in oklab, var(--rw-accent) 14%, transparent); border-color: var(--rw-accent); color: var(--rw-fg); }',
      '.rw-unread-filter-dot { width: 7px; height: 7px; border-radius: 999px; background: var(--rw-accent, #2563eb); flex: 0 0 auto; }',
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
      /* "Private" badge on a card's meta row — a non-interactive marker (the
         clickable toggle lives in the detail head). Mirrors .rw-vis-chip's
         resting look so the two read as the same concept. */
      '.rw-meta-private {',
      '  display: inline-flex; align-items: center; gap: 4px;',
      '  padding: 1px 7px 1px 6px;',
      '  border-radius: 999px;',
      '  background: var(--rw-panel-2);',
      '  border: 1px solid var(--rw-line);',
      '  color: var(--rw-fg-2);',
      '  font-size: 10.5px; font-weight: 500; line-height: 1.6; white-space: nowrap;',
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
      '  display: flex; align-items: center;',
      /* Right padding leaves room for the absolute-positioned shell
         actions (notifications + theme + close). */
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

      /* Intercom-style home view: greeting + navigation cards. Reuses the
         left pane's warm panel treatment so Home reads as the same product
         surface, not new chrome. Top padding clears the absolute-positioned
         shell actions (theme + close). */
      '.rw-home {',
      '  flex: 1 1 auto; min-height: 0; overflow-y: auto;',
      '  display: flex; flex-direction: column;',
      '  padding: 54px 24px 20px;',
      '  background: var(--rw-panel);',
      '  background-image: radial-gradient(420px 320px at 70% 100%, color-mix(in oklab, var(--rw-accent) 6%, transparent), transparent 70%);',
      '}',
      '.rw-shell[data-theme="dark"] .rw-home {',
      '  background-image: radial-gradient(420px 320px at 70% 100%, color-mix(in oklab, var(--rw-accent) 14%, transparent), transparent 70%);',
      '}',
      '.rw-home-greet { margin-bottom: 16px; }',
      '.rw-home-greet-title {',
      '  font-family: var(--rw-serif);',
      '  font-size: 20px; font-weight: 500; letter-spacing: -0.01em;',
      '  color: var(--rw-fg);',
      '}',
      '.rw-home-cards { display: flex; flex-direction: column; gap: 8px; width: 100%; }',
      '.rw-home-card {',
      '  display: flex; align-items: center; gap: 12px;',
      '  width: 100%; text-align: left;',
      '  padding: 12px 14px;',
      '  background: var(--rw-bg); border: 1px solid var(--rw-line-2);',
      '  border-radius: 12px;',
      '  color: var(--rw-fg); font: inherit;',
      '  cursor: pointer;',
      '  transition: border-color .12s, transform .12s, box-shadow .12s;',
      '}',
      '.rw-home-card:hover { border-color: var(--rw-accent); box-shadow: 0 4px 16px -10px rgba(42,37,32,0.30); }',
      '.rw-home-card:active { transform: translateY(1px); }',
      '.rw-home-card-emoji { font-size: 22px; line-height: 1; flex: 0 0 auto; }',
      '.rw-home-card-count { min-width: 20px; height: 20px; padding: 0 6px; border-radius: 10px; background: var(--rw-accent, #2563eb); color: #fff; font-size: 11px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; }',
      '.rw-home-card-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 auto; }',
      '.rw-home-card-title { font-size: 14px; font-weight: 600; }',
      '.rw-home-card-sub { font-size: 12px; color: var(--rw-muted); }',
      '.rw-home-card-chev { color: var(--rw-muted); flex: 0 0 auto; display: inline-flex; }',
      '.rw-home-powered { margin-top: auto; padding-top: 18px; }',
      '@media (max-width: 640px) { .rw-home { padding: 64px 20px 20px; } }',

      /* Compose face — compact like home/chat, same warm panel treatment as
         Home so the message flow reads as one surface. Topbar right padding
         clears the absolute-positioned shell actions (theme + close). */
      '.rw-compose {',
      '  flex: 1 1 auto; min-height: 0; overflow-y: auto;',
      '  display: flex; flex-direction: column;',
      '  padding: 0 20px 20px;',
      '  background: var(--rw-panel);',
      '  background-image: radial-gradient(420px 320px at 70% 100%, color-mix(in oklab, var(--rw-accent) 6%, transparent), transparent 70%);',
      '}',
      '.rw-shell[data-theme="dark"] .rw-compose {',
      '  background-image: radial-gradient(420px 320px at 70% 100%, color-mix(in oklab, var(--rw-accent) 14%, transparent), transparent 70%);',
      '}',
      '.rw-compose-topbar {',
      '  display: flex; align-items: center;',
      '  padding: 14px 64px 12px 0;',
      '  flex: 0 0 auto;',
      '}',
      '.rw-compose-title {',
      '  font-family: var(--rw-serif);',
      '  font-size: 18px; font-weight: 500; letter-spacing: -0.01em;',
      '  color: var(--rw-fg); margin: 6px 0 12px;',
      '}',

      /* Compact back-to-home control used by compose/list headers. */
      '.rw-home-btn {',
      '  display: inline-flex; align-items: center; gap: 6px;',
      '  padding: 5px 11px 5px 9px;',
      '  background: transparent; border: 1px solid var(--rw-line-2);',
      '  border-radius: 999px;',
      '  color: var(--rw-muted); font: inherit; font-size: 12px; font-weight: 500;',
      '  cursor: pointer; flex: 0 0 auto;',
      '  transition: color .12s, border-color .12s, transform .12s;',
      '}',
      '.rw-home-btn:hover { color: var(--rw-fg); border-color: var(--rw-accent); }',
      '.rw-home-btn:active { transform: translateY(1px); }',
      /* Slim list-view topbar hosting the board title (the discussion board is
         the widget's landing view). Right padding keeps the title clear of the
         absolute-positioned shell actions (bell / theme / close). */
      '.rw-list-title {',
      '  font-size: 15px; font-weight: 600; color: var(--rw-fg);',
      '  letter-spacing: -0.01em;',
      '}',
      '.rw-list-topbar {',
      '  display: flex; align-items: center;',
      /* Right padding clears the absolute shell actions (bell/theme/close reach',
      '     ~110px from the edge) so the right-aligned coin total never overlaps them. */
      '  padding: 14px 120px 10px 22px;',
      '  border-bottom: 1px solid var(--rw-line);',
      '  flex: 0 0 auto;',
      '}',

      /* Community coin — blatant header total + per-post earned chip + why tooltip. */
      '.rw-coin-total {',
      '  display: inline-flex; align-items: center; gap: 6px; margin-left: auto;',
      '  padding: 4px 10px; border-radius: 999px; white-space: nowrap;',
      '  background: color-mix(in srgb, var(--rw-accent) 14%, transparent);',
      '  color: var(--rw-accent); font-weight: 700; font-size: 13px;',
      '}',
      /* Zero balance: present but quiet — discoverable, not shouty. */
      '.rw-coin-total--zero {',
      '  background: color-mix(in srgb, var(--rw-fg) 7%, transparent);',
      '  color: color-mix(in srgb, var(--rw-fg) 55%, transparent); font-weight: 600;',
      '}',
      '.rw-coin-glyph { font-size: 1em; line-height: 1; }',
      '.rw-coin-chip {',
      '  position: relative;',
      '  display: inline-flex; align-items: center; gap: 3px;',
      '  padding: 1px 7px; border-radius: 999px;',
      '  background: color-mix(in srgb, var(--rw-accent) 12%, transparent);',
      '  color: var(--rw-accent); font-weight: 600; font-size: 11px; cursor: default;',
      '}',
      '.rw-coin-tip {',
      '  position: absolute; bottom: calc(100% + 6px); left: 0; z-index: 60;',
      '  width: max-content; max-width: 260px; padding: 8px 10px; border-radius: 8px;',
      '  background: var(--rw-fg); color: var(--rw-bg); text-align: left;',
      '  font-size: 12px; font-weight: 500; line-height: 1.4;',
      '  box-shadow: 0 6px 20px rgba(0,0,0,0.25); white-space: normal; pointer-events: none;',
      '}',
      '.rw-coin-tip-head { display: block; font-weight: 700; margin-bottom: 4px; }',
      '.rw-coin-tip ul { margin: 0; padding-left: 16px; }',
      '.rw-coin-tip li { margin: 2px 0; }',

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

      /* notifications bell + dropdown (ticket-update alerts) */
      '.rw-notif-wrap { position: relative; display: inline-flex; }',
      '.rw-notif-bell { position: relative; }',
      '.rw-notif-badge {',
      '  position: absolute; top: -2px; right: -2px; min-width: 15px; height: 15px; padding: 0 4px;',
      '  border-radius: 999px; background: #ef4444; color: #fff; font-size: 9px; font-weight: 700;',
      '  display: inline-flex; align-items: center; justify-content: center; line-height: 1;',
      '  box-shadow: 0 0 0 2px var(--rw-bg);',
      '}',
      '.rw-notif-dropdown {',
      '  position: absolute; top: calc(100% + 8px); right: 0; width: 300px; max-width: 78vw; z-index: 70;',
      '  background: var(--rw-panel, var(--rw-bg)); border: 1px solid var(--rw-line-2);',
      '  border-radius: 12px; box-shadow: 0 12px 32px -10px rgba(0,0,0,0.4); overflow: hidden;',
      '}',
      '.rw-notif-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 14px; font-size: 12px; font-weight: 600; color: var(--rw-fg-2); border-bottom: 1px solid var(--rw-line); }',
      '.rw-notif-markread { flex: 0 0 auto; border: none; background: none; padding: 0; margin: 0; font: inherit; font-weight: 600; font-size: 11.5px; color: var(--rw-accent); cursor: pointer; }',
      '.rw-notif-markread:hover { text-decoration: underline; }',
      '.rw-notif-list { max-height: 320px; overflow-y: auto; }',
      '.rw-notif-empty { padding: 16px 14px; font-size: 12.5px; color: var(--rw-muted); }',
      '.rw-notif-item {',
      '  display: flex; align-items: flex-start; gap: 8px; width: 100%; text-align: left;',
      '  padding: 10px 14px; background: transparent; border: 0; border-bottom: 1px solid var(--rw-line);',
      '  cursor: pointer; font-family: inherit; color: var(--rw-fg);',
      '}',
      '.rw-notif-item:last-child { border-bottom: 0; }',
      '.rw-notif-item:hover { background: color-mix(in oklab, var(--rw-accent) 8%, transparent); }',
      '.rw-notif-item .rw-unseen-dot { margin-top: 5px; margin-right: 0; }',
      '.rw-notif-item-text { min-width: 0; flex: 1 1 auto; }',
      '.rw-notif-item-title { font-size: 13px; font-weight: 600; line-height: 1.3; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }',
      '.rw-notif-item-when { font-size: 11px; color: var(--rw-muted); margin-top: 2px; }',

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
      '  flex: 0 0 auto;',
      '  display: inline-flex; flex-direction: column; align-items: center; justify-content: center;',
      '  gap: 0; width: 30px; padding: 4px 0;',
      '  background: var(--rw-panel);',
      '  border: 1px solid var(--rw-line);',
      '  border-radius: 8px; color: var(--rw-fg-2);',
      '  font: inherit; font-size: 11px; font-weight: 600; line-height: 1.2;',
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
      /* Misconfigured-embed banner: deliberately loud and unmissable, sits
         at the very top of the composer above the textarea. */
      '.rw-auth-banner { margin: 0 0 10px 0; padding: 12px 14px; border-radius: 10px;',
      '  background: rgba(220,38,38,0.14); border: 1px solid rgba(220,38,38,0.45); }',
      '.rw-auth-banner-hd { font-size: 13px; font-weight: 700; color: #fca5a5; letter-spacing: 0.01em; }',
      '.rw-modal-mount[data-theme="light"] .rw-auth-banner-hd { color: #b91c1c; }',
      '.rw-auth-banner-msg { margin-top: 5px; font-size: 12px; line-height: 1.45; color: #fecaca; }',
      '.rw-modal-mount[data-theme="light"] .rw-auth-banner-msg { color: #7f1d1d; }',
      '.rw-auth-banner-sub { margin-top: 6px; font-size: 11px; line-height: 1.4; color: #f87171; opacity: 0.85; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }',
      '.rw-modal-mount[data-theme="light"] .rw-auth-banner-sub { color: #b91c1c; }',

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
      '.rw-chip-thumb {',
      '  position: relative; display: inline-block; flex: 0 0 auto;',
      '  width: 56px; height: 56px; border-radius: 8px; overflow: hidden;',
      '  border: 1px solid var(--rw-line-2); background: rgba(255,255,255,0.06);',
      '}',
      '.rw-modal-mount[data-theme="light"] .rw-chip-thumb { background: rgba(15,20,35,0.04); }',
      '.rw-chip-thumb-img {',
      '  width: 100%; height: 100%; object-fit: cover; display: block; cursor: zoom-in;',
      '}',
      '.rw-chip-thumb .rw-chip-x {',
      '  position: absolute; top: 2px; right: 2px; width: 18px; height: 18px;',
      '  background: rgba(4,6,11,0.62); color: #fff; border-radius: 999px;',
      '  font-size: 13px; line-height: 1;',
      '}',
      '.rw-chip-thumb .rw-chip-x:hover { background: rgba(4,6,11,0.85); color: #fff; }',
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
      '.rw-submit-btn:hover:not(:disabled):not([aria-disabled="true"]) { filter: brightness(1.06); }',
      '.rw-submit-btn:active:not(:disabled):not([aria-disabled="true"]) { transform: translateY(1px); }',
      /* Disabled state keeps the accent fill — just fades it. Matches
         the inline-submit treatment in the new-ticket composer so the
         two submits read as the same control in different states.
         `:disabled` = transient in-flight; `[aria-disabled]` = soft-locked
         and still hoverable so its `title` reason shows. */
      '.rw-submit-btn:disabled, .rw-submit-btn[aria-disabled="true"] { cursor: not-allowed; opacity: 0.45; }',

      /* detail modal head — head + body share one scroll area
         (.rw-td-scroll), so the head is no longer flex-pinned. */
      '.rw-td-head { padding: 16px 18px 4px; }',
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
      /* Title row: vote pill on the left, title text to its right. Centered
         so the compact pill visually balances against the headline. */
      '.rw-td-title-row {',
      '  display: flex; align-items: center; gap: 12px;',
      '  margin: 6px 0 12px;',
      '}',
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

      '.rw-td-body { padding: 8px 18px; }',

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
      '.rw-event-message { min-width: 0; }',
      '.rw-event-message code {',
      '  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;',
      '  font-size: 0.92em;',
      '  padding: 1px 4px;',
      '  border-radius: 4px;',
      '  background: var(--rw-panel-2);',
      '  color: var(--rw-fg-2);',
      '  border: 1px solid var(--rw-line);',
      '}',
      '.rw-event-message strong { color: var(--rw-fg-2); font-weight: 600; }',
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
      '.rw-lightbox-nav {',
      '  position: absolute; top: 50%; transform: translateY(-50%);',
      '  width: 44px; height: 44px;',
      '  display: inline-flex; align-items: center; justify-content: center;',
      '  border-radius: 999px; border: 1px solid rgba(255,255,255,0.14);',
      '  background: rgba(0,0,0,0.4); color: rgba(255,255,255,0.92);',
      '  cursor: pointer; padding: 0;',
      '  transition: background .15s ease, border-color .15s ease;',
      '}',
      '.rw-lightbox-nav:hover { background: rgba(0,0,0,0.7); border-color: rgba(255,255,255,0.28); }',
      '.rw-lightbox-prev { left: 16px; }',
      '.rw-lightbox-next { right: 16px; }',

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
      // Must stack above .rw-shell-scrim (2147483645) like the other
      // modalMountEl overlays (.rw-modal-scrim, .rw-lightbox-scrim).
      '  z-index: 2147483647;',
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

      /* -----------------------------------------------------------------------
         Clarification timeline stepper
         Compact horizontal stepper displayed in the ticket detail when a
         clarification or linked PR exists.  Steps are: Submitted → Clarifying
         → In progress → PR opened.  Active step is highlighted with the accent
         colour; past steps are muted; future steps are dimmed. */
      '.rw-clarif-timeline {',
      '  display: flex; align-items: center; gap: 0;',
      '  padding: 10px 18px 6px;',
      '  border-bottom: 1px solid var(--rw-line);',
      '  flex-wrap: nowrap; overflow-x: auto;',
      '}',
      '.rw-clarif-step {',
      '  display: inline-flex; align-items: center; gap: 4px;',
      '  font-size: 11px; font-weight: 600; letter-spacing: 0.02em;',
      '  color: var(--rw-muted-2);',
      '  white-space: nowrap;',
      '  flex: 0 0 auto;',
      '}',
      '.rw-clarif-step.rw-clarif-past {',
      '  color: var(--rw-muted);',
      '}',
      '.rw-clarif-step.rw-clarif-active {',
      '  color: var(--rw-accent);',
      '}',
      '.rw-clarif-step-dot {',
      '  width: 6px; height: 6px; border-radius: 50%;',
      '  background: currentColor; flex: 0 0 auto;',
      '  opacity: 0.45;',
      '}',
      '.rw-clarif-step.rw-clarif-past .rw-clarif-step-dot { opacity: 0.7; }',
      '.rw-clarif-step.rw-clarif-active .rw-clarif-step-dot { opacity: 1; }',
      '.rw-clarif-connector {',
      '  flex: 0 0 auto;',
      '  width: 18px; height: 1px;',
      '  background: var(--rw-line-2);',
      '  margin: 0 2px;',
      '}',

      /* -----------------------------------------------------------------------
         Clarification question cards
         Rendered below the timeline when status=asking and questions exist.
         Each question is a labelled input card; the Send-answers button is
         shared and sits below all cards. */
      '.rw-clarif-section {',
      '  padding: 14px 18px 10px;',
      '  border-bottom: 1px solid var(--rw-line);',
      '  display: flex; flex-direction: column; gap: 10px;',
      '}',
      '.rw-clarif-title {',
      '  font-size: 10.5px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase;',
      '  color: var(--rw-muted); margin: 0;',
      '}',
      '.rw-clarif-card {',
      '  background: var(--rw-panel); border: 1px solid var(--rw-line-2);',
      '  border-radius: 8px; padding: 10px 12px;',
      '  display: flex; flex-direction: column; gap: 8px;',
      '}',
      '.rw-clarif-prompt {',
      '  font-size: 13px; font-weight: 500; color: var(--rw-fg);',
      '  line-height: 1.4; margin: 0;',
      '}',
      '.rw-clarif-input {',
      '  width: 100%; background: var(--rw-bg); border: 1px solid var(--rw-line-2);',
      '  border-radius: 6px; color: var(--rw-fg); font: inherit; font-size: 13px;',
      '  padding: 6px 8px; outline: none; box-sizing: border-box;',
      '  transition: border-color .15s ease;',
      '}',
      '.rw-clarif-input:focus { border-color: var(--rw-accent); }',
      '.rw-clarif-options { display: flex; flex-direction: column; gap: 5px; }',
      '.rw-clarif-option {',
      '  display: flex; align-items: center; gap: 7px;',
      '  font-size: 13px; color: var(--rw-fg-2); cursor: pointer; user-select: none;',
      '}',
      '.rw-clarif-option input { margin: 0; cursor: pointer; accent-color: var(--rw-accent); }',
      '.rw-clarif-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }',
      '.rw-clarif-send-btn {',
      '  display: inline-flex; align-items: center; gap: 6px;',
      '  height: 28px; padding: 0 12px;',
      '  border-radius: 999px;',
      '  border: 1px solid var(--rw-accent);',
      '  background: var(--rw-accent); color: var(--rw-accent-ink);',
      '  font: inherit; font-size: 12px; font-weight: 600;',
      '  cursor: pointer;',
      '  transition: transform .12s ease, filter .12s ease, opacity .12s ease;',
      '}',
      '.rw-clarif-send-btn:hover:not(:disabled) { filter: brightness(1.06); }',
      '.rw-clarif-send-btn:active:not(:disabled) { transform: translateY(1px); }',
      '.rw-clarif-send-btn:disabled { cursor: not-allowed; opacity: 0.45; }',
      '.rw-clarif-error { font-size: 12px; color: #fca5a5; margin: 0; }',
      '.rw-modal-mount[data-theme="light"] .rw-clarif-error { color: #b91c1c; }',

      /* -----------------------------------------------------------------------
         Linked-PR card
         Shown near the top of the detail (between head and body) when a PR is
         linked.  Minimal treatment: left-accent border + PR number link + state badge. */
      '.rw-pr-card {',
      '  margin: 8px 18px 2px;',
      '  padding: 9px 12px;',
      '  border-radius: 8px;',
      '  border: 1px solid var(--rw-line-2);',
      '  border-left: 3px solid var(--rw-accent);',
      '  display: flex; align-items: center; gap: 10px;',
      '  background: var(--rw-panel);',
      '}',
      '.rw-pr-card-label {',
      '  font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;',
      '  color: var(--rw-muted); flex: 0 0 auto;',
      '}',
      '.rw-pr-card-link {',
      '  font-size: 13px; font-weight: 600; color: var(--rw-fg);',
      '  text-decoration: none; flex: 1 1 auto; min-width: 0;',
      '  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;',
      '}',
      '.rw-pr-card-link:hover { text-decoration: underline; color: var(--rw-accent); }',
      '.rw-pr-state {',
      '  display: inline-block; padding: 1px 6px; border-radius: 6px;',
      '  font-size: 10.5px; font-weight: 600; letter-spacing: 0.04em; flex: 0 0 auto;',
      '}',
      '.rw-pr-state-open   { background: rgba(34,197,94,0.15); color: #16a34a; }',
      '.rw-pr-state-closed { background: rgba(220,38,38,0.12); color: #dc2626; }',
      '.rw-pr-state-merged { background: rgba(139,92,246,0.15); color: #7c3aed; }',
      '.rw-modal-mount[data-theme="dark"] .rw-pr-state-open   { color: #4ade80; }',
      '.rw-modal-mount[data-theme="dark"] .rw-pr-state-closed { color: #f87171; }',
      '.rw-modal-mount[data-theme="dark"] .rw-pr-state-merged { color: #a78bfa; }',

      /* -----------------------------------------------------------------------
         Possible-duplicate card
         Rendered below the timeline when clarification.status === "duplicate".
         Amber-tinted notice with a clickable ticket reference and a ghost
         override button.  Light and dark themes handled via CSS variables
         where possible; a few amber values need explicit dark-mode overrides. */
      '.rw-dup-card {',
      '  margin: 8px 18px 2px;',
      '  padding: 10px 12px;',
      '  border-radius: 8px;',
      '  border: 1px solid var(--rw-line-2);',
      '  border-left: 3px solid #f59e0b;',
      '  background: var(--rw-panel);',
      '  display: flex; flex-direction: column; gap: 8px;',
      '}',
      '.rw-dup-card-body {',
      '  display: flex; flex-direction: column; gap: 4px;',
      '}',
      '.rw-dup-badge {',
      '  display: inline-block;',
      '  font-size: 10px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;',
      '  color: #92400e; background: rgba(245,158,11,0.15);',
      '  border-radius: 4px; padding: 1px 5px;',
      '  align-self: flex-start;',
      '}',
      '.rw-modal-mount[data-theme="dark"] .rw-dup-badge { color: #fbbf24; background: rgba(245,158,11,0.12); }',
      '.rw-dup-card-text {',
      '  font-size: 13px; line-height: 1.45; color: var(--rw-fg-2);',
      '}',
      '.rw-dup-ref-link {',
      '  background: none; border: none; padding: 0;',
      '  font: inherit; font-size: 13px; font-weight: 600;',
      '  color: var(--rw-accent); cursor: pointer; text-decoration: underline;',
      '  text-underline-offset: 2px;',
      '}',
      '.rw-dup-ref-link:hover { opacity: 0.8; }',
      '.rw-dup-ref-unknown { font-size: 13px; color: var(--rw-fg-2); }',
      '.rw-dup-card-footer {',
      '  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;',
      '}',
      '.rw-dup-proceed-btn {',
      '  display: inline-flex; align-items: center;',
      '  height: 26px; padding: 0 10px;',
      '  border-radius: 999px;',
      '  border: 1px solid var(--rw-line-2);',
      '  background: transparent; color: var(--rw-fg-2);',
      '  font: inherit; font-size: 11.5px; font-weight: 600;',
      '  cursor: pointer;',
      '  transition: border-color .12s ease, color .12s ease, opacity .12s ease;',
      '}',
      '.rw-dup-proceed-btn:hover:not(:disabled) { border-color: var(--rw-muted); color: var(--rw-fg); }',
      '.rw-dup-proceed-btn:active:not(:disabled) { opacity: 0.7; }',
      '.rw-dup-proceed-btn:disabled { cursor: not-allowed; opacity: 0.4; }',

      /* -----------------------------------------------------------------------
         Chat view (agent conversation)
         Full-card layout: topbar / scrolling message list / pinned footer.
         Bubbles: user right (accent), agent left (panel) with name + avatar. */
      '.rw-chat-full { flex: 1 1 auto; display: flex; flex-direction: column; min-height: 0; }',
      '.rw-chat-topbar {',
      '  flex: 0 0 auto; display: flex; align-items: center; gap: 12px;',
      '  padding: 12px 18px 10px; border-bottom: 1px solid var(--rw-line);',
      '}',
      '.rw-chat-topbar-identity { display: flex; align-items: center; gap: 8px; min-width: 0; }',
      '.rw-chat-topbar-name {',
      '  font-size: 13px; font-weight: 600; color: var(--rw-fg);',
      '  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;',
      '}',
      '.rw-chat-agent-img { border-radius: 50%; object-fit: cover; flex: 0 0 auto; }',
      '.rw-chat-scroll {',
      '  flex: 1 1 auto; overflow-y: auto; padding: 14px 18px;',
      '  display: flex; flex-direction: column; gap: 10px;',
      '}',
      '.rw-chat-empty { font-size: 13px; color: var(--rw-muted); text-align: center; padding: 24px 12px; }',
      '.rw-chat-intro { padding: 36px 22px; display: flex; flex-direction: column; align-items: center; gap: 12px; }',
      '.rw-intro-status {',
      '  display: inline-flex; align-items: center; gap: 7px;',
      '  font-size: 12px; font-weight: 600; color: var(--rw-fg-2);',
      '  background: var(--rw-panel-2); border: 1px solid var(--rw-panel-3);',
      '  padding: 5px 11px 5px 9px; border-radius: 999px;',
      '}',
      '.rw-intro-pulse {',
      '  width: 8px; height: 8px; border-radius: 50%; flex: none;',
      '  background: #16a34a; box-shadow: 0 0 0 0 rgba(22,163,74,0.5);',
      '  animation: rw-intro-pulse 2s ease-out infinite;',
      '}',
      '@keyframes rw-intro-pulse {',
      '  0% { box-shadow: 0 0 0 0 rgba(22,163,74,0.45); }',
      '  70% { box-shadow: 0 0 0 6px rgba(22,163,74,0); }',
      '  100% { box-shadow: 0 0 0 0 rgba(22,163,74,0); }',
      '}',
      '@media (prefers-reduced-motion: reduce) { .rw-intro-pulse { animation: none; } }',
      '.rw-chat-intro-title {',
      '  font-size: 15px; font-weight: 700; color: var(--rw-fg);',
      '  line-height: 1.35; max-width: 34ch; margin: 0;',
      '  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;',
      '}',
      '.rw-intro-body { font-size: 13px; color: var(--rw-muted); line-height: 1.5; max-width: 32ch; }',
      '.rw-chat-msg { display: flex; gap: 8px; }',
      '.rw-chat-msg-user { justify-content: flex-end; }',
      '.rw-chat-msg-agent { justify-content: flex-start; align-items: flex-start; }',
      '.rw-chat-agent-col { display: flex; flex-direction: column; gap: 3px; min-width: 0; max-width: 78%; }',
      '.rw-chat-agent-name { font-size: 10.5px; font-weight: 600; color: var(--rw-muted); padding-left: 2px; }',
      '.rw-chat-bubble {',
      '  padding: 8px 12px; border-radius: 14px; font-size: 13px; line-height: 1.45;',
      '  white-space: pre-wrap; word-break: break-word;',
      '}',
      '.rw-chat-markdown strong { font-weight: 700; }',
      '.rw-chat-markdown em { font-style: italic; }',
      '.rw-chat-markdown code {',
      '  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;',
      '  font-size: 0.92em; padding: 1px 4px; border-radius: 4px;',
      '  background: rgba(15, 23, 42, 0.08);',
      '}',
      '.rw-chat-markdown a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }',
      '.rw-chat-bubble-user {',
      '  max-width: 78%; background: var(--rw-accent); color: var(--rw-accent-ink);',
      '  border-bottom-right-radius: 4px;',
      '}',
      '.rw-chat-bubble-agent {',
      '  background: var(--rw-panel); border: 1px solid var(--rw-line-2); color: var(--rw-fg);',
      '  border-bottom-left-radius: 4px; align-self: flex-start;',
      '}',
      '.rw-chat-typing { display: inline-flex; gap: 4px; align-items: center; padding: 11px 12px; }',
      '.rw-chat-typing-dot {',
      '  width: 6px; height: 6px; border-radius: 50%; background: var(--rw-muted);',
      '  animation: rw-chat-blink 1.2s infinite ease-in-out;',
      '}',
      '.rw-chat-typing-dot:nth-child(2) { animation-delay: 0.15s; }',
      '.rw-chat-typing-dot:nth-child(3) { animation-delay: 0.3s; }',
      '@keyframes rw-chat-blink { 0%, 80%, 100% { opacity: 0.25; } 40% { opacity: 1; } }',
      '.rw-chat-event-line { font-size: 11.5px; color: var(--rw-muted); text-align: center; padding: 2px 8px; }',
      '.rw-chat-event-chips { display: flex; align-items: center; justify-content: center; gap: 4px; flex-wrap: wrap; }',
      '.rw-chat-footer {',
      '  flex: 0 0 auto; border-top: 1px solid var(--rw-line);',
      '  padding: 10px 14px 12px; display: flex; flex-direction: column; gap: 8px;',
      '}',
      '.rw-chat-hatch-slot { display: flex; justify-content: center; }',
      '.rw-chat-hatch-slot:empty { display: none; }',
      // Agentless [Submit Ticket] — proposal-card primary family, sized up
      // to a full-width footer action above the input.
      '.rw-chat-submit-btn { width: 100%; height: 32px; justify-content: center; font-size: 12.5px; }',
      '.rw-chat-input-row { display: flex; align-items: flex-end; gap: 8px; }',
      '.rw-chat-input {',
      '  flex: 1 1 auto; resize: none; min-height: 36px; max-height: 120px;',
      '  background: var(--rw-bg); border: 1px solid var(--rw-line-2); border-radius: 10px;',
      '  color: var(--rw-fg); font: inherit; font-size: 13px; padding: 8px 10px;',
      '  outline: none; box-sizing: border-box; transition: border-color .15s ease;',
      '}',
      '.rw-chat-input:focus { border-color: var(--rw-accent); }',
      '.rw-chat-input:disabled { opacity: 0.6; }',
      '.rw-chat-send-btn {',
      '  flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center;',
      '  width: 36px; height: 36px; border-radius: 50%;',
      '  border: 1px solid var(--rw-accent); background: var(--rw-accent); color: var(--rw-accent-ink);',
      '  cursor: pointer; transition: filter .12s ease, opacity .12s ease;',
      '}',
      '.rw-chat-send-btn:hover:not(:disabled) { filter: brightness(1.06); }',
      '.rw-chat-send-btn:disabled { cursor: not-allowed; opacity: 0.45; }',
      '.rw-chat-inline-notice {',
      '  font-size: 12px; color: var(--rw-muted); background: var(--rw-panel);',
      '  border: 1px solid var(--rw-line-2); border-radius: 8px; padding: 6px 10px;',
      '}',
      '.rw-chat-closed-bar { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }',
      '.rw-chat-closed-text { font-size: 12.5px; color: var(--rw-muted); }',
      '.rw-chat-newconv-btn {',
      '  display: inline-flex; align-items: center; height: 28px; padding: 0 12px;',
      '  border-radius: 999px; border: 1px solid var(--rw-accent);',
      '  background: var(--rw-accent); color: var(--rw-accent-ink);',
      '  font: inherit; font-size: 12px; font-weight: 600; cursor: pointer;',
      '}',
      '.rw-chat-newconv-btn:disabled { cursor: not-allowed; opacity: 0.45; }',

      /* Discard-conversation confirmation dialog (rendered via mountModal). */
      '.rw-confirm-modal {',
      '  width: min(360px, 100%); box-sizing: border-box;',
      '  background: var(--rw-bg); border: 1px solid var(--rw-line-2);',
      '  border-radius: 14px; padding: 20px;',
      '  box-shadow: 0 18px 48px -16px rgba(0,0,0,0.55);',
      '  display: flex; flex-direction: column; gap: 8px; color: var(--rw-fg);',
      '  animation: rw-modal-in .2s cubic-bezier(0.16, 1, 0.3, 1);',
      '}',
      '.rw-confirm-title { margin: 0; font-size: 15px; font-weight: 600; color: var(--rw-fg); }',
      '.rw-confirm-body { margin: 0; font-size: 13px; line-height: 1.5; color: var(--rw-muted); }',
      '.rw-confirm-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 10px; }',
      '.rw-confirm-btn {',
      '  height: 30px; padding: 0 14px; border-radius: 999px;',
      '  font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer;',
      '  border: 1px solid transparent; transition: all .15s ease;',
      '}',
      '.rw-confirm-cancel { background: transparent; border-color: var(--rw-line-2); color: var(--rw-fg-2); }',
      '.rw-confirm-cancel:hover { color: var(--rw-fg); border-color: var(--rw-muted); }',
      '.rw-confirm-go { background: var(--rw-accent); border-color: var(--rw-accent); color: var(--rw-accent-ink); }',
      '.rw-confirm-go:hover { filter: brightness(1.06); }',

      /* Chat image attach affordance: thumbnail chips above input + attach btn */
      '.rw-chat-img-chips { display: flex; gap: 6px; padding: 0 2px 4px; flex-wrap: wrap; }',
      '.rw-chat-img-chip {',
      '  position: relative; width: 56px; height: 56px; border-radius: 8px;',
      '  overflow: hidden; flex-shrink: 0;',
      '  border: 1px solid var(--rw-line-2); background: var(--rw-bg);',
      '}',
      '.rw-chat-img-chip img { width: 100%; height: 100%; object-fit: cover; display: block; }',
      '.rw-chat-img-chip-x {',
      '  position: absolute; top: 2px; right: 2px;',
      '  width: 16px; height: 16px; border-radius: 50%;',
      '  background: rgba(0,0,0,0.65); border: none; color: #fff;',
      '  cursor: pointer; font-size: 13px; line-height: 1;',
      '  display: flex; align-items: center; justify-content: center; padding: 0;',
      '}',
      '.rw-chat-img-chip.rw-uploading::after {',
      '  content: ""; position: absolute; inset: 0; background: rgba(0,0,0,0.35);',
      '}',
      '.rw-chat-img-chip.rw-failed { border-color: rgba(220,38,38,0.55); }',
      '.rw-chat-attach-btn {',
      '  flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center;',
      '  width: 30px; height: 30px; border-radius: 50%;',
      '  border: 1px solid var(--rw-line); background: transparent;',
      '  color: var(--rw-muted); cursor: pointer;',
      '}',
      '.rw-chat-attach-btn:hover:not(:disabled) { color: var(--rw-fg); border-color: var(--rw-line-2); }',
      '.rw-chat-attach-btn:disabled { opacity: 0.4; cursor: not-allowed; }',
      /* New-conversation strip — right-aligned, directly below the header.
         Its own row so it reads as a distinct chat action, clear of both the
         global icon cluster and the composer. */
      '.rw-chat-actionbar {',
      '  flex: 0 0 auto; display: flex; justify-content: flex-end;',
      '  padding: 8px 18px 0;',
      '}',
      '.rw-chat-newconv-pill {',
      '  display: inline-flex; align-items: center; gap: 5px;',
      '  height: 26px; padding: 0 10px;',
      '  background: transparent; border: 1px solid var(--rw-line-2);',
      '  border-radius: 999px; color: var(--rw-muted);',
      '  font: inherit; font-size: 11.5px; font-weight: 500; cursor: pointer;',
      '  transition: color .15s ease, border-color .15s ease;',
      '}',
      '.rw-chat-newconv-pill:hover:not(:disabled) { color: var(--rw-fg); border-color: var(--rw-muted); }',
      '.rw-chat-newconv-pill:disabled { opacity: 0.45; cursor: not-allowed; }',

      /* Chat bubble: images sent by the user */
      '.rw-chat-bubble-imgs { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 6px; }',
      '.rw-chat-bubble-img {',
      '  width: 72px; height: 72px; border-radius: 8px; object-fit: cover;',
      '  cursor: pointer; display: block;',
      '  border: 1px solid rgba(255,255,255,0.12);',
      '}',

      /* Chat ticket cards: compact reference cards rendered inline in the
         conversation (existing-ticket deflection links and the created-
         ticket confirmation). Idiom matches rw-pr-card. */
      '.rw-chat-ticket-card {',
      '  align-self: stretch;',
      '  display: flex; align-items: center; justify-content: space-between; gap: 10px;',
      '  padding: 9px 12px; border-radius: 8px;',
      '  border: 1px solid var(--rw-line-2); border-left: 3px solid var(--rw-accent);',
      '  background: var(--rw-panel); font: inherit; text-align: left;',
      '}',
      'button.rw-chat-ticket-card { cursor: pointer; width: 100%; }',
      'button.rw-chat-ticket-card:hover { border-color: var(--rw-muted); }',
      '.rw-chat-ticket-card-main { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1 1 auto; }',
      '.rw-chat-ticket-created { align-items: stretch; flex-direction: column; justify-content: flex-start; }',
      '.rw-chat-ticket-created .rw-chat-ticket-card-main { flex: 0 1 auto; width: 100%; flex-wrap: wrap; }',
      '.rw-chat-ticket-title {',
      '  font-size: 13px; font-weight: 600; color: var(--rw-fg);',
      '  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;',
      '}',
      '.rw-chat-ticket-label {',
      '  font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;',
      '  color: var(--rw-muted); flex: 0 0 auto;',
      '}',
      '.rw-chat-ticket-ref { font-size: 13px; font-weight: 600; color: var(--rw-fg); }',
      '.rw-chat-ticket-open {',
      '  flex: 0 0 auto; display: inline-flex; align-items: center; height: 26px; padding: 0 10px;',
      '  border-radius: 999px; border: 1px solid var(--rw-line-2);',
      '  background: transparent; color: var(--rw-fg-2);',
      '  font: inherit; font-size: 11.5px; font-weight: 600; cursor: pointer;',
      '}',
      '.rw-chat-ticket-open:hover { border-color: var(--rw-muted); color: var(--rw-fg); }',
      '.rw-chat-ticket-actions { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 6px; }',
      '.rw-chat-ticket-created .rw-chat-ticket-actions { width: 100%; justify-content: flex-end; flex-wrap: wrap; }',
      '.rw-chat-ticket-assign { height: 26px; margin-top: 0; }',
      '.rw-chat-assigned-line { font-size: 11.5px; color: var(--rw-muted); text-align: center; padding: 2px 8px; }',

      /* Chat proposal card: editable draft title + description with primary
         Create Ticket action and a quiet dismiss link. Inputs reuse the
         clarification-card input styling (rw-clarif-input). */
      '.rw-chat-proposal-card {',
      '  align-self: stretch;',
      '  background: var(--rw-panel); border: 1px solid var(--rw-line-2);',
      '  border-left: 3px solid var(--rw-accent); border-radius: 8px;',
      '  padding: 12px; display: flex; flex-direction: column; gap: 8px;',
      '}',
      '.rw-chat-proposal-label {',
      '  font-size: 11px; font-weight: 600; color: var(--rw-muted); margin: 2px 0 0;',
      '}',
      '.rw-chat-proposal-desc { resize: vertical; min-height: 84px; font-family: inherit; }',
      /* Visibility row in the proposal card — Public/Private pill + hint,
         mirroring the standalone composer's privacy control. */
      '.rw-chat-proposal-visibility { display: flex; align-items: center; flex-wrap: wrap; margin: 2px 0 0; }',
      '.rw-chat-proposal-visibility .rw-priv-hint { margin-left: 8px; }',
      '.rw-chat-dismiss-link {',
      '  background: none; border: none; padding: 0; font: inherit;',
      '  font-size: 12px; color: var(--rw-muted); cursor: pointer;',
      '  text-decoration: underline; text-underline-offset: 2px;',
      '}',
      '.rw-chat-dismiss-link:hover:not(:disabled) { color: var(--rw-fg); }',
      '.rw-chat-dismiss-link:disabled { cursor: not-allowed; opacity: 0.45; }',

      /* Escape hatch: quiet link above the input after >=4 user turns with
         no proposal — the user is never trapped in a questioning loop. */
      '.rw-chat-escape-link {',
      '  background: none; border: none; padding: 2px 4px; font: inherit;',
      '  font-size: 12px; color: var(--rw-muted); cursor: pointer;',
      '  text-decoration: underline; text-underline-offset: 2px;',
      '}',
      '.rw-chat-escape-link:hover:not(:disabled) { color: var(--rw-fg); }',
      '.rw-chat-escape-link:disabled { cursor: not-allowed; opacity: 0.45; }',

      /* Staff tools bar (live_coder only): groups the Live-session relay and
         PR Preview launcher into one accent-tinted, clearly-privileged control
         surface. Previously these were a quiet underlined link + an unstyled
         native button that were easy to miss. Hidden entirely for non-staff
         (gated in JS), so this surface only ever renders for live_coder users. */
      '.rw-staff-bar {',
      '  margin: 12px 16px 4px; padding: 10px 12px;',
      '  background: color-mix(in oklab, var(--rw-accent) 7%, var(--rw-panel));',
      '  border: 1px solid color-mix(in oklab, var(--rw-accent) 22%, var(--rw-line-2));',
      '  border-left: 3px solid var(--rw-accent); border-radius: 10px;',
      '  display: flex; flex-direction: column; gap: 9px;',
      '}',
      '.rw-staff-bar-head {',
      '  display: flex; align-items: center; gap: 6px;',
      '  font-size: 10.5px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;',
      '  color: var(--rw-accent);',
      '}',
      '.rw-staff-bar-head svg { width: 12px; height: 12px; }',
      '.rw-staff-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }',
      '.rw-staff-btn {',
      '  display: inline-flex; align-items: center; gap: 6px;',
      '  padding: 7px 14px; border-radius: 999px;',
      '  font: inherit; font-size: 12.5px; font-weight: 600; letter-spacing: 0.005em;',
      '  cursor: pointer; white-space: nowrap; flex-shrink: 0;',
      '  transition: transform .12s ease, box-shadow .16s ease, filter .12s ease, background .12s ease, border-color .12s ease;',
      '}',
      '.rw-staff-btn:not(:disabled):hover { transform: translateY(-1px); }',
      '.rw-staff-btn:disabled { cursor: not-allowed; opacity: 0.55; }',
      '.rw-staff-btn-ic { font-size: 13px; line-height: 1; }',
      '.rw-staff-btn--primary {',
      '  background: var(--rw-accent); color: var(--rw-accent-ink); border: 1px solid var(--rw-accent);',
      '}',
      '.rw-staff-btn--primary:not(:disabled):hover { filter: brightness(1.05); box-shadow: 0 8px 18px -10px color-mix(in oklab, var(--rw-accent) 60%, transparent); }',
      '.rw-staff-btn--ghost {',
      '  background: var(--rw-bg); color: var(--rw-fg);',
      '  border: 1px solid color-mix(in oklab, var(--rw-accent) 40%, var(--rw-line-2));',
      '}',
      '.rw-staff-btn--ghost:not(:disabled):hover { background: color-mix(in oklab, var(--rw-accent) 10%, var(--rw-bg)); border-color: var(--rw-accent); }',

      /* Assign-agent feedback. A transient failure stays a small red line
         (`.rw-assign-err`); the terminal "no agent is set up for this project"
         case gets an amber callout that names the root cause and the exact
         settings path to fix it — staff kept missing the bare red string. */
      '.rw-assign-callout {',
      '  display: flex; align-items: flex-start; gap: 8px; width: 100%;',
      '  margin-top: 1px; padding: 9px 11px; border-radius: 9px;',
      '  background: color-mix(in oklab, var(--rw-warn-line) 12%, var(--rw-panel));',
      '  border: 1px solid color-mix(in oklab, var(--rw-warn-line) 34%, var(--rw-line-2));',
      '  border-left: 3px solid var(--rw-warn-line);',
      '}',
      '.rw-assign-callout-ic { flex: 0 0 auto; font-size: 14px; line-height: 1.35; }',
      '.rw-assign-callout-body { font-size: 12.5px; line-height: 1.45; color: var(--rw-fg-2); }',
      '.rw-assign-callout-title { font-weight: 700; color: var(--rw-warn); }',
      '.rw-assign-callout-path { font-weight: 600; color: var(--rw-fg); white-space: nowrap; }',

      /* "Created from a conversation" — collapsed transcript section on the
         ticket detail for tickets born from chat. Reporter-only by
         construction (the chat API is owner-scoped). */
      '.rw-chat-transcript {',
      '  margin: 8px 18px 2px; border: 1px solid var(--rw-line-2); border-radius: 8px;',
      '  background: var(--rw-panel); overflow: hidden;',
      '}',
      '.rw-chat-transcript-toggle {',
      '  width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 8px;',
      '  background: none; border: none; padding: 9px 12px; font: inherit; cursor: pointer;',
      '  color: var(--rw-muted); font-size: 11.5px;',
      '}',
      '.rw-chat-transcript-toggle:hover { color: var(--rw-fg); }',
      '.rw-chat-transcript-title {',
      '  font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;',
      '  color: var(--rw-muted);',
      '}',
      '.rw-chat-transcript-body {',
      '  border-top: 1px solid var(--rw-line-2); padding: 10px 12px;',
      '  display: flex; flex-direction: column; gap: 6px; max-height: 260px; overflow-y: auto;',
      '}',
      '.rw-chat-transcript-line { display: flex; gap: 8px; font-size: 12.5px; line-height: 1.45; }',
      '.rw-chat-transcript-who { flex: 0 0 auto; font-weight: 600; color: var(--rw-muted); }',
      '.rw-chat-transcript-text { color: var(--rw-fg-2); white-space: pre-wrap; word-break: break-word; min-width: 0; }',
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

  // Full-screen image lightbox with optional gallery navigation. Accepts
  // either a single image — openImageLightbox(url, name) — or a gallery:
  // openImageLightbox([{ url, name }, …], startIndex). When more than one image
  // is present, prev/next arrows appear only on the side(s) where another image
  // exists, and ←/→ navigate between them.
  function openImageLightbox(items, start) {
    if (typeof items === "string") items = [{ url: items, name: start }];
    if (!items || !items.length) return;
    var i = Math.max(0, Math.min(items.length - 1, start | 0));

    var img = h("img", { className: "rw-lightbox-img" });
    img.addEventListener("mousedown", function (e) { e.stopPropagation(); });

    var closeBtn = h("button", {
      className: "rw-lightbox-close",
      type: "button",
      "aria-label": "Close image",
    }, Icons.close(18));

    var prevBtn = h("button", {
      className: "rw-lightbox-nav rw-lightbox-prev",
      type: "button",
      "aria-label": "Previous image",
    }, Icons.chevLeft(26));
    var nextBtn = h("button", {
      className: "rw-lightbox-nav rw-lightbox-next",
      type: "button",
      "aria-label": "Next image",
    }, Icons.chevRight(26));

    var scrim = h("div", {
      className: "rw-lightbox-scrim",
      role: "dialog",
      "aria-modal": "true",
    }, [img, prevBtn, nextBtn, closeBtn]);

    function render() {
      var it = items[i];
      img.setAttribute("src", it.url);
      img.setAttribute("alt", it.name || "");
      scrim.setAttribute("aria-label", it.name || "Image preview");
      // Arrows show only when an adjacent image exists on that side.
      prevBtn.style.display = i > 0 ? "inline-flex" : "none";
      nextBtn.style.display = i < items.length - 1 ? "inline-flex" : "none";
    }
    function go(delta, e) {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      var ni = i + delta;
      if (ni < 0 || ni > items.length - 1) return;
      i = ni;
      render();
    }
    prevBtn.addEventListener("click", function (e) { go(-1, e); });
    nextBtn.addEventListener("click", function (e) { go(1, e); });

    function close() {
      document.removeEventListener("keydown", onKey, true);
      if (scrim.parentNode) scrim.parentNode.removeChild(scrim);
    }
    var onKey = function (e) {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        e.preventDefault();
        close();
      } else if (e.key === "ArrowLeft") {
        e.stopImmediatePropagation();
        go(-1, e);
      } else if (e.key === "ArrowRight") {
        e.stopImmediatePropagation();
        go(1, e);
      }
    };

    closeBtn.addEventListener("click", function (e) { e.stopPropagation(); close(); });
    scrim.addEventListener("mousedown", function (e) {
      if (e.target === scrim) close();
    });

    render();
    document.addEventListener("keydown", onKey, true);
    modalMountEl.appendChild(scrim);
  }

  // ---------------------------------------------------------------------------
  // Staged-attachment previews (composer chips)
  //
  // A file the user has chosen but not yet uploaded is held as { file }. To
  // show the actual image — not just its name — we mint an object URL over the
  // chosen bytes and embed it as a thumbnail. The URL is cached on the entry so
  // repeated chip re-renders reuse one allocation, and released the moment the
  // entry is removed or cleared so we never leak object URLs.
  // ---------------------------------------------------------------------------
  function attachPreviewUrl(entry) {
    if (!entry || !entry.file) return null;
    var type = entry.file.type || "";
    if (type.indexOf("image/") !== 0) return null;
    if (!entry.previewUrl) {
      try { entry.previewUrl = URL.createObjectURL(entry.file); }
      catch (e) { return null; }
    }
    return entry.previewUrl;
  }
  function releaseAttachPreview(entry) {
    if (entry && entry.previewUrl) {
      try { URL.revokeObjectURL(entry.previewUrl); } catch (e) { /* noop */ }
      entry.previewUrl = null;
    }
  }
  function releaseAllAttachPreviews(entries) {
    if (entries && entries.length) entries.forEach(releaseAttachPreview);
  }

  // A staged-attachment chip rendered in a composer before upload. Image files
  // render as a standalone thumbnail tile — no filename — that expands to a
  // full-screen lightbox on click (the same one posted attachments use); the
  // corner × removes it. Non-images (rare: composers only accept image/*) fall
  // back to a compact icon chip. onRemove(entry) fires when × is clicked.
  // getGallery (optional) returns the ordered [{ url, name }] of all staged
  // images so the lightbox can page between them with prev/next arrows.
  function renderAttachChip(entry, onRemove, getGallery) {
    var name = entry.file.name || t("composer.pastedImage");
    var removeBtn = h("button", {
      className: "rw-chip-x", type: "button", "aria-label": t("aria.removeAttach"),
    }, "×");
    removeBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      onRemove(entry);
    });
    var previewUrl = attachPreviewUrl(entry);
    if (previewUrl) {
      var img = h("img", {
        className: "rw-chip-thumb-img", src: previewUrl, alt: name,
        title: name, role: "button", tabindex: "0", "aria-label": name,
      });
      function expand(e) {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        var items = (getGallery && getGallery()) || [{ url: previewUrl, name: name }];
        var idx = 0;
        for (var k = 0; k < items.length; k++) { if (items[k].url === previewUrl) { idx = k; break; } }
        openImageLightbox(items, idx);
      }
      img.addEventListener("click", expand);
      img.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") expand(e);
      });
      return h("span", { className: "rw-chip-thumb", title: name }, [img, removeBtn]);
    }
    return h("span", { className: "rw-chip-attach", title: name }, [Icons.image(13), removeBtn]);
  }

  // Ordered [{ url, name }] of every staged image in a composer's entry list —
  // the gallery a thumbnail's lightbox pages through.
  function stagedGallery(entries) {
    var items = [];
    entries.forEach(function (e) {
      var url = attachPreviewUrl(e);
      if (url) items.push({ url: url, name: e.file.name || t("composer.pastedImage") });
    });
    return items;
  }

  function shotIsImage(att) {
    return (att.mimeType || att.mime || "").indexOf("image/") === 0;
  }
  function shotName(att) {
    return att.originalName || att.filename || "image";
  }
  function renderShotThumb(att, gallery) {
    // Attachment shape from be/: { id, filename, originalName, mimeType, url, ... }
    var aspect = att.width && att.height ? (att.width + " / " + att.height) : "16 / 10";
    var name = shotName(att);
    var img = h("img", {
      className: "rw-shot-img",
      src: att.url,
      alt: name, loading: "lazy",
      style: { aspectRatio: aspect, objectFit: "cover" },
    });
    if (!shotIsImage(att)) {
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
    thumb.addEventListener("click", function () {
      var items = gallery || [{ url: att.url, name: name }];
      var idx = 0;
      for (var k = 0; k < items.length; k++) { if (items[k].url === att.url) { idx = k; break; } }
      openImageLightbox(items, idx);
    });
    return thumb;
  }
  function renderShotGrid(attachments, tight) {
    if (!attachments || attachments.length === 0) return null;
    var grid = h("div", { className: "rw-shots" + (tight ? " rw-shots--tight" : "") });
    // Gallery = the image attachments, in grid order, so the lightbox can page
    // between them with prev/next arrows.
    var gallery = attachments.filter(shotIsImage).map(function (a) {
      return { url: a.url, name: shotName(a) };
    });
    attachments.forEach(function (a) { grid.appendChild(renderShotThumb(a, gallery)); });
    return grid;
  }

  // ===========================================================================
  // Vote
  // ===========================================================================

  function handleVoteClick(ticket, voteBtn, countSpan, e) {
    e.preventDefault(); e.stopPropagation();
    // Anonymous viewer on a public widget: persist a vote intent and
    // redirect to login. On return, the widget reopens to this ticket
    // with the vote button enabled (the user clicks again to confirm).
    if (isAnonViewer()) {
      if (!config.loginUrl) return;
      gateWriteAction({
        type: "vote",
        ticketId: ticket.id,
        direction: ticket.userVote === true ? "retract" : "up",
      });
      return;
    }
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

  // Compact number for the coin total (e.g. 1234 → "1,234"). Coin accrues one
  // per lifecycle step, so totals stay small — a thousands separator is plenty.
  function formatCoin(n) {
    try { return Number(n).toLocaleString(); } catch (e) { return String(n); }
  }

  // Header coin total — ALWAYS shown for an identified viewer (blatant, per spec),
  // even at zero, so the reward system is discoverable before the first coin. The
  // tooltip explains how to earn while the balance is still 0. Hidden only for
  // anonymous viewers, who have no community identity to score.
  function renderCoinTotalBadge() {
    if (!communityStats || !communityStats.identified) return null;
    var bal = communityStats.balance || 0;
    var label = bal > 0
      ? "You've earned " + formatCoin(bal) + " coin from feedback you submitted or upvoted"
      : "Earn coin when feedback you submit or upvote moves forward";
    return h("span", {
      className: "rw-coin-total" + (bal > 0 ? "" : " rw-coin-total--zero"),
      title: label, "aria-label": label,
    }, [
      h("span", { className: "rw-coin-glyph", "aria-hidden": "true" }, "🪙"),
      h("span", null, formatCoin(bal)),
    ]);
  }

  // Per-post "+N 🪙" chip with a hover tooltip explaining why the viewer earned
  // it (e.g. "you upvoted this and it reached Merged"). `earned` is the
  // coinByTicket[ticketId] entry: { coin, reasons }.
  function renderCoinChip(earned) {
    var reasons = (earned && earned.reasons) || [];
    var chip = h("span", {
      className: "rw-coin-chip",
      "aria-label": "You earned " + earned.coin + " coin from this post. " + reasons.join(". "),
    }, [
      h("span", { className: "rw-coin-glyph", "aria-hidden": "true" }, "🪙"),
      h("span", null, "+" + earned.coin),
    ]);
    var tip = null;
    function show() {
      if (tip) return;
      var items = reasons.length
        ? reasons.map(function (r) { return h("li", null, r); })
        : [h("li", null, "You helped this post make progress")];
      tip = h("span", { className: "rw-coin-tip" }, [
        h("span", { className: "rw-coin-tip-head" }, "Why you earned coin"),
        h("ul", null, items),
      ]);
      chip.appendChild(tip);
    }
    function hide() { if (tip && tip.parentNode) { tip.parentNode.removeChild(tip); } tip = null; }
    chip.addEventListener("mouseenter", show);
    chip.addEventListener("mouseleave", hide);
    return chip;
  }

  function renderTicketCard(ticket, opts) {
    var hideStatus = !!(opts && opts.hideStatus);
    var voted = ticket.userVote === true;
    var countSpan = h("span", null, String(ticket.yesVotes || 0));
    var voteBtn = h("button", {
      className: "rw-dash-vote" + (voted ? " rw-voted" : ""),
      type: "button",
      "aria-label": t("aria.upvote"),
      // Authed users vote directly. Anonymous viewers of a public widget
      // can click — the click is gated and redirects to the login URL
      // with their intent preserved. Anonymous viewers without a login
      // URL fall through to disabled (matches old behavior).
      disabled: !(config.isIdentified || canAnonInteract()),
      title: config.isIdentified ? t("aria.upvote") : t("aria.upvoteSignedOut"),
    }, [Icons.arrowUp(11), countSpan]);
    voteBtn.addEventListener("click", function (e) {
      // Stop the row's click handler from also firing (which would open detail).
      e.stopPropagation();
      handleVoteClick(ticket, voteBtn, countSpan, e);
    });

    var authorName = displayNameFromTicket(ticket);
    var metaChildren = [];
    // Private marker leads the meta row so the viewer can tell at a glance
    // which of their submissions are visible only to them. Private tickets
    // surface only to their owner (My Submissions), so this never leaks.
    if (ticket.isPrivate) {
      metaChildren.push(h("span", {
        className: "rw-meta-private",
        title: t("visibility.privateHint"),
        "aria-label": t("visibility.private"),
      }, [Icons.lock(11), h("span", null, t("visibility.private"))]));
    }
    // Status chip is suppressed on the Latest Updates tab — every ticket there
    // is already shipped (done/deployed), so the chip carries no information.
    if (!hideStatus) {
      if (metaChildren.length > 0) metaChildren.push(h("span", { className: "rw-meta-dot" }, "·"));
      metaChildren.push(renderStatusChip(ticket.status));
    }
    if (authorName) {
      if (metaChildren.length > 0) metaChildren.push(h("span", { className: "rw-meta-dot" }, "·"));
      metaChildren.push(h("span", { className: "rw-meta-author" }, authorName));
    }
    if (metaChildren.length > 0) metaChildren.push(h("span", { className: "rw-meta-dot" }, "·"));
    metaChildren.push(h("span", { className: "rw-meta-when" }, timeAgo(ticket.completedAt || ticket.createdAt)));

    // Per-post coin the viewer earned from this ticket ("if relevant" — only
    // when they created/upvoted it and it advanced). Sits at the tail of the
    // meta row; hovering the chip explains why.
    var earned = communityStats.coinByTicket && communityStats.coinByTicket[ticket.id];
    if (earned && earned.coin) {
      metaChildren.push(h("span", { className: "rw-meta-dot" }, "·"));
      metaChildren.push(renderCoinChip(earned));
    }

    // "Needs your attention" marker — a dot on the title + a highlighted row —
    // for the viewer's OWN tickets that have new activity since they last
    // looked. Only own tickets carry lastActivityAt, so this naturally shows
    // only in My Submissions. Makes it obvious WHICH of many tickets to open.
    var unseen = ticketHasUnseenActivity(ticket);

    var titleChildren = [];
    if (unseen) titleChildren.push(h("span", { className: "rw-unseen-dot", "aria-label": "New activity" }));
    titleChildren.push(h("span", null, ticket.title));
    var mainChildren = [h("div", { className: "rw-dash-row-title" }, titleChildren)];
    if (ticket.description) {
      mainChildren.push(h("div", { className: "rw-dash-row-body" }, renderMarkdownText(ticket.description)));
    }
    mainChildren.push(h("div", { className: "rw-dash-row-meta" }, metaChildren));

    var row = h("button", {
      className: "rw-dash-row" + (unseen ? " rw-dash-row--unseen" : ""), type: "button",
      "aria-label": (unseen ? "New activity — " : "") + t("aria.openTicket", { title: ticket.title }),
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

    // [+ New post] sits on the tab row's right. It now launches the agent chat
    // (a guided, conversational way to file a ticket — the same surface as
    // Home's chat card) rather than the direct compose form. goCompose /
    // renderInlineComposer stay defined but unwired, kept for possible re-use.
    var newPostBtn = h("button", { className: "rw-new-post-btn", type: "button" }, [
      Icons.plus(13),
      h("span", null, t("compose.newPost")),
    ]);
    newPostBtn.addEventListener("click", openChat);

    return h("div", { className: "rw-dash-tabs" }, [
      h("div", { className: "rw-dash-tabs-row", role: "tablist" }, tabButtons),
      newPostBtn,
    ]);
  }

  function renderList() {
    // "top" stayed as the cache name even though the tab is now "Hot" — accept either.
    var tab = activeTab === "top" ? "hot" : activeTab;

    // Lazy (re)load a stale cache. Filing a ticket nulls all three caches to
    // force a refetch, but navigating BACK to the list (a re-render, not a full
    // panel refresh) would otherwise render the "no tickets" empty state until a
    // manual refresh — the bug where a freshly-filed ticket "disappears" from My
    // Submissions. null = not loaded yet; [] = loaded and genuinely empty. Only
    // My Submissions is gated on identity (anon users can't load it).
    var cacheIsNull =
      tab === "updates" ? updatesCache === null :
      tab === "hot"     ? topTicketsCache === null :
                          (myTicketsCache === null && config.isIdentified);
    if (cacheIsNull) {
      var reload =
        tab === "updates" ? loadUpdates().then(function (d) { updatesCache = d.tickets || []; }) :
        tab === "hot"     ? loadTopTickets().then(function (d) { topTicketsCache = d.tickets || []; }) :
                            loadMyTickets().then(function (d) { myTicketsCache = d.tickets || []; });
      reload.catch(function () {
        if (tab === "updates") updatesCache = [];
        else if (tab === "hot") topTicketsCache = [];
        else myTicketsCache = [];
      }).then(function () {
        if (view === "list") renderPanelBody();
      });
      return renderLoading();
    }

    var allItems =
      tab === "updates" ? (updatesCache || []) :
      tab === "hot"     ? (topTicketsCache || []) :
                          (myTicketsCache || []);

    // "Unread only" filter — My Submissions only.
    var showFilter = tab === "mine" && config.isIdentified && allItems.length > 0;
    var unreadCount = tab === "mine" ? allItems.filter(ticketHasUnseenActivity).length : 0;
    var items = (tab === "mine" && mineUnreadOnly) ? allItems.filter(ticketHasUnseenActivity) : allItems;

    // Whole-area empty states (no tickets at all) replace the list outright.
    if (allItems.length === 0) {
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

    // Return the scroll container DIRECTLY (it owns flex:1 + overflow:auto).
    // The filter is its first child so it inherits the list's left padding and
    // aligns with the ticket rows — and scrolling keeps working on every tab.
    var list = h("div", { className: "rw-dash-list" });
    if (showFilter) list.appendChild(renderUnreadFilter(unreadCount));

    if (items.length === 0 && mineUnreadOnly) {
      list.appendChild(renderEmpty(t("filters.allCaughtUp"), t("filters.noUnread")));
      return list;
    }

    var cardOpts = tab === "updates" ? { hideStatus: true } : null;
    // Use `tk` for the loop variable — `t` is the i18n function.
    items.forEach(function (tk) { list.appendChild(renderTicketCard(tk, cardOpts)); });
    return list;
  }

  // "Unread only" toggle for My Submissions. Shows the unread count and flips
  // mineUnreadOnly, re-rendering the list in place.
  function renderUnreadFilter(unreadCount) {
    var on = mineUnreadOnly;
    var btn = h("button", {
      className: "rw-unread-filter" + (on ? " rw-on" : ""),
      type: "button",
      "aria-pressed": on ? "true" : "false",
    }, [
      h("span", { className: "rw-unread-filter-dot" }),
      document.createTextNode(t("filters.unreadOnly") + (unreadCount > 0 ? " (" + unreadCount + ")" : "")),
    ]);
    btn.addEventListener("click", function () { mineUnreadOnly = !mineUnreadOnly; renderPanelBody(); });
    return h("div", { className: "rw-unread-filter-row" }, [btn]);
  }

  // -----------------------------------------------------------------------
  // Inline composer (compose face)
  //
  // The message-entry surface, rendered inside the compose view (reached
  // from Home's "Send us a message" card, the list's [+ New post] button,
  // or a submit-ticket login-restore intent). Stages files locally, then sends
  // a single multipart create request so the backend reviews ticket text and
  // images together before auto-assignment can start.
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
        chipsEl.appendChild(renderAttachChip(entry, function (target) {
          var i = entries.indexOf(target);
          if (i >= 0) { releaseAttachPreview(entries[i]); entries.splice(i, 1); }
          renderChips(); updateSubmitEnabled();
        }, function () { return stagedGallery(entries); }));
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
    // Paste-to-attach is only wired when image attachments are enabled
    // server-side; otherwise a pasted screenshot must not queue an upload.
    if (config.attachmentsEnabled) {
      ta.addEventListener("paste", function (e) {
        if (e.clipboardData && e.clipboardData.files && e.clipboardData.files.length > 0) {
          e.preventDefault(); addFiles(e.clipboardData.files);
        }
      });
    }

    var submitBtn = h("button", { className: "rw-inline-submit", type: "button" }, [
      h("span", null, t("composer.submit")),
    ]);
    // When submit is unavailable we keep the button focusable/hoverable and use
    // aria-disabled + a class instead of the native `disabled` attribute.
    // A natively-disabled <button> suppresses pointer events in Chrome/Safari,
    // so its `title` tooltip never shows and a click can't surface a reason —
    // exactly the "dead button, no explanation" the user hit. submitReason
    // holds the current blocking reason (null = armed); the click handler and
    // the instant hover tooltip both read it. Native `disabled` is still used for the
    // transient in-flight states (posting/uploading) below, which need no
    // explanation.
    var submitReason = null;
    // `reason` gates the click/keydown and applies the disabled styling.
    // `showTooltip` controls whether it ALSO surfaces as the button's
    // hover/click ::after bubble. The identity-lock reason is shown once,
    // by the persistent top-of-composer banner — surfacing it on the
    // button too (and again via the click handler) was the triple-render
    // the user (rightly) called redundant. Short hints (empty composer)
    // keep the tooltip since no banner shows for them.
    function setSubmitReason(reason, showTooltip) {
      submitReason = reason;
      if (reason) {
        submitBtn.setAttribute("aria-disabled", "true");
        if (showTooltip) submitBtn.setAttribute("data-rw-reason", reason);
        else submitBtn.removeAttribute("data-rw-reason");
      } else {
        submitBtn.removeAttribute("aria-disabled");
        submitBtn.removeAttribute("data-rw-reason");
      }
    }
    function updateSubmitEnabled() {
      // Empty composer never submits, regardless of auth state. Short hint,
      // no banner for this case → keep it as the button tooltip.
      if (ta.value.trim().length === 0) { setSubmitReason(t("composer.disabledEmpty"), true); return; }
      // Authed users can always submit. Anonymous viewers of a public widget
      // can submit too — the click triggers a login redirect that preserves
      // their draft. Anything else (private widget, or public with no login
      // URL configured) stays locked. The reason is shown ONCE, by the
      // persistent banner at the top of the composer — not also on the
      // button and again on click. So gate without a tooltip here.
      if (config.isIdentified || canAnonInteract()) { setSubmitReason(null); return; }
      setSubmitReason(
        config.authErrorMessage || t("composer.disabledLocked"),
        false
      );
    }
    updateSubmitEnabled();
    ta.addEventListener("input", updateSubmitEnabled);
    ta.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        if (!submitReason && !submitBtn.disabled) submitBtn.click();
      }
    });

    var isPrivate = false;
    var attachBtn = h("button", { className: "rw-pill-btn", type: "button" }, [
      Icons.paperclip(13), h("span", null, t("composer.attach")),
    ]);
    attachBtn.addEventListener("click", function () { fileInput.click(); });
    // Visibility toggle: label flips between "Public" and "Private"
    // (with matching globe / lock icon) instead of a single "Private"
    // pill lighting up. Reads as a clear state change at a glance.
    // Unique class so applyIntent can find and toggle this button when
    // restoring a draft that was saved with privacy on. Without this,
    // an anon user who chose "private" before login redirects ends up
    // submitting publicly on return — the description and files restore
    // but the privacy toggle silently resets.
    var privateBtn = h("button", { className: "rw-pill-btn rw-priv-toggle", type: "button", "data-rw-private": "false" }, [
      Icons.globe(12),
      h("span", null, t("composer.public")),
    ]);
    var privHint = h("span", { className: "rw-priv-hint" }, t("composer.privateOff"));
    function refreshPrivateBtn() {
      clearChildren(privateBtn);
      privateBtn.appendChild(isPrivate ? Icons.lock(12) : Icons.globe(12));
      privateBtn.appendChild(h("span", null, isPrivate ? t("composer.private") : t("composer.public")));
      privateBtn.setAttribute("data-rw-private", isPrivate ? "true" : "false");
    }
    privateBtn.addEventListener("click", function () {
      isPrivate = !isPrivate;
      refreshPrivateBtn();
      privHint.textContent = isPrivate ? t("composer.privateOn") : t("composer.privateOff");
    });

    submitBtn.addEventListener("click", function () {
      // Soft-disabled: block the submit. The reason is already shown
      // persistently (banner for the identity lock; tooltip for the empty
      // hint) — do NOT also re-render it as a notice here, that was the
      // redundant duplicate.
      if (submitReason) return;
      var description = ta.value.trim();
      if (!description) return;

      // Anonymous viewer on a public widget: serialize the draft (description,
      // private toggle, queued image files as base64) into sessionStorage,
      // then redirect to the configured login URL with ?return_to=<page>.
      // The widget restores the draft on its next bootstrap once the user is
      // authenticated. Files are NEVER uploaded to the server in this branch —
      // images stay in the browser until a real authenticated submit fires.
      if (isAnonViewer()) {
        if (!config.loginUrl) {
          clearChildren(noticeSlot);
          noticeSlot.appendChild(renderNotice("error", t("composer.loginNotConfigured")));
          return;
        }
        submitBtn.disabled = true;
        submitBtn.firstChild.textContent = t("composer.savingDraft");
        Promise.all(entries.map(function (e) { return fileToDataUrl(e.file); }))
          .then(function (serializedFiles) {
            gateWriteAction({
              type: "submit-ticket",
              draft: {
                description: description,
                isPrivate: isPrivate,
                files: serializedFiles,
              },
            });
          })
          .catch(function () {
            // On serialization failure, drop the files and redirect with
            // text only so the user isn't stranded with an unclickable button.
            gateWriteAction({
              type: "submit-ticket",
              draft: { description: description, isPrivate: isPrivate, files: [] },
            });
          });
        return;
      }

      if (!config.isIdentified) {
        clearChildren(noticeSlot);
        noticeSlot.appendChild(renderNotice("error", t("composer.needSignIn")));
        return;
      }
      submitBtn.disabled = true;
      submitBtn.firstChild.textContent = t("composer.posting");
      clearChildren(noticeSlot);

      // Captured across the upload .then so the post-submit branch can route
      // the author straight into the ticket they just filed.
      var createdTicket = null;
      var payload = {
        description: description,
        isPrivate: isPrivate,
        context: collectContext(),
      };
      var request;
      if (entries.length > 0) {
        submitBtn.firstChild.textContent = t("composer.uploading");
        request = createTicketWithAttachments(payload, entries.map(function (e) { return e.file; }));
      } else {
        request = createTicket(payload);
      }

      request.then(function (data) {
        createdTicket = (data && data.ticket) || null;
        ta.value = "";
        releaseAllAttachPreviews(entries);
        entries.length = 0;
        renderChips();
        isPrivate = false;
        refreshPrivateBtn();
        privHint.textContent = t("composer.privateOff");
        submitBtn.firstChild.textContent = t("composer.submit");
        topTicketsCache = null; updatesCache = null; myTicketsCache = null; assignedTicketsCache = null;
        composeReturnView = "home";
        activeTab = "mine";

        // Take the author straight into the ticket they just filed. Assignment
        // is automatic + server-side, but a thin ticket is held for one round
        // of clarifying questions — the detail view polls and surfaces those
        // within a few seconds, so the author can answer and unblock the agent.
        // Back from here lands on the My Submissions list (activeTab = 'mine').
        if (createdTicket && createdTicket.id) {
          detailReturnView = null;
          openDetailModal(createdTicket);
          return;
        }

        // Fallback (no ticket id returned): land on the My Submissions list.
        view = "list";
        return refreshAll();
      }).catch(function (err) {
        submitBtn.disabled = false;
        submitBtn.firstChild.textContent = t("composer.submit");
        clearChildren(noticeSlot);
        var msg = entries.length > 0 ? friendlyAttachError(err) : friendlySubmitError(err);
        noticeSlot.appendChild(renderNotice("error", t("composer.failed", { msg: msg })));
      });
    });

    return h("div", { className: "rw-inline-composer" }, [
      // Single, persistent, in-your-face surface for the identity lock.
      // Shows whenever submit is locked because the viewer isn't recognized
      // (no token / rejected token). This REPLACES the old button-tooltip +
      // click-notice duplicates — one message, not three.
      (!config.isIdentified && !canAnonInteract())
        ? h("div", { className: "rw-auth-banner" }, [
            h("div", { className: "rw-auth-banner-hd" },
              config.authError ? "⚠ Widget not set up correctly" : "⚠ Can’t submit — not signed in"),
            h("div", { className: "rw-auth-banner-msg" },
              config.authErrorMessage || t("composer.disabledLocked")),
            config.authError
              ? h("div", { className: "rw-auth-banner-sub" },
                  "Error code: " + config.authError + " — open the browser console for the exact fix.")
              : null,
          ])
        : null,
      ta,
      chipsEl,
      h("div", { className: "rw-inline-composer-bar" }, [
        h("div", { className: "rw-inline-tools" }, [
          config.attachmentsEnabled ? attachBtn : null, privateBtn, privHint,
        ]),
        submitBtn,
      ]),
      noticeSlot,
      config.attachmentsEnabled ? fileInput : null,
    ]);
  }

  // ===========================================================================
  // Home view (Intercom-style landing)
  //
  // Opening the widget lands here: a localized greeting plus navigation
  // cards into the existing faces — chat (only when the bootstrap payload
  // says a support agent is configured) or the compose face when it isn't,
  // the Hot discussion list, and the Latest Updates list. The shell actions
  // (theme + close) are pinned top-right of the card outside scrollEl, so
  // Home inherits its close button without rendering one.
  // ===========================================================================

  // Centralized home/list navigation. Both stop any running detail poll —
  // navigating away from a detail must never leave its 5s refresh loop alive.
  function goHome() {
    stopDetailPoll();
    view = "home";
    currentDetailTicket = null;
    // A detail opened FROM chat must not leave its return-to-chat marker
    // behind once the user jumps home instead.
    detailReturnView = null;
    // If a live session was open when goHome() was triggered (e.g. via the
    // topbar home button), clear the live session flags so they don't bleed
    // into the next chat view open.
    chatIsLiveSession = false;
    liveSessionTicket = null;
    renderPanelBody();
  }

  function goList(tab) {
    stopDetailPoll();
    view = "list";
    if (tab) activeTab = tab;
    currentDetailTicket = null;
    detailReturnView = null;
    chatIsLiveSession = false;
    liveSessionTicket = null;
    renderPanelBody();
  }

  // Compose face. Records the view it was opened from so its back control
  // returns there (Home's "Send us a message" card keeps home, the list's
  // [+ New post] keeps list). Like goHome/goList, kills any running detail poll.
  function goCompose() {
    stopDetailPoll();
    composeReturnView = view === "list" ? "list" : "home";
    view = "compose";
    currentDetailTicket = null;
    detailReturnView = null;
    renderPanelBody();
  }

  function renderHomeCard(emoji, title, sub, onClick, count) {
    var children = [
      h("span", { className: "rw-home-card-emoji", "aria-hidden": "true" }, emoji),
      h("span", { className: "rw-home-card-text" }, [
        h("span", { className: "rw-home-card-title" }, title),
        h("span", { className: "rw-home-card-sub" }, sub),
      ]),
    ];
    if (typeof count === "number" && count > 0) {
      children.push(h("span", { className: "rw-home-card-count" }, count > 99 ? "99+" : String(count)));
    }
    children.push(h("span", { className: "rw-home-card-chev" }, Icons.chevRight(16)));
    var btn = h("button", { className: "rw-home-card", type: "button" }, children);
    btn.addEventListener("click", onClick);
    return btn;
  }

  function renderHomeView() {
    var root = h("div", { className: "rw-home" });

    root.appendChild(h("div", { className: "rw-home-greet" },
      h("div", { className: "rw-home-greet-title" }, t("home.greeting"))));

    var cards = h("div", { className: "rw-home-cards" });

    // 💬 Chat with Agent — rendered ONLY when the bootstrap payload carries
    // `chat: { enabled: true, agentName }` (served once a support agent is
    // picked in widget settings; separate plan). Absent field ⇒ falsy ⇒
    // hidden, so existing embeds are bit-for-bit unaffected until then.
    if (config.chat && config.chat.enabled) {
      cards.appendChild(renderHomeCard(
        "💬",
        t("home.chatTitle"),
        config.chat.agentName
          ? t("home.chatSub", { name: config.chat.agentName })
          : t("home.chatSubGeneric"),
        openChat
      ));
    } else {
      // No support agent configured — the message entry must not disappear.
      // Same slot, neutral Intercom-style wording; opens the CHAT view in
      // agentless intake mode (messages accumulate, no turns dispatch, a
      // [Submit Ticket] action files them — see updateChatActionSlot).
      // Public posting keeps its own entry: the board's [+ New post]
      // still opens the compose face.
      cards.appendChild(renderHomeCard(
        "💬",
        t("home.messageTitle"),
        t("home.messageSub"),
        openChat
      ));
    }

    cards.appendChild(renderHomeCard(
      "🗳",
      t("home.discussTitle"),
      t("home.discussSub"),
      function () { goList("hot"); },
      (topTicketsCache || []).length
    ));

    cards.appendChild(renderHomeCard(
      "📣",
      t("home.updatesTitle"),
      t("home.updatesSub"),
      function () { goList("updates"); },
      (updatesCache || []).length
    ));

    root.appendChild(cards);

    // Brand-locked footer tag — same composition as the list view's
    // eyebrow "powered by RunHQ" (always English regardless of locale).
    root.appendChild(h("div", { className: "rw-powered-by rw-home-powered" }, [
      document.createTextNode("powered by "),
      h("a", {
        href: "https://www.runhq.io", target: "_blank",
        rel: "noopener noreferrer", "aria-label": "Visit RunHQ",
      }, "RunHQ"),
    ]));

    return root;
  }

  // -----------------------------------------------------------------------
  // Shell mode. Every view — home, chat, list, detail — renders in the same
  // large centered modal over a full scrim overlay. The old Intercom-style
  // compact corner panel (home/chat/compose) has been removed, so no view is
  // ever compact. applyShellMode stays as the single funnel that keeps the
  // scrim class in sync (belt-and-braces: it strips any stray rw-compact),
  // called from openPanel — BEFORE rw-open, so the first paint is correct —
  // and from renderPanelBody, which every in-panel navigation funnels through.
  // -----------------------------------------------------------------------

  function isCompactView(_v) { return false; }

  function applyShellMode() {
    if (!widgetEl) return;
    widgetEl.classList.toggle("rw-compact", isCompactView(view));
  }

  // -----------------------------------------------------------------------
  // Top-level body renderer — builds either the split (list) view or the
  // full-width detail view, depending on `view` state.
  // -----------------------------------------------------------------------

  function renderPanelBody() {
    if (!scrollEl) return;
    applyShellMode();
    clearChildren(scrollEl);

    if (view === "home") {
      scrollEl.appendChild(renderHomeView());
      return;
    }

    if (view === "compose") {
      var composeFull = h("div", { className: "rw-compose" });
      var composeBack = h("button", {
        className: "rw-home-btn", type: "button", "aria-label": t("compose.back"),
      }, [Icons.arrowLeft(13), h("span", null, t("compose.back"))]);
      composeBack.addEventListener("click", function () {
        var returnTo = composeReturnView;
        composeReturnView = "home";
        if (returnTo === "list") goList(); else goHome();
      });
      composeFull.appendChild(h("div", { className: "rw-compose-topbar" }, [composeBack]));
      composeFull.appendChild(h("div", { className: "rw-compose-title" }, t("compose.title")));
      composeFull.appendChild(renderInlineComposer());
      scrollEl.appendChild(composeFull);
      // Autofocus so typing starts immediately — every entry point (Home
      // card, [+ New post], intent restore) funnels through this branch.
      requestAnimationFrame(function () {
        var composeTa = scrollEl && scrollEl.querySelector(".rw-inline-composer-ta");
        if (composeTa) composeTa.focus();
      });
      return;
    }

    if (view === "detail" && currentDetailTicket) {
      var detailFull = h("div", { className: "rw-detail-full" });

      // Topbar with just the Back button. The ticket ref id used to live
      // here too but it duplicated the #refId chip in the head below and
      // collided with the absolute-positioned shell actions on narrow
      // viewports — gone.
      var backLabel = detailReturnView === "chat" ? t("chat.backToChat") : t("detail.back");
      var backBtn = h("button", { className: "rw-back-btn", type: "button" }, [
        Icons.arrowLeft(13),
        h("span", null, backLabel),
      ]);
      backBtn.addEventListener("click", function () {
        stopDetailPoll();
        var returnTo = detailReturnView;
        detailReturnView = null;
        currentDetailTicket = null;
        view = returnTo === "chat" ? "chat" : "list";
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
    } else if (view === "chat") {
      scrollEl.appendChild(renderChatViewShell());
    } else {
      // The discussion board is the widget's landing view, so its slim topbar
      // holds the board title (not a back-to-home control — Home was retired
      // from the flow). The right padding on .rw-list-topbar keeps the title
      // clear of the absolute-positioned shell actions (bell / theme / close).
      var boardTitle = config.projectName
        ? t("header.feedback", { name: config.projectName })
        : t("home.greeting");
      scrollEl.appendChild(h("div", { className: "rw-list-topbar" }, [
        h("span", { className: "rw-list-title" }, boardTitle),
        renderCoinTotalBadge(),
      ]));

      // Single full-width panel: tab bar (with [+ New post] on its right)
      // + list. The old left pane (intro copy, inline composer, Recent
      // Submissions) is gone — Home's "Send us a message" card and the
      // [+ New post] button open the compose face instead.
      scrollEl.appendChild(h("div", { className: "rw-list-panel" }, [
        renderTabsBar(),
        renderList(),
      ]));
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
      // Refresh public/login fields too — owner toggling Public off mid-session
      // should disable the anon-redirect path on next refresh.
      config.isPublic = !!data.isPublic;
      config.loginUrl = data.loginUrl || null;
      // Re-read chat config on every panel open so enabling/disabling the
      // support agent in settings picks up without an embed reload.
      config.chat = data.chat || null;
      // Deploy-environment id→name map, for resolving `deployed:<envId>` status
      // labels to "Deployed → <name>" across the list/detail/live-session.
      setDeployEnvironments(data.environments);
      // Image-attach affordances are gated server-side (currently off). Absent
      // ⇒ false ⇒ hidden, which is the safe default against an older server.
      config.attachmentsEnabled = !!data.attachmentsEnabled;
    });
    var updP = loadUpdates().then(function (data) {
      updatesCache = data.tickets || [];
    }).catch(function () { updatesCache = []; });
    // RunHQ-cookie users have config.token === null but ARE authenticated.
    // Gating on isIdentified (set after the topTickets / identity response)
    // keeps their "My Submissions" list populated on every refresh; gating
    // on config.token alone would silently empty it on panel re-open.
    var mineP = config.isIdentified
      ? loadMyTickets().then(function (d) { myTicketsCache = d.tickets || []; }).catch(function () { myTicketsCache = []; })
      : Promise.resolve().then(function () { myTicketsCache = []; });
    var assignedP = (config.isIdentified && viewerCanLiveCoder())
      ? loadAssignedTickets().then(function (d) { assignedTicketsCache = d.tickets || []; }).catch(function () { assignedTicketsCache = []; })
      : Promise.resolve().then(function () { assignedTicketsCache = []; });
    // Community coin — only meaningful for an identified viewer (the endpoint
    // 401s for anonymous project keys). Chained on topP so config.isIdentified
    // is known. Best-effort: coin UI is non-critical and must never block the list.
    var commP = topP.then(function () {
      if (!config.isIdentified) { communityStats = { identified: false, balance: 0, coinByTicket: {} }; return; }
      return loadCommunityStats().then(function (data) {
        communityStats = {
          identified: true,
          balance: (data && data.balance) || 0,
          coinByTicket: (data && data.coinByTicket) || {},
        };
      }).catch(function () { communityStats = { identified: true, balance: 0, coinByTicket: {} }; });
    }).catch(function () { communityStats = { identified: false, balance: 0, coinByTicket: {} }; });

    return Promise.all([topP, updP, mineP, assignedP, commP]).then(function () {
      renderPanelBody();
      refreshTabLabel();
    }).catch(function (err) {
      clearChildren(scrollEl);
      scrollEl.appendChild(renderNotice("error", t("list.loadFailed", { msg: err.message || "" })));
    });
  }

  // Refresh ONLY the unread-driving caches + the label/bell/launcher (not the
  // list body), so the badge reflects new activity without disrupting the
  // current view. refreshTabLabel rebuilds the launcher tab, so this updates the
  // closed "HQ N" pill too — not just the in-panel bell.
  function refreshBadgeCaches() {
    if (!config.isIdentified) return Promise.resolve();
    var jobs = [
      loadMyTickets().then(function (d) { myTicketsCache = d.tickets || []; }).catch(function () {}),
    ];
    if (viewerCanLiveCoder()) {
      jobs.push(loadAssignedTickets().then(function (d) { assignedTicketsCache = d.tickets || []; }).catch(function () {}));
    }
    return Promise.all(jobs).then(function () { refreshTabLabel(); });
  }

  // Fallback poll for the unread badge while the panel is open — only does work
  // when the real-time notifications stream is NOT connected (the stream is the
  // primary, instant path; see startNotificationsStream). Runs while open so an
  // engaged user still gets updates if SSE is unavailable.
  function startBadgePoll() {
    stopBadgePoll();
    if (!config.isIdentified) return;
    badgePollTimerId = setInterval(function () {
      if (!isOpen || !config.isIdentified) { stopBadgePoll(); return; }
      if (notifStreamConnected) return; // SSE is handling it
      refreshBadgeCaches();
    }, BADGE_POLL_INTERVAL_MS);
  }

  function stopBadgePoll() {
    if (badgePollTimerId !== null) { clearInterval(badgePollTimerId); badgePollTimerId = null; }
  }

  // ---------------------------------------------------------------------------
  // Real-time unread: a single per-user SSE stream (GET /notifications/events)
  // that fires a payload-free 'ping' whenever a ticket the viewer reported or
  // assigned changes — including a coder/teammate live-session reply. On a ping
  // we re-fetch the badge caches. Runs for the page lifetime (open OR closed) so
  // the launcher pill lights up without the widget being open. Degrades to the
  // open-panel poll if EventSource is unavailable or the stream errors.
  // ---------------------------------------------------------------------------
  function notificationsEventsUrl() {
    var url = RUNHQ_API + "/api/widget/notifications/events";
    var params = [];
    if (config.identitySource !== "runhq" && config.token) {
      params.push("token=" + encodeURIComponent(config.token));
    }
    // ?project= lets cookie-auth members authenticate (EventSource can't send
    // the X-RW-Project header); the BE shims it in.
    if (config.project) params.push("project=" + encodeURIComponent(config.project));
    return params.length ? url + "?" + params.join("&") : url;
  }

  function startNotificationsStream() {
    if (!config.isIdentified) return;
    if (notifEventSourceRef) return; // already streaming
    if (typeof window.EventSource !== "function") return; // no SSE → poll covers it
    if (notifReconnectTimerId !== null) { clearTimeout(notifReconnectTimerId); notifReconnectTimerId = null; }
    try {
      var es = new EventSource(notificationsEventsUrl(), { withCredentials: wantsCookieAuth() });
      es.addEventListener("ready", function () { notifStreamConnected = true; });
      es.addEventListener("ping", function () {
        notifStreamConnected = true;
        refreshBadgeCaches();
      });
      es.onerror = function () {
        // A stream that errors is not silently retried in a tight loop: close it
        // and schedule ONE delayed reconnect, so a transient blip self-heals but
        // a hard failure (e.g. cookie project shim unsupported) falls back to the
        // open-panel poll rather than hammering the endpoint.
        notifStreamConnected = false;
        try { es.close(); } catch (_) {}
        if (notifEventSourceRef === es) {
          notifEventSourceRef = null;
          if (notifReconnectTimerId === null) {
            notifReconnectTimerId = setTimeout(function () {
              notifReconnectTimerId = null;
              startNotificationsStream();
            }, NOTIF_RECONNECT_MS);
          }
        }
      };
      notifEventSourceRef = es;
    } catch (_) {
      notifEventSourceRef = null;
      notifStreamConnected = false;
    }
  }

  function stopNotificationsStream() {
    if (notifEventSourceRef) {
      try { notifEventSourceRef.close(); } catch (_) {}
      notifEventSourceRef = null;
    }
    if (notifReconnectTimerId !== null) { clearTimeout(notifReconnectTimerId); notifReconnectTimerId = null; }
    notifStreamConnected = false;
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
  // Chat view (agent conversation)
  //
  // Message-bubble UI against the BE chat API. Bubbles: user right, agent
  // left with name + avatar. The footer pins an input row (4000-char cap,
  // Enter to send) or — when the conversation is closed — a "Start new
  // conversation" bar. Card idioms (rw-clarif-*) match the clarification
  // question cards.
  // ===========================================================================

  // Support-agent identity from the bootstrap payload (`chat: { enabled,
  // agentName }` on GET /api/widget/tickets — captured into config.chat by
  // refreshAll/init). Reads are defensive — chat renders with a generic
  // "Support" identity and an initials avatar until/unless the field exists.
  function chatAgentName() {
    return (config.chat && config.chat.agentName) || t("chat.agentDefault");
  }
  // Whether a support agent is configured for this widget (bootstrap
  // `chat.enabled`). Drives the chat surface's two personalities: agent
  // mode (turns, typing indicator, proposal flow) vs agentless intake
  // (messages accumulate, [Submit Ticket] files them).
  function chatAgentMode() {
    return !!(config.chat && config.chat.enabled);
  }
  // Whether THIS conversation has any agent involvement. Beyond the static
  // config gate, an agentless conversation can gain agent turns when an
  // owner configures a support agent mid-thread: the resume payload's
  // `hasAgentTurns` flips true, or agent rows / proposal events arrive over
  // the live transport. Once true the agentless intake affordances
  // (collect prompt styling, [Submit Ticket]) yield to the agent flow.
  function chatThreadHasAgent() {
    if (chatAgentMode()) return true;
    if (chatConversation && chatConversation.hasAgentTurns) return true;
    for (var i = 0; i < chatMessages.length; i++) {
      var m = chatMessages[i];
      if (m.role === "agent") return true;
      if (m.role === "event" && m.payload && m.payload.kind === "proposal") return true;
    }
    return false;
  }
  // Display identity for the bot side of the thread: the agent's name when
  // one is configured, otherwise the project name (Intercom-style company
  // attribution for the agentless inbox).
  function chatIdentityName() {
    if (chatAgentMode()) return chatAgentName();
    return config.projectName || config.project || t("chat.agentDefault");
  }
  function chatAgentAvatarUrl() {
    return (config.chat && config.chat.agentAvatarUrl) || null;
  }
  function renderChatAgentAvatar(size) {
    var url = chatAgentAvatarUrl();
    if (url) {
      return h("img", {
        className: "rw-chat-agent-img",
        src: url, alt: chatIdentityName(),
        style: { width: size + "px", height: size + "px" },
      });
    }
    return renderAvatar(chatIdentityName(), size);
  }

  // Entry point. Same gating as ticket submission: anonymous viewers of a
  // public widget go through the login-redirect intent path (draftless
  // "chat" intent restored by applyIntent after login); everyone else
  // proceeds and lets the API's 403 surface misconfigurations.
  function openChat() {
    if (isAnonViewer()) {
      gateWriteAction({ type: "chat" });
      return;
    }
    stopDetailPoll();
    view = "chat";
    currentDetailTicket = null;
    renderPanelBody();
  }

  // Open the Live session chat view for a staff member with the `live_coder`
  // permission. Pre-seeds the chatConversation with a stub so renderChatViewShell
  // skips chatOpenConversation() and goes straight to message-loading + transport.
  // Back-navigation returns to the ticket detail.
  function openLiveSession(conversationId, ticket) {
    stopDetailPoll();
    stopChatTransport();
    // Pre-seed the conversation stub. renderChatViewShell detects a non-null
    // chatConversation and skips chatOpenConversation().
    chatConversation = { id: conversationId, status: "active", createdTaskId: ticket.id, pendingTurnId: null };
    chatMessages = [];
    chatTurnPending = false;
    chatSubmitInFlight = false;
    chatIsLiveSession = true;
    liveSessionTicket = ticket;
    // Return-from-detail bookkeeping.
    detailReturnView = "detail";
    view = "chat";
    renderPanelBody();
  }

  // Tear down whatever delivery mechanism is live (SSE stream, poll timer,
  // closed-watch). Safe to call repeatedly; the refs it clears are armed by
  // the transport layer.
  function stopChatTransport() {
    if (chatEventSourceRef) {
      try { chatEventSourceRef.close(); } catch (_) {}
      chatEventSourceRef = null;
    }
    if (chatPollTimerId !== null) {
      clearTimeout(chatPollTimerId);
      chatPollTimerId = null;
    }
    if (chatClosedWatchTimerId !== null) {
      clearInterval(chatClosedWatchTimerId);
      chatClosedWatchTimerId = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Transport. SSE (EventSource) is preferred; a stream that errors once
  // (auth, proxy buffering, old browser) is not retried — adaptive polling
  // is the reliable path (~1.5s while a turn is pending, 5s idle).
  //
  // EventSource cannot attach an Authorization header, so the app-token
  // path passes the JWT as ?token= (the BE chat-events route shims it into
  // Authorization). The runhq-cookie path uses withCredentials plus
  // ?project= in place of the X-RW-Project header — the BE does not read
  // that param yet, so cookie embeds degrade to polling (by design: the
  // stream errors once and never retries). The BE replays rows newer than
  // ?after= on subscribe, closing the gap between the bootstrap fetch and
  // the stream opening (clients dedupe by id).
  // ---------------------------------------------------------------------------

  function chatEventsUrl(conversationId) {
    var url = RUNHQ_API + "/api/widget/chat/conversations/" + encodeURIComponent(conversationId) + "/events";
    var params = [];
    if (config.identitySource !== "runhq" && config.token) {
      params.push("token=" + encodeURIComponent(config.token));
    }
    if (config.project) params.push("project=" + encodeURIComponent(config.project));
    var cursor = chatLastCursor();
    if (cursor) params.push("after=" + encodeURIComponent(cursor));
    return params.length ? url + "?" + params.join("&") : url;
  }

  // Newest server-assigned message id (skips local- optimistic echoes) —
  // the `after` cursor for the polling fallback.
  function chatLastCursor() {
    for (var i = chatMessages.length - 1; i >= 0; i--) {
      if (String(chatMessages[i].id).indexOf("local-") !== 0) return chatMessages[i].id;
    }
    return null;
  }

  // Server rows replace optimistic local echoes: same role 'user' + same
  // content, or same event kind. Returns true when a swap happened.
  function chatReplaceLocalEcho(row) {
    for (var i = chatMessages.length - 1; i >= 0; i--) {
      var m = chatMessages[i];
      if (String(m.id).indexOf("local-") !== 0) continue;
      if (row.role === "user" && m.role === "user" && m.content === row.content) {
        // Carry local _dataUrl previews forward to the authoritative server row
        // so images remain visible while the data URL is still in memory.
        // The serve endpoint (chatGetImageUrl) fetches a presigned URL for
        // authoritative rows that have no local preview.
        var localImgs = m.images || [];
        var serverImgs = row.images || [];
        if (localImgs.length > 0) {
          if (serverImgs.length === 0) {
            row.images = localImgs;
          } else {
            for (var j = 0; j < Math.min(localImgs.length, serverImgs.length); j++) {
              if (localImgs[j]._dataUrl && !serverImgs[j]._dataUrl) {
                serverImgs[j]._dataUrl = localImgs[j]._dataUrl;
              }
            }
          }
        }
        chatMessages[i] = row;
        return true;
      }
      if (row.role === "event" && m.role === "event"
          && m.payload && row.payload && m.payload.kind === row.payload.kind) {
        chatMessages[i] = row;
        return true;
      }
    }
    return false;
  }

  // Whether a turn is still awaiting the agent's visible reply, derived from
  // the message flow itself: scanning from the end, the first turn-relevant
  // row decides — a user action (user message, proposal resolution, force
  // marker) means pending; an agent reply / proposal / system notice means
  // settled. Needed because SSE can deliver the turn's outcome BEFORE the
  // user-action POST resolves (the BE awaits the turn dispatch) — a blind
  // `chatTurnPending = true` after the POST would wedge the typing
  // indicator on. ticket_link / assigned arrive mid-turn and are skipped,
  // as are 'team' rows — a human teammate replying never starts or settles
  // an agent turn. Agentless threads short-circuit to false: nothing is
  // ever pending when no agent dispatches turns.
  function chatTurnStillPending() {
    // A live-coder session is a steering channel, not a request/response turn:
    // the coder works in its own terminal and narrates back asynchronously (if
    // at all). Gating a "typing…" indicator on the staff's last message would
    // leave it spinning forever, so never treat a live session as pending.
    if (chatIsLiveSession) return false;
    if (!chatThreadHasAgent()) return false;
    for (var i = chatMessages.length - 1; i >= 0; i--) {
      var m = chatMessages[i];
      if (m.role === "agent") return false;
      if (m.role === "user") return true;
      if (m.role === "event" && m.payload) {
        var kind = m.payload.kind;
        if (kind === "proposal" || kind === "system_notice") return false;
        if (kind === "proposal_resolved" || kind === "force_proposal_requested") return true;
      }
    }
    return false;
  }

  // Merge incoming rows (SSE or poll). Dedupe by id; agent text, proposals,
  // and system notices end the pending turn (ticket_link / assigned arrive
  // mid-turn and keep the typing indicator up).
  function chatApplyMessages(rows) {
    if (!rows || rows.length === 0) return;
    var changed = false;
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      if (!row || row.id == null) continue;
      var dup = false;
      for (var i = 0; i < chatMessages.length; i++) {
        if (chatMessages[i].id === row.id) { dup = true; break; }
      }
      if (dup) continue;
      if (!chatReplaceLocalEcho(row)) chatMessages.push(row);
      changed = true;
      if (row.role === "agent") chatTurnPending = false;
      if (row.role === "event" && row.payload) {
        var kind = row.payload.kind;
        if (kind === "proposal" || kind === "system_notice") chatTurnPending = false;
        if (kind === "proposal_resolved" && row.payload.created) startChatClosedWatch();
      }
    }
    if (changed && view === "chat") renderChatMessageList();
  }

  function startChatTransport() {
    if (!chatConversation || chatConversation.status !== "active") return;
    if (chatEventSourceRef || chatPollTimerId !== null) return; // already running
    if (typeof window.EventSource === "function") {
      try {
        var convAtOpen = chatConversation;
        var es = new EventSource(chatEventsUrl(convAtOpen.id), { withCredentials: wantsCookieAuth() });
        es.onmessage = function (e) {
          if (view !== "chat" || chatConversation !== convAtOpen) return;
          var row = null;
          try { row = JSON.parse(e.data); } catch (_) { return; }
          chatApplyMessages([row]);
        };
        es.onerror = function () {
          try { es.close(); } catch (_) {}
          if (chatEventSourceRef === es) {
            chatEventSourceRef = null;
            if (view === "chat" && chatConversation === convAtOpen) scheduleChatPoll();
          }
        };
        chatEventSourceRef = es;
        return;
      } catch (_) {
        chatEventSourceRef = null;
      }
    }
    scheduleChatPoll();
  }

  function scheduleChatPoll() {
    if (chatPollTimerId !== null) clearTimeout(chatPollTimerId);
    chatPollTimerId = setTimeout(chatPollTick, chatTurnPending ? CHAT_POLL_FAST_MS : CHAT_POLL_IDLE_MS);
  }

  function chatPollTick() {
    chatPollTimerId = null;
    if (view !== "chat" || !chatConversation || chatConversation.status !== "active") return;
    var conv = chatConversation;
    chatLoadMessages(conv.id, chatLastCursor()).then(function (data) {
      if (view !== "chat" || chatConversation !== conv) return;
      chatApplyMessages((data && data.messages) || []);
    }).catch(function () {
      // Silent — the next tick retries (matches startDetailPoll's posture).
    }).then(function () {
      if (view !== "chat" || chatConversation !== conv || chatConversation.status !== "active") return;
      scheduleChatPoll();
    });
  }

  // After a ticket is created the agent gets a wrap-up turn and the BE closes
  // the conversation once it has nothing left to resolve. Status changes don't
  // stream as message rows, so poll for closure.
  //
  // We poll THIS conversation's own status (by id), NOT /conversations/active:
  // the moment a ticket is filed the conversation gains a createdTaskId, which
  // getActiveConversation deliberately excludes (it only surfaces intake
  // threads). A multi-ticket intake keeps the conversation open to host the
  // next proposal — reading "am I still the active intake thread?" would report
  // that (legitimately open) conversation as closed and hide the pending card.
  function startChatClosedWatch() {
    if (chatClosedWatchTimerId !== null) return;
    var conv = chatConversation;
    chatClosedWatchTimerId = setInterval(function () {
      if (view !== "chat" || chatConversation !== conv) {
        clearInterval(chatClosedWatchTimerId);
        chatClosedWatchTimerId = null;
        return;
      }
      chatLoadStatus(conv.id).then(function (data) {
        if (view !== "chat" || chatConversation !== conv) return;
        if (!data || data.status === "closed") chatMarkClosed();
      }).catch(function (err) {
        if (view !== "chat" || chatConversation !== conv) return;
        if (err && err.status === 404) chatMarkClosed();
      });
    }, CHAT_CLOSED_WATCH_MS);
  }

  function chatMarkClosed() {
    if (!chatConversation) return;
    chatConversation.status = "closed";
    stopChatTransport();
    chatTurnPending = false;
    if (view === "chat" && chatUi) {
      renderChatMessageList();
      renderChatFooter();
    }
  }

  // The latest 'proposal' event with no subsequent 'proposal_resolved'.
  // Resolved proposals collapse out of the flow; their outcome renders from
  // the 'proposal_resolved' event itself.
  function chatFindActiveProposal() {
    var active = null;
    for (var i = 0; i < chatMessages.length; i++) {
      var m = chatMessages[i];
      if (m.role !== "event" || !m.payload) continue;
      if (m.payload.kind === "proposal") active = m;
      else if (m.payload.kind === "proposal_resolved") active = null;
    }
    return active;
  }

  function renderChatUserRow(row) {
    var bubbleChildren = [];
    if (row.content) bubbleChildren.push(renderMarkdownText(row.content));
    var images = row.images || [];
    if (images.length > 0) {
      var imgRow = h("div", { className: "rw-chat-bubble-imgs" });
      images.forEach(function (img) {
        var url = img._dataUrl || null;
        var name = img.originalName || "image";
        if (url) {
          // Local data URL captured at send time (and carried forward by
          // chatReplaceLocalEcho). Authoritative rows use the serve endpoint
          // below to fetch a presigned URL when no local preview is available.
          var imgEl = h("img", { className: "rw-chat-bubble-img", src: url, alt: name });
          imgEl.addEventListener("click", function () { openImageLightbox(url, name); });
          imgRow.appendChild(imgEl);
        } else {
          // No local preview. Fetch the presigned URL from the serve endpoint
          // (authenticated), then update the img src. The conversation id comes
          // from the module-level chatConversation state.
          var convId = chatConversation && chatConversation.id;
          if (convId && img.id) {
            var imgEl = h("img", { className: "rw-chat-bubble-img", src: "", alt: name });
            imgEl.style.minWidth = "60px";
            imgEl.style.minHeight = "60px";
            imgEl.style.background = "rgba(255,255,255,0.07)";
            imgRow.appendChild(imgEl);
            (function (el, cId, iId, iName) {
              chatGetImageUrl(cId, iId).then(function (data) {
                if (data && data.url) {
                  el.src = data.url;
                  el.addEventListener("click", function () { openImageLightbox(data.url, iName); });
                }
              }).catch(function () {
                // Fetch failed — replace with filename chip as fallback
                if (el.parentNode) {
                  var chip = h("span", { className: "rw-chip-attach" }, [
                    Icons.image(11),
                    h("span", null, iName),
                  ]);
                  el.parentNode.replaceChild(chip, el);
                }
              });
            }(imgEl, convId, img.id, name));
          } else {
            // No conversation context (shouldn't happen in normal flow)
            imgRow.appendChild(h("span", { className: "rw-chip-attach" }, [
              Icons.image(11),
              h("span", null, name),
            ]));
          }
        }
      });
      bubbleChildren.push(imgRow);
    }
    return h("div", { className: "rw-chat-msg rw-chat-msg-user" },
      h("div", { className: "rw-chat-bubble rw-chat-bubble-user" }, bubbleChildren));
  }

  function renderChatAgentRow(row) {
    return h("div", { className: "rw-chat-msg rw-chat-msg-agent" }, [
      renderChatAgentAvatar(24),
      h("div", { className: "rw-chat-agent-col" }, [
        h("div", { className: "rw-chat-agent-name" }, chatIdentityName()),
        h("div", { className: "rw-chat-bubble rw-chat-bubble-agent" }, renderMarkdownText(row.content || "")),
      ]),
    ]);
  }

  // Workspace-member reply (role='team', payload {authorName}) — rendered
  // like an agent bubble but attributed to the human author with an
  // initials avatar. Delivered over the same SSE/polling transport; never
  // starts or settles a turn (see chatTurnStillPending).
  function renderChatTeamRow(row) {
    var name = (row.payload && row.payload.authorName) || t("chat.teamDefault");
    return h("div", { className: "rw-chat-msg rw-chat-msg-agent" }, [
      renderAvatar(name, 24),
      h("div", { className: "rw-chat-agent-col" }, [
        h("div", { className: "rw-chat-agent-name" }, name),
        h("div", { className: "rw-chat-bubble rw-chat-bubble-agent" }, renderMarkdownText(row.content || "")),
      ]),
    ]);
  }

  function renderChatTypingRow() {
    return h("div", { className: "rw-chat-msg rw-chat-msg-agent" }, [
      renderChatAgentAvatar(24),
      h("div", { className: "rw-chat-agent-col" }, [
        h("div", {
          className: "rw-chat-bubble rw-chat-bubble-agent rw-chat-typing",
          "aria-label": t("chat.typing", { name: chatAgentName() }),
        }, [
          h("span", { className: "rw-chat-typing-dot" }),
          h("span", { className: "rw-chat-typing-dot" }),
          h("span", { className: "rw-chat-typing-dot" }),
        ]),
      ]),
    ]);
  }

  // Event rows render inline in the flow keyed on payload.kind. Unknown
  // kinds are ignored for forward compatibility.
  function renderChatEventRow(row, activeProposal) {
    var payload = row.payload || {};
    var kind = payload.kind;
    if (kind === "proposal") {
      // Only the latest unresolved proposal is actionable; older / resolved
      // proposals collapse (their outcome renders from proposal_resolved).
      // Never actionable in a Live session: that surface is a staff-to-coder
      // relay that REUSES the reporter's intake conversation (which the staff
      // viewer doesn't own), so filing a ticket from it 404s. An unresolved
      // intake proposal belongs to the reporter's own chat thread.
      if (activeProposal && activeProposal.id === row.id
          && chatConversation && chatConversation.status === "active"
          && !chatIsLiveSession) {
        return renderChatProposalCard(row);
      }
      return null;
    }
    if (kind === "proposal_resolved") {
      if (payload.created) return renderChatTicketCreatedCard(payload);
      return h("div", { className: "rw-chat-event-line" }, t("chat.proposalDismissed"));
    }
    if (kind === "ticket_link") {
      return renderChatTicketLinkCard(payload);
    }
    if (kind === "assigned") {
      return renderChatAssignedLine(payload);
    }
    if (kind === "collect_prompt") {
      // Agentless intake's one scripted line ("anything more to add?"),
      // styled like a bot reply so the thread reads conversationally.
      // Hidden once an agent owns the thread — the agent's own clarifying
      // flow supersedes the static prompt.
      if (chatThreadHasAgent()) return null;
      return renderChatAgentRow({ content: t("chat.collectPrompt") });
    }
    if (kind === "system_notice") {
      return h("div", { className: "rw-chat-event-line" }, payload.text || t("chat.unavailable"));
    }
    if (kind === "force_proposal_requested") {
      return h("div", { className: "rw-chat-event-line" }, t("chat.forceRequested"));
    }
    if (kind === "activity") {
      // A ticket status change / milestone / PR event mirrored from the public
      // activity feed, rendered as an inline line in the thread's timeline.
      var aMeta = payload.metadata || {};
      // Status changes render as from→to chips — exactly like the public activity
      // page (renderEventNode). describeEvent's text form collapses to a vague
      // "changed status" whenever a label can't be resolved (e.g. a deployed:<env>
      // status), losing the transition; the chips keep it clear.
      if (payload.activityType === "status_change" && (aMeta.from || aMeta.to)) {
        var chips = [];
        if (aMeta.from) chips.push(renderStatusChip(aMeta.from));
        if (aMeta.from && aMeta.to) chips.push(h("span", { className: "rw-event-arrow" }, " → "));
        if (aMeta.to) chips.push(renderStatusChip(aMeta.to));
        return h("div", { className: "rw-chat-event-line rw-chat-event-chips" }, chips);
      }
      // Everything else (milestones, PR, assignment, …) keeps the feed's wording.
      var text = describeEvent({
        type: payload.activityType,
        content: payload.content,
        metadata: payload.metadata,
      });
      if (!text) return null;
      return h("div", { className: "rw-chat-event-line" }, renderInlineMarkdown(text));
    }
    return null;
  }

  // Navigate from chat into the existing ticket detail view (deflection:
  // vote/comment happen there). detailReturnView makes the detail's back
  // button return to the chat instead of the list.
  function openTicketFromChat(ticketId) {
    loadTicketDetail(ticketId).then(function (detail) {
      var ticket = detail && detail.ticket;
      if (!ticket) return;
      stopChatTransport();
      chatUi = null;
      detailReturnView = "chat";
      openDetailModal(ticket);
    }).catch(function () {
      // Navigation failed silently — the user stays in the chat.
    });
  }

  // ticketId -> conversationId, persisted so the ticket detail view can
  // offer the reporter the originating transcript across sessions. Reporter-
  // scoped by construction: the chat API only serves the conversation owner,
  // so a stale/foreign entry just fails the fetch and hides the section.
  function chatTicketMapKey() {
    return "runhq:widget:chatTickets:" + (config.projectId || config.project || "default");
  }
  function chatRememberTicketConversation(ticketId, conversationId) {
    try {
      var raw = localStorage.getItem(chatTicketMapKey());
      var map = raw ? JSON.parse(raw) : {};
      map[ticketId] = conversationId;
      localStorage.setItem(chatTicketMapKey(), JSON.stringify(map));
    } catch (_) {}
  }
  function chatConversationForTicket(ticketId) {
    try {
      var raw = localStorage.getItem(chatTicketMapKey());
      var map = raw ? JSON.parse(raw) : {};
      return map[ticketId] || null;
    } catch (_) {
      return null;
    }
  }

  // Editable draft card for the latest unresolved 'proposal' event. Create
  // posts the (possibly edited) title/description; dismiss collapses the
  // card and lets the conversation continue. Both resolutions push a local
  // 'proposal_resolved' echo for instant feedback; the BE's authoritative
  // event replaces it via chatReplaceLocalEcho.
  function renderChatProposalCard(row) {
    var payload = row.payload || {};

    var titleInput = h("input", { type: "text", className: "rw-clarif-input", maxlength: "200" });
    titleInput.value = payload.title || "";
    var descTa = h("textarea", { className: "rw-clarif-input rw-chat-proposal-desc", rows: "5", maxlength: "5000" });
    descTa.value = payload.description || "";

    var errorEl = h("span", { className: "rw-clarif-error", style: { display: "none" } });
    var createBtn = h("button", { className: "rw-clarif-send-btn", type: "button" }, t("chat.createTicket"));
    var dismissBtn = h("button", { className: "rw-chat-dismiss-link", type: "button" }, t("chat.dismiss"));

    // Visibility toggle: mirrors the composer's Public/Private pill (label +
    // icon flip rather than a single pill lighting up). The chosen state is
    // threaded into chatCreateTicket so the born-ready ticket is filed with
    // the right visibility — matching the standalone new-ticket composer.
    var isPrivate = false;
    var privateBtn = h("button", { className: "rw-pill-btn rw-priv-toggle", type: "button", "data-rw-private": "false" }, [
      Icons.globe(12),
      h("span", null, t("chat.proposalPublic")),
    ]);
    var privHint = h("span", { className: "rw-priv-hint" }, t("chat.proposalPrivateOff"));
    function refreshPrivateBtn() {
      clearChildren(privateBtn);
      privateBtn.appendChild(isPrivate ? Icons.lock(12) : Icons.globe(12));
      privateBtn.appendChild(h("span", null, isPrivate ? t("chat.proposalPrivate") : t("chat.proposalPublic")));
      privateBtn.setAttribute("data-rw-private", isPrivate ? "true" : "false");
      privHint.textContent = isPrivate ? t("chat.proposalPrivateOn") : t("chat.proposalPrivateOff");
    }
    privateBtn.addEventListener("click", function () {
      if (createBtn.disabled) return;
      isPrivate = !isPrivate;
      refreshPrivateBtn();
    });

    function resolveLocally(created, ticketId) {
      // SSE may have delivered the BE's authoritative proposal_resolved (and
      // even the wrap-up turn's rows) before this POST resolved — only echo
      // locally while the proposal is still unresolved, and recompute the
      // pending state from the flow (see chatTurnStillPending).
      if (chatFindActiveProposal()) {
        chatApplyMessages([{
          id: "local-resolved-" + Date.now(),
          role: "event",
          content: null,
          payload: created
            ? { kind: "proposal_resolved", created: true, ticketId: ticketId }
            : { kind: "proposal_resolved", created: false },
          createdAt: new Date().toISOString(),
        }]);
      }
      // The agent reacts to either resolution (assign + wrap-up on create,
      // a natural continuation on dismiss) — show the typing indicator
      // while that turn is genuinely outstanding.
      chatTurnPending = chatTurnStillPending();
      if (chatPollTimerId !== null) scheduleChatPoll();
      renderChatMessageList();
    }

    createBtn.addEventListener("click", function () {
      var title = titleInput.value.trim();
      var description = descTa.value.trim();
      if (!title || !description) {
        errorEl.style.display = "";
        errorEl.textContent = t("chat.proposalIncomplete");
        return;
      }
      errorEl.style.display = "none";
      createBtn.disabled = true;
      dismissBtn.disabled = true;
      createBtn.textContent = t("chat.creating");
      chatCreateTicket(chatConversation.id, title, description, isPrivate).then(function (data) {
        var ticketId = (data && (data.ticketId || (data.ticket && data.ticket.id))) || null;
        if (ticketId) {
          chatRememberTicketConversation(ticketId, chatConversation.id);
          chatConversation.createdTaskId = ticketId;
        }
        startChatClosedWatch();
        resolveLocally(true, ticketId);
      }).catch(function (err) {
        createBtn.disabled = false;
        dismissBtn.disabled = false;
        createBtn.textContent = t("chat.createTicket");
        errorEl.style.display = "";
        errorEl.textContent = t("chat.createFailed", { msg: (err && err.message) || "" });
      });
    });

    dismissBtn.addEventListener("click", function () {
      createBtn.disabled = true;
      dismissBtn.disabled = true;
      chatDismissProposal(chatConversation.id).then(function () {
        resolveLocally(false, null);
      }).catch(function (err) {
        createBtn.disabled = false;
        dismissBtn.disabled = false;
        errorEl.style.display = "";
        errorEl.textContent = t("chat.dismissFailed", { msg: (err && err.message) || "" });
      });
    });

    return h("div", { className: "rw-chat-proposal-card" }, [
      h("p", { className: "rw-clarif-title" }, t("chat.proposalTitle")),
      h("label", { className: "rw-chat-proposal-label" }, t("chat.proposalTitleLabel")),
      titleInput,
      h("label", { className: "rw-chat-proposal-label" }, t("chat.proposalDescLabel")),
      descTa,
      h("div", { className: "rw-chat-proposal-visibility" }, [privateBtn, privHint]),
      h("div", { className: "rw-clarif-actions" }, [createBtn, dismissBtn, errorEl]),
    ]);
  }

  // Confirmation card rendered from 'proposal_resolved' {created:true}.
  // Links into the existing ticket detail view.
  function renderChatTicketCreatedCard(payload) {
    var ticketId = payload.ticketId || null;
    var shortRef = ticketId ? "#" + String(ticketId).slice(0, 8).toUpperCase() : "";
    var viewBtn = null;
    if (ticketId) {
      viewBtn = h("button", { className: "rw-chat-ticket-open", type: "button" }, t("chat.viewTicket"));
      viewBtn.addEventListener("click", function () { openTicketFromChat(ticketId); });
    }

    // Assignment is fully automatic and server-side now — no manual button.

    var cardChildren = [
      h("div", { className: "rw-chat-ticket-card-main" }, [
        h("span", { className: "rw-chat-ticket-label" }, t("chat.ticketCreated")),
        shortRef ? h("span", { className: "rw-chat-ticket-ref" }, shortRef) : null,
      ]),
    ];
    if (viewBtn) {
      cardChildren.push(h("div", { className: "rw-chat-ticket-actions" }, [viewBtn]));
    }

    return h("div", { className: "rw-chat-ticket-card rw-chat-ticket-created" }, cardChildren);
  }

  // Whether the current chat thread already shows an 'assigned' event — used to
  // hide the inline assign affordance once the ticket has an agent (e.g. the
  // chat agent auto-assigned, or a triager just assigned it).
  // Inline status line for the 'assigned' event — renders in the flow
  // directly after the ticket-created card the agent's assignment follows.
  function renderChatAssignedLine(payload) {
    return h("div", { className: "rw-chat-assigned-line" },
      "🤖 " + t("chat.assignedTo", { name: payload.agentName || "an agent" }));
  }

  // Whether a created-ticket resolution is already in the thread (local
  // echo or the BE's authoritative row) — hides [Submit Ticket] in the
  // window between the resolution event arriving and the conversation's
  // closed status being observed.
  function chatHasCreatedResolution() {
    for (var i = 0; i < chatMessages.length; i++) {
      var m = chatMessages[i];
      if (m.role === "event" && m.payload
          && m.payload.kind === "proposal_resolved" && m.payload.created) return true;
    }
    return false;
  }

  // Persistent [Submit Ticket] action for the agentless intake: files the
  // accumulated user messages as a ticket (BE derives title/description).
  // Styled from the proposal-card primary button family.
  function renderChatSubmitTicketAction() {
    var btn = h("button", {
      className: "rw-clarif-send-btn rw-chat-submit-btn", type: "button",
    }, chatSubmitInFlight ? t("chat.creating") : t("chat.submitTicket"));
    if (chatSubmitInFlight) btn.disabled = true;

    // Local notice bubble for graceful 409 handling — rides the existing
    // system_notice event-line rendering (local-only row; a reload shows
    // the authoritative state instead).
    function noticeLocally(text) {
      chatApplyMessages([{
        id: "local-notice-" + Date.now(),
        role: "event",
        content: null,
        payload: { kind: "system_notice", text: text },
        createdAt: new Date().toISOString(),
      }]);
      renderChatMessageList();
    }

    btn.addEventListener("click", function () {
      if (chatSubmitInFlight || !chatConversation) return;
      var conv = chatConversation;
      chatSubmitInFlight = true;
      btn.disabled = true;
      btn.textContent = t("chat.creating");
      chatSubmitTicket(conv.id).then(function (data) {
        chatSubmitInFlight = false;
        if (view !== "chat" || chatConversation !== conv) return;
        var ticketId = (data && data.ticketId) || null;
        if (ticketId) {
          chatRememberTicketConversation(ticketId, conv.id);
          conv.createdTaskId = ticketId;
        }
        // The BE appended the authoritative proposal_resolved and closed
        // the conversation before responding. SSE may have delivered the
        // event already — only echo locally when it hasn't.
        if (!chatHasCreatedResolution()) {
          chatApplyMessages([{
            id: "local-resolved-" + Date.now(),
            role: "event",
            content: null,
            payload: { kind: "proposal_resolved", created: true, ticketId: ticketId },
            createdAt: new Date().toISOString(),
          }]);
        }
        // A 200 is the close confirmation (submit-ticket closes server-
        // side synchronously) — flip straight to the closed footer with
        // its "Start new conversation" affordance.
        chatMarkClosed();
      }).catch(function (err) {
        chatSubmitInFlight = false;
        if (view !== "chat" || chatConversation !== conv) return;
        var code = (err && err.message) || "";
        if (code === "agent_turns_present") {
          // An agent joined the thread between renders — surrender the
          // affordance to the agent flow (proposal cards take over).
          conv.hasAgentTurns = true;
          noticeLocally(t("chat.submitAgentActive"));
        } else if (code === "conversation_closed") {
          chatMarkClosed();
        } else if (code === "ticket_already_created") {
          noticeLocally(t("chat.alreadyTicketed"));
        } else if (code === "no_user_messages") {
          noticeLocally(t("chat.submitEmpty"));
        } else if (err && err.status === 429) {
          noticeLocally(t("chat.rateLimited"));
        } else {
          noticeLocally(t("chat.submitFailed", { msg: code }));
        }
      });
    });
    return btn;
  }

  // Footer action slot, re-evaluated on every list render (it lives apart
  // from the input row so an in-progress draft is never rebuilt). Two
  // personalities:
  //   - agentless intake → persistent [Submit Ticket] once the user has
  //     said anything (open + ticketless + no agent involvement);
  //   - agent thread → the escape hatch (anti "AI jail"): after >=4 user
  //     messages with no proposal event, a quiet link that forces the
  //     agent's next turn to propose a ticket from what it has.
  function updateChatActionSlot() {
    if (!chatUi || !chatUi.hatchSlot) return;
    var slot = chatUi.hatchSlot;
    clearChildren(slot);
    // Live session: no submit-ticket or escape-hatch actions (this is a
    // staff-to-job channel, not a user intake conversation).
    if (chatIsLiveSession) return;
    if (!chatConversation || chatConversation.status !== "active") return;

    if (!chatThreadHasAgent()) {
      if (chatConversation.createdTaskId || chatHasCreatedResolution()) return;
      var hasUserMessage = false;
      for (var u = 0; u < chatMessages.length; u++) {
        if (chatMessages[u].role === "user") { hasUserMessage = true; break; }
      }
      if (!hasUserMessage) return;
      slot.appendChild(renderChatSubmitTicketAction());
      return;
    }

    var userTurns = 0;
    var hasProposal = false;
    var forceRequested = false;
    for (var i = 0; i < chatMessages.length; i++) {
      var m = chatMessages[i];
      if (m.role === "user") userTurns++;
      else if (m.role === "event" && m.payload) {
        if (m.payload.kind === "proposal") hasProposal = true;
        if (m.payload.kind === "force_proposal_requested") forceRequested = true;
      }
    }
    if (userTurns < CHAT_ESCAPE_HATCH_MIN_TURNS || hasProposal || forceRequested) return;

    var hatchLink = h("button", { className: "rw-chat-escape-link", type: "button" }, t("chat.escapeHatch"));
    hatchLink.addEventListener("click", function () {
      hatchLink.disabled = true;
      chatForceProposal(chatConversation.id).then(function () {
        chatApplyMessages([{
          id: "local-force-" + Date.now(),
          role: "event",
          content: null,
          payload: { kind: "force_proposal_requested" },
          createdAt: new Date().toISOString(),
        }]);
        chatTurnPending = chatTurnStillPending();
        if (chatPollTimerId !== null) scheduleChatPoll();
        renderChatMessageList();
      }).catch(function () {
        hatchLink.disabled = false;
      });
    });
    slot.appendChild(hatchLink);
  }

  // Collapsed transcript section for the ticket detail view. Lazily fetches
  // the full conversation history (no `after` cursor = from the beginning)
  // on first expand. A 403/404 (not the owner / conversation gone) removes
  // the section quietly — it only ever renders for the reporter.
  function renderChatTranscriptSection(conversationId) {
    var bodyEl = h("div", { className: "rw-chat-transcript-body", style: { display: "none" } });
    var loaded = false;
    var expanded = false;
    var toggleLabel = h("span", null, t("chat.transcriptShow"));
    var toggleBtn = h("button", { className: "rw-chat-transcript-toggle", type: "button" }, [
      h("span", { className: "rw-chat-transcript-title" }, t("chat.transcriptTitle")),
      toggleLabel,
    ]);
    var section = h("div", { className: "rw-chat-transcript" }, [toggleBtn, bodyEl]);

    toggleBtn.addEventListener("click", function () {
      expanded = !expanded;
      bodyEl.style.display = expanded ? "" : "none";
      toggleLabel.textContent = expanded ? t("chat.transcriptHide") : t("chat.transcriptShow");
      if (!expanded || loaded) return;
      loaded = true;
      bodyEl.appendChild(renderLoading());
      chatLoadMessages(conversationId, null).then(function (data) {
        clearChildren(bodyEl);
        var rows = (data && data.messages) || [];
        var lines = 0;
        rows.forEach(function (row) {
          // The transcript is about what was said — event rows are omitted.
          if (row.role !== "user" && row.role !== "agent") return;
          lines++;
          bodyEl.appendChild(h("div", { className: "rw-chat-transcript-line" }, [
            h("span", { className: "rw-chat-transcript-who" },
              row.role === "user" ? t("chat.transcriptYou") : chatAgentName()),
            renderMarkdownText(row.content || "", "rw-chat-transcript-text"),
          ]));
        });
        if (lines === 0) {
          bodyEl.appendChild(h("div", { className: "rw-chat-event-line" }, t("chat.transcriptEmpty")));
        }
      }).catch(function () {
        if (section.parentNode) section.parentNode.removeChild(section);
      });
    });

    return section;
  }

  // Compact reference card for an existing ticket the agent surfaced
  // (search_tickets deflection). Whole card is the click target.
  function renderChatTicketLinkCard(payload) {
    var card = h("button", { className: "rw-chat-ticket-card rw-chat-ticket-link", type: "button" }, [
      h("div", { className: "rw-chat-ticket-card-main" }, [
        h("span", { className: "rw-chat-ticket-title" }, payload.title || "Ticket"),
        payload.status ? renderStatusChip(payload.status) : null,
      ]),
    ]);
    card.addEventListener("click", function () {
      if (payload.ticketId) openTicketFromChat(payload.ticketId);
    });
    return card;
  }

  // Full rebuild of the message list from chatMessages. Cheap at the ≤50-
  // message history scale this view operates at; guarded by chatUi so a
  // stale async callback after navigation is a no-op.
  // Opening acknowledgement for a Live session that has no messages yet. This
  // is NOT a fabricated chat message — it is a UI affordance (styled like the
  // intake empty state) that names the ticket and sets expectations: the
  // assigned agent is already working in the background and progress/updates
  // will appear here. Without it a freshly-opened Live session reads as a blank
  // screen with nothing going on, even though a coder job is running.
  function renderLiveSessionIntro() {
    var children = [];
    // Signature element: a live "working" pill whose pulsing dot signals that
    // work is actively happening in the background — the direct answer to the
    // blank-screen "is anything going on?" feeling. The dot is decorative
    // (aria-hidden); the text carries the meaning.
    children.push(h("div", { className: "rw-intro-status" }, [
      h("span", { className: "rw-intro-pulse", "aria-hidden": "true" }),
      h("span", null, t("chat.liveSessionStatus", { name: chatIdentityName() })),
    ]));
    // The ticket the session is about, clamped to two lines with an ellipsis
    // (full text on hover via title=) so a long subject can't blow out the
    // layout. Reads as "working on → this".
    var title = liveSessionTicket && liveSessionTicket.title;
    if (title) {
      children.push(h("div", { className: "rw-chat-intro-title", title: title }, title));
    }
    children.push(h("div", { className: "rw-intro-body" }, t("chat.liveSessionIntro")));
    return h("div", { className: "rw-chat-empty rw-chat-intro" }, children);
  }

  function renderChatMessageList() {
    if (!chatUi) return;
    var listEl = chatUi.listEl;
    clearChildren(listEl);

    if (chatIsLiveSession) {
      // Live session against a running coder job: replace the generic intake
      // empty state with an acknowledgement of the ticket + reassurance that
      // work is happening in the background. The footer input stays live, so
      // the user can ask a question or steer the work at any time.
      if (chatMessages.length === 0) {
        listEl.appendChild(renderLiveSessionIntro());
      }
      // Reading the live session advances the DEDICATED live-session-seen mark
      // up to the newest message shown, so the launcher/bell/dot clear and
      // re-light only on the next coder/teammate reply. This is separate from
      // ticketSeen (the detail view), so merely viewing the ticket detail never
      // clears an unread live-session reply.
      var liveTaskId = chatConversation && chatConversation.createdTaskId;
      if (liveTaskId && chatMessages.length > 0) {
        var seenMs = 0;
        for (var si = 0; si < chatMessages.length; si++) {
          seenMs = Math.max(seenMs, new Date(chatMessages[si].createdAt || 0).getTime() || 0);
        }
        if (seenMs > 0) { markLiveSessionSeen(liveTaskId, seenMs); refreshTabLabel(); }
      }
    } else {
      // Agentless threads open with a scripted offline notice that doubles as
      // submission guidance ("provide as much detail as possible, then Submit
      // Ticket"). Rendered as a bot bubble pinned to the top of the thread —
      // including before the first message — so the user always knows who is
      // (not) on the other end. Threads an agent has joined skip it; the
      // agent speaks for itself.
      if (!chatAgentMode() && !chatThreadHasAgent()) {
        listEl.appendChild(renderChatAgentRow({ content: t("chat.agentlessIntro") }));
      }

      if (chatMessages.length === 0 && chatAgentMode()) {
        listEl.appendChild(h("div", { className: "rw-chat-empty" },
          t("chat.empty", { name: chatAgentName() })));
      }
    }

    var activeProposal = chatFindActiveProposal();
    for (var i = 0; i < chatMessages.length; i++) {
      var row = chatMessages[i];
      var node = null;
      if (row.role === "user") node = renderChatUserRow(row);
      else if (row.role === "agent") node = renderChatAgentRow(row);
      else if (row.role === "team") node = renderChatTeamRow(row);
      else if (row.role === "event") node = renderChatEventRow(row, activeProposal);
      if (node) listEl.appendChild(node);
    }

    if (chatTurnPending && chatConversation && chatConversation.status === "active") {
      listEl.appendChild(renderChatTypingRow());
    }

    updateChatActionSlot();
    listEl.scrollTop = listEl.scrollHeight;
  }

  // Whether the current intake conversation has anything worth confirming
  // before discarding — at least one thing the user said or the agent replied.
  function chatHasDiscardableContent() {
    for (var i = 0; i < chatMessages.length; i++) {
      var role = chatMessages[i].role;
      if (role === "user" || role === "agent" || role === "team") return true;
    }
    return false;
  }

  // Show the below-header "New conversation" strip only for an active intake
  // conversation (never in a Live session; hidden once closed, where the footer
  // already offers "Start new conversation").
  function updateChatActionBar() {
    if (!chatUi || !chatUi.actionBar) return;
    var show = !chatIsLiveSession && chatConversation && chatConversation.status === "active";
    chatUi.actionBar.style.display = show ? "" : "none";
  }

  // Clear the current intake conversation and open a fresh one. A non-empty
  // conversation prompts for confirmation first (a half-typed chat is easy to
  // discard by accident); an empty one starts fresh silently.
  function requestFreshConversation() {
    if (chatFreshInFlight) return;
    if (chatHasDiscardableContent()) {
      confirmClearConversation(beginFreshConversation);
    } else {
      beginFreshConversation();
    }
  }

  // Abandon the active conversation server-side and swap in the new one. The
  // current transcript stays visible until the fresh conversation loads, so a
  // failed request leaves the user exactly where they were. chatFreshInFlight
  // guards against a double-trigger while the request is outstanding.
  function beginFreshConversation() {
    if (chatFreshInFlight) return;
    chatFreshInFlight = true;
    stopChatTransport();
    chatStartFreshConversation().then(function (data) {
      chatFreshInFlight = false;
      if (view !== "chat" || !chatUi) return;
      chatConversation = (data && data.conversation) || null;
      chatMessages = ((data && data.messages) || []).slice();
      chatTurnPending = false;
      chatSubmitInFlight = false;
      pendingChatImages = [];
      renderChatMessageList();
      renderChatFooter();
      startChatTransport();
    }).catch(function (err) {
      chatFreshInFlight = false;
      if (view !== "chat" || !chatUi) return;
      // Restore real-time delivery for the conversation we left intact, then
      // surface the failure inline.
      if (chatConversation && chatConversation.status === "active") startChatTransport();
      renderChatMessageList();
      renderChatFooter();
      chatSystemNotice(t("chat.clearFailed", { msg: (err && err.message) || "" }));
    });
  }

  // Push an inline system-notice event into the thread (same shape the
  // agentless [Submit Ticket] flow uses for its local errors).
  function chatSystemNotice(text) {
    chatApplyMessages([{
      id: "local-notice-" + Date.now(),
      role: "event",
      content: null,
      payload: { kind: "system_notice", text: text },
      createdAt: new Date().toISOString(),
    }]);
    renderChatMessageList();
  }

  // Small themed confirmation dialog for discarding the conversation. Uses the
  // shared modal infra (scrim + Escape/outside-click to cancel).
  function confirmClearConversation(onConfirm) {
    var cancelBtn = h("button", { className: "rw-confirm-btn rw-confirm-cancel", type: "button" }, t("chat.clearCancel"));
    var confirmBtn = h("button", { className: "rw-confirm-btn rw-confirm-go", type: "button" }, t("chat.clearConfirm"));
    cancelBtn.addEventListener("click", function () { closeActiveModal(); });
    confirmBtn.addEventListener("click", function () { closeActiveModal(); onConfirm(); });
    var modal = h("div", { className: "rw-confirm-modal" }, [
      h("h3", { className: "rw-confirm-title" }, t("chat.clearConfirmTitle")),
      h("p", { className: "rw-confirm-body" }, t("chat.clearConfirmBody")),
      h("div", { className: "rw-confirm-actions" }, [cancelBtn, confirmBtn]),
    ]);
    mountModal(modal);
    confirmBtn.focus();
  }

  // Footer: closed bar OR (hatch slot + notice slot + input row). Rebuilt
  // only on conversation lifecycle changes — NOT per message — so an
  // in-progress draft in the textarea survives incoming messages.
  function renderChatFooter() {
    if (!chatUi) return;
    // Keep the below-header new-conversation strip in sync with the
    // conversation lifecycle (footer rebuilds on every lifecycle change).
    updateChatActionBar();
    var footerEl = chatUi.footerEl;
    clearChildren(footerEl);
    if (!chatConversation) return;

    if (chatConversation.status === "closed") {
      var newBtn = h("button", { className: "rw-chat-newconv-btn", type: "button" }, t("chat.startNew"));
      newBtn.addEventListener("click", function () {
        newBtn.disabled = true;
        chatOpenConversation().then(function (data) {
          if (view !== "chat" || !chatUi) return;
          chatConversation = (data && data.conversation) || null;
          chatMessages = ((data && data.messages) || []).slice();
          chatTurnPending = false;
          chatSubmitInFlight = false;
          renderChatMessageList();
          renderChatFooter();
          startChatTransport();
        }).catch(function () {
          newBtn.disabled = false;
        });
      });
      footerEl.appendChild(h("div", { className: "rw-chat-closed-bar" }, [
        h("span", { className: "rw-chat-closed-text" }, t("chat.closed")),
        newBtn,
      ]));
      return;
    }

    // Action slot — populated by updateChatActionSlot (collapses via CSS
    // :empty when unpopulated): [Submit Ticket] in agentless intake, the
    // escape hatch in agent threads.
    var hatchSlot = h("div", { className: "rw-chat-hatch-slot" });
    chatUi.hatchSlot = hatchSlot;
    footerEl.appendChild(hatchSlot);

    var noticeSlot = h("div", { className: "rw-chat-notice-slot" });

    // Image attach affordance: gated on the attach_image permission; disabled
    // in live sessions (staff → coder) because that path doesn't support images.
    var canAttachImages = !chatIsLiveSession
      && currentUser.permissions
      && currentUser.permissions.indexOf("attach_image") !== -1;

    // Thumbnail strip rendered above the input row while images are pending.
    var pendingChipsRow = canAttachImages ? h("div", { className: "rw-chat-img-chips" }) : null;

    function renderPendingChips() {
      if (!pendingChipsRow) return;
      clearChildren(pendingChipsRow);
      pendingChipsRow.style.display = pendingChatImages.length > 0 ? "flex" : "none";
      pendingChatImages.forEach(function (entry, idx) {
        var chip = h("div", {
          className: "rw-chat-img-chip" + (entry.uploading ? " rw-uploading" : "") + (entry.failed ? " rw-failed" : ""),
        });
        var img = h("img", { src: entry.dataUrl, alt: entry.name || "image" });
        chip.appendChild(img);
        var xBtn = h("button", {
          className: "rw-chat-img-chip-x", type: "button", "aria-label": t("aria.removeAttach"),
        }, "×");
        xBtn.addEventListener("click", function () {
          pendingChatImages.splice(idx, 1);
          renderPendingChips();
          updateSendState();
        });
        chip.appendChild(xBtn);
        pendingChipsRow.appendChild(chip);
      });
    }

    var ta = h("textarea", {
      className: "rw-chat-input",
      placeholder: t("chat.inputPlaceholder"),
      maxlength: String(CHAT_INPUT_MAX),
      rows: "1",
      "aria-label": t("chat.inputPlaceholder"),
    });
    var sendBtn = h("button", {
      className: "rw-chat-send-btn", type: "button", "aria-label": t("chat.send"),
    }, Icons.send(14));

    var attachBtn = canAttachImages ? h("button", {
      className: "rw-chat-attach-btn", type: "button", "aria-label": t("composer.attach"),
      title: t("composer.attach"),
    }, Icons.image(14)) : null;

    var fileInput = canAttachImages ? h("input", {
      type: "file", accept: "image/*", style: { display: "none" },
    }) : null;

    // Whether any upload is still in flight — blocks send until settled.
    function anyUploading() {
      for (var k = 0; k < pendingChatImages.length; k++) {
        if (pendingChatImages[k].uploading) return true;
      }
      return false;
    }

    function updateSendState() {
      if (!canAttachImages) return;
      var busy = anyUploading();
      sendBtn.disabled = busy;
      attachBtn.disabled = busy || pendingChatImages.length >= CHAT_IMAGE_MAX;
    }

    function queueImageFile(file) {
      if (!file || !file.type || file.type.indexOf("image/") !== 0) return;
      if (pendingChatImages.length >= CHAT_IMAGE_MAX) return;
      var convId = chatConversation && chatConversation.id;
      if (!convId) return;
      // Read as data URL for immediate preview, then upload.
      var reader = new FileReader();
      var entry = { id: null, dataUrl: "", name: file.name || "image", mimeType: file.type, uploading: true, failed: false };
      pendingChatImages.push(entry);
      renderPendingChips();
      updateSendState();
      reader.onload = function () {
        entry.dataUrl = String(reader.result || "");
        renderPendingChips();
      };
      reader.readAsDataURL(file);
      chatUploadImage(convId, file).then(function (data) {
        var img = data && data.image;
        if (!img) throw new Error("upload_empty_response");
        entry.id = img.id;
        entry.mimeType = img.mimeType || entry.mimeType;
        entry.uploading = false;
        renderPendingChips();
        updateSendState();
      }).catch(function () {
        entry.uploading = false;
        entry.failed = true;
        renderPendingChips();
        updateSendState();
        showChatNotice(t("chat.uploadFailed"));
      });
    }

    if (canAttachImages) {
      attachBtn.addEventListener("click", function () { fileInput.click(); });
      fileInput.addEventListener("change", function () {
        Array.prototype.forEach.call(fileInput.files, queueImageFile);
        fileInput.value = "";
      });
      ta.addEventListener("paste", function (e) {
        var items = e.clipboardData && e.clipboardData.items;
        if (!items) return;
        var found = false;
        for (var k = 0; k < items.length; k++) {
          if (items[k].type && items[k].type.indexOf("image/") === 0) {
            var pf = items[k].getAsFile();
            if (pf) { found = true; queueImageFile(pf); }
          }
        }
        if (found) e.preventDefault();
      });
    }

    function showChatNotice(msg) {
      clearChildren(noticeSlot);
      noticeSlot.appendChild(h("div", { className: "rw-chat-inline-notice" }, msg));
    }

    function doSend() {
      if (!chatConversation || chatConversation.status !== "active") return;
      var content = ta.value.trim();
      // Collect successfully-uploaded image ids (skip failed).
      var imageIds = canAttachImages
        ? pendingChatImages.filter(function (p) { return p.id && !p.failed; }).map(function (p) { return p.id; })
        : [];
      // Require either text or at least one image; block while upload in flight.
      if ((!content && imageIds.length === 0) || sendBtn.disabled) return;
      if (anyUploading()) return;
      if (content.length > CHAT_INPUT_MAX) content = content.slice(0, CHAT_INPUT_MAX);
      sendBtn.disabled = true;
      ta.disabled = true;
      if (canAttachImages) attachBtn.disabled = true;
      clearChildren(noticeSlot);
      // Capture local previews so the optimistic echo can show images before
      // the authoritative row (which has no fetch URL) arrives from the server.
      // Only include successfully-uploaded images (mirrors the imageIds filter).
      var localImagePreviews = pendingChatImages
        .filter(function (p) { return p.id && !p.failed; })
        .map(function (p) { return { id: p.id, mimeType: p.mimeType, originalName: p.name, _dataUrl: p.dataUrl }; });
      // Live session: route through the staff-only live-message endpoint.
      // Regular chat: route through the user-message endpoint.
      var sendFn = chatIsLiveSession ? liveCoderSend : chatSendMessage;
      sendFn(chatConversation.id, content, imageIds.length ? imageIds : undefined).then(function (data) {
        ta.value = "";
        // Clear pending images and chips on success.
        pendingChatImages = [];
        renderPendingChips();
        // Use the server's row when returned; otherwise an optimistic echo
        // that chatReplaceLocalEcho swaps for the authoritative row later.
        var row = (data && data.message) || {
          id: "local-" + Date.now(),
          role: "user",
          content: content,
          payload: null,
          createdAt: new Date().toISOString(),
        };
        // Attach local previews to the echo so the bubble renders images.
        if (localImagePreviews.length > 0) {
          if (row.images && row.images.length > 0) {
            // Server returned an authoritative row with image ids — enrich with dataUrl.
            for (var j = 0; j < Math.min(localImagePreviews.length, row.images.length); j++) {
              if (!row.images[j]._dataUrl) row.images[j]._dataUrl = localImagePreviews[j]._dataUrl;
            }
          } else {
            // Optimistic echo (no images field from server yet): set directly.
            row.images = localImagePreviews;
          }
        }
        // Merge through chatApplyMessages — SSE may have already delivered
        // this row (and even the turn's reply) before the POST resolved, so
        // a raw push would duplicate it. Pending state is recomputed from
        // the flow for the same reason.
        chatApplyMessages([row]);
        chatTurnPending = chatTurnStillPending();
        if (chatPollTimerId !== null) scheduleChatPoll();
        renderChatMessageList();
      }).catch(function (err) {
        var code = err && err.status;
        if (code === 429) showChatNotice(t("chat.rateLimited"));
        else if (code === 409) showChatNotice(t("chat.turnCap"));
        else showChatNotice(t("chat.sendFailed", { msg: (err && err.message) || "" }));
      }).then(function () {
        sendBtn.disabled = false;
        ta.disabled = false;
        if (canAttachImages) attachBtn.disabled = false;
        ta.focus();
        updateSendState();
      });
    }

    sendBtn.addEventListener("click", doSend);
    ta.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        doSend();
      }
    });

    footerEl.appendChild(noticeSlot);
    if (canAttachImages && pendingChipsRow) footerEl.appendChild(pendingChipsRow);
    footerEl.appendChild(h("div", { className: "rw-chat-input-row" }, [
      canAttachImages ? attachBtn : null,
      ta,
      sendBtn,
    ]));
    if (canAttachImages) footerEl.appendChild(fileInput);
    chatUi.inputEl = ta;
    // Render chips from any images still pending (e.g. footer rebuilt while
    // uploads were in flight).
    if (canAttachImages) { renderPendingChips(); updateSendState(); }
    // The slot was just (re)created empty — populate it now so a resumed
    // agentless conversation shows [Submit Ticket] immediately instead of
    // waiting for the next message-driven list render.
    updateChatActionSlot();
  }

  // Build the chat view shell and bootstrap the conversation (POST resumes
  // the active conversation or creates one — this is the "resume on reopen"
  // behavior). Called from renderPanelBody when view === "chat".
  function renderChatViewShell() {
    // Discard any images queued in the previous session.
    pendingChatImages = [];
    var root = h("div", { className: "rw-chat-full" });

    // Live session: back returns to the ticket detail. Regular chat: back goes home.
    var isLive = chatIsLiveSession;
    var savedLiveTicket = liveSessionTicket;
    var backBtn = h("button", { className: "rw-back-btn", type: "button" }, [
      Icons.arrowLeft(13),
      h("span", null, isLive ? t("detail.back") : t("chat.back")),
    ]);
    backBtn.addEventListener("click", function () {
      stopChatTransport();
      chatUi = null;
      if (isLive) {
        // Return to the ticket detail that spawned this live session.
        chatIsLiveSession = false;
        liveSessionTicket = null;
        detailReturnView = null;
        if (savedLiveTicket) {
          view = "detail";
          currentDetailTicket = savedLiveTicket;
          renderPanelBody();
        } else {
          goList();
        }
      } else {
        // Normal chat is reached from the discussion board's [+ New post], so
        // back returns to that board (the widget's landing view).
        goList();
      }
    });

    var topbarLabel = isLive ? "Live session" : (
      chatAgentMode() ? t("chat.title", { name: chatAgentName() }) : chatIdentityName()
    );

    root.appendChild(h("div", { className: "rw-chat-topbar" }, [
      backBtn,
      h("div", { className: "rw-chat-topbar-identity" }, [
        renderChatAgentAvatar(22),
        h("span", { className: "rw-chat-topbar-name" }, topbarLabel),
      ]),
    ]));

    // New-conversation control — its own right-aligned strip directly below the
    // header (intake chats only; a Live session is a staff↔job channel, never
    // discardable). Kept out of both the global icon cluster and the composer.
    // Visibility is synced to the conversation lifecycle by updateChatActionBar.
    var actionBar = null;
    if (!isLive) {
      var newConvBtn = h("button", {
        className: "rw-chat-newconv-pill", type: "button",
        "aria-label": t("chat.clearAria"), title: t("chat.clearTitle"),
      }, [Icons.compose(13), h("span", null, t("chat.clearTitle"))]);
      newConvBtn.addEventListener("click", function () {
        if (newConvBtn.disabled) return;
        requestFreshConversation();
      });
      actionBar = h("div", { className: "rw-chat-actionbar", style: { display: "none" } }, [newConvBtn]);
      root.appendChild(actionBar);
    }

    var listEl = h("div", { className: "rw-chat-scroll" });
    var footerEl = h("div", { className: "rw-chat-footer" });
    root.appendChild(listEl);
    root.appendChild(footerEl);
    chatUi = { listEl: listEl, footerEl: footerEl, hatchSlot: null, inputEl: null, actionBar: actionBar };

    listEl.appendChild(renderLoading());

    if (isLive && chatConversation) {
      // Live session: conversation is pre-seeded by openLiveSession(). Skip
      // chatOpenConversation() and go straight to message-loading + transport.
      var liveConvAtOpen = chatConversation;
      chatLoadMessages(liveConvAtOpen.id, null).then(function (data) {
        if (view !== "chat" || !chatUi || chatConversation !== liveConvAtOpen) return;
        chatMessages = ((data && data.messages) || []).slice();
        chatTurnPending = false;
        chatSubmitInFlight = false;
        renderChatMessageList();
        renderChatFooter();
        startChatTransport();
      }).catch(function (err) {
        if (view !== "chat" || !chatUi) return;
        clearChildren(listEl);
        listEl.appendChild(h("div", { style: { padding: "16px" } },
          renderNotice("error", t("chat.loadFailed", { msg: (err && err.message) || "" }))));
      });
    } else {
      chatOpenConversation().then(function (data) {
        if (view !== "chat" || !chatUi) return;
        chatConversation = (data && data.conversation) || null;
        chatMessages = ((data && data.messages) || []).slice();
        // The conversation DTO carries pendingTurnId — resuming mid-turn
        // restores the typing indicator (and the fast poll cadence) instead
        // of silently dropping the in-flight turn.
        chatTurnPending = !!(chatConversation
          && chatConversation.status === "active"
          && chatConversation.pendingTurnId
          && !chatIsLiveSession);
        chatSubmitInFlight = false;
        renderChatMessageList();
        renderChatFooter();
        if (chatConversation && chatConversation.status === "active") {
          startChatTransport();
          if (chatConversation.createdTaskId) startChatClosedWatch();
        }
      }).catch(function (err) {
        if (view !== "chat" || !chatUi) return;
        clearChildren(listEl);
        if (err && err.status === 403) {
          // Anonymous / unidentified caller — mirror the composer's gate: a
          // public widget with a login URL redirects (preserving a "chat"
          // intent); anything else shows the sign-in notice.
          if (canAnonInteract()) {
            gateWriteAction({ type: "chat" });
            return;
          }
          listEl.appendChild(h("div", { style: { padding: "16px" } },
            renderNotice("error", config.authErrorMessage || t("chat.signInPrompt"))));
          return;
        }
        listEl.appendChild(h("div", { style: { padding: "16px" } },
          renderNotice("error", t("chat.loadFailed", { msg: (err && err.message) || "" }))));
      });
    }

    return root;
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

  // ===========================================================================
  // Detail polling helpers
  // ===========================================================================

  // URL for the ticket-status SSE stream. Mirrors chatEventsUrl: app-token
  // embeds pass the JWT as ?token= (the BE route shims it into Authorization);
  // cookie embeds pass ?project= but the BE does not read it for SSE auth yet,
  // so they degrade to polling by design (the stream errors once, never retries).
  function ticketEventsUrl(ticketId) {
    var url = RUNHQ_API + "/api/widget/tickets/" + encodeURIComponent(ticketId) + "/events";
    var params = [];
    if (config.identitySource !== "runhq" && config.token) {
      params.push("token=" + encodeURIComponent(config.token));
    }
    if (config.project) params.push("project=" + encodeURIComponent(config.project));
    return params.length ? url + "?" + params.join("&") : url;
  }

  // Start real-time delivery of ticket-detail updates while the given ticket's
  // detail view is open. SSE (EventSource) is preferred; a stream that errors
  // once (auth, proxy buffering, old browser, cookie embed) falls back to
  // adaptive 5s polling — correctness never depends on the stream staying up.
  // `onData(freshDetail)` receives a full PublicTicketDetail on each
  // snapshot/update (SSE) or poll tick. Bails on navigation away from the ticket.
  function startDetailPoll(ticketId, onData) {
    stopDetailPoll();
    var snap = currentDetailTicket;
    if (typeof window.EventSource === "function") {
      try {
        var es = new EventSource(ticketEventsUrl(ticketId), { withCredentials: wantsCookieAuth() });
        var apply = function (e) {
          if (view !== "detail" || currentDetailTicket !== snap) { stopDetailPoll(); return; }
          var detail = null;
          try { detail = JSON.parse(e.data); } catch (_) { return; }
          onData(detail);
        };
        es.addEventListener("snapshot", apply);
        es.addEventListener("update", apply);
        es.onerror = function () {
          try { es.close(); } catch (_) {}
          if (detailEventSourceRef === es) {
            detailEventSourceRef = null;
            if (view === "detail" && currentDetailTicket === snap) startDetailPollLoop(ticketId, onData);
          }
        };
        detailEventSourceRef = es;
        return;
      } catch (_) {
        detailEventSourceRef = null;
      }
    }
    startDetailPollLoop(ticketId, onData);
  }

  // Recurring poll fallback for the detail view (used when SSE is unavailable
  // or errors out). Same guards/posture as the original detail poll.
  function startDetailPollLoop(ticketId, onData) {
    if (detailPollIntervalId !== null) { clearInterval(detailPollIntervalId); detailPollIntervalId = null; }
    var snap = currentDetailTicket;
    detailPollIntervalId = setInterval(function () {
      if (view !== "detail" || currentDetailTicket !== snap) {
        stopDetailPoll();
        return;
      }
      loadTicketDetail(ticketId).then(function (data) {
        if (view !== "detail" || currentDetailTicket !== snap) return;
        onData(data);
      }).catch(function () {
        // polling failure is silent — the next tick will retry
      });
    }, DETAIL_POLL_INTERVAL_MS);
  }

  function stopDetailPoll() {
    if (detailEventSourceRef) {
      try { detailEventSourceRef.close(); } catch (_) {}
      detailEventSourceRef = null;
    }
    if (detailPollIntervalId !== null) {
      clearInterval(detailPollIntervalId);
      detailPollIntervalId = null;
    }
  }

  // ===========================================================================
  // Clarification timeline, question cards, PR card rendering
  // ===========================================================================

  // Compact horizontal progress stepper rendered from the SERVER-DERIVED
  // milestone model — the only representation of progress shown to partners.
  // Each milestone is { key, label, state: 'done'|'current'|'upcoming' } and
  // carries no code, file paths, or PR locators by construction. The widget
  // never computes milestones itself; it renders what the server sends, so
  // there is a single source of truth for "what step are we on".
  function renderMilestoneStepper(milestones) {
    if (!milestones || milestones.length === 0) return null;
    var currentLabel = milestones[0].label;
    var items = [];
    for (var i = 0; i < milestones.length; i++) {
      var m = milestones[i];
      var cls = "rw-clarif-step";
      if (m.state === "done") cls += " rw-clarif-past";
      else if (m.state === "current") { cls += " rw-clarif-active"; currentLabel = m.label; }

      items.push(h("span", { className: cls }, [
        h("span", { className: "rw-clarif-step-dot" }),
        document.createTextNode(m.label),
      ]));

      if (i < milestones.length - 1) {
        items.push(h("span", { className: "rw-clarif-connector" }));
      }
    }
    return h("div", { className: "rw-clarif-timeline", "aria-label": "Progress: " + currentLabel }, items);
  }

  // Render question cards when status=asking and questions are present.
  // `onAnswered(responseData)` is called with the server response after submit.
  function renderClarificationCards(ticketId, clarification, onAnswered) {
    if (!clarification || clarification.status !== "asking" || !clarification.openQuestions || clarification.openQuestions.length === 0) {
      return null;
    }

    var questions = clarification.openQuestions;
    var cards = [];

    for (var i = 0; i < questions.length; i++) {
      (function (q) {
        var inputEl;
        if (q.options && q.options.length > 0) {
          // options → radio (single) or checkboxes (multiselect)
          var optionEls = q.options.map(function (opt, idx) {
            var inputType = q.multiselect ? "checkbox" : "radio";
            var name = "rw-q-" + q.id;
            var inputOpt = h("input", { type: inputType, name: name, value: opt });
            var label = h("label", { className: "rw-clarif-option" }, [inputOpt, document.createTextNode(opt)]);
            return label;
          });
          inputEl = h("div", { className: "rw-clarif-options", "data-qid": q.id, "data-multiselect": q.multiselect ? "true" : "false" }, optionEls);
        } else {
          // free-text
          inputEl = h("input", { type: "text", className: "rw-clarif-input", "data-qid": q.id, placeholder: "Your answer…" });
        }
        cards.push(h("div", { className: "rw-clarif-card" }, [
          h("p", { className: "rw-clarif-prompt" }, q.prompt),
          inputEl,
        ]));
      })(questions[i]);
    }

    var errorEl = h("span", { className: "rw-clarif-error", style: { display: "none" } });
    var sendBtn = h("button", { className: "rw-clarif-send-btn", type: "button" }, "Send answers");

    var section = h("div", { className: "rw-clarif-section" }, [
      h("p", { className: "rw-clarif-title" }, "We have a few questions"),
    ].concat(cards).concat([
      h("div", { className: "rw-clarif-actions" }, [sendBtn, errorEl]),
    ]));

    sendBtn.addEventListener("click", function () {
      // Collect answers for all questions
      var answers = [];
      var valid = true;
      for (var qi = 0; qi < questions.length; qi++) {
        var q = questions[qi];
        // Find the input by data-qid within section
        var inputNode = section.querySelector('[data-qid="' + q.id + '"]');
        var answer;
        if (!inputNode) { valid = false; break; }
        if (inputNode.tagName === "DIV") {
          // options container
          var isMultiselect = inputNode.getAttribute("data-multiselect") === "true";
          var checked = [];
          var inputs = inputNode.querySelectorAll("input");
          for (var ci = 0; ci < inputs.length; ci++) {
            if (inputs[ci].checked) checked.push(inputs[ci].value);
          }
          if (checked.length === 0) { valid = false; break; }
          answer = isMultiselect ? checked : checked[0];
        } else {
          answer = inputNode.value.trim();
          if (!answer) { valid = false; break; }
        }
        answers.push({ questionId: q.id, answer: answer });
      }

      if (!valid) {
        errorEl.style.display = "";
        errorEl.textContent = "Please answer all questions before sending.";
        return;
      }

      errorEl.style.display = "none";
      sendBtn.disabled = true;
      sendBtn.textContent = "Sending…";

      postClarifyAnswer(ticketId, clarification.id, answers).then(function (resp) {
        onAnswered(resp);
      }).catch(function (err) {
        sendBtn.disabled = false;
        sendBtn.textContent = "Send answers";
        errorEl.style.display = "";
        var code = err && err.status;
        if (code === 409) {
          errorEl.textContent = "These questions have already been answered.";
        } else if (code === 400) {
          errorEl.textContent = "Some answers were invalid — please review and try again.";
        } else if (code === 503) {
          errorEl.textContent = "Clarification service unavailable — please try again shortly.";
        } else {
          errorEl.textContent = "Failed to submit answers: " + ((err && err.message) || "unknown error");
        }
      });
    });

    return section;
  }

  // Duplicate-notice card — rendered when clarification.status === "duplicate".
  // Shows the matched ticket reference (navigable), and a "Not a duplicate —
  // start anyway" button that calls POST /clarify-proceed to override.
  // `onProceeded` is called with the server response on success so the caller
  // can re-fetch the detail.
  function renderDuplicateCard(ticketId, clarification, onProceeded) {
    if (!clarification || clarification.status !== "duplicate") return null;

    var dupId = clarification.duplicateOf;

    // Build the duplicate-ticket reference.  If we have an id, make it a
    // clickable button that fetches the duplicate's detail and navigates to
    // it inside the widget (mirrors the pattern used by onAssignSuccess).
    var refEl;
    if (dupId) {
      var shortRef = String(dupId).slice(0, 8).toUpperCase();
      refEl = h("button", {
        className: "rw-dup-ref-link",
        type: "button",
        title: "View existing request " + shortRef,
      }, "#" + shortRef);
      refEl.addEventListener("click", function () {
        loadTicketDetail(dupId).then(function (detail) {
          var t = detail && detail.ticket;
          if (t) openDetailModal(t);
        }).catch(function () {
          // Navigation failed silently — the user is still on the current ticket.
        });
      });
    } else {
      refEl = h("span", { className: "rw-dup-ref-unknown" }, "an existing request");
    }

    var errorEl = h("span", { className: "rw-clarif-error", style: { display: "none" } });
    var proceedBtn = h("button", {
      className: "rw-dup-proceed-btn",
      type: "button",
    }, "Not a duplicate — start anyway");

    proceedBtn.addEventListener("click", function () {
      errorEl.style.display = "none";
      proceedBtn.disabled = true;
      proceedBtn.textContent = "Starting…";

      postClarifyProceed(ticketId, clarification.id).then(function (resp) {
        onProceeded(resp);
      }).catch(function (err) {
        proceedBtn.disabled = false;
        proceedBtn.textContent = "Not a duplicate — start anyway";
        errorEl.style.display = "";
        var code = err && err.status;
        if (code === 409) {
          errorEl.textContent = "This request has already been processed.";
        } else if (code === 403) {
          errorEl.textContent = "You don’t have permission to override this.";
        } else if (code === 503) {
          errorEl.textContent = "Service unavailable — please try again shortly.";
        } else {
          errorEl.textContent = "Failed to proceed: " + ((err && err.message) || "unknown error");
        }
      });
    });

    return h("div", { className: "rw-dup-card" }, [
      h("div", { className: "rw-dup-card-body" }, [
        h("span", { className: "rw-dup-badge" }, "Possible duplicate"),
        h("span", { className: "rw-dup-card-text" }, [
          document.createTextNode("This looks similar to "),
          refEl,
          document.createTextNode(". Check if it already covers your request."),
        ]),
      ]),
      h("div", { className: "rw-dup-card-footer" }, [
        proceedBtn,
        errorEl,
      ]),
    ]);
  }

  // NOTE: a clickable "Pull request #N" card used to live here. It was removed
  // deliberately: a PR number/URL is an internal locator that points at code,
  // which violates the partner-facing "never reveal code" contract. A linked PR
  // now surfaces only as the "In review"/"Shipped" milestone (server-derived).

  function renderDetailInto(card, data, loading) {
    clearChildren(card);

    var ticket = data.ticket;
    var comments = data.comments || [];
    var activity = data.activity || [];

    // Viewing the ticket (initial load or a live SSE/poll update) marks it seen
    // up to the freshest thing shown, so the launcher badge clears for this
    // ticket and only re-lights if NEW activity arrives afterwards. We use the
    // max of the SERVER timestamps actually rendered (updatedAt + every comment
    // + every activity) so both sides of the badge comparison stay on the
    // server clock — no client/server skew, and it matches listMyTickets'
    // lastActivityAt (comments/activity don't bump updatedAt).
    if (!loading && ticket && ticket.id) {
      var seenMs = new Date(ticket.updatedAt || 0).getTime() || 0;
      for (var ci = 0; ci < comments.length; ci++) {
        seenMs = Math.max(seenMs, new Date(comments[ci].createdAt || 0).getTime() || 0);
      }
      for (var ai = 0; ai < activity.length; ai++) {
        seenMs = Math.max(seenMs, new Date(activity[ai].createdAt || 0).getTime() || 0);
      }
      markTicketSeen(ticket.id, seenMs);
      refreshTabLabel();
    }

    // head
    var voted = ticket.userVote === true;
    var countSpan = h("span", null, String(ticket.yesVotes || 0));
    var voteBtn = h("button", {
      className: "rw-vote" + (voted ? " rw-voted" : ""),
      type: "button",
      "aria-label": t("aria.upvote"),
      disabled: !(config.isIdentified || canAnonInteract()),
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

    // Manual "Assign agent" button removed — assignment is automatic and
    // server-side. The assigned-agent attribution line below still shows once
    // an agent has been auto-started.

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

    var head = h("div", { className: "rw-td-head" }, headChildren);
    // Head + body share one scroll area so the entire ticket content
    // (title, description, attachments, activity thread) scrolls
    // together. The composer below stays pinned at the bottom of the
    // card via flex layout. Earlier the body alone scrolled, which made
    // long descriptions invisible on the way down to comments.
    var scrollArea = h("div", { className: "rw-td-scroll" });
    scrollArea.appendChild(head);

    // Progress stepper — rendered from the server-derived milestone model (the
    // only partner-facing representation of progress). Shown on the fully-loaded
    // render (not the loading skeleton).
    if (!loading && data.milestones && data.milestones.length > 0) {
      var stepper = renderMilestoneStepper(data.milestones);
      if (stepper) scrollArea.appendChild(stepper);
    }

    // "Reviewing" banner — shown while auto-assign is still processing a freshly
    // filed ticket (server-computed data.processing). The clarifier / agent
    // picker runs for a few seconds after creation; without this the ticket looks
    // idle and the author may close it before the questions or assignment appear.
    // The detail poll replaces it automatically the moment an outcome lands.
    if (!loading && data.processing) {
      scrollArea.appendChild(
        h("div", {
          style: {
            display: "flex", alignItems: "center", gap: "12px",
            margin: "0 0 14px", padding: "12px 14px", borderRadius: "10px",
            background: "color-mix(in oklab, var(--rw-accent) 8%, transparent)",
            border: "1px solid color-mix(in oklab, var(--rw-accent) 22%, transparent)",
          },
        }, [
          h("div", { className: "rw-spinner", style: { flex: "0 0 auto" } }),
          h("div", null, [
            h("div", { style: { fontWeight: "600", fontSize: "13px", color: "var(--rw-fg)" } },
              "Reviewing your request…"),
            h("div", { style: { fontSize: "12px", color: "var(--rw-muted)", marginTop: "2px", lineHeight: "1.4" } },
              "This takes a few seconds. Any clarifying questions or an assigned agent will appear here automatically — no need to refresh or close."),
          ]),
        ]),
      );
    }

    // Clarification question cards — rendered when status=asking and the
    // viewer is the answerer (server only populates openQuestions for them).
    if (!loading && data.clarification && data.clarification.status === "asking"
        && data.clarification.openQuestions && data.clarification.openQuestions.length > 0) {
      var qaCards = renderClarificationCards(ticket.id, data.clarification, function (resp) {
        // On successful answer: the server returns an updated clarification.
        // Re-fetch the full detail so the timeline and thread reflect the new state.
        loadTicketDetail(ticket.id).then(function (freshData) {
          if (view !== "detail") return;
          renderDetailInto(card, freshData, false);
        }).catch(function () {
          // If the re-fetch fails, at minimum update the clarification section
          // by re-rendering with the response data merged in.
          var merged = {
            ticket: ticket,
            comments: comments,
            activity: activity,
            isOwner: data.isOwner,
            isEditable: data.isEditable,
            clarification: (resp && resp.clarification) ? {
              id: data.clarification.id,
              status: resp.clarification.status,
              round: resp.clarification.round || data.clarification.round,
              openQuestions: resp.clarification.questions || [],
              duplicateOf: resp.clarification.duplicateOf ?? data.clarification.duplicateOf ?? null,
            } : data.clarification,
            milestones: data.milestones,
          };
          renderDetailInto(card, merged, false);
        });
      });
      if (qaCards) scrollArea.appendChild(qaCards);
    }

    // Duplicate-notice card — rendered when the clarification flagged this
    // ticket as a possible duplicate of an existing one.  The user can
    // click through to the matched ticket or override and proceed anyway.
    if (!loading && data.clarification && data.clarification.status === "duplicate") {
      var dupCard = renderDuplicateCard(ticket.id, data.clarification, function () {
        // On successful proceed: re-fetch the full detail so the timeline,
        // stepper label, and this card all reflect the new state.
        loadTicketDetail(ticket.id).then(function (freshData) {
          if (view !== "detail") return;
          renderDetailInto(card, freshData, false);
        }).catch(function () {
          // Fallback: re-render with clarification status cleared so the
          // card disappears and the user isn't stuck on an error state.
          renderDetailInto(card, {
            ticket: ticket,
            comments: comments,
            activity: activity,
            isOwner: data.isOwner,
            isEditable: data.isEditable,
            clarification: { id: data.clarification.id, status: "started", round: data.clarification.round, openQuestions: [] },
            linkedPr: data.linkedPr,
          }, false);
        });
      });
      if (dupCard) scrollArea.appendChild(dupCard);
    }

    // "Created from a conversation" — when this ticket originated from the
    // chat intake on THIS browser (reporter side), offer the transcript.
    // Team-side transcript rendering lives in the runhq client (spec §5),
    // not in the widget.
    if (!loading) {
      var chatConvId = chatConversationForTicket(ticket.id);
      if (chatConvId) {
        scrollArea.appendChild(renderChatTranscriptSection(chatConvId));
      }
    }

    // Staff tools bar (live_coder only): the Live-session relay and the PR
    // Preview launcher are powerful, privileged actions, but used to render as
    // a quiet underlined link + an unstyled native button that staff routinely
    // missed. Collect whichever apply into `staffActionEls` and emit them in
    // one accent-tinted bar below.
    var staffActionEls = [];

    // Assign-agent affordance — staff-only (server sets data.canAssign true
    // only when the viewer holds `assign_agent`, no agent is assigned yet, and
    // the ticket is in an actionable status). This is the path for a ticket
    // filed by an unauthorized reporter (never auto-assigned): an authorized
    // teammate reviews it and clicks here. One click runs the server's
    // suggest → assign tail; on success the detail re-fetches and this button
    // disappears (the ticket now shows its assigned agent + Live session).
    if (!loading && data.canAssign) {
      // Feedback slot below the button. A transient failure renders as a small
      // red line; the terminal "no agent is set up for this project" case
      // renders an amber callout that names the cause and where to fix it.
      var assignMsgEl = h("div", {
        className: "rw-assign-msg",
        style: { width: "100%" },
      }, "");
      var clearAssignMsg = function () { assignMsgEl.textContent = ""; };
      var showAssignError = function (text) {
        assignMsgEl.textContent = "";
        assignMsgEl.appendChild(h("span", {
          className: "rw-assign-err",
          style: { fontSize: "12px", color: "var(--rw-danger, #dc2626)" },
        }, text));
      };
      var showNoAgentCallout = function () {
        assignMsgEl.textContent = "";
        assignMsgEl.appendChild(h("div", { className: "rw-assign-callout" }, [
          h("span", { className: "rw-assign-callout-ic", "aria-hidden": "true" }, "⚠️"),
          h("div", { className: "rw-assign-callout-body" }, [
            h("span", { className: "rw-assign-callout-title" }, "No agents are set up for this project."),
            " To assign one, open ",
            h("span", { className: "rw-assign-callout-path" }, "Workspace Settings → Widget → Permissions"),
            " and expose at least one agent, then try again.",
          ]),
        ]));
      };
      var assignBtn = h("button", {
        className: "rw-staff-btn rw-staff-btn--primary",
        type: "button",
        title: "Assign an agent to work on this task",
      }, [
        h("span", { className: "rw-staff-btn-ic" }, "🤖"),
        "Assign an agent",
      ]);
      var assigning = false;
      var resetAssignBtn = function () {
        assigning = false;
        assignBtn.disabled = false;
        assignBtn.textContent = "Assign an agent";
      };
      assignBtn.addEventListener("click", function () {
        if (assigning) return;
        assigning = true;
        assignBtn.disabled = true;
        assignBtn.textContent = "Assigning…";
        clearAssignMsg();
        assignTicketAgent(ticket.id).then(function (resp) {
          var status = resp && resp.outcome && resp.outcome.status;
          if (status === "assigned") {
            // Re-fetch so the assigned agent + Live-session affordance render
            // and this button disappears.
            loadTicketDetail(ticket.id).then(function (freshData) {
              if (view !== "detail") return;
              renderDetailInto(card, freshData, false);
            }).catch(resetAssignBtn);
          } else if (status === "skipped_no_agent") {
            // Terminal: the project has no exposed agent for the picker to
            // choose. Retrying won't help until an operator exposes one, so
            // guide them there instead of a bare red line.
            resetAssignBtn();
            showNoAgentCallout();
          } else {
            // Reached the server but a transient failure stopped the assign.
            // Surface it and let the user retry.
            resetAssignBtn();
            showAssignError("Couldn't assign — try again");
          }
        }).catch(function (err) {
          resetAssignBtn();
          showAssignError(
            (err && err.status === 409) ? "Already assigned"
            : (err && err.status === 403) ? "Not authorized"
            : "Couldn't assign — try again");
        });
      });
      // Non-technical framing: state plainly that nobody is on the task yet,
      // with the action right beneath it — clearer than a bare "Assign agent"
      // button for a non-technical teammate reviewing the ticket.
      var assignNote = h("div", {
        className: "rw-staff-assign-note",
        style: { fontSize: "12.5px", lineHeight: "1.4", color: "var(--rw-muted, #6b7280)" },
      }, "No agent is working on this task yet.");
      var assignGroup = h("div", {
        style: { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "7px", width: "100%" },
      }, [assignNote, assignBtn, assignMsgEl]);
      staffActionEls.push(assignGroup);
    }

    // Live session affordance — staff-only (requires the `live_coder`
    // permission). Shown whenever the ticket has an assigned agent (a coder job
    // is running), regardless of how the ticket was created. Chat-originated
    // tickets carry a `chatConversationId`; a directly-assigned ticket has none,
    // so we lazily create the relay conversation on click (the workspace relay
    // targets the coder by canonical task id either way).
    //
    // Clicking "Live session" navigates to the chat view with the conversation
    // pre-seeded, reusing the existing chatApplyMessages + startChatTransport
    // SSE machinery (no duplicate transport).
    if (!loading
        && ticket.assignedAgentName
        && currentUser.permissions && currentUser.permissions.indexOf("live_coder") !== -1) {
      var liveBtn = h("button", {
        className: "rw-staff-btn rw-staff-btn--primary",
        type: "button",
        title: "Send a message into the running coder job",
      }, [
        h("span", { className: "rw-staff-btn-ic" }, "⚡"),
        "Live session",
      ]);
      // Unread dot = an unread coder/teammate reply in THIS ticket's live
      // session. The detail ticket may not carry liveSessionLastMessageAt, so
      // resolve it from the assigned cache (which does).
      var assignedMatch = (assignedTicketsCache || []).find(function (a) { return a && a.id === ticket.id; });
      if (assignedMatch && hasUnreadLiveSession(assignedMatch)) {
        liveBtn.insertBefore(h("span", { className: "rw-unseen-dot" }), liveBtn.firstChild);
      }
      var liveOpening = false;
      liveBtn.addEventListener("click", function () {
        if (liveOpening) return;
        // Chat-originated ticket: the conversation already exists — open it.
        if (data.chatConversationId) {
          openLiveSession(data.chatConversationId, ticket);
          return;
        }
        // Otherwise create/reuse a ticket-scoped conversation, then open it.
        liveOpening = true;
        liveBtn.disabled = true;
        liveBtn.textContent = "Opening…";
        ensureTicketLiveSession(ticket.id).then(function (resp) {
          if (resp && resp.conversationId) {
            openLiveSession(resp.conversationId, ticket);
          } else {
            liveOpening = false;
            liveBtn.disabled = false;
            liveBtn.textContent = "Live session";
          }
        }).catch(function () {
          liveOpening = false;
          liveBtn.disabled = false;
          liveBtn.textContent = "Live session";
        });
      });
      staffActionEls.push(liveBtn);
    }

    // Preview button — staff-only (requires canPreview from the server, which
    // is true only for live_coder staff on a ticket with a linked PR).
    // The preview start is async: the first POST often returns `preparing`
    // (no url), so we poll until a url comes back, then open it in a new tab.
    // Guard against overlapping clicks (ignore while already polling).
    if (!loading && data.canPreview) {
      var previewStarting = false;
      var previewPollTimer = null;
      var previewPollStart = null;
      var PREVIEW_POLL_INTERVAL_MS = 1500;
      var PREVIEW_POLL_TIMEOUT_MS = 55000;

      var previewErrEl = h("span", { className: "rw-preview-err", style: { fontSize: "12px", color: "var(--rw-danger, #dc2626)" } }, "");
      var previewBtn = h("button", {
        className: "rw-staff-btn rw-staff-btn--ghost rw-preview-btn",
        type: "button",
        title: "Open a live preview of this PR in a new tab",
      }, "▶ Preview");

      function stopPreviewPoll() {
        if (previewPollTimer !== null) {
          clearTimeout(previewPollTimer);
          previewPollTimer = null;
        }
      }

      function setPreviewError(msg) {
        previewStarting = false;
        stopPreviewPoll();
        previewBtn.disabled = false;
        previewBtn.textContent = "▶ Preview";
        previewErrEl.textContent = msg;
      }

      function schedulePreviewPoll(ticketIdForPreview) {
        previewPollTimer = setTimeout(function () {
          previewPollTimer = null;
          if (!previewStarting) return;
          var elapsed = Date.now() - previewPollStart;
          if (elapsed > PREVIEW_POLL_TIMEOUT_MS) {
            setPreviewError("Preview unavailable");
            return;
          }
          startTicketPreview(ticketIdForPreview).then(function (resp) {
            if (!previewStarting) return;
            if (resp && resp.ok && resp.url) {
              previewStarting = false;
              stopPreviewPoll();
              previewBtn.disabled = false;
              previewBtn.textContent = "▶ Preview";
              previewErrEl.textContent = "";
              window.open(resp.url, "_blank", "noopener");
            } else if (resp && resp.ok && !resp.url) {
              // still preparing — poll again
              schedulePreviewPoll(ticketIdForPreview);
            } else {
              setPreviewError("Preview unavailable");
            }
          }).catch(function () {
            setPreviewError("Preview unavailable");
          });
        }, PREVIEW_POLL_INTERVAL_MS);
      }

      previewBtn.addEventListener("click", function () {
        if (previewStarting) return;
        previewStarting = true;
        previewPollStart = Date.now();
        previewBtn.disabled = true;
        previewBtn.textContent = "Starting preview…";
        previewErrEl.textContent = "";
        startTicketPreview(ticket.id).then(function (resp) {
          if (!previewStarting) return;
          if (resp && resp.ok && resp.url) {
            previewStarting = false;
            previewBtn.disabled = false;
            previewBtn.textContent = "▶ Preview";
            window.open(resp.url, "_blank", "noopener");
          } else if (resp && resp.ok && !resp.url) {
            // preparing — start poll
            schedulePreviewPoll(ticket.id);
          } else {
            setPreviewError("Preview unavailable");
          }
        }).catch(function () {
          setPreviewError("Preview unavailable");
        });
      });

      staffActionEls.push(previewBtn, previewErrEl);
    }

    // Emit the staff tools bar if any privileged action applies. The eyebrow
    // label + accent tint make these controls unmistakably staff-only and far
    // easier to spot than the prior loose link/button.
    if (staffActionEls.length) {
      var staffBar = h("div", { className: "rw-staff-bar" }, [
        h("div", { className: "rw-staff-bar-head" }, [
          icon([{ d: "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" }], 12),
          "Staff tools",
        ]),
        h("div", { className: "rw-staff-actions" }, staffActionEls),
      ]);
      scrollArea.appendChild(staffBar);
    }

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
      // Render markdown (bold/italic/code/links) per paragraph so reports don't
      // show raw ** and ` markers. pre-wrap on .rw-td-post-body keeps single
      // newlines (e.g. "- " bullet lines) intact within a paragraph.
      ticket.description.split(/\n\n+/).forEach(function (para) {
        var p = h("p", null);
        appendMarkdownInline(p, para);
        postBody.appendChild(p);
      });
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
          if (node.kind === "event") thread.appendChild(renderEventNode(node.event, ticket));
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
      renderDetailInto(card, { ticket: ticket, comments: comments, activity: activity, isOwner: data.isOwner, isEditable: data.isEditable, clarification: data.clarification, milestones: data.milestones }, false);
    }));

    // Polling — start once the full detail is loaded (not during the loading skeleton).
    // The poll fetches fresh data and re-renders only the mutable sections
    // (clarification + PR card + thread) when content has changed.
    // Stop immediately if the view has navigated away.
    if (!loading) {
      startDetailPoll(ticket.id, function (freshData) {
        var clarifChanged =
          JSON.stringify(freshData.clarification) !== JSON.stringify(data.clarification);
        var milestonesChanged =
          JSON.stringify(freshData.milestones) !== JSON.stringify(data.milestones);
        var statusChanged = freshData.ticket && data.ticket && freshData.ticket.status !== data.ticket.status;
        var threadChanged =
          (freshData.comments || []).length !== comments.length
          || (freshData.activity || []).length !== activity.length;
        // Also re-render when the "reviewing" state clears — for skip/failed
        // outcomes nothing else changes (no clarification, same status), so the
        // banner would otherwise linger forever.
        var processingChanged = !!freshData.processing !== !!data.processing;
        if (clarifChanged || milestonesChanged || statusChanged || threadChanged || processingChanged) {
          renderDetailInto(card, freshData, false);
        }
      });
    }
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
    var seenActivity = {};
    for (var i = 0; i < comments.length; i++) {
      nodes.push({ kind: "comment", comment: comments[i], at: new Date(comments[i].createdAt).getTime() });
    }
    for (var j = 0; j < activity.length; j++) {
      // Skip event types that duplicate things we render elsewhere
      var e = activity[j];
      if (e.type === "comment_added" || e.type === "comment_edited" || e.type === "comment_deleted") continue;
      if (e.type === "attachment_added") continue;
      if (isDuplicateActivityEvent(e, seenActivity)) continue;
      nodes.push({ kind: "event", event: e, at: new Date(e.createdAt).getTime() });
    }
    nodes.sort(function (a, b) { return a.at - b.at; });
    return nodes;
  }

  function activityDedupeKey(e) {
    if (!e || e.type !== "agent_assigned") return null;
    var m = e.metadata || {};
    var agentId = m.agent_id || m.agentId || "";
    var actor = e.createdByName || e.createdBy || m.external_user_id || m.externalUserId || "";
    var command = m.command || "";
    return [e.type, actor, agentId, command].join("|");
  }

  function isDuplicateActivityEvent(e, seen) {
    var key = activityDedupeKey(e);
    if (!key) return false;
    var at = new Date(e.createdAt).getTime();
    if (!Number.isFinite(at)) at = 0;
    if (seen[key] != null && Math.abs(at - seen[key]) <= 15000) {
      // BE writes the widget audit row and older workspace builds also wrote a
      // matching assignment row. Collapse those near-simultaneous duplicates.
      return true;
    }
    seen[key] = at;
    return false;
  }

  function renderInlineMarkdown(text) {
    var src = String(text == null ? "" : text);
    var out = [];
    var re = /(`([^`]+)`|\*\*([^*]+)\*\*)/g;
    var last = 0;
    var match;
    while ((match = re.exec(src)) !== null) {
      if (match.index > last) out.push(document.createTextNode(src.slice(last, match.index)));
      if (match[2] != null) {
        out.push(h("code", null, match[2]));
      } else {
        out.push(h("strong", null, match[3]));
      }
      last = match.index + match[0].length;
    }
    if (last < src.length) out.push(document.createTextNode(src.slice(last)));
    return out.length ? out : [document.createTextNode(src)];
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
    // Canonical activity types (the shapes that actually reach the widget).
    if (e.type === "agent_assigned")   return m.agentName ? t("events.agentAssignedTo", { to: m.agentName }) : t("events.agentAssigned");
    if (e.type === "agent_unassigned") return t("events.agentUnassigned");
    if (e.type === "pr_linked") {
      // Code-safe: never the PR number/url — only the review/ship milestone.
      if (m.state === "merged") return t("events.prMerged");
      if (m.state === "closed") return t("events.prClosed");
      return t("events.prLinked");
    }
    if (e.type === "ticket_created" || e.type === "task_created") return t("events.ticketCreated");
    if (e.type === "ticket_edited")  return t("events.ticketEdited");
    if (e.type === "ticket_deleted" || e.type === "task_deleted") return t("events.ticketDeleted");
    if (e.type === "task_archived")   return t("events.ticketArchived");
    if (e.type === "task_unarchived") return t("events.ticketUnarchived");
    // Agent-authored, screened status update. Its `content` is plain-language
    // prose already cleared by the runhq-side gate — render it as the message.
    if (e.type === "agent_update")    return e.content || t("events.agentUpdate");
    // Safety net: humanize any unmapped type so a raw snake_case identifier
    // (e.g. "agent_assigned") never surfaces to a partner.
    return e.content || humanizeEventType(e.type);
  }

  // "agent_assigned" → "Agent assigned". Used as the describeEvent fallback so
  // unmapped activity types still read as plain English, never code.
  function humanizeEventType(type) {
    if (!type) return "";
    return String(type).replace(/_/g, " ").replace(/^./, function (c) { return c.toUpperCase(); });
  }

  function activityActorName(e, ticket) {
    if (e.createdByName) return e.createdByName;
    var m = e.metadata || {};
    var isAgentActor = e.createdByType === "agent" || e.type === "agent_update";
    if (isAgentActor) {
      if (typeof m.agentName === "string" && m.agentName) return m.agentName;
      if (ticket && ticket.assignedAgentName) return ticket.assignedAgentName;
      return t("events.agentDefault");
    }
    return "Team";
  }

  function renderEventNode(e, ticket) {
    var actorName = activityActorName(e, ticket);
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
      textChildren.push(h("span", { className: "rw-event-message" }, renderInlineMarkdown(describeEvent(e))));
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
      h("div", { className: "rw-td-comment-text" }, renderMarkdownText(c.body || "")),
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

    // Anonymous viewers of a public widget can compose a reply — the submit
    // click is gated and redirects to the login URL with the draft preserved.
    var canPostComment = config.isIdentified || canAnonInteract();
    var disabled = !canPostComment || !!ticket.commentsDisabled;
    var placeholder = !canPostComment ? t("reply.signInPlaceholder")
                    : ticket.commentsDisabled ? t("reply.disabledPlaceholder")
                    : config.attachmentsEnabled ? t("reply.placeholder")
                    : t("reply.placeholderNoAttach");

    var ta = h("textarea", { className: "rw-td-composer-ta", placeholder: placeholder, disabled: disabled });

    var submitBtn = h("button", { className: "rw-submit-btn", type: "button" }, [
      h("span", null, t("reply.submit")), Icons.send(12),
    ]);
    var attachBtn = h("button", { className: "rw-pill-btn", type: "button", disabled: disabled }, [
      Icons.paperclip(14), h("span", null, t("composer.attach")),
    ]);
    attachBtn.addEventListener("click", function () { fileInput.click(); });

    // Same soft-disabled pattern as the new-ticket composer: keep the button
    // hoverable so its `title` (and a click) can explain why posting is
    // blocked, instead of a dead natively-disabled control. Native `disabled`
    // is reserved for the transient posting/uploading state.
    var submitReason = null;
    // `reason` gates the click/keydown and applies the disabled styling.
    // `showTooltip` controls whether it ALSO surfaces as the button's
    // hover/click ::after bubble. The identity-lock reason is shown once,
    // by the persistent top-of-composer banner — surfacing it on the
    // button too (and again via the click handler) was the triple-render
    // the user (rightly) called redundant. Short hints (empty composer)
    // keep the tooltip since no banner shows for them.
    function setSubmitReason(reason, showTooltip) {
      submitReason = reason;
      if (reason) {
        submitBtn.setAttribute("aria-disabled", "true");
        if (showTooltip) submitBtn.setAttribute("data-rw-reason", reason);
        else submitBtn.removeAttribute("data-rw-reason");
      } else {
        submitBtn.removeAttribute("aria-disabled");
        submitBtn.removeAttribute("data-rw-reason");
      }
    }
    function updateSubmitEnabled() {
      // Reply composer has no banner; the button tooltip is its single
      // surface (short messages), so keep showTooltip on.
      if (ticket.commentsDisabled) { setSubmitReason(t("reply.disabledPrompt"), true); return; }
      if (!canPostComment) { setSubmitReason(t("reply.signInPrompt"), true); return; }
      var hasText = ta.value.trim().length > 0;
      var hasStaged = entries.length > 0;
      setSubmitReason(!hasText && !hasStaged ? t("composer.disabledEmpty") : null, true);
    }
    updateSubmitEnabled();
    function renderChips() {
      clearChildren(chipsEl);
      if (entries.length === 0) { chipsEl.style.display = "none"; return; }
      chipsEl.style.display = "flex";
      entries.forEach(function (entry) {
        chipsEl.appendChild(renderAttachChip(entry, function (target) {
          var i = entries.indexOf(target);
          if (i >= 0) { releaseAttachPreview(entries[i]); entries.splice(i, 1); }
          renderChips(); updateSubmitEnabled();
        }, function () { return stagedGallery(entries); }));
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
    // Paste-to-attach only when image attachments are enabled server-side.
    if (config.attachmentsEnabled) {
      ta.addEventListener("paste", function (e) {
        if (e.clipboardData && e.clipboardData.files && e.clipboardData.files.length > 0) {
          e.preventDefault(); addFiles(e.clipboardData.files);
        }
      });
    }
    ta.addEventListener("input", function () {
      ta.style.height = "auto";
      ta.style.height = Math.min(200, Math.max(56, ta.scrollHeight)) + "px";
      updateSubmitEnabled();
    });
    ta.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        if (!submitReason && !submitBtn.disabled) submitBtn.click();
      }
    });

    submitBtn.addEventListener("click", function () {
      // Soft-disabled: block. Reason already shown via the button tooltip;
      // don't also re-render it as a notice (that was the redundant copy).
      if (submitReason) return;
      var text = ta.value.trim();
      if (!text && entries.length === 0) return;

      // Anonymous viewer on a public widget: serialize body + queued image
      // files into sessionStorage and redirect to login. Files are not
      // uploaded to the server in this branch.
      if (isAnonViewer()) {
        if (!config.loginUrl) return;
        submitBtn.disabled = true;
        submitBtn.firstChild.textContent = t("reply.savingDraft");
        Promise.all(entries.map(function (e) { return fileToDataUrl(e.file); }))
          .then(function (serializedFiles) {
            gateWriteAction({
              type: "comment",
              ticketId: ticket.id,
              draft: { body: text, files: serializedFiles },
            });
          })
          .catch(function () {
            gateWriteAction({
              type: "comment",
              ticketId: ticket.id,
              draft: { body: text, files: [] },
            });
          });
        return;
      }

      submitBtn.disabled = true;
      submitBtn.firstChild.textContent = t("reply.posting");
      clearChildren(noticeSlot);
      var attachErrors = [];
      postComment(ticket.id, text || "").then(function (data) {
        var newComment = data && data.comment;
        if (!newComment) throw new Error("Malformed response");
        if (entries.length === 0) return newComment;
        submitBtn.firstChild.textContent = t("reply.uploading");
        return Promise.all(entries.map(function (e) {
          return uploadCommentAttachment(ticket.id, newComment.id, e.file)
            .then(function (r) { return r && r.attachment; })
            .catch(function (err) {
              console.warn("Comment attach failed:", err && err.message);
              attachErrors.push(friendlyAttachError(err));
              return null;
            });
        })).then(function (attachments) {
          var real = attachments.filter(function (a) { return !!a; });
          newComment.attachments = (newComment.attachments || []).concat(real);
          return newComment;
        });
      }).then(function (newComment) {
        ta.value = "";
        ta.style.height = "auto";
        releaseAllAttachPreviews(entries);
        entries.length = 0;
        renderChips();
        submitBtn.firstChild.textContent = t("reply.submit");
        // Clear the transient in-flight `disabled`; updateSubmitEnabled()
        // now governs only the soft-locked (aria-disabled) state.
        submitBtn.disabled = false;
        updateSubmitEnabled();
        // Comment posted, but one or more images failed to attach — surface it
        // rather than dropping the image silently. The comment still appears.
        if (attachErrors.length > 0) {
          clearChildren(noticeSlot);
          noticeSlot.appendChild(renderNotice("error", t("reply.attachFailed", {
            n: String(attachErrors.length),
            msg: attachErrors[0] || "",
          })));
        }
        if (onPosted) onPosted(newComment);
      }).catch(function (err) {
        submitBtn.firstChild.textContent = t("reply.submit");
        submitBtn.disabled = false;
        updateSubmitEnabled();
        noticeSlot.appendChild(renderNotice("error", t("reply.failed", { msg: err.message || "" })));
      });
    });

    var composerCard = h("div", { className: "rw-td-composer-card" }, [
      ta,
      chipsEl,
      h("div", { className: "rw-td-composer-bar" }, [
        h("div", { className: "rw-td-composer-bar-l" }, [
          config.attachmentsEnabled ? attachBtn : null,
          config.attachmentsEnabled
            ? h("span", { className: "rw-td-composer-hint" }, t("reply.hint"))
            : null,
        ]),
        submitBtn,
      ]),
    ]);

    var composer = h("div", { className: "rw-td-composer" });
    if (!canPostComment) {
      composer.appendChild(h("div", { className: "rw-login-prompt", style: { marginBottom: "8px" } }, t("reply.signInPrompt")));
    } else if (ticket.commentsDisabled) {
      composer.appendChild(h("div", { className: "rw-login-prompt", style: { marginBottom: "8px" } }, t("reply.disabledPrompt")));
    }
    composer.appendChild(noticeSlot);
    composer.appendChild(h("div", { className: "rw-td-composer-row" }, [
      renderAvatar("You", 26),
      composerCard,
      config.attachmentsEnabled ? fileInput : null,
    ]));
    return composer;
  }

  // ===========================================================================
  // Panel open/close
  // ===========================================================================

  function openPanel(afterRefresh) {
    if (isOpen) {
      if (afterRefresh) afterRefresh();
      return;
    }
    isOpen = true;
    // Mode class BEFORE the open class, with a forced style flush between:
    // the geometry transition is gated on .rw-open, so the panel always
    // opens already AT its final geometry (no compact↔expanded morph during
    // the fade-in) — including deep-link opens that pre-set view = "list".
    applyShellMode();
    void widgetEl.offsetWidth;
    widgetEl.classList.add("rw-open");
    tabEl.classList.add("rw-open");
    markPanelOpened();
    var p = refreshAll();
    if (afterRefresh && p && typeof p.then === "function") {
      p.then(afterRefresh);
    }
    // Keep the unread badge/bell current while the panel is open.
    startBadgePoll();
  }

  // ---------------------------------------------------------------------------
  // Restore intent on return from login
  //
  // After a successful login redirect, the widget bootstraps under an
  // authenticated identity. If a saved intent matches the current project,
  // apply it: open the composer/detail with prefilled state and surface a
  // "welcome back" toast. The user still confirms the action with a second
  // click — we never auto-submit on their behalf.
  // ---------------------------------------------------------------------------

  function showRestoreToast(message) {
    if (!scrollEl) return;
    var toast = h("div", {
      className: "rw-restore-toast",
      style: {
        position: "absolute", top: "12px", left: "50%", transform: "translateX(-50%)",
        background: "var(--rw-accent, #2563eb)", color: "#fff",
        padding: "8px 14px", borderRadius: "8px", fontSize: "12px",
        boxShadow: "0 4px 12px rgba(0,0,0,0.2)", zIndex: "10",
        opacity: "0", transition: "opacity 200ms ease",
      },
    }, message);
    scrollEl.appendChild(toast);
    requestAnimationFrame(function () { toast.style.opacity = "1"; });
    setTimeout(function () {
      toast.style.opacity = "0";
      setTimeout(function () { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 250);
    }, 4000);
  }

  // Replays a serialized File array into a composer's existing addFiles flow
  // by populating the hidden input.files via DataTransfer and dispatching a
  // synthetic 'change' event. Returns nothing; the composer reflects the
  // queued files via its own renderChips on receipt.
  function rehydrateFilesIntoComposer(composerRoot, serializedFiles) {
    if (!composerRoot || !Array.isArray(serializedFiles) || serializedFiles.length === 0) return;
    var fileInput = composerRoot.querySelector('input[type="file"]');
    if (!fileInput) return;
    Promise.all(serializedFiles.map(dataUrlToFile)).then(function (files) {
      try {
        var dt = new DataTransfer();
        files.forEach(function (f) { dt.items.add(f); });
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      } catch (_) {
        // DataTransfer is widely supported but fall back silently if not.
      }
    }).catch(function () {});
  }

  function applyIntent(intent) {
    if (!intent) return;
    try {
      if (intent.type === "submit-ticket" && intent.draft) {
        // The draft restores into the compose face. Boot pre-sets
        // view = "compose" for this intent type so the panel paints compact
        // from its very first frame; this guard covers any other caller.
        if (view !== "compose") {
          composeReturnView = "home";
          view = "compose";
          renderPanelBody();
        }
        var composerRoot = scrollEl && scrollEl.querySelector(".rw-inline-composer");
        var ta = composerRoot && composerRoot.querySelector(".rw-inline-composer-ta");
        if (!ta) return;
        ta.value = intent.draft.description || "";
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        rehydrateFilesIntoComposer(composerRoot, intent.draft.files);
        // Restore the privacy toggle. The composer renders with isPrivate=false
        // by default, so we only need to click when the saved draft was private.
        // The button's data-rw-private attribute reflects its current state,
        // so we won't double-toggle if applyIntent fires more than once.
        if (intent.draft.isPrivate) {
          var privBtn = composerRoot && composerRoot.querySelector(".rw-priv-toggle");
          if (privBtn && privBtn.getAttribute("data-rw-private") !== "true") {
            privBtn.click();
          }
        }
        showRestoreToast(t("restore.welcomeBack"));
        return;
      }
      if (intent.type === "vote" && intent.ticketId) {
        var summary = (topTicketsCache || []).find(function (tk) { return tk.id === intent.ticketId; })
          || (updatesCache || []).find(function (tk) { return tk.id === intent.ticketId; })
          || (myTicketsCache || []).find(function (tk) { return tk.id === intent.ticketId; });
        if (!summary) return;
        view = "detail";
        currentDetailTicket = summary;
        renderPanelBody();
        showRestoreToast(t("restore.voteWelcomeBack"));
        return;
      }
      if (intent.type === "comment" && intent.ticketId && intent.draft) {
        var commentSummary = (topTicketsCache || []).find(function (tk) { return tk.id === intent.ticketId; })
          || (updatesCache || []).find(function (tk) { return tk.id === intent.ticketId; })
          || (myTicketsCache || []).find(function (tk) { return tk.id === intent.ticketId; });
        if (!commentSummary) return;
        view = "detail";
        currentDetailTicket = commentSummary;
        renderPanelBody();
        // The comment composer renders inside loadTicketDetail's resolve
        // callback (a separate fetch, see renderPanelBody for the detail
        // branch). We poll briefly for the textarea since intent restore
        // is a one-shot and over-engineering a render-event hook for a
        // rare flow isn't worth the complexity.
        var commentDraft = intent.draft;
        var attempts = 0;
        var poll = function () {
          var commentRoot = scrollEl && scrollEl.querySelector(".rw-td-composer");
          var commentTa = commentRoot && commentRoot.querySelector(".rw-td-composer-ta");
          if (commentTa) {
            commentTa.value = commentDraft.body || "";
            commentTa.dispatchEvent(new Event("input", { bubbles: true }));
            rehydrateFilesIntoComposer(commentRoot, commentDraft.files);
            showRestoreToast(t("restore.welcomeBack"));
            return;
          }
          if (attempts++ < 20) setTimeout(poll, 100);
        };
        poll();
        return;
      }
      if (intent.type === "chat") {
        openChat();
        showRestoreToast(t("restore.welcomeBack"));
        return;
      }
    } catch (_) {
      // Restore failures are silent — the user just sees the regular widget.
    }
  }
  function closePanel() {
    if (!isOpen) return;
    isOpen = false;
    widgetEl.classList.remove("rw-open");
    tabEl.classList.remove("rw-open");
    closeActiveModal();
    // Stop any running detail poll before resetting view state.
    stopDetailPoll();
    stopChatTransport();
    stopBadgePoll();
    chatUi = null;
    chatTurnPending = false;
    chatSubmitInFlight = false;
    detailReturnView = null;
    composeReturnView = "home";
    // Reset the shell so re-opening lands on a fresh discussion board (Hot tab)
    // rather than wherever the user last left it (detail view, chat, etc.).
    view = "list";
    currentDetailTicket = null;
    activeTab = "hot";
    // The launcher is hidden while open; rebuild it on close so its badge
    // reflects any tickets the user just viewed (seen marks updated).
    refreshTabLabel();
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
    tabEl.addEventListener("click", function () {
      if (isOpen) { closePanel(); return; }
      // If the pill is sitting in its hover-peeked state (collapsed flag
      // set, no badge active), the user is explicitly bringing it back —
      // record an explicit "expanded" preference so it stays visible after
      // this session (including on mobile, where absent = collapsed default).
      // When the badge is overriding the collapsed state we leave the
      // flag intact so the pill re-tucks once updates are read.
      if (shouldRenderCollapsed()) {
        setCollapsed(false);
        applyCollapsedState();
      }
      openPanel();
    });

    // Shell controls (notifications + theme + close), pinned top-right.
    notifBellBtn = h("button", { className: "rw-icon-btn rw-notif-bell", type: "button" }, Icons.bell(16));
    notifBellBtn.addEventListener("click", function (e) { e.stopPropagation(); toggleNotifDropdown(); });
    notifWrap = h("div", { className: "rw-notif-wrap" }, [notifBellBtn]);

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
      h("div", { className: "rw-shell-actions" }, [notifWrap, themeToggleBtn, closeShellBtn]),
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
    // Apply the persisted collapse preference on first paint so the pill
    // never flashes in its full state if the user previously hid it.
    // Updates/my-tickets haven't loaded yet, so launcherBadgeCount() is 0 here —
    // if a badge arrives later, refreshTabLabel() re-runs applyCollapsedState().
    applyCollapsedState();

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        if (activeModal) { closeActiveModal(); return; }
        if (isOpen) closePanel();
      }
    });
  }

  // ===========================================================================
  // Auth misconfiguration diagnostics
  //
  // When init() is given a token but the server rejects it, the widget used
  // to silently fall back to "anonymous" — indistinguishable from a working
  // anon embed, and impossible to debug from the page. Instead we classify
  // the failure (server sends `authError` on /api/widget/identity), log a
  // precise actionable message to the console, and stash a short human
  // string the locked submit button surfaces on hover/click.
  // ===========================================================================

  // code -> { dev: console guidance, user: short visible reason }
  var WIDGET_AUTH_ERRORS = {
    malformed_jwt:           { dev: "The Authorization token isn't a valid JWT. Your backend must `RunHQWidget.init({ token })` with the signed widget_user JWT, not a raw key or empty value.", user: "Widget token is malformed — the site is sending an invalid token." },
    unknown_project:         { dev: "The token's `fp` claim matches no project. Your backend is deriving the fingerprint wrong or signing with the wrong API secret. `fp` must be sha256(API_SECRET) hex, first 32 chars.", user: "Widget token doesn't match this project — backend is using the wrong API secret / fingerprint." },
    project_disabled:        { dev: "The widget project is disabled in RunHQ settings.", user: "This feedback widget is disabled." },
    signature_invalid:       { dev: "Token signature failed verification. Your backend signed with the wrong API secret — copy the current secret from the Widget Integration page.", user: "Widget token signature invalid — backend signed with the wrong API secret." },
    token_expired:           { dev: "Token `exp` is in the past. Mint a fresh token per session (the snippet uses 24h).", user: "Widget token expired — the site must mint a fresh token per session." },
    token_too_old:           { dev: "Token age exceeds the 24h server cap. Reduce token lifetime / refresh it.", user: "Widget token is too old — the site must refresh it." },
    missing_exp:             { dev: "Token is missing the required `exp` claim. Add an expiry (e.g. now + 24h).", user: "Widget token missing required expiry — fix the backend token payload." },
    wrong_type:              { dev: 'Token `type` claim must be exactly "widget_user".', user: "Widget token has the wrong `type` — must be \"widget_user\"." },
    not_identified:          { dev: "Token verified but has no `sub` claim, so submissions can't be attributed. Set `sub` to the logged-in user's id.", user: "Widget token has no user id (`sub`) — the site must include it so you can submit." },
    identity_request_failed: { dev: "The /api/widget/identity request failed (network, CORS, or a stripped Authorization header). Check the embed origin, the `server` URL, and that the header is allowed.", user: "Widget couldn't reach the identity endpoint (network/CORS) — check the embed configuration." },
    no_identity:             { dev: "A token was supplied but the server returned no identity and no reason. Verify the token claims (fp, type, sub, exp) and signing secret.", user: "Widget token was not accepted — the site isn't passing a valid identity." },
  };

  function reportWidgetAuthError(code, err) {
    var info = WIDGET_AUTH_ERRORS[code] || WIDGET_AUTH_ERRORS.no_identity;
    config.authError = code;
    config.authErrorMessage = info.user;
    // Loud, actionable, and prefixed so it's greppable in the page console.
    console.error(
      "[RunHQ widget] Misconfigured embed — token rejected (" + code + "). " +
      info.dev +
      " Docs: open the channel's Widget Integration page in RunHQ." +
      (err ? " Underlying error: " + (err && err.message ? err.message : String(err)) : "")
    );
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
      // Idempotency guard. mountDOM() unconditionally appends a fresh
      // <runhq-widget-host> to document.body, so a second init() — from a
      // duplicate <script> tag, RunHQ's preview auto-inject layered on top
      // of an already-embedded widget, or a SPA re-running init() on
      // client-side navigation — would stack a second widget behind the
      // first. The mounted host element is the source of truth (not a JS
      // flag), so a host page that removes the widget can still re-init.
      if (document.querySelector("runhq-widget-host")) {
        console.warn(
          "RunHQWidget.init: a widget is already mounted on this page; ignoring duplicate init()."
        );
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
        // Explicit opt-in for the RunHQ-member cookie auth path. When true,
        // widget fetches use `credentials: include` and the server is
        // expected to have this origin in `widget_projects.allowed_origins`.
        // When false (default), the widget operates wide-open without
        // credentials — same envelope as before this feature shipped.
        useCookieAuth: !!opts.useCookieAuth,
        // Resolved by /api/widget/identity below. Until then, authHeaders()
        // uses the legacy token-or-slug heuristic so the bootstrap probe
        // itself can authenticate.
        identitySource: null,
        csrfToken: null,
        identityName: null,
        identityAvatar: null,
        // Chat home-card config. Populated from the bootstrap payload
        // (`chat: { enabled, agentName }`) once a support agent is
        // configured in widget settings (server side ships separately).
        // Absent ⇒ null ⇒ the home chat card stays hidden.
        chat: null,
      };

      hookConsole();

      // Identity probe runs FIRST so subsequent calls (loadTopTickets,
      // loadMyTickets, etc.) carry the right header set. Failure resolves
      // to null identity — same effect as today's anon path.
      var identityP = loadIdentity()
        .then(function (idData) {
          var src = idData && idData.identity && idData.identity.source;
          if (src === "runhq" || src === "app") {
            config.identitySource = src;
            config.csrfToken = (idData && idData.csrfToken) || null;
            config.identityName = (idData && idData.identity && idData.identity.displayName) || null;
            config.identityAvatar = (idData && idData.identity && idData.identity.avatarUrl) || null;
            // Pre-populate currentUser from the same response so the triager
            // badge appears on first render without waiting for /api/widget/me.
            currentUser.permissions = (idData && idData.permissions) || [];
            currentUser.matchedRoles = (idData && idData.matchedRoles) || [];
            currentUser.isTriager = !!(idData && idData.isTriager);
          } else if (config.token) {
            // A token WAS supplied to init() but identity didn't resolve —
            // i.e. the embed is misimplemented. Do NOT silently degrade to
            // anonymous: capture the server's classification and report it
            // loudly (console) + visibly (submit reason) so it's debuggable.
            reportWidgetAuthError((idData && idData.authError) || "no_identity");
          }
        })
        .catch(function (err) {
          // Credentialed CORS fails hard when an owner copied a cookie-auth
          // snippet onto a non-allowlisted origin. Drop back to the legacy
          // non-credentialed envelope before loading public/app-token data.
          config.useCookieAuth = false;
          // The identity probe itself failed (network / CORS / blocked
          // header). With a token supplied that's a misimplementation, not
          // anonymous — surface it instead of swallowing.
          if (config.token) reportWidgetAuthError("identity_request_failed", err);
        });

      identityP.then(function () { return loadTopTickets(); }).then(function (data) {
        topTicketsCache = data.tickets || [];
        config.projectId = data.projectSlug || config.project;
        config.projectName = data.projectName || config.project;
        config.isIdentified = !!data.isIdentified;
        config.isPublic = !!data.isPublic;
        // Login URL is only present in the response when the caller is an
        // anonymous viewer of a public project. Authed users get null.
        config.loginUrl = data.loginUrl || null;
        // Chat home-card gating — see renderHomeView. Absent or
        // `enabled: false` ⇒ the card is hidden.
        config.chat = data.chat || null;
        // Image-attach affordances are gated server-side (currently off).
        config.attachmentsEnabled = !!data.attachmentsEnabled;
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

        // Authenticated viewers (app token OR runhq cookie) get their own
        // ticket list. Pure-anon viewers only get the public update feed.
        if (config.isIdentified) {
          loadMyTickets().then(function (d) { myTicketsCache = d.tickets || []; refreshTabLabel(); }).catch(function () {});
          loadUpdates().then(function (d) { updatesCache = d.tickets || []; refreshTabLabel(); }).catch(function () {});
          // Open the real-time unread stream for the page lifetime so the
          // launcher pill lights up even while the widget is closed.
          startNotificationsStream();
        } else {
          myTicketsCache = [];
          assignedTicketsCache = [];
          loadUpdates().then(function (d) { updatesCache = d.tickets || []; refreshTabLabel(); }).catch(function () { updatesCache = []; });
        }

        // If we redirected an anon user to the login URL on a previous page
        // load and they came back authenticated, restore their draft (or
        // navigate them to the ticket they were about to vote on). Only
        // applies when the saved intent matches the current project — this
        // prevents drafts written for project A from leaking into project B.
        var savedIntent = readIntent();
        if (savedIntent && config.isIdentified
            && savedIntent.projectSlug === (config.projectId || config.project)) {
          clearIntent();
          // Deep-link/restore opens bypass Home: the user is mid-action
          // (draft submit, vote, comment), so land straight on the view
          // that can receive the intent. Draft restore lands on the compose
          // face (compact from the first frame); vote/comment land on the
          // list (expanded) and applyIntent escalates list → detail itself.
          view = savedIntent.type === "submit-ticket" ? "compose" : "list";
          openPanel(function () { applyIntent(savedIntent); });
        }
      }).catch(function (err) {
        console.error("RunHQWidget: failed to initialize", err);
      });
    },
    // Opens the panel directly onto the agent-chat view. Public so host
    // pages can deep-link into chat, alongside the Home screen's "Chat
    // with Agent" card.
    openChat: function () {
      if (!widgetEl) {
        console.warn("RunHQWidget.openChat: widget is not initialized yet.");
        return;
      }
      openPanel(function () { openChat(); });
    },
  };

  // ---------------------------------------------------------------------------
  // Test-only hook — zero production impact; never called by the widget itself.
  // When the host context sets window._rwTestHooks to a plain object before the
  // IIFE runs, we populate it with internal functions so vm-based tests can
  // drive the real rendering code without a full browser environment.
  // ---------------------------------------------------------------------------
  if (window._rwTestHooks && typeof window._rwTestHooks === "object") {
    window._rwTestHooks.renderDetailInto = renderDetailInto;
    window._rwTestHooks.renderAttachChip = renderAttachChip;
    window._rwTestHooks.releaseAttachPreview = releaseAttachPreview;
    window._rwTestHooks.stagedGallery = stagedGallery;
    window._rwTestHooks.renderLiveSessionIntro = renderLiveSessionIntro;
    window._rwTestHooks.renderChatTeamRow = renderChatTeamRow;
    window._rwTestHooks.renderChatEventRow = renderChatEventRow;
    window._rwTestHooks.renderChatProposalCard = renderChatProposalCard;
    window._rwTestHooks.statusMeta = statusMeta;
    window._rwTestHooks.renderStatusChip = renderStatusChip;
    window._rwTestHooks.setDeployEnvironments = setDeployEnvironments;
    // Seed the closure state the live-session intro reads (ticket + chat config),
    // so a vm test can render it without bootstrapping the whole widget.
    window._rwTestHooks._setLiveSessionState = function (ticket, chatConfig) {
      liveSessionTicket = ticket;
      if (chatConfig) config.chat = chatConfig;
    };
    // Seed the active conversation so a vm test can drive the proposal card's
    // Create action (which posts to chatCreateTicket against the conversation).
    window._rwTestHooks._setChatConversation = function (conv) {
      chatConversation = conv;
    };
    // Toggle the live-session flag so a vm test can assert that intake proposal
    // cards are non-actionable in the staff-to-coder relay surface.
    window._rwTestHooks._setChatIsLiveSession = function (on) {
      chatIsLiveSession = !!on;
    };
    // Unread-badge test helpers: expose the badge counter, the seen-marker, and
    // direct cache setters so vm tests can drive the full seen/unseen lifecycle
    // without bootstrapping the full network layer.
    window._rwTestHooks.launcherBadgeCount = launcherBadgeCount;
    window._rwTestHooks.markTicketSeen = markTicketSeen;
    window._rwTestHooks.markLiveSessionSeen = markLiveSessionSeen;
    window._rwTestHooks.markAllTicketsRead = markAllTicketsRead;
    window._rwTestHooks.hasUnreadLiveSession = hasUnreadLiveSession;
    window._rwTestHooks.viewerCanLiveCoder = viewerCanLiveCoder;
    window._rwTestHooks._setCaches = function (mine, assigned) {
      myTicketsCache = mine || [];
      assignedTicketsCache = assigned || [];
    };
    // Expose config + currentUser references so tests can set isIdentified /
    // permissions without going through the full identity-fetch flow.
    window._rwTestHooks._setConfig = function (updates) {
      Object.assign(config, updates);
    };
    window._rwTestHooks._setCurrentUser = function (updates) {
      Object.assign(currentUser, updates);
    };
  }

})();
