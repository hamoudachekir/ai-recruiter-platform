"""Tenant Model Registry — Phase 5.

Loads per-tenant XGBoost calibration models with a three-tier fallback:

  1. Tenant-specific model  (tenant_model_registry/{tenantId}/model.pkl)
  2. Global model           (model_registry/score_calibration_v1.pkl)
  3. Deterministic passthrough (no ML calibration)

This allows different organisations to have models trained on their own
recruiter feedback without interfering with other tenants.

MODEL STORAGE LAYOUT:
  app/ml_models/
    model_registry/
      score_calibration_v1.pkl       ← global model (Phase 4)
      metadata.json
    tenant_model_registry/
      tenant_abc123/
        model.pkl
        metadata.json
      tenant_xyz789/
        model.pkl
        metadata.json

THREAD SAFETY: models are loaded lazily and cached per-tenant in a
module-level dict. The cache is invalidated by calling invalidate_cache().
"""

from __future__ import annotations

import json
import logging
import pickle
from pathlib import Path
from typing import Optional

_LOG = logging.getLogger(__name__)

_MODULE_DIR = Path(__file__).parent
_TENANT_REGISTRY_DIR = _MODULE_DIR  # same directory as this file
_MAX_ADJUSTMENT = 15.0  # same safety cap as global model

# Module-level cache: tenant_id → loaded model object (or None)
_model_cache: dict[str, Optional[object]] = {}
_metadata_cache: dict[str, Optional[dict]] = {}


def _tenant_model_path(tenant_id: str) -> Path:
    return _TENANT_REGISTRY_DIR / tenant_id / "model.pkl"


def _tenant_metadata_path(tenant_id: str) -> Path:
    return _TENANT_REGISTRY_DIR / tenant_id / "metadata.json"


def load_model_for_tenant(tenant_id: str) -> Optional[object]:
    """Load the best available model for a tenant.

    Resolution order:
      1. Tenant-specific model (cached after first load)
      2. Global model from Phase 4
      3. None (deterministic passthrough)

    Args:
        tenant_id: The tenant whose model to load.

    Returns:
        A trained XGBoost regressor, or None.
    """
    # ── Cache hit ─────────────────────────────────────────────────────────
    if tenant_id in _model_cache:
        return _model_cache[tenant_id]

    # ── Try tenant-specific model ─────────────────────────────────────────
    model_path = _tenant_model_path(tenant_id)
    if model_path.exists():
        try:
            with model_path.open("rb") as f:
                model = pickle.load(f)
            _model_cache[tenant_id] = model
            _LOG.info("[TenantRegistry] Loaded tenant model for tenantId=%s", tenant_id)
            return model
        except Exception as exc:  # noqa: BLE001
            _LOG.warning(
                "[TenantRegistry] Failed to load tenant model for %s: %s",
                tenant_id,
                exc,
            )

    # ── Fallback: global model ────────────────────────────────────────────
    try:
        from app.ml_models.score_calibration_model import load_model

        global_model = load_model()
        _model_cache[tenant_id] = global_model
        if global_model is not None:
            _LOG.info("[TenantRegistry] Using global model for tenantId=%s", tenant_id)
        return global_model
    except Exception as exc:  # noqa: BLE001
        _LOG.warning(
            "[TenantRegistry] Global model unavailable for %s: %s", tenant_id, exc
        )

    _model_cache[tenant_id] = None
    return None


def get_metadata_for_tenant(tenant_id: str) -> Optional[dict]:
    """Return model metadata for a tenant, or global metadata as fallback."""
    if tenant_id in _metadata_cache:
        return _metadata_cache[tenant_id]

    meta_path = _tenant_metadata_path(tenant_id)
    if meta_path.exists():
        try:
            with meta_path.open("r", encoding="utf-8") as f:
                meta = json.load(f)
            _metadata_cache[tenant_id] = meta
            return meta
        except Exception:  # noqa: BLE001
            pass

    # Fallback to global metadata
    try:
        from app.ml_models.score_calibration_model import get_metadata

        meta = get_metadata()
        _metadata_cache[tenant_id] = meta
        return meta
    except Exception:  # noqa: BLE001
        pass

    _metadata_cache[tenant_id] = None
    return None


def predict_for_tenant(
    tenant_id: str,
    features: dict[str, float],
    system_score: float,
    feature_names: list[str],
) -> Optional[float]:
    """Run calibration prediction for a specific tenant.

    Applies the same ±15 pt safety cap as the global model.

    Args:
        tenant_id:     Tenant to use.
        features:      Feature vector dict.
        system_score:  Phase 3 score (0–100).
        feature_names: Ordered feature name list.

    Returns:
        Calibrated score or None if no model available.
    """
    model = load_model_for_tenant(tenant_id)
    if model is None:
        return None

    try:
        import numpy as np

        x = np.array(
            [[features.get(name, 0.0) for name in feature_names]],
            dtype=np.float32,
        )
        raw = float((model).predict(x)[0])  # type: ignore[union-attr]
        lo = max(0.0, system_score - _MAX_ADJUSTMENT)
        hi = min(100.0, system_score + _MAX_ADJUSTMENT)
        return round(max(lo, min(hi, raw)), 2)
    except Exception as exc:  # noqa: BLE001
        _LOG.error(
            "[TenantRegistry] predict_for_tenant failed for %s: %s", tenant_id, exc
        )
        return None


def save_tenant_model(tenant_id: str, model: object, metadata: dict) -> bool:
    """Save a trained model to the tenant-specific registry directory."""
    try:
        tenant_dir = _TENANT_REGISTRY_DIR / tenant_id
        tenant_dir.mkdir(parents=True, exist_ok=True)

        with (tenant_dir / "model.pkl").open("wb") as f:
            pickle.dump(model, f)

        with (tenant_dir / "metadata.json").open("w", encoding="utf-8") as f:
            json.dump(
                {**metadata, "tenantId": tenant_id},
                f,
                indent=2,
                default=str,
            )

        # Invalidate cache
        _model_cache.pop(tenant_id, None)
        _metadata_cache.pop(tenant_id, None)

        _LOG.info("[TenantRegistry] Saved model for tenantId=%s", tenant_id)
        return True
    except Exception as exc:  # noqa: BLE001
        _LOG.error(
            "[TenantRegistry] save_tenant_model failed for %s: %s", tenant_id, exc
        )
        return False


def invalidate_cache(tenant_id: Optional[str] = None) -> None:
    """Invalidate cached models. Pass None to clear all tenants."""
    if tenant_id:
        _model_cache.pop(tenant_id, None)
        _metadata_cache.pop(tenant_id, None)
    else:
        _model_cache.clear()
        _metadata_cache.clear()


def list_tenants_with_models() -> list[str]:
    """Return tenant IDs that have their own trained model file."""
    result = []
    if not _TENANT_REGISTRY_DIR.exists():
        return result
    for child in _TENANT_REGISTRY_DIR.iterdir():
        if child.is_dir() and (child / "model.pkl").exists():
            result.append(child.name)
    return result
