from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np
import sounddevice as sd
import soundfile as sf

from .config import VoiceEngineConfig
from .pipeline import VoicePipeline


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Record from the microphone and run the voice engine")
    parser.add_argument("--duration", type=float, default=8.0, help="Recording length in seconds")
    parser.add_argument("--sample-rate", type=int, default=16000)
    parser.add_argument("--channels", type=int, default=1)
    parser.add_argument("--output", type=Path, default=Path("voice_engine_mic_test.wav"))
    parser.add_argument("--whisper-model", default="small")
    parser.add_argument("--whisper-device", default="cpu")
    parser.add_argument("--whisper-compute-type", default="int8")
    parser.add_argument("--language", default="en")
    parser.add_argument("--hf-token", default="")
    parser.add_argument("--enable-diarization", action="store_true")
    parser.add_argument("--single-speaker-label", default="CANDIDATE")
    parser.add_argument("--min-speech-ms", type=int, default=180)
    parser.add_argument("--min-silence-ms", type=int, default=700)
    parser.add_argument("--speech-pad-ms", type=int, default=220)
    parser.add_argument("--vad-threshold", type=float, default=0.35)
    return parser.parse_args()


def record_audio(duration: float, sample_rate: int, channels: int) -> np.ndarray:
    print(f"Speak now for {duration:.1f} seconds...")
    recording = sd.rec(
        int(duration * sample_rate),
        samplerate=sample_rate,
        channels=channels,
        dtype="float32",
    )
    sd.wait()
    return np.asarray(recording, dtype=np.float32)


def to_mono(audio: np.ndarray) -> np.ndarray:
    if audio.ndim == 1:
        return audio
    if audio.shape[1] == 1:
        return audio[:, 0]
    return np.mean(audio, axis=1).astype(np.float32)


def main() -> int:
    try:
        args = parse_args()
        language = (args.language or "").strip()
        normalized_language = None if language.lower() in {"", "auto"} else language

        env_enable_diarization = str(os.getenv("VOICE_ENGINE_ENABLE_DIARIZATION", "false")).strip().lower() in {
            "1",
            "true",
            "yes",
            "on",
        }
        enable_diarization = bool(args.enable_diarization or env_enable_diarization)
        single_speaker_label = (
            args.single_speaker_label
            or os.getenv("VOICE_ENGINE_SINGLE_SPEAKER_LABEL")
            or "CANDIDATE"
        ).strip() or "CANDIDATE"

        hf_token = (
            args.hf_token
            or os.getenv("VOICE_ENGINE_HF_TOKEN")
            or os.getenv("HF_TOKEN")
            or os.getenv("HUGGING_FACE_HUB_TOKEN")
            or ""
        )

        audio = record_audio(args.duration, args.sample_rate, args.channels)
        mono_audio = to_mono(audio)
        sf.write(args.output, mono_audio, args.sample_rate)

        config = VoiceEngineConfig(
            sample_rate=args.sample_rate,
            channels=1,
            vad_threshold=args.vad_threshold,
            min_speech_ms=args.min_speech_ms,
            min_silence_ms=args.min_silence_ms,
            speech_pad_ms=args.speech_pad_ms,
            whisper_model=args.whisper_model,
            whisper_device=args.whisper_device,
            whisper_compute_type=args.whisper_compute_type,
            language=normalized_language,
            hf_token=hf_token,
            enable_diarization=enable_diarization,
            single_speaker_label=single_speaker_label,
        )

        pipeline = VoicePipeline(config)
        turns = pipeline.process(args.output)

        payload = {
            "ok": True,
            "output": str(args.output),
            "turn_count": len(turns),
            "turns": [turn.__dict__ for turn in turns],
        }

        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0
    except KeyboardInterrupt:
        print(
            "Interrupted by user while loading model or recording audio. "
            "If this was the first run with a larger model, re-run and let download finish.",
            file=sys.stderr,
        )
        return 130


if __name__ == "__main__":
    raise SystemExit(main())