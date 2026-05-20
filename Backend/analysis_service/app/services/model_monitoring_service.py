"""Model Monitoring Service — Phase 4.5.

Tracks ML inference events and aggregates daily/weekly/monthly
operational metrics for the monitoring dashboard.

TRACKED PER EVENT:
  - Inference latency (ms)
  - System score vs ML score
  - Calibration error (|system - ml|)
  - Whether ML was applied
  - Model version
  - Score bucket (for distribution tracking)

AGGREGATION WINDOWS: 24h, 7d, 30d

All writes are fire-and-forget. A monitoring failure MUST NEVER
affect the interview analysis pipeline.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

_LOG = logging.getLogger(__name__)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _safe_float(v: object, default: float = 0.0) -> float:
    try:
        return float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


def _score_bucket(score: float) -> str:
    if score < 20:
        return "0-20"
    elif score < 40:
        return "20-40"
    elif score < 60:
        return "40-60"
    elif score < 80:
        return "60-80"
    else:
        return "80-100"


# ── Event recording (fire-and-forget) ─────────────────────────────────────────


def record_inference_event(
    interview_id: str,
    latency_ms: float,
    system_score: float,
    ml_score: Optional[float],
    ml_applied: bool,
    model_version: Optional[str],
) -> None:
    """Record a single inference event. Exceptions are only logged, never raised."""
    try:
        from app.db.mongo import ml_model_monitoring_col

        cal_err = (
            round(abs(_safe_float(system_score) - _safe_float(ml_score)), 2)
            if ml_score is not None
            else None
        )
        ml_model_monitoring_col.insert_one(
            {
                "interviewId": interview_id,
                "eventType": "inference",
                "latencyMs": round(_safe_float(latency_ms), 2),
                "systemScore": round(_safe_float(system_score), 2),
                "mlScore": round(_safe_float(ml_score), 2)
                if ml_score is not None
                else None,
                "calibrationError": cal_err,
                "mlApplied": ml_applied,
                "modelVersion": model_version,
                "scoreBucket": _score_bucket(_safe_float(system_score)),
                "timestamp": _utc_now(),
            }
        )
    except Exception as exc:  # noqa: BLE001
        _LOG.warning("[ModelMonitoring] Event write failed: %s", exc)


# ── Metric aggregation ─────────────────────────────────────────────────────────


def get_monitoring_summary(window: str = "24h") -> dict:
    """Aggregate inference metrics for 24h, 7d, or 30d window."""
    try:
        return _aggregate(window)
    except Exception as exc:  # noqa: BLE001
        _LOG.error("[ModelMonitoring] Aggregation failed (window=%s): %s", window, exc)
        return {"error": str(exc), "window": window, "metricsAvailable": False}


def _aggregate(window: str) -> dict:
    from app.db.mongo import ml_model_monitoring_col

    days_map = {"24h": 1, "7d": 7, "30d": 30}
    days = days_map.get(window, 1)
    cutoff = _utc_now() - timedelta(days=days)

    events = list(
        ml_model_monitoring_col.find(
            {"timestamp": {"$gte": cutoff}, "eventType": "inference"},
            {"_id": 0},
        )
    )

    if not events:
        return {"window": window, "totalInferences": 0, "metricsAvailable": False}

    n = len(events)
    latencies = [e["latencyMs"] for e in events if e.get("latencyMs") is not None]
    cal_errors = [
        e["calibrationError"] for e in events if e.get("calibrationError") is not None
    ]
    ml_applied_count = sum(1 for e in events if e.get("mlApplied"))

    bucket_counts: dict[str, int] = {}
    for e in events:
        b = e.get("scoreBucket", "unknown")
        bucket_counts[b] = bucket_counts.get(b, 0) + 1

    return {
        "window": window,
        "totalInferences": n,
        "metricsAvailable": True,
        "latency": {
            "meanMs": round(sum(latencies) / max(len(latencies), 1), 2),
            "maxMs": round(max(latencies), 2) if latencies else None,
            "minMs": round(min(latencies), 2) if latencies else None,
        },
        "mlAppliedCount": ml_applied_count,
        "mlUsageRate": round(ml_applied_count / n, 3),
        "calibrationError": {
            "mean": round(sum(cal_errors) / max(len(cal_errors), 1), 2)
            if cal_errors
            else None,
            "max": round(max(cal_errors), 2) if cal_errors else None,
        },
        "scoreDistribution": bucket_counts,
        "modelVersions": list(
            {e.get("modelVersion") for e in events if e.get("modelVersion")}
        ),
        "computedAt": _utc_now().isoformat(),
    }
