"""Vision analysis service with configurable thresholds."""
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
import re

import cv2
import numpy as np

from app.core.config import (
    VISION_MIN_BRIGHTNESS,
    VISION_MAX_BRIGHTNESS,
    VISION_CENTER_TOLERANCE_X,
    VISION_CENTER_TOLERANCE_Y,
    VISION_MIN_FACE_RATIO,
    VISION_MAX_FACE_RATIO,
    VISION_NO_FACE_SECS,
    VISION_MULTIPLE_FACES_SECS,
    VISION_LOW_LIGHT_SECS,
    VISION_NOT_CENTERED_SECS,
    VISION_BAD_DISTANCE_SECS,
)


@dataclass
class VisionThresholds:
    """Vision analysis thresholds loaded from environment/config."""
    min_brightness: float = VISION_MIN_BRIGHTNESS
    max_brightness: float = VISION_MAX_BRIGHTNESS
    center_tolerance_x: float = VISION_CENTER_TOLERANCE_X
    center_tolerance_y: float = VISION_CENTER_TOLERANCE_Y
    min_face_ratio: float = VISION_MIN_FACE_RATIO
    max_face_ratio: float = VISION_MAX_FACE_RATIO
    no_face_secs: int = VISION_NO_FACE_SECS
    multiple_faces_secs: int = VISION_MULTIPLE_FACES_SECS
    low_light_secs: int = VISION_LOW_LIGHT_SECS
    not_centered_secs: int = VISION_NOT_CENTERED_SECS
    bad_distance_secs: int = VISION_BAD_DISTANCE_SECS


def _frame_sec_from_name(path: Path) -> int:
    m = re.search(r"frame_(\d+)\.jpg$", path.name)
    if not m:
        return 0
    return max(0, int(m.group(1)) - 1)


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _make_event(sec: int, event_type: str, severity: str, message: str, meta: dict | None = None) -> dict:
    return {
        "timestamp": _utc_now_iso(),
        "timeInVideoSeconds": sec,
        "questionId": "",
        "type": event_type,
        "severity": severity,
        "message": message,
        "source": "post_interview_video_analysis",
        "meta": meta or {},
    }


def _flush_run(events: list[dict], run: dict, min_secs: int, event_type: str, severity: str, message: str, meta: dict | None = None):
    if run["active"] and run["length"] >= min_secs:
        events.append(_make_event(run["start_sec"], event_type, severity, message, meta=meta))
    run["active"] = False
    run["start_sec"] = 0
    run["length"] = 0


def _load_face_cascade() -> cv2.CascadeClassifier:
    cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    cascade = cv2.CascadeClassifier(cascade_path)
    if cascade.empty():
        raise RuntimeError(f"Failed to load Haar cascade from {cascade_path}")
    return cascade


