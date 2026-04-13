from __future__ import annotations

from dataclasses import dataclass
from typing import List

import numpy as np
import torch
from pyannote.audio import Pipeline

from .config import VoiceEngineConfig


@dataclass
class DiarizedSegment:
    speaker: str
    start_ms: float
    end_ms: float
    duration_ms: float


class PyannoteDiarizer:
    def __init__(self, config: VoiceEngineConfig):
        if not config.hf_token:
            raise ValueError(
                "VoiceEngineConfig.hf_token is required to load pyannote/speaker-diarization-3.1"
            )

        self.config = config
        try:
            self.pipeline = Pipeline.from_pretrained(
                "pyannote/speaker-diarization-3.1",
                use_auth_token=config.hf_token,
            )
        except TypeError:
            # pyannote.audio 4.x switched to a `token` argument.
            self.pipeline = Pipeline.from_pretrained(
                "pyannote/speaker-diarization-3.1",
                token=config.hf_token,
            )

        if config.whisper_device == "cuda" and torch.cuda.is_available():
            self.pipeline.to(torch.device("cuda"))

    def diarize(self, audio: np.ndarray) -> List[DiarizedSegment]:
        waveform = torch.from_numpy(np.asarray(audio, dtype=np.float32)).unsqueeze(0)

        diarization = self.pipeline(
            {"waveform": waveform, "sample_rate": self.config.sample_rate},
            min_speakers=self.config.min_speakers,
            max_speakers=self.config.max_speakers,
        )

        segments: List[DiarizedSegment] = []
        for turn, _, speaker in diarization.itertracks(yield_label=True):
            segments.append(
                DiarizedSegment(
                    speaker=speaker,
                    start_ms=turn.start * 1000.0,
                    end_ms=turn.end * 1000.0,
                    duration_ms=(turn.end - turn.start) * 1000.0,
                )
            )

        return segments
