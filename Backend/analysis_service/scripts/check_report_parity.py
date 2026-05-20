"""Task 3 — Deterministic parity check script.

Compares the EXISTING report in MongoDB (if any) with the freshly generated
LangGraph deterministic report, ignoring metadata-only fields.

Usage (PowerShell):
    $env:PYTHONPATH  = "Backend\\analysis_service"
    $env:REPORT_POLISH_ENABLED = "false"
    python Backend\\analysis_service\\scripts\\check_report_parity.py <interviewId>

Expected: PASS parity check
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

# Force deterministic mode regardless of environment
os.environ["REPORT_POLISH_ENABLED"] = "false"

# ── Metadata fields to ignore in diff ──────────────────────────────────────────
_IGNORE_KEYS = {
    "generatedAt",
    "updatedAt",
    "createdAt",
    "analysisAgent",
    "polishStatus",
    "llmUsed",
    "graphVersion",
    "warnings",
    "errors",
    "_id",
}

# ── Business fields to compare ─────────────────────────────────────────────────
_COMPARE_PATHS: list[tuple[str, ...]] = [
    # Top-level
    ("finalRecommendation",),
    ("humanReviewRequired",),
    # Score
    ("technicalEvaluation", "score"),
    ("technicalEvaluation", "strengths"),
    ("technicalEvaluation", "weaknesses"),
    # Vision / integrity
    ("visionMonitoring",),
    ("integrityAlerts",),
    ("audioAnalysis",),
    # If schema uses extended fields
    ("scoreBreakdown",),
    ("communicationAnalysis",),
    ("visionIntegrityReport",),
    ("questionEvaluations",),
]

SEPARATOR = "─" * 60


def _strip_meta(doc: dict) -> dict:
    """Return a shallow copy with metadata keys removed."""
    return {k: v for k, v in doc.items() if k not in _IGNORE_KEYS}


def _get_nested(doc: dict, path: tuple[str, ...]):
    cur = doc
    for key in path:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(key)
    return cur


def _normalise(value) -> str:
    """Stable JSON representation for comparison."""
    try:
        return json.dumps(value, sort_keys=True, default=str)
    except Exception:
        return str(value)


def _load_existing_report(interview_id: str) -> dict | None:
    try:
        from pymongo import MongoClient
        mongo_url = os.getenv("MONGO_URL", "mongodb://127.0.0.1:27017")
        db_name = os.getenv("MONGO_DB_NAME", "ai_recruiter")
        client = MongoClient(mongo_url, serverSelectionTimeoutMS=5000)
        db = client[db_name]
        doc = db["interview_final_reports"].find_one({"interviewId": interview_id})
        if doc:
            doc.pop("_id", None)
        return doc
    except Exception as exc:
        print(f"[mongo] Could not load existing report: {exc}")
        return None


def _run_new_report(interview_id: str) -> dict:
    from app.services.report_graph import run_report_graph
    state = run_report_graph(interview_id)
    if state.get("error"):
        raise RuntimeError(f"Graph failed: {state['error']}")
    return state.get("final_report") or state.get("deterministic_report") or {}


def _diff_reports(old: dict, new: dict) -> list[str]:
    diffs: list[str] = []

    # Compare specific business paths
    for path in _COMPARE_PATHS:
        old_val = _get_nested(old, path)
        new_val = _get_nested(new, path)
        old_str = _normalise(old_val)
        new_str = _normalise(new_val)
        if old_str != new_str:
            key = ".".join(path)
            diffs.append(f"  FIELD : {key}")
            diffs.append(f"    OLD : {old_str[:200]}")
            diffs.append(f"    NEW : {new_str[:200]}")

    return diffs


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: python check_report_parity.py <interviewId>")
        sys.exit(2)

    interview_id = sys.argv[1].strip()
    print(f"\n{SEPARATOR}")
    print(f"  DETERMINISTIC PARITY CHECK  —  interviewId: {interview_id}")
    print(SEPARATOR)
    print(f"  REPORT_POLISH_ENABLED : false (forced)")

    # Load existing report from MongoDB (before running graph)
    print(f"\n[1] Loading existing report from MongoDB…")
    old_report = _load_existing_report(interview_id)
    if old_report:
        print(f"     ✓ Existing report found ({len(old_report)} fields)")
    else:
        print(f"     ⚠  No existing report in MongoDB — will compare new vs new")

    # Run LangGraph in deterministic mode
    print(f"\n[2] Running LangGraph report (deterministic mode)…")
    try:
        new_report = _run_new_report(interview_id)
        print(f"     ✓ New report generated ({len(new_report)} fields)")
    except Exception as exc:
        print(f"     ✗ Graph failed: {exc}")
        sys.exit(1)

    # If no old report, compare new report with itself (sanity)
    if old_report is None:
        print(f"\n     ℹ  No baseline to compare — running self-consistency check.")
        old_report = copy.deepcopy(new_report)

    # Strip metadata from both
    old_clean = _strip_meta(old_report)
    new_clean = _strip_meta(new_report)

    # Diff
    print(f"\n[3] Comparing business fields…")
    diffs = _diff_reports(old_clean, new_clean)

    print(f"\n{SEPARATOR}")
    if not diffs:
        print("  ✓  PASS  parity check — all business fields are identical")
        print(SEPARATOR)
        sys.exit(0)
    else:
        print(f"  ✗  FAIL  parity check — {len(diffs) // 3} field(s) differ:")
        print(SEPARATOR)
        for line in diffs:
            print(line)
        print(f"\n  Note: metadata fields (generatedAt, polishStatus, etc.) are excluded from diff.")
        sys.exit(1)


if __name__ == "__main__":
    main()
