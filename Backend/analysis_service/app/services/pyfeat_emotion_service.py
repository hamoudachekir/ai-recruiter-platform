"""Py-Feat emotion analysis — replacement for DeepFace Mini-Xception.

Py-Feat (https://py-feat.org) is trained on AffectNet (real-world face
images) and exposes Facial Action Units (FACS) which are far more
reliable than raw emotion probabilities. This service wraps Py-Feat
behind a single ``analyze_frame()`` function so the existing pipeline
can call into it without knowing anything about the underlying detector.

Heavy dependencies (``feat``, ``torch``) are imported lazily. If they
are not installed the caller can fall back to DeepFace — see
``EMOTION_ENGINE`` in ``app.core.config``. The module must therefore
import cleanly even when torch/py-feat are missing.
"""
from __future__ import annotations

import logging
from typing import Any, Optional

import os
import tempfile

import cv2
import numpy as np

from app.core.config import PYFEAT_DEVICE

_LOG = logging.getLogger(__name__)

# Py-Feat → standard short emotion names used by the rest of the pipeline.
PYFEAT_TO_STANDARD = {
    "anger": "angry",
    "disgust": "disgust",
    "fear": "fear",
    "happiness": "happy",
    "sadness": "sad",
    "surprise": "surprise",
    "neutral": "neutral",
}
STANDARD_EMOTIONS = ("angry", "disgust", "fear", "happy", "sad", "surprise", "neutral")

_DETECTOR = None
_IMPORT_ERROR: Optional[str] = None


def _shim_scipy_simps() -> None:
    """Compatibility shim for scipy>=1.14 which removed the legacy
    ``scipy.integrate.simps`` alias (renamed to ``simpson`` in 1.12).
    Py-Feat 0.6.x still imports ``simps`` at module load. We alias it
    back to ``simpson`` so the import succeeds.
    """
    try:
        import scipy.integrate as si  # type: ignore
    except Exception:  # noqa: BLE001
        return
    if not hasattr(si, "simps") and hasattr(si, "simpson"):
        si.simps = si.simpson  # type: ignore[attr-defined]


def _shim_torchvision_read_video() -> None:
    """Compatibility shim for torchvision >= 0.22 (which removed
    ``torchvision.io.read_video``). Py-Feat 0.6.x imports the symbol
    unconditionally at module load — patch in a stub so the import
    succeeds. We never call ``read_video`` from this service (we analyze
    individual frames via ``detect_image_array``), so a raising stub is
    safe; it just means anyone who *does* call it will get a clear error.
    """
    try:
        import torchvision.io as tvi  # type: ignore
    except Exception:  # noqa: BLE001
        return

    def _missing(*_args: Any, **_kwargs: Any) -> None:
        raise NotImplementedError(
            "torchvision.io.read_video was removed in torchvision>=0.22. "
            "This shim exists so py-feat can import, but video reading is "
            "not used by this service."
        )

    if not hasattr(tvi, "read_video"):
        tvi.read_video = _missing  # type: ignore[attr-defined]
    if not hasattr(tvi, "read_video_timestamps"):
        tvi.read_video_timestamps = _missing  # type: ignore[attr-defined]


def _import_feat() -> Any:
    """Return the ``feat`` module if importable, otherwise raise."""
    global _IMPORT_ERROR
    try:
        _shim_scipy_simps()
        _shim_torchvision_read_video()
        from feat import Detector  # type: ignore
        return Detector
    except Exception as exc:  # noqa: BLE001
        _IMPORT_ERROR = f"{type(exc).__name__}: {exc}"
        raise


def is_available() -> bool:
    """Best-effort check that Py-Feat can be imported on this machine."""
    try:
        _import_feat()
        return True
    except Exception:  # noqa: BLE001
        return False


def get_detector():
    """Lazily construct (or return cached) Py-Feat Detector. Heavy: ~1 GB
    of model weights are downloaded on first call.
    """
    global _DETECTOR
    if _DETECTOR is not None:
        return _DETECTOR
    Detector = _import_feat()
    _LOG.info("[PyFeat] Loading detector models (first call — ~30s + downloads)...")
    _DETECTOR = Detector(
        face_model="retinaface",
        landmark_model="mobilefacenet",
        au_model="xgb",
        emotion_model="resmasknet",
        facepose_model="img2pose",
        device=PYFEAT_DEVICE,
    )
    _LOG.info("[PyFeat] Detector ready.")
    return _DETECTOR


def _normalize_emotion_probs(raw: dict[str, float]) -> dict[str, float]:
    """Convert Py-Feat emotion row (named in long form) to the short-form
    {angry/happy/...} dict on a 0..1 scale, with the rows summing to 1.
    """
    out = {k: 0.0 for k in STANDARD_EMOTIONS}
    total = 0.0
    for pyfeat_name, val in raw.items():
        std = PYFEAT_TO_STANDARD.get(pyfeat_name.lower())
        if std is None:
            continue
        v = float(val)
        if not np.isfinite(v) or v < 0:
            v = 0.0
        out[std] = v
        total += v
    if total > 0:
        out = {k: (v / total) for k, v in out.items()}
    return out


