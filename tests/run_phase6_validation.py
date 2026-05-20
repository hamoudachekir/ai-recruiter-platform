"""Phase 6 Master Validation Runner.

Runs ALL Phase 6 validation suites and generates a comprehensive master report.

This is the single entry point for Phase 6 validation that:
1. Runs load tests (10, 50, 100 concurrent)
2. Runs chaos tests (Mongo, Redis, Worker, GPU, Payload)
3. Runs data consistency audits
4. Runs replay determinism tests
5. Runs report integrity validation
6. Runs ML shadow validation
7. Runs performance profiling

Generates:
- Individual test reports in tests/results/
- Master aggregated report: tests/results/PHASE6_MASTER_REPORT.json
- Console summary with PASS/WARNING/FAIL status
"""

import json
import logging
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
_LOG = logging.getLogger(__name__)

# ─── Configuration ────────────────────────────────────────────────────────────

TESTS_DIR = Path(__file__).parent
RESULTS_DIR = TESTS_DIR / "results"
MASTER_REPORT_FILE = RESULTS_DIR / "PHASE6_MASTER_REPORT.json"

# Test suite definitions
TEST_SUITES = {
    "load_tests": {
        "name": "Load Testing",
        "tests": [
            {
                "name": "concurrent_interview_runner",
                "script": "tests/load/concurrent_interview_runner.py",
                "report": "tests/results/load_test_report.json",
                "weight": 10,
            },
        ],
    },
    "chaos_tests": {
        "name": "Chaos Testing (Failure Injection)",
        "tests": [
            {
                "name": "mongo_failure",
                "script": "tests/chaos/mongo_failure_test.py",
                "report": "tests/results/chaos_mongo_failure_report.json",
                "weight": 5,
            },
            {
                "name": "redis_failure",
                "script": "tests/chaos/redis_failure_test.py",
                "report": "tests/results/chaos_redis_failure_report.json",
                "weight": 5,
            },
            {
                "name": "worker_kill",
                "script": "tests/chaos/worker_kill_test.py",
                "report": "tests/results/chaos_worker_kill_report.json",
                "weight": 5,
            },
            {
                "name": "gpu_timeout",
                "script": "tests/chaos/gpu_timeout_test.py",
                "report": "tests/results/chaos_gpu_timeout_report.json",
                "weight": 5,
            },
            {
                "name": "corrupt_payload",
                "script": "tests/chaos/corrupt_payload_test.py",
                "report": "tests/results/chaos_corrupt_payload_report.json",
                "weight": 5,
            },
        ],
    },
    "data_consistency": {
        "name": "Data Consistency Audit",
        "tests": [
            {
                "name": "consistency_audit",
                "script": "tests/audit/consistency_audit.py",
                "report": "tests/results/data_consistency_report.json",
                "weight": 15,
            },
            {
                "name": "orphan_detector",
                "script": "tests/audit/orphan_detector.py",
                "report": "tests/results/orphan_detection_report.json",
                "weight": 5,
            },
            {
                "name": "replay_consistency",
                "script": "tests/audit/replay_consistency_test.py",
                "report": "tests/results/replay_consistency_report.json",
                "weight": 10,
            },
        ],
    },
    "report_integrity": {
        "name": "Report Integrity Validation",
        "tests": [
            {
                "name": "report_integrity",
                "script": "tests/integrity/report_integrity_validator.py",
                "report": "tests/results/report_integrity_report.json",
                "weight": 15,
            },
        ],
    },
    "ml_validation": {
        "name": "ML Shadow Validation",
        "tests": [
            {
                "name": "shadow_validation",
                "script": "tests/ml/shadow_validation.py",
                "report": "tests/results/ml_shadow_validation_report.json",
                "weight": 10,
            },
            {
                "name": "drift_validation",
                "script": "tests/ml/drift_validation.py",
                "report": "tests/results/ml_drift_report.json",
                "weight": 5,
            },
        ],
    },
    "performance": {
        "name": "Performance Baseline",
        "tests": [
            {
                "name": "baseline_profiler",
                "script": "tests/performance/baseline_profiler.py",
                "report": "tests/results/performance_baseline.json",
                "weight": 10,
            },
        ],
    },
}


# ─── Test Runner ──────────────────────────────────────────────────────────────


