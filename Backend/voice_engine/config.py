from dataclasses import dataclass


@dataclass
class VoiceEngineConfig:
    # --- Key tuning parameters ---
    # vad_threshold          : Silero VAD confidence gate. Higher = less sensitive to background
    #                          noise (keyboard clicks, breathing). Range 0.0–1.0.
    # min_speech_ms          : Minimum continuous speech required to open a segment.
    #                          Whisper's reliable lower bound is ~250 ms; stay above it.
    # min_silence_ms         : Silence gap needed to close an open segment.
    # min_segment_confidence : avg_logprob cut-off for transcribed segments (value is ≤ 0.0;
    #                          0.0 = perfect confidence). Segments below this are flagged
    #                          low_confidence=True on the resulting Transcript object.

    sample_rate: int = 16000
    channels: int = 1

    vad_threshold: float = 0.45
    min_speech_ms: int = 300
    min_silence_ms: int = 700
    speech_pad_ms: int = 220

    whisper_model: str = "small"
    whisper_device: str = "cpu"
    whisper_compute_type: str = "int8"
    language: str | None = "en"
    min_segment_confidence: float = -1.2

    hf_token: str = ""
    enable_diarization: bool = False
    single_speaker_label: str = "CANDIDATE"
    max_speakers: int = 2
    min_speakers: int = 2
