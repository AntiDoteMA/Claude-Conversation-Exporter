// Self-test for the pure helpers in lib/parse.js.
// Run with:  node tools/selftest.js
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseIdsFromUrl,
  normalizeSecChUa,
  headerMap,
  fillTemplate,
  withDefaults,
  sanitizeCookie,
  parseCurl,
  parseCookieString,
  cookieValue,
  setField,
  sourcePriority,
  applyPageContext,
  applyCookieHeader,
  applyRequestIds,
} from '../lib/parse.js';
import {
  DOWNLOAD_DISMISS_GRACE_MS,
  getPopupDismissDelay,
} from '../lib/popup-lifecycle.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) {
    console.log(`      expected: ${JSON.stringify(expected)}`);
    console.log(`      actual:   ${JSON.stringify(actual)}`);
  }
}

// --- URL parsing -----------------------------------------------------------
check(
  'chat url -> conversation id',
  parseIdsFromUrl('https://claude.ai/chat/35e54613-b35b-4f3e-bc42-d543b5918b06'),
  { chat_conversations: '35e54613-b35b-4f3e-bc42-d543b5918b06' }
);
check(
  'api url -> organization id',
  parseIdsFromUrl(
    'https://claude.ai/api/organizations/c2a408d8-804b-4d2e-be0d-b9c6c10c662e/chat_conversations/35e54613-b35b-4f3e-bc42-d543b5918b06?tree=True'
  ),
  {
    organizations: 'c2a408d8-804b-4d2e-be0d-b9c6c10c662e',
    chat_conversations: '35e54613-b35b-4f3e-bc42-d543b5918b06',
  }
);
check('garbage url -> nothing', parseIdsFromUrl('not a url'), {});
check('empty url -> nothing', parseIdsFromUrl(''), {});

// --- referer header -> conversation id -------------------------------------
check(
  'referer header -> conversation id',
  parseIdsFromUrl('https://claude.ai/chat/35e54613-b35b-4f3e-bc42-d543b5918b06'),
  { chat_conversations: '35e54613-b35b-4f3e-bc42-d543b5918b06' }
);
check(
  'referer header with query -> conversation id',
  parseIdsFromUrl('https://claude.ai/chat/35e54613-b35b-4f3e-bc42-d543b5918b06?foo=1'),
  { chat_conversations: '35e54613-b35b-4f3e-bc42-d543b5918b06' }
);
check(
  'api url with query -> both ids',
  parseIdsFromUrl(
    'https://claude.ai/api/organizations/c2a408d8-804b-4d2e-be0d-b9c6c10c662e/chat_conversations/35e54613-b35b-4f3e-bc42-d543b5918b06?tree=True&rendering_mode=messages'
  ),
  {
    organizations: 'c2a408d8-804b-4d2e-be0d-b9c6c10c662e',
    chat_conversations: '35e54613-b35b-4f3e-bc42-d543b5918b06',
  }
);
check(
  'unrelated url -> nothing',
  parseIdsFromUrl('https://claude.ai/new'),
  {}
);
check(
  'referer of another origin still exposes the /chat/ id',
  parseIdsFromUrl('https://example.com/chat/35e54613-b35b-4f3e-bc42-d543b5918b06'),
  { chat_conversations: '35e54613-b35b-4f3e-bc42-d543b5918b06' }
);

// --- sec-ch-ua normalization ------------------------------------------------
check(
  'real chrome sec-ch-ua -> brand token',
  normalizeSecChUa('"Chromium";v="138", "Not)A;Brand";v="24", "Google Chrome";v="138"'),
  'Not)A;Brand'
);
check(
  'readme style sec-ch-ua -> brand token',
  normalizeSecChUa('Not)A;Brand'),
  'Not)A;Brand'
);
check('missing sec-ch-ua -> null', normalizeSecChUa(''), null);

// --- header map ------------------------------------------------------------
check(
  'header map lowercases and keeps first',
  headerMap([
    { name: 'Cookie', value: 'a=1' },
    { name: 'COOKIE', value: 'a=2' },
    { name: 'anthropic-client-sha', value: 'abc' },
  ]),
  { cookie: 'a=1', 'anthropic-client-sha': 'abc' }
);

