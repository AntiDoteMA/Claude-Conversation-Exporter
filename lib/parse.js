// Pure helpers shared by the background worker, the popup and the self-test.
// No chrome.* APIs here so it can be unit tested under Node.

export const HEADER_FIELDS = {
  'anthropic-anonymous-id': 'anthropic-anonymous-id',
  'anthropic-client-build': 'anthropic-client-build',
  'anthropic-client-sha': 'anthropic-client-sha',
  'anthropic-client-version': 'anthropic-client-version',
  'anthropic-client-capabilities': 'anthropic-client-capabilities',
  'anthropic-client-platform': 'anthropic-client-platform',
  'anthropic-device-id': 'anthropic-device-id',
  'x-activity-session-id': 'x-activity-session-id',
  'user-agent': 'user-agent',
  'sec-ch-ua': 'sec-ch-ua',
  'sec-ch-ua-mobile': 'sec-ch-ua-mobile',
  'sec-ch-ua-platform': 'sec-ch-ua-platform',
};

// Cookie name -> field key. `lastActiveOrg` is the organization (workspace)
// uuid of the active claude.ai account.
export const COOKIE_FIELDS = {
  ajs_anonymous_id: 'anthropic-anonymous-id',
  'anthropic-device-id': 'anthropic-device-id',
  activitySessionId: 'x-activity-session-id',
  lastActiveOrg: 'organizations',
};

export const DEFAULTS = {
  'anthropic-client-version': '1.0.0',
  'anthropic-client-capabilities': 'mfa_sms_v1, mfa_email_v1',
  'anthropic-client-platform': 'web_claude_ai',
  'sec-ch-ua': 'Not)A;Brand',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': 'Windows',
};

// ---------------------------------------------------------------------------
// Capture source priorities
// ---------------------------------------------------------------------------
// A captured value is only replaced when the new source has a priority >= the
// priority of the value that is already stored. This is what keeps a stale
// value from an earlier session from surviving a new one, while still letting
// the most authoritative source win.
//
//   page-url      the URL of the tab the user is looking at (ground truth)
//   request-url   the URL of a live /api/... request
//   cookie:*      the value of a cookie read through the cookies API
//   referer       the `referer` request header (contains /chat/<uuid>)
//   header        a request header of a live request
//   request-header  the raw `Cookie` request header
//   page-cookie   document.cookie as seen by the page itself
//   script-scan   a fallback scan of the loaded page
//   manual        typed by the user in the popup - never overwritten
export const SOURCE_PRIORITY = {
  manual: 100,
  'page-url': 90,
  'request-url': 80,
  'cookie:lastActiveOrg': 75,
  'page-cookie:lastActiveOrg': 72,
  referer: 70,
  header: 60,
  cookie: 60,
  'request-header': 60,
  'request-header-asset': 58,
  'cookie-jar': 55,
  'page-cookie': 50,
  'script-scan': 40,
};

export function sourcePriority(source) {
  if (!source) return 0;
  if (Object.prototype.hasOwnProperty.call(SOURCE_PRIORITY, source)) {
    return SOURCE_PRIORITY[source];
  }
  const idx = source.indexOf(':');
  if (idx === -1) return 0;
  const base = source.slice(0, idx);
  const name = source.slice(idx + 1);
  if (base === 'cookie') {
    return name === 'lastActiveOrg'
      ? SOURCE_PRIORITY['cookie:lastActiveOrg']
      : SOURCE_PRIORITY['cookie'];
  }
  if (base === 'page-cookie') {
    return name === 'lastActiveOrg'
      ? SOURCE_PRIORITY['page-cookie:lastActiveOrg']
      : SOURCE_PRIORITY['page-cookie'];
  }
  return 0;
}

// Store a captured value in `fields` (a map of key -> {value, source, ts}).
//
// A value is only replaced when the new source is at least as authoritative
// as the source of the stored value. Equal priority always wins, so a new
// session replaces the values of the previous one - that is what makes the
// extractor follow a conversation that was just created.
export function setField(fields, key, value, source) {
  if (value === undefined || value === null || value === '') return false;
  const str = String(value);
  const existing = fields[key];
  const newPriority = sourcePriority(source);

  if (existing) {
    const curPriority = sourcePriority(existing.source);
    // A less authoritative source must not overwrite a better one.
    if (newPriority < curPriority) return false;
    // Same priority and same value: nothing to do.
    if (newPriority === curPriority && existing.value === str) {
      existing.ts = Date.now();
      return false;
    }
  }

  fields[key] = { value: str, source, ts: Date.now() };
  return true;
}

// ---------------------------------------------------------------------------
// URL / id parsing
// ---------------------------------------------------------------------------
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const LOOSE_UUID = '[0-9a-zA-Z]{8}-[0-9a-zA-Z]{4}-[0-9a-zA-Z]{4}-[0-9a-zA-Z]{4}-[0-9a-zA-Z]{12}';
const ANY_ID = '[0-9a-fA-F-]{16,}';
// A path segment that looks like an id. The segment is always bounded by a
// slash, so this cannot swallow anything but the id itself.
const ID_SEGMENT = '[0-9a-zA-Z][0-9a-zA-Z_-]{7,}';

