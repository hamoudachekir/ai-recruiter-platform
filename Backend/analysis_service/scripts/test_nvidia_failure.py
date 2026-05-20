"""Task 6 — Invalid NVIDIA API key failure test.

Verifies that the report graph:
  - completes without crashing even when the NVIDIA API rejects the key
  - returns the deterministic report unchanged
  - sets polishStatus to "failed" or "timeout" (never "completed")
  - sets llmUsed to False
  - adds no forbidden-field mutations

Usage (PowerShell):
    $env:PYTHONPATH       = "Backend\\analysis_service"
    $env:REPORT_POLISH_ENABLED = "true"
    $env:LLM_PROVIDER     = "nvidia"
    $env:NVIDIA_API_KEY   = "invalid_key_for_test"
    python Backend\\analysis_service\\scripts\\test_nvidia_failure.py <interviewId>

You can also pass a custom bad key as the second CLI argument:
    python ...\\test_nvidia_failure.py <interviewId> [bad_api_key]

Expected:
    PASS failure handling test
"""
from __future__ import annotations

import copy
import json
import os
import sys
from pathlib import Path

# ── Bootstrap ──────────────────────────────────────────────────────────────────
def _load_env() -> None:
    try:
        from dotenv import load_dotenv
        repo_root = Path(__file__).resolve().parents[4]
        for candidate in [repo_root / ".env", repo_root / "Backend" / ".env"]:
            if candidate.exists():
                load_dotenv(candidate)
                return
    except ImportError:
        pass

_load_env()

SEPARATOR = "─" * 60

# Forbidden paths — identical list to test_nvidia_polish_live.py
_FORBIDDEN_PATHS: list[tuple[str, ...]] = [
    ("humanReviewRequired",),
    ("ethicsNote",),
    ("recruiterDecision",),
    ("identity",),
    ("integrityAlerts",),
    ("audioAnalysis",),
    ("visionMonitoring",),
    ("technicalEvaluation", "score"),
    ("scoreBreakdown",),
    ("finalRecommendation", "status"),
    ("finalRecommendation", "overallScore"),
    ("visionIntegrityReport", "riskLevel"),
]


def _get_nested(doc: dict, path: tuple[str, ...]):
    cur = doc
    for key in path:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(key)
    return cur


def _normalise(value) -> str:
    try:
        return json.dumps(value, sort_keys=True, default=str)
    except Exception:
        return str(value)


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: python test_nvidia_failure.py <interviewId> [bad_api_key]")
        sys.exit(2)

    interview_id = sys.argv[1].strip()

    # Determine the bad key to inject
    if len(sys.argv) >= 3:
        bad_key = sys.argv[2].strip()
    else:
        bad_key = os.getenv("NVIDIA_API_KEY", "").strip() or "invalid_key_for_test"

    print(f"\n{SEPARATOR}")
    print(f"  NVIDIA FAILURE HANDLING TEST  —  interviewId: {interview_id}")
    print(SEPARATOR)
    print(f"  REPORT_POLISH_ENABLED : true  (forced)")
    print(f"  LLM_PROVIDER          : nvidia  (forced)")
    print(f"  NVIDIA_API_KEY        : {'*' * min(len(bad_key), 8)}... (injected bad key)")
    print()

    # Force the environment for this run
    os.environ["REPORT_POLISH_ENABLED"] = "true"
    os.environ["LLM_PROVIDER"] = "nvidia"
    os.environ["NVIDIA_API_KEY"] = bad_key

    # ── Run a deterministic baseline first (no LLM) ───────────────────────────
    os.environ["REPORT_POLISH_ENABLED"] = "false"
    import app.services.report_graph as rg
    rg._compiled_graph = None

    print("[1] Running deterministic baseline (polish disabled)…")
    try:
        baseline_state = rg.run_report_graph(interview_id)
    except Exception as exc:
        print(f"  ✗  Baseline graph crashed: {exc}")
        print("     Cannot continue — fix the graph first before testing failure handling.")
        sys.exit(1)

    if baseline_state.get("error"):
        print(f"  ✗  Baseline graph failed: {baseline_state['error']}")
        sys.exit(1)

    baseline = copy.deepcopy(
        baseline_state.get("final_report") or baseline_state.get("deterministic_report") or {}
    )
    base_score = _get_nested(baseline, ("technicalEvaluation", "score"))
    print(f"  ✓  Baseline complete. technicalEvaluation.score = {base_score}")

    # ── Now run with bad API key ───────────────────────────────────────────────
    os.environ["REPORT_POLISH_ENABLED"] = "true"
    rg._compiled_graph = None  # re-read env

    print(f"\n[2] Running graph with INVALID NVIDIA API key…")
    crash_exc: Exception | None = None
    failure_state: dict = {}

    try:
        failure_state = rg.run_report_graph(interview_id)
        print(f"  ✓  Graph completed without crashing (expected)")
    except Exception as exc:
        crash_exc = exc
        print(f"  ✗  Graph CRASHED: {exc}")

    polish_status = failure_state.get("polish_status", "unknown")
    llm_used = bool(failure_state.get("llm_used", False))
    graph_error = failure_state.get("error")

    failed_report = failure_state.get("final_report") or failure_state.get("deterministic_report") or {}
    failed_score = _get_nested(failed_report, ("technicalEvaluation", "score"))

    print(f"\n  polishStatus      : {polish_status}")
    print(f"  llmUsed           : {llm_used}")
    print(f"  graphError        : {graph_error or 'None'}")
    print(f"  score (baseline)  : {base_score}")
    print(f"  score (failure)   : {failed_score}")

    # ── Check forbidden fields ────────────────────────────────────────────────
    forbidden_violations: list[str] = []
    if failed_report and baseline:
        for path in _FORBIDDEN_PATHS:
            old_val = _get_nested(baseline, path)
            new_val = _get_nested(failed_report, path)
            if _normalise(old_val) != _normalise(new_val):
                forbidden_violations.append(
                    f"  VIOLATION: {'.'.join(path)}\n"
                    f"    baseline : {_normalise(old_val)[:120]}\n"
                    f"    failure  : {_normalise(new_val)[:120]}"
                )

    # ── Verdict ───────────────────────────────────────────────────────────────
    print(f"\n{SEPARATOR}")
    failures: list[str] = []

    if crash_exc is not None:
        failures.append(f"Graph crashed with exception: {crash_exc}")

    if graph_error:
        # Graph-level errors (from the pipeline, not polish) are a concern
        # only if they aren't polish-related.
        if "polish" not in str(graph_error).lower():
            failures.append(f"Graph pipeline error (non-polish): {graph_error}")

    if polish_status not in {"failed", "timeout"}:
        failures.append(
            f"polishStatus is '{polish_status}', expected 'failed' or 'timeout'"
        )

    if llm_used:
        failures.append("llmUsed is True — LLM should NOT have succeeded with an invalid key")

    if base_score != failed_score:
        failures.append(
            f"Score changed: baseline={base_score} failure={failed_score}"
        )

    if forbidden_violations:
        failures.append(f"{len(forbidden_violations)} forbidden field(s) changed")
        for v in forbidden_violations:
            print(v)

    if failures:
        print("  ✗  FAIL  failure handling test")
        for f in failures:
            print(f"     - {f}")
        sys.exit(1)
    else:
        print("  ✓  PASS  failure handling test")
        print(f"     Graph completed without crash")
        print(f"     polishStatus={polish_status}")
        print(f"     llmUsed=false")
        print(f"     Deterministic report returned unchanged")
        print(f"     Forbidden fields unchanged")

    print(SEPARATOR)


if __name__ == "__main__":
    main()
