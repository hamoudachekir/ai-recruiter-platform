"""Concurrent interview runner for load testing.

Simulates multiple interviews running in parallel to stress-test:
- Report generation latency
- MongoDB query latency
- Queue wait time
- Pipeline stability
- Resource usage
"""

import asyncio
import json
import logging
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import psutil
import requests
from pymongo import MongoClient

logging.basicConfig(level=logging.INFO)
_LOG = logging.getLogger(__name__)

# ─── Configuration ────────────────────────────────────────────────────────────

ANALYSIS_SERVICE_URL = os.getenv("ANALYSIS_SERVICE_URL", "http://localhost:8090")
MONGO_URL = os.getenv("MONGO_URL", "mongodb://localhost:27017")
MONGO_DB = os.getenv("MONGO_DB_NAME", "ai_recruiter_dev")

# Test interview IDs pool (these should exist in your database)
# You can create test interviews or use existing ones
TEST_INTERVIEW_IDS = os.getenv("TEST_INTERVIEW_IDS", "").split(",")

# If no test IDs provided, we'll use synthetic test IDs
if not TEST_INTERVIEW_IDS or TEST_INTERVIEW_IDS == [""]:
    _LOG.warning("No TEST_INTERVIEW_IDS found. Using synthetic interview IDs.")
    TEST_INTERVIEW_IDS = [f"test_interview_{i:03d}" for i in range(1, 101)]


# ─── MongoDB Client ───────────────────────────────────────────────────────────

_mongo_client = MongoClient(MONGO_URL)
_db = _mongo_client[MONGO_DB]
jobs_col = _db["video_analysis_jobs"]
reports_col = _db["interview_final_reports"]
pipeline_snapshots_col = _db["interview_pipeline_snapshots"]


# ─── Metrics Collector ────────────────────────────────────────────────────────


class LoadTestMetrics:
    """Collect metrics during load testing."""

    def __init__(self):
        self.start_time = time.time()
        self.end_time = None

        # Latency tracking
        self.report_latencies: List[float] = []
        self.mongo_read_latencies: List[float] = []
        self.mongo_write_latencies: List[float] = []
        self.queue_wait_times: List[float] = []

        # Success/failure tracking
        self.total_interviews = 0
        self.successful_reports = 0
        self.failed_reports = 0
        self.timeout_reports = 0

        # Resource tracking
        self.cpu_samples: List[float] = []
        self.memory_samples: List[float] = []
        self.peak_memory = 0

        # Error tracking
        self.errors: List[Dict[str, Any]] = []

    def record_report_latency(self, latency: float):
        self.report_latencies.append(latency)

    def record_mongo_read(self, latency: float):
        self.mongo_read_latencies.append(latency)

    def record_mongo_write(self, latency: float):
        self.mongo_write_latencies.append(latency)

    def record_queue_wait(self, wait_time: float):
        self.queue_wait_times.append(wait_time)

    def record_success(self):
        self.successful_reports += 1

    def record_failure(self):
        self.failed_reports += 1

    def record_timeout(self):
        self.timeout_reports += 1

    def record_error(self, error: Dict[str, Any]):
        self.errors.append(error)

    def sample_resources(self):
        """Sample CPU and memory usage."""
        try:
            cpu = psutil.cpu_percent(interval=0.1)
            mem = psutil.virtual_memory().percent
            self.cpu_samples.append(cpu)
            self.memory_samples.append(mem)

            mem_used = psutil.virtual_memory().used / (1024**3)  # GB
            if mem_used > self.peak_memory:
                self.peak_memory = mem_used
        except Exception as e:
            _LOG.warning(f"Error sampling resources: {e}")

    def finalize(self):
        self.end_time = time.time()

    def get_percentile(self, data: List[float], p: int) -> float:
        """Calculate percentile."""
        if not data:
            return 0.0
        sorted_data = sorted(data)
        idx = int(len(sorted_data) * (p / 100))
        return sorted_data[min(idx, len(sorted_data) - 1)]

    def summarize(self) -> Dict[str, Any]:
        """Generate summary report."""
        duration = (self.end_time or time.time()) - self.start_time

        return {
            "duration_seconds": round(duration, 2),
            "total_interviews": self.total_interviews,
            "successful_reports": self.successful_reports,
            "failed_reports": self.failed_reports,
            "timeout_reports": self.timeout_reports,
            "success_rate": (
                round(self.successful_reports / self.total_interviews * 100, 2)
                if self.total_interviews > 0
                else 0.0
            ),
            "latency": {
                "report_generation": {
                    "avg": round(
                        sum(self.report_latencies) / len(self.report_latencies), 2
                    )
                    if self.report_latencies
                    else 0.0,
                    "p50": round(self.get_percentile(self.report_latencies, 50), 2),
                    "p95": round(self.get_percentile(self.report_latencies, 95), 2),
                    "p99": round(self.get_percentile(self.report_latencies, 99), 2),
                    "max": round(max(self.report_latencies), 2)
                    if self.report_latencies
                    else 0.0,
                },
                "mongo_read": {
                    "avg": round(
                        sum(self.mongo_read_latencies) / len(self.mongo_read_latencies),
                        2,
                    )
                    if self.mongo_read_latencies
                    else 0.0,
                    "p95": round(self.get_percentile(self.mongo_read_latencies, 95), 2),
                },
                "mongo_write": {
                    "avg": round(
                        sum(self.mongo_write_latencies)
                        / len(self.mongo_write_latencies),
                        2,
                    )
                    if self.mongo_write_latencies
                    else 0.0,
                    "p95": round(
                        self.get_percentile(self.mongo_write_latencies, 95), 2
                    ),
                },
                "queue_wait": {
                    "avg": round(
                        sum(self.queue_wait_times) / len(self.queue_wait_times), 2
                    )
                    if self.queue_wait_times
                    else 0.0,
                    "p95": round(self.get_percentile(self.queue_wait_times, 95), 2),
                },
            },
            "resources": {
                "cpu": {
                    "avg": round(sum(self.cpu_samples) / len(self.cpu_samples), 2)
                    if self.cpu_samples
                    else 0.0,
                    "max": round(max(self.cpu_samples), 2) if self.cpu_samples else 0.0,
                },
                "memory": {
                    "avg": round(sum(self.memory_samples) / len(self.memory_samples), 2)
                    if self.memory_samples
                    else 0.0,
                    "peak_gb": round(self.peak_memory, 2),
                },
            },
            "errors": self.errors[:10],  # First 10 errors
            "error_count": len(self.errors),
        }


