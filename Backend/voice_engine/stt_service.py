from __future__ import annotations

from dataclasses import asdict
from pathlib import Path
from typing import Any
import re

from .audio_utils import prepare_audio_file
from .config import VoiceEngineConfig
from .pipeline import VoicePipeline


def _build_summary_text(transcript_text: str, language: str | None = None) -> str:
    text = " ".join(str(transcript_text or "").split()).strip()
    if not text:
        return ""

    parts = [segment.strip() for segment in re.split(r'(?<=[.!?])\s+', text) if segment.strip()]
    if len(parts) <= 2:
        return text

    selected = [parts[0], parts[len(parts) // 2], parts[-1]]
    deduped: list[str] = []
    seen: set[str] = set()
    for item in selected:
        lowered = item.lower()
        if lowered not in seen:
            seen.add(lowered)
            deduped.append(item)

    summary_core = " ".join(deduped[:3]).strip()
    if not summary_core:
        return ""

    if str(language or "").lower().startswith("fr"):
        return f"Resume: {summary_core}"
    return f"Summary: {summary_core}"


def _normalize_language(value: Any) -> str | None:
    language = str(value or "").strip().lower()
    if not language:
        return "fr"
    if language == "auto":
        return None
    return language


def _normalize_model(value: Any) -> str:
    model = str(value or "").strip().lower()
    return model or "small"


def _normalize_overrides(overrides: dict[str, Any] | None = None) -> dict[str, Any]:
    data = dict(overrides or {})
    return {
        "sample_rate": int(data.get("sampleRate") or data.get("sample_rate") or 16000),
        "channels": int(data.get("channels") or 1),
        "vad_threshold": float(data.get("vadThreshold") or data.get("vad_threshold") or 0.35),
        "min_speech_ms": int(data.get("minSpeechMs") or data.get("min_speech_ms") or 180),
        "min_silence_ms": int(data.get("minSilenceMs") or data.get("min_silence_ms") or 700),
        "speech_pad_ms": int(data.get("speechPadMs") or data.get("speech_pad_ms") or 220),
        "whisper_model": _normalize_model(data.get("whisperModel") or data.get("whisper_model")),
        "whisper_device": str(data.get("whisperDevice") or data.get("whisper_device") or "cpu"),
        "whisper_compute_type": str(data.get("whisperComputeType") or data.get("whisper_compute_type") or "int8"),
        "language": _normalize_language(data.get("language")),
        "hf_token": str(data.get("hfToken") or data.get("hf_token") or ""),
        "enable_diarization": bool(data.get("enableDiarization") or data.get("enable_diarization") or False),
        "single_speaker_label": str(data.get("singleSpeakerLabel") or data.get("single_speaker_label") or "CANDIDATE"),
        "max_speakers": int(data.get("maxSpeakers") or data.get("max_speakers") or 2),
        "min_speakers": int(data.get("minSpeakers") or data.get("min_speakers") or 2),
    }


def _build_config(overrides: dict[str, Any] | None = None) -> VoiceEngineConfig:
    normalized = _normalize_overrides(overrides)
    return VoiceEngineConfig(
        sample_rate=normalized["sample_rate"],
        channels=normalized["channels"],
        vad_threshold=normalized["vad_threshold"],
        min_speech_ms=normalized["min_speech_ms"],
        min_silence_ms=normalized["min_silence_ms"],
        speech_pad_ms=normalized["speech_pad_ms"],
        whisper_model=normalized["whisper_model"],
        whisper_device=normalized["whisper_device"],
        whisper_compute_type=normalized["whisper_compute_type"],
        language=normalized["language"],
        hf_token=normalized["hf_token"],
        enable_diarization=normalized["enable_diarization"],
        single_speaker_label=normalized["single_speaker_label"],
        max_speakers=normalized["max_speakers"],
        min_speakers=normalized["min_speakers"],
    )


def _build_segments(turns: list[Any]) -> list[dict[str, Any]]:
    segments: list[dict[str, Any]] = []
    for turn in turns:
        payload = asdict(turn) if hasattr(turn, "__dataclass_fields__") else dict(turn)
        segments.append(
            {
                "speaker": payload.get("speaker"),
                "start_ms": payload.get("start_ms", 0.0),
                "end_ms": payload.get("end_ms", 0.0),
                "text": payload.get("text", ""),
                "language": payload.get("language"),
                "words": payload.get("words", []),
                "silence_before_ms": payload.get("silence_before_ms", 0.0),
            }
        )
    return segments


def transcribe_file(audio_path: str | Path, overrides: dict[str, Any] | None = None, save_dir: str | Path | None = None) -> dict[str, Any]:
    normalized_config = _build_config(overrides)
    normalized_audio_path, should_cleanup = prepare_audio_file(
        audio_path,
        target_sample_rate=normalized_config.sample_rate,
        target_channels=normalized_config.channels,
    )

    try:
        pipeline = VoicePipeline(normalized_config)
        turns = pipeline.process(normalized_audio_path)
        segments = _build_segments(turns)
        transcript_text = "\n".join(
            f"{segment.get('speaker', 'Unknown')}: {segment['text'].strip()}"
            for segment in segments
            if segment.get("text")
        ).strip()
        detected_language = next(
            (segment.get("language") for segment in segments if segment.get("language")),
            normalized_config.language or "fr",
        )
        summary_text = _build_summary_text(transcript_text, detected_language)

        saved_files = {}
        if save_dir:
            from datetime import datetime
            import shutil
            
            save_path = Path(save_dir)
            save_path.mkdir(parents=True, exist_ok=True)
            base_name = f"Entretien_Live_Test_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
            
            wav_path = save_path / f"{base_name}.wav"
            shutil.copy2(normalized_audio_path, wav_path)
            saved_files['wav'] = str(wav_path)
            
            txt_path = save_path / f"{base_name}_transcription.txt"
            txt_path.write_text(transcript_text, encoding='utf-8')
            saved_files['txt'] = str(txt_path)
            
            try:
                from fpdf import FPDF
                pdf = FPDF()
                pdf.add_page()
                pdf.set_auto_page_break(bMargin=15)
                pdf.set_font('Arial', '', 12)
                
                # Header
                pdf.set_font_size(16)
                pdf.cell(0, 10, f"COMPTE-RENDU D'ENTRETIEN - {base_name}", 0, 1, 'C')
                pdf.ln(10)

                if summary_text:
                    pdf.set_font_size(14)
                    pdf.cell(0, 8, "SYNTHESIS", 0, 1)
                    pdf.set_font_size(10)
                    pdf.multi_cell(0, 5, summary_text.encode('latin-1', 'replace').decode('latin-1'))
                    pdf.ln(8)
                
                # Dialogue
                pdf.set_font_size(10)
                for line in transcript_text.split('\n'):
                    pdf.multi_cell(0, 5, line.encode('latin-1', 'replace').decode('latin-1'))
                    pdf.ln(2)
                
                pdf_path = save_path / f"{base_name}.pdf"
                pdf.output(str(pdf_path))
                saved_files['pdf'] = str(pdf_path)
            except Exception as e:
                saved_files['pdf_error'] = str(e)

        return {
            "ok": True,
            "status": "ok",
            "audio_path": str(audio_path),
            "normalized_audio_path": normalized_audio_path,
            "language": detected_language,
            "text": transcript_text,
            "turn_count": len(turns),
            "turns": [asdict(turn) for turn in turns],
            "segments": segments,
            "summary": summary_text,
            "saved_files": saved_files,
        }
    finally:
        if should_cleanup:
            Path(normalized_audio_path).unlink(missing_ok=True)