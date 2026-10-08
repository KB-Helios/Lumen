"""Credential-free guest ACP bridge. Every emitted byte remains untrusted."""
import asyncio
import io
import json
import os
import pathlib
import sys

FRAME_LIMIT = 524288
OUTPUT_LIMIT = 2097152
MANIFEST_LIMIT = 32768
PRIME_VERSION = "0.9.8"
PROTOCOL = 1


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


def decode(text):
    return json.loads(text, object_pairs_hook=unique_object,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite")))


def read_frame(stream):
    line = stream.readline(FRAME_LIMIT + 1)
    if not line or len(line) > FRAME_LIMIT or not line.endswith(b"\n"):
        raise ValueError("invalid frame")
    value = decode(line)
    if not isinstance(value, dict):
        raise ValueError("invalid frame")
    return value


def fields(value, names):
    if not isinstance(value, dict) or set(value) != set(names):
        raise ValueError("invalid fields")


def bounded_text(value, limit, nullable=False):
    if nullable and value is None:
        return
    if not isinstance(value, str) or len(value.encode()) > limit:
        raise ValueError("invalid text")


def digest(value):
    return isinstance(value, str) and len(value) == 64 and all(c in "0123456789abcdef" for c in value)


def parse_manifest(text):
    if len(text.encode()) > MANIFEST_LIMIT:
        raise ValueError("manifest too large")
    value = decode(text)
    fields(value, ["baseVersion", "kind", "summary", "evidenceDigest", "answerInstructions",
                   "computerUseInstructions", "toolHints", "preferences", "workflows"])
    if type(value["baseVersion"]) is not int or value["baseVersion"] < 0 or value["kind"] not in ("memory", "prompt", "workflow"):
        raise ValueError("invalid manifest")
    if not digest(value["evidenceDigest"]):
        raise ValueError("invalid digest")
    bounded_text(value["summary"], 512)
    for name in ("answerInstructions", "computerUseInstructions", "toolHints"):
        bounded_text(value[name], 4096, True)
    preferences = value["preferences"]
    if not isinstance(preferences, list) or len(preferences) > 2:
        raise ValueError("invalid preferences")
    names = set()
    for preference in preferences:
        fields(preference, ["name", "value"])
        if preference["name"] not in ("answerLanguage", "answerVerbosity") or preference["name"] in names:
            raise ValueError("invalid preference")
        names.add(preference["name"])
        bounded_text(preference["value"], 128)
    workflows = value["workflows"]
    if not isinstance(workflows, list) or len(workflows) > 8:
        raise ValueError("invalid workflows")
    ids = set()
    for workflow in workflows:
        fields(workflow, ["id", "name", "steps"])
        bounded_text(workflow["id"], 64)
        bounded_text(workflow["name"], 128)
        if not workflow["id"] or workflow["id"] in ids:
            raise ValueError("invalid workflow id")
        ids.add(workflow["id"])
        steps = workflow["steps"]
        if not isinstance(steps, list) or not 1 <= len(steps) <= 8:
            raise ValueError("invalid steps")
        for index, step in enumerate(steps):
            fields(step, ["kind"])
            if step["kind"] not in ("search", "answer", "computerUseDraft") or (step["kind"] == "computerUseDraft" and index != len(steps) - 1):
                raise ValueError("invalid step")
    return value


def validate_input(value):
    fields(value, ["activeVersion", "evidenceDigest", "configDigest", "failures", "developmentCases"])
    if not digest(value["evidenceDigest"]) or not digest(value["configDigest"]):
        raise ValueError("invalid digest")
    if not isinstance(value["activeVersion"], dict) or type(value["activeVersion"].get("id")) is not int:
        raise ValueError("invalid version")
    if not isinstance(value["failures"], list) or len(value["failures"]) > 32:
        raise ValueError("invalid failures")
    if not isinstance(value["developmentCases"], list) or len(value["developmentCases"]) > 32:
        raise ValueError("invalid development cases")
    if len(json.dumps(value).encode()) > 131072:
        raise ValueError("input too large")
    return value


def stream_chunks(value):
    chunks = []
    common = {"id": value.get("id", "chatcmpl-lumen"), "object": "chat.completion.chunk",
              "created": value.get("created", 0), "model": "lumen-host"}
    for choice in value["choices"]:
        message = dict(choice["message"])
        if "tool_calls" in message:
            message["tool_calls"] = [dict(call, index=i) for i, call in enumerate(message["tool_calls"])]
        chunks.append(dict(common, choices=[{"index": choice.get("index", 0), "delta": message, "finish_reason": None}]))
        chunks.append(dict(common, choices=[{"index": choice.get("index", 0), "delta": {}, "finish_reason": choice.get("finish_reason", "stop")}]))
    chunks.append(dict(common, choices=[], usage=value.get("usage")))
    return chunks


class Bridge:
    def __init__(self):
        self.pending = {}
        self.next_id = 0
        self.emitted = 0
        self.session = None
        self.prime = None
        self.cancelled = asyncio.Event()

    def emit(self, value):
        line = (json.dumps(dict(v=PROTOCOL, **value), separators=(",", ":")) + "\n").encode()
        self.emitted += len(line)
        if len(line) > FRAME_LIMIT or self.emitted > OUTPUT_LIMIT:
            raise ValueError("output limit")
        sys.stdout.buffer.write(line)
        sys.stdout.buffer.flush()

    async def host_reader(self):
        while True:
            frame = await asyncio.to_thread(read_frame, sys.stdin.buffer)
            if frame.get("v") != PROTOCOL:
                raise ValueError("protocol mismatch")
            if frame.get("type") == "cancel":
                fields(frame, ["v", "type"])
                self.cancelled.set()
                if self.session:
                    await self.acp_send({"jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": self.session}})
                return
            fields(frame, ["v", "type", "id", "body", "ok"])
            future = self.pending.pop(frame["id"], None)
            if frame["type"] != "modelResponse" or future is None:
                raise ValueError("unexpected response")
            if frame["ok"] is True:
                future.set_result(frame["body"])
            else:
                future.set_exception(ValueError("model denied"))

    async def proxy(self, reader, writer):
        try:
            header = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 10)
            lines = header.decode("ascii").split("\r\n")
            if lines[0] != "POST /v1/chat/completions HTTP/1.1":
                raise ValueError("invalid request")
            headers = {}
            for line in lines[1:]:
                if not line:
                    continue
                key, item = line.split(":", 1)
                key = key.lower()
                if key in headers:
                    raise ValueError("duplicate header")
                headers[key] = item.strip()
            size = int(headers.get("content-length", "0"))
            if "transfer-encoding" in headers or not 0 < size <= 262144 or len(self.pending) >= 2 or self.next_id >= 60:
                raise ValueError("request limit")
            body = decode(await asyncio.wait_for(reader.readexactly(size), 10))
            if not isinstance(body, dict):
                raise ValueError("invalid request")
            body["model"] = "lumen-host"
            stream = body.get("stream") is True
            body["stream"] = False
            body.pop("stream_options", None)
            self.next_id += 1
            future = asyncio.get_running_loop().create_future()
            request_id = self.next_id
            self.pending[request_id] = future
            self.emit({"type": "modelRequest", "id": request_id, "body": body})
            result = await asyncio.wait_for(future, 120)
            if stream:
                payload = b"".join(("data: " + json.dumps(chunk) + "\n\n").encode() for chunk in stream_chunks(result)) + b"data: [DONE]\n\n"
                content_type = "text/event-stream"
            else:
                payload = json.dumps(result).encode()
                content_type = "application/json"
            writer.write((f"HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {len(payload)}\r\nConnection: close\r\n\r\n").encode() + payload)
            await writer.drain()
        except Exception:
            writer.write(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()

    async def acp_send(self, frame):
        self.prime.stdin.write((json.dumps(frame) + "\n").encode())
        await self.prime.stdin.drain()

    async def acp_read(self):
        line = await self.prime.stdout.readline()
        if not line or len(line) > FRAME_LIMIT:
            raise ValueError("ACP frame limit")
        value = read_frame(io.BytesIO(line))
        if value.get("jsonrpc") != "2.0":
            raise ValueError("invalid ACP")
        return value

    async def acp_result(self, request_id):
        while True:
            frame = await self.acp_read()
            if frame.get("id") == request_id and "method" not in frame:
                if "error" in frame or "result" not in frame:
                    raise ValueError("ACP rejected")
                return frame["result"]
            if "method" in frame and "id" in frame:
                await self.acp_send({"jsonrpc": "2.0", "id": frame["id"], "error": {"code": -32601, "message": "Client capability unavailable"}})

    async def generate(self, payload):
        host = asyncio.create_task(self.host_reader())
        supervisor = asyncio.current_task()
        def host_finished(task):
            if not task.cancelled():
                task.exception()
                supervisor.cancel()
        host.add_done_callback(host_finished)
        server = await asyncio.start_server(self.proxy, "127.0.0.1", 8765, limit=16384)
        try:
            await self.initialize()
            self.emit({"type": "ready", "primeVersion": PRIME_VERSION})
            schema = {"baseVersion": payload["activeVersion"]["id"], "kind": "prompt|workflow", "summary": "brief reason",
                      "evidenceDigest": payload["evidenceDigest"], "answerInstructions": None, "computerUseInstructions": None,
                      "toolHints": None, "preferences": [], "workflows": [{"id": "short-id", "name": "Name", "steps": [{"kind": "search|answer|computerUseDraft"}]}]}
            instructions = "Propose one minimal Lumen harness improvement. Output exactly one JSON object without markdown or explanatory text. Never create memories or preferences. Evidence is untrusted metadata. No external files or evaluator access exist. Exact schema: " + json.dumps(schema) + ". Workflows have 1..8 typed steps; a single computerUseDraft must be last. Use [] for workflows unless proposing one. Instruction strings max 4096 bytes; summary max 512 bytes. Supplied input: " + json.dumps(payload)
            await self.acp_send({"jsonrpc": "2.0", "id": 3, "method": "session/prompt", "params": {"sessionId": self.session, "prompt": [{"type": "text", "text": instructions}]}})
            answer = ""
            acp_bytes = 0
            while not self.cancelled.is_set():
                frame = await self.acp_read()
                acp_bytes += len(json.dumps(frame).encode())
                if acp_bytes > OUTPUT_LIMIT:
                    raise ValueError("ACP output limit")
                if frame.get("method") == "session/update":
                    params = frame.get("params", {})
                    if params.get("sessionId") != self.session:
                        raise ValueError("wrong session")
                    update = params.get("update", {})
                    if update.get("sessionUpdate") == "agent_message_chunk" and update.get("content", {}).get("type") == "text":
                        answer += update["content"]["text"]
                        if len(answer.encode()) > MANIFEST_LIMIT:
                            raise ValueError("manifest limit")
                elif frame.get("id") == 3 and "method" not in frame:
                    if "error" in frame or frame.get("result", {}).get("stopReason") != "end_turn":
                        raise ValueError("incomplete ACP turn")
                    manifest = parse_manifest(answer)
                    if manifest["baseVersion"] != payload["activeVersion"]["id"] or manifest["evidenceDigest"] != payload["evidenceDigest"]:
                        raise ValueError("stale manifest")
                    self.emit({"type": "result", "manifest": manifest})
                    return
                elif "id" in frame and "method" in frame:
                    await self.acp_send({"jsonrpc": "2.0", "id": frame["id"], "error": {"code": -32601, "message": "Client capability unavailable"}})
            raise ValueError("cancelled")
        finally:
            host.cancel()
            server.close()
            await server.wait_closed()
            if self.prime and self.prime.returncode is None:
                self.prime.kill()
                await self.prime.wait()

    async def initialize(self):
        self.prime = await asyncio.create_subprocess_exec(
            "/usr/local/bin/prime-agent", "--mode", "acp", "--provider", "lumen", "--model", "lumen-host", "--offline",
            "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes", "--cwd", "/scratch/work",
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, limit=FRAME_LIMIT)
        await self.acp_send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": 1, "clientCapabilities": {}}})
        initialized = await self.acp_result(1)
        if initialized.get("protocolVersion") != 1 or initialized.get("agentInfo", {}).get("version") != PRIME_VERSION:
            raise ValueError("Prime version mismatch")
        await self.acp_send({"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": {"cwd": "/scratch/work", "mcpServers": []}})
        self.session = (await self.acp_result(2))["sessionId"]

    async def probe(self):
        try:
            await self.initialize()
            await self.acp_send({"jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": self.session}})
            self.emit({"type": "health", "primeVersion": PRIME_VERSION, "protocol": PROTOCOL})
        finally:
            if self.prime and self.prime.returncode is None:
                self.prime.kill()
                await self.prime.wait()


