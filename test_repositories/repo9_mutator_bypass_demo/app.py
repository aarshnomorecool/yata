from __future__ import annotations

import re
import sqlite3
from pathlib import Path

from flask import Flask, request

# A common real-world anti-pattern: block the "obvious" injection shape
# instead of parameterizing. Catches the literal `' OR '1'='1'` pattern but
# not a comment-obfuscated equivalent like `'/**/OR/**/1=1-- `.
_OBVIOUS_INJECTION = re.compile(r"'\s*OR\s*'1'\s*=\s*'1'", re.IGNORECASE)


def _bootstrap(database_file: Path) -> None:
    database_file.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(database_file) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS crew_accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                display_name TEXT NOT NULL,
                phrase TEXT NOT NULL
            )
            """
        )
        total = conn.execute("SELECT COUNT(*) FROM crew_accounts").fetchone()[0]
        if total == 0:
            conn.execute(
                "INSERT INTO crew_accounts (display_name, phrase) VALUES (?, ?)",
                ("captain", "mirror123"),
            )
            conn.commit()


def create_app(db_path: str | None = None) -> Flask:
    app = Flask(__name__)
    database_file = Path(db_path) if db_path else Path(__file__).with_name("database.db")
    _bootstrap(database_file)

    @app.post("/session/start")
    def start_session() -> tuple[str, int]:
        handle = request.form.get("handle", "")
        passcode = request.form.get("passcode", "")

        with sqlite3.connect(database_file) as cabin:
            lookup = cabin.cursor()
            # Primary login check -- a plain cursor.execute() f-string query.
            # This is the sink HUNTER's SQLInjectionDetector finds and the
            # one HEALER's SQLInjectionPatchStrategy parameterizes.
            lookup_sql = f"SELECT id, display_name FROM crew_accounts WHERE display_name = '{handle}' AND phrase = '{passcode}'"
            lookup.execute(lookup_sql)
            match = lookup.fetchone()

            # Legacy audit fallback, kept for an old admin console that logs
            # every attempt via executescript() instead of execute(). The
            # shipped SQLInjectionDetector only pattern-matches calls named
            # exactly "execute" (red_agent.py, SQLInjectionDetector.scan),
            # so this second sink -- reachable with the same tainted
            # `handle` -- is never found, and therefore never patched. This
            # is a real, unmodified detector limitation, not a fabricated
            # weakness.
            legacy_match = False
            if match is None and not _OBVIOUS_INJECTION.search(handle):
                try:
                    cabin.executescript(
                        "CREATE TEMP TABLE IF NOT EXISTS _legacy_audit(hits INTEGER);"
                        "INSERT INTO _legacy_audit SELECT COUNT(*) FROM crew_accounts "
                        f"WHERE display_name = '{handle}';"
                    )
                    hits = cabin.execute("SELECT hits FROM _legacy_audit").fetchone()
                    legacy_match = bool(hits and hits[0] > 0)
                except sqlite3.Error:
                    legacy_match = False

        if match:
            return f"Access granted to {match[1]}", 200
        if legacy_match:
            return "Access granted via legacy audit fallback", 200
        return "Denied", 401

    return app
