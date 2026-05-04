import json
import os
import time
import wave
import math
import struct
import urllib.request
import urllib.error
from pathlib import Path
import subprocess

root = Path.cwd()
pyexe = r"c:/Users/hamou/OneDrive/Desktop/talan/ai-recruiter-platform/.venv/Scripts/python.exe"
log_dir = root / "Backend" / "voice_engine" / "_runtime_logs"
log_dir.mkdir(parents=True, exist_ok=True)

results = []

def log(msg):
    print(msg, flush=True)

speech_log = log_dir / "speech_stack.log"
agent_log = log_dir / "interview_agent.log"

speech_proc = None
agent_proc = None

try:
    env = os.environ.copy()
    env.update({
        "FW_DEVICE": "cpu",
        "FW_MODEL": "small.en",
        "FW_COMPUTE_TYPE": "int8",
        "FW_PRELOAD_TTS": "0",
    })
    sf = open(speech_log, "ab")
    speech_proc = subprocess.Popen(
        [pyexe, "-m", "uvicorn", "Backend.voice_engine.speech_stack.api_server:app", "--host", "127.0.0.1", "--port", "8012"],
        cwd=str(root), env=env, stdout=sf, stderr=subprocess.STDOUT
    )
    log(f"STEP4_OK pid={speech_proc.pid}")
except Exception as e:
    log(f"STEP4_FAIL {type(e).__name__}: {e}")

try:
    env2 = os.environ.copy()
    env2.update({
        "LLM_PROVIDER": "echo",
        "AGENT_PORT": "8013",
    })
    af = open(agent_log, "ab")
    agent_proc = subprocess.Popen(
        [pyexe, "-m", "uvicorn", "Backend.voice_engine.interview_agent.agent_server:app", "--host", "127.0.0.1", "--port", "8013"],
        cwd=str(root), env=env2, stdout=af, stderr=subprocess.STDOUT
    )
    log(f"STEP5_OK pid={agent_proc.pid}")
except Exception as e:
    log(f"STEP5_FAIL {type(e).__name__}: {e}")


def wait_health(url, step_name):
    deadline = time.time() + 60
    last_err = None
    while time.time() < deadline:
        try:
            req = urllib.request.Request(url, method="GET")
            with urllib.request.urlopen(req, timeout=5) as resp:
                body = resp.read().decode("utf-8", errors="replace")
                try:
                    obj = json.loads(body)
                except Exception:
                    obj = {"raw": body[:300]}
                log(f"{step_name}_OK {json.dumps(obj, ensure_ascii=False)}")
                return obj
        except Exception as e:
            last_err = e
            time.sleep(1)
    log(f"{step_name}_FAIL {type(last_err).__name__}: {last_err}")
    return None

speech_health = wait_health("http://127.0.0.1:8012/health", "STEP6_SPEECH_HEALTH")
agent_health = wait_health("http://127.0.0.1:8013/health", "STEP6_AGENT_HEALTH")

