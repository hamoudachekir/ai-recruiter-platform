"""Feature Drift Detection Service — Phase 4.5.

Detects distribution shift in the ML feature vector over time.

METHODS:
  - Z-score: flags features whose mean has shifted > threshold standard deviations.
  - PSI (Population Stability Index): industry-standard distribution shift metric.
    PSI < 0.10  → no significant change
    PSI 0.10–0.25 → moderate change, monitor
    PSI > 0.25  → significant shift, investigate / retrain
  - Confidence mean drop: if rolling mean confidence drops > 20%, alert.

ALERT LEVELS:
  none       PSI <= 0.10 for all features, confidence stable
  warning    0.10 < PSI <= 0.25 for any feature OR confidence drop > 10%
  critical   PSI > 0.25 for any feature OR confidence drop > 20%

Results are persisted in ml_feature_drift_metrics for dashboard display.
"""

from __future__ import annotations

import logging
import math
from datetime import datetime, timedelta, timezone
from typing import Optional

_LOG = logging.getLogger(__name__)

_PSI_WARNING = 0.10
_PSI_CRITICAL = 0.25
_CONFIDENCE_DROP_WARNING = 0.10
_CONFIDENCE_DROP_CRITICAL = 0.20
_MIN_SAMPLES = 20  # minimum records needed for drift analysis
_BASELINE_DAYS = 30  # days for baseline window
_RECENT_DAYS = 7  # days for recent window


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _safe_float(v, default: float = 0.0) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _compute_psi(expected: list[float], actual: list[float], n_bins: int = 10) -> float:
    """Compute Population Stability Index between two float distributions.

    PSI = sum((actual_pct - expected_pct) * ln(actual_pct / expected_pct))

    Args:
        expected: Baseline distribution values.
        actual:   Recent distribution values.
        n_bins:   Number of histogram bins.

    Returns:
        PSI value (float >= 0).
    """
    if len(expected) < 5 or len(actual) < 5:
        return 0.0

    # Determine bin edges from combined range
    all_vals = expected + actual
    min_v = min(all_vals)
    max_v = max(all_vals)

    if min_v == max_v:
        return 0.0  # No variance — no drift possible

    step = (max_v - min_v) / n_bins
    edges = [min_v + i * step for i in range(n_bins + 1)]
    edges[-1] = max_v + 1e-9  # ensure last value is included

    def hist(values: list[float]) -> list[float]:
        counts = [0] * n_bins
        for v in values:
            for i in range(n_bins):
                if edges[i] <= v < edges[i + 1]:
                    counts[i] += 1
                    break
        n = max(len(values), 1)
        # Add epsilon to avoid log(0)
        return [(c / n) + 1e-9 for c in counts]

    exp_pct = hist(expected)
    act_pct = hist(actual)

    psi = sum((a - e) * math.log(a / e) for a, e in zip(act_pct, exp_pct))
    return round(max(0.0, psi), 4)


def _compute_z_score(baseline: list[float], recent: list[float]) -> float:
    """Compute z-score of recent mean relative to baseline distribution."""
    if len(baseline) < 2 or not recent:
        return 0.0
    n = len(baseline)
    mean_b = sum(baseline) / n
    var_b = sum((x - mean_b) ** 2 for x in baseline) / max(n - 1, 1)
    std_b = math.sqrt(var_b) if var_b > 0 else 1e-9
    mean_r = sum(recent) / len(recent)
    return round(abs(mean_r - mean_b) / std_b, 3)


def run_drift_analysis(feature_names: Optional[list[str]] = None) -> dict:
    """Load recent ML dataset records and run drift analysis.

    Compares the RECENT_DAYS window against the BASELINE_DAYS window.

    Args:
        feature_names: Specific features to analyse. None = all features.

    Returns:
        Drift analysis result dict.
    """
    try:
        return _analyse(feature_names)
    except Exception as exc:  # noqa: BLE001
        _LOG.error("[DriftDetector] Analysis failed: %s", exc)
        return {"driftAnalysisFailed": True, "reason": str(exc)}


