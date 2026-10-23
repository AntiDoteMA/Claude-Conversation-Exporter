# Claude Conversation Exporter — Chrome Extension (MV3)

Captures the details needed to export the currently open Claude conversation from
your active, logged-in browser session. Save it as JSON directly from the extension,
or copy a ready-to-run `curl` command.

> **Security note:** the generated curl command contains live Claude session cookies.
> Treat it like a password, do not commit it to a repository, and delete it after use.
> See the Privacy and security section in `README.md` for details.

## What it captures and where it comes from

| Variable | Source | Notes |
|---|---|---|
| `organizations` | the `/api/organizations/<uuid>` path, else cookie `lastActiveOrg` | UUID of the active workspace |
| `chat_conversations` | the `/chat/<uuid>` path of the open tab, else the `referer` header (`https://claude.ai/chat/<uuid>`), else the `/chat_conversations/<uuid>` api path | conversation id |
| `anthropic-anonymous-id` | request header, else cookie `ajs_anonymous_id` | |
| `anthropic-client-build` | request header | build number of the web app |
| `anthropic-client-sha` | request header | commit sha of the web app bundle |
| `anthropic-device-id` | request header, else cookie `anthropic-device-id` | |
| `x-activity-session-id` | request header, else cookie `activitySessionId` | |
| `cookie` | the real `Cookie` request header (exact string the server received), else the cookie jar | full cookie string for the `-b` flag; every `"` is replaced by `'` |
| `sec-ch-ua` | request header, normalized to the brand token (`Not)A;Brand`) | matches the default curl template |
| `referer` | request header | the page the api call was made from, e.g. `https://claude.ai/chat/<uuid>` |

Extra captured values (`anthropic-client-version`, `anthropic-client-capabilities`,
`anthropic-client-platform`, `sec-ch-ua-mobile`, `sec-ch-ua-platform`, `user-agent`) are
shown as extra rows and are used by the "Verbatim headers" curl mode.

### Where each id comes from (and why it used to fail)

- **organization id** – read from the `lastActiveOrg` cookie. It is taken from the
  `Cookie` request header first, then from the `chrome.cookies` API, then from
  `document.cookie` as seen by the page. The `/api/organizations/<uuid>` path of a
  live request wins over the cookie.
- **conversation id** – claude.ai is a single page app: a new conversation only
  changes the URL (`history.pushState`), no request is fired. The content script
  therefore polls the URL and reports it. The `referer` header of the api request
  (`referer: https://claude.ai/chat/<uuid>`) is used as a fallback, and the
  `/chat_conversations/<uuid>` api path as a last one.

### Values are refreshed, not frozen

Every captured value remembers **where** it came from. A new value replaces an
existing one only when its source is at least as authoritative:

```
manual                > page-url > request-url > cookie:lastActiveOrg
                      > referer > header > request-header > cookie-jar > page-cookie
```

- The tab URL beats the api request, so an in-flight request of the *previous*
  conversation cannot overwrite the conversation you are looking at.
- Equal priority always wins: a **new session replaces the values of the old
  one** (new conversation id, new `activitySessionId`, new `sessionKey`).
- `manual` wins over everything: a value you typed in the popup is never
  overwritten by a live capture. **Reset capture** clears those overrides.

### How the capture works

The extension registers a **passive** `chrome.webRequest.onSendHeaders` observer on
`https://claude.ai/*`. This is the only reliable way to get the values above, because
`anthropic-client-build`, `anthropic-client-sha` and `x-activity-session-id` are added by
Claude's own JavaScript — a `fetch()` issued by the extension would not carry them.

The observer only *reads*; it never modifies or blocks a request.

In parallel a content script runs in every claude.ai tab and reports

- the current URL (polled, because the app navigates without a page load),
- `document.cookie` (contains `lastActiveOrg`),
- a fallback scan of the page for ids that are in neither.

The background worker stores everything in `chrome.storage.local` and serializes the
updates, so parallel requests cannot overwrite each other.

## Install

### Packaged CRX

A signed package is provided at `Crx/Claude_Conversation_Exporter.crx`.

1. Download the `.crx` file.
2. Open `chrome://extensions`.
3. Drag `Claude_Conversation_Exporter.crx` onto the extensions page.
4. Confirm the installation and pin the extension (optional but handy).

Chrome versions, managed browser policies, and some non-Chromium browsers may block
sideloading a CRX from outside the Chrome Web Store. If that occurs, use the
unpacked source installation method below.

### Unpacked source

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the folder containing this project's `manifest.json`
5. Pin the extension (optional but handy)

## Use

1. Log in at <https://claude.ai> in a normal tab and open a conversation
   (URL should look like `https://claude.ai/chat/<uuid>`).
2. Click the extension icon. The popup shows the main export actions and a collapsed
   **Captured request details** section with the capture count. Expand it to view
   or edit every variable and where it came from. Values are captured passively as
   you browse — send a message or open a chat if a field is still empty.
