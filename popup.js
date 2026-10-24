import {
  fillTemplate,
  withDefaults,
  DEFAULTS,
  sanitizeCookie,
  parseCurl,
  CODE_API_VERSION,
  parseCodeSessionId,
  codeSessionUrl,
  codeSessionEventsUrl,
  nextCodeEventsCursor,
  mergeCodeSessionEvents,
} from './lib/parse.js';
import {
  DOWNLOAD_DISMISS_GRACE_MS,
  getPopupDismissDelay,
} from './lib/popup-lifecycle.js';

const STORAGE_KEY = 'claudeCapture';
const DOWNLOAD_URL_LIFETIME_MS = 30000;
// Safety stop for the paged event export (200 events per page).
const MAX_CODE_EVENT_PAGES = 500;

let downloadInProgress = false;
let dismissHoldUntil = 0;
let pendingDismissTimer = null;
let popupFocusLost = false;

// Order + labels mirror the Readme "extract first" list.
const FIELDS = [
  { key: 'organizations', label: 'organizations', core: true },
  { key: 'chat_conversations', label: 'chat_conversations', core: true },
  { key: 'anthropic-anonymous-id', label: 'anthropic-anonymous-id', core: true },
  { key: 'anthropic-client-build', label: 'anthropic-client-build', core: true },
  { key: 'anthropic-client-sha', label: 'anthropic-client-sha', core: true },
  { key: 'anthropic-device-id', label: 'anthropic-device-id', core: true },
  { key: 'x-activity-session-id', label: 'x-activity-session-id', core: true },
  { key: 'cookie', label: 'cookie', core: true, multiline: true },
  { key: 'sec-ch-ua', label: 'sec-ch-ua', core: true },
  { key: 'referer', label: 'referer' },
  { key: 'anthropic-client-version', label: 'anthropic-client-version' },
  { key: 'anthropic-client-capabilities', label: 'anthropic-client-capabilities' },
  { key: 'anthropic-client-platform', label: 'anthropic-client-platform' },
  { key: 'sec-ch-ua-mobile', label: 'sec-ch-ua-mobile' },
  { key: 'sec-ch-ua-platform', label: 'sec-ch-ua-platform' },
  { key: 'user-agent', label: 'user-agent' },
];

let capture = { fields: {}, rawHeaders: {}, ts: 0, url: '' };
// The Claude Code session shown in the active tab ({ id, tabId }), if any.
// The download button exports it instead of a chat conversation.
let codeSession = null;

function $(id) {
  return document.getElementById(id);
}

function fieldValue(key) {
  const f = capture.fields && capture.fields[key];
  const value = f && f.value ? f.value : DEFAULTS[key] !== undefined ? DEFAULTS[key] : '';
  // A double quote inside the cookie would break the `-b "..."` curl argument.
  return key === 'cookie' ? sanitizeCookie(value) : value;
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1600);
}

