#!/usr/bin/env python3
"""
Phase 6 Load Test — AI Interview Pipeline (Locust)
====================================================

Locust HTTP load test for the AI recruiter analysis service.

Run scenarios
-------------
10 concurrent users (smoke):
    locust -f tests/load/locustfile.py \\
           --host http://localhost:8001 \\
           --users 10 --spawn-rate 1 --run-time 2m --headless

50 concurrent users (stress):
    locust -f tests/load/locustfile.py \\
           --host http://localhost:8001 \\
           --users 50 --spawn-rate 5 --run-time 3m --headless

100 concurrent users (peak):
    locust -f tests/load/locustfile.py \\
           --host http://localhost:8001 \\
           --users 100 --spawn-rate 10 --run-time 5m --headless

Measured metrics
----------------
- Report generation latency (end-to-end HTTP round-trips)
- MongoDB query latency (direct pymongo probe task)
- Queue wait time (extracted from trigger response payload)
- WebSocket stability (counters updated by LoadTestMetrics)
- CPU / memory / GPU usage (psutil + optional nvidia-smi)

Output
------
tests/results/load_test_report.json  (merged with any pre-existing content)

Schema
------
{
  "suite": "load_test",
  "scenarios": [
    {"scenario": "locust", "concurrent_users": 10, "metrics": {...}, ...},
    ...
  ],
  "metrics": {...},
  "resources": {"cpu_usage_percent": ..., "memory_usage_mb": ..., "gpu_usage_percent": ...},
  "generated_at": "<ISO-8601>",
  "pass": true | false
}
"""

from __future__ import annotations

import json
import logging
import os
import random
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

# ---------------------------------------------------------------------------
# sys.path: allow importing from Backend/analysis_service if needed
# ---------------------------------------------------------------------------
_REPO_ROOT: Path = Path(__file__).resolve().parents[2]  # ai-recruiter-platform/
_BACKEND: Path = _REPO_ROOT / "Backend"
_ANALYSIS_SVC: Path = _BACKEND / "analysis_service"

for _extra in (_REPO_ROOT, _BACKEND, _ANALYSIS_SVC):
    _s = str(_extra)
    if _s not in sys.path:
        sys.path.insert(0, _s)

# ---------------------------------------------------------------------------
# Optional / graceful third-party imports
# ---------------------------------------------------------------------------
try:
    from locust import HttpUser, between, events, task

    _LOCUST_AVAILABLE = True
except ImportError:  # pragma: no cover — stubs let the file be imported for inspection
    _LOCUST_AVAILABLE = False

    def task(weight: int = 1):  # type: ignore[misc]
        """No-op stub when locust is not installed."""

        def _deco(fn):
            return fn

        return _deco

    def between(lo: float, hi: float):  # type: ignore[misc]
        """No-op stub — returns None; never called without locust."""
        return None

    class HttpUser:  # type: ignore[misc]
        """Minimal stub so the class definition doesn't raise NameError."""

        host: str = ""
        wait_time = None

    class events:  # type: ignore[misc]
        """Stub events namespace."""

        class quitting:  # type: ignore[misc]
            @staticmethod
            def add_listener(fn):
                return fn


try:
    import psutil  # type: ignore[import]

    _PSUTIL_AVAILABLE = True
except ImportError:  # pragma: no cover
    _PSUTIL_AVAILABLE = False

try:
    from pymongo import MongoClient  # type: ignore[import]

    _PYMONGO_AVAILABLE = True
except ImportError:  # pragma: no cover
    _PYMONGO_AVAILABLE = False

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
MONGO_URL: str = os.getenv("MONGO_URL", "mongodb://127.0.0.1:27017")
MONGO_DB_NAME: str = os.getenv("MONGO_DB_NAME", "ai_recruiter_platform")
ANALYSIS_SERVICE_HOST: str = os.getenv("ANALYSIS_SERVICE_HOST", "http://localhost:8001")

RESULTS_DIR: Path = _REPO_ROOT / "tests" / "results"
RESULTS_FILE: Path = RESULTS_DIR / "load_test_report.json"

# 200-ID pool shared across all virtual users
INTERVIEW_ID_POOL: List[str] = [f"load-test-{n}" for n in range(1, 201)]

