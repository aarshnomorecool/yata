from __future__ import annotations

import difflib
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from rich.console import Console
from rich.panel import Panel
from rich.syntax import Syntax

from blue_agent import BlueAgent, PatchResult
from event_log import EventLog
from mutator_agent import MutationBattery, MutatorAgent
from red_agent import AttackPlan, VulnerabilityFinding
from verifier import Referee, VerificationResult

MAX_RETRIES = 3

GetChoice = Callable[[str, list[dict]], str]


def _terminal_choice(message: str, choices: list[dict]) -> str:
    from InquirerPy import inquirer

    return inquirer.select(message=message, choices=choices).execute()


@dataclass(slots=True)
class DecisionOutcome:
    decision: str  # "apply" | "reject" | "skip" | "abort"
    patch_result: PatchResult | None
    patched_check: VerificationResult | None
    battery: MutationBattery | None
    retries_used: int


def run_four_step_decision(
    *,
    console: Console,
    event_log: EventLog,
    blue_agent: BlueAgent,
    referee: Referee,
    mutator: MutatorAgent,
    finding: VulnerabilityFinding,
    attack_plan: AttackPlan,
    vulnerable_check: VerificationResult,
    current_root: Path,
    round_number: int,
    get_choice: GetChoice | None = None,
) -> DecisionOutcome:
    """ONE state machine for the four-step patch decision.

    get_choice(message, choices) -> value is the only seam between this
    decision logic and whichever surface owns input. Terminal mode (the
    default) blocks on an InquirerPy prompt; gamer mode passes
    GameBridge.request_choice, which blocks until the browser POSTs a
    choice. Either way every step transition and human choice is written
    to event_log first, so both renderers -- and a renderer that isn't the
    input owner -- can mirror this exact state without a second copy of
    this decision logic.
    """
    get_choice = get_choice or _terminal_choice

    relative_file = str(finding.metadata.get("relative_file", finding.affected_file))

    # STEP 1 / 4 -- Finding Confirmed
    event_log.write(
        "step_shown", step=1, name="finding_confirmed", round=round_number,
        vulnerability_type=finding.vulnerability_type, file=relative_file,
        line_number=finding.line_number, payload=attack_plan.payload,
        evidence=vulnerable_check.evidence,
    )
    console.print(Panel(
        f"[bold white]STEP 1 / 4 -- Finding Confirmed[/bold white]\n\n"
        f"[bold]Vulnerability:[/bold] {finding.vulnerability_type}\n"
        f"[bold]File:[/bold] {relative_file}:{finding.line_number}\n"
        f"[bold]Payload:[/bold] {attack_plan.payload}\n"
        f"[bold]Exploit returned:[/bold] {vulnerable_check.evidence}",
        border_style="red", expand=True,
    ))
    step1_choice = get_choice(
        "Finding confirmed:",
        [
            {"name": "[C]ontinue", "value": "continue"},
            {"name": "[A]bort assessment", "value": "abort"},
        ],
    )
    event_log.write("human_choice", step=1, round=round_number, choice=step1_choice)
    if step1_choice == "abort":
        return DecisionOutcome("abort", None, None, None, 0)

    retries_used = 0
    while True:
        # STEP 2 / 4 -- Patch Generated
        patch_result = blue_agent.generate_patch(current_root, finding)
        strategy_label = "Pattern-based (LLM)" if patch_result.used_llm else "Structural"
        diff_text = _build_diff(current_root, patch_result, relative_file)

        event_log.write(
            "step_shown", step=2, name="patch_generated", round=round_number,
            file=relative_file, vulnerability_type=finding.vulnerability_type,
            strategy=strategy_label, defense_strategy=patch_result.defense_strategy,
            summary=patch_result.patch_text, diff=diff_text,
        )
        console.print(Panel(
            f"[bold white]STEP 2 / 4 -- Patch Generated[/bold white]\n\n"
            f"[bold]Strategy:[/bold] {strategy_label}\n"
            f"[bold]Summary:[/bold] {patch_result.patch_text}\n"
            f"[bold]Defense:[/bold] {patch_result.defense_strategy}",
            border_style="blue", expand=True,
        ))

        while True:
            step2_choice = get_choice(
                "Patch generated:",
                [
                    {"name": "[A]pply this patch", "value": "apply"},
                    {"name": "[R]eject and skip", "value": "reject"},
                    {"name": "[V]iew full diff", "value": "view"},
                ],
            )
            if step2_choice == "view":
                console.print(Syntax(diff_text or "(no textual diff; patched file is byte-identical to the original)", "diff", theme="ansi_dark", word_wrap=True))
                continue
            break

        event_log.write("human_choice", step=2, round=round_number, choice=step2_choice)
        if step2_choice == "reject":
            return DecisionOutcome("reject", patch_result, None, None, retries_used)

        # STEP 3 / 4 -- Validating Patch
        patched_check = referee.verify_exploit(patch_result.patched_root, finding, attack_plan.payload)
        original_blocked = not patched_check.attack_succeeded

        battery: MutationBattery | None = None
        battery_payloads = mutator.get_battery(finding.vulnerability_type)
        if original_blocked and battery_payloads:
            battery = mutator.run_battery(patch_result.patched_root, finding)

        event_log.write(
            "step_shown", step=3, name="validating_patch", round=round_number,
            file=relative_file, vulnerability_type=finding.vulnerability_type,
            original_blocked=original_blocked,
            battery_total=battery.total if battery else 0,
            battery_blocked=battery.blocked_count if battery else 0,
            # Per-payload results, so a renderer can show one real MUTATOR
            # re-attack per payload instead of a single aggregated number.
            battery_results=[
                {"payload": r.payload, "blocked": r.blocked} for r in battery.results
            ] if battery else [],
        )
        battery_line = (
            f"[bold]MUTATOR battery:[/bold] {battery.blocked_count}/{battery.total} known bypass techniques blocked\n"
            if battery is not None
            else "[dim]MUTATOR battery: skipped (no payload shape for this vulnerability class)[/dim]\n"
        )
        all_clear = original_blocked and (battery is None or battery.all_blocked)
        console.print(Panel(
            f"[bold white]STEP 3 / 4 -- Validating Patch[/bold white]\n\n"
            f"[bold]Original exploit re-attempt:[/bold] {'BLOCKED' if original_blocked else 'FAILED'}\n"
            f"{battery_line}",
            border_style=("green" if all_clear else "red"), expand=True,
        ))

        if all_clear:
            break  # -> Step 4

        blocked = battery.blocked_count if battery else 0
        total = battery.total if battery else 1
        exception_choice = _prompt_exception(console, event_log, round_number, blocked, total, get_choice)
        if exception_choice == "retry":
            retries_used += 1
            if retries_used >= MAX_RETRIES:
                console.print(f"[yellow]MUTATOR retry cap reached ({MAX_RETRIES}). Flagging for manual review instead.[/yellow]")
                return DecisionOutcome("skip", patch_result, patched_check, battery, retries_used)
            continue  # loop back to HEALER for a second patch attempt
        if exception_choice == "skip":
            return DecisionOutcome("skip", patch_result, patched_check, battery, retries_used)
        return DecisionOutcome("abort", patch_result, patched_check, battery, retries_used)

    # STEP 4 / 4 -- Applied (caller performs the actual file copy + shows backup/score)
    return DecisionOutcome("apply", patch_result, patched_check, battery, retries_used)


