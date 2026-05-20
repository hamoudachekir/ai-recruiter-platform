"""Task 2 — Live report graph validation script.

Usage (PowerShell):
    $env:PYTHONPATH = "Backend\\analysis_service"
    python Backend\\analysis_service\\scripts\\test_live_report_graph.py <interviewId>

Does NOT crash if recording is missing — prints a clear warning instead.
Never logs secrets or API keys.
"""
from __future__ import annotations

import os
import sys
import traceback
from pathlib import Path

# ── Bootstrap: load .env from repo root before importing anything ─────────────
def _load_env() -> None:
    try:
        from dotenv import load_dotenv
        repo_root = Path(__file__).resolve().parents[4]  # …/ai-recruiter-platform
        for candidate in [repo_root / ".env", repo_root / "Backend" / ".env"]:
            if candidate.exists():
                load_dotenv(candidate)
                print(f"[env] Loaded: {candidate}")
                return
        print("[env] No .env file found — using process environment variables.")
    except ImportError:
        print("[env] python-dotenv not installed — using process environment variables.")

_load_env()

# ── Now safe to import project modules ───────────────────────────────────────
from app.core.config import UPLOADS_DIR, log_resolved_paths  # noqa: E402

SEPARATOR = "─" * 60


def _section(title: str) -> None:
    print(f"\n{SEPARATOR}")
    print(f"  {title}")
    print(SEPARATOR)


def _check_mongo(interview_id: str) -> tuple[bool, bool, bool]:
    """Returns (connected, interview_found, report_found)."""
    try:
        from pymongo import MongoClient
        from pymongo.errors import ServerSelectionTimeoutError
        mongo_url = os.getenv("MONGO_URL", "mongodb://127.0.0.1:27017")
        db_name = os.getenv("MONGO_DB_NAME", "ai_recruiter")
        client = MongoClient(mongo_url, serverSelectionTimeoutMS=5000)
        client.admin.command("ping")
        db = client[db_name]

        from bson import ObjectId
        oid = None
        try:
            oid = ObjectId(interview_id)
        except Exception:
            pass

        call_rooms = db["callrooms"]
        interview = (
            (call_rooms.find_one({"_id": oid}) if oid else None)
            or call_rooms.find_one({"roomId": interview_id})
        )

        reports = db["interview_final_reports"]
        report = reports.find_one({"interviewId": interview_id})

        return True, interview is not None, report is not None
    except Exception as exc:
        print(f"[mongo] ERROR: {exc}")
        return False, False, False


def _check_recording(interview_id: str) -> tuple[bool, str | None]:
    """Returns (found, resolved_path_or_None)."""
    interview_dir = UPLOADS_DIR / interview_id / "raw"
    if not interview_dir.exists():
        return False, None
    candidates = sorted(interview_dir.glob("*"))
    if not candidates:
        return False, None
    return True, str(candidates[-1])


def _run_graph(interview_id: str) -> dict:
    from app.services.report_graph import run_report_graph
    return run_report_graph(interview_id)


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: python test_live_report_graph.py <interviewId>")
        sys.exit(2)

    interview_id = sys.argv[1].strip()

    _section("RESOLVED PATHS")
    log_resolved_paths()

    _section("MONGODB CHECK")
    mongo_ok, interview_found, report_found = _check_mongo(interview_id)
    print(f"  MongoDB connection status : {'✓ connected' if mongo_ok else '✗ FAILED'}")
    print(f"  Interview found           : {'yes' if interview_found else 'no'}")
    print(f"  Existing report found     : {'yes' if report_found else 'no'}")

    _section("RECORDING CHECK")
    rec_found, rec_path = _check_recording(interview_id)
    print(f"  Resolved uploads path     : {UPLOADS_DIR}")
    print(f"  Recording found           : {'yes' if rec_found else 'no'}")
    if rec_found:
        print(f"  Recording path            : {rec_path}")
    else:
        print("  ⚠  WARNING: No recording file found.")
        print("     The graph will fail at the init node.")
        print("     Upload a recording to:")
        print(f"     {UPLOADS_DIR / interview_id / 'raw' / '<filename>'}")

    if not mongo_ok:
        print("\n✗  Cannot run graph — MongoDB is not reachable. Aborting.")
        sys.exit(1)

    _section("RUNNING REPORT GRAPH")
    print(f"  interviewId : {interview_id}")
    print(f"  REPORT_POLISH_ENABLED : {os.getenv('REPORT_POLISH_ENABLED', 'false')}")

    graph_error: str | None = None
    final_state: dict = {}
    graph_status = "UNKNOWN"

    try:
        final_state = _run_graph(interview_id)
        graph_error = final_state.get("error")
        graph_status = "FAILED" if graph_error else "COMPLETED"
    except Exception:
        graph_error = traceback.format_exc()
        graph_status = "CRASHED"

    _section("RESULTS")
    print(f"  interviewId              : {interview_id}")
    print(f"  MongoDB connection status: {'connected' if mongo_ok else 'failed'}")
    print(f"  Interview found          : {'yes' if interview_found else 'no'}")
    print(f"  Existing report found    : {'yes' if report_found else 'no'}")
    print(f"  Recording found          : {'yes' if rec_found else 'no'}")
    print(f"  Resolved uploads path    : {UPLOADS_DIR}")
    print(f"  Graph status             : {graph_status}")
    print(f"  polishStatus             : {final_state.get('polish_status', 'N/A')}")
    print(f"  llmUsed                  : {final_state.get('llm_used', False)}")

    report = final_state.get("final_report") or {}
    rec_status = (
        report.get("finalRecommendation")
        if isinstance(report.get("finalRecommendation"), str)
        else (report.get("finalRecommendation") or {}).get("status", "N/A")
    )
    tech_score = (report.get("technicalEvaluation") or {}).get("score", "N/A")
    print(f"  Final recommendation     : {str(rec_status)[:120]}")
    print(f"  Technical score          : {tech_score}")

    if graph_error:
        print(f"\n  ⚠  ERROR: {graph_error}")

    print()
    if graph_status == "COMPLETED":
        print("✓  PASS  — graph completed successfully")
    else:
        print(f"✗  FAIL  — graph status: {graph_status}")
        sys.exit(1)


if __name__ == "__main__":
    main()
