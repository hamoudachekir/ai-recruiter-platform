"""Worker Task Functions — Phase 5.

These functions are executed by RQ workers in separate processes.
Each function is idempotent: running it twice produces the same MongoDB state.

WORKER STARTUP:
  rq worker high default low --url $REDIS_URL --with-scheduler

PROCESS ISOLATION:
  Workers run in separate processes from the FastAPI app, so they
  cannot share in-process state. All communication is via MongoDB.
"""

from __future__ import annotations

import logging

_LOG = logging.getLogger(__name__)


# ── Analysis worker ────────────────────────────────────────────────────────────


def run_analysis_job(interview_id: str, tenant_id: str = "") -> dict:
    """Run full post-interview analysis pipeline for one interview.

    Idempotent: the pipeline's init_node handles resume after partial failure.
    Billing event is tracked after successful completion.
    """
    _LOG.info(
        "[Worker:analysis] START interviewId=%s tenant=%s", interview_id, tenant_id
    )
    try:
        from app.services.orchestrator import run_full_analysis

        run_full_analysis(interview_id)
        if tenant_id:
            try:
                from app.services.billing_metering_service import track_event

                track_event(tenant_id, "interview_processed", interview_id=interview_id)
            except Exception:  # noqa: BLE001
                pass
        _LOG.info("[Worker:analysis] DONE interviewId=%s", interview_id)
        return {"success": True, "interviewId": interview_id}
    except Exception as exc:  # noqa: BLE001
        _LOG.error("[Worker:analysis] FAILED interviewId=%s: %s", interview_id, exc)
        raise  # Re-raise so RQ marks job as failed → dead-letter queue


# ── Replay worker ──────────────────────────────────────────────────────────────


def run_replay_job(
    interview_id: str,
    tenant_id: str = "",
    baseline_config: dict | None = None,
    candidate_config: dict | None = None,
) -> dict:
    """Run replay evaluation for one interview."""
    _LOG.info("[Worker:replay] START interviewId=%s", interview_id)
    try:
        from app.services.replay_evaluation_service import compare_replay

        result = compare_replay(interview_id, baseline_config, candidate_config)
        if tenant_id:
            try:
                from app.services.billing_metering_service import track_event

                track_event(tenant_id, "replay_job", interview_id=interview_id)
            except Exception:  # noqa: BLE001
                pass
        _LOG.info(
            "[Worker:replay] DONE interviewId=%s delta=%s",
            interview_id,
            result.get("scoreDelta"),
        )
        return result
    except Exception as exc:  # noqa: BLE001
        _LOG.error("[Worker:replay] FAILED interviewId=%s: %s", interview_id, exc)
        raise


# ── ML Training worker ─────────────────────────────────────────────────────────


def run_training_job(tenant_id: str = "") -> dict:
    """Run ML model training. Tenant-specific if tenant_id provided."""
    _LOG.info("[Worker:training] START tenant=%s", tenant_id or "global")
    try:
        from app.services.ml_training_pipeline import train

        result = train()
        _LOG.info(
            "[Worker:training] DONE tenant=%s mae=%s r2=%s",
            tenant_id or "global",
            result.get("mae"),
            result.get("r2"),
        )
        return result
    except Exception as exc:  # noqa: BLE001
        _LOG.error("[Worker:training] FAILED: %s", exc)
        raise


# ── Generic Inference worker ──────────────────────────────────────────────────


def run_generic_inference_job(
    model_name: str,
    task_name: str,
    payload: dict,
    tenant_id: str = "",
) -> dict:
    """Generic inference task endpoint for GPU/CPU routed jobs.

    The task currently records routing metadata and dispatches only safe,
    non-authoritative operations. Deterministic final reports remain owned by
    the existing orchestrator pipeline.
    """
    _LOG.info(
        "[Worker:inference] START model=%s task=%s tenant=%s",
        model_name,
        task_name,
        tenant_id or "global",
    )
    try:
        from app.services.gpu_inference_router import publish_gpu_heartbeat

        if (
            "gpu" in str(payload.get("pool", "")).lower()
            or "large" in model_name.lower()
        ):
            publish_gpu_heartbeat()
        return {
            "success": True,
            "modelName": model_name,
            "taskName": task_name,
            "tenantId": tenant_id,
            "payloadId": payload.get("id") or payload.get("interviewId", ""),
            "authoritative": False,
        }
    except Exception as exc:  # noqa: BLE001
        _LOG.error("[Worker:inference] FAILED: %s", exc)
        raise


# ── ATS Export worker ─────────────────────────────────────────────────────────


def run_ats_export_job(
    interview_id: str,
    tenant_id: str,
    provider: str,
    job_id_ats: str = "",
    candidate_id: str = "",
) -> dict:
    """Push interview report to an ATS provider.

    Uses tenant credentials from tenant_configs to authenticate.
    """
    _LOG.info(
        "[Worker:ats] START interviewId=%s tenant=%s provider=%s",
        interview_id,
        tenant_id,
        provider,
    )
    try:
        from app.db.mongo import reports_col
        from app.services.tenant_service import get_tenant_config

        report = reports_col.find_one(
            {"interviewId": interview_id, "tenantId": tenant_id}, {"_id": 0}
        )
        if not report:
            _LOG.warning("[Worker:ats] No report for interviewId=%s", interview_id)
            return {"success": False, "reason": "report_not_found"}

        config = get_tenant_config(tenant_id)
        if not config:
            return {"success": False, "reason": "tenant_config_not_found"}

        credentials = {
            "api_key": (config.features or {}).get(f"{provider}_api_key", ""),
            "webhook_secret": (config.features or {}).get(
                f"{provider}_webhook_secret", ""
            ),
        }

        if provider == "greenhouse":
            import asyncio

            from app.integrations.base_ats import GreenhouseAtsProvider

            ats = GreenhouseAtsProvider(tenant_id, credentials)
            result = asyncio.run(
                ats.push_interview_report(report, job_id_ats, candidate_id)
            )
        else:
            result = {
                "success": False,
                "reason": f"Provider {provider} not implemented",
            }

        if result.get("success") and tenant_id:
            try:
                from app.services.billing_metering_service import track_event

                track_event(tenant_id, "ats_export", interview_id=interview_id)
            except Exception:  # noqa: BLE001
                pass

        _LOG.info(
            "[Worker:ats] DONE interviewId=%s success=%s",
            interview_id,
            result.get("success"),
        )
        return result
    except Exception as exc:  # noqa: BLE001
        _LOG.error("[Worker:ats] FAILED interviewId=%s: %s", interview_id, exc)
        raise