# ─── Interview Runner ─────────────────────────────────────────────────────────


def trigger_analysis(interview_id: str) -> Optional[Dict[str, Any]]:
    """Trigger analysis for a single interview."""
    try:
        response = requests.post(
            f"{ANALYSIS_SERVICE_URL}/analyze/{interview_id}",
            timeout=5,
        )
        if response.status_code == 200:
            return response.json()
        else:
            _LOG.error(
                f"Failed to trigger analysis for {interview_id}: {response.status_code}"
            )
            return None
    except Exception as e:
        _LOG.error(f"Error triggering analysis for {interview_id}: {e}")
        return None


def poll_job_status(interview_id: str, timeout: int = 300) -> Dict[str, Any]:
    """Poll job status until completion or timeout."""
    start_time = time.time()
    last_status = None

    while time.time() - start_time < timeout:
        try:
            # Query MongoDB directly
            mongo_start = time.time()
            job = jobs_col.find_one({"interviewId": interview_id})
            mongo_latency = time.time() - mongo_start

            if not job:
                _LOG.warning(f"Job not found for {interview_id}")
                time.sleep(2)
                continue

            status = job.get("status", "unknown")

            if status != last_status:
                _LOG.info(f"[{interview_id}] Status: {status}")
                last_status = status

            if status == "completed":
                return {
                    "status": "completed",
                    "latency": time.time() - start_time,
                    "mongo_latency": mongo_latency,
                }
            elif status == "failed":
                return {
                    "status": "failed",
                    "latency": time.time() - start_time,
                    "mongo_latency": mongo_latency,
                    "error": job.get("error", {}),
                }

            time.sleep(2)

        except Exception as e:
            _LOG.error(f"Error polling status for {interview_id}: {e}")
            time.sleep(2)

    return {
        "status": "timeout",
        "latency": timeout,
    }


def verify_report(interview_id: str) -> bool:
    """Verify that the report was saved correctly."""
    try:
        mongo_start = time.time()
        report = reports_col.find_one({"interviewId": interview_id})
        mongo_latency = time.time() - mongo_start

        if not report:
            _LOG.error(f"Report not found for {interview_id}")
            return False

        # Basic validation
        required_fields = ["decisionTrace", "confidenceDecision", "biasReport"]
        for field in required_fields:
            if field not in report:
                _LOG.error(f"Report missing {field} for {interview_id}")
                return False

        return True

    except Exception as e:
        _LOG.error(f"Error verifying report for {interview_id}: {e}")
        return False


