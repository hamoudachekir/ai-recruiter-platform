"""Redis Queue Configuration — Phase 5.

Centralised connection and queue definitions for all async workers.

QUEUE HIERARCHY:
  high     Transcription jobs (STT is user-blocking)
  high     Report generation jobs
  default  Replay evaluation jobs
  default  ML training jobs
  low      ATS export / sync jobs
  low      ML monitoring snapshots

IDEMPOTENCY:
  Every enqueued job carries a job_id (interviewId + operation + timestamp).
  RQ de-duplicates by job_id within the queue using at-least-once semantics.
  Worker functions are designed to be idempotent — running twice produces
  the same MongoDB state.

DEAD-LETTER QUEUE:
  Failed jobs after MAX_RETRIES are moved to the "failed" queue (RQ default).
  Monitor with: rq info --url redis://...
"""

from __future__ import annotations

import logging
import os
from typing import Optional

_LOG = logging.getLogger(__name__)

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
MAX_JOB_RETRIES = int(os.getenv("WORKER_MAX_RETRIES", "3"))
JOB_TIMEOUT_DEFAULT = int(os.getenv("WORKER_JOB_TIMEOUT", "600"))  # 10 min
JOB_TIMEOUT_TRANSCRIPTION = int(os.getenv("STT_JOB_TIMEOUT", "900"))  # 15 min


def _get_redis():
    """Lazy Redis connection — returns None if redis is unavailable."""
    try:
        redis_mod = __import__("redis")
        Redis = getattr(redis_mod, "Redis")

        conn = Redis.from_url(REDIS_URL, socket_connect_timeout=3)
        conn.ping()
        return conn
    except Exception as exc:  # noqa: BLE001
        _LOG.warning(
            "[Workers] Redis unavailable (%s) — falling back to sync mode.", exc
        )
        return None


def get_queue(name: str = "default"):
    """Return an RQ Queue for the given name, or None if Redis is unavailable."""
    conn = _get_redis()
    if conn is None:
        return None
    try:
        rq_mod = __import__("rq")
        Queue = getattr(rq_mod, "Queue")

        return Queue(name, connection=conn, default_timeout=JOB_TIMEOUT_DEFAULT)
    except Exception as exc:  # noqa: BLE001
        _LOG.warning("[Workers] Queue(%s) creation failed: %s", name, exc)
        return None


# ── Named queue accessors ──────────────────────────────────────────────────────


def transcription_queue():
    return get_queue("high")


def report_generation_queue():
    return get_queue("high")


def replay_jobs_queue():
    return get_queue("default")


def ml_training_queue():
    return get_queue("default")


def ats_export_queue():
    return get_queue("low")


def ml_monitoring_queue():
    return get_queue("low")


# ── Job submission helpers ─────────────────────────────────────────────────────


def enqueue_analysis(
    interview_id: str,
    tenant_id: str = "",
    force: bool = False,
) -> Optional[str]:
    """Enqueue a full post-interview analysis job.

    Returns the RQ job ID, or None if queued synchronously (no Redis).
    """
    q = report_generation_queue()
    job_id = f"analysis:{interview_id}"

    if q is None:
        # Fallback: run synchronously in the current process
        _LOG.info("[Workers] Sync fallback for analysis job %s", interview_id)
        try:
            from app.services.orchestrator import run_full_analysis

            run_full_analysis(interview_id)
        except Exception as exc:  # noqa: BLE001
            _LOG.error("[Workers] Sync analysis failed: %s", exc)
        return None

    try:
        from app.workers.report_worker import run_analysis_job

        job = q.enqueue(
            run_analysis_job,
            interview_id,
            tenant_id,
            job_id=job_id,
            retry=_make_retry(),
        )
        _LOG.info("[Workers] Enqueued analysis job %s → rq_id=%s", interview_id, job.id)
        return job.id
    except Exception as exc:  # noqa: BLE001
        _LOG.error("[Workers] enqueue_analysis failed: %s", exc)
        return None


def enqueue_replay(
    interview_id: str,
    tenant_id: str = "",
    baseline_config: Optional[dict] = None,
    candidate_config: Optional[dict] = None,
) -> Optional[str]:
    """Enqueue a replay evaluation job."""
    q = replay_jobs_queue()
    job_id = f"replay:{interview_id}:{int(__import__('time').time())}"

    if q is None:
        try:
            from app.services.replay_evaluation_service import compare_replay

            compare_replay(interview_id, baseline_config, candidate_config)
        except Exception as exc:  # noqa: BLE001
            _LOG.error("[Workers] Sync replay failed: %s", exc)
        return None

    try:
        from app.workers.report_worker import run_replay_job

        job = q.enqueue(
            run_replay_job,
            interview_id,
            tenant_id,
            baseline_config or {},
            candidate_config or {},
            job_id=job_id,
            retry=_make_retry(),
        )
        return job.id
    except Exception as exc:  # noqa: BLE001
        _LOG.error("[Workers] enqueue_replay failed: %s", exc)
        return None


def enqueue_ml_training(tenant_id: str = "") -> Optional[str]:
    """Enqueue an ML training job."""
    q = ml_training_queue()
    job_id = f"train:{tenant_id or 'global'}:{int(__import__('time').time())}"

    if q is None:
        try:
            from app.services.ml_training_pipeline import train

            train()
        except Exception as exc:  # noqa: BLE001
            _LOG.error("[Workers] Sync training failed: %s", exc)
        return None

    try:
        from app.workers.report_worker import run_training_job

        job = q.enqueue(
            run_training_job,
            tenant_id,
            job_id=job_id,
            retry=_make_retry(),
            timeout=3600,  # Training can take a while
        )
        return job.id
    except Exception as exc:  # noqa: BLE001
        _LOG.error("[Workers] enqueue_ml_training failed: %s", exc)
        return None


def enqueue_ats_export(
    interview_id: str,
    tenant_id: str,
    provider: str,
    job_id_ats: str = "",
    candidate_id: str = "",
) -> Optional[str]:
    """Enqueue an ATS export job."""
    q = ats_export_queue()
    job_id = f"ats:{tenant_id}:{interview_id}"

    if q is None:
        return None  # ATS export is async-only; no sync fallback

    try:
        from app.workers.report_worker import run_ats_export_job

        job = q.enqueue(
            run_ats_export_job,
            interview_id,
            tenant_id,
            provider,
            job_id_ats,
            candidate_id,
            job_id=job_id,
            retry=_make_retry(),
        )
        return job.id
    except Exception as exc:  # noqa: BLE001
        _LOG.error("[Workers] enqueue_ats_export failed: %s", exc)
        return None


def _make_retry():
    """Build an RQ Retry object if available."""
    try:
        rq_job_mod = __import__("rq.job", fromlist=["Retry"])
        Retry = getattr(rq_job_mod, "Retry")

        return Retry(max=MAX_JOB_RETRIES, interval=[10, 30, 60])
    except ImportError:
        return None