async function copy(text, msg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(msg || 'Copied');
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast(msg || 'Copied');
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function render() {
  const host = $('fields');
  host.innerHTML = '';

  for (const def of FIELDS) {
    const entry = (capture.fields && capture.fields[def.key]) || {};
    const value = fieldValue(def.key);

    const wrap = document.createElement('div');
    wrap.className = 'field';

    const head = document.createElement('div');
    head.className = 'field-head';

    const name = document.createElement('span');
    name.className = 'field-name';
    name.textContent = def.label;
    head.appendChild(name);

    const src = document.createElement('span');
    const srcText = entry.source || (DEFAULTS[def.key] ? 'default' : 'empty');
    src.className = 'src' + (entry.source && entry.source !== 'default' ? ' live' : '');
    src.textContent = srcText;
    head.appendChild(src);

    const row = document.createElement('div');
    row.className = 'field-row';

    const input = document.createElement('input');
    input.type = 'text';
    input.value = value;
    input.dataset.key = def.key;
    if (def.multiline) input.title = 'Full cookie header string';
    input.addEventListener('change', async () => {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      const cap = stored[STORAGE_KEY] || { fields: {} };
      cap.fields = cap.fields || {};
      cap.fields[def.key] = { value: input.value, source: 'manual', ts: Date.now() };
      await chrome.storage.local.set({ [STORAGE_KEY]: cap });
      capture = cap;
      toast('Updated ' + def.label);
    });
    row.appendChild(input);

    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-one';
    copyBtn.textContent = 'copy';
    copyBtn.addEventListener('click', () => copy(input.value, def.label + ' copied'));
    row.appendChild(copyBtn);

    wrap.appendChild(head);
    wrap.appendChild(row);
    host.appendChild(wrap);
  }

  // Status line
  const core = FIELDS.filter((f) => f.core);
  const missing = core.filter((f) => !fieldValue(f.key));
  const capturedCount = core.length - missing.length;
  $('status').textContent = missing.length
    ? `${capturedCount}/${core.length} captured`
    : 'all captured';
  $('status').style.color = missing.length ? '#e0a458' : '#7fb069';

  const detailsStatus = $('details-status');
  detailsStatus.textContent = missing.length
    ? `${capturedCount}/${core.length} captured`
    : 'all captured';
  detailsStatus.className = 'details-status' + (missing.length ? ' partial' : ' ready');

  // Meta
  $('meta-ts').textContent = capture.ts
    ? new Date(capture.ts).toLocaleString()
    : 'not captured yet';
  $('meta-url').textContent = capture.requestUrl || capture.url || '–';
  $('meta-requests').textContent = capture.requests
    ? `${capture.requests} request(s) observed`
    : 'no request observed yet';

  const warn = $('meta-warn');
  const warnings = [];
  // A Claude Code session needs none of the captured chat values.
  if (codeSession) {
    warn.classList.add('hidden');
    return;
  }
  if (!fieldValue('chat_conversations')) {
    warnings.push(
      'No chat id — open a conversation (https://claude.ai/chat/<id>) on claude.ai, then press "Scan open tabs".'
    );
  }
  if (!fieldValue('organizations')) {
    warnings.push(
      'No organization id — the lastActiveOrg cookie was not found. Log in on claude.ai and press "Scan open tabs".'
    );
  }
  if (!fieldValue('cookie')) {
    warnings.push('No cookie captured — reload the claude.ai tab and interact with it.');
  }
  if (!fieldValue('anthropic-client-sha') || !fieldValue('anthropic-client-build')) {
    warnings.push('client build/sha missing — reload the claude.ai tab to trigger an API call.');
  }
  if (!capture.requests) {
    warnings.push(
      'No claude.ai request observed yet — press "Re-capture (reload tab)" and interact with the chat.'
    );
  }
  if (warnings.length) {
    warn.textContent = warnings.join(' ');
    warn.classList.remove('hidden');
  } else {
    warn.classList.add('hidden');
  }
}

// ---------------------------------------------------------------------------
// Curl building
// ---------------------------------------------------------------------------
async function buildTemplateCurl() {
  const res = await fetch(chrome.runtime.getURL('curl-template.txt'));
  const tpl = (await res.text()).trim();
  const values = {};
  for (const def of FIELDS) values[def.key] = fieldValue(def.key);
  return fillTemplate(tpl, values);
}

function buildVerbatimCurl() {
  const raw = capture.rawHeaders || {};
  const skip = new Set([
    'cookie',
    'host',
    'connection',
    'content-length',
    'accept-encoding',
    'referer',
    'sec-fetch-site',
    'sec-fetch-dest',
    'sec-fetch-mode',
    'sec-fetch-user',
    'upgrade-insecure-requests',
    'origin',
  ]);

  const order = [
    'accept',
    'accept-language',
    'anthropic-anonymous-id',
    'anthropic-client-build',
    'anthropic-client-capabilities',
    'anthropic-client-platform',
    'anthropic-client-sha',
    'anthropic-client-version',
    'anthropic-device-id',
    'content-type',
    'sec-ch-ua',
    'sec-ch-ua-mobile',
    'sec-ch-ua-platform',
    'user-agent',
    'x-activity-session-id',
  ];

  const used = new Set();
  const parts = [];
  for (const name of order) {
    const v = raw[name];
    if (v) {
      parts.push(`-H "${name}: ${v}"`);
      used.add(name);
    }
  }
  for (const [name, v] of Object.entries(raw)) {
    if (used.has(name) || skip.has(name) || !v) continue;
    parts.push(`-H "${name}: ${v}"`);
  }

  const org = fieldValue('organizations');
  const chat = fieldValue('chat_conversations');
  const url = `https://claude.ai/api/organizations/${org}/chat_conversations/${chat}?tree=True&rendering_mode=messages&render_all_tools=true&include_inline_comparison=true&renders_source_card=true&consistency=strong`;

  return `curl.exe "${url}" ${parts.join(' ')} -b "${fieldValue('cookie')}" -H "referer: https://claude.ai/chat/${chat}"`;
}

async function buildCurl() {
  if ($('raw-mode').checked) return buildVerbatimCurl();
  return buildTemplateCurl();
}

// ---------------------------------------------------------------------------
// Fetch + download
// ---------------------------------------------------------------------------
function setFetchStatus(text, kind) {
  const el = $('fetch-status');
  el.textContent = text;
  el.className = 'fetch-status' + (kind ? ' ' + kind : '');
  el.classList.remove('hidden');
}

function downloadJson(filename, text) {
  dismissHoldUntil = Date.now() + DOWNLOAD_DISMISS_GRACE_MS;

  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Keep the object URL alive long enough for Chrome to consume the download
  // even if focus changes while the save is being committed.
  setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_LIFETIME_MS);
}

