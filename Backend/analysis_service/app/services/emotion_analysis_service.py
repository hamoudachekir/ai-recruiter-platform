"""Recruiter-only Behavioral Insights Overlay service.

This module is advisory-only by design. It never writes to deterministic final
reports, scoring fields, decision traces, confidence decisions, bias reports, or
ML calibration outputs. Failures are best-effort warnings and must not fail the
interview pipeline.
"""

from __future__ import annotations

import logging
import math
import os
from datetime import datetime, timezone
from pathlib import Path
from statistics import mean, pstdev
from typing import Any, cast

import cv2
import numpy as np
from app.core.config import UPLOADS_DIR
from app.db.mongo import (
    behavioral_audit_logs_col,
    behavioral_events_col,
    pipeline_snapshots_col,
    reports_col,
    transcripts_col,
)
from app.services.ffmpeg_service import extract_frames

_LOG = logging.getLogger(__name__)

BEHAVIORAL_INSIGHTS_ENABLED = os.getenv("ENABLE_BEHAVIORAL_INSIGHTS", "1") == "1"
BEHAVIORAL_OUTPUT_LABEL = "Non-deterministic advisory behavioral signals"

ADVISORY_METADATA_TEXT = (
    f"{BEHAVIORAL_OUTPUT_LABEL}. Recruiter-only, optional, non-authoritative, "
    "and non-decision-making. Does not affect deterministic scoring, decision "
    "traces, confidence decisions, bias reports, replay hashes, ML calibration, "
    "final reports, or hiring decisions."
)

BEHAVIORAL_FRAME_INTERVAL_MS = int(os.getenv("BEHAVIORAL_FRAME_INTERVAL_MS", "1000"))
BEHAVIORAL_MIN_CONFIDENCE = float(os.getenv("BEHAVIORAL_MIN_CONFIDENCE", "0.55"))
BEHAVIORAL_SMOOTHING_WINDOW = max(1, int(os.getenv("BEHAVIORAL_SMOOTHING_WINDOW", "3")))
BEHAVIORAL_EXISTING_FRAME_FPS = float(os.getenv("BEHAVIORAL_EXISTING_FRAME_FPS", "1"))

_ALLOWED_SIGNALS = {
    "possible_hesitation",
    "neutral",
    "engagement_variation",
    "attention_variation",
    "silence_correlation",
}
_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}


class BehavioralAnalysisError(RuntimeError):
    """Non-fatal behavioral overlay error."""


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def record_behavioral_audit_event(
    interview_id: str,
    event_type: str,
    status: str,
    metadata: dict[str, Any] | None = None,
) -> None:
    """Write an isolated audit log for the optional behavioral branch only."""
    try:
        behavioral_audit_logs_col.insert_one(
            {
                "interviewId": interview_id,
                "eventType": event_type,
                "status": status,
                "advisoryOnly": True,
                "outputLabel": BEHAVIORAL_OUTPUT_LABEL,
                "metadata": metadata or {},
                "createdAt": _utc_now(),
            }
        )
    except Exception as exc:  # noqa: BLE001
        _LOG.warning("Behavioral audit logging failed for %s: %s", interview_id, exc)


def find_interview_video(interview_id: str) -> Path | None:
    """Find the uploaded recording for an interview."""
    raw_dir = UPLOADS_DIR / interview_id / "raw"
    if not raw_dir.exists():
        return None
    video_exts = {".mp4", ".webm", ".mov", ".mkv", ".avi"}
    candidates = sorted(
        path
        for path in raw_dir.iterdir()
        if path.is_file() and path.suffix.lower() in video_exts
    )
    return candidates[0] if candidates else None


