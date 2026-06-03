"""Speech-to-Text service with fallback telemetry.

When Faster-Whisper is unavailable, returns clear fallback telemetry
so the report accurately reflects that transcription was not performed.
"""

import concurrent.futures
import logging
import os
from pathlib import Path

_LOGGER = logging.getLogger(__name__)

_LOW_CONFIDENCE_LOGPROB_THRESHOLD = -1.2  # segments below this are unreliable
_MIN_WORDS_FOR_VALID_TRANSCRIPT = 20  # fewer words = not a real interview
_MIN_SEGMENTS_FOR_VALID_TRANSCRIPT = 2  # single segment = suspicious

# Maximum seconds to wait for Whisper transcription before giving up.
# Covers both model download (first run) and actual transcription time.
# Override via STT_TIMEOUT_SECONDS env var.
_TRANSCRIPTION_TIMEOUT_SECONDS = int(os.getenv("STT_TIMEOUT_SECONDS", "300"))


def _compute_transcript_quality(
    segments: list,
    full_text: str,
    language: str | None,
    language_probability: float,
) -> dict:
    """Compute quality metrics for a transcript.

    Returns a dict with:
    - qualityGrade: "PASS", "WARN", or "FAIL"
    - qualityScore: 0-100
    - qualityFlags: list of string issues found
    - wordCount: int
    - segmentCount: int
    - avgConfidence: float (average avg_logprob across segments, 0.0 if none)
    - languageProbability: float
    """
    word_count = len(full_text.split()) if full_text else 0
    segment_count = len(segments)
    avg_confidence = sum(s.get("avgLogprob", 0.0) for s in segments) / max(
        segment_count, 1
    )

    quality_flags = []
    quality_score = 100

    if word_count == 0:
        quality_flags.append("empty_transcript")
        quality_score -= 60
    elif word_count < _MIN_WORDS_FOR_VALID_TRANSCRIPT:
        quality_flags.append("too_short")
        quality_score -= 30

    if segment_count < _MIN_SEGMENTS_FOR_VALID_TRANSCRIPT:
        quality_flags.append("too_few_segments")
        quality_score -= 20

    if avg_confidence < _LOW_CONFIDENCE_LOGPROB_THRESHOLD:
        quality_flags.append("low_avg_confidence")
        quality_score -= 20

    if language_probability < 0.7 and language_probability > 0.0:
        quality_flags.append("uncertain_language")
        quality_score -= 10

    low_conf_count = sum(1 for s in segments if s.get("lowConfidence", False))
    if segment_count > 0 and low_conf_count / segment_count > 0.5:
        quality_flags.append("majority_low_confidence")
        quality_score -= 15

    quality_score = max(0, quality_score)

    if quality_score >= 70:
        quality_grade = "PASS"
    elif quality_score >= 40:
        quality_grade = "WARN"
    else:
        quality_grade = "FAIL"

    return {
        "qualityGrade": quality_grade,
        "qualityScore": quality_score,
        "qualityFlags": quality_flags,
        "wordCount": word_count,
        "segmentCount": segment_count,
        "avgConfidence": avg_confidence,
        "languageProbability": language_probability,
    }