def _run_detector(detector: Any, frame_bgr: np.ndarray) -> Optional[Any]:
    """Run the Py-Feat detector on a single in-memory BGR frame.

    Py-Feat 0.6.x doesn't have a stable in-memory entry point — the
    documented stable API is ``Detector.detect_image([paths])``. We try
    a few in-memory methods first (in case newer versions expose them),
    then fall back to writing a temp JPEG and calling ``detect_image``.
    """
    rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)

    # 1) Modern py-feat sometimes exposes a numpy-array entry point.
    for method_name in ("detect_image_array", "detect_array", "predict_image"):
        method = getattr(detector, method_name, None)
        if method is None:
            continue
        try:
            res = method(rgb)
            if res is not None and len(res) > 0:
                return res
        except Exception as exc:  # noqa: BLE001
            _LOG.debug("[PyFeat] %s() failed: %s", method_name, exc)

    # 2) detect() is the modern omnibus API — try passing a path AFTER we
    # write the frame. If detect() accepts arrays directly in your version
    # it'll be picked up in (3) below.
    tmp_path: Optional[str] = None
    try:
        fd, tmp_path = tempfile.mkstemp(prefix="pyfeat_frame_", suffix=".jpg")
        os.close(fd)
        # cv2 expects BGR for imwrite (which is what we already have)
        ok = cv2.imwrite(tmp_path, frame_bgr)
        if not ok:
            _LOG.debug("[PyFeat] cv2.imwrite returned False for %s", tmp_path)
            return None

        # 3) detect() — supports paths in all py-feat versions
        detect_fn = getattr(detector, "detect", None)
        if callable(detect_fn):
            try:
                res = detect_fn(tmp_path, data_type="image")
                if res is not None and len(res) > 0:
                    return res
            except TypeError:
                # older signature: detect(input_files) without data_type kw
                try:
                    res = detect_fn(tmp_path)
                    if res is not None and len(res) > 0:
                        return res
                except Exception as exc:  # noqa: BLE001
                    _LOG.debug("[PyFeat] detect(path) failed: %s", exc)
            except Exception as exc:  # noqa: BLE001
                _LOG.debug("[PyFeat] detect(path, data_type='image') failed: %s", exc)

        # 4) Legacy: detect_image([path])
        detect_image_fn = getattr(detector, "detect_image", None)
        if callable(detect_image_fn):
            try:
                res = detect_image_fn([tmp_path])
                if res is not None and len(res) > 0:
                    return res
            except Exception as exc:  # noqa: BLE001
                _LOG.debug("[PyFeat] detect_image([path]) failed: %s", exc)

        _LOG.debug("[PyFeat] no detect method succeeded for the frame")
        return None
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