function prettyPrint(body) {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

// Run a GET request from a claude.ai tab and return the parsed JSON body.
async function requestJson(url, headers, tabId) {
  const res = await chrome.runtime.sendMessage({ type: 'run-request', url, headers, tabId });
  if (!res) throw new Error('No response from the extension.');
  if (!res.ok) {
    throw new Error(
      res.status
        ? `Request failed: HTTP ${res.status} ${res.statusText || ''}`.trim()
        : `Request failed: ${res.error || 'unknown error'}`
    );
  }
  return JSON.parse(res.body || 'null');
}

// Find out whether the active tab shows a Claude Code session.
async function detectCodeSession() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const id = tab && parseCodeSessionId(tab.url);
    codeSession = id ? { id, tabId: tab.id } : null;
  } catch (e) {
    codeSession = null;
  }
}

// Export a Claude Code session: its metadata plus every event, oldest first.
async function downloadCodeSession({ id, tabId }) {
  const headers = { 'anthropic-version': CODE_API_VERSION };

  setFetchStatus('Fetching Claude Code session...', 'busy');
  const session = await requestJson(codeSessionUrl(id), headers, tabId);

  const pages = [];
  let cursor = null;
  let fetched = 0;
  let complete = false;
  for (let i = 0; i < MAX_CODE_EVENT_PAGES; i++) {
    const page = await requestJson(codeSessionEventsUrl(id, cursor), headers, tabId);
    pages.push(page);
    fetched += (page && Array.isArray(page.data) ? page.data.length : 0);
    setFetchStatus(`Fetching Claude Code session... ${fetched.toLocaleString()} events`, 'busy');
    cursor = nextCodeEventsCursor(page, cursor);
    if (!cursor) {
      complete = true;
      break;
    }
  }

  const events = mergeCodeSessionEvents(pages);
  const text = JSON.stringify({ session, events, complete }, null, 2);
  const filename = `${id}.json`;
  downloadJson(filename, text);
  const bytes = new Blob([text]).size;
  setFetchStatus(
    `Saved ${filename} (${events.length.toLocaleString()} events, ${bytes.toLocaleString()} bytes)` +
      (complete ? '' : ' - stopped early, the session is very long'),
    complete ? 'ok' : 'err'
  );
  toast(`${filename} downloaded`);
}

async function fetchAndDownload() {
  const btn = $('fetch-download');
  btn.disabled = true;
  downloadInProgress = true;

  try {
    await detectCodeSession();
    if (codeSession) {
      await downloadCodeSession(codeSession);
      return;
    }

    if (!fieldValue('chat_conversations')) {
      setFetchStatus('No conversation id - open a chat on claude.ai first.', 'err');
      return;
    }

    // Fetch exactly the request that the copied curl command performs.
    const cmd = await buildCurl();
    const req = parseCurl(cmd);
    if (!req.url) {
      setFetchStatus('Could not determine the request URL.', 'err');
      return;
    }

    setFetchStatus('Fetching conversation...', 'busy');

    const res = await chrome.runtime.sendMessage({
      type: 'run-request',
      url: req.url,
      headers: req.headers,
    });

    if (!res) {
      setFetchStatus('No response from the extension.', 'err');
      return;
    }
    if (!res.ok) {
      setFetchStatus(
        res.status
          ? `Request failed: HTTP ${res.status} ${res.statusText || ''}`.trim()
          : `Request failed: ${res.error || 'unknown error'}`,
        'err'
      );
      return;
    }

    const text = prettyPrint(res.body || '');
    downloadJson('conversation.json', text);
    const bytes = new Blob([text]).size;
    setFetchStatus(`Saved conversation.json (${bytes.toLocaleString()} bytes)`, 'ok');
    toast('conversation.json downloaded');
  } catch (e) {
    setFetchStatus(`Error: ${(e && e.message) || e}`, 'err');
  } finally {
    downloadInProgress = false;
    btn.disabled = false;
    schedulePopupDismiss();
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function loadCapture() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  capture = stored[STORAGE_KEY] || { fields: {}, rawHeaders: {}, ts: 0 };
  capture.fields = withDefaults(capture.fields);
  render();
}

async function reloadClaudeTab() {
  const tabs = await chrome.tabs.query({ url: ['https://claude.ai/*', 'https://*.claude.ai/*'] });
  if (!tabs.length) {
    toast('No claude.ai tab open');
    return;
  }
  const tab = tabs.find((t) => /claude\.ai\/chat\//.test(t.url)) || tabs[0];
  await chrome.tabs.reload(tab.id);
  toast('Reloaded claude.ai — capture updates in a moment');
}

// Ask the open claude.ai tabs for their current URL + document.cookie.
// This is what fills in the organization id (`lastActiveOrg`) and the
// conversation id when the tab was already open before the extension was
// installed, or when the app navigated without a page load.
async function scanTabs(silent) {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'scan-tabs' });
    if (!silent) {
      if (res && res.ok) toast(`Scanned ${res.tabs} tab(s)`);
      else toast('Scan failed');
    }
  } catch (e) {
    if (!silent) toast('Scan failed');
  }
}