def transcribe_audio(
    audio_path: Path, model_name: str, device: str, compute_type: str
) -> dict:
    """Transcribe audio using Faster-Whisper with fallback handling.

    Returns:
        dict with transcription data or fallback telemetry if unavailable.
    """
    try:
        from faster_whisper import WhisperModel
    except ImportError as e:
        _LOGGER.warning(
            "[STT] Faster-Whisper unavailable: %s. Returning fallback telemetry.", e
        )
        return {
            "transcriptionAvailable": False,
            "sttFallback": True,
            "sttFallbackReason": "faster_whisper_unavailable",
            "language": None,
            "segments": [],
            "fullText": "",
            "error": "faster-whisper unavailable",
            "transcriptQuality": {
                "qualityGrade": "FAIL",
                "qualityScore": 0,
                "qualityFlags": ["stt_unavailable"],
                "wordCount": 0,
                "segmentCount": 0,
                "avgConfidence": 0.0,
                "languageProbability": 0.0,
            },
        }
    except Exception as e:
        _LOGGER.error(
            "[STT] Unexpected error loading Faster-Whisper: %s. Returning fallback telemetry.",
            e,
        )
        return {
            "transcriptionAvailable": False,
            "sttFallback": True,
            "sttFallbackReason": "stt_service_error",
            "sttErrorDetails": str(e),
            "language": None,
            "segments": [],
            "fullText": "",
            "error": f"stt service error: {e}",
            "transcriptQuality": {
                "qualityGrade": "FAIL",
                "qualityScore": 0,
                "qualityFlags": ["stt_unavailable"],
                "wordCount": 0,
                "segmentCount": 0,
                "avgConfidence": 0.0,
                "languageProbability": 0.0,
            },
        }

    try:
        # Load the model AND transcribe inside the timed thread. Model
        # construction can itself block (first-run download from HuggingFace,
        # CUDA init), so keeping it inside the hard timeout prevents the
        # background task from hanging indefinitely at progress=65%.
        def _run_transcribe():
            model = WhisperModel(model_name, device=device, compute_type=compute_type)
            return model.transcribe(
                str(audio_path),
                vad_filter=True,
                word_timestamps=True,
            )

        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as _executor:
                _future = _executor.submit(_run_transcribe)
                segs, info = _future.result(timeout=_TRANSCRIPTION_TIMEOUT_SECONDS)
        except concurrent.futures.TimeoutError:
            _LOGGER.error(
                "[STT] Transcription timed out after %d seconds for %s",
                _TRANSCRIPTION_TIMEOUT_SECONDS,
                audio_path,
            )
            return {
                "transcriptionAvailable": False,
                "sttFallback": True,
                "sttFallbackReason": "transcription_timeout",
                "language": None,
                "languageProbability": 0.0,
                "segments": [],
                "fullText": "",
                "error": (
                    f"Transcription timed out after {_TRANSCRIPTION_TIMEOUT_SECONDS}s. "
                    "Check WHISPER_MODEL size and STT_TIMEOUT_SECONDS env var."
                ),
                "transcriptQuality": {
                    "qualityGrade": "FAIL",
                    "qualityScore": 0,
                    "qualityFlags": ["transcription_timeout"],
                    "wordCount": 0,
                    "segmentCount": 0,
                    "avgConfidence": 0.0,
                    "languageProbability": 0.0,
                },
            }

        segments = []
        texts = []
        for seg in segs:
            text = (seg.text or "").strip()
            if not text:
                continue
            segments.append(
                {
                    "start": float(seg.start),
                    "end": float(seg.end),
                    "text": text,
                    # "UNKNOWN" is a sentinel value — no diarization is performed
                    # in this path; use uppercase to distinguish from a real speaker label
                    "speaker": "UNKNOWN",
                    "avgLogprob": float(getattr(seg, "avg_logprob", 0.0)),
                    "lowConfidence": float(getattr(seg, "avg_logprob", 0.0))
                    < _LOW_CONFIDENCE_LOGPROB_THRESHOLD,
                }
            )
            texts.append(text)

        full_text = " ".join(texts).strip()

        language_probability = float(getattr(info, "language_probability", 0.0))
        transcript_quality = _compute_transcript_quality(
            segments=segments,
            full_text=full_text,
            language=getattr(info, "language", None),
            language_probability=language_probability,
        )

        _LOGGER.info(
            "[STT] Transcription successful: %d segments, %d words",
            len(segments),
            len(full_text.split()) if full_text else 0,
        )
        _LOGGER.info(
            "[STT] Quality assessment: grade=%s score=%d flags=%s",
            transcript_quality["qualityGrade"],
            transcript_quality["qualityScore"],
            transcript_quality["qualityFlags"],
        )

        return {
            "transcriptionAvailable": True,
            "sttFallback": False,
            "language": getattr(info, "language", None),
            "languageProbability": language_probability,
            "segments": segments,
            "fullText": full_text,
            "transcriptQuality": transcript_quality,
            "error": None,
        }

    except Exception as e:
        _LOGGER.error(
            "[STT] Transcription failed: %s. Returning fallback telemetry.", e
        )
        return {
            "transcriptionAvailable": False,
            "sttFallback": True,
            "sttFallbackReason": "transcription_failed",
            "sttErrorDetails": str(e),
            "language": None,
            "segments": [],
            "fullText": "",
            "error": f"transcription failed: {e}",
            "transcriptQuality": {
                "qualityGrade": "FAIL",
                "qualityScore": 0,
                "qualityFlags": ["stt_unavailable"],
                "wordCount": 0,
                "segmentCount": 0,
                "avgConfidence": 0.0,
                "languageProbability": 0.0,
            },
        }
