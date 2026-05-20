"""Training Data Quality Filters — Phase 4.5.

Applies quality gates to ML dataset records before model training.

REJECTION CRITERIA (any single criterion fails the record):
    - decision_confidence < 0.45          low_confidence
    - transcriptQuality == "FAIL"         transcript_quality_fail
    - evidenceCoverage < 0.50             low_evidence_coverage
    - biasRiskLevel == "high"             high_bias_risk
    - humanScore is None or not numeric   missing_ground_truth
    - mlFeatureVector is empty            missing_feature_vector

The quality service is integrated into ml_training_pipeline.py between
the basic existence check and the train/val/test split.
"""

from __future__ import annotations

import logging

_LOG = logging.getLogger(__name__)

# Thresholds
_MIN_CONFIDENCE = 0.45
_MIN_EVIDENCE_COVERAGE = 0.50
_REJECT_QUALITY_GRADE = "FAIL"
_REJECT_BIAS_RISK = "high"


def assess_record_quality(record: dict) -> dict:
    """Assess whether a single ML dataset record is suitable for training.

    Args:
        record: A document from interview_ml_dataset.

    Returns:
        dict with:
          usableForTraining: bool
          reasons:           list of rejection reason strings
          confidence:        float (extracted value)
          evidenceCoverage:  float (extracted value)
          biasRisk:          str
          qualityGrade:      str
    """
    reasons: list[str] = []

    # ── Feature vector presence ───────────────────────────────────────────
    feature_vector = (record.get("features") or {}).get("mlFeatureVector") or {}
    if not feature_vector:
        reasons.append("missing_feature_vector")

    # ── Ground truth presence ─────────────────────────────────────────────
    human_score = record.get("humanScore")
    if human_score is None or not isinstance(human_score, (int, float)):
        reasons.append("missing_ground_truth")

    # ── Decision confidence ───────────────────────────────────────────────
    confidence = float(feature_vector.get("decision_confidence", 0.0))
    if confidence < _MIN_CONFIDENCE:
        reasons.append("low_confidence")

    # ── Transcript quality ────────────────────────────────────────────────
    transcript_stats = (record.get("features") or {}).get("transcriptStats") or {}
    quality_grade = (transcript_stats.get("qualityGrade") or "PASS").upper()
    if quality_grade == _REJECT_QUALITY_GRADE:
        reasons.append("transcript_quality_fail")

    # ── Evidence coverage ─────────────────────────────────────────────────
    evidence_coverage = float(feature_vector.get("evidence_coverage", 1.0))
    if evidence_coverage < _MIN_EVIDENCE_COVERAGE:
        reasons.append("low_evidence_coverage")

    # ── Bias risk ─────────────────────────────────────────────────────────
    bias_report = (record.get("features") or {}).get("biasReport") or {}
    bias_risk = (bias_report.get("biasRiskLevel") or "low").lower()
    if bias_risk == _REJECT_BIAS_RISK:
        reasons.append("high_bias_risk")

    return {
        "usableForTraining": len(reasons) == 0,
        "reasons": reasons,
        "confidence": confidence,
        "evidenceCoverage": evidence_coverage,
        "biasRisk": bias_risk,
        "qualityGrade": quality_grade,
    }


def filter_dataset(records: list[dict]) -> list[dict]:
    """Filter a list of ML dataset records, keeping only training-quality records.

    Also logs a summary of rejection reasons.

    Args:
        records: List of interview_ml_dataset documents.

    Returns:
        Filtered list containing only usable records.
    """
    if not records:
        return []

    usable: list[dict] = []
    rejection_counts: dict[str, int] = {}

    for record in records:
        assessment = assess_record_quality(record)
        if assessment["usableForTraining"]:
            usable.append(record)
        else:
            for reason in assessment["reasons"]:
                rejection_counts[reason] = rejection_counts.get(reason, 0) + 1

    total = len(records)
    accepted = len(usable)
    rejected = total - accepted

    if rejected > 0:
        _LOG.info(
            "[DataQuality] Filter: %d/%d accepted (%d rejected). Reasons: %s",
            accepted,
            total,
            rejected,
            rejection_counts,
        )
    else:
        _LOG.info("[DataQuality] Filter: all %d records passed quality checks.", total)

    return usable


def get_dataset_quality_report(records: list[dict]) -> dict:
    """Compute a quality summary report for a dataset.

    Args:
        records: List of interview_ml_dataset documents.

    Returns:
        Summary dict with acceptance rate and rejection breakdown.
    """
    if not records:
        return {
            "totalRecords": 0,
            "acceptedRecords": 0,
            "rejectedRecords": 0,
            "acceptanceRate": 0.0,
            "rejectionBreakdown": {},
        }

    assessments = [assess_record_quality(r) for r in records]
    accepted = sum(1 for a in assessments if a["usableForTraining"])
    rejected = len(assessments) - accepted
    rejection_counts: dict[str, int] = {}
    for a in assessments:
        for reason in a.get("reasons", []):
            rejection_counts[reason] = rejection_counts.get(reason, 0) + 1

    return {
        "totalRecords": len(records),
        "acceptedRecords": accepted,
        "rejectedRecords": rejected,
        "acceptanceRate": round(accepted / len(records), 3),
        "rejectionBreakdown": rejection_counts,
    }