async function resetCapture() {
  await chrome.runtime.sendMessage({ type: 'reset-capture' });
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  capture = stored[STORAGE_KEY] || { fields: {}, rawHeaders: {}, ts: 0 };
  capture.fields = withDefaults(capture.fields);
  render();
  toast('Capture reset');
}

function setupDetailsDismissOnOutsideClick() {
  const details = $('request-details');
  if (!details) return;

  document.addEventListener('pointerdown', (event) => {
    if (!details.open) return;
    if (details.contains(event.target)) return;
    details.open = false;
  });
}

function closePopup() {
  window.close();
}

function schedulePopupDismiss() {
  if (downloadInProgress || !popupFocusLost) return;
  if (pendingDismissTimer !== null) return;

  const delay = getPopupDismissDelay(dismissHoldUntil);
  if (delay <= 0) {
    closePopup();
    return;
  }

  pendingDismissTimer = setTimeout(() => {
    pendingDismissTimer = null;
    if (popupFocusLost && !downloadInProgress) closePopup();
  }, delay);
}

function cancelPendingPopupDismiss() {
  popupFocusLost = false;
  if (pendingDismissTimer !== null) {
    clearTimeout(pendingDismissTimer);
    pendingDismissTimer = null;
  }
}

function setupPopupDismissOnFocusLoss() {
  window.addEventListener('blur', () => {
    popupFocusLost = true;
    schedulePopupDismiss();
  });
  window.addEventListener('focus', cancelPendingPopupDismiss);
}

function init() {
  setupDetailsDismissOnOutsideClick();
  setupPopupDismissOnFocusLoss();

  $('refresh').addEventListener('click', reloadClaudeTab);
  $('reload-template').addEventListener('click', loadCapture);
  $('raw-mode').addEventListener('change', render);
  $('scan-now').addEventListener('click', () => scanTabs(false));
  $('reset-capture').addEventListener('click', resetCapture);

  $('copy-curl').addEventListener('click', async () => {
    const curl = await buildCurl();
    await copy(curl, 'curl command copied');
  });

  $('fetch-download').addEventListener('click', fetchAndDownload);

  $('copy-vars').addEventListener('click', async () => {
    const out = FIELDS.map((f) => `${f.label}: ${fieldValue(f.key)}`).join('\n');
    await copy(out, 'request details copied');
  });

  $('copy-cookie').addEventListener('click', async () => {
    await copy(fieldValue('cookie'), 'cookie copied');
  });

  $('copy-json').addEventListener('click', async () => {
    const obj = {};
    for (const f of FIELDS) obj[f.key] = fieldValue(f.key);
    await copy(JSON.stringify(obj, null, 2), 'JSON copied');
  });

  $('copy-raw').addEventListener('click', async () => {
    const raw = capture.rawHeaders || {};
    let out = '';
    for (const [k, v] of Object.entries(raw)) out += `${k}: ${v}\n`;
    await copy(out.trim(), 'raw headers copied');
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STORAGE_KEY]) {
      capture = changes[STORAGE_KEY].newValue || capture;
      capture.fields = capture.fields || {};
      render();
    }
  });

  detectCodeSession()
    .then(loadCapture)
    .then(() => scanTabs(true));
}

document.addEventListener('DOMContentLoaded', init);
