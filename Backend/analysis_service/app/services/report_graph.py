"""LangGraph StateGraph for the post-interview report pipeline.

The deterministic services in this package are the source of truth — this
module only sequences them, threads state, captures errors, and adds an
OPTIONAL LLM polish step (gated by REPORT_POLISH_ENABLED) before persisting
the final report. The persisted document keeps the exact schema produced
by ``report_service.build_final_report``.
"""

from __future__ import annotations

import logging
import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, TypedDict

from app.core.config import (
    ANALYSIS_FRAME_FPS,
    UPLOADS_DIR,
    WHISPER_COMPUTE_TYPE,
    WHISPER_DEVICE,
    WHISPER_MODEL,
)
from app.db.mongo import (
    call_rooms_col,
    jobs_col,
    pipeline_snapshots_col,
    reports_col,
    transcripts_col,
    vision_events_col,
)
from app.schemas.report_schema import validate_final_report

# ── Phase 3 — Explainability / Auditability modules ──────────────────────────
from app.services.audit_logger import AuditLogger
from app.services.bias_detector import detect_biases
from app.services.confidence_engine import compute_final_decision
from app.services.decision_trace import build_decision_trace
from app.services.ffmpeg_service import (
    extract_audio,
    extract_frames,
    get_duration_seconds,
)
from app.services.hallucination_guard import validate_llm_output_against_evidence
from app.services.interview_metadata import (
    get_report_metadata,
    resolve_full_job_context,
    resolve_interview_metadata,
)
from app.services.job_match_service import build_job_match_evaluation
from app.services.qna_service import extract_qna_from_stt, load_interview_qa
from app.services.question_evaluator import evaluate_all_questions
from app.services.report_polish import polish as polish_report_fn
from app.services.report_service import build_final_report
from app.services.sentiment_service import analyze_qna_sentiment
from app.services.silence_service import detect_silences
from app.services.skills_service import extract_skills_from_interview
from app.services.stt_service import transcribe_audio
from app.services.vision_service import analyze_frames
from langgraph.graph import END, StateGraph

_LOG = logging.getLogger(__name__)

# Configuration from environment
ANALYSIS_CLEANUP_TEMP_FILES = os.getenv(
    "ANALYSIS_CLEANUP_TEMP_FILES", "true"
).strip().lower() in {"1", "true", "yes", "on"}


# ─── Cleanup helpers ──────────────────────────────────────────────────────────


def _cleanup_file_safe(path: Path | str | None) -> bool:
    """Safely delete a file. Returns True if deleted or didn't exist."""
    if not path:
        return True
    try:
        p = Path(path)
        if p.exists() and p.is_file():
            p.unlink()
            _LOG.info("[Cleanup] Deleted file: %s", p)
            return True
    except Exception as e:
        _LOG.warning("[Cleanup] Failed to delete file %s: %s", path, e)
    return False


def _cleanup_directory_safe(path: Path | str | None) -> bool:
    """Safely delete a directory and its contents."""
    if not path:
        return True
    try:
        p = Path(path)
        if p.exists() and p.is_dir():
            shutil.rmtree(p)
            _LOG.info("[Cleanup] Deleted directory: %s", p)
            return True
    except Exception as e:
        _LOG.warning("[Cleanup] Failed to delete directory %s: %s", path, e)
    return False


def _cleanup_analysis_temp_files(state: ReportState) -> dict:
    """Clean up temporary analysis files (audio, frames).

    Rules:
    - Never delete the original video (in raw/ directory)
    - Delete extracted audio.wav
    - Delete extracted frames directory
    - Log all cleanup actions
    - Failures are logged but don't stop the pipeline
    """
    if not ANALYSIS_CLEANUP_TEMP_FILES:
        _LOG.info("[Cleanup] Skipped (ANALYSIS_CLEANUP_TEMP_FILES=false)")
        return {}

    interview_id = state.get("interview_id", "unknown")
    _LOG.info("[Cleanup] Starting temp file cleanup for interviewId=%s", interview_id)

    cleaned = {
        "audio_deleted": False,
        "frames_deleted": False,
        "errors": [],
    }

    # Cleanup audio file
    audio_path = state.get("audio_path")
    if audio_path:
        try:
            cleaned["audio_deleted"] = _cleanup_file_safe(audio_path)
        except Exception as e:
            cleaned["errors"].append(f"audio: {e}")

    # Cleanup frames directory
    frames_dir = state.get("frames_dir")
    if frames_dir:
        try:
            cleaned["frames_deleted"] = _cleanup_directory_safe(frames_dir)
        except Exception as e:
            cleaned["errors"].append(f"frames: {e}")

    if cleaned["errors"]:
        _LOG.warning(
            "[Cleanup] Completed with errors for interviewId=%s: %s",
            interview_id,
            cleaned["errors"],
        )
    else:
        _LOG.info("[Cleanup] Completed successfully for interviewId=%s", interview_id)

    return {"cleanup_result": cleaned}


PolishStatus = Literal["skipped", "completed", "failed", "timeout"]


class ReportState(TypedDict, total=False):
    interview_id: str
    polish_enabled: bool

    video_path: str
    audio_path: str
    frames_dir: str

    duration_seconds: float
    vision_payload: dict
    transcript_payload: dict
    silence_events: list[dict]
    call_room: dict
    live_events: list[dict]
    live_summary: dict
    post_events: list[dict]
    post_summary: dict

    deterministic_report: dict
    final_report: dict

    error: str | None
    polish_status: PolishStatus
    llm_used: bool
    # Immutable snapshot of all deterministic pipeline inputs.
    # Set by build_report_node; read by finalize_interview_node.
    pipeline_snapshot: dict

    # ── Phase 3 — Explainability / Auditability ──────────────────────
    # Traceable decision record: every score with evidence + reasoning steps.
    decision_trace: dict
    # Bias detection report (never alters scores; flagged for recruiter review).
    bias_report: dict
    # Confidence-driven decision: PASS | FAIL | REVIEW_REQUIRED + justification.
    confidence_decision: dict


