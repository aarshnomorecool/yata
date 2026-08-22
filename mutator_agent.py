from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from red_agent import VulnerabilityFinding
from verifier import Referee, VerificationResult


@dataclass(slots=True)
class MutationResult:
    payload: str
    blocked: bool
    verification: VerificationResult


@dataclass(slots=True)
class MutationBattery:
    vulnerability_type: str
    results: list[MutationResult] = field(default_factory=list)

    @property
    def total(self) -> int:
        return len(self.results)

    @property
    def blocked_count(self) -> int:
        return sum(1 for result in self.results if result.blocked)

    @property
    def all_blocked(self) -> bool:
        return self.blocked_count == self.total

    @property
    def bypasses(self) -> list[MutationResult]:
        return [result for result in self.results if not result.blocked]


class MutatorAgent:
    """MUTATOR: deterministic known-bypass battery.

    Not an LLM improvising payloads. A fixed, curated list of known bypass
    techniques per vulnerability class, identical every run, reproducible.
    Runs after VALIDATOR's first pass already blocked the original winning
    payload, re-using Referee.verify_exploit (the same live
    _verify_<type> dispatch VALIDATOR uses) once per payload in the battery.
    """

    PAYLOADS: dict[str, list[str]] = {
        "SQL Injection": [
            "' OR '1'='1' -- ",
            "' OR 1=1#",
            "'/**/OR/**/1=1-- ",
        ],
        "Command Injection": [
            "; whoami",
            "$(whoami)",
            "`whoami`",
        ],
        "Path Traversal": [
            "../../etc/passwd",
            "../../../../etc/passwd",
            "..\\..\\windows\\system32\\drivers\\etc\\hosts",
            "%2e%2e%2fetc%2fpasswd",
            "....//....//etc/passwd",
            "/etc/passwd",
            "../../etc/passwd%00.png",
        ],
        # Hardcoded Secret: no payload shape exists for this class, it is a
        # presence check, not an exploit. Deliberately absent -- skip
        # entirely rather than wasting a verify_exploit call.
    }

    def __init__(self, referee: Referee | None = None) -> None:
        self.referee = referee or Referee()

    def get_battery(self, vulnerability_type: str) -> list[str]:
        return list(self.PAYLOADS.get(vulnerability_type, []))

    def run_battery(self, patched_root: Path, finding: VulnerabilityFinding) -> MutationBattery:
        payloads = self.get_battery(finding.vulnerability_type)
        results: list[MutationResult] = []
        for payload in payloads:
            verification = self.referee.verify_exploit(patched_root, finding, payload)
            results.append(
                MutationResult(
                    payload=payload,
                    blocked=not verification.attack_succeeded,
                    verification=verification,
                )
            )
        return MutationBattery(vulnerability_type=finding.vulnerability_type, results=results)
