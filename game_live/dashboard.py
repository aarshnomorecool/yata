"""Live dashboard, taken from the shared bhenga-main variant.

templates/live.html is byte-identical to theirs. This module is their
dashboard.py with only the asset directories repointed: their original
expected `animated_assets/`, `32x32 Lava Tiles/` and `Dragon - Fully
Animated/` as siblings of the module, none of which shipped. Everything the
page requests now resolves inside this repository's assets/ tree:

    /raw_assets/<path>          -> assets/<path>
    /lava_tiles/100NN.png       -> assets/lava_tiles/100NN.png
    /dragon_anim/<Anim>/NNN.png -> assets/dragon_anim/<Anim>/NNN.png

The event contract is theirs too: emit() pushes {type, data} onto a queue
that /stream serves as SSE, and live.html drives itself off those messages.
"""
from __future__ import annotations

import json
import logging
import queue
import threading
from pathlib import Path

from flask import Flask, Response, jsonify, render_template, send_from_directory

# Keep werkzeug quiet so it does not fight the Rich terminal output.
logging.getLogger("werkzeug").setLevel(logging.ERROR)

event_queue: "queue.Queue[dict]" = queue.Queue()

BASE_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BASE_DIR.parent
ASSETS_DIR = PROJECT_ROOT / "assets"
LAVA_TILES_DIR = ASSETS_DIR / "lava_tiles"
DRAGON_ANIM_DIR = ASSETS_DIR / "dragon_anim"
TEMPLATE_DIR = BASE_DIR / "templates"

app = Flask(__name__, template_folder=str(TEMPLATE_DIR))

LAST_REPO_MAP: list = []


@app.route("/")
def index():
    return render_template("live.html")


@app.route("/raw_assets/<path:filename>")
def serve_raw_assets(filename: str):
    return send_from_directory(ASSETS_DIR, filename)


@app.route("/lava_tiles/<path:filename>")
def serve_lava_tiles(filename: str):
    return send_from_directory(LAVA_TILES_DIR, filename)


@app.route("/dragon_anim/<anim_type>/<path:filename>")
def serve_dragon_anim(anim_type: str, filename: str):
    anim_dir = DRAGON_ANIM_DIR / anim_type
    if not anim_dir.exists():
        for child in DRAGON_ANIM_DIR.iterdir():
            if child.name.lower() == anim_type.lower():
                anim_dir = child
                break
    return send_from_directory(anim_dir, filename)


@app.route("/api/repo_map")
def api_repo_map():
    return jsonify(LAST_REPO_MAP)


@app.route("/stream")
def stream():
    def event_stream():
        yield f"data: {json.dumps({'type': 'connected'})}\n\n"
        while True:
            event = event_queue.get()
            yield f"data: {json.dumps(event)}\n\n"

    return Response(event_stream(), mimetype="text/event-stream")


def emit(event_type: str, data: dict | list | None = None) -> None:
    if data is None:
        data = {}
    if event_type == "repo_map":
        global LAST_REPO_MAP
        LAST_REPO_MAP = data
    event_queue.put({"type": event_type, "data": data})


def start_dashboard(port: int = 5050) -> str:
    """Serve the dashboard on a background daemon thread; return its URL."""
    thread = threading.Thread(
        target=lambda: app.run(host="127.0.0.1", port=port, use_reloader=False, debug=False, threaded=True),
        daemon=True,
    )
    thread.start()
    return f"http://127.0.0.1:{port}"
