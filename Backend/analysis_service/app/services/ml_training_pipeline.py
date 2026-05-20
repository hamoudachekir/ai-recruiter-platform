"""ML Training Pipeline — Phase 4.

Trains the score calibration model from the interview_ml_dataset collection.

USAGE (run as a standalone script or call train() from application code):

    from app.services.ml_training_pipeline import train
    result = train()

STEPS:
    1. Load records from interview_ml_dataset
    2. Validate and filter (drop incomplete/insufficient records)
    3. Build feature matrix X and target vector y
    4. Split: 70% train / 20% val / 10% test
    5. Train XGBoost regressor
    6. Evaluate MAE + R² on validation set
    7. Save model + metadata to model_registry/
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

_LOG = logging.getLogger(__name__)

# Minimum number of records required to train
_MIN_RECORDS = 10


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def train(min_records: int = _MIN_RECORDS) -> dict:
    """Load data, train, evaluate, and save the calibration model.

    Args:
        min_records: Minimum dataset size required to attempt training.

    Returns:
        dict with keys:
          success, message, mae, r2, datasetSize, modelVersion
    """
    try:
        return _train_inner(min_records)
    except Exception as exc:  # noqa: BLE001
        _LOG.error("[TrainingPipeline] Training failed: %s", exc)
        return {
            "success": False,
            "message": f"Training error: {exc}",
            "mae": None,
            "r2": None,
            "datasetSize": 0,
            "modelVersion": None,
        }


def _train_inner(min_records: int) -> dict:
    # ── 0. Import dependencies ────────────────────────────────────────────
    try:
        import numpy as np
        from sklearn.metrics import mean_absolute_error, r2_score
        from sklearn.model_selection import train_test_split
        from xgboost import XGBRegressor
    except ImportError as exc:
        return {
            "success": False,
            "message": f"Missing dependency: {exc}. Install xgboost and scikit-learn.",
            "mae": None,
            "r2": None,
            "datasetSize": 0,
            "modelVersion": None,
        }

    from app.db.mongo import ml_dataset_col
    from app.ml_models.score_calibration_model import (
        FEATURE_NAMES as _FEATURE_NAMES_IMPORT,
    )
    from app.ml_models.score_calibration_model import (
        reset_cache,
        save_model,
    )
    from app.services.ml_feature_extractor import FEATURE_NAMES

    # ── 1. Load records ───────────────────────────────────────────────────
    records = list(
        ml_dataset_col.find(
            {
                "humanScore": {"$exists": True},
                "features.mlFeatureVector": {"$exists": True},
            },
            {"_id": 0},
        )
    )

    _LOG.info("[TrainingPipeline] Loaded %d raw records", len(records))

    # ── 2. Validate + filter ──────────────────────────────────────────────
    valid = []
    for r in records:
        human_score = r.get("humanScore")
        fv = (r.get("features") or {}).get("mlFeatureVector") or {}
        if human_score is None:
            continue
        if not isinstance(human_score, (int, float)):
            continue
        if not fv:
            continue
        valid.append(r)

    _LOG.info("[TrainingPipeline] Valid records after filtering: %d", len(valid))

    # ── 2-B. Training data quality filtering ─────────────────────────────
    # Apply strict quality gates: reject records with low confidence,
    # failed transcripts, low evidence coverage, or high bias risk.
    try:
        from app.services.training_data_quality_service import (
            filter_dataset,
            get_dataset_quality_report,
        )

        quality_report = get_dataset_quality_report(valid)
        valid = filter_dataset(valid)
        _LOG.info(
            "[TrainingPipeline] Quality filter: %d/%d records accepted "
            "(acceptance_rate=%.1f%%)",
            quality_report["acceptedRecords"],
            quality_report["totalRecords"],
            quality_report["acceptanceRate"] * 100,
        )
    except Exception as _qf_exc:  # noqa: BLE001
        _LOG.warning(
            "[TrainingPipeline] Quality filter failed — proceeding with "
            "unfiltered data: %s",
            _qf_exc,
        )

    if len(valid) < min_records:
        return {
            "success": False,
            "message": (
                f"Insufficient data: {len(valid)} valid records "
                f"(minimum {min_records} required)."
            ),
            "mae": None,
            "r2": None,
            "datasetSize": len(valid),
            "modelVersion": None,
        }

    # ── 3. Build X and y ──────────────────────────────────────────────────
    X_rows = []
    y_rows = []
    for r in valid:
        fv = (r.get("features") or {}).get("mlFeatureVector") or {}
        system_score = float(r.get("systemScore") or 0)
        human_score = float(r["humanScore"])

        row = [fv.get(name, 0.0) for name in FEATURE_NAMES]
        row.append(system_score / 100.0)  # append systemScore as a feature (normalised)
        X_rows.append(row)
        y_rows.append(human_score)

    X = np.array(X_rows, dtype=np.float32)
    y = np.array(y_rows, dtype=np.float32)

    # ── 4. Split ──────────────────────────────────────────────────────────
    # 70 % train+val, 10 % test
    X_trainval, X_test, y_trainval, y_test = train_test_split(
        X, y, test_size=0.10, random_state=42
    )
    # 20 % validation out of the remaining 90 %  ≈  22 % of total
    X_train, X_val, y_train, y_val = train_test_split(
        X_trainval, y_trainval, test_size=0.222, random_state=42
    )

    _LOG.info(
        "[TrainingPipeline] Split — train=%d val=%d test=%d",
        len(X_train),
        len(X_val),
        len(X_test),
    )

    # ── 5. Train XGBoost ──────────────────────────────────────────────────
    model = XGBRegressor(
        n_estimators=100,
        max_depth=4,
        learning_rate=0.1,
        subsample=0.8,
        colsample_bytree=0.8,
        objective="reg:squarederror",
        random_state=42,
        verbosity=0,
    )
    model.fit(
        X_train,
        y_train,
        eval_set=[(X_val, y_val)],
        verbose=False,
    )

    # ── 6. Evaluate ───────────────────────────────────────────────────────
    y_pred_val = model.predict(X_val)
    mae_val = float(mean_absolute_error(y_val, y_pred_val))
    r2_val = float(r2_score(y_val, y_pred_val))

    y_pred_test = model.predict(X_test)
    mae_test = float(mean_absolute_error(y_test, y_pred_test))

    _LOG.info(
        "[TrainingPipeline] Evaluation — val_mae=%.2f val_r2=%.3f test_mae=%.2f",
        mae_val,
        r2_val,
        mae_test,
    )

    # ── 7. Save ───────────────────────────────────────────────────────────
    # Store feature names + systemScore in metadata so inference knows the order
    extended_feature_names = FEATURE_NAMES + ["system_score_norm"]

    metadata = {
        "mae": round(mae_val, 4),
        "r2": round(r2_val, 4),
        "testMae": round(mae_test, 4),
        "datasetSize": len(valid),
        "featureNames": extended_feature_names,
        "trainSamples": len(X_train),
        "valSamples": len(X_val),
        "testSamples": len(X_test),
        "xgboostParams": {
            "n_estimators": 100,
            "max_depth": 4,
            "learning_rate": 0.1,
        },
    }

    saved = save_model(model, metadata)
    reset_cache()

    if not saved:
        return {
            "success": False,
            "message": "Model trained but could not be saved to registry.",
            "mae": mae_val,
            "r2": r2_val,
            "datasetSize": len(valid),
            "modelVersion": None,
        }

    return {
        "success": True,
        "message": f"Model trained and saved. MAE={mae_val:.2f} R²={r2_val:.3f}",
        "mae": mae_val,
        "r2": r2_val,
        "datasetSize": len(valid),
        "modelVersion": "score_calibration_v1",
    }
