from __future__ import annotations

import sys
import types
import unittest
from dataclasses import dataclass

import numpy as np


def install_fake_dependencies():
    fake_torch = types.ModuleType("torch")

    class FakeTensor:
        def __init__(self, array):
            self.array = np.asarray(array, dtype=np.float32)

        def unsqueeze(self, axis):
            return FakeTensor(np.expand_dims(self.array, axis))

        def detach(self):
            return self

        def cpu(self):
            return self

        def numpy(self):
            return self.array

    def as_tensor(array, dtype=None):
        return FakeTensor(array)

    class FakeModel:
        def eval(self):
            return self

    def get_speech_timestamps(*args, **kwargs):
        return [
            {"start": 0, "end": 1600},
            {"start": 2400, "end": 4000},
        ]

    fake_torch.as_tensor = as_tensor
    fake_torch.from_numpy = lambda array: FakeTensor(array)
    fake_torch.float32 = np.float32
    fake_torch.device = lambda value: value
    fake_torch.cuda = types.SimpleNamespace(is_available=lambda: False)
    fake_torch.hub = types.SimpleNamespace(load=lambda *args, **kwargs: (FakeModel(), (get_speech_timestamps, None, None, None)))

    fake_faster_whisper = types.ModuleType("faster_whisper")

    @dataclass
    class FakeWord:
        word: str
        start: float
        end: float
        probability: float

    @dataclass
    class FakeSegment:
        text: str
        avg_logprob: float = -0.1
        words: list | None = None
        start: float = 0.0
        end: float = 0.0

    class WhisperModel:
        def __init__(self, *args, **kwargs):
            pass

        def transcribe(self, audio, **kwargs):
            segment = FakeSegment(
                text="hello",
                avg_logprob=-0.1,
                words=[FakeWord("hello", 0.0, 0.5, 0.9)],
                start=0.0,
                end=1.0,
            )
            return iter([segment]), types.SimpleNamespace(language="fr")

    fake_faster_whisper.WhisperModel = WhisperModel

    fake_pyannote = types.ModuleType("pyannote")
    fake_pyannote_audio = types.ModuleType("pyannote.audio")

    class FakeTurn:
        start = 0.0
        end = 1.2

    class FakeDiarization:
        def itertracks(self, yield_label=False):
            yield FakeTurn(), None, "SPEAKER_00"
            yield types.SimpleNamespace(start=1.2, end=2.0), None, "SPEAKER_01"

    class Pipeline:
        @classmethod
        def from_pretrained(cls, *args, **kwargs):
            return cls()

        def to(self, device):
            return self

        def __call__(self, *args, **kwargs):
            return FakeDiarization()

    fake_pyannote_audio.Pipeline = Pipeline

    sys.modules["torch"] = fake_torch
    sys.modules["faster_whisper"] = fake_faster_whisper
    sys.modules["pyannote"] = fake_pyannote
    sys.modules["pyannote.audio"] = fake_pyannote_audio


install_fake_dependencies()

from voice_engine.config import VoiceEngineConfig
from voice_engine.diarizer import DiarizedSegment
from voice_engine.pipeline import VoicePipeline
from voice_engine.transcriber import Transcript
from voice_engine.vad import SileroVAD


class VoiceEngineSmokeTests(unittest.TestCase):
    def test_vad_detects_segments(self):
        vad = SileroVAD(VoiceEngineConfig(hf_token="token"))
        audio = np.zeros(5000, dtype=np.float32)

        segments = vad.detect(audio)

        self.assertEqual(len(segments), 2)
        self.assertAlmostEqual(segments[0].start_ms, 0.0)
        self.assertAlmostEqual(segments[0].end_ms, 100.0, delta=1.0)

    def test_silence_detection_finds_gap(self):
        vad = SileroVAD(VoiceEngineConfig(hf_token="token", min_silence_ms=25))
        audio = np.zeros(5000, dtype=np.float32)

        gaps = vad.get_silence_gaps(audio)

        self.assertGreaterEqual(len(gaps), 1)
        self.assertAlmostEqual(gaps[0]["start_ms"], 100.0, delta=1.0)
        self.assertAlmostEqual(gaps[0]["duration_ms"], 50.0, delta=1.0)

    def test_merge_prefers_highest_overlap(self):
        pipeline = VoicePipeline.__new__(VoicePipeline)

        transcripts = [
            Transcript(
                text="hello",
                start_ms=0.0,
                end_ms=1000.0,
                language="fr",
                confidence=-0.1,
                words=[],
            )
        ]
        diarized = [
            DiarizedSegment("SPEAKER_01", 0.0, 300.0, 300.0),
            DiarizedSegment("SPEAKER_00", 250.0, 1100.0, 850.0),
        ]

        results = pipeline._merge(transcripts, diarized, [{"start_ms": 0.0, "end_ms": 0.0, "duration_ms": 1200.0}])

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].speaker, "SPEAKER_00")
        self.assertEqual(results[0].text, "hello")

    def test_silence_before_is_reported(self):
        pipeline = VoicePipeline.__new__(VoicePipeline)
        silence = pipeline._silence_before(1250.0, [{"start_ms": 1000.0, "end_ms": 1200.0, "duration_ms": 200.0}])

        self.assertEqual(silence, 200.0)


if __name__ == "__main__":
    unittest.main()
