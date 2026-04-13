from dataclasses import dataclass


@dataclass
class VoiceEngineConfig:
    sample_rate: int = 16000
    channels: int = 1

    vad_threshold: float = 0.35
    min_speech_ms: int = 180
    min_silence_ms: int = 700
    speech_pad_ms: int = 220

    whisper_model: str = "small"
    whisper_device: str = "cpu"
    whisper_compute_type: str = "int8"
    language: str | None = "en"

    hf_token: str = ""
    enable_diarization: bool = False
    single_speaker_label: str = "CANDIDATE"
    max_speakers: int = 2
    min_speakers: int = 2