def analyze_and_persist_behavioral_insights(interview_id: str) -> dict[str, Any]:
    """Run best-effort advisory behavioral signal analysis and persist events."""
    if not BEHAVIORAL_INSIGHTS_ENABLED:
        record_behavioral_audit_event(
            interview_id,
            "behavioral_analysis_skipped",
            "disabled",
            {"reason": "feature_flag_disabled"},
        )
        return get_persisted_behavioral_insights(interview_id)

    generated_at = _utc_now()
    record_behavioral_audit_event(
        interview_id, "behavioral_analysis_started", "running"
    )
    video_path = find_interview_video(interview_id)
    if not video_path:
        raise BehavioralAnalysisError("No uploaded interview recording found.")

    frames_dir, frame_fps = _resolve_frames(interview_id, video_path)
    frame_paths = _list_frame_paths(frames_dir)
    if not frame_paths:
        raise BehavioralAnalysisError(
            "No video frames available for behavioral signal analysis."
        )

    silence_events = _load_silence_events(interview_id)
    predictions: list[dict[str, Any]] = []

    for index, frame_path in enumerate(frame_paths):
        timestamp = round(index / max(frame_fps, 0.001), 3)
        prediction = _analyze_frame(frame_path, timestamp, silence_events)
        if prediction:
            predictions.append(prediction)

    smoothed = _smooth_predictions(predictions, BEHAVIORAL_SMOOTHING_WINDOW)
    events = _build_event_documents(interview_id, smoothed, generated_at)

    # Replay-safe persistence: replace prior advisory overlay output for this interview.
    behavioral_events_col.delete_many({"interviewId": interview_id})
    if events:
        behavioral_events_col.insert_many(
            sorted(events, key=lambda item: item["timestamp"])
        )

    result = get_persisted_behavioral_insights(interview_id)
    record_behavioral_audit_event(
        interview_id,
        "behavioral_analysis_completed",
        "completed",
        {"eventCount": len(events), "summary": result.get("summary")},
    )
    return result


def get_persisted_behavioral_insights(interview_id: str) -> dict[str, Any]:
    events = list(
        behavioral_events_col.find({"interviewId": interview_id}, {"_id": 0}).sort(
            "timestamp", 1
        )
    )
    return {
        "interviewId": interview_id,
        "events": events,
        "summary": compute_behavioral_summary(events),
        "timelineSegments": aggregate_timeline_segments(events),
        "advisoryOnly": True,
        "outputLabel": BEHAVIORAL_OUTPUT_LABEL,
        "deterministicPipelineImpact": "none",
        "metadataText": ADVISORY_METADATA_TEXT,
    }


def compute_behavioral_summary(events: list[dict[str, Any]]) -> dict[str, Any]:
    if not events:
        return {
            "avgStressLevel": 0.0,
            "attentionConsistency": 0.0,
            "emotionVariability": "low",
            "stressSpikes": 0,
            "attentionLossEvents": 0,
        }

    stress_values = [
        float((event.get("emotionScores") or {}).get("stress", 0.0)) for event in events
    ]
    neutral_values = [
        float((event.get("emotionScores") or {}).get("neutral", 0.0))
        for event in events
    ]
    positive_values = [
        float((event.get("emotionScores") or {}).get("positive", 0.0))
        for event in events
    ]
    attention_values = [float(event.get("attentionScore", 0.0)) for event in events]

    variability_score = mean(
        [
            pstdev(stress_values) if len(stress_values) > 1 else 0.0,
            pstdev(neutral_values) if len(neutral_values) > 1 else 0.0,
            pstdev(positive_values) if len(positive_values) > 1 else 0.0,
        ]
    )
    variability = (
        "high"
        if variability_score >= 0.22
        else "medium"
        if variability_score >= 0.1
        else "low"
    )

    return {
        "avgStressLevel": round(mean(stress_values), 4),
        "attentionConsistency": round(mean(attention_values), 4),
        "emotionVariability": variability,
        "stressSpikes": sum(
            1
            for event in events
            if event.get("dominantEmotion")
            in {"possible_hesitation", "stress", "silence_correlation"}
            and float((event.get("emotionScores") or {}).get("stress", 0.0)) >= 0.65
        ),
        "attentionLossEvents": sum(
            1
            for event in events
            if event.get("dominantEmotion") in {"attention_variation", "attention_loss"}
        ),
    }


