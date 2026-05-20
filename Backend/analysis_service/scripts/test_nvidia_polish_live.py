"""Task 5 — Live NVIDIA LLM polish test.

Runs the report graph with REPORT_POLISH_ENABLED=true and LLM_PROVIDER=nvidia,
then verifies:
  - polishStatus="completed"
  - llmUsed=true
  - All forbidden/deterministic fields are unchanged
  - Only whitelisted prose fields were modified

Usage (PowerShell):
    $env:PYTHONPATH       = "Backend\\analysis_service"
    $env:REPORT_POLISH_ENABLED = "true"
    $env:LLM_PROVIDER     = "nvidia"
    $env:NVIDIA_API_KEY   = "nvapi-..."
    $env:NVIDIA_MODEL     = "meta/llama-3.1-8b-instruct"
    python Backend\\analysis_service\\scripts\\test_nvidia_polish_live.py <interviewId>

Expected:
    polishStatus=completed
    llmUsed=true
    deterministic scores unchanged
    forbidden fields unchanged
    PASS live NVIDIA polish test
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

# ── Require correct env before running ────────────────────────────────────────
def _check_env() -> None:
    errors: list[str] = []
    if (os.getenv("REPORT_POLISH_ENABLED", "").strip().lower() not in {"1", "true", "yes", "on"}):
        errors.append("REPORT_POLISH_ENABLED must be 'true'")
    if (os.getenv("LLM_PROVIDER", "").strip().lower() != "nvidia"):
        errors.append("LLM_PROVIDER must be 'nvidia'")
    if not (os.getenv("NVIDIA_API_KEY") or "").strip():
        errors.append("NVIDIA_API_KEY must be set")
    if errors:
        print("✗  Missing required environment variables:")
        for e in errors:
            print(f"   - {e}")
        sys.exit(1)

_check_env()

SEPARATOR = "─" * 60

# ── Forbidden fields that must NEVER change ────────────────────────────────────
# These are checked by path (dot-separated). A missing path = no change = OK.
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
    # finalRecommendation.status / overallScore if object schema
    ("finalRecommendation", "status"),
    ("finalRecommendation", "overallScore"),
    # visionIntegrityReport forbidden sub-fields
    ("visionIntegrityReport", "riskLevel"),
    ("visionIntegrityReport", "absenceEvents"),
    ("visionIntegrityReport", "multipleFacesDetected"),
    ("visionIntegrityReport", "lightingIssues"),
    ("visionIntegrityReport", "positionIssues"),
]

# ── Whitelisted prose fields (may legitimately change) ─────────────────────────
_PROSE_PATHS: list[tuple[str, ...]] = [
    ("transcriptSummary",),
    ("finalRecommendation",),               # string schema
    ("finalRecommendation", "summary"),     # object schema
    ("finalRecommendation", "nextStep"),
    ("technicalEvaluation", "strengths"),
    ("technicalEvaluation", "weaknesses"),
    ("communicationAnalysis", "summary"),
    ("visionIntegrityReport", "summary"),
    ("aiInterviewerNotes", "summary"),
    ("aiInterviewerNotes", "strengths"),
    ("aiInterviewerNotes", "weaknesses"),
    ("aiInterviewerNotes", "recommendedFollowUpQuestions"),
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


def _run_graph_both(interview_id: str):
    """Run graph twice: once deterministic (baseline), once with polish."""
    # ── Deterministic baseline ────────────────────────────────────────────────
    os.environ["REPORT_POLISH_ENABLED"] = "false"
    from app.services.report_graph import run_report_graph, _compiled_graph
    import app.services.report_graph as rg
    rg._compiled_graph = None  # reset cached graph so env is re-read

    baseline_state = run_report_graph(interview_id)
    if baseline_state.get("error"):
        raise RuntimeError(f"Baseline graph failed: {baseline_state['error']}")
    baseline = copy.deepcopy(
        baseline_state.get("final_report") or baseline_state.get("deterministic_report") or {}
    )

    # ── Polish run ────────────────────────────────────────────────────────────
    os.environ["REPORT_POLISH_ENABLED"] = "true"
    rg._compiled_graph = None  # reset again

    polish_state = run_report_graph(interview_id)
    if polish_state.get("error"):
        raise RuntimeError(f"Polish graph failed: {polish_state['error']}")
    polished = polish_state.get("final_report") or polish_state.get("deterministic_report") or {}

    return baseline, polished, polish_state


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: python test_nvidia_polish_live.py <interviewId>")
        sys.exit(2)

    interview_id = sys.argv[1].strip()

    # Print config (never log the actual key)
    nvidia_key = (os.getenv("NVIDIA_API_KEY") or "").strip()
    model = os.getenv("NVIDIA_MODEL", "meta/llama-3.1-8b-instruct")

    print(f"\n{SEPARATOR}")
    print(f"  LIVE NVIDIA POLISH TEST  —  interviewId: {interview_id}")
    print(SEPARATOR)
    print(f"  provider          : nvidia")
    print(f"  model             : {model}")
    print(f"  API key loaded    : {'yes' if nvidia_key else 'no'}")
    print()

    try:
        baseline, polished, polish_state = _run_graph_both(interview_id)
    except Exception as exc:
        print(f"✗  Graph execution failed: {exc}")
        sys.exit(1)

    polish_status = polish_state.get("polish_status", "unknown")
    llm_used = bool(polish_state.get("llm_used", False))

    print(f"  polishStatus      : {polish_status}")
    print(f"  llmUsed           : {llm_used}")

    # ── Determine which prose fields changed ─────────────────────────────────
    polished_fields: list[str] = []
    for path in _PROSE_PATHS:
        old_val = _get_nested(baseline, path)
        new_val = _get_nested(polished, path)
        if _normalise(old_val) != _normalise(new_val) and new_val is not None:
            polished_fields.append(".".join(path))

    print(f"\n  Prose fields polished ({len(polished_fields)}):")
    if polished_fields:
        for f in polished_fields:
            print(f"    ✓ {f}")
    else:
        print("    (none — model may not have changed any prose)")

    # ── Check forbidden fields ────────────────────────────────────────────────
    forbidden_violations: list[str] = []
    for path in _FORBIDDEN_PATHS:
        old_val = _get_nested(baseline, path)
        new_val = _get_nested(polished, path)
        if _normalise(old_val) != _normalise(new_val):
            forbidden_violations.append(
                f"  VIOLATION: {'.'.join(path)}\n"
                f"    baseline : {_normalise(old_val)[:120]}\n"
                f"    polished : {_normalise(new_val)[:120]}"
            )

    # ── Final score comparison ────────────────────────────────────────────────
    base_score = _get_nested(baseline, ("technicalEvaluation", "score"))
    new_score = _get_nested(polished, ("technicalEvaluation", "score"))
    scores_unchanged = base_score == new_score

    rec_status_base = (
        baseline.get("finalRecommendation")
        if isinstance(baseline.get("finalRecommendation"), str)
        else _get_nested(baseline, ("finalRecommendation", "status")) or "N/A"
    )
    rec_status_new = (
        polished.get("finalRecommendation")
        if isinstance(polished.get("finalRecommendation"), str)
        else _get_nested(polished, ("finalRecommendation", "status")) or "N/A"
    )

    print(f"\n  Final recommendation (base) : {str(rec_status_base)[:100]}")
    print(f"  Final recommendation (polished): {str(rec_status_new)[:100]}")
    print(f"  Technical score (base)   : {base_score}")
    print(f"  Technical score (polished): {new_score}")
    print(f"  Deterministic scores unchanged: {'yes' if scores_unchanged else 'NO — VIOLATION'}")

    # ── Verdict ───────────────────────────────────────────────────────────────
    print(f"\n{SEPARATOR}")
    failures: list[str] = []

    if polish_status != "completed":
        failures.append(f"polishStatus is '{polish_status}', expected 'completed'")
    if not llm_used:
        failures.append("llmUsed is False — LLM did not run successfully")
    if not scores_unchanged:
        failures.append("Deterministic score changed — forbidden field mutation detected")
    if forbidden_violations:
        failures.append(f"{len(forbidden_violations)} forbidden field(s) changed")
        for v in forbidden_violations:
            print(v)

    if failures:
        print("  ✗  FAIL  live NVIDIA polish test")
        for f in failures:
            print(f"     - {f}")
        sys.exit(1)
    else:
        print("  ✓  PASS  live NVIDIA polish test")
        print(f"     polishStatus=completed  llmUsed=true")
        print(f"     deterministic scores unchanged")
        print(f"     forbidden fields unchanged")
        if polished_fields:
            print(f"     prose fields polished: {', '.join(polished_fields)}")

    print(SEPARATOR)


if __name__ == "__main__":
    main()
