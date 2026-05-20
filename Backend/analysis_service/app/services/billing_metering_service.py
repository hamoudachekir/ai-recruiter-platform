"""Billing Metering Service — Phase 5.

Tracks per-tenant resource consumption for billing readiness.

TRACKED EVENTS:
  interview_processed   One interview analyzed end-to-end
  streaming_minute      One minute of realtime audio processing
  gpu_minute            One minute of GPU inference time
  replay_job            One replay evaluation run
  ats_export            One ATS sync/export operation
  report_export         One PDF/JSON report export
  storage_mb            Storage usage snapshot

All events are written to billing_events collection.
Aggregation is read-only and computed on demand.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

_LOG = logging.getLogger(__name__)

VALID_EVENT_TYPES = {
    "interview_processed",
    "streaming_minute",
    "gpu_minute",
    "replay_job",
    "ats_export",
    "report_export",
    "storage_mb",
}


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def track_event(
    tenant_id: str,
    event_type: str,
    quantity: float = 1.0,
    interview_id: Optional[str] = None,
    metadata: Optional[dict] = None,
) -> None:
    """Record a single billing event. Fire-and-forget."""
    if event_type not in VALID_EVENT_TYPES:
        _LOG.warning(
            "[Billing] Unknown event_type=%s for tenant=%s", event_type, tenant_id
        )
        return
    try:
        from app.db.mongo import billing_events_col

        billing_events_col.insert_one(
            {
                "tenantId": tenant_id,
                "eventType": event_type,
                "quantity": round(float(quantity), 4),
                "interviewId": interview_id or "",
                "metadata": metadata or {},
                "recordedAt": _utc_now(),
            }
        )
    except Exception as exc:  # noqa: BLE001
        _LOG.warning("[Billing] track_event failed for tenant=%s: %s", tenant_id, exc)


def get_usage_summary(tenant_id: str, period: str = "current_month") -> dict:
    """Compute usage totals for a tenant over a time period.

    Args:
        tenant_id: The tenant to summarize.
        period:    "current_month" | "last_month" | "last_7d" | "all_time"

    Returns:
        dict with per-event-type totals and cost indicators.
    """
    try:
        return _aggregate(tenant_id, period)
    except Exception as exc:  # noqa: BLE001
        _LOG.error("[Billing] get_usage_summary failed: %s", exc)
        return {"tenantId": tenant_id, "period": period, "error": str(exc)}


def _aggregate(tenant_id: str, period: str) -> dict:
    from app.db.mongo import billing_events_col

    now = _utc_now()
    if period == "current_month":
        start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    elif period == "last_month":
        first_this_month = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        start = (first_this_month - timedelta(days=1)).replace(day=1, hour=0)
        now = first_this_month
    elif period == "last_7d":
        start = now - timedelta(days=7)
    else:  # all_time
        start = datetime(2020, 1, 1, tzinfo=timezone.utc)

    events = list(
        billing_events_col.find(
            {"tenantId": tenant_id, "recordedAt": {"$gte": start, "$lte": now}},
            {"_id": 0, "eventType": 1, "quantity": 1},
        )
    )

    totals: dict[str, float] = {et: 0.0 for et in VALID_EVENT_TYPES}
    for e in events:
        et = e.get("eventType", "")
        if et in totals:
            totals[et] += float(e.get("quantity", 1.0))

    return {
        "tenantId": tenant_id,
        "period": period,
        "from": start.isoformat(),
        "to": now.isoformat(),
        "totalEvents": len(events),
        "usage": {k: round(v, 2) for k, v in totals.items()},
        "computedAt": _utc_now().isoformat(),
    }


def get_top_tenants_by_usage(
    event_type: str = "interview_processed", limit: int = 10
) -> list[dict]:
    """Return top tenants sorted by usage (super_admin only)."""
    try:
        from app.db.mongo import billing_events_col

        pipeline = [
            {"$match": {"eventType": event_type}},
            {"$group": {"_id": "$tenantId", "total": {"$sum": "$quantity"}}},
            {"$sort": {"total": -1}},
            {"$limit": limit},
            {"$project": {"tenantId": "$_id", "total": 1, "_id": 0}},
        ]
        return list(billing_events_col.aggregate(pipeline))
    except Exception as exc:  # noqa: BLE001
        _LOG.error("[Billing] get_top_tenants_by_usage failed: %s", exc)
        return []
