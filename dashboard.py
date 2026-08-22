import json
import queue
import threading
import time
import logging
from flask import Flask, render_template, Response, request, jsonify, send_from_directory
from pathlib import Path

# Disable Flask startup logs
log = logging.getLogger('werkzeug')
log.setLevel(logging.ERROR)

event_queue = queue.Queue()

# Decision bridge: request_decision() blocks the assess thread until the
# browser POSTs an answer to /api/decision. Only one decision is ever
# pending at a time, matching the terminal's own one-question-at-a-time
# input() flow it stands in for.
_pending_decision = None
_decision_answer = None
_decision_lock = threading.Lock()

# Setup paths relative to this file
BASE_DIR = Path(__file__).resolve().parent
ANIMATED_ASSETS_DIR = BASE_DIR.parent / "animated_assets"
RAW_ASSETS_DIR = BASE_DIR / "assets"
LAVA_TILES_DIR = BASE_DIR.parent / "32x32 Lava Tiles"
DRAGON_ANIM_DIR = BASE_DIR / "Dragon - Fully Animated"
TEMPLATE_DIR = BASE_DIR / "templates"

app = Flask(__name__, 
            static_folder=str(ANIMATED_ASSETS_DIR), 
            static_url_path='/assets',
            template_folder=str(TEMPLATE_DIR))

@app.route('/')
def index():
    return render_template('live.html')

@app.route('/raw_assets/<path:filename>')
def serve_raw_assets(filename):
    return send_from_directory(RAW_ASSETS_DIR, filename)

@app.route('/lava_tiles/<path:filename>')
def serve_lava_tiles(filename):
    return send_from_directory(LAVA_TILES_DIR, filename)


@app.route('/dragon_anim/<anim_type>/<path:filename>')
def serve_dragon_anim(anim_type, filename):
    import os
    from flask import send_from_directory
    anim_dir = DRAGON_ANIM_DIR / anim_type
    if not anim_dir.exists():
        for d in DRAGON_ANIM_DIR.iterdir():
            if d.name.lower() == anim_type.lower():
                anim_dir = d
                break
    return send_from_directory(anim_dir, filename)

LAST_REPO_MAP = []
@app.route('/api/repo_map')
def api_repo_map():
    return jsonify(LAST_REPO_MAP)

@app.route('/api/decision', methods=['POST'])
def api_decision():
    global _decision_answer
    payload = request.get_json(silent=True) or {}
    choice = payload.get('choice')
    with _decision_lock:
        if _pending_decision is None or not choice:
            return jsonify({"ok": False, "error": "no pending decision"}), 409
        _decision_answer = choice
    return jsonify({"ok": True})

def request_decision(message, timeout=600):
    """Emit a decision prompt to the browser and block until it answers.

    Mirrors the terminal's own input() prompt: one question, blocking,
    answered once. Returns the raw choice string ('yes'/'no'), or None if
    it timed out (treated as a safe "no").
    """
    global _pending_decision, _decision_answer
    with _decision_lock:
        _pending_decision = {"message": message}
        _decision_answer = None
    emit("decision_required", {"message": message})
    start = time.time()
    while _decision_answer is None:
        if time.time() - start > timeout:
            with _decision_lock:
                _pending_decision = None
            return None
        time.sleep(0.15)
    with _decision_lock:
        answer = _decision_answer
        _pending_decision = None
    return answer

@app.route('/stream')
def stream():
    def event_stream():
        # Send an initial connection event
        yield f"data: {json.dumps({'type': 'connected'})}\n\n"
        while True:
            event = event_queue.get()
            yield f"data: {json.dumps(event)}\n\n"
    return Response(event_stream(), mimetype="text/event-stream")

def emit(event_type, data=None):
    if data is None:
        data = {}
    if event_type == 'repo_map':
        global LAST_REPO_MAP
        LAST_REPO_MAP = data
    event_queue.put({"type": event_type, "data": data})

def _run_server():
    app.run(host='127.0.0.1', port=5050, use_reloader=False, debug=False)

_server_thread = None

def start_dashboard():
    """Starts the Flask server in a background daemon thread"""
    global _server_thread
    if _server_thread is not None:
        return _server_thread
    _server_thread = threading.Thread(target=_run_server, daemon=True)
    _server_thread.start()
    return _server_thread
