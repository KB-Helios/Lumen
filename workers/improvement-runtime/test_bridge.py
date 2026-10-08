import io
import json
import unittest

import bridge


def candidate():
    return {"baseVersion": 1, "kind": "prompt", "summary": "Clarify answers", "evidenceDigest": "a" * 64,
            "answerInstructions": "Answer concisely.", "computerUseInstructions": None, "toolHints": None,
            "preferences": [], "workflows": []}


class BoundaryTests(unittest.TestCase):
    def test_first_candidate_can_use_initial_version_zero(self):
        manifest = candidate()
        manifest["baseVersion"] = 0
        self.assertEqual(bridge.parse_manifest(json.dumps(manifest)), manifest)

    def test_oversized_frame_is_rejected_before_json_decode(self):
        with self.assertRaises(ValueError):
            bridge.read_frame(io.BytesIO(b" " * (bridge.FRAME_LIMIT + 1) + b"\n"))

    def test_duplicate_keys_cannot_shadow_protocol_fields(self):
        with self.assertRaises(ValueError):
            bridge.read_frame(io.BytesIO(b'{"v":1,"v":2}\n'))

    def test_valid_manifest_survives_and_unknown_field_is_rejected(self):
        manifest = candidate()
        self.assertEqual(bridge.parse_manifest(json.dumps(manifest)), manifest)
        manifest["script"] = "rm -rf /"
        with self.assertRaises(ValueError):
            bridge.parse_manifest(json.dumps(manifest))

    def test_workflow_cannot_embed_arguments_or_continue_after_desktop_draft(self):
        manifest = candidate()
        manifest["kind"] = "workflow"
        for steps in [[{"kind": "search", "query": "private"}],
                      [{"kind": "computerUseDraft"}, {"kind": "answer"}],
                      [{"kind": "answer"}] * 9]:
            manifest["workflows"] = [{"id": "test", "name": "Test", "steps": steps}]
            with self.assertRaises(ValueError):
                bridge.parse_manifest(json.dumps(manifest))

    def test_input_refuses_held_out_files_and_keeps_supplied_metadata_only(self):
        payload = {"activeVersion": {"id": 1}, "evidenceDigest": "a" * 64, "configDigest": "b" * 64,
                   "failures": [], "developmentCases": []}
        self.assertEqual(bridge.validate_input(payload), payload)
        payload["heldOutCases"] = [{"secret": "never send"}]
        with self.assertRaises(ValueError):
            bridge.validate_input(payload)

    def test_stream_adapter_preserves_tools_finish_reason_and_usage(self):
        response = {"id": "chatcmpl-test", "model": "host", "choices": [{"index": 0, "message": {
            "role": "assistant", "content": None, "tool_calls": [{"id": "call-1", "type": "function", "function": {
                "name": "ipython", "arguments": "{}"}}]}, "finish_reason": "tool_calls"}],
            "usage": {"prompt_tokens": 8, "completion_tokens": 2, "total_tokens": 10}}
        chunks = bridge.stream_chunks(response)
        self.assertEqual(chunks[0]["choices"][0]["delta"]["tool_calls"][0]["index"], 0)
        self.assertEqual(chunks[1]["choices"][0]["finish_reason"], "tool_calls")
        self.assertEqual(chunks[-1]["usage"]["total_tokens"], 10)


if __name__ == "__main__":
    unittest.main()
