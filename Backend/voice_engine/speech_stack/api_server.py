import io
import json
import os
import sys
import tempfile

from typing import Annotated, AsyncGenerator, Optional

try:
    import edge_tts as _edge_tts
    _EDGE_TTS_OK = True
except ImportError:
    _EDGE_TTS_OK = False

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, StreamingResponse
from pydantic import BaseModel, Field
from dotenv import load_dotenv

try:
    from .speech_stack import SpeechStack
except ImportError:
    # Support direct execution: `python api_server.py`
    current_dir = os.path.dirname(os.path.abspath(__file__))
    if current_dir not in sys.path:
        sys.path.insert(0, current_dir)
    from speech_stack import SpeechStack

# Load environment variables from repo root (.env) and optional local overrides.
_CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(_CURRENT_DIR)))
load_dotenv(os.path.join(_REPO_ROOT, ".env"), override=False)
load_dotenv(os.path.join(_CURRENT_DIR, ".env"), override=True)

app = FastAPI(title="Voice Engine Speech Stack API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:5174",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
    allow_origin_regex=r"^http://(localhost|127\.0\.0\.1)(:\\d+)?$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

speech_stack: Optional[SpeechStack] = None
startup_error: Optional[str] = None


def _env_bool(name: str, default: bool) -> bool:
    raw = str(os.getenv(name, "1" if default else "0") or "").strip().lower()
    return raw in {"1", "true", "yes", "on"}


def _env_language_default() -> Optional[str]:
    raw = str(os.getenv("FW_LANGUAGE", "auto") or "").strip().lower()
    if raw in {"", "auto", "none"}:
        return None
    return raw


def _env_preload_tts_default() -> bool:
    raw = str(os.getenv("FW_PRELOAD_TTS", "1") or "").strip().lower()
    return raw in {"1", "true", "yes", "on"}


def _safe_upload_suffix(filename: Optional[str]) -> str:
    if not filename:
        return ".webm"

    _, ext = os.path.splitext(filename)
    ext = (ext or "").strip().lower()
    if not ext:
        return ".webm"

    # Keep suffix small and predictable for temp file creation.
    if len(ext) > 10 or any(ch in ext for ch in ('/', '\\', ':')):
        return ".webm"

    return ext


def _parse_custom_terms(raw: Optional[str]) -> list[str]:
    if not raw:
        return []

    try:
        payload = json.loads(raw)
    except Exception:
        payload = [item.strip() for item in str(raw).split(",")]

    if not isinstance(payload, list):
        return []

    terms: list[str] = []
    seen: set[str] = set()
    for item in payload:
        term = str(item or "").strip()
        if not term or len(term) < 2 or len(term) > 64:
            continue
        lower = term.lower()
        if lower in seen:
            continue
        seen.add(lower)
        terms.append(term)

    return terms[:120]


def _run_with_temp_audio(payload: bytes, filename: Optional[str], fn) -> dict:
    suffix = _safe_upload_suffix(filename)
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp.write(payload)
            temp_path = tmp.name

        return fn(temp_path)
    finally:
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)


class SentimentRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=5000)


class TtsRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=5000)
    rate: int = 175
    volume: float = 1.0
    voice_id: Optional[str] = None
    language: Optional[str] = None
    provider: Optional[str] = None


@app.on_event("startup")
def startup() -> None:
    global speech_stack, startup_error

    try:
        speech_stack = SpeechStack(
            model_name=os.getenv("FW_MODEL", "distil-large-v3"),
            device=os.getenv("FW_DEVICE", "cuda"),
            compute_type=os.getenv("FW_COMPUTE_TYPE", "int8_float16"),
            language=_env_language_default(),
            beam_size=int(os.getenv("FW_BEAM_SIZE", "1")),
            neutral_threshold=float(os.getenv("FW_NEUTRAL_THRESHOLD", "0.65")),
            enable_sentiment=True,
            enable_transcript_correction=_env_bool("FW_ENABLE_TRANSCRIPT_CORRECTION", True),
            correction_confidence_threshold=float(os.getenv("FW_CORRECTION_CONFIDENCE_THRESHOLD", "0.98")),
            correction_dictionary_path=os.getenv("FW_CORRECTION_DICTIONARY_PATH", "") or None,
        )
        startup_error = None
        if _env_preload_tts_default():
            try:
                speech_stack.warm_tts()
            except Exception as exc:
                startup_error = f"TTS warmup skipped: {exc}"
    except Exception as exc:
        speech_stack = None
        startup_error = str(exc)


def require_stack() -> SpeechStack:
    stack = speech_stack
    if stack is None:
        detail = "Speech stack is not ready."
        if startup_error:
            detail += f" Startup error: {startup_error}"
        raise RuntimeError(detail)
    return stack