def aggregate_timeline_segments(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not events:
        return []
    sorted_events = sorted(events, key=lambda item: float(item.get("timestamp", 0.0)))
    max_gap = max(BEHAVIORAL_FRAME_INTERVAL_MS / 1000.0, 0.001) * 1.75
    segments: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None

    for event in sorted_events:
        timestamp = float(event.get("timestamp", 0.0))
        signal = (
            event.get("dominantEmotion")
            if event.get("dominantEmotion") in _ALLOWED_SIGNALS
            else "neutral"
        )
        if (
            current is None
            or current["dominantEmotion"] != signal
            or timestamp - current["endTimestamp"] > max_gap
        ):
            if current:
                segments.append(_finalize_segment(current))
            current = {
                "startTimestamp": timestamp,
                "endTimestamp": timestamp,
                "dominantEmotion": signal,
                "count": 1,
                "confidenceValues": [float(event.get("confidence", 0.0))],
                "attentionValues": [float(event.get("attentionScore", 0.0))],
                "label": "behavioral signal",
            }
        else:
            current["endTimestamp"] = timestamp
            current["count"] += 1
            current["confidenceValues"].append(float(event.get("confidence", 0.0)))
            current["attentionValues"].append(float(event.get("attentionScore", 0.0)))

    if current:
        segments.append(_finalize_segment(current))
    return segments


def _finalize_segment(segment: dict[str, Any]) -> dict[str, Any]:
    confidence_values = segment.pop("confidenceValues", [])
    attention_values = segment.pop("attentionValues", [])
    return {
        **segment,
        "durationSec": round(
            max(0.0, segment["endTimestamp"] - segment["startTimestamp"]), 3
        ),
        "avgConfidence": round(mean(confidence_values), 4)
        if confidence_values
        else 0.0,
        "avgAttentionScore": round(mean(attention_values), 4)
        if attention_values
        else 0.0,
    }


def _resolve_frames(interview_id: str, video_path: Path) -> tuple[Path, float]:
    existing_frames_dir = UPLOADS_DIR / interview_id / "analysis" / "frames"
    if _list_frame_paths(existing_frames_dir):
        return existing_frames_dir, max(BEHAVIORAL_EXISTING_FRAME_FPS, 0.001)

    behavioral_frames_dir = UPLOADS_DIR / interview_id / "behavioral" / "frames"
    fps = 1000.0 / max(BEHAVIORAL_FRAME_INTERVAL_MS, 1)
    if not _list_frame_paths(behavioral_frames_dir):
        try:
            extract_frames(video_path, behavioral_frames_dir, fps=fps)
        except Exception as exc:  # noqa: BLE001
            _LOG.warning(
                "Behavioral frame extraction failed for %s: %s", interview_id, exc
            )
            raise BehavioralAnalysisError(
                "Unable to extract frames for advisory behavioral analysis."
            ) from exc
    return behavioral_frames_dir, fps


def _list_frame_paths(frames_dir: Path) -> list[Path]:
    if not frames_dir.exists():
        return []
    return sorted(
        path
        for path in frames_dir.iterdir()
        if path.is_file() and path.suffix.lower() in _IMAGE_EXTENSIONS
    )


def _analyze_frame(
    frame_path: Path, timestamp: float, silence_events: list[dict[str, Any]]
) -> dict[str, Any] | None:
    image = cv2.imread(str(frame_path))
    if image is None:
        return None

    attention_score, attention_confidence = _estimate_attention_score(image)
    emotion_scores, emotion_confidence = _detect_safe_emotion_scores(image)
    in_silence = _timestamp_in_silence(timestamp, silence_events, padding_sec=0.75)
    speaking_energy = "low" if in_silence else "medium"

    confidence = max(attention_confidence, emotion_confidence)
    if confidence < BEHAVIORAL_MIN_CONFIDENCE and attention_score >= 0.35:
        return None

    dominant = _choose_dominant_signal(emotion_scores, attention_score, in_silence)
    return {
        "timestamp": timestamp,
        "dominantEmotion": dominant,
        "emotionScores": emotion_scores,
        "attentionScore": attention_score,
        "speakingEnergy": speaking_energy,
        "confidence": max(confidence, BEHAVIORAL_MIN_CONFIDENCE),
    }


def _detect_safe_emotion_scores(image: np.ndarray) -> tuple[dict[str, float], float]:
    result = _try_deepface(image)
    if result:
        return result
    result = _try_fer(image)
    if result:
        return result
    # Conservative fallback: neutral behavioral signal, no psychological certainty.
    return {"stress": 0.15, "neutral": 0.7, "positive": 0.15}, 0.55


def _try_deepface(image: np.ndarray) -> tuple[dict[str, float], float] | None:
    try:
        from deepface import DeepFace  # type: ignore

        result = DeepFace.analyze(
            image, actions=["emotion"], enforce_detection=False, silent=True
        )
        result_payload = result[0] if isinstance(result, list) and result else result
        if not isinstance(result_payload, dict):
            return None
        raw = cast(dict[str, Any], result_payload).get("emotion") or {}
        return _map_emotion_scores(raw, scale=100.0) if raw else None
    except Exception as exc:  # noqa: BLE001
        _LOG.debug("DeepFace behavioral backend unavailable/failed: %s", exc)
        return None


def _try_fer(image: np.ndarray) -> tuple[dict[str, float], float] | None:
    try:
        from fer import FER  # type: ignore

        detector = FER(mtcnn=False)
        detections = detector.detect_emotions(cv2.cvtColor(image, cv2.COLOR_BGR2RGB))
        if not detections:
            return None
        largest = max(
            detections,
            key=lambda item: (
                item.get("box", [0, 0, 0, 0])[2] * item.get("box", [0, 0, 0, 0])[3]
            ),
        )
        raw = largest.get("emotions") or {}
        return _map_emotion_scores(raw, scale=1.0) if raw else None
    except Exception as exc:  # noqa: BLE001
        _LOG.debug("FER behavioral backend unavailable/failed: %s", exc)
        return None


def _map_emotion_scores(
    raw: dict[str, Any], scale: float
) -> tuple[dict[str, float], float]:
    def value(name: str) -> float:
        try:
            return max(0.0, min(1.0, float(raw.get(name, 0.0)) / scale))
        except Exception:
            return 0.0

    stress = value("angry") + value("fear") + value("sad") + value("disgust")
    positive = value("happy") + 0.5 * value("surprise")
    neutral = value("neutral")
    total = stress + positive + neutral
    if total <= 0:
        return {"stress": 0.15, "neutral": 0.7, "positive": 0.15}, 0.0
    scores = {
        "stress": round(stress / total, 4),
        "neutral": round(neutral / total, 4),
        "positive": round(positive / total, 4),
    }
    return scores, round(max(scores.values()), 4)


def _estimate_attention_score(image: np.ndarray) -> tuple[float, float]:
    # MediaPipe can be added later for richer landmarks; OpenCV keeps this no-key and lightweight.
    try:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        cv2_data = getattr(cv2, "data", None)
        haarcascades = getattr(cv2_data, "haarcascades", "")
        cascade_path = haarcascades + "haarcascade_frontalface_default.xml"
        face_cascade = cv2.CascadeClassifier(cascade_path)
        faces = face_cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5)
        if len(faces) == 0:
            return 0.2, 0.75

        height, width = gray.shape[:2]
        x, y, w, h = max(faces, key=lambda box: box[2] * box[3])
        center_x = x + w / 2
        center_y = y + h / 2
        dx = abs(center_x - width / 2) / max(width / 2, 1)
        dy = abs(center_y - height / 2) / max(height / 2, 1)
        face_area_ratio = (w * h) / max(width * height, 1)
        centered_score = max(0.0, 1.0 - (0.65 * dx + 0.35 * dy))
        size_score = min(1.0, max(0.0, face_area_ratio / 0.12))
        return round(
            max(0.0, min(1.0, 0.75 * centered_score + 0.25 * size_score)), 4
        ), 0.7
    except Exception as exc:  # noqa: BLE001
        _LOG.debug("Behavioral attention estimate failed: %s", exc)
        return 0.5, 0.0


