"""Test-only ACP peer. Never copied into the Docker build context."""
import json
import sys
import urllib.request


def send(frame):
    print(json.dumps(dict(jsonrpc="2.0", **frame)), flush=True)


for line in sys.stdin:
    request = json.loads(line)
    method = request.get("method")
    if method == "initialize":
        assert request["params"]["protocolVersion"] == 1
        send({"id": request["id"], "result": {"protocolVersion": 1, "agentInfo": {"version": "wrong" if "--bad-version" in sys.argv else "0.9.8"}}})
    elif method == "session/new":
        assert request["params"] == {"cwd": "/scratch/work", "mcpServers": []}
        send({"id": request["id"], "result": {"sessionId": "fixture-session"}})
    elif method == "session/prompt":
        assert request["params"]["sessionId"] == "fixture-session"
        if "--cancel" in sys.argv:
            continue
        body = {"model": "lumen-host", "stream": True, "stream_options": {"include_usage": True},
                "max_tokens": 4096, "messages": [{"role": "user", "content": request["params"]["prompt"][0]["text"]}]}
        port = next(arg.split("=", 1)[1] for arg in sys.argv if arg.startswith("--port="))
        http = urllib.request.Request(f"http://127.0.0.1:{port}/v1/chat/completions", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
        text = ""
        with urllib.request.urlopen(http, timeout=10) as response:
            for event in response.read().decode().split("\n\n"):
                if event.startswith("data: ") and event != "data: [DONE]":
                    payload = json.loads(event[6:])
                    for choice in payload["choices"]:
                        text += choice["delta"].get("content") or ""
        send({"method": "session/update", "params": {"sessionId": "fixture-session", "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}}}})
        send({"id": request["id"], "result": {"stopReason": "end_turn"}})
    elif method == "session/cancel":
        assert request["params"]["sessionId"] == "fixture-session"
        if "--cancel" in sys.argv:
            send({"id": 3, "result": {"stopReason": "cancelled"}})