@app.get("/health")
def health() -> dict:
    if speech_stack is None:
        return {
            "status": "error",
            "ready": False,
            "error": startup_error,
        }

    return {
        "status": "ok",
        "ready": True,
        "warning": startup_error,
        "model": speech_stack.model_name,
        "device": speech_stack.device,
        "compute_type": speech_stack.active_compute_type,
        "cuda_runtime_path": speech_stack.cuda_runtime_path,
        "tts_provider": speech_stack.tts_provider,
        "tts_model": speech_stack.elevenlabs_model_id,
        "tts_preloaded": True,
    }


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    return """
<!doctype html>
<html>
<head>
  <meta charset=\"utf-8\" />
  <title>Voice Engine Speech Stack</title>
  <style>
    body { font-family: Segoe UI, sans-serif; max-width: 920px; margin: 24px auto; }
    h1 { margin-bottom: 8px; }
    .row { margin: 12px 0; }
    button { margin-right: 8px; padding: 10px 14px; }
    textarea { width: 100%; min-height: 96px; }
    pre { background: #f4f6f8; padding: 12px; overflow-x: auto; }
  </style>
</head>
<body>
  <h1>Voice Engine Speech Stack</h1>
  <p>Record with microphone, transcribe, analyze sentiment, then generate TTS.</p>

  <div class=\"row\">
    <button id=\"startBtn\">Start Recording</button>
    <button id=\"stopBtn\" disabled>Stop Recording</button>
    <span id=\"status\">Idle</span>
  </div>

  <div class=\"row\">
    <strong>Transcription + Sentiment</strong>
    <pre id=\"result\">No data yet.</pre>
  </div>

  <div class=\"row\">
    <strong>Text to Speech</strong>
    <textarea id=\"ttsText\" placeholder=\"Type text to synthesize...\"></textarea>
    <button id=\"ttsBtn\">Generate TTS</button>
    <audio id=\"ttsAudio\" controls></audio>
  </div>

  <script>
    let mediaRecorder = null;
    let chunks = [];

    const statusEl = document.getElementById('status');
    const resultEl = document.getElementById('result');
    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');

    startBtn.onclick = async () => {
      chunks = [];
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream);

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };

      mediaRecorder.onstop = async () => {
        statusEl.textContent = 'Uploading audio...';
        const blob = new Blob(chunks, { type: 'audio/webm' });
        const formData = new FormData();
        formData.append('audio', blob, 'recording.webm');

        try {
          const response = await fetch('/api/transcribe-sentiment', {
            method: 'POST',
            body: formData,
          });
          const data = await response.json();
          resultEl.textContent = JSON.stringify(data, null, 2);
          statusEl.textContent = 'Done';

          const fullText = data?.transcription?.text || '';
          document.getElementById('ttsText').value = fullText;
        } catch (error) {
          resultEl.textContent = String(error);
          statusEl.textContent = 'Failed';
        }
      };

      mediaRecorder.start();
      statusEl.textContent = 'Recording...';
      startBtn.disabled = true;
      stopBtn.disabled = false;
    };

    stopBtn.onclick = () => {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
      }
      startBtn.disabled = false;
      stopBtn.disabled = true;
      statusEl.textContent = 'Processing...';
    };

    document.getElementById('ttsBtn').onclick = async () => {
      const text = document.getElementById('ttsText').value.trim();
      if (!text) {
        statusEl.textContent = 'TTS text is empty';
        return;
      }

      statusEl.textContent = 'Generating TTS...';
      try {
        const response = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        });

        if (!response.ok) {
          const err = await response.json();
          throw new Error(err.detail || 'TTS failed');
        }

        const audioBlob = await response.blob();
        const audioUrl = URL.createObjectURL(audioBlob);
        const audioEl = document.getElementById('ttsAudio');
        audioEl.src = audioUrl;
        audioEl.play();
        statusEl.textContent = 'TTS ready';
      } catch (error) {
        statusEl.textContent = 'TTS failed';
        resultEl.textContent = String(error);
      }
    };
  </script>
</body>
</html>
"""


