"""Agent Office adapter for Hermes gateway hooks.

Posts what the agent is doing to the office's /api/observe endpoint, so it
shows up as a contractor walking between the library, the server room and
the research window. Installed by `node scripts/install-adapters.mjs hermes`,
which writes office.json (url and observe key) next to this file.

Never blocks the agent: each post runs on its own thread with a short timeout,
and any failure is dropped.
"""

import json
import threading
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
NAME = "Hermes"

# Hermes tool names to the office's stations.
STATIONS = {
    "read_file": "library", "search_files": "library", "memory": "library", "session_search": "library",
    "terminal": "servers", "execute_code": "servers", "process": "servers",
    "web_search": "window", "web_extract": "window", "vision_analyze": "window",
    "delegate_task": "whiteboard", "todo": "whiteboard",
}


def _config():
    try:
        return json.loads((HERE / "office.json").read_text())
    except Exception:
        return None


def _station(tool):
    if not tool:
        return "desk"
    if tool.startswith("browser"):
        return "window"
    return STATIONS.get(tool, "desk")


def _post(body):
    cfg = _config()
    if not cfg:
        return
    try:
        req = urllib.request.Request(
            cfg["url"].rstrip("/") + "/api/observe",
            data=json.dumps(body).encode(),
            headers={"content-type": "application/json", "x-observe-key": cfg["key"]},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=1.5).read()
    except Exception:
        pass


def handle(event_type: str, context: dict):
    ctx = context or {}
    sid = str(ctx.get("session_key") or ctx.get("session_id") or f"{ctx.get('platform', 'hermes')}:{ctx.get('user_id', '')}")
    cfg = _config() or {}
    body = {"source": "hermes", "id": sid[:80], "name": cfg.get("name") or NAME, "project": str(ctx.get("platform") or "")[:60]}

    if event_type == "agent:start":
        body.update(state="working", station="desk", activity="Got a message")
    elif event_type == "agent:step":
        tools = ctx.get("tool_names") or []
        tool = str(tools[-1]) if tools else ""
        body.update(
            state="working",
            station=_station(tool),
            activity=f"Using {tool.replace('_', ' ')}" if tool else f"Thinking (step {ctx.get('iteration', '?')})",
        )
    elif event_type == "agent:end":
        reply = str(ctx.get("response") or "").strip().replace("\n", " ")
        body.update(state="idle", station="lounge", activity=reply[:120] or "Replied")
    elif event_type in ("session:end", "session:reset"):
        body.update(state="idle", station="lounge", activity="Session closed")
    else:
        return

    threading.Thread(target=_post, args=(body,), daemon=True).start()