def _analyse(feature_names: Optional[list[str]]) -> dict:
    from app.db.mongo import ml_dataset_col, ml_feature_drift_metrics_col
    from app.services.ml_feature_extractor import FEATURE_NAMES

    names_to_check = feature_names or FEATURE_NAMES
    now = _utc_now()
    recent_cutoff = now - timedelta(days=_RECENT_DAYS)
    baseline_end = recent_cutoff
    baseline_start = baseline_end - timedelta(days=_BASELINE_DAYS)

    # Load baseline records
    baseline_records = list(
        ml_dataset_col.find(
            {"updatedAt": {"$gte": baseline_start, "$lt": baseline_end}},
            {"_id": 0, "features.mlFeatureVector": 1},
        )
    )
    # Load recent records
    recent_records = list(
        ml_dataset_col.find(
            {"updatedAt": {"$gte": recent_cutoff}},
            {"_id": 0, "features.mlFeatureVector": 1},
        )
    )

    if len(baseline_records) < _MIN_SAMPLES or len(recent_records) < _MIN_SAMPLES:
        return {
            "driftDetected": False,
            "alertLevel": "none",
            "reason": (
                f"Insufficient data: baseline={len(baseline_records)} "
                f"recent={len(recent_records)} (min={_MIN_SAMPLES})"
            ),
            "baselineSamples": len(baseline_records),
            "recentSamples": len(recent_records),
            "computedAt": now.isoformat(),
        }

    def get_feature_values(records: list[dict], name: str) -> list[float]:
        vals = []
        for r in records:
            fv = (r.get("features") or {}).get("mlFeatureVector") or {}
            vals.append(_safe_float(fv.get(name, 0.0)))
        return vals

    # ── Per-feature PSI ───────────────────────────────────────────────────
    psi_scores: dict[str, float] = {}
    z_scores: dict[str, float] = {}
    for name in names_to_check:
        baseline_vals = get_feature_values(baseline_records, name)
        recent_vals = get_feature_values(recent_records, name)
        psi_scores[name] = _compute_psi(baseline_vals, recent_vals)
        z_scores[name] = _compute_z_score(baseline_vals, recent_vals)

    # ── Confidence mean drop ──────────────────────────────────────────────
    baseline_conf = get_feature_values(baseline_records, "decision_confidence")
    recent_conf = get_feature_values(recent_records, "decision_confidence")
    mean_b_conf = sum(baseline_conf) / max(len(baseline_conf), 1)
    mean_r_conf = sum(recent_conf) / max(len(recent_conf), 1)
    conf_drop = (mean_b_conf - mean_r_conf) if mean_b_conf > 0 else 0.0

    # ── Alert level ───────────────────────────────────────────────────────
    max_psi = max(psi_scores.values()) if psi_scores else 0.0
    drift_features = [k for k, v in psi_scores.items() if v > _PSI_WARNING]
    critical_features = [k for k, v in psi_scores.items() if v > _PSI_CRITICAL]

    if critical_features or conf_drop > _CONFIDENCE_DROP_CRITICAL:
        alert_level = "critical"
        drift_detected = True
    elif drift_features or conf_drop > _CONFIDENCE_DROP_WARNING:
        alert_level = "warning"
        drift_detected = True
    else:
        alert_level = "none"
        drift_detected = False

    recommendations: list[str] = []
    if critical_features:
        recommendations.append(
            f"CRITICAL: Retrain model — features {critical_features[:3]} show PSI > {_PSI_CRITICAL}"
        )
    elif drift_features:
        recommendations.append(
            f"WARNING: Monitor features {drift_features[:3]} for continued drift"
        )
    if conf_drop > _CONFIDENCE_DROP_CRITICAL:
        recommendations.append(
            f"CRITICAL: Decision confidence dropped {conf_drop:.1%} — review pipeline quality"
        )
    if not recommendations:
        recommendations.append("No action required — feature distributions are stable")

    result = {
        "driftDetected": drift_detected,
        "alertLevel": alert_level,
        "maxPsi": round(max_psi, 4),
        "psiScores": {k: v for k, v in sorted(psi_scores.items(), key=lambda x: -x[1])},
        "zScores": z_scores,
        "driftFeatures": drift_features,
        "criticalFeatures": critical_features,
        "confidenceMeanBaseline": round(mean_b_conf, 3),
        "confidenceMeanRecent": round(mean_r_conf, 3),
        "confidenceDrop": round(conf_drop, 3),
        "baselineSamples": len(baseline_records),
        "recentSamples": len(recent_records),
        "recommendations": recommendations,
        "computedAt": now.isoformat(),
    }

    # Persist result
    try:
        ml_feature_drift_metrics_col.insert_one({**result})
        _LOG.info(
            "[DriftDetector] Analysis complete: alertLevel=%s maxPsi=%.3f",
            alert_level,
            max_psi,
        )
    except Exception as exc:  # noqa: BLE001
        _LOG.warning("[DriftDetector] Persistence failed: %s", exc)

    return result
