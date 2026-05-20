"""Report integrity validator for the interview pipeline.

Validates comprehensive report integrity:
- Every score has evidence
- Evidence IDs exist in evidenceMap
- No hallucinated skills (validate against known skills list)
- No LLM-generated numeric scores in deterministic fields
- Confidence values bounded [0,1]
- Decision labels valid (PASS/FAIL/REVIEW_REQUIRED)
- Metadata versions exist
- Audit hashes valid
"""

import json
import logging
import os
import re
from datetime import datetime, timezone
from typing import Any, Dict

from pymongo import MongoClient

logging.basicConfig(level=logging.INFO)
_LOG = logging.getLogger(__name__)

# ─── Configuration ────────────────────────────────────────────────────────────

MONGO_URL = os.getenv("MONGO_URL", "mongodb://localhost:27017")
MONGO_DB = os.getenv("MONGO_DB_NAME", "ai_recruiter_dev")

# Known valid decision labels
VALID_DECISIONS = {"PASS", "FAIL", "REVIEW_REQUIRED", "PENDING", "INCOMPLETE"}

# Known skill categories (extend this based on your domain)
KNOWN_SKILLS = {
    # Programming languages
    "python",
    "javascript",
    "typescript",
    "java",
    "c++",
    "c#",
    "go",
    "rust",
    "php",
    "ruby",
    "swift",
    "kotlin",
    # Frameworks & Libraries
    "react",
    "angular",
    "vue",
    "node.js",
    "django",
    "flask",
    "spring",
    "express",
    "fastapi",
    # Databases
    "mongodb",
    "postgresql",
    "mysql",
    "redis",
    "elasticsearch",
    # Cloud & DevOps
    "aws",
    "azure",
    "gcp",
    "docker",
    "kubernetes",
    "terraform",
    "jenkins",
    "ci/cd",
    # Soft skills
    "communication",
    "leadership",
    "teamwork",
    "problem-solving",
    "critical thinking",
    "adaptability",
    # Other technical
    "machine learning",
    "data structures",
    "algorithms",
    "rest api",
    "graphql",
    "microservices",
    "testing",
    "debugging",
    "git",
    "agile",
}

# Deterministic fields that should NEVER contain LLM-generated scores
DETERMINISTIC_FIELDS = {
    "overallScore",
    "technicalEvaluation.score",
    "hrEvaluation.score",
    "visionMonitoring.faceVisiblePercent",
    "visionMonitoring.absenceEvents",
    "visionMonitoring.lightingIssues",
    "visionMonitoring.positionIssues",
    "visionMonitoring.multipleFacesDetected",
    "audioAnalysis.longSilenceEvents",
    "audioAnalysis.transcriptionAvailable",
}


# ─── Report Integrity Validator ───────────────────────────────────────────────