const ORG_PATH_RE = new RegExp(`/api/organizations/(${ID_SEGMENT}|${UUID}|${LOOSE_UUID}|${ANY_ID})`);
const CHAT_PATH_RE = new RegExp(
  `/(?:chat|chat_conversations|conversation)/(${ID_SEGMENT}|${UUID}|${LOOSE_UUID}|${ANY_ID})`
);

export function headerMap(headers) {
  const map = {};
  if (!headers) return map;
  for (const h of headers) {
    if (!h || !h.name) continue;
    const k = h.name.toLowerCase();
    if (!(k in map)) map[k] = h.value;
  }
  return map;
}

// Normalize a raw `sec-ch-ua` header into the single brand token used by the
// Readme template, e.g.
//   "Chromium";v="138", "Not)A;Brand";v="24", "Google Chrome";v="138"
// -> Not)A;Brand
export function normalizeSecChUa(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  // Brand-only form as used in the Readme, e.g. `Not)A;Brand`.
  // (Note the ';' inside the brand token - do not split on it.)
  if (!s.includes('"') && !/;\s*v\s*=/i.test(s)) return s || null;

  const known = [
    'chromium',
    'google chrome',
    'microsoft edge',
    'safari',
    'firefox',
    'opera',
    'google chrome mobile',
  ];
  for (const part of s.split(',')) {
    const m = part.match(/^\s*"([^"]+)"/) || part.match(/^\s*([^;]+)/);
    if (!m) continue;
    const brand = m[1].trim();
    if (!brand) continue;
    if (!known.includes(brand.toLowerCase())) return brand;
  }
  return null;
}

// Extract the organization / conversation ids out of any URL.
// Works for the page URL (`/chat/<uuid>`), the API URL
// (`/api/organizations/<uuid>/chat_conversations/<uuid>`) and the `referer`
// header (`https://claude.ai/chat/<uuid>`).
export function parseIdsFromUrl(url) {
  const out = {};
  if (!url) return out;
  let u;
  try {
    u = new URL(String(url));
  } catch {
    // Not an absolute URL - try to read it as a path.
    if (!/\/(?:chat|chat_conversations|api\/organizations)\//.test(String(url))) {
      return out;
    }
    u = { pathname: String(url), searchParams: new URLSearchParams() };
  }

  const path = u.pathname || '';

  const orgMatch = path.match(ORG_PATH_RE);
  if (orgMatch) out.organizations = orgMatch[1];

  // `/chat/<id>` on the page, `/chat_conversations/<id>` on the API.
  const chatMatch = path.match(CHAT_PATH_RE);
  if (chatMatch) out.chat_conversations = chatMatch[1];

  const params = u.searchParams || new URLSearchParams();
  const orgQuery = params.get('organization') || params.get('org');
  if (orgQuery && !out.organizations) out.organizations = orgQuery;

  return out;
}

// ---------------------------------------------------------------------------
// Claude Code sessions
// ---------------------------------------------------------------------------
// A Claude Code session lives at `https://claude.ai/code/session_<id>`. Its
// history is not a chat conversation: it is a list of events, served newest
// first in pages by `/v1/code/sessions/<id>/events`. Each page carries a
// `next_cursor`; the last page has none (or no events at all).

// The API of the session endpoints requires this header.
export const CODE_API_VERSION = '2023-06-01';
export const CODE_EVENTS_PAGE_SIZE = 200;

