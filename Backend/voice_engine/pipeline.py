from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import List, TYPE_CHECKING
import warnings

import numpy as np

from .config import VoiceEngineConfig
from .transcriber import FasterWhisperTranscriber, Transcript
from .utils import load_audio
from .vad import SileroVAD

if TYPE_CHECKING:
    from .diarizer import DiarizedSegment


@dataclass
class TurnResult:
    speaker: str
    start_ms: float
    end_ms: float
    text: str
    language: str | None = None
    words: List[dict] = field(default_factory=list)
    silence_before_ms: float = 0.0


class VoicePipeline:
    def __init__(self, config: VoiceEngineConfig):
        self.config = config
        self.vad = SileroVAD(config)
        self.transcriber = FasterWhisperTranscriber(config)
        self.diarizer = None
        if config.enable_diarization and config.hf_token:
            try:
                from .diarizer import PyannoteDiarizer

                self.diarizer = PyannoteDiarizer(config)
            except ModuleNotFoundError as error:
                warnings.warn(
                    f"Diarization disabled: {error}",
                    RuntimeWarning,
                )
            except Exception as error:
                warnings.warn(
                    f"Diarization disabled: {error}",
                    RuntimeWarning,
                )

    def process(self, audio_path: str | Path) -> List[TurnResult]:
        audio = load_audio(audio_path, self.config.sample_rate)
        return self.process_audio(audio)

    def process_audio(self, audio: np.ndarray) -> List[TurnResult]:
        speech_segments = self.vad.detect(audio)
        silence_gaps = self.vad.get_silence_gaps(audio)

        transcripts: List[Transcript] = []
        for segment in speech_segments:
            transcript = self.transcriber.transcribe_segment(segment)
            if transcript.text:
                transcripts.append(transcript)

        diarized = self.diarizer.diarize(audio) if self.diarizer else []
        return self._merge(transcripts, diarized, silence_gaps)

    def _merge(
        self,
        transcripts: List[Transcript],
        diarized: List["DiarizedSegment"],
        silence_gaps: List[dict],
    ) -> List[TurnResult]:
        results: List[TurnResult] = []
        default_speaker = (
            getattr(getattr(self, "config", None), "single_speaker_label", "CANDIDATE")
            or "CANDIDATE"
        )

        for transcript in transcripts:
            best_speaker = default_speaker
            best_overlap = 0.0

            for segment in diarized:
                overlap = self._overlap_ms(
                    transcript.start_ms,
                    transcript.end_ms,
                    segment.start_ms,
                    segment.end_ms,
                )
                if overlap > best_overlap:
                    best_overlap = overlap
                    best_speaker = segment.speaker

            silence_before = self._silence_before(transcript.start_ms, silence_gaps)

            results.append(
                TurnResult(
                    speaker=best_speaker,
                    start_ms=transcript.start_ms,
                    end_ms=transcript.end_ms,
                    text=transcript.text,
                    language=transcript.language,
                    words=transcript.words,
                    silence_before_ms=silence_before,
                )
            )

        return results

    def _silence_before(self, start_ms: float, silence_gaps: List[dict]) -> float:
        for gap in silence_gaps:
            if 0 <= start_ms - gap["end_ms"] <= 250:
                return float(gap["duration_ms"])
        return 0.0

    @staticmethod
    def _overlap_ms(a1: float, a2: float, b1: float, b2: float) -> float:
        return max(0.0, min(a2, b2) - max(a1, b1))
