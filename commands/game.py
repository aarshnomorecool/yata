from __future__ import annotations

import threading
import webbrowser
from pathlib import Path

from rich.console import Console

console = Console()


def run(args) -> int:
    from game.server import create_game_app

    project_root = Path(__file__).resolve().parent.parent
    repo_name = args.target
    url = f"http://127.0.0.1:{args.port}"
    if getattr(args, "replay", False):
        url += f"/?replay=1&speed={args.speed}"

    console.print(f"[bold cyan][YATA][/bold cyan] Game view (read-only mirror) for [bold]{repo_name}[/bold]")
    console.print(f"[bold cyan][YATA][/bold cyan] {url}")
    if getattr(args, "replay", False):
        console.print("[dim]Replay mode: re-runs this repository's last recorded event log from the start, "
                      "paced so each beat is visible. Nothing is re-assessed.[/dim]")
    console.print("[dim]This view never decides anything. If an `assess --interactive` run is happening "
                  "elsewhere, the terminal there owns every decision unless it was started with --ui game.[/dim]")

    app = create_game_app(project_root=project_root, repo_name=repo_name, bridge=None)

    if not args.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()

    app.run(host="127.0.0.1", port=args.port, debug=False, use_reloader=False)
    return 0
