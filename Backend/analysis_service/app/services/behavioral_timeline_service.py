"""Recruiter-only Behavioral Timeline Overlay service (DeepFace).

Advisory-only by design. Reads only the recorded interview video under
``UPLOADS_DIR/<interview_id>/raw/`` and writes ONLY to the three isolated
``interview_behavioral_timeline_*`` collections. Never touches scoring,
final reports, replay determinism, or ML calibration outputs.

Pipeline:
    extract frames (ffmpeg, 2 fps)
    -> DeepFace.analyze (emotion only)
    -> EMA temporal smoothing
    -> safe-label mapping (9-rule taxonomy)
    -> event aggregation (min duration + merge gaps)
    -> 10s heatmap bins
    -> Mongo persistence
"""
from __future__ import annotations

import logging
import shutil
import statistics
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import cv2
import numpy as np

from app.core.config import (
    BEHAVIORAL_TIMELINE_ENABLED,
    BEHAVIORAL_TIMELINE_FPS_SAMPLE,
    BEHAVIORAL_TIMELINE_HEATMAP_BIN_SEC,
    BEHAVIORAL_TIMELINE_MERGE_GAP_SEC,
    BEHAVIORAL_TIMELINE_MIN_EVENT_SEC,
    DEEPFACE_DETECTOR_BACKEND,
    EMOTION_ENGINE,
    UPLOADS_DIR,
)
from app.services import pyfeat_emotion_service
from app.db.mongo import (
    behavioral_timeline_audit_col,
    behavioral_timeline_events_col,
    behavioral_timeline_heatmap_col,
)
from app.services.ffmpeg_service import extract_frames, get_duration_seconds

_LOG = logging.getLogger(__name__)

_VIDEO_EXTS = {".mp4", ".webm", ".mov", ".mkv", ".avi"}
_EMOTION_KEYS = ("angry", "disgust", "fear", "happy", "sad", "surprise", "neutral")

# Safe advisory labels — these are the ONLY labels that may appear in the
# response payload or be persisted. Raw DeepFace emotion names never leak.
LABEL_NEUTRAL = "Neutral Behavioral Signal"
LABEL_HESITATION = "Possible Hesitation"
LABEL_POSITIVE_SHIFT = "Positive Expression Shift"
LABEL_FLUCTUATION = "Behavioral Fluctuation"
LABEL_REDUCED = "Reduced Expressiveness"
LABEL_INTERACTION = "Increased Interaction Energy"
LABEL_SILENCE = "Silence + Behavioral Pause"
LABEL_ATTENTION = "Attention Variation"
LABEL_ENGAGEMENT = "Engagement Variation"

_LABEL_EXPLANATIONS = {
    LABEL_NEUTRAL: "Sustained neutral expression with low emotional variance.",
    LABEL_HESITATION: "Brief elevation in uncertainty signals with reduced facial movement.",
    LABEL_POSITIVE_SHIFT: "Rising positive expression compared to recent baseline.",
    LABEL_FLUCTUATION: "Oscillating emotional signals across the window.",
    LABEL_REDUCED: "Flat, low-amplitude expression sustained across the window.",
    LABEL_INTERACTION: "Rising combined positive and surprise signals.",
    LABEL_SILENCE: "No face detected and low interaction activity.",
    LABEL_ATTENTION: "Attention proxy shifting (gaze / head movement variance).",
    LABEL_ENGAGEMENT: "Sustained engagement drift relative to recent baseline.",
}


class BehavioralTimelineError(RuntimeError):
    """Non-fatal behavioral timeline failure."""


# ---------------------------------------------------------------------------
# Audit logging (isolated collection only)
# ---------------------------------------------------------------------------
def _record_audit(
    interview_id: str,
    action: str,
    details: Optional[dict[str, Any]] = None,
) -> None:
    try:
        behavioral_timeline_audit_col.insert_one(
            {
                "interview_id": interview_id,
                "action": action,
                "details": details or {},
                "advisoryOnly": True,
                "performedAt": datetime.now(timezone.utc),
            }
        )
    except Exception as exc:  # noqa: BLE001
        _LOG.warning(
            "[BehavioralTimeline] Audit write failed interviewId=%s action=%s: %s",
            interview_id,
            action,
            exc,
        )


# ---------------------------------------------------------------------------
# Video resolution
# ---------------------------------------------------------------------------
def find_interview_video(interview_id: str) -> Optional[Path]:
    raw_dir = UPLOADS_DIR / interview_id / "raw"
    if not raw_dir.exists():
        return None
    candidates = sorted(
        p for p in raw_dir.iterdir() if p.is_file() and p.suffix.lower() in _VIDEO_EXTS
    )
    return candidates[-1] if candidates else None