def analyze_frames(frames_dir: Path, thresholds: VisionThresholds | None = None) -> dict:
    th = thresholds or VisionThresholds()
    frame_paths = sorted(frames_dir.glob("frame_*.jpg"))
    events: list[dict] = []
    summary = {
        "totalChecks": 0,
        "faceDetectedChecks": 0,
        "noFaceChecks": 0,
        "multipleFacesChecks": 0,
        "lightingIssueChecks": 0,
        "positionIssueChecks": 0,
        "distanceIssueChecks": 0,
    }

    if not frame_paths:
        return {"events": events, "summary": summary}

    face_cascade = _load_face_cascade()

    no_face_run = {"active": False, "start_sec": 0, "length": 0}
    multi_face_run = {"active": False, "start_sec": 0, "length": 0}
    low_light_run = {"active": False, "start_sec": 0, "length": 0}
    not_centered_run = {"active": False, "start_sec": 0, "length": 0}
    bad_distance_run = {"active": False, "start_sec": 0, "length": 0}

    for fp in frame_paths:
        summary["totalChecks"] += 1
        sec = _frame_sec_from_name(fp)
        img_bgr = cv2.imread(str(fp))
        if img_bgr is None:
            continue
        h, w = img_bgr.shape[:2]
        gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
        brightness = float(np.mean(gray))

        detections = face_cascade.detectMultiScale(
            gray,
            scaleFactor=1.1,
            minNeighbors=5,
            minSize=(30, 30),
        )
        face_count = len(detections) if len(detections) > 0 else 0

        if face_count == 0:
            summary["noFaceChecks"] += 1
            no_face_run["active"] = True
            no_face_run["start_sec"] = no_face_run["start_sec"] or sec
            no_face_run["length"] += 1
        else:
            _flush_run(
                events,
                no_face_run,
                th.no_face_secs,
                "NO_FACE_DETECTED",
                "medium",
                "No face detected for extended duration. Recruiter review recommended.",
            )
            summary["faceDetectedChecks"] += 1

        if face_count > 1:
            summary["multipleFacesChecks"] += 1
            multi_face_run["active"] = True
            multi_face_run["start_sec"] = multi_face_run["start_sec"] or sec
            multi_face_run["length"] += 1
        else:
            _flush_run(
                events,
                multi_face_run,
                th.multiple_faces_secs,
                "MULTIPLE_FACES_DETECTED",
                "high",
                "More than one face detected. Recruiter review recommended.",
            )

        if brightness < th.min_brightness or brightness > th.max_brightness:
            summary["lightingIssueChecks"] += 1
            low_light_run["active"] = True
            low_light_run["start_sec"] = low_light_run["start_sec"] or sec
            low_light_run["length"] += 1
        else:
            _flush_run(
                events,
                low_light_run,
                th.low_light_secs,
                "POOR_LIGHTING",
                "low",
                "Lighting quality is poor for part of the interview.",
            )

        if face_count > 0:
            # Haar cascade returns (x, y, w, h) in pixels — convert to relative coords
            x, y, fw, fh = detections[0]
            cx = float(x + fw / 2.0) / w
            cy = float(y + fh / 2.0) / h
            face_ratio = float(fw) / w

            if abs(cx - 0.5) > th.center_tolerance_x or abs(cy - 0.5) > th.center_tolerance_y:
                summary["positionIssueChecks"] += 1
                not_centered_run["active"] = True
                not_centered_run["start_sec"] = not_centered_run["start_sec"] or sec
                not_centered_run["length"] += 1
            else:
                _flush_run(
                    events,
                    not_centered_run,
                    th.not_centered_secs,
                    "FACE_NOT_CENTERED",
                    "low",
                    "Face was not centered for an extended period.",
                )

            if face_ratio < th.min_face_ratio or face_ratio > th.max_face_ratio:
                summary["distanceIssueChecks"] += 1
                bad_distance_run["active"] = True
                bad_distance_run["start_sec"] = bad_distance_run["start_sec"] or sec
                bad_distance_run["length"] += 1
            else:
                _flush_run(
                    events,
                    bad_distance_run,
                    th.bad_distance_secs,
                    "BAD_FACE_DISTANCE",
                    "low",
                    "Face distance from camera was not optimal.",
                )

    _flush_run(events, no_face_run, th.no_face_secs, "NO_FACE_DETECTED", "medium", "No face detected for extended duration. Recruiter review recommended.")
    _flush_run(events, multi_face_run, th.multiple_faces_secs, "MULTIPLE_FACES_DETECTED", "high", "More than one face detected. Recruiter review recommended.")
    _flush_run(events, low_light_run, th.low_light_secs, "POOR_LIGHTING", "low", "Lighting quality is poor for part of the interview.")
    _flush_run(events, not_centered_run, th.not_centered_secs, "FACE_NOT_CENTERED", "low", "Face was not centered for an extended period.")
    _flush_run(events, bad_distance_run, th.bad_distance_secs, "BAD_FACE_DISTANCE", "low", "Face distance from camera was not optimal.")

    return {"events": events, "summary": summary}
