import io
import json
import os
import tempfile
import threading
import re
import wave
import contextlib

from typing import Any, BinaryIO, Dict, List, Optional, Tuple, Union

import httpx
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
        beam_size: int = 1,
        vad_filter: bool = True,
        sentiment_model: str = "cardiffnlp/twitter-roberta-base-sentiment-latest",
        neutral_threshold: float = 0.65,
        enable_sentiment: bool = True,
        enable_transcript_correction: bool = True,
        correction_confidence_threshold: float = 0.98,
        correction_dictionary_path: Optional[str] = None,
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
        self.enable_transcript_correction = bool(enable_transcript_correction)
        self.correction_confidence_threshold = max(0.0, min(float(correction_confidence_threshold), 1.0))
        self.correction_dictionary_path = correction_dictionary_path or os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            "correction_dictionary.json",
        )
        self.correction_dictionary = self._load_correction_dictionary(self.correction_dictionary_path)

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
        self._xtts_model = None
        self._xtts_speaker_cache: Dict[str, Tuple[Any, Any]] = {}
        self.tts_provider = str(os.getenv("FW_TTS_PROVIDER", "xtts_v2") or "xtts_v2").strip().lower()
        self.tts_model_name = str(
            os.getenv(
                "FW_TTS_MODEL",
                "tts_models/multilingual/multi-dataset/xtts_v2",
            )
            or "tts_models/multilingual/multi-dataset/xtts_v2"
        ).strip()
        self.tts_default_language = str(os.getenv("FW_TTS_LANGUAGE", "en") or "en").strip().lower() or "en"
        self.tts_default_speaker_wav = str(os.getenv("FW_TTS_SPEAKER_WAV", "") or "").strip() or None
        self.tts_speaker_dir = str(os.getenv("FW_TTS_SPEAKER_DIR", "") or "").strip() or None
        self.tts_use_gpu = str(os.getenv("FW_TTS_USE_GPU", "auto") or "auto").strip().lower()
        self.tts_speed = max(0.85, min(float(os.getenv("FW_TTS_SPEED", "1.12") or "1.12"), 1.35))

        # ── ElevenLabs settings (used when tts_provider == "elevenlabs") ──────
        self.elevenlabs_api_key = str(os.getenv("ELEVENLABS_API_KEY", "") or "").strip()
        # Default: "Rachel" – a clear, neutral English voice available on the
        # free tier.  Override with any voice ID from your ElevenLabs dashboard.
        self.elevenlabs_voice_id = str(
            os.getenv("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM") or "21m00Tcm4TlvDq8ikWAM"
        ).strip()
        # eleven_flash_v2_5 = fast + low-latency; eleven_multilingual_v2 = higher quality
        self.elevenlabs_model_id = str(
            os.getenv("ELEVENLABS_MODEL_ID", "eleven_flash_v2_5") or "eleven_flash_v2_5"
        ).strip()
        self.elevenlabs_stability = max(
            0.0, min(float(os.getenv("ELEVENLABS_STABILITY", "0.5") or "0.5"), 1.0)
        )
        self.elevenlabs_similarity_boost = max(
            0.0, min(float(os.getenv("ELEVENLABS_SIMILARITY_BOOST", "0.75") or "0.75"), 1.0)
        )
        self.elevenlabs_fallback_to_xtts = str(
            os.getenv("ELEVENLABS_FALLBACK_TO_XTTS", "1") or "1"
        ).strip().lower() in {"1", "true", "yes", "on"}
        # ─────────────────────────────────────────────────────────────────────

        if not self.tts_default_speaker_wav:
            self.tts_default_speaker_wav = self._discover_default_speaker_wav()

    @staticmethod
    def _is_usable_speaker_audio(file_path: str) -> bool:
        if not file_path or not os.path.isfile(file_path):
            return False

        try:
            if os.path.getsize(file_path) < 2048:
                return False
        except Exception:
            return False

        ext = os.path.splitext(file_path)[1].lower()
        if ext != ".wav":
            return True

        try:
            with contextlib.closing(wave.open(file_path, "rb")) as wav_file:
                frames = int(wav_file.getnframes())
                sample_rate = int(wav_file.getframerate())
                if frames <= 0 or sample_rate <= 0:
                    return False
                duration = frames / float(sample_rate)
                return duration >= 0.8
        except Exception:
            return False

    @staticmethod
    def _select_latest_audio_file(directory: Optional[str]) -> Optional[str]:
        if not directory or not os.path.isdir(directory):
            return None

        candidates = []
        for entry in os.listdir(directory):
            full_path = os.path.join(directory, entry)
            if not os.path.isfile(full_path):
                continue
            ext = os.path.splitext(entry)[1].lower()
            if ext not in {".wav", ".mp3", ".flac", ".m4a", ".ogg"}:
                continue
            if not SpeechStack._is_usable_speaker_audio(full_path):
                continue
            candidates.append(full_path)

        if not candidates:
            return None

        return max(candidates, key=lambda path: os.path.getmtime(path))

    def _discover_default_speaker_wav(self) -> Optional[str]:
        candidates = []
        if self.tts_speaker_dir:
            candidates.append(self.tts_speaker_dir)

        backend_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        candidates.extend(
            [
                os.path.join(backend_root, "server", "voice-recordings"),
                os.path.join(backend_root, "voice_engine", "_runtime_logs"),
            ]
        )

        for directory in candidates:
            selected = self._select_latest_audio_file(directory)
            if selected:
                return selected

        return None

    @staticmethod
    def _normalize_term(term: str) -> str:
        return re.sub(r"\s+", " ", str(term or "")).strip()

    def _load_correction_dictionary(self, path: Optional[str]) -> Dict[str, Any]:
        if not path:
            return {"replacements": {}, "aliases": {}}

        try:
            with open(path, "r", encoding="utf-8") as fh:
                payload = json.load(fh)
            if not isinstance(payload, dict):
                return {"replacements": {}, "aliases": {}}

            replacements_raw = payload.get("replacements") or {}
            aliases_raw = payload.get("aliases") or {}
            replacements: Dict[str, str] = {}
            aliases: Dict[str, List[str]] = {}

            if isinstance(replacements_raw, dict):
                for key, value in replacements_raw.items():
                    src = self._normalize_term(str(key))
                    dst = self._normalize_term(str(value))
                    if src and dst and src.lower() != dst.lower():
                        replacements[src] = dst

            if isinstance(aliases_raw, dict):
                for canonical, values in aliases_raw.items():
                    canon = self._normalize_term(str(canonical))
                    if not canon:
                        continue
                    bag: List[str] = []
                    if isinstance(values, list):
                        for alias in values:
                            norm = self._normalize_term(str(alias))
                            if norm and norm.lower() != canon.lower():
                                bag.append(norm)
                    aliases[canon] = sorted(set(bag), key=lambda item: (len(item), item.lower()), reverse=True)

            return {"replacements": replacements, "aliases": aliases}
        except Exception:
            return {"replacements": {}, "aliases": {}}

    @staticmethod
    def _term_boundary_pattern(term: str) -> re.Pattern:
        return re.compile(rf"(?<!\\w){re.escape(term)}(?!\\w)", re.IGNORECASE)

    def _build_custom_term_aliases(self, canonical: str) -> List[str]:
        term = self._normalize_term(canonical)
        if len(term) < 2:
            return []

        variants = {
            term.lower(),
            re.sub(r"[\./_-]+", " ", term).lower().strip(),
            re.sub(r"[^a-zA-Z0-9]+", "", term).lower().strip(),
        }

        return [
            item
            for item in sorted(variants, key=lambda v: (len(v), v), reverse=True)
            if item and item != term.lower() and len(item) >= 2
        ]

    def _build_vocabulary_rules(self, custom_terms: Optional[List[str]]) -> List[Dict[str, Any]]:
        replacements = dict(self.correction_dictionary.get("replacements") or {})
        aliases = {
            key: list(value)
            for key, value in (self.correction_dictionary.get("aliases") or {}).items()
            if isinstance(value, list)
        }

        for term in custom_terms or []:
            canonical = self._normalize_term(term)
            if not canonical or len(canonical) < 2 or len(canonical) > 64:
                continue
            aliases.setdefault(canonical, [])
            for generated in self._build_custom_term_aliases(canonical):
                if generated.lower() != canonical.lower():
                    aliases[canonical].append(generated)

        rules: List[Dict[str, Any]] = []

        for wrong, right in replacements.items():
            rules.append(
                {
                    "name": f"dict_replace:{wrong}",
                    "pattern": self._term_boundary_pattern(wrong),
                    "replacement": right,
                    "mode": "low_confidence",
                }
            )

        for canonical, alias_list in aliases.items():
            unique_aliases = sorted(
                {
                    self._normalize_term(alias)
                    for alias in alias_list
                    if self._normalize_term(alias)
                    and self._normalize_term(alias).lower() != canonical.lower()
                },
                key=lambda value: (len(value), value.lower()),
                reverse=True,
            )

            for alias in unique_aliases:
                rules.append(
                    {
                        "name": f"dict_alias:{alias}->{canonical}",
                        "pattern": self._term_boundary_pattern(alias),
                        "replacement": canonical,
                        "mode": "low_confidence",
                    }
                )

        return rules

    def _build_transcript_rules(self, custom_terms: Optional[List[str]] = None) -> List[Dict[str, Any]]:
        # Conservative rules (always allowed): punctuation/spacing cleanup.
        rules: List[Dict[str, Any]] = [
            {
                "name": "collapse_spaces",
                "pattern": re.compile(r"\s+"),
                "replacement": " ",
                "mode": "always",
            },
            {
                "name": "remove_space_before_punctuation",
                "pattern": re.compile(r"\s+([,.;:!?])"),
                "replacement": r"\1",
                "mode": "always",
            },
        ]

        # Aggressive rules are applied only on lower-confidence transcript output.
        rules.extend(
            [
                {
                    "name": "fix_worker_patch_phrase",
                    "pattern": re.compile(r"\bthe world corps patch\b", re.IGNORECASE),
                    "replacement": "the worker patch",
                    "mode": "low_confidence",
                },
                {
                    "name": "fix_i_will_rewired",
                    "pattern": re.compile(r"\bi will rewired\b", re.IGNORECASE),
                    "replacement": "I will rewire",
                    "mode": "low_confidence",
                },
                {
                    "name": "fix_i_am_validated_links",
                    "pattern": re.compile(r"\bi am validated links\b", re.IGNORECASE),
                    "replacement": "I am validating next",
                    "mode": "low_confidence",
                },
            ]
        )

        rules.extend(self._build_vocabulary_rules(custom_terms))

        return rules

    def _apply_transcript_corrections(
        self,
        text: str,
        language: Optional[str],
        language_probability: float,
        custom_terms: Optional[List[str]] = None,
    ) -> Tuple[str, List[Dict[str, str]]]:
        if not self.enable_transcript_correction:
            return text, []

        # Keep corrections focused on English output to minimize false rewrites.
        lang = (language or "").strip().lower()
        if lang and not lang.startswith("en"):
            return text, []

        rules = self._build_transcript_rules(custom_terms=custom_terms)
        corrected = text
        applied: List[Dict[str, str]] = []
        low_confidence = float(language_probability) <= self.correction_confidence_threshold

        for rule in rules:
            mode = str(rule.get("mode", "always"))
            if mode == "low_confidence" and not low_confidence:
                continue

            pattern = rule["pattern"]
            replacement = str(rule["replacement"])
            updated = pattern.sub(replacement, corrected)
            if updated != corrected:
                applied.append(
                    {
                        "rule": str(rule.get("name", "unnamed_rule")),
                        "before": corrected,
                        "after": updated,
                    }
                )
                corrected = updated

        return corrected.strip(), applied

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

    def transcribe(self, audio: AudioInput, custom_terms: Optional[List[str]] = None) -> Dict:
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
        all_applied_rules: List[Dict[str, Any]] = []
        for segment in segments:
            raw_text = segment.text.strip()
            corrected_text, applied_rules = self._apply_transcript_corrections(
                raw_text,
                info.language,
                float(info.language_probability),
                custom_terms=custom_terms,
            )
            segment_items.append(
                {
                    "start": float(segment.start),
                    "end": float(segment.end),
                    "text": corrected_text,
                    "raw_text": raw_text,
                }
            )
            if corrected_text:
                texts.append(corrected_text)
            if applied_rules:
                all_applied_rules.extend(applied_rules)

        full_text_raw = " ".join(texts).strip()
        full_text_corrected, full_text_rules = self._apply_transcript_corrections(
            full_text_raw,
            info.language,
            float(info.language_probability),
            custom_terms=custom_terms,
        )
        if full_text_rules:
            all_applied_rules.extend(full_text_rules)

        return {
            "text": full_text_corrected,
            "language": info.language,
            "language_probability": float(info.language_probability),
            "segments": segment_items,
            "model": self.model_name,
            "device": self.device,
            "compute_type": self.active_compute_type,
            "cuda_runtime_path": self.cuda_runtime_path,
            "transcript_correction": {
                "enabled": self.enable_transcript_correction,
                "confidence_threshold": self.correction_confidence_threshold,
                "applied": len(all_applied_rules),
                "rules": [item.get("rule", "") for item in all_applied_rules][-20:],
                "custom_terms_count": len(custom_terms or []),
            },
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

    def transcribe_with_sentiment(self, audio: AudioInput, custom_terms: Optional[List[str]] = None) -> Dict:
        transcription = self.transcribe(audio, custom_terms=custom_terms)

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
        if self.tts_provider == "elevenlabs":
            return self._list_elevenlabs_voices()
        if self.tts_provider != "xtts_v2":
            raise RuntimeError(f"Unsupported TTS provider '{self.tts_provider}'.")

        voices: List[Dict[str, Any]] = []

        if self.tts_default_speaker_wav and os.path.isfile(self.tts_default_speaker_wav):
            voices.append(
                {
                    "id": "default",
                    "name": f"default ({os.path.basename(self.tts_default_speaker_wav)})",
                    "languages": [self.tts_default_language],
                    "speaker_wav": self.tts_default_speaker_wav,
                }
            )

        if self.tts_speaker_dir and os.path.isdir(self.tts_speaker_dir):
            for entry in sorted(os.listdir(self.tts_speaker_dir)):
                full_path = os.path.join(self.tts_speaker_dir, entry)
                if not os.path.isfile(full_path):
                    continue
                ext = os.path.splitext(entry)[1].lower()
                if ext not in {".wav", ".mp3", ".flac", ".m4a", ".ogg"}:
                    continue

                voice_id = os.path.splitext(entry)[0]
                voices.append(
                    {
                        "id": voice_id,
                        "name": voice_id,
                        "languages": [self.tts_default_language],
                        "speaker_wav": full_path,
                    }
                )

        if not voices:
            voices.append(
                {
                    "id": "xtts_v2",
                    "name": "XTTS v2 (set FW_TTS_SPEAKER_WAV or FW_TTS_SPEAKER_DIR for voice cloning)",
                    "languages": [self.tts_default_language],
                }
            )

        return voices

    # ── ElevenLabs helpers ────────────────────────────────────────────────────

    def _list_elevenlabs_voices(self) -> List[Dict]:
        """Fetch available voices from the ElevenLabs API."""
        if not self.elevenlabs_api_key:
            return [
                {
                    "id": self.elevenlabs_voice_id,
                    "name": "ElevenLabs (no API key – using configured voice ID)",
                    "languages": ["en"],
                }
            ]
        try:
            with httpx.Client(timeout=15.0) as client:
                resp = client.get(
                    "https://api.elevenlabs.io/v1/voices",
                    headers={"xi-api-key": self.elevenlabs_api_key},
                )
                resp.raise_for_status()
                data = resp.json()
            return [
                {
                    "id": v.get("voice_id", ""),
                    "name": v.get("name", ""),
                    "languages": ["en"],
                    "preview_url": v.get("preview_url"),
                }
                for v in data.get("voices", [])
            ]
        except Exception:
            return [
                {
                    "id": self.elevenlabs_voice_id,
                    "name": "ElevenLabs (voice list unavailable)",
                    "languages": ["en"],
                }
            ]

    def _synthesize_elevenlabs(
        self,
        text: str,
        voice_id: Optional[str] = None,
    ) -> bytes:
        """Call ElevenLabs REST API and return MP3 audio bytes."""
        if not self.elevenlabs_api_key:
            raise RuntimeError(
                "ELEVENLABS_API_KEY is not set. "
                "Get a free key at https://elevenlabs.io and set it in your .env."
            )
        vid = (voice_id or "").strip() or self.elevenlabs_voice_id
        url = f"https://api.elevenlabs.io/v1/text-to-speech/{vid}"
        payload = {
            "text": text,
            "model_id": self.elevenlabs_model_id,
            "voice_settings": {
                "stability": self.elevenlabs_stability,
                "similarity_boost": self.elevenlabs_similarity_boost,
            },
        }
        headers = {
            "xi-api-key": self.elevenlabs_api_key,
            "Content-Type": "application/json",
            "Accept": "audio/mpeg",
        }
        # ElevenLabs occasionally drops the connection mid-request or returns
        # 5xx under load. Retry up to 3 times with small backoff so a single
        # transient hiccup does not kill the candidate's voice for the turn.
        # Auth/4xx errors are NOT retried — they will not recover.
        import time as _time
        retryable_statuses = {500, 502, 503, 504}
        last_exc: Exception | None = None

        for attempt in range(3):
            try:
                with httpx.Client(timeout=30.0) as client:
                    resp = client.post(url, json=payload, headers=headers)
                    resp.raise_for_status()
                    return resp.content  # raw MP3 bytes
            except httpx.HTTPStatusError as exc:
                status = exc.response.status_code if exc.response is not None else 0
                last_exc = exc
                if status in retryable_statuses and attempt < 2:
                    _time.sleep(0.5 * (attempt + 1))
                    continue
                detail = (exc.response.text or "")[:300] if exc.response is not None else ""
                raise RuntimeError(
                    f"ElevenLabs TTS failed (HTTP {status}): {detail or exc}"
                ) from exc
            except httpx.HTTPError as exc:
                # Network-level error (connection reset, read timeout, etc.).
                last_exc = exc
                if attempt < 2:
                    _time.sleep(0.5 * (attempt + 1))
                    continue
                raise RuntimeError(f"ElevenLabs TTS request failed: {exc}") from exc

        raise RuntimeError(f"ElevenLabs TTS request failed after retries: {last_exc}")

    # ─────────────────────────────────────────────────────────────────────────

    def _load_xtts_model(self):
        try:
            from TTS.api import TTS
        except ImportError as exc:
            raise RuntimeError(
                "XTTS-v2 requires the 'TTS' package. Install it in your app environment."
            ) from exc

        use_gpu = self.device == "cuda"
        if self.tts_use_gpu in {"0", "false", "no", "off", "cpu"}:
            use_gpu = False
        elif self.tts_use_gpu in {"1", "true", "yes", "on", "cuda", "gpu"}:
            use_gpu = True

        try:
            return TTS(self.tts_model_name, gpu=use_gpu)
        except Exception as first_exc:
            if use_gpu:
                try:
                    return TTS(self.tts_model_name, gpu=False)
                except Exception as second_exc:
                    raise RuntimeError(
                        "Failed to load XTTS-v2 on GPU and CPU fallback. "
                        f"GPU error: {first_exc}; CPU error: {second_exc}"
                    ) from second_exc
            raise RuntimeError(f"Failed to load XTTS-v2 model: {first_exc}") from first_exc

    def _ensure_tts_model(self) -> None:
        if self._xtts_model is not None:
            return

        self._xtts_model = self._load_xtts_model()

    def warm_tts(self) -> None:
        """Preload the configured TTS provider so first playback is low-latency."""
        if self.tts_provider == "elevenlabs":
            # ElevenLabs is a cloud API; validate the key with a short voice-list call.
            if not self.elevenlabs_api_key:
                raise RuntimeError(
                    "ELEVENLABS_API_KEY is not configured. "
                    "Set it in your .env to use ElevenLabs TTS."
                )
            try:
                self._list_elevenlabs_voices()
            except Exception as exc:
                raise RuntimeError(f"ElevenLabs TTS warm-up check failed: {exc}") from exc
            return
        if self.tts_provider != "xtts_v2":
            raise RuntimeError(f"Unsupported TTS provider '{self.tts_provider}'.")
        with self._tts_lock:
            self._ensure_tts_model()
            if self.tts_default_speaker_wav and self._is_usable_speaker_audio(self.tts_default_speaker_wav):
                try:
                    self._get_xtts_conditioning(self.tts_default_speaker_wav)
                    self._prime_xtts_locked(self.tts_default_speaker_wav)
                except Exception:
                    # Keep startup resilient; synthesis can still retry with another voice/source.
                    self.tts_default_speaker_wav = None

    def _resolve_speaker_wav(self, voice_id: Optional[str]) -> str:
        if voice_id:
            voice_id = str(voice_id).strip()
            if not voice_id:
                voice_id = None

        if voice_id and self._is_usable_speaker_audio(voice_id):
            return voice_id

        if voice_id and self.tts_speaker_dir:
            for ext in (".wav", ".mp3", ".flac", ".m4a", ".ogg"):
                candidate = os.path.join(self.tts_speaker_dir, f"{voice_id}{ext}")
                if self._is_usable_speaker_audio(candidate):
                    return candidate

        if self.tts_default_speaker_wav and self._is_usable_speaker_audio(self.tts_default_speaker_wav):
            return self.tts_default_speaker_wav

        discovered = self._discover_default_speaker_wav()
        if discovered:
            self.tts_default_speaker_wav = discovered
            return discovered

        raise RuntimeError(
            "XTTS-v2 requires a reference speaker audio file. "
            "Set FW_TTS_SPEAKER_WAV to a valid file path or provide voice_id mapped under FW_TTS_SPEAKER_DIR."
        )

    def _get_xtts_conditioning(self, speaker_wav: str) -> Tuple[Any, Any]:
        cache_key = os.path.normcase(os.path.abspath(speaker_wav))
        cached = self._xtts_speaker_cache.get(cache_key)
        if cached is not None:
            return cached

        xtts_api = self._xtts_model
        synthesizer = getattr(xtts_api, "synthesizer", None)
        xtts_model = getattr(synthesizer, "tts_model", None)
        if xtts_model is None or not hasattr(xtts_model, "get_conditioning_latents"):
            raise RuntimeError("XTTS-v2 conditioning cache is unavailable on this runtime.")

        gpt_cond_latent, speaker_embedding = xtts_model.get_conditioning_latents(audio_path=speaker_wav)
        self._xtts_speaker_cache[cache_key] = (gpt_cond_latent, speaker_embedding)
        return gpt_cond_latent, speaker_embedding

    def _prime_xtts_locked(self, speaker_wav: str) -> None:
        prime_text = str(os.getenv("FW_TTS_PRIME_TEXT", "Ready.") or "").strip()
        if not prime_text or prime_text.lower() in {"0", "false", "no", "off", "none"}:
            return

        xtts_api = self._xtts_model
        synthesizer = getattr(xtts_api, "synthesizer", None)
        xtts_model = getattr(synthesizer, "tts_model", None)
        if xtts_model is None or not hasattr(xtts_model, "inference"):
            return

        try:
            gpt_cond_latent, speaker_embedding = self._get_xtts_conditioning(speaker_wav)
            xtts_model.inference(
                text=prime_text,
                language=self.tts_default_language or "en",
                gpt_cond_latent=gpt_cond_latent,
                speaker_embedding=speaker_embedding,
                speed=self.tts_speed,
                enable_text_splitting=False,
            )
        except Exception:
            # Priming is best-effort only; real synthesis still has its own fallback path.
            return

    @staticmethod
    def _float_audio_to_wav_bytes(audio: Any, sample_rate: int) -> bytes:
        wav = np.asarray(audio, dtype=np.float32)
        if wav.ndim > 1:
            wav = wav.reshape(-1)

        np.clip(wav, -1.0, 1.0, out=wav)
        pcm = (wav * 32767.0).astype(np.int16)

        with io.BytesIO() as output_io:
            with contextlib.closing(wave.open(output_io, "wb")) as out_wav:
                out_wav.setnchannels(1)
                out_wav.setsampwidth(2)
                out_wav.setframerate(int(sample_rate))
                out_wav.writeframes(pcm.tobytes())
            return output_io.getvalue()

    @staticmethod
    def _apply_wav_volume(wav_bytes: bytes, volume: float) -> bytes:
        factor = max(0.0, min(float(volume), 2.0))
        if abs(factor - 1.0) < 1e-3:
            return wav_bytes

        with io.BytesIO(wav_bytes) as source_io:
            with wave.open(source_io, "rb") as source_wav:
                params = source_wav.getparams()
                frames = source_wav.readframes(params.nframes)

        # Keep processing conservative for PCM 16-bit and return untouched bytes otherwise.
        if params.sampwidth != 2:
            return wav_bytes

        audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32)
        audio *= factor
        np.clip(audio, -32768, 32767, out=audio)
        out_frames = audio.astype(np.int16).tobytes()

        with io.BytesIO() as output_io:
            with wave.open(output_io, "wb") as out_wav:
                out_wav.setparams(params)
                out_wav.writeframes(out_frames)
            return output_io.getvalue()

    def synthesize_tts(
        self,
        text: str,
        rate: int = 175,
        volume: float = 1.0,
        voice_id: Optional[str] = None,
        language: Optional[str] = None,
    ) -> bytes:
        if not text or not text.strip():
            raise ValueError("TTS text is empty.")

        force_xtts_fallback = False

        # ── ElevenLabs path ───────────────────────────────────────────────────
        if self.tts_provider == "elevenlabs":
            try:
                mp3_bytes = self._synthesize_elevenlabs(text, voice_id=voice_id)
                # Convert MP3 → WAV so the rest of the pipeline (volume adjustment,
                # StreamingResponse with audio/wav) stays unchanged.
                try:
                    import audioop  # noqa: F401 – quick existence check
                except ImportError:
                    pass  # audioop is optional; pydub fallback below handles it
                try:
                    from pydub import AudioSegment  # type: ignore[import-untyped]
                    seg = AudioSegment.from_file(io.BytesIO(mp3_bytes), format="mp3")
                    seg = seg.set_channels(1).set_frame_rate(24000).set_sample_width(2)
                    wav_io = io.BytesIO()
                    seg.export(wav_io, format="wav")
                    wav_bytes = wav_io.getvalue()
                except ImportError:
                    # pydub not installed – return raw MP3 directly.
                    wav_bytes = mp3_bytes
                return self._apply_wav_volume(wav_bytes, volume) if not wav_bytes[:4] == b"ID3\x03" else wav_bytes
            except RuntimeError as exc:
                reason = str(exc).lower()
                paid_plan_restricted = (
                    "paid_plan_required" in reason
                    or "payment_required" in reason
                    or "http 402" in reason
                )
                if self.elevenlabs_fallback_to_xtts and (paid_plan_restricted or "elevenlabs tts failed" in reason):
                    force_xtts_fallback = True
                else:
                    raise

        # ── XTTS-v2 path ─────────────────────────────────────────────────────
        if self.tts_provider != "xtts_v2" and not force_xtts_fallback:
            raise RuntimeError(f"Unsupported TTS provider '{self.tts_provider}'.")

        tts_language = (language or self.tts_default_language or "en").strip().lower()
        speaker_wav = self._resolve_speaker_wav(voice_id)

        with self._tts_lock:
            self._ensure_tts_model()
            assert self._xtts_model is not None

            xtts_api = self._xtts_model
            synthesizer = getattr(xtts_api, "synthesizer", None)
            xtts_model = getattr(synthesizer, "tts_model", None)
            if synthesizer is not None and xtts_model is not None and hasattr(xtts_model, "inference"):
                try:
                    gpt_cond_latent, speaker_embedding = self._get_xtts_conditioning(speaker_wav)
                    inference = xtts_model.inference(
                        text=text,
                        language=tts_language,
                        gpt_cond_latent=gpt_cond_latent,
                        speaker_embedding=speaker_embedding,
                        speed=self.tts_speed,
                        enable_text_splitting=False,
                    )
                    sample_rate = int(getattr(synthesizer, "output_sample_rate", 24000) or 24000)
                    wav_bytes = self._float_audio_to_wav_bytes(inference.get("wav", []), sample_rate)
                    return self._apply_wav_volume(wav_bytes, volume)
                except Exception:
                    # Fall back to the higher-level Coqui API path if direct XTTS inference fails.
                    pass

            temp_path = None
            try:
                with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                    temp_path = tmp.name

                # XTTS controls speed differently from pyttsx3; keep legacy rate for API compatibility.
                _ = int(rate)
                self._xtts_model.tts_to_file(
                    text=text,
                    file_path=temp_path,
                    speaker_wav=speaker_wav,
                    language=tts_language,
                )

                with open(temp_path, "rb") as file_obj:
                    wav_bytes = file_obj.read()
                    return self._apply_wav_volume(wav_bytes, volume)
            finally:
                if temp_path and os.path.exists(temp_path):
                    os.remove(temp_path)
