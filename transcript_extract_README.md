# Compact transcript extractor

`transcript_extract.py` turns a Claude conversation export into a compact,
step-by-step Markdown or JSON transcript. It is designed for reading the
important parts of a long session without carrying every full tool payload.

The extension in this repository downloads the active conversation as
`conversation.json`. This utility can consume that file directly. It also
supports Claude bulk exports such as `conversations.json`.

> [!IMPORTANT]
> The extracted transcript still contains private conversation content. It is
> processed locally, but treat `transcript.md` and `transcript.json` as
> sensitive files and do not commit or publish them without reviewing them.

## Requirements

- Python 3.9 or newer
- No third-party Python packages

## Quick start

From the repository root:

```bash
# Markdown transcript of conversation.json
python transcript_extract.py

# Machine-readable JSON transcript
python transcript_extract.py --format json --out transcript.json

# Both outputs at once on Windows
run_both.bat
```

The default input is `conversation.json`. Pass another path as the first
argument to read a bulk export:

```bash
python transcript_extract.py conversations.json --out transcript.md
```

## Commands

```text
python transcript_extract.py [file]
  --session last|first|<index>  Select a conversation (default: last)
  --last N                     Select the last N conversations
  --list                       List conversations and exit
  --format md|json             Output format (default: md)
  --out FILE                   Write output to a file
  --include-results            Include bounded successful tool-result text
  --no-tools                   Hide tool steps from the narrative
  --no-thinking                Hide thinking summaries
  --no-reference               Hide the reference index / JSON facts
  --budget N                   Cap Markdown output at N characters
```

Examples:

```bash
# Index every conversation in a bulk export
python transcript_extract.py conversations.json --list

# Extract a specific conversation by its zero-based index
python transcript_extract.py conversations.json --session 11

# Extract the three most recently active conversations
python transcript_extract.py conversations.json --last 3

# Hide tool steps and thinking for a shorter handoff
python transcript_extract.py --no-tools --no-thinking

# Include useful tool output while keeping each result bounded
python transcript_extract.py --include-results
```

## What it preserves

The extractor is deterministic: it does not call an AI service and does not
upload anything. It preserves the conversation in chronological order:

- user requests
- assistant narration
- available thinking summaries
- tool names and selected arguments
- tool failures and their error excerpts
- optional bounded excerpts of successful tool results
- files read, written, or edited
- commands run
- the last assistant message as the likely handoff state

Large payloads such as complete file contents and command output are omitted by
default. Failed commands remain visible because they often explain where work
stopped. `--include-results` adds up to 1,200 characters from each successful
tool result.

## Markdown output

```markdown
## Turn 3 - USER (2026-10-23T14:20:00Z)

> Please fix the failing export.

## Turn 4 - ASSISTANT (2026-10-23T14:20:10Z)

I found the error and corrected it.

- 🔧 `terminal:execute_command` → npm test
  ↳ ❌
     one test failed

---

# Reference index
```

A reference index follows the transcript. It lists derived facts such as files
edited, commands run, errors, and the final assistant message.

## JSON output

JSON output contains:

- conversation metadata
- normalized turns and ordered steps
- an optional `facts` object with the derived reference information

`--no-tools` removes tool steps from the narrative, `--no-thinking` removes
thinking summaries, and `--no-reference` removes the facts object. The
reference index may still summarize tool-derived facts unless
`--no-reference` is also used. Successful result excerpts are omitted unless
`--include-results` is used. Error excerpts remain included.

## Supported export shapes

The script recognizes:

- one conversation object containing `chat_messages` (the extension download)
- a list of conversation objects
- a dictionary containing `conversations`, `data`, `items`, `chats`, or `sessions`
- a bare list of messages

Both Claude's `sender` values (`human` and `assistant`) and generic `role`
values (`user` and `assistant`) are supported. Older exports that store prose
in `msg.text` are supported as well as exports that use content blocks.

Conversations are ordered by their newest **message** timestamp rather than
`updated_at`, because bulk exports can update the latter independently of the
actual conversation activity.

## Tests

Run the standard-library test suite with:

```bash
python -m unittest discover -s tools -p "test_*.py" -v
```