// --- template substitution -------------------------------------------------
const template = readFileSync(join(root, 'curl-template.txt'), 'utf8');
const values = {
  organizations: 'c2a408d8-804b-4d2e-be0d-b9c6c10c662e',
  chat_conversations: '35e54613-b35b-4f3e-bc42-d543b5918b06',
  'anthropic-anonymous-id': 'claudeai.v1.58a7ab38-7963-4d1f-a629-5f20eef81af8',
  'anthropic-client-build': '1792660413',
  'anthropic-client-sha': '6f837c723ede15069070005153860fa8b2b8c0d7',
  'anthropic-device-id': 'de5e01f7-d402-4037-bbf5-f057780bbe2b',
  'x-activity-session-id': '0a8f47e5-b65f-4928-ba4c-b78093c59097',
  cookie: 'sessionKey=abc; lastActiveOrg=c2a408d8',
  'sec-ch-ua': 'Not)A;Brand',
};
const rendered = fillTemplate(template, values);
check('no placeholders left in rendered curl', /##[a-z0-9_-]+##/i.test(rendered), false);
check('org id present', rendered.includes(values.organizations), true);
check('cookie passed to -b', rendered.includes(`-b "${values.cookie}"`), true);
check('no hardcoded _fbp= prefix bug', rendered.includes('-b "_fbp='), false);
check(
  'sec-ch-ua rendered in readme form',
  rendered.includes(`sec-ch-ua: 'Not)A;Brand';v='8'`),
  true
);
check('cookie value with special chars survives', fillTemplate('##cookie##', { cookie: "g_state={'i_l':0}" }), "g_state={'i_l':0}");

// --- cookie sanitizing -----------------------------------------------------
check(
  'double quotes in cookie -> single quotes',
  sanitizeCookie('a="b"; g_state={"i_l":0}'),
  "a='b'; g_state={'i_l':0}"
);
check('cookie without quotes is untouched', sanitizeCookie('a=1; b=2'), 'a=1; b=2');
check('single quotes in cookie are preserved', sanitizeCookie("g_state={'i_l':0}"), "g_state={'i_l':0}");
check('sanitizing is idempotent', sanitizeCookie(sanitizeCookie('a="b"')), "a='b'");
check(
  'sanitized cookie keeps -b argument intact',
  fillTemplate('-b "##cookie##"', { cookie: sanitizeCookie('x="y"') }),
  `-b "x='y'"`
);

// --- curl parsing (used to replay the request in the page) ----------------
const parsed = parseCurl(rendered);
check('curl url parsed', parsed.url.includes('/api/organizations/'), true);
check(
  'curl org id in url',
  parsed.url.includes('c2a408d8-804b-4d2e-be0d-b9c6c10c662e'),
  true
);
check(
  'curl chat id in url',
  parsed.url.includes('35e54613-b35b-4f3e-bc42-d543b5918b06'),
  true
);
check('curl header parsed', parsed.headers['anthropic-client-sha'], values['anthropic-client-sha']);
check('curl cookie parsed', parsed.cookie, values.cookie);
check(
  'curl parse survives quotes in the cookie',
  parseCurl(`curl.exe "https://x/y" -b "${sanitizeCookie('a="b"')}"`).cookie,
  "a='b'"
);

// --- defaults --------------------------------------------------------------
const merged = withDefaults({});
check('defaults fill sec-ch-ua', merged['sec-ch-ua'].value, 'Not)A;Brand');
check('defaults fill client-version', merged['anthropic-client-version'].value, '1.0.0');

// --- cookie string parsing -------------------------------------------------
const cookieHeader =
  '_fbp=fb.1.179; sessionKey=sk-ant-sid02-abc; lastActiveOrg=c2a408d8-804b-4d2e-be0d-b9c6c10c662e; activitySessionId=0a8f47e5-b65f-4928-ba4c-b78093c59097; g_state={"i_l":0}';
const parsedJar = parseCookieString(cookieHeader);
check('cookie: organization id from lastActiveOrg', parsedJar.lastActiveOrg, 'c2a408d8-804b-4d2e-be0d-b9c6c10c662e');
check('cookie: session id from activitySessionId', parsedJar.activitySessionId, '0a8f47e5-b65f-4928-ba4c-b78093c59097');
check('cookie: value with = is kept', parsedJar.g_state, '{"i_l":0}');
check('cookie: single value lookup', cookieValue(cookieHeader, 'sessionKey'), 'sk-ant-sid02-abc');
check('cookie: unknown name', cookieValue(cookieHeader, 'nope'), undefined);

// --- capture priorities ----------------------------------------------------
// A new session must replace the values of the previous one, while a manual
// value typed in the popup must survive.
const fields = {};
setField(fields, 'organizations', 'old-org', 'request-url');
setField(fields, 'organizations', 'new-org', 'request-url');
check('equal priority replaces the value', fields.organizations.value, 'new-org');

setField(fields, 'organizations', 'other-org', 'page-cookie:lastActiveOrg');
check(
  'less authoritative source does not overwrite',
  fields.organizations.value,
  'new-org'
);

setField(fields, 'organizations', 'manual-org', 'manual');
check('manual value is stored', fields.organizations.value, 'manual-org');
setField(fields, 'organizations', 'yet-another-org', 'request-url');
check('manual value is never overwritten', fields.organizations.value, 'manual-org');

// The conversation id of the tab wins over the one of an older request.
const chatFields = {};
setField(chatFields, 'chat_conversations', 'request-chat', 'request-url');
setField(chatFields, 'chat_conversations', 'page-chat', 'page-url');
check('page url wins over the request url', chatFields.chat_conversations.value, 'page-chat');
setField(chatFields, 'chat_conversations', 'stale-request-chat', 'request-url');
check(
  'a late request url does not overwrite the page url',
  chatFields.chat_conversations.value,
  'page-chat'
);
setField(chatFields, 'chat_conversations', 'new-page-chat', 'page-url');
check('a new conversation replaces the old one', chatFields.chat_conversations.value, 'new-page-chat');

check(
  'the cookie api beats document.cookie',
  sourcePriority('cookie:lastActiveOrg') > sourcePriority('page-cookie:lastActiveOrg'),
  true
);
check(
  'the request cookie header beats the cookie jar',
  sourcePriority('request-header') > sourcePriority('cookie-jar'),
  true
);
check('unknown source has the lowest priority', sourcePriority('whatever'), 0);
check('empty value is not stored', setField(fields, 'empty', '', 'header'), false);
check('empty value did not create a field', fields.empty, undefined);

// --- popup dismissal lifecycle ----------------------------------------------
check('popup closes immediately without a download', getPopupDismissDelay(0, 1000), 0);
check(
  'popup dismissal waits for an active download',
  getPopupDismissDelay(1000 + DOWNLOAD_DISMISS_GRACE_MS, 1000),
  DOWNLOAD_DISMISS_GRACE_MS
);
check(
  'popup dismissal is deferred during the download grace period',
  getPopupDismissDelay(1000 + DOWNLOAD_DISMISS_GRACE_MS, 1500),
  DOWNLOAD_DISMISS_GRACE_MS - 500
);
check(
  'popup dismissal is immediate after the download grace period',
  getPopupDismissDelay(1000 + DOWNLOAD_DISMISS_GRACE_MS, 1000 + DOWNLOAD_DISMISS_GRACE_MS),
  0
);

// --- a full session, step by step -----------------------------------------
// This is the sequence that used to break: a new session kept the values of
// the old one and the conversation id was never updated.
const ORG1 = '11111111-1111-4111-8111-111111111111';
const ORG2 = '22222222-2222-4222-8222-222222222222';
const ORG8 = '88888888-8888-4888-8888-888888888888';
const ORG9 = '99999999-9999-4999-8999-999999999999';
const CHAT1 = 'aaaaaaaa-1111-4111-8111-111111111111';
const CHAT2 = 'bbbbbbbb-2222-4222-8222-222222222222';
const CHAT3 = 'cccccccc-3333-4333-8333-333333333333';
const live = {};

applyRequestIds(
  live,
  `https://claude.ai/api/organizations/${ORG1}/chat_conversations/${CHAT1}?tree=True`,
  `https://claude.ai/chat/${CHAT1}`
);
applyCookieHeader(
  live,
  `sessionKey=S1; lastActiveOrg=${ORG1}; activitySessionId=ACT1; anthropic-device-id=DEV1`
);
check('session 1: organization id', live.organizations.value, ORG1);
check('session 1: organization source', live.organizations.source, 'request-url');
check('session 1: conversation id', live.chat_conversations.value, CHAT1);
check('session 1: conversation source', live.chat_conversations.source, 'request-url');
check('session 1: session id', live['x-activity-session-id'].value, 'ACT1');

// The user creates a new conversation. claude.ai only changes the url.
applyPageContext(live, {
  url: `https://claude.ai/chat/${CHAT2}`,
  cookie: `sessionKey=S1; lastActiveOrg=${ORG1}`,
});
check('new conversation: id follows the url', live.chat_conversations.value, CHAT2);
check('new conversation: source is the page url', live.chat_conversations.source, 'page-url');

// The request of the previous conversation arrives late.
applyRequestIds(
  live,
  `https://claude.ai/api/organizations/${ORG1}/chat_conversations/${CHAT1}?tree=True`,
  `https://claude.ai/chat/${CHAT1}`
);
check(
  'a late request does not win over the page url',
  live.chat_conversations.value,
  CHAT2
);

// A new session: new cookies, new organization, new conversation.
applyRequestIds(
  live,
  `https://claude.ai/api/organizations/${ORG2}/chat_conversations/${CHAT3}`,
  `https://claude.ai/chat/${CHAT3}`
);
applyCookieHeader(
  live,
  `sessionKey=S2; lastActiveOrg=${ORG2}; activitySessionId=ACT2; anthropic-device-id=DEV1`
);
applyPageContext(live, {
  url: `https://claude.ai/chat/${CHAT3}`,
  cookie: `sessionKey=S2; lastActiveOrg=${ORG2}`,
});
check('new session: organization id', live.organizations.value, ORG2);
check('new session: conversation id', live.chat_conversations.value, CHAT3);
check('new session: activity session id', live['x-activity-session-id'].value, 'ACT2');
check('new session: device id is kept', live['anthropic-device-id'].value, 'DEV1');

// The organization id can also come from the cookie alone.
const orgOnly = {};
applyCookieHeader(orgOnly, `lastActiveOrg=${ORG9}`);
check('organization id from the cookie', orgOnly.organizations.value, ORG9);
check('organization id from the cookie: source', orgOnly.organizations.source, 'cookie:lastActiveOrg');

// ... and from document.cookie when the cookies api is not available.
const docOnly = {};
applyPageContext(docOnly, {
  url: `https://claude.ai/chat/${CHAT1}`,
  cookie: `lastActiveOrg=${ORG8}`,
});
check('organization id from document.cookie', docOnly.organizations.value, ORG8);
check(
  'organization id from document.cookie: source',
  docOnly.organizations.source,
  'page-cookie:lastActiveOrg'
);

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