class ReportIntegrityValidator:
    """Validate comprehensive report integrity."""

    def __init__(self):
        self.client = MongoClient(MONGO_URL)
        self.db = self.client[MONGO_DB]

        self.reports_col = self.db["interview_final_reports"]
        self.audit_logs_col = self.db["interview_audit_logs"]

        self.results = {
            "timestamp": None,
            "validation_rules": {
                "scores_have_evidence": True,
                "evidence_ids_exist": True,
                "no_hallucinated_skills": True,
                "no_llm_scores_in_deterministic_fields": True,
                "confidence_bounds_valid": True,
                "decision_labels_valid": True,
                "metadata_versions_exist": True,
                "audit_hashes_valid": True,
            },
            "checks": {},
            "violations": [],
            "summary": {
                "total_checks": 0,
                "passed": 0,
                "failed": 0,
                "total_violations": 0,
            },
        }

    def _get_nested_value(self, obj: Dict, path: str) -> Any:
        """Get a nested value from a dict using dot notation."""
        keys = path.split(".")
        value = obj
        for key in keys:
            if isinstance(value, dict):
                value = value.get(key)
            else:
                return None
        return value

    def validate_scores_have_evidence(self) -> Dict[str, Any]:
        """Validate that every score has corresponding evidence."""
        _LOG.info("VALIDATE: Checking scores have evidence...")

        check_result = {
            "name": "scores_have_evidence",
            "description": "Every score must have corresponding evidence",
            "status": "pass",
            "details": {},
            "violations": [],
        }

        try:
            total_reports = 0
            violations = []

            for report in self.reports_col.find():
                total_reports += 1
                interview_id = report.get("interviewId", "unknown")

                # Check technical evaluation
                tech_eval = report.get("technicalEvaluation", {})
                if tech_eval.get("score") is not None:
                    evidence_ids = tech_eval.get("evidenceIds", [])
                    if not evidence_ids:
                        violations.append(
                            {
                                "interview_id": interview_id,
                                "field": "technicalEvaluation.score",
                                "issue": "Score exists but no evidence IDs",
                                "score": tech_eval.get("score"),
                            }
                        )

                # Check HR evaluation
                hr_eval = report.get("hrEvaluation", {})
                if hr_eval.get("score") is not None:
                    evidence_ids = hr_eval.get("evidenceIds", [])
                    if not evidence_ids:
                        violations.append(
                            {
                                "interview_id": interview_id,
                                "field": "hrEvaluation.score",
                                "issue": "Score exists but no evidence IDs",
                                "score": hr_eval.get("score"),
                            }
                        )

            check_result["details"] = {
                "total_reports": total_reports,
                "violations": len(violations),
            }

            check_result["violations"] = violations[:20]  # First 20

            if violations:
                check_result["status"] = "fail"
                self.results["violations"].extend(violations)

            _LOG.info(
                f"✓ Checked {total_reports} reports, found {len(violations)} violations"
            )

        except Exception as e:
            check_result["status"] = "error"
            check_result["error"] = str(e)
            _LOG.error(f"✗ Validation failed: {e}")

        return check_result

    def validate_evidence_ids_exist(self) -> Dict[str, Any]:
        """Validate that all evidence IDs exist in evidenceMap."""
        _LOG.info("VALIDATE: Checking evidence IDs exist...")

        check_result = {
            "name": "evidence_ids_exist",
            "description": "All evidence IDs must exist in evidenceMap",
            "status": "pass",
            "details": {},
            "violations": [],
        }

        try:
            total_reports = 0
            violations = []

            for report in self.reports_col.find():
                total_reports += 1
                interview_id = report.get("interviewId", "unknown")
                evidence_map = report.get("evidenceMap", {})

                # Collect all referenced evidence IDs
                referenced_ids = set()

                # From technical evaluation
                tech_eval = report.get("technicalEvaluation", {})
                referenced_ids.update(tech_eval.get("evidenceIds", []))

                # From HR evaluation
                hr_eval = report.get("hrEvaluation", {})
                referenced_ids.update(hr_eval.get("evidenceIds", []))

                # From decision trace
                decision_trace = report.get("decisionTrace", {})
                reasoning_chain = decision_trace.get("reasoningChain", [])
                for step in reasoning_chain:
                    referenced_ids.update(step.get("evidenceUsed", []))

                # Check each referenced ID exists in evidence map
                for eid in referenced_ids:
                    if eid not in evidence_map:
                        violations.append(
                            {
                                "interview_id": interview_id,
                                "evidence_id": eid,
                                "issue": "Evidence ID referenced but not in evidenceMap",
                            }
                        )

            check_result["details"] = {
                "total_reports": total_reports,
                "violations": len(violations),
            }

            check_result["violations"] = violations[:20]  # First 20

            if violations:
                check_result["status"] = "fail"
                self.results["violations"].extend(violations)

            _LOG.info(
                f"✓ Checked {total_reports} reports, found {len(violations)} violations"
            )

        except Exception as e:
            check_result["status"] = "error"
            check_result["error"] = str(e)
            _LOG.error(f"✗ Validation failed: {e}")

        return check_result

    def validate_no_hallucinated_skills(self) -> Dict[str, Any]:
        """Validate that detected skills are from known skills list."""
        _LOG.info("VALIDATE: Checking for hallucinated skills...")

        check_result = {
            "name": "no_hallucinated_skills",
            "description": "All detected skills should be from known skills list",
            "status": "pass",
            "details": {},
            "violations": [],
        }

        try:
            total_reports = 0
            violations = []
            unknown_skills = set()

            for report in self.reports_col.find():
                total_reports += 1
                interview_id = report.get("interviewId", "unknown")

                # Check detected skills
                tech_eval = report.get("technicalEvaluation", {})
                detected_skills = tech_eval.get("detectedSkills", [])

                for skill in detected_skills:
                    skill_name = skill.get("name", "").lower()
                    # Check if skill is in known skills list (fuzzy match)
                    if skill_name and not any(
                        known_skill in skill_name or skill_name in known_skill
                        for known_skill in KNOWN_SKILLS
                    ):
                        unknown_skills.add(skill_name)
                        violations.append(
                            {
                                "interview_id": interview_id,
                                "skill": skill_name,
                                "issue": "Unknown/hallucinated skill detected",
                            }
                        )

            check_result["details"] = {
                "total_reports": total_reports,
                "violations": len(violations),
                "unique_unknown_skills": len(unknown_skills),
                "unknown_skills_sample": list(unknown_skills)[:10],
            }

            check_result["violations"] = violations[:20]  # First 20

            if violations:
                check_result["status"] = "warning"  # Warning, not fail
                self.results["violations"].extend(violations)

            _LOG.info(
                f"✓ Checked {total_reports} reports, found {len(violations)} potential hallucinations"
            )

        except Exception as e:
            check_result["status"] = "error"
            check_result["error"] = str(e)
            _LOG.error(f"✗ Validation failed: {e}")

        return check_result

    def validate_deterministic_fields(self) -> Dict[str, Any]:
        """Validate that deterministic fields don't contain LLM-generated scores."""
        _LOG.info("VALIDATE: Checking deterministic fields...")

        check_result = {
            "name": "deterministic_fields_valid",
            "description": "Deterministic fields must not contain LLM scores",
            "status": "pass",
            "details": {},
            "violations": [],
        }

        try:
            total_reports = 0
            violations = []

            for report in self.reports_col.find():
                total_reports += 1
                interview_id = report.get("interviewId", "unknown")

                # Check each deterministic field
                for field_path in DETERMINISTIC_FIELDS:
                    value = self._get_nested_value(report, field_path)

                    if value is not None:
                        # Verify it's numeric
                        if not isinstance(value, (int, float, bool)):
                            violations.append(
                                {
                                    "interview_id": interview_id,
                                    "field": field_path,
                                    "value": value,
                                    "issue": "Non-numeric value in deterministic field",
                                }
                            )

            check_result["details"] = {
                "total_reports": total_reports,
                "violations": len(violations),
            }

            check_result["violations"] = violations[:20]  # First 20

            if violations:
                check_result["status"] = "fail"
                self.results["violations"].extend(violations)

            _LOG.info(
                f"✓ Checked {total_reports} reports, found {len(violations)} violations"
            )

        except Exception as e:
            check_result["status"] = "error"
            check_result["error"] = str(e)
            _LOG.error(f"✗ Validation failed: {e}")

        return check_result

    def validate_confidence_bounds(self) -> Dict[str, Any]:
        """Validate that confidence values are bounded [0,1]."""
        _LOG.info("VALIDATE: Checking confidence bounds...")

        check_result = {
            "name": "confidence_bounds",
            "description": "All confidence values must be in [0,1]",
            "status": "pass",
            "details": {},
            "violations": [],
        }

        try:
            total_reports = 0
            violations = []

            for report in self.reports_col.find():
                total_reports += 1
                interview_id = report.get("interviewId", "unknown")

                # Check various confidence fields
                confidence_fields = [
                    ("confidenceDecision.overallConfidence", "Overall confidence"),
                    (
                        "confidenceDecision.technicalConfidence",
                        "Technical confidence",
                    ),
                    ("confidenceDecision.hrConfidence", "HR confidence"),
                    ("confidenceDecision.visionConfidence", "Vision confidence"),
                ]

                for field_path, field_name in confidence_fields:
                    value = self._get_nested_value(report, field_path)

                    if value is not None:
                        if not isinstance(value, (int, float)):
                            violations.append(
                                {
                                    "interview_id": interview_id,
                                    "field": field_path,
                                    "value": value,
                                    "issue": f"{field_name} is not numeric",
                                }
                            )
                        elif not (0 <= value <= 1):
                            violations.append(
                                {
                                    "interview_id": interview_id,
                                    "field": field_path,
                                    "value": value,
                                    "issue": f"{field_name} out of bounds [0,1]",
                                }
                            )

            check_result["details"] = {
                "total_reports": total_reports,
                "violations": len(violations),
            }

            check_result["violations"] = violations[:20]  # First 20

            if violations:
                check_result["status"] = "fail"
                self.results["violations"].extend(violations)

            _LOG.info(
                f"✓ Checked {total_reports} reports, found {len(violations)} violations"
            )

        except Exception as e:
            check_result["status"] = "error"
            check_result["error"] = str(e)
            _LOG.error(f"✗ Validation failed: {e}")

        return check_result

    def validate_decision_labels(self) -> Dict[str, Any]:
        """Validate that decision labels are valid."""
        _LOG.info("VALIDATE: Checking decision labels...")

        check_result = {
            "name": "decision_labels",
            "description": "Decision labels must be valid (PASS/FAIL/REVIEW_REQUIRED)",
            "status": "pass",
            "details": {},
            "violations": [],
        }

        try:
            total_reports = 0
            violations = []

            for report in self.reports_col.find():
                total_reports += 1
                interview_id = report.get("interviewId", "unknown")

                # Check main decision
                decision = report.get("decision")
                if decision and decision not in VALID_DECISIONS:
                    violations.append(
                        {
                            "interview_id": interview_id,
                            "field": "decision",
                            "value": decision,
                            "issue": f"Invalid decision label, must be one of {VALID_DECISIONS}",
                        }
                    )

                # Check decision trace decision
                decision_trace = report.get("decisionTrace", {})
                trace_decision = decision_trace.get("finalDecision")
                if trace_decision and trace_decision not in VALID_DECISIONS:
                    violations.append(
                        {
                            "interview_id": interview_id,
                            "field": "decisionTrace.finalDecision",
                            "value": trace_decision,
                            "issue": f"Invalid decision label, must be one of {VALID_DECISIONS}",
                        }
                    )

            check_result["details"] = {
                "total_reports": total_reports,
                "violations": len(violations),
            }

            check_result["violations"] = violations[:20]  # First 20

            if violations:
                check_result["status"] = "fail"
                self.results["violations"].extend(violations)

            _LOG.info(
                f"✓ Checked {total_reports} reports, found {len(violations)} violations"
            )

        except Exception as e:
            check_result["status"] = "error"
            check_result["error"] = str(e)
            _LOG.error(f"✗ Validation failed: {e}")

        return check_result

    def validate_metadata_versions(self) -> Dict[str, Any]:
        """Validate that metadata versions exist."""
        _LOG.info("VALIDATE: Checking metadata versions...")

        check_result = {
            "name": "metadata_versions",
            "description": "Reports must have valid metadata with versions",
            "status": "pass",
            "details": {},
            "violations": [],
        }

        try:
            total_reports = 0
            violations = []

            for report in self.reports_col.find():
                total_reports += 1
                interview_id = report.get("interviewId", "unknown")

                # Check metadata exists
                metadata = report.get("metadata", {})
                if not metadata:
                    violations.append(
                        {
                            "interview_id": interview_id,
                            "field": "metadata",
                            "issue": "Missing metadata",
                        }
                    )
                    continue

                # Check version exists
                version = metadata.get("version")
                if not version:
                    violations.append(
                        {
                            "interview_id": interview_id,
                            "field": "metadata.version",
                            "issue": "Missing version in metadata",
                        }
                    )

                # Check pipeline version exists
                pipeline_version = metadata.get("pipelineVersion")
                if not pipeline_version:
                    violations.append(
                        {
                            "interview_id": interview_id,
                            "field": "metadata.pipelineVersion",
                            "issue": "Missing pipeline version in metadata",
                        }
                    )

            check_result["details"] = {
                "total_reports": total_reports,
                "violations": len(violations),
            }

            check_result["violations"] = violations[:20]  # First 20

            if violations:
                check_result["status"] = "fail"
                self.results["violations"].extend(violations)

            _LOG.info(
                f"✓ Checked {total_reports} reports, found {len(violations)} violations"
            )

        except Exception as e:
            check_result["status"] = "error"
            check_result["error"] = str(e)
            _LOG.error(f"✗ Validation failed: {e}")

        return check_result

    def validate_audit_hashes(self) -> Dict[str, Any]:
        """Validate that audit hashes are valid (if present)."""
        _LOG.info("VALIDATE: Checking audit hashes...")

        check_result = {
            "name": "audit_hashes",
            "description": "Audit hashes must be valid SHA-256 hashes",
            "status": "pass",
            "details": {},
            "violations": [],
        }

        try:
            total_reports = 0
            violations = []
            hash_pattern = re.compile(r"^[a-f0-9]{64}$", re.IGNORECASE)

            for report in self.reports_col.find():
                total_reports += 1
                interview_id = report.get("interviewId", "unknown")

                # Check audit hash if present
                audit_hash = report.get("auditHash")
                if audit_hash:
                    if not isinstance(audit_hash, str):
                        violations.append(
                            {
                                "interview_id": interview_id,
                                "field": "auditHash",
                                "value": audit_hash,
                                "issue": "Audit hash is not a string",
                            }
                        )
                    elif not hash_pattern.match(audit_hash):
                        violations.append(
                            {
                                "interview_id": interview_id,
                                "field": "auditHash",
                                "value": audit_hash,
                                "issue": "Audit hash is not a valid SHA-256 hash",
                            }
                        )

            check_result["details"] = {
                "total_reports": total_reports,
                "violations": len(violations),
            }

            check_result["violations"] = violations[:20]  # First 20

            if violations:
                check_result["status"] = "fail"
                self.results["violations"].extend(violations)

            _LOG.info(
                f"✓ Checked {total_reports} reports, found {len(violations)} violations"
            )

        except Exception as e:
            check_result["status"] = "error"
            check_result["error"] = str(e)
            _LOG.error(f"✗ Validation failed: {e}")

        return check_result

    def run_all_validations(self) -> Dict[str, Any]:
        """Run all integrity validations."""
        _LOG.info("\n" + "=" * 80)
        _LOG.info("REPORT INTEGRITY VALIDATION")
        _LOG.info("=" * 80 + "\n")

        checks = [
            self.validate_scores_have_evidence,
            self.validate_evidence_ids_exist,
            self.validate_no_hallucinated_skills,
            self.validate_deterministic_fields,
            self.validate_confidence_bounds,
            self.validate_decision_labels,
            self.validate_metadata_versions,
            self.validate_audit_hashes,
        ]

        for check_fn in checks:
            result = check_fn()
            self.results["checks"][result["name"]] = result
            self.results["summary"]["total_checks"] += 1

            if result["status"] == "pass":
                self.results["summary"]["passed"] += 1
            else:
                self.results["summary"]["failed"] += 1

            print()

        self.results["timestamp"] = datetime.now(timezone.utc).isoformat()
        self.results["summary"]["total_violations"] = len(self.results["violations"])

        # Print summary
        print("\n" + "=" * 80)
        print("INTEGRITY VALIDATION SUMMARY")
        print("=" * 80)
        print(f"Total Checks: {self.results['summary']['total_checks']}")
        print(f"Passed: {self.results['summary']['passed']}")
        print(f"Failed: {self.results['summary']['failed']}")
        print(f"Total Violations: {self.results['summary']['total_violations']}")
        print("=" * 80)

        if self.results["violations"]:
            print("\nVIOLATIONS FOUND:")
            for i, violation in enumerate(self.results["violations"][:15], 1):
                print(f"\n  {i}. Interview: {violation.get('interview_id')}")
                if "field" in violation:
                    print(f"     Field: {violation['field']}")
                print(f"     Issue: {violation['issue']}")
                if "value" in violation:
                    print(f"     Value: {violation['value']}")

        print()

        return self.results


# ─── Main ─────────────────────────────────────────────────────────────────────


def main():
    """Run integrity validation."""
    validator = ReportIntegrityValidator()
    results = validator.run_all_validations()

    # Save results
    output_file = "tests/results/report_integrity_report.json"
    os.makedirs(os.path.dirname(output_file), exist_ok=True)

    with open(output_file, "w") as f:
        json.dump(results, f, indent=2)

    print(f"✓ Results saved to: {output_file}")


if __name__ == "__main__":
    main()
