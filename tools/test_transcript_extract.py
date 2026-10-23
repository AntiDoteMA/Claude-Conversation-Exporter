#!/usr/bin/env python3
"""Tests for the standalone transcript extractor."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

import transcript_extract as extractor  # noqa: E402


SAMPLE_CONVERSATION = {
    "uuid": "conversation-1",
    "name": "Example conversation",
    "created_at": "2026-10-23T10:00:00Z",
    "updated_at": "2026-10-23T10:05:00Z",
    "chat_messages": [
        {
            "sender": "human",
            "created_at": "2026-10-23T10:00:00Z",
            "content": [{"type": "text", "text": "Please fix the export."}],
        },
        {
            "sender": "assistant",
            "created_at": "2026-10-23T10:01:00Z",
            "content": [
                {"type": "thinking", "summaries": [{"summary": "Checking the failing test."}]},
                {"type": "text", "text": "I found the issue and fixed it."},
                {
                    "type": "tool_use",
                    "id": "tool-1",
                    "name": "terminal:execute_command",
                    "input": {"command": "npm test"},
                },
            ],
        },
        {
            "sender": "human",
            "created_at": "2026-10-23T10:02:00Z",
            "content": [{
                "type": "tool_result",
                "tool_use_id": "tool-1",
                "name": "terminal:execute_command",
                "content": [{"type": "text", "text": "All checks passed"}],
            }],
        },
        {
            "sender": "assistant",
            "created_at": "2026-10-23T10:03:00Z",
            "content": [{"type": "text", "text": "The fix is complete."}],
        },
    ],
}


class TranscriptExtractorTests(unittest.TestCase):
    def write_json(self, directory: Path, name: str, payload) -> Path:
        path = directory / name
        path.write_text(json.dumps(payload), encoding="utf-8")
        return path

    def test_loads_extension_single_conversation_shape(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = self.write_json(Path(tmp), "conversation.json", SAMPLE_CONVERSATION)
            conversations = extractor.load(path)
            self.assertEqual(len(conversations), 1)
            self.assertEqual(conversations[0]["uuid"], "conversation-1")

    def test_loads_bulk_and_bare_message_shapes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bulk = self.write_json(root, "conversations.json", {"conversations": [SAMPLE_CONVERSATION]})
            messages = self.write_json(root, "messages.json", [
                {"role": "user", "text": "Hello"},
                {"role": "assistant", "text": "Hi"},
            ])
            self.assertEqual(len(extractor.load(bulk)), 1)
            loaded_messages = extractor.load(messages)
            self.assertEqual(len(loaded_messages), 1)
            self.assertEqual(len(loaded_messages[0]["chat_messages"]), 2)

    def test_normalizes_roles_and_plain_text_messages(self) -> None:
        conversation = {"chat_messages": [
            {"role": "user", "text": "Request"},
            {"role": "assistant", "text": "Reply"},
        ]}
        turns = extractor.build_turns(conversation)
        self.assertEqual(turns[0]["role"], "human")
        self.assertEqual(turns[1]["role"], "assistant")
        self.assertEqual(turns[0]["steps"][0]["kind"], "user_text")
        self.assertEqual(turns[1]["steps"][0]["kind"], "say")

    def test_markdown_includes_tool_output_only_when_requested(self) -> None:
        turns = extractor.build_turns(SAMPLE_CONVERSATION)
        facts = extractor.collect_facts(turns)
        default = extractor.render_transcript(SAMPLE_CONVERSATION, turns, True, True, False)
        included = extractor.render_transcript(SAMPLE_CONVERSATION, turns, True, True, True)
        self.assertIn("`execute_command`", default)
        self.assertNotIn("All checks passed", default)
        self.assertIn("All checks passed", included)

    def test_json_honors_tool_thinking_and_reference_filters(self) -> None:
        turns = extractor.build_turns(SAMPLE_CONVERSATION)
        facts = extractor.collect_facts(turns)
        payload = json.loads(extractor.render_json(
            SAMPLE_CONVERSATION, turns, facts,
            include_thinking=False, include_tools=False,
            include_results=False, include_reference=False,
        ))
        self.assertNotIn("facts", payload)
        kinds = [step["kind"] for turn in payload["turns"] for step in turn["steps"]]
        self.assertNotIn("tool", kinds)
        self.assertNotIn("think", kinds)

    def test_json_includes_successful_result_only_when_requested(self) -> None:
        turns = extractor.build_turns(SAMPLE_CONVERSATION)
        facts = extractor.collect_facts(turns)
        default = json.loads(extractor.render_json(
            SAMPLE_CONVERSATION, turns, facts, include_thinking=True
        ))
        included = json.loads(extractor.render_json(
            SAMPLE_CONVERSATION, turns, facts, include_thinking=True, include_results=True
        ))
        default_result = default["turns"][1]["steps"][2]["result"]
        included_result = included["turns"][1]["steps"][2]["result"]
        self.assertNotIn("excerpt", default_result)
        self.assertEqual(included_result["excerpt"], "All checks passed")

    def test_last_selection_uses_newest_message_timestamp(self) -> None:
        older = {"uuid": "older", "chat_messages": [
            {"sender": "human", "created_at": "2026-10-01T00:00:00Z", "content": []},
        ]}
        newer = {"uuid": "newer", "chat_messages": [
            {"sender": "human", "created_at": "2026-10-02T00:00:00Z", "content": []},
        ]}
        self.assertEqual(extractor.select([newer, older], "last"), [0])

    def test_cli_uses_conversation_json_by_default(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.write_json(root, "conversation.json", SAMPLE_CONVERSATION)
            result = subprocess.run(
                [sys.executable, str(REPO_ROOT / "transcript_extract.py")],
                cwd=root, capture_output=True, text=True,
                encoding="utf-8", check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("# Session: Example conversation", result.stdout)


if __name__ == "__main__":
    unittest.main()

