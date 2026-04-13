"""Voice engine package for interview audio processing."""

from .config import VoiceEngineConfig
from .pipeline import TurnResult, VoicePipeline
from .transcriber import FasterWhisperTranscriber, Transcript
from .vad import SileroVAD, SpeechSegment

DiarizedSegment = None
PyannoteDiarizer = None


def __getattr__(name):
    if name in {"DiarizedSegment", "PyannoteDiarizer"}:
        try:
            from .diarizer import DiarizedSegment as _DiarizedSegment, PyannoteDiarizer as _PyannoteDiarizer
        except ModuleNotFoundError:
            return None

        globals()["DiarizedSegment"] = _DiarizedSegment
        globals()["PyannoteDiarizer"] = _PyannoteDiarizer
        return globals()[name]

    raise AttributeError(f"module 'voice_engine' has no attribute '{name}'")

__all__ = [
    "VoiceEngineConfig",
    "SpeechSegment",
    "SileroVAD",
    "Transcript",
    "FasterWhisperTranscriber",
    "DiarizedSegment",
    "PyannoteDiarizer",
    "TurnResult",
    "VoicePipeline",
]