"""Performance Baseline Profiler — Phase 4.5

Collects comprehensive performance baseline metrics:
- Average report latency
- p50, p95, p99 latencies
- MongoDB write/read latency
- Replay evaluation latency
- WebSocket latency
- RAM usage (avg, peak)
- CPU usage (avg, peak)
- GPU usage (avg, peak) if available
- Queue processing latency

This baseline helps identify performance regressions and set SLA targets.
"""

import json
import logging
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import psutil
from pymongo import MongoClient

logging.basicConfig(level=logging.INFO)
_LOG = logging.getLogger(__name__)

# ─── Configuration ────────────────────────────────────────────────────────────

MONGO_URL = os.getenv("MONGO_URL", "mongodb://localhost:27017")
MONGO_DB = os.getenv("MONGO_DB_NAME", "ai_recruiter_dev")

# ANSI color codes
GREEN = "\033[92m"
RED = "\033[91m"
YELLOW = "\033[93m"
BLUE = "\033[94m"
CYAN = "\033[96m"
RESET = "\033[0m"

# Lookback period for profiling (days)
LOOKBACK_DAYS = 7

# ─── Performance Profiler ─────────────────────────────────────────────────────


class PerformanceProfiler:
    """Collect performance baseline metrics."""

    def __init__(self):
        self.client = MongoClient(MONGO_URL)
        self.db = self.client[MONGO_DB]

        self.audit_logs_col = self.db["interview_audit_logs"]
        self.reports_col = self.db["interview_final_reports"]
        self.jobs_col = self.db["video_analysis_jobs"]
        self.replay_results_col = self.db["replay_evaluation_results"]
        self.realtime_sessions_col = self.db["realtime_sessions"]

        self.results = {
            "timestamp": None,
            "lookback_days": LOOKBACK_DAYS,
            "report_latency": {},
            "mongodb_performance": {},
            "replay_latency": {},
            "websocket_latency": {},
            "queue_latency": {},
            "system_resources": {},
            "summary": {
                "avg_report_latency_ms": 0,
                "p95_report_latency_ms": 0,
                "p99_report_latency_ms": 0,
                "mongodb_write_avg_ms": 0,
                "mongodb_read_avg_ms": 0,
                "avg_cpu_percent": 0,
                "peak_cpu_percent": 0,
                "avg_ram_mb": 0,
                "peak_ram_mb": 0,
            },
        }

    def _utc_now(self) -> datetime:
        """Get current UTC time."""
        return datetime.now(timezone.utc)

    def _get_percentile(self, values: List[float], percentile: float) -> float:
        """Calculate percentile from a list of values."""
        if not values:
            return 0.0
        sorted_values = sorted(values)
        index = int(len(sorted_values) * percentile / 100)
        return sorted_values[min(index, len(sorted_values) - 1)]

    def profile_report_latency(self) -> Dict[str, Any]:
        """Profile end-to-end report generation latency."""
        _LOG.info("[Profiler] Analyzing report generation latency...")

        cutoff = self._utc_now() - timedelta(days=LOOKBACK_DAYS)

        try:
            # Get pipeline events from audit logs
            pipeline = [
                {
                    "$match": {
                        "eventType": "pipeline_phase",
                        "timestamp": {"$gte": cutoff},
                    }
                },
                {
                    "$group": {
                        "_id": "$interviewId",
                        "startTime": {"$min": "$timestamp"},
                        "endTime": {"$max": "$timestamp"},
                    }
                },
                {
                    "$project": {
                        "interviewId": "$_id",
                        "latencyMs": {
                            "$subtract": [
                                {"$toLong": "$endTime"},
                                {"$toLong": "$startTime"},
                            ]
                        },
                    }
                },
            ]

            latency_docs = list(self.audit_logs_col.aggregate(pipeline))

            if not latency_docs:
                _LOG.warning("No pipeline events found in audit logs")
                return {"success": False, "error": "No pipeline events found"}

            latencies = [
                doc["latencyMs"] for doc in latency_docs if doc.get("latencyMs")
            ]

            if not latencies:
                return {"success": False, "error": "No valid latency measurements"}

            # Calculate statistics
            avg_latency = sum(latencies) / len(latencies)
            min_latency = min(latencies)
            max_latency = max(latencies)
            p50 = self._get_percentile(latencies, 50)
            p95 = self._get_percentile(latencies, 95)
            p99 = self._get_percentile(latencies, 99)

            result = {
                "total_reports": len(latencies),
                "avg_ms": round(avg_latency, 2),
                "min_ms": round(min_latency, 2),
                "max_ms": round(max_latency, 2),
                "p50_ms": round(p50, 2),
                "p95_ms": round(p95, 2),
                "p99_ms": round(p99, 2),
                "latency_distribution": {
                    "under_1s": sum(1 for l in latencies if l < 1000),
                    "1s_to_5s": sum(1 for l in latencies if 1000 <= l < 5000),
                    "5s_to_10s": sum(1 for l in latencies if 5000 <= l < 10000),
                    "over_10s": sum(1 for l in latencies if l >= 10000),
                },
            }

            self.results["report_latency"] = result
            self.results["summary"]["avg_report_latency_ms"] = result["avg_ms"]
            self.results["summary"]["p95_report_latency_ms"] = result["p95_ms"]
            self.results["summary"]["p99_report_latency_ms"] = result["p99_ms"]

            _LOG.info(
                f"{GREEN}✓{RESET} Report latency: avg={result['avg_ms']:.0f}ms, p95={result['p95_ms']:.0f}ms, p99={result['p99_ms']:.0f}ms"
            )

            return result

        except Exception as exc:
            _LOG.error(f"[Profiler] Report latency profiling failed: {exc}")
            return {"success": False, "error": str(exc)}

    def profile_mongodb_performance(self) -> Dict[str, Any]:
        """Profile MongoDB read and write performance."""
        _LOG.info("[Profiler] Profiling MongoDB performance...")

        write_latencies = []
        read_latencies = []
        test_iterations = 10

        try:
            # Test write performance
            test_collection = self.db["_performance_test"]

            for i in range(test_iterations):
                start = time.perf_counter()
                test_collection.insert_one(
                    {"test_id": i, "timestamp": self._utc_now(), "data": "x" * 1000}
                )
                write_latency = (time.perf_counter() - start) * 1000  # ms
                write_latencies.append(write_latency)

            # Test read performance
            for i in range(test_iterations):
                start = time.perf_counter()
                test_collection.find_one({"test_id": i})
                read_latency = (time.perf_counter() - start) * 1000  # ms
                read_latencies.append(read_latency)

            # Cleanup
            test_collection.drop()

            # Calculate statistics
            result = {
                "write_performance": {
                    "avg_ms": round(sum(write_latencies) / len(write_latencies), 3),
                    "min_ms": round(min(write_latencies), 3),
                    "max_ms": round(max(write_latencies), 3),
                    "p95_ms": round(self._get_percentile(write_latencies, 95), 3),
                },
                "read_performance": {
                    "avg_ms": round(sum(read_latencies) / len(read_latencies), 3),
                    "min_ms": round(min(read_latencies), 3),
                    "max_ms": round(max(read_latencies), 3),
                    "p95_ms": round(self._get_percentile(read_latencies, 95), 3),
                },
                "test_iterations": test_iterations,
            }

            self.results["mongodb_performance"] = result
            self.results["summary"]["mongodb_write_avg_ms"] = result[
                "write_performance"
            ]["avg_ms"]
            self.results["summary"]["mongodb_read_avg_ms"] = result["read_performance"][
                "avg_ms"
            ]

            _LOG.info(
                f"{GREEN}✓{RESET} MongoDB: write={result['write_performance']['avg_ms']:.2f}ms, read={result['read_performance']['avg_ms']:.2f}ms"
            )

            return result

        except Exception as exc:
            _LOG.error(f"[Profiler] MongoDB profiling failed: {exc}")
            return {"success": False, "error": str(exc)}

    def profile_replay_latency(self) -> Dict[str, Any]:
        """Profile replay evaluation latency."""
        _LOG.info("[Profiler] Analyzing replay evaluation latency...")

        cutoff = self._utc_now() - timedelta(days=LOOKBACK_DAYS)

        try:
            replay_results = list(
                self.replay_results_col.find(
                    {"evaluatedAt": {"$gte": cutoff}},
                    {
                        "_id": 0,
                        "interviewId": 1,
                        "evaluationTimeMs": 1,
                        "evaluatedAt": 1,
                    },
                )
            )

            if not replay_results:
                _LOG.warning("No replay evaluations found")
                return {"success": False, "error": "No replay data"}

            latencies = [
                r.get("evaluationTimeMs", 0)
                for r in replay_results
                if r.get("evaluationTimeMs")
            ]

            if not latencies:
                return {"success": False, "error": "No latency data in replay results"}

            result = {
                "total_replays": len(replay_results),
                "avg_ms": round(sum(latencies) / len(latencies), 2),
                "min_ms": round(min(latencies), 2),
                "max_ms": round(max(latencies), 2),
                "p50_ms": round(self._get_percentile(latencies, 50), 2),
                "p95_ms": round(self._get_percentile(latencies, 95), 2),
                "p99_ms": round(self._get_percentile(latencies, 99), 2),
            }

            self.results["replay_latency"] = result

            _LOG.info(
                f"{GREEN}✓{RESET} Replay latency: avg={result['avg_ms']:.0f}ms, p95={result['p95_ms']:.0f}ms"
            )

            return result

        except Exception as exc:
            _LOG.error(f"[Profiler] Replay latency profiling failed: {exc}")
            return {"success": False, "error": str(exc)}

    def profile_websocket_latency(self) -> Dict[str, Any]:
        """Profile WebSocket message latency."""
        _LOG.info("[Profiler] Analyzing WebSocket latency...")

        cutoff = self._utc_now() - timedelta(days=LOOKBACK_DAYS)

        try:
            # Get realtime session events
            sessions = list(
                self.realtime_sessions_col.find(
                    {"lastActivity": {"$gte": cutoff}},
                    {
                        "_id": 0,
                        "sessionId": 1,
                        "messageLatencies": 1,
                        "avgLatencyMs": 1,
                    },
                )
            )

            if not sessions:
                _LOG.warning("No WebSocket sessions found")
                return {"success": False, "error": "No WebSocket data"}

            # Collect all latencies
            all_latencies = []
            for session in sessions:
                latencies = session.get("messageLatencies", [])
                if latencies:
                    all_latencies.extend(latencies)
                elif session.get("avgLatencyMs"):
                    all_latencies.append(session["avgLatencyMs"])

            if not all_latencies:
                return {"success": False, "error": "No WebSocket latency data"}

            result = {
                "total_sessions": len(sessions),
                "total_messages": len(all_latencies),
                "avg_ms": round(sum(all_latencies) / len(all_latencies), 2),
                "min_ms": round(min(all_latencies), 2),
                "max_ms": round(max(all_latencies), 2),
                "p50_ms": round(self._get_percentile(all_latencies, 50), 2),
                "p95_ms": round(self._get_percentile(all_latencies, 95), 2),
                "p99_ms": round(self._get_percentile(all_latencies, 99), 2),
            }

            self.results["websocket_latency"] = result

            _LOG.info(
                f"{GREEN}✓{RESET} WebSocket latency: avg={result['avg_ms']:.0f}ms, p95={result['p95_ms']:.0f}ms"
            )

            return result

        except Exception as exc:
            _LOG.error(f"[Profiler] WebSocket latency profiling failed: {exc}")
            return {"success": False, "error": str(exc)}

    def profile_queue_latency(self) -> Dict[str, Any]:
        """Profile job queue processing latency."""
        _LOG.info("[Profiler] Analyzing queue processing latency...")

        cutoff = self._utc_now() - timedelta(days=LOOKBACK_DAYS)

        try:
            # Get jobs with timing data
            jobs = list(
                self.jobs_col.find(
                    {
                        "completedAt": {"$gte": cutoff},
                        "createdAt": {"$exists": True},
                        "startedAt": {"$exists": True},
                        "completedAt": {"$exists": True},
                    },
                    {
                        "_id": 0,
                        "jobId": 1,
                        "createdAt": 1,
                        "startedAt": 1,
                        "completedAt": 1,
                    },
                )
            )

            if not jobs:
                _LOG.warning("No completed jobs with timing data found")
                return {"success": False, "error": "No job timing data"}

            # Calculate queue wait times and processing times
            queue_times = []
            processing_times = []

            for job in jobs:
                created = job.get("createdAt")
                started = job.get("startedAt")
                completed = job.get("completedAt")

                if created and started:
                    queue_ms = (started - created).total_seconds() * 1000
                    queue_times.append(queue_ms)

                if started and completed:
                    processing_ms = (completed - started).total_seconds() * 1000
                    processing_times.append(processing_ms)

            if not queue_times:
                return {"success": False, "error": "No valid queue timing data"}

            result = {
                "total_jobs": len(jobs),
                "queue_wait_time": {
                    "avg_ms": round(sum(queue_times) / len(queue_times), 2)
                    if queue_times
                    else 0,
                    "min_ms": round(min(queue_times), 2) if queue_times else 0,
                    "max_ms": round(max(queue_times), 2) if queue_times else 0,
                    "p95_ms": round(self._get_percentile(queue_times, 95), 2)
                    if queue_times
                    else 0,
                },
                "processing_time": {
                    "avg_ms": round(sum(processing_times) / len(processing_times), 2)
                    if processing_times
                    else 0,
                    "min_ms": round(min(processing_times), 2)
                    if processing_times
                    else 0,
                    "max_ms": round(max(processing_times), 2)
                    if processing_times
                    else 0,
                    "p95_ms": round(self._get_percentile(processing_times, 95), 2)
                    if processing_times
                    else 0,
                },
            }

            self.results["queue_latency"] = result

            _LOG.info(
                f"{GREEN}✓{RESET} Queue: wait={result['queue_wait_time']['avg_ms']:.0f}ms, processing={result['processing_time']['avg_ms']:.0f}ms"
            )

            return result

        except Exception as exc:
            _LOG.error(f"[Profiler] Queue latency profiling failed: {exc}")
            return {"success": False, "error": str(exc)}

    def profile_system_resources(self) -> Dict[str, Any]:
        """Profile system resource usage (CPU, RAM, GPU)."""
        _LOG.info("[Profiler] Profiling system resources...")

        try:
            # Current system metrics
            cpu_percent = psutil.cpu_percent(interval=1)
            cpu_count = psutil.cpu_count()
            memory = psutil.virtual_memory()

            # Get per-core CPU usage
            cpu_per_core = psutil.cpu_percent(interval=1, percpu=True)

            # Process-specific metrics (current Python process)
            process = psutil.Process()
            process_memory = process.memory_info()
            process_cpu = process.cpu_percent(interval=1)

            result = {
                "system": {
                    "cpu_percent": round(cpu_percent, 2),
                    "cpu_count": cpu_count,
                    "cpu_per_core": [round(c, 2) for c in cpu_per_core],
                    "memory_total_mb": round(memory.total / (1024 * 1024), 2),
                    "memory_available_mb": round(memory.available / (1024 * 1024), 2),
                    "memory_used_mb": round(memory.used / (1024 * 1024), 2),
                    "memory_percent": round(memory.percent, 2),
                },
                "process": {
                    "cpu_percent": round(process_cpu, 2),
                    "memory_rss_mb": round(process_memory.rss / (1024 * 1024), 2),
                    "memory_vms_mb": round(process_memory.vms / (1024 * 1024), 2),
                },
            }

            # Try to get GPU info if available
            try:
                import GPUtil

                gpus = GPUtil.getGPUs()
                if gpus:
                    result["gpu"] = [
                        {
                            "id": gpu.id,
                            "name": gpu.name,
                            "load_percent": round(gpu.load * 100, 2),
                            "memory_used_mb": round(gpu.memoryUsed, 2),
                            "memory_total_mb": round(gpu.memoryTotal, 2),
                            "memory_percent": round(
                                (gpu.memoryUsed / gpu.memoryTotal) * 100, 2
                            ),
                            "temperature_c": round(gpu.temperature, 2),
                        }
                        for gpu in gpus
                    ]
                else:
                    result["gpu"] = []
            except ImportError:
                result["gpu"] = "not_available"
                _LOG.info("GPUtil not installed - GPU metrics unavailable")
            except Exception as gpu_exc:
                result["gpu"] = f"error: {str(gpu_exc)}"
                _LOG.warning(f"GPU metrics unavailable: {gpu_exc}")

            self.results["system_resources"] = result
            self.results["summary"]["avg_cpu_percent"] = result["system"]["cpu_percent"]
            self.results["summary"]["peak_cpu_percent"] = max(
                result["system"]["cpu_per_core"]
            )
            self.results["summary"]["avg_ram_mb"] = result["system"]["memory_used_mb"]
            self.results["summary"]["peak_ram_mb"] = result["system"]["memory_total_mb"]

            _LOG.info(
                f"{GREEN}✓{RESET} System: CPU={result['system']['cpu_percent']:.1f}%, RAM={result['system']['memory_percent']:.1f}%"
            )

            return result

        except Exception as exc:
            _LOG.error(f"[Profiler] System resource profiling failed: {exc}")
            return {"success": False, "error": str(exc)}

    def run_all_profilers(self) -> Dict[str, Any]:
        """Run all performance profiling checks."""
        self.results["timestamp"] = self._utc_now().isoformat()

        _LOG.info(f"\n{CYAN}{'=' * 70}{RESET}")
        _LOG.info(f"{CYAN}PERFORMANCE BASELINE PROFILER{RESET}")
        _LOG.info(f"{CYAN}{'=' * 70}{RESET}\n")
        _LOG.info(f"Lookback period: {LOOKBACK_DAYS} days\n")

        # Run profiling checks
        self.profile_report_latency()
        self.profile_mongodb_performance()
        self.profile_replay_latency()
        self.profile_websocket_latency()
        self.profile_queue_latency()
        self.profile_system_resources()

        # Print summary
        summary = self.results["summary"]
        _LOG.info(f"\n{CYAN}{'=' * 70}{RESET}")
        _LOG.info(f"{CYAN}PERFORMANCE BASELINE SUMMARY{RESET}")
        _LOG.info(f"{CYAN}{'=' * 70}{RESET}")

        _LOG.info(f"\n{BLUE}Report Generation:{RESET}")
        _LOG.info(f"  Avg latency:     {summary['avg_report_latency_ms']:.0f} ms")
        _LOG.info(f"  P95 latency:     {summary['p95_report_latency_ms']:.0f} ms")
        _LOG.info(f"  P99 latency:     {summary['p99_report_latency_ms']:.0f} ms")

        _LOG.info(f"\n{BLUE}MongoDB:{RESET}")
        _LOG.info(f"  Write latency:   {summary['mongodb_write_avg_ms']:.2f} ms")
        _LOG.info(f"  Read latency:    {summary['mongodb_read_avg_ms']:.2f} ms")

        _LOG.info(f"\n{BLUE}System Resources:{RESET}")
        _LOG.info(
            f"  CPU usage:       {summary['avg_cpu_percent']:.1f}% (avg), {summary['peak_cpu_percent']:.1f}% (peak)"
        )
        _LOG.info(f"  RAM usage:       {summary['avg_ram_mb']:.0f} MB (current)")

        _LOG.info(f"\n{GREEN}✓ PERFORMANCE BASELINE COLLECTED{RESET}\n")

        return self.results

    def save_report(self, output_path: Optional[str] = None) -> None:
        """Save performance report to JSON file."""
        if output_path is None:
            results_dir = Path(__file__).parent.parent / "results"
            results_dir.mkdir(exist_ok=True)
            output_path = results_dir / "performance_baseline.json"
        else:
            output_path = Path(output_path)
            output_path.parent.mkdir(parents=True, exist_ok=True)

        with open(output_path, "w") as f:
            json.dump(self.results, f, indent=2)

        _LOG.info(f"Report saved to: {output_path}")


# ─── Main ──────────────────────────────────────────────────────────────────────


def main():
    """Run performance profiling and save report."""
    try:
        profiler = PerformanceProfiler()
        profiler.run_all_profilers()
        profiler.save_report()
    except ImportError as e:
        _LOG.error(f"{RED}Missing dependencies: {e}{RESET}")
        _LOG.error("Install with: pip install psutil")
        _LOG.info("Optional GPU monitoring: pip install gputil")


if __name__ == "__main__":
    main()
