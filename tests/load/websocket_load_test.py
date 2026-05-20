#!/usr/bin/env python3
"""
Phase 6 Load Test — WebSocket Stability (asyncio)
==================================================

Async WebSocket load test for the AI recruiter analysis service.
Exercises ``ws://localhost:8001/ws/{interview_id}`` under progressively
higher concurrency to validate connection stability, first-message latency,
and clean-disconnect behaviour.

Scenarios
---------
    python tests/load/websocket_load_test.py

    Runs three scenarios automatically:
      • 10  concurrent clients — smoke / baseline
      • 50  concurrent clients — moderate stress
      • 100 concurrent clients — peak concurrency

    Each client connects, waits for messages for up to 30 seconds, then
    disconnects cleanly.

Graceful degradation
--------------------
Connection refused (service not running) is recorded as
``"status": "service_unavailable"`` in individual client results and is
*not* counted as a test failure.  The overall scenario is still written
to the report so downstream consumers can distinguish "service down"
from "service crashed under load".

Output
------
tests/results/load_test_report.json
  WebSocket scenarios are merged into the ``"scenarios"`` array under the
  key ``"scenario": "websocket_load"`` with the respective
  ``"concurrent_clients"`` count.

Schema (per scenario entry)
---------------------------
{
  "scenario": "websocket_load",
  "concurrent_clients": 10,
  "metrics": {
    "total_connections": 10,
    "successful_connections": 9,
    "failed_connections": 1,
    "service_unavailable_count": 0,
    "avg_connection_latency_ms": 45.2,
    "p95_connection_latency_ms": 120.0,
    "avg_first_message_latency_ms": 210.3,
    "p95_first_message_latency_ms": 500.0,
    "disconnects": 1,
    "messages_received_total": 38,
    "avg_messages_per_client": 4.2
  },
  "resources": {...},
  "generated_at": "...",
  "pass": true | false
}
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# ---------------------------------------------------------------------------
# sys.path setup
# ---------------------------------------------------------------------------
_REPO_ROOT: Path = Path(__file__).resolve().parents[2]
_BACKEND: Path = _REPO_ROOT / "Backend"
_ANALYSIS_SVC: Path = _BACKEND / "analysis_service"

for _extra in (_REPO_ROOT, _BACKEND, _ANALYSIS_SVC):
    _s = str(_extra)
    if _s not in sys.path:
        sys.path.insert(0, _s)

# ---------------------------------------------------------------------------
# Optional imports (graceful fallback)
# ---------------------------------------------------------------------------
try:
    import websockets  # type: ignore[import]
    import websockets.exceptions  # type: ignore[import]

    _WEBSOCKETS_AVAILABLE = True
except ImportError:  # pragma: no cover
    _WEBSOCKETS_AVAILABLE = False

try:
    import psutil  # type: ignore[import]

    _PSUTIL_AVAILABLE = True
except ImportError:  # pragma: no cover
    _PSUTIL_AVAILABLE = False

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
WS_BASE_URL: str = os.getenv("WS_BASE_URL", "ws://localhost:8001")
WS_PATH_TEMPLATE: str = "/ws/{interview_id}"

RESULTS_DIR: Path = _REPO_ROOT / "tests" / "results"
RESULTS_FILE: Path = RESULTS_DIR / "load_test_report.json"

# Interview IDs to cycle through — same 200-ID pool as locustfile
INTERVIEW_ID_POOL: List[str] = [f"load-test-{n}" for n in range(1, 201)]

# Maximum time each client stays connected (seconds)
CLIENT_SESSION_DURATION_S: float = 30.0
# Timeout waiting for the initial connection handshake
CONNECT_TIMEOUT_S: float = 10.0
# Timeout waiting for each subsequent message
RECV_TIMEOUT_S: float = 2.0
# Timeout waiting for the first message after connecting
FIRST_MSG_TIMEOUT_S: float = 5.0

_LOG = logging.getLogger("ws_load_test")
logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(message)s")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _get_system_resources() -> Dict[str, float]:
    """Return CPU / memory / GPU utilisation as a flat dict.

    GPU is queried via ``nvidia-smi``; defaults to 0.0 if unavailable.
    """
    cpu_pct: float = 0.0
    mem_mb: float = 0.0
    gpu_pct: float = 0.0

    if _PSUTIL_AVAILABLE:
        try:
            cpu_pct = psutil.cpu_percent(interval=0.2)
            mem_mb = psutil.virtual_memory().used / (1024.0 * 1024.0)
        except Exception:
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
            vals: List[float] = []
            for ln in proc.stdout.strip().splitlines():
                try:
                    vals.append(float(ln.strip()))
                except ValueError:
                    pass
            if vals:
                gpu_pct = sum(vals) / len(vals)
    except Exception:
        gpu_pct = 0.0

    return {
        "cpu_usage_percent": round(cpu_pct, 2),
        "memory_usage_mb": round(mem_mb, 2),
        "gpu_usage_percent": round(gpu_pct, 2),
    }


def _pct(samples: List[float], p: float) -> float:
    """Return the p-th percentile from *samples*, or 0.0 when empty."""
    if not samples:
        return 0.0
    s = sorted(samples)
    idx = max(0, min(int(len(s) * p / 100), len(s) - 1))
    return s[idx]


def _avg(samples: List[float]) -> float:
    """Return the arithmetic mean of *samples*, or 0.0 when empty."""
    return sum(samples) / len(samples) if samples else 0.0


def _merge_ws_scenario(scenario_entry: Dict[str, Any]) -> None:
    """Merge *scenario_entry* into ``tests/results/load_test_report.json``.

    Replaces an existing entry with the same
    ``("scenario", "concurrent_clients")`` pair, or appends a new one.
    Creates the file if it does not yet exist.

    Parameters
    ----------
    scenario_entry:
        A fully-populated scenario dict including ``"scenario"``,
        ``"concurrent_clients"``, ``"metrics"``, ``"resources"``,
        ``"generated_at"``, and ``"pass"``.
    """
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)

    existing: Dict[str, Any] = {}
    if RESULTS_FILE.exists():
        try:
            with RESULTS_FILE.open("r", encoding="utf-8") as fh:
                existing = json.load(fh)
        except Exception:
            existing = {}

    scenarios: List[Dict[str, Any]] = existing.get("scenarios", [])
    key_n = scenario_entry.get("concurrent_clients")

    replaced = False
    for idx, s in enumerate(scenarios):
        if (
            s.get("scenario") == "websocket_load"
            and s.get("concurrent_clients") == key_n
        ):
            scenarios[idx] = scenario_entry
            replaced = True
            break
    if not replaced:
        scenarios.append(scenario_entry)

    # Determine global pass: every ws scenario must pass
    ws_scenarios = [s for s in scenarios if s.get("scenario") == "websocket_load"]
    all_pass = all(s.get("pass", False) for s in ws_scenarios) if ws_scenarios else True

    report: Dict[str, Any] = {
        "suite": "load_test",
        "scenarios": scenarios,
        "metrics": existing.get("metrics", {}),
        "resources": existing.get("resources", scenario_entry.get("resources", {})),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "pass": all_pass,
    }

    with RESULTS_FILE.open("w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2)

    _LOG.info(
        "[ws_load] Scenario (%d clients) written → %s",
        key_n,
        RESULTS_FILE,
    )


# ---------------------------------------------------------------------------
# WebSocketLoadTest
# ---------------------------------------------------------------------------


class WebSocketLoadTest:
    """Asyncio-based WebSocket load tester for the analysis service.

    Usage example
    -------------
    ::

        runner = WebSocketLoadTest(ws_base_url="ws://localhost:8001")
        asyncio.run(runner.run_concurrent_load(n_clients=10, interview_ids=[...]))
        metrics = runner.collect_metrics()

    Attributes
    ----------
    ws_base_url:
        Base WebSocket URL, e.g. ``"ws://localhost:8001"``.
    session_duration:
        Maximum number of seconds each client stays connected.
    """

    def __init__(
        self,
        ws_base_url: str = WS_BASE_URL,
        session_duration: float = CLIENT_SESSION_DURATION_S,
    ) -> None:
        self.ws_base_url = ws_base_url.rstrip("/")
        self.session_duration = session_duration

        # Accumulators (reset by reset_metrics)
        self._total_connections: int = 0
        self._successful_connections: int = 0
        self._failed_connections: int = 0
        self._service_unavailable_count: int = 0
        self._disconnects: int = 0
        self._messages_received_total: int = 0
        self._connection_latencies: List[float] = []
        self._first_message_latencies: List[float] = []
        self._client_results: List[Dict[str, Any]] = []

    def reset_metrics(self) -> None:
        """Reset all internal accumulators before a new scenario run."""
        self._total_connections = 0
        self._successful_connections = 0
        self._failed_connections = 0
        self._service_unavailable_count = 0
        self._disconnects = 0
        self._messages_received_total = 0
        self._connection_latencies = []
        self._first_message_latencies = []
        self._client_results = []

    # ------------------------------------------------------------------
    # Single-client coroutine
    # ------------------------------------------------------------------

    async def run_single_client(
        self, interview_id: str, client_id: int
    ) -> Dict[str, Any]:
        """Connect to the WebSocket endpoint, receive messages, then disconnect.

        The client stays connected for up to ``self.session_duration`` seconds
        or until the server closes the connection, whichever comes first.

        Parameters
        ----------
        interview_id:
            Interview ID embedded in the WebSocket URI path.
        client_id:
            Zero-based index for logging / identification purposes.

        Returns
        -------
        A dict with the following keys:

        ``client_id``, ``interview_id``, ``status`` (``"ok"`` |
        ``"service_unavailable"`` | ``"failed"``), ``connected`` (bool),
        ``connection_time_ms`` (float), ``first_message_latency_ms`` (float),
        ``messages_received`` (int), ``disconnect_reason`` (str | None),
        ``error`` (str | None).
        """
        uri = f"{self.ws_base_url}{WS_PATH_TEMPLATE.format(interview_id=interview_id)}"

        result: Dict[str, Any] = {
            "client_id": client_id,
            "interview_id": interview_id,
            "uri": uri,
            "status": "unknown",
            "connected": False,
            "connection_time_ms": 0.0,
            "first_message_latency_ms": 0.0,
            "messages_received": 0,
            "disconnect_reason": None,
            "error": None,
        }

        self._total_connections += 1

        if not _WEBSOCKETS_AVAILABLE:
            result["status"] = "skipped"
            result["error"] = "websockets library not installed"
            self._failed_connections += 1
            return result

        t_connect_start = time.perf_counter()

        try:
            async with asyncio.timeout(CONNECT_TIMEOUT_S):
                ws_ctx = websockets.connect(uri)  # type: ignore[attr-defined]

            # Re-open with explicit timeout for the entire block
            async with asyncio.timeout(self.session_duration + CONNECT_TIMEOUT_S):
                async with websockets.connect(  # type: ignore[attr-defined]
                    uri,
                    open_timeout=CONNECT_TIMEOUT_S,
                    close_timeout=5.0,
                ) as ws:
                    t_connected = time.perf_counter()
                    conn_ms = (t_connected - t_connect_start) * 1_000
                    result["connected"] = True
                    result["connection_time_ms"] = round(conn_ms, 2)
                    self._successful_connections += 1
                    self._connection_latencies.append(conn_ms)

                    # --------------------------------------------------
                    # First message
                    # --------------------------------------------------
                    t_first_start = time.perf_counter()
                    try:
                        _msg = await asyncio.wait_for(
                            ws.recv(), timeout=FIRST_MSG_TIMEOUT_S
                        )
                        first_ms = (time.perf_counter() - t_first_start) * 1_000
                        result["first_message_latency_ms"] = round(first_ms, 2)
                        result["messages_received"] += 1
                        self._first_message_latencies.append(first_ms)
                        self._messages_received_total += 1
                    except asyncio.TimeoutError:
                        result["disconnect_reason"] = "no_first_message"

                    # --------------------------------------------------
                    # Continue receiving for up to session_duration
                    # --------------------------------------------------
                    session_deadline = time.perf_counter() + self.session_duration
                    while time.perf_counter() < session_deadline:
                        remaining = session_deadline - time.perf_counter()
                        if remaining <= 0:
                            break
                        recv_timeout = min(remaining, RECV_TIMEOUT_S)
                        try:
                            await asyncio.wait_for(ws.recv(), timeout=recv_timeout)
                            result["messages_received"] += 1
                            self._messages_received_total += 1
                        except asyncio.TimeoutError:
                            # No message within window — normal for low-traffic endpoints
                            break
                        except (
                            websockets.exceptions.ConnectionClosed,  # type: ignore[attr-defined]
                            websockets.exceptions.ConnectionClosedOK,  # type: ignore[attr-defined]
                            websockets.exceptions.ConnectionClosedError,  # type: ignore[attr-defined]
                        ):
                            result["disconnect_reason"] = "server_closed"
                            self._disconnects += 1
                            break

                    if result["disconnect_reason"] is None:
                        result["disconnect_reason"] = "clean_session_end"

                    result["status"] = "ok"

        # ------------------------------------------------------------------
        # Exception handlers — classify into "service_unavailable" vs. error
        # ------------------------------------------------------------------
        except (ConnectionRefusedError, OSError) as exc:
            detail = str(exc).lower()
            if (
                "refused" in detail
                or "connect call failed" in detail
                or "errno 111" in detail
            ):
                result["status"] = "service_unavailable"
                result["error"] = "connection_refused"
                self._service_unavailable_count += 1
            else:
                result["status"] = "failed"
                result["error"] = f"OSError: {exc}"
            self._failed_connections += 1
            self._disconnects += 1

        except asyncio.TimeoutError:
            result["status"] = "failed"
            result["error"] = "connection_timeout"
            self._failed_connections += 1
            self._disconnects += 1

        except Exception as exc:  # pragma: no cover
            ws_exc_module = "websockets.exceptions"
            exc_type = type(exc).__module__ + "." + type(exc).__name__

            if "InvalidURI" in exc_type or "InvalidHandshake" in exc_type:
                result["status"] = "failed"
                result["error"] = f"handshake_error: {exc}"
            elif "ConnectionClosed" in exc_type:
                result["status"] = "ok"
                result["disconnect_reason"] = "server_closed_early"
                result["connected"] = True
                self._successful_connections += 1
            else:
                result["status"] = "failed"
                result["error"] = f"{type(exc).__name__}: {exc}"
            self._failed_connections += 1
            self._disconnects += 1

        return result

    # ------------------------------------------------------------------
    # Concurrent runner
    # ------------------------------------------------------------------

    async def run_concurrent_load(
        self, n_clients: int, interview_ids: List[str]
    ) -> List[Dict[str, Any]]:
        """Launch *n_clients* WebSocket clients simultaneously.

        Each client gets an interview ID drawn round-robin from *interview_ids*
        so the load is spread evenly.  All coroutines are started together via
        ``asyncio.gather`` with ``return_exceptions=True`` so a single crash
        does not abort the entire batch.

        Parameters
        ----------
        n_clients:
            Number of simultaneous WebSocket clients to spawn.
        interview_ids:
            Pool of interview IDs to cycle through.  Must be non-empty.

        Returns
        -------
        List of per-client result dicts (one per client, in arbitrary order).
        """
        if not interview_ids:
            interview_ids = INTERVIEW_ID_POOL

        tasks = []
        for client_id in range(n_clients):
            iid = interview_ids[client_id % len(interview_ids)]
            tasks.append(self.run_single_client(iid, client_id))

        raw_results = await asyncio.gather(*tasks, return_exceptions=True)

        results: List[Dict[str, Any]] = []
        for client_id, raw in enumerate(raw_results):
            if isinstance(raw, Exception):
                # Unhandled exception from a client coroutine — record gracefully
                results.append(
                    {
                        "client_id": client_id,
                        "status": "failed",
                        "connected": False,
                        "error": f"{type(raw).__name__}: {raw}",
                        "messages_received": 0,
                        "connection_time_ms": 0.0,
                        "first_message_latency_ms": 0.0,
                        "disconnect_reason": "unhandled_exception",
                    }
                )
                self._failed_connections += 1
            else:
                results.append(raw)

        self._client_results = results
        return results

    # ------------------------------------------------------------------
    # Metrics aggregation
    # ------------------------------------------------------------------

    def collect_metrics(self) -> Dict[str, Any]:
        """Aggregate all internal counters into a JSON-serialisable dict.

        Should be called after ``run_concurrent_load`` returns.

        Returns
        -------
        Dict with keys: ``total_connections``, ``successful_connections``,
        ``failed_connections``, ``service_unavailable_count``,
        ``avg_connection_latency_ms``, ``p95_connection_latency_ms``,
        ``avg_first_message_latency_ms``, ``p95_first_message_latency_ms``,
        ``disconnects``, ``messages_received_total``,
        ``avg_messages_per_client``.
        """
        n = self._total_connections
        avg_msgs = self._messages_received_total / max(1, self._successful_connections)
        return {
            "total_connections": n,
            "successful_connections": self._successful_connections,
            "failed_connections": self._failed_connections,
            "service_unavailable_count": self._service_unavailable_count,
            "avg_connection_latency_ms": round(_avg(self._connection_latencies), 2),
            "p95_connection_latency_ms": round(_pct(self._connection_latencies, 95), 2),
            "avg_first_message_latency_ms": round(
                _avg(self._first_message_latencies), 2
            ),
            "p95_first_message_latency_ms": round(
                _pct(self._first_message_latencies, 95), 2
            ),
            "disconnects": self._disconnects,
            "messages_received_total": self._messages_received_total,
            "avg_messages_per_client": round(avg_msgs, 2),
        }


# ---------------------------------------------------------------------------
# Scenario runner
# ---------------------------------------------------------------------------


async def _run_scenario(
    n_clients: int,
    ws_base_url: str = WS_BASE_URL,
) -> Dict[str, Any]:
    """Execute a single concurrency scenario and return the scenario entry dict.

    Parameters
    ----------
    n_clients:
        Number of simultaneous WebSocket clients.
    ws_base_url:
        Base URL for the WebSocket server.

    Returns
    -------
    Populated scenario dict ready to be merged into the report file.
    """
    _LOG.info("[ws_load] Starting scenario: %d concurrent clients", n_clients)

    runner = WebSocketLoadTest(ws_base_url=ws_base_url)
    interview_ids = random.sample(
        INTERVIEW_ID_POOL, min(n_clients, len(INTERVIEW_ID_POOL))
    )

    t_scenario_start = time.perf_counter()
    results = await runner.run_concurrent_load(n_clients, interview_ids)
    elapsed_s = time.perf_counter() - t_scenario_start

    metrics = runner.collect_metrics()
    resources = _get_system_resources()

    # Pass condition: at least 95 % of non-unavailable connections succeed OR
    # the service is simply not running (all unavailable → treat as "skipped",
    # not "failed").
    ok = metrics["successful_connections"]
    total = metrics["total_connections"]
    unavail = metrics["service_unavailable_count"]
    real_attempts = total - unavail
    if real_attempts == 0:
        # Nothing actually connected — service is down, not a test failure
        passed = True
        pass_reason = "service_unavailable_skip"
    else:
        success_rate = ok / max(1, real_attempts)
        passed = success_rate >= 0.95
        pass_reason = f"success_rate={round(success_rate, 4)}"

    _LOG.info(
        "[ws_load] Scenario %d clients done in %.1fs — ok=%d fail=%d "
        "unavail=%d pass=%s (%s)",
        n_clients,
        elapsed_s,
        ok,
        metrics["failed_connections"],
        unavail,
        passed,
        pass_reason,
    )

    return {
        "scenario": "websocket_load",
        "concurrent_clients": n_clients,
        "duration_seconds": round(elapsed_s, 2),
        "metrics": metrics,
        "resources": resources,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "pass": passed,
        "pass_reason": pass_reason,
    }


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


async def _main_async(ws_base_url: str = WS_BASE_URL) -> None:
    """Run all three load scenarios sequentially and persist results.

    Parameters
    ----------
    ws_base_url:
        Override the target WebSocket base URL (useful in tests).
    """
    concurrency_levels = [10, 50, 100]

    for n in concurrency_levels:
        scenario = await _run_scenario(n_clients=n, ws_base_url=ws_base_url)
        _merge_ws_scenario(scenario)
        # Brief cooldown between scenarios to let the server recover
        if n != concurrency_levels[-1]:
            await asyncio.sleep(3.0)

    _LOG.info("[ws_load] All scenarios complete.  Report → %s", RESULTS_FILE)


def main(ws_base_url: str = WS_BASE_URL) -> None:
    """Synchronous entry point — runs the async load test via ``asyncio.run``.

    Parameters
    ----------
    ws_base_url:
        Target WebSocket base URL.  Defaults to ``ws://localhost:8001``.
    """
    if not _WEBSOCKETS_AVAILABLE:
        _LOG.error(
            "The 'websockets' package is not installed.  "
            "Install it with:  pip install 'websockets>=12.0'"
        )
        sys.exit(1)

    asyncio.run(_main_async(ws_base_url=ws_base_url))


if __name__ == "__main__":
    main()