def _prompt_exception(
    console: Console, event_log: EventLog, round_number: int, blocked: int, total: int, get_choice: GetChoice
) -> str:
    bypasses = total - blocked
    event_log.write("step_shown", step="3-exception", round=round_number, blocked=blocked, total=total, bypasses=bypasses)
    console.print(Panel(
        f"[bold red]{bypasses}/{total} bypasses succeeded, patch does NOT survive re-attack[/bold red]",
        border_style="red", expand=True,
    ))
    choice = get_choice(
        "Patch failed re-attack:",
        [
            {"name": "[R]etry with alternate patch strategy", "value": "retry"},
            {"name": "[S]kip and flag for manual review", "value": "skip"},
            {"name": "[A]bort assessment", "value": "abort"},
        ],
    )
    event_log.write("human_choice", step="3-exception", round=round_number, choice=choice)
    return choice


def _build_diff(current_root: Path, patch_result: PatchResult, relative_file: str) -> str:
    original_path = current_root / relative_file
    patched_path = patch_result.patched_file
    try:
        original_lines = original_path.read_text(encoding="utf-8").splitlines(keepends=True)
    except OSError:
        original_lines = []
    try:
        patched_lines = Path(patched_path).read_text(encoding="utf-8").splitlines(keepends=True)
    except OSError:
        patched_lines = []
    diff = difflib.unified_diff(
        original_lines, patched_lines,
        fromfile=f"a/{relative_file}", tofile=f"b/{relative_file}",
    )
    return "".join(diff)
