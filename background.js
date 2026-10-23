// Background service worker.
// Captures live Claude.ai session variables from real browser traffic.
//
// Every captured field carries the source it came from. A new value only
// replaces an existing one when its source has an equal or higher priority
// (see SOURCE_PRIORITY in lib/parse.js). That way a fresh session replaces
// the values of the previous one, while a value typed by the user in the
// popup is never overwritten.

import {
  HEADER_FIELDS,
  COOKIE_FIELDS,
  headerMap,
  normalizeSecChUa,
  parseIdsFromUrl,
  sanitizeCookie,
  setField,
  withDefaults,
  applyPageContext,
  applyCookieHeader,
  applyRequestIds,
} from './lib/parse.js';

const STORAGE_KEY = 'claudeCapture';
const HISTORY_KEY = 'claudeCaptureHistory';
const MAX_HISTORY = 20;

// The cookie API is queried for every origin claude.ai uses.
const COOKIE_URLS = ['https://claude.ai/', 'https://www.claude.ai/'];
// The cookie jar is read at most every few seconds - it only changes when
// the session is renewed.
const JAR_TTL = 4000;
let lastJarRead = 0;
// Requests are counted, so the popup can show whether the observer works at
// all. The counter is written at most every few seconds.
const COUNTER_TTL = 5000;
let lastPersist = 0;

// All capture work is serialized. Without this, two requests arriving at the
// same time could each read the old state and the second write would drop
// the update of the first one.
let chain = Promise.resolve();
function enqueue(task) {
  const run = chain.then(task, task);
  chain = run.then(
    () => {},
    () => {}
  );
  return run;
}

async function getCapture() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const cap = stored[STORAGE_KEY];
  if (cap && typeof cap === 'object') return cap;
  return { fields: {}, rawHeaders: {}, url: '', requestUrl: '', ts: 0, requests: 0 };
}

async function persist(cap) {
  lastPersist = Date.now();
  await chrome.storage.local.set({ [STORAGE_KEY]: cap });
  const stored = await chrome.storage.local.get(HISTORY_KEY);
  const history = Array.isArray(stored[HISTORY_KEY]) ? stored[HISTORY_KEY] : [];
  history.unshift({
    ts: cap.ts,
    url: cap.url,
    fields: Object.fromEntries(
      Object.entries(cap.fields).map(([k, v]) => [k, v.value])
    ),
  });
  await chrome.storage.local.set({ [HISTORY_KEY]: history.slice(0, MAX_HISTORY) });
}

// ---------------------------------------------------------------------------
// Cookie capture
// ---------------------------------------------------------------------------
// Reads the real cookie jar. `lastActiveOrg` holds the organization (workspace)
// uuid, `activitySessionId` the session id, `ajs_anonymous_id` the anonymous
// id and `anthropic-device-id` the device id.
async function readCookieJar() {
  const jar = [];
  for (const url of COOKIE_URLS) {
    let list = [];
    try {
      list = await chrome.cookies.getAll({ url });
    } catch (e) {
      list = [];
    }
    for (const c of list) {
      if (!c || !c.name) continue;
      const known = jar.find((x) => x.name === c.name && x.domain === c.domain);
      if (!known) jar.push(c);
    }
  }
  return jar;
}

// Read the cookie jar through the cookies API, but not more often than
// every JAR_TTL milliseconds.
async function readCookieJarIfStale() {
  const now = Date.now();
  if (now - lastJarRead < JAR_TTL) return [];
  lastJarRead = now;
  return readCookieJar();
}

// ---------------------------------------------------------------------------
// 1. Passive capture of the app's own requests
// ---------------------------------------------------------------------------
chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    if (!details.requestHeaders) return;
    enqueue(() => captureRequest(details));
  },
  { urls: ['https://claude.ai/*', 'https://*.claude.ai/*'] },
  ['requestHeaders', 'extraHeaders']
);

