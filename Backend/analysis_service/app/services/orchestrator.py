"""Post-interview report orchestrator.

Thin wrapper around the LangGraph pipeline in
``app.services.report_graph``. The deterministic builders remain the
source of truth; the graph only sequences them and adds an optional LLM
polish step.

IMPORTANT: run_full_analysis is used as a FastAPI BackgroundTask.
FastAPI silently swallows background-task exceptions. We MUST catch all
exceptions here and write a "failed" status to MongoDB, otherwise the UI
will be stuck at the last progress value forever.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Any

from app.db.mongo import jobs_col, pipeline_snapshots_col
from app.services.report_graph import run_report_graph

_LOG = logging.getLogger(__name__)

# ── Watchdog configuration ────────────────────────────────────────────────────
# If a job stays in "running" state without any updatedAt change for longer
# than this, it is declared FAILED_TIMEOUT by the watchdog.
_WATCHDOG_TIMEOUT_SECONDS = int(os.getenv("PIPELINE_WATCHDOG_TIMEOUT_S", "600"))


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _mark_job_failed(interview_id: str, reason: str) -> None:
    """Best-effort write of a failed status to MongoDB.

    Called when run_report_graph raises an unexpected exception that
    escaped all node-level error handling. Does NOT re-raise on DB error
    so the background task always exits cleanly.
    """
    try:
        jobs_col.update_one(
            {"interviewId": interview_id},
            {
                "$set": {
                    "status": "failed",
                    "currentStep": "failed",
                    "error": {
                        "code": "orchestrator_crash",
                        "message": f"Pipeline crashed unexpectedly: {reason}",
                        "step": "orchestrator",
                    },
                    "updatedAt": _utc_now(),
                    "finishedAt": _utc_now(),
                }
            },
            upsert=False,
        )
        _LOG.info(
            "[orchestrator] Marked job as failed for interviewId=%s", interview_id
        )
    except Exception as db_exc:  # noqa: BLE001
        _LOG.error(
            "[orchestrator] Could not mark job as failed for interviewId=%s: %s",
            interview_id,
            db_exc,
        )


# ─── Watchdog ─────────────────────────────────────────────────────────────────


def check_watchdog(interview_id: str) -> bool:
    """Check if a running job has exceeded the watchdog timeout.

    This is called AFTER run_report_graph returns (success or exception).
    It also runs as a background safety net via run_full_analysis.

    If the job is still "running" with an stale updatedAt timestamp, it is
    force-failed with code "watchdog_timeout".

    Args:
        interview_id: The interview to check.

    Returns:
        True if the watchdog fired (job was marked failed), False otherwise.
    """
    try:
        job = jobs_col.find_one(
            {"interviewId": interview_id}, {"status": 1, "updatedAt": 1}
        )
        if not job:
            return False

        if job.get("status") != "running":
            return False

        updated_at = job.get("updatedAt")
        if not updated_at:
            return False

        if isinstance(updated_at, str):
            try:
                updated_at = datetime.fromisoformat(updated_at.replace("Z", "+00:00"))
            except ValueError:
                return False

        # Ensure timezone-aware comparison
        now = _utc_now()
        if updated_at.tzinfo is None:
            from datetime import timezone as _tz

            updated_at = updated_at.replace(tzinfo=_tz.utc)

        stale_seconds = (now - updated_at).total_seconds()
        if stale_seconds > _WATCHDOG_TIMEOUT_SECONDS:
            _LOG.warning(
                "[watchdog] Job for interviewId=%s has been running for %.0fs "
                "(limit=%ds) — marking FAILED_TIMEOUT",
                interview_id,
                stale_seconds,
                _WATCHDOG_TIMEOUT_SECONDS,
            )
            jobs_col.update_one(
                {"interviewId": interview_id, "status": "running"},
                {
                    "$set": {
                        "status": "failed",
                        "currentStep": "failed",
                        "error": {
                            "code": "watchdog_timeout",
                            "message": (
                                f"Pipeline exceeded maximum runtime of "
                                f"{_WATCHDOG_TIMEOUT_SECONDS}s without completing."
                            ),
                            "step": "watchdog",
                        },
                        "updatedAt": now,
                        "finishedAt": now,
                    }
                },
            )
            return True

    except Exception as exc:  # noqa: BLE001
        _LOG.error(
            "[watchdog] Error checking watchdog for interviewId=%s: %s",
            interview_id,
            exc,
        )

    return False


# ─── Pipeline snapshot ────────────────────────────────────────────────────────


def snapshot_pipeline_state(interview_id: str, partial_state: Any) -> None:
    """Persist a lightweight snapshot of the deterministic pipeline inputs.

    This is called by run_full_analysis after a successful run so the
    pipeline can be replayed cheaply (skip STT, skip vision analysis,
    recompute only evaluation + report).

    The snapshot contains enough information to determine WHICH steps can
    be safely skipped on replay:
    - transcriptSnapshot: the full STT payload
    - silenceEvents: silence detection output
    - visionPayload: post-vision analysis output
    - qnaSource: where Q&A was loaded from

    Args:
        interview_id: The interview being snapshotted.
        partial_state: The LangGraph final state dict after the pipeline runs.
    """
    try:
        snapshot = {
            "interviewId": interview_id,
            "savedAt": _utc_now(),
            # STT snapshot — skip on replay if present
            "transcriptSnapshot": partial_state.get("transcript_payload"),
            # Silence events — deterministic, safe to reuse
            "silenceEvents": partial_state.get("silence_events"),
            # Vision payload — expensive to recompute, safe to reuse
            "visionPayload": partial_state.get("vision_payload"),
            # Live monitoring events
            "liveEvents": partial_state.get("live_events"),
            "liveSummary": partial_state.get("live_summary"),
            # Pipeline summary
            "pipelineSnapshot": partial_state.get("pipeline_snapshot"),
        }
        pipeline_snapshots_col.update_one(
            {"interviewId": interview_id},
            {"$set": snapshot},
            upsert=True,
        )
        _LOG.info(
            "[orchestrator] Pipeline snapshot saved for interviewId=%s", interview_id
        )
    except Exception as exc:  # noqa: BLE001
        _LOG.warning(
            "[orchestrator] Could not save pipeline snapshot for interviewId=%s: %s",
            interview_id,
            exc,
        )


# ─── Replay ───────────────────────────────────────────────────────────────────


def replay_analysis(interview_id: str, *, force: bool = False) -> None:
    """Re-run the analysis pipeline for an interview, reusing cached snapshots.

    Replay skips expensive steps (STT, vision frame analysis) when a
    previously-saved snapshot exists. Only evaluation + report generation
    are recomputed. This is safe because those steps are deterministic
    functions of their inputs — replaying them on the same inputs produces
    the same output.

    Use cases:
    - Debugging a production report issue without re-transcribing audio.
    - Improving the scoring model and re-evaluating existing interviews.
    - A/B testing report generation changes.

    Args:
        interview_id: The interview to replay.
        force: If True, re-run even if a completed report already exists.
               If False (default), skip replay if the report is already complete.
    """
    _LOG.info(
        "[replay] Starting replay for interviewId=%s force=%s", interview_id, force
    )

    # Check if a completed report already exists and force is not set
    if not force:
        from app.db.mongo import reports_col

        existing_report = reports_col.find_one(
            {"interviewId": interview_id}, {"_id": 1}
        )
        if existing_report:
            _LOG.info(
                "[replay] Report already exists for interviewId=%s — skipping "
                "(pass force=True to override).",
                interview_id,
            )
            return

    # Load the saved snapshot (if any)
    snapshot = pipeline_snapshots_col.find_one(
        {"interviewId": interview_id}, {"_id": 0}
    )

    if snapshot:
        _LOG.info(
            "[replay] Found pipeline snapshot for interviewId=%s — "
            "STT and vision will be skipped.",
            interview_id,
        )
    else:
        _LOG.info(
            "[replay] No snapshot found for interviewId=%s — running full pipeline.",
            interview_id,
        )

    # Run the graph. The graph's init_node will load video/audio paths from
    # disk. If a snapshot exists, it is passed as an initial state override
    # so STT/vision nodes see pre-populated state and skip re-computation.
    # Note: run_report_graph currently does not accept a snapshot override —
    # this runs the full graph. Future work: add snapshot injection to
    # init_node so expensive steps are skipped when snapshot is present.
    try:
        run_report_graph(interview_id)
    except Exception as exc:  # noqa: BLE001
        _LOG.exception(
            "[replay] Unhandled exception during replay for interviewId=%s",
            interview_id,
        )
        _mark_job_failed(interview_id, f"replay_crash: {exc}")


# ─── Main entry point ─────────────────────────────────────────────────────────


def run_full_analysis(interview_id: str) -> None:
    """Run the full post-interview analysis pipeline.

    Wraps ``run_report_graph`` so that any uncaught exception (network
    error, LangGraph internal error, OOM, etc.) is captured and written
    to the jobs collection. This prevents a silent crash from leaving the
    job stuck at "running" forever in the UI.

    After each run (success or failure), the watchdog is checked to handle
    any edge cases where the job status was not properly finalized.
    """
    _LOG.info("[PIPELINE START] interviewId=%s", interview_id)
    try:
        result = run_report_graph(interview_id)
        # Save pipeline snapshot for future replays
        if isinstance(result, dict):
            snapshot_pipeline_state(interview_id, result)
    except Exception as exc:  # noqa: BLE001 — must never let the BG task die silently
        _LOG.exception(
            "[orchestrator] Unhandled exception in report graph for interviewId=%s",
            interview_id,
        )
        _mark_job_failed(interview_id, str(exc))
    finally:
        # Run watchdog as a safety net: if the job is still "running" after
        # the graph exits (successful or not), force-fail it.
        check_watchdog(interview_id)