@app.post(
    "/api/transcribe",
    responses={
        400: {"description": "Audio payload is empty."},
        500: {"description": "Internal error while transcribing audio."},
        503: {"description": "Speech stack is not initialized."},
    },
)
async def transcribe(
    audio: Annotated[Optional[UploadFile], File()] = None,
    audio_file: Annotated[Optional[UploadFile], File()] = None,
    custom_terms: Annotated[Optional[str], Form()] = None,
) -> dict:
    try:
        stack = require_stack()
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    upload = audio or audio_file
    if upload is None:
        raise HTTPException(status_code=422, detail="Missing audio upload field. Use 'audio' or 'audio_file'.")

    payload = await upload.read()
    if not payload:
        raise HTTPException(status_code=400, detail="Audio payload is empty.")

    terms = _parse_custom_terms(custom_terms)

    try:
        return _run_with_temp_audio(
            payload,
            upload.filename,
            lambda temp_path: stack.transcribe(temp_path, custom_terms=terms),
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post(
    "/api/transcribe-sentiment",
    responses={
        400: {"description": "Audio payload is empty."},
        500: {"description": "Internal error while transcribing audio."},
        503: {"description": "Speech stack is not initialized."},
    },
)
async def transcribe_sentiment(
    audio: Annotated[Optional[UploadFile], File()] = None,
    audio_file: Annotated[Optional[UploadFile], File()] = None,
    custom_terms: Annotated[Optional[str], Form()] = None,
) -> dict:
    try:
        stack = require_stack()
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    upload = audio or audio_file
    if upload is None:
        raise HTTPException(status_code=422, detail="Missing audio upload field. Use 'audio' or 'audio_file'.")

    payload = await upload.read()
    if not payload:
        raise HTTPException(status_code=400, detail="Audio payload is empty.")

    terms = _parse_custom_terms(custom_terms)

    try:
        return _run_with_temp_audio(
            payload,
            upload.filename,
            lambda temp_path: stack.transcribe_with_sentiment(temp_path, custom_terms=terms),
        )
    except Exception as exc:
        # Realtime MediaRecorder chunks can intermittently be undecodable;
        # return a safe empty payload so the client can continue streaming.
        message = str(exc)
        return {
            "transcription": {
                "text": "",
                "language": stack.language or "en",
                "language_probability": 0.0,
                "segments": [],
                "model": stack.model_name,
                "device": stack.device,
                "compute_type": stack.active_compute_type,
                "cuda_runtime_path": stack.cuda_runtime_path,
            },
            "overall_sentiment": {"label": "NEUTRAL", "score": 0.0},
            "segment_sentiment": [],
            "warning": f"Skipped audio chunk: {message}",
        }


@app.post(
    "/api/sentiment",
    responses={
        500: {"description": "Internal error while analyzing sentiment."},
        503: {"description": "Speech stack is not initialized."},
    },
)
def sentiment(request: SentimentRequest) -> dict:
    try:
        stack = require_stack()
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    try:
        return stack.analyze_sentiment(request.text)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get(
    "/api/voices",
    responses={
        500: {"description": "Internal error while reading TTS voices."},
        503: {"description": "Speech stack is not initialized."},
    },
)
def tts_voices() -> dict:
    try:
        stack = require_stack()
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    try:
        return {"voices": stack.list_tts_voices()}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


async def _edge_tts_stream(text: str) -> AsyncGenerator[bytes, None]:
    """Stream MP3 audio chunks from Microsoft Edge TTS."""
    voice = os.getenv("EDGE_TTS_VOICE", "en-US-EmmaNeural")
    rate  = os.getenv("EDGE_TTS_RATE",  "+5%")
    comm = _edge_tts.Communicate(text, voice, rate=rate)
    async for chunk in comm.stream():
        if chunk["type"] == "audio":
            yield chunk["data"]


@app.post(
    "/api/tts",
    responses={
        500: {"description": "Internal error while generating TTS audio."},
        503: {"description": "Speech stack is not initialized."},
    },
)
async def tts(request: TtsRequest):
    provider = str(request.provider or "").strip().lower()
    force_edge = provider in {"edge", "edge_tts", "microsoft_edge"}

    # Default to ElevenLabs. Edge TTS is only used when the client explicitly
    # asks for it, so installed optional packages cannot silently override the
    # configured voice provider.
    if force_edge:
        if not _EDGE_TTS_OK:
            raise HTTPException(
                status_code=503,
                detail="Edge TTS provider requested but edge-tts package is not installed on speech stack server.",
            )
        try:
            return StreamingResponse(
                _edge_tts_stream(request.text),
                media_type="audio/mpeg",
                headers={"Content-Disposition": "inline; filename=tts.mp3"},
            )
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Edge TTS failed: {exc}") from exc

    # ── ElevenLabs fallback ───────────────────────────────────────────────
    try:
        stack = require_stack()
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    try:
        wav_bytes = stack.synthesize_tts(
            text=request.text,
            rate=request.rate,
            volume=request.volume,
            voice_id=request.voice_id,
            language=request.language,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    is_mp3 = wav_bytes[:3] == b"ID3" or wav_bytes[:2] == b"\xff\xfb"
    media_type = "audio/mpeg" if is_mp3 else "audio/wav"
    return StreamingResponse(
        io.BytesIO(wav_bytes),
        media_type=media_type,
        headers={"Content-Disposition": f"inline; filename={'tts.mp3' if is_mp3 else 'tts.wav'}"},
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8012, reload=False)