const CODE_SESSION_PATH_RE = /^\/code\/(session_[0-9A-Za-z]+)(?:[/?#]|$)/;

// The Claude Code session id of a claude.ai URL, or null.
export function parseCodeSessionId(url) {
  if (!url) return null;
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return null;
  }
  if (!/(^|\.)claude\.ai$/.test(u.hostname)) return null;
  const m = u.pathname.match(CODE_SESSION_PATH_RE);
  return m ? m[1] : null;
}

export function codeSessionUrl(sessionId) {
  return `https://claude.ai/v1/code/sessions/${encodeURIComponent(sessionId)}`;
}

export function codeSessionEventsUrl(sessionId, cursor) {
  let url = `${codeSessionUrl(sessionId)}/events?limit=${CODE_EVENTS_PAGE_SIZE}&sort_order=desc`;
  if (cursor !== undefined && cursor !== null && cursor !== '') {
    url += `&cursor=${encodeURIComponent(cursor)}`;
  }
  return url;
}

// The cursor of the page after `page`, or null when `page` was the last one.
// A cursor that does not move would loop forever, so it also ends the export.
export function nextCodeEventsCursor(page, previousCursor) {
  if (!page || !Array.isArray(page.data) || !page.data.length) return null;
  const next = page.next_cursor;
  if (next === undefined || next === null || next === '') return null;
  if (String(next) === String(previousCursor)) return null;
  return String(next);
}

// Merge the event pages into one list in the order they happened. An event
// that shows up on two pages (the session kept running during the export) is
// kept once.
export function mergeCodeSessionEvents(pages) {
  const byId = new Map();
  for (const page of pages || []) {
    for (const event of (page && page.data) || []) {
      if (!event) continue;
      const key = event.event_id || `seq:${event.sequence_num}`;
      if (!byId.has(key)) byId.set(key, event);
    }
  }
  return [...byId.values()].sort(
    (a, b) => Number(a.sequence_num) - Number(b.sequence_num)
  );
}

// Merge the state reported by a claude.ai tab (URL + document.cookie +
// fallback scan) into the captured fields. Returns true when something
// changed.
export function applyPageContext(fields, data) {
  if (!data) return false;
  let changed = false;
  const put = (key, value, source) => {
    if (setField(fields, key, value, source)) changed = true;
  };
  const url = data.url || '';

  // The URL of the tab is the ground truth for the conversation id: claude.ai
  // is a single page app, so a new conversation changes only the URL.
  for (const [key, value] of Object.entries(parseIdsFromUrl(url))) {
    put(key, value, 'page-url');
  }

  // document.cookie - the page can read `lastActiveOrg` even when the
  // chrome.cookies API is not available for the site.
  const cookieStr = data.cookie || '';
  if (cookieStr) {
    put('cookie', sanitizeCookie(cookieStr), 'page-cookie');
    const jar = parseCookieString(cookieStr);
    for (const [name, value] of Object.entries(jar)) {
      const key = COOKIE_FIELDS[name];
      if (!key) continue;
      put(key, value, 'page-cookie:' + name);
    }
  }

  // Fallback scan of the page for ids that are not in the URL or the cookies.
  if (data.organizations) {
    put('organizations', data.organizations, 'script-scan');
  }
  if (data.chat_conversations) {
    put('chat_conversations', data.chat_conversations, 'script-scan');
  }
  if (data.sha) put('anthropic-client-sha', data.sha, 'script-scan');
  if (data.build) put('anthropic-client-build', data.build, 'script-scan');

  return changed;
}

// Merge the values of a `Cookie` request header into the captured fields.
export function applyCookieHeader(fields, rawCookie) {
  if (!rawCookie) return false;
  let changed = false;
  const jar = parseCookieString(rawCookie);
  for (const [name, value] of Object.entries(jar)) {
    const key = COOKIE_FIELDS[name];
    if (!key) continue;
    if (setField(fields, key, value, 'cookie:' + name)) changed = true;
  }
  return changed;
}

// Merge the ids of a request URL and of a `referer` header into the fields.
export function applyRequestIds(fields, requestUrl, referer) {
  let changed = false;
  for (const [key, value] of Object.entries(parseIdsFromUrl(requestUrl))) {
    if (setField(fields, key, value, 'request-url')) changed = true;
  }
  if (referer) {
    if (setField(fields, 'referer', referer, 'referer')) changed = true;
    for (const [key, value] of Object.entries(parseIdsFromUrl(referer))) {
      if (setField(fields, key, value, 'referer')) changed = true;
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------
// Parse a cookie string (`document.cookie` or a `Cookie` request header) into
// a plain object. Values may contain `=` (base64 padding), so only the first
// `=` separates name and value.
export function parseCookieString(str) {
  const out = {};
  if (!str) return out;
  for (const part of String(str).split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const name = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (name) out[name] = value;
  }
  return out;
}

// Look up a single cookie in a cookie string.
export function cookieValue(str, name) {
  return parseCookieString(str)[name];
}

// A double quote inside a cookie value breaks the `-b "..."` argument of the
// curl command, so every double quote is replaced by a single quote.
export function sanitizeCookie(value) {
  if (value === undefined || value === null) return value;
  return String(value).replace(/"/g, "'");
}

// Substitute ##placeholders## in the curl template.
export function fillTemplate(template, values) {
  return String(template).replace(/##([a-z0-9_-]+)##/gi, (match, key) => {
    const v = values[key];
    return v === undefined || v === null ? '' : String(v);
  });
}

// Parse a curl command back into its request parts, so the exact same
// request can be executed in the page context.
export function parseCurl(cmd) {
  const out = { url: '', headers: {}, cookie: '' };
  const text = String(cmd || '').trim();

  // The first double quoted token is the URL.
  const urlMatch = text.match(/"([^"]+)"/);
  if (urlMatch) out.url = urlMatch[1];

  // -H "name: value"
  const hre = /-H\s+"([^"]*)"/g;
  let m;
  while ((m = hre.exec(text)) !== null) {
    const idx = m[1].indexOf(':');
    if (idx === -1) continue;
    out.headers[m[1].slice(0, idx).trim().toLowerCase()] = m[1].slice(idx + 1).trim();
  }

  // -b "cookie"
  const bm = text.match(/-b\s+"([^"]*)"/);
  if (bm) out.cookie = bm[1];

  return out;
}

// Merge captured values over the defaults.
export function withDefaults(fields) {
  const out = { ...(fields || {}) };
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (!out[key]) out[key] = { value, source: 'default', ts: 0 };
  }
  return out;
}
