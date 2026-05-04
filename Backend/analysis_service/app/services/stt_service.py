from pathlib import Path


def transcribe_audio(audio_path: Path, model_name: str, device: str, compute_type: str) -> dict:
    try:
        from faster_whisper import WhisperModel
    except Exception:
        return {
            "transcriptionAvailable": False,
            "language": None,
            "segments": [],
            "fullText": "",
            "error": "faster-whisper unavailable",
        }

    model = WhisperModel(model_name, device=device, compute_type=compute_type)
    segs, info = model.transcribe(str(audio_path), vad_filter=True)

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
                "speaker": "unknown",
            }
        )
        texts.append(text)

    return {
        "transcriptionAvailable": True,
        "language": getattr(info, "language", None),
        "segments": segments,
        "fullText": " ".join(texts).strip(),
        "error": None,
    }
