from __future__ import annotations

import re
import warnings
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Dict, List

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
    diarization_used: bool = False  # NEW
    speaker_count: int = 1  # NEW


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
        skipped = 0
        for segment in speech_segments:
            transcript = self.transcriber.transcribe_segment(segment)
            if transcript.text:
                if transcript.low_confidence and len(transcript.text.split()) < 4:
                    skipped += 1
                    continue
                transcripts.append(transcript)

        if skipped:
            warnings.warn(
                f"Skipped {skipped} low-confidence transcript(s) with fewer than 4 words.",
                RuntimeWarning,
            )

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

        diarization_used = bool(diarized)
        speaker_count = len({seg.speaker for seg in diarized}) if diarized else 1

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
                    diarization_used=diarization_used,
                    speaker_count=speaker_count,
                )
            )

        return self._map_speaker_labels(results)

    def _silence_before(self, start_ms: float, silence_gaps: List[dict]) -> float:
        for gap in silence_gaps:
            if 0 <= start_ms - gap["end_ms"] <= 250:
                return float(gap["duration_ms"])
        return 0.0

    @staticmethod
    def _map_speaker_labels(results: List[TurnResult]) -> List[TurnResult]:
        """Remap raw pyannote SPEAKER_XX labels to RECRUITER/CANDIDATE.

        Heuristic:
        - All labels already human-readable  → return as-is
        - 1 unique speaker detected          → return as-is (no remapping)
        - 3+ unique speakers detected        → return as-is (unusual setup)
        - Exactly 2 speakers                 → least total duration → RECRUITER,
                                               most total duration  → CANDIDATE
        """
        _raw = re.compile(r"^SPEAKER_\d+$")

        # Nothing to do if no raw labels are present
        if not any(_raw.match(turn.speaker) for turn in results):
            return results

        # Aggregate speaking duration per speaker
        durations: Dict[str, float] = {}
        for turn in results:
            dur = turn.end_ms - turn.start_ms
            durations[turn.speaker] = durations.get(turn.speaker, 0.0) + dur

        unique_speakers = list(durations.keys())

        # Only remap when there are exactly 2 distinct speakers
        if len(unique_speakers) != 2:
            return results

        sorted_speakers = sorted(unique_speakers, key=lambda s: durations[s])
        label_map: Dict[str, str] = {
            sorted_speakers[0]: "RECRUITER",  # least duration → asks questions
            sorted_speakers[1]: "CANDIDATE",  # most duration  → gives answers
        }

        for turn in results:
            turn.speaker = label_map.get(turn.speaker, turn.speaker)

        return results

    @staticmethod
    def _overlap_ms(a1: float, a2: float, b1: float, b2: float) -> float:
        return max(0.0, min(a2, b2) - max(a1, b1))
