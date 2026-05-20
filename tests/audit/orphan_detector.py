"""Orphan data detector for the interview pipeline.

Detects orphaned/dangling references across collections:
- Snapshots without corresponding jobs
- Reports without corresponding jobs
- Audit logs without corresponding reports
- Vision events without corresponding interviews
- Suggests cleanup actions for orphaned data
"""

import json
import logging
import os
from datetime import datetime, timezone
from typing import Any, Dict

from pymongo import MongoClient

logging.basicConfig(level=logging.INFO)
_LOG = logging.getLogger(__name__)

# ─── Configuration ────────────────────────────────────────────────────────────

MONGO_URL = os.getenv("MONGO_URL", "mongodb://localhost:27017")
MONGO_DB = os.getenv("MONGO_DB_NAME", "ai_recruiter_dev")


# ─── Orphan Detector ──────────────────────────────────────────────────────────


class OrphanDetector:
    """Detect orphaned data across collections."""

    def __init__(self):
        self.client = MongoClient(MONGO_URL)
        self.db = self.client[MONGO_DB]

        self.jobs_col = self.db["video_analysis_jobs"]
        self.reports_col = self.db["interview_final_reports"]
        self.snapshots_col = self.db["interview_pipeline_snapshots"]
        self.audit_logs_col = self.db["interview_audit_logs"]
        self.vision_events_col = self.db["post_interview_vision_events"]
        self.call_rooms_col = self.db["callrooms"]

        self.results = {
            "timestamp": None,
            "checks": {},
            "orphans_detected": [],
            "cleanup_suggestions": [],
            "summary": {
                "total_checks": 0,
                "orphans_found": 0,
                "total_orphaned_records": 0,
            },
        }

    def detect_orphan_snapshots(self) -> Dict[str, Any]:
        """Find snapshots without corresponding jobs."""
        _LOG.info("DETECT: Finding orphan snapshots...")

        check_result = {
            "name": "orphan_snapshots",
            "description": "Snapshots without corresponding jobs",
            "orphans": [],
            "details": {},
        }

        try:
            # Get all unique interviewIds from jobs
            job_ids = set()
            for job in self.jobs_col.find({}, {"interviewId": 1}):
                job_ids.add(job.get("interviewId"))

            # Find snapshots with interviewIds not in jobs
            orphan_snapshots = []
            total_snapshots = 0

            for snapshot in self.snapshots_col.find(
                {}, {"interviewId": 1, "createdAt": 1, "version": 1}
            ):
                total_snapshots += 1
                interview_id = snapshot.get("interviewId")

                if interview_id and interview_id not in job_ids:
                    orphan_snapshots.append(
                        {
                            "_id": str(snapshot.get("_id")),
                            "interviewId": interview_id,
                            "createdAt": snapshot.get("createdAt"),
                            "version": snapshot.get("version"),
                        }
                    )

            check_result["details"] = {
                "total_snapshots": total_snapshots,
                "valid_snapshots": total_snapshots - len(orphan_snapshots),
                "orphan_count": len(orphan_snapshots),
            }

            check_result["orphans"] = orphan_snapshots[:20]  # First 20

            if orphan_snapshots:
                self.results["orphans_detected"].append(
                    {
                        "type": "snapshots",
                        "count": len(orphan_snapshots),
                        "severity": "medium",
                        "message": f"Found {len(orphan_snapshots)} snapshots without jobs",
                    }
                )

                # Add cleanup suggestion
                self.results["cleanup_suggestions"].append(
                    {
                        "collection": "interview_pipeline_snapshots",
                        "action": "delete",
                        "criteria": "interviewId not in jobs collection",
                        "affected_count": len(orphan_snapshots),
                        "risk": "low",
                        "command_example": f"db.interview_pipeline_snapshots.deleteMany({{ interviewId: {{ $in: {orphan_snapshots[:5]} }} }})",
                    }
                )

            _LOG.info(
                f"✓ Found {len(orphan_snapshots)}/{total_snapshots} orphan snapshots"
            )

        except Exception as e:
            check_result["error"] = str(e)
            _LOG.error(f"✗ Detection failed: {e}")

        return check_result

    def detect_orphan_reports(self) -> Dict[str, Any]:
        """Find reports without corresponding jobs."""
        _LOG.info("DETECT: Finding orphan reports...")

        check_result = {
            "name": "orphan_reports",
            "description": "Reports without corresponding jobs",
            "orphans": [],
            "details": {},
        }

        try:
            # Get all unique interviewIds from jobs
            job_ids = set()
            for job in self.jobs_col.find({}, {"interviewId": 1}):
                job_ids.add(job.get("interviewId"))

            # Find reports with interviewIds not in jobs
            orphan_reports = []
            total_reports = 0

            for report in self.reports_col.find(
                {}, {"interviewId": 1, "createdAt": 1, "overallScore": 1}
            ):
                total_reports += 1
                interview_id = report.get("interviewId")

                if interview_id and interview_id not in job_ids:
                    orphan_reports.append(
                        {
                            "_id": str(report.get("_id")),
                            "interviewId": interview_id,
                            "createdAt": report.get("createdAt"),
                            "overallScore": report.get("overallScore"),
                        }
                    )

            check_result["details"] = {
                "total_reports": total_reports,
                "valid_reports": total_reports - len(orphan_reports),
                "orphan_count": len(orphan_reports),
            }

            check_result["orphans"] = orphan_reports[:20]  # First 20

            if orphan_reports:
                self.results["orphans_detected"].append(
                    {
                        "type": "reports",
                        "count": len(orphan_reports),
                        "severity": "high",
                        "message": f"Found {len(orphan_reports)} reports without jobs",
                    }
                )

                # Add cleanup suggestion
                self.results["cleanup_suggestions"].append(
                    {
                        "collection": "interview_final_reports",
                        "action": "archive_then_delete",
                        "criteria": "interviewId not in jobs collection",
                        "affected_count": len(orphan_reports),
                        "risk": "high",
                        "recommendation": "Archive reports before deletion - they may contain valuable data",
                    }
                )

            _LOG.info(f"✓ Found {len(orphan_reports)}/{total_reports} orphan reports")

        except Exception as e:
            check_result["error"] = str(e)
            _LOG.error(f"✗ Detection failed: {e}")

        return check_result

    def detect_orphan_audit_logs(self) -> Dict[str, Any]:
        """Find audit logs without corresponding reports."""
        _LOG.info("DETECT: Finding orphan audit logs...")

        check_result = {
            "name": "orphan_audit_logs",
            "description": "Audit logs without corresponding reports",
            "orphans": [],
            "details": {},
        }

        try:
            # Get all unique interviewIds from reports
            report_ids = set()
            for report in self.reports_col.find({}, {"interviewId": 1}):
                report_ids.add(report.get("interviewId"))

            # Find audit logs with interviewIds not in reports
            orphan_logs = []
            total_logs = 0

            for log in self.audit_logs_col.find(
                {}, {"interviewId": 1, "timestamp": 1, "action": 1}
            ):
                total_logs += 1
                interview_id = log.get("interviewId")

                if interview_id and interview_id not in report_ids:
                    orphan_logs.append(
                        {
                            "_id": str(log.get("_id")),
                            "interviewId": interview_id,
                            "timestamp": log.get("timestamp"),
                            "action": log.get("action"),
                        }
                    )

            check_result["details"] = {
                "total_logs": total_logs,
                "valid_logs": total_logs - len(orphan_logs),
                "orphan_count": len(orphan_logs),
            }

            check_result["orphans"] = orphan_logs[:20]  # First 20

            if orphan_logs:
                self.results["orphans_detected"].append(
                    {
                        "type": "audit_logs",
                        "count": len(orphan_logs),
                        "severity": "medium",
                        "message": f"Found {len(orphan_logs)} audit logs without reports",
                    }
                )

                # Add cleanup suggestion
                self.results["cleanup_suggestions"].append(
                    {
                        "collection": "interview_audit_logs",
                        "action": "delete",
                        "criteria": "interviewId not in reports collection",
                        "affected_count": len(orphan_logs),
                        "risk": "low",
                        "note": "Audit logs without reports are safe to delete",
                    }
                )

            _LOG.info(f"✓ Found {len(orphan_logs)}/{total_logs} orphan audit logs")

        except Exception as e:
            check_result["error"] = str(e)
            _LOG.error(f"✗ Detection failed: {e}")

        return check_result

    def detect_orphan_vision_events(self) -> Dict[str, Any]:
        """Find vision events without corresponding interviews."""
        _LOG.info("DETECT: Finding orphan vision events...")

        check_result = {
            "name": "orphan_vision_events",
            "description": "Vision events without corresponding interviews",
            "orphans": [],
            "details": {},
        }

        try:
            # Get all unique interviewIds from jobs and call rooms
            valid_ids = set()

            for job in self.jobs_col.find({}, {"interviewId": 1}):
                valid_ids.add(job.get("interviewId"))

            for room in self.call_rooms_col.find({}, {"_id": 1, "roomId": 1}):
                valid_ids.add(str(room.get("_id")))
                if room.get("roomId"):
                    valid_ids.add(room.get("roomId"))

            # Find vision events with interviewIds not in valid set
            orphan_events = []
            total_events = 0

            for event in self.vision_events_col.find(
                {}, {"interviewId": 1, "timestamp": 1, "eventType": 1}
            ):
                total_events += 1
                interview_id = event.get("interviewId")

                if interview_id and interview_id not in valid_ids:
                    orphan_events.append(
                        {
                            "_id": str(event.get("_id")),
                            "interviewId": interview_id,
                            "timestamp": event.get("timestamp"),
                            "eventType": event.get("eventType"),
                        }
                    )

            check_result["details"] = {
                "total_events": total_events,
                "valid_events": total_events - len(orphan_events),
                "orphan_count": len(orphan_events),
            }

            check_result["orphans"] = orphan_events[:20]  # First 20

            if orphan_events:
                self.results["orphans_detected"].append(
                    {
                        "type": "vision_events",
                        "count": len(orphan_events),
                        "severity": "low",
                        "message": f"Found {len(orphan_events)} vision events without interviews",
                    }
                )

                # Add cleanup suggestion
                self.results["cleanup_suggestions"].append(
                    {
                        "collection": "post_interview_vision_events",
                        "action": "delete",
                        "criteria": "interviewId not in jobs or callrooms",
                        "affected_count": len(orphan_events),
                        "risk": "low",
                        "note": "Vision events without parent interviews are safe to delete",
                    }
                )

            _LOG.info(
                f"✓ Found {len(orphan_events)}/{total_events} orphan vision events"
            )

        except Exception as e:
            check_result["error"] = str(e)
            _LOG.error(f"✗ Detection failed: {e}")

        return check_result

    def detect_orphan_transcripts(self) -> Dict[str, Any]:
        """Find transcripts without corresponding jobs."""
        _LOG.info("DETECT: Finding orphan transcripts...")

        check_result = {
            "name": "orphan_transcripts",
            "description": "Transcripts without corresponding jobs",
            "orphans": [],
            "details": {},
        }

        try:
            transcripts_col = self.db["interview_transcripts"]

            # Get all unique interviewIds from jobs
            job_ids = set()
            for job in self.jobs_col.find({}, {"interviewId": 1}):
                job_ids.add(job.get("interviewId"))

            # Find transcripts with interviewIds not in jobs
            orphan_transcripts = []
            total_transcripts = 0

            for transcript in transcripts_col.find(
                {}, {"interviewId": 1, "createdAt": 1}
            ):
                total_transcripts += 1
                interview_id = transcript.get("interviewId")

                if interview_id and interview_id not in job_ids:
                    orphan_transcripts.append(
                        {
                            "_id": str(transcript.get("_id")),
                            "interviewId": interview_id,
                            "createdAt": transcript.get("createdAt"),
                        }
                    )

            check_result["details"] = {
                "total_transcripts": total_transcripts,
                "valid_transcripts": total_transcripts - len(orphan_transcripts),
                "orphan_count": len(orphan_transcripts),
            }

            check_result["orphans"] = orphan_transcripts[:20]  # First 20

            if orphan_transcripts:
                self.results["orphans_detected"].append(
                    {
                        "type": "transcripts",
                        "count": len(orphan_transcripts),
                        "severity": "medium",
                        "message": f"Found {len(orphan_transcripts)} transcripts without jobs",
                    }
                )

                # Add cleanup suggestion
                self.results["cleanup_suggestions"].append(
                    {
                        "collection": "interview_transcripts",
                        "action": "archive_then_delete",
                        "criteria": "interviewId not in jobs collection",
                        "affected_count": len(orphan_transcripts),
                        "risk": "medium",
                        "recommendation": "Archive transcripts before deletion - they contain source data",
                    }
                )

            _LOG.info(
                f"✓ Found {len(orphan_transcripts)}/{total_transcripts} orphan transcripts"
            )

        except Exception as e:
            check_result["error"] = str(e)
            _LOG.error(f"✗ Detection failed: {e}")

        return check_result

    def run_all_detections(self) -> Dict[str, Any]:
        """Run all orphan detection checks."""
        _LOG.info("\n" + "=" * 80)
        _LOG.info("ORPHAN DATA DETECTION")
        _LOG.info("=" * 80 + "\n")

        checks = [
            self.detect_orphan_snapshots,
            self.detect_orphan_reports,
            self.detect_orphan_audit_logs,
            self.detect_orphan_vision_events,
            self.detect_orphan_transcripts,
        ]

        total_orphans = 0

        for check_fn in checks:
            result = check_fn()
            self.results["checks"][result["name"]] = result
            self.results["summary"]["total_checks"] += 1

            orphan_count = result.get("details", {}).get("orphan_count", 0)
            total_orphans += orphan_count

            print()

        self.results["timestamp"] = datetime.now(timezone.utc).isoformat()
        self.results["summary"]["orphans_found"] = len(self.results["orphans_detected"])
        self.results["summary"]["total_orphaned_records"] = total_orphans

        # Print summary
        print("\n" + "=" * 80)
        print("ORPHAN DETECTION SUMMARY")
        print("=" * 80)
        print(f"Total Checks: {self.results['summary']['total_checks']}")
        print(f"Orphan Types Found: {self.results['summary']['orphans_found']}")
        print(
            f"Total Orphaned Records: {self.results['summary']['total_orphaned_records']}"
        )
        print(f"Cleanup Suggestions: {len(self.results['cleanup_suggestions'])}")
        print("=" * 80)

        if self.results["orphans_detected"]:
            print("\nORPHANS DETECTED:")
            for orphan in self.results["orphans_detected"]:
                severity_label = f"[{orphan['severity'].upper()}]"
                print(
                    f"  {severity_label:10} {orphan['type']:20} - {orphan['message']}"
                )

        if self.results["cleanup_suggestions"]:
            print("\nCLEANUP SUGGESTIONS:")
            for i, suggestion in enumerate(self.results["cleanup_suggestions"], 1):
                print(f"\n  {i}. Collection: {suggestion['collection']}")
                print(f"     Action: {suggestion['action']}")
                print(f"     Affected: {suggestion['affected_count']} records")
                print(f"     Risk: {suggestion['risk']}")
                if "recommendation" in suggestion:
                    print(f"     Recommendation: {suggestion['recommendation']}")

        print()

        return self.results


# ─── Main ─────────────────────────────────────────────────────────────────────


def main():
    """Run orphan detection."""
    detector = OrphanDetector()
    results = detector.run_all_detections()

    # Save results
    output_file = "tests/results/orphan_detection_report.json"
    os.makedirs(os.path.dirname(output_file), exist_ok=True)

    with open(output_file, "w") as f:
        json.dump(results, f, indent=2)

    print(f"✓ Results saved to: {output_file}")


if __name__ == "__main__":
    main()