3. If a field is still empty, press **Scan open tabs**: the extension asks the open
   claude.ai tabs for their URL and their cookies (this also works when the tab was
   already open before the extension was installed).
4. If something is stale, press **Re-capture (reload tab)**: the claude.ai tab is
   reloaded, the app emits fresh API requests, and the popup updates live.
5. Press **Copy curl command** and paste it into a terminal.

### New conversations / new sessions

Nothing has to be done manually. The content script follows the SPA, so a new
conversation id is picked up within half a second, and a new session replaces the
previous `activitySessionId` / `sessionKey` on the next api request. If a value was
typed by hand it is kept until **Reset capture** is pressed.

### Fetch & download

**Download conversation JSON** runs the request and saves the response as
`conversation.json` in your Downloads folder.

- The button executes *exactly* the request that the copied curl command performs:
  the curl command is parsed back into URL + headers, and the request is issued from
  the claude.ai tab (content script) so the browser sends the **real, unsanitized
  cookies** automatically — no cookie juggling needed.
- Only headers that `fetch()` is allowed to set are forwarded (`anthropic-*`,
  `x-activity-session-id`, `content-type`). The browser supplies `accept`,
  `accept-language`, `user-agent`, `referer` and `cookie` itself, so they cannot be
  overridden and are not sent manually.
- The response is pretty-printed as JSON when it parses, otherwise saved raw.
- Status is reported inline: `Fetching…` → `Saved conversation.json (12.4 KB)`, or the
  HTTP status / error (e.g. `401` when the session expired — press **Re-capture**).
- A claude.ai tab must be open. If the tab was loaded before the extension was
  installed, the content script is injected automatically on the first attempt.

### Curl modes

- **Default (template)** — renders `curl-template.txt` with the captured values
  substituted into the `##placeholders##`. `sec-ch-ua` is normalized to the brand
  token so the output uses the expected template form.
- **Verbatim headers** (checkbox) — rebuilds the command from the headers your browser
  actually sent, so nothing is approximated.

### Editing values

Every field is editable. Edits are saved to extension storage and are used by the copy
buttons, so you can correct or override any value before copying. A manual value is
never overwritten by a live capture — press **Reset capture** to drop the overrides and
start over.

## Notes

- **Quote sanitizing in the cookie**: a double quote inside a cookie value would break
  the `-b "..."` argument, so every `"` in the cookie is replaced by `'`. This is applied
  when the cookie is captured, when it is displayed/copied, and when the curl command is
  built, so all outputs are consistent. The untouched original is still visible under
  **Copy raw captured headers** if you ever need it.
- The `cookie` field contains live credentials (`sessionKey`, `sessionKeyV3`,
  `cf_clearance`, `routingHint`). The captured values and recent capture history are
  stored in `chrome.storage.local` for this browser profile only. **Reset capture**
  deletes both the current capture and history. To remove all extension storage, use
  `chrome://extensions` → **Remove extension**, or open the service worker console and
  run `chrome.storage.local.clear()`.
- The command template uses `-b "##cookie##"`. Do not add a cookie-name prefix in
  front of the captured cookie string, or the cookie will be malformed.
- `chrome.cookies` and `chrome.webRequest` both require the `host_permissions` already
  declared in `manifest.json` (`https://claude.ai/*`).

## Troubleshooting

| Symptom | What it means | Fix |
|---|---|---|
| **Observed: no request observed yet** | the `webRequest` observer did not see a single claude.ai request | reload the claude.ai tab (the observer only sees requests that happen *after* the extension is loaded) and confirm the extension is enabled in `chrome://extensions` |
| **organizations is empty** | `lastActiveOrg` was not found | log in on claude.ai, then press **Scan open tabs**; if it is still empty, copy the value out of the browser devtools (Application → Cookies) and paste it into the field |
| **chat_conversations is empty** | no conversation is open | open a conversation (`https://claude.ai/chat/<uuid>`) and press **Scan open tabs** |
| **values look like the previous session** | they were captured before | press **Reset capture**, then **Scan open tabs** / **Re-capture (reload tab)** |
| **Fetch fails with 401** | the session cookie rotated | press **Re-capture (reload tab)** and copy the curl command again |

## Files

```
manifest.json          MV3 manifest
background.js          webRequest capture + cookie/URL/referer extraction + request runner
content.js             page context (URL, document.cookie) + executes the request
lib/parse.js           pure helpers (header/cookie parsing, priorities, template fill, curl parse)
popup.html/.css/.js    popup UI, curl builder, fetch + download
curl-template.txt      default curl command with ##placeholders##
icons/                 generated icons
tools/make-icons.ps1   regenerates the icons
tools/selftest.js      unit tests for the shared helpers (node tools/selftest.js)
tools/package-crx.ps1  builds and signs the distributable CRX on Windows
Crx/                   prepackaged extension package
```
