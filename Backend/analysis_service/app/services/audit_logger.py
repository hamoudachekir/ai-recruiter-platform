"""Structured Audit Log System — Phase 3.

Writes immutable audit events to the ``interview_audit_logs`` MongoDB collection.
Every significant pipeline action is logged with a payload hash for integrity
verification.

DESIGN RULES:
- ``log()`` is fire-and-forget: exceptions are caught locally — an audit failure
  must NEVER fail the pipeline.
- ``payloadHash`` is a truncated SHA-256 of the JSON-serialised payload, allowing
  external verification: same payload → same hash.
- Events are append-only: never update, never delete.
- ``get_refs()`` returns event IDs accumulated during a single run.  These IDs
  are embedded in the final report so recruiters can query the full audit trail.

Event types
-----------
  pipeline_start        Graph execution started.
  pipeline_end          Graph execution ended (completed or failed).
  score_computed        A batch of scores was produced.
  decision_made         PASS / FAIL / REVIEW_REQUIRED label assigned.
  hallucination_check   Hallucination guard executed.
  replay_action         Pipeline was replayed from snapshot.
  node_start / node_end A LangGraph node started / ended.
"""

from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime, timezone
from typing import Any

_LOG = logging.getLogger(__name__)

# Module-level run cache: interview_id → list[event_id_str]
# Sufficient for a single-process FastAPI server; each interview runs once per
# background task, so there is no cross-contamination between runs.
_run_refs: dict[str, list[str]] = {}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _hash_payload(payload: dict[str, Any] | None) -> str:
    """Return a short, deterministic SHA-256 hex of the payload."""
    if not payload:
        return "sha256:empty"
    try:
        canonical = json.dumps(payload, sort_keys=True, default=str)
        digest = hashlib.sha256(canonical.encode()).hexdigest()
        return f"sha256:{digest[:16]}"  # 16 chars — readable, unique enough
    except Exception:  # noqa: BLE001
        return "sha256:error"


# ---------------------------------------------------------------------------
# Public interface
# ---------------------------------------------------------------------------


class AuditLogger:
    """Static namespace for audit-log operations.

    Usage::

        from app.services.audit_logger import AuditLogger

        AuditLogger.log(
            interview_id="room-xxx",
            node_name="build_report",
            event_type="score_computed",
            summary="overall=78 decision=REVIEW_REQUIRED",
            payload={"overallScore": 78},
        )

        refs = AuditLogger.get_refs("room-xxx")
    """

    @staticmethod
    def log(
        interview_id: str,
        node_name: str,
        event_type: str,
        summary: str,
        payload: dict[str, Any] | None = None,
    ) -> str | None:
        """Write one audit event to MongoDB and cache its ID for this run.

        Args:
            interview_id: The interview being audited.
            node_name:    Pipeline component name, e.g. ``"build_report"``.
            event_type:   One of the event type strings listed in the module doc.
            summary:      Human-readable one-liner (truncated to 500 chars).
            payload:      Optional data dict — only its hash is stored, not the
                          full content, to keep the collection lean.

        Returns:
            The inserted MongoDB ObjectId as a string, or ``None`` on failure.
        """
        try:
            from app.db.mongo import audit_logs_col

            doc = {
                "interviewId": interview_id,
                "timestamp": _utc_now(),
                "nodeName": node_name,
                "eventType": event_type,
                "summary": summary[:500],
                "payloadHash": _hash_payload(payload),
            }
            result = audit_logs_col.insert_one(doc)
            event_id = str(result.inserted_id)

            _run_refs.setdefault(interview_id, []).append(event_id)

            _LOG.debug(
                "[AuditLogger] id=%s interview=%s type=%s node=%s",
                event_id,
                interview_id,
                event_type,
                node_name,
            )
            return event_id

        except Exception as exc:  # noqa: BLE001
            # Audit failure must NEVER propagate to the pipeline caller
            _LOG.error(
                "[AuditLogger] Failed — interview=%s node=%s: %s",
                interview_id,
                node_name,
                exc,
            )
            return None

    @staticmethod
    def get_refs(interview_id: str) -> list[str]:
        """Return all event IDs logged during this run, then clear the cache.

        The returned list is embedded in the final report under
        ``auditLogReferences`` so any report can be fully audited.

        Args:
            interview_id: The interview whose refs should be retrieved.

        Returns:
            List of MongoDB ObjectId strings (may be empty).
        """
        refs = list(_run_refs.get(interview_id, []))
        _run_refs.pop(interview_id, None)  # prevent memory leak in long runs
        return refs

    @staticmethod
    def clear(interview_id: str) -> None:
        """Discard cached event IDs without returning them."""
        _run_refs.pop(interview_id, None)
