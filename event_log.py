from __future__ import annotations

import json
import time
from pathlib import Path


class EventLog:
    """Single shared JSON-lines event log.

    One state machine (see interactive_flow.py) writes every step transition
    and human choice here as it happens. Any renderer -- the terminal today,
    the game view later -- only ever reads this file, it never writes
    decisions into it. Keeping the write path singular is what lets the
    terminal and game renderers agree on identical real state.
    """

    def __init__(self, log_path: Path) -> None:
        self.log_path = log_path
        self.log_path.parent.mkdir(parents=True, exist_ok=True)

    def reset(self) -> None:
        self.log_path.write_text("", encoding="utf-8")

    def write(self, event_type: str, **fields: object) -> dict:
        event = {"timestamp": time.time(), "event_type": event_type, **fields}
        with self.log_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, default=str) + "\n")
        return event

    def read_all(self) -> list[dict]:
        if not self.log_path.exists():
            return []
        events = []
        for line in self.log_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            events.append(json.loads(line))
        return events
