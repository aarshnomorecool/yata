from __future__ import annotations

import json
from pathlib import Path

from flask import Flask, jsonify, render_template, request, send_from_directory

from game.bridge import GameBridge
from game.layout import build_import_edges, build_village_layout

TIER_MAP = {
    "SQL Injection": "demon",
    "Command Injection": "hobgoblin",
    "Hardcoded Secret": "imp",
    "Path Traversal": "imp",
}


def create_game_app(*, project_root: Path, repo_name: str, bridge: GameBridge | None = None) -> Flask:
    """ONE state machine, TWO renderers: this Flask app is a renderer only.

    It never decides anything -- it reads the shared event log and repo-map
    JSON that yata.py / interactive_flow.py already write, and (only when a
    GameBridge is supplied, meaning this run picked gamer/--ui game mode)
    relays a human's clicked choice back to the waiting decision flow via
    GameBridge.submit_choice. Without a bridge this is a pure read-only
    mirror -- clicking in it does nothing, matching developer mode's rule
    that the game view never owns input unless gamer mode says so.
    """
    game_dir = Path(__file__).resolve().parent
    app = Flask(
        __name__,
        template_folder=str(game_dir / "templates"),
        static_folder=str(game_dir / "static"),
        static_url_path="/static",
    )

    assets_dir = project_root / "assets"
    events_path = project_root / ".yata" / "events" / repo_name / "events.jsonl"
    repo_map_path = project_root / ".yata" / "repo_map" / repo_name / "repo_map.json"

    @app.get("/")
    def index():
        return render_template("index.html", repo_name=repo_name, owner=bridge is not None)

    @app.get("/assets/<path:filename>")
    def serve_asset(filename: str):
        return send_from_directory(assets_dir, filename)

    @app.get("/api/state")
    def state():
        since = request.args.get("since", default=0, type=int)
        events: list[dict] = []
        if events_path.exists():
            lines = events_path.read_text(encoding="utf-8").splitlines()
            new_lines = lines[since:] if since <= len(lines) else []
            events = [json.loads(line) for line in new_lines if line.strip()]
            cursor = since + len(new_lines) if since <= len(lines) else len(lines)
        else:
            cursor = 0

        repo_map: list[dict] = []
        if repo_map_path.exists():
            try:
                repo_map = json.loads(repo_map_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                repo_map = []

        village = build_village_layout(repo_map)
        edges = build_import_edges(repo_map)
        pending = bridge.get_pending() if bridge is not None else None

        return jsonify(
            {
                "repo_name": repo_name,
                "owner": bridge is not None,
                "cursor": cursor,
                "events": events,
                "village": village,
                "edges": edges,
                "pending": pending,
                "tier_map": TIER_MAP,
            }
        )

    @app.post("/api/decision")
    def decision():
        if bridge is None:
            return jsonify({"ok": False, "error": "read-only viewer, not the input owner"}), 403
        payload = request.get_json(silent=True) or {}
        value = payload.get("choice")
        if not value or not bridge.submit_choice(str(value)):
            return jsonify({"ok": False, "error": "no matching pending choice"}), 409
        return jsonify({"ok": True})

    return app
