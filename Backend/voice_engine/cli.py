from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from .stt_service import transcribe_file


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the voice engine on an audio file")
    parser.add_argument("audio_path", type=Path)
    parser.add_argument("--sample-rate", type=int, default=16000)
    parser.add_argument("--channels", type=int, default=1)
    parser.add_argument("--vad-threshold", type=float, default=0.35)
    parser.add_argument("--min-speech-ms", type=int, default=180)
    parser.add_argument("--min-silence-ms", type=int, default=700)
    parser.add_argument("--speech-pad-ms", type=int, default=220)
    parser.add_argument("--whisper-model", default="small")
    parser.add_argument("--whisper-device", default="cpu")
    parser.add_argument("--whisper-compute-type", default="int8")
    parser.add_argument("--language", default="fr")
    parser.add_argument("--hf-token", default="")
    parser.add_argument("--enable-diarization", action="store_true")
    parser.add_argument("--single-speaker-label", default="CANDIDATE")
    parser.add_argument("--max-speakers", type=int, default=2)
    parser.add_argument("--min-speakers", type=int, default=2)
    parser.add_argument("--save-dir", default=None, help="Directory to save the generated audio, txt, and pdf files")
    return parser.parse_args()


def main() -> int:
    try:
        args = parse_args()
        payload = transcribe_file(
            args.audio_path,
            {
                "sampleRate": args.sample_rate,
                "channels": args.channels,
                "vadThreshold": args.vad_threshold,
                "minSpeechMs": args.min_speech_ms,
                "minSilenceMs": args.min_silence_ms,
                "speechPadMs": args.speech_pad_ms,
                "whisperModel": args.whisper_model,
                "whisperDevice": args.whisper_device,
                "whisperComputeType": args.whisper_compute_type,
                "language": args.language,
                "hfToken": args.hf_token,
                "enableDiarization": args.enable_diarization,
                "singleSpeakerLabel": args.single_speaker_label,
                "maxSpeakers": args.max_speakers,
                "minSpeakers": args.min_speakers,
            },
            save_dir=args.save_dir
        )

        print(json.dumps(payload, ensure_ascii=False))
        return 0
    except KeyboardInterrupt:
        print(
            "Interrupted by user while loading model or processing audio. "
            "Re-run and let model download complete.",
            file=sys.stderr,
        )
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