# ---------------------------------------------------------------------------
# DeepFace inference (lazy import so service boot doesn't pull tensorflow)
# ---------------------------------------------------------------------------
_DEEPFACE_MODULE = None


def _get_deepface():
    global _DEEPFACE_MODULE
    if _DEEPFACE_MODULE is None:
        from deepface import DeepFace  # type: ignore

        _DEEPFACE_MODULE = DeepFace
    return _DEEPFACE_MODULE


def _analyze_frame_pyfeat(frame_bgr: np.ndarray) -> Optional[dict[str, Any]]:
    """Run Py-Feat analysis on one frame, returning the same dict shape
    that the DeepFace path produces (plus an ``action_units`` field).
    """
    pf = pyfeat_emotion_service.analyze_frame(frame_bgr, timestamp=0.0)
    if pf is None:
        return None
    probs = pf.get("emotion") or {}
    # ensure all canonical keys present
    probs = {k: float(probs.get(k, 0.0)) for k in _EMOTION_KEYS}
    return {
        "emotion": probs,
        "dominant_emotion": pf.get("dominant_emotion") or max(probs, key=probs.get),
        "face_box": pf.get("face_box"),
        "face_confidence": float(pf.get("confidence") or 0.0),
        "action_units": pf.get("action_units") or {},
        "landmarks": pf.get("landmarks") or [],
    }


def _analyze_frame(frame_bgr: np.ndarray) -> Optional[dict[str, Any]]:
    """Run emotion analysis on one frame. Returns None on no-face.

    Routes through Py-Feat when ``EMOTION_ENGINE=pyfeat`` and the library
    is importable; otherwise falls back to DeepFace so the service still
    works on machines where torch/py-feat aren't installed yet.
    """
    if EMOTION_ENGINE == "pyfeat" and pyfeat_emotion_service.is_available():
        result = _analyze_frame_pyfeat(frame_bgr)
        if result is not None:
            return result
        # Py-Feat tried but couldn't detect — return None so we record
        # a no-face frame rather than silently swapping engines mid-run.
        return None

    deepface = _get_deepface()
    try:
        results = deepface.analyze(
            img_path=frame_bgr,
            actions=["emotion"],
            enforce_detection=False,
            detector_backend=DEEPFACE_DETECTOR_BACKEND,
            silent=True,
        )
    except Exception as exc:  # noqa: BLE001
        _LOG.debug("[BehavioralTimeline] DeepFace.analyze failed: %s", exc)
        return None

    if not results:
        return None
    first = results[0] if isinstance(results, list) else results
    emotion = first.get("emotion") or {}
    if not emotion:
        return None

    # DeepFace returns percentages 0..100; normalize to 0..1.
    total = sum(float(v) for v in emotion.values()) or 1.0
    probs = {k: max(0.0, float(emotion.get(k, 0.0)) / total) for k in _EMOTION_KEYS}

    region = first.get("region") or {}
    face_box = None
    fw, fh = int(region.get("w", 0)), int(region.get("h", 0))
    if fw > 0 and fh > 0:
        face_box = {
            "x": int(region.get("x", 0)),
            "y": int(region.get("y", 0)),
            "w": fw,
            "h": fh,
        }

    dominant = first.get("dominant_emotion") or max(probs, key=probs.get)
    return {
        "emotion": probs,
        "dominant_emotion": dominant,
        "face_box": face_box,
        "face_confidence": float(first.get("face_confidence", 0.0) or 0.0),
    }


# ---------------------------------------------------------------------------
# Frame iteration
# ---------------------------------------------------------------------------
def _iter_sampled_frames(
    video_path: Path, fps: float
) -> list[tuple[float, np.ndarray, int, int]]:
    """Return list of (timestamp_seconds, frame_bgr, frame_w, frame_h)."""
    tmp_dir = Path(tempfile.mkdtemp(prefix="bt_frames_"))
    samples: list[tuple[float, np.ndarray, int, int]] = []
    try:
        extract_frames(video_path, tmp_dir, fps=fps)
        files = sorted(tmp_dir.glob("frame_*.jpg"))
        step = 1.0 / max(fps, 0.1)
        for idx, fpath in enumerate(files):
            img = cv2.imread(str(fpath))
            if img is None:
                continue
            h, w = img.shape[:2]
            ts = idx * step
            samples.append((ts, img, w, h))
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
    return samples


# ---------------------------------------------------------------------------
# Temporal smoothing — EMA per emotion channel
# ---------------------------------------------------------------------------
def _smooth_emotions(
    raw_series: list[dict[str, float]], alpha: float = 0.7
) -> list[dict[str, float]]:
    if not raw_series:
        return []
    smoothed: list[dict[str, float]] = []
    prev = dict(raw_series[0])
    smoothed.append(prev)
    for cur in raw_series[1:]:
        out = {}
        for k in _EMOTION_KEYS:
            out[k] = alpha * float(cur.get(k, 0.0)) + (1.0 - alpha) * float(prev.get(k, 0.0))
        smoothed.append(out)
        prev = out
    return smoothed