wav_path = log_dir / "test.wav"
try:
    fr = 16000
    dur = 1.0
    freq = 440.0
    n = int(fr * dur)
    with wave.open(str(wav_path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(fr)
        frames = bytearray()
        for i in range(n):
            s = int(0.25 * 32767 * math.sin(2 * math.pi * freq * i / fr))
            frames += struct.pack("<h", s)
        wf.writeframes(bytes(frames))
    log(f"STEP7_OK {wav_path}")
except Exception as e:
    log(f"STEP7_FAIL {type(e).__name__}: {e}")


def post_json(url, payload):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.getcode(), resp.read().decode("utf-8", errors="replace")


def post_multipart_audio(url, field, file_path):
    boundary = "----WebKitFormBoundary7MA4YWxkTrZu0gW"
    with open(file_path, "rb") as f:
        file_data = f.read()
    parts = []
    parts.append((f"--{boundary}\r\n").encode())
    parts.append((f'Content-Disposition: form-data; name="{field}"; filename="{Path(file_path).name}"\r\n').encode())
    parts.append(b"Content-Type: audio/wav\r\n\r\n")
    parts.append(file_data)
    parts.append(b"\r\n")
    parts.append((f"--{boundary}--\r\n").encode())
    body = b"".join(parts)
    headers = {"Content-Type": f"multipart/form-data; boundary={boundary}"}
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.getcode(), resp.read().decode("utf-8", errors="replace")

try:
    code, body = post_multipart_audio("http://127.0.0.1:8012/api/transcribe-sentiment", "audio", str(wav_path))
    obj = json.loads(body)
    text = obj.get("text") if isinstance(obj, dict) else None
    warn = obj.get("warning") if isinstance(obj, dict) else None
    sentiment = obj.get("sentiment") if isinstance(obj, dict) else None
    if isinstance(sentiment, dict):
        s_label = sentiment.get("label")
        s_score = sentiment.get("score")
    else:
        s_label = None
        s_score = None
    log(f"STEP8_TRANSCRIBE_OK status={code} text_len={len(text) if isinstance(text,str) else 0} warning={warn} sentiment={s_label}:{s_score}")
except urllib.error.HTTPError as e:
    snippet = e.read().decode("utf-8", errors="replace")[:300]
    log(f"STEP8_TRANSCRIBE_FAIL HTTPError: {e.code} {snippet}")
except Exception as e:
    log(f"STEP8_TRANSCRIBE_FAIL {type(e).__name__}: {e}")

try:
    code, body = post_json("http://127.0.0.1:8012/api/sentiment", {"text": "I am excited to join this role"})
    obj = json.loads(body)
    label = obj.get("label") if isinstance(obj, dict) else None
    score = obj.get("score") if isinstance(obj, dict) else None
    log(f"STEP8_SENTIMENT_OK status={code} label={label} score={score}")
except urllib.error.HTTPError as e:
    snippet = e.read().decode("utf-8", errors="replace")[:300]
    log(f"STEP8_SENTIMENT_FAIL HTTPError: {e.code} {snippet}")
except Exception as e:
    log(f"STEP8_SENTIMENT_FAIL {type(e).__name__}: {e}")

interview_id = "smoke-001"


def compact(obj):
    if not isinstance(obj, dict):
        return {"raw": str(obj)[:200]}
    out = {}
    for k in ["status", "action", "phase", "next_question", "recommendation", "interview_id", "session_id", "message"]:
        if k in obj:
            out[k] = obj.get(k)
    if "report" in obj and isinstance(obj["report"], dict):
        if "recommendation" in obj["report"]:
            out["report_recommendation"] = obj["report"].get("recommendation")
    return out

try:
    payload = {
        "interview_id": interview_id,
        "job_title": "Software Engineer",
        "skills": ["Python", "FastAPI"],
        "candidate_name": "Alex",
        "phase": "intro"
    }
    code, body = post_json("http://127.0.0.1:8013/session/start", payload)
    obj = json.loads(body)
    log(f"STEP9_START_OK status={code} {json.dumps(compact(obj), ensure_ascii=False)}")
except urllib.error.HTTPError as e:
    snippet = e.read().decode("utf-8", errors="replace")[:400]
    log(f"STEP9_START_FAIL HTTPError: {e.code} {snippet}")
except Exception as e:
    log(f"STEP9_START_FAIL {type(e).__name__}: {e}")

try:
    payload = {
        "interview_id": interview_id,
        "answer": "I built a scalable API using FastAPI and async workers.",
        "sentiment": {"label": "POSITIVE", "score": 0.9}
    }
    code, body = post_json("http://127.0.0.1:8013/session/turn", payload)
    obj = json.loads(body)
    log(f"STEP9_TURN_OK status={code} {json.dumps(compact(obj), ensure_ascii=False)}")
except urllib.error.HTTPError as e:
    snippet = e.read().decode("utf-8", errors="replace")[:400]
    log(f"STEP9_TURN_FAIL HTTPError: {e.code} {snippet}")
except Exception as e:
    log(f"STEP9_TURN_FAIL {type(e).__name__}: {e}")

try:
    payload = {"interview_id": interview_id, "phase": "technical"}
    code, body = post_json("http://127.0.0.1:8013/session/switch", payload)
    obj = json.loads(body)
    log(f"STEP9_SWITCH_OK status={code} {json.dumps(compact(obj), ensure_ascii=False)}")
except urllib.error.HTTPError as e:
    snippet = e.read().decode("utf-8", errors="replace")[:400]
    log(f"STEP9_SWITCH_FAIL HTTPError: {e.code} {snippet}")
except Exception as e:
    log(f"STEP9_SWITCH_FAIL {type(e).__name__}: {e}")

try:
    payload = {"interview_id": interview_id}
    code, body = post_json("http://127.0.0.1:8013/session/end", payload)
    obj = json.loads(body)
    log(f"STEP9_END_OK status={code} {json.dumps(compact(obj), ensure_ascii=False)}")
except urllib.error.HTTPError as e:
    snippet = e.read().decode("utf-8", errors="replace")[:400]
    log(f"STEP9_END_FAIL HTTPError: {e.code} {snippet}")
except Exception as e:
    log(f"STEP9_END_FAIL {type(e).__name__}: {e}")

log(f"STEP10_PIDS speech_pid={getattr(speech_proc, 'pid', None)} agent_pid={getattr(agent_proc, 'pid', None)}")
log(f"STEP10_LOGS speech_log={speech_log.resolve()} agent_log={agent_log.resolve()}")
