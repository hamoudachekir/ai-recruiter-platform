from __future__ import annotations

import argparse
import json
import subprocess
import sys
import threading
import wave
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Replay a WAV file into the realtime worker and print partial outputs")
    parser.add_argument("audio_path", type=Path)
    parser.add_argument("--chunk-ms", type=int, default=120)
    parser.add_argument("--sample-rate", type=int, default=16000)
    parser.add_argument("--channels", type=int, default=1)
    parser.add_argument("--language", default="auto")
    parser.add_argument("--whisper-model", default="small")
    parser.add_argument("--whisper-device", default="cpu")
    parser.add_argument("--whisper-compute-type", default="int8")
    parser.add_argument("--vad-threshold", type=float, default=0.5)
    parser.add_argument("--min-speech-ms", type=int, default=320)
    parser.add_argument("--min-silence-ms", type=int, default=850)
    parser.add_argument("--max-chunk-ms", type=int, default=1800)
    parser.add_argument("--max-trailing-silence-ms", type=int, default=180)
    parser.add_argument("--min-chunk-rms", type=float, default=0.01)
    parser.add_argument("--min-speech-ratio", type=float, default=0.38)
    parser.add_argument("--min-avg-logprob", type=float, default=-0.85)
    parser.add_argument("--max-no-speech-prob", type=float, default=0.5)
    return parser.parse_args()


def load_wav_pcm16_mono(path: Path, target_sample_rate: int) -> bytes:
    with wave.open(str(path), "rb") as wav_file:
        channels = wav_file.getnchannels()
        sample_width = wav_file.getsampwidth()
        sample_rate = wav_file.getframerate()
        frames = wav_file.readframes(wav_file.getnframes())

    if sample_width != 2:
        raise ValueError("Only 16-bit PCM WAV files are supported")

    if sample_rate != target_sample_rate:
        raise ValueError(
            f"WAV sample rate is {sample_rate} but target sample rate is {target_sample_rate}. "
            "Please resample the audio first."
        )

    if channels == 1:
        return frames

    if channels <= 0:
        raise ValueError("Invalid WAV channel count")

    # Convert interleaved PCM16 to mono by averaging all channels.
    mono = bytearray()
    frame_count = len(frames) // (2 * channels)
    for frame_index in range(frame_count):
        start = frame_index * channels * 2
        total = 0
        for channel_index in range(channels):
            offset = start + (channel_index * 2)
            sample = int.from_bytes(frames[offset:offset + 2], byteorder="little", signed=True)
            total += sample
        averaged = int(total / channels)
        mono.extend(int(averaged).to_bytes(2, byteorder="little", signed=True))

    return bytes(mono)


def main() -> int:
    args = parse_args()
    if not args.audio_path.exists():
        print(f"Audio file not found: {args.audio_path}", file=sys.stderr)
        return 1

    pcm_data = load_wav_pcm16_mono(args.audio_path, args.sample_rate)
    chunk_samples = max(1, int((args.sample_rate * args.chunk_ms) / 1000.0))
    chunk_bytes = chunk_samples * 2

    worker_args = [
        sys.executable,
        "-m",
        "voice_engine.realtime_worker",
        "--sample-rate", str(args.sample_rate),
        "--channels", str(args.channels),
        "--vad-threshold", str(args.vad_threshold),
        "--min-speech-ms", str(args.min_speech_ms),
        "--min-silence-ms", str(args.min_silence_ms),
        "--max-chunk-ms", str(args.max_chunk_ms),
        "--max-trailing-silence-ms", str(args.max_trailing_silence_ms),
        "--min-chunk-rms", str(args.min_chunk_rms),
        "--min-speech-ratio", str(args.min_speech_ratio),
        "--min-avg-logprob", str(args.min_avg_logprob),
        "--max-no-speech-prob", str(args.max_no_speech_prob),
        "--whisper-model", str(args.whisper_model),
        "--whisper-device", str(args.whisper_device),
        "--whisper-compute-type", str(args.whisper_compute_type),
    ]

    language = str(args.language or "").strip()
    if language and language.lower() != "auto":
        worker_args.extend(["--language", language])

    process = subprocess.Popen(
        worker_args,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=False,
    )

    stdout_lines: list[bytes] = []
    stderr_lines: list[bytes] = []

    def read_stdout() -> None:
        assert process.stdout is not None
        for line in process.stdout:
            stdout_lines.append(line)

    def read_stderr() -> None:
        assert process.stderr is not None
        for line in process.stderr:
            stderr_lines.append(line)

    stdout_thread = threading.Thread(target=read_stdout, daemon=True)
    stderr_thread = threading.Thread(target=read_stderr, daemon=True)
    stdout_thread.start()
    stderr_thread.start()

    try:
        assert process.stdin is not None
        for offset in range(0, len(pcm_data), chunk_bytes):
            chunk = pcm_data[offset:offset + chunk_bytes]
            if not chunk:
                continue
            process.stdin.write(len(chunk).to_bytes(4, byteorder="little", signed=False))
            process.stdin.write(chunk)
        process.stdin.close()
    except BrokenPipeError:
        pass

    return_code = process.wait(timeout=300)
    stdout_thread.join(timeout=1)
    stderr_thread.join(timeout=1)

    partial_count = 0
    all_payloads: list[dict] = []

    for raw_line in stdout_lines:
        line = raw_line.decode("utf-8", errors="replace").strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue

        all_payloads.append(payload)
        if payload.get("type") == "partial":
            partial_count += 1
            speaker = payload.get("speaker", "CANDIDATE")
            text = payload.get("text", "")
            print(f"[partial {partial_count}] {speaker}: {text}")

    done_payload = next((item for item in reversed(all_payloads) if item.get("type") == "done"), None)
    turn_count = int(done_payload.get("turn_count", 0)) if done_payload else 0

    print("\n=== replay summary ===")
    print(f"exit_code: {return_code}")
    print(f"partial_count: {partial_count}")
    print(f"turn_count: {turn_count}")

    filtered_stderr = []
    for raw_line in stderr_lines:
        text_line = raw_line.decode("utf-8", errors="replace").strip()
        if not text_line:
            continue
        if text_line.startswith("Using cache found in"):
            continue
        filtered_stderr.append(text_line)

    if filtered_stderr:
        print("\n=== stderr ===")
        for line in filtered_stderr:
            print(line)

    return 0 if return_code == 0 else return_code


if __name__ == "__main__":
    raise SystemExit(main())