# ---------------------------------------------------------------------------
# Safe-label mapping (9-rule taxonomy from spec §1.4)
# ---------------------------------------------------------------------------
def _window_stats(window: list[dict[str, float]]) -> dict[str, Any]:
    """Compute mean / variance per channel across the rolling window."""
    if not window:
        return {"means": {k: 0.0 for k in _EMOTION_KEYS}, "variance": 0.0, "max_abs": 0.0}
    means = {
        k: float(statistics.fmean(float(f.get(k, 0.0)) for f in window))
        for k in _EMOTION_KEYS
    }
    # Aggregate variance across the dominant emotion's series.
    dominant_key = max(means, key=means.get)
    series = [float(f.get(dominant_key, 0.0)) for f in window]
    variance = float(statistics.pvariance(series)) if len(series) > 1 else 0.0
    max_abs = max(max(float(v) for v in f.values()) for f in window)
    return {"means": means, "variance": variance, "max_abs": max_abs, "dominant": dominant_key}


def _map_to_safe_label(
    window: list[dict[str, float]],
    baseline: dict[str, float],
    no_face_count: int,
    window_size: int,
) -> Optional[str]:
    """Map a rolling window of smoothed emotion probs to a single safe label.

    Rules implement the spec's §1.4 table. Returns ``None`` if no rule fires —
    no event is emitted for that frame.
    """
    if not window:
        return None
    # Rule 7: Silence + Behavioral Pause — gap > 3s of no-face.
    if no_face_count >= max(2, int(window_size * 0.6)):
        return LABEL_SILENCE

    stats = _window_stats(window)
    means = stats["means"]
    variance = float(stats["variance"])
    max_abs = float(stats["max_abs"])

    # Rule 4: Behavioral Fluctuation — high variance, oscillating.
    if variance > 0.04:  # variance on probability space is small; 0.04 ≈ stddev 0.2
        return LABEL_FLUCTUATION

    # Rule 6: Increased Interaction Energy — happy + surprise > 0.5 rising.
    happy_baseline = float(baseline.get("happy", 0.0))
    if (means["happy"] + means["surprise"]) > 0.5 and means["happy"] > happy_baseline:
        return LABEL_INTERACTION

    # Rule 3: Positive Expression Shift — happy +0.3 over baseline.
    if means["happy"] - happy_baseline > 0.3:
        return LABEL_POSITIVE_SHIFT

    # Rule 2: Possible Hesitation — fear + sad > 0.4.
    if (means["fear"] + means["sad"]) > 0.4:
        return LABEL_HESITATION

    # Rule 5: Reduced Expressiveness — all emotions < 0.3, flat.
    if max_abs < 0.3 and variance < 0.01:
        return LABEL_REDUCED

    # Rule 1: Neutral Behavioral Signal — neutral dominant.
    if means["neutral"] > 0.6 and variance < 0.02:
        return LABEL_NEUTRAL

    # Rules 8 & 9 (Attention / Engagement variation) require gaze/head-pose
    # signals we do not extract from DeepFace; surfaced via face-presence
    # variance as a proxy when the window has moderate variance.
    if 0.02 <= variance <= 0.04:
        return LABEL_ENGAGEMENT

    return None


# ---------------------------------------------------------------------------
# Confidence estimation (§1.5)
# ---------------------------------------------------------------------------
def _event_confidence(
    window: list[dict[str, float]],
    model_confs: list[float],
    face_qualities: list[float],
) -> float:
    if not window:
        return 0.0
    model_conf = float(statistics.fmean(model_confs)) if model_confs else 0.0
    # temporal consistency = 1 - stddev of the per-frame max probability
    maxes = [max(float(v) for v in f.values()) for f in window]
    temporal = 1.0 - (float(statistics.pstdev(maxes)) if len(maxes) > 1 else 0.0)
    temporal = max(0.0, min(1.0, temporal))
    face_q = float(statistics.fmean(face_qualities)) if face_qualities else 0.0
    conf = 0.6 * model_conf + 0.3 * temporal + 0.1 * face_q
    return max(0.0, min(1.0, conf))


