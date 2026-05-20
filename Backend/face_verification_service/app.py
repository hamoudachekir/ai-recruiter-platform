"""
Fast Face Verification Microservice

InsightFace + ONNXRuntime service for 1:1 identity verification.

Privacy rules:
- No race/gender/age/emotion analysis.
- Profile photo and live frames are decoded in memory only.
- No raw live frames are stored permanently.
- Only normalized embeddings and verification metadata leave this service.
"""

import base64
import logging
import os
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np
from flask import Flask, jsonify, request
from flask_cors import CORS

app = Flask(__name__)
CORS(app)
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

MODEL_PACK = os.getenv("FACE_VERIFY_MODEL_PACK", "buffalo_l")
THRESHOLD = float(os.getenv("FACE_VERIFY_THRESHOLD", "0.60"))
DET_SIZE = int(os.getenv("FACE_VERIFY_DET_SIZE", "640"))
MAX_FRAMES = int(os.getenv("FACE_VERIFY_MAX_FRAMES", "3"))
REQUIRED_FRAMES = int(os.getenv("FACE_VERIFY_REQUIRED_FRAMES", "3"))
MIN_MATCHING_FRAMES = int(os.getenv("FACE_VERIFY_MIN_MATCHING_FRAMES", "2"))
REQUEST_IMAGE_MAX_BYTES = int(os.getenv("FACE_VERIFY_IMAGE_MAX_BYTES", str(12 * 1024 * 1024)))
QUALITY_BRIGHTNESS_MIN = float(os.getenv("FACE_VERIFY_BRIGHTNESS_MIN", "35"))
QUALITY_BRIGHTNESS_MAX = float(os.getenv("FACE_VERIFY_BRIGHTNESS_MAX", "240"))
QUALITY_MIN_FACE_RATIO = float(os.getenv("FACE_VERIFY_MIN_FACE_RATIO", "0.12"))
QUALITY_MIN_BLUR_SCORE = float(os.getenv("FACE_VERIFY_MIN_BLUR_SCORE", "18"))
CTX_ID_ENV = os.getenv("FACE_VERIFY_CTX_ID")

_face_app = None
_model_ready = False
_model_error = None
_providers: List[str] = []
_ctx_id = -1


def _select_runtime() -> Tuple[List[str], int]:
    try:
        import onnxruntime as ort

        available = set(ort.get_available_providers())
    except Exception:
        available = set()

    if CTX_ID_ENV not in (None, ""):
        ctx_id = int(CTX_ID_ENV)
        if ctx_id >= 0 and "CUDAExecutionProvider" in available:
            return ["CUDAExecutionProvider", "CPUExecutionProvider"], ctx_id
        return ["CPUExecutionProvider"], -1

    if "CUDAExecutionProvider" in available:
        return ["CUDAExecutionProvider", "CPUExecutionProvider"], 0
    return ["CPUExecutionProvider"], -1


def load_model() -> None:
    global _face_app, _model_ready, _model_error, _providers, _ctx_id
    try:
        from insightface.app import FaceAnalysis

        _providers, _ctx_id = _select_runtime()
        log.info(
            "Loading InsightFace model pack=%s providers=%s ctx_id=%s",
            MODEL_PACK,
            _providers,
            _ctx_id,
        )
        face_app = FaceAnalysis(
            name=MODEL_PACK,
            providers=_providers,
            allowed_modules=["detection", "recognition"],
        )
        face_app.prepare(ctx_id=_ctx_id, det_size=(DET_SIZE, DET_SIZE))
        _face_app = face_app
        _model_ready = True
        _model_error = None
        log.info("InsightFace model ready")

        # Trigger ONNX runtime warmup so the first real verification doesn't
        # pay the 5–10s cold-start tax. We feed a synthetic dummy image; the
        # detector will return zero faces but kernels get JIT-compiled and
        # cached on disk for subsequent runs.
        try:
            warmup = np.zeros((DET_SIZE, DET_SIZE, 3), dtype=np.uint8)
            face_app.get(warmup)
            log.info("InsightFace warmup complete")
        except Exception as warmup_exc:
            log.warning("InsightFace warmup failed (non-fatal): %s", warmup_exc)
    except Exception as exc:
        _face_app = None
        _model_ready = False
        _model_error = str(exc)
        log.exception("InsightFace model failed to load")


def get_model():
    if not _model_ready or _face_app is None:
        raise RuntimeError(_model_error or "face model is not ready")
    return _face_app