_LOG = logging.getLogger("locust.load_test")

# ---------------------------------------------------------------------------
# LoadTestMetrics — thread-safe accumulator
# ---------------------------------------------------------------------------


class LoadTestMetrics:
    """Thread-safe accumulator for all load-test observations.

    All public mutator methods acquire a lock before mutating state.
    The ``summarize`` method also acquires the lock to produce a
    consistent snapshot.

    Attributes
    ----------
    latency_samples:
        Wall-clock latency of every HTTP request recorded by this process (ms).
    error_count:
        Count of HTTP responses that were not considered successful.
    success_count:
        Count of HTTP responses that were considered successful.
    report_save_successes:
        Number of ``GET /api/reports/…`` calls that returned a non-empty report body.
    report_save_failures:
        Number of ``GET /api/reports/…`` calls that returned 4xx/5xx or empty body.
    mongo_latency_samples:
        Latency samples from the direct pymongo probe task (ms).
    queue_wait_samples:
        Queue-wait times extracted from trigger-response payloads (ms).
    ws_connections:
        Total WebSocket connection attempts registered externally.
    ws_success:
        Successful WebSocket connections.
    ws_failures:
        Failed WebSocket connections.
    ws_messages_received:
        Total messages received across all WebSocket connections.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        # Core HTTP tracking
        self.latency_samples: List[float] = []
        self.error_count: int = 0
        self.success_count: int = 0
        # Report tracking
        self.report_save_successes: int = 0
        self.report_save_failures: int = 0
        # MongoDB probe tracking
        self.mongo_latency_samples: List[float] = []
        # Queue tracking
        self.queue_wait_samples: List[float] = []
        # WebSocket tracking (populated externally by ws load test)
        self.ws_connections: int = 0
        self.ws_success: int = 0
        self.ws_failures: int = 0
        self.ws_messages_received: int = 0

    # ------------------------------------------------------------------
    # Mutators (all thread-safe)
    # ------------------------------------------------------------------

    def record_latency(self, ms: float) -> None:
        """Append a raw request latency sample (milliseconds)."""
        with self._lock:
            self.latency_samples.append(ms)

    def record_error(self) -> None:
        """Increment the failed-request counter."""
        with self._lock:
            self.error_count += 1

    def record_success(self) -> None:
        """Increment the successful-request counter."""
        with self._lock:
            self.success_count += 1

    def record_report_save(self, *, success: bool) -> None:
        """Track whether a report-retrieval call returned a valid body."""
        with self._lock:
            if success:
                self.report_save_successes += 1
            else:
                self.report_save_failures += 1

    def record_mongo_latency(self, ms: float) -> None:
        """Append a raw MongoDB round-trip latency sample (milliseconds)."""
        with self._lock:
            self.mongo_latency_samples.append(ms)

    def record_queue_wait(self, ms: float) -> None:
        """Append an observed queue-wait duration (milliseconds)."""
        with self._lock:
            self.queue_wait_samples.append(ms)

    def record_ws_attempt(self) -> None:
        """Register one WebSocket connection attempt."""
        with self._lock:
            self.ws_connections += 1

    def record_ws_success(self) -> None:
        """Register one successful WebSocket connection."""
        with self._lock:
            self.ws_success += 1

    def record_ws_failure(self) -> None:
        """Register one failed WebSocket connection."""
        with self._lock:
            self.ws_failures += 1

    def record_ws_message(self) -> None:
        """Register one WebSocket message received."""
        with self._lock:
            self.ws_messages_received += 1

    # ------------------------------------------------------------------
    # Aggregation
    # ------------------------------------------------------------------

    @staticmethod
    def _pct(samples: List[float], p: float) -> float:
        """Return the p-th percentile from a list of samples."""
        if not samples:
            return 0.0
        s = sorted(samples)
        idx = max(0, min(int(len(s) * p / 100), len(s) - 1))
        return s[idx]

    @staticmethod
    def _avg(samples: List[float]) -> float:
        return sum(samples) / len(samples) if samples else 0.0

    def summarize(self) -> Dict[str, Any]:
        """Return a JSON-serialisable summary snapshot of all metrics."""
        with self._lock:
            lats = list(self.latency_samples)
            mongo_lats = list(self.mongo_latency_samples)
            queue_waits = list(self.queue_wait_samples)
            err = self.error_count
            ok = self.success_count
            rs_ok = self.report_save_successes
            rs_fail = self.report_save_failures
            ws_total = self.ws_connections
            ws_ok = self.ws_success
            ws_fail = self.ws_failures
            ws_msgs = self.ws_messages_received

        total = ok + err
        return {
            # HTTP aggregate
            "total_requests": total,
            "success_count": ok,
            "error_count": err,
            "error_rate": round(err / max(1, total), 4),
            # HTTP latency
            "avg_latency_ms": round(self._avg(lats), 2),
            "p50_latency_ms": round(self._pct(lats, 50), 2),
            "p95_latency_ms": round(self._pct(lats, 95), 2),
            "p99_latency_ms": round(self._pct(lats, 99), 2),
            "max_latency_ms": round(max(lats, default=0.0), 2),
            # Report persistence
            "report_save_successes": rs_ok,
            "report_save_failures": rs_fail,
            "report_save_success_rate": round(rs_ok / max(1, rs_ok + rs_fail), 4),
            # MongoDB direct probe
            "mongo_avg_latency_ms": round(self._avg(mongo_lats), 2),
            "mongo_p95_latency_ms": round(self._pct(mongo_lats, 95), 2),
            "mongo_samples_count": len(mongo_lats),
            # Queue
            "avg_queue_wait_ms": round(self._avg(queue_waits), 2),
            "p95_queue_wait_ms": round(self._pct(queue_waits, 95), 2),
            # WebSocket
            "ws_total_connections": ws_total,
            "ws_successful_connections": ws_ok,
            "ws_failed_connections": ws_fail,
            "ws_messages_received": ws_msgs,
        }


# ---------------------------------------------------------------------------
# Module-level shared state
# ---------------------------------------------------------------------------
_METRICS: LoadTestMetrics = LoadTestMetrics()
_TEST_START_TIME: float = time.time()
_WRITE_LOCK: threading.Lock = threading.Lock()

# ---------------------------------------------------------------------------
# Resource / helper utilities
# ---------------------------------------------------------------------------


def _get_system_resources() -> Dict[str, float]:
    """Collect CPU, memory, and optional GPU utilisation.

    GPU is probed via ``nvidia-smi``; returns 0.0 gracefully when the
    binary is not present or returns non-zero.

    Returns
    -------
    dict with keys ``cpu_usage_percent``, ``memory_usage_mb``,
    ``gpu_usage_percent``.
    """
    cpu_pct: float = 0.0
    mem_mb: float = 0.0
    gpu_pct: float = 0.0

    if _PSUTIL_AVAILABLE:
        try:
            cpu_pct = psutil.cpu_percent(interval=0.2)
            mem_info = psutil.virtual_memory()
            mem_mb = mem_info.used / (1024.0 * 1024.0)
        except Exception:  # pragma: no cover
            pass

    try:
        proc = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=utilization.gpu",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if proc.returncode == 0:
            values: List[float] = []
            for line in proc.stdout.strip().splitlines():
                stripped = line.strip()
                try:
                    values.append(float(stripped))
                except ValueError:
                    pass
            if values:
                gpu_pct = sum(values) / len(values)
    except Exception:  # pragma: no cover
        gpu_pct = 0.0

    return {
        "cpu_usage_percent": round(cpu_pct, 2),
        "memory_usage_mb": round(mem_mb, 2),
        "gpu_usage_percent": round(gpu_pct, 2),
    }


def _probe_mongo_latency(interview_id: str) -> float:
    """Execute a direct MongoDB ``find_one`` and return round-trip time in ms.

    Parameters
    ----------
    interview_id:
        The document key to look up in ``video_analysis_jobs``.

    Returns
    -------
    Latency in milliseconds, or ``0.0`` when pymongo is unavailable or the
    probe raises an exception.
    """
    if not _PYMONGO_AVAILABLE:
        return 0.0

    client = None
    try:
        client = MongoClient(
            MONGO_URL,
            serverSelectionTimeoutMS=3_000,
            socketTimeoutMS=3_000,
            connectTimeoutMS=3_000,
        )
        col = client[MONGO_DB_NAME]["video_analysis_jobs"]
        t0 = time.perf_counter()
        col.find_one({"interviewId": interview_id}, {"_id": 0, "status": 1})
        return (time.perf_counter() - t0) * 1_000
    except Exception as exc:  # pragma: no cover
        _LOG.debug("MongoDB probe failed for %s: %s", interview_id, exc)
        return 0.0
    finally:
        if client is not None:
            try:
                client.close()
            except Exception:
                pass


def _seed_mongo_doc(interview_id: str) -> None:
    """Upsert a minimal ``video_analysis_jobs`` document so polling finds data.

    This is a best-effort operation; failures are logged at DEBUG level and
    silently ignored so a MongoDB outage does not prevent the load test from
    running.

    Parameters
    ----------
    interview_id:
        The ``interviewId`` field of the document to upsert.
    """
    if not _PYMONGO_AVAILABLE:
        return

    client = None
    try:
        client = MongoClient(
            MONGO_URL,
            serverSelectionTimeoutMS=3_000,
            socketTimeoutMS=3_000,
        )
        col = client[MONGO_DB_NAME]["video_analysis_jobs"]
        col.update_one(
            {"interviewId": interview_id},
            {
                "$setOnInsert": {
                    "interviewId": interview_id,
                    "status": "pending",
                    "currentStep": "seeded_by_load_test",
                    "updatedAt": datetime.now(timezone.utc),
                    "finishedAt": None,
                    "error": None,
                }
            },
            upsert=True,
        )
    except Exception as exc:  # pragma: no cover
        _LOG.debug("MongoDB seed failed for %s: %s", interview_id, exc)
    finally:
        if client is not None:
            try:
                client.close()
            except Exception:
                pass


def _persist_results(concurrent_users: Optional[int] = None) -> None:
    """Write or merge accumulated metrics into ``tests/results/load_test_report.json``.

    Uses a module-level lock so concurrent ``on_stop`` callbacks from many
    users do not corrupt the file.  The function is idempotent — repeated
    calls update the same ``"locust"`` scenario entry rather than appending.

    Parameters
    ----------
    concurrent_users:
        The ``--users`` value from the Locust runner; ``None`` when not
        determinable (e.g. interactive mode or import-time call).
    """
    with _WRITE_LOCK:
        RESULTS_DIR.mkdir(parents=True, exist_ok=True)

        metrics = _METRICS.summarize()
        resources = _get_system_resources()

        # ------------------------------------------------------------------
        # Load any existing report so we can merge scenarios
        # ------------------------------------------------------------------
        existing: Dict[str, Any] = {}
        if RESULTS_FILE.exists():
            try:
                with RESULTS_FILE.open("r", encoding="utf-8") as fh:
                    existing = json.load(fh)
            except Exception:
                existing = {}

        scenarios: List[Dict[str, Any]] = existing.get("scenarios", [])

        locust_scenario: Dict[str, Any] = {
            "scenario": "locust",
            "concurrent_users": concurrent_users,
            "duration_seconds": round(time.time() - _TEST_START_TIME, 1),
            "metrics": metrics,
            "resources": resources,
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }

        # Replace existing locust entry, or append
        replaced = False
        for idx, entry in enumerate(scenarios):
            if entry.get("scenario") == "locust":
                scenarios[idx] = locust_scenario
                replaced = True
                break
        if not replaced:
            scenarios.append(locust_scenario)

        # Overall pass/fail: error rate <= 5 %
        total_req = metrics.get("total_requests", 0)
        err_count = metrics.get("error_count", 0)
        passed: bool = total_req == 0 or (err_count / max(1, total_req)) <= 0.05

        report: Dict[str, Any] = {
            "suite": "load_test",
            "scenarios": scenarios,
            "metrics": metrics,
            "resources": resources,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "pass": passed,
        }

        try:
            with RESULTS_FILE.open("w", encoding="utf-8") as fh:
                json.dump(report, fh, indent=2)
            _LOG.info(
                "[load_test] Report written → %s  (pass=%s)", RESULTS_FILE, passed
            )
        except Exception as exc:  # pragma: no cover
            _LOG.error("[load_test] Failed to write report: %s", exc)


# ---------------------------------------------------------------------------
# Locust Virtual User
# ---------------------------------------------------------------------------


class InterviewLoadUser(HttpUser):
    """Simulates a single concurrent user of the AI recruiter analysis service.

    Task mix
    --------
    +------------------------------+--------+----------------------------------+
    | Task                         | Weight | Purpose                          |
    +==============================+========+==================================+
    | health_check                 | 1      | Baseline liveness probe          |
    | trigger_interview_analysis   | 1      | Submit / re-trigger analysis job |
    | poll_job_status              | 5      | Frequent polling (most common)   |
    | fetch_report                 | 3      | Report retrieval latency         |
    | probe_mongo_direct           | 1      | Raw DB latency measurement       |
    +------------------------------+--------+----------------------------------+

    Wait time: 1–3 s between tasks (simulates realistic client pacing).

    Attributes
    ----------
    host:
        Target host URL; overridden by ``--host`` CLI argument.
    wait_time:
        Locust wait-time callable returning a random delay in [1, 3] seconds.
    """

    host: str = ANALYSIS_SERVICE_HOST
    wait_time = between(1, 3)  # type: ignore[assignment]

    # Instance-level; set in on_start
    _user_interview_id: str = ""

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def on_start(self) -> None:
        """Seed a dedicated MongoDB document for this virtual user.

        Picks one interview ID from the 200-ID pool so that multiple virtual
        users exercise different documents concurrently.  The document is
        upserted (not inserted) so re-runs of the same load test remain safe.
        """
        self._user_interview_id = random.choice(INTERVIEW_ID_POOL)
        _seed_mongo_doc(self._user_interview_id)
        _LOG.debug("[user] Started — interview_id=%s", self._user_interview_id)

    def on_stop(self) -> None:
        """Persist accumulated metrics when this virtual user stops.

        Because many users may call this simultaneously, ``_persist_results``
        uses a file-write lock internally to prevent corruption.
        """
        _persist_results()

    # ------------------------------------------------------------------
    # Tasks
    # ------------------------------------------------------------------

    @task(1)
    def health_check(self) -> None:
        """GET /health — baseline liveness probe (weight=1).

        Expected: HTTP 200 with ``{"ok": true}`` payload.
        Records latency on success; marks failure on non-200 response.
        """
        t0 = time.perf_counter()
        try:
            with self.client.get(
                "/health", name="/health", catch_response=True
            ) as resp:
                elapsed_ms = (time.perf_counter() - t0) * 1_000
                if resp.status_code == 200:
                    _METRICS.record_success()
                    _METRICS.record_latency(elapsed_ms)
                else:
                    resp.failure(f"Unexpected status {resp.status_code}")
                    _METRICS.record_error()
        except Exception as exc:  # pragma: no cover
            _METRICS.record_error()
            _LOG.warning("[health_check] Exception: %s", exc)

    @task(1)
    def trigger_interview_analysis(self) -> None:
        """POST /api/analyze/{interview_id} — submit an analysis job (weight=1).

        Picks a *random* ID from the 200-ID pool on every invocation to
        distribute write load across the collection rather than hammering a
        single document.  HTTP 409 (already running) is treated as a success
        because it signals correct idempotency behaviour.

        If the response payload contains a ``queueWaitMs`` field it is
        recorded in the queue-wait histogram.
        """
        interview_id = random.choice(INTERVIEW_ID_POOL)
        url = f"/api/analyze/{interview_id}"
        t0 = time.perf_counter()
        try:
            with self.client.post(
                url,
                json={"force": False},
                name="/api/analyze/[id]",
                catch_response=True,
            ) as resp:
                elapsed_ms = (time.perf_counter() - t0) * 1_000
                _METRICS.record_latency(elapsed_ms)

                if resp.status_code in (200, 202, 409):
                    # 409 = already running — correct idempotency, not a failure
                    _METRICS.record_success()
                    try:
                        body = resp.json()
                        if isinstance(body, dict) and "queueWaitMs" in body:
                            _METRICS.record_queue_wait(float(body["queueWaitMs"]))
                    except Exception:
                        pass
                else:
                    resp.failure(f"trigger_interview_analysis: HTTP {resp.status_code}")
                    _METRICS.record_error()
        except Exception as exc:  # pragma: no cover
            _METRICS.record_error()
            _LOG.warning("[trigger_interview_analysis] Exception: %s", exc)

    @task(5)
    def poll_job_status(self) -> None:
        """GET /api/jobs/{interview_id} — job-status polling latency (weight=5).

        High weight mirrors real-world behaviour: clients poll frequently to
        track pipeline progress.  HTTP 404 is treated as a valid response
        (the job may not have been created yet in this ID pool slot).
        """
        interview_id = random.choice(INTERVIEW_ID_POOL)
        url = f"/api/jobs/{interview_id}"
        t0 = time.perf_counter()
        try:
            with self.client.get(
                url, name="/api/jobs/[id]", catch_response=True
            ) as resp:
                elapsed_ms = (time.perf_counter() - t0) * 1_000
                _METRICS.record_latency(elapsed_ms)

                if resp.status_code in (200, 404):
                    _METRICS.record_success()
                else:
                    resp.failure(f"poll_job_status: HTTP {resp.status_code}")
                    _METRICS.record_error()
        except Exception as exc:  # pragma: no cover
            _METRICS.record_error()
            _LOG.warning("[poll_job_status] Exception: %s", exc)

    @task(3)
    def fetch_report(self) -> None:
        """GET /api/reports/{interview_id} — report retrieval latency (weight=3).

        Measures the full MongoDB read path for persisted analysis reports.
        A 200 response with a non-empty ``report`` / ``data`` key increments
        ``report_save_successes``; any other outcome increments
        ``report_save_failures``.
        """
        interview_id = random.choice(INTERVIEW_ID_POOL)
        url = f"/api/reports/{interview_id}"
        t0 = time.perf_counter()
        try:
            with self.client.get(
                url, name="/api/reports/[id]", catch_response=True
            ) as resp:
                elapsed_ms = (time.perf_counter() - t0) * 1_000
                _METRICS.record_latency(elapsed_ms)

                if resp.status_code == 200:
                    _METRICS.record_success()
                    try:
                        body = resp.json()
                        has_report = bool(body.get("report") or body.get("data"))
                        _METRICS.record_report_save(success=has_report)
                    except Exception:
                        _METRICS.record_report_save(success=False)
                elif resp.status_code == 404:
                    # Not yet generated — polling 404 is a valid outcome
                    _METRICS.record_success()
                else:
                    resp.failure(f"fetch_report: HTTP {resp.status_code}")
                    _METRICS.record_error()
                    _METRICS.record_report_save(success=False)
        except Exception as exc:  # pragma: no cover
            _METRICS.record_error()
            _METRICS.record_report_save(success=False)
            _LOG.warning("[fetch_report] Exception: %s", exc)

    @task(1)
    def probe_mongo_direct(self) -> None:
        """Direct pymongo latency probe — measures raw DB speed (weight=1).

        Bypasses the FastAPI layer entirely so the resulting sample reflects
        pure MongoDB round-trip time, independent of application/network
        overhead.  Nothing is recorded when pymongo is unavailable.
        """
        interview_id = random.choice(INTERVIEW_ID_POOL)
        ms = _probe_mongo_latency(interview_id)
        if ms > 0.0:
            _METRICS.record_mongo_latency(ms)


# ---------------------------------------------------------------------------
# Locust event hooks
# ---------------------------------------------------------------------------

if _LOCUST_AVAILABLE:

    @events.quitting.add_listener  # type: ignore[attr-defined]
    def _on_locust_quit(environment, **kwargs) -> None:  # type: ignore[misc]
        """Finalise and persist the report when the Locust master process quits.

        ``environment.runner.target_user_count`` carries the ``--users`` value
        passed on the CLI, which is embedded in the scenario entry so the JSON
        report can distinguish the 10/50/100-user runs.
        """
        target_users: Optional[int] = None
        try:
            target_users = environment.runner.target_user_count
        except Exception:
            pass

        _persist_results(concurrent_users=target_users)
        print(
            f"\n[load_test] Report finalised → {RESULTS_FILE}  "
            f"(concurrent_users={target_users})"
        )