# ---------------------------------------------------------------------------
# Event aggregation
# ---------------------------------------------------------------------------
def _aggregate_events(
    per_frame: list[dict[str, Any]],
    min_event_sec: float,
    merge_gap_sec: float,
) -> list[dict[str, Any]]:
    """Build events from per-frame labels: contiguous same-label, then merge."""
    if not per_frame:
        return []

    events: list[dict[str, Any]] = []
    cur: Optional[dict[str, Any]] = None
    for f in per_frame:
        label = f.get("label")
        if label is None:
            if cur is not None:
                events.append(cur)
                cur = None
            continue
        if cur is None or cur["label"] != label:
            if cur is not None:
                events.append(cur)
            cur = {
                "label": label,
                "frames": [f],
                "start": float(f["timestamp"]),
                "end": float(f["timestamp"]),
            }
        else:
            cur["frames"].append(f)
            cur["end"] = float(f["timestamp"])
    if cur is not None:
        events.append(cur)

    # Merge adjacent same-label events separated by <= merge_gap_sec.
    merged: list[dict[str, Any]] = []
    for ev in events:
        if (
            merged
            and merged[-1]["label"] == ev["label"]
            and (ev["start"] - merged[-1]["end"]) <= merge_gap_sec
        ):
            merged[-1]["frames"].extend(ev["frames"])
            merged[-1]["end"] = ev["end"]
        else:
            merged.append(ev)

    # Drop events shorter than min_event_sec.
    return [e for e in merged if (e["end"] - e["start"]) >= min_event_sec]


def _build_event_doc(ev: dict[str, Any]) -> dict[str, Any]:
    frames = ev["frames"]
    smoothed = [f["smoothed"] for f in frames]
    model_confs = [float(f.get("model_conf", 0.0)) for f in frames]
    face_qualities = [float(f.get("face_quality", 0.0)) for f in frames]
    confidence = _event_confidence(smoothed, model_confs, face_qualities)

    raw_avg = {
        k: float(statistics.fmean(float(s.get(k, 0.0)) for s in smoothed))
        for k in _EMOTION_KEYS
    }

    boxes = [f["face_box"] for f in frames if f.get("face_box")]
    face_box = None
    frame_w = frame_h = 0
    if boxes:
        face_box = {
            "x": int(statistics.median(b["x"] for b in boxes)),
            "y": int(statistics.median(b["y"] for b in boxes)),
            "w": int(statistics.median(b["w"] for b in boxes)),
            "h": int(statistics.median(b["h"] for b in boxes)),
        }
        frame_w = int(statistics.median(f["frame_w"] for f in frames if f.get("frame_w")))
        frame_h = int(statistics.median(f["frame_h"] for f in frames if f.get("frame_h")))

    # Average AU activations across the event window (when available).
    au_avg: dict[str, float] = {}
    au_frames = [f.get("action_units") or {} for f in frames if f.get("action_units")]
    if au_frames:
        all_keys = {k for d in au_frames for k in d.keys()}
        for key in all_keys:
            vals = [float(d.get(key, 0.0)) for d in au_frames]
            au_avg[key] = round(float(statistics.fmean(vals)), 3)

    duration = float(ev["end"] - ev["start"])
    label = ev["label"]
    return {
        "timestamp": round(float(ev["start"]), 2),
        "duration": round(duration, 2),
        "label": label,
        "confidence": round(confidence, 3),
        "explanation": _LABEL_EXPLANATIONS.get(label, ""),
        "raw_scores": {k: round(v, 3) for k, v in raw_avg.items()},
        "action_units": au_avg,
        "face_box": face_box,
        "frame_width": frame_w,
        "frame_height": frame_h,
    }


# ---------------------------------------------------------------------------
# Emotion Summary (recruiter dashboard enrichment — advisory only)
# ---------------------------------------------------------------------------
_PEAK_LABELS = {
    "fear": "Stress Peak",
    "sad": "Stress Peak",
    "angry": "Stress Peak",
    "happy": "Positive Shift",
    "surprise": "Positive Shift",
    "disgust": "Reaction Peak",
    "neutral": "Neutral Focus",
}


def _classify_band(score: int) -> str:
    if score <= 25:
        return "low"
    if score <= 55:
        return "medium"
    return "high"


