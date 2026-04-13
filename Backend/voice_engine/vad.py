from __future__ import annotations

from dataclasses import dataclass
from typing import List

import numpy as np
import torch

from .config import VoiceEngineConfig
from .utils import numpy_to_tensor, samples_to_ms


@dataclass
class SpeechSegment:
    start_ms: float
    end_ms: float
    start_sample: int
    end_sample: int
    audio: np.ndarray


class SileroVAD:
    def __init__(self, config: VoiceEngineConfig):
        self.config = config
        self.model, self.utils = torch.hub.load(
            repo_or_dir="snakers4/silero-vad",
            model="silero_vad",
            force_reload=False,
            trust_repo=True,
        )
        self.model.eval()
        self.get_speech_timestamps = self.utils[0]

    def detect(self, audio: np.ndarray) -> List[SpeechSegment]:
        tensor = numpy_to_tensor(audio)

        timestamps = self.get_speech_timestamps(
            tensor,
            self.model,
            sampling_rate=self.config.sample_rate,
            threshold=self.config.vad_threshold,
            min_speech_duration_ms=self.config.min_speech_ms,
            min_silence_duration_ms=self.config.min_silence_ms,
            speech_pad_ms=self.config.speech_pad_ms,
            return_seconds=False,
        )

        segments: List[SpeechSegment] = []

        for ts in timestamps:
            start_sample = int(ts["start"])
            end_sample = int(ts["end"])
            chunk = np.asarray(audio[start_sample:end_sample], dtype=np.float32)

            segments.append(
                SpeechSegment(
                    start_ms=samples_to_ms(start_sample, self.config.sample_rate),
                    end_ms=samples_to_ms(end_sample, self.config.sample_rate),
                    start_sample=start_sample,
                    end_sample=end_sample,
                    audio=chunk,
                )
            )

        return segments

    def get_silence_gaps(self, audio: np.ndarray) -> List[dict]:
        segments = self.detect(audio)
        total_ms = len(audio) / self.config.sample_rate * 1000.0
        gaps: List[dict] = []

        prev_end = 0.0
        for seg in segments:
            if seg.start_ms - prev_end > self.config.min_silence_ms:
                gaps.append(
                    {
                        "start_ms": prev_end,
                        "end_ms": seg.start_ms,
                        "duration_ms": seg.start_ms - prev_end,
                    }
                )
            prev_end = seg.end_ms

        if total_ms - prev_end > self.config.min_silence_ms:
            gaps.append(
                {
                    "start_ms": prev_end,
                    "end_ms": total_ms,
                    "duration_ms": total_ms - prev_end,
                }
            )

        return gaps
