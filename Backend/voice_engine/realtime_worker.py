from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, deque
from dataclasses import dataclass

import numpy as np
import torch
from faster_whisper import WhisperModel


HALLUCINATION_PHRASES = {
    "description",
    "subscribe",
    "thanks for watching",
    "thank you for watching",
    "caption",
    "captions",
    "transcript",
}

HALLUCINATION_PATTERNS = (
    "in the description",
    "description below",
    "link in bio",
    "thanks for watching",
    "thank you for watching",
)


def clean_text(text: str) -> str:
    replacements = {
        "•": "-",
        "’": "'",
        "“": '"',
        "”": '"',
        "…": "...",
        "\u2022": "-",
        "\u2013": "-",
        "\u2014": "-",
    }

    cleaned = str(text or "")
    for source, target in replacements.items():
        cleaned = cleaned.replace(source, target)

    cleaned = re.sub(r"[^\w\s\u00C0-\u017F.,:;!?\'\"()\-]", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned.strip()


def emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def read_exact(stream, size: int) -> bytes | None:
    if size <= 0:
        return b""

    data = bytearray()
    while len(data) < size:
        chunk = stream.read(size - len(data))
        if not chunk:
            if not data:
                return None
            break
        data.extend(chunk)
    return bytes(data)


@dataclass
class StreamConfig:
    sample_rate: int
    channels: int
    vad_threshold: float
    min_speech_ms: int
    min_silence_ms: int
    max_chunk_ms: int
    max_trailing_silence_ms: int
    min_chunk_rms: float
    min_speech_ratio: float
    min_avg_logprob: float
    max_no_speech_prob: float
    partial_emit_ms: int
    whisper_model: str
    whisper_device: str
    whisper_compute_type: str
    language: str | None
    single_speaker_label: str


class RealtimeTranscriber:
    def __init__(self, config: StreamConfig):
        self.config = config
        if config.sample_rate not in {8000, 16000}:
            raise ValueError("Realtime VAD supports only sample rates 8000 or 16000")

        self.min_speech_samples = int(config.sample_rate * (config.min_speech_ms / 1000.0))
        self.max_chunk_samples = int(config.sample_rate * (config.max_chunk_ms / 1000.0))
        self.max_trailing_silence_samples = int(
            config.sample_rate * (config.max_trailing_silence_ms / 1000.0)
        )
        self.partial_emit_samples = int(config.sample_rate * (config.partial_emit_ms / 1000.0))
        self.vad_frame_samples = 512 if config.sample_rate == 16000 else 256

        self.whisper = WhisperModel(
            config.whisper_model,
            device=config.whisper_device,
            compute_type=config.whisper_compute_type,
        )

        self.vad_model, _ = torch.hub.load(
            repo_or_dir="snakers4/silero-vad",
            model="silero_vad",
            force_reload=False,
            trust_repo=True,
        )
        self.vad_model.eval()

        self.speech_buffer: list[np.ndarray] = []
        self.buffered_samples = 0
        self.buffered_speech_samples = 0
        self.buffered_trailing_silence_samples = 0
        self.silence_ms = 0.0
        self.is_speaking = False
        self.start_sample = 0
        self.total_samples = 0
        self.turn_index = 0
        self.recent_texts: deque[str] = deque(maxlen=8)
        self.last_partial_emit_samples = 0

    @staticmethod
    def _normalize_text(text: str) -> str:
        sanitized = re.sub(r"[^a-z0-9']+", " ", text.lower())
        return re.sub(r"\s+", " ", sanitized).strip()

    @staticmethod
    def _collapse_repeated_tokens(text: str, max_repeat: int = 2) -> str:
        tokens = text.split()
        if not tokens:
            return ""

        compact_tokens: list[str] = []
        previous = ""
        repeat_count = 0

        for token in tokens:
            normalized = re.sub(r"[^a-z0-9']+", "", token.lower())
            if normalized and normalized == previous:
                repeat_count += 1
            else:
                previous = normalized
                repeat_count = 1

            if repeat_count <= max_repeat:
                compact_tokens.append(token)

        return " ".join(compact_tokens).strip()

    def _is_text_valid(self, text: str) -> bool:
        normalized = self._normalize_text(text)
        if len(normalized) < 8:
            return False

        if normalized in HALLUCINATION_PHRASES:
            return False

        if any(pattern in normalized for pattern in HALLUCINATION_PATTERNS):
            return False

        tokens = normalized.split()
        if not tokens:
            return False

        if len(tokens) < 2:
            return False

        if len(tokens) <= 4 and normalized in HALLUCINATION_PHRASES:
            return False

        if len(tokens) >= 4 and len(set(tokens)) == 1:
            return False

        if len(tokens) >= 6:
            token_counter = Counter(tokens)
            if (max(token_counter.values()) / len(tokens)) >= 0.7:
                return False

        if len(tokens) >= 6:
            unique_ratio = len(set(tokens)) / max(len(tokens), 1)
            if unique_ratio < 0.34:
                return False

        if len(tokens) >= 8 and len(set(tokens)) <= 3:
            return False

        if self.recent_texts and normalized == self.recent_texts[-1]:
            return False

        self.recent_texts.append(normalized)
        return True

    def _pcm_to_mono_float32(self, payload: bytes) -> np.ndarray:
        int16_data = np.frombuffer(payload, dtype=np.int16)
        if int16_data.size == 0:
            return np.asarray([], dtype=np.float32)

        audio = int16_data.astype(np.float32) / 32768.0

        if self.config.channels > 1:
            usable = (audio.size // self.config.channels) * self.config.channels
            if usable == 0:
                return np.asarray([], dtype=np.float32)
            reshaped = audio[:usable].reshape(-1, self.config.channels)
            audio = np.mean(reshaped, axis=1).astype(np.float32)

        return np.clip(audio, -1.0, 1.0)

    def _is_speech(self, chunk: np.ndarray) -> bool:
        if chunk.size == 0:
            return False

        rms = float(np.sqrt(np.mean(np.square(chunk.astype(np.float64)))))
        if rms < self.config.min_chunk_rms:
            return False

        speech_frames = 0
        total_frames = 0

        for start in range(0, chunk.size, self.vad_frame_samples):
            frame = chunk[start : start + self.vad_frame_samples]
            if frame.size < self.vad_frame_samples:
                padded = np.zeros(self.vad_frame_samples, dtype=np.float32)
                padded[: frame.size] = frame
                frame = padded

            total_frames += 1

            with torch.no_grad():
                confidence = float(
                    self.vad_model(torch.from_numpy(frame).float(), self.config.sample_rate).item()
                )

            if confidence >= self.config.vad_threshold:
                speech_frames += 1

        min_required = max(1, (total_frames + 1) // 2)
        return speech_frames >= min_required

    def _transcribe(self, audio: np.ndarray) -> tuple[str, str | None]:
        segments, info = self.whisper.transcribe(
            audio,
            language=self.config.language,
            beam_size=7,
            temperature=0.0,
            condition_on_previous_text=False,
            no_speech_threshold=self.config.max_no_speech_prob,
            log_prob_threshold=self.config.min_avg_logprob,
            compression_ratio_threshold=2.2,
            repetition_penalty=1.12,
            vad_filter=False,
            word_timestamps=True,
        )

        text_parts: list[str] = []
        for segment in segments:
            text = (segment.text or "").strip()
            if not text:
                continue

            avg_logprob = float(getattr(segment, "avg_logprob", 0.0))
            no_speech_prob = float(getattr(segment, "no_speech_prob", 0.0))

            if no_speech_prob > self.config.max_no_speech_prob and avg_logprob < self.config.min_avg_logprob:
                continue

            words = list(getattr(segment, "words", []) or [])
            if words:
                confidences = [float(getattr(word, "probability", 0.0)) for word in words]
                avg_confidence = sum(confidences) / max(len(confidences), 1)
                if avg_confidence < 0.42:
                    continue

            text_parts.append(text)

        merged = clean_text(self._collapse_repeated_tokens(" ".join(text_parts).strip()))
        if not merged:
            return "", getattr(info, "language", None)

        if not self._is_text_valid(merged):
            return "", getattr(info, "language", None)

        return merged, getattr(info, "language", None)

    def _flush_if_needed(self, force: bool = False) -> None:
        if not self.speech_buffer:
            self._reset_turn_state()
            return

        if not force and self.silence_ms < self.config.min_silence_ms:
            return

        audio = np.concatenate(self.speech_buffer)

        if self.buffered_speech_samples < self.min_speech_samples:
            self._reset_turn_state()
            return

        speech_ratio = self.buffered_speech_samples / max(audio.size, 1)
        if speech_ratio < self.config.min_speech_ratio:
            self._reset_turn_state()
            return

        text, detected_language = self._transcribe(audio)
        end_sample = self.total_samples

        if text:
            self.turn_index += 1
            emit(
                {
                    "type": "partial",
                    "turn_index": self.turn_index,
                    "speaker": self.config.single_speaker_label,
                    "text": text,
                    "language": detected_language,
                    "start_ms": (self.start_sample * 1000.0) / self.config.sample_rate,
                    "end_ms": (end_sample * 1000.0) / self.config.sample_rate,
                }
            )

        self._reset_turn_state()

    def _maybe_emit_partial(self) -> None:
        if not self.speech_buffer:
            return

        if self.partial_emit_samples <= 0:
            return

        if (self.total_samples - self.last_partial_emit_samples) < self.partial_emit_samples:
            return

        audio = np.concatenate(self.speech_buffer)
        if audio.size < self.min_speech_samples:
            return

        text, detected_language = self._transcribe(audio)
        if not text:
            return

        self.last_partial_emit_samples = self.total_samples
        emit(
            {
                "type": "partial",
                "turn_index": self.turn_index,
                "speaker": self.config.single_speaker_label,
                "text": text,
                "language": detected_language,
                "start_ms": (self.start_sample * 1000.0) / self.config.sample_rate,
                "end_ms": (self.total_samples * 1000.0) / self.config.sample_rate,
            }
        )

    def _reset_turn_state(self) -> None:
        self.speech_buffer = []
        self.buffered_samples = 0
        self.buffered_speech_samples = 0
        self.buffered_trailing_silence_samples = 0
        self.silence_ms = 0.0
        self.is_speaking = False
        self.last_partial_emit_samples = self.total_samples

    def push_chunk(self, payload: bytes) -> None:
        chunk = self._pcm_to_mono_float32(payload)
        chunk_size = int(chunk.size)

        if chunk_size <= 0:
            return

        chunk_start_sample = self.total_samples
        self.total_samples += chunk_size
        chunk_ms = (chunk_size * 1000.0) / self.config.sample_rate

        if self._is_speech(chunk):
            if not self.is_speaking:
                self.is_speaking = True
                self.start_sample = chunk_start_sample
            self.speech_buffer.append(chunk)
            self.buffered_samples += chunk_size
            self.buffered_speech_samples += chunk_size
            self.buffered_trailing_silence_samples = 0
            self.silence_ms = 0.0

            # Flush periodically for realtime partials, even without silence.
            if self.max_chunk_samples > 0 and self.buffered_samples >= self.max_chunk_samples:
                self._flush_if_needed(force=True)
            else:
                self._maybe_emit_partial()
            return

        if not self.is_speaking:
            return

        if self.max_trailing_silence_samples > 0:
            remaining_silence = self.max_trailing_silence_samples - self.buffered_trailing_silence_samples
            keep_samples = max(0, min(chunk_size, remaining_silence))
            if keep_samples > 0:
                self.speech_buffer.append(chunk[:keep_samples])
                self.buffered_samples += keep_samples
                self.buffered_trailing_silence_samples += keep_samples

        self.silence_ms += chunk_ms
        self._flush_if_needed(force=False)

    def finalize(self) -> None:
        if self.is_speaking and self.speech_buffer:
            self._flush_if_needed(force=True)

        emit({"type": "done", "turn_count": self.turn_index})


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Realtime STT worker for framed PCM chunks")
    parser.add_argument("--sample-rate", type=int, default=16000)
    parser.add_argument("--channels", type=int, default=1)
    parser.add_argument("--vad-threshold", type=float, default=0.5)
    parser.add_argument("--min-speech-ms", type=int, default=320)
    parser.add_argument("--min-silence-ms", type=int, default=850)
    parser.add_argument("--max-chunk-ms", type=int, default=1800)
    parser.add_argument("--max-trailing-silence-ms", type=int, default=180)
    parser.add_argument("--min-chunk-rms", type=float, default=0.01)
    parser.add_argument("--min-speech-ratio", type=float, default=0.38)
    parser.add_argument("--min-avg-logprob", type=float, default=-0.85)
    parser.add_argument("--max-no-speech-prob", type=float, default=0.5)
    parser.add_argument("--partial-emit-ms", type=int, default=700)
    parser.add_argument("--whisper-model", default="medium")
    parser.add_argument("--whisper-device", default="cpu")
    parser.add_argument("--whisper-compute-type", default="int8")
    parser.add_argument("--language", default="en")
    parser.add_argument("--single-speaker-label", default="CANDIDATE")
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    language = (args.language or "").strip()
    normalized_language = None if language.lower() in {"", "auto", "none"} else language

    transcriber = RealtimeTranscriber(
        StreamConfig(
            sample_rate=args.sample_rate,
            channels=args.channels,
            vad_threshold=args.vad_threshold,
            min_speech_ms=args.min_speech_ms,
            min_silence_ms=args.min_silence_ms,
            max_chunk_ms=args.max_chunk_ms,
            max_trailing_silence_ms=args.max_trailing_silence_ms,
            min_chunk_rms=args.min_chunk_rms,
            min_speech_ratio=args.min_speech_ratio,
            min_avg_logprob=args.min_avg_logprob,
            max_no_speech_prob=args.max_no_speech_prob,
            partial_emit_ms=args.partial_emit_ms,
            whisper_model=args.whisper_model,
            whisper_device=args.whisper_device,
            whisper_compute_type=args.whisper_compute_type,
            language=normalized_language,
            single_speaker_label=(args.single_speaker_label or "CANDIDATE").strip() or "CANDIDATE",
        )
    )

    emit({"type": "ready"})

    stream = sys.stdin.buffer

    while True:
        header = read_exact(stream, 4)
        if header is None or len(header) < 4:
            break

        frame_size = int.from_bytes(header, byteorder="little", signed=False)
        if frame_size <= 0:
            continue

        payload = read_exact(stream, frame_size)
        if payload is None or len(payload) < frame_size:
            break

        transcriber.push_chunk(payload)

    transcriber.finalize()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
