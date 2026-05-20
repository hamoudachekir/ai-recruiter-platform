"""ML Drift Monitoring — Phase 4.5

Monitors ML model drift over time:
- Track feature distribution changes over time
- Detect score drift between system and ML
- Monitor prediction confidence trends
- Alert on significant drift (>10%)
- Compare recent vs baseline distributions
- Statistical significance testing

This test helps identify when the ML model needs retraining
or when system behavior has changed significantly.
"""

import json
import logging
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
from pymongo import MongoClient
from scipy import stats

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

# Drift thresholds
DRIFT_WARNING_THRESHOLD = 0.10  # 10% change
DRIFT_CRITICAL_THRESHOLD = 0.25  # 25% change

# Time windows (days)
RECENT_WINDOW_DAYS = 7
BASELINE_WINDOW_DAYS = 30

# ─── Drift Monitor ────────────────────────────────────────────────────────────


class DriftMonitor:
    """Monitor ML model drift over time."""

    def __init__(self):
        self.client = MongoClient(MONGO_URL)
        self.db = self.client[MONGO_DB]

        self.ml_dataset_col = self.db["interview_ml_dataset"]
        self.shadow_results_col = self.db["ml_shadow_results"]
        self.feature_drift_col = self.db["ml_feature_drift_metrics"]

        self.results = {
            "timestamp": None,
            "time_windows": {
                "recent_days": RECENT_WINDOW_DAYS,
                "baseline_days": BASELINE_WINDOW_DAYS,
                "recent_start": None,
                "baseline_start": None,
                "baseline_end": None,
            },
            "drift_alerts": [],
            "feature_drift": {},
            "score_drift": {},
            "confidence_trends": {},
            "summary": {
                "total_features_monitored": 0,
                "features_with_drift": 0,
                "critical_drift_count": 0,
                "warning_drift_count": 0,
                "score_drift_detected": False,
                "confidence_drift_detected": False,
            },
        }

    def _utc_now(self) -> datetime:
        """Get current UTC time."""
        return datetime.now(timezone.utc)

    def _get_time_windows(self) -> tuple:
        """Calculate baseline and recent time windows."""
        now = self._utc_now()
        recent_start = now - timedelta(days=RECENT_WINDOW_DAYS)
        baseline_end = recent_start
        baseline_start = baseline_end - timedelta(days=BASELINE_WINDOW_DAYS)

        self.results["time_windows"]["recent_start"] = recent_start.isoformat()
        self.results["time_windows"]["baseline_start"] = baseline_start.isoformat()
        self.results["time_windows"]["baseline_end"] = baseline_end.isoformat()

        return baseline_start, baseline_end, recent_start

    def monitor_feature_drift(self) -> Dict[str, Any]:
        """Monitor drift in feature distributions."""
        _LOG.info("[DriftMonitor] Analyzing feature drift...")

        baseline_start, baseline_end, recent_start = self._get_time_windows()

        try:
            # Load baseline records
            baseline_records = list(
                self.ml_dataset_col.find(
                    {"updatedAt": {"$gte": baseline_start, "$lt": baseline_end}},
                    {"_id": 0, "features.mlFeatureVector": 1},
                )
            )

            # Load recent records
            recent_records = list(
                self.ml_dataset_col.find(
                    {"updatedAt": {"$gte": recent_start}},
                    {"_id": 0, "features.mlFeatureVector": 1},
                )
            )

            baseline_count = len(baseline_records)
            recent_count = len(recent_records)

            _LOG.info(
                f"Baseline period: {baseline_count} records ({baseline_start.date()} to {baseline_end.date()})"
            )
            _LOG.info(
                f"Recent period: {recent_count} records (from {recent_start.date()})"
            )

            if baseline_count < 10 or recent_count < 10:
                return {
                    "success": False,
                    "error": f"Insufficient data (baseline={baseline_count}, recent={recent_count})",
                }

            # Extract feature vectors
            baseline_features = self._extract_feature_vectors(baseline_records)
            recent_features = self._extract_feature_vectors(recent_records)

            # Get common features
            common_features = set(baseline_features.keys()) & set(
                recent_features.keys()
            )
            if not common_features:
                return {
                    "success": False,
                    "error": "No common features between baseline and recent",
                }

            drift_results = {}
            features_with_drift = []
            critical_drift = []
            warning_drift = []

            # Analyze each feature
            for feature_name in sorted(common_features):
                baseline_values = baseline_features[feature_name]
                recent_values = recent_features[feature_name]

                drift_analysis = self._analyze_feature_drift(
                    feature_name, baseline_values, recent_values
                )
                drift_results[feature_name] = drift_analysis

                # Check for drift
                if drift_analysis.get("drift_detected"):
                    features_with_drift.append(feature_name)

                    severity = drift_analysis.get("severity", "none")
                    if severity == "critical":
                        critical_drift.append(feature_name)
                        self.results["drift_alerts"].append(
                            {
                                "type": "feature_drift",
                                "severity": "critical",
                                "feature": feature_name,
                                "psi": drift_analysis.get("psi"),
                                "mean_shift": drift_analysis.get("mean_shift_pct"),
                            }
                        )
                    elif severity == "warning":
                        warning_drift.append(feature_name)

            self.results["feature_drift"] = {
                "total_features": len(common_features),
                "features_analyzed": list(common_features),
                "features_with_drift": features_with_drift,
                "critical_drift": critical_drift,
                "warning_drift": warning_drift,
                "drift_details": drift_results,
                "baseline_count": baseline_count,
                "recent_count": recent_count,
            }

            self.results["summary"]["total_features_monitored"] = len(common_features)
            self.results["summary"]["features_with_drift"] = len(features_with_drift)
            self.results["summary"]["critical_drift_count"] = len(critical_drift)
            self.results["summary"]["warning_drift_count"] = len(warning_drift)

            if critical_drift:
                _LOG.error(
                    f"{RED}✗{RESET} Critical drift detected in {len(critical_drift)} features: {critical_drift}"
                )
            elif warning_drift:
                _LOG.warning(
                    f"{YELLOW}⚠{RESET} Warning drift detected in {len(warning_drift)} features"
                )
            else:
                _LOG.info(f"{GREEN}✓{RESET} No significant feature drift detected")

            return {"success": True, "drift_count": len(features_with_drift)}

        except Exception as exc:
            _LOG.error(f"[DriftMonitor] Feature drift analysis failed: {exc}")
            return {"success": False, "error": str(exc)}

    def _extract_feature_vectors(self, records: List[Dict]) -> Dict[str, List[float]]:
        """Extract feature vectors from ML dataset records."""
        features = {}

        for record in records:
            feature_vec = (record.get("features") or {}).get("mlFeatureVector") or {}

            if not isinstance(feature_vec, dict):
                continue

            for key, value in feature_vec.items():
                if value is not None and isinstance(value, (int, float)):
                    if key not in features:
                        features[key] = []
                    features[key].append(float(value))

        return features

    def _analyze_feature_drift(
        self, feature_name: str, baseline: List[float], recent: List[float]
    ) -> Dict[str, Any]:
        """Analyze drift for a single feature using multiple metrics."""
        baseline_arr = np.array(baseline)
        recent_arr = np.array(recent)

        # Compute statistics
        baseline_mean = float(np.mean(baseline_arr))
        recent_mean = float(np.mean(recent_arr))
        baseline_std = float(np.std(baseline_arr))
        recent_std = float(np.std(recent_arr))

        # Mean shift
        mean_shift = recent_mean - baseline_mean
        mean_shift_pct = (
            (mean_shift / abs(baseline_mean)) * 100
            if baseline_mean != 0
            else float("inf")
        )

        # Std shift
        std_shift_pct = (
            ((recent_std - baseline_std) / baseline_std) * 100
            if baseline_std != 0
            else 0
        )

        # Kolmogorov-Smirnov test (distribution difference)
        ks_statistic, ks_pvalue = stats.ks_2samp(baseline_arr, recent_arr)

        # Population Stability Index (PSI)
        psi = self._calculate_psi(baseline_arr, recent_arr)

        # Determine drift severity
        drift_detected = False
        severity = "none"

        if psi > 0.25 or abs(mean_shift_pct) > 25:
            drift_detected = True
            severity = "critical"
        elif psi > 0.10 or abs(mean_shift_pct) > 10:
            drift_detected = True
            severity = "warning"

        return {
            "feature": feature_name,
            "baseline": {
                "mean": round(baseline_mean, 4),
                "std": round(baseline_std, 4),
                "count": len(baseline),
            },
            "recent": {
                "mean": round(recent_mean, 4),
                "std": round(recent_std, 4),
                "count": len(recent),
            },
            "drift_metrics": {
                "mean_shift": round(mean_shift, 4),
                "mean_shift_pct": round(mean_shift_pct, 2),
                "std_shift_pct": round(std_shift_pct, 2),
                "ks_statistic": round(ks_statistic, 4),
                "ks_pvalue": round(ks_pvalue, 4),
                "psi": round(psi, 4),
            },
            "drift_detected": drift_detected,
            "severity": severity,
        }

    def _calculate_psi(
        self, baseline: np.ndarray, recent: np.ndarray, bins: int = 10
    ) -> float:
        """Calculate Population Stability Index (PSI)."""
        try:
            # Create bins based on baseline distribution
            _, bin_edges = np.histogram(baseline, bins=bins)

            # Get distributions
            baseline_hist, _ = np.histogram(baseline, bins=bin_edges)
            recent_hist, _ = np.histogram(recent, bins=bin_edges)

            # Convert to proportions (add small epsilon to avoid log(0))
            epsilon = 1e-10
            baseline_props = (baseline_hist + epsilon) / (
                len(baseline) + epsilon * bins
            )
            recent_props = (recent_hist + epsilon) / (len(recent) + epsilon * bins)

            # Calculate PSI
            psi = np.sum(
                (recent_props - baseline_props) * np.log(recent_props / baseline_props)
            )

            return float(psi)

        except Exception:
            return 0.0

    def monitor_score_drift(self) -> Dict[str, Any]:
        """Monitor drift in system vs ML score relationships."""
        _LOG.info("[DriftMonitor] Analyzing score drift...")

        baseline_start, baseline_end, recent_start = self._get_time_windows()

        try:
            # Load baseline shadow results
            baseline_records = list(
                self.shadow_results_col.find(
                    {
                        "runAt": {"$gte": baseline_start, "$lt": baseline_end},
                        "shadowInferenceSkipped": False,
                    },
                    {
                        "_id": 0,
                        "systemScore": 1,
                        "mlCalibratedScore": 1,
                        "scoreDelta": 1,
                    },
                )
            )

            # Load recent shadow results
            recent_records = list(
                self.shadow_results_col.find(
                    {"runAt": {"$gte": recent_start}, "shadowInferenceSkipped": False},
                    {
                        "_id": 0,
                        "systemScore": 1,
                        "mlCalibratedScore": 1,
                        "scoreDelta": 1,
                    },
                )
            )

            if len(baseline_records) < 10 or len(recent_records) < 10:
                return {
                    "success": False,
                    "error": "Insufficient shadow results for score drift analysis",
                }

            # Extract deltas
            baseline_deltas = [float(r.get("scoreDelta", 0)) for r in baseline_records]
            recent_deltas = [float(r.get("scoreDelta", 0)) for r in recent_records]

            # Compute statistics
            baseline_mean_delta = np.mean(baseline_deltas)
            recent_mean_delta = np.mean(recent_deltas)
            baseline_std_delta = np.std(baseline_deltas)
            recent_std_delta = np.std(recent_deltas)

            delta_shift = recent_mean_delta - baseline_mean_delta
            delta_shift_pct = (
                abs(delta_shift) / (abs(baseline_mean_delta) + 1e-10)
            ) * 100

            # T-test for significance
            t_statistic, t_pvalue = stats.ttest_ind(baseline_deltas, recent_deltas)

            # Check for drift
            drift_detected = abs(delta_shift) > 5 or delta_shift_pct > 20
            severity = "critical" if abs(delta_shift) > 10 else "warning"

            if drift_detected:
                self.results["drift_alerts"].append(
                    {
                        "type": "score_drift",
                        "severity": severity,
                        "baseline_mean_delta": round(baseline_mean_delta, 2),
                        "recent_mean_delta": round(recent_mean_delta, 2),
                        "shift": round(delta_shift, 2),
                        "shift_pct": round(delta_shift_pct, 2),
                    }
                )

            self.results["score_drift"] = {
                "baseline": {
                    "mean_delta": round(baseline_mean_delta, 2),
                    "std_delta": round(baseline_std_delta, 2),
                    "count": len(baseline_records),
                },
                "recent": {
                    "mean_delta": round(recent_mean_delta, 2),
                    "std_delta": round(recent_std_delta, 2),
                    "count": len(recent_records),
                },
                "drift_metrics": {
                    "delta_shift": round(delta_shift, 2),
                    "delta_shift_pct": round(delta_shift_pct, 2),
                    "t_statistic": round(t_statistic, 4),
                    "t_pvalue": round(t_pvalue, 4),
                    "significant": t_pvalue < 0.05,
                },
                "drift_detected": drift_detected,
                "severity": severity if drift_detected else "none",
            }

            self.results["summary"]["score_drift_detected"] = drift_detected

            if drift_detected:
                _LOG.warning(
                    f"{YELLOW}⚠{RESET} Score drift detected: {delta_shift:+.2f} points ({delta_shift_pct:.1f}%)"
                )
            else:
                _LOG.info(f"{GREEN}✓{RESET} No significant score drift detected")

            return {"success": True, "drift_detected": drift_detected}

        except Exception as exc:
            _LOG.error(f"[DriftMonitor] Score drift analysis failed: {exc}")
            return {"success": False, "error": str(exc)}

    def monitor_confidence_trends(self) -> Dict[str, Any]:
        """Monitor trends in prediction confidence over time."""
        _LOG.info("[DriftMonitor] Analyzing confidence trends...")

        baseline_start, baseline_end, recent_start = self._get_time_windows()

        try:
            # Load baseline records
            baseline_records = list(
                self.shadow_results_col.find(
                    {
                        "runAt": {"$gte": baseline_start, "$lt": baseline_end},
                        "shadowInferenceSkipped": False,
                    },
                    {"_id": 0, "decisionConfidence": 1},
                )
            )

            # Load recent records
            recent_records = list(
                self.shadow_results_col.find(
                    {"runAt": {"$gte": recent_start}, "shadowInferenceSkipped": False},
                    {"_id": 0, "decisionConfidence": 1},
                )
            )

            if len(baseline_records) < 10 or len(recent_records) < 10:
                return {
                    "success": False,
                    "error": "Insufficient data for confidence trend analysis",
                }

            # Extract confidence values
            baseline_confidence = [
                float(r.get("decisionConfidence", 0))
                for r in baseline_records
                if r.get("decisionConfidence") is not None
            ]
            recent_confidence = [
                float(r.get("decisionConfidence", 0))
                for r in recent_records
                if r.get("decisionConfidence") is not None
            ]

            if not baseline_confidence or not recent_confidence:
                return {
                    "success": False,
                    "error": "No confidence values found",
                }

            # Compute statistics
            baseline_mean = np.mean(baseline_confidence)
            recent_mean = np.mean(recent_confidence)
            baseline_std = np.std(baseline_confidence)
            recent_std = np.std(recent_confidence)

            confidence_shift = recent_mean - baseline_mean
            confidence_shift_pct = (confidence_shift / baseline_mean) * 100

            # Check for drift
            drift_detected = abs(confidence_shift) > 0.10  # 10% absolute change
            severity = "warning" if drift_detected else "none"

            if drift_detected:
                self.results["drift_alerts"].append(
                    {
                        "type": "confidence_drift",
                        "severity": severity,
                        "baseline_mean": round(baseline_mean, 3),
                        "recent_mean": round(recent_mean, 3),
                        "shift": round(confidence_shift, 3),
                        "shift_pct": round(confidence_shift_pct, 2),
                    }
                )

            self.results["confidence_trends"] = {
                "baseline": {
                    "mean": round(baseline_mean, 3),
                    "std": round(baseline_std, 3),
                    "count": len(baseline_confidence),
                },
                "recent": {
                    "mean": round(recent_mean, 3),
                    "std": round(recent_std, 3),
                    "count": len(recent_confidence),
                },
                "trend": {
                    "shift": round(confidence_shift, 3),
                    "shift_pct": round(confidence_shift_pct, 2),
                    "direction": "increasing" if confidence_shift > 0 else "decreasing",
                },
                "drift_detected": drift_detected,
                "severity": severity,
            }

            self.results["summary"]["confidence_drift_detected"] = drift_detected

            if drift_detected:
                direction = "increased" if confidence_shift > 0 else "decreased"
                _LOG.warning(
                    f"{YELLOW}⚠{RESET} Confidence {direction} by {abs(confidence_shift):.3f} ({confidence_shift_pct:+.1f}%)"
                )
            else:
                _LOG.info(f"{GREEN}✓{RESET} Confidence levels stable")

            return {"success": True, "drift_detected": drift_detected}

        except Exception as exc:
            _LOG.error(f"[DriftMonitor] Confidence trend analysis failed: {exc}")
            return {"success": False, "error": str(exc)}

    def run_all_monitors(self) -> Dict[str, Any]:
        """Run all drift monitoring checks."""
        self.results["timestamp"] = self._utc_now().isoformat()

        _LOG.info(f"\n{BLUE}{'=' * 70}{RESET}")
        _LOG.info(f"{BLUE}ML DRIFT MONITORING{RESET}")
        _LOG.info(f"{BLUE}{'=' * 70}{RESET}\n")

        # Run monitoring checks
        self.monitor_feature_drift()
        self.monitor_score_drift()
        self.monitor_confidence_trends()

        # Print summary
        summary = self.results["summary"]
        _LOG.info(f"\n{BLUE}{'=' * 70}{RESET}")
        _LOG.info(f"{BLUE}DRIFT MONITORING SUMMARY{RESET}")
        _LOG.info(f"{BLUE}{'=' * 70}{RESET}")
        _LOG.info(f"Features monitored:      {summary['total_features_monitored']}")
        _LOG.info(f"Features with drift:     {summary['features_with_drift']}")
        _LOG.info(f"Critical drift alerts:   {summary['critical_drift_count']}")
        _LOG.info(f"Warning drift alerts:    {summary['warning_drift_count']}")
        _LOG.info(f"Score drift detected:    {summary['score_drift_detected']}")
        _LOG.info(f"Confidence drift:        {summary['confidence_drift_detected']}")

        # Print alerts
        if self.results["drift_alerts"]:
            _LOG.info(f"\n{YELLOW}DRIFT ALERTS:{RESET}")
            for alert in self.results["drift_alerts"]:
                severity_color = RED if alert["severity"] == "critical" else YELLOW
                _LOG.info(
                    f"  {severity_color}{alert['severity'].upper()}{RESET} - {alert['type']}"
                )

        total_drift = (
            summary["critical_drift_count"]
            + summary["warning_drift_count"]
            + (1 if summary["score_drift_detected"] else 0)
            + (1 if summary["confidence_drift_detected"] else 0)
        )

        if total_drift == 0:
            _LOG.info(f"\n{GREEN}✓ NO SIGNIFICANT DRIFT DETECTED{RESET}\n")
        elif summary["critical_drift_count"] > 0:
            _LOG.info(
                f"\n{RED}✗ CRITICAL DRIFT DETECTED - MODEL RETRAINING RECOMMENDED{RESET}\n"
            )
        else:
            _LOG.info(f"\n{YELLOW}⚠ DRIFT DETECTED - MONITOR CLOSELY{RESET}\n")

        return self.results

    def save_report(self, output_path: Optional[str] = None) -> None:
        """Save drift report to JSON file."""
        if output_path is None:
            results_dir = Path(__file__).parent.parent / "results"
            results_dir.mkdir(exist_ok=True)
            output_path = results_dir / "ml_drift_report.json"
        else:
            output_path = Path(output_path)
            output_path.parent.mkdir(parents=True, exist_ok=True)

        with open(output_path, "w") as f:
            json.dump(self.results, f, indent=2)

        _LOG.info(f"Report saved to: {output_path}")


# ─── Main ──────────────────────────────────────────────────────────────────────


def main():
    """Run drift monitoring and save report."""
    try:
        monitor = DriftMonitor()
        monitor.run_all_monitors()
        monitor.save_report()
    except ImportError as e:
        _LOG.error(f"{RED}Missing dependencies: {e}{RESET}")
        _LOG.error("Install with: pip install numpy scipy")


if __name__ == "__main__":
    main()