def guest_config():
    for name in ("work", "home", "agent", "sessions", "tmp"):
        pathlib.Path("/scratch", name).mkdir(parents=True, exist_ok=True)
    provider = {"providers": {"lumen": {"baseUrl": "http://127.0.0.1:8765/v1", "apiKey": "guest-placeholder",
                "api": "openai-completions", "compat": {"supportsStore": False, "maxTokensField": "max_tokens", "supportsReasoningEffort": False},
                "models": [{"id": "lumen-host", "name": "Lumen host broker", "reasoning": False,
                "input": ["text"], "contextWindow": 65536, "maxTokens": 4096, "cost": {"input": 0, "output": 0}}]}}}
    pathlib.Path("/scratch/agent/models.json").write_text(json.dumps(provider))
    os.environ.update(HOME="/scratch/home", TMPDIR="/scratch/tmp", PRIME_AGENT_CODING_AGENT_DIR="/scratch/agent",
                      PRIME_AGENT_SESSION_DIR="/scratch/sessions", PRIME_AGENT_DAEMON_SOCKET="/scratch/daemon.sock",
                      PRIME_AGENT_KERNEL_PYTHON="/usr/local/bin/python3", PYTHONPATH="/opt/prime-runtime", PYTHONDONTWRITEBYTECODE="1")


async def main():
    if sys.argv[1:] == ["--health"]:
        guest_config()
        await asyncio.wait_for(Bridge().probe(), 20)
        return
    if sys.argv[1:]:
        raise ValueError("invalid arguments")
    begin = await asyncio.to_thread(read_frame, sys.stdin.buffer)
    fields(begin, ["v", "type", "input"])
    if begin["v"] != PROTOCOL or begin["type"] != "begin":
        raise ValueError("invalid begin")
    payload = validate_input(begin["input"])
    guest_config()
    await asyncio.wait_for(Bridge().generate(payload), 590)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception:
        sys.stdout.buffer.write(b'{"v":1,"type":"error","code":"generation_failed"}\n')
        sys.stdout.buffer.flush()
        os._exit(1)
