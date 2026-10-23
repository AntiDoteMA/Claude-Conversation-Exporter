#!/usr/bin/env python3
"""Extract a compact, agent-ready transcript from a Claude conversation export.

The export can be large because every tool call stores its full input (file
contents, diff bodies, command output) inside the assistant message. An agent
resuming the work does not need those payloads -- it needs the sequence: what
was asked, what was thought, what was said, what was run, what broke, and where
the work stopped.

The output preserves the conversation as a linear step-by-step stream. Each
assistant turn becomes an ordered list of steps in the order they happened:

    💭 thinking summary
    🔧 tool call with its arguments
       ↳ ✅ result ok   /   ↳ ❌ error with excerpt
    💬 narration

Usage:
    python transcript_extract.py                        # transcript of conversation.json
    python transcript_extract.py conversations.json     # a bulk conversations export
    python transcript_extract.py --list                 # index of all conversations
    python transcript_extract.py --session 3            # a specific one (0-based)
    python transcript_extract.py --format json          # machine readable
    python transcript_extract.py --out transcript.md    # write to a file
    python transcript_extract.py --include-results      # include successful tool output
    python transcript_extract.py --no-thinking          # drop thinking summaries
    python transcript_extract.py --no-tools             # drop tool calls, keep the narrative
    python transcript_extract.py --last 2               # the last N sessions
    python transcript_extract.py --budget 60000         # cap Markdown output (chars)
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

DEFAULT_FILE = "conversation.json"

# Blocks that are pure noise for a resuming agent.
NOISE_BLOCKS = {"injected_prompt_block"}


# --------------------------------------------------------------------------
# loading / selection
# --------------------------------------------------------------------------
def load(path: Path) -> list[dict]:
    with path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)
    if isinstance(data, dict):
        # A single conversation exported on its own. This is the shape produced
        # by the Chrome extension's "Download conversation JSON" action.
        if isinstance(data.get("chat_messages"), list):
            return [data]
        # Tolerate {"conversations": [...]} style bulk exports.
        for key in ("conversations", "data", "items", "chats", "sessions"):
            if isinstance(data.get(key), list):
                if not data[key]:
                    raise SystemExit("the export contains no conversations")
                return data[key]
        raise SystemExit(f"unrecognised export shape: {list(data)[:10]}")
    if not isinstance(data, list):
        raise SystemExit("unrecognised export shape")
    if not data:
        raise SystemExit("the export contains no conversations")

    # A list of conversations, or a list of messages belonging to one.
    if isinstance(data[0], dict) and "chat_messages" not in data[0] \
            and ("sender" in data[0] or "role" in data[0]):
        return [{"uuid": None, "name": "(single conversation)", "chat_messages": data}]
    return data


def parse_ts(value: str) -> datetime:
    if not value:
        return datetime.min
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return datetime.min


def convo_time(convo: dict) -> datetime:
    """Last activity time of a conversation.

    Uses the newest message timestamp, not `updated_at`: the export bumps
    `updated_at` on every conversation it touches, so it does not reflect when
    the conversation actually happened.
    """
    msgs = convo.get("chat_messages") or []
    stamps = [m.get("created_at") for m in msgs if m.get("created_at")]
    if stamps:
        return parse_ts(max(stamps))
    return parse_ts(convo.get("created_at") or "")


def index_convos(convos: list[dict]) -> list[dict]:
    rows = []
    for i, c in enumerate(convos):
        msgs = c.get("chat_messages") or []
        # this export leaves `text` empty and puts the prose in the content
        # blocks, so count both
        text_len = sum(
            len(m.get("text") or "")
            + sum(
                len(b.get("text") or "")
                for b in (m.get("content") or [])
                if isinstance(b, dict) and b.get("type") == "text"
            )
            for m in msgs
        )
        blocks = sum(len(m.get("content") or []) for m in msgs)
        tools = sum(
            1 for m in msgs for b in (m.get("content") or [])
            if isinstance(b, dict) and b.get("type") == "tool_use"
        )
        rows.append(
            {
                "index": i,
                "uuid": c.get("uuid"),
                "name": c.get("name") or "(unnamed)",
                "created_at": c.get("created_at"),
                "updated_at": c.get("updated_at"),
                "messages": len(msgs),
                "blocks": blocks,
                "tools": tools,
                "text_chars": text_len,
                "last_activity": convo_time(c),
            }
        )
    return rows


def select(convos: list[dict], which: str) -> list[int]:
    """Return the conversation indexes to digest."""
    order = sorted(range(len(convos)), key=lambda i: convo_time(convos[i]))
    if which == "last":
        return [order[-1]]
    if which == "first":
        return [order[0]]
    if which.isdigit():
        idx = int(which)
        if not 0 <= idx < len(convos):
            raise SystemExit(f"no conversation at index {idx}")
        return [idx]
    raise SystemExit(f"unknown --session selector: {which}")


# --------------------------------------------------------------------------
# block helpers
# --------------------------------------------------------------------------
def blocks(msg: dict) -> list[dict]:
    return [b for b in (msg.get("content") or []) if isinstance(b, dict)]


def message_role(msg: dict) -> str:
    """Normalize Claude's `sender` and generic exports' `role` fields."""
    role = (msg.get("sender") or msg.get("role") or "").lower()
    if role in ("human", "user"):
        return "human"
    if role in ("assistant", "ai"):
        return "assistant"
    return role or "unknown"


def message_blocks(msg: dict) -> list[dict]:
    """Return content blocks, falling back to a legacy plain-text message."""
    content = blocks(msg)
    if content:
        return content
    text = (msg.get("text") or "").strip()
    return [{"type": "text", "text": text}] if text else []


def truncate(text: str, limit: int) -> str:
    text = (text or "").replace("\r\n", "\n").strip()
    if limit <= 0 or len(text) <= limit:
        return text
    head = int(limit * 0.7)
    tail = int(limit * 0.2)
    return f"{text[:head]}\n...[{len(text) - head - tail} chars omitted]...\n{text[-tail:]}"


def tool_name(name: str) -> str:
    """Shorten the tool names for readability.

    Old export shape:
        `mcp__claude-device__lcl-Filesystem-write_file` -> `write_file`
        `mcp__claude-device__lcl-work-board-resume`      -> `work_board_resume`

    Current export shape (integration-qualified):
        `Filesystem:read_text_file`  -> `read_text_file`
        `terminal:execute_command`   -> `execute_command`
        `work-board:get_board`       -> `work_board_get_board`
    """
    short = name or ""
    if short.startswith("mcp__"):
        short = short.split("__")[-1]
    if short.startswith("lcl-"):
        short = short[4:]
    if ":" in short:
        integration, _, rest = short.partition(":")
        integration = integration.replace("-", "_")
        if integration.lower() in ("filesystem", "terminal", "shell", "exec"):
            short = rest
        else:
            short = f"{integration}_{rest}"
    for prefix in ("Filesystem-", "Filesystem_", "terminal-"):
        if short.startswith(prefix):
            short = short[len(prefix):]
            break
    return short.replace("-", "_")


def render_tool_result(block: dict) -> str:
    content = block.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict):
                t = item.get("text")
                if t:
                    parts.append(t)
        return "\n".join(parts)
    return ""


def thinking_summary(block: dict) -> str:
    """Recover the reasoning from a thinking block.

    The `thinking` field is redacted in this export, but most blocks still carry
    one or more `summaries` entries -- a short description of what was reasoned.
    """
    summaries = block.get("summaries")
    if isinstance(summaries, list):
        parts = []
        for s in summaries:
            if isinstance(s, dict):
                t = s.get("summary")
                if t:
                    parts.append(t.strip())
        if parts:
            return " / ".join(parts)
    text = (block.get("thinking") or "").strip()
    return text


def summarize_tool_call(block: dict) -> dict:
    """Pull the meaningful bits out of a tool_use input."""
    name = block.get("name") or ""
    short = tool_name(name)
    inp = block.get("input") or {}
    info: dict = {"tool": short, "raw_name": name}

    if "path" in inp:
        info["path"] = inp["path"]
    if "paths" in inp:
        info["paths"] = inp["paths"]
    if "pattern" in inp:
        info["pattern"] = inp["pattern"]
    if "query" in inp:
        info["query"] = inp["query"]
    if "skill" in inp:
        info["skill"] = inp["skill"]
    if "subject" in inp:
        info["subject"] = inp["subject"]
    if "status" in inp:
        info["status"] = inp["status"]
    if "taskId" in inp:
        info["taskId"] = inp["taskId"]
    if "ticket_id" in inp:
        info["ticket_id"] = inp["ticket_id"]
    if "title" in inp:
        info["title"] = inp["title"]
    if "next_action" in inp:
        info["next_action"] = inp["next_action"]
    if "summary" in inp:
        info["summary"] = inp["summary"]
    if "reason" in inp:
        info["reason"] = inp["reason"]
    if "action_summary" in inp:
        info["action_summary"] = inp["action_summary"]
    if "question" in inp:
        info["question"] = inp["question"]
    if "note" in inp:
        info["note"] = inp["note"]
    if "verification" in inp:
        info["verification"] = inp["verification"]
    if "files_touched" in inp:
        info["files_touched"] = inp["files_touched"]
    if "view_range" in inp:
        info["view_range"] = inp["view_range"]
    if "head" in inp:
        info["head"] = inp["head"]
    if "tail" in inp:
        info["tail"] = inp["tail"]
    if "working_directory" in inp:
        info["working_directory"] = inp["working_directory"]
    if "command" in inp:
        cmd = inp["command"]
        args = inp.get("args") or []
        parts = [str(a) for a in args]
        info["command"] = " ".join([str(cmd)] + parts).strip()
        if inp.get("cwd"):
            info["cwd"] = inp["cwd"]
    if "content" in inp:
        info["content_chars"] = len(inp["content"] or "")
    if "edits" in inp:
        edits = inp["edits"] or []
        info["edit_count"] = len(edits)
        info["edits"] = [
            {
                "old": truncate(e.get("oldText") or "", 400),
                "new": truncate(e.get("newText") or "", 600),
            }
            for e in edits
            if isinstance(e, dict)
        ]
    return info


def describe_args(info: dict) -> str:
    """The argument summary shown next to a tool call."""
    bits = []
    if "command" in info:
        bits.append(info["command"])
    if "path" in info:
        bits.append(str(info["path"]))
    if "paths" in info:
        bits.append(", ".join(str(p) for p in info["paths"]))
    if "pattern" in info:
        bits.append(f"pattern={info['pattern']}")
    if "query" in info:
        bits.append(f"query={info['query']}")
    for key in (
        "ticket_id",
        "title",
        "subject",
        "skill",
        "status",
        "taskId",
        "next_action",
        "action_summary",
        "summary",
        "reason",
        "question",
        "note",
        "verification",
        "view_range",
    ):
        if key in info:
            bits.append(f"{key}={info[key]}")
    if info.get("files_touched"):
        bits.append("files=" + ", ".join(str(f) for f in info["files_touched"]))
    if "edit_count" in info:
        bits.append(f"{info['edit_count']} edit(s)")
    if "content_chars" in info:
        bits.append(f"{info['content_chars']} chars")
    return " | ".join(str(b) for b in bits)


# --------------------------------------------------------------------------
# transcript model
# --------------------------------------------------------------------------
def build_turns(convo: dict) -> list[dict]:
    """Turn the flat block stream into ordered, per-turn steps.

    A step is one of:
        think  - a thinking summary
        say    - assistant narration
        tool   - a tool call, with an optional paired result
    """
    turns: list[dict] = []
    # map tool_use id -> the step that owns it, so results attach to their call
    pending: dict[str, dict] = {}

    for msg in convo.get("chat_messages") or []:
        role = message_role(msg)
        turn = {
            "role": role,
            "at": msg.get("created_at"),
            "steps": [],
            "text": "",
        }
        turns.append(turn)

        said: list[str] = []

        for b in message_blocks(msg):
            btype = b.get("type")
            if btype in NOISE_BLOCKS:
                continue

            if btype == "text":
                t = (b.get("text") or "").strip()
                if not t:
                    continue
                if role == "human":
                    turn["steps"].append({"kind": "user_text", "text": t})
                else:
                    said.append(t)
                    turn["steps"].append({"kind": "say", "text": t})

            elif btype == "thinking":
                s = thinking_summary(b)
                if s:
                    turn["steps"].append({"kind": "think", "text": s})

            elif btype == "tool_use":
                info = summarize_tool_call(b)
                step = {"kind": "tool", "info": info, "result": None}
                turn["steps"].append(step)
                tid = b.get("id")
                if tid:
                    pending[tid] = step

            elif btype == "tool_result":
                text = render_tool_result(b)
                err = bool(b.get("is_error"))
                res = {"tool": tool_name(b.get("name") or ""), "error": err, "chars": len(text)}
                # Keep a bounded excerpt so --include-results can show useful
                # output without restoring the full payload that made the
                # original export large.
                if text:
                    res["excerpt"] = truncate(text, 1200)
                step = pending.pop(b.get("tool_use_id"), None)
                if step is not None:
                    step["result"] = res
                else:
                    turn["steps"].append({"kind": "orphan_result", "result": res})

        turn["text"] = "\n\n".join(said)
        if role == "human":
            turn["text"] = "\n".join(
                s["text"] for s in turn["steps"] if s["kind"] == "user_text"
            )
    return turns


def collect_facts(turns: list[dict]) -> dict:
    """Roll the step stream up into a reference index (files, commands, errors)."""
    facts = {
        "tools_used": {},
        "files_written": [],
        "files_edited": [],
        "files_read": [],
        "commands": [],
        "errors": [],
    }
    for turn in turns:
        for step in turn["steps"]:
            if step["kind"] != "tool":
                continue
            info = step["info"]
            facts["tools_used"][info["tool"]] = facts["tools_used"].get(info["tool"], 0) + 1
            path = info.get("path")
            if path:
                if info["tool"] == "write_file":
                    facts["files_written"].append(path)
                elif info["tool"] == "edit_file":
                    facts["files_edited"].append(path)
                elif info["tool"] in ("read_text_file", "read_multiple_files"):
                    facts["files_read"].append(path)
            for p in info.get("paths", []) or []:
                facts["files_read"].append(p)
            if "command" in info:
                facts["commands"].append(info["command"])
            if step.get("result") and step["result"].get("error"):
                facts["errors"].append({**step["result"], "at": turn["at"]})
    return facts


def dedupe(items: list[str]) -> list[str]:
    seen = set()
    res = []
    for i in items:
        if i not in seen:
            seen.add(i)
            res.append(i)
    return res


# --------------------------------------------------------------------------
# rendering
# --------------------------------------------------------------------------
def render_transcript(convo: dict, turns: list[dict], include_tools: bool,
                      include_thinking: bool, include_results: bool) -> str:
    out: list[str] = []
    out.append(f"# Session: {convo.get('name') or '(unnamed)'}")
    out.append("")
    out.append(f"- uuid: `{convo.get('uuid')}`")
    out.append(f"- started: {convo.get('created_at')}")
    out.append(f"- ended: {convo.get('updated_at')}")
    out.append(f"- messages: {len(turns)}")
    out.append("")

    turn_no = 0
    for turn in turns:
        has_content = any(
            s["kind"] in ("user_text", "say", "think", "tool") for s in turn["steps"]
        )
        if not has_content:
            continue
        turn_no += 1
        who = "USER" if turn["role"] == "human" else "ASSISTANT"
        out.append(f"## Turn {turn_no} - {who} ({turn['at']})")
        out.append("")

        for step in turn["steps"]:
            kind = step["kind"]

            if kind == "user_text":
                for line in step["text"].splitlines():
                    out.append(f"> {line}" if line.strip() else ">")
                out.append("")

            elif kind == "say":
                out.append(step["text"])
                out.append("")

            elif kind == "think":
                if not include_thinking:
                    continue
                out.append(f"> 💭 _{step['text']}_")
                out.append("")

            elif kind == "tool":
                if not include_tools:
                    continue
                info = step["info"]
                args = describe_args(info)
                head = f"- 🔧 `{info['tool']}`"
                if args:
                    head += f" → {args}"
                out.append(head)
                res = step.get("result")
                if res:
                    if res.get("error"):
                        # failures are always shown inline: they are the part
                        # a resuming agent most needs to see
                        out.append("  ↳ ❌")
                        for line in (res.get("excerpt") or "").splitlines():
                            out.append(f"     {line}")
                    elif include_results:
                        out.append("  ↳ ✅ ok")
                        for line in (res.get("excerpt") or "").splitlines():
                            out.append(f"     {line}")
                for edit in info.get("edits", []) or []:
                    out.append("  - OLD:")
                    for line in edit["old"].splitlines()[:12]:
                        out.append(f"    {line}")
                    out.append("  - NEW:")
                    for line in edit["new"].splitlines()[:20]:
                        out.append(f"    {line}")
                out.append("")

            elif kind == "orphan_result":
                res = step["result"]
                if res.get("error"):
                    out.append(f"- ↳ ❌ `{res['tool']}` (result without a visible call)")
                    for line in (res.get("excerpt") or "").splitlines():
                        out.append(f"  {line}")
                    out.append("")

    return "\n".join(out)


def render_reference(convo: dict, turns: list[dict], facts: dict) -> str:
    """The roll-up index. Placed last so it never interrupts the narrative."""
    out: list[str] = []
    out.append("---")
    out.append("")
    out.append("# Reference index")
    out.append("")
    out.append("Derived from the transcript above. Not part of the step order.")
    out.append("")

    for label, key in (
        ("Files written", "files_written"),
        ("Files edited", "files_edited"),
    ):
        vals = dedupe(facts[key])
        if vals:
            out.append(f"## {label}")
            out.append("")
            for v in vals:
                out.append(f"- {v}")
            out.append("")

    if facts["commands"]:
        out.append("## Commands run")
        out.append("")
        for c in dedupe(facts["commands"]):
            out.append(f"- `{c}`")
        out.append("")

    if facts["errors"]:
        out.append("## Errors")
        out.append("")
        for e in facts["errors"]:
            out.append(f"### {e['at']} - `{e['tool']}`")
            out.append("")
            for line in (e.get("excerpt") or "").splitlines():
                out.append(f"    {line}")
            out.append("")

    assistant_says = [
        s["text"].strip()
        for t in turns
        if t["role"] == "assistant"
        for s in t["steps"]
        if s["kind"] == "say" and s["text"].strip()
    ]
    if assistant_says:
        out.append("## Final state (last thing the assistant said)")
        out.append("")
        out.append(assistant_says[-1])
        out.append("")

    return "\n".join(out)


def render_json(convo: dict, turns: list[dict], facts: dict, include_thinking: bool,
                include_tools: bool = True, include_results: bool = False,
                include_reference: bool = True) -> str:
    slim = []
    for turn in turns:
        steps = []
        for step in turn["steps"]:
            if step["kind"] == "think" and not include_thinking:
                continue
            if step["kind"] == "tool":
                if not include_tools:
                    continue
                info = dict(step["info"])
                info.pop("edits", None)
                result = step.get("result")
                if result and not include_results and not result.get("error"):
                    result = dict(result)
                    result.pop("excerpt", None)
                steps.append({"kind": "tool", "info": info, "result": result})
            else:
                steps.append(step)
        slim.append({"role": turn["role"], "at": turn["at"], "steps": steps})
    payload = {
        "uuid": convo.get("uuid"),
        "name": convo.get("name"),
        "created_at": convo.get("created_at"),
        "updated_at": convo.get("updated_at"),
        "turns": slim,
    }
    if include_reference:
        payload["facts"] = facts
    return json.dumps(payload, indent=2, ensure_ascii=False)


def apply_budget(text: str, budget: int) -> str:
    """Hard cap on the output size, keeping the tail (final state) intact."""
    if budget <= 0 or len(text) <= budget:
        return text
    head = int(budget * 0.75)
    tail = int(budget * 0.2)
    return (
        text[:head]
        + f"\n\n...[budget: {len(text) - head - tail} chars omitted]...\n\n"
        + text[-tail:]
    )


def main(argv: list[str]) -> int:
    # Windows consoles default to cp1252, which cannot encode the markers used
    # in the transcript. Force UTF-8 on stdout/stderr.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("file", nargs="?", default=DEFAULT_FILE,
                    help="path to conversation.json or a bulk conversations export")
    ap.add_argument("--session", default="last", help="last | first | <index>")
    ap.add_argument("--last", type=int, default=1, help="transcribe the last N sessions")
    ap.add_argument("--list", action="store_true", help="list conversations and exit")
    ap.add_argument("--format", choices=["md", "json"], default="md")
    ap.add_argument("--out", help="write to this file instead of stdout")
    ap.add_argument("--include-tools", action="store_true",
                    help="show tool calls (already enabled by default)")
    ap.add_argument("--no-tools", action="store_true", help="hide tool calls")
    ap.add_argument("--include-results", action="store_true",
                    help="include bounded successful tool-result text")
    ap.add_argument("--no-thinking", action="store_true", help="drop thinking summaries")
    ap.add_argument("--no-reference", action="store_true",
                    help="drop the Markdown reference index or JSON facts")
    ap.add_argument("--budget", type=int, default=0,
                    help="cap Markdown output size in chars (0 = no cap)")
    args = ap.parse_args(argv)

    if args.last < 1:
        raise SystemExit("--last must be at least 1")
    if args.budget < 0:
        raise SystemExit("--budget cannot be negative")
    if args.include_tools and args.no_tools:
        raise SystemExit("--include-tools and --no-tools cannot be used together")

    path = Path(args.file)
    if not path.exists():
        raise SystemExit(f"file not found: {path}")

    convos = load(path)

    if args.list:
        rows = index_convos(convos)
        print(f"{'idx':>3}  {'msgs':>4}  {'tools':>5}  {'chars':>8}  last activity             name")
        for r in rows:
            print(
                f"{r['index']:>3}  {r['messages']:>4}  {r['tools']:>5}  {r['text_chars']:>8}  "
                f"{r['last_activity'].isoformat():<26}  {r['name']}"
            )
        return 0

    if args.last > 1:
        order = sorted(range(len(convos)), key=lambda i: convo_time(convos[i]))
        idxs = order[-args.last:]
    else:
        idxs = select(convos, args.session)

    include_tools = not args.no_tools
    include_thinking = not args.no_thinking

    parts: list[str] = []
    payloads = []
    for i in idxs:
        convo = convos[i]
        turns = build_turns(convo)
        facts = collect_facts(turns)
        if args.format == "json":
            payloads.append(
                json.loads(render_json(
                    convo,
                    turns,
                    facts,
                    include_thinking,
                    include_tools=include_tools,
                    include_results=args.include_results,
                    include_reference=not args.no_reference,
                ))
            )
            continue
        parts.append(render_transcript(convo, turns, include_tools, include_thinking, args.include_results))
        if not args.no_reference:
            parts.append(render_reference(convo, turns, facts))

    if args.format == "json":
        out = json.dumps(payloads, indent=2, ensure_ascii=False)
    else:
        out = "\n\n".join(parts)
        out = apply_budget(out, args.budget)

    if args.out:
        Path(args.out).write_text(out, encoding="utf-8")
        print(f"wrote {args.out} ({len(out)} chars)")
    else:
        sys.stdout.write(out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
