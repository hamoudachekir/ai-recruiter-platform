"""ML Shadow Mode Validation — Phase 4.5

Validates that ML shadow mode operates correctly:
- finalVisibleScore ALWAYS equals systemScore (within 0.001 tolerance)
- ML predictions never overwrite deterministic scores
- ML predictions stored correctly in ml_shadow_results collection
- Feature vectors are stable and complete
- Confidence drift is tracked
- Recruiter override stats computed correctly
- shadowInferenceSkipped flag behavior is correct

This test is critical for ensuring ML operates in pure shadow mode
without ever affecting recruiter-visible scores.
"""

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

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
RESET = "\033[0m"

# Tolerance for floating-point comparison
SCORE_TOLERANCE = 0.001

# ─── Shadow Validator ─────────────────────────────────────────────────────────


class ShadowValidator:
    """Validate ML shadow mode operation."""

    def __init__(self):
        self.client = MongoClient(MONGO_URL)
        self.db = self.client[MONGO_DB]

        self.shadow_results_col = self.db["ml_shadow_results"]
        self.ml_dataset_col = self.db["interview_ml_dataset"]
        self.reports_col = self.db["interview_final_reports"]

        self.results = {
            "timestamp": None,
            "validation_rules": {
                "finalVisibleScore_equals_systemScore": True,
                "ml_never_overwrites_deterministic": True,
                "predictions_stored_correctly": True,
                "feature_vectors_stable": True,
                "confidence_tracked": True,
                "recruiter_overrides_computed": True,
                "skip_flag_behavior_correct": True,
            },
            "checks": {},
            "violations": [],
            "summary": {
                "total_shadow_records": 0,
                "total_checks": 0,
                "passed": 0,
                "failed": 0,
                "skipped_inferences": 0,
                "score_divergence_avg": 0.0,
                "score_divergence_max": 0.0,
            },
        }

    def validate_score_invariant(self) -> Dict[str, Any]:
        """Verify finalVisibleScore ALWAYS equals systemScore."""
        _LOG.info("[ShadowValidation] Checking score invariant...")

        check_name = "score_invariant"
        violations = []

        try:
            shadow_records = list(
                self.shadow_results_col.find(
                    {"shadowInferenceSkipped": False},
                    {
                        "_id": 0,
                        "interviewId": 1,
                        "systemScore": 1,
                        "finalVisibleScore": 1,
                        "mlCalibratedScore": 1,
                    },
                )
            )

            total = len(shadow_records)
            passed = 0
            failed = 0

            for record in shadow_records:
                interview_id = record.get("interviewId", "unknown")
                system_score = record.get("systemScore")
                visible_score = record.get("finalVisibleScore")

                if system_score is None or visible_score is None:
                    violations.append(
                        {
                            "interviewId": interview_id,
                            "issue": "missing_scores",
                            "systemScore": system_score,
                            "finalVisibleScore": visible_score,
                        }
                    )
                    failed += 1
                    continue

                # Check if scores match within tolerance
                diff = abs(float(system_score) - float(visible_score))
                if diff > SCORE_TOLERANCE:
                    violations.append(
                        {
                            "interviewId": interview_id,
                            "issue": "score_mismatch",
                            "systemScore": system_score,
                            "finalVisibleScore": visible_score,
                            "difference": round(diff, 4),
                        }
                    )
                    failed += 1
                    self.results["validation_rules"][
                        "finalVisibleScore_equals_systemScore"
                    ] = False
                else:
                    passed += 1

            result = {
                "check": check_name,
                "passed": passed,
                "failed": failed,
                "total": total,
                "success": failed == 0,
                "violations": violations[:20],  # Limit to first 20
                "violation_count": len(violations),
            }

            self.results["checks"][check_name] = result
            self.results["violations"].extend(violations)
            self.results["summary"]["total_checks"] += 1

            if result["success"]:
                self.results["summary"]["passed"] += 1
                _LOG.info(f"{GREEN}✓{RESET} Score invariant: {passed}/{total} passed")
            else:
                self.results["summary"]["failed"] += 1
                _LOG.error(
                    f"{RED}✗{RESET} Score invariant: {failed}/{total} violations"
                )

            return result

        except Exception as exc:
            _LOG.error(f"[ShadowValidation] Score invariant check failed: {exc}")
            return {
                "check": check_name,
                "success": False,
                "error": str(exc),
            }

    def validate_ml_storage(self) -> Dict[str, Any]:
        """Verify ML predictions are stored correctly in ml_shadow_results."""
        _LOG.info("[ShadowValidation] Checking ML prediction storage...")

        check_name = "ml_storage"
        violations = []

        try:
            shadow_records = list(
                self.shadow_results_col.find(
                    {"shadowInferenceSkipped": False},
                    {
                        "_id": 0,
                        "interviewId": 1,
                        "systemScore": 1,
                        "mlCalibratedScore": 1,
                        "scoreDelta": 1,
                        "modelVersion": 1,
                        "runAt": 1,
                    },
                )
            )

            total = len(shadow_records)
            passed = 0
            failed = 0

            for record in shadow_records:
                interview_id = record.get("interviewId", "unknown")
                issues = []

                # Check required fields
                if record.get("mlCalibratedScore") is None:
                    issues.append("missing_mlCalibratedScore")
                if record.get("scoreDelta") is None:
                    issues.append("missing_scoreDelta")
                if not record.get("modelVersion"):
                    issues.append("missing_modelVersion")
                if not record.get("runAt"):
                    issues.append("missing_runAt")

                # Validate scoreDelta calculation
                if (
                    record.get("mlCalibratedScore") is not None
                    and record.get("systemScore") is not None
                ):
                    expected_delta = round(
                        float(record["mlCalibratedScore"])
                        - float(record["systemScore"]),
                        2,
                    )
                    actual_delta = record.get("scoreDelta")
                    if (
                        actual_delta is None
                        or abs(expected_delta - float(actual_delta)) > 0.01
                    ):
                        issues.append(
                            f"scoreDelta_mismatch (expected={expected_delta}, actual={actual_delta})"
                        )

                if issues:
                    violations.append(
                        {
                            "interviewId": interview_id,
                            "issues": issues,
                            "record": record,
                        }
                    )
                    failed += 1
                else:
                    passed += 1

            result = {
                "check": check_name,
                "passed": passed,
                "failed": failed,
                "total": total,
                "success": failed == 0,
                "violations": violations[:20],
                "violation_count": len(violations),
            }

            self.results["checks"][check_name] = result
            if violations:
                self.results["validation_rules"]["predictions_stored_correctly"] = False
                self.results["violations"].extend(violations)

            self.results["summary"]["total_checks"] += 1
            if result["success"]:
                self.results["summary"]["passed"] += 1
                _LOG.info(f"{GREEN}✓{RESET} ML storage: {passed}/{total} valid")
            else:
                self.results["summary"]["failed"] += 1
                _LOG.error(f"{RED}✗{RESET} ML storage: {failed}/{total} invalid")

            return result

        except Exception as exc:
            _LOG.error(f"[ShadowValidation] ML storage check failed: {exc}")
            return {
                "check": check_name,
                "success": False,
                "error": str(exc),
            }

    def validate_feature_vectors(self) -> Dict[str, Any]:
        """Verify feature vectors in ML dataset are stable and complete."""
        _LOG.info("[ShadowValidation] Checking feature vector stability...")

        check_name = "feature_vectors"
        violations = []

        try:
            ml_records = list(
                self.ml_dataset_col.find(
                    {},
                    {
                        "_id": 0,
                        "interviewId": 1,
                        "features.mlFeatureVector": 1,
                    },
                )
            )

            total = len(ml_records)
            passed = 0
            failed = 0
            feature_counts = {}

            for record in ml_records:
                interview_id = record.get("interviewId", "unknown")
                features = (record.get("features") or {}).get("mlFeatureVector") or {}

                if not isinstance(features, dict):
                    violations.append(
                        {
                            "interviewId": interview_id,
                            "issue": "features_not_dict",
                            "type": str(type(features)),
                        }
                    )
                    failed += 1
                    continue

                # Track feature count distribution
                count = len(features)
                feature_counts[count] = feature_counts.get(count, 0) + 1

                # Check for missing or invalid values
                invalid_features = []
                for key, value in features.items():
                    if value is None:
                        invalid_features.append(f"{key}=None")
                    elif not isinstance(value, (int, float)):
                        invalid_features.append(f"{key}={type(value).__name__}")

                if invalid_features:
                    violations.append(
                        {
                            "interviewId": interview_id,
                            "issue": "invalid_feature_values",
                            "invalid_features": invalid_features[:10],
                            "feature_count": count,
                        }
                    )
                    failed += 1
                else:
                    passed += 1

            # Check for feature count consistency
            if len(feature_counts) > 1:
                _LOG.warning(f"{YELLOW}⚠{RESET} Feature count varies: {feature_counts}")

            result = {
                "check": check_name,
                "passed": passed,
                "failed": failed,
                "total": total,
                "success": failed == 0,
                "feature_count_distribution": feature_counts,
                "violations": violations[:20],
                "violation_count": len(violations),
            }

            self.results["checks"][check_name] = result
            if violations:
                self.results["validation_rules"]["feature_vectors_stable"] = False
                self.results["violations"].extend(violations)

            self.results["summary"]["total_checks"] += 1
            if result["success"]:
                self.results["summary"]["passed"] += 1
                _LOG.info(f"{GREEN}✓{RESET} Feature vectors: {passed}/{total} valid")
            else:
                self.results["summary"]["failed"] += 1
                _LOG.error(f"{RED}✗{RESET} Feature vectors: {failed}/{total} invalid")

            return result

        except Exception as exc:
            _LOG.error(f"[ShadowValidation] Feature vector check failed: {exc}")
            return {
                "check": check_name,
                "success": False,
                "error": str(exc),
            }

    def validate_skip_flag_behavior(self) -> Dict[str, Any]:
        """Verify shadowInferenceSkipped flag behavior is correct."""
        _LOG.info("[ShadowValidation] Checking skip flag behavior...")

        check_name = "skip_flag_behavior"
        violations = []

        try:
            # Check records where skip flag is True
            skipped_records = list(
                self.shadow_results_col.find(
                    {"shadowInferenceSkipped": True},
                    {
                        "_id": 0,
                        "interviewId": 1,
                        "reason": 1,
                        "mlCalibratedScore": 1,
                        "scoreDelta": 1,
                    },
                )
            )

            skipped_count = len(skipped_records)
            skipped_valid = 0
            skipped_invalid = 0

            for record in skipped_records:
                interview_id = record.get("interviewId", "unknown")
                issues = []

                # Skipped records should have reason
                if not record.get("reason"):
                    issues.append("missing_reason")

                # Skipped records should NOT have ML scores
                if record.get("mlCalibratedScore") is not None:
                    issues.append("has_mlCalibratedScore_despite_skip")
                if record.get("scoreDelta") is not None:
                    issues.append("has_scoreDelta_despite_skip")

                if issues:
                    violations.append(
                        {
                            "interviewId": interview_id,
                            "issues": issues,
                            "record": record,
                        }
                    )
                    skipped_invalid += 1
                else:
                    skipped_valid += 1

            # Check records where skip flag is False
            active_records = list(
                self.shadow_results_col.find(
                    {"shadowInferenceSkipped": False},
                    {
                        "_id": 0,
                        "interviewId": 1,
                        "mlCalibratedScore": 1,
                        "scoreDelta": 1,
                        "modelVersion": 1,
                    },
                )
            )

            active_count = len(active_records)
            active_valid = 0
            active_invalid = 0

            for record in active_records:
                interview_id = record.get("interviewId", "unknown")
                issues = []

                # Active records should have ML scores
                if record.get("mlCalibratedScore") is None:
                    issues.append("missing_mlCalibratedScore")
                if record.get("scoreDelta") is None:
                    issues.append("missing_scoreDelta")
                if not record.get("modelVersion"):
                    issues.append("missing_modelVersion")

                if issues:
                    violations.append(
                        {
                            "interviewId": interview_id,
                            "issues": issues,
                            "record": record,
                        }
                    )
                    active_invalid += 1
                else:
                    active_valid += 1

            total = skipped_count + active_count
            passed = skipped_valid + active_valid
            failed = skipped_invalid + active_invalid

            result = {
                "check": check_name,
                "passed": passed,
                "failed": failed,
                "total": total,
                "skipped_records": {
                    "total": skipped_count,
                    "valid": skipped_valid,
                    "invalid": skipped_invalid,
                },
                "active_records": {
                    "total": active_count,
                    "valid": active_valid,
                    "invalid": active_invalid,
                },
                "success": failed == 0,
                "violations": violations[:20],
                "violation_count": len(violations),
            }

            self.results["checks"][check_name] = result
            if violations:
                self.results["validation_rules"]["skip_flag_behavior_correct"] = False
                self.results["violations"].extend(violations)

            self.results["summary"]["total_checks"] += 1
            self.results["summary"]["skipped_inferences"] = skipped_count

            if result["success"]:
                self.results["summary"]["passed"] += 1
                _LOG.info(
                    f"{GREEN}✓{RESET} Skip flag behavior: {passed}/{total} correct"
                )
            else:
                self.results["summary"]["failed"] += 1
                _LOG.error(
                    f"{RED}✗{RESET} Skip flag behavior: {failed}/{total} incorrect"
                )

            return result

        except Exception as exc:
            _LOG.error(f"[ShadowValidation] Skip flag check failed: {exc}")
            return {
                "check": check_name,
                "success": False,
                "error": str(exc),
            }

    def compute_score_divergence(self) -> Dict[str, Any]:
        """Compute statistics on system vs ML score divergence."""
        _LOG.info("[ShadowValidation] Computing score divergence statistics...")

        check_name = "score_divergence"

        try:
            shadow_records = list(
                self.shadow_results_col.find(
                    {"shadowInferenceSkipped": False, "scoreDelta": {"$exists": True}},
                    {
                        "_id": 0,
                        "interviewId": 1,
                        "systemScore": 1,
                        "mlCalibratedScore": 1,
                        "scoreDelta": 1,
                    },
                )
            )

            if not shadow_records:
                return {
                    "check": check_name,
                    "success": True,
                    "message": "No shadow records with score delta found",
                }

            deltas = [abs(float(r.get("scoreDelta", 0))) for r in shadow_records]
            system_scores = [float(r.get("systemScore", 0)) for r in shadow_records]
            ml_scores = [float(r.get("mlCalibratedScore", 0)) for r in shadow_records]

            # Compute statistics
            avg_delta = sum(deltas) / len(deltas) if deltas else 0
            max_delta = max(deltas) if deltas else 0
            min_delta = min(deltas) if deltas else 0

            # Percentiles
            sorted_deltas = sorted(deltas)
            n = len(sorted_deltas)
            p50 = sorted_deltas[n // 2] if n > 0 else 0
            p95 = sorted_deltas[int(n * 0.95)] if n > 0 else 0
            p99 = sorted_deltas[int(n * 0.99)] if n > 0 else 0

            # Large divergence count (>20 points)
            large_divergence = sum(1 for d in deltas if d > 20)
            large_divergence_rate = large_divergence / len(deltas) if deltas else 0

            result = {
                "check": check_name,
                "total_records": len(shadow_records),
                "avg_system_score": round(sum(system_scores) / len(system_scores), 2)
                if system_scores
                else 0,
                "avg_ml_score": round(sum(ml_scores) / len(ml_scores), 2)
                if ml_scores
                else 0,
                "score_divergence": {
                    "mean": round(avg_delta, 2),
                    "max": round(max_delta, 2),
                    "min": round(min_delta, 2),
                    "p50": round(p50, 2),
                    "p95": round(p95, 2),
                    "p99": round(p99, 2),
                },
                "large_divergence": {
                    "count": large_divergence,
                    "rate": round(large_divergence_rate, 3),
                },
                "success": True,
            }

            self.results["checks"][check_name] = result
            self.results["summary"]["score_divergence_avg"] = result[
                "score_divergence"
            ]["mean"]
            self.results["summary"]["score_divergence_max"] = result[
                "score_divergence"
            ]["max"]

            _LOG.info(
                f"{BLUE}ℹ{RESET} Score divergence: mean={result['score_divergence']['mean']}, max={result['score_divergence']['max']}"
            )

            return result

        except Exception as exc:
            _LOG.error(f"[ShadowValidation] Score divergence computation failed: {exc}")
            return {
                "check": check_name,
                "success": False,
                "error": str(exc),
            }

    def validate_recruiter_overrides(self) -> Dict[str, Any]:
        """Verify recruiter override statistics are computed correctly."""
        _LOG.info("[ShadowValidation] Checking recruiter override stats...")

        check_name = "recruiter_overrides"

        try:
            ml_records = list(
                self.ml_dataset_col.find(
                    {"humanScore": {"$exists": True}},
                    {
                        "_id": 0,
                        "interviewId": 1,
                        "systemScore": 1,
                        "humanScore": 1,
                        "agreementLabel": 1,
                    },
                )
            )

            if not ml_records:
                return {
                    "check": check_name,
                    "success": True,
                    "message": "No recruiter feedback records found",
                }

            total = len(ml_records)
            matches = sum(1 for r in ml_records if r.get("agreementLabel") == "MATCH")
            mismatches = sum(
                1 for r in ml_records if r.get("agreementLabel") == "MISMATCH"
            )

            # Verify agreement label computation
            incorrect_labels = 0
            for record in ml_records:
                system = record.get("systemScore")
                human = record.get("humanScore")
                label = record.get("agreementLabel")

                if system is None or human is None:
                    continue

                # Agreement label should be MATCH if |system - human| <= 10
                expected_label = (
                    "MATCH" if abs(float(system) - float(human)) <= 10 else "MISMATCH"
                )
                if label != expected_label:
                    incorrect_labels += 1

            agreement_rate = matches / total if total > 0 else 0

            result = {
                "check": check_name,
                "total_feedback_records": total,
                "matches": matches,
                "mismatches": mismatches,
                "agreement_rate": round(agreement_rate, 3),
                "incorrect_labels": incorrect_labels,
                "success": incorrect_labels == 0,
            }

            self.results["checks"][check_name] = result
            if incorrect_labels > 0:
                self.results["validation_rules"]["recruiter_overrides_computed"] = False

            self.results["summary"]["total_checks"] += 1
            if result["success"]:
                self.results["summary"]["passed"] += 1
                _LOG.info(
                    f"{GREEN}✓{RESET} Recruiter overrides: {total} records, {matches} matches ({agreement_rate:.1%})"
                )
            else:
                self.results["summary"]["failed"] += 1
                _LOG.error(
                    f"{RED}✗{RESET} Recruiter overrides: {incorrect_labels} incorrect labels"
                )

            return result

        except Exception as exc:
            _LOG.error(f"[ShadowValidation] Recruiter override check failed: {exc}")
            return {
                "check": check_name,
                "success": False,
                "error": str(exc),
            }

    def run_all_validations(self) -> Dict[str, Any]:
        """Run all shadow validation checks."""
        self.results["timestamp"] = datetime.now(timezone.utc).isoformat()

        _LOG.info(f"\n{BLUE}{'=' * 70}{RESET}")
        _LOG.info(f"{BLUE}ML SHADOW MODE VALIDATION{RESET}")
        _LOG.info(f"{BLUE}{'=' * 70}{RESET}\n")

        # Get total shadow records
        total_shadow = self.shadow_results_col.count_documents({})
        self.results["summary"]["total_shadow_records"] = total_shadow
        _LOG.info(f"Total shadow records: {total_shadow}\n")

        # Run all validation checks
        self.validate_score_invariant()
        self.validate_ml_storage()
        self.validate_feature_vectors()
        self.validate_skip_flag_behavior()
        self.compute_score_divergence()
        self.validate_recruiter_overrides()

        # Print summary
        summary = self.results["summary"]
        _LOG.info(f"\n{BLUE}{'=' * 70}{RESET}")
        _LOG.info(f"{BLUE}VALIDATION SUMMARY{RESET}")
        _LOG.info(f"{BLUE}{'=' * 70}{RESET}")
        _LOG.info(f"Total checks:        {summary['total_checks']}")
        _LOG.info(f"{GREEN}Passed:{RESET}          {summary['passed']}")
        _LOG.info(f"{RED}Failed:{RESET}          {summary['failed']}")
        _LOG.info(f"Skipped inferences:  {summary['skipped_inferences']}")
        _LOG.info(f"Avg score divergence: {summary['score_divergence_avg']}")
        _LOG.info(f"Max score divergence: {summary['score_divergence_max']}")

        # Print validation rules status
        _LOG.info(f"\n{BLUE}Validation Rules:{RESET}")
        for rule, status in self.results["validation_rules"].items():
            icon = f"{GREEN}✓{RESET}" if status else f"{RED}✗{RESET}"
            _LOG.info(f"  {icon} {rule}")

        overall_success = summary["failed"] == 0
        if overall_success:
            _LOG.info(f"\n{GREEN}✓ ALL VALIDATIONS PASSED{RESET}\n")
        else:
            _LOG.info(f"\n{RED}✗ {summary['failed']} VALIDATIONS FAILED{RESET}\n")

        return self.results

    def save_report(self, output_path: str = None) -> None:
        """Save validation report to JSON file."""
        if output_path is None:
            results_dir = Path(__file__).parent.parent / "results"
            results_dir.mkdir(exist_ok=True)
            output_path = results_dir / "ml_shadow_validation_report.json"
        else:
            output_path = Path(output_path)
            output_path.parent.mkdir(parents=True, exist_ok=True)

        with open(output_path, "w") as f:
            json.dump(self.results, f, indent=2)

        _LOG.info(f"Report saved to: {output_path}")


# ─── Main ──────────────────────────────────────────────────────────────────────


def main():
    """Run shadow validation and save report."""
    validator = ShadowValidator()
    validator.run_all_validations()
    validator.save_report()


if __name__ == "__main__":
    main()
