import io
import os
import tempfile
import threading
import re

from typing import BinaryIO, Dict, List, Optional, Tuple, Union

import numpy as np

from faster_whisper import WhisperModel
from faster_whisper.audio import decode_audio

AudioInput = Union[str, bytes, bytearray, BinaryIO, np.ndarray]


def ensure_local_cuda_runtime_path(repo_root: Optional[str] = None) -> Optional[str]:
    """Add local CUDA runtime folder to PATH when available."""
    if repo_root is None:
        repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

    candidates = []
    custom_dir = os.environ.get("CUDA_LOCAL_DLL_DIR")
    if custom_dir:
        candidates.append(custom_dir)

    candidates.append(os.path.join(repo_root, "third_party", "nvidia_cuda12"))

    for dll_dir in candidates:
        cublas_path = os.path.join(dll_dir, "cublas64_12.dll")
        if not os.path.isfile(cublas_path):
            continue

        existing_paths = os.environ.get("PATH", "").split(os.pathsep)
        normalized = {
            os.path.normcase(os.path.normpath(path)) for path in existing_paths if path
        }
        dll_norm = os.path.normcase(os.path.normpath(dll_dir))

        if dll_norm not in normalized:
            os.environ["PATH"] = dll_dir + os.pathsep + os.environ.get("PATH", "")

        return dll_dir

    return None