async function captureRequest(details) {
  const cap = await getCapture();
  const fields = cap.fields || {};
  const map = headerMap(details.requestHeaders);

  // Only write to storage when something actually changed - claude.ai issues a
  // lot of requests and most of them carry no new information.
  let changed = false;
  const put = (key, value, source) => {
    if (setField(fields, key, value, source)) changed = true;
  };

  // --- plain headers ------------------------------------------------------
  for (const [header, key] of Object.entries(HEADER_FIELDS)) {
    let value = map[header];
    if (key === 'sec-ch-ua') {
      const brand = normalizeSecChUa(value);
      if (brand) {
        put(key, brand, 'header');
        continue;
      }
      value = undefined;
    }
    if (value !== undefined) put(key, value, 'header');
  }

  // A request that carries the app's own headers (`anthropic-client-sha` and
  // friends) is the interesting one - it replaces the raw header set.
  // Everything else is merged in, so a static asset request cannot wipe the
  // captured anthropic headers.
  const hasAppHeaders = Boolean(
    map['anthropic-client-sha'] ||
      map['anthropic-client-build'] ||
      map['anthropic-client-version']
  );

  // The Cookie request header is the exact string the server received.
  // The raw value stays in rawHeaders; the exported field is sanitized.
  // The header of an api request is preferred: it contains exactly the
  // cookies that are sent to /api/... (the cookie jar of the root url does
  // not contain cookies that are scoped to /api/).
  const rawCookie = map['cookie'];
  if (rawCookie) {
    put(
      'cookie',
      sanitizeCookie(rawCookie),
      hasAppHeaders ? 'request-header' : 'request-header-asset'
    );
    if (applyCookieHeader(fields, rawCookie)) changed = true;
  }

  // --- ids ----------------------------------------------------------------
  // 1. from the request URL (`/api/organizations/<org>/chat_conversations/<id>`)
  // 2. from the referer header - `https://claude.ai/chat/<conversation id>`
  const referer = map['referer'] || map['referrer'];
  if (applyRequestIds(fields, details.url, referer)) changed = true;

  // --- cookie jar ---------------------------------------------------------
  // The request header already carried the cookies we need. The cookie API is
  // only consulted as a supplement (throttled, it is an async call per
  // request) - it is the only way to see cookies the request did not send.
  const jar = await readCookieJarIfStale();
  for (const cookie of jar) {
    const key = COOKIE_FIELDS[cookie.name];
    if (!key) continue;
    put(key, cookie.value, 'cookie:' + cookie.name);
  }
  if (jar.length) {
    const jarString = jar.map((c) => `${c.name}=${c.value}`).join('; ');
    put('cookie', sanitizeCookie(jarString), 'cookie-jar');
  }

  // --- raw headers --------------------------------------------------------
  const rawHeaders = hasAppHeaders
    ? { ...map }
    : { ...(cap.rawHeaders || {}), ...map };
  if (JSON.stringify(rawHeaders) !== JSON.stringify(cap.rawHeaders || {})) {
    cap.rawHeaders = rawHeaders;
    changed = true;
  }

  cap.fields = fields;
  cap.requests = (cap.requests || 0) + 1;
  if (cap.requestUrl !== details.url) {
    cap.requestUrl = details.url;
    changed = true;
  }
  if (/^https:\/\/(?:www\.)?claude\.ai\/chat\//.test(details.url)) {
    if (cap.url !== details.url) {
      cap.url = details.url;
      changed = true;
    }
  } else if (!cap.url) {
    cap.url = details.url;
    changed = true;
  }

  // Nothing new - do not hammer the storage. The request counter is
  // refreshed every few seconds anyway.
  const now = Date.now();
  if (!changed && now - lastPersist < COUNTER_TTL) return;
  cap.ts = now;
  await persist(cap);
}