def run_single_interview(interview_id: str, metrics: LoadTestMetrics) -> Dict[str, Any]:
    """Run a single interview through the pipeline."""
    _LOG.info(f"Starting interview: {interview_id}")
    result = {
        "interview_id": interview_id,
        "success": False,
        "status": "unknown",
        "error": None,
    }

    try:
        # Trigger analysis
        trigger_result = trigger_analysis(interview_id)
        if not trigger_result:
            result["error"] = "Failed to trigger analysis"
            metrics.record_failure()
            metrics.record_error(result)
            return result

        # Poll for completion
        job_result = poll_job_status(interview_id)
        result["status"] = job_result["status"]
        result["latency"] = job_result.get("latency", 0)

        if "mongo_latency" in job_result:
            metrics.record_mongo_read(job_result["mongo_latency"])

        if job_result["status"] == "completed":
            # Verify report
            if verify_report(interview_id):
                result["success"] = True
                metrics.record_success()
                metrics.record_report_latency(job_result["latency"])
            else:
                result["error"] = "Report verification failed"
                metrics.record_failure()
                metrics.record_error(result)
        elif job_result["status"] == "timeout":
            result["error"] = "Job timed out"
            metrics.record_timeout()
            metrics.record_error(result)
        else:
            result["error"] = job_result.get("error", "Unknown error")
            metrics.record_failure()
            metrics.record_error(result)

    except Exception as e:
        result["error"] = str(e)
        metrics.record_failure()
        metrics.record_error(result)

    return result


# ─── Concurrent Load Test ─────────────────────────────────────────────────────


def run_concurrent_load_test(
    num_concurrent: int,
    num_total: int,
    metrics: LoadTestMetrics,
) -> List[Dict[str, Any]]:
    """Run multiple interviews concurrently."""
    _LOG.info(
        f"Starting load test: {num_total} interviews, {num_concurrent} concurrent"
    )

    # Select interview IDs
    interview_ids = []
    for i in range(num_total):
        idx = i % len(TEST_INTERVIEW_IDS)
        interview_ids.append(f"{TEST_INTERVIEW_IDS[idx]}_{i}")

    metrics.total_interviews = num_total
    results = []

    # Resource monitoring thread
    stop_monitoring = False

    def monitor_resources():
        while not stop_monitoring:
            metrics.sample_resources()
            time.sleep(1)

    import threading

    monitor_thread = threading.Thread(target=monitor_resources, daemon=True)
    monitor_thread.start()

    # Run interviews concurrently
    with ThreadPoolExecutor(max_workers=num_concurrent) as executor:
        futures = {
            executor.submit(run_single_interview, interview_id, metrics): interview_id
            for interview_id in interview_ids
        }

        for future in as_completed(futures):
            interview_id = futures[future]
            try:
                result = future.result()
                results.append(result)
                _LOG.info(
                    f"Completed {len(results)}/{num_total}: {interview_id} - "
                    f"{'SUCCESS' if result['success'] else 'FAILED'}"
                )
            except Exception as e:
                _LOG.error(f"Exception for {interview_id}: {e}")
                metrics.record_failure()
                metrics.record_error(
                    {
                        "interview_id": interview_id,
                        "error": str(e),
                    }
                )

    stop_monitoring = True
    monitor_thread.join(timeout=2)

    return results


# ─── Main ─────────────────────────────────────────────────────────────────────


def main():
    """Run load test scenarios."""
    scenarios = [
        {"name": "10_concurrent", "concurrent": 10, "total": 20},
        {"name": "50_concurrent", "concurrent": 50, "total": 100},
        {"name": "100_concurrent", "concurrent": 100, "total": 200},
    ]

    all_results = {}

    for scenario in scenarios:
        print(f"\n{'=' * 80}")
        print(f"SCENARIO: {scenario['name']}")
        print(f"Concurrent: {scenario['concurrent']}, Total: {scenario['total']}")
        print(f"{'=' * 80}\n")

        metrics = LoadTestMetrics()
        metrics.start_time = time.time()

        results = run_concurrent_load_test(
            num_concurrent=scenario["concurrent"],
            num_total=scenario["total"],
            metrics=metrics,
        )

        metrics.finalize()
        summary = metrics.summarize()

        all_results[scenario["name"]] = {
            "config": scenario,
            "summary": summary,
            "results": results,
        }

        # Print summary
        print(f"\n{'=' * 80}")
        print(f"SUMMARY: {scenario['name']}")
        print(f"{'=' * 80}")
        print(f"Duration: {summary['duration_seconds']}s")
        print(f"Total Interviews: {summary['total_interviews']}")
        print(f"Success Rate: {summary['success_rate']}%")
        print(f"Avg Report Latency: {summary['latency']['report_generation']['avg']}s")
        print(f"P95 Report Latency: {summary['latency']['report_generation']['p95']}s")
        print(f"P99 Report Latency: {summary['latency']['report_generation']['p99']}s")
        print(f"Avg CPU: {summary['resources']['cpu']['avg']}%")
        print(f"Peak Memory: {summary['resources']['memory']['peak_gb']} GB")
        print(f"Errors: {summary['error_count']}")
        print(f"{'=' * 80}\n")

    # Save results
    output_file = "tests/results/load_test_report.json"
    os.makedirs(os.path.dirname(output_file), exist_ok=True)

    with open(output_file, "w") as f:
        json.dump(
            {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "scenarios": all_results,
            },
            f,
            indent=2,
        )

    print(f"\n✓ Results saved to: {output_file}")


if __name__ == "__main__":
    main()
