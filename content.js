// Runs on claude.ai pages.
//
// Reports to the background worker:
//   * the URL of the tab  -> the conversation id (`/chat/<uuid>`)
//   * document.cookie     -> `lastActiveOrg` (the organization id) and friends
//   * a fallback scan of the page for ids that are not in the URL
//
// It also executes the conversation request from the page context, so the
// browser sends the real cookies automatically.

(function () {
  // Do not register twice when the script is injected again by the
  // background worker.
  if (window.__claudeVariablesExtractor) return;
  window.__claudeVariablesExtractor = true;

  // Only headers that a fetch() is allowed to set. The browser supplies
  // accept / accept-language / user-agent / referer / cookie itself.
  const SETTABLE_HEADERS = new Set([
    'anthropic-anonymous-id',
    'anthropic-client-build',
    'anthropic-client-capabilities',
    'anthropic-client-platform',
    'anthropic-client-sha',
    'anthropic-client-version',
    'anthropic-device-id',
    'x-activity-session-id',
    'content-type',
    'priority',
  ]);

  const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

  let lastUrl = null;
  let lastCookie = null;

  function send(msg) {
    try {
      chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
    } catch (e) {
      /* extension context invalid */
    }
  }

  // --- page state ---------------------------------------------------------

  function readCookie() {
    try {
      return document.cookie || '';
    } catch (e) {
      return '';
    }
  }

  // Best-effort: look for ids in the rendered page. Used when the URL does
  // not carry them (for example right after a new chat was created).
  //
  // Only the organization id is scanned here: the page contains links to
  // *other* conversations (the sidebar), so a `/chat/<uuid>` match would
  // happily return a completely different conversation. The conversation id
  // comes from the URL of the tab instead.
  function scanDocument() {
    const out = {};
    let html = '';
    try {
      html = document.documentElement ? document.documentElement.innerHTML : '';
    } catch (e) {
      html = '';
    }
    if (html.length > 400000) html = html.slice(0, 400000);

    const org =
      html.match(new RegExp('"lastActiveOrg"\\s*:\\s*"(' + UUID + ')"')) ||
      html.match(new RegExp('"organization_?id"\\s*:\\s*"(' + UUID + ')"')) ||
      html.match(new RegExp('/api/organizations/(' + UUID + ')'));
    if (org) out.organizations = org[1];

    return out;
  }

  // Best-effort: look for a build id / commit sha in loaded resource URLs.
  function scanResources() {
    const out = {};
    try {
      const urls = performance
        .getEntriesByType('resource')
        .map((r) => r.name)
        .filter((n) => /\.js(\?|$)/.test(n));
      for (const u of urls) {
        const sha = u.match(/([0-9a-f]{40})/);
        if (sha && !out.sha) out.sha = sha[1];
        const build = u.match(/build[-_]?(\d{6,})/i) || u.match(/(\d{10})/);
        if (build && !out.build) out.build = build[1];
      }
    } catch (e) {
      /* ignore */
    }
    return out;
  }

  // The current state of the page, in the shape the background worker wants.
  function collect() {
    const url = location.href;
    const cookie = readCookie();
    const data = Object.assign({ url, cookie }, scanDocument(), scanResources());
    return data;
  }

  function pushContext(force) {
    const url = location.href;
    const cookie = readCookie();
    if (!force && url === lastUrl && cookie === lastCookie) return;
    lastUrl = url;
    lastCookie = cookie;
    send({ type: 'page-context', ...collect() });
  }

  // --- navigation tracking ------------------------------------------------
  // claude.ai is a single page app: a new conversation only changes the URL
  // (history.pushState), which fires neither popstate nor hashchange. The
  // URL is therefore polled.
  pushContext(true);
  window.addEventListener('popstate', () => pushContext(true));
  window.addEventListener('hashchange', () => pushContext(true));
  window.addEventListener('pageshow', () => pushContext(true));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) pushContext(true);
  });
  window.addEventListener('focus', () => pushContext(true));

  setInterval(() => pushContext(false), 500);

  // Best-effort fallbacks for the client build / sha.
  setTimeout(() => send({ type: 'page-fallbacks', ...scanResources(), ...scanDocument() }), 1200);
  setTimeout(() => send({ type: 'page-fallbacks', ...scanResources(), ...scanDocument() }), 4000);

  // --- message handling ---------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return false;

    // The background worker asks for the current state of the tab.
    if (msg.type === 'get-context') {
      pushContext(true);
      sendResponse(collect());
      return false;
    }

    if (msg.type !== 'do-fetch') return false;

    (async () => {
      const headers = {};
      for (const [key, value] of Object.entries(msg.headers || {})) {
        const k = key.toLowerCase();
        if (SETTABLE_HEADERS.has(k) && value) headers[key] = value;
      }

      try {
        const res = await fetch(msg.url, {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
          headers,
        });
        const body = await res.text();
        sendResponse({
          ok: res.ok,
          status: res.status,
          statusText: res.statusText,
          body,
          url: msg.url,
        });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();

    return true; // async response
  });
})();