def build_emotion_summary(
    frames: list[dict[str, Any]],
    events: list[dict[str, Any]],
    video_duration: float,
) -> dict[str, Any]:
    """Aggregate per-frame DeepFace probabilities into a recruiter dashboard block.

    Advisory only. Inputs are the smoothed per-frame probabilities (already
    EMA-smoothed); outputs are integer percentages on a 0–100 scale plus a
    15-second bucketed timeline and the top-3 most intense moments.
    """
    face_frames = [f for f in frames if not f.get("no_face") and f.get("smoothed")]

    if not face_frames:
        return {
            "dominantEmotion": "neutral",
            "dominantEmotionPercent": 0,
            "emotionAverages": {k: 0 for k in _EMOTION_KEYS},
            "stressScore": 0,
            "stressLevel": "low",
            "positivityScore": 0,
            "positivityLevel": "low",
            "peakMoments": [],
            "emotionTimeline": [],
            "engagementArc": "stable",
        }

    # Per-emotion averages — keep float precision for stress/positivity math,
    # then round to integers for the dashboard. Without keeping the float
    # version, low-confidence sessions where every probability is < 0.5%
    # would round to 0 across the board and `max()` would tie-break to the
    # first key in _EMOTION_KEYS ("angry"), producing the spurious
    # "Angry 100% of frames" bug while all other tiles read 0%.
    emotion_averages_float: dict[str, float] = {}
    emotion_averages: dict[str, int] = {}
    for k in _EMOTION_KEYS:
        avg = statistics.fmean(float(f["smoothed"].get(k, 0.0)) for f in face_frames)
        emotion_averages_float[k] = avg * 100.0
        emotion_averages[k] = int(round(avg * 100))

    # Dominant emotion = strongest average. If the signal is essentially
    # flat (peak < 2%), the model couldn't read the candidate's expression
    # reliably — default to "neutral" instead of a noisy tie-break.
    DOMINANT_MIN_AVG = 2.0  # require ≥ 2% to claim a dominant emotion
    peak_emotion = max(emotion_averages_float, key=emotion_averages_float.get)
    peak_avg = emotion_averages_float[peak_emotion]
    dominant = peak_emotion if peak_avg >= DOMINANT_MIN_AVG else "neutral"

    # Percent of frames where the dominant emotion was the per-frame top.
    # Skip frames whose top probability is also near-zero (those are
    # low-confidence frames that would otherwise default to the first
    # alphabetical key and inflate the dominant count).
    PER_FRAME_MIN_TOP = 0.02
    dom_count = 0
    counted_frames = 0
    for f in face_frames:
        sm = f["smoothed"]
        top = max(_EMOTION_KEYS, key=lambda k: float(sm.get(k, 0.0)))
        top_val = float(sm.get(top, 0.0))
        if top_val < PER_FRAME_MIN_TOP:
            continue  # frame too uncertain to attribute to any emotion
        counted_frames += 1
        if top == dominant:
            dom_count += 1
    dominant_percent = (
        int(round((dom_count / counted_frames) * 100)) if counted_frames else 0
    )

    # Stress proxy = mean of (fear + sad + angry) using float averages so
    # tiny-but-real signals aren't lost to integer rounding.
    stress_score = int(round(
        (emotion_averages_float["fear"]
         + emotion_averages_float["sad"]
         + emotion_averages_float["angry"]) / 3.0
    ))
    stress_level = _classify_band(stress_score)

    # Positivity proxy = mean of (happy + surprise) per-emotion averages / 2
    positivity_score = int(round(
        (emotion_averages_float["happy"]
         + emotion_averages_float["surprise"]) / 2.0
    ))
    positivity_level = _classify_band(positivity_score)

    # Peak moments — bucket frames into 2-second windows, average per window,
    # and pick the windows where a SUSTAINED non-neutral emotion is strongest.
    # This filters out 1-frame DeepFace spikes (which often hit 100% happy on
    # a single noisy frame) and surfaces moments that actually persisted.
    PEAK_WINDOW_SEC = 2.0
    PEAK_MIN_FRAMES = 2          # require at least 2 sampled frames in the window
    PEAK_MIN_INTENSITY = 0.35    # window-averaged probability threshold
    PEAK_MIN_SPACING_SEC = 5.0

    windowed: dict[float, list[dict[str, float]]] = {}
    for f in face_frames:
        bucket_start = (int(float(f["timestamp"]) // PEAK_WINDOW_SEC)) * PEAK_WINDOW_SEC
        windowed.setdefault(bucket_start, []).append(f["smoothed"])

    window_candidates: list[dict[str, Any]] = []
    for bucket_start, smoothed_list in windowed.items():
        if len(smoothed_list) < PEAK_MIN_FRAMES:
            continue
        # Average each emotion across the window
        avg = {
            k: float(statistics.fmean(float(s.get(k, 0.0)) for s in smoothed_list))
            for k in _EMOTION_KEYS
        }
        # Pick the strongest non-neutral emotion for this window
        non_neutral = {k: v for k, v in avg.items() if k != "neutral"}
        if not non_neutral:
            continue
        top_emotion = max(non_neutral, key=non_neutral.get)
        top_intensity = non_neutral[top_emotion]
        if top_intensity < PEAK_MIN_INTENSITY:
            continue
        window_candidates.append(
            {
                "timestamp": round(float(bucket_start), 2),
                "emotion": top_emotion,
                "intensity": round(top_intensity, 3),
            }
        )

    window_candidates.sort(key=lambda x: x["intensity"], reverse=True)
    selected: list[dict[str, Any]] = []
    for cand in window_candidates:
        if all(abs(cand["timestamp"] - s["timestamp"]) >= PEAK_MIN_SPACING_SEC for s in selected):
            selected.append(cand)
        if len(selected) >= 3:
            break
    selected.sort(key=lambda x: x["timestamp"])
    peak_moments = [
        {**c, "label": _PEAK_LABELS.get(c["emotion"], "Emotion Peak")}
        for c in selected
    ]

    # Emotion timeline — 15-second buckets, integer percentages per emotion
    bucket_size = 15.0
    emotion_timeline: list[dict[str, Any]] = []
    if video_duration > 0:
        start = 0.0
        while start < video_duration:
            end = min(start + bucket_size, video_duration)
            in_bucket = [f for f in face_frames if start <= f["timestamp"] < end]
            entry: dict[str, Any] = {
                "bucketStart": round(start, 2),
                "bucketEnd": round(end, 2),
            }
            for k in _EMOTION_KEYS:
                if in_bucket:
                    entry[k] = int(round(
                        statistics.fmean(float(f["smoothed"].get(k, 0.0)) for f in in_bucket) * 100
                    ))
                else:
                    entry[k] = 0
            emotion_timeline.append(entry)
            start = end

    # Engagement arc — compare first-third vs last-third (happy+surprise) average
    engagement_arc = "stable"
    if len(face_frames) >= 6:
        third = max(1, len(face_frames) // 3)
        eng_series = [
            (float(f["smoothed"].get("happy", 0.0)) + float(f["smoothed"].get("surprise", 0.0))) * 100.0
            for f in face_frames
        ]
        first_eng = statistics.fmean(eng_series[:third])
        last_eng = statistics.fmean(eng_series[-third:])
        variance = statistics.pvariance(eng_series) if len(eng_series) > 1 else 0.0
        diff = last_eng - first_eng
        if variance > 20.0:
            engagement_arc = "variable"
        elif diff > 10.0:
            engagement_arc = "rising"
        elif diff < -10.0:
            engagement_arc = "falling"
        else:
            engagement_arc = "stable"

    return {
        "dominantEmotion": dominant,
        "dominantEmotionPercent": dominant_percent,
        "emotionAverages": emotion_averages,
        "stressScore": stress_score,
        "stressLevel": stress_level,
        "positivityScore": positivity_score,
        "positivityLevel": positivity_level,
        "peakMoments": peak_moments,
        "emotionTimeline": emotion_timeline,
        "engagementArc": engagement_arc,
    }


# ---------------------------------------------------------------------------
# Heatmap (§1.7)
# ---------------------------------------------------------------------------
def _build_heatmap(
    per_frame: list[dict[str, Any]],
    video_duration: float,
    bin_sec: float,
) -> list[dict[str, Any]]:
    if video_duration <= 0:
        return []
    bins: list[dict[str, Any]] = []
    start = 0.0
    while start < video_duration:
        end = min(start + bin_sec, video_duration)
        in_bin = [f for f in per_frame if start <= f["timestamp"] < end]
        if not in_bin:
            bins.append({"start": round(start, 2), "end": round(end, 2), "intensity": 0.0, "level": "low"})
            start = end
            continue
        # std-dev across all emotion probabilities in the bin
        all_vals: list[float] = []
        for f in in_bin:
            for v in f["smoothed"].values():
                all_vals.append(float(v))
        std = float(statistics.pstdev(all_vals)) if len(all_vals) > 1 else 0.0
        labels = [f.get("label") for f in in_bin if f.get("label")]
        changes = sum(1 for a, b in zip(labels, labels[1:]) if a != b)
        intensity = max(0.0, min(1.0, std + 0.1 * changes))
        level = "low" if intensity < 0.3 else ("medium" if intensity < 0.6 else "high")
        bins.append(
            {
                "start": round(start, 2),
                "end": round(end, 2),
                "intensity": round(intensity, 3),
                "level": level,
            }
        )
        start = end
    return bins


# ---------------------------------------------------------------------------
# Public entrypoints
# ---------------------------------------------------------------------------
def get_persisted_behavioral_timeline(interview_id: str) -> Optional[dict[str, Any]]:
    """Return the persisted overlay data or ``None`` if missing/failed."""
    events_doc = behavioral_timeline_events_col.find_one({"interview_id": interview_id})
    if not events_doc:
        return None
    if events_doc.get("status") == "failed":
        return None
    heatmap_doc = behavioral_timeline_heatmap_col.find_one({"interview_id": interview_id}) or {}
    return {
        "interview_id": interview_id,
        "events": events_doc.get("events", []),
        "summary": events_doc.get("summary", {}),
        "emotionSummary": events_doc.get("emotionSummary", {}),
        "frameLandmarks": events_doc.get("frameLandmarks", []),
        "heatmap": heatmap_doc.get("heatmap", []),
    }


def analyze_and_persist_behavioral_timeline(interview_id: str) -> dict[str, Any]:
    """Full pipeline. Persists results, returns the response payload.

    Never raises; on failure returns an empty payload and records an audit row.
    """
    started_at = datetime.now(timezone.utc)
    _LOG.info("[BehavioralTimeline] Starting analysis for interview %s", interview_id)
    _record_audit(interview_id, "ANALYZE_START", {"fps": BEHAVIORAL_TIMELINE_FPS_SAMPLE})

    if not BEHAVIORAL_TIMELINE_ENABLED:
        _record_audit(interview_id, "ANALYZE_SKIPPED", {"reason": "feature_flag_disabled"})
        return {}

    video_path = find_interview_video(interview_id)
    if not video_path:
        _record_audit(interview_id, "ANALYZE_ERROR", {"reason": "video_not_found"})
        behavioral_timeline_events_col.update_one(
            {"interview_id": interview_id},
            {"$set": {"status": "failed", "reason": "video_not_found", "updatedAt": datetime.now(timezone.utc)}},
            upsert=True,
        )
        return {}

    try:
        video_duration = get_duration_seconds(video_path)
        samples = _iter_sampled_frames(video_path, BEHAVIORAL_TIMELINE_FPS_SAMPLE)
        if not samples:
            raise BehavioralTimelineError("no frames extracted")
        # If we still don't have a duration (broken WebM headers, ffprobe
        # returned N/A, and the decode scan failed too), derive it from the
        # number of frames we just sampled at a known fps. This keeps the
        # heatmap and emotion-timeline loops from collapsing to empty.
        if video_duration <= 0 and BEHAVIORAL_TIMELINE_FPS_SAMPLE > 0:
            video_duration = (
                len(samples) - 1
            ) / BEHAVIORAL_TIMELINE_FPS_SAMPLE + 1.0 / BEHAVIORAL_TIMELINE_FPS_SAMPLE
            _LOG.info(
                "[BehavioralTimeline] Derived video_duration=%.2fs from %d frames @ %.2f fps",
                video_duration,
                len(samples),
                BEHAVIORAL_TIMELINE_FPS_SAMPLE,
            )

        # 1) per-frame DeepFace
        raw_frames: list[dict[str, Any]] = []
        for ts, img, w, h in samples:
            result = _analyze_frame(img)
            if result is None:
                raw_frames.append(
                    {
                        "timestamp": ts,
                        "emotion": {k: 0.0 for k in _EMOTION_KEYS},
                        "face_box": None,
                        "model_conf": 0.0,
                        "face_quality": 0.0,
                        "frame_w": w,
                        "frame_h": h,
                        "no_face": True,
                    }
                )
                continue
            probs = result["emotion"]
            dominant_conf = float(probs.get(result["dominant_emotion"], 0.0))
            fb = result.get("face_box")
            face_area_ratio = 0.0
            if fb and w and h:
                face_area_ratio = (fb["w"] * fb["h"]) / float(w * h)
            face_quality = min(1.0, face_area_ratio / 0.05) if face_area_ratio else 0.0
            raw_frames.append(
                {
                    "timestamp": ts,
                    "emotion": probs,
                    "face_box": fb,
                    "model_conf": dominant_conf,
                    "face_quality": face_quality,
                    "frame_w": w,
                    "frame_h": h,
                    "no_face": False,
                    "action_units": result.get("action_units") or {},
                    "landmarks": result.get("landmarks") or [],
                }
            )

        # 2) EMA smoothing
        smoothed = _smooth_emotions([f["emotion"] for f in raw_frames])
        for f, sm in zip(raw_frames, smoothed):
            f["smoothed"] = sm

        # 3) per-frame safe label using a 3-second rolling window
        fps = BEHAVIORAL_TIMELINE_FPS_SAMPLE
        window_size = max(2, int(round(3.0 * fps)))
        baseline_window = max(window_size, int(round(10.0 * fps)))
        per_frame: list[dict[str, Any]] = []
        for i, frame in enumerate(raw_frames):
            wstart = max(0, i - window_size + 1)
            window = [raw_frames[j]["smoothed"] for j in range(wstart, i + 1)]
            no_face_count = sum(1 for j in range(wstart, i + 1) if raw_frames[j].get("no_face"))
            base_start = max(0, i - baseline_window + 1)
            base_means = {
                k: float(statistics.fmean(
                    float(raw_frames[j]["smoothed"].get(k, 0.0)) for j in range(base_start, i + 1)
                ))
                for k in _EMOTION_KEYS
            }
            # Prefer Action Unit–driven labels when available — FACS-based
            # signals are far more reliable than raw emotion probabilities.
            au_label = None
            if frame.get("action_units"):
                au_label = pyfeat_emotion_service.derive_label_from_aus(
                    frame.get("action_units") or {},
                    frame.get("smoothed") or {},
                )
            label = au_label or _map_to_safe_label(
                window, base_means, no_face_count, window_size
            )
            per_frame.append(
                {
                    "timestamp": float(frame["timestamp"]),
                    "smoothed": frame["smoothed"],
                    "face_box": frame.get("face_box"),
                    "model_conf": frame.get("model_conf", 0.0),
                    "face_quality": frame.get("face_quality", 0.0),
                    "frame_w": frame.get("frame_w", 0),
                    "frame_h": frame.get("frame_h", 0),
                    "label": label,
                    "action_units": frame.get("action_units") or {},
                }
            )

        # 4) aggregate events
        raw_events = _aggregate_events(
            per_frame,
            min_event_sec=BEHAVIORAL_TIMELINE_MIN_EVENT_SEC,
            merge_gap_sec=BEHAVIORAL_TIMELINE_MERGE_GAP_SEC,
        )
        event_docs = [_build_event_doc(ev) for ev in raw_events]

        # 5) heatmap (10s bins)
        heatmap = _build_heatmap(
            per_frame,
            video_duration=video_duration,
            bin_sec=BEHAVIORAL_TIMELINE_HEATMAP_BIN_SEC,
        )

        # 6) summary
        if event_docs:
            label_durations: dict[str, float] = {}
            for ev in event_docs:
                label_durations[ev["label"]] = label_durations.get(ev["label"], 0.0) + ev["duration"]
            dominant_signal = max(label_durations, key=label_durations.get)
        else:
            dominant_signal = LABEL_NEUTRAL
        summary = {
            "dominantSignal": dominant_signal,
            "variationMoments": len(event_docs),
            "videoDuration": round(float(video_duration), 2),
            "analyzedAt": datetime.now(timezone.utc).isoformat(),
        }

        # 6b) emotion summary — recruiter dashboard enrichment
        emotion_summary = build_emotion_summary(
            raw_frames, event_docs, float(video_duration)
        )

        # 6c) per-frame landmark timeline — used by the on-video face mesh
        # overlay. Skip frames that have no landmarks (no face detected).
        # Stored as a compact list of {t, w, h, pts}. The frontend
        # interpolates between adjacent entries for smooth tracking.
        frame_landmarks: list[dict[str, Any]] = []
        for f in raw_frames:
            pts = f.get("landmarks") or []
            if not pts or f.get("no_face"):
                continue
            frame_landmarks.append(
                {
                    "t": round(float(f["timestamp"]), 3),
                    "w": int(f.get("frame_w") or 0),
                    "h": int(f.get("frame_h") or 0),
                    "pts": pts,  # flat [x0,y0,x1,y1,...,x67,y67]
                }
            )

        # 7) persist
        processing_ms = int((datetime.now(timezone.utc) - started_at).total_seconds() * 1000)
        audit_payload = {
            "modelVersion": "deepface",
            "frameSampleRate": BEHAVIORAL_TIMELINE_FPS_SAMPLE,
            "detectorBackend": DEEPFACE_DETECTOR_BACKEND,
            "processingTimeMs": processing_ms,
            "processedAt": datetime.now(timezone.utc),
        }
        behavioral_timeline_events_col.update_one(
            {"interview_id": interview_id},
            {
                "$set": {
                    "interview_id": interview_id,
                    "events": event_docs,
                    "summary": summary,
                    "emotionSummary": emotion_summary,
                    "frameLandmarks": frame_landmarks,
                    "audit": audit_payload,
                    "status": "completed",
                    "updatedAt": datetime.now(timezone.utc),
                }
            },
            upsert=True,
        )
        behavioral_timeline_heatmap_col.update_one(
            {"interview_id": interview_id},
            {
                "$set": {
                    "interview_id": interview_id,
                    "heatmap": heatmap,
                    "createdAt": datetime.now(timezone.utc),
                }
            },
            upsert=True,
        )
        _record_audit(
            interview_id,
            "ANALYZE_COMPLETE",
            {"eventCount": len(event_docs), "processingTimeMs": processing_ms},
        )
        _LOG.info(
            "[BehavioralTimeline] Analysis complete: interview=%s events=%d",
            interview_id,
            len(event_docs),
        )

        return {
            "interview_id": interview_id,
            "events": event_docs,
            "summary": summary,
            "emotionSummary": emotion_summary,
            "frameLandmarks": frame_landmarks,
            "heatmap": heatmap,
        }

    except Exception as exc:  # noqa: BLE001
        _LOG.warning(
            "[BehavioralTimeline] Analysis failed interviewId=%s: %s",
            interview_id,
            exc,
            exc_info=True,
        )
        _record_audit(
            interview_id,
            "ANALYZE_ERROR",
            {"error": str(exc), "errorType": type(exc).__name__},
        )
        behavioral_timeline_events_col.update_one(
            {"interview_id": interview_id},
            {
                "$set": {
                    "status": "failed",
                    "reason": str(exc),
                    "updatedAt": datetime.now(timezone.utc),
                }
            },
            upsert=True,
        )
        return {}