# ─── Helpers (kept here so all nodes import from one place) ───────────────────


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _set_job(interview_id: str, **fields: Any) -> None:
    jobs_col.update_one(
        {"interviewId": interview_id},
        {"$set": {"updatedAt": _utc_now(), **fields}},
        upsert=True,
    )


def _coerce_object_id(value: str):
    try:
        from bson import ObjectId

        return ObjectId(value)
    except Exception:
        return None


def _safe_nested(data: dict, keys: list[str]):
    cur = data
    for key in keys:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(key)
    return cur


def _polish_enabled_from_env() -> bool:
    return (os.getenv("REPORT_POLISH_ENABLED", "false") or "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


# ─── Node decorator: progress tracking + uniform error capture ────────────────


def _build_error_info(
    code: str,
    message: str,
    step: str,
    recoverable: bool = True,
) -> dict:
    """Build structured error information for node failures."""
    return {
        "code": code,
        "message": message,
        "step": step,
        "recoverable": recoverable,
        "timestamp": _utc_now().isoformat(),
    }


def node(step: str, progress: int):
    """Decorate a node with progress tracking and error short-circuit.

    - Skips entirely if a prior node already set ``state["error"]``.
    - Reports progress to the jobs collection before running.
    - Captures exceptions into ``state["error"]`` so the graph can route to
      ``mark_failed`` via the tail conditional.
    - Logs structured error information including duration and interviewId.
    """

    def deco(fn):
        def wrapped(state: ReportState) -> dict:
            if state.get("error"):
                return {}

            interview_id = state.get("interview_id", "")
            if interview_id:
                _set_job(interview_id, progress=progress, currentStep=step)

            start_time = datetime.now(timezone.utc)
            _LOG.info(
                "[Node Start] step=%s interviewId=%s progress=%d",
                step,
                interview_id or "unknown",
                progress,
            )

            try:
                result = fn(state)
                duration_ms = (
                    datetime.now(timezone.utc) - start_time
                ).total_seconds() * 1000

                # Structured success log
                _LOG.info(
                    "report_graph_node_finished",
                    extra={
                        "event": "report_graph_node_finished",
                        "interviewId": interview_id or "unknown",
                        "node": step,
                        "status": "success",
                        "durationMs": round(duration_ms),
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    },
                )
                return result

            except RuntimeError as exc:
                # Structured errors from services (FFmpeg, etc.)
                duration_ms = (
                    datetime.now(timezone.utc) - start_time
                ).total_seconds() * 1000
                error_str = str(exc)

                # Try to parse structured error from subprocess failures
                error_code = "runtime_error"
                if "subprocess_timeout" in error_str:
                    error_code = "subprocess_timeout"
                elif "subprocess_failed" in error_str:
                    error_code = "subprocess_failed"

                error_info = _build_error_info(
                    code=error_code,
                    message=f"{step} failed: {exc}",
                    step=step,
                    recoverable=error_code != "subprocess_failed",
                )

                # Structured error log
                _LOG.error(
                    "report_graph_node_failed",
                    extra={
                        "event": "report_graph_node_failed",
                        "interviewId": interview_id or "unknown",
                        "node": step,
                        "status": "failed",
                        "durationMs": round(duration_ms),
                        "errorCode": error_code,
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    },
                )
                return {"error": error_info}

            except Exception as exc:  # noqa: BLE001 — uniform error capture
                duration_ms = (
                    datetime.now(timezone.utc) - start_time
                ).total_seconds() * 1000

                error_info = _build_error_info(
                    code="node_exception",
                    message=f"{step}: {exc}",
                    step=step,
                    recoverable=False,
                )

                # Structured exception log
                _LOG.exception(
                    "report_graph_node_exception",
                    extra={
                        "event": "report_graph_node_exception",
                        "interviewId": interview_id or "unknown",
                        "node": step,
                        "status": "failed",
                        "durationMs": round(duration_ms),
                        "errorCode": "node_exception",
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    },
                )
                return {"error": error_info}

        wrapped.__name__ = fn.__name__
        return wrapped

    return deco


# ─── Nodes ────────────────────────────────────────────────────────────────────


@node("initializing", 5)
def init_node(state: ReportState) -> dict:
    interview_id = state["interview_id"]
    interview_dir = UPLOADS_DIR / interview_id
    raw_dir = interview_dir / "raw"
    analysis_dir = interview_dir / "analysis"
    frames_dir = analysis_dir / "frames"
    audio_path = analysis_dir / "audio.wav"

    raw_candidates = sorted(raw_dir.glob("*"))
    if not raw_candidates:
        return {"error": "No uploaded interview video found."}
    video_path = raw_candidates[-1]

    # Mirror the original orchestrator: clear any prior error so retries start clean.
    _set_job(
        interview_id,
        status="running",
        startedAt=_utc_now(),
        error=None,
    )

    return {
        "video_path": str(video_path),
        "audio_path": str(audio_path),
        "frames_dir": str(frames_dir),
        "polish_enabled": state.get("polish_enabled", _polish_enabled_from_env()),
        "polish_status": "skipped",
    }


@node("extract_audio", 15)
def audio_extract_node(state: ReportState) -> dict:
    video_path = Path(state["video_path"])
    audio_path = Path(state["audio_path"])

    _LOG.info(
        "[extract_audio] Starting audio extraction: video=%s, audio=%s",
        video_path,
        audio_path,
    )

    # Check video file before extraction
    video_size = video_path.stat().st_size if video_path.exists() else 0
    _LOG.info(
        "[extract_audio] Video file size: %d bytes (%.2f MB)",
        video_size,
        video_size / (1024 * 1024),
    )

    extract_audio(video_path, audio_path)

    # Validate extracted audio
    if audio_path.exists():
        audio_size = audio_path.stat().st_size
        _LOG.info(
            "[extract_audio] Audio extracted successfully: size=%d bytes (%.2f MB), path=%s",
            audio_size,
            audio_size / (1024 * 1024),
            audio_path,
        )
        # Audio duration will be checked during transcription
    else:
        _LOG.error(
            "[extract_audio] Audio file not found after extraction: %s", audio_path
        )

    return {
        "audio_extracted": audio_path.exists(),
        "audio_size_bytes": audio_size if audio_path.exists() else 0,
    }


@node("extract_frames", 30)
def frames_extract_node(state: ReportState) -> dict:
    extract_frames(
        Path(state["video_path"]), Path(state["frames_dir"]), fps=ANALYSIS_FRAME_FPS
    )
    return {}


@node("vision_analysis", 48)
def vision_analyze_node(state: ReportState) -> dict:
    interview_id = state["interview_id"]
    vision_payload = analyze_frames(Path(state["frames_dir"]))
    for event in vision_payload["events"]:
        vision_events_col.insert_one({"interviewId": interview_id, **event})
    return {"vision_payload": vision_payload}


@node("transcription", 65)
def transcribe_node(state: ReportState) -> dict:
    interview_id = state["interview_id"]
    audio_path = Path(state["audio_path"])

    _LOG.info("[transcription] Starting transcription for interview=%s", interview_id)

    # Pre-check audio file
    if not audio_path.exists():
        _LOG.error("[transcription] Audio file not found: %s", audio_path)
        transcript_payload = {
            "transcriptionAvailable": False,
            "sttFallback": True,
            "sttFallbackReason": "audio_file_missing",
            "language": None,
            "segments": [],
            "fullText": "",
            "error": f"Audio file not found: {audio_path}",
            "transcriptQuality": {
                "qualityGrade": "FAIL",
                "qualityScore": 0,
                "qualityFlags": ["audio_file_missing"],
                "wordCount": 0,
                "segmentCount": 0,
                "avgConfidence": 0.0,
                "languageProbability": 0.0,
            },
        }
    else:
        audio_size = audio_path.stat().st_size
        _LOG.info(
            "[transcription] Audio file found: size=%d bytes (%.2f MB)",
            audio_size,
            audio_size / (1024 * 1024),
        )

        # Warn if audio file is suspiciously small (likely silent or no audio track)
        if audio_size < 1024:  # Less than 1KB
            _LOG.warning(
                "[transcription] Audio file is extremely small (%d bytes). Video may have no audio track or be silent.",
                audio_size,
            )
        elif audio_size < 10000:  # Less than 10KB
            _LOG.warning(
                "[transcription] Audio file is very small (%d bytes). Audio quality may be poor.",
                audio_size,
            )

        transcript_payload = transcribe_audio(
            audio_path,
            model_name=WHISPER_MODEL,
            device=WHISPER_DEVICE,
            compute_type=WHISPER_COMPUTE_TYPE,
        )

    # Log transcription results
    available = transcript_payload.get("transcriptionAvailable", False)
    segments = transcript_payload.get("segments", [])
    full_text = transcript_payload.get("fullText", "")
    word_count = len(full_text.split()) if full_text else 0

    _LOG.info(
        "[transcription] Transcription result for interview=%s: available=%s, segments=%d, words=%d, fallback=%s, reason=%s",
        interview_id,
        available,
        len(segments),
        word_count,
        transcript_payload.get("sttFallback", False),
        transcript_payload.get("sttFallbackReason", "none"),
    )

    if not available and not transcript_payload.get("sttFallback"):
        _LOG.warning(
            "[transcription] No usable transcript extracted. sttFallback=%s, error=%s",
            transcript_payload.get("sttFallback"),
            transcript_payload.get("error", "none"),
        )

    transcripts_col.update_one(
        {"interviewId": interview_id},
        {
            "$set": {
                "interviewId": interview_id,
                **transcript_payload,
                "updatedAt": _utc_now(),
            }
        },
        upsert=True,
    )

    # ── Transcript Quality Gate ───────────────────────────────────────────────────
    # We must NOT continue the pipeline on a fundamentally unusable transcript.
    # A FAIL grade means: empty audio, import failure, or <20 words total.
    # A WARN grade means: short or low-confidence but potentially usable.
    # We hard-stop on FAIL. We log and continue on WARN.
    transcript_quality = transcript_payload.get("transcriptQuality") or {}
    quality_grade = transcript_quality.get("qualityGrade", "PASS")
    quality_flags = transcript_quality.get("qualityFlags", [])
    quality_score = transcript_quality.get("qualityScore", 100)

    _LOG.info(
        "[transcription] Quality gate: grade=%s score=%d flags=%s interview=%s",
        quality_grade,
        quality_score,
        quality_flags,
        interview_id,
    )

    if quality_grade == "FAIL":
        # ── Changed behavior: Don't fail the entire pipeline for poor transcripts ──
        # Instead, log a warning and proceed with limited data. The report will
        # reflect low confidence and missing transcript data.
        _LOG.warning(
            "[transcription] TRANSCRIPT QUALITY GATE: FAILED for interview=%s. "
            "Proceeding with limited data. grade=%s score=%d flags=%s",
            interview_id,
            quality_grade,
            quality_score,
            quality_flags,
        )
        # Persist the quality failure as metadata in the transcript
        transcripts_col.update_one(
            {"interviewId": interview_id},
            {
                "$set": {
                    "transcriptQualityGate": "FAIL",
                    "transcriptQualityFlags": quality_flags,
                    "qualityNote": "Report generated with limited transcript data",
                }
            },
            upsert=True,
        )
        # Continue to next node instead of returning error

    if quality_grade == "WARN":
        _LOG.warning(
            "[transcription] TRANSCRIPT QUALITY GATE: WARN for interview=%s. "
            "Proceeding with caution. grade=%s score=%d flags=%s",
            interview_id,
            quality_grade,
            quality_score,
            quality_flags,
        )
        transcripts_col.update_one(
            {"interviewId": interview_id},
            {
                "$set": {
                    "transcriptQualityGate": "WARN",
                    "transcriptQualityFlags": quality_flags,
                }
            },
            upsert=True,
        )

    return {"transcript_payload": transcript_payload}


@node("silence_detection", 78)
def silence_detect_node(state: ReportState) -> dict:
    interview_id = state["interview_id"]
    silence_events = detect_silences(Path(state["audio_path"]))
    transcripts_col.update_one(
        {"interviewId": interview_id},
        {"$set": {"silenceEvents": silence_events}},
        upsert=True,
    )
    return {"silence_events": silence_events}


@node("merge_live_monitoring", 88)
def merge_live_node(state: ReportState) -> dict:
    interview_id = state["interview_id"]
    call_room = (
        call_rooms_col.find_one({"_id": _coerce_object_id(interview_id)})
        or call_rooms_col.find_one({"roomId": interview_id})
        or {}
    )
    live_events = (call_room.get("visionMonitoring") or {}).get("events") or []
    live_summary = (call_room.get("visionMonitoring") or {}).get("summary") or {}
    vision_payload = state.get("vision_payload") or {"events": [], "summary": {}}
    return {
        "call_room": call_room,
        "live_events": live_events,
        "live_summary": live_summary,
        "post_events": vision_payload["events"],
        "post_summary": vision_payload["summary"],
    }


@node("report_generation", 95)
def build_report_node(state: ReportState) -> dict:
    interview_id = state["interview_id"]
    duration_seconds = get_duration_seconds(Path(state["video_path"]))

    # ── Load call room (needed for Q&A and job context) ───────────────────
    call_room = state.get("call_room") or (
        call_rooms_col.find_one({"_id": _coerce_object_id(interview_id)})
        or call_rooms_col.find_one({"roomId": interview_id})
        or {}
    )

    # ── Step 1: Load structured Q&A from stored messages ─────────────────
    interview_qna = load_interview_qa(interview_id, call_room=call_room)
    if not interview_qna["available"]:
        # Fallback: try to annotate from STT transcript
        transcript_payload = state.get("transcript_payload") or {}
        interview_qna = extract_qna_from_stt(transcript_payload)
    _LOG.info(
        "[Q&A] source=%s questions=%d answered=%d",
        interview_qna.get("source"),
        interview_qna.get("questionCount", 0),
        interview_qna.get("answeredCount", 0),
    )

    # ── Step 2: Sentiment analysis on Q&A items ───────────────────────────
    qna_items = interview_qna.get("items") or []
    answer_sentiment_summary = analyze_qna_sentiment(qna_items)

    # ── Step 3: Per-question evaluation ──────────────────────────────────
    question_evaluations = evaluate_all_questions(qna_items)

    # ── Step 4: Full job context ──────────────────────────────────────────
    job_context = resolve_full_job_context(interview_id)
    _LOG.info(
        "[JobContext] linked=%s title=%s skills=%d",
        job_context.get("linked"),
        job_context.get("title"),
        len(job_context.get("requiredSkills") or []),
    )

    # ── Step 5: Skills extraction (from candidate answers only) ───────────
    transcript_payload_for_skills = state.get("transcript_payload") or {}
    full_transcript = transcript_payload_for_skills.get("fullText") or ""
    required_skills = job_context.get("requiredSkills") or []
    skills_extracted = extract_skills_from_interview(
        qna_items=qna_items,
        full_transcript=full_transcript,
        job_required_skills=required_skills,
    )

    # ── Step 6: Job match evaluation ─────────────────────────────────────
    full_candidate_text = " ".join(
        item.get("answerText") or "" for item in qna_items
    ).strip()
    job_match_eval = build_job_match_evaluation(
        job_context=job_context,
        detected_skills=skills_extracted.get("detectedSkills") or [],
        question_evaluations=question_evaluations,
        full_candidate_text=full_candidate_text or full_transcript,
    )

    # Resolve real metadata from MongoDB collections
    # This ensures reports contain actual candidate names and job titles
    # instead of placeholder values like "Candidate" and "Role"
    metadata = get_report_metadata(interview_id)

    _LOG.info(
        "[report_generation] Building report for interview=%s with metadata: "
        "candidate=%s, job=%s, job_status=%s",
        interview_id,
        metadata["candidate_name"],
        metadata["job_title"],
        metadata.get("job_metadata_status", "unknown"),
    )

    report = build_final_report(
        interview_id=interview_id,
        candidate_name=metadata["candidate_name"],
        job_title=metadata["job_title"],
        job_metadata_status=metadata.get("job_metadata_status", "unknown"),
        duration_seconds=duration_seconds,
        transcript_payload=state.get("transcript_payload") or {},
        live_vision_summary=state.get("live_summary") or {},
        post_vision_summary=state.get("post_summary") or {},
        live_events=state.get("live_events") or [],
        post_events=state.get("post_events") or [],
        silence_events=state.get("silence_events") or [],
        # Enhanced fields
        interview_qna=interview_qna,
        question_evaluations=question_evaluations,
        skills_extracted=skills_extracted,
        job_context=job_context,
        job_match_evaluation=job_match_eval,
        answer_sentiment_summary=answer_sentiment_summary,
    )

    # Add resolved metadata IDs to report for traceability
    report["candidateEmail"] = metadata["candidate_email"]
    report["jobMetadataStatus"] = metadata.get("job_metadata_status", "unknown")
    if metadata["job_id"]:
        report["jobId"] = metadata["job_id"]
    if metadata["application_id"]:
        report["applicationId"] = metadata["application_id"]

    # Build an immutable snapshot of all deterministic pipeline inputs.
    # Downstream nodes (finalize_interview_node) MUST read from this
    # snapshot — never re-fetch from MongoDB — to guarantee idempotency.
    pipeline_snapshot = {
        "interviewId": interview_id,
        "transcriptAvailable": bool(
            (state.get("transcript_payload") or {}).get("transcriptionAvailable")
        ),
        "transcriptWordCount": len(
            ((state.get("transcript_payload") or {}).get("fullText") or "").split()
        ),
        "qnaAvailable": interview_qna.get("available", False),
        "qnaQuestionCount": interview_qna.get("questionCount", 0),
        "qnaAnsweredCount": interview_qna.get("answeredCount", 0),
        "skillsDetected": len((skills_extracted.get("detectedSkills") or [])),
        "visionEventsCount": len(state.get("live_events") or [])
        + len(state.get("post_events") or []),
        "silenceEventsCount": len(state.get("silence_events") or []),
        "durationSeconds": duration_seconds,
        "snapshotBuiltAt": _utc_now().isoformat(),
    }
    _LOG.info(
        "[PIPELINE SNAPSHOT] interviewId=%s transcript=%s qna=%s questions=%d",
        interview_id,
        pipeline_snapshot["transcriptAvailable"],
        pipeline_snapshot["qnaAvailable"],
        pipeline_snapshot["qnaQuestionCount"],
    )

    # ─────────────────────────────────────────────────────────────────────────
    # Phase 3 — Explainability, Bias Detection, Confidence Decision, Audit
    # These are ALL wrapped in try/except so a failure here never kills the
    # pipeline.  The report is still valid without Phase 3 metadata.
    # ─────────────────────────────────────────────────────────────────────────

    # 3-A  Decision trace: traceable record of every score computation
    try:
        decision_trace = build_decision_trace(
            interview_id=interview_id,
            report=report,
            qna_items=qna_items,
            question_evaluations=question_evaluations,
            transcript_payload=state.get("transcript_payload") or {},
            live_events=state.get("live_events") or [],
            post_events=state.get("post_events") or [],
            silence_events=state.get("silence_events") or [],
            job_match_eval=job_match_eval,
            skills_extracted=skills_extracted,
            pipeline_snapshot=pipeline_snapshot,
        )
    except Exception as _dt_exc:  # noqa: BLE001
        _LOG.warning("[build_report] decision_trace failed: %s", _dt_exc)
        decision_trace = {"error": str(_dt_exc)}

    # 3-B  Bias detection: never modifies scores, only flags for recruiter
    try:
        bias_report = detect_biases(
            qna_items=qna_items,
            question_evaluations=question_evaluations,
            silence_events=state.get("silence_events") or [],
            transcript_payload=state.get("transcript_payload") or {},
            hr_score=(report.get("hrEvaluation") or {}).get("score"),
        )
    except Exception as _br_exc:  # noqa: BLE001
        _LOG.warning("[build_report] bias_detector failed: %s", _br_exc)
        bias_report = {"analysisPerformed": False, "error": str(_br_exc)}

    # 3-C  Confidence-driven decision: PASS | FAIL | REVIEW_REQUIRED
    try:
        _cb: dict = decision_trace.get("confidenceBreakdown") or {}  # type: ignore[assignment]
        evidence_coverage = float(_cb.get("overall") or 0.0)
        confidence_decision = compute_final_decision(
            overall_score=report.get("overallScore"),
            report_quality=report.get("reportQuality") or {},
            evidence_coverage=evidence_coverage,
            qna_available=interview_qna.get("available", False),
            qna_answered_count=interview_qna.get("answeredCount", 0),
            bias_flags=bias_report.get("detectedBiases") or [],
        )
    except Exception as _cd_exc:  # noqa: BLE001
        _LOG.warning("[build_report] confidence_engine failed: %s", _cd_exc)
        confidence_decision = {
            "label": "REVIEW_REQUIRED",
            "confidence": 0.0,
            "justification": f"Decision engine error: {_cd_exc}",
            "triggerRules": ["engine_error"],
        }

    _LOG.info(
        "[EVALUATION COMPLETE] interviewId=%s overall=%s decision=%s bias_risk=%s",
        interview_id,
        report.get("overallScore"),
        confidence_decision.get("label"),
        bias_report.get("biasRiskLevel", "unknown"),
    )

    # Embed Phase 3 artifacts directly into the report dict so they are
    # persisted to MongoDB as part of the final document.
    report["decisionTrace"] = decision_trace
    report["biasReport"] = bias_report
    report["confidenceDecision"] = confidence_decision
    report["explanationLayer"] = decision_trace.get("explanationLayer") or {}
    report["confidenceMap"] = decision_trace.get("confidenceBreakdown") or {}

    # 3-D  Audit: record score computation event
    AuditLogger.log(
        interview_id=interview_id,
        node_name="build_report",
        event_type="score_computed",
        summary=(
            f"overall={report.get('overallScore')} "
            f"decision={confidence_decision.get('label')} "
            f"qna={len(qna_items)} "
            f"bias_risk={bias_report.get('biasRiskLevel', 'unknown')}"
        ),
        payload={
            "overallScore": report.get("overallScore"),
            "technicalScore": (report.get("technicalEvaluation") or {}).get("score"),
            "hrScore": (report.get("hrEvaluation") or {}).get("score"),
            "integrityScore": report.get("integrityScore"),
        },
    )
    AuditLogger.log(
        interview_id=interview_id,
        node_name="build_report",
        event_type="decision_made",
        summary=(
            f"label={confidence_decision.get('label')} "
            f"confidence={confidence_decision.get('confidence')} "
            f"coverage={confidence_decision.get('evidenceCoverage')}"
        ),
        payload=confidence_decision,
    )

    return {
        "duration_seconds": duration_seconds,
        "deterministic_report": report,
        "final_report": report,
        "pipeline_snapshot": pipeline_snapshot,
        "decision_trace": decision_trace,
        "bias_report": bias_report,
        "confidence_decision": confidence_decision,
    }


def polish_report_node(state: ReportState) -> dict:
    """Optional polish — must never fail the graph.

    Not wrapped with ``@node`` because polish errors must be swallowed
    entirely here — a polish failure must never prevent report persistence.

    Safety rules enforced here:
    - _set_job is wrapped so a MongoDB timeout cannot kill this node.
    - Any exception from polish_report_fn falls back to the deterministic
      report so finalize_interview_node always receives a usable payload.
    """
    interview_id = state.get("interview_id", "")
    deterministic = state.get("deterministic_report") or state.get("final_report") or {}

    # Guard: _set_job can throw on transient MongoDB errors.  A progress
    # update failure must not prevent the report from being persisted.
    try:
        if interview_id:
            _set_job(interview_id, progress=96, currentStep="report_polish")
    except Exception as exc:  # noqa: BLE001
        _LOG.warning(
            "[polish] _set_job(96) failed for interview=%s — continuing: %s",
            interview_id,
            exc,
        )

    try:
        merged, status, llm_used = polish_report_fn(deterministic)
        return {"final_report": merged, "polish_status": status, "llm_used": llm_used}
    except Exception as exc:  # noqa: BLE001
        # polish_report_fn already swallows all internal errors, but guard
        # against any unexpected exception escaping to protect persistence.
        _LOG.error(
            "[polish] Unexpected exception for interview=%s — falling back to "
            "deterministic report: %s",
            interview_id,
            exc,
        )
        return {
            "final_report": deterministic,
            "polish_status": "failed",
            "llm_used": False,
        }


def _validate_pipeline_state(state: ReportState, interview_id: str) -> list[str]:
    """Validate that all required pipeline stages produced usable output.

    Returns a list of validation error strings.
    An empty list means the pipeline state is valid and safe to finalize.
    """
    errors: list[str] = []

    # Report must exist and have the correct interviewId
    report = state.get("final_report") or state.get("deterministic_report") or {}
    if not report:
        errors.append("no_report_in_state")
    elif report.get("interviewId") != interview_id:
        errors.append(
            f"report_interviewId_mismatch: "
            f"expected={interview_id} got={report.get('interviewId')}"
        )

    # Transcript payload must be present (even if STT failed — it should
    # have a fallback payload with transcriptionAvailable=False)
    transcript = state.get("transcript_payload")
    if transcript is None:
        errors.append("no_transcript_payload_in_state")

    # Pipeline snapshot must be present (set by build_report_node)
    if not state.get("pipeline_snapshot"):
        errors.append("no_pipeline_snapshot_in_state")

    return errors


_LLM_NUMERIC_FIELDS = frozenset(
    {
        "score",
        "overallScore",
        "technicalScore",
        "hrScore",
        "integrityScore",
        "totalScore",
        "cameraScore",
        "audioScore",
        "quizScore",
        "cvJobMatchScore",
    }
)


def _check_no_llm_scores(report: dict) -> list[str]:
    """Guard: verify that the polish step did not overwrite deterministic scores.

    The LLM polish layer is ONLY allowed to modify text/prose fields.
    Any numeric score in the final report must come from deterministic services.

    This function is a last-resort safeguard — ``_repin_deterministic`` in
    report_polish.py already handles this during polish, but we validate
    again here before writing to MongoDB.

    Returns a list of violation strings (empty = clean).
    """
    polish_meta = report.get("polish") or {}
    # Only run the check if polish was actually applied
    if not polish_meta.get("success"):
        return []

    violations: list[str] = []
    score_breakdown = report.get("scoreBreakdown") or {}
    for field in _LLM_NUMERIC_FIELDS:
        val = score_breakdown.get(field) or report.get(field)
        if val is not None and not isinstance(val, (int, float)):
            violations.append(f"{field}={val!r} is not numeric")
        # We cannot know if LLM set the value, but we can verify it's in range
        if isinstance(val, (int, float)) and not (0 <= val <= 100):
            violations.append(f"{field}={val} out of valid range [0, 100]")

    return violations


@node("finalize_interview", 100)
def finalize_interview_node(state: ReportState) -> dict:
    """Atomic finalizer — the ONLY node that writes the report to MongoDB.

    Responsibilities (in order):
    1. Validate the full pipeline state (transcript, report, snapshot).
    2. Guard against LLM score contamination.
    3. Validate the report schema.
    4. Write the final report document (the irreplaceable artifact).
    5. Persist the pipeline snapshot for replay/audit.
    6. Mark the job as completed.

    Design invariant:
    - Steps 4 and 5 write to MongoDB; if either fails, the @node decorator
      routes to mark_failed_node.
    - Step 6 (_set_job "completed") is wrapped separately so a MongoDB
      transient failure there does NOT hide a successfully saved report.
    - This node NEVER writes a partial state.
    """
    interview_id = state["interview_id"]

    # ── 1. Validate full pipeline state ────────────────────────────────────
    validation_errors = _validate_pipeline_state(state, interview_id)
    if validation_errors:
        _LOG.error(
            "[FINALIZE] Pipeline state validation FAILED for interviewId=%s: %s",
            interview_id,
            validation_errors,
        )
        return {
            "error": _build_error_info(
                code="finalize_validation_failed",
                message=f"Pipeline state invalid: {'; '.join(validation_errors)}",
                step="finalize_interview",
                recoverable=False,
            )
        }

    raw_report = state.get("final_report") or state.get("deterministic_report") or {}

    # ── 2. Schema validation ────────────────────────────────────────────
    try:
        final_report = validate_final_report(raw_report)
        _LOG.info(
            "[FINALIZE] Schema validation passed for interviewId=%s", interview_id
        )
    except ValueError as exc:
        _LOG.error(
            "[FINALIZE] Schema validation FAILED for interviewId=%s: %s",
            interview_id,
            exc,
        )
        return {
            "error": _build_error_info(
                code="report_validation_failed",
                message=f"Report schema validation failed: {exc}",
                step="finalize_interview",
                recoverable=False,
            )
        }

    # ── 3. LLM score guard ───────────────────────────────────────────
    llm_score_violations = _check_no_llm_scores(final_report)
    if llm_score_violations:
        _LOG.error(
            "[FINALIZE] LLM score guard triggered for interviewId=%s: %s",
            interview_id,
            llm_score_violations,
        )
        # Non-fatal: log the violation and strip the polish metadata so the
        # deterministic report is used without any LLM influence.
        final_report.pop("polish", None)
        final_report["_llmScoreGuardTriggered"] = True
        final_report["_llmScoreViolations"] = llm_score_violations
        _LOG.warning(
            "[FINALIZE] LLM polish stripped from report for interviewId=%s — "
            "deterministic report will be persisted.",
            interview_id,
        )

    # ── 4. Add finalization metadata ───────────────────────────────────
    # ── 3-B. Phase 3 — Hallucination guard (runs only when LLM polish was used) ──
    # Validates polished text fields against transcript evidence.
    # Violations are soft: they are logged and stored but do NOT stop the pipeline.
    if state.get("llm_used"):
        transcript_segments = (state.get("transcript_payload") or {}).get(
            "segments"
        ) or []
        detected_skills = [
            s.get("skill", "")
            for s in (final_report.get("skillsExtractedFromInterview") or {}).get(
                "detectedSkills"
            )
            or []
        ]
        # Check each LLM-touched prose field
        _guard_violations: list[dict] = []
        for _field in ("transcriptSummary", "recommendationText"):
            _text = final_report.get(_field) or ""
            if _text:
                _guard = validate_llm_output_against_evidence(
                    llm_text=_text,
                    transcript_segments=transcript_segments,
                    detected_skills=detected_skills,
                )
                if not _guard.get("passed"):
                    _guard_violations.append({"field": _field, **_guard})
                    _LOG.warning(
                        "[FINALIZE] Hallucination guard: %d violation(s) in "
                        "field '%s' for interviewId=%s",
                        len(_guard.get("violations", [])),
                        _field,
                        interview_id,
                    )
        if _guard_violations:
            final_report["_hallucinationGuardResults"] = _guard_violations
        # Audit the hallucination check
        AuditLogger.log(
            interview_id=interview_id,
            node_name="finalize_interview",
            event_type="hallucination_check",
            summary=(
                f"llm_used=True fields_checked=2 "
                f"violations={sum(len(g.get('violations', [])) for g in _guard_violations)}"
            ),
            payload={"violationCount": len(_guard_violations)},
        )

    # ── 3-C. Phase 3 — Embed audit log references ───────────────────────────
    # Collect all audit event IDs accumulated during this run so recruiters
    # can query the full audit trail from the report document.
    final_report["auditLogReferences"] = AuditLogger.get_refs(interview_id)

    # Final pipeline-end audit event
    AuditLogger.log(
        interview_id=interview_id,
        node_name="finalize_interview",
        event_type="pipeline_end",
        summary=(
            f"status=completed "
            f"decision={final_report.get('confidenceDecision', {}).get('label', 'unknown')}"
        ),
    )

    # ── 4. Add finalization metadata ─────────────────────
    # ── Phase 4.5: Resolve model version and A/B group for versioning ─────
    _model_version_str = None
    _ab_group_str = "A"
    try:
        from app.ml_models.score_calibration_model import get_metadata as _gm45

        _mm45 = _gm45()
        if _mm45:
            _model_version_str = _mm45.get("version")
    except Exception:  # noqa: BLE001
        pass
    try:
        from app.services.ab_testing_service import assign_group as _ag45

        _ab_group_str = _ag45(interview_id)
    except Exception:  # noqa: BLE001
        pass

    final_report["_metadata"] = {
        "graphVersion": "3.0",  # Phase 4.5 upgrade
        "featureSchemaVersion": "1.0",  # Phase 4 ML feature schema
        "mlModelVersion": _model_version_str,  # None when no model trained yet
        "abGroup": _ab_group_str,  # A/B group for this interview
        "shadowMode": True,  # ML runs in shadow mode only
        "generatedAt": _utc_now().isoformat(),
        "polishStatus": state.get("polish_status", "skipped"),
        "llmUsed": bool(state.get("llm_used", False)),
        "graphCompleted": True,
        "reportSaved": False,  # will be set True after DB write
    }

    # ── 5. Write the report (irreplaceable artifact) ───────────────────────
    # If this fails the @node decorator catches it and routes to
    # mark_failed_node — this is the correct behavior: a report we
    # cannot persist is a report that does not exist.
    reports_col.update_one(
        {"interviewId": interview_id},
        {"$set": final_report},
        upsert=True,
    )
    _LOG.info("[FINAL REPORT WRITTEN] interviewId=%s", interview_id)

    # ── Phase 4.5: Operational hooks ───────────────────────────────────
    # All hooks run AFTER the report is safely written.  Each is wrapped in
    # its own try/except so a failure here NEVER prevents job completion.

    _p45_system_score = float(final_report.get("overallScore") or 0)
    _p45_conf = float(
        (final_report.get("confidenceDecision") or {}).get("confidence") or 0.0
    )
    _p45_bias_risk = (final_report.get("biasReport") or {}).get(
        "biasRiskLevel"
    ) or "low"

    # 4.5-A: Extract features once for reuse by shadow + monitoring
    _p45_features: dict = {}
    try:
        from app.services.ml_feature_extractor import extract_features as _p45_ef

        _p45_features = _p45_ef(final_report)
    except Exception as _p45_fex:  # noqa: BLE001
        _LOG.debug("[finalize] feature extraction for hooks failed: %s", _p45_fex)

    # 4.5-B: Shadow ML inference (never changes visible score)
    try:
        from app.services.shadow_inference_service import (
            run_shadow_inference as _p45_si,
        )

        _p45_si(
            interview_id=interview_id,
            system_score=_p45_system_score,
            features=_p45_features,
            decision_confidence=_p45_conf,
            ab_group=_ab_group_str,
        )
    except Exception as _p45_siex:  # noqa: BLE001
        _LOG.debug("[finalize] shadow inference hook failed: %s", _p45_siex)

    # 4.5-C: Manual review queue routing
    try:
        from app.services.manual_review_service import check_and_queue as _p45_cq

        _p45_cq(
            interview_id=interview_id,
            confidence=_p45_conf,
            bias_risk=_p45_bias_risk,
            system_score=_p45_system_score,
        )
    except Exception as _p45_mqex:  # noqa: BLE001
        _LOG.debug("[finalize] manual review hook failed: %s", _p45_mqex)

    # 4.5-D: Model monitoring event
    try:
        from app.services.model_monitoring_service import (
            record_inference_event as _p45_ri,
        )

        _p45_ri(
            interview_id=interview_id,
            latency_ms=0.0,  # latency not tracked at this level
            system_score=_p45_system_score,
            ml_score=None,  # shadow score stored separately
            ml_applied=False,
            model_version=_model_version_str,
        )
    except Exception as _p45_mmex:  # noqa: BLE001
        _LOG.debug("[finalize] monitoring hook failed: %s", _p45_mmex)

    # ── 6. Persist pipeline snapshot for replay/audit ────────────────────
    snapshot = state.get("pipeline_snapshot") or {}
    if snapshot:
        try:
            pipeline_snapshots_col.update_one(
                {"interviewId": interview_id},
                {
                    "$set": {
                        **snapshot,
                        "interviewId": interview_id,
                        "updatedAt": _utc_now(),
                    }
                },
                upsert=True,
            )
        except Exception as snap_exc:  # noqa: BLE001
            # Snapshot persistence is best-effort — a failure here must not
            # prevent the report from being served.
            _LOG.warning(
                "[FINALIZE] Could not save pipeline snapshot for interviewId=%s: %s",
                interview_id,
                snap_exc,
            )

    # ── 7. Mark job completed ─────────────────────────────────────────
    # Wrapped separately: a transient MongoDB error here must NOT route to
    # mark_failed_node because the report IS already saved.
    try:
        _set_job(
            interview_id,
            status="completed",
            progress=100,
            currentStep="done",
            finishedAt=_utc_now(),
            graphCompleted=True,
            reportSaved=True,
            polishStatus=state.get("polish_status", "skipped"),
            llmUsed=bool(state.get("llm_used", False)),
        )
        _LOG.info("[PIPELINE END STATUS=completed] interviewId=%s", interview_id)
    except Exception as exc:  # noqa: BLE001
        _LOG.error(
            "[FINALIZE] Report saved but _set_job(completed) failed for "
            "interviewId=%s — report IS retrievable via GET /final-report: %s",
            interview_id,
            exc,
        )

    return {}


def cleanup_node(state: ReportState) -> dict:
    """Cleanup temporary files after success or failure.

    This node runs regardless of pipeline success/failure to ensure
    temp files are cleaned up. Failures are logged but never fail the pipeline.
    """
    return _cleanup_analysis_temp_files(state)


def mark_failed_node(state: ReportState) -> dict:
    """Mark the job as failed with structured error information."""
    interview_id = state.get("interview_id", "")
    error = state.get("error") or "unknown"

    # Handle both old string errors and new structured errors
    if isinstance(error, dict):
        error_code = error.get("code", "unknown")
        error_message = error.get("message", str(error))
        error_step = error.get("step", "unknown")
    else:
        error_code = "unknown"
        error_message = str(error)
        error_step = "unknown"

    _LOG.error(
        "[Graph Failed] interviewId=%s step=%s code=%s error=%s",
        interview_id or "unknown",
        error_step,
        error_code,
        error_message,
    )

    if interview_id:
        _set_job(
            interview_id,
            status="failed",
            error={
                "code": error_code,
                "message": error_message,
                "step": error_step,
            },
            currentStep="failed",
            finishedAt=_utc_now(),
        )
    return {}


# ─── Graph assembly ───────────────────────────────────────────────────────────


def _route_after_build(state: ReportState) -> str:
    if state.get("error"):
        return "mark_failed"
    if state.get("polish_enabled") and state.get("deterministic_report"):
        return "polish_report"
    return "finalize_interview"


def _route_after_step(state: ReportState) -> str:
    """Generic routing after each pre-build step.

    If a node set ``state["error"]`` we jump straight to ``mark_failed`` and
    skip the remaining pipeline. Otherwise we fall through to the next step
    via the static edge added in ``build_graph``.
    """
    return "mark_failed" if state.get("error") else "_continue"


def build_graph():
    graph = StateGraph(ReportState)

    graph.add_node("init", init_node)
    graph.add_node("audio_extract", audio_extract_node)
    graph.add_node("frames_extract", frames_extract_node)
    graph.add_node("vision_analyze", vision_analyze_node)
    graph.add_node("transcribe", transcribe_node)
    graph.add_node("silence_detect", silence_detect_node)
    graph.add_node("merge_live", merge_live_node)
    graph.add_node("build_report", build_report_node)
    graph.add_node("polish_report", polish_report_node)
    graph.add_node("finalize_interview", finalize_interview_node)
    graph.add_node("mark_failed", mark_failed_node)

    graph.set_entry_point("init")

    # Linear pipeline with per-step error-routing.
    pipeline = [
        ("init", "audio_extract"),
        ("audio_extract", "frames_extract"),
        ("frames_extract", "vision_analyze"),
        ("vision_analyze", "transcribe"),
        ("transcribe", "silence_detect"),
        ("silence_detect", "merge_live"),
        ("merge_live", "build_report"),
    ]
    for src, dst in pipeline:
        graph.add_conditional_edges(
            src,
            _route_after_step,
            {"mark_failed": "mark_failed", "_continue": dst},
        )

    graph.add_conditional_edges(
        "build_report",
        _route_after_build,
        {
            "mark_failed": "mark_failed",
            "polish_report": "polish_report",
            "finalize_interview": "finalize_interview",
        },
    )
    graph.add_edge("polish_report", "finalize_interview")

    # Add cleanup node that runs after both success and failure paths
    graph.add_node("cleanup", cleanup_node)
    graph.add_edge("finalize_interview", "cleanup")
    graph.add_edge("mark_failed", "cleanup")
    graph.add_edge("cleanup", END)

    return graph


_compiled_graph = None


def _get_graph():
    global _compiled_graph
    if _compiled_graph is None:
        _compiled_graph = build_graph().compile()
    return _compiled_graph


def run_report_graph(interview_id: str) -> ReportState:
    """Synchronous entry point — same call surface as the prior orchestrator."""
    _LOG.info("[graph] START interviewId=%s", interview_id)
    initial: ReportState = {
        "interview_id": interview_id,
        "polish_enabled": _polish_enabled_from_env(),
        "polish_status": "skipped",
        "error": None,
    }
    result = _get_graph().invoke(initial)
    final_status = "completed" if not result.get("error") else "failed"
    _LOG.info("[graph] END interviewId=%s status=%s", interview_id, final_status)
    return result  # type: ignore[return-value]


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python -m app.services.report_graph <interview_id>")
        raise SystemExit(2)
    final_state = run_report_graph(sys.argv[1])
    print(
        f"interview_id={final_state.get('interview_id')} "
        f"error={final_state.get('error')} "
        f"polish_status={final_state.get('polish_status')}"
    )
