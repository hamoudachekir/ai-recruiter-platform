import io
import os
import tempfile

from typing import Annotated, Optional

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, StreamingResponse
from pydantic import BaseModel, Field

from speech_stack import SpeechStack

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


@app.on_event("startup")
def startup() -> None:
    global speech_stack, startup_error

    try:
        speech_stack = SpeechStack(
            model_name=os.getenv("FW_MODEL", "small.en"),
            device=os.getenv("FW_DEVICE", "cuda"),
            compute_type=os.getenv("FW_COMPUTE_TYPE", "int8"),
            language=os.getenv("FW_LANGUAGE", "en"),
            beam_size=int(os.getenv("FW_BEAM_SIZE", "3")),
            neutral_threshold=float(os.getenv("FW_NEUTRAL_THRESHOLD", "0.65")),
            enable_sentiment=True,
        )
        startup_error = None
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
        "model": speech_stack.model_name,
        "device": speech_stack.device,
        "compute_type": speech_stack.active_compute_type,
        "cuda_runtime_path": speech_stack.cuda_runtime_path,
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

    try:
        return _run_with_temp_audio(payload, upload.filename, stack.transcribe)
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

    try:
        return _run_with_temp_audio(payload, upload.filename, stack.transcribe_with_sentiment)
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


@app.post(
    "/api/tts",
    responses={
        500: {"description": "Internal error while generating TTS audio."},
        503: {"description": "Speech stack is not initialized."},
    },
)
def tts(request: TtsRequest):
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
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return StreamingResponse(
        io.BytesIO(wav_bytes),
        media_type="audio/wav",
        headers={"Content-Disposition": "inline; filename=tts.wav"},
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8012, reload=False)
