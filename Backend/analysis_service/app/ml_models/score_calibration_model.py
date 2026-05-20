"""Score Calibration Model — Phase 4.

XGBoost regression model that learns to correct systematic bias
in the Phase 3 deterministic scoring engine.

DESIGN RULES:
- Model is OPTIONAL: if not trained, returns None and the caller
  falls back to the Phase 3 system score unchanged.
- Prediction is capped at ±15 points from systemScore to prevent
  ML from making wild corrections.
- Model version is stored alongside a JSON metadata file.
- Thread-safe: model is loaded once at module level after training.
"""

from __future__ import annotations

import json
import logging
import pickle
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

_LOG = logging.getLogger(__name__)

# ── Registry paths ────────────────────────────────────────────────────────────
_MODULE_DIR = Path(__file__).parent
REGISTRY_DIR = _MODULE_DIR / "model_registry"
REGISTRY_DIR.mkdir(parents=True, exist_ok=True)

MODEL_PATH = REGISTRY_DIR / "score_calibration_v1.pkl"
METADATA_PATH = REGISTRY_DIR / "metadata.json"

# Safety cap: ML cannot move the score more than this from Phase 3 value
_MAX_SCORE_ADJUSTMENT = 15.0

# Minimum dataset size required to trust the model
_MIN_TRAINING_SAMPLES = 10

# Cached model instance (loaded lazily)
_model_cache: Optional[object] = None
_model_loaded: bool = False

# Re-export FEATURE_NAMES so training/inference pipelines can import from one place.
# ml_feature_extractor does NOT import from this module, so there is no circular dependency.
from app.services.ml_feature_extractor import FEATURE_NAMES  # noqa: E402, F401


def _utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_model() -> Optional[object]:
    """Load the calibration model from disk (lazy, cached).

    Returns:
        The trained XGBoost regressor, or None if not trained yet.
    """
    global _model_cache, _model_loaded
    if _model_loaded:
        return _model_cache

    _model_loaded = True  # set before attempting load to avoid retry loop

    if not MODEL_PATH.exists():
        _LOG.info("[ScoreCalibration] No trained model found at %s", MODEL_PATH)
        return None

    try:
        with MODEL_PATH.open("rb") as f:
            _model_cache = pickle.load(f)
        _LOG.info("[ScoreCalibration] Model loaded from %s", MODEL_PATH)
        return _model_cache
    except Exception as exc:  # noqa: BLE001
        _LOG.error("[ScoreCalibration] Failed to load model: %s", exc)
        return None


def save_model(model: object, metadata: dict) -> bool:
    """Persist a trained model and its metadata to the registry.

    Args:
        model:    Trained XGBoost regressor.
        metadata: Training metadata dict (mae, r2, dataset_size, etc.).

    Returns:
        True on success, False on failure.
    """
    global _model_cache, _model_loaded
    try:
        with MODEL_PATH.open("wb") as f:
            pickle.dump(model, f)

        full_meta = {
            "version": "1.0",
            "trainedAt": _utc_iso(),
            "modelPath": str(MODEL_PATH),
            **metadata,
        }
        with METADATA_PATH.open("w", encoding="utf-8") as f:
            json.dump(full_meta, f, indent=2, default=str)

        # Invalidate cache so next call reloads
        _model_cache = model
        _model_loaded = True

        _LOG.info(
            "[ScoreCalibration] Model saved — mae=%.2f r2=%.3f samples=%d",
            metadata.get("mae", 0),
            metadata.get("r2", 0),
            metadata.get("datasetSize", 0),
        )
        return True
    except Exception as exc:  # noqa: BLE001
        _LOG.error("[ScoreCalibration] Failed to save model: %s", exc)
        return False


def predict(
    features: dict[str, float],
    system_score: float,
    feature_names: list[str],
) -> Optional[float]:
    """Predict a calibrated score using the trained model.

    Applies a ±15 pt safety cap around system_score.

    Args:
        features:      Feature vector from ml_feature_extractor.
        system_score:  Phase 3 deterministic score (0–100).
        feature_names: Ordered list of feature names (must match training order).

    Returns:
        Calibrated score float (0–100), or None if model is not available.
    """
    model = load_model()
    if model is None:
        return None

    try:
        import numpy as np

        # Build feature array in correct order
        x = np.array(
            [[features.get(name, 0.0) for name in feature_names]],
            dtype=np.float32,
        )

        raw_prediction = float((model).predict(x)[0])  # type: ignore[union-attr]

        # Apply safety cap: ML cannot deviate more than ±15 from system score
        lo = max(0.0, system_score - _MAX_SCORE_ADJUSTMENT)
        hi = min(100.0, system_score + _MAX_SCORE_ADJUSTMENT)
        calibrated = round(max(lo, min(hi, raw_prediction)), 2)

        _LOG.debug(
            "[ScoreCalibration] system=%.1f raw_ml=%.1f calibrated=%.1f",
            system_score,
            raw_prediction,
            calibrated,
        )
        return calibrated

    except Exception as exc:  # noqa: BLE001
        _LOG.error("[ScoreCalibration] Prediction error: %s", exc)
        return None


def get_metadata() -> Optional[dict]:
    """Return training metadata from the registry, or None if not trained."""
    if not METADATA_PATH.exists():
        return None
    try:
        with METADATA_PATH.open("r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as exc:  # noqa: BLE001
        _LOG.error("[ScoreCalibration] Metadata read error: %s", exc)
        return None


def reset_cache() -> None:
    """Force model reload on next predict() call (useful after retraining)."""
    global _model_cache, _model_loaded
    _model_cache = None
    _model_loaded = False
