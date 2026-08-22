from __future__ import annotations

import queue
import threading


class GameBridge:
    """Connects the game view to the ONE decision state machine.

    When gamer mode owns input, interactive_flow.run_four_step_decision
    calls request_choice() instead of prompting the terminal. That call
    blocks until the browser POSTs a choice to /api/decision, which lands
    here via submit_choice(). No decision logic lives in this class --
    it only relays a human choice from the browser to the waiting caller.
    """

    def __init__(self) -> None:
        self._choice_queue: "queue.Queue[str]" = queue.Queue()
        self._pending: dict | None = None
        self._generation = 0
        self._lock = threading.Lock()

    def request_choice(self, message: str, choices: list[dict]) -> str:
        with self._lock:
            self._generation += 1
            self._pending = {"message": message, "choices": choices, "generation": self._generation}
        choice = self._choice_queue.get()
        with self._lock:
            self._pending = None
        return choice

    def submit_choice(self, value: str) -> bool:
        with self._lock:
            if self._pending is None:
                return False
            valid_values = {choice["value"] for choice in self._pending["choices"]}
            if value not in valid_values:
                return False
        self._choice_queue.put(value)
        return True

    def get_pending(self) -> dict | None:
        with self._lock:
            return dict(self._pending) if self._pending is not None else None
