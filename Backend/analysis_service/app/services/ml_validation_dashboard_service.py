"""ML Validation Dashboard Service — Phase 4.5.

Computes aggregated metrics for the ML validation dashboard.

All computations are READ-ONLY from:
  - interview_ml_dataset  (feedback + system/human scores)
  - ml_ab_test_metrics    (A/B outcomes)
  - ml_shadow_results     (shadow inference results)

METRIC DEFINITIONS:
  recruiterAgreementRate    fraction where agreementLabel == "MATCH"
  systemMae                 mean |humanScore - systemScore|
  mlCalibrationMae          mean |humanScore - mlCalibratedScore| (shadow only)
  overrideFrequency         fraction where |humanScore - systemScore| > 10
  falsePASSRate             fraction where systemDecision=PASS but human=FAIL
  falseFAILRate             fraction where systemDecision=FAIL but human=PASS
  lowConfidenceRate         fraction of records where confidence < 0.45
  biasFlagFrequency         fraction of records with any detected bias
  modelUsageRate            fraction of shadow results where mlApplied=True
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

_LOG = logging.getLogger(__name__)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def get_overview_metrics(days: int = 30) -> dict:
    """Compute the full validation overview for the dashboard.

    Args:
        days: Number of days to include in the analysis window.

    Returns:
        Dict of aggregated validation metrics.
    """
    try:
        return _compute_overview(days)
    except Exception as exc:  # noqa: BLE001
        _LOG.error("[ValidationDashboard] Overview computation failed: %s", exc)
        return {"error": str(exc), "metricsAvailable": False}


def _compute_overview(days: int) -> dict:
    from app.db.mongo import ml_dataset_col, ml_shadow_results_col

    cutoff = _utc_now() - timedelta(days=days)
    records = list(
        ml_dataset_col.find(
            {"updatedAt": {"$gte": cutoff}},
            {"_id": 0},
        )
    )

    if not records:
        return {
            "metricsAvailable": False,
            "totalFeedbackRecords": 0,
            "windowDays": days,
            "message": "No feedback records found in the specified window.",
        }

    n = len(records)

    # ── Agreement ─────────────────────────────────────────────────────────
    matches = sum(1 for r in records if r.get("agreementLabel") == "MATCH")
    agreement_rate = round(matches / n, 3)

    # ── MAE — System vs Human ─────────────────────────────────────────────
    mae_records = [
        r
        for r in records
        if r.get("humanScore") is not None and r.get("systemScore") is not None
    ]
    system_mae = (
        round(
            sum(
                abs(float(r["humanScore"]) - float(r["systemScore"]))
                for r in mae_records
            )
            / len(mae_records),
            2,
        )
        if mae_records
        else None
    )

    # ── Override frequency ────────────────────────────────────────────────
    overrides = sum(
        1
        for r in mae_records
        if abs(float(r["humanScore"]) - float(r["systemScore"])) > 10
    )
    override_freq = round(overrides / max(len(mae_records), 1), 3)

    # ── False PASS / False FAIL ───────────────────────────────────────────
    decision_records = [
        r for r in records if r.get("humanDecision") and r.get("systemDecision")
    ]
    false_pass = sum(
        1
        for r in decision_records
        if r.get("systemDecision") == "PASS" and r.get("humanDecision") == "FAIL"
    )
    false_fail = sum(
        1
        for r in decision_records
        if r.get("systemDecision") == "FAIL" and r.get("humanDecision") == "PASS"
    )
    n_dec = max(len(decision_records), 1)
    false_pass_rate = round(false_pass / n_dec, 3)
    false_fail_rate = round(false_fail / n_dec, 3)

    # ── Low confidence rate ───────────────────────────────────────────────
    low_conf = sum(
        1
        for r in records
        if float(
            ((r.get("features") or {}).get("mlFeatureVector") or {}).get(
                "decision_confidence", 1.0
            )
        )
        < 0.45
    )
    low_conf_rate = round(low_conf / n, 3)

    # ── Bias flag frequency ───────────────────────────────────────────────
    biased = sum(
        1
        for r in records
        if len(
            ((r.get("features") or {}).get("biasReport") or {}).get(
                "detectedBiases", []
            )
        )
        > 0
    )
    bias_flag_freq = round(biased / n, 3)

    # ── ML calibration MAE (shadow results) ───────────────────────────────
    shadow_records = list(
        ml_shadow_results_col.find(
            {"runAt": {"$gte": cutoff}, "shadowInferenceSkipped": False},
            {"_id": 0},
        )
    )
    ml_mae = None
    model_usage_rate = None
    if shadow_records:
        # Match shadow results with human scores
        shadow_by_id = {r["interviewId"]: r for r in shadow_records}
        calibration_pairs = [
            (
                float(r["humanScore"]),
                float(shadow_by_id[r["interviewId"]]["mlCalibratedScore"]),
            )
            for r in records
            if r.get("interviewId") in shadow_by_id
            and r.get("humanScore") is not None
            and shadow_by_id[r["interviewId"]].get("mlCalibratedScore") is not None
        ]
        if calibration_pairs:
            ml_mae = round(
                sum(abs(h - m) for h, m in calibration_pairs) / len(calibration_pairs),
                2,
            )
        model_usage_rate = round(
            sum(1 for r in shadow_records if not r.get("shadowInferenceSkipped"))
            / len(shadow_records),
            3,
        )

    return {
        "metricsAvailable": True,
        "totalFeedbackRecords": n,
        "windowDays": days,
        "recruiterAgreementRate": agreement_rate,
        "systemMae": system_mae,
        "mlCalibrationMae": ml_mae,
        "overrideFrequency": override_freq,
        "falsePASSRate": false_pass_rate,
        "falseFAILRate": false_fail_rate,
        "lowConfidenceRate": low_conf_rate,
        "biasFlagFrequency": bias_flag_freq,
        "modelUsageRate": model_usage_rate,
        "computedAt": _utc_now().isoformat(),
    }


def get_drift_summary(days: int = 7) -> dict:
    """Return the most recent drift analysis results."""
    try:
        from app.db.mongo import ml_feature_drift_metrics_col

        cutoff = _utc_now() - timedelta(days=days)
        latest = list(
            ml_feature_drift_metrics_col.find(
                {"computedAt": {"$gte": cutoff}},
                {"_id": 0},
            )
            .sort("computedAt", -1)
            .limit(5)
        )
        return {
            "recentDriftAnalyses": latest,
            "count": len(latest),
        }
    except Exception as exc:  # noqa: BLE001
        _LOG.error("[ValidationDashboard] Drift summary failed: %s", exc)
        return {"error": str(exc)}


def get_ab_metrics_summary() -> dict:
    """Return A/B group performance comparison."""
    try:
        from app.services.ab_testing_service import get_group_metrics

        metrics = get_group_metrics()
        return {"abMetrics": metrics, "groupsAvailable": list(metrics.keys())}
    except Exception as exc:  # noqa: BLE001
        _LOG.error("[ValidationDashboard] A/B metrics failed: %s", exc)
        return {"error": str(exc)}


def get_recruiter_agreement_trend(days: int = 30, bucket_days: int = 7) -> dict:
    """Compute recruiter agreement rate as a time-series bucketed by bucket_days."""
    try:
        from app.db.mongo import ml_dataset_col

        records = list(
            ml_dataset_col.find(
                {"updatedAt": {"$exists": True}},
                {"_id": 0, "agreementLabel": 1, "updatedAt": 1},
            )
        )
        if not records:
            return {"trend": [], "bucketDays": bucket_days}

        # Bucket by date
        buckets: dict[str, dict] = {}
        for r in records:
            ts = r.get("updatedAt")
            if not ts:
                continue
            bucket_key = (
                ts.strftime("%Y-%m-%d") if hasattr(ts, "strftime") else str(ts)[:10]
            )
            if bucket_key not in buckets:
                buckets[bucket_key] = {"date": bucket_key, "total": 0, "matches": 0}
            buckets[bucket_key]["total"] += 1
            if r.get("agreementLabel") == "MATCH":
                buckets[bucket_key]["matches"] += 1

        trend = sorted(
            [
                {
                    "date": k,
                    "total": v["total"],
                    "matches": v["matches"],
                    "agreementRate": round(v["matches"] / max(v["total"], 1), 3),
                }
                for k, v in buckets.items()
            ],
            key=lambda x: x["date"],
        )
        return {"trend": trend[-days // bucket_days :], "bucketDays": bucket_days}
    except Exception as exc:  # noqa: BLE001
        _LOG.error("[ValidationDashboard] Agreement trend failed: %s", exc)
        return {"error": str(exc), "trend": []}
