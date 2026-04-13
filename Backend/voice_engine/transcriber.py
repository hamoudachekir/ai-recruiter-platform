from __future__ import annotations

from dataclasses import dataclass
from typing import List

import numpy as np
from faster_whisper import WhisperModel

from .config import VoiceEngineConfig
from .vad import SpeechSegment


@dataclass
class Transcript:
    text: str
    start_ms: float
    end_ms: float
    language: str | None
    confidence: float
    words: List[dict]


class FasterWhisperTranscriber:
    def __init__(self, config: VoiceEngineConfig):
        self.config = config
        self.model = WhisperModel(
            config.whisper_model,
            device=config.whisper_device,
            compute_type=config.whisper_compute_type,
        )

    def transcribe_segment(self, segment: SpeechSegment) -> Transcript:
        segments, info = self.model.transcribe(
            segment.audio,
            language=self.config.language,
            beam_size=5,
            word_timestamps=True,
            vad_filter=False,
        )

        texts: List[str] = []
        words: List[dict] = []
        avg_logprob = 0.0
        count = 0

        for seg in segments:
            if seg.text:
                texts.append(seg.text.strip())
            avg_logprob += getattr(seg, "avg_logprob", 0.0)
            count += 1

            if seg.words:
                for word in seg.words:
                    words.append(
                        {
                            "word": word.word,
                            "start_ms": segment.start_ms + word.start * 1000.0,
                            "end_ms": segment.start_ms + word.end * 1000.0,
                            "probability": word.probability,
                        }
                    )

        return Transcript(
            text=" ".join(texts).strip(),
            start_ms=segment.start_ms,
            end_ms=segment.end_ms,
            language=getattr(info, "language", None),
            confidence=avg_logprob / max(count, 1),
            words=words,
        )

    def transcribe_full(self, audio: np.ndarray) -> List[Transcript]:
        segments, info = self.model.transcribe(
            audio,
            language=self.config.language,
            beam_size=5,
            word_timestamps=True,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": self.config.min_silence_ms},
        )

        results: List[Transcript] = []

        for seg in segments:
            words: List[dict] = []
            if seg.words:
                for word in seg.words:
                    words.append(
                        {
                            "word": word.word,
                            "start_ms": word.start * 1000.0,
                            "end_ms": word.end * 1000.0,
                            "probability": word.probability,
                        }
                    )

            results.append(
                Transcript(
                    text=seg.text.strip(),
                    start_ms=seg.start * 1000.0,
                    end_ms=seg.end * 1000.0,
                    language=getattr(info, "language", None),
                    confidence=getattr(seg, "avg_logprob", 0.0),
                    words=words,
                )
            )

        return results