class Phase6Validator:
    """Master validator for Phase 6."""

    def __init__(self):
        self.results = {
            "timestamp": None,
            "phase": "Phase 6 - Real-World Validation",
            "suites": {},
            "summary": {
                "total_suites": 0,
                "total_tests": 0,
                "passed": 0,
                "warnings": 0,
                "failed": 0,
                "skipped": 0,
                "pass_rate": 0.0,
            },
            "operational_readiness": {
                "status": "unknown",
                "score": 0.0,
                "details": {},
            },
        }

        # Ensure results directory exists
        RESULTS_DIR.mkdir(parents=True, exist_ok=True)

    def run_test(self, test: Dict[str, Any]) -> Dict[str, Any]:
        """Run a single test script."""
        _LOG.info(f"\n{'=' * 80}")
        _LOG.info(f"Running: {test['name']}")
        _LOG.info(f"{'=' * 80}\n")

        result = {
            "name": test["name"],
            "script": test["script"],
            "status": "unknown",
            "duration": 0.0,
            "report_file": test["report"],
            "error": None,
            "summary": {},
        }

        start_time = time.time()

        try:
            # Run the test script
            script_path = Path(test["script"])

            if not script_path.exists():
                result["status"] = "skipped"
                result["error"] = f"Script not found: {script_path}"
                _LOG.warning(f"⚠ Skipping {test['name']}: Script not found")
                return result

            # Execute the script
            proc = subprocess.run(
                [sys.executable, str(script_path)],
                capture_output=True,
                text=True,
                timeout=600,  # 10 minute timeout
            )

            result["duration"] = time.time() - start_time

            # Check if report was generated
            report_path = Path(test["report"])

            if report_path.exists():
                # Load the report
                with open(report_path, "r") as f:
                    report_data = json.load(f)

                result["summary"] = self._extract_summary(report_data)

                # Determine status from report
                if "status" in report_data:
                    result["status"] = report_data["status"]
                elif "summary" in report_data:
                    summary = report_data["summary"]
                    if isinstance(summary, dict):
                        failed = summary.get("failed", 0)
                        warnings = summary.get("warnings", 0)
                        if failed > 0:
                            result["status"] = "fail"
                        elif warnings > 0:
                            result["status"] = "warning"
                        else:
                            result["status"] = "pass"
                else:
                    result["status"] = "pass"  # Assume pass if report exists

                _LOG.info(f"✓ {test['name']} completed: {result['status'].upper()}")

            else:
                result["status"] = "fail"
                result["error"] = "Report file not generated"
                _LOG.error(f"✗ {test['name']} failed: No report generated")

        except subprocess.TimeoutExpired:
            result["status"] = "fail"
            result["error"] = "Test timed out (600s)"
            result["duration"] = 600
            _LOG.error(f"✗ {test['name']} failed: Timeout")

        except Exception as e:
            result["status"] = "fail"
            result["error"] = str(e)
            result["duration"] = time.time() - start_time
            _LOG.error(f"✗ {test['name']} failed: {e}")

        return result

    def _extract_summary(self, report_data: Dict[str, Any]) -> Dict[str, Any]:
        """Extract key summary metrics from a test report."""
        summary = {}

        # Try to extract common metrics
        if "summary" in report_data:
            summary = report_data["summary"]

        # Extract scenario results for load tests
        if "scenarios" in report_data:
            summary["scenarios"] = {}
            for name, scenario in report_data["scenarios"].items():
                if "summary" in scenario:
                    summary["scenarios"][name] = scenario["summary"]

        # Extract checks for audits
        if "checks" in report_data:
            summary["total_checks"] = len(report_data["checks"])
            summary["passed_checks"] = sum(
                1 for c in report_data["checks"].values() if c.get("status") == "pass"
            )

        return summary

    def run_suite(
        self, suite_name: str, suite_config: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Run all tests in a suite."""
        _LOG.info(f"\n{'#' * 80}")
        _LOG.info(f"# SUITE: {suite_config['name']}")
        _LOG.info(f"{'#' * 80}\n")

        suite_result = {
            "name": suite_config["name"],
            "tests": {},
            "summary": {
                "total": len(suite_config["tests"]),
                "passed": 0,
                "warnings": 0,
                "failed": 0,
                "skipped": 0,
            },
        }

        for test in suite_config["tests"]:
            result = self.run_test(test)
            suite_result["tests"][test["name"]] = result

            # Update suite summary
            status = result["status"]
            if status == "pass":
                suite_result["summary"]["passed"] += 1
            elif status == "warning":
                suite_result["summary"]["warnings"] += 1
            elif status == "fail":
                suite_result["summary"]["failed"] += 1
            elif status == "skipped":
                suite_result["summary"]["skipped"] += 1

        return suite_result

    def run_all_suites(self):
        """Run all validation suites."""
        _LOG.info("\n" + "=" * 80)
        _LOG.info("PHASE 6 - REAL-WORLD VALIDATION")
        _LOG.info("=" * 80 + "\n")

        self.results["timestamp"] = datetime.now(timezone.utc).isoformat()

        for suite_name, suite_config in TEST_SUITES.items():
            suite_result = self.run_suite(suite_name, suite_config)
            self.results["suites"][suite_name] = suite_result

            # Update master summary
            self.results["summary"]["total_suites"] += 1
            self.results["summary"]["total_tests"] += suite_result["summary"]["total"]
            self.results["summary"]["passed"] += suite_result["summary"]["passed"]
            self.results["summary"]["warnings"] += suite_result["summary"]["warnings"]
            self.results["summary"]["failed"] += suite_result["summary"]["failed"]
            self.results["summary"]["skipped"] += suite_result["summary"]["skipped"]

        # Calculate pass rate
        total = self.results["summary"]["total_tests"]
        passed = self.results["summary"]["passed"]
        self.results["summary"]["pass_rate"] = (
            round(passed / total * 100, 2) if total > 0 else 0.0
        )

        # Calculate operational readiness score
        self._calculate_operational_readiness()

    def _calculate_operational_readiness(self):
        """Calculate operational readiness score based on weighted results."""
        total_weight = 0
        weighted_score = 0

        for suite_name, suite_config in TEST_SUITES.items():
            suite_result = self.results["suites"].get(suite_name, {})
            suite_tests = suite_result.get("tests", {})

            for test_config in suite_config["tests"]:
                test_name = test_config["name"]
                test_result = suite_tests.get(test_name, {})
                weight = test_config.get("weight", 5)

                total_weight += weight

                status = test_result.get("status", "skipped")
                if status == "pass":
                    weighted_score += weight
                elif status == "warning":
                    weighted_score += weight * 0.7  # 70% credit for warnings
                # fail or skipped = 0 credit

        score = (weighted_score / total_weight * 100) if total_weight > 0 else 0.0

        self.results["operational_readiness"]["score"] = round(score, 2)

        # Determine status
        if score >= 90:
            self.results["operational_readiness"]["status"] = "PRODUCTION_READY"
        elif score >= 75:
            self.results["operational_readiness"]["status"] = "NEEDS_ATTENTION"
        else:
            self.results["operational_readiness"]["status"] = "NOT_READY"

        # Add details
        self.results["operational_readiness"]["details"] = {
            "total_weight": total_weight,
            "weighted_score": round(weighted_score, 2),
            "criteria": {
                "≥90%": "PRODUCTION_READY",
                "75-89%": "NEEDS_ATTENTION",
                "<75%": "NOT_READY",
            },
        }

    def print_summary(self):
        """Print a comprehensive summary to console."""
        print("\n" + "=" * 80)
        print("PHASE 6 VALIDATION SUMMARY")
        print("=" * 80 + "\n")

        # Print suite results
        for suite_name, suite_result in self.results["suites"].items():
            summary = suite_result["summary"]
            total = summary["total"]
            passed = summary["passed"]
            warnings = summary["warnings"]
            failed = summary["failed"]
            skipped = summary["skipped"]

            status_icon = "✓" if failed == 0 else "✗"
            print(f"{status_icon} {suite_result['name']}")
            print(
                f"   Tests: {total} | Passed: {passed} | Warnings: {warnings} | "
                f"Failed: {failed} | Skipped: {skipped}"
            )
            print()

        # Print master summary
        print("=" * 80)
        print("MASTER SUMMARY")
        print("=" * 80)
        summary = self.results["summary"]
        print(f"Total Test Suites: {summary['total_suites']}")
        print(f"Total Tests: {summary['total_tests']}")
        print(f"Passed: {summary['passed']}")
        print(f"Warnings: {summary['warnings']}")
        print(f"Failed: {summary['failed']}")
        print(f"Skipped: {summary['skipped']}")
        print(f"Pass Rate: {summary['pass_rate']}%")
        print()

        # Print operational readiness
        readiness = self.results["operational_readiness"]
        print("=" * 80)
        print("OPERATIONAL READINESS")
        print("=" * 80)
        print(f"Status: {readiness['status']}")
        print(f"Score: {readiness['score']}%")
        print()

        if readiness["status"] == "PRODUCTION_READY":
            print("✓ System is PRODUCTION READY for real-world deployment!")
        elif readiness["status"] == "NEEDS_ATTENTION":
            print("⚠ System needs attention before production deployment.")
        else:
            print("✗ System is NOT READY for production deployment.")

        print("=" * 80 + "\n")

    def save_report(self):
        """Save the master report to JSON."""
        with open(MASTER_REPORT_FILE, "w") as f:
            json.dump(self.results, f, indent=2)

        _LOG.info(f"✓ Master report saved to: {MASTER_REPORT_FILE}")


# ─── Main ─────────────────────────────────────────────────────────────────────


def main():
    """Run Phase 6 validation suite."""
    validator = Phase6Validator()

    try:
        validator.run_all_suites()
        validator.print_summary()
        validator.save_report()

        # Exit code based on operational readiness
        readiness_status = validator.results["operational_readiness"]["status"]
        if readiness_status == "PRODUCTION_READY":
            sys.exit(0)
        elif readiness_status == "NEEDS_ATTENTION":
            sys.exit(1)
        else:
            sys.exit(2)

    except KeyboardInterrupt:
        _LOG.warning("\n\nValidation interrupted by user")
        sys.exit(130)

    except Exception as e:
        _LOG.error(f"Validation failed with error: {e}")
        sys.exit(3)


if __name__ == "__main__":
    main()
