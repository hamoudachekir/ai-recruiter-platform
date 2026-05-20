"""Data consistency audit for the interview pipeline.

Verifies that:
- Every COMPLETED job has a report
- Every report has required Phase 3 fields (decisionTrace, confidenceDecision, biasReport)
- Audit logs exist for every report
- No orphan snapshots
- No missing references
"""

import json
import logging
import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Set

from pymongo import MongoClient

logging.basicConfig(level=logging.INFO)
_LOG = logging.getLogger(__name__)

# ─── Configuration ────────────────────────────────────────────────────────────

MONGO_URL = os.getenv("MONGO_URL", "mongodb://localhost:27017")
MONGO_DB = os.getenv("MONGO_DB_NAME", "ai_recruiter_dev")


# ─── Consistency Auditor ──────────────────────────────────────────────────────


class ConsistencyAuditor:
    """Audit data consistency across collections."""

    def __init__(self):
        self.client = MongoClient(MONGO_URL)
        self.db = self.client[MONGO_DB]

        self.jobs_col = self.db["video_analysis_jobs"]
        self.reports_col = self.db["interview_final_reports"]
        self.snapshots_col = self.db["interview_pipeline_snapshots"]
        self.audit_logs_col = self.db["interview_audit_logs"]

        self.results = {
            "timestamp": None,
            "checks": {},
            "issues": [],
            "summary": {
                "total_checks": 0,
                "passed": 0,
                "failed": 0,
                "warnings": 0,
            },
        }

    def audit_completed_jobs_have_reports(self) -> Dict[str, Any]:
        """Verify every COMPLETED job has a corresponding report."""
        _LOG.info("AUDIT: Checking completed jobs have reports...")

        check_result = {
            "name": "completed_jobs_have_reports",
            "description": "Every COMPLETED job must have a report",
            "status": "pass",
            "details": {},
            "missing_reports": [],
        }

        try:
            # Find all completed jobs
            completed_jobs = list(
                self.jobs_col.find(
                    {"status": "completed"},
                    {"interviewId": 1, "finishedAt": 1},
                )
            )

            total_completed = len(completed_jobs)
            missing_reports = []

            for job in completed_jobs:
                interview_id = job.get("interviewId")
                report = self.reports_col.find_one({"interviewId": interview_id})

                if not report:
                    missing_reports.append(
                        {
                            "interviewId": interview_id,
                            "finishedAt": job.get("finishedAt"),
                        }
                    )

            check_result["details"] = {
                "total_completed_jobs": total_completed,
                "jobs_with_reports": total_completed - len(missing_reports),
                "missing_reports_count": len(missing_reports),
            }

            check_result["missing_reports"] = missing_reports[:10]  # First 10

            if missing_reports:
                check_result["status"] = "fail"
                self.results["issues"].append(
                    {
                        "severity": "critical",
                        "check": check_result["name"],
                        "message": f"{len(missing_reports)} completed jobs missing reports",
                        "sample": missing_reports[:5],
                    }
                )

            _LOG.info(
                f"✓ {check_result['details']['jobs_with_reports']}/{total_completed} "
                f"jobs have reports"
            )

        except Exception as e:
            check_result["status"] = "error"
            check_result["error"] = str(e)
            _LOG.error(f"✗ Audit failed: {e}")

        return check_result

    def audit_reports_have_required_fields(self) -> Dict[str, Any]:
        """Verify every report has required Phase 3 fields."""
        _LOG.info("AUDIT: Checking reports have required fields...")

        check_result = {
            "name": "reports_have_required_fields",
            "description": "Reports must have decisionTrace, confidenceDecision, biasReport",
            "status": "pass",
            "details": {},
            "invalid_reports": [],
        }

        required_fields = {
            "decisionTrace": "Phase 3 decision trace",
            "confidenceDecision": "Phase 3 confidence decision",
            "biasReport": "Phase 3 bias report",
            "auditLogReferences": "Audit log references",
        }

        try:
            reports = list(
                self.reports_col.find(
                    {}, {"interviewId": 1, **{f: 1 for f in required_fields}}
                )
            )

            total_reports = len(reports)
            invalid_reports = []

            for report in reports:
                interview_id = report.get("interviewId")
                missing_fields = []

                for field, desc in required_fields.items():
                    if field not in report or not report[field]:
                        missing_fields.append(field)

                if missing_fields:
                    invalid_reports.append(
                        {
                            "interviewId": interview_id,
                            "missing_fields": missing_fields,
                        }
                    )

            check_result["details"] = {
                "total_reports": total_reports,
                "valid_reports": total_reports - len(invalid_reports),
                "invalid_reports_count": len(invalid_reports),
            }

            check_result["invalid_reports"] = invalid_reports[:10]

            if invalid_reports:
                check_result["status"] = "fail"
                self.results["issues"].append(
                    {
                        "severity": "critical",
                        "check": check_result["name"],
                        "message": f"{len(invalid_reports)} reports missing required fields",
                        "sample": invalid_reports[:5],
                    }
                )

            _LOG.info(
                f"✓ {check_result['details']['valid_reports']}/{total_reports} "
                f"reports have all required fields"
            )

        except Exception as e:
            check_result["status"] = "error"
            check_result["error"] = str(e)
            _LOG.error(f"✗ Audit failed: {e}")

        return check_result

    def audit_audit_logs_exist(self) -> Dict[str, Any]:
        """Verify audit logs exist for every report."""
        _LOG.info("AUDIT: Checking audit logs exist...")

        check_result = {
            "name": "audit_logs_exist",
            "description": "Every report must have audit log entries",
            "status": "pass",
            "details": {},
            "missing_logs": [],
        }

        try:
            reports = list(
                self.reports_col.find({}, {"interviewId": 1, "auditLogReferences": 1})
            )

            total_reports = len(reports)
            missing_logs = []

            for report in reports:
                interview_id = report.get("interviewId")
                audit_refs = report.get("auditLogReferences", [])

                if not audit_refs:
                    missing_logs.append(interview_id)
                    continue

                # Verify at least one audit log exists
                log_exists = self.audit_logs_col.find_one({"interviewId": interview_id})

                if not log_exists:
                    missing_logs.append(interview_id)

            check_result["details"] = {
                "total_reports": total_reports,
                "reports_with_logs": total_reports - len(missing_logs),
                "missing_logs_count": len(missing_logs),
            }

            check_result["missing_logs"] = missing_logs[:10]

            if missing_logs:
                check_result["status"] = "warning"
                self.results["issues"].append(
                    {
                        "severity": "warning",
                        "check": check_result["name"],
                        "message": f"{len(missing_logs)} reports missing audit logs",
                        "sample": missing_logs[:5],
                    }
                )

            _LOG.info(
                f"✓ {check_result['details']['reports_with_logs']}/{total_reports} "
                f"reports have audit logs"
            )

        except Exception as e:
            check_result["status"] = "error"
            check_result["error"] = str(e)
            _LOG.error(f"✗ Audit failed: {e}")

        return check_result

    def audit_no_orphan_snapshots(self) -> Dict[str, Any]:
        """Verify no orphan snapshots exist."""
        _LOG.info("AUDIT: Checking for orphan snapshots...")

        check_result = {
            "name": "no_orphan_snapshots",
            "description": "Snapshots must have corresponding jobs",
            "status": "pass",
            "details": {},
            "orphan_snapshots": [],
        }

        try:
            snapshots = list(self.snapshots_col.find({}, {"interviewId": 1}))

            total_snapshots = len(snapshots)
            orphan_snapshots = []

            for snapshot in snapshots:
                interview_id = snapshot.get("interviewId")
                job = self.jobs_col.find_one({"interviewId": interview_id})

                if not job:
                    orphan_snapshots.append(interview_id)

            check_result["details"] = {
                "total_snapshots": total_snapshots,
                "valid_snapshots": total_snapshots - len(orphan_snapshots),
                "orphan_count": len(orphan_snapshots),
            }

            check_result["orphan_snapshots"] = orphan_snapshots[:10]

            if orphan_snapshots:
                check_result["status"] = "warning"
                self.results["issues"].append(
                    {
                        "severity": "warning",
                        "check": check_result["name"],
                        "message": f"{len(orphan_snapshots)} orphan snapshots found",
                        "sample": orphan_snapshots[:5],
                    }
                )

            _LOG.info(
                f"✓ {check_result['details']['valid_snapshots']}/{total_snapshots} "
                f"snapshots are valid"
            )

        except Exception as e:
            check_result["status"] = "error"
            check_result["error"] = str(e)
            _LOG.error(f"✗ Audit failed: {e}")

        return check_result

    def audit_scores_have_evidence(self) -> Dict[str, Any]:
        """Verify all scores have evidence."""
        _LOG.info("AUDIT: Checking scores have evidence...")

        check_result = {
            "name": "scores_have_evidence",
            "description": "All scores must have supporting evidence",
            "status": "pass",
            "details": {},
            "reports_missing_evidence": [],
        }

        try:
            reports = list(
                self.reports_col.find(
                    {},
                    {
                        "interviewId": 1,
                        "finalVisibleScore": 1,
                        "scoreBreakdown": 1,
                        "evidenceMap": 1,
                    },
                )
            )

            total_reports = len(reports)
            reports_missing_evidence = []

            for report in reports:
                interview_id = report.get("interviewId")
                score_breakdown = report.get("scoreBreakdown", {})
                evidence_map = report.get("evidenceMap", {})

                issues = []

                # Check if evidence map exists
                if not evidence_map:
                    issues.append("no_evidence_map")

                # Check score breakdown has evidence
                for category, data in score_breakdown.items():
                    if isinstance(data, dict):
                        evidence_ids = data.get("evidenceIds", [])
                        if not evidence_ids:
                            issues.append(f"no_evidence_for_{category}")

                if issues:
                    reports_missing_evidence.append(
                        {
                            "interviewId": interview_id,
                            "issues": issues,
                        }
                    )

            check_result["details"] = {
                "total_reports": total_reports,
                "reports_with_evidence": total_reports - len(reports_missing_evidence),
                "reports_missing_evidence_count": len(reports_missing_evidence),
            }

            check_result["reports_missing_evidence"] = reports_missing_evidence[:10]

            if reports_missing_evidence:
                check_result["status"] = "fail"
                self.results["issues"].append(
                    {
                        "severity": "critical",
                        "check": check_result["name"],
                        "message": f"{len(reports_missing_evidence)} reports missing evidence",
                        "sample": reports_missing_evidence[:5],
                    }
                )

            _LOG.info(
                f"✓ {check_result['details']['reports_with_evidence']}/{total_reports} "
                f"reports have complete evidence"
            )

        except Exception as e:
            check_result["status"] = "error"
            check_result["error"] = str(e)
            _LOG.error(f"✗ Audit failed: {e}")

        return check_result

    def audit_confidence_bounds(self) -> Dict[str, Any]:
        """Verify confidence values are within [0, 1]."""
        _LOG.info("AUDIT: Checking confidence value bounds...")

        check_result = {
            "name": "confidence_bounds",
            "description": "Confidence values must be in [0, 1]",
            "status": "pass",
            "details": {},
            "invalid_confidence": [],
        }

        try:
            reports = list(
                self.reports_col.find(
                    {},
                    {"interviewId": 1, "confidenceDecision": 1},
                )
            )

            total_reports = len(reports)
            invalid_confidence = []

            for report in reports:
                interview_id = report.get("interviewId")
                confidence = report.get("confidenceDecision", {})

                conf_level = confidence.get("overallConfidenceLevel")

                if conf_level is not None:
                    if not isinstance(conf_level, (int, float)):
                        invalid_confidence.append(
                            {
                                "interviewId": interview_id,
                                "issue": "not_numeric",
                                "value": conf_level,
                            }
                        )
                    elif conf_level < 0 or conf_level > 1:
                        invalid_confidence.append(
                            {
                                "interviewId": interview_id,
                                "issue": "out_of_bounds",
                                "value": conf_level,
                            }
                        )

            check_result["details"] = {
                "total_reports": total_reports,
                "valid_confidence": total_reports - len(invalid_confidence),
                "invalid_confidence_count": len(invalid_confidence),
            }

            check_result["invalid_confidence"] = invalid_confidence[:10]

            if invalid_confidence:
                check_result["status"] = "fail"
                self.results["issues"].append(
                    {
                        "severity": "critical",
                        "check": check_result["name"],
                        "message": f"{len(invalid_confidence)} reports with invalid confidence",
                        "sample": invalid_confidence[:5],
                    }
                )

            _LOG.info(
                f"✓ {check_result['details']['valid_confidence']}/{total_reports} "
                f"reports have valid confidence values"
            )

        except Exception as e:
            check_result["status"] = "error"
            check_result["error"] = str(e)
            _LOG.error(f"✗ Audit failed: {e}")

        return check_result

    def run_all_audits(self) -> Dict[str, Any]:
        """Run all consistency audits."""
        _LOG.info("\n" + "=" * 80)
        _LOG.info("DATA CONSISTENCY AUDIT")
        _LOG.info("=" * 80 + "\n")

        checks = [
            self.audit_completed_jobs_have_reports,
            self.audit_reports_have_required_fields,
            self.audit_audit_logs_exist,
            self.audit_no_orphan_snapshots,
            self.audit_scores_have_evidence,
            self.audit_confidence_bounds,
        ]

        for check_fn in checks:
            result = check_fn()
            self.results["checks"][result["name"]] = result
            self.results["summary"]["total_checks"] += 1

            if result["status"] == "pass":
                self.results["summary"]["passed"] += 1
            elif result["status"] == "warning":
                self.results["summary"]["warnings"] += 1
            elif result["status"] in ["fail", "error"]:
                self.results["summary"]["failed"] += 1

            print()

        self.results["timestamp"] = datetime.now(timezone.utc).isoformat()

        # Print summary
        total = self.results["summary"]["total_checks"]
        passed = self.results["summary"]["passed"]
        warnings = self.results["summary"]["warnings"]
        failed = self.results["summary"]["failed"]

        print("\n" + "=" * 80)
        print("AUDIT SUMMARY")
        print("=" * 80)
        print(f"Total Checks: {total}")
        print(f"Passed: {passed}")
        print(f"Warnings: {warnings}")
        print(f"Failed: {failed}")
        print(f"Issues Found: {len(self.results['issues'])}")
        print("=" * 80)

        if self.results["issues"]:
            print("\nISSUES:")
            for issue in self.results["issues"][:10]:
                print(
                    f"  [{issue['severity'].upper()}] {issue['check']}: {issue['message']}"
                )

        print()

        return self.results


# ─── Main ─────────────────────────────────────────────────────────────────────


def main():
    """Run consistency audit."""
    auditor = ConsistencyAuditor()
    results = auditor.run_all_audits()

    # Save results
    output_file = "tests/results/data_consistency_report.json"
    os.makedirs(os.path.dirname(output_file), exist_ok=True)

    with open(output_file, "w") as f:
        json.dump(results, f, indent=2)

    print(f"✓ Results saved to: {output_file}")


if __name__ == "__main__":
    main()