// ---------------------------------------------------------------------------
// 2. Page context messages (URL, document.cookie, fallback discovery)
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;

  if (msg.type === 'page-context') {
    enqueue(async () => {
      const cap = await getCapture();
      const fields = cap.fields || {};
      applyPageContext(fields, msg);
      cap.url = msg.url || cap.url;
      cap.fields = fields;
      cap.ts = Date.now();
      await persist(cap);
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === 'page-fallbacks') {
    enqueue(async () => {
      const cap = await getCapture();
      const fields = cap.fields || {};
      applyPageContext(fields, msg);
      cap.fields = fields;
      cap.ts = Date.now();
      await persist(cap);
      sendResponse({ ok: true });
    });
    return true;
  }

  // Ask every claude.ai tab for its current URL + cookies. Used when the
  // popup is opened, so a tab that was already open before the extension was
  // installed still contributes its ids.
  if (msg.type === 'scan-tabs') {
    enqueue(async () => {
      try {
        const tabs = await chrome.tabs.query({
          url: ['https://claude.ai/*', 'https://*.claude.ai/*'],
        });
        // The active tab comes first, so its conversation wins over the one
        // of a background tab.
        const ordered = [...tabs].sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));

        for (const tab of ordered) {
          const data = await askTabForContext(tab.id);
          if (!data) continue;
          const cap = await getCapture();
          const fields = cap.fields || {};
          applyPageContext(fields, data);
          cap.url = data.url || cap.url;
          cap.fields = fields;
          cap.ts = Date.now();
          await persist(cap);
          // One tab with a conversation is enough.
          if (parseIdsFromUrl(data.url).chat_conversations) break;
        }
        sendResponse({ ok: true, tabs: tabs.length });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    });
    return true;
  }

  // Drop everything that was captured (including manual overrides and history).
  if (msg.type === 'reset-capture') {
    enqueue(async () => {
      await chrome.storage.local.set({
        [STORAGE_KEY]: {
          fields: withDefaults({}),
          rawHeaders: {},
          url: '',
          requestUrl: '',
          ts: 0,
          requests: 0,
        },
        [HISTORY_KEY]: [],
      });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === 'run-request') {
    enqueue(async () => {
      try {
        const tabs = await chrome.tabs.query({
          url: ['https://claude.ai/*', 'https://*.claude.ai/*'],
        });
        const tab =
          tabs.find((t) => /claude\.ai\/chat\//.test(t.url || '')) || tabs[0];
        if (!tab) {
          sendResponse({ ok: false, error: 'No claude.ai tab is open.' });
          return;
        }

        let res;
        try {
          res = await chrome.tabs.sendMessage(tab.id, {
            type: 'do-fetch',
            url: msg.url,
            headers: msg.headers,
          });
        } catch (e) {
          // Content script not injected yet (tab was open before install).
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content.js'],
          });
          res = await chrome.tabs.sendMessage(tab.id, {
            type: 'do-fetch',
            url: msg.url,
            headers: msg.headers,
          });
        }

        sendResponse(res || { ok: false, error: 'No response from the page.' });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    });
    return true;
  }

  if (msg.type === 'get-capture') {
    getCapture().then((cap) => {
      cap.fields = withDefaults(cap.fields);
      sendResponse(cap);
    });
    return true;
  }

  return false;
});

// Ask a tab for its current URL + document.cookie, injecting the content
// script first when it is not there yet.
async function askTabForContext(tabId) {
  const request = { type: 'get-context' };
  try {
    const res = await chrome.tabs.sendMessage(tabId, request);
    if (res && res.url) return res;
  } catch (e) {
    /* not injected yet */
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
  } catch (e) {
    return null;
  }
  try {
    const res = await chrome.tabs.sendMessage(tabId, request);
    if (res && res.url) return res;
  } catch (e) {
    /* ignore */
  }
  return null;
}

// ---------------------------------------------------------------------------
// 3. Bootstrapping
// ---------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(async () => {
  const cap = await getCapture();
  cap.fields = withDefaults(cap.fields);
  await chrome.storage.local.set({ [STORAGE_KEY]: cap });
});

chrome.runtime.onStartup.addListener(async () => {
  const stored = await chrome.storage.local.get(HISTORY_KEY);
  if (!stored[HISTORY_KEY]) await chrome.storage.local.set({ [HISTORY_KEY]: [] });
});
