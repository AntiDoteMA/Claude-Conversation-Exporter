# Claude Conversation Exporter

A local Chrome extension for exporting the **currently open Claude conversation**.

Choose either output:

- **Download JSON** — fetches the conversation and saves `conversation.json` directly from the extension.
- **Copy a curl command** — reproduces the authenticated request so you can run it yourself in a terminal.

The extension runs entirely in your browser profile. It has no analytics, telemetry, account system, remote code, or server-side component.

> [!IMPORTANT]
> A generated curl command contains live Claude session cookies. Treat it like a password: do not share it, commit it, paste it into a public issue, or leave it in shell history. The exported JSON may also contain private information from your conversation.

## Features

- Detects the active organization and conversation IDs from your logged-in Claude tab.
- Captures the request headers Claude sends for its own web app.
- Keeps captured values fresh when you open a new conversation or start a new session.
- Downloads the conversation API response as formatted JSON.
- Generates a standard `curl.exe` command from either the included template or the verbatim captured headers.
- Lets you correct any field manually before copying or downloading.
- Stores working data only in `chrome.storage.local` in the current browser profile.

## Installation

Choose either the packaged extension or the source folder.

### Use the packaged CRX

A signed package is included at [`Crx/Claude_Conversation_Exporter.crx`](Crx/Claude_Conversation_Exporter.crx).

1. Download the `.crx` file from GitHub.
2. Open `chrome://extensions` in Chrome.
3. Drag `Claude_Conversation_Exporter.crx` onto that page and confirm the installation.

Some Chrome versions, managed browser policies, or non-Chromium browsers can block installing a CRX that was not downloaded from the Chrome Web Store. If that happens, use the source installation method below. The CRX is provided as a convenience; **Load unpacked** is the most broadly compatible installation method.

### Install from source

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the repository folder containing `manifest.json`.
6. Pin **Claude Conversation Exporter** to the toolbar (optional).

See [`INSTALL.md`](INSTALL.md) for more detailed operating instructions.

## Export a conversation

### Download JSON

1. Sign in to [claude.ai](https://claude.ai) and open a conversation.
2. Click the extension icon.
3. Press **Download conversation JSON**.
4. Chrome saves the response in your normal Downloads folder.

The request runs from the open Claude page, so the browser supplies the live authenticated session automatically.

### Optional: extract a compact transcript

This repository also includes a standalone Python utility that turns the downloaded `conversation.json` into a compact, agent-ready Markdown or JSON transcript. It preserves user requests, assistant narration, thinking summaries, tool activity, errors, and a derived reference index while omitting bulky tool payloads by default.

```bash
python transcript_extract.py --out transcript.md
python transcript_extract.py --format json --out transcript.json
```

The extractor runs entirely locally, uses only Python's standard library, and does not upload the conversation. Its output can still contain private conversation content, so review it before sharing or committing it.

See [`transcript_extract_README.md`](transcript_extract_README.md) for supported export shapes, all options, examples, and the output format.

### Copy a curl command

1. Open a Claude conversation and click the extension icon.
2. If a value is missing, press **Scan open tabs**.
3. If values are stale, press **Re-capture (reload tab)**.
4. Press **Copy curl command**.
5. Paste the command into a terminal and run it.

For Windows, the generated command uses `curl.exe`. On other platforms, you can replace `curl.exe` with `curl`.

**Verbatim headers** mode rebuilds the command from the headers your browser actually sent. The default mode uses the repository's `curl-template.txt` and fills its placeholders.

## Privacy and security

### What leaves your browser

The extension itself sends no data to an analytics service or any third-party server. Its only network request is the conversation request to `claude.ai`, initiated when you choose **Download conversation JSON**.

When you copy a curl command, that command later sends the captured request data and cookies to `claude.ai`. The extension cannot control where a copied command is subsequently run.

### What is stored locally

Captured request details, including session cookies, are stored in `chrome.storage.local` for the current Chrome profile. They are not synced by the extension. The extension keeps up to 20 recent capture snapshots locally. Click **Reset capture** to delete the current capture and that history, or remove the extension to delete all extension storage.

### Permission guide

| Permission | Why it is used |
|---|---|
| `webRequest` | Passively observes the headers Claude sends for `claude.ai` requests. It does not modify or block traffic. |
| `cookies` | Reads Claude cookies needed to identify the active workspace/session and construct the request. |
| `storage` | Keeps the latest captured details in `chrome.storage.local`. |
| `tabs` | Finds an open Claude tab to inspect and to run the export request from. |
| `activeTab` | Allows the popup to work with the currently active page when appropriate. |
| `scripting` | Injects the small content script into a Claude tab if it was opened before installation. |
| `clipboardWrite` | Copies the generated curl command and request details when you press a copy button. |
| `https://claude.ai/*` host access | Limits all page and request access to Claude rather than unrelated sites. |

The source is small and contains no remote imports, analytics SDKs, ad code, or hidden upload endpoint. You can verify that by reviewing these files:

- [`manifest.json`](manifest.json) — permissions and host restrictions
- [`background.js`](background.js) — passive request capture and local storage
- [`content.js`](content.js) — Claude-page context and the authenticated export request
- [`popup.js`](popup.js) — curl generation and local download
- [`lib/parse.js`](lib/parse.js) — parsing and formatting helpers

### Handling exported credentials safely

- Do not upload a captured curl command to a paste site, issue tracker, or chat.
- Do not add generated commands or exported private conversations to Git.
- Prefer the direct JSON download when you do not specifically need curl.
- Revoke or sign out of Claude if you accidentally expose a captured command.

## Limitations

- It exports the conversation that is currently open in Claude, not every conversation in your account.
- The exported JSON is the conversation API response, not a pixel-perfect copy of the rendered chat interface.
- Claude's private endpoints and required headers can change without notice.
- Only conversations that your current Claude account can access can be exported.
- Claude may rotate session cookies; use **Re-capture** if a request returns `401`.

## Development

The extension has no build step and no runtime dependencies. Node.js is only needed for the helper tests. The optional transcript extractor uses Python's standard library and has no third-party dependencies.

```bash
npm test
npm run test:transcript
```

The JavaScript suite covers URL and ID parsing, curl-template rendering, header parsing, cookie sanitization, source precedence, and session-refresh behavior. The Python suite covers transcript extraction, supported export shapes, output filters, result handling, and session selection.

Project layout:

```text
manifest.json          Chrome extension manifest
background.js          Request capture and local storage
content.js             Claude-page context and export request
popup.html/.css/.js    Extension interface, curl builder, and download
lib/parse.js           Shared parsing and formatting helpers
curl-template.txt      Default curl command template
icons/                 Extension icons
tools/selftest.js         Node.js extension self-tests
tools/test_transcript_extract.py  Python transcript-extractor tests
tools/package-crx.ps1     Builds and signs the distributable CRX on Windows
transcript_extract.py     Local conversation-to-transcript extractor
transcript_extract_README.md  Transcript extractor documentation
run_both.bat              Generates Markdown and JSON transcripts on Windows
Crx/                      Prepackaged extension package
```

## License

Released under the [MIT License](LICENSE).

## Disclaimer

This is an unofficial, personal-use utility and is not affiliated with or endorsed by Anthropic. It uses your existing browser session to retrieve data that you are already authorized to view. You are responsible for following Claude's terms, applicable laws, and your organization's data-handling policies.
