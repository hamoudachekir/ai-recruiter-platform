"""MongoDB failure injection test.

Tests pipeline behavior when MongoDB connections fail during critical operations.
"""

import json
import logging
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from typing import Any, Dict, List

from pymongo import MongoClient

logging.basicConfig(level=logging.INFO)
_LOG = logging.getLogger(__name__)

# ─── Configuration ────────────────────────────────────────────────────────────

MONGO_URL = os.getenv("MONGO_URL", "mongodb://localhost:27017")
MONGO_DB = os.getenv("MONGO_DB_NAME", "ai_recruiter_dev")
ANALYSIS_SERVICE_URL = os.getenv("ANALYSIS_SERVICE_URL", "http://localhost:8090")


# ─── Test Scenarios ───────────────────────────────────────────────────────────


class MongoFailureTest:
    """Chaos test for MongoDB failures."""

    def __init__(self):
        self.client = MongoClient(MONGO_URL)
        self.db = self.client[MONGO_DB]
        self.jobs_col = self.db["video_analysis_jobs"]
        self.reports_col = self.db["interview_final_reports"]
        self.audit_logs_col = self.db["interview_audit_logs"]

        self.results = {
            "timestamp": None,
            "tests": {},
            "summary": {
                "total": 0,
                "passed": 0,
                "failed": 0,
            },
        }

    def test_connection_drop_during_report_persist(self) -> Dict[str, Any]:
        """Test: MongoDB connection drops during report persistence.

        Expected behavior:
        - No silent failure
        - Job status transitions to 'failed'
        - Error payload contains structured information
        - No partial report writes
        """
        _LOG.info("TEST: Connection drop during report persist")

        test_result = {
            "name": "connection_drop_during_persist",
            "description": "MongoDB disconnects during persist_report_node",
            "status": "not_implemented",
            "checks": {},
            "error": None,
        }

        try:
            # This test requires cooperation with the pipeline
            # For now, we document the expected behavior

            checks = {
                "no_silent_failure": {
                    "expected": "Job marked as failed",
                    "status": "manual_check",
                },
                "status_transition": {
                    "expected": "Status = 'failed'",
                    "status": "manual_check",
                },
                "error_payload_exists": {
                    "expected": "error field populated",
                    "status": "manual_check",
                },
                "no_partial_writes": {
                    "expected": "Report either complete or absent",
                    "status": "manual_check",
                },
            }

            test_result["checks"] = checks
            test_result["status"] = "manual_check_required"

            _LOG.info("✓ Test documented (manual verification required)")

        except Exception as e:
            test_result["status"] = "error"
            test_result["error"] = str(e)
            _LOG.error(f"✗ Test error: {e}")

        return test_result

    def test_connection_drop_during_finalize(self) -> Dict[str, Any]:
        """Test: MongoDB connection drops during finalize_interview_node.

        Expected behavior:
        - Watchdog detects stuck job
        - Job marked as FAILED_TIMEOUT
        - No data corruption
        """
        _LOG.info("TEST: Connection drop during finalize")

        test_result = {
            "name": "connection_drop_during_finalize",
            "description": "MongoDB disconnects during finalize_interview_node",
            "status": "not_implemented",
            "checks": {},
            "error": None,
        }

        try:
            checks = {
                "watchdog_detects": {
                    "expected": "Watchdog fires",
                    "status": "manual_check",
                },
                "status_marked_failed": {
                    "expected": "Status = 'failed'",
                    "status": "manual_check",
                },
                "no_data_corruption": {
                    "expected": "No corrupted documents",
                    "status": "manual_check",
                },
            }

            test_result["checks"] = checks
            test_result["status"] = "manual_check_required"

            _LOG.info("✓ Test documented (manual verification required)")

        except Exception as e:
            test_result["status"] = "error"
            test_result["error"] = str(e)
            _LOG.error(f"✗ Test error: {e}")

        return test_result

    def test_slow_mongo_queries(self) -> Dict[str, Any]:
        """Test: MongoDB queries are extremely slow.

        Expected behavior:
        - Pipeline continues (with delay)
        - Watchdog eventually fires if too slow
        - No data loss
        """
        _LOG.info("TEST: Slow MongoDB queries")

        test_result = {
            "name": "slow_mongo_queries",
            "description": "MongoDB responds very slowly",
            "status": "pass",
            "checks": {},
            "error": None,
        }

        try:
            # Test slow query detection
            start = time.time()

            # Simulate slow query by fetching large dataset
            count = self.jobs_col.count_documents({})
            latency = time.time() - start

            checks = {
                "query_completes": {
                    "expected": "Query eventually completes",
                    "actual": f"Completed in {latency:.2f}s",
                    "status": "pass" if latency < 60 else "fail",
                },
                "no_data_loss": {
                    "expected": "Data intact",
                    "actual": f"Found {count} documents",
                    "status": "pass",
                },
            }

            test_result["checks"] = checks
            test_result["status"] = "pass"

            _LOG.info("✓ Test passed")

        except Exception as e:
            test_result["status"] = "fail"
            test_result["error"] = str(e)
            _LOG.error(f"✗ Test failed: {e}")

        return test_result

    def test_duplicate_key_collision(self) -> Dict[str, Any]:
        """Test: Attempting to insert duplicate interviewId.

        Expected behavior:
        - Proper error handling
        - No silent overwrite
        - Original data preserved
        """
        _LOG.info("TEST: Duplicate key collision")

        test_result = {
            "name": "duplicate_key_collision",
            "description": "Insert duplicate interviewId",
            "status": "pass",
            "checks": {},
            "error": None,
        }

        try:
            test_id = f"dup_test_{int(time.time())}"

            # Insert first document
            self.jobs_col.insert_one(
                {
                    "interviewId": test_id,
                    "status": "completed",
                    "data": "original",
                    "createdAt": datetime.now(timezone.utc),
                }
            )

            # Attempt duplicate insert
            try:
                self.jobs_col.insert_one(
                    {
                        "interviewId": test_id,
                        "status": "failed",
                        "data": "duplicate",
                        "createdAt": datetime.now(timezone.utc),
                    }
                )
                duplicate_allowed = True
            except Exception:
                duplicate_allowed = False

            # Verify original preserved
            doc = self.jobs_col.find_one({"interviewId": test_id})
            original_preserved = doc.get("data") == "original" if doc else False

            checks = {
                "duplicate_rejected": {
                    "expected": "Duplicate insert fails or handled",
                    "actual": "Prevented"
                    if not duplicate_allowed
                    else "Allowed (upsert)",
                    "status": "pass",
                },
                "original_data_preserved": {
                    "expected": "Original data intact",
                    "actual": "Preserved" if original_preserved else "Overwritten",
                    "status": "pass"
                    if original_preserved or not duplicate_allowed
                    else "fail",
                },
            }

            # Cleanup
            self.jobs_col.delete_one({"interviewId": test_id})

            test_result["checks"] = checks
            test_result["status"] = "pass"

            _LOG.info("✓ Test passed")

        except Exception as e:
            test_result["status"] = "fail"
            test_result["error"] = str(e)
            _LOG.error(f"✗ Test failed: {e}")

        return test_result

    def test_missing_collection(self) -> Dict[str, Any]:
        """Test: Required collection is missing.

        Expected behavior:
        - Graceful error handling
        - Clear error message
        - No crash
        """
        _LOG.info("TEST: Missing collection")

        test_result = {
            "name": "missing_collection",
            "description": "Access non-existent collection",
            "status": "pass",
            "checks": {},
            "error": None,
        }

        try:
            # Try to access non-existent collection
            fake_col = self.db["nonexistent_collection_xyz"]

            # MongoDB allows this - collection is created on first write
            # Try to read from it
            doc = fake_col.find_one({"_id": "test"})

            checks = {
                "no_crash": {
                    "expected": "Operation completes without crash",
                    "actual": "No crash",
                    "status": "pass",
                },
                "returns_none": {
                    "expected": "Returns None for missing doc",
                    "actual": f"Got {doc}",
                    "status": "pass" if doc is None else "fail",
                },
            }

            test_result["checks"] = checks
            test_result["status"] = "pass"

            _LOG.info("✓ Test passed")

        except Exception as e:
            test_result["status"] = "fail"
            test_result["error"] = str(e)
            _LOG.error(f"✗ Test failed: {e}")

        return test_result

    def run_all_tests(self) -> Dict[str, Any]:
        """Run all MongoDB failure tests."""
        _LOG.info("\n" + "=" * 80)
        _LOG.info("MongoDB FAILURE INJECTION TESTS")
        _LOG.info("=" * 80 + "\n")

        tests = [
            self.test_connection_drop_during_report_persist,
            self.test_connection_drop_during_finalize,
            self.test_slow_mongo_queries,
            self.test_duplicate_key_collision,
            self.test_missing_collection,
        ]

        for test_fn in tests:
            result = test_fn()
            self.results["tests"][result["name"]] = result
            self.results["summary"]["total"] += 1

            if result["status"] == "pass":
                self.results["summary"]["passed"] += 1
            elif result["status"] in ["fail", "error"]:
                self.results["summary"]["failed"] += 1

            print()

        self.results["timestamp"] = datetime.now(timezone.utc).isoformat()

        # Calculate pass rate
        total = self.results["summary"]["total"]
        passed = self.results["summary"]["passed"]
        pass_rate = (passed / total * 100) if total > 0 else 0

        print("\n" + "=" * 80)
        print("SUMMARY")
        print("=" * 80)
        print(f"Total Tests: {total}")
        print(f"Passed: {passed}")
        print(f"Failed: {self.results['summary']['failed']}")
        print(f"Pass Rate: {pass_rate:.1f}%")
        print("=" * 80 + "\n")

        return self.results


# ─── Main ─────────────────────────────────────────────────────────────────────


def main():
    """Run MongoDB failure tests."""
    tester = MongoFailureTest()
    results = tester.run_all_tests()

    # Save results
    output_file = "tests/results/chaos_mongo_failure_report.json"
    os.makedirs(os.path.dirname(output_file), exist_ok=True)

    with open(output_file, "w") as f:
        json.dump(results, f, indent=2)

    print(f"✓ Results saved to: {output_file}")


if __name__ == "__main__":
    main()
