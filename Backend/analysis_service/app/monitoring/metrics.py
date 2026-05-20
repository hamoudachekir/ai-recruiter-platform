"""Prometheus metrics for Phase 5 enterprise operations.

Metrics are intentionally advisory and operational only; they never alter the
Phase 3 deterministic report or replay guarantees.
"""

from __future__ import annotations

from contextlib import contextmanager
from time import perf_counter

try:
    _prometheus_client = __import__("prometheus_client")
    Counter = getattr(_prometheus_client, "Counter")
    Gauge = getattr(_prometheus_client, "Gauge")
    Histogram = getattr(_prometheus_client, "Histogram")
except ImportError:

    class _NoopMetric:
        def __init__(self, *args, **kwargs):
            pass

        def labels(self, *args, **kwargs):
            return self

        def observe(self, *args, **kwargs):
            return None

        def inc(self, *args, **kwargs):
            return None

        def dec(self, *args, **kwargs):
            return None

        def set(self, *args, **kwargs):
            return None

    Counter = Gauge = Histogram = _NoopMetric

QUEUE_LATENCY_SECONDS = Histogram(
    "ai_recruiter_queue_latency_seconds",
    "Time jobs spend waiting in Redis queues.",
    ["queue", "tenant_id", "job_type"],
    buckets=(0.1, 1, 5, 15, 30, 60, 120, 300, 600, 1800),
)

INFERENCE_LATENCY_SECONDS = Histogram(
    "ai_recruiter_inference_latency_seconds",
    "Inference latency by model and target pool.",
    ["model", "pool", "tenant_id"],
    buckets=(0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 300),
)

GPU_UTILIZATION = Gauge(
    "ai_recruiter_gpu_utilization_percent",
    "Current GPU utilization percentage by pool.",
    ["pool", "device"],
)

ACTIVE_REALTIME_SESSIONS = Gauge(
    "ai_recruiter_active_realtime_sessions",
    "Active realtime advisory websocket sessions.",
    ["tenant_id"],
)

WEBSOCKET_DISCONNECTS = Counter(
    "ai_recruiter_websocket_disconnects_total",
    "Realtime websocket disconnects.",
    ["tenant_id", "reason"],
)

ATS_SYNC_FAILURES = Counter(
    "ai_recruiter_ats_sync_failures_total",
    "ATS sync/export failures.",
    ["tenant_id", "provider", "operation"],
)

ATS_SYNC_SUCCESSES = Counter(
    "ai_recruiter_ats_sync_successes_total",
    "ATS sync/export successes.",
    ["tenant_id", "provider", "operation"],
)

REPLAY_DIVERGENCE = Histogram(
    "ai_recruiter_replay_divergence_score_delta",
    "Absolute score delta observed during replay comparisons.",
    ["tenant_id"],
    buckets=(0, 0.5, 1, 2, 5, 10, 15, 25, 50),
)

RECRUITER_AGREEMENT = Gauge(
    "ai_recruiter_recruiter_agreement_rate",
    "Recruiter/system agreement rate by tenant.",
    ["tenant_id"],
)

TENANT_USAGE_EVENTS = Counter(
    "ai_recruiter_tenant_usage_events_total",
    "Usage metering events by tenant and event type.",
    ["tenant_id", "event_type"],
)


@contextmanager
def inference_timer(model: str, pool: str, tenant_id: str = ""):
    """Time an inference block and record it to Prometheus."""
    start = perf_counter()
    try:
        yield
    finally:
        INFERENCE_LATENCY_SECONDS.labels(
            model=model, pool=pool, tenant_id=tenant_id or "unknown"
        ).observe(perf_counter() - start)