def analyze_frame(
    frame_bgr: np.ndarray, timestamp: float
) -> Optional[dict[str, Any]]:
    """Analyze a single frame and return a normalized result dict.

    Shape mirrors what ``behavioral_timeline_service`` expects from the
    legacy DeepFace path so it can be swapped in seamlessly.
    """
    try:
        detector = get_detector()
    except Exception as exc:  # noqa: BLE001
        _LOG.debug("[PyFeat] Detector unavailable: %s", exc)
        return None

    try:
        result = _run_detector(detector, frame_bgr)
        if result is None or len(result) == 0:
            return None

        emotions_row = result.emotions.iloc[0].to_dict()
        try:
            aus_row = result.aus.iloc[0].to_dict()
        except Exception:  # noqa: BLE001
            aus_row = {}
        try:
            face_row = result.faceboxes.iloc[0].to_dict()
        except Exception:  # noqa: BLE001
            face_row = {}
        pose_row: dict[str, float] = {}
        if hasattr(result, "poses"):
            try:
                pose_row = result.poses.iloc[0].to_dict()
            except Exception:  # noqa: BLE001
                pose_row = {}

        # 68-point facial landmarks — Py-Feat exposes them under one of
        # several attribute names depending on version, with columns
        # following different naming conventions. Try each defensively.
        landmarks_flat: list[int] = []
        for attr in ("landmarks", "landmark"):
            obj = getattr(result, attr, None)
            if obj is None:
                continue
            try:
                row = obj.iloc[0].to_dict()
            except Exception:  # noqa: BLE001
                continue
            # Probe known column name conventions.
            patterns = [
                lambda i: (f"x_{i}", f"y_{i}"),
                lambda i: (f"{i}_x", f"{i}_y"),
                lambda i: (f"X_{i}", f"Y_{i}"),
                lambda i: (f"lmk_{i}_x", f"lmk_{i}_y"),
                lambda i: (f"landmark_{i}_x", f"landmark_{i}_y"),
            ]
            for pat in patterns:
                trial: list[int] = []
                ok = True
                for i in range(68):
                    kx, ky = pat(i)
                    x_val = row.get(kx)
                    y_val = row.get(ky)
                    if x_val is None or y_val is None:
                        ok = False
                        break
                    try:
                        trial.append(int(round(float(x_val))))
                        trial.append(int(round(float(y_val))))
                    except (TypeError, ValueError):
                        ok = False
                        break
                if ok and len(trial) == 136:
                    landmarks_flat = trial
                    break
            if landmarks_flat:
                break

        # Last-resort fallback: scan the entire Fex row (the result
        # itself is a DataFrame) for x_0..x_67 / y_0..y_67 columns.
        if not landmarks_flat:
            try:
                row = result.iloc[0].to_dict()
                trial = []
                for i in range(68):
                    x_val = row.get(f"x_{i}")
                    y_val = row.get(f"y_{i}")
                    if x_val is None or y_val is None:
                        trial = []
                        break
                    trial.append(int(round(float(x_val))))
                    trial.append(int(round(float(y_val))))
                if len(trial) == 136:
                    landmarks_flat = trial
            except Exception as exc:  # noqa: BLE001
                _LOG.debug("[PyFeat] landmark row scan failed: %s", exc)

        if not landmarks_flat:
            _LOG.debug(
                "[PyFeat] no landmarks recovered. Available columns: %s",
                list(getattr(result, "columns", []))[:30],
            )

        probs = _normalize_emotion_probs(emotions_row)
        dominant = max(probs, key=probs.get)

        fw = int(frame_bgr.shape[1])
        fh = int(frame_bgr.shape[0])
        face_box = None
        try:
            x = int(float(face_row.get("FaceRectX", 0) or 0))
            y = int(float(face_row.get("FaceRectY", 0) or 0))
            w = int(float(face_row.get("FaceRectWidth", 0) or 0))
            h = int(float(face_row.get("FaceRectHeight", 0) or 0))
            if w > 0 and h > 0:
                face_box = {"x": x, "y": y, "w": w, "h": h}
        except Exception:  # noqa: BLE001
            face_box = None

        action_units = {
            str(k).upper(): float(v) if np.isfinite(float(v)) else 0.0
            for k, v in aus_row.items()
        }

        return {
            "timestamp": float(timestamp),
            "emotion": probs,
            "action_units": action_units,
            "head_pose": {str(k): float(v) for k, v in pose_row.items() if np.isfinite(float(v))},
            "dominant_emotion": dominant,
            "confidence": float(probs[dominant]),
            "face_box": face_box,
            "frame_w": fw,
            "frame_h": fh,
            "landmarks": landmarks_flat,
        }
    except Exception as exc:  # noqa: BLE001
        _LOG.debug("[PyFeat] Frame analysis failed at t=%.2f: %s", timestamp, exc)
        return None


# ---------------------------------------------------------------------------
# AU-driven safe-label inference (FACS-based, more reliable than raw probs)
# ---------------------------------------------------------------------------
def derive_label_from_aus(action_units: dict[str, float], emotions: dict[str, float]) -> Optional[str]:
    """Return one of the safe advisory labels using AU activations.

    Returns ``None`` if no rule fires, letting the caller fall back to its
    default heuristics.
    """
    if not action_units:
        return None

    def au(name: str) -> float:
        return float(action_units.get(name, 0.0))

    au06 = au("AU06")  # cheek raiser — Duchenne
    au12 = au("AU12")  # lip corner puller — smile
    au15 = au("AU15")  # lip corner depressor — sad
    au17 = au("AU17")  # chin raiser — sad
    au04 = au("AU04")  # brow lowerer — concentration / anger
    au01 = au("AU01")  # inner brow raiser — sad / fear
    au02 = au("AU02")  # outer brow raiser — surprise

    # Genuine (Duchenne) smile
    if au06 > 0.5 and au12 > 0.5:
        return "Positive Expression Shift"
    # Social/polite smile (lip pull without cheek raise)
    if au12 > 0.5 and au06 < 0.3:
        return "Increased Interaction Energy"
    # Sadness — depressed corners or raised inner brow + chin
    if au15 > 0.4 or (au01 > 0.4 and au17 > 0.3):
        return "Possible Hesitation"
    # Brow furrow on a mostly-neutral face → concentration / mild stress
    if au04 > 0.6 and float(emotions.get("neutral", 0.0)) > 0.4:
        return "Attention Variation"
    # Outer brow up + emotion-confirmed surprise
    if au02 > 0.5 and float(emotions.get("surprise", 0.0)) > 0.3:
        return "Behavioral Fluctuation"
    return None
