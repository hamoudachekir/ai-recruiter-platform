"""GPU inference router — Phase 5.

Routes heavy inference workloads to GPU queues when available and falls back to
CPU paths when the GPU pool is unavailable. This layer wraps inference jobs; it
never changes deterministic scoring or final report semantics.
"""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass
from typing import Any, Literal

_LOG = logging.getLogger(__name__)

InferencePool = Literal["cpu", "gpu"]

GPU_REQUIRED_MODELS = {
    "whisper-large",
    "whisper-large-v2",
    "whisper-large-v3",
    "yolo",
    "vision",
    "face-detection",
}
CPU_PREFERRED_MODELS = {"replay", "small-calibration", "metadata", "ranking"}


@dataclass(frozen=True)
class InferenceRoute:
    model: str
    pool: InferencePool
    queue: str
    reason: str
    timeoutSeconds: int
    fallbackPool: InferencePool | None = None


def classify_model(model_name: str) -> InferencePool:
    """Select the preferred inference pool for a model name."""
    key = model_name.lower().replace("_", "-")
    if any(token in key for token in GPU_REQUIRED_MODELS):
        return "gpu"
    if any(token in key for token in CPU_PREFERRED_MODELS):
        return "cpu"
    if "large" in key or "vision" in key:
        return "gpu"
    return "cpu"


def gpu_pool_healthy() -> bool:
    """Best-effort GPU pool health check.

    If Redis is available, checks a heartbeat key that GPU workers can update.
    If no key exists, falls back to local CUDA availability.
    """
    try:
        from app.workers.queue_config import REDIS_URL

        redis_mod = __import__("redis")
        Redis = getattr(redis_mod, "Redis")
        redis = Redis.from_url(REDIS_URL, socket_connect_timeout=1)
        heartbeat = redis.get("gpu_pool:heartbeat")
        if heartbeat:
            ts = float(heartbeat.decode("utf-8"))
            return time.time() - ts < int(os.getenv("GPU_HEARTBEAT_TTL", "60"))
    except Exception:  # noqa: BLE001
        pass

    try:
        import torch

        return bool(torch.cuda.is_available())
    except Exception:  # noqa: BLE001
        return False


def route_inference_job(
    model_name: str, tenant_id: str = "", priority: str = "default"
) -> InferenceRoute:
    """Return queue/pool routing instructions for an inference job."""
    preferred = classify_model(model_name)
    if preferred == "gpu":
        if gpu_pool_healthy():
            return InferenceRoute(
                model=model_name,
                pool="gpu",
                queue="high",
                reason="heavy_model_gpu_available",
                timeoutSeconds=int(os.getenv("GPU_INFERENCE_TIMEOUT", "900")),
                fallbackPool="cpu",
            )
        return InferenceRoute(
            model=model_name,
            pool="cpu",
            queue="default",
            reason="gpu_unavailable_cpu_fallback",
            timeoutSeconds=int(os.getenv("CPU_FALLBACK_TIMEOUT", "1800")),
            fallbackPool=None,
        )

    queue = "high" if priority == "high" else "default"
    return InferenceRoute(
        model=model_name,
        pool="cpu",
        queue=queue,
        reason="cpu_preferred_or_small_job",
        timeoutSeconds=int(os.getenv("CPU_INFERENCE_TIMEOUT", "600")),
    )


def enqueue_inference_job(
    model_name: str,
    task_name: str,
    payload: dict[str, Any],
    tenant_id: str = "",
    priority: str = "default",
) -> dict:
    """Enqueue an inference job to the selected pool.

    Generic workers can inspect `taskName`, `modelName`, and `payload`.
    If Redis is unavailable, returns a sync-fallback response for caller-owned
    execution.
    """
    route = route_inference_job(model_name, tenant_id=tenant_id, priority=priority)
    try:
        from app.monitoring.metrics import inference_timer
        from app.workers.queue_config import get_queue

        q = get_queue(route.queue)
        if q is None:
            return {
                "enqueued": False,
                "route": route.__dict__,
                "fallback": "sync_required",
            }

        job_id = f"inference:{tenant_id or 'global'}:{task_name}:{payload.get('id') or payload.get('interviewId') or int(time.time())}"
        with inference_timer(model_name, route.pool, tenant_id):
            job = q.enqueue(
                "app.workers.report_worker.run_generic_inference_job",
                model_name,
                task_name,
                payload,
                tenant_id,
                job_id=job_id,
                timeout=route.timeoutSeconds,
            )
        return {"enqueued": True, "jobId": job.id, "route": route.__dict__}
    except Exception as exc:  # noqa: BLE001
        _LOG.error("[GPURouter] enqueue failed: %s", exc)
        return {"enqueued": False, "error": str(exc), "route": route.__dict__}


def publish_gpu_heartbeat(device: str = "cuda:0") -> None:
    """GPU worker heartbeat helper."""
    try:
        from app.workers.queue_config import REDIS_URL

        redis_mod = __import__("redis")
        Redis = getattr(redis_mod, "Redis")
        redis = Redis.from_url(REDIS_URL, socket_connect_timeout=1)
        redis.set("gpu_pool:heartbeat", str(time.time()), ex=120)
        redis.set(f"gpu_pool:device:{device}", "healthy", ex=120)
    except Exception as exc:  # noqa: BLE001
        _LOG.debug("[GPURouter] heartbeat publish failed: %s", exc)


def get_pool_status() -> dict:
    """Return current routing health for admin dashboards."""
    healthy = gpu_pool_healthy()
    status = {"gpuHealthy": healthy, "cpuHealthy": True, "checkedAt": time.time()}
    try:
        import torch

        status["cudaAvailable"] = bool(torch.cuda.is_available())
        status["cudaDeviceCount"] = (
            int(torch.cuda.device_count()) if torch.cuda.is_available() else 0
        )
    except Exception:
        status["cudaAvailable"] = False
        status["cudaDeviceCount"] = 0
    return status