def _decode_image(image_b64: str) -> np.ndarray:
    if not image_b64 or not isinstance(image_b64, str):
        raise ValueError("imageBase64 is required")

    payload = image_b64.split(",", 1)[-1] if "," in image_b64 else image_b64
    raw = base64.b64decode(payload, validate=False)
    if len(raw) > REQUEST_IMAGE_MAX_BYTES:
        raise ValueError("image is too large")

    image_array = np.frombuffer(raw, dtype=np.uint8)
    image = cv2.imdecode(image_array, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("invalid image")
    return image


def _brightness(image: np.ndarray) -> float:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    return float(np.mean(gray))


def _blur_score(image: np.ndarray) -> float:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    resized = cv2.resize(gray, (min(320, gray.shape[1]), min(240, gray.shape[0])))
    return float(cv2.Laplacian(resized, cv2.CV_64F).var())


def _normalize_embedding(embedding: Any) -> List[float]:
    vector = np.asarray(embedding, dtype=np.float32).reshape(-1)
    norm = float(np.linalg.norm(vector))
    if not np.isfinite(norm) or norm <= 0:
        raise ValueError("invalid face embedding")
    return (vector / norm).astype(float).tolist()


def _extract_one_embedding(image_b64: str) -> Dict[str, Any]:
    image = _decode_image(image_b64)
    brightness = _brightness(image)
    blur_score = _blur_score(image)
    faces = get_model().get(image)
    face_count = len(faces or [])

    quality = {
        "faceDetected": face_count > 0,
        "multipleFaces": face_count > 1,
        "brightness": brightness,
        "blurScore": blur_score,
        "faceCount": face_count,
    }

    if face_count == 0:
        return {"ok": False, "reason": "no_face", "quality": quality}
    if face_count > 1:
        return {"ok": False, "reason": "multiple_faces", "quality": quality}

    face = faces[0]
    embedding = getattr(face, "normed_embedding", None)
    if embedding is None:
        embedding = getattr(face, "embedding", None)
    if embedding is None:
        return {"ok": False, "reason": "embedding_failed", "quality": quality}

    bbox = [float(v) for v in getattr(face, "bbox", [])]
    if len(bbox) == 4:
        image_h, image_w = image.shape[:2]
        face_w = max(0.0, bbox[2] - bbox[0])
        face_h = max(0.0, bbox[3] - bbox[1])
        quality["faceRatio"] = float(max(face_w / max(1, image_w), face_h / max(1, image_h)))

    quality_issues = []
    if brightness < QUALITY_BRIGHTNESS_MIN or brightness > QUALITY_BRIGHTNESS_MAX:
        quality_issues.append("brightness")
    if quality.get("faceRatio", 1.0) < QUALITY_MIN_FACE_RATIO:
        quality_issues.append("face_too_small")
    if blur_score < QUALITY_MIN_BLUR_SCORE:
        quality_issues.append("blurry")
    if quality_issues:
        quality["issues"] = quality_issues
        return {"ok": False, "reason": "low_quality", "quality": quality}

    return {
        "ok": True,
        "embedding": _normalize_embedding(embedding),
        "quality": quality,
    }


def _cosine_similarity(a: List[float], b: List[float]) -> float:
    av = np.asarray(a, dtype=np.float32).reshape(-1)
    bv = np.asarray(b, dtype=np.float32).reshape(-1)
    if av.shape != bv.shape:
        raise ValueError("embedding dimension mismatch")
    av = av / max(float(np.linalg.norm(av)), 1e-8)
    bv = bv / max(float(np.linalg.norm(bv)), 1e-8)
    return float(np.dot(av, bv))


def _health_payload() -> Dict[str, Any]:
    return {
        "status": "ok" if _model_ready else "degraded",
        "modelReady": _model_ready,
        "model": MODEL_PACK,
        "providers": _providers,
        "ctxId": _ctx_id,
        "threshold": THRESHOLD,
        "requiredFrames": REQUIRED_FRAMES,
        "minMatchingFrames": MIN_MATCHING_FRAMES,
        "error": _model_error,
    }


@app.get("/face/health")
@app.get("/health")
def health():
    status_code = 200 if _model_ready else 503
    return jsonify(_health_payload()), status_code


@app.post("/face/enroll")
def enroll():
    try:
        body = request.get_json(force=True, silent=True) or {}
        image_b64 = body.get("imageBase64") or body.get("photoBase64") or body.get("referenceImageBase64")
        result = _extract_one_embedding(image_b64)

        if not result["ok"]:
            return jsonify({
                "enrolled": False,
                "status": "uncertain",
                "reason": result["reason"],
                "quality": result["quality"],
                "model": MODEL_PACK,
            })

        return jsonify({
            "enrolled": True,
            "status": "enrolled",
            "embedding": result["embedding"],
            "model": MODEL_PACK,
            "quality": result["quality"],
        })
    except ValueError as exc:
        return jsonify({"enrolled": False, "status": "failed", "reason": str(exc)}), 400
    except Exception as exc:
        log.exception("Enrollment failed")
        return jsonify({"enrolled": False, "status": "failed", "reason": str(exc)}), 500


@app.post("/face/verify")
def verify():
    try:
        body = request.get_json(force=True, silent=True) or {}
        profile_embedding = body.get("profileEmbedding") or body.get("referenceEmbedding")
        live_frames = body.get("liveFrames") or body.get("frames") or []
        threshold = float(body.get("threshold") or THRESHOLD)
        required_frames = max(1, min(MAX_FRAMES, int(body.get("requiredFrames") or REQUIRED_FRAMES)))
        min_matching_frames = max(
            1,
            min(required_frames, int(body.get("minMatchingFrames") or MIN_MATCHING_FRAMES)),
        )

        if not isinstance(profile_embedding, list) or not profile_embedding:
            return jsonify({
                "status": "failed",
                "verified": False,
                "allowInterview": False,
                "reason": "profile_embedding_required",
            }), 400
        if not isinstance(live_frames, list) or not live_frames:
            return jsonify({
                "status": "uncertain",
                "verified": False,
                "allowInterview": False,
                "reason": "live_frames_required",
                "threshold": threshold,
                "requiredFrames": required_frames,
                "minMatchingFrames": min_matching_frames,
            })

        frames_to_check = live_frames[:required_frames]
        if len(frames_to_check) < required_frames:
            return jsonify({
                "status": "uncertain",
                "verified": False,
                "allowInterview": False,
                "reason": "insufficient_live_frames",
                "threshold": threshold,
                "framesChecked": len(frames_to_check),
                "totalFrames": len(frames_to_check),
                "validFrames": 0,
                "requiredFrames": required_frames,
                "minMatchingFrames": min_matching_frames,
            })

        frame_results = []
        similarities = []
        reasons = []

        for index, frame_b64 in enumerate(frames_to_check):
            extracted = _extract_one_embedding(frame_b64)
            if not extracted["ok"]:
                reason = extracted["reason"]
                reasons.append(reason)
                frame_results.append({
                    "index": index,
                    "ok": False,
                    "reason": reason,
                    "quality": extracted["quality"],
                })
                continue

            similarity = _cosine_similarity(profile_embedding, extracted["embedding"])
            similarities.append(similarity)
            frame_results.append({
                "index": index,
                "ok": True,
                "matched": similarity >= threshold,
                "similarity": similarity,
                "quality": extracted["quality"],
            })

        valid_frames = len(similarities)
        frames_checked = len(frame_results)
        best_similarity: Optional[float] = max(similarities) if similarities else None
        median_similarity: Optional[float] = float(np.median(similarities)) if similarities else None
        matching_frames = int(sum(1 for score in similarities if score >= threshold))

        if reasons or valid_frames < required_frames or median_similarity is None:
            if "multiple_faces" in reasons:
                primary_reason = "multiple_faces"
                status = "multiple_faces"
            elif "no_face" in reasons:
                primary_reason = "no_face"
                status = "no_face"
            elif "low_quality" in reasons:
                primary_reason = "low_quality"
                status = "uncertain"
            else:
                primary_reason = "no_valid_face"
                status = "uncertain"
            return jsonify({
                "status": status,
                "verified": False,
                "allowInterview": False,
                "metric": "cosine_similarity",
                "reason": primary_reason,
                "similarity": median_similarity,
                "medianSimilarity": median_similarity,
                "bestSimilarity": best_similarity,
                "threshold": threshold,
                "framesChecked": frames_checked,
                "totalFrames": frames_checked,
                "validFrames": valid_frames,
                "matchingFrames": matching_frames,
                "requiredFrames": required_frames,
                "minMatchingFrames": min_matching_frames,
                "frameResults": frame_results,
            })

        matched = matching_frames >= min_matching_frames and median_similarity >= threshold
        return jsonify({
            "status": "matched" if matched else "not_matched",
            "verified": matched,
            "allowInterview": matched,
            "metric": "cosine_similarity",
            "similarity": median_similarity,
            "medianSimilarity": median_similarity,
            "bestSimilarity": best_similarity,
            "threshold": threshold,
            "framesChecked": frames_checked,
            "totalFrames": frames_checked,
            "validFrames": valid_frames,
            "matchingFrames": matching_frames,
            "requiredFrames": required_frames,
            "minMatchingFrames": min_matching_frames,
            "frameResults": frame_results,
        })
    except ValueError as exc:
        return jsonify({"status": "failed", "verified": False, "allowInterview": False, "reason": str(exc)}), 400
    except Exception as exc:
        log.exception("Verification failed")
        return jsonify({"status": "failed", "verified": False, "allowInterview": False, "reason": str(exc)}), 500


# Backward-compatible endpoint for older callers during local migration.
@app.post("/verify-face")
def verify_legacy():
    body = request.get_json(force=True, silent=True) or {}
    ref_b64 = body.get("referenceImageBase64")
    live_frames = body.get("liveFrames") or []
    enrolled = _extract_one_embedding(ref_b64)
    if not enrolled["ok"]:
        return jsonify({
            "status": "uncertain",
            "verified": False,
            "reason": enrolled["reason"],
            "framesChecked": 0,
            "validFrames": 0,
        })
    with app.test_request_context(
        "/face/verify",
        method="POST",
        json={"profileEmbedding": enrolled["embedding"], "liveFrames": live_frames},
    ):
        return verify()


load_model()


if __name__ == "__main__":
    port = int(os.getenv("PORT", 8011))
    log.info("Face verification service starting on port %d", port)
    app.run(host="0.0.0.0", port=port, debug=False)
