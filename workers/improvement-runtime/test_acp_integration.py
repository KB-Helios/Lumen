import asyncio
import json
import pathlib
import sys
import unittest
from unittest.mock import patch

import bridge
from test_bridge import candidate


class AcpIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def launch(self, extra, operation):
        real_spawn = asyncio.create_subprocess_exec
        real_server = asyncio.start_server
        port = 0
        async def bind(callback, host, requested_port, **kwargs):
            nonlocal port
            self.assertEqual((host, requested_port), ("127.0.0.1", 8765))
            # Windows reserves the fixed guest port; tests use an ephemeral host port.
            server = await real_server(callback, host, 0, **kwargs)
            port = server.sockets[0].getsockname()[1]
            return server
        async def spawn(*args, **kwargs):
            # Replace only the unavailable Linux executable; the bridge and ACP pipes are real.
            self.assertEqual(args[0], "/usr/local/bin/prime-agent")
            self.assertIn("--offline", args)
            return await real_spawn(sys.executable, str(pathlib.Path(__file__).with_name("acp_fixture.py")), f"--port={port}", *extra, **kwargs)
        with patch("bridge.asyncio.create_subprocess_exec", spawn), patch("bridge.asyncio.start_server", bind):
            await operation()

    async def test_real_subprocess_frames_and_loopback_proxy_deliver_bounded_manifest(self):
        records = []
        manifest = candidate()
        class BrokerBridge(bridge.Bridge):
            async def host_reader(self):
                await asyncio.Future()
            def emit(self, frame):
                records.append(frame)
                if frame["type"] == "modelRequest":
                    self.pending[frame["id"]].set_result({"choices": [{"index": 0, "message": {"role": "assistant", "content": json.dumps(manifest)}, "finish_reason": "stop"}],
                                                        "usage": {"prompt_tokens": 500, "completion_tokens": 100, "total_tokens": 600}})
        async def operation():
            await asyncio.wait_for(BrokerBridge().generate({"activeVersion": {"id": 1}, "evidenceDigest": "a" * 64,
                                                          "configDigest": "b" * 64, "failures": [], "developmentCases": []}), 5)
        await self.launch([], operation)
        self.assertEqual(records[-1], {"type": "result", "manifest": manifest})
        request = next(frame for frame in records if frame["type"] == "modelRequest")
        self.assertFalse(request["body"]["stream"])
        self.assertNotIn("stream_options", request["body"])

    async def test_wrong_acp_version_never_emits_healthy_state(self):
        records = []
        class ProbeBridge(bridge.Bridge):
            def emit(self, frame):
                records.append(frame)
        async def operation():
            with self.assertRaises(ValueError):
                await ProbeBridge().probe()
        await self.launch(["--bad-version"], operation)
        self.assertEqual(records, [])

    async def test_cancel_uses_acp_notification_and_never_returns_manifest(self):
        records = []
        class CancelBridge(bridge.Bridge):
            def emit(self, frame):
                records.append(frame)
            async def host_reader(self):
                while not self.session:
                    await asyncio.sleep(0.01)
                await asyncio.sleep(0.05)
                self.cancelled.set()
                await self.acp_send({"jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": self.session}})
        async def operation():
            with self.assertRaises((ValueError, asyncio.CancelledError)):
                await asyncio.wait_for(CancelBridge().generate({"activeVersion": {"id": 1}, "evidenceDigest": "a" * 64,
                                                               "configDigest": "b" * 64, "failures": [], "developmentCases": []}), 5)
        await self.launch(["--cancel"], operation)
        self.assertFalse(any(frame["type"] == "result" for frame in records))
