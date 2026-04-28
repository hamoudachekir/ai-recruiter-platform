import argparse
import queue
import sys
import threading
import time

from typing import Optional

import numpy as np

try:
    import sounddevice as sd
except ImportError as exc:
    raise SystemExit(
        "Missing dependency 'sounddevice'. Install with pip install sounddevice"
    ) from exc

from .speech_stack import SpeechStack


class AudioStreamer:
    def __init__(self, sample_rate: int, block_duration: float, device: Optional[int]):
        self.sample_rate = sample_rate
        self.block_size = int(sample_rate * block_duration)
        self.device = device
        self._queue: "queue.Queue[np.ndarray]" = queue.Queue()
        self._stream: Optional[sd.InputStream] = None

    def start(self) -> None:
        self._stream = sd.InputStream(
            samplerate=self.sample_rate,
            channels=1,
            dtype="float32",
            blocksize=self.block_size,
            device=self.device,
            callback=self._audio_callback,
        )
        self._stream.start()

    def stop(self) -> None:
        if self._stream is not None:
            self._stream.stop()
            self._stream.close()
            self._stream = None

    def read(self, timeout: float = 1.0) -> np.ndarray:
        return self._queue.get(timeout=timeout)

    def _audio_callback(self, indata, frames, time_info, status) -> None:
        if status:
            print(f"[audio warning] {status}", file=sys.stderr)
        self._queue.put(indata[:, 0].copy())


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Voice engine real-time STT + sentiment in terminal"
    )
    parser.add_argument("--model", default="small.en")
    parser.add_argument("--device", default="cuda", choices=["auto", "cpu", "cuda"])
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--language", default="en")
    parser.add_argument("--sample-rate", type=int, default=16000)
    parser.add_argument("--device-index", type=int, default=None)
    parser.add_argument("--preset", choices=["speed", "balanced", "accuracy"], default="balanced")
    parser.add_argument("--beam-size", type=int, default=None)
    parser.add_argument("--chunk-seconds", type=float, default=None)
    parser.add_argument("--no-vad", action="store_true")
    parser.add_argument("--sentiment-neutral-threshold", type=float, default=0.65)
    return parser.parse_args()


def resolve_preset(args: argparse.Namespace) -> tuple[float, int]:
    if args.preset == "speed":
        defaults = {"chunk": 1.0, "beam": 1}
    elif args.preset == "accuracy":
        defaults = {"chunk": 3.0, "beam": 5}
    else:
        defaults = {"chunk": 1.5, "beam": 3}

    chunk_seconds = args.chunk_seconds if args.chunk_seconds is not None else defaults["chunk"]
    beam_size = args.beam_size if args.beam_size is not None else defaults["beam"]
    return chunk_seconds, beam_size


def main() -> int:
    args = parse_args()
    chunk_seconds, beam_size = resolve_preset(args)

    print(f"Preset: {args.preset} | Chunk: {chunk_seconds}s | Beam: {beam_size}")
    print("Loading speech stack...")
    load_start = time.perf_counter()

    stack = SpeechStack(
        model_name=args.model,
        device=args.device,
        compute_type=args.compute_type,
        language=args.language,
        beam_size=beam_size,
        vad_filter=not args.no_vad,
        neutral_threshold=args.sentiment_neutral_threshold,
        enable_sentiment=True,
    )

    load_time = time.perf_counter() - load_start
    print(
        f"Ready in {load_time:.1f}s | model={stack.model_name} | device={stack.device} "
        f"| compute_type={stack.active_compute_type}"
    )
    if stack.cuda_runtime_path:
        print(f"CUDA runtime path: {stack.cuda_runtime_path}")

    streamer = AudioStreamer(
        sample_rate=args.sample_rate,
        block_duration=chunk_seconds,
        device=args.device_index,
    )

    print("Starting microphone stream. Press Ctrl+C to stop.")
    streamer.start()

    running = True
    processed_seconds = 0.0
    chunk_count = 0
    times = []
    sentiment_counts = {"POSITIVE": 0, "NEGATIVE": 0, "NEUTRAL": 0}

    def loop() -> None:
        nonlocal running, processed_seconds, chunk_count
        while running:
            try:
                chunk = streamer.read(timeout=0.5)
            except queue.Empty:
                continue

            chunk_start = time.perf_counter()
            try:
                result = stack.transcribe_with_sentiment(chunk)
            except Exception as exc:
                print(f"[error] {exc}", file=sys.stderr)
                running = False
                break

            for item in result["segment_sentiment"]:
                text = item["text"].strip()
                if not text:
                    continue

                label = item["sentiment"].get("label", "NEUTRAL")
                score = float(item["sentiment"].get("score", 0.0))
                if label not in sentiment_counts:
                    label = "NEUTRAL"
                sentiment_counts[label] += 1

                start = processed_seconds + float(item["start"])
                end = processed_seconds + float(item["end"])
                print(f"[{start:7.2f}s -> {end:7.2f}s] {text} | sentiment={label} ({score:.2f})")

            processed_seconds += chunk_seconds
            chunk_count += 1
            times.append(time.perf_counter() - chunk_start)

    worker = threading.Thread(target=loop, daemon=True)
    worker.start()

    try:
        while worker.is_alive():
            worker.join(timeout=0.2)
    except KeyboardInterrupt:
        running = False
        print("\nStopping...")
    finally:
        streamer.stop()

    if times:
        avg_t = sum(times) / len(times)
        print("\n--- Performance Summary ---")
        print(f"Chunks processed: {chunk_count}")
        print(f"Chunk size: {chunk_seconds}s")
        print(f"Avg transcription time: {avg_t:.3f}s (RTF: {avg_t/chunk_seconds:.2f}x)")
        print(f"Min/Max transcription time: {min(times):.3f}s / {max(times):.3f}s")

    total_segments = sum(sentiment_counts.values())
    print("\n--- Sentiment Summary ---")
    print(f"Total classified segments: {total_segments}")
    print(f"POSITIVE: {sentiment_counts['POSITIVE']}")
    print(f"NEGATIVE: {sentiment_counts['NEGATIVE']}")
    print(f"NEUTRAL: {sentiment_counts['NEUTRAL']}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