def _choose_dominant_signal(
    emotion_scores: dict[str, float], attention_score: float, in_silence: bool
) -> str:
    stress = float(emotion_scores.get("stress", 0.0))
    neutral = float(emotion_scores.get("neutral", 0.0))
    positive = float(emotion_scores.get("positive", 0.0))
    if attention_score < 0.35:
        return "attention_variation"
    if in_silence and stress >= 0.6:
        return "silence_correlation"
    if stress >= 0.6 and stress >= neutral + 0.1 and stress >= positive + 0.1:
        return "possible_hesitation"
    if positive >= 0.55 and positive >= stress + 0.1:
        return "engagement_variation"
    return "neutral"


def _smooth_predictions(
    predictions: list[dict[str, Any]], window: int
) -> list[dict[str, Any]]:
    if not predictions:
        return []
    half = max(0, window // 2)
    smoothed: list[dict[str, Any]] = []
    for index, prediction in enumerate(predictions):
        neighbors = predictions[
            max(0, index - half) : min(len(predictions), index + half + 1)
        ]
        scores = _normalize_scores(
            {
                "stress": mean(
                    float((item.get("emotionScores") or {}).get("stress", 0.0))
                    for item in neighbors
                ),
                "neutral": mean(
                    float((item.get("emotionScores") or {}).get("neutral", 0.0))
                    for item in neighbors
                ),
                "positive": mean(
                    float((item.get("emotionScores") or {}).get("positive", 0.0))
                    for item in neighbors
                ),
            }
        )
        attention = mean(float(item.get("attentionScore", 0.0)) for item in neighbors)
        confidence = mean(float(item.get("confidence", 0.0)) for item in neighbors)
        speaking_energy = (
            "low" if prediction.get("speakingEnergy") == "low" else "medium"
        )
        smoothed.append(
            {
                "timestamp": prediction["timestamp"],
                "dominantEmotion": _choose_dominant_signal(
                    scores,
                    attention,
                    prediction.get("dominantEmotion") == "silence_correlation",
                ),
                "emotionScores": scores,
                "attentionScore": round(attention, 4),
                "speakingEnergy": speaking_energy,
                "confidence": round(confidence, 4),
            }
        )
    return smoothed


def _normalize_scores(scores: dict[str, float]) -> dict[str, float]:
    total = sum(max(0.0, float(value)) for value in scores.values())
    if total <= 0:
        return {"stress": 0.0, "neutral": 1.0, "positive": 0.0}
    return {
        key: round(max(0.0, float(scores.get(key, 0.0))) / total, 4)
        for key in ["stress", "neutral", "positive"]
    }


def _build_event_documents(
    interview_id: str, predictions: list[dict[str, Any]], generated_at: datetime
) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for prediction in sorted(predictions, key=lambda item: item["timestamp"]):
        confidence = float(prediction.get("confidence", 0.0))
        if confidence < BEHAVIORAL_MIN_CONFIDENCE:
            continue
        raw_dominant = prediction.get("dominantEmotion")
        dominant = str(raw_dominant) if raw_dominant in _ALLOWED_SIGNALS else "neutral"
        events.append(
            {
                "interviewId": interview_id,
                "timestamp": round(float(prediction.get("timestamp", 0.0)), 3),
                "dominantEmotion": dominant,
                "emotionScores": {
                    "stress": round(
                        float(
                            (prediction.get("emotionScores") or {}).get("stress", 0.0)
                        ),
                        4,
                    ),
                    "neutral": round(
                        float(
                            (prediction.get("emotionScores") or {}).get("neutral", 0.0)
                        ),
                        4,
                    ),
                    "positive": round(
                        float(
                            (prediction.get("emotionScores") or {}).get("positive", 0.0)
                        ),
                        4,
                    ),
                },
                "attentionScore": round(
                    float(prediction.get("attentionScore", 0.0)), 4
                ),
                "speakingEnergy": prediction.get("speakingEnergy", "medium"),
                "confidence": round(confidence, 4),
                "advisoryOnly": True,
                "outputLabel": BEHAVIORAL_OUTPUT_LABEL,
                "behavioralSignalWording": _safe_signal_wording(dominant),
                "protectedAttributeInference": False,
                "decisionImpact": "none",
                "generatedAt": generated_at,
            }
        )
    return events


def _safe_signal_wording(signal: str) -> str:
    return {
        "possible_hesitation": "possible hesitation",
        "engagement_variation": "engagement variation",
        "attention_variation": "attention variation",
        "silence_correlation": "possible hesitation during silence",
        "neutral": "neutral behavioral signal",
    }.get(signal, "behavioral fluctuation")


def _load_silence_events(interview_id: str) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    try:
        snapshot = pipeline_snapshots_col.find_one(
            {"interviewId": interview_id},
            {"_id": 0, "silenceEvents": 1},
            sort=[("savedAt", -1)],
        )
        if isinstance(snapshot, dict) and isinstance(
            snapshot.get("silenceEvents"), list
        ):
            candidates.extend(snapshot["silenceEvents"])
    except Exception as exc:  # noqa: BLE001
        _LOG.debug("Behavioral silence snapshot lookup failed: %s", exc)
    if not candidates:
        try:
            transcript = transcripts_col.find_one(
                {"interviewId": interview_id}, {"_id": 0, "silenceEvents": 1}
            )
            if isinstance(transcript, dict) and isinstance(
                transcript.get("silenceEvents"), list
            ):
                candidates.extend(transcript["silenceEvents"])
        except Exception as exc:  # noqa: BLE001
            _LOG.debug("Behavioral silence transcript lookup failed: %s", exc)
    if not candidates:
        try:
            report = reports_col.find_one(
                {"interviewId": interview_id},
                {"_id": 0, "audioAnalysis": 1, "audio": 1},
            )
            audio = (
                (report or {}).get("audioAnalysis") or (report or {}).get("audio") or {}
            )
            detailed = (
                audio.get("silenceEventsDetailed")
                or audio.get("silenceEventsTimeline")
                or []
            )
            if isinstance(detailed, list):
                candidates.extend(detailed)
        except Exception as exc:  # noqa: BLE001
            _LOG.debug("Behavioral silence report lookup failed: %s", exc)
    return _sanitize_silence_events(candidates)


def _sanitize_silence_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    sanitized: list[dict[str, Any]] = []
    for event in events:
        if not isinstance(event, dict):
            continue
        try:
            start = float(event.get("start", event.get("startTime", 0.0)))
            end = float(event.get("end", event.get("endTime", 0.0)))
        except Exception:
            continue
        if math.isfinite(start) and math.isfinite(end) and end >= start:
            sanitized.append(
                {
                    "start": round(start, 3),
                    "end": round(end, 3),
                    "durationSec": round(end - start, 3),
                }
            )
    return sorted(sanitized, key=lambda item: item["start"])


def _timestamp_in_silence(
    timestamp: float, silence_events: list[dict[str, Any]], padding_sec: float = 0.0
) -> bool:
    for event in silence_events:
        if (
            float(event.get("start", 0.0)) - padding_sec
            <= timestamp
            <= float(event.get("end", 0.0)) + padding_sec
        ):
            return True
    return False