class SpeechStack:
    """Reusable STT + sentiment + TTS stack for integration in backend services."""

    def __init__(
        self,
        model_name: str = "small.en",
        device: str = "cuda",
        compute_type: str = "int8",
        language: Optional[str] = "en",
        beam_size: int = 3,
        vad_filter: bool = True,
        sentiment_model: str = "cardiffnlp/twitter-roberta-base-sentiment-latest",
        neutral_threshold: float = 0.65,
        enable_sentiment: bool = True,
    ):
        self.model_name = model_name
        self.device = device
        self.compute_type = compute_type
        self.language = language
        self.beam_size = beam_size
        self.vad_filter = vad_filter
        self.neutral_threshold = neutral_threshold
        self.enable_sentiment = enable_sentiment
        self.sentiment_model = sentiment_model

        if self.device in {"cuda", "auto"}:
            self.cuda_runtime_path = ensure_local_cuda_runtime_path()
        else:
            self.cuda_runtime_path = None

        self.active_compute_type = self.compute_type
        self.whisper_model = self._load_whisper_model()

        self.sentiment_pipeline = None
        if self.enable_sentiment:
            self.sentiment_pipeline = self._load_sentiment_model()

        self._tts_lock = threading.Lock()

    def _load_whisper_model(self) -> WhisperModel:
        attempted = [self.compute_type]

        if self.device == "cuda":
            for candidate in ("int8_float16", "int8", "float32"):
                if candidate not in attempted:
                    attempted.append(candidate)
        else:
            for candidate in ("int8", "float32"):
                if candidate not in attempted:
                    attempted.append(candidate)

        last_exc = None
        for candidate in attempted:
            try:
                model = WhisperModel(
                    self.model_name,
                    device=self.device,
                    compute_type=candidate,
                )
                self.active_compute_type = candidate
                return model
            except Exception as exc:
                last_exc = exc

        raise RuntimeError(
            "Unable to initialize Whisper model with any supported compute type."
        ) from last_exc

    def _load_sentiment_model(self):
        try:
            from transformers import pipeline
        except ImportError as exc:
            raise RuntimeError(
                "Sentiment requires transformers and torch. Install them in your app."
            ) from exc

        return pipeline(
            "sentiment-analysis",
            model=self.sentiment_model,
            truncation=True,
        )

    @staticmethod
    def _normalize_sentiment_label(label: str) -> str:
        raw = (label or "").strip().upper()
        if "NEG" in raw or raw == "LABEL_0":
            return "NEGATIVE"
        if "NEU" in raw or raw == "LABEL_1":
            return "NEUTRAL"
        if "POS" in raw or raw == "LABEL_2":
            return "POSITIVE"
        return "NEUTRAL"

    @staticmethod
    def _prepare_audio(audio: AudioInput) -> np.ndarray:
        if isinstance(audio, np.ndarray):
            if audio.dtype != np.float32:
                return audio.astype(np.float32)
            return audio

        if isinstance(audio, (bytes, bytearray)):
            return decode_audio(io.BytesIO(audio), sampling_rate=16000)

        if isinstance(audio, str):
            return decode_audio(audio, sampling_rate=16000)

        if hasattr(audio, "read"):
            return decode_audio(audio, sampling_rate=16000)

        raise TypeError("Unsupported audio input type. Expected path, bytes, file-like, or np.ndarray.")

    def transcribe(self, audio: AudioInput) -> Dict:
        audio_np = self._prepare_audio(audio)

        segments, info = self.whisper_model.transcribe(
            audio_np,
            language=self.language,
            beam_size=self.beam_size,
            condition_on_previous_text=False,
            vad_filter=self.vad_filter,
        )

        segment_items: List[Dict] = []
        texts: List[str] = []
        for segment in segments:
            text = segment.text.strip()
            segment_items.append(
                {
                    "start": float(segment.start),
                    "end": float(segment.end),
                    "text": text,
                }
            )
            if text:
                texts.append(text)

        return {
            "text": " ".join(texts).strip(),
            "language": info.language,
            "language_probability": float(info.language_probability),
            "segments": segment_items,
            "model": self.model_name,
            "device": self.device,
            "compute_type": self.active_compute_type,
            "cuda_runtime_path": self.cuda_runtime_path,
        }

    def analyze_sentiment(self, text: str) -> Dict:
        if not self.enable_sentiment or self.sentiment_pipeline is None:
            raise RuntimeError("Sentiment is disabled for this SpeechStack instance.")

        if not text or not text.strip():
            return {"label": "NEUTRAL", "score": 0.0}

        def classify_piece(piece: str) -> Tuple[str, float]:
            result = self.sentiment_pipeline(piece)
            if not result:
                return "NEUTRAL", 0.0

            raw_label = self._normalize_sentiment_label(result[0].get("label", ""))
            raw_score = float(result[0].get("score", 0.0))
            if raw_label != "NEUTRAL" and raw_score < self.neutral_threshold:
                return "NEUTRAL", raw_score
            return raw_label, raw_score

        # Base signal: trailing window (recent speech dominates in live mode).
        sentiment_input = text[-512:]
        base_label, base_score = classify_piece(sentiment_input)

        # Add recency-weighted sentence signals to avoid early positive text
        # masking later negative turns.
        pieces: List[Tuple[str, float]] = [(base_label, base_score)]
        sentences = [
            s.strip()
            for s in re.split(r"(?<=[.!?])\s+", text)
            if s and s.strip()
        ]
        recent_sentences = sentences[-4:]
        for sentence in recent_sentences:
            sample = sentence[-512:]
            pieces.append(classify_piece(sample))

        # Strongly favor the latest spoken sentence in streaming contexts.
        if sentences:
            last_label, last_score = classify_piece(sentences[-1][-512:])
            if last_label == "NEGATIVE" and last_score >= self.neutral_threshold:
                return {"label": "NEGATIVE", "score": last_score}
            if last_label == "POSITIVE" and last_score >= 0.9:
                return {"label": "POSITIVE", "score": last_score}

        weighted_sum = 0.0
        total_weight = 0.0
        for idx, (label, score) in enumerate(pieces):
            weight = float((idx + 1) ** 2)
            polarity = 0.0
            if label == "POSITIVE":
                polarity = score
            elif label == "NEGATIVE":
                polarity = -score

            weighted_sum += polarity * weight
            total_weight += weight

        if total_weight == 0:
            return {"label": "NEUTRAL", "score": 0.0}

        aggregate = weighted_sum / total_weight
        if aggregate > 0.15:
            return {"label": "POSITIVE", "score": min(abs(aggregate), 1.0)}
        if aggregate < -0.15:
            return {"label": "NEGATIVE", "score": min(abs(aggregate), 1.0)}
        return {"label": "NEUTRAL", "score": min(abs(aggregate), 1.0)}

    def transcribe_with_sentiment(self, audio: AudioInput) -> Dict:
        transcription = self.transcribe(audio)

        overall = {"label": "NEUTRAL", "score": 0.0}
        if self.enable_sentiment and self.sentiment_pipeline is not None:
            overall = self.analyze_sentiment(transcription["text"])

        segment_results = []
        for item in transcription["segments"]:
            text = item["text"]
            sentiment = {"label": "NEUTRAL", "score": 0.0}
            if self.enable_sentiment and self.sentiment_pipeline is not None:
                sentiment = self.analyze_sentiment(text)

            segment_results.append(
                {
                    "start": item["start"],
                    "end": item["end"],
                    "text": text,
                    "sentiment": sentiment,
                }
            )

        return {
            "transcription": transcription,
            "overall_sentiment": overall,
            "segment_sentiment": segment_results,
        }

    def list_tts_voices(self) -> List[Dict]:
        try:
            import pyttsx3
        except ImportError as exc:
            raise RuntimeError(
                "TTS requires pyttsx3. Install it in your app environment."
            ) from exc

        engine = pyttsx3.init()
        try:
            voices = []
            for voice in engine.getProperty("voices"):
                voices.append(
                    {
                        "id": voice.id,
                        "name": voice.name,
                        "languages": [str(lang) for lang in getattr(voice, "languages", [])],
                    }
                )
            return voices
        finally:
            engine.stop()

    def synthesize_tts(
        self,
        text: str,
        rate: int = 175,
        volume: float = 1.0,
        voice_id: Optional[str] = None,
    ) -> bytes:
        if not text or not text.strip():
            raise ValueError("TTS text is empty.")

        try:
            import pyttsx3
        except ImportError as exc:
            raise RuntimeError(
                "TTS requires pyttsx3. Install it in your app environment."
            ) from exc

        with self._tts_lock:
            engine = pyttsx3.init()
            engine.setProperty("rate", int(rate))
            engine.setProperty("volume", max(0.0, min(float(volume), 1.0)))
            if voice_id:
                engine.setProperty("voice", voice_id)

            temp_path = None
            try:
                with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                    temp_path = tmp.name

                engine.save_to_file(text, temp_path)
                engine.runAndWait()

                with open(temp_path, "rb") as file_obj:
                    return file_obj.read()
            finally:
                engine.stop()
                if temp_path and os.path.exists(temp_path):
                    os.remove(temp_path)